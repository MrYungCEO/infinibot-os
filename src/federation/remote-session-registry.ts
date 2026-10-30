/**
 * Remote Session Registry
 *
 * Tracks sessions spawned on remote federation nodes.
 * Provides lifecycle management, cleanup, and status tracking
 * for cross-node agent sessions.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("federation").child("remote-sessions");

// ============================================================
// Types
// ============================================================

export interface RemoteSessionRecord {
  /** Unique run ID */
  runId: string;
  /** Session key on the remote node */
  sessionKey: string;
  /** Node ID where the session is running */
  nodeId: string;
  /** Node display name (for user-facing output) */
  nodeName?: string;
  /** Agent ID running the session */
  agentId: string;
  /** Task description */
  task: string;
  /** Label for the session */
  label?: string;
  /** Session that spawned this remote session */
  spawnerSessionKey?: string;
  /** When the session was created */
  createdAt: number;
  /** When the session started running */
  startedAt?: number;
  /** When the session ended */
  endedAt?: number;
  /** Current status */
  status: RemoteSessionStatus;
  /** Last known progress (0-100) */
  progress?: number;
  /** Last status message */
  lastMessage?: string;
  /** Cleanup policy */
  cleanup: "delete" | "keep";
  /** Timeout in seconds */
  timeoutSeconds?: number;
  /** Whether cleanup has been handled */
  cleanupHandled?: boolean;
  /** Model used for the session */
  model?: string;
}

export type RemoteSessionStatus =
  | "pending"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "unknown";

// ============================================================
// Registry State
// ============================================================

const remoteSessions = new Map<string, RemoteSessionRecord>();
let sweeper: NodeJS.Timeout | null = null;
const SWEEP_INTERVAL_MS = 60_000; // 1 minute
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

// ============================================================
// Registry Management
// ============================================================

/**
 * Register a new remote session.
 */
export function registerRemoteSession(params: {
  runId: string;
  sessionKey: string;
  nodeId: string;
  nodeName?: string;
  agentId: string;
  task: string;
  label?: string;
  spawnerSessionKey?: string;
  cleanup?: "delete" | "keep";
  timeoutSeconds?: number;
  model?: string;
}): RemoteSessionRecord {
  const record: RemoteSessionRecord = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    nodeId: params.nodeId,
    nodeName: params.nodeName,
    agentId: params.agentId,
    task: params.task,
    label: params.label,
    spawnerSessionKey: params.spawnerSessionKey,
    createdAt: Date.now(),
    status: "pending",
    cleanup: params.cleanup ?? "keep",
    timeoutSeconds: params.timeoutSeconds,
    model: params.model,
  };

  remoteSessions.set(params.runId, record);
  ensureSweeperStarted();

  log.debug(`registered remote session: ${params.runId} on ${params.nodeId}`);
  return record;
}

/**
 * Update a remote session's status and progress.
 */
export function updateRemoteSession(
  runId: string,
  updates: Partial<
    Pick<RemoteSessionRecord, "status" | "progress" | "lastMessage" | "startedAt" | "endedAt">
  >,
): RemoteSessionRecord | null {
  const record = remoteSessions.get(runId);
  if (!record) return null;

  if (updates.status !== undefined) record.status = updates.status;
  if (updates.progress !== undefined) record.progress = updates.progress;
  if (updates.lastMessage !== undefined) record.lastMessage = updates.lastMessage;
  if (updates.startedAt !== undefined) record.startedAt = updates.startedAt;
  if (updates.endedAt !== undefined) record.endedAt = updates.endedAt;

  log.debug(`updated remote session: ${runId} status=${record.status} progress=${record.progress}`);
  return record;
}

/**
 * Get a remote session by run ID.
 */
export function getRemoteSession(runId: string): RemoteSessionRecord | null {
  return remoteSessions.get(runId) ?? null;
}

/**
 * Get a remote session by session key and node.
 */
export function getRemoteSessionByKey(
  sessionKey: string,
  nodeId: string,
): RemoteSessionRecord | null {
  for (const record of remoteSessions.values()) {
    if (record.sessionKey === sessionKey && record.nodeId === nodeId) {
      return record;
    }
  }
  return null;
}

/**
 * Find a remote session by session key only (without requiring nodeId).
 * Returns node info if found, useful for determining which node owns a session.
 */
export function findRemoteSessionBySessionKey(
  sessionKey: string,
): { nodeId: string; nodeName?: string; record: RemoteSessionRecord } | null {
  for (const record of remoteSessions.values()) {
    if (record.sessionKey === sessionKey) {
      return {
        nodeId: record.nodeId,
        nodeName: record.nodeName,
        record,
      };
    }
  }
  return null;
}

/**
 * List all remote sessions, optionally filtered.
 */
export function listRemoteSessions(filter?: {
  nodeId?: string;
  spawnerSessionKey?: string;
  status?: RemoteSessionStatus[];
  limit?: number;
}): RemoteSessionRecord[] {
  let results: RemoteSessionRecord[] = [];

  for (const record of remoteSessions.values()) {
    if (filter?.nodeId && record.nodeId !== filter.nodeId) continue;
    if (filter?.spawnerSessionKey && record.spawnerSessionKey !== filter.spawnerSessionKey)
      continue;
    if (filter?.status && !filter.status.includes(record.status)) continue;
    results.push(record);
  }

  // Sort by createdAt descending
  results.sort((a, b) => b.createdAt - a.createdAt);

  if (filter?.limit && filter.limit > 0) {
    results = results.slice(0, filter.limit);
  }

  return results;
}

/**
 * Get remote sessions spawned by a specific session.
 */
export function getRemoteSessionsSpawnedBy(spawnerSessionKey: string): RemoteSessionRecord[] {
  return listRemoteSessions({ spawnerSessionKey });
}

/**
 * Get active remote sessions (not completed/failed/timeout).
 */
export function getActiveRemoteSessions(): RemoteSessionRecord[] {
  return listRemoteSessions({
    status: ["pending", "starting", "running"],
  });
}

/**
 * Mark a remote session as complete.
 */
export function completeRemoteSession(
  runId: string,
  outcome: { status: "completed" | "failed" | "timeout"; message?: string },
): void {
  const record = remoteSessions.get(runId);
  if (!record) return;

  record.status = outcome.status;
  record.endedAt = Date.now();
  if (outcome.message) record.lastMessage = outcome.message;

  log.info(`remote session completed: ${runId} status=${outcome.status}`);
}

/**
 * Remove a remote session from the registry.
 */
export function removeRemoteSession(runId: string): boolean {
  const removed = remoteSessions.delete(runId);
  if (removed) {
    log.debug(`removed remote session: ${runId}`);
  }
  return removed;
}

/**
 * Remove all remote sessions owned by a disconnected node. Active sessions are
 * first marked failed so callers can emit lifecycle events before deletion.
 */
export function removeRemoteSessionsForNode(
  nodeId: string,
  opts: {
    reason?: string;
    onAbort?: (record: RemoteSessionRecord) => void;
  } = {},
): RemoteSessionRecord[] {
  const reason = opts.reason ?? "federation-disconnect";
  const removed: RemoteSessionRecord[] = [];

  for (const [runId, record] of remoteSessions.entries()) {
    if (record.nodeId !== nodeId) continue;

    if (
      record.status === "pending" ||
      record.status === "starting" ||
      record.status === "running"
    ) {
      record.status = "failed";
      record.endedAt = Date.now();
      record.lastMessage = reason;
      opts.onAbort?.({ ...record });
    }

    remoteSessions.delete(runId);
    removed.push({ ...record });
  }

  if (removed.length > 0) {
    log.info(`removed ${removed.length} remote session(s) for disconnected node ${nodeId}`);
  }

  return removed;
}

/**
 * Get summary statistics for remote sessions.
 */
export function getRemoteSessionStats(): {
  total: number;
  active: number;
  completed: number;
  failed: number;
  byNode: Record<string, number>;
} {
  const stats = {
    total: 0,
    active: 0,
    completed: 0,
    failed: 0,
    byNode: {} as Record<string, number>,
  };

  for (const record of remoteSessions.values()) {
    stats.total++;
    stats.byNode[record.nodeId] = (stats.byNode[record.nodeId] ?? 0) + 1;

    if (
      record.status === "pending" ||
      record.status === "starting" ||
      record.status === "running"
    ) {
      stats.active++;
    } else if (record.status === "completed") {
      stats.completed++;
    } else {
      stats.failed++;
    }
  }

  return stats;
}

// ============================================================
// Cleanup and Sweeper
// ============================================================

/**
 * Sweep stale sessions from the registry.
 */
function sweepStaleSessions(): void {
  const now = Date.now();
  const toRemove: string[] = [];

  for (const [runId, record] of remoteSessions.entries()) {
    const age = now - record.createdAt;

    // Remove completed sessions older than threshold
    if (
      (record.status === "completed" ||
        record.status === "failed" ||
        record.status === "timeout") &&
      age > STALE_THRESHOLD_MS
    ) {
      toRemove.push(runId);
      continue;
    }

    // Mark sessions as timed out if they've been running too long
    if (
      record.status === "running" ||
      record.status === "starting" ||
      record.status === "pending"
    ) {
      const timeoutMs = (record.timeoutSeconds ?? 3600) * 1000; // Default 1 hour
      if (age > timeoutMs && !record.endedAt) {
        record.status = "timeout";
        record.endedAt = now;
        record.lastMessage = "Session timed out";
        log.warn(`remote session timed out: ${runId}`);
      }
    }
  }

  for (const runId of toRemove) {
    remoteSessions.delete(runId);
    log.debug(`swept stale remote session: ${runId}`);
  }
}

function ensureSweeperStarted(): void {
  if (sweeper) return;
  sweeper = setInterval(sweepStaleSessions, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

/**
 * Stop the sweeper (for testing/cleanup).
 */
export function stopRemoteSessionSweeper(): void {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/**
 * Clear all remote sessions (for testing).
 */
export function clearRemoteSessions(): void {
  remoteSessions.clear();
}

// ============================================================
// Event Handling
// ============================================================

/**
 * Handle a session event from a remote node.
 * Called when the federation hub receives session.event messages.
 */
export function handleRemoteSessionEvent(event: {
  nodeId: string;
  sessionKey: string;
  event: string;
  data: unknown;
}): void {
  // Find the session record
  const record = getRemoteSessionByKey(event.sessionKey, event.nodeId);
  if (!record) {
    log.debug(`received event for unknown remote session: ${event.sessionKey} on ${event.nodeId}`);
    return;
  }

  const data = event.data as Record<string, unknown> | undefined;

  switch (event.event) {
    case "started":
      updateRemoteSession(record.runId, {
        status: "running",
        startedAt: Date.now(),
      });
      break;

    case "progress":
      updateRemoteSession(record.runId, {
        progress: typeof data?.progress === "number" ? data.progress : undefined,
        lastMessage: typeof data?.message === "string" ? data.message : undefined,
      });
      break;

    case "completed":
      completeRemoteSession(record.runId, {
        status: "completed",
        message: typeof data?.message === "string" ? data.message : undefined,
      });
      break;

    case "failed":
      completeRemoteSession(record.runId, {
        status: "failed",
        message: typeof data?.error === "string" ? data.error : "Remote session failed",
      });
      break;

    case "timeout":
      completeRemoteSession(record.runId, {
        status: "timeout",
        message: "Remote session timed out",
      });
      break;

    default:
      log.debug(`unknown remote session event: ${event.event}`);
  }
}
