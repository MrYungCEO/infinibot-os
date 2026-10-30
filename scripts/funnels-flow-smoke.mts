#!/usr/bin/env node
/**
 * Smoke for the new funnels.flow.* handlers.
 *
 *   1. Create a business + funnel + 2 stages.
 *   2. Bind a form to the funnel's entry stage.
 *   3. Manually create a lead tagged with form_<id> (simulating the
 *      auto-ingest the next task wires up) — confirm the snapshot
 *      attributes it to the right source.
 *   4. Move the lead to stage 2; confirm rollups update.
 *   5. funnels.lead.source returns the correct provenance.
 *
 * Phase-3+ tasks (auto-ingest, automation engine wiring) will replace
 * the manual createLead step with a real form-submit pipeline. The
 * shape verified here is what the UI consumes regardless.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-funnels-flow-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;
await fs.mkdir(sandbox, { recursive: true });

const { getFunnelStore, resetFunnelStore } = await import("../src/funnels/store.ts");
const { funnelsFlowHandlers } = await import("../src/gateway/server-methods/funnels-flow.ts");
resetFunnelStore();

interface Resp { ok: boolean; payload?: unknown; error?: { code: string; message: string } }
async function call(method: string, params: Record<string, unknown> = {}): Promise<Resp> {
  const handler = (funnelsFlowHandlers as Record<string, unknown>)[method];
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

  // Seed: business + funnel + stages directly via store (the public CRUD
  // path is well-trodden; we only smoke the new flow handlers here).
  const store = getFunnelStore();
  const biz = store.createBusiness({ name: "Test Biz", type: "service", status: "active" });
  const funnel = store.createFunnel({
    businessId: biz.id,
    name: "High Ticket",
    type: "sales",
    status: "active",
  });
  const entry = store.createStage({ funnelId: funnel.id, name: "New Leads", type: "entry", position: 0 });
  const second = store.createStage({ funnelId: funnel.id, name: "Qualified", type: "standard", position: 1 });
  ok(`seeded biz=${biz.id} funnel=${funnel.id} stages=${entry.id},${second.id}`);

  // 1. Bind a form.
  console.log("\n--- 1. bind a form ---");
  const r1 = await call("funnels.form.bind", {
    formId: "form-mentor-app",
    businessId: biz.id,
    funnelId: funnel.id,
    entryStageId: entry.id,
    tag: "high-ticket-mentorship",
  });
  if (!r1.ok) fail("bind failed", r1.error);
  ok(`bound form to funnel: ${JSON.stringify((r1.payload as { binding: unknown }).binding)}`);

  const r1b = await call("funnels.form.list_bindings", { funnelId: funnel.id });
  if ((r1b.payload as { count: number }).count !== 1) fail("list_bindings count != 1", r1b.payload);
  ok(`list_bindings count=${(r1b.payload as { count: number }).count}`);

  // 2. Create a lead tagged with form_<id> (Phase 2 will do this auto on form submit).
  console.log("\n--- 2. simulate ingest: tagged lead ---");
  const lead = store.createLead({
    businessId: biz.id,
    funnelId: funnel.id,
    stageId: entry.id,
    name: "Alice Form",
    email: "alice@example.com",
    source: "form" as never,
    status: "new" as never,
    priority: "medium" as never,
    tags: ["form_form-mentor-app"],
  });
  ok(`lead created: ${lead.id}`);

  // 3. Snapshot.
  console.log("\n--- 3. flow.snapshot ---");
  const r3 = await call("funnels.flow.snapshot", { funnelId: funnel.id });
  if (!r3.ok) fail("snapshot failed", r3.error);
  const snap = r3.payload as {
    funnel: { name: string };
    sources: Array<{ kind: string; id: string; leadCount: number }>;
    stages: Array<{ id: string; name: string; leadCount: number; qualified: number; unqualified: number; pending: number }>;
    outcomes: { won: number; lost: number; promotedToCrm: number; totalLeads: number };
  };
  console.log(`  funnel: ${snap.funnel.name}`);
  console.log(`  sources: ${JSON.stringify(snap.sources)}`);
  console.log(`  stages: ${snap.stages.map((s) => `${s.name}=${s.leadCount}`).join(", ")}`);
  console.log(`  outcomes: ${JSON.stringify(snap.outcomes)}`);

  const formSource = snap.sources.find((s) => s.kind === "form" && s.id === "form-mentor-app");
  if (!formSource) fail("form source missing", snap.sources);
  if (formSource.leadCount !== 1) fail("form source leadCount != 1", formSource);
  const entryRow = snap.stages.find((s) => s.id === entry.id)!;
  if (entryRow.leadCount !== 1) fail("entry stage count wrong", entryRow);
  if (snap.outcomes.totalLeads !== 1) fail("totalLeads wrong", snap.outcomes);
  ok("snapshot attributes lead to form source ✓ and entry stage ✓");

  // 4. Move lead to second stage.
  console.log("\n--- 4. move lead to next stage ---");
  store.moveLead(lead.id, second.id, "advanced");
  const r4 = await call("funnels.flow.snapshot", { funnelId: funnel.id });
  const snap2 = r4.payload as { stages: Array<{ id: string; leadCount: number }> };
  const entry2 = snap2.stages.find((s) => s.id === entry.id)!;
  const second2 = snap2.stages.find((s) => s.id === second.id)!;
  if (entry2.leadCount !== 0) fail("entry count after move should be 0", entry2);
  if (second2.leadCount !== 1) fail("second count after move should be 1", second2);
  ok(`after move: entry=${entry2.leadCount}, second=${second2.leadCount}`);

  // 5. lead.source provenance.
  console.log("\n--- 5. lead.source ---");
  const r5 = await call("funnels.lead.source", { leadId: lead.id });
  const ls = r5.payload as { kind: string; sourceId: string; funnelId: string };
  if (ls.kind !== "form") fail("kind should be form", ls);
  if (ls.sourceId !== "form-mentor-app") fail("sourceId wrong", ls);
  if (ls.funnelId !== funnel.id) fail("funnelId wrong", ls);
  ok(`provenance: kind=${ls.kind} source=${ls.sourceId} funnel=${ls.funnelId}`);

  // 6. unbind cleans up.
  console.log("\n--- 6. unbind ---");
  const r6 = await call("funnels.form.unbind", { formId: "form-mentor-app" });
  if (!(r6.payload as { unbound: boolean }).unbound) fail("unbind didn't return true", r6.payload);
  const r6b = await call("funnels.form.list_bindings", { funnelId: funnel.id });
  if ((r6b.payload as { count: number }).count !== 0) fail("list_bindings count != 0 after unbind", r6b.payload);
  ok(`unbind clean: list_bindings count=0`);

  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");

  console.log("\nOK — funnels.flow.* end-to-end verified");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
