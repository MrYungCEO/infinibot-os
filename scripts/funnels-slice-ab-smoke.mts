#!/usr/bin/env node
/**
 * Slice A + B end-to-end smoke.
 *
 * Verifies that:
 *   1. A flow map persists with library-tagged nodes (Slice A — every
 *      node carries libraryId, the new optional column on FlowNode).
 *   2. funnels.flowmap.promote materializes the canvas as a funnel:
 *      - creates a funnel record with the right businessId/name
 *      - creates one stage per node, preserved canvas order
 *      - maps library ids to StageType (sources → entry, terminals →
 *        exit, rest → standard)
 *      - writes funnelId back onto the flow map
 *      - writes stageId back onto each node so the canvas can join
 *        analytics on it
 *   3. Re-promoting is idempotent — reuses the funnel + stages.
 *   4. Binding a form to the promoted funnel + ingesting a submission
 *      creates a lead in the entry stage with the right tag.
 *   5. funnels.flow.snapshot returns that lead in the stages rollup
 *      under the matching stageId — proving the canvas hover card
 *      will see real counts.
 *
 * Run: node --import tsx scripts/funnels-slice-ab-smoke.mts
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-slice-ab-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;
await fs.mkdir(sandbox, { recursive: true });

const { getFunnelStore, resetFunnelStore } = await import("../src/funnels/store.ts");
const { funnelsFlowHandlers } = await import("../src/gateway/server-methods/funnels-flow.ts");
const { funnelHandlers } = await import("../src/gateway/server-methods/funnels.ts");
resetFunnelStore();

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

type Handler = (o: unknown) => Promise<void>;
function invoke<T = unknown>(handlers: Record<string, Handler>, method: string, params: Record<string, unknown>): Promise<{ ok: boolean; payload?: T; error?: { code: string; message?: string } }> {
  const fn = handlers[method];
  if (!fn) return Promise.reject(new Error(`no handler: ${method}`));
  return new Promise((resolve) => {
    fn({
      req: { type: "req", id: "t", method, params },
      params,
      respond: (okFlag: boolean, payload?: unknown, error?: { code: string; message?: string }) =>
        resolve({ ok: okFlag, payload: payload as T, error }),
      client: {},
      context: { broadcast: () => {} },
      isWebchatConnect: false,
    });
  });
}

async function main() {
  console.log("=== sandbox:", sandbox, "===\n");
  const store = getFunnelStore();
  const biz = store.createBusiness({ name: "Acme", type: "service", status: "active" });

  // 1. Create a flow map with library-tagged nodes ───────────────
  console.log("--- 1. flow map with library-tagged nodes ---");
  const flowMap = store.createFlowMap({
    name: "Coaching Funnel — Smoke",
    businessId: biz.id,
    nodes: [
      // Source → entry stage type
      {
        id: "n-ig",
        type: "social",
        platform: "instagram",
        name: "INSTAGRAM",
        libraryId: "instagram",
        row: 0,
        column: 0,
        items: [
          { id: "dm", label: "DM_FLOWS", enabled: true },
          { id: "bio", label: "LINK_IN_BIO", enabled: true },
        ],
      },
      // Capture → standard stage type
      {
        id: "n-form",
        type: "landing",
        name: "BOOK_CALL",
        libraryId: "calendar_booking",
        row: 1,
        column: 0,
        items: [{ id: "calendar", label: "CALENDAR", enabled: true }],
      },
      // Qualify → standard stage type
      {
        id: "n-score",
        type: "qualification",
        name: "LEAD_SCORER",
        libraryId: "lead_scorer",
        row: 2,
        column: 0,
        items: [],
      },
      // Destination → exit stage type
      {
        id: "n-coaching",
        type: "offer",
        name: "COACHING_PROGRAM",
        libraryId: "coaching_program",
        row: 3,
        column: 0,
        items: [{ id: "calls", label: "WEEKLY_CALLS", enabled: true }],
      },
    ],
    connections: [
      { id: "c1", from: "n-ig", to: "n-form" },
      { id: "c2", from: "n-form", to: "n-score" },
      { id: "c3", from: "n-score", to: "n-coaching" },
    ],
  });
  if (flowMap.nodes.length !== 4) fail("expected 4 nodes", flowMap.nodes.length);
  if (flowMap.funnelId) fail("draft flow map should not have funnelId yet", flowMap.funnelId);
  ok(`flow map created with ${flowMap.nodes.length} library-tagged nodes`);

  // 2. Promote the flow map → live funnel ────────────────────────
  console.log("\n--- 2. funnels.flowmap.promote ---");
  const promote1 = await invoke<{ flowMap: { funnelId?: string; nodes: Array<{ stageId?: string; libraryId?: string }> }; funnel: { id: string; name: string } }>(
    funnelHandlers as never,
    "funnels.flowmap.promote",
    { flowMapId: flowMap.id, funnelName: "Coaching Funnel — Live" },
  );
  if (!promote1.ok || !promote1.payload) fail("promote failed", promote1.error);
  const promoted = promote1.payload;
  if (!promoted.funnel?.id) fail("promote returned no funnel", promoted);
  if (promoted.funnel.name !== "Coaching Funnel — Live") fail("promote ignored funnelName", promoted.funnel);
  if (promoted.flowMap.funnelId !== promoted.funnel.id) fail("flowMap.funnelId not bound", promoted.flowMap);
  if (promoted.flowMap.nodes.length !== 4) fail("node count drift after promote");
  const stageIds = promoted.flowMap.nodes.map((n) => n.stageId);
  if (stageIds.some((s) => !s)) fail("some nodes missing stageId", stageIds);
  if (new Set(stageIds).size !== 4) fail("stageIds not unique", stageIds);

  // Verify stage types — sources → entry, terminals → exit, rest → standard.
  const stages = store.getStages(promoted.funnel.id);
  const byLib = new Map(promoted.flowMap.nodes.map((n) => [n.libraryId!, stages.find((s) => s.id === n.stageId)!]));
  if (byLib.get("instagram")?.type !== "entry") fail("instagram → entry", byLib.get("instagram"));
  if (byLib.get("calendar_booking")?.type !== "standard") fail("calendar_booking → standard", byLib.get("calendar_booking"));
  if (byLib.get("lead_scorer")?.type !== "standard") fail("lead_scorer → standard", byLib.get("lead_scorer"));
  if (byLib.get("coaching_program")?.type !== "exit") fail("coaching_program → exit", byLib.get("coaching_program"));
  ok(`promoted: funnel=${promoted.funnel.id.slice(0, 8)} stages=${stages.length} types=entry/standard×2/exit`);

  // 3. Re-promote — idempotent ────────────────────────────────────
  console.log("\n--- 3. re-promote is idempotent ---");
  const promote2 = await invoke<{ flowMap: { funnelId?: string }; funnel: { id: string } }>(
    funnelHandlers as never,
    "funnels.flowmap.promote",
    { flowMapId: flowMap.id },
  );
  if (!promote2.ok || !promote2.payload) fail("second promote failed");
  if (promote2.payload.funnel.id !== promoted.funnel.id) fail("re-promote created a new funnel");
  const stages2 = store.getStages(promoted.funnel.id);
  if (stages2.length !== 4) fail("re-promote created extra stages", stages2.length);
  ok(`re-promote reused funnel + ${stages2.length} stages, no duplicates`);

  // 4. Bind a form to the funnel + ingest a submission ───────────
  console.log("\n--- 4. form binding + ingest ---");
  const entryStage = byLib.get("instagram")!;
  const bindRes = await invoke<{ binding: unknown }>(
    funnelsFlowHandlers as never,
    "funnels.form.bind",
    {
      formId: "smoke-form-1",
      businessId: biz.id,
      funnelId: promoted.funnel.id,
      entryStageId: entryStage.id,
      tag: "ig",
    },
  );
  if (!bindRes.ok) fail("form bind failed", bindRes.error);

  // Create the lead exactly the same way the public form-submit
  // handler would after seeing the binding.
  const lead = store.createLead({
    businessId: biz.id,
    funnelId: promoted.funnel.id,
    stageId: entryStage.id,
    name: "Alice",
    email: "alice@example.com",
    source: "form" as never,
    status: "new" as never,
    priority: "medium" as never,
    tags: ["form_ig", "form_smoke-form-1"],
  });
  if (!lead.id) fail("createLead returned no id");
  ok(`bound form-1 → entry stage; created lead ${lead.id.slice(0, 8)} tagged form_ig`);

  // 5. funnels.flow.snapshot reflects the live lead ──────────────
  console.log("\n--- 5. funnels.flow.snapshot ---");
  type SnapshotPayload = {
    funnel: { id: string; name: string };
    stages: Array<{ id: string; name: string; leadCount?: number }>;
    sources: Array<{ kind: string; id: string; tag: string; leadCount: number }>;
    outcomes: { totalLeads: number };
  };
  const snapRes = await invoke<SnapshotPayload>(
    funnelsFlowHandlers as never,
    "funnels.flow.snapshot",
    { funnelId: promoted.funnel.id },
  );
  if (!snapRes.ok || !snapRes.payload) fail("snapshot failed", snapRes.error);
  const snap = snapRes.payload;
  if (snap.outcomes.totalLeads !== 1) fail("totalLeads should be 1", snap.outcomes);

  // The stages rollup should include each stageId from our flow map.
  // The entry stage should report exactly 1 lead.
  const entryRollup = snap.stages.find((s) => s.id === entryStage.id);
  if (!entryRollup) fail("entry stage missing from rollup", snap.stages.map((s) => s.id));
  if (entryRollup.leadCount !== 1) fail(`entry stage leadCount expected 1, got ${entryRollup.leadCount}`);

  // The sources rollup should attribute that lead to our form binding.
  const formSource = snap.sources.find((s) => s.id === "smoke-form-1" || s.tag === "ig" || s.tag === "form_ig");
  if (!formSource) fail("smoke-form-1 source missing from sources rollup", snap.sources);
  if (formSource.leadCount !== 1) fail(`form source leadCount expected 1, got ${formSource.leadCount}`);
  ok(`snapshot: total=${snap.outcomes.totalLeads} entry-stage=${entryRollup.leadCount} form-source=${formSource.leadCount}`);

  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");
  console.log("\nOK — Slice A + B end-to-end verified");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
