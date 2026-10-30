/**
 * Business snapshot (core).
 *
 * Folds live business data (kanban tasks + projects, CRM clients, deadlines)
 * into one cheap, deterministic snapshot. Consumers: the proactive engine
 * (core) and — through `api.runtime.host.gatherBusinessSnapshot` — the
 * Discipline plugin's per-block insight engine.
 *
 * Moved out of `src/discipline/insights.ts` when Discipline became a plugin:
 * the snapshot is business data, not a Discipline feature, and core must
 * build and run with the plugin off.
 */

import type { KanbanTask, KanbanProject, PriorityLevel } from "../tasks/types.js";
import { getKanbanStore } from "../tasks/store.js";
import { listBusinessBrandingSummaries } from "../business/branding.js";
import { listRowsForBusinessRole } from "../databases/system-role-bridge.js";

export type InsightTone = "info" | "warn" | "urgent" | "success";

export interface InsightRef {
  kind: "task" | "project" | "client" | "deadline";
  label: string;
  id?: string;
}

/** A pre-computed view of business state shared by every block's insight. */
export interface BusinessSnapshot {
  generatedAt: number;
  tasks: KanbanTask[];
  projects: KanbanProject[];
  openTasks: KanbanTask[];
  /** Open tasks sorted by priority (P0 first) then due date. */
  rankedOpenTasks: KanbanTask[];
  overdueTasks: KanbanTask[];
  dueTodayTasks: KanbanTask[];
  dueThisWeekTasks: KanbanTask[];
  activeProjects: KanbanProject[];
  /** Projects parked waiting on the client / external input. */
  awaitingClientProjects: KanbanProject[];
  /** Projects paused / not-started that count as stalled. */
  stalledProjects: KanbanProject[];
  totalClients: number;
  /** Clients with no update in `STALE_CLIENT_DAYS`+ days. */
  staleClients: number;
}

// ── Tunables ────────────────────────────────────────────────────────────────

const STALE_CLIENT_DAYS = 14;
const DONE_STATUSES = new Set(["done"]);

const PRIORITY_RANK: Record<PriorityLevel, number> = {
  Immediate: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

function taskPriorityRank(t: KanbanTask): number {
  const lvl = t.priorityLevel;
  if (lvl && lvl in PRIORITY_RANK) return PRIORITY_RANK[lvl];
  return 5;
}

// ── Date helpers (local-date based) ──────────────────────────────────────────

function localDateIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a kanban `dueDate` ("yyyy-mm-dd" or ISO) into a local Date at 00:00, or null. */
function parseDue(due?: string): Date | null {
  if (!due || typeof due !== "string") return null;
  const m = due.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

type DueBucket = "overdue" | "today" | "week" | "later" | "none";

function dueBucket(due: string | undefined, now: Date): DueBucket {
  const d = parseDue(due);
  if (!d) return "none";
  const todayIso = localDateIso(now);
  const dIso = localDateIso(d);
  if (dIso < todayIso) return "overdue";
  if (dIso === todayIso) return "today";
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  if (d.getTime() <= weekEnd.getTime()) return "week";
  return "later";
}

// ── Snapshot gathering (the only IO) ─────────────────────────────────────────

const ACTIVE_PROJECT_STATUSES = new Set(["In progress", "Updating", "Reviewing"]);
const AWAITING_CLIENT_STATUSES = new Set(["Awaiting Client"]);
const STALLED_PROJECT_STATUSES = new Set(["Paused", "Not started"]);

/**
 * Read live business data and fold it into a snapshot. Cheap and local-first:
 * the kanban store serves from SQLite, CRM rows from the role bridge. All IO is
 * wrapped so a single failing source degrades gracefully instead of throwing.
 */
export async function gatherBusinessSnapshot(
  stateDir: string,
  now: Date = new Date(),
): Promise<BusinessSnapshot> {
  let tasks: KanbanTask[] = [];
  let projects: KanbanProject[] = [];
  try {
    const store = getKanbanStore(stateDir);
    [tasks, projects] = await Promise.all([store.getTasks(), store.getProjects()]);
  } catch {
    /* kanban unavailable — degrade to empty */
  }

  const openTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status) && !t.done);

  const rankedOpenTasks = [...openTasks].sort((a, b) => {
    const pr = taskPriorityRank(a) - taskPriorityRank(b);
    if (pr !== 0) return pr;
    const da = parseDue(a.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const db = parseDue(b.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return da - db;
  });

  const overdueTasks = openTasks.filter((t) => dueBucket(t.dueDate, now) === "overdue");
  const dueTodayTasks = openTasks.filter((t) => dueBucket(t.dueDate, now) === "today");
  const dueThisWeekTasks = openTasks.filter((t) => {
    const b = dueBucket(t.dueDate, now);
    return b === "today" || b === "week";
  });

  const activeProjects = projects.filter((p) => p.status && ACTIVE_PROJECT_STATUSES.has(p.status));
  const awaitingClientProjects = projects.filter(
    (p) => p.status && AWAITING_CLIENT_STATUSES.has(p.status),
  );
  const stalledProjects = projects.filter(
    (p) => p.status && STALLED_PROJECT_STATUSES.has(p.status),
  );

  // CRM clients across every configured business (clients are per-business
  // rows; summing is deterministic and avoids "active business" resolution).
  let totalClients = 0;
  let staleClients = 0;
  try {
    const staleCutoff = now.getTime() - STALE_CLIENT_DAYS * 86_400_000;
    for (const biz of listBusinessBrandingSummaries()) {
      const rows = listRowsForBusinessRole("clients", biz.id, { limit: 1000 });
      totalClients += rows.length;
      for (const r of rows) {
        if (typeof r.updatedAt === "number" && r.updatedAt < staleCutoff) staleClients += 1;
      }
    }
  } catch {
    /* CRM unavailable — clients stay at 0 */
  }

  return {
    generatedAt: now.getTime(),
    tasks,
    projects,
    openTasks,
    rankedOpenTasks,
    overdueTasks,
    dueTodayTasks,
    dueThisWeekTasks,
    activeProjects,
    awaitingClientProjects,
    stalledProjects,
    totalClients,
    staleClients,
  };
}
