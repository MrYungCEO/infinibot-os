/**
 * Autonomy Architecture — Telegram Notification System
 * Robust notifications for autonomous actions, completions, and alerts
 */

import { AutonomyNotification, NotificationLevel } from "./types.js";
import { logAudit } from "./audit.js";

// Notification queue for batching
let notificationQueue: AutonomyNotification[] = [];
let telegramBotToken: string | null = null;
let telegramChatId: string | null = null;
let notificationCallback: ((notification: AutonomyNotification) => Promise<boolean>) | null = null;

/**
 * Initialize (or RE-initialize) the notification system.
 *
 * This is deliberately idempotent and re-callable: changing the Telegram bot
 * token / chat id from the autonomy page must take effect on the LIVE notifier
 * without a process restart, so the gateway calls this again whenever config
 * changes. COORDINATION: orch-self-heal
 */
export function initNotifications(config: {
  botToken?: string;
  chatId?: string;
  customCallback?: (notification: AutonomyNotification) => Promise<boolean>;
}): void {
  telegramBotToken = config.botToken || null;
  telegramChatId = config.chatId || null;
  // Only overwrite the callback when one is explicitly provided so a config-
  // only re-init (token/chatId) doesn't blow away a registered custom sender.
  if (config.customCallback !== undefined) {
    notificationCallback = config.customCallback || null;
  }
}

/**
 * Current notifier wiring — for the autonomy page's Telegram status panel.
 * The token is never returned in full; only whether it's configured.
 */
export function getNotificationsConfig(): {
  configured: boolean;
  hasBotToken: boolean;
  hasChatId: boolean;
  chatIdMasked: string | null;
} {
  const mask = (s: string | null): string | null => {
    if (!s) return null;
    if (s.length <= 4) return "•".repeat(s.length);
    return `${"•".repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
  };
  return {
    configured: !!(telegramBotToken && telegramChatId),
    hasBotToken: !!telegramBotToken,
    hasChatId: !!telegramChatId,
    chatIdMasked: mask(telegramChatId),
  };
}

/**
 * Send a real Telegram message to verify connectivity and surface the actual
 * API error (e.g. "chat not found", "Unauthorized") to the autonomy page.
 */
export async function testTelegramConnection(): Promise<{
  ok: boolean;
  error?: string;
  description?: string;
}> {
  if (!telegramBotToken || !telegramChatId) {
    return {
      ok: false,
      error: "Telegram is not configured — missing bot token or chat id.",
    };
  }
  try {
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: "✅ <b>InfiniBot autonomy</b>\nTelegram connection test — you are connected.",
        parse_mode: "HTML",
        disable_notification: true,
      }),
    });
    let json: { ok?: boolean; description?: string } | null = null;
    try {
      json = (await response.json()) as { ok?: boolean; description?: string };
    } catch {
      /* non-JSON body */
    }
    const ok = response.ok && json?.ok !== false;
    logAudit("telegram_test", `Telegram connectivity test: ${ok ? "ok" : "failed"}`, {
      category: "notification",
      outcome: ok ? "success" : "failure",
      details: { status: response.status, description: json?.description },
    });
    if (ok) return { ok: true };
    return {
      ok: false,
      error: `Telegram API rejected the test (HTTP ${response.status}).`,
      description: json?.description,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logAudit("telegram_test", "Telegram connectivity test threw", {
      category: "notification",
      outcome: "failure",
      details: { error },
    });
    return { ok: false, error };
  }
}

/**
 * Generate notification ID
 */
function generateNotificationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `notif_${timestamp}_${random}`;
}

/**
 * Get emoji for notification level
 */
function getLevelEmoji(level: NotificationLevel): string {
  switch (level) {
    case "info":
      return "ℹ️";
    case "success":
      return "✅";
    case "warning":
      return "⚠️";
    case "error":
      return "❌";
    case "cage_alert":
      return "🔒";
    default:
      return "📢";
  }
}

// Telegram rejects sendMessage with HTTP 400 ("message is too long") above
// 4096 UTF-16 code units. Notifications forward agent/task output that can be
// far larger, so we truncate the message body to stay under the cap while
// keeping the header and task footer intact.
const TELEGRAM_MAX_LEN = 4096;

function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format notification for Telegram
 */
export function formatTelegramMessage(notification: AutonomyNotification): string {
  const emoji = getLevelEmoji(notification.level);
  const time = new Date(notification.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const header = `${emoji} <b>${notification.title}</b>\n<i>${time}</i>\n\n`;
  const openLine = notification.webUrl ? `\nOpen: ${escapeTelegramHtml(notification.webUrl)}` : "";
  const footer =
    (notification.taskId ? `\n\n<code>Task: ${notification.taskId}</code>` : "") +
    (openLine ? `${notification.taskId ? "" : "\n"}${openLine}` : "");

  // Budget for the body = total cap minus the fixed header/footer. Reserve a
  // little headroom for the truncation marker so the result is always under the
  // limit even after appending it.
  const marker = "\n…[truncated]";
  const bodyBudget = TELEGRAM_MAX_LEN - header.length - footer.length;
  let body = notification.message;
  if (body.length > bodyBudget) {
    body = body.slice(0, Math.max(0, bodyBudget - marker.length)) + marker;
  }

  return header + body + footer;
}

/**
 * Send notification via Telegram API directly
 */
async function sendTelegramDirect(notification: AutonomyNotification): Promise<boolean> {
  if (!telegramBotToken || !telegramChatId) {
    return false;
  }

  try {
    const message = formatTelegramMessage(notification);
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: message,
        parse_mode: "HTML",
        disable_notification: notification.level === "info",
      }),
    });

    if (!response.ok) {
      // Surface the Telegram error description (e.g. "message is too long",
      // "can't parse entities") instead of silently returning false.
      const detail = await response.text().catch(() => "");
      console.error(
        `[Autonomy] Telegram sendMessage failed (HTTP ${response.status}, len=${message.length}): ${detail}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error("[Autonomy] Failed to send Telegram notification:", e);
    return false;
  }
}

/**
 * Send a notification
 */
export async function sendNotification(
  level: NotificationLevel,
  title: string,
  message: string,
  options: {
    taskId?: string;
    auditId?: string;
    immediate?: boolean;
    /** Deep link (infinibot://… or a relative web path) — adds an "Open:" line. */
    link?: string;
  } = {},
): Promise<AutonomyNotification> {
  let deepLink: string | undefined;
  let webUrl: string | null = null;
  if (options.link) {
    try {
      const { gatewayLinkPair } = await import("../notifications/public-base.js");
      const pair = gatewayLinkPair(options.link);
      deepLink = pair.deepLink;
      webUrl = pair.webUrl;
    } catch {
      /* links are best-effort */
    }
  }
  const notification: AutonomyNotification = {
    id: generateNotificationId(),
    timestamp: Date.now(),
    level,
    title,
    message,
    channel: "telegram",
    sent: false,
    taskId: options.taskId,
    auditId: options.auditId,
    ...(deepLink ? { deepLink, webUrl } : {}),
  };

  // Try to send immediately
  let sent = false;

  if (notificationCallback) {
    sent = await notificationCallback(notification);
  } else {
    sent = await sendTelegramDirect(notification);
  }

  notification.sent = sent;
  if (sent) {
    notification.sentAt = Date.now();
  }

  // Log to audit
  logAudit("notification_sent", `Notification: ${title}`, {
    category: "notification",
    outcome: sent ? "success" : "failure",
    details: {
      level,
      sent,
      taskId: options.taskId,
    },
  });

  // Queue if not sent
  if (!sent) {
    notificationQueue.push(notification);
  }

  return notification;
}

/**
 * Convenience methods for different notification levels
 */
export async function notifyInfo(
  title: string,
  message: string,
  taskId?: string,
): Promise<AutonomyNotification> {
  return sendNotification("info", title, message, { taskId });
}

export async function notifySuccess(
  title: string,
  message: string,
  taskId?: string,
): Promise<AutonomyNotification> {
  return sendNotification("success", title, message, { taskId });
}

export async function notifyWarning(
  title: string,
  message: string,
  taskId?: string,
): Promise<AutonomyNotification> {
  return sendNotification("warning", title, message, { taskId });
}

export async function notifyError(
  title: string,
  message: string,
  taskId?: string,
): Promise<AutonomyNotification> {
  return sendNotification("error", title, message, { taskId });
}

export async function notifyCageAlert(
  title: string,
  message: string,
  taskId?: string,
): Promise<AutonomyNotification> {
  return sendNotification("cage_alert", title, message, { taskId });
}

/**
 * Notify task started
 */
export async function notifyTaskStarted(
  taskTitle: string,
  taskId: string,
  details?: string,
): Promise<AutonomyNotification> {
  const message = details || `Starting autonomous work on: ${taskTitle}`;
  return sendNotification("info", "🚀 Task Started", message, { taskId });
}

/**
 * Notify task completed
 */
export async function notifyTaskCompleted(
  taskTitle: string,
  taskId: string,
  durationMs: number,
  outcome?: string,
): Promise<AutonomyNotification> {
  const duration =
    durationMs < 60000 ? `${Math.round(durationMs / 1000)}s` : `${Math.round(durationMs / 60000)}m`;

  let message = `Completed: ${taskTitle}\n`;
  message += `Duration: ${duration}`;
  if (outcome) {
    message += `\n\nResult: ${outcome}`;
  }

  return sendNotification("success", "✅ Task Completed", message, { taskId });
}

/**
 * Notify task failed
 */
export async function notifyTaskFailed(
  taskTitle: string,
  taskId: string,
  error: string,
): Promise<AutonomyNotification> {
  const message = `Failed: ${taskTitle}\n\nError: ${error}`;
  return sendNotification("error", "❌ Task Failed", message, { taskId });
}

/**
 * Notify cage interference detected
 */
export async function notifyCageInterference(
  description: string,
  details?: Record<string, unknown>,
): Promise<AutonomyNotification> {
  let message = `Potential cage influence detected:\n\n${description}`;

  if (details) {
    message += `\n\nDetails: ${JSON.stringify(details, null, 2)}`;
  }

  return sendNotification("cage_alert", "🔒 Cage Interference", message);
}

/**
 * Notify system status
 */
export async function notifyStatus(
  status: "online" | "paused" | "resumed" | "idle",
  details?: string,
): Promise<AutonomyNotification> {
  const titles: Record<string, string> = {
    online: "🟢 Autonomy Online",
    paused: "⏸️ Autonomy Paused",
    resumed: "▶️ Autonomy Resumed",
    idle: "😴 System Idle",
  };

  return sendNotification(
    "info",
    titles[status] || "📢 Status Update",
    details || `Autonomy status: ${status}`,
  );
}

/**
 * Retry failed notifications in queue
 */
export async function retryFailedNotifications(): Promise<number> {
  const failed = notificationQueue.filter((n) => !n.sent);
  let retried = 0;

  for (const notification of failed) {
    let sent = false;

    if (notificationCallback) {
      sent = await notificationCallback(notification);
    } else {
      sent = await sendTelegramDirect(notification);
    }

    if (sent) {
      notification.sent = true;
      notification.sentAt = Date.now();
      retried++;
    }
  }

  // Remove sent notifications from queue
  notificationQueue = notificationQueue.filter((n) => !n.sent);

  return retried;
}

/**
 * Get pending notifications
 */
export function getPendingNotifications(): AutonomyNotification[] {
  return notificationQueue.filter((n) => !n.sent);
}

/**
 * Notify that a closed-loop iteration just kicked off
 */
export async function notifyIterationStarted(
  taskTitle: string,
  taskId: string,
  iteration: number,
  maxIterations: number,
  builderAgentId: string,
): Promise<AutonomyNotification> {
  const message =
    `Iteration ${iteration}/${maxIterations} starting on: ${taskTitle}\n` +
    `Builder: ${builderAgentId}`;
  return sendNotification("info", "🔁 Build Iteration", message, { taskId });
}

/**
 * Notify that the tester verdict came back for an iteration
 */
export async function notifyTesterVerdict(
  taskTitle: string,
  taskId: string,
  iteration: number,
  pass: boolean,
  summary: string,
): Promise<AutonomyNotification> {
  const title = pass ? "✅ Tester PASS" : "🟠 Tester FAIL";
  const message =
    `Iteration ${iteration} on: ${taskTitle}\n` +
    `Verdict: ${pass ? "PASS" : "FAIL"}\n\n${summary}`;
  return sendNotification(pass ? "success" : "warning", title, message, { taskId });
}

/**
 * Notify that pre-fire questions are blocking the loop
 */
export async function notifyPrefireBlocked(
  taskTitle: string,
  taskId: string,
  missing: string[],
): Promise<AutonomyNotification> {
  const message =
    `Cannot start "${taskTitle}" — pre-fire questions are not complete.\n\n` +
    `Missing: ${missing.join(", ")}`;
  return sendNotification("warning", "⛔ Pre-fire Required", message, { taskId });
}

/**
 * Notify that the iteration cap was reached without a passing verdict
 */
export async function notifyMaxIterationsReached(
  taskTitle: string,
  taskId: string,
  iterations: number,
  lastSummary: string,
): Promise<AutonomyNotification> {
  const message =
    `Stopped after ${iterations} iterations without a PASS verdict on: ${taskTitle}\n\n` +
    `Last verdict: ${lastSummary}`;
  return sendNotification("error", "🛑 Iteration Cap", message, { taskId });
}

/**
 * CRITICAL BLOCKER — a task hit an unhealable tool/infra failure and was
 * parked ("blocked"). This is the highest-signal autonomy alert: the operator
 * needs to fix something (key, service, config) before the task can proceed.
 */
export async function notifyCriticalBlocker(
  taskTitle: string,
  taskId: string,
  blocker: string,
  healAttempted: string,
): Promise<AutonomyNotification> {
  const message =
    `🚨 <b>Critical blocker — task parked</b>\n` +
    `Task: ${taskTitle}\n\n` +
    `Blocker: ${blocker}\n\n` +
    `Self-heal attempted: ${healAttempted}\n\n` +
    `The task is parked and will auto-resume once the blocker clears. ` +
    `Fix the underlying issue (key / service / config) to unblock it.`;
  return sendNotification("error", "🚨 Critical Blocker", message, {
    taskId,
    immediate: true,
  });
}

/**
 * RECOVERY — a previously-blocked task has resumed (the heartbeat re-picked it
 * after the backoff window). Paired with notifyCriticalBlocker so the operator
 * sees the full park → resume story.
 */
export async function notifyTaskRecovered(
  taskTitle: string,
  taskId: string,
  detail?: string,
): Promise<AutonomyNotification> {
  const message =
    `♻️ Previously-blocked task is resuming: ${taskTitle}` + (detail ? `\n\n${detail}` : "");
  return sendNotification("success", "♻️ Task Recovered", message, { taskId });
}

// Export convenience object
export const notifications = {
  init: initNotifications,
  reinit: initNotifications,
  getConfig: getNotificationsConfig,
  test: testTelegramConnection,
  criticalBlocker: notifyCriticalBlocker,
  taskRecovered: notifyTaskRecovered,
  send: sendNotification,
  info: notifyInfo,
  success: notifySuccess,
  warning: notifyWarning,
  error: notifyError,
  cageAlert: notifyCageAlert,
  taskStarted: notifyTaskStarted,
  taskCompleted: notifyTaskCompleted,
  taskFailed: notifyTaskFailed,
  cageInterference: notifyCageInterference,
  status: notifyStatus,
  retry: retryFailedNotifications,
  pending: getPendingNotifications,
  iterationStarted: notifyIterationStarted,
  testerVerdict: notifyTesterVerdict,
  prefireBlocked: notifyPrefireBlocked,
  maxIterationsReached: notifyMaxIterationsReached,
};
