#!/usr/bin/env node
/**
 * Smoke for per-business clients ↔ database unification.
 *
 *   1. Seed two businesses with legacy biz.clients[] arrays.
 *   2. Call business.clients.list for biz A → auto-creates A's CRM
 *      database, migrates A's legacy clients, returns them.
 *   3. Call business.clients.list for biz B → same, but for B.
 *   4. Each business has its OWN dedicated database (different ids).
 *   5. business.clients.create writes to the right business's DB.
 *   6. business.clients.update + business.clients.delete round-trip.
 *   7. Re-list on biz A doesn't re-migrate (idempotent).
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-clients-bridge-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;

// Pre-seed a business.json with two businesses + a couple of legacy clients each.
const businessJsonPath = path.join(sandbox, "business.json");
await fs.mkdir(sandbox, { recursive: true });
await fs.writeFile(
  businessJsonPath,
  JSON.stringify({
    active: "biz-a",
    businesses: [
      {
        id: "biz-a",
        name: "Acme Inc",
        industry: "Software",
        plan: "",
        planNotionUrl: "",
        context: "",
        clients: [
          {
            id: "cli-a-1",
            data: { name: "Alice", email: "alice@acme.com" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            id: "cli-a-2",
            data: { name: "Bob", email: "bob@acme.com" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        crmSchema: null,
      },
      {
        id: "biz-b",
        name: "Beta Corp",
        industry: "Hardware",
        plan: "",
        planNotionUrl: "",
        context: "",
        clients: [
          {
            id: "cli-b-1",
            data: { name: "Charlie", email: "charlie@beta.com" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        crmSchema: null,
      },
    ],
  }, null, 2),
);

const { businessHandlers } = await import("../src/gateway/server-methods/business.ts");

interface Resp { ok: boolean; payload?: unknown; error?: { code: string; message: string } }
async function call(method: string, params: Record<string, unknown> = {}): Promise<Resp> {
  const handler = (businessHandlers as Record<string, unknown>)[method];
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

  console.log("--- 1. List biz-a → auto-migrate legacy clients into a new DB ---");
  const r1 = await call("business.clients.list", { businessId: "biz-a" });
  if (!r1.ok) fail("biz-a list failed", r1.error);
  const p1 = r1.payload as { clients: Array<{ data: Record<string, unknown> }>; databaseId?: string; migrated?: number; source?: string };
  if (p1.source !== "database") fail("expected source=database", p1);
  if ((p1.migrated ?? 0) < 2) fail("expected migrated≥2", p1);
  if (p1.clients.length !== 2) fail("expected 2 clients", p1);
  if (!p1.databaseId) fail("expected databaseId", p1);
  ok(`biz-a → db=${p1.databaseId}, migrated=${p1.migrated}, clients=${p1.clients.length}`);
  const bizADbId = p1.databaseId;

  console.log("\n--- 2. List biz-b → separate dedicated DB ---");
  const r2 = await call("business.clients.list", { businessId: "biz-b" });
  const p2 = r2.payload as { databaseId?: string; clients: unknown[]; migrated?: number };
  if (p2.databaseId === bizADbId) fail("biz-b shares DB with biz-a", p2);
  if (p2.clients.length !== 1) fail("expected 1 client for biz-b", p2);
  ok(`biz-b → db=${p2.databaseId} (different), clients=${p2.clients.length}, migrated=${p2.migrated}`);

  console.log("\n--- 3. Create a new client on biz-a → writes to A's DB only ---");
  const r3 = await call("business.clients.create", {
    businessId: "biz-a",
    data: { name: "Dave", email: "dave@acme.com" },
  });
  if (!r3.ok) fail("create failed", r3.error);
  const p3 = r3.payload as { client: { id: string; data: Record<string, unknown> } };
  ok(`created ${p3.client.id} name=${p3.client.data.name}`);

  // Confirm biz-a now has 3, biz-b still 1.
  const r4 = await call("business.clients.list", { businessId: "biz-a" });
  const r4b = await call("business.clients.list", { businessId: "biz-b" });
  if ((r4.payload as { clients: unknown[] }).clients.length !== 3) fail("biz-a not 3", r4.payload);
  if ((r4b.payload as { clients: unknown[] }).clients.length !== 1) fail("biz-b should still be 1", r4b.payload);
  ok("biz-a now has 3, biz-b still 1 — no cross-contamination");

  console.log("\n--- 4. Update + delete ---");
  const newId = p3.client.id;
  const rU = await call("business.clients.update", {
    businessId: "biz-a",
    id: newId,
    data: { phone: "+15555550100" },
  });
  if (!rU.ok) fail("update failed", rU.error);
  const pU = rU.payload as { client: { data: Record<string, unknown> } };
  if (pU.client.data.phone !== "+15555550100") fail("phone not set", pU);
  if (pU.client.data.name !== "Dave") fail("merge dropped existing name", pU);
  ok(`update merged: name=Dave, phone=${pU.client.data.phone}`);

  const rD = await call("business.clients.delete", { businessId: "biz-a", id: newId });
  if (!rD.ok) fail("delete failed", rD.error);
  ok(`delete ok: ${(rD.payload as { deleted: boolean }).deleted}`);
  const rAfter = await call("business.clients.list", { businessId: "biz-a" });
  if ((rAfter.payload as { clients: unknown[] }).clients.length !== 2) fail("biz-a not back to 2", rAfter.payload);
  ok("biz-a back to 2 after delete");

  console.log("\n--- 5. Re-list biz-a is idempotent ---");
  const r5 = await call("business.clients.list", { businessId: "biz-a" });
  const p5 = r5.payload as { migrated: number };
  if (p5.migrated !== 0) fail("re-list re-migrated", p5);
  ok(`re-list migrated=${p5.migrated} (idempotent ✓)`);

  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");

  console.log("\nOK — per-business clients bridge verified end-to-end");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
