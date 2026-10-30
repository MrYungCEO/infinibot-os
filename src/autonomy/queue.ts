/**
 * Autonomy Architecture — Task Queue System
 * Queues tasks for autonomous execution with approval workflow
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { QueuedTask, QueuedTaskPriority, QueuedTaskStatus, TaskContext } from "./types.js";
import { logAudit } from "./audit.js";
import { syncToKanban } from "./kanban-sync.js";

let queuePath = "state/autonomy/queue.json";
let taskQueue: QueuedTask[] = [];

/**
 * Initialize queue system
 */
export function initQueue(path?: string): void {
  if (path) {
    queuePath = path;
  }

  // Ensure directory exists
  const dir = dirname(queuePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Load existing queue
  if (existsSync(queuePath)) {
    try {
      const content = readFileSync(queuePath, "utf-8");
      taskQueue = JSON.parse(content);
    } catch {
      taskQueue = [];
    }
  }

  // PILLAR 1 — restart persistence. On a fresh process the orchestrator's
  // in-memory `running` map is empty, so ANY task still marked "running" in the
  // file is an orphan from a process that died mid-iteration. Left as-is it
  // perma-blocks the heartbeat (the alreadyRunning guard in manager.ts sees a
  // running task and refuses to dispatch anything). Reconcile so the task
  // resumes after restart. COORDINATION: orch-self-heal
  reconcileOrphans();
}

/** Default backoff before a blocked task is eligible for heartbeat re-pick. */
const BLOCK_RETRY_BACKOFF_MS = Math.max(
  10_000,
  parseInt(process.env.AUTONOMY_BLOCK_BACKOFF_MS ?? "120000", 10),
);

/**
 * Reset tasks orphaned in a "running" state by a previous process so the
 * heartbeat can resume them, and log a `recovered_orphan` audit entry each.
 *
 * A task that recorded an unhealable blocker before dying is parked as
 * "blocked" (the heartbeat will still re-pick it after backoff); everything
 * else returns to a runnable state ("approved" if it required approval — it
 * must have been approved to be running — otherwise "pending").
 */
export function reconcileOrphans(): number {
  let recovered = 0;
  for (const task of taskQueue) {
    if (task.status !== "running") continue;
    const wasUnhealable = task.healState?.lastUnhealable === true;
    const next: QueuedTaskStatus = wasUnhealable
      ? "blocked"
      : task.requiresApproval
        ? "approved"
        : "pending";
    task.status = next;
    task.recoveredCount = (task.recoveredCount ?? 0) + 1;
    // Reset the in-flight phase marker — a resumed run starts a fresh
    // iteration rather than pretending the dead one is still building.
    if (
      task.currentPhase === "building" ||
      task.currentPhase === "testing" ||
      task.currentPhase === "assessing" ||
      task.currentPhase === "healing"
    ) {
      task.currentPhase = undefined;
    }
    if (next === "blocked") {
      task.blockedReason =
        task.blockedReason ??
        task.healState?.lastBlocker ??
        "unhealable blocker (recovered from restart)";
      task.blockedAt = Date.now();
      task.blockedUntil = Date.now() + BLOCK_RETRY_BACKOFF_MS;
    }
    recovered++;
    const auditEntry = logAudit(
      "recovered_orphan",
      `Recovered orphaned running task: ${task.title}`,
      {
        category: "autonomy",
        target: task.id,
        outcome: "success",
        details: { resetTo: next, recoveredCount: task.recoveredCount, wasUnhealable },
      },
    );
    if (Array.isArray(task.auditIds)) task.auditIds.push(auditEntry.id);
  }
  if (recovered > 0) saveQueue();
  return recovered;
}

/**
 * Save queue to disk
 */
function saveQueue(): void {
  const dir = dirname(queuePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(queuePath, JSON.stringify(taskQueue, null, 2), "utf-8");
}

/**
 * Force-save the queue to disk. Use this from external mutators (e.g. the
 * orchestrator writing iteration records into a task) so the change lands
 * on disk without relying on the next public mutation to trigger a save.
 */
export function persistQueue(): void {
  saveQueue();
}

/**
 * Generate unique task ID
 */
function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `task_${timestamp}_${random}`;
}

/**
 * Add task to queue
 */
export function queueTask(
  title: string,
  description: string,
  options: {
    priority?: QueuedTaskPriority;
    projectId?: string;
    projectName?: string;
    kanbanTaskId?: string;
    kanbanProjectId?: string;
    estimatedDuration?: string;
    hardwareIntensive?: boolean;
    requiresApproval?: boolean;
    autoExecuteAfterIdleMs?: number;
    context?: TaskContext;
    // COORDINATION: goal-orchestrator-mode — opt into goal loop
    kind?: "goal" | "build";
    goalText?: string;
    subgoalText?: string[];
    maxTurns?: number;
    /** Per-goal backend override (claude/opencode/codex/gateway-agent). */
    backend?: import("./types.js").AutonomyBackend;
  } = {},
): QueuedTask {
  const isGoal = options.kind === "goal";
  const task: QueuedTask = {
    id: generateTaskId(),
    createdAt: Date.now(),
    priority: options.priority || "normal",
    status: "pending",
    title,
    description,
    projectId: options.projectId,
    projectName: options.projectName,
    kanbanTaskId: options.kanbanTaskId,
    kanbanProjectId: options.kanbanProjectId,
    estimatedDuration: options.estimatedDuration,
    hardwareIntensive: options.hardwareIntensive ?? false,
    requiresApproval: options.requiresApproval ?? false,
    autoExecuteAfterIdleMs: options.autoExecuteAfterIdleMs,
    context: options.context,
    auditIds: [],
    ...(isGoal
      ? {
          kind: "goal" as const,
          goalText: options.goalText || description,
          subgoalText: options.subgoalText,
          goalBudget: {
            maxTurns: Math.max(1, options.maxTurns ?? 10),
            turnsUsed: 0,
            startedAt: undefined,
          },
          goalIterations: [],
          ...(options.backend ? { backend: options.backend } : {}),
        }
      : {}),
  };

  taskQueue.push(task);
  saveQueue();

  // Log to audit
  const auditEntry = logAudit("task_queued", `Task queued: ${title}`, {
    category: "autonomy",
    target: task.id,
    details: {
      priority: task.priority,
      hardwareIntensive: task.hardwareIntensive,
      requiresApproval: task.requiresApproval,
    },
  });

  task.auditIds.push(auditEntry.id);
  saveQueue();

  return task;
}

/**
 * Get all queued tasks
 */
export function getQueue(): QueuedTask[] {
  return [...taskQueue];
}

/**
 * Get pending tasks (not yet executed)
 */
export function getPendingTasks(): QueuedTask[] {
  return taskQueue.filter((t) => t.status === "pending" || t.status === "approved");
}

/**
 * Get next task to execute (by priority, then age)
 */
export function getNextTask(hardwareIntensiveAllowed: boolean = true): QueuedTask | null {
  const priorityOrder: QueuedTaskPriority[] = ["critical", "high", "normal", "low"];

  for (const priority of priorityOrder) {
    const candidates = taskQueue.filter((t) => {
      if (t.status !== "pending" && t.status !== "approved") return false;
      if (t.priority !== priority) return false;
      if (t.requiresApproval && t.status !== "approved") return false;
      if (t.hardwareIntensive && !hardwareIntensiveAllowed) return false;
      return true;
    });

    if (candidates.length > 0) {
      // Return oldest task of this priority
      return candidates.sort((a, b) => a.createdAt - b.createdAt)[0];
    }
  }

  return null;
}

/**
 * Approve a task for execution
 */
export function approveTask(taskId: string): QueuedTask | null {
  const task = taskQueue.find((t) => t.id === taskId);
  if (!task) return null;

  task.status = "approved";
  saveQueue();

  logAudit("task_dequeued", `Task approved: ${task.title}`, {
    category: "autonomy",
    target: taskId,
    details: { action: "approved" },
  });

  return task;
}

/**
 * Cancel a task
 */
export function cancelTask(taskId: string, reason?: string): QueuedTask | null {
  const task = taskQueue.find((t) => t.id === taskId);
  if (!task) return null;

  task.status = "cancelled";
  task.error = reason;
  saveQueue();

  logAudit("task_dequeued", `Task cancelled: ${task.title}`, {
    category: "autonomy",
    target: taskId,
    outcome: "blocked",
    details: { action: "cancelled", reason },
  });

  return task;
}

/**
 * Start executing a task
 */
export function startTask(taskId: string): QueuedTask | null {
  const task = taskQueue.find((t) => t.id === taskId);
  if (!task) return null;

  task.status = "running";
  task.executedAt = Date.now();
  saveQueue();

  const auditEntry = logAudit("task_started", `Task started: ${task.title}`, {
    category: "autonomy",
    target: taskId,
    details: {
      priority: task.priority,
      hardwareIntensive: task.hardwareIntensive,
    },
  });

  task.auditIds.push(auditEntry.id);
  saveQueue();

  // Sync to kanban (async, don't await)
  syncToKanban(task).catch(() => {});

  return task;
}

/**
 * Complete a task
 */
export function completeTask(taskId: string, outcome?: string): QueuedTask | null {
  const task = taskQueue.find((t) => t.id === taskId);
  if (!task) return null;

  task.status = "completed";
  task.completedAt = Date.now();
  task.outcome = outcome;
  saveQueue();

  const auditEntry = logAudit("task_completed", `Task completed: ${task.title}`, {
    category: "autonomy",
    target: taskId,
    outcome: "success",
    details: {
      durationMs: task.completedAt - (task.executedAt || task.createdAt),
      outcome,
    },
  });

  task.auditIds.push(auditEntry.id);
  saveQueue();

  // Sync to kanban (async, don't await)
  syncToKanban(task).catch(() => {});

  return task;
}

/**
 * Fail a task
 */
export function failTask(taskId: string, error: string): QueuedTask | null {
  const task = taskQueue.find((t) => t.id === taskId);
  if (!task) return null;

  task.status = "failed";
  task.completedAt = Date.now();
  task.error = error;
  saveQueue();

  const auditEntry = logAudit("task_failed", `Task failed: ${task.title}`, {
    category: "autonomy",
    target: taskId,
    outcome: "failure",
    details: { error },
  });

  task.auditIds.push(auditEntry.id);
  saveQueue();

  // Sync to kanban (async, don't await)
  syncToKanban(task).catch(() => {});

  return task;
}

/**
 * Park a task as "blocked" after an unhealable tool/infra failure.
 * Unlike failTask this keeps the task live: the heartbeat re-picks it once
 * `blockedUntil` elapses, so a recovered service lets it resume on its own.
 * COORDINATION: orch-self-heal
 */
export function blockTask(
  taskId: string,
  reason: string,
  options: { backoffMs?: number } = {},
): QueuedTask | null {
  const task = taskQueue.find((t) => t.id === taskId);
  if (!task) return null;

  task.status = "blocked";
  task.currentPhase = "blocked";
  task.blockedReason = reason;
  task.blockedAt = Date.now();
  task.blockedUntil = Date.now() + (options.backoffMs ?? BLOCK_RETRY_BACKOFF_MS);
  if (task.healState) task.healState.lastBlocker = reason;
  saveQueue();

  const auditEntry = logAudit("task_blocked", `Task blocked: ${task.title}`, {
    category: "autonomy",
    target: taskId,
    outcome: "blocked",
    details: { reason, blockedUntil: task.blockedUntil },
  });
  task.auditIds.push(auditEntry.id);
  saveQueue();

  syncToKanban(task).catch(() => {});
  return task;
}

/**
 * Whether a blocked task is eligible for the heartbeat to re-pick (its backoff
 * window has elapsed). Non-blocked tasks return false.
 */
export function isBlockedTaskReady(task: QueuedTask, now: number = Date.now()): boolean {
  if (task.status !== "blocked") return false;
  return (task.blockedUntil ?? 0) <= now;
}

/**
 * Get task by ID
 */
export function getTask(taskId: string): QueuedTask | null {
  return taskQueue.find((t) => t.id === taskId) || null;
}

/**
 * Get queue statistics
 */
export function getQueueStats(): {
  total: number;
  pending: number;
  approved: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  byPriority: Record<QueuedTaskPriority, number>;
} {
  const byPriority: Record<QueuedTaskPriority, number> = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
  };

  let pending = 0,
    approved = 0,
    running = 0,
    completed = 0,
    failed = 0,
    blocked = 0;

  for (const task of taskQueue) {
    byPriority[task.priority]++;

    switch (task.status) {
      case "pending":
        pending++;
        break;
      case "approved":
        approved++;
        break;
      case "running":
        running++;
        break;
      case "completed":
        completed++;
        break;
      case "failed":
        failed++;
        break;
      case "blocked":
        blocked++;
        break;
    }
  }

  return {
    total: taskQueue.length,
    pending,
    approved,
    running,
    completed,
    failed,
    blocked,
    byPriority,
  };
}

/**
 * Clear completed/failed tasks older than N days
 */
export function cleanupQueue(olderThanDays: number = 7): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const before = taskQueue.length;

  taskQueue = taskQueue.filter((t) => {
    if (t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled") {
      return true;
    }
    return (t.completedAt || t.createdAt) > cutoff;
  });

  saveQueue();
  return before - taskQueue.length;
}

// Export convenience object
export const queue = {
  init: initQueue,
  add: queueTask,
  get: getQueue,
  pending: getPendingTasks,
  next: getNextTask,
  approve: approveTask,
  cancel: cancelTask,
  start: startTask,
  complete: completeTask,
  fail: failTask,
  block: blockTask,
  isBlockedReady: isBlockedTaskReady,
  reconcileOrphans,
  getById: getTask,
  stats: getQueueStats,
  cleanup: cleanupQueue,
  persist: persistQueue,
};
