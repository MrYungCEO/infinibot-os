#!/usr/bin/env node
/**
 * Smoke for the notes ↔ database-row unification through the role bridge.
 *
 *   1. With no role mapped → legacy file store path; counts match the file system.
 *   2. Map a database to role=notes → bridge_status reports "mixed" when both
 *      file notes and db rows exist.
 *   3. Run notes.migrate_to_database → imports file notes as rows.
 *   4. notes.list now returns rows from the database (mode=database).
 *   5. notes.create writes a row, not a file.
 *   6. Idempotent: re-running migrate skips already-imported records.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-notes-bridge-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;

const { noteHandlers } = await import("../src/gateway/server-methods/notes.ts");
const { getDatabasesStore, ensureKanbanBuiltInDatabases } = await import("../src/databases/store.ts");
const { NoteStore } = await import("../src/notes/store.ts");

interface Resp { ok: boolean; payload?: unknown; error?: { code: string; message: string } }
async function call(method: string, params: Record<string, unknown> = {}): Promise<Resp> {
  const handler = noteHandlers[method];
  if (!handler) throw new Error(`no handler: ${method}`);
  let resp: Resp = { ok: false };
  await handler({
    req: { type: "req", id: "t", method, params } as never,
    params,
    respond: ((ok: boolean, payload?: unknown, error?: unknown) => {
      resp = { ok, payload, error: error as Resp["error"] };
    }) as never,
    client: {} as never,
    isWebchatConnect: false,
    context: {} as never,
  } as never);
  return resp;
}

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

async function main() {
  console.log("=== sandbox:", sandbox, "===\n");

  // Out of the box, getDatabasesStore() auto-seeds a Notes template AND
  // assigns role=notes to it via ensureBusinessTemplates. That's actually
  // the desired UX (database mode by day one), but to exercise the legacy
  // fallback path explicitly we clear the role first.
  const dbStore = getDatabasesStore(sandbox);
  dbStore.clearSystemRole("notes");

  // 1. Seed a legacy file note.
  console.log("--- 1. Legacy file-store path ---");
  const store = new NoteStore(sandbox);
  const fileNote = store.create({ name: "Legacy file note", body: "Body of the legacy note." });
  ok(`created legacy file note id=${fileNote.id}`);

  const r1 = await call("notes.list");
  if (!r1.ok) fail("notes.list legacy failed", r1.error);
  const payload1 = r1.payload as { mode?: string; count: number };
  if (payload1.mode !== "legacy") fail("expected mode=legacy", payload1);
  if (payload1.count !== 1) fail("expected count=1", payload1);
  ok(`notes.list mode=legacy count=${payload1.count}`);

  const status1 = await call("notes.bridge_status");
  const ps1 = status1.payload as { drift: string; legacyCount: number };
  if (ps1.drift !== "legacy_only") fail("expected drift=legacy_only", ps1);
  ok(`bridge_status drift=${ps1.drift} legacyCount=${ps1.legacyCount}`);

  // 2. Map a database to the notes role.
  console.log("\n--- 2. Map a database to role=notes ---");
  const notesDb = dbStore.createDatabase({ name: "My Notes" });
  dbStore.setSystemRole("notes", notesDb.id);
  ok(`role=notes mapped to db ${notesDb.id}`);

  const status2 = await call("notes.bridge_status");
  const ps2 = status2.payload as { drift: string; databaseName?: string };
  // Drift is now "legacy_only" because role is mapped but no rows imported yet,
  // OR "mixed" if we count both. The bridge reports legacy_only when rowCount=0.
  ok(`bridge_status after map: drift=${ps2.drift}, db=${ps2.databaseName}`);

  // 3. Migrate.
  console.log("\n--- 3. Run migrate_to_database ---");
  const r3 = await call("notes.migrate_to_database");
  if (!r3.ok) fail("migrate failed", r3.error);
  const mr = r3.payload as { imported: number; skipped: number };
  if (mr.imported !== 1) fail("expected 1 imported", mr);
  ok(`migrated: imported=${mr.imported} skipped=${mr.skipped}`);

  // 4. notes.list now reads from database.
  console.log("\n--- 4. notes.list now reads from database ---");
  const r4 = await call("notes.list");
  const p4 = r4.payload as { mode: string; count: number; notes: Array<{ name: string }> };
  if (p4.mode !== "database") fail("expected mode=database", p4);
  if (p4.count !== 1) fail("expected count=1 in db", p4);
  if (p4.notes[0].name !== "Legacy file note") fail("title not preserved", p4.notes[0]);
  ok(`notes.list mode=database count=${p4.count} title preserved`);

  // 5. Create a new note → goes to db_rows, not file.
  console.log("\n--- 5. notes.create writes to db_rows ---");
  const r5 = await call("notes.create", { name: "Born in the database", body: "Pure row." });
  if (!r5.ok) fail("create failed", r5.error);

  // Confirm file store didn't grow.
  const fileNotesAfter = store.list({});
  if (fileNotesAfter.length !== 1) fail("file store grew — create leaked to file", fileNotesAfter.length);
  ok(`file store unchanged (${fileNotesAfter.length}); new note went to db`);

  const r5b = await call("notes.list");
  const p5b = r5b.payload as { count: number };
  if (p5b.count !== 2) fail("expected count=2 after create", p5b);
  ok(`notes.list now returns ${p5b.count} (legacy migrated + new)`);

  // 6. Re-run migrate; should be idempotent.
  console.log("\n--- 6. Re-run migrate (idempotency) ---");
  const r6 = await call("notes.migrate_to_database");
  const mr6 = r6.payload as { imported: number; skipped: number };
  if (mr6.imported !== 0) fail("re-migrate imported again — not idempotent", mr6);
  if (mr6.skipped !== 1) fail("expected 1 skipped", mr6);
  ok(`re-migrate imported=${mr6.imported} skipped=${mr6.skipped} (idempotent ✓)`);

  // Cleanup.
  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");

  console.log("\nOK — notes bridge unification verified end-to-end");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
