/**
 * Persistent agent queue + phase orchestration — shared types.
 *
 * Lives in `<stateDir>/queue.db` so the orchestrator survives gateway
 * restarts. An entry is a brief + an ordered list of phases; each phase is run
 * by ANY agent — a CLI coding agent (Claude Code, Codex, OpenCode, Gemini CLI)
 * or a gateway agent id — through one backend-agnostic phase runner
 * (src/queue/phase-runner.ts). A phase completes only when the run's
 * verified-completion verdict is VERIFIED (or operator-ACCEPTED) AND the
 * phase gate passes — never on process exit alone.
 */

import type { GoalCheck } from "../autonomy/goals/types.js";

export type QueueStatus =
  | "queued"
  | "running"
  | "paused"
  | "blocked"
  | "done"
  | "failed"
  | "canceled"
  /** Dead-letter: poisoned entry (repeated crashes / spawn failures). Needs `retry`. */
  | "dead";

export const QUEUE_STATUSES: readonly QueueStatus[] = [
  "queued",
  "running",
  "paused",
  "blocked",
  "done",
  "failed",
  "canceled",
  "dead",
];

export const QUEUE_TERMINAL_STATUSES: ReadonlySet<QueueStatus> = new Set([
  "done",
  "failed",
  "canceled",
  "dead",
]);

/** CLI backends a phase can target directly. */
export type QueueCliBackend = "claude-code" | "codex" | "opencode" | "gemini" | "grok";

/** Worktree isolation: none = run in workdir; entry = one worktree for all phases; phase = one per phase. */
export type QueueIsolation = "none" | "entry" | "phase";

export interface QueuePhase {
  /** Human-readable phase name shown on the iso-map pips + activity feed. */
  name: string;
  /** Markdown brief for this phase. */
  brief: string;
  /** Files / paths treated as conflict markers vs other running agents. */
  blockers?: string[];
  /**
   * Verification gate — enforced with the goal-run checker
   * (src/autonomy/goals/checks.ts). A list of checks (shell | file | grep |
   * llm | visual) or legacy text (one llm criterion per line; "$ cmd" = shell).
   */
  gateCriteria?: string | GoalCheck[];
  /**
   * Who runs this phase: "claude-code" | "codex" | "opencode" | "gemini" | "grok"
   * (aliases: claude, cc, gemini-cli) or a gateway agent id. Default: the
   * queue default agent (`claude-code`).
   */
  agent?: string;
  /** Model override; mapped per backend (see phase-runner.ts mapModelForBackend). */
  model?: string;
  /** Agent to use when `agent` is a CLI that is missing / not logged in. */
  fallbackAgent?: string;
  /** Working directory (repo) the phase agent + gate checks run in. */
  workdir?: string;
  /** Attempts (verdict/gate failures) before the entry blocks. Default 3. */
  maxAttempts?: number;
  /** Per-attempt wall clock. Default 30 min. */
  timeoutSec?: number;
  /**
   * Require a VERIFIED/ACCEPTED verified-completion verdict (default true).
   * false = the gate alone decides (for agents that can't produce a RESULT).
   */
  requireVerified?: boolean;
  /** Override the entry isolation for this phase. */
  isolation?: QueueIsolation;
}

export type QueueBlockedKind =
  | "gate_failed"
  | "unverified"
  | "needs_input"
  | "backend_unavailable"
  /** The requested model is retired / unknown / out of credits for this backend. */
  | "model_unavailable"
  | "spawn_failed"
  | "timeout"
  | "dependency_failed"
  | "invalid"
  | "restart"
  | "operator";

export interface QueueEntry {
  id: string;
  title: string;
  briefMd: string;
  phaseSpec: QueuePhase[];
  status: QueueStatus;
  priority: number;
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  orchestratorId: string | null;
  currentPhaseIdx: number;
  /** Total attempts across all phases. */
  attempts: number;
  lastError: string | null;
  /** Run id of the attempt currently executing (or null). */
  currentRunId: string | null;
  /** Counted attempts of the CURRENT phase (reset when the phase advances). */
  phaseAttempts: number;
  /** Latest gate verification of the current phase. */
  lastGate: QueueGateResult | null;
  /** Why the entry is blocked (null unless status is blocked/dead). */
  blockedKind: QueueBlockedKind | null;
  /** Human-readable next step for the operator. */
  fixHint: string | null;
  /** Backoff: do not dispatch before this time. */
  nextAttemptAt: number | null;
  /** Why a queued entry is not dispatching right now (deps, conflict, backoff…). */
  waitingReason: string | null;
  /** Consecutive transient failures (crash / spawn / lost) — dead-letter at the cap. */
  transientFailures: number;
  /** Entry-level wall clock budget (seconds) — null = unbounded. */
  timeoutSec: number | null;
  /** Default workdir for phases that don't set one. */
  workdir: string | null;
  isolation: QueueIsolation;
  /** Worktree(s) created for this entry: key "entry" or "p<idx>". */
  worktrees: Record<string, { path: string; branch: string; repo: string }>;
  /** Pause requested while running: park the entry after the current attempt settles. */
  pauseRequested: boolean;
  /** Origin trust (W5): untrusted entries never get the CLI permission bypass. */
  trusted: boolean;
  createdBy: string | null;
  idempotencyKey: string | null;
  /** Operator instruction for the next attempt (queue.retry {instruction}). */
  pendingInstruction: string | null;
  /** Next attempt starts a fresh agent session instead of resuming. */
  freshSession: boolean;
}

export interface QueueGateResult {
  pass: boolean;
  at: number;
  phaseIdx: number;
  attempt: number;
  results: Array<{ checkId: string; label: string; pass: boolean; output: string }>;
}

export type QueueAttemptOutcome =
  | "starting"
  | "running"
  | "passed" // verdict ok + gate passed → phase completed
  | "gate_failed"
  | "unverified"
  | "failed"
  | "needs_input"
  | "timeout"
  | "crashed"
  | "spawn_failed"
  | "unavailable"
  | "interrupted" // pause(force) / restart lost the process — not counted
  | "canceled";

/** One attempt of one phase — records exactly which backend/model/session ran it. */
export interface QueueAttempt {
  id: number;
  entryId: string;
  phaseIdx: number;
  /** 1-based attempt number within the phase (counted + uncounted). */
  n: number;
  runId: string;
  /** Resolved target: CLI backend id or `agent:<id>`. */
  agent: string;
  backend: QueueCliBackend | null;
  /** Model as requested on the phase. */
  modelRequested: string | null;
  /** Model actually passed to the CLI (after per-backend mapping). */
  model: string | null;
  sessionId: string | null;
  /** Session this attempt resumed (same-session continuation). */
  resumedSession: string | null;
  /** Agent that was requested when a fallback was used. */
  fallbackFrom: string | null;
  workdir: string | null;
  /** Commit the phase started from (evidence baseline shared by all its attempts). */
  baseCommit: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: QueueAttemptOutcome;
  /** Counts against maxAttempts (false for interrupted / unavailable). */
  counted: boolean;
  exitCode: number | null;
  /** Verified-completion terminal state of the run (verified | unverified | …). */
  verdict: string | null;
  verdictReasons: string[];
  gate: QueueGateResult | null;
  error: string | null;
}

export interface QueueEventRow {
  seq: number;
  entryId: string;
  ts: number;
  kind: string;
  phaseIdx: number | null;
  message: string;
  data: Record<string, unknown> | null;
}

export interface EnqueueInput {
  title?: string;
  briefMd: string;
  phaseSpec: QueuePhase[];
  priority?: number;
  dependsOn?: string[];
  workdir?: string | null;
  isolation?: QueueIsolation;
  timeoutSec?: number | null;
  trusted?: boolean;
  createdBy?: string | null;
  idempotencyKey?: string | null;
  /** Create the entry paused (default false). */
  paused?: boolean;
}
