/**
 * Goal runs — `/goal`-style autonomous runs.
 *
 * A goal run = goal text + a list of verifiable completion checks + an agent
 * target. The runner keeps spawning / resuming the agent until every check
 * passes (COMPLETED) or a budget is hit (EXHAUSTED) or something
 * unrecoverable happens (FAILED). Process exit alone never marks success.
 *
 * The same {@link GoalCheck} type is used by the persistent queue's
 * `QueuePhase.gateCriteria` so phase advancement is gated on verification.
 */

export type GoalCheckType = "shell" | "file" | "grep" | "llm" | "visual";

export interface GoalCheck {
  /** Stable id within the run (auto-assigned when omitted). */
  id?: string;
  type: GoalCheckType;
  /** Short human label; defaults to a summary of the check. */
  label?: string;
  /** shell: command run via `bash -lc` in the run workdir. Exit 0 = pass. */
  command?: string;
  /** file / grep: path (relative paths resolve against the run workdir). */
  path?: string;
  /** grep: regex (JS syntax) that must match the file content. */
  pattern?: string;
  /** file: when true the file must NOT exist. grep: when true the pattern must NOT match. */
  negate?: boolean;
  /** llm: natural-language criterion the judge evaluates against output + diff. */
  criterion?: string;
  /** visual: control-UI routes to screenshot via visual_verify (desktop + mobile). */
  routes?: string[];
  /** visual: what the screenshots must show — graded by the vision reviewer. */
  expectation?: string;
  /** visual: worktree whose dist/control-ui to serve (default: the run workdir, else the live UI). */
  worktree?: string;
  /** Per-check timeout (shell / llm / visual). Default 120s (visual 600s). */
  timeoutSec?: number;
}

export interface GoalCheckResult {
  checkId: string;
  pass: boolean;
  /** Trimmed stdout/stderr or judge rationale, capped. */
  output: string;
  durationMs: number;
  at: number;
  /** Where the check ran: periodic timer, end of iteration, manual recheck, boot recovery. */
  trigger: "timer" | "iteration" | "manual" | "recovery";
  iteration: number;
  exitCode?: number | null;
  timedOut?: boolean;
}

/** CLI backends the runner can drive directly. */
export type GoalCliBackend = "claude-code" | "codex" | "opencode" | "gemini" | "grok";

export type GoalAgentTarget =
  | { kind: "cli"; backend: GoalCliBackend; model?: string }
  | { kind: "agent"; agentId: string; model?: string };

export type GoalRunStatus =
  | "queued"
  | "running"
  | "checking"
  | "paused"
  | "completed"
  | "failed"
  | "exhausted"
  | "canceled";

export const GOAL_TERMINAL_STATUSES: ReadonlySet<GoalRunStatus> = new Set([
  "completed",
  "failed",
  "exhausted",
  "canceled",
]);

/**
 * How one iteration ended. Distinct outcomes so the UI and feedback prompt
 * can tell a crash from a hang from "agent said done but checks fail".
 */
export type GoalIterationOutcome =
  | "running"
  | "exited" // clean exit (code 0 / gateway run ok)
  | "nonzero_exit"
  | "crashed" // process vanished / run record missing / spawn died
  | "timeout" // per-iteration timeout hit
  | "hung" // no output for hangSec
  | "claimed_done_checks_failed" // exited ok + claimed done, but checks fail
  | "checks_passed" // checks passed (possibly while still running)
  | "spawn_failed"
  | "canceled"
  | "interrupted"; // paused / gateway restart lost the process

export interface GoalIteration {
  index: number; // 1-based
  runId: string | null;
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: GoalIterationOutcome;
  exitCode: number | null;
  /** Prompt sent to the agent for this iteration (goal / feedback). */
  prompt: string;
  /** Tail of the agent output at the end of the iteration. */
  outputTail: string;
  resumed: boolean;
  note?: string;
  /** Set on the last iteration before an operator retry/continue reopened the run. */
  budgetReset?: boolean;
}

export interface GoalLimits {
  maxIterations: number;
  maxWallClockSec: number;
  iterationTimeoutSec: number;
  checkIntervalSec: number;
  /** No-output window before an iteration is considered hung. */
  hangSec: number;
}

export const DEFAULT_GOAL_LIMITS: GoalLimits = {
  maxIterations: 5,
  maxWallClockSec: 2 * 60 * 60,
  iterationTimeoutSec: 30 * 60,
  checkIntervalSec: 120,
  hangSec: 10 * 60,
};

export interface GoalRun {
  id: string;
  title: string;
  goal: string;
  checks: GoalCheck[];
  target: GoalAgentTarget;
  workdir: string | null;
  projectId: string | null;
  limits: GoalLimits;
  status: GoalRunStatus;
  /** Machine-readable reason for failed / exhausted / canceled. */
  reason: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  /** Wall-clock consumed by earlier active segments (paused time excluded). */
  elapsedMs: number;
  /** Start of the current active segment (null while paused / terminal). */
  activeSince: number | null;
  iterations: GoalIteration[];
  /** Most recent result per check id. */
  lastResults: Record<string, GoalCheckResult>;
  /** Extra instruction queued via goals.continue, consumed by the next spawn. */
  pendingInstruction: string | null;
  /** Session the next iteration should resume (CLI backends that support it). */
  sessionId: string | null;
  lastCheckAt: number | null;
  createdBy: string | null;
  notify: boolean;
}

export interface CreateGoalInput {
  title?: string;
  goal: string;
  checks: GoalCheck[];
  target: GoalAgentTarget;
  workdir?: string | null;
  projectId?: string | null;
  limits?: Partial<GoalLimits>;
  createdBy?: string | null;
  notify?: boolean;
  /** When false the run is created paused (default true = start immediately). */
  start?: boolean;
}
