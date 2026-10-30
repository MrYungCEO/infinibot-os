/**
 * Scheduled Agent Tasks — shared types.
 *
 * A ScheduledTask fires on a cron schedule, hands a READ-ONLY review job to an
 * assignee (CLI coder backend or gateway agent) and gets back a work-suggestion
 * report that follows one standard contract ({@link SuggestionReport}). Each
 * suggested item then moves through a standard approval pipeline:
 *
 *   suggested ─approve→ approved → building ─checks pass→ awaiting_deploy
 *        │                         │                         │
 *        ├reject→ rejected         └fail→ build_failed       ├approve deploy→ deploying → deployed
 *        └snooze→ snoozed ─(time)→ suggested                 └reject→ deploy_rejected
 *                                                  deploying ─fail→ deploy_failed
 *
 * Building and deploying are verified goal runs (src/autonomy/goals); nothing
 * merges, pushes or deploys without an explicit approval.
 */

import type { GoalAgentTarget, GoalCheck } from "../goals/types.js";

export type DeliveryChannel = "telegram" | "ui";

export interface RepoSpec {
  /** Short name shown in reports ("cloud-serverless"). */
  label: string;
  /** Absolute path to a checkout / worktree of the repo. */
  path: string;
  /** Branch to review and to base dev worktrees on (default: current HEAD). */
  branch?: string;
  /** Optional sub-paths the review should focus on. */
  focus?: string[];
  /** Free-form notes for the reviewer (what this repo is, how it deploys). */
  notes?: string;
}

export interface ApprovalPolicy {
  /** Every item needs its own approval (the only mode today). */
  mode: "per-item";
  /** On approve, start the dev goal run right away (else wait for a "start" action). */
  autoContinueOnApprove: boolean;
  /** Stop at "awaiting deploy approval" after checks pass. Default true. */
  requireDeployApproval: boolean;
}

export interface ScheduledTaskLimits {
  /** Wall-clock budget for the read-only suggestion run. */
  suggestionTimeoutSec: number;
  /** Max goal-run iterations for the suggestion run (schema-fix retries). */
  suggestionMaxIterations: number;
  /** Max items kept from one report. */
  maxItems: number;
  /** Dev goal-run budget per approved item. */
  devMaxIterations: number;
  devMaxWallClockSec: number;
  devIterationTimeoutSec: number;
  /** Deploy stage budget (command timeout, or goal-run wall clock). */
  deployTimeoutSec: number;
  /** Items building at the same time for this task; the rest wait in "approved". */
  maxConcurrentBuilds: number;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  mode: "per-item",
  autoContinueOnApprove: true,
  requireDeployApproval: true,
};

export const DEFAULT_TASK_LIMITS: ScheduledTaskLimits = {
  suggestionTimeoutSec: 45 * 60,
  suggestionMaxIterations: 3,
  maxItems: 12,
  devMaxIterations: 5,
  devMaxWallClockSec: 2 * 60 * 60,
  devIterationTimeoutSec: 30 * 60,
  deployTimeoutSec: 20 * 60,
  maxConcurrentBuilds: 2,
};

export interface ScheduledTask {
  id: string;
  name: string;
  /** 5- or 6-field cron expression. */
  cron: string;
  /** IANA timezone the cron expression is evaluated in. */
  timezone: string;
  assignee: GoalAgentTarget;
  repos: RepoSpec[];
  /** What to review / focus on; appended to the standard review prompt. */
  instructions: string;
  /** Report template id (only "work-suggestions-v1" today). */
  reportTemplate: string;
  delivery: DeliveryChannel[];
  approval: ApprovalPolicy;
  limits: ScheduledTaskLimits;
  /**
   * Owner-configured deploy command. When set it is used for every item and
   * overrides a `deploy.command` the assignee proposed.
   */
  deployCommand: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunId: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  /** Set by the seeder so it never re-creates a task the owner deleted. */
  seedKey: string | null;
}

// ── Standard report contract (validated by report-schema.ts) ────────────────

export type Priority = "P0" | "P1" | "P2" | "P3";
export type Effort = "S" | "M" | "L";
export type Risk = "low" | "medium" | "high";

export interface RepoHealth {
  repo: string;
  branch: string;
  ahead?: number | null;
  behind?: number | null;
  openPRs?: number | null;
  openIssues?: number | null;
  ci?: string | null;
  failingTests?: string[];
  uncommittedChanges?: number | null;
  staleBranches?: string[];
  deployStatus?: string | null;
  notes?: string;
}

export interface WorkItemPlan {
  /** Ordered steps. */
  steps: string[];
}

export interface WorkItemDeploy {
  steps: string[];
  rollback: string;
  /** Optional exact shell command for the deploy stage (runs in the dev worktree). */
  command?: string;
  /** Post-deploy verification (goal-run check format). */
  checks?: GoalCheck[];
}

export interface SuggestedWorkItem {
  id: string;
  title: string;
  why: string;
  priority: Priority;
  effort: Effort;
  risk: Risk;
  /** Label of the repo (from the task's repo list) the work happens in. */
  repo: string;
  files: string[];
  dev: WorkItemPlan;
  /** Verification in goal-run check format — these gate the dev goal run. */
  checks: GoalCheck[];
  deploy: WorkItemDeploy;
  approvals: string[];
}

export interface SuggestionReport {
  summary: string;
  repos: RepoHealth[];
  items: SuggestedWorkItem[];
}

// ── Runs, items, events ──────────────────────────────────────────────────────

export type TaskRunStatus =
  | "running" // suggestion goal run in progress
  | "validating" // goal run done, validating / rendering / delivering
  | "delivered" // report delivered, items awaiting decisions
  | "failed";

export interface TaskRun {
  id: string;
  taskId: string;
  status: TaskRunStatus;
  trigger: "schedule" | "manual";
  goalId: string | null;
  artifactDir: string;
  report: SuggestionReport | null;
  reportPdfPath: string | null;
  reportId: string | null;
  error: string | null;
  /** Read-only guard: repos whose branch ref moved during the suggestion run. */
  readOnlyViolations: string[];
  /** Branch refs captured before the run (label → sha). */
  refsBefore: Record<string, string>;
  deliveredAt: number | null;
  deliveryError: string | null;
  deliveryAttempts: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export type ItemStage =
  | "suggested"
  | "snoozed"
  | "rejected"
  | "approved"
  | "building"
  | "build_failed"
  | "awaiting_deploy"
  | "deploy_rejected"
  | "deploying"
  | "deploy_failed"
  | "deployed";

export const ITEM_TERMINAL_STAGES: ReadonlySet<ItemStage> = new Set([
  "rejected",
  "deploy_rejected",
  "deployed",
]);

/** Stages that wait for an owner decision. */
export const ITEM_DECISION_STAGES: ReadonlySet<ItemStage> = new Set([
  "suggested",
  "awaiting_deploy",
  "build_failed",
  "deploy_failed",
]);

export interface PipelineItem {
  id: string;
  runId: string;
  taskId: string;
  /** Item id from the report (stable within the run). */
  reportItemId: string;
  item: SuggestedWorkItem;
  stage: ItemStage;
  /** Owner modifications appended to the dev goal. */
  instructions: string[];
  snoozeUntil: number | null;
  devGoalId: string | null;
  deployGoalId: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseSha: string | null;
  diffSummary: string | null;
  testEvidence: string | null;
  deployOutput: string | null;
  /** Detached deploy command bookkeeping (restart-safe). */
  deployPid: number | null;
  deployDir: string | null;
  lastError: string | null;
  /** Telegram message carrying this item's buttons (for edits). */
  tgChatId: string | null;
  tgMessageId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PipelineEvent {
  seq: number;
  itemId: string | null;
  runId: string | null;
  taskId: string;
  from: string | null;
  to: string;
  actor: string;
  note: string | null;
  at: number;
}

export type DecisionAction =
  | "approve"
  | "reject"
  | "modify"
  | "snooze"
  | "start"
  | "approve_deploy"
  | "reject_deploy"
  | "retry"
  | "continue";

export interface Decision {
  action: DecisionAction;
  instruction?: string | null;
  snoozeHours?: number;
  actor?: string;
}

/** The command the deploy stage runs: the owner's task command wins over the agent's proposal. */
export function deployCommandFor(
  task: Pick<ScheduledTask, "deployCommand">,
  item: SuggestedWorkItem,
): string {
  return task.deployCommand?.trim() || item.deploy.command?.trim() || "";
}
