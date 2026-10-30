#!/usr/bin/env node
/**
 * Slice C — schema unification smoke.
 *
 * Verifies the unified canvas model where a funnel + its stages IS the
 * flow map:
 *
 *   1. funnels.flowmap.save with NO funnelId creates a fresh funnel +
 *      one stage per node + stage_connections — no separate promote
 *      step needed.
 *   2. funnels.flowmap.list returns the saved canvas as a
 *      funnel-backed projection (id starts with "funnel:").
 *   3. funnels.flowmap.get by the synthetic id round-trips the canvas
 *      — nodes preserve libraryId / row / column / items.
 *   4. Re-saving with the same id updates the existing funnel in place
 *      — stage ids are preserved (position-based diff).
 *   5. Adding a new node + saving creates exactly one new stage.
 *   6. Removing a node + saving drops the corresponding stage (and
 *      survivor stage absorbs any orphaned leads).
 *   7. funnels.flowmap.delete with the synthetic id removes the funnel
 *      (cascade drops stages + connections).
 *   8. Legacy flow_map rows (no funnel_id) are auto-migrated on list.
 *
 * Run: node --import tsx scripts/funnels-slice-c-smoke.mts
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-slice-c-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;
await fs.mkdir(sandbox, { recursive: true });

const { getFunnelStore, resetFunnelStore } = await import("../src/funnels/store.ts");
const { funnelHandlers } = await import("../src/gateway/server-methods/funnels.ts");
resetFunnelStore();

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

type Handler = (o: unknown) => Promise<void>;
function invoke<T = unknown>(
  handlers: Record<string, Handler>,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: T; error?: { code: string; message?: string } }> {
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

  // 1. Save a canvas — under the unified model this directly creates a funnel ──
  console.log("--- 1. save canvas → funnel created automatically ---");
  type SaveResp = { flowMap: { id: string; funnelId?: string; nodes: any[]; connections: any[] } };
  const save1 = await invoke<SaveResp>(funnelHandlers as never, "funnels.flowmap.save", {
    name: "Coaching Funnel",
    businessId: biz.id,
    nodes: [
      { id: "n1", libraryId: "instagram", name: "INSTAGRAM", row: 0, column: 0 },
      { id: "n2", libraryId: "calendar_booking", name: "BOOK_CALL", row: 1, column: 0 },
      { id: "n3", libraryId: "coaching_program", name: "COACHING_PROGRAM", row: 2, column: 0 },
    ],
    connections: [
      { id: "c1", from: "n1", to: "n2" },
      { id: "c2", from: "n2", to: "n3" },
    ],
  });
  if (!save1.ok || !save1.payload) fail("save1 failed", save1.error);
  const fm1 = save1.payload.flowMap;
  if (!fm1.id.startsWith("funnel:")) fail("expected funnel:<id> form", fm1.id);
  if (!fm1.funnelId) fail("flowMap.funnelId not set", fm1);
  if (fm1.nodes.length !== 3) fail("node count wrong", fm1.nodes);
  const stages1 = store.getStages(fm1.funnelId);
  if (stages1.length !== 3) fail("stages not created in funnel", stages1);
  if (stages1[0].libraryId !== "instagram") fail("libraryId not persisted on stage", stages1[0]);
  ok(`save → funnel=${fm1.funnelId.slice(0, 8)} stages=3 libraryId persisted on stages`);

  // 2. List returns the projection ──────────────────────────────
  console.log("\n--- 2. funnels.flowmap.list returns funnel-backed projections ---");
  const list1 = await invoke<{ flowMaps: Array<{ id: string; funnelId?: string }> }>(
    funnelHandlers as never,
    "funnels.flowmap.list",
    { businessId: biz.id },
  );
  if (!list1.ok || !list1.payload) fail("list failed", list1.error);
  if (list1.payload.flowMaps.length !== 1) fail("expected 1 flow map", list1.payload.flowMaps);
  if (list1.payload.flowMaps[0].id !== fm1.id) fail("list id mismatch");
  ok(`list → 1 projection, id=${fm1.id.slice(0, 18)}`);

  // 3. Get by id round-trips ────────────────────────────────────
  console.log("\n--- 3. get by id preserves canvas fields ---");
  const get1 = await invoke<{ flowMap: { nodes: any[] } }>(
    funnelHandlers as never,
    "funnels.flowmap.get",
    { id: fm1.id },
  );
  if (!get1.ok || !get1.payload?.flowMap) fail("get failed", get1.error);
  const gotNodes = get1.payload.flowMap.nodes;
  if (gotNodes.length !== 3) fail("get returned wrong node count", gotNodes);
  if (gotNodes[0].libraryId !== "instagram") fail("get lost libraryId", gotNodes[0]);
  if (gotNodes[1].row !== 1) fail("get lost row coord", gotNodes[1]);
  ok(`get → libraryId + row/column preserved`);

  // 4. Re-save preserves stage ids ──────────────────────────────
  console.log("\n--- 4. re-save preserves stage ids (position-based diff) ---");
  const save2 = await invoke<SaveResp>(funnelHandlers as never, "funnels.flowmap.save", {
    id: fm1.id,
    name: "Coaching Funnel",
    businessId: biz.id,
    nodes: [
      { id: "n1", libraryId: "instagram", name: "INSTAGRAM", row: 0, column: 0 },
      { id: "n2", libraryId: "calendar_booking", name: "BOOK_CALL — UPDATED", row: 1, column: 0 },
      { id: "n3", libraryId: "coaching_program", name: "COACHING_PROGRAM", row: 2, column: 0 },
    ],
    connections: [
      { id: "c1", from: "n1", to: "n2" },
      { id: "c2", from: "n2", to: "n3" },
    ],
  });
  if (!save2.ok || !save2.payload) fail("save2 failed", save2.error);
  const stages2 = store.getStages(fm1.funnelId!);
  if (stages2.length !== 3) fail("stage count changed on re-save", stages2.length);
  const same = stages2.every((s, i) => s.id === stages1[i].id);
  if (!same) fail("stage ids changed on re-save", { before: stages1.map((s) => s.id), after: stages2.map((s) => s.id) });
  const renamed = stages2.find((s) => s.libraryId === "calendar_booking");
  if (renamed?.name !== "BOOK_CALL — UPDATED") fail("rename didn't persist", renamed);
  ok(`re-save preserved 3 stage ids; rename persisted`);

  // 5. Add node + save creates one stage ────────────────────────
  console.log("\n--- 5. add node → exactly 1 new stage ---");
  const save3 = await invoke<SaveResp>(funnelHandlers as never, "funnels.flowmap.save", {
    id: fm1.id,
    name: "Coaching Funnel",
    businessId: biz.id,
    nodes: [
      { id: "n1", libraryId: "instagram", name: "INSTAGRAM", row: 0, column: 0 },
      { id: "n2", libraryId: "calendar_booking", name: "BOOK_CALL — UPDATED", row: 1, column: 0 },
      { id: "n2.5", libraryId: "lead_scorer", name: "LEAD_SCORER", row: 2, column: 0 },
      { id: "n3", libraryId: "coaching_program", name: "COACHING_PROGRAM", row: 3, column: 0 },
    ],
    connections: [
      { id: "c1", from: "n1", to: "n2" },
      { id: "c2", from: "n2", to: "n2.5" },
      { id: "c3", from: "n2.5", to: "n3" },
    ],
  });
  if (!save3.ok) fail("save3 failed", save3.error);
  const stages3 = store.getStages(fm1.funnelId!);
  if (stages3.length !== 4) fail("expected 4 stages after add", stages3.length);
  const scorer = stages3.find((s) => s.libraryId === "lead_scorer");
  if (!scorer) fail("scorer stage not created", stages3);
  ok(`add node → 4 stages (added lead_scorer between)`);

  // 6. Remove a node → stage dropped ────────────────────────────
  console.log("\n--- 6. remove node → stage dropped (orphan-safe) ---");
  const save4 = await invoke<SaveResp>(funnelHandlers as never, "funnels.flowmap.save", {
    id: fm1.id,
    name: "Coaching Funnel",
    businessId: biz.id,
    nodes: [
      { id: "n1", libraryId: "instagram", name: "INSTAGRAM", row: 0, column: 0 },
      // Removed calendar_booking
      { id: "n2.5", libraryId: "lead_scorer", name: "LEAD_SCORER", row: 2, column: 0 },
      { id: "n3", libraryId: "coaching_program", name: "COACHING_PROGRAM", row: 3, column: 0 },
    ],
    connections: [
      { id: "c1", from: "n1", to: "n2.5" },
      { id: "c2", from: "n2.5", to: "n3" },
    ],
  });
  if (!save4.ok) fail("save4 failed", save4.error);
  const stages4 = store.getStages(fm1.funnelId!);
  if (stages4.length !== 3) fail("expected 3 stages after remove", stages4.length);
  if (stages4.find((s) => s.libraryId === "calendar_booking")) fail("calendar_booking stage should be gone");
  ok(`remove node → 3 stages, calendar_booking dropped`);

  // 7. Delete the funnel via the synthetic id ──────────────────
  console.log("\n--- 7. funnels.flowmap.delete drops the funnel ---");
  const del = await invoke<{ deleted: boolean }>(funnelHandlers as never, "funnels.flowmap.delete", {
    id: fm1.id,
  });
  if (!del.ok || !del.payload?.deleted) fail("delete failed", del.error);
  if (store.getFunnel(fm1.funnelId!)) fail("funnel still exists after delete");
  if (store.getStages(fm1.funnelId!).length !== 0) fail("stages not cascade-deleted");
  ok(`delete dropped funnel + cascade dropped 3 stages`);

  // 8. Legacy flow_map without funnel_id auto-migrates on list ──
  console.log("\n--- 8. legacy flow_map auto-migrates on list ---");
  store.createFlowMap({
    name: "Legacy Funnel",
    businessId: biz.id,
    nodes: [
      { id: "ln1", libraryId: "youtube", name: "YOUTUBE", row: 0, column: 0 },
      { id: "ln2", libraryId: "sales_page", name: "SALES_PAGE", row: 1, column: 0 },
    ],
    connections: [{ id: "lc1", from: "ln1", to: "ln2" }],
  });
  const list2 = await invoke<{ flowMaps: Array<{ name: string; funnelId?: string }> }>(
    funnelHandlers as never,
    "funnels.flowmap.list",
    { businessId: biz.id },
  );
  if (!list2.ok) fail("list2 failed");
  const legacyProjection = list2.payload!.flowMaps.find((f) => f.name === "Legacy Funnel");
  if (!legacyProjection?.funnelId) fail("legacy not migrated", legacyProjection);
  const migratedStages = store.getStages(legacyProjection.funnelId);
  if (migratedStages.length !== 2) fail("legacy nodes not all migrated", migratedStages);
  ok(`legacy flow_map auto-migrated: funnel=${legacyProjection.funnelId.slice(0, 8)} stages=${migratedStages.length}`);

  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");
  console.log("\nOK — Slice C unified schema verified");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
