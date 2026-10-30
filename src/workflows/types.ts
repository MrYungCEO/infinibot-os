/**
 * Workflow system types.
 *
 * A workflow is a markdown document with YAML frontmatter that describes
 * a repeatable, runnable task. Beyond plain CRUD on the body text, the
 * frontmatter declares:
 *
 *   - `inputs[]`  — typed dynamic inputs the user fills in at run time.
 *                   `{{name}}` placeholders in the body are interpolated
 *                   from the supplied input values.
 *   - `requires[]`— capabilities the runner must verify are present before
 *                   the workflow is allowed to start (tools, MCP servers,
 *                   env vars, channels, federation nodes).
 *   - `agent`     — which agent identity to spawn for the run (default `main`).
 *   - `model`     — optional model override.
 *   - `timeoutSeconds` — hard cap on run duration.
 *
 * All workflow runs are tracked by the runner and addressable by `runId`.
 */

// ── Input schema ─────────────────────────────────────────────────────

export type WorkflowInputType =
  | "string"
  | "text" // multi-line string
  | "number"
  | "boolean"
  | "select" // single choice from `options`
  | "multiSelect" // multiple choices from `options`
  | "url"
  | "email"
  | "date";

export interface WorkflowInputDef {
  /** Stable identifier — used in `{{name}}` interpolation in the body. */
  name: string;
  /** Display label; defaults to a humanized `name`. */
  label?: string;
  /** Help text shown under the input in the run dialog. */
  description?: string;
  /** Storage / form-control type. */
  type: WorkflowInputType;
  /** Required = true → cannot start without a value. */
  required?: boolean;
  /** Default value if the user leaves it blank. */
  default?: string | number | boolean | string[];
  /** For select / multiSelect. */
  options?: Array<{ value: string; label?: string }>;
  /** For string / text — regex (string source). */
  pattern?: string;
  /** For string / text — placeholder shown in the input. */
  placeholder?: string;
  /** For number — min / max bounds (inclusive). */
  min?: number;
  max?: number;
}

// ── Required capabilities ────────────────────────────────────────────

export type WorkflowRequirementKind =
  | "tool" // an agent tool name must be available
  | "mcp" // an MCP server must be connected
  | "env" // an env var must be set (and optionally non-empty)
  | "channel" // a channel must be configured + enabled
  | "node" // a federation node must be online
  | "model"; // a specific model identifier must be reachable

export interface WorkflowRequirement {
  kind: WorkflowRequirementKind;
  /** Identifier scoped to the kind (tool name, MCP id, env var name, channel id, node id, model id). */
  name: string;
  /** Human-readable explanation of why this requirement exists. */
  reason?: string;
  /** If true and the requirement is missing, preflight returns warning instead of error. */
  optional?: boolean;
}

// ── Workflow document ────────────────────────────────────────────────

/**
 * Discriminates between one-shot workflows (the original kind) and
 * autonomous-control workflows that run continuously across many iterations
 * until stopped. Defaults to "static" so existing workflows are unaffected.
 */
export type WorkflowKind = "static" | "continuous";

/**
 * Stop conditions for continuous workflows.
 *   - "manual": only stops via user action (default; truly continuous).
 *   - "iteration_limit": stops once iteration count hits maxIterations.
 *   - "error_streak": stops once consecutive failed iterations hits errorStreakThreshold.
 *   - "predicate": stops when the runner observes a special sentinel in iteration output.
 */
export type ContinuousStopReason = "manual" | "iteration_limit" | "error_streak" | "predicate";

export interface ContinuousConfig {
  /** Pause between iteration N's completion and iteration N+1's start, in seconds. 0 = back-to-back. */
  iterationIntervalSeconds: number;
  /** Hard ceiling on iterations. null = unbounded (rely on manual stop). */
  maxIterations: number | null;
  /** Per-iteration timeout, in seconds. Falls back to `timeoutSeconds` if unset. */
  iterationTimeoutSeconds?: number;
  /** Auto-stop after this many consecutive failed iterations. 0 = never. */
  errorStreakThreshold: number;
  /** Which stop conditions to honor. `manual` is always honored regardless. */
  stopOn: ContinuousStopReason[];
}

export interface WorkflowMeta {
  /** Unique workflow ID (slug-style). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description. */
  description?: string;
  /** Tags for categorization and search. */
  tags?: string[];
  /** Agent that created/owns this workflow (audit). */
  author?: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
  /** Notion page ID if synced. */
  notionPageId?: string;
  /** Notion last sync timestamp. */
  notionSyncedAt?: string;
  // ── Run-time configuration ────────────────────────────────
  /** "static" (default, one-shot) or "continuous" (autonomous-control loop). */
  kind?: WorkflowKind;
  /** Required when kind === "continuous"; ignored otherwise. */
  continuous?: ContinuousConfig;
  /** Typed dynamic inputs collected from the user before run. */
  inputs?: WorkflowInputDef[];
  /** Capabilities verified at preflight before the run is allowed. */
  requires?: WorkflowRequirement[];
  /** Which agent to spawn for the run (default `main`). */
  agent?: string;
  /** Optional model override. */
  model?: string;
  /** Hard timeout in seconds (default 600). Applies per-iteration for continuous workflows. */
  timeoutSeconds?: number;
}

export interface Workflow extends WorkflowMeta {
  /** Full markdown body (without frontmatter). */
  body: string;
}

export interface WorkflowListItem extends WorkflowMeta {
  /** First ~200 chars of body for preview. */
  preview: string;
  /** Character count of body. */
  bodyLength: number;
}

export interface WorkflowCreateParams {
  name: string;
  description?: string;
  tags?: string[];
  body: string;
  author?: string;
  /** Optional custom ID (auto-generated from name if not provided). */
  id?: string;
  kind?: WorkflowKind;
  continuous?: ContinuousConfig;
  inputs?: WorkflowInputDef[];
  requires?: WorkflowRequirement[];
  agent?: string;
  model?: string;
  timeoutSeconds?: number;
}

export interface WorkflowUpdateParams {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  body?: string;
  notionPageId?: string;
  notionSyncedAt?: string;
  kind?: WorkflowKind;
  continuous?: ContinuousConfig;
  inputs?: WorkflowInputDef[];
  requires?: WorkflowRequirement[];
  agent?: string;
  model?: string;
  timeoutSeconds?: number;
}

export interface WorkflowSearchParams {
  query?: string;
  tags?: string[];
  author?: string;
  limit?: number;
}

// ── Run records ──────────────────────────────────────────────────────

export type WorkflowRunStatus =
  | "pending" // accepted, agent not yet spawned
  | "running" // agent session active (or, for continuous, daemon loop active)
  | "paused" // continuous-only: daemon paused via autonomy pause or user
  | "completed" // agent returned successfully (continuous: stopped cleanly)
  | "failed" // preflight error or agent error
  | "cancelled" // user cancelled
  | "timeout"; // exceeded timeoutSeconds

/**
 * One iteration of a continuous workflow run. Each iteration is essentially a
 * mini one-shot run with its own session, audit trail, and outcome.
 */
export interface WorkflowIteration {
  /** 1-based iteration index inside the parent continuous run. */
  number: number;
  startedAt: string;
  finishedAt?: string;
  /** Status mirrors the single-iteration runner outcome (pending/running/completed/failed/timeout). */
  status: Exclude<WorkflowRunStatus, "paused">;
  /** Spawned session for this iteration (one session per iteration). */
  sessionKey?: string;
  spawnRunId?: string;
  /** PTY id when this iteration ran in terminal mode. Lets the UI re-attach
   *  to the live Claude Code TUI even after the iteration completed. */
  terminalId?: string;
  /** Final result text from the iteration's agent (if any). */
  result?: string;
  error?: string;
  /** ms wall-clock duration. */
  durationMs?: number;
}

/**
 * Workflow execution mode — gateway agent (default) or a CLI in a long-lived PTY.
 * Mirrors TaskExecutionMode from src/autonomy/types.ts so the two systems
 * carry the same option surface.
 */
export type WorkflowExecutionMode = "gateway" | "terminal";
export type WorkflowCliKind = "claude" | "opencode" | "gemini" | "codex" | "grok";

export interface WorkflowPreflightIssue {
  /** Severity — "error" blocks the run; "warning" is a soft notice. */
  severity: "error" | "warning";
  requirement: WorkflowRequirement;
  /** What we observed at preflight time. */
  detail: string;
}

export interface WorkflowPreflightResult {
  /** True only if there are zero "error"-severity issues. */
  ok: boolean;
  issues: WorkflowPreflightIssue[];
  /** Validated + defaulted inputs (filled-in form). */
  resolvedInputs: Record<string, unknown>;
  /** Body with `{{input.name}}` placeholders interpolated. */
  interpolatedBody?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  /** Mirrors the workflow's kind at run start so the runner knows which loop to use. */
  kind?: WorkflowKind;
  status: WorkflowRunStatus;
  /** Inputs the user supplied (post-validation, after defaults applied). */
  inputs: Record<string, unknown>;
  /** Spawned agent session key, set once status moves to "running" (static runs only). */
  sessionKey?: string;
  /** Spawned run id from the gateway's session.spawn handler (static runs only). */
  spawnRunId?: string;
  /** PTY id when this run launched the workflow's agent inside a terminal
   *  (executionMode === "terminal"). For continuous workflows this is the
   *  most recent iteration's terminal; see iterations[].terminalId for the
   *  full history. The UI uses this to embed the live xterm viewer. */
  terminalId?: string;
  /** How the agent for this run was launched. Defaults to "gateway". */
  executionMode?: WorkflowExecutionMode;
  /** CLI launched when executionMode === "terminal". Defaults to "claude". */
  cli?: WorkflowCliKind;
  /** Agent that ran. */
  agent: string;
  startedAt: string;
  /** ISO timestamp of terminal status. */
  finishedAt?: string;
  /** Truthy if the run produced an error message. */
  error?: string;
  /** Final result text from the agent (if any). For continuous runs, the last iteration's result. */
  result?: string;
  /** Preflight outcome captured at start, for audit. */
  preflight?: WorkflowPreflightResult;
  /** Continuous-only: per-iteration history. Capped at the most recent 200 iterations to bound memory. */
  iterations?: WorkflowIteration[];
  /** Continuous-only: total iterations attempted (may exceed iterations.length due to capping). */
  iterationCount?: number;
  /** Continuous-only: current consecutive-failure streak; resets on any success. */
  errorStreak?: number;
  /** Continuous-only: how the daemon stopped. */
  stopReason?: ContinuousStopReason;
  /** Continuous-only: who/what requested the stop (e.g. "user", "autonomy.pause", "error_streak"). */
  stopRequestedBy?: string;
}
