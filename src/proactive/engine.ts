/**
 * Proactive Overhaul v2 — engine (pure)
 *
 * Turns a BusinessSnapshot (business-snapshot.ts) plus the
 * persisted commitment store into the full v2 ProactiveState:
 *   - per-project focus state + drift score
 *   - drift radar (worst-first)
 *   - top-3 commit candidates with reasoning
 *   - active commitment + drift escalation
 *   - "where was I?" re-entry anchor
 *
 * Deterministic + cheap: no IO, no LLM. The gateway RPC does the IO once
 * (gatherBusinessSnapshot + loadProactiveStore) and calls compute here.
 */

import type { BusinessSnapshot, InsightRef } from "./business-snapshot.js";
import type { KanbanTask, KanbanProject, PriorityLevel } from "../tasks/types.js";
import type {
  ProactiveState,
  ProactiveStore,
  ProjectFocusRow,
  ProjectFocusState,
  CommitCandidate,
  ActiveCommitment,
  WhereWasIAnchor,
} from "./types.js";

const DONE = new Set(["done"]);
const DAY_MS = 86_400_000;

const PRIORITY_RANK: Record<PriorityLevel, number> = {
  Immediate: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

function priorityTag(level?: PriorityLevel | string | null): string | null {
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

function parseDue(due?: string): number | null {
  if (!due) return null;
  const m = due.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

function dueLabel(due: string | undefined, now: Date): string {
  const t = parseDue(due);
  if (t == null) return "";
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t < startToday) return "overdue";
  if (t < startToday + DAY_MS) return "due today";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `due ${dow[new Date(t).getDay()]}`;
}

// ── Per-project focus state + drift ──────────────────────────────────────────

interface ProjectAgg {
  project: KanbanProject;
  lastActivityAt: number;
  openCount: number;
  doneCount: number;
  topBlocker: string | null;
}

function aggregateProjects(snap: BusinessSnapshot): Map<string, ProjectAgg> {
  const byId = new Map<string, ProjectAgg>();
  for (const p of snap.projects) {
    byId.set(p.id, {
      project: p,
      lastActivityAt: p.updatedAt ?? 0,
      openCount: 0,
      doneCount: 0,
      topBlocker: null,
    });
  }
  // Fold task activity into the owning project.
  let bestBlockerRank: Record<string, number> = {};
  for (const t of snap.tasks) {
    const agg = byId.get(t.projectId);
    if (!agg) continue;
    if (typeof t.updatedAt === "number" && t.updatedAt > agg.lastActivityAt) {
      agg.lastActivityAt = t.updatedAt;
    }
    if (DONE.has(t.status) || t.done) {
      agg.doneCount += 1;
    } else {
      agg.openCount += 1;
      // The highest-priority open task doubles as the "top blocker" phrase.
      const rank = taskPriorityRank(t);
      const prev = bestBlockerRank[t.projectId];
      if (prev === undefined || rank < prev) {
        bestBlockerRank[t.projectId] = rank;
        agg.topBlocker = t.title;
      }
    }
  }
  return byId;
}

function focusRow(
  agg: ProjectAgg,
  store: ProactiveStore,
  agentsByProject: Record<string, number>,
  now: Date,
): ProjectFocusRow {
  const { project } = agg;
  const inRotation = store.focusedProjectIds.includes(project.id);
  const isCold = store.coldProjectIds.includes(project.id);
  const daysSince =
    agg.lastActivityAt > 0
      ? Math.max(0, Math.floor((now.getTime() - agg.lastActivityAt) / DAY_MS))
      : 999;

  // Drift score: 0 at activity today, +~14/day, capped 100. Cold pins to 100.
  let driftScore = Math.min(100, Math.round(daysSince * 14));
  let state: ProjectFocusState;
  if (isCold) {
    state = "cold";
    driftScore = 100;
  } else if (inRotation) {
    state = daysSince >= store.config.driftDays ? "drifting" : "active";
  } else {
    // Not declared into rotation: running in the background = watch, otherwise cold.
    const hasOpen = agg.openCount > 0;
    state = hasOpen && daysSince < store.config.driftDays * 3 ? "watch" : "cold";
  }

  const total = agg.openCount + agg.doneCount;
  const progress =
    typeof project.progress === "number"
      ? project.progress
      : total > 0
        ? Math.round((agg.doneCount / total) * 100)
        : 0;

  return {
    projectId: project.id,
    name: project.name,
    state,
    driftScore,
    daysSinceActivity: daysSince === 999 ? -1 : daysSince,
    lastActivityAt: agg.lastActivityAt,
    progress,
    agentsOnIt: agentsByProject[project.id] ?? 0,
    topBlocker: agg.topBlocker,
    inRotation,
  };
}

// ── Commit candidates ────────────────────────────────────────────────────────

// How many candidates the engine surfaces. The commit flow only *shows* the top
// 3, but it needs a deeper backlog so that locally dismissing (Reject) a row can
// immediately slide the next-ranked task into the freed slot — without a
// round-trip or ever dropping below 3 while real work remains. Keep this > 3.
const CANDIDATE_POOL = 12;

function buildCandidates(
  snap: BusinessSnapshot,
  rows: ProjectFocusRow[],
  now: Date,
): CommitCandidate[] {
  const driftByProject = new Map(rows.map((r) => [r.projectId, r]));
  const scored = snap.rankedOpenTasks.slice(0, 30).map((t) => {
    const pr = taskPriorityRank(t);
    const due = dueLabel(t.dueDate, now);
    const drift = t.projectId ? (driftByProject.get(t.projectId)?.driftScore ?? 0) : 0;
    // Retained for downstream/debug; ordering below is an explicit comparator,
    // not this blended score, so the top-3 is fully deterministic.
    let score = (5 - pr) * 20;
    if (due === "overdue") score += 40;
    else if (due === "due today") score += 25;
    else if (due.startsWith("due")) score += 10;
    score += Math.round(drift * 0.3);

    const proj = t.projectId ? snap.projects.find((p) => p.id === t.projectId) : undefined;
    const reasonBits: string[] = [];
    const ptag = priorityTag(t.priorityLevel);
    if (ptag) reasonBits.push(ptag);
    if (due) reasonBits.push(due);
    if (drift >= 40 && proj) reasonBits.push(`${proj.name} drifting`);
    if (reasonBits.length === 0) reasonBits.push("top of the open queue");

    return {
      cand: {
        taskId: t.id,
        projectId: t.projectId || null,
        title: t.title,
        projectName: proj?.name ?? null,
        reason: reasonBits.join(" · "),
        score,
        priorityTag: ptag,
        dueLabel: due,
      } satisfies CommitCandidate,
      pr,
      drift,
      updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : 0,
      id: t.id,
    };
  });

  // Deterministic priority-ordered selection (matches the spec, no randomness):
  //   1. priority ascending      — P0/Immediate first
  //   2. drift descending        — most-drifting project's tasks first
  //   3. recently updated first  — fresher work surfaces ahead of stale
  //   4. taskId                  — final stable tiebreak so the order never jitters
  scored.sort(
    (a, b) =>
      a.pr - b.pr ||
      b.drift - a.drift ||
      b.updatedAt - a.updatedAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return scored.slice(0, CANDIDATE_POOL).map((x) => x.cand);
}

// ── Active commitment + drift escalation ─────────────────────────────────────

function buildActive(store: ProactiveStore, now: Date): ActiveCommitment | null {
  const ac = store.activeCommitment;
  if (!ac) return null;
  const elapsedMin = Math.max(0, Math.floor((now.getTime() - ac.startedAt) / 60_000));
  const endsAt = ac.startedAt + ac.durationMin * 60_000;
  const remainingMin = Math.max(0, Math.ceil((endsAt - now.getTime()) / 60_000));
  // Drift escalation is time-since-last-seen based here; the live UI refines it
  // with tab-focus / agent-activity signals, but the server gives an honest floor.
  const idleMin =
    store.lastSeenAt > 0 ? Math.floor((now.getTime() - store.lastSeenAt) / 60_000) : 0;
  let driftLevel: ActiveCommitment["driftLevel"] = "ontrack";
  if (idleMin > 15) driftLevel = "hard-drift";
  else if (idleMin > 5) driftLevel = "soft-drift";
  return {
    taskId: ac.taskId,
    projectId: ac.projectId,
    title: ac.title,
    startedAt: ac.startedAt,
    durationMin: ac.durationMin,
    endsAt,
    elapsedMin,
    remainingMin,
    driftLevel,
  };
}

// ── "Where was I?" anchor ────────────────────────────────────────────────────

function buildWhereWasI(
  snap: BusinessSnapshot,
  store: ProactiveStore,
  rows: ProjectFocusRow[],
  now: Date,
  refs: InsightRef[],
): WhereWasIAnchor {
  const last = store.lastCommitment ?? store.activeCommitment ?? null;
  const sinceAt =
    store.lastSeenAt > 0 ? store.lastSeenAt : last ? ((last as any).endedAt ?? last.startedAt) : 0;
  const idleMin = sinceAt > 0 ? Math.max(0, Math.floor((now.getTime() - sinceAt) / 60_000)) : 0;

  // "While away": tasks that changed since we were last seen.
  const movedSince = snap.tasks.filter(
    (t) => typeof t.updatedAt === "number" && sinceAt > 0 && t.updatedAt >= sinceAt,
  );
  const newlyDone = movedSince.filter((t) => DONE.has(t.status) || t.done).length;
  const moved = movedSince.length;
  const whileAwayBits: string[] = [];
  if (newlyDone > 0) whileAwayBits.push(`${newlyDone} task${newlyDone > 1 ? "s" : ""} finished`);
  if (moved - newlyDone > 0)
    whileAwayBits.push(`${moved - newlyDone} task${moved - newlyDone > 1 ? "s" : ""} moved`);
  if (whileAwayBits.length === 0) whileAwayBits.push("no changes while away");

  // Most important change: the worst-drifting rotation project, or top overdue task.
  let mostImportant: string | null = null;
  const worstDrift = rows.find((r) => r.inRotation && r.state === "drifting");
  if (worstDrift) {
    mostImportant = `${worstDrift.name} is drifting — no progress in ${worstDrift.daysSinceActivity}d.`;
    refs.push({ kind: "project", id: worstDrift.projectId, label: worstDrift.name });
  } else if (snap.overdueTasks.length > 0) {
    const t = snap.overdueTasks[0];
    mostImportant = `"${t.title}" is overdue — on your critical path.`;
    refs.push({ kind: "task", id: t.id, label: t.title });
  }

  if (last) {
    refs.push({ kind: "task", id: last.taskId ?? undefined, label: last.title });
  }

  return {
    lastCommittedTitle: last?.title ?? null,
    lastCommittedTaskId: last?.taskId ?? null,
    lastCommittedProjectId: last?.projectId ?? null,
    idleMin,
    whileAway: whileAwayBits.join(" · "),
    mostImportantChange: mostImportant,
    canResume: !!store.lastCommitment && !store.activeCommitment,
  };
}

// ── Top-level compute ────────────────────────────────────────────────────────

export function computeProactiveState(
  snap: BusinessSnapshot,
  store: ProactiveStore,
  opts: { agentsByProject?: Record<string, number>; now?: Date } = {},
): ProactiveState {
  const now = opts.now ?? new Date();
  const agentsByProject = opts.agentsByProject ?? {};

  const aggs = aggregateProjects(snap);
  const allRows = [...aggs.values()].map((a) => focusRow(a, store, agentsByProject, now));

  // Rotation = declared focus ids, in declared order; everything else considered
  // for watch/extras. Worst-drift first inside each bucket.
  const byDriftDesc = (a: ProjectFocusRow, b: ProjectFocusRow) => b.driftScore - a.driftScore;

  const rotationRows = store.focusedProjectIds
    .map((id) => allRows.find((r) => r.projectId === id))
    .filter((r): r is ProjectFocusRow => !!r);

  const nonRotation = allRows.filter((r) => !r.inRotation);

  const focused = rotationRows.slice(0, store.config.maxFocus).sort(byDriftDesc);
  // Extras = rotation overflow + any non-rotation project that still has activity.
  const overflow = rotationRows.slice(store.config.maxFocus);
  const extras = [...overflow, ...nonRotation.filter((r) => r.state !== "cold")]
    .sort(byDriftDesc)
    .slice(0, 12);

  const driftRadar = [...rotationRows]
    .filter((r) => r.state === "drifting" || r.driftScore >= 28)
    .sort(byDriftDesc);

  const candidates = buildCandidates(snap, allRows, now);
  const active = buildActive(store, now);
  const references: InsightRef[] = [];
  const whereWasI = buildWhereWasI(snap, store, allRows, now, references);

  const p0Tasks = snap.openTasks.filter((t) => taskPriorityRank(t) === 0).length;

  return {
    generatedAt: now.getTime(),
    maxFocus: store.config.maxFocus,
    driftDays: store.config.driftDays,
    focused,
    extras,
    driftRadar,
    candidates,
    active,
    whereWasI,
    summary: {
      focusedCount: focused.length,
      extrasCount: extras.length,
      driftingCount: allRows.filter((r) => r.state === "drifting").length,
      coldCount: allRows.filter((r) => r.state === "cold").length,
      openTasks: snap.openTasks.length,
      p0Tasks,
      overdue: snap.overdueTasks.length,
    },
    references,
  };
}
