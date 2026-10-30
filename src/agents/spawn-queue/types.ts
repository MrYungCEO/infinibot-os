/**
 * Spawn-queue data model.
 *
 * A SpawnQueue is a named, ordered set of QueueItems. Each item carries the
 * same payload as `claude_coder` (a SpawnSpec) plus scheduling metadata:
 * dependencies, an optional phase grouping, and a priority. A per-queue
 * dispatcher walks the items in topological + phase order and spawns up to
 * `maxConcurrent` at a time, mirroring each dispatched run onto a kanban task.
 *
 * This module is pure types only — no runtime — so it can be imported from
 * the manager, the store, the MCP tools, and the tests without cycles.
 */

export type CoderBackendName = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

export type QueueItemState = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";

/** Terminal states never transition again (except retry, which resets to pending). */
export const TERMINAL_STATES: ReadonlySet<QueueItemState> = new Set<QueueItemState>([
  "done",
  "failed",
  "skipped",
  "cancelled",
]);

/**
 * Phase gate. Controls when items in a later phase may start relative to the
 * phases before them:
 *   - allDone  (default): every item in earlier phases must be terminal.
 *   - anyDone:            at least one item in each earlier phase is `done`.
 *   - majority:           > half of each earlier phase's items are `done`.
 */
export type GateMode = "allDone" | "anyDone" | "majority";

/**
 * The spawn payload. Mirrors the `claude_coder` tool args. Kept loose with an
 * index signature so callers can pass any subset the tool accepts; the
 * dispatcher forwards it verbatim (minus queue-control fields) to the spawner.
 */
export interface SpawnSpec {
  task: string;
  workdir?: string;
  model?: string;
  timeoutMinutes?: number;
  systemPrompt?: string;
  enabledMCPs?: string[];
  autoApprove?: boolean;
  backend?: CoderBackendName;
  projectId?: string;
  projectHint?: string;
  label?: string;
  [key: string]: unknown;
}

export interface QueueItem {
  id: string;
  queueName: string;
  label: string;
  spawnSpec: SpawnSpec;
  state: QueueItemState;
  /** Ids of items that must reach `done` before this one is eligible. */
  dependsOn: string[];
  /** Higher dispatches first within a phase. */
  priority: number;
  addedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Underlying claude_coder runId once dispatched. */
  runId?: string;
  /** Kanban task mirroring this item (pre-created in Backlog). */
  kanbanTaskId?: string;
  /** Run that enqueued this item, when known. */
  parentRunId?: string;
  /** Optional phase grouping label. Ordered numerically when parseable. */
  phase?: string;
  retryCount: number;
  maxRetries: number;
  /** Human-readable reason for the current terminal/retry state. */
  reason?: string;
  /** Backoff barrier — item is not eligible to dispatch before this epoch ms. */
  retryNotBefore?: number;
}

export interface SpawnQueue {
  name: string;
  maxConcurrent: number;
  defaultBackend?: CoderBackendName;
  defaultTimeoutMinutes?: number;
  defaultProjectHint?: string;
  /** When set, finished items are purged from memory this long after finishing. */
  autopurgeAfterMs?: number;
  gateMode: GateMode;
  createdAt: number;
}

export interface CreateQueueOptions {
  maxConcurrent?: number;
  defaultBackend?: CoderBackendName;
  defaultTimeoutMinutes?: number;
  defaultProjectHint?: string;
  autopurgeAfterMs?: number;
  gateMode?: GateMode;
}

/** Caller-supplied shape for a single enqueue (mirrors claude_coder args). */
export interface EnqueueItemInput {
  id?: string;
  label?: string;
  spawnSpec: SpawnSpec;
  dependsOn?: string[];
  phase?: string;
  priority?: number;
  maxRetries?: number;
  parentRunId?: string;
}

export interface QueueCounts {
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

/** Result of spawning the underlying claude_coder run for a queue item. */
export interface SpawnResult {
  runId: string;
  kanbanTaskId?: string;
}

/** Liveness/terminal probe for a dispatched run. */
export interface RunProbe {
  terminal: boolean;
  ok?: boolean;
  error?: string;
  /** Whether the underlying child process is still alive (false ⇒ orphaned). */
  alive: boolean;
}

/**
 * Pluggable spawn backend. The real implementation drives `claude_coder`; tests
 * inject a mock so the dispatcher's scheduling can be asserted in isolation.
 */
export interface Spawner {
  spawn(spec: SpawnSpec, ctx: { existingKanbanTaskId?: string }): Promise<SpawnResult>;
  /** Returns undefined when the runId is unknown to the registry. */
  probe(runId: string): RunProbe | undefined;
  cancel(runId: string): void;
}

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_RETRY_BACKOFF_MS = 30_000;
export const DEFAULT_GATE_MODE: GateMode = "allDone";
