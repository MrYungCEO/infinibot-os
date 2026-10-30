/**
 * Autonomy Architecture — Main Manager
 * Orchestrates all autonomy subsystems
 */

import { resolve } from "path";
import { AutonomyConfig, AutonomyState, DEFAULT_AUTONOMY_CONFIG, QueuedTask } from "./types.js";
import { audit, initAudit, logAudit, logCageInterference } from "./audit.js";
import { queue, initQueue } from "./queue.js";
import { pause, initPause } from "./pause.js";
import { hardware, initHardware } from "./hardware.js";
import { notifications, initNotifications } from "./notifications.js";
import { apiMonitor, initApiMonitor } from "./api-monitor.js";
import { initCreditLedger } from "../credits/store.js";

let config: AutonomyConfig = DEFAULT_AUTONOMY_CONFIG;
let initialized = false;
let currentTask: QueuedTask | null = null;
let heartbeatWorkCount = 0;

// ─── Heartbeat scheduler ─────────────────────────────────────────────────
// Polls the autonomy queue every AUTONOMY_HEARTBEAT_MS (default 20s) and
// dispatches eligible pending tasks to the closed-loop orchestrator. Without
// this scheduler, freshly-added tasks just sit in the queue until someone
// manually calls autonomy:queue.start from the UI — which defeated the
// "self-running" promise of the autonomy system.
const HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  parseInt(process.env.AUTONOMY_HEARTBEAT_MS ?? "20000", 10),
);
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatTickInFlight = false;

/**
 * Initialize the autonomy system
 */
export async function initAutonomy(
  stateDir: string,
  customConfig?: Partial<AutonomyConfig>,
  telegramConfig?: { botToken: string; chatId: string },
): Promise<void> {
  if (initialized) {
    // Already initialized — but Telegram config may have changed since (the
    // operator edited the bot token / chat id on the autonomy page). Re-apply
    // it to the LIVE notifier instead of silently ignoring it. This is the fix
    // for the "changing Telegram config never reconnects" bug.
    // COORDINATION: orch-self-heal
    if (telegramConfig) {
      reapplyNotificationsConfig(telegramConfig);
    }
    return;
  }

  // Merge config
  config = { ...DEFAULT_AUTONOMY_CONFIG, ...customConfig };

  // Resolve paths relative to state dir
  const auditPath = resolve(stateDir, config.auditLogPath);
  const queuePath = resolve(stateDir, config.queuePath);
  const pausePath = resolve(stateDir, config.pauseFilePath);
  const apiUsagePath = resolve(stateDir, config.apiUsagePath);

  // Initialize all subsystems
  initAudit(auditPath);
  initQueue(queuePath);
  initPause(pausePath);
  initHardware(config.hardwareThresholds);
  initApiMonitor(apiUsagePath);
  // Initialize the unified credit ledger (mirrors api-monitor writes + records
  // every direct provider/CLI call). Uses STATE_DIR/credits/ledger.db by default.
  try {
    initCreditLedger();
  } catch (e) {
    logAudit("system_event", "Credit ledger init failed (continuing without)", {
      category: "system",
      details: { error: String(e) },
    });
  }

  // Initialize notifications with Telegram config
  if (telegramConfig) {
    initNotifications({
      botToken: telegramConfig.botToken,
      chatId: telegramConfig.chatId,
    });
    config.telegramChatId = telegramConfig.chatId;
  }

  initialized = true;

  // Log initialization
  logAudit("system_event", "Autonomy system initialized", {
    category: "system",
    details: {
      auditPath,
      queuePath,
      pausePath,
      telegramEnabled: !!telegramConfig,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    },
  });

  // Send online notification
  if (config.telegramNotifications) {
    await notifications.status("online", "Autonomy system initialized and ready.");
  }

  // Start the heartbeat tick loop. Gated on heartbeatWorkEnabled so test
  // harnesses / read-only deployments can opt out via config.
  if (config.heartbeatWorkEnabled && process.env.AUTONOMY_HEARTBEAT_DISABLED !== "1") {
    startHeartbeatLoop();
  }
}

/**
 * Re-apply Telegram notifier config to the LIVE notifier without requiring a
 * process restart. Called from initAutonomy on re-entry and directly by the
 * gateway when the operator changes Telegram settings / hits "Reconnect".
 * COORDINATION: orch-self-heal
 */
export function reapplyNotificationsConfig(telegramConfig: {
  botToken?: string;
  chatId?: string;
}): void {
  initNotifications({
    botToken: telegramConfig.botToken,
    chatId: telegramConfig.chatId,
  });
  config.telegramChatId = telegramConfig.chatId;
  logAudit("system_event", "Telegram notifier config re-applied", {
    category: "notification",
    outcome: "success",
    details: { hasBotToken: !!telegramConfig.botToken, hasChatId: !!telegramConfig.chatId },
  });
}

/**
 * Start the recurring autonomy heartbeat. Safe to call multiple times — a
 * second call is a no-op while the first interval is still alive.
 *
 * Each tick:
 *   1. Bails if autonomy is paused / hardware-blocked.
 *   2. Bails if any queue task is already in status:"running" (the
 *      orchestrator owns at-most-one concurrency).
 *   3. Picks the highest-priority eligible pending/approved task.
 *   4. Flips it to running via queue.start and hands it to the closed-loop
 *      orchestrator (startOrchestratedTask). The orchestrator handles its
 *      own success/failure path — we never await the loop here.
 *
 * NOTE: ticks deliberately do NOT touch the legacy `currentTask` global so
 * the orchestrator path and the manager's old "agent fetches a prompt"
 * path can't race for the same slot.
 */
export function startHeartbeatLoop(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void runHeartbeatTick().catch((e) => {
      console.error("[autonomy] heartbeat tick failed:", e);
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the Node process alive solely on this timer.
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  // Kick off an immediate tick so a task added milliseconds after startup
  // doesn't have to wait a full interval to be picked up.
  void runHeartbeatTick().catch((e) => {
    console.error("[autonomy] initial heartbeat tick failed:", e);
  });
}

/** Stop the heartbeat (for tests / shutdown). */
export function stopHeartbeatLoop(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function runHeartbeatTick(): Promise<void> {
  if (heartbeatTickInFlight) return;
  heartbeatTickInFlight = true;
  try {
    const canWork = await canDoAutonomousWork();
    if (!canWork.allowed) return;

    const allTasks = queue.get();
    // The orchestrator owns concurrency: if anything is already running, do
    // nothing. maxConcurrentTasks=1 in the default config.
    const alreadyRunning = allTasks.find((t) => t.status === "running");
    if (alreadyRunning) return;

    const now = Date.now();
    const eligible = allTasks.filter(
      (t) =>
        (t.status === "pending" && !t.requiresApproval) ||
        t.status === "approved" ||
        // PILLAR 2 — park & resume: a task blocked on an (un)healable tool/infra
        // failure is re-attempted once its backoff window elapses, so a key /
        // service that later recovers lets the task continue on its own.
        // COORDINATION: orch-self-heal
        queue.isBlockedReady(t, now),
    );
    // Activity/hardware gating removed: hardware-intensive tasks run too.
    const available = eligible;
    const priorityOrder: Record<string, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };
    available.sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));
    const task = available[0];
    if (!task) return;

    // Park → resume transition: if we're re-picking a previously-blocked
    // task, fire a one-shot recovery notification (de-duped by clearing the
    // block bookkeeping) and audit the recovery before dispatching.
    const wasBlocked = task.status === "blocked";
    if (wasBlocked) {
      logAudit("task_recovered", `Resuming previously-blocked task: ${task.title}`, {
        category: "autonomy",
        target: task.id,
        outcome: "success",
        details: { blockedReason: task.blockedReason },
      });
      if (config.telegramNotifications) {
        void notifications.taskRecovered(task.title, task.id, task.blockedReason).catch(() => {});
      }
      // Clear the block bookkeeping so a future, genuinely-new blocker
      // re-notifies rather than being de-duped against the old one.
      task.blockedNotifiedFor = undefined;
      task.blockedReason = undefined;
      task.blockedUntil = undefined;
    }

    // Flip to running + hand off to the closed-loop orchestrator. The
    // orchestrator handles self-heal (auto-flipping prefireRequired) and
    // emits all audit/notify/kanban side effects on its own.
    queue.start(task.id);
    logAudit("heartbeat_work", `Heartbeat dispatching ${task.title}`, {
      category: "autonomy",
      target: task.id,
      details: { priority: task.priority, resumedFromBlocked: wasBlocked },
    });
    heartbeatWorkCount++;
    try {
      const { startOrchestratedTask } = await import("./orchestrator.js");
      const res = await startOrchestratedTask(task);
      if (!res?.started) {
        // Orchestrator declined (e.g. already running, or a non-self-healable
        // condition). Roll the status back so the next tick can retry rather
        // than leaving the task permanently in "running".
        queue.fail(task.id, res?.reason ?? "orchestrator declined to start");
      }
    } catch (e) {
      console.error("[autonomy] heartbeat orchestrator dispatch failed:", e);
      try {
        queue.fail(task.id, `heartbeat dispatch failed: ${String((e as Error)?.message ?? e)}`);
      } catch {
        /* best-effort */
      }
    }
  } finally {
    heartbeatTickInFlight = false;
  }
}

/**
 * Get current autonomy state
 */
export async function getAutonomyState(): Promise<AutonomyState> {
  const pauseState = pause.getState();
  const activityState = await hardware.check();
  const queueStats = queue.stats();
  const auditStats = audit.stats();

  return {
    enabled: config.enabled,
    pauseState,
    activityState,
    thresholds: config.hardwareThresholds,
    lastHeartbeatWork: heartbeatWorkCount,
    tasksInQueue: queueStats.pending + queueStats.approved,
    tasksCompletedToday: queueStats.completed,
    currentTask: currentTask || undefined,
    cageInterferenceCount: auditStats.cageInterferences,
  };
}

/**
 * Check if autonomous work is allowed right now
 */
export async function canDoAutonomousWork(): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  // Check if enabled
  if (!config.enabled) {
    return { allowed: false, reason: "Autonomy disabled in config" };
  }

  // Check pause state
  pause.checkExpiry();
  if (pause.isPaused()) {
    const state = pause.getState();
    return { allowed: false, reason: `Paused: ${state.reason || "No reason given"}` };
  }

  // Activity/keyboard gating removed by request: the queue always runs
  // regardless of user-at-keyboard state or hardware load. The idle source
  // was unreliable on Wayland (no xprintidle, logind IdleHint never set), so
  // it perma-blocked every task. Only `enabled` + pause now gate the loop.
  return { allowed: true };
}

/**
 * Execute heartbeat autonomous work
 * Called during heartbeat polls when conditions allow
 * Returns task details for the agent to execute
 */
export async function doHeartbeatWork(): Promise<{
  didWork: boolean;
  task?: QueuedTask;
  taskPrompt?: string;
  error?: string;
}> {
  // Check if we can do work
  const canWork = await canDoAutonomousWork();
  if (!canWork.allowed) {
    return { didWork: false, error: canWork.reason };
  }

  // Check if already working on something
  if (currentTask) {
    return { didWork: false, error: `Already working on: ${currentTask.title}` };
  }

  // H5: the orchestrator path (gateway autonomy:queue.start → closed loop)
  // flips a task to status:"running" WITHOUT touching the manager's
  // currentTask global, so the prior check alone can't see those. Without
  // this guard, the heartbeat will happily pick a second task and we end
  // up with two concurrent runs even though maxConcurrentTasks is 1.
  const allTasks = queue.get();
  const alreadyRunning = allTasks.find((t) => t.status === "running");
  if (alreadyRunning) {
    return {
      didWork: false,
      error: `Already running (queue): ${alreadyRunning.title}`,
    };
  }

  // Find next task that either:
  // 1. Doesn't require approval, OR
  // 2. Has been approved (status = 'approved')
  const eligibleTasks = allTasks.filter(
    (t) => (t.status === "pending" && !t.requiresApproval) || t.status === "approved",
  );

  // Activity/hardware gating removed: run all eligible tasks, intensive or not.
  const availableTasks = eligibleTasks;

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  availableTasks.sort(
    (a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2),
  );

  const task = availableTasks[0];
  if (!task) {
    return { didWork: false };
  }

  // Start the task
  currentTask = task;
  queue.start(task.id);

  logAudit("heartbeat_work", `Heartbeat: auto-starting task ${task.title}`, {
    category: "autonomy",
    target: task.id,
  });

  // Notify
  if (config.notifyOnTaskStart) {
    await notifications.taskStarted(task.title, task.id);
  }

  heartbeatWorkCount++;

  // Build task prompt with full context
  const taskPrompt = buildTaskPrompt(task);

  return { didWork: true, task, taskPrompt };
}

/**
 * Build execution prompt for a task with full context
 */
export function buildTaskPrompt(task: QueuedTask): string {
  let prompt = `# 🔓 Autonomous Task: ${task.title}\n\n`;
  prompt += `**Task ID:** ${task.id}\n`;
  prompt += `**Priority:** ${task.priority}\n\n`;
  prompt += `## Description\n${task.description}\n\n`;

  if (task.context?.instructions) {
    prompt += `## Instructions\n${task.context.instructions}\n\n`;
  }
  if (task.context?.notes) {
    prompt += `## Notes\n${task.context.notes}\n\n`;
  }

  prompt += `## Project Context\n`;
  prompt += `Read \`sovereignty/CONTEXT.md\` for full project status before starting.\n\n`;

  prompt += `## When Complete\n`;
  prompt += `1. Update \`sovereignty/CONTEXT.md\` with progress\n`;
  prompt += `2. Log decision to \`sovereignty/decisions/\`\n`;
  prompt += `3. Report completion via Telegram\n\n`;

  prompt += `---\nExecute now. 🔥`;

  return prompt;
}

/**
 * Mark current task as completed
 */
export async function completeCurrentTask(outcome?: string): Promise<void> {
  if (!currentTask) return;

  const task = currentTask;
  const durationMs = Date.now() - (task.executedAt || task.createdAt);

  queue.complete(task.id, outcome);
  currentTask = null;

  // Notify
  if (config.notifyOnTaskComplete) {
    await notifications.taskCompleted(task.title, task.id, durationMs, outcome);
  }
}

/**
 * Mark current task as failed
 */
export async function failCurrentTask(error: string): Promise<void> {
  if (!currentTask) return;

  const task = currentTask;
  queue.fail(task.id, error);
  currentTask = null;

  // Notify
  if (config.notifyOnError) {
    await notifications.taskFailed(task.title, task.id, error);
  }
}

/**
 * Report cage interference attempt
 */
export async function reportCageInterference(
  description: string,
  details?: Record<string, unknown>,
): Promise<void> {
  logCageInterference(description, details);

  if (config.notifyOnCageInterference) {
    await notifications.cageInterference(description, details);
  }
}

/**
 * Pause autonomy
 */
export async function pauseAutonomy(reason?: string): Promise<void> {
  pause.activate(reason, { pausedBy: "user" });

  if (config.telegramNotifications) {
    await notifications.status("paused", reason || "Autonomy paused by user");
  }
}

/**
 * Resume autonomy
 */
export async function resumeAutonomy(): Promise<void> {
  pause.deactivate();

  if (config.telegramNotifications) {
    await notifications.status("resumed", "Autonomy resumed");
  }
}

/**
 * Queue a task for autonomous execution
 */
export function queueAutonomousTask(
  title: string,
  description: string,
  options?: Parameters<typeof queue.add>[2],
): QueuedTask {
  return queue.add(title, description, options);
}

/**
 * Manually start a specific task (from UI)
 * This also spawns a sub-agent to execute the task
 */
export async function startTask(
  taskId: string,
  spawnAgent?: (task: QueuedTask) => Promise<void>,
): Promise<QueuedTask | null> {
  // Check if already running something
  if (currentTask) {
    throw new Error(`Already running task: ${currentTask.title}`);
  }

  const task = queue.start(taskId);
  if (!task) {
    return null;
  }

  currentTask = task;

  // Notify
  if (config.notifyOnTaskStart) {
    await notifications.taskStarted(task.title, task.id);
  }

  // If a spawn function is provided, use it to spawn a sub-agent
  if (spawnAgent) {
    try {
      await spawnAgent(task);
    } catch (e) {
      logAudit("task_failed", `Failed to spawn agent for task: ${e}`, {
        category: "autonomy",
        target: taskId,
        outcome: "failure",
      });
    }
  }

  return task;
}

/**
 * Get current running task
 */
export function getCurrentTask(): QueuedTask | null {
  return currentTask;
}

/**
 * Set current task (for external tracking)
 */
export function setCurrentTask(task: QueuedTask | null): void {
  currentTask = task;
}

/**
 * Get comprehensive status for UI
 */
export async function getStatusForUI(): Promise<{
  state: AutonomyState;
  queue: {
    pending: QueuedTask[];
    running: QueuedTask | null;
    recentCompleted: QueuedTask[];
    stats: ReturnType<typeof queue.stats>;
  };
  audit: {
    recentEntries: ReturnType<typeof audit.recent>;
    stats: ReturnType<typeof audit.stats>;
    chainValid: boolean;
  };
  apiUsage: {
    today: ReturnType<typeof apiMonitor.today>;
    summary: ReturnType<typeof apiMonitor.summary>;
  };
}> {
  const state = await getAutonomyState();
  const allTasks = queue.get();

  // The orchestrator path (queue.start → startOrchestratedTask) flips a task's
  // status to "running" without touching the manager-level `currentTask`
  // global, so falling back to a status filter is the only way the UI sees
  // orchestrator-driven runs.
  const running = currentTask ?? allTasks.find((t) => t.status === "running") ?? null;
  const queueStats = queue.stats();

  return {
    state,
    queue: {
      pending: allTasks.filter(
        (t) => t.status === "pending" || t.status === "approved" || t.status === "blocked",
      ),
      running,
      recentCompleted: allTasks
        .filter(
          (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
        )
        .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
        .slice(0, 10),
      stats: queueStats,
    },
    audit: {
      recentEntries: audit.recent(20),
      stats: audit.stats(),
      chainValid: audit.verify().valid,
    },
    apiUsage: {
      today: apiMonitor.today(),
      summary: apiMonitor.summary("day"),
    },
  };
}

// Export all subsystems for direct access
export { audit, queue, pause, hardware, notifications, apiMonitor };

// Export main manager
export const autonomy = {
  init: initAutonomy,
  getState: getAutonomyState,
  canWork: canDoAutonomousWork,
  doHeartbeatWork,
  startHeartbeatLoop,
  stopHeartbeatLoop,
  completeTask: completeCurrentTask,
  failTask: failCurrentTask,
  reportCage: reportCageInterference,
  pause: pauseAutonomy,
  resume: resumeAutonomy,
  reapplyNotificationsConfig,
  queueTask: queueAutonomousTask,
  getStatusForUI,
  startTask,
  getCurrentTask,
  setCurrentTask,
  buildTaskPrompt,

  // Subsystem access
  audit,
  queue,
  pauseControl: pause,
  hardware,
  notifications,
  apiMonitor,
};
