/**
 * Shared types for the three KIS Phase 1 **operations agents** (§19–§21):
 *   • Daily CEO Briefing Agent    (§19)
 *   • Operations Monitor Agent    (§20)
 *   • Project Health Agent        (§21)
 *
 * These agents READ the live Phase 1 object stores and the foundation rules
 * (src/business-objects/rules.ts). They OBSERVE and RECOMMEND only — Phase 1
 * authority L0–L2 (§32); they never mutate a store or act autonomously (§24).
 *
 * The agent core is written as **pure functions over an `OpsInputs` snapshot**
 * so it can be unit-tested with hand-seeded records without touching SQLite.
 * `collectOpsInputs()` (inputs.ts) is the only place that reads the real
 * singleton stores; the gateway RPCs collect a snapshot then call the pure fns.
 */

import type { Opportunity } from "../../opportunity/types.js";
import type { Product } from "../../product/types.js";
import type { Decision } from "../../decision/types.js";
import type { Risk } from "../../risk/types.js";
import type { Commitment } from "../../commitment/types.js";
import type { Person } from "../../person/types.js";
import type { Issue } from "../../issues/types.js";
import type { KanbanTask, KanbanProject } from "../../tasks/types.js";

export type {
  Opportunity,
  Product,
  Decision,
  Risk,
  Commitment,
  Person,
  Issue,
  KanbanTask,
  KanbanProject,
};

/**
 * A frozen snapshot of every store the ops agents read. `now` is injected so
 * runs are deterministic in tests. All arrays default to empty.
 */
export interface OpsInputs {
  /** Evaluation clock (Unix ms). */
  now: number;
  tasks: KanbanTask[];
  projects: KanbanProject[];
  decisions: Decision[];
  opportunities: Opportunity[];
  risks: Risk[];
  commitments: Commitment[];
  persons: Person[];
  issues: Issue[];
}

/** A single actionable line the CEO briefing surfaces. */
export interface BriefingItem {
  /** Source object kind, for the dashboard to route a click. */
  kind: "task" | "decision" | "risk" | "opportunity" | "commitment" | "project" | "issue";
  /** Source record id. */
  id: string;
  /** One-line, decision-ready summary (never a vague question — §17). */
  summary: string;
  /** Why this needs the CEO now (grounded in a real flag/date, never manufactured). */
  why: string;
  /** Priority of the underlying record (P0–P3) where known. */
  priority?: string;
  /** ISO date this is due, when a real deadline drives it. */
  dueDate?: string;
  /** Client this concerns, when relevant. */
  clientId?: string;
}

/** §19 Daily CEO Briefing — max ~5–10 TODAY items, then a no-action FYI. */
export interface CeoBriefing {
  generatedAt: number;
  /** L0–L2; this agent observes/recommends only (§24, §32). */
  authorityLevel: "L1";
  today: {
    /** 1. Actions only the CEO can perform. */
    ceoActions: BriefingItem[];
    /** 2. Decisions required (CEO queue). */
    decisionsRequired: BriefingItem[];
    /** 3. Critical blockers. */
    criticalBlockers: BriefingItem[];
    /** 4. Important client matters. */
    clientMatters: BriefingItem[];
    /** 5. Upcoming deadlines. */
    upcomingDeadlines: BriefingItem[];
  };
  /** Total count across the five TODAY buckets (capped to ~10). */
  todayCount: number;
  /** "FYI — NO ACTION REQUIRED": short, honest summary. No urgency invented. */
  fyi: string[];
  /** True when nothing genuinely needs the CEO today (an honest quiet day). */
  quietDay: boolean;
}

/** One exception the Operations Monitor found. */
export interface Exception {
  kind:
    | "overdue_task"
    | "missing_owner"
    | "missing_deadline"
    | "stale_project"
    | "missing_next_action"
    | "blocked_work"
    | "upcoming_milestone"
    | "overdue_invoice"
    | "risk_needs_review"
    | "opportunity_no_followup"
    | "decision_deadline_approaching";
  objectType: "task" | "project" | "opportunity" | "risk" | "commitment" | "decision" | "person";
  id: string;
  title: string;
  detail: string;
  owner?: string;
  priority?: string;
  dueDate?: string;
}

/** A named exception group in the monitor's exception report. */
export interface ExceptionGroup {
  kind: Exception["kind"];
  label: string;
  count: number;
  items: Exception[];
}

/** §20 Operations Monitor — an exception report, not a summary of everything. */
export interface ExceptionReport {
  generatedAt: number;
  authorityLevel: "L1";
  totalExceptions: number;
  /** Only non-empty groups are included. */
  groups: ExceptionGroup[];
  /** True when the org is clean — no exceptions found. */
  clean: boolean;
}

export type HealthStatus = "Green" | "Yellow" | "Red";

/** §21 Project Health — one project's rating with the WHY behind it. */
export interface ProjectHealth {
  projectId: string;
  name: string;
  status: HealthStatus;
  /** Human-readable reasons the status was assigned (the agent MUST explain why). */
  reasons: string[];
  /** Structured signals the rating was derived from, for the dashboard. */
  signals: {
    openTasks: number;
    overdueTasks: number;
    blockedTasks: number;
    unassignedTasks: number;
    overdueInvoices: number;
    criticalRisks: number;
    clientRisks: number;
    stale: boolean;
    missingNextAction: boolean;
    dueDate?: string;
    deadlinePassed: boolean;
  };
}

/** §21 Project Health report across every active project. */
export interface ProjectHealthReport {
  generatedAt: number;
  authorityLevel: "L1";
  counts: { green: number; yellow: number; red: number };
  projects: ProjectHealth[];
}
