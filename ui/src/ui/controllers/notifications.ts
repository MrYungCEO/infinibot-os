/**
 * Notification controller — manages toast notifications globally.
 */

export interface AppNotification {
  id: string;
  type: "success" | "error" | "info" | "warning" | "completion" | "spawn";
  title: string;
  message: string;
  timestamp: number;
  duration: number; // ms, 0 = sticky until dismissed
  icon?: string;
  action?: { label: string; callback: () => void };
  sessionKey?: string;
  agentId?: string;
  dismissed: boolean;
  progress?: number; // 0-100
  accentColor?: string;
  deepLink?: string | null;
}

export type NotificationsState = {
  notifications: AppNotification[];
  notificationHistory: AppNotification[];
  notificationHistoryOpen: boolean;
  requestUpdate?: () => void;
};

const DEFAULT_DURATIONS: Record<AppNotification["type"], number> = {
  success: 4000,
  error: 0,     // sticky — requires explicit dismiss per spec
  info: 4000,
  warning: 8000,
  completion: 4000,
  spawn: 4000,
};

const ICON_MAP: Record<AppNotification["type"], string> = {
  success: "✅",
  error: "❌",
  info: "ℹ️",
  warning: "⚠️",
  completion: "🤖",
  spawn: "⊕",
};

// Active dismiss timers keyed by notification id
const timers = new Map<string, number>();
// Pause/resume support: track when each timer was scheduled and its total duration
const timerStartTimes = new Map<string, number>();
const timerDurations = new Map<string, number>();

let idCounter = 0;

const HISTORY_STORAGE_KEY = "infinibot-notification-history";
const HISTORY_MAX_AGE_MS = 86400000; // 24h

function persistHistory(history: AppNotification[]): void {
  try {
    const stripped = history.map((n) => ({ ...n, action: undefined }));
    localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify({ ts: Date.now(), items: stripped }),
    );
  } catch {
    // Storage full / unavailable — silently skip
  }
}

export function loadNotificationHistory(): AppNotification[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (parsed.ts && Date.now() - parsed.ts > HISTORY_MAX_AGE_MS) {
      localStorage.removeItem(HISTORY_STORAGE_KEY);
      return [];
    }
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

export function addNotification(
  state: NotificationsState,
  partial: Omit<AppNotification, "id" | "timestamp" | "dismissed"> & { id?: string; timestamp?: number; dismissed?: boolean },
): string {
  const id = partial.id ?? `notif-${Date.now()}-${++idCounter}`;
  const duration = partial.duration ?? DEFAULT_DURATIONS[partial.type] ?? 5000;
  const icon = partial.icon ?? ICON_MAP[partial.type] ?? "ℹ️";

  const notification: AppNotification = {
    ...partial,
    id,
    timestamp: partial.timestamp ?? Date.now(),
    dismissed: partial.dismissed ?? false,
    duration,
    icon,
  };

  // Dedupe by stable id: a caller (e.g. the gateway "Connected" toast) can
  // pass a sticky id to collapse repeats from a recovery storm onto a single
  // toast instead of stacking. Cancel the old timer and drop the old entry so
  // the new notification's duration starts fresh.
  const dup = state.notifications.find((n) => n.id === id && !n.dismissed);
  if (dup) {
    const t = timers.get(dup.id);
    if (t != null) { window.clearTimeout(t); timers.delete(dup.id); }
    timerStartTimes.delete(dup.id);
    timerDurations.delete(dup.id);
    state.notifications = state.notifications.filter((n) => n !== dup);
  }

  // Prepend (newest first)
  state.notifications = [notification, ...state.notifications];

  // Cap active stack at 4 — drop oldest entirely. Previously these were just
  // flagged `dismissed = true` and left in the array, which (a) leaked memory
  // across long sessions and (b) made a reconnect storm look like several
  // "stuck" toasts because the toast component re-mounted with each render
  // pass and briefly re-showed the dismissed-but-still-present entries.
  const active = state.notifications.filter((n) => !n.dismissed);
  if (active.length > 4) {
    const toRemove = [...active]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, active.length - 4);
    const removeIds = new Set(toRemove.map((n) => n.id));
    for (const old of toRemove) {
      const t = timers.get(old.id);
      if (t != null) { window.clearTimeout(t); timers.delete(old.id); }
      timerStartTimes.delete(old.id);
      timerDurations.delete(old.id);
      state.notificationHistory = state.notificationHistory.map((h) =>
        h.id === old.id ? { ...h, dismissed: true } : h,
      );
    }
    state.notifications = state.notifications.filter((n) => !removeIds.has(n.id));
  }

  // Add to history (cap at 50) and persist
  state.notificationHistory = [notification, ...state.notificationHistory].slice(0, 50);
  persistHistory(state.notificationHistory);

  state.requestUpdate?.();

  // Auto-dismiss after duration (if duration > 0)
  if (duration > 0) {
    timerStartTimes.set(id, Date.now());
    timerDurations.set(id, duration);
    const timer = window.setTimeout(() => {
      dismissNotification(state, id);
    }, duration);
    timers.set(id, timer);
  }

  return id;
}

export function dismissNotification(state: NotificationsState, id: string): void {
  const timer = timers.get(id);
  if (timer != null) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
  timerStartTimes.delete(id);
  timerDurations.delete(id);
  state.notifications = state.notifications.filter((n) => n.id !== id);
  // Also mark dismissed in history
  state.notificationHistory = state.notificationHistory.map((n) =>
    n.id === id ? { ...n, dismissed: true } : n,
  );
  persistHistory(state.notificationHistory);
  state.requestUpdate?.();
}

/** Pause the auto-dismiss timer for a notification. Returns remaining ms. */
export function pauseNotificationTimer(id: string): number {
  const timer = timers.get(id);
  if (timer != null) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
  const startTime = timerStartTimes.get(id) ?? Date.now();
  const duration = timerDurations.get(id) ?? 0;
  timerStartTimes.delete(id);
  timerDurations.delete(id);
  return Math.max(0, duration - (Date.now() - startTime));
}

/** Resume the auto-dismiss timer with the given remaining ms. */
export function resumeNotificationTimer(
  state: NotificationsState,
  id: string,
  remainingMs: number,
): void {
  if (remainingMs <= 0) {
    dismissNotification(state, id);
    return;
  }
  timerStartTimes.set(id, Date.now());
  timerDurations.set(id, remainingMs);
  const timer = window.setTimeout(() => dismissNotification(state, id), remainingMs);
  timers.set(id, timer);
}

export function clearAllNotifications(state: NotificationsState): void {
  // Clear all timers
  for (const [, timer] of timers) {
    window.clearTimeout(timer);
  }
  timers.clear();
  state.notifications = [];
  state.requestUpdate?.();
}

export function clearNotificationHistory(state: NotificationsState): void {
  state.notificationHistory = [];
  try { localStorage.removeItem(HISTORY_STORAGE_KEY); } catch { /* ignore */ }
  state.requestUpdate?.();
}

export function getActiveNotifications(state: NotificationsState): AppNotification[] {
  return state.notifications
    .filter((n) => !n.dismissed)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 4);
}

export function toggleNotificationHistory(state: NotificationsState): void {
  state.notificationHistoryOpen = !state.notificationHistoryOpen;
  state.requestUpdate?.();
}

export function getActiveCount(state: NotificationsState): number {
  return state.notifications.filter((n) => !n.dismissed).length;
}
