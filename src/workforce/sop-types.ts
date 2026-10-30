/**
 * First-class SOPs and workflows.
 *
 * Before this, `Worker.sopPath` was a string pointing at a YAML file nobody
 * ever wrote, and `wf_recurring_responsibilities` held a title plus a blob of
 * free text. There was no procedure, no acceptance criteria, no version, and
 * nothing an operator could edit in the product.
 *
 * A `Sop` is the procedure itself: ordered steps, declared inputs and outputs,
 * acceptance criteria and a monotonic `version` that bumps on every meaningful
 * edit. A `SopSchedule` attaches one to a worker on a cadence and owns a REAL
 * cron job. A `SopRun` records each materialised execution (scheduled or
 * one-off) and links it to the work item it produced.
 */

import type { WorkItemPriority } from "./types.js";

export const SOP_STATUSES = ["draft", "active", "retired"] as const;
export type SopStatus = (typeof SOP_STATUSES)[number];

export const SOP_TRIGGERS = ["manual", "schedule", "event"] as const;
export type SopTrigger = (typeof SOP_TRIGGERS)[number];

export const SOP_CADENCES = ["daily", "weekly", "monthly"] as const;
export type SopCadence = (typeof SOP_CADENCES)[number];

export const SOP_RUN_STATUSES = ["pending", "materialised", "failed", "cancelled"] as const;
export type SopRunStatus = (typeof SOP_RUN_STATUSES)[number];

export interface SopStep {
  /** 1-based position. Renumbered densely by the store on every write. */
  order: number;
  title: string;
  /** What the employee actually does at this step. */
  instruction: string;
  /** What this step must leave behind before the next one starts. */
  expectedOutput: string | null;
  /** A failed optional step does not fail the procedure. */
  required: boolean;
  /** Free-form hint: a tool, an RPC, a report, a checklist location. */
  toolHint: string | null;
}

export interface SopIo {
  name: string;
  description: string;
  required: boolean;
}

export interface Sop {
  id: string;
  agencyId: string;
  /** Unique, human-typed key inside the agency (e.g. `cmo-weekly-content-review`). */
  slug: string;
  name: string;
  summary: string;
  /** Role/worker accountable for the procedure. */
  ownerWorkerId: string | null;
  /** Seed role id (`cmo`, `pm`, …) when this SOP came from the starter set. */
  ownerRoleId: string | null;
  category: string;
  status: SopStatus;
  /** Bumped by the store whenever the procedure body changes. */
  version: number;
  steps: SopStep[];
  inputs: SopIo[];
  outputs: SopIo[];
  acceptanceCriteria: string[];
  tags: string[];
  defaultPriority: WorkItemPriority;
  estimatedMinutes: number;
  /** `seed` rows are reconciled by the seeder; `operator` rows never are. */
  source: "seed" | "operator";
  /** Stable key used by the idempotent seeder. Null for operator SOPs. */
  seedKey: string | null;
  /**
   * Seed generation this row was last reconciled onto. 0 for operator SOPs.
   * Plays exactly the role `metadata.roleSeedVersion` plays for seeded workers:
   * the seeder rewrites a `seed` row once when this is behind
   * `SOP_SEED_VERSION`, and never touches it again — so operator edits are not
   * clobbered on every call.
   */
  seedVersion: number;
  createdAt: number;
  updatedAt: number;
}

export type SopInput = {
  id?: string;
  slug: string;
  name: string;
  summary?: string;
  ownerWorkerId?: string | null;
  ownerRoleId?: string | null;
  category?: string;
  status?: SopStatus;
  steps?: Array<Partial<SopStep> & { title: string; instruction: string }>;
  inputs?: Array<Partial<SopIo> & { name: string }>;
  outputs?: Array<Partial<SopIo> & { name: string }>;
  acceptanceCriteria?: string[];
  tags?: string[];
  defaultPriority?: WorkItemPriority;
  estimatedMinutes?: number;
  source?: "seed" | "operator";
  seedKey?: string | null;
  seedVersion?: number;
};

export type SopPatch = Partial<Omit<SopInput, "id" | "slug">> & { slug?: string };

/**
 * An SOP attached to a worker on a cadence.
 *
 * Two things are kept in lockstep by `attachSopSchedule`:
 *  - `cronJobName` — a real, operator-visible job in the cron service;
 *  - `responsibilityId` — the `wf_recurring_responsibilities` row whose
 *    `tick()` actually materialises the work item.
 */
export interface SopSchedule {
  id: string;
  agencyId: string;
  sopId: string;
  workerId: string;
  managerWorkerId: string | null;
  cadence: SopCadence;
  interval: number;
  weekday: number | null;
  monthDay: number | null;
  /** HH:MM, UTC (matching `RecurringResponsibility.runAt`). */
  runAt: string;
  timezone: string;
  slaMinutes: number;
  priority: WorkItemPriority;
  enabled: boolean;
  cronJobName: string;
  cronJobId: string | null;
  responsibilityId: string | null;
  nextRunAt: number;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type SopScheduleInput = {
  id?: string;
  sopId: string;
  workerId: string;
  managerWorkerId?: string | null;
  cadence?: SopCadence;
  interval?: number;
  weekday?: number | null;
  monthDay?: number | null;
  runAt?: string;
  timezone?: string;
  slaMinutes?: number;
  priority?: WorkItemPriority;
  enabled?: boolean;
  nextRunAt?: number;
};

export interface SopRun {
  id: string;
  agencyId: string;
  sopId: string;
  scheduleId: string | null;
  workerId: string;
  workItemId: string | null;
  trigger: SopTrigger;
  /** The SOP version that was in force when the run was created. */
  sopVersion: number;
  status: SopRunStatus;
  note: string | null;
  scheduledFor: number;
  createdAt: number;
  updatedAt: number;
}
