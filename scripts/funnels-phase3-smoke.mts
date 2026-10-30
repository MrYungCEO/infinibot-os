#!/usr/bin/env node
/**
 * Phase 3 smoke: AutomationEngine fires on FunnelStore lead events.
 *
 * Setup:
 *   - business + funnel + 2 stages (Inbox, Hot)
 *   - one rule: trigger lead_created with no conditions → add_tag "auto"
 *   - one rule: trigger score_changed score>=80 → move_stage to Hot
 *
 * Run: node --import tsx scripts/funnels-phase3-smoke.mts
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-phase3-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;
await fs.mkdir(sandbox, { recursive: true });

const { getFunnelStore, resetFunnelStore } = await import("../src/funnels/store.ts");
const { getAutomationBridge, resetAutomationBridge, reloadRulesForFunnel } = await import(
  "../src/funnels/automation/bridge.ts"
);

resetAutomationBridge();
resetFunnelStore();

function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}
function ok(label: string) { console.log(`✓ ${label}`); }

async function main() {
  console.log("=== sandbox:", sandbox, "===\n");
  const store = getFunnelStore();
  const biz = store.createBusiness({ name: "Acme", type: "service", status: "active" });
  const funnel = store.createFunnel({
    businessId: biz.id,
    name: "Sales",
    type: "sales",
    status: "active",
  });
  const inbox = store.createStage({
    funnelId: funnel.id,
    name: "Inbox",
    type: "entry",
    position: 0,
  });
  const hot = store.createStage({
    funnelId: funnel.id,
    name: "Hot",
    type: "qualified",
    position: 1,
  });

  store.createRule({
    businessId: biz.id,
    funnelId: funnel.id,
    name: "Auto tag new leads",
    enabled: true,
    priority: 1,
    triggerOn: "lead_created",
    conditions: [],
    actions: [{ type: "add_tag", config: { tag: "auto" } }],
  } as never);

  store.createRule({
    businessId: biz.id,
    funnelId: funnel.id,
    name: "Hot when score ≥ 80",
    enabled: true,
    priority: 2,
    triggerOn: "score_changed",
    conditions: [{ field: "score", operator: "greater_than", value: 79 }],
    actions: [{ type: "move_stage", config: { stageId: hot.id, reason: "auto-qualified" } }],
  } as never);

  // Boot bridge AFTER rules exist so we cover the load path explicitly.
  getAutomationBridge();
  reloadRulesForFunnel(biz.id, funnel.id);

  console.log("--- 1. lead_created → add_tag fires ---");
  const lead = store.createLead({
    businessId: biz.id,
    funnelId: funnel.id,
    stageId: inbox.id,
    name: "Alice",
    email: "alice@example.com",
    source: "form" as never,
    status: "new" as never,
    priority: "medium" as never,
    tags: [],
  });
  // Engine runs asynchronously via void Promise; give it a tick.
  await new Promise((r) => setTimeout(r, 50));
  const enriched = store.getLead(lead.id)!;
  if (!(enriched.tags ?? []).includes("auto")) {
    fail("add_tag action didn't run", enriched.tags);
  }
  ok(`lead created → auto-tag applied: tags=${enriched.tags?.join(",")}`);

  console.log("\n--- 2. score_changed → move_stage fires ---");
  store.updateLead(lead.id, { score: 90 });
  await new Promise((r) => setTimeout(r, 50));
  const moved = store.getLead(lead.id)!;
  if (moved.stageId !== hot.id) {
    fail("move_stage didn't run (lead still in inbox)", { stageId: moved.stageId, expected: hot.id });
  }
  ok(`score=90 → moved to ${hot.name} stage`);

  console.log("\n--- 3. engine stats reflect activity ---");
  const stats = getAutomationBridge().engine.getStats();
  if (stats.rulesTriggered < 2) {
    fail("engine should have triggered at least 2 rules", stats);
  }
  ok(`engine stats: rulesEvaluated=${stats.rulesEvaluated} triggered=${stats.rulesTriggered}`);

  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");
  console.log("\nOK — Phase 3 automation engine wired");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
