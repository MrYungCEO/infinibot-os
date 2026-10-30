/**
 * Report kind: `daily_summary` — the 24-hour summary PDF.
 *
 * Implements the foundation {@link ReportKindModule} contract (same shape as
 * `gateway_recovery` and `ceo_hourly_insights`): `collect()` only *reads* source
 * data and returns `{ title, summaryText, html }`; the worker persists the row
 * and prints the HTML to PDF, then fans out to UI + Telegram.
 *
 * The brief asks for two explicit sections:
 *   - "Items Completed"       — kanban tasks moved to `done` + subagent runs that
 *                                finished `complete`, both inside the 24h window.
 *   - "Verification Required" — kanban tasks parked in the `review` column (the
 *                                verification queue) + subagent runs that errored
 *                                or timed out and need a human to look.
 *
 * Config:
 *   - windowMs?: number   (defaults to 24h; lets a caller widen/narrow the range)
 *   - now?: number        (override "now" for deterministic tests)
 *
 * Each source read is wrapped defensively: a single store failure degrades to a
 * `collectionGaps` note in the footer rather than aborting the whole report.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { listSubagentHistory } from "../../agents/subagent-history.js";
import { getKanbanStore } from "../../tasks/store.js";
import type { CollectedReport, ReportKindModule, Theme } from "../types.js";
import {
  buildDailySummaryHtml,
  type CompletedItem,
  type DailySummaryData,
  type VerificationItem,
} from "../templates/daily-summary.js";

export const DAILY_SUMMARY_KIND = "daily_summary" as const;
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Hard cap per section so a backlog flood can't produce a multi-MB PDF. */
export const MAX_ITEMS_PER_SECTION = 60;

function safe<T>(label: string, gaps: string[], fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    gaps.push(`${label}: ${String((err as Error)?.message ?? err)}`);
    return fallback;
  }
}

function resolveStateDir(stateDir?: string): string {
  return stateDir ?? process.env.INFINIBOT_STATE_DIR ?? join(homedir(), ".infinibot");
}

/**
 * Gather the 24h window from kanban + subagent sources. Exported so the cron /
 * tests can build the data without going through the worker.
 */
export async function collectDailySummary(opts?: {
  now?: number;
  windowMs?: number;
  stateDir?: string;
}): Promise<DailySummaryData> {
  const now = opts?.now ?? Date.now();
  const windowMs = opts?.windowMs && opts.windowMs > 0 ? opts.windowMs : DEFAULT_WINDOW_MS;
  const since = now - windowMs;
  const stateDir = resolveStateDir(opts?.stateDir);
  const gaps: string[] = [];

  const completed: CompletedItem[] = [];
  const verification: VerificationItem[] = [];

  // ── Kanban ──────────────────────────────────────────────────────────────
  // Completed: tasks that transitioned to `done` inside the window.
  // Verification: tasks currently in the `review` column (regardless of age —
  // a card sitting in review for >24h is exactly what needs surfacing).
  const store = safe<ReturnType<typeof getKanbanStore> | null>(
    "kanban.store",
    gaps,
    () => getKanbanStore(stateDir),
    null,
  );
  if (store) {
    const doneTasks = safe(
      "kanban.completed",
      gaps,
      () =>
        store
          .listTasksSince(since)
          .filter(
            (t) =>
              t.status === "done" && typeof t.completedAt === "number" && t.completedAt >= since,
          ),
      [],
    );
    for (const t of doneTasks) {
      completed.push({
        source: "task",
        id: t.id,
        title: t.title,
        detail: t.assignee ? `assignee ${t.assignee}` : undefined,
        at: t.completedAt ?? t.updatedAt,
      });
    }

    // Verification queue: tasks currently in the `review` column. getTasks() is
    // async so it gets its own try/catch rather than the sync `safe` wrapper.
    try {
      const all = await store.getTasks();
      // Scope to the window: a *24-hour* summary surfaces cards that entered or
      // moved within the review column in the last day. Without this an imported
      // backlog of thousands of stale review cards floods the PDF.
      for (const t of all) {
        if (t.status === "review" && t.updatedAt >= since) {
          verification.push({
            source: "task",
            id: t.id,
            title: t.title,
            reason: "in review",
            detail: t.assignee ? `assignee ${t.assignee}` : undefined,
            at: t.updatedAt,
          });
        }
      }
    } catch (err) {
      gaps.push(`kanban.review: ${String((err as Error)?.message ?? err)}`);
    }
  }

  // ── Subagents ───────────────────────────────────────────────────────────
  // Completed: history entries that finished `complete` inside the window.
  // Verification: history entries that finished `error` / `timeout` — they ran
  // to an end but the outcome needs a human to verify.
  const history = safe(
    "subagents.history",
    gaps,
    () => listSubagentHistory({ since, limit: 200 }).entries,
    [],
  );
  for (const e of history) {
    if (e.endedAt < since) continue;
    const title = e.label ? `${e.label} — ${e.task}` : e.task;
    if (e.status === "complete") {
      completed.push({
        source: "agent",
        id: e.runId,
        title,
        detail: e.coderBackend ? `backend ${e.coderBackend}` : undefined,
        at: e.endedAt,
      });
    } else {
      verification.push({
        source: "agent",
        id: e.runId,
        title,
        reason: e.status === "timeout" ? "timed out" : "errored",
        detail: e.coderBackend ? `backend ${e.coderBackend}` : undefined,
        at: e.endedAt,
        error: e.error ?? e.outcome?.error ?? null,
      });
    }
  }

  // Most-recent first within each section.
  completed.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  verification.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  // Stats reflect the TRUE totals (before capping) so the headline counts stay
  // honest even when the rendered card list is truncated for size.
  const tasksDone = completed.filter((c) => c.source === "task").length;
  const agentsDone = completed.filter((c) => c.source === "agent").length;
  const reviewTasks = verification.filter((v) => v.source === "task").length;
  const agentsNeedingAttention = verification.filter((v) => v.source === "agent").length;

  // Cap each rendered section; surface how many were hidden (no silent drop).
  const overflow = {
    completed: Math.max(0, completed.length - MAX_ITEMS_PER_SECTION),
    verification: Math.max(0, verification.length - MAX_ITEMS_PER_SECTION),
  };

  return {
    generatedAt: now,
    window: [since, now],
    completed: completed.slice(0, MAX_ITEMS_PER_SECTION),
    verification: verification.slice(0, MAX_ITEMS_PER_SECTION),
    stats: { tasksDone, agentsDone, reviewTasks, agentsNeedingAttention },
    overflow,
    collectionGaps: gaps,
  };
}

/** The foundation contract. The worker calls this; it prints `html` to PDF. */
export const dailySummaryKind: ReportKindModule = {
  kind: DAILY_SUMMARY_KIND,
  async collect({ theme, config, stateDir }): Promise<CollectedReport> {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const windowMs =
      typeof config?.windowMs === "number" && config.windowMs > 0
        ? (config.windowMs as number)
        : DEFAULT_WINDOW_MS;

    const data = await collectDailySummary({ now, windowMs, stateDir });
    const html = buildDailySummaryHtml(data, theme as Theme);

    const completedCount = data.completed.length;
    const verifyCount = data.verification.length;
    const summaryText =
      `${completedCount} item${completedCount === 1 ? "" : "s"} completed · ` +
      `${verifyCount} need${verifyCount === 1 ? "s" : ""} verification ` +
      `(${data.stats.reviewTasks} in review, ${data.stats.agentsNeedingAttention} agent issue${
        data.stats.agentsNeedingAttention === 1 ? "" : "s"
      })`;

    return {
      title: `24-Hour Summary — ${new Date(now).toLocaleDateString()}`,
      summaryText,
      html,
    };
  },
};

export default dailySummaryKind;
