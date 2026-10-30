#!/usr/bin/env node
/**
 * Verify that Notion sync remains functional after the role-bridge
 * unification. Notion sync (`pullDatabaseFromNotion` and
 * `pushRowToNotion`) writes to `database_rows` via `store.upsertRow`. The
 * role-bridge handlers — notes, clients, leads — all read from the same
 * `database_rows` rows. So when Notion writes:
 *   1. The role's read handler must return those rows.
 *   2. The externalRef must round-trip so push-to-Notion knows the page id.
 *   3. Per-business roles (clients, leads) must keep rows scoped to the
 *      right business database.
 *
 * We don't hit the real Notion API — we simulate a Notion upsert by
 * directly calling `store.upsertRow` with an `externalRef` carrying a
 * fake `system: "notion"` + `externalId`, exactly like pullDatabaseFromNotion
 * would.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-notion-sync-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;

// Seed business.json so the leads/clients per-business resolvers find an
// active business id.
await fs.mkdir(sandbox, { recursive: true });
await fs.writeFile(
  path.join(sandbox, "business.json"),
  JSON.stringify({
    active: "biz-notion",
    businesses: [
      {
        id: "biz-notion",
        name: "Notion-synced Co",
        industry: "",
        plan: "",
        planNotionUrl: "",
        context: "",
        clients: [],
        crmSchema: null,
      },
    ],
  }, null, 2),
);

const { getDatabasesStore } = await import("../src/databases/store.ts");
const { noteHandlers } = await import("../src/gateway/server-methods/notes.ts");
const { businessHandlers } = await import("../src/gateway/server-methods/business.ts");
const { leadHandlers } = await import("../src/gateway/server-methods/leads.ts");
const { ensureBusinessRoleDatabase } = await import("../src/databases/system-role-bridge.ts");

interface Resp { ok: boolean; payload?: unknown; error?: { code: string; message: string } }
async function call(handlers: Record<string, unknown>, method: string, params: Record<string, unknown> = {}): Promise<Resp> {
  const handler = handlers[method];
  if (!handler) throw new Error(`no handler: ${method}`);
  let resp: Resp = { ok: false };
  await (handler as (opts: unknown) => Promise<void>)({
    req: { type: "req", id: "t", method, params },
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      resp = { ok, payload, error: error as Resp["error"] };
    },
    client: {},
    isWebchatConnect: false,
    context: {},
  });
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
  const store = getDatabasesStore(sandbox);

  /* ─── Notes: simulate Notion pull → bridge sees the row ─── */
  console.log("--- Notes: Notion pull → notes.list returns the row ---");
  // Use the auto-mapped Notes role; if it's not auto-mapped here, fall back.
  let notesRole = store.resolveSystemRole("notes");
  if (!notesRole?.database) {
    const d = store.createDatabase({ name: "Notion-Notes" });
    store.setSystemRole("notes", d.id);
    notesRole = store.resolveSystemRole("notes");
  }
  const notesDbId = notesRole!.database.id;

  // Simulate what `pullDatabaseFromNotion` does: upsert a row with an
  // externalRef.system === "notion".
  const notionNotePageId = "notion-page-abc123";
  store.upsertRow({
    databaseId: notesDbId,
    title: "Synced from Notion",
    body: "This note arrived via Notion sync.",
    externalRef: {
      system: "notion",
      externalId: notionNotePageId,
      lastSyncedAt: Date.now(),
    },
  });
  ok(`Notion-pull simulated: page=${notionNotePageId} → row written to db=${notesDbId}`);

  const r1 = await call(noteHandlers as Record<string, unknown>, "notes.list");
  const p1 = r1.payload as { notes: Array<{ name: string; body: string }>; mode: string };
  if (p1.mode !== "database") fail("notes.list not in database mode", p1);
  const found = p1.notes.find((n) => n.name === "Synced from Notion");
  if (!found) fail("Notion-pulled note not visible to notes.list", p1);
  ok(`notes.list returns the Notion-pulled row: "${found.name}"`);

  /* ─── Notes: write through bridge → externalRef preserved on update ─── */
  console.log("\n--- Notes: handler update preserves Notion linkage ---");
  // Find the row, update its body via the handler, then confirm
  // externalRef is still present (push-to-Notion would need it).
  const rGet = await call(noteHandlers as Record<string, unknown>, "notes.list");
  const rowId = ((rGet.payload as { notes: Array<{ id: string; name: string }> }).notes.find(
    (n) => n.name === "Synced from Notion",
  ))!.id;

  await call(noteHandlers as Record<string, unknown>, "notes.update", {
    id: rowId,
    body: "Edited locally; Notion linkage must stay intact.",
  });
  // Inspect the underlying row.
  const raw = store.getRow(rowId);
  if (!raw?.externalRef || raw.externalRef.externalId !== notionNotePageId) {
    fail("update wiped externalRef — push-to-Notion would break", raw);
  }
  ok(`update preserved externalRef.externalId=${raw.externalRef.externalId}`);

  /* ─── Clients (per-business): Notion pull → bridge sees the row ─── */
  console.log("\n--- Clients: per-business Notion sync ---");
  // Ensure the biz-notion clients DB exists, then simulate a Notion pull.
  const clientsResolved = ensureBusinessRoleDatabase(
    "biz-notion",
    "clients",
    "biz-notion CRM",
  );
  const clientsDbId = clientsResolved.databaseId!;
  const notionClientPageId = "notion-client-xyz789";
  store.upsertRow({
    databaseId: clientsDbId,
    title: "Frodo Baggins",
    values: {
      email: "frodo@shire.test",
      phone: "+15555550101",
    } as Record<string, never>,
    businessId: "biz-notion",
    externalRef: {
      system: "notion",
      externalId: notionClientPageId,
      lastSyncedAt: Date.now(),
    },
  });
  ok(`Notion pull simulated for clients: row in db=${clientsDbId}`);

  const r2 = await call(businessHandlers as Record<string, unknown>, "business.clients.list", {
    businessId: "biz-notion",
  });
  const p2 = r2.payload as { clients: Array<{ id: string; data: Record<string, unknown> }>; source: string };
  if (p2.source !== "database") fail("clients.list not in db mode", p2);
  const client = p2.clients.find((c) => c.data.email === "frodo@shire.test");
  if (!client) fail("Notion-pulled client not visible", p2);
  ok(`business.clients.list returns the Notion-pulled row: ${client.id}`);

  /* ─── Clients: update preserves externalRef ─── */
  await call(businessHandlers as Record<string, unknown>, "business.clients.update", {
    businessId: "biz-notion",
    id: client.id,
    data: { phone: "+15555550999" },
  });
  const clientRaw = store.getRow(client.id);
  if (!clientRaw?.externalRef || clientRaw.externalRef.externalId !== notionClientPageId) {
    fail("clients update wiped externalRef", clientRaw);
  }
  ok(`clients update preserved externalRef.externalId=${clientRaw.externalRef.externalId}`);

  /* ─── Leads: Notion pull → simulate by writing directly ─── */
  console.log("\n--- Leads: per-business Notion mirror ---");
  const leadsResolved = ensureBusinessRoleDatabase(
    "biz-notion",
    "leads",
    "biz-notion Leads",
  );
  const leadsDbId = leadsResolved.databaseId!;
  const notionLeadPageId = "notion-lead-qrs456";
  store.upsertRow({
    databaseId: leadsDbId,
    id: "lead-from-notion-1",
    title: "Acme Corp",
    values: { email: "sales@acme.test", source: "notion-import" } as Record<string, never>,
    businessId: "biz-notion",
    externalRef: {
      system: "notion",
      externalId: notionLeadPageId,
      lastSyncedAt: Date.now(),
    },
  });
  ok(`Notion-pulled lead written to db=${leadsDbId}`);

  // Inspect — the row should be queryable as a lead row via the bridge.
  const leadRaw = store.getRow("lead-from-notion-1");
  if (!leadRaw) fail("lead row missing after upsert");
  if (!leadRaw.externalRef || leadRaw.externalRef.externalId !== notionLeadPageId) {
    fail("lead externalRef missing", leadRaw);
  }
  ok(`lead row + externalRef survive in db`);

  // Verify leads.bridge_status reports the database as the source.
  const status = await call(leadHandlers as Record<string, unknown>, "leads.bridge_status", {
    businessId: "biz-notion",
  });
  const sp = status.payload as { mode: string; databaseId?: string; businessId?: string };
  if (sp.mode !== "database") fail("leads.bridge_status not in db mode", sp);
  if (sp.databaseId !== leadsDbId) fail("leads.bridge_status pointed at wrong db", sp);
  ok(`leads.bridge_status: mode=${sp.mode} db=${sp.databaseId}`);

  /* ─── Cross-role: each role sees its own rows only ─── */
  console.log("\n--- Cross-role isolation ---");
  const notesAfter = await call(noteHandlers as Record<string, unknown>, "notes.list");
  const clientsAfter = await call(businessHandlers as Record<string, unknown>, "business.clients.list", {
    businessId: "biz-notion",
  });
  const notesIds = new Set(
    (notesAfter.payload as { notes: Array<{ id: string }> }).notes.map((n) => n.id),
  );
  const clientsIds = new Set(
    (clientsAfter.payload as { clients: Array<{ id: string }> }).clients.map((c) => c.id),
  );
  for (const id of notesIds) {
    if (clientsIds.has(id)) fail(`row ${id} appears in both notes and clients`, { notesIds, clientsIds });
  }
  ok(`no cross-role bleed: notes=${notesIds.size} ids, clients=${clientsIds.size} ids, disjoint`);

  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");

  console.log("\nOK — Notion-sync compatibility verified for notes/clients/leads");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
