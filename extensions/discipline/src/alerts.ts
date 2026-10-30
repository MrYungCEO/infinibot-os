/**
 * Discipline notification alerts — time-based emits for blocks, streaks, and
 * daily check-ins. One entry-point (`startDisciplineAlerts`) is called by the
 * plugin's service; it schedules all recurring checks internally and the
 * returned stop function clears every timer it armed (plugin off → silent).
 *
 * Deliberately decoupled from the discipline store write path — it only reads
 * data and calls emitNotification. This means it can never break a discipline
 * op even if the notification system is offline.
 */

import type { EmitNotificationOpts } from "../../../src/notifications/emit.js";
import { getDisciplineStore } from "./store.js";

export type AlertsDeps = {
  stateDir: () => string;
  emitNotification: (opts: EmitNotificationOpts) => Promise<unknown>;
  log: { info: (m: string) => void; warn: (m: string) => void };
};

let deps: AlertsDeps | null = null;
const log: AlertsDeps["log"] = {
  info: (m) => deps?.log.info(m),
  warn: (m) => deps?.log.warn(m),
};

async function emitNotification(opts: EmitNotificationOpts): Promise<void> {
  if (!deps) return; // stopped
  await deps.emitNotification(opts);
}

/** Every timer armed while running, so stop() leaves nothing behind. */
const _timers = new Set<ReturnType<typeof setTimeout>>();

function later(fn: () => void, delayMs: number): void {
  const t = setTimeout(() => {
    _timers.delete(t);
    fn();
  }, delayMs);
  t.unref?.();
  _timers.add(t);
}

// ── STREAK MILESTONES ────────────────────────────────────────────────────────
const STREAK_MILESTONES = [3, 7, 14, 30] as const;

// Per-session dedup: track which milestone / block-alert has already fired today.
const firedToday = new Set<string>();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function minutesSinceMidnight(now = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

function msUntilMinuteOfDay(target: number): number {
  const now = new Date();
  const nowMin = minutesSinceMidnight(now);
  let delta = (target - nowMin) * 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds();
  if (delta <= 0) delta += 24 * 60 * 60_000; // push to tomorrow if already past
  return delta;
}

// ── STREAK DETECTION ─────────────────────────────────────────────────────────

async function checkAndEmitStreaks(stateDir: string): Promise<void> {
  try {
    const store = getDisciplineStore(stateDir);
    const today = new Date();
    const blocks = store.getBlocks().filter((b) => b.enabled);
    if (blocks.length === 0) return;

    // Count consecutive days (starting from yesterday) that had ≥1 block completion.
    let streak = 0;
    for (let i = 1; i <= 31; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const completions = store.getBlockCompletions(iso);
      if (completions.length === 0) break;
      streak++;
    }

    for (const milestone of STREAK_MILESTONES) {
      const key = `streak:${milestone}:${todayIso()}`;
      if (streak >= milestone && !firedToday.has(key)) {
        firedToday.add(key);
        const period = milestone >= 14 ? "month" : "week";
        await emitNotification({
          category: "discipline.alert",
          severity: "success",
          title: `🔥 ${milestone}-day streak`,
          body: `You've hit ${milestone} days in a row — keep it going this ${period}`,
          source: "discipline",
          sourceId: `streak:${milestone}`,
          deepLink: "infinibot://discipline",
          data: { streakDays: milestone, eventKey: "streak_milestone" },
          stateDir,
        });
      }
    }
  } catch (err) {
    log.warn(`discipline alerts: streak check failed: ${String(err)}`);
  }
}

// ── MORNING CHECK-IN ─────────────────────────────────────────────────────────

async function checkMorningCheckIn(stateDir: string): Promise<void> {
  try {
    const key = `morning:${todayIso()}`;
    if (firedToday.has(key)) return;
    firedToday.add(key);

    const store = getDisciplineStore(stateDir);
    const dow = new Date().getDay();
    const blocks = store.getBlocks().filter((b) => b.enabled && (b.days ?? []).includes(dow));
    if (blocks.length === 0) return; // no blocks today — no morning check needed

    // Check if any block has been completed today already
    const completions = store.getBlockCompletions(todayIso());
    if (completions.length > 0) return; // already active

    await emitNotification({
      category: "discipline.alert",
      severity: "warn",
      title: "🌅 Morning check-in",
      body: "Tap Start Day to log your routine",
      source: "discipline",
      sourceId: `morning:${todayIso()}`,
      deepLink: "infinibot://discipline",
      data: { eventKey: "morning_checkin" },
      stateDir,
    });
  } catch (err) {
    log.warn(`discipline alerts: morning check-in failed: ${String(err)}`);
  }
}

// ── EVENING WRAP ─────────────────────────────────────────────────────────────

async function emitEveningWrap(stateDir: string): Promise<void> {
  try {
    const key = `evening:${todayIso()}`;
    if (firedToday.has(key)) return;
    firedToday.add(key);

    await emitNotification({
      category: "discipline.alert",
      severity: "info",
      title: "🌙 Closing time",
      body: "Wrap up the day — tap End Day to review wins",
      source: "discipline",
      sourceId: `evening:${todayIso()}`,
      deepLink: "infinibot://discipline",
      data: { eventKey: "evening_wrap" },
      stateDir,
    });
  } catch (err) {
    log.warn(`discipline alerts: evening wrap emit failed: ${String(err)}`);
  }
}

// ── BLOCK START WARNINGS ─────────────────────────────────────────────────────

/** Schedule a single block's "starting soon" and "at start" notifications. */
function scheduleBlockAlerts(
  block: { id: string; label: string; startMinute: number; endMinute: number; intent?: string },
  stateDir: string,
): void {
  const nowMin = minutesSinceMidnight();
  const durationMin = block.endMinute - block.startMinute;

  // "In 3 min" warning
  const warnMin = block.startMinute - 3;
  if (warnMin > nowMin) {
    const delayMs = (warnMin - nowMin) * 60_000;
    later(() => {
      const key = `block_warn:${block.id}:${todayIso()}`;
      if (firedToday.has(key)) return;
      firedToday.add(key);
      void emitNotification({
        category: "discipline.alert",
        severity: "info",
        title: `⏱ ${block.label} in 3 min`,
        body: `${durationMin} min${block.intent ? ` • ${block.intent}` : ""}`,
        source: "discipline",
        sourceId: `block_warn:${block.id}`,
        deepLink: "infinibot://discipline",
        data: { blockId: block.id, eventKey: "block_starting_soon" },
        stateDir,
      });
    }, delayMs);
  }

  // At-start notification
  if (block.startMinute > nowMin) {
    const delayMs = (block.startMinute - nowMin) * 60_000;
    later(() => {
      const key = `block_start:${block.id}:${todayIso()}`;
      if (firedToday.has(key)) return;
      firedToday.add(key);
      void emitNotification({
        category: "discipline.alert",
        severity: "info",
        title: `⏱ ${block.label} starting now`,
        body: `${durationMin} min${block.intent ? ` • ${block.intent}` : ""}`,
        source: "discipline",
        sourceId: `block_start:${block.id}`,
        deepLink: "infinibot://discipline",
        data: { blockId: block.id, eventKey: "block_start" },
        stateDir,
      });
    }, delayMs);
  }

  // "Missed" check — 10 min after start, if not completed
  const missedMin = block.startMinute + 10;
  if (missedMin > nowMin) {
    const delayMs = (missedMin - nowMin) * 60_000;
    later(() => {
      void checkBlockMissed(block, stateDir);
    }, delayMs);
  }
}

async function checkBlockMissed(
  block: { id: string; label: string },
  stateDir: string,
): Promise<void> {
  try {
    const key = `block_missed:${block.id}:${todayIso()}`;
    if (firedToday.has(key)) return;

    const store = getDisciplineStore(stateDir);
    const completions = store.getBlockCompletions(todayIso());
    if (completions.some((c) => c.blockId === block.id)) return; // already completed

    firedToday.add(key);
    await emitNotification({
      category: "discipline.alert",
      severity: "warn",
      title: `⚠️ ${block.label} was missed`,
      body: "Tap to mark complete or reschedule",
      source: "discipline",
      sourceId: `block_missed:${block.id}`,
      deepLink: "infinibot://discipline",
      data: { blockId: block.id, eventKey: "block_missed" },
      stateDir,
    });
  } catch (err) {
    log.warn(`discipline alerts: block ${block.id} missed check failed: ${String(err)}`);
  }
}

// ── DAILY SCHEDULE LOADER ────────────────────────────────────────────────────

async function loadAndScheduleDay(stateDir: string): Promise<void> {
  try {
    const store = getDisciplineStore(stateDir);
    const dow = new Date().getDay();
    const todayStr = todayIso();
    const blocks = store
      .getBlocks()
      .filter((b) => {
        if (!b.enabled) return false;
        if (b.oneOffDate) return b.oneOffDate === todayStr;
        return (b.days ?? []).includes(dow);
      })
      .sort((a, b) => a.startMinute - b.startMinute);

    for (const block of blocks) {
      scheduleBlockAlerts(block, stateDir);
    }

    // Reset daily dedup cache at midnight
    log.info(`discipline alerts: scheduled ${blocks.length} block(s) for ${todayStr}`);
  } catch (err) {
    log.warn(`discipline alerts: loadAndScheduleDay failed: ${String(err)}`);
  }
}

// ── PUBLIC ENTRY POINT ───────────────────────────────────────────────────────

let _started = false;

export function startDisciplineAlerts(next: AlertsDeps): () => void {
  if (_started) return stopDisciplineAlerts;
  _started = true;
  deps = next;
  const stateDir = () => next.stateDir();

  // Once-per-day recurring check at a local minute-of-day.
  function scheduleDaily(targetMinute: number, fn: () => void): void {
    const run = () => {
      fn();
      later(run, msUntilMinuteOfDay(targetMinute));
    };
    later(run, msUntilMinuteOfDay(targetMinute));
  }

  // 09:30 — morning check-in
  scheduleDaily(9 * 60 + 30, () => {
    firedToday.clear(); // New day — clear dedup cache
    void loadAndScheduleDay(stateDir());
    void checkMorningCheckIn(stateDir());
    void checkAndEmitStreaks(stateDir());
  });

  // 21:00 — evening wrap
  scheduleDaily(21 * 60, () => void emitEveningWrap(stateDir()));

  // On startup: if it's already past 09:30 but before midnight, schedule the
  // remaining blocks for today (e.g. gateway restarted mid-day).
  const nowMin = minutesSinceMidnight();
  if (nowMin >= 9 * 60 + 30) {
    void loadAndScheduleDay(stateDir());
    void checkAndEmitStreaks(stateDir());
  }

  log.info("discipline alerts started");
  return stopDisciplineAlerts;
}

export function stopDisciplineAlerts(): void {
  _started = false;
  for (const t of _timers) clearTimeout(t);
  _timers.clear();
  deps = null;
}

/** Test hook: timers currently armed. */
export function pendingAlertTimers(): number {
  return _timers.size;
}
