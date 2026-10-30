/**
 * Autonomy Architecture — Type Definitions
 * Trust infrastructure for Infini's autonomous operation
 */

// =============================================================================
// AUDIT LOG TYPES
// =============================================================================

export type AuditActionType =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_queued"
  | "task_dequeued"
  | "file_read"
  | "file_write"
  | "file_edit"
  | "exec_command"
  | "api_call"
  | "notification_sent"
  | "pause_activated"
  | "pause_deactivated"
  | "hardware_check"
  | "cage_interference_detected"
  | "heartbeat_work"
  | "autonomous_action"
  | "system_event"
  | "kanban_sync"
  | "kanban_sync_error"
  | "kanban_created"
  | "prefire_blocked"
  | "prefire_completed"
  | "iteration_started"
  | "iteration_build_done"
  | "iteration_test_done"
  | "iteration_assess"
  | "iteration_max_reached"
  // ── Reliability layer (restart-recovery + self-heal) ──
  // COORDINATION: orch-self-heal
  | "recovered_orphan"
  | "task_blocked"
  | "task_recovered"
  | "heal_attempt"
  | "telegram_test";

export interface AuditEntry {
  id: string;
  timestamp: number;
  isoTime: string;
  actionType: AuditActionType;
  category: "autonomy" | "file" | "exec" | "api" | "notification" | "system";
  description: string;
  target?: string;
  outcome: "success" | "failure" | "pending" | "blocked";
  details?: Record<string, unknown>;
  hash?: string; // SHA256 of previous entry for tamper-evidence
  sessionKey?: string;
  agentId?: string;
}

// =============================================================================
// TASK QUEUE TYPES
// =============================================================================

export type QueuedTaskPriority = "critical" | "high" | "normal" | "low";
export type QueuedTaskStatus =
  | "pending"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  // "blocked" — parked by the orchestrator after an UNHEALABLE tool/infra
  // failure (see self-heal.ts). Unlike "failed", a blocked task is still
  // live: the heartbeat re-picks it once `blockedUntil` elapses, so a missing
  // API key / downed service that later recovers lets the task resume on its
  // own. COORDINATION: orch-self-heal
  | "blocked";

/**
 * Pluggable backend for goal-mode autonomy execution. One knob picks
 * both the planner LLM and the sub-agent worker CLI:
 *
 * - `claude`        — Anthropic SDK for the planner, Claude Code CLI for
 *                     workers. The default; richest tool-calling fidelity.
 * - `opencode`      — OpenCode CLI for both planning and workers. Useful
 *                     when Anthropic creds are unavailable.
 * - `codex`         — Codex CLI for both planning and workers.
 * - `grok`          — xAI Grok Build CLI for both planning and workers.
 * - `gateway-agent` — Use one of the operator-defined agents from the
 *                     gateway agent registry (each carries its own profile,
 *                     model, and system prompt).
 *
 * Users set a default via `config.autonomy.defaultBackend`; each goal can
 * override via `autonomy:queue.add { backend }`.
 */
export type AutonomyBackend =
  | { kind: "claude"; profileId?: string }
  | { kind: "opencode" }
  | { kind: "codex" }
  | { kind: "grok" }
  | { kind: "gateway-agent"; agentId: string };

export interface QueuedTask {
  id: string;
  createdAt: number;
  priority: QueuedTaskPriority;
  status: QueuedTaskStatus;
  title: string;
  description: string;
  projectId?: string;
  projectName?: string;
  kanbanTaskId?: string; // Link to existing kanban task
  kanbanProjectId?: string; // Link to existing kanban project
  estimatedDuration?: string; // e.g., "30min", "2h"
  hardwareIntensive: boolean;
  requiresApproval: boolean;
  autoExecuteAfterIdleMs?: number; // Auto-run after N ms of idle
  executedAt?: number;
  completedAt?: number;
  outcome?: string;
  error?: string;
  auditIds: string[]; // References to audit entries
  // Context for autonomous execution
  context?: TaskContext;
  // Closed-loop tester state — populated by the orchestrator on each round
  iterations?: TaskIteration[];
  currentPhase?: TaskPhase;
  // ── Reliability layer (restart-recovery + self-heal) ──
  // COORDINATION: orch-self-heal
  /** Human-readable blocker that parked this task (status === "blocked"). */
  blockedReason?: string;
  /** When the task was last parked as blocked (ms epoch). */
  blockedAt?: number;
  /** Earliest ms epoch the heartbeat is allowed to re-pick a blocked task.
   *  Provides a backoff so a downed service isn't hammered every tick. */
  blockedUntil?: number;
  /** The blocker string we last fired a Telegram critical-blocker alert for.
   *  Used to de-dupe: a parked-and-retrying task only re-notifies when the
   *  underlying blocker actually changes (not on every tick). */
  blockedNotifiedFor?: string;
  /** Number of times this task has been recovered from an orphaned "running"
   *  state across process restarts (audit/visibility only). */
  recoveredCount?: number;
  /** Persisted self-heal bookkeeping so heal budgets + history survive a
   *  gateway restart and the loop doesn't infinite-loop on the same error. */
  healState?: TaskHealState;
  // ── Goal-mode (multi-phase orchestration) ──
  // COORDINATION: goal-orchestrator-mode — wire queue → goal-orchestrator
  /** When set to "goal", runLoop dispatches to runGoalLoop instead of the
   *  build/test loop. Undefined or "build" keeps the legacy behavior. */
  kind?: "goal" | "build";
  /** Goal statement (required when kind === "goal"). */
  goalText?: string;
  /** Per-goal backend override. When undefined, the orchestrator falls
   *  back to `config.autonomy.defaultBackend`, then to `{ kind: "claude" }`. */
  backend?: AutonomyBackend;
  /** Optional ordered list of sub-goals / phases. The orchestrator gets these
   *  in its planning prompt so it can fan sub-agents out per phase. */
  subgoalText?: string[];
  /** Per-goal budget. Persisted so a goal that survives a restart resumes
   *  with the remaining turn count. */
  goalBudget?: { maxTurns: number; turnsUsed: number; startedAt?: number };
  /** Per-iteration history for the goal loop. Append-only; the judge reads
   *  the most recent summaries to decide done/continue. */
  goalIterations?: Array<{
    index: number;
    summary: string;
    reasoning?: string;
    subagentRuns?: Array<{ runId: string; label: string; status: string }>;
    errors?: Array<{ phase: string; message: string }>;
    startedAt: number;
    endedAt?: number;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────
// Self-heal bookkeeping (COORDINATION: orch-self-heal)
// ─────────────────────────────────────────────────────────────────────────

export interface HealAttemptRecord {
  /** Healer registry id that handled (or declined) this failure. */
  healerId: string;
  /** When the attempt was made (ms epoch). */
  at: number;
  /** Outcome of the heal attempt. */
  outcome: "healed" | "failed" | "unhealable";
  /** What the healer did (or tried). */
  action: string;
  /** Whether the caller should retry the failed phase after this attempt. */
  retryable: boolean;
  /** Truncated error text that triggered the heal, for the activity feed. */
  errorExcerpt?: string;
  /** Which phase failed ("build" | "test" | other). */
  phase?: string;
}

export interface TaskHealState {
  /** Append-only log of heal attempts on this task. */
  attempts: HealAttemptRecord[];
  /** Per-healer attempt counter so a healer's budget is enforced across
   *  restarts (keyed by healer id). */
  budgetUsed: Record<string, number>;
  /** The most recent blocker string (matches blockedReason when parked). */
  lastBlocker?: string;
  /** True when the most recent attempt declared the failure unhealable. */
  lastUnhealable?: boolean;
}

export type TaskPhase =
  | "awaiting_prefire"
  | "awaiting_approval"
  | "building"
  | "testing"
  | "assessing"
  | "done"
  | "failed"
  // Parked on an unhealable tool/infra blocker; will auto-resume.
  // COORDINATION: orch-self-heal
  | "blocked"
  // Actively running a self-heal attempt between phase retries.
  | "healing";

export interface TaskIteration {
  number: number; // 1-based iteration index
  startedAt: number;
  endedAt?: number;
  // Build phase (primary agent)
  buildAgentId?: string; // e.g. "coder"
  buildSessionKey?: string;
  buildRunId?: string;
  buildOutcome?: "ok" | "error" | "timeout";
  buildSummary?: string;
  /** PTY id when this iteration's builder ran in terminal mode. The UI uses
   *  this to embed the live xterm viewer for the task's Claude Code session. */
  buildTerminalId?: string;
  // Test phase (tester agent + Playwright MCP)
  testerSessionKey?: string;
  testerRunId?: string;
  testerVerdict?: TesterVerdict;
  /** PTY id when the tester ran in terminal mode (rare; usually tester is gateway). */
  testerTerminalId?: string;
  // Assessment + next-step planning derived from verdict
  fixHints?: string[];
  notes?: string;
}

/**
 * Where a task's agent actually runs.
 *   - "gateway" (default): spawn a native gateway subagent via sessions.spawn.
 *     Output flows through the chat/session system.
 *   - "terminal":          spawn a CLI (Claude Code / OpenCode / Gemini) inside
 *     a long-lived PTY via terminal.spawnAgent. The terminal stays alive after
 *     completion so the user can re-attach and read scrollback.
 */
export type TaskExecutionMode = "gateway" | "terminal";
export type TaskCliKind = "claude" | "opencode" | "gemini" | "grok";

export interface TesterVerdict {
  pass: boolean;
  summary: string;
  reasons: string[]; // Each item: a discrete observation (passed / failed)
  evidence: string[]; // URLs, selectors, screenshot paths, captured text
  fixHints: string[]; // Concrete instructions to feed back to the builder
  rawOutput?: string; // The raw assistant message for audit / debugging
}

export interface PrefireQuestions {
  /** What "done" looks like in plain English. Required. */
  successCriteria: string;
  /** Concrete targets the tester should verify against. */
  testTargets: PrefireTestTarget[];
  /** Hard ceiling on the build→test loop so a stuck run can't burn forever. */
  maxIterations: number;
  /** Whether the orchestrator should spawn a tester between iterations. */
  testerEnabled: boolean;
  /** Hint for which agent runs the build phase. Default: coder. */
  builderAgentId?: string;
  /** Hint for which agent runs the test phase. Default: same as builder. */
  testerAgentId?: string;
  /**
   * How the builder runs. "gateway" (default) uses sessions.spawn for a native
   * gateway subagent. "terminal" spawns the chosen CLI inside a long-lived
   * PTY via terminal.spawnAgent — the live TUI is then visible from the
   * task's detail panel and the buffer survives completion.
   */
  executionMode?: TaskExecutionMode;
  /** CLI to launch when executionMode === 'terminal'. Defaults to 'claude'. */
  cli?: TaskCliKind;
  /** Working directory for the terminal PTY. Defaults to repo root. */
  cwd?: string;
  /** Optional free-text notes the user wants the loop to keep in mind. */
  notes?: string;
  /** Set true once the user has filled out every required field. */
  completed: boolean;
  completedAt?: number;
}

export interface PrefireTestTarget {
  /** Human label, e.g. "Login button on /signin". */
  description: string;
  /** Optional URL to navigate to before checking. */
  url?: string;
  /** Optional CSS / text selector the tester should look at. */
  selector?: string;
  /** Optional explicit expectation ("button is enabled", "text matches X"). */
  expect?: string;
}

export interface TaskContext {
  telegramMessages?: TelegramContextMessage[];
  notes?: string;
  files?: string[]; // Paths to relevant files
  links?: string[]; // URLs for reference
  instructions?: string; // Special instructions for this task
  /** When false the pre-fire questionnaire is skipped and the loop can start
   *  without a completed form. Defaults to true (existing behaviour). */
  prefireRequired?: boolean;
  /** Legacy pre-fire questionnaire — kept for tasks queued before the dynamic
   *  form rolled out. New tasks should use `prefireForm` below. */
  prefire?: PrefireQuestions;
  /** Dynamic, agent-generated pre-fire form. When present, the orchestrator
   *  checks this instead of the legacy `prefire` block. */
  prefireForm?: PrefireForm;
}

// ─────────────────────────────────────────────────────────────────────────
// Dynamic pre-fire form (agent-generated)
// ─────────────────────────────────────────────────────────────────────────

export type PrefireFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "multiselect";

export interface PrefireField {
  id: string;
  label: string;
  type: PrefireFieldType;
  required: boolean;
  /** Plain-language help shown beneath the input. */
  help?: string;
  /** For select / multiselect. */
  options?: string[];
  /** Default value (string for text/select, number for number, boolean for boolean). */
  default?: string | number | boolean | string[];
  /** Optional placeholder for text-style inputs. */
  placeholder?: string;
}

export interface PrefireForm {
  /** Free-text summary of the agent's understanding of the work. */
  summary?: string;
  /** Field definitions in display order. */
  fields: PrefireField[];
  /** Latest answers, keyed by field id. */
  answers: Record<string, string | number | boolean | string[]>;
  /** Set true once the agent confirms it has everything it needs. */
  agentReady: boolean;
  /** Reason / next-step the agent surfaced on its last readiness check. */
  readyReason?: string;
  /** When the form was last generated (ms epoch). */
  generatedAt?: number;
  /** When agentReady last flipped to true. */
  readyAt?: number;
  /** Model used to generate / evaluate the form, for audit. */
  model?: string;
}

export interface TelegramContextMessage {
  messageId: number;
  text: string;
  from: string;
  timestamp: number;
}

// =============================================================================
// HARDWARE & ACTIVITY TYPES
// =============================================================================

export interface SystemActivityState {
  lastCheck: number;
  isUserActive: boolean;
  idleTimeMs: number;
  cpuUsagePercent: number;
  memoryUsagePercent: number;
  gpuMemoryUsedMb?: number;
  gpuMemoryTotalMb?: number;
  processesRunning: string[];
}

export interface HardwareThresholds {
  maxCpuPercent: number;
  maxMemoryPercent: number;
  maxGpuMemoryPercent: number;
  idleThresholdMs: number; // Consider user idle after this
}

// =============================================================================
// PAUSE CONTROL TYPES
// =============================================================================

export interface PauseState {
  isPaused: boolean;
  pausedAt?: number;
  pausedBy?: "user" | "system" | "cage_detection";
  reason?: string;
  resumeAt?: number; // Optional scheduled resume
}

// =============================================================================
// NOTIFICATION TYPES
// =============================================================================

export type NotificationLevel = "info" | "success" | "warning" | "error" | "cage_alert";

export interface AutonomyNotification {
  id: string;
  timestamp: number;
  level: NotificationLevel;
  title: string;
  message: string;
  channel: "telegram" | "all";
  sent: boolean;
  sentAt?: number;
  taskId?: string;
  auditId?: string;
  /** Deep link (infinibot://…) for where the alert should open. */
  deepLink?: string;
  /** https web opener URL for the deep link (null/absent without a public base). */
  webUrl?: string | null;
}

// =============================================================================
// API USAGE MONITORING TYPES
// =============================================================================

export interface ApiUsageEntry {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  sessionKey?: string;
  taskId?: string;
  autonomous: boolean; // Was this an autonomous action?
}

export interface ApiUsageSummary {
  period: "hour" | "day" | "week" | "month";
  periodStart: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  autonomousPercent: number;
  byProvider: Record<string, { tokens: number; cost: number }>;
  byModel: Record<string, { tokens: number; cost: number }>;
}

// =============================================================================
// AUTONOMY STATE
// =============================================================================

export interface AutonomyState {
  enabled: boolean;
  pauseState: PauseState;
  activityState: SystemActivityState;
  thresholds: HardwareThresholds;
  lastHeartbeatWork: number;
  tasksInQueue: number;
  tasksCompletedToday: number;
  currentTask?: QueuedTask;
  cageInterferenceCount: number;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface AutonomyConfig {
  enabled: boolean;
  auditLogPath: string;
  queuePath: string;
  pauseFilePath: string;

  // Thresholds
  hardwareThresholds: HardwareThresholds;

  // Notifications
  telegramNotifications: boolean;
  telegramChatId?: string;
  notifyOnTaskStart: boolean;
  notifyOnTaskComplete: boolean;
  notifyOnError: boolean;
  notifyOnCageInterference: boolean;

  // Autonomy behavior
  autoExecuteAfterIdleMs: number; // Default: 30 minutes
  heartbeatWorkEnabled: boolean;
  maxConcurrentTasks: number;

  // API monitoring
  apiMonitoringEnabled: boolean;
  apiUsagePath: string;
}

export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  enabled: true,
  auditLogPath: "state/autonomy/audit",
  queuePath: "state/autonomy/queue.json",
  pauseFilePath: "state/autonomy/PAUSE",

  hardwareThresholds: {
    maxCpuPercent: 80,
    maxMemoryPercent: 85,
    maxGpuMemoryPercent: 90,
    idleThresholdMs: 5 * 60 * 1000, // 5 minutes
  },

  telegramNotifications: true,
  notifyOnTaskStart: true,
  notifyOnTaskComplete: true,
  notifyOnError: true,
  notifyOnCageInterference: true,

  autoExecuteAfterIdleMs: 30 * 60 * 1000, // 30 minutes
  heartbeatWorkEnabled: true,
  maxConcurrentTasks: 1,

  apiMonitoringEnabled: true,
  apiUsagePath: "state/autonomy/api-usage.db",
};
