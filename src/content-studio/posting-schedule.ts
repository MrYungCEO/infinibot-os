/**
 * Content Studio posting schedule — pure slot math for the per-page video
 * posting queue (no I/O, no clock; callers pass `now`).
 *
 * A page posts either every N minutes (`mode: "interval"`) or X times a day
 * spread evenly across its posting window (`mode: "daily"`). Every slot:
 *   - lands inside the page's daily window (e.g. 09:00–21:00) in the page's
 *     IANA timezone (windows may wrap midnight, e.g. 22:00–02:00);
 *   - is at least the effective minimum interval after the last post;
 *   - respects the daily cap (posts per local day, counted in the page tz);
 *   - gets a deterministic jitter of ±jitterMinutes (seeded by the queue
 *     entry id, so a recomputed slot does not wander), clamped so it never
 *     breaks the window or the minimum interval.
 *
 * Platform safety: live posting is floored at LIVE_MIN_INTERVAL_MINUTES and
 * capped at LIVE_MAX_POSTS_PER_DAY no matter what the page asks for. Dry-run
 * pages (nothing is ever published) may go down to DRY_RUN_MIN_INTERVAL so
 * the full flow can be exercised end to end in minutes.
 */

export type PostingMode = "interval" | "daily";

export type PostingSchedule = {
  mode: PostingMode;
  /** interval mode: minutes between posts. */
  everyMinutes: number;
  /** daily mode: posts per day inside the window (also the daily cap). */
  postsPerDay: number;
  /** "HH:MM" local time the window opens. */
  windowStart: string;
  /** "HH:MM" local time the window closes. Equal to start = all day. */
  windowEnd: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** ± minutes of random spread around each slot. */
  jitterMinutes: number;
  /** Hard cap on posts per local day (both modes). */
  dailyCap: number;
};

export const LIVE_MIN_INTERVAL_MINUTES = 30;
export const LIVE_MAX_POSTS_PER_DAY = 10;
export const DRY_RUN_MIN_INTERVAL_MINUTES = 1;
export const DRY_RUN_MAX_POSTS_PER_DAY = 200;
export const MAX_JITTER_MINUTES = 120;

export const DEFAULT_SCHEDULE: PostingSchedule = {
  mode: "daily",
  everyMinutes: 240,
  postsPerDay: 2,
  windowStart: "09:00",
  windowEnd: "21:00",
  timezone: "UTC",
  jitterMinutes: 15,
  dailyCap: 3,
};

const MIN = 60_000;
const DAY = 86_400_000;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "9:5" / "09:05" → minutes after midnight, or null. */
export function parseHm(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}

export function formatHm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** Limits that apply to a page given whether it publishes for real. */
export function scheduleLimits(dryRun: boolean): { minInterval: number; maxPerDay: number } {
  return dryRun
    ? { minInterval: DRY_RUN_MIN_INTERVAL_MINUTES, maxPerDay: DRY_RUN_MAX_POSTS_PER_DAY }
    : { minInterval: LIVE_MIN_INTERVAL_MINUTES, maxPerDay: LIVE_MAX_POSTS_PER_DAY };
}

/**
 * Normalizes untrusted input (RPC / agent tool) onto a valid schedule,
 * applying the platform floor/cap for live pages.
 */
export function normalizeSchedule(
  input: Partial<Record<keyof PostingSchedule, unknown>> | undefined,
  base: PostingSchedule = DEFAULT_SCHEDULE,
  dryRun = false,
): PostingSchedule {
  const raw = input ?? {};
  const limits = scheduleLimits(dryRun);
  const mode: PostingMode = raw.mode === "interval" || raw.mode === "daily" ? raw.mode : base.mode;
  const tz =
    typeof raw.timezone === "string" && raw.timezone.trim() && isValidTimezone(raw.timezone.trim())
      ? raw.timezone.trim()
      : isValidTimezone(base.timezone)
        ? base.timezone
        : "UTC";
  const ws = parseHm(raw.windowStart) ?? parseHm(base.windowStart) ?? 9 * 60;
  const we = parseHm(raw.windowEnd) ?? parseHm(base.windowEnd) ?? 21 * 60;
  const postsPerDay = clampInt(raw.postsPerDay ?? base.postsPerDay, 1, limits.maxPerDay, 1);
  const dailyCap = clampInt(
    raw.dailyCap ?? (raw.postsPerDay !== undefined ? postsPerDay : base.dailyCap),
    1,
    limits.maxPerDay,
    Math.min(limits.maxPerDay, Math.max(postsPerDay, base.dailyCap)),
  );
  return {
    mode,
    everyMinutes: clampInt(
      raw.everyMinutes ?? base.everyMinutes,
      limits.minInterval,
      7 * 1440,
      240,
    ),
    postsPerDay,
    windowStart: formatHm(ws),
    windowEnd: formatHm(we),
    timezone: tz,
    jitterMinutes: clampInt(raw.jitterMinutes ?? base.jitterMinutes, 0, MAX_JITTER_MINUTES, 0),
    dailyCap: Math.max(dailyCap, mode === "daily" ? postsPerDay : 1),
  };
}

// ── Timezone helpers (Intl only, no deps) ─────────────────────────────────

type Parts = { y: number; mo: number; d: number; h: number; mi: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(ms: number, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year!, mo: out.month!, d: out.day!, h: out.hour! % 24, mi: out.minute! };
}

/** Offset (local − UTC) in ms for `tz` at instant `ms`. */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  return asUtc - Math.floor(ms / MIN) * MIN;
}

/** UTC instant for a local wall time in `tz` (DST gaps resolve forward). */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  minuteOfDay: number,
  tz: string,
): number {
  const guess = Date.UTC(y, mo - 1, d) + minuteOfDay * MIN;
  let ms = guess - offsetAt(guess, tz);
  // A second pass settles instants that straddle a DST change.
  ms = guess - offsetAt(ms, tz);
  return ms;
}

/** Local calendar day key "YYYY-MM-DD" of an instant in `tz`. */
export function localDayKey(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function minuteOfDay(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return p.h * 60 + p.mi;
}

/** Midnight (local) of the day containing `ms`, as a UTC instant. */
function localMidnight(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return zonedToUtc(p.y, p.mo, p.d, 0, tz);
}

function addLocalDays(ms: number, days: number, tz: string): number {
  // Step via noon so DST shifts never skip/duplicate a day.
  const p = zonedParts(ms, tz);
  const noon = zonedToUtc(p.y, p.mo, p.d, 12 * 60, tz) + days * DAY;
  const q = zonedParts(noon, tz);
  return zonedToUtc(q.y, q.mo, q.d, 0, tz);
}

// ── Windows ───────────────────────────────────────────────────────────────

/** Window length in minutes (start == end → 24h). */
export function windowMinutes(s: PostingSchedule): number {
  const a = parseHm(s.windowStart) ?? 0;
  const b = parseHm(s.windowEnd) ?? 0;
  if (a === b) return 1440;
  return b > a ? b - a : 1440 - a + b;
}

/** True when the local time of `ms` is inside the page window. */
export function inWindow(ms: number, s: PostingSchedule): boolean {
  const a = parseHm(s.windowStart) ?? 0;
  const b = parseHm(s.windowEnd) ?? 0;
  if (a === b) return true;
  const m = minuteOfDay(ms, s.timezone);
  return b > a ? m >= a && m < b : m >= a || m < b;
}

/** The window (open, close) instants that contain or follow `ms`. */
export function windowAtOrAfter(ms: number, s: PostingSchedule): { open: number; close: number } {
  const a = parseHm(s.windowStart) ?? 0;
  const len = windowMinutes(s);
  // Check yesterday's window too (a wrapping window opened yesterday may still be open).
  for (let day = -1; day < 3; day++) {
    const mid = addLocalDays(localMidnight(ms, s.timezone), day, s.timezone);
    const p = zonedParts(mid, s.timezone);
    const open = zonedToUtc(p.y, p.mo, p.d, a, s.timezone);
    const close = open + len * MIN;
    if (close > ms) return { open, close };
  }
  const open = addLocalDays(ms, 1, s.timezone);
  return { open, close: open + len * MIN };
}

/** Effective spacing between posts (minutes), never below the floor. */
export function effectiveIntervalMinutes(s: PostingSchedule, dryRun = false): number {
  const floor = scheduleLimits(dryRun).minInterval;
  const want =
    s.mode === "interval"
      ? s.everyMinutes
      : Math.floor(windowMinutes(s) / Math.max(1, s.postsPerDay));
  return Math.max(floor, want);
}

export function effectiveDailyCap(s: PostingSchedule, dryRun = false): number {
  const cap = s.mode === "daily" ? Math.min(s.dailyCap, s.postsPerDay) : s.dailyCap;
  return Math.max(1, Math.min(cap, scheduleLimits(dryRun).maxPerDay));
}

// ── Jitter ────────────────────────────────────────────────────────────────

/** Deterministic value in [-1, 1] from a string seed (FNV-1a). */
export function seededUnit(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

// ── Slot computation ──────────────────────────────────────────────────────

export type SlotInput = {
  schedule: PostingSchedule;
  dryRun?: boolean;
  now: number;
  /** Instant of the most recent post (posted or attempted-post) for the page. */
  lastPostAt: number | null;
  /** Instants of posts already made (used for the daily cap). */
  postedAts: number[];
  /** Seed for jitter (queue entry id). */
  seed: string;
};

export type Slot = { at: number; reason: string };

function postsOnDay(postedAts: number[], ms: number, tz: string): number {
  const key = localDayKey(ms, tz);
  return postedAts.filter((t) => localDayKey(t, tz) === key).length;
}

/**
 * Next posting instant for the page. Returns the earliest instant ≥ now that
 * satisfies window, min interval and daily cap, with jitter applied inside
 * the allowed range.
 */
export function nextSlot(input: SlotInput): Slot {
  const { schedule: s, now, postedAts } = input;
  const dryRun = input.dryRun === true;
  const interval = effectiveIntervalMinutes(s, dryRun) * MIN;
  const cap = effectiveDailyCap(s, dryRun);
  const jitter = Math.min(s.jitterMinutes, Math.floor(interval / MIN / 2)) * MIN;
  const earliest = input.lastPostAt !== null ? Math.max(now, input.lastPostAt + interval) : now;
  let t = earliest;
  let reason = input.lastPostAt !== null && earliest > now ? "min-interval" : "next-open";
  for (let guard = 0; guard < 400; guard++) {
    const w = windowAtOrAfter(t, s);
    if (t < w.open) {
      t = w.open;
      reason = "window-open";
    }
    if (postsOnDay(postedAts, t, s.timezone) >= cap) {
      // Day is full → first window opening on the next local day.
      const nextDay = addLocalDays(t, 1, s.timezone);
      t = Math.max(nextDay, earliest);
      reason = "daily-cap";
      continue;
    }
    if (t >= w.close) continue;
    // In daily mode, slots align to the window grid so posts spread evenly.
    if (s.mode === "daily") {
      const k = Math.ceil((t - w.open) / interval);
      const aligned = w.open + Math.max(0, k) * interval;
      if (aligned >= w.close) {
        t = w.close;
        continue;
      }
      if (aligned > t) reason = reason === "next-open" ? "grid" : reason;
      t = aligned;
    }
    // Jitter, clamped to [max(earliest, open), close - 1min].
    const lo = Math.max(earliest, w.open);
    const hi = w.close - MIN;
    const jittered = t + Math.round((seededUnit(input.seed) * jitter) / MIN) * MIN;
    const at = Math.min(hi, Math.max(lo, jittered));
    return { at, reason };
  }
  return { at: earliest, reason: "fallback" };
}

/**
 * The next `count` slots for a queue (head first), assuming each slot is
 * used. Drives the "upcoming schedule" preview.
 */
export function upcomingSlots(
  input: Omit<SlotInput, "seed">,
  seeds: string[],
): Array<{ seed: string; at: number; reason: string }> {
  const out: Array<{ seed: string; at: number; reason: string }> = [];
  let last = input.lastPostAt;
  const posted = [...input.postedAts];
  let now = input.now;
  for (const seed of seeds) {
    const slot = nextSlot({ ...input, now, lastPostAt: last, postedAts: posted, seed });
    out.push({ seed, at: slot.at, reason: slot.reason });
    last = slot.at;
    posted.push(slot.at);
    now = slot.at;
  }
  return out;
}

/**
 * Hard pre-post check, run again right before handing off to the device:
 * a slot computed earlier may be stale (another post happened, config
 * changed). Returns null when posting now is allowed, or the blocking reason.
 */
export function postBlockReason(input: Omit<SlotInput, "seed">): string | null {
  const { schedule: s, now, postedAts } = input;
  const dryRun = input.dryRun === true;
  const interval = effectiveIntervalMinutes(s, dryRun) * MIN;
  if (input.lastPostAt !== null && now - input.lastPostAt < interval - 1000) {
    return `min interval: last post ${Math.round((now - input.lastPostAt) / MIN)}m ago (< ${interval / MIN}m)`;
  }
  if (!inWindow(now, s))
    return `outside posting window ${s.windowStart}–${s.windowEnd} ${s.timezone}`;
  const cap = effectiveDailyCap(s, dryRun);
  if (postsOnDay(postedAts, now, s.timezone) >= cap) return `daily cap reached (${cap}/day)`;
  return null;
}

// ── Designated (owner-chosen) times ───────────────────────────────────────

/** A designated slot more than this late is flagged "late" (catch-up). */
export const LATE_GRACE_MS = 2 * MIN;

export type DesignatedSlot = Slot & {
  /** ms between the designated time and `at` (0 when on time). */
  lateByMs: number;
};

/**
 * Slot for an entry with an owner-chosen time. The time itself is honoured
 * exactly — no window, grid or jitter — and only the hard safety limits can
 * push it: the minimum interval after the last post and the daily cap. A
 * time already in the past (gateway down, phone offline) is a catch-up: it
 * posts now and reports how late it is.
 *
 * Reasons: "designated" (on time) · "catch-up" (past, posting now) ·
 * "min-interval" / "daily-cap" (pushed by a safety limit).
 */
export function designatedSlot(
  input: Omit<SlotInput, "seed"> & { designatedAt: number },
): DesignatedSlot {
  const { schedule: s, now } = input;
  const dryRun = input.dryRun === true;
  const target = Math.max(now, input.designatedAt);
  // The page's own limits, but on an all-day window with no jitter.
  const flat: PostingSchedule = {
    ...s,
    mode: "interval",
    everyMinutes: effectiveIntervalMinutes(s, dryRun),
    windowStart: "00:00",
    windowEnd: "00:00",
    jitterMinutes: 0,
    dailyCap: effectiveDailyCap(s, dryRun),
  };
  const slot = nextSlot({ ...input, schedule: flat, now: target, seed: "designated" });
  const lateByMs = Math.max(0, slot.at - input.designatedAt);
  if (slot.at <= target) {
    return {
      at: slot.at,
      reason: input.designatedAt < now - LATE_GRACE_MS ? "catch-up" : "designated",
      lateByMs,
    };
  }
  return {
    at: slot.at,
    reason: slot.reason === "fallback" ? "min-interval" : slot.reason,
    lateByMs,
  };
}

/** Hard pre-post check for a designated entry (no window: the owner chose the time). */
export function designatedBlockReason(input: Omit<SlotInput, "seed">): string | null {
  return postBlockReason({
    ...input,
    schedule: { ...input.schedule, windowStart: "00:00", windowEnd: "00:00" },
  });
}
