/**
 * DRY-RUN of the verification → kanban sweep against LIVE data. Read-only:
 * reads ~/.infinibot/subagents/{runs,history}.json + verification/records.json
 * and queries the Notion tasks DB (To do / In progress only). Never writes.
 *
 *   node --import tsx scripts/dev/kanban-reconcile-dry-run.ts [--older-min 30] [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getNotionApiKeyOrNull, resolveNotionDbId } from "../../src/databases/notion-config.js";
import {
  runLinkFromRunReview,
  sweepStalledRunTasks,
  type BoardTask,
  type RunLink,
} from "../../src/verification/kanban-reconcile.js";
import type { CompletionRecord } from "../../src/verification/store.js";

const args = process.argv.slice(2);
const olderMin = Number(args[args.indexOf("--older-min") + 1]) || 30;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const stateDir = process.env.INFINIBOT_STATE_DIR || path.join(os.homedir(), ".infinibot");

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const runsFile = readJson<{ runs?: Record<string, any> }>(path.join(stateDir, "subagents", "runs.json"), {});
const history = readJson<any>(path.join(stateDir, "subagents", "history.json"), []);
const historyEntries: any[] = Array.isArray(history) ? history : (history.entries ?? []);
const records = new Map<string, CompletionRecord>(
  (readJson<{ records?: CompletionRecord[] }>(path.join(stateDir, "verification", "records.json"), {}).records ?? []).map(
    (r) => [r.runId, r],
  ),
);

const links = new Map<string, RunLink>();
for (const e of Object.values(runsFile.runs ?? {})) {
  if (!e?.kanbanTaskId) continue;
  links.set(e.runId, {
    runId: e.runId,
    kanbanTaskId: e.kanbanTaskId,
    respawnOfRunId: e.respawnOfRunId,
    label: e.label,
    task: e.task,
    endedAt: e.endedAt,
    outcomeStatus: e.outcome?.status,
    live: e.endedAt == null,
  });
}
for (const a of historyEntries) {
  if (!a?.kanbanTaskId || links.has(a.runId)) continue;
  links.set(a.runId, {
    runId: a.runId,
    kanbanTaskId: a.kanbanTaskId,
    label: a.label,
    task: a.task,
    endedAt: a.endedAt,
    outcomeStatus: a.outcome?.status ?? (a.status === "complete" ? "ok" : a.status),
    live: false,
  });
}

const runReviews = readJson<{ reviews?: any[] }>(path.join(stateDir, "subagents", "run-reviews.json"), {}).reviews ?? [];
for (const r of runReviews) {
  if (links.has(r.runId)) continue;
  const link = runLinkFromRunReview(r);
  if (link) links.set(r.runId, link);
}

async function notionBoard(): Promise<BoardTask[]> {
  const key = getNotionApiKeyOrNull();
  const db = resolveNotionDbId("kanban-tasks");
  if (!key || !db) throw new Error("Notion key / tasks DB not configured");
  const out: BoardTask[] = [];
  const map: Record<string, string> = { "Not started": "todo", "In progress": "in_progress" };
  for (const name of Object.keys(map)) {
    let cursor: string | undefined;
    do {
      const res = await fetch(`https://api.notion.com/v1/databases/${db}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: { property: "Status Update", status: { equals: name } },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Notion query ${res.status}: ${await res.text()}`);
      const j: any = await res.json();
      for (const p of j.results ?? []) {
        const titleProp = Object.values(p.properties ?? {}).find((v: any) => v?.type === "title") as any;
        out.push({
          id: p.id,
          title: (titleProp?.title ?? []).map((t: any) => t.plain_text).join(""),
          status: p.properties?.Done?.checkbox ? "done" : map[name],
          projectId: p.properties?.Project?.relation?.[0]?.id ?? "",
        });
      }
      cursor = j.has_more ? j.next_cursor : undefined;
    } while (cursor);
  }
  return out;
}

const board = await notionBoard();
const report = await sweepStalledRunTasks({
  dryRun: true,
  olderThanMs: olderMin * 60_000,
  runs: [...links.values()],
  deps: {
    listTasks: async () => board,
    updateTask: async () => {
      throw new Error("dry-run: no writes");
    },
    appendNote: async () => {
      throw new Error("dry-run: no writes");
    },
    resolveRun: (id) => links.get(id) ?? null,
    getRecord: (id) => records.get(id),
  },
});

const runLinkedTaskIds = new Set([...links.values()].map((l) => l.kanbanTaskId!.replace(/-/g, "")));
const openBoard = board.filter((t) => t.status === "in_progress" || t.status === "todo");
const unlinked = openBoard.filter((t) => !runLinkedTaskIds.has(t.id.replace(/-/g, "")));
const byState: Record<string, number> = {};
for (const c of report.candidates) byState[c.state] = (byState[c.state] ?? 0) + 1;
const byTarget: Record<string, number> = {};
for (const c of report.candidates) {
  const k = `${c.plan.label}`;
  byTarget[k] = (byTarget[k] ?? 0) + 1;
}

console.log(`board: ${openBoard.length} open tasks (${board.filter((t) => t.status === "in_progress").length} In progress, ${board.filter((t) => t.status === "todo").length} To do)`);
console.log(`runs linked to a kanban task: ${links.size} (registry ${Object.keys(runsFile.runs ?? {}).length}, history ${historyEntries.length}, run reviews ${runReviews.length})`);
console.log(`open tasks with a linked run: ${openBoard.length - unlinked.length}; without: ${unlinked.length}`);
console.log(`would reconcile: ${report.candidates.length}`, byTarget, "by state:", byState);
console.log(`skipped: ${report.skipped.length}`);
for (const s of report.skipped) console.log(`  skip ${s.taskId ?? ""} ${s.runId}: ${s.reason}`);
for (const c of report.candidates)
  console.log(
    `  ${c.taskStatus.padEnd(11)} → ${c.plan.label.padEnd(8)} [${c.state}/${c.stateSource}] ${c.title?.slice(0, 70)} (run ${c.runId}, ended ${c.endedAt ? new Date(c.endedAt).toISOString() : "?"})`,
  );
const refs = report.updates.filter((u) => u.relation !== "primary");
if (refs.length) {
  console.log(`non-primary (referenced / respawn / suggested): ${refs.length}`);
  for (const u of refs) console.log(`  ${u.relation} ${u.title ?? u.taskId} → ${u.to ?? "-"} (${u.outcome}${u.reason ? `: ${u.reason}` : ""})`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ report, unlinked }, null, 2));
