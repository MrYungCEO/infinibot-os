#!/usr/bin/env node
/**
 * Discipline agent tool — end-to-end smoke.
 *
 * Exercises every action class so we know the wiring between the tool
 * surface and the in-process store is intact:
 *
 *   1. list_blocks on a fresh DB → []
 *   2. create_block with "HH:MM" time strings + routine items as strings
 *   3. list_blocks shows the block; fields decoded back (start/end as HH:MM,
 *      routineItems normalized with ids + order)
 *   4. update_block — patch a single field, others preserved
 *   5. assign_project / assign_task / clear_assignment
 *   6. complete_block / score_day reflects the completion
 *   7. create_log + list_logs
 *   8. update_settings (militant) round-trips
 *   9. save_template snapshots the current blocks
 *  10. delete the live block, apply_template restores it
 *  11. list_templates reports the saved one
 *  12. delete_template removes it
 *
 * Run: node --import tsx scripts/discipline-tool-smoke.mts
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

const sandbox = path.join(os.tmpdir(), `infinibot-discipline-${randomBytes(3).toString("hex")}`);
process.env.INFINIBOT_STATE_DIR = sandbox;
await fs.mkdir(sandbox, { recursive: true });

const { createDisciplineTool } = await import("../src/agents/tools/discipline-tool.ts");
const tool = createDisciplineTool();

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

async function invoke<T = any>(args: Record<string, unknown>): Promise<T> {
  const result = await tool.execute("test", args);
  // jsonResult wraps payload as a text-typed content block. Pull it.
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  const text = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`tool didn't return JSON: ${text}`);
  }
}

async function main() {
  console.log("=== sandbox:", sandbox, "===\n");

  // 1. List on a fresh store → empty
  console.log("--- 1. fresh list_blocks ---");
  const list0 = await invoke<{ blocks: any[] }>({ action: "list_blocks" });
  if (list0.blocks.length !== 0) fail("expected 0 blocks on fresh DB", list0);
  ok(`fresh store has 0 blocks`);

  // 2. Create a block with HH:MM times + string routine items
  console.log("\n--- 2. create_block with HH:MM times ---");
  const c1 = await invoke<{ block: any }>({
    action: "create_block",
    label: "Morning Deep Work",
    category: "deep-work",
    start: "09:00",
    end: "11:30",
    days: [1, 2, 3, 4, 5],
    nonNegotiable: true,
    routineItems: ["Open notebook", "Close email", "Run pomodoro"],
  });
  const blockId = c1.block.id;
  if (c1.block.start !== "09:00") fail("HH:MM start not decoded back", c1.block);
  if (c1.block.end !== "11:30") fail("HH:MM end not decoded back", c1.block);
  if (c1.block.startMinute !== 540) fail("start minute wrong", c1.block);
  if (c1.block.endMinute !== 690) fail("end minute wrong", c1.block);
  if (c1.block.routineItems.length !== 3) fail("routine items wrong", c1.block);
  if (c1.block.routineItems[0].label !== "Open notebook") fail("first routine label drift");
  if (c1.block.routineItems[0].order !== 0) fail("routine order missing");
  if (!c1.block.nonNegotiable) fail("nonNegotiable not persisted");
  ok(`block created: ${blockId.slice(0, 12)} 09:00–11:30 nn=true 3 items`);

  // 3. List shows the block
  console.log("\n--- 3. list_blocks reflects the create ---");
  const list1 = await invoke<{ blocks: any[] }>({ action: "list_blocks" });
  if (list1.blocks.length !== 1) fail("expected 1 block", list1);
  ok(`list reports 1 block`);

  // 4. Update a single field; others preserved
  console.log("\n--- 4. update_block (patch only intent) ---");
  const u1 = await invoke<{ block: any }>({
    action: "update_block",
    id: blockId,
    intent: "Ship slice D",
  });
  if (u1.block.intent !== "Ship slice D") fail("intent not applied", u1.block);
  if (u1.block.label !== "Morning Deep Work") fail("update wiped label", u1.block);
  if (u1.block.startMinute !== 540) fail("update wiped time", u1.block);
  if (u1.block.routineItems.length !== 3) fail("update wiped routine items", u1.block);
  ok(`patch applied; label/time/routine items preserved`);

  // 5. Project + task assignment
  console.log("\n--- 5. assign / clear project + task ---");
  const u2 = await invoke<{ block: any }>({
    action: "assign_project",
    id: blockId,
    projectId: "proj_test_001",
  });
  if (u2.block.projectId !== "proj_test_001") fail("assign_project failed", u2.block);
  const u3 = await invoke<{ block: any }>({
    action: "assign_task",
    id: blockId,
    taskId: "task_test_001",
  });
  if (u3.block.taskId !== "task_test_001") fail("assign_task failed", u3.block);
  const u4 = await invoke<{ block: any }>({ action: "clear_assignment", id: blockId });
  if (u4.block.projectId !== null || u4.block.taskId !== null) {
    fail("clear_assignment didn't drop both", u4.block);
  }
  ok(`assign_project / assign_task / clear_assignment all working`);

  // 6. Complete block + score day reflects it
  console.log("\n--- 6. complete_block + score_day ---");
  const comp = await invoke<any>({ action: "complete_block", id: blockId });
  if (!comp || typeof comp !== "object") fail("complete returned bad shape", comp);
  const score = await invoke<{ score: any }>({ action: "score_day" });
  if (!score.score) fail("score_day returned no score", score);
  ok(`block completed; score_day returned shape with date=${score.score.date}`);

  // 7. Logs
  console.log("\n--- 7. logs ---");
  const log1 = await invoke<{ log: any }>({
    action: "create_log",
    label: "Stretch break",
    category: "body",
    source: "manual",
  });
  if (!log1.log?.id) fail("log create failed", log1);
  const logs = await invoke<{ logs: any[] }>({ action: "list_logs" });
  if (logs.logs.length < 1) fail("list_logs missing the created log");
  ok(`logs: created + listed`);

  // 8. Settings round-trip
  console.log("\n--- 8. settings ---");
  const settings = await invoke<{ settings: any }>({
    action: "update_settings",
    militant: true,
    probeIntervalMin: 45,
  });
  if (settings.settings.militant !== true) fail("militant not set");
  if (settings.settings.probeIntervalMin !== 45) fail("probe interval wrong");
  ok(`settings updated: militant=true probeInterval=45min`);

  // 9. Save current as template
  console.log("\n--- 9. save_template snapshots live blocks ---");
  const tpl = await invoke<{ template: any }>({
    action: "save_template",
    name: "Morning Workhorse",
    description: "Daily 9-11:30 deep work routine",
  });
  if (!tpl.template?.id) fail("template not created", tpl);
  if (tpl.template.blockCount !== 1) fail("template should snapshot 1 block", tpl);
  const tplId = tpl.template.id;
  ok(`template saved: ${tplId.slice(0, 12)} (1 block)`);

  // 10. Delete the live block, apply template restores it
  console.log("\n--- 10. delete block + apply_template restores ---");
  const del = await invoke<{ deleted: boolean }>({ action: "delete_block", id: blockId });
  if (!del.deleted) fail("delete failed");
  const empty = await invoke<{ blocks: any[] }>({ action: "list_blocks" });
  if (empty.blocks.length !== 0) fail("delete didn't remove block");
  const applied = await invoke<{ blocks: any[]; blockCount: number }>({
    action: "apply_template",
    templateId: tplId,
  });
  if (applied.blockCount !== 1) fail("apply_template didn't restore", applied);
  // Apply replaces blocks — new id, but same shape
  const restored = applied.blocks[0];
  if (restored.label !== "Morning Deep Work") fail("template restore lost label");
  if (restored.startMinute !== 540) fail("template restore lost time");
  if (restored.routineItems.length !== 3) fail("template restore lost routine items");
  ok(`apply_template restored 1 block with original label/time/routine items`);

  // 11. List templates
  console.log("\n--- 11. list_templates ---");
  const listT = await invoke<{ templates: any[] }>({ action: "list_templates" });
  if (listT.templates.length !== 1) fail("expected 1 template", listT);
  if (listT.templates[0].name !== "Morning Workhorse") fail("template name drift");
  ok(`list_templates returns 1 saved template`);

  // 12. Delete template
  console.log("\n--- 12. delete_template ---");
  const delT = await invoke<{ deleted: boolean }>({
    action: "delete_template",
    templateId: tplId,
  });
  if (!delT.deleted) fail("template delete failed");
  ok(`template deleted`);

  await fs.rm(sandbox, { recursive: true, force: true });
  ok("sandbox cleaned");
  console.log("\nOK — Discipline tool end-to-end verified");
}

main().catch(async (err) => {
  console.error("FAIL:", err);
  try { await fs.rm(sandbox, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
