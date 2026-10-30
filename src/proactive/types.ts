/**
 * Proactive Overhaul v2 — shared types
 *
 * Implements the data model behind the v2 design proposal:
 *   - Per-project focus state (Active / Watch / Drifting / Cold) + drift score
 *   - Drift radar (priorities sliding toward cold)
 *   - Commitment-enforced focus blocks (suggest → commit → break/complete)
 *   - "Where was I?" re-entry anchor
 *
 * These types are surfaced to web + mobile through the `proactive.*` gateway
 * RPCs. The engine (`engine.ts`) is pure; persistence lives in `commit-store.ts`.
 */

import type { InsightRef } from "./business-snapshot.js";

/** Per-project attention state. */
export type ProjectFocusState = "active" | "watch" | "drifting" | "cold";

/** A single focused project as rendered in the Projects module / drift radar. */
export interface ProjectFocusRow {
  projectId: string;
  name: string;
  state: ProjectFocusState;
  /** 0 (fresh) → 100 (stone cold). Higher = more drift. */
  driftScore: number;
  /** Days since the most recent task/project activity. */
  daysSinceActivity: number;
  /** Unix ms of last activity (max task.updatedAt or project.updatedAt). */
  lastActivityAt: number;
  /** % of open tasks on this project that are done (rough progress). */
  progress: number;
  /** Count of agents currently working this project (0 when unknown). */
  agentsOnIt: number;
  /** Single worst blocker phrase, when one stands out. */
  topBlocker: string | null;
  /** True when this project is inside the declared MAX focus rotation. */
  inRotation: boolean;
}

/** A suggested commitment surfaced by step 1 of the commit flow. */
export interface CommitCandidate {
  taskId: string;
  projectId: string | null;
  title: string;
  projectName: string | null;
  /** One-line "why this, why now" reasoning. */
  reason: string;
  /** Ranking weight (higher = stronger candidate). */
  score: number;
  /** "P0".."P3" or null. */
  priorityTag: string | null;
  /** "overdue" / "due today" / "due Thu" / "". */
  dueLabel: string;
}

/** The active commitment block (the locked Now-bar), or null when free. */
export interface ActiveCommitment {
  taskId: string | null;
  projectId: string | null;
  title: string;
  startedAt: number;
  durationMin: number;
  /** Unix ms when the block is scheduled to end. */
  endsAt: number;
  /** Minutes elapsed since the block started. */
  elapsedMin: number;
  /** Minutes remaining (clamped at 0). */
  remainingMin: number;
  /** "ontrack" | "soft-drift" (>5m) | "hard-drift" (>15m) — drift escalation. */
  driftLevel: "ontrack" | "soft-drift" | "hard-drift";
}

/** The "Where was I?" re-entry anchor shown at the top of the dashboard. */
export interface WhereWasIAnchor {
  /** Last committed task title (or null if there was never a commitment). */
  lastCommittedTitle: string | null;
  lastCommittedTaskId: string | null;
  lastCommittedProjectId: string | null;
  /** Minutes since the last action / last seen. */
  idleMin: number;
  /** Compact "while away" summary line. */
  whileAway: string;
  /** The single most important change, surfaced first. */
  mostImportantChange: string | null;
  /** Whether a previous block can be resumed in one click. */
  canResume: boolean;
}

/** Full proactive state returned by `proactive.state`. */
export interface ProactiveState {
  generatedAt: number;
  /** Declared maximum focused projects (the sacred cap). */
  maxFocus: number;
  /** Days of no progress before a project is "drifting". */
  driftDays: number;
  /** Projects inside the cap, worst-drift first. */
  focused: ProjectFocusRow[];
  /** Projects past the cap — the de-prioritized "Extras" strip. */
  extras: ProjectFocusRow[];
  /** Drift radar: rotation projects sliding Active → Watch → Drifting, ranked. */
  driftRadar: ProjectFocusRow[];
  /** Top-3 suggested commitments (step 1 of the commit flow). */
  candidates: CommitCandidate[];
  /** The active locked commitment, or null. */
  active: ActiveCommitment | null;
  /** The re-entry anchor. */
  whereWasI: WhereWasIAnchor;
  /** Rollup counters for at-a-glance modules. */
  summary: {
    focusedCount: number;
    extrasCount: number;
    driftingCount: number;
    coldCount: number;
    openTasks: number;
    p0Tasks: number;
    overdue: number;
  };
  /** Supporting references (clickable drill-throughs) for the anchor. */
  references: InsightRef[];
}

// ── Persistence model ────────────────────────────────────────────────────────

export interface CommitBreak {
  at: number;
  taskId: string | null;
  reason: string;
}

export interface CommitCompletion {
  at: number;
  taskId: string | null;
  outcome: "shipped" | "blocked";
  next?: string;
}

export interface ProactiveConfig {
  /** Declared MAX focused projects. Default 3, capped at ~5 by the UI. */
  maxFocus: number;
  /** Days with no progress before a project is "drifting". */
  driftDays: number;
}

export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  maxFocus: 3,
  driftDays: 2,
};

/** Persisted proactive store (JSON under STATE_DIR/proactive.json). */
export interface ProactiveStore {
  config: ProactiveConfig;
  /** Project ids the user has declared into the focus rotation. */
  focusedProjectIds: string[];
  /** Project ids explicitly parked (cold), out of rotation. */
  coldProjectIds: string[];
  /** The currently active commitment, or null. */
  activeCommitment: {
    taskId: string | null;
    projectId: string | null;
    title: string;
    startedAt: number;
    durationMin: number;
  } | null;
  /** The previous commitment (for resume / where-was-i). */
  lastCommitment: {
    taskId: string | null;
    projectId: string | null;
    title: string;
    startedAt: number;
    durationMin: number;
    endedAt: number;
  } | null;
  /** Break log — feeds the insights agent over time. */
  breaks: CommitBreak[];
  /** End-of-block completions. */
  completions: CommitCompletion[];
  /** Unix ms the dashboard was last seen (drives idle / while-away). */
  lastSeenAt: number;
  updatedAt: number;
}
