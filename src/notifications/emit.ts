/**
 * Unified notification emitter — the single chokepoint for all notifications.
 *
 * Every push that goes out also lands in the persistent history store, and a
 * `notification.created` gateway event is broadcast so connected mobile apps
 * update in real time.
 *
 * Usage:
 *   import { emitNotification } from "../notifications/emit.js";
 *   await emitNotification({ category: "agent.completed", ... });
 */

import { isSecureSessionKey } from "../secure-mode/session-key.js";
import crypto from "crypto";
import {
  getNotificationHistoryStore,
  type NotificationCategory,
  type NotificationSeverity,
} from "./history-store.js";
import { getPushTokenStore } from "./push-token-store.js";
import { sendExpoPushMessages, type ExpoMessage } from "./expo-push-client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeDeepLink, webOpenerUrl } from "./links.js";
import { getPublicBaseUrl } from "./public-base.js";

const log = createSubsystemLogger("notification-emit");

export interface EmitNotificationOpts {
  category: NotificationCategory;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  source?: string;
  sourceId?: string | null;
  /**
   * Where a tap lands (docs/mobile/DEEP-LINKS.md). Any accepted form —
   * `infinibot://…`, legacy `mobile://chat?sessionKey=`, or a relative web path —
   * is normalized to `infinibot://<path>`.
   */
  deepLink?: string | null;
  /** https opener URL (`<public-base>/m/<path>`); derived from deepLink when absent. */
  webUrl?: string | null;
  data?: Record<string, unknown>;
  expiresAt?: number | null;
  stateDir?: string;
  /**
   * Optional human-friendly title that should be shown by UIs ahead of `title`.
   * Old consumers continue to read `title`; new consumers prefer
   * `data.displayTitle` (mirrored at top level of the broadcast payload).
   */
  displayTitle?: string;
  /**
   * Optional short 1-line summary describing what happened (e.g. duration +
   * files changed). Mirrored into `data.summary` and into the broadcast
   * payload so the Alerts row can render it without re-parsing `body`.
   */
  summary?: string;
}

type BroadcastFn = (event: string, payload: unknown) => void;

let _broadcaster: BroadcastFn | null = null;

/** Called once from gateway startup to wire in the WS broadcast function. */
export function setNotificationBroadcaster(fn: BroadcastFn): void {
  _broadcaster = fn;
}

const CHANNEL_ID_MAP: Record<string, string> = {
  "agent.completed": "agent-messages",
  "agent.error": "agent-messages",
  "agent.input_required": "agent-messages",
  "terminal.exit": "system",
  "cron.fired": "system",
  "discipline.alert": "discipline",
  "kanban.task.completed": "task-updates",
  "kanban.task.assigned": "task-updates",
  "kanban.task.due": "task-updates",
  "business.lead.new": "default",
  "business.income.logged": "default",
  "federation.node.online": "system",
  "federation.node.offline": "system",
  "system.update.available": "system",
  "voice.call.incoming": "default",
  "voice.call.missed": "default",
  "chat.mentions": "agent-messages",
  "autonomy.checkpoint": "agent-messages",
  "autonomy.budget.warning": "system",
  "autonomy.budget.hit": "system",
  "credits.threshold": "system",
  manual: "default",
};

function priorityForSeverity(sev: NotificationSeverity): "high" | "default" {
  return sev === "error" || sev === "critical" ? "high" : "default";
}

/**
 * Secure Mode: a notification about a secure session must not carry its
 * content into the plaintext history DB or a cloud push service. Keep the
 * routing (session key, run id, deep link) and replace the words.
 */
function redactSecureNotification(opts: EmitNotificationOpts): EmitNotificationOpts {
  const data = (opts.data ?? {}) as Record<string, unknown>;
  const key =
    (typeof data.sessionKey === "string" && data.sessionKey) ||
    (typeof opts.sourceId === "string" && opts.sourceId) ||
    "";
  if (!isSecureSessionKey(key)) return opts;
  const keep: Record<string, unknown> = { secure: true, sessionKey: key };
  for (const f of ["type", "runId", "phase", "kind"]) if (f in data) keep[f] = data[f];
  return {
    ...opts,
    title: "Secure Mode",
    body: "Secure session update (content stays in Secure Mode)",
    displayTitle: undefined,
    summary: undefined,
    data: keep,
  };
}

export async function emitNotification(rawOpts: EmitNotificationOpts): Promise<string> {
  const opts = redactSecureNotification(rawOpts);
  const {
    category,
    severity = "info",
    title,
    body,
    source = "system",
    sourceId = null,
    deepLink: rawDeepLink = null,
    webUrl: rawWebUrl,
    data = {},
    expiresAt = null,
    stateDir,
    displayTitle,
    summary,
  } = opts;

  const id = crypto.randomUUID();
  const ts = Date.now();

  const deepLink = normalizeDeepLink(rawDeepLink);
  let webUrl: string | null = rawWebUrl?.trim() || null;
  if (!webUrl && deepLink) {
    try {
      const base = getPublicBaseUrl();
      webUrl = base ? webOpenerUrl(deepLink, base) : null;
    } catch {
      webUrl = null;
    }
  }

  // Stash humanized title + summary inside `data` so the SQLite history row
  // carries them without a schema migration. Mirrors are also emitted at the
  // top level of the broadcast payload below for direct consumer access.
  const enrichedData: Record<string, unknown> = { ...data };
  if (displayTitle && !enrichedData.displayTitle) {
    enrichedData.displayTitle = displayTitle;
  }
  if (summary && !enrichedData.summary) {
    enrichedData.summary = summary;
  }
  if (!enrichedData.rawTitle && displayTitle && title && displayTitle !== title) {
    enrichedData.rawTitle = title;
  }
  // The history table has no webUrl column — it rides in the data JSON.
  if (webUrl && !enrichedData.webUrl) enrichedData.webUrl = webUrl;

  // 1. Persist to history
  const store = getNotificationHistoryStore(stateDir);
  const prefs = store.getPreferences();
  const catPref = store.getCategoryPreference(category);

  // Check category preference: enabled + severity threshold
  const sevOrder: NotificationSeverity[] = ["info", "success", "warn", "error", "critical"];
  const sevIndex = sevOrder.indexOf(severity);
  const minSevIndex = sevOrder.indexOf(catPref.minSeverity);
  const belowThreshold = sevIndex < minSevIndex;

  // Get all registered push tokens
  const tokenStore = getPushTokenStore(stateDir);
  const validTokens = tokenStore.listValid();
  const tokenStrings = validTokens.map((t) => t.token);

  const entry = store.insert({
    id,
    ts,
    category,
    severity,
    title,
    body,
    source,
    sourceId,
    deepLink,
    data: enrichedData,
    deviceTokens: tokenStrings,
    snoozeUntil: null,
    expiresAt,
  });

  // 2. Broadcast gateway event so connected mobile apps update in real time.
  // displayTitle + summary are emitted at the top level alongside being
  // available under `data` so legacy consumers reading `title`/`body` keep
  // working and new consumers can prefer the friendlier strings without
  // digging through `data`.
  if (_broadcaster) {
    try {
      _broadcaster("notification.created", {
        id: entry.id,
        ts: entry.ts,
        category: entry.category,
        severity: entry.severity,
        title: entry.title,
        body: entry.body,
        source: entry.source,
        sourceId: entry.sourceId,
        deepLink: entry.deepLink,
        webUrl,
        data: entry.data,
        displayTitle: displayTitle ?? null,
        summary: summary ?? null,
      });
    } catch (err) {
      log.warn("broadcast failed", { error: String(err) });
    }
  }

  // 3. Send push notification if category is enabled and severity meets threshold
  if (!catPref.enabled || belowThreshold || validTokens.length === 0) {
    log.info("push skipped", {
      category,
      severity,
      enabled: catPref.enabled,
      belowThreshold,
      tokenCount: validTokens.length,
    });
    return id;
  }

  const channelId = CHANNEL_ID_MAP[category] ?? "default";
  const isCritical = severity === "critical";
  const messages: ExpoMessage[] = validTokens.map((t) => ({
    to: t.token,
    title,
    body,
    data: {
      ...enrichedData,
      category,
      severity,
      notificationId: id,
      source,
      sourceId,
      deepLink,
      webUrl,
    },
    priority: priorityForSeverity(severity),
    sound: catPref.sound ? "default" : null,
    channelId: isCritical && channelId === "agent-messages" ? "agent-critical" : channelId,
    // iOS: keep critical alerts visible in foreground
    ...(isCritical ? { _displayInForeground: true } : {}),
  }));

  try {
    const { invalidTokens } = await sendExpoPushMessages(messages);
    for (const token of invalidTokens) {
      tokenStore.markInvalid(token);
      log.info("marked token invalid", { tokenSuffix: token.slice(-10) });
    }
    log.info("push sent", {
      category,
      severity,
      tokenCount: messages.length - invalidTokens.length,
    });
  } catch (err) {
    log.warn("push send error", { error: String(err) });
  }

  return id;
}
