/**
 * Calendar alert scheduler.
 *
 * Persists pending alerts to disk and re-arms timers on gateway start.
 * Telegram alerts are delivered via `sendMessageTelegram`. Other channels
 * are placeholders for future plumbing.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR } from "../utils.js";
import { sendMessageTelegram } from "../telegram/send.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listStoredEvents } from "./store.js";
import { emitNotification } from "../notifications/emit.js";
import { getKanbanStore } from "../tasks/store.js";
import { loadConfig } from "../config/config.js";
import type { NotificationCategory, NotificationSeverity } from "../notifications/history-store.js";

const log = createSubsystemLogger("calendar-alerts");

export type AlertChannel = "telegram" | "discord" | "email" | "notification";

export interface ScheduledAlert {
  id: string;
  eventId: string;
  eventTitle: string;
  fireAtMs: number;
  channel: AlertChannel;
  /** Channel-specific target (Telegram chat id, email, etc.) — falls back to env if missing. */
  target?: string;
  message: string;
  createdAtMs: number;
  /** Set when the alert has fired (success or failure). Kept for audit, pruned eventually. */
  firedAtMs?: number;
  fireStatus?: "ok" | "error";
  fireError?: string;
}

interface AlertsFile {
  version: 1;
  alerts: ScheduledAlert[];
}

const ALERTS_DIR = path.join(CONFIG_DIR, "calendar");
const ALERTS_PATH = path.join(ALERTS_DIR, "alerts.json");

const timers = new Map<string, NodeJS.Timeout>();
let alerts: ScheduledAlert[] = [];
let loaded = false;
let writePromise: Promise<void> = Promise.resolve();

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(ALERTS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AlertsFile>;
    alerts = Array.isArray(parsed?.alerts) ? parsed!.alerts!.filter(Boolean) : [];
  } catch {
    alerts = [];
  }
}

async function persist(): Promise<void> {
  // Serialize writes to avoid corruption.
  const next = writePromise
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(ALERTS_DIR, { recursive: true });
      const tmp = `${ALERTS_PATH}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
      const data: AlertsFile = { version: 1, alerts };
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmp, ALERTS_PATH);
    });
  writePromise = next;
  await next;
}

function generateId(): string {
  return `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pruneFired() {
  // Keep last 50 fired alerts for audit; drop the rest.
  const fired = alerts
    .filter((a) => a.firedAtMs)
    .sort((a, b) => (b.firedAtMs ?? 0) - (a.firedAtMs ?? 0));
  const keepFired = new Set(fired.slice(0, 50).map((a) => a.id));
  alerts = alerts.filter((a) => !a.firedAtMs || keepFired.has(a.id));
}

async function fire(alert: ScheduledAlert): Promise<void> {
  try {
    if (alert.channel === "telegram") {
      const target = alert.target || process.env.CALENDAR_TELEGRAM_CHAT_ID || "";
      if (!target)
        throw new Error("no telegram target (set target or CALENDAR_TELEGRAM_CHAT_ID env)");
      await sendMessageTelegram(target, alert.message);
    } else if (
      alert.channel === "notification" ||
      alert.channel === "email" ||
      alert.channel === "discord"
    ) {
      // Other channels handled elsewhere — alerts.ts only triggers Telegram for now.
      log.info(`alert ${alert.id}: ${alert.channel} delivery is a UI/client responsibility`);
    } else {
      throw new Error(`unsupported channel: ${alert.channel}`);
    }
    alert.firedAtMs = Date.now();
    alert.fireStatus = "ok";
  } catch (e) {
    alert.firedAtMs = Date.now();
    alert.fireStatus = "error";
    alert.fireError = e instanceof Error ? e.message : String(e);
    log.error(`alert ${alert.id} failed: ${alert.fireError}`);
  } finally {
    timers.delete(alert.id);
    pruneFired();
    await persist();
  }
}

function arm(alert: ScheduledAlert): void {
  if (alert.firedAtMs) return;
  if (timers.has(alert.id)) return;
  const delay = Math.max(0, alert.fireAtMs - Date.now());
  // Cap at a 24-hour window to limit per-process timer count; rearm on next init.
  const cap = 24 * 60 * 60 * 1000;
  const t = setTimeout(
    () => {
      void fire(alert);
    },
    Math.min(delay, cap),
  );
  timers.set(alert.id, t);
}

/** Initialize the scheduler — call once on gateway start. */
export async function initCalendarAlerts(): Promise<void> {
  await ensureLoaded();
  const now = Date.now();
  // Fire any past-due alerts immediately, arm the rest.
  for (const a of alerts) {
    if (a.firedAtMs) continue;
    if (a.fireAtMs <= now + 1_000) {
      void fire(a);
    } else {
      arm(a);
    }
  }
  log.info(
    `calendar alerts initialized: ${alerts.length} total, ${alerts.filter((a) => !a.firedAtMs).length} pending`,
  );
}

export async function scheduleAlert(input: {
  eventId: string;
  eventTitle: string;
  fireAtMs: number;
  channel: AlertChannel;
  target?: string;
  message: string;
}): Promise<ScheduledAlert> {
  await ensureLoaded();
  // De-dupe: cancel any existing pending alert for the same eventId+channel.
  for (const a of alerts) {
    if (!a.firedAtMs && a.eventId === input.eventId && a.channel === input.channel) {
      const t = timers.get(a.id);
      if (t) {
        clearTimeout(t);
        timers.delete(a.id);
      }
      a.firedAtMs = Date.now();
      a.fireStatus = "ok";
      a.fireError = "replaced by newer alert";
    }
  }
  const alert: ScheduledAlert = {
    id: generateId(),
    eventId: input.eventId,
    eventTitle: input.eventTitle,
    fireAtMs: input.fireAtMs,
    channel: input.channel,
    target: input.target,
    message: input.message,
    createdAtMs: Date.now(),
  };
  alerts.push(alert);
  await persist();
  arm(alert);
  return alert;
}

export async function cancelAlert(alertId: string): Promise<boolean> {
  await ensureLoaded();
  const a = alerts.find((x) => x.id === alertId);
  if (!a || a.firedAtMs) return false;
  const t = timers.get(alertId);
  if (t) {
    clearTimeout(t);
    timers.delete(alertId);
  }
  a.firedAtMs = Date.now();
  a.fireStatus = "ok";
  a.fireError = "cancelled";
  await persist();
  return true;
}

export async function cancelAlertsForEvent(eventId: string): Promise<number> {
  await ensureLoaded();
  let count = 0;
  for (const a of alerts) {
    if (a.firedAtMs) continue;
    if (a.eventId !== eventId) continue;
    const t = timers.get(a.id);
    if (t) {
      clearTimeout(t);
      timers.delete(a.id);
    }
    a.firedAtMs = Date.now();
    a.fireStatus = "ok";
    a.fireError = "cancelled (event)";
    count += 1;
  }
  if (count > 0) await persist();
  return count;
}

export async function listAlerts(filter?: {
  eventId?: string;
  pending?: boolean;
}): Promise<ScheduledAlert[]> {
  await ensureLoaded();
  let out = alerts.slice();
  if (filter?.eventId) out = out.filter((a) => a.eventId === filter.eventId);
  if (filter?.pending) out = out.filter((a) => !a.firedAtMs);
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

// ============================================================
// Proactive alert engine
//
// A periodic scan (default every 60s) that watches upcoming calendar
// events and project/phase deadlines, then fires deduped notifications to
// Telegram + the in-app notification surface. Distinct from the timer-based
// ScheduledAlert scheduler above: this one derives what to send from live
// calendar/kanban state rather than from pre-armed one-shot timers.
// ============================================================

/** Minutes-before stages for an upcoming meeting. Override via env (CSV). */
const MEETING_STAGES_MIN: number[] = parseCsvNumbers(
  process.env.CALENDAR_MEETING_ALERT_STAGES,
  [15, 1],
);
/** Hours-before stages for project / phase deadlines. */
const DEADLINE_STAGES_HOURS: number[] = parseCsvNumbers(
  process.env.CALENDAR_DEADLINE_ALERT_STAGES,
  [72, 24],
);
/** Local hour-of-day for the once-daily overdue digest. */
const OVERDUE_HOUR = Number(process.env.CALENDAR_OVERDUE_ALERT_HOUR ?? 9);

function parseCsvNumbers(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const out = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return out.length ? out : fallback;
}

// ── Dedup store: persist fired alert keys so we never re-spam ──────────
const SENT_PATH = path.join(ALERTS_DIR, "alerts-sent.json");
let sentKeys: Record<string, number> | null = null;
let sentWritePromise: Promise<void> = Promise.resolve();

async function loadSentKeys(): Promise<Record<string, number>> {
  if (sentKeys) return sentKeys;
  try {
    const raw = await fs.readFile(SENT_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    sentKeys = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    sentKeys = {};
  }
  return sentKeys!;
}

async function persistSentKeys(): Promise<void> {
  const keys = sentKeys ?? {};
  // Prune keys older than 30 days to bound file growth.
  const cutoff = Date.now() - 30 * 86400_000;
  for (const [k, ts] of Object.entries(keys)) {
    if (ts < cutoff) delete keys[k];
  }
  const next = sentWritePromise
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(ALERTS_DIR, { recursive: true });
      const tmp = `${SENT_PATH}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
      await fs.writeFile(tmp, JSON.stringify(keys), "utf-8");
      await fs.rename(tmp, SENT_PATH);
    });
  sentWritePromise = next;
  await next;
}

async function alreadySent(key: string): Promise<boolean> {
  const keys = await loadSentKeys();
  return key in keys;
}

async function markSent(key: string): Promise<void> {
  const keys = await loadSentKeys();
  keys[key] = Date.now();
  await persistSentKeys();
}

// ── Dispatch ───────────────────────────────────────────────────────────
function resolveTelegramTarget(): string | null {
  const fromEnv = process.env.CALENDAR_TELEGRAM_CHAT_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = loadConfig();
    const def = cfg.channels?.telegram?.defaultChatId?.trim();
    if (def) return def;
  } catch {
    /* config not loadable — fall through */
  }
  return null;
}

/** Send one alert to Telegram (if configured) + the in-app notification surface. */
async function dispatchAlert(opts: {
  title: string;
  body: string;
  category: NotificationCategory;
  severity?: NotificationSeverity;
  sourceId?: string;
}): Promise<void> {
  // 1. Telegram
  const target = resolveTelegramTarget();
  if (target) {
    try {
      await sendMessageTelegram(target, `📅 ${opts.title}\n${opts.body}`);
    } catch (e) {
      log.warn(`telegram dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    log.info(`telegram not configured — would have sent: ${opts.title} — ${opts.body}`);
  }

  // 2. In-app notification surface (persists + broadcasts to mobile/UI)
  try {
    await emitNotification({
      category: opts.category,
      severity: opts.severity ?? "info",
      title: opts.title,
      body: opts.body,
      source: "calendar",
      sourceId: opts.sourceId ?? null,
    });
  } catch (e) {
    log.warn(`ui notification dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Scan helpers ─────────────────────────────────────────────────────────
function startMsOf(e: { startIso?: string; startDate?: string }): number | null {
  const raw = e.startIso || e.startDate;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function dueMsOf(dueDate?: string): number | null {
  if (!dueDate) return null;
  const ms = new Date(dueDate).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

async function scanMeetings(now: number): Promise<void> {
  let events;
  try {
    const fromIso = new Date(now - 60_000).toISOString();
    const toIso = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    events = await listStoredEvents({ fromIso, toIso });
  } catch (e) {
    log.warn(`meeting scan: store read failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    const startMs = startMsOf(ev);
    if (startMs == null || startMs <= now) continue;
    const minutesUntil = (startMs - now) / 60_000;
    for (const stage of MEETING_STAGES_MIN) {
      if (minutesUntil > stage) continue;
      const key = `event:${ev.id}:${stage}`;
      if (await alreadySent(key)) continue;
      const when = new Date(startMs).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      await dispatchAlert({
        title: `Upcoming: ${ev.summary || "(no title)"}`,
        body: `Starts in ~${Math.max(0, Math.round(minutesUntil))} min (${when})${ev.location ? ` · ${ev.location}` : ""}`,
        category: "kanban.task.due",
        severity: stage <= 1 ? "warn" : "info",
        sourceId: ev.id,
      });
      await markSent(key);
    }
  }
}

async function scanDeadlines(now: number): Promise<void> {
  let store: ReturnType<typeof getKanbanStore>;
  try {
    store = getKanbanStore();
  } catch (e) {
    log.warn(
      `deadline scan skipped: kanban store unavailable (${e instanceof Error ? e.message : String(e)})`,
    );
    return;
  }

  let projects;
  try {
    projects = await store.getProjects();
  } catch (e) {
    log.warn(`deadline scan: getProjects failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const overdue: string[] = [];

  for (const p of projects) {
    const isDone = p.status === "Completed" || p.status === "Cancelled";
    const dueMs = dueMsOf(p.dueDate);
    if (dueMs != null && !isDone) {
      await stageDeadline(now, dueMs, {
        keyBase: `project:${p.id}`,
        label: `Project deadline: ${p.name}`,
        sourceId: p.id,
      });
      if (dueMs < now) overdue.push(`• Project "${p.name}" (due ${p.dueDate})`);
    }

    // Phases — prefer store.listPhases(projectId) once it lands, else the
    // phases already embedded on the project. Skip the branch on any error.
    try {
      let phases = p.phases;
      const maybeList = (store as any).listPhases;
      if (typeof maybeList === "function") {
        phases = await maybeList.call(store, p.id);
      }
      for (const ph of phases || []) {
        if (ph.status === "done" || ph.status === "skipped") continue;
        const phDue = dueMsOf(ph.dueDate);
        if (phDue == null) continue;
        await stageDeadline(now, phDue, {
          keyBase: `phase:${p.id}:${ph.id}`,
          label: `Phase deadline: ${ph.name} (${p.name})`,
          sourceId: ph.id,
        });
        if (phDue < now) overdue.push(`• Phase "${ph.name}" of "${p.name}" (due ${ph.dueDate})`);
      }
    } catch (e) {
      log.warn(
        `phase scan skipped for project ${p.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Overdue tasks
  try {
    const tasks = await store.getTasks();
    for (const t of tasks) {
      if (t.done || t.status === "done") continue;
      const dueMs = dueMsOf(t.dueDate);
      if (dueMs != null && dueMs < now) overdue.push(`• Task "${t.title}" (due ${t.dueDate})`);
    }
  } catch (e) {
    log.warn(`overdue task scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Once-daily overdue digest at the configured local hour.
  if (overdue.length && new Date(now).getHours() === OVERDUE_HOUR) {
    const dayKey = `overdue:${new Date(now).toISOString().slice(0, 10)}`;
    if (!(await alreadySent(dayKey))) {
      await dispatchAlert({
        title: `${overdue.length} overdue item${overdue.length === 1 ? "" : "s"}`,
        body: overdue.slice(0, 20).join("\n"),
        category: "kanban.task.due",
        severity: "warn",
      });
      await markSent(dayKey);
    }
  }
}

async function stageDeadline(
  now: number,
  dueMs: number,
  meta: { keyBase: string; label: string; sourceId?: string },
): Promise<void> {
  const hoursUntil = (dueMs - now) / 3_600_000;

  // Staged warnings (72h, 24h, ...): fire once the deadline is within the stage.
  for (const stage of DEADLINE_STAGES_HOURS) {
    if (hoursUntil > stage || hoursUntil < 0) continue;
    const key = `${meta.keyBase}:${stage}h`;
    if (await alreadySent(key)) continue;
    await dispatchAlert({
      title: meta.label,
      body: `Due in ~${Math.max(0, Math.round(hoursUntil))}h`,
      category: "kanban.task.due",
      severity: stage <= 24 ? "warn" : "info",
      sourceId: meta.sourceId,
    });
    await markSent(key);
  }

  // On-the-day notice (fires when due date is the current local day).
  if (isSameLocalDay(dueMs, now)) {
    const key = `${meta.keyBase}:dayof`;
    if (!(await alreadySent(key))) {
      await dispatchAlert({
        title: `${meta.label} — due today`,
        body: "This deadline is today.",
        category: "kanban.task.due",
        severity: "warn",
        sourceId: meta.sourceId,
      });
      await markSent(key);
    }
  }
}

/** Run one full proactive scan. Safe to call repeatedly / manually. */
export async function runAlertsScan(): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  try {
    await scanMeetings(now);
  } catch (e) {
    log.warn(`meeting scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await scanDeadlines(now);
  } catch (e) {
    log.warn(`deadline scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: true };
}

let runnerTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic proactive scan. Returns a stop function. Idempotent —
 * calling again while running is a no-op.
 */
export function startAlertsRunner(intervalMs: number = 60_000): () => void {
  if (runnerTimer) return () => stopAlertsRunner();
  // Kick once shortly after boot, then on the interval.
  const kick = setTimeout(() => {
    void runAlertsScan();
  }, 5_000);
  kick.unref?.();
  runnerTimer = setInterval(() => {
    void runAlertsScan();
  }, intervalMs);
  runnerTimer.unref?.();
  log.info(`calendar proactive alerts runner started (every ${Math.round(intervalMs / 1000)}s)`);
  return () => stopAlertsRunner();
}

export function stopAlertsRunner(): void {
  if (runnerTimer) {
    clearInterval(runnerTimer);
    runnerTimer = null;
  }
}
