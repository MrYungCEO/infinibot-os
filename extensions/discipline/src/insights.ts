/**
 * Discipline Insight Engine (shared)
 *
 * Deterministic, dependency-light engine that turns live business data
 * (kanban tasks, projects, CRM clients, deadlines) into a short, contextual
 * insight + suggested action for each discipline block.
 *
 * This is the SINGLE source of truth for insight logic. Both the web UI and
 * the mobile app reach it through the `discipline.insights` gateway RPC — they
 * never re-implement the logic, only render the result.
 *
 * Design goals:
 *   - Deterministic + cheap: pure functions over a snapshot, no LLM calls.
 *     `computeBlockInsight` runs in microseconds, so it can be called on every
 *     ticker tick. Core's `gatherBusinessSnapshot` (injected) does the IO once.
 *   - Reads REAL data: tasks/projects come from the local-first kanban store,
 *     clients from the CRM role-bridge. Nothing is stubbed — when there is no
 *     data a block simply gets a quieter, honest insight.
 */

import type { DisciplineBlock, DisciplineCategory } from "./types.js";
import type { KanbanTask, PriorityLevel } from "../../../src/tasks/types.js";
import type {
  BusinessSnapshot,
  InsightRef,
  InsightTone,
} from "../../../src/proactive/business-snapshot.js";

export type { BusinessSnapshot, InsightRef, InsightTone };

/** Core's snapshot reader, injected by the plugin (api.runtime.host). */
export type GatherBusinessSnapshot = (stateDir: string) => Promise<BusinessSnapshot>;

// ── Public types ────────────────────────────────────────────────────────────

export interface DisciplineInsight {
  blockId: string;
  /** Short contextual headline, e.g. "Deep work — ship Project X (P0, due Thu)". */
  headline: string;
  /** Imperative next action, e.g. "Open Project X". */
  suggestedAction: string;
  tone: InsightTone;
  references: InsightRef[];
}

export interface DisciplineInsightResult {
  generatedAt: number;
  insights: DisciplineInsight[];
  /** End-of-day-ready rollup of the underlying signal totals. */
  summary: {
    openTasks: number;
    p0Tasks: number;
    overdue: number;
    dueToday: number;
    dueThisWeek: number;
    activeProjects: number;
    awaitingClient: number;
    staleClients: number;
  };
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

/** Human "P0..P3" label for a Notion priority level. */
function priorityTag(level?: PriorityLevel | string | null): string | null {
  if (!level) return null;
  switch (level) {
    case "Immediate":
      return "P0";
    case "High":
      return "P1";
    case "Medium":
      return "P2";
    case "Low":
      return "P3";
    default:
      return null;
  }
}

function taskPriorityRank(t: KanbanTask): number {
  const lvl = t.priorityLevel;
  if (lvl && lvl in PRIORITY_RANK) return PRIORITY_RANK[lvl];
  return 5;
}

// ── Date helpers (local-date based, like the rest of discipline) ─────────────

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

function shortDue(due: string | undefined, now: Date): string {
  const d = parseDue(due);
  if (!d) return "";
  const bucket = dueBucket(due, now);
  if (bucket === "overdue") return "overdue";
  if (bucket === "today") return "due today";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `due ${dow}`;
}

// ── Insight computation (pure) ───────────────────────────────────────────────

function projectName(snap: BusinessSnapshot, projectId?: string): string | null {
  if (!projectId) return null;
  return snap.projects.find((p) => p.id === projectId)?.name ?? null;
}

/** Describe a single task as a compact phrase: "Title (P0, due Thu)". */
function describeTask(t: KanbanTask, now: Date): string {
  const bits: string[] = [];
  const tag = priorityTag(t.priorityLevel);
  if (tag) bits.push(tag);
  const due = shortDue(t.dueDate, now);
  if (due) bits.push(due);
  const suffix = bits.length ? ` (${bits.join(", ")})` : "";
  return `${t.title}${suffix}`;
}

/**
 * Compute the insight for one block against the snapshot. Pure + deterministic.
 * Category drives the lens; a block linked to a specific task/project narrows it.
 */
export function computeBlockInsight(
  block: DisciplineBlock,
  snap: BusinessSnapshot,
  now: Date = new Date(),
): DisciplineInsight {
  const refs: InsightRef[] = [];
  let headline = "";
  let suggestedAction = "";
  let tone: InsightTone = "info";

  // A block linked to a task/project always leads with that link.
  const linkedTask = block.taskId ? snap.tasks.find((t) => t.id === block.taskId) : undefined;
  const linkedProjectName =
    projectName(snap, block.projectId) ??
    (linkedTask ? projectName(snap, linkedTask.projectId) : null);

  const cat: DisciplineCategory = block.category;

  if (cat === "deep-work" || cat === "ops") {
    // Focus / building lens — surface the single most important open task.
    const lead =
      linkedTask && !DONE_STATUSES.has(linkedTask.status) ? linkedTask : snap.rankedOpenTasks[0];
    if (lead) {
      const proj = projectName(snap, lead.projectId);
      headline = `${block.label} — ${describeTask(lead, now)}.`;
      if (snap.openTasks.length > 1) headline += ` ${snap.openTasks.length} open tasks.`;
      suggestedAction = proj ? `Open ${proj}` : "Open task board";
      refs.push({ kind: "task", id: lead.id, label: lead.title });
      if (proj) refs.push({ kind: "project", id: lead.projectId, label: proj });
      const lb = dueBucket(lead.dueDate, now);
      tone =
        taskPriorityRank(lead) === 0 || lb === "overdue"
          ? "urgent"
          : lb === "today"
            ? "warn"
            : "info";
    } else {
      headline = `${block.label} — no open tasks. Plan the next move.`;
      suggestedAction = "Add a task";
      tone = "success";
    }
    // Deadline pressure is worth calling out even mid-focus.
    if (snap.overdueTasks.length > 0) {
      headline += ` ⚠ ${snap.overdueTasks.length} overdue.`;
      refs.push({ kind: "deadline", label: `${snap.overdueTasks.length} overdue` });
      if (tone !== "urgent") tone = "urgent";
    } else if (snap.dueTodayTasks.length > 0) {
      headline += ` ${snap.dueTodayTasks.length} due today.`;
      refs.push({ kind: "deadline", label: `${snap.dueTodayTasks.length} due today` });
      if (tone === "info") tone = "warn";
    }
    return { blockId: block.id, headline, suggestedAction, tone, references: refs };
  }

  if (cat === "meetings") {
    // Client-facing lens — awaiting-client projects + open client work.
    if (snap.awaitingClientProjects.length > 0) {
      const p = snap.awaitingClientProjects[0];
      headline = `${block.label} — ${snap.awaitingClientProjects.length} project${snap.awaitingClientProjects.length > 1 ? "s" : ""} awaiting client (${p.name}).`;
      suggestedAction = `Follow up: ${p.name}`;
      refs.push({ kind: "project", id: p.id, label: p.name });
      tone = "warn";
    } else if (snap.dueThisWeekTasks.length > 0) {
      headline = `${block.label} — ${snap.dueThisWeekTasks.length} deliverable${snap.dueThisWeekTasks.length > 1 ? "s" : ""} due this week to align on.`;
      suggestedAction = "Review week's deadlines";
      refs.push({ kind: "deadline", label: `${snap.dueThisWeekTasks.length} due this week` });
      tone = "info";
    } else {
      headline = `${block.label} — no client items pending. Use it to plan ahead.`;
      suggestedAction = "Plan outreach";
      tone = "success";
    }
    return { blockId: block.id, headline, suggestedAction, tone, references: refs };
  }

  if (cat === "admin") {
    // Housekeeping lens — clients to chase + overdue admin.
    if (snap.staleClients > 0) {
      headline = `${block.label} — ${snap.staleClients} of ${snap.totalClients} clients with no contact in ${STALE_CLIENT_DAYS}+ days.`;
      suggestedAction = "Review clients";
      refs.push({ kind: "client", label: `${snap.staleClients} need follow-up` });
      tone = "warn";
    } else if (snap.overdueTasks.length > 0) {
      headline = `${block.label} — clear ${snap.overdueTasks.length} overdue task${snap.overdueTasks.length > 1 ? "s" : ""}.`;
      suggestedAction = "Clear overdue";
      refs.push({ kind: "deadline", label: `${snap.overdueTasks.length} overdue` });
      tone = "urgent";
    } else {
      headline = `${block.label} — inbox clear. ${snap.totalClients} clients tracked.`;
      suggestedAction = "Tidy backlog";
      tone = "success";
    }
    return { blockId: block.id, headline, suggestedAction, tone, references: refs };
  }

  // body / break / personal — recovery lens, but stay honest about what's next.
  const nextDeadline = snap.dueTodayTasks[0] ?? snap.dueThisWeekTasks[0];
  if (linkedProjectName) {
    headline = `${block.label} — recharge, then back to ${linkedProjectName}.`;
  } else if (nextDeadline) {
    headline = `${block.label} — recharge. Next up: ${describeTask(nextDeadline, now)}.`;
    refs.push({ kind: "task", id: nextDeadline.id, label: nextDeadline.title });
  } else {
    headline = `${block.label} — protect this. Recovery is part of the work.`;
  }
  suggestedAction = "Step away";
  tone = "info";
  return { blockId: block.id, headline, suggestedAction, tone, references: refs };
}

/**
 * Top-level entry: gather the snapshot once and compute an insight for every
 * block, plus a summary rollup suitable for the end-of-day view.
 */
export async function computeDisciplineInsights(
  gather: GatherBusinessSnapshot,
  stateDir: string,
  blocks: DisciplineBlock[],
  now: Date = new Date(),
): Promise<DisciplineInsightResult> {
  const snap = await gather(stateDir);
  const insights = blocks.map((b) => computeBlockInsight(b, snap, now));
  const p0Tasks = snap.openTasks.filter((t) => taskPriorityRank(t) === 0).length;
  return {
    generatedAt: snap.generatedAt,
    insights,
    summary: {
      openTasks: snap.openTasks.length,
      p0Tasks,
      overdue: snap.overdueTasks.length,
      dueToday: snap.dueTodayTasks.length,
      dueThisWeek: snap.dueThisWeekTasks.length,
      activeProjects: snap.activeProjects.length,
      awaitingClient: snap.awaitingClientProjects.length,
      staleClients: snap.staleClients,
    },
  };
}
