/**
 * Spoken-date parsing for quick capture — deterministic, no I/O, timezone-aware.
 *
 * "by Friday", "next Tuesday at 3", "in two weeks", "end of month",
 * "tomorrow morning", "the 17th", "Oct 17 at 3:30pm", "17/10" → a calendar
 * date (YYYY-MM-DD) in the owner's timezone, an optional wall-clock time
 * (HH:mm) when one was said, and the exact phrase it came from.
 *
 * Used two ways by capture.structure:
 *   1. the fallback when no model answers (heuristic draft), and
 *   2. the guard over the model's date: when the model quotes a phrase this
 *      parser understands, the parser's answer wins (models get weekday
 *      arithmetic wrong); a model date with no phrase in the transcript is
 *      dropped as invented.
 *
 * All arithmetic is on civil dates (UTC-based Date objects used as plain
 * Y/M/D containers), so the host timezone never leaks in: "today" is today
 * in `timeZone`, not on the gateway's clock.
 */

export type SpokenDate = {
  /** YYYY-MM-DD in the owner's timezone. */
  date: string;
  /** HH:mm (24 h) when a time was said. */
  time?: string;
  /** The words it came from, as spoken ("by Friday at 3"). */
  phrase: string;
  /** Character range of `phrase` in the input. */
  start: number;
  end: number;
};

export type ParseDateOptions = {
  now?: Date;
  /** IANA zone ("Asia/Bangkok"); defaults to the host zone. */
  timeZone?: string;
  /** Accept dates before today ("yesterday", "last Friday") — logs. */
  allowPast?: boolean;
  /** Only accept a date when the text has a scheduling cue ("by", "review", "remind me"…). */
  requireCue?: boolean;
};

export type WallClock = {
  y: number;
  m: number; // 1-12
  d: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
// Full names plus unambiguous short forms ("sat", "sun", "wed" are ordinary words).
const WEEKDAY_RE = "(sunday|monday|tues(?:day)?|wednesday|weds|thurs(?:day)?|friday|saturday)";

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  couple: 2,
  "a couple": 2,
  "a couple of": 2,
  three: 3,
  few: 3,
  "a few": 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
};
const NUM_RE =
  "(\\d{1,3}|a couple(?: of)?|a few|couple|few|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty)";

function toNumber(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  return NUMBER_WORDS[s] ?? null;
}

// ── timezone + civil-date helpers ─────────────────────────────────────────────

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The wall clock in `timeZone` at instant `now`. */
export function wallClock(now: Date, timeZone?: string): WallClock {
  const tz = isValidTimeZone(timeZone) ? timeZone : hostTimeZone();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  return {
    y,
    m,
    d,
    hour: get("hour") % 24,
    minute: get("minute"),
    weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
  };
}

type Civil = Date; // UTC midnight of a calendar day

const civil = (y: number, m: number, d: number): Civil => new Date(Date.UTC(y, m - 1, d));
const addDays = (c: Civil, n: number): Civil => new Date(c.getTime() + n * 86_400_000);
const dow = (c: Civil) => c.getUTCDay();

function addMonths(c: Civil, n: number): Civil {
  const y = c.getUTCFullYear();
  const m = c.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(c.getUTCDate(), last)));
}

function endOfMonth(c: Civil, plus = 0): Civil {
  return new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1 + plus, 0));
}

export function ymdOf(c: Civil): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${c.getUTCFullYear()}-${p(c.getUTCMonth() + 1)}-${p(c.getUTCDate())}`;
}

/** A real calendar date "YYYY-MM-DD" (rejects 2026-02-30). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const c = civil(y, m, d);
  return c.getUTCFullYear() === y && c.getUTCMonth() === m - 1 && c.getUTCDate() === d;
}

/** "HH:mm" 24 h. */
export function isHm(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function monthIndex(raw: string): number {
  return [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(raw.toLowerCase().slice(0, 3));
}

function weekdayIndex(raw: string): number {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(raw.toLowerCase().slice(0, 3));
}

/** Next date with day-of-month `day` on or after today (this month, else the next one that has it). */
function nextDayOfMonth(today: Civil, day: number): Civil | null {
  if (day < 1 || day > 31) return null;
  for (let k = 0; k < 13; k += 1) {
    const base = addMonths(civil(today.getUTCFullYear(), today.getUTCMonth() + 1, 1), k);
    const c = civil(base.getUTCFullYear(), base.getUTCMonth() + 1, day);
    if (c.getUTCDate() !== day) continue; // e.g. the 31st in a 30-day month
    if (c.getTime() >= today.getTime()) return c;
  }
  return null;
}

/** Month + day: this year, or next year when it has passed (unless a year was said / past allowed). */
function monthDay(
  today: Civil,
  month: number,
  day: number,
  year: number | undefined,
  allowPast: boolean,
): Civil | null {
  if (month < 0 || day < 1 || day > 31) return null;
  const y = year ?? today.getUTCFullYear();
  const c = civil(y, month + 1, day);
  if (c.getUTCDate() !== day) return null;
  if (year === undefined && !allowPast && c.getTime() < today.getTime())
    return civil(y + 1, month + 1, day);
  return c;
}

// ── patterns ──────────────────────────────────────────────────────────────────

type Ctx = { today: Civil; wall: WallClock; allowPast: boolean };
type Hit = { date: Civil; time?: string };
type Rule = { re: RegExp; at: (m: RegExpExecArray, ctx: Ctx) => Hit | null };

/** Deadline-ish lead words, eaten with the phrase so "ship it by Friday" → "ship it". */
const LEAD = "(?:(?:due|by|before|until|till|on|for|from|starting|no later than)\\s+)?";

const RULES: Rule[] = [
  {
    re: new RegExp(`\\b${LEAD}(?:the\\s+)?day\\s+after\\s+tomorrow\\b`, "i"),
    at: (_m, { today }) => ({ date: addDays(today, 2) }),
  },
  {
    re: new RegExp(`\\b${LEAD}(?:the\\s+)?day\\s+before\\s+yesterday\\b`, "i"),
    at: (_m, { today }) => ({ date: addDays(today, -2) }),
  },
  {
    re: new RegExp(
      `\\b${LEAD}(today|tonight|this\\s+(?:morning|afternoon|evening)|end\\s+of\\s+(?:the\\s+)?day|eod)\\b`,
      "i",
    ),
    at: (m, { today }) => {
      const w = m[1].toLowerCase();
      const time = /tonight|evening/.test(w)
        ? "19:00"
        : /afternoon/.test(w)
          ? "14:00"
          : /morning/.test(w)
            ? "09:00"
            : /end|eod/.test(w)
              ? "17:00"
              : undefined;
      return { date: today, ...(time ? { time } : {}) };
    },
  },
  {
    re: new RegExp(
      `\\b${LEAD}(?:tomorrow|tmrw|tmr)(?:\\s+(morning|afternoon|evening|night))?\\b`,
      "i",
    ),
    at: (m, { today }) => {
      const part = m[1]?.toLowerCase();
      const time =
        part === "morning"
          ? "09:00"
          : part === "afternoon"
            ? "14:00"
            : part === "evening" || part === "night"
              ? "19:00"
              : undefined;
      return { date: addDays(today, 1), ...(time ? { time } : {}) };
    },
  },
  { re: /\byesterday\b/i, at: (_m, { today }) => ({ date: addDays(today, -1) }) },
  {
    // "in 2 weeks", "within three days", "2 days from now", "in a fortnight"
    re: new RegExp(
      `\\b(?:(?:in|within|after)\\s+${NUM_RE}\\s+(day|week|month|year)s?(?:\\s+(?:from\\s+(?:now|today)|time))?|${NUM_RE}\\s+(day|week|month)s?\\s+from\\s+(?:now|today))\\b`,
      "i",
    ),
    at: (m, { today }) => {
      const n = toNumber(m[1] ?? m[3] ?? "");
      const unit = (m[2] ?? m[4] ?? "").toLowerCase();
      if (!n || n > 400) return null;
      if (unit === "day") return { date: addDays(today, n) };
      if (unit === "week") return { date: addDays(today, 7 * n) };
      if (unit === "month") return { date: addMonths(today, n) };
      return { date: addMonths(today, 12 * n) };
    },
  },
  {
    re: /\b(?:in|within)\s+a\s+fortnight\b/i,
    at: (_m, { today }) => ({ date: addDays(today, 14) }),
  },
  {
    // "in 2 hours", "in 30 minutes"
    re: new RegExp(`\\b(?:in|within)\\s+${NUM_RE}\\s+(hour|hr|minute|min)s?\\b`, "i"),
    at: (m, { today, wall }) => {
      const n = toNumber(m[1]);
      if (!n || n > 72 * 60) return null;
      const mins = /^h/i.test(m[2]) ? n * 60 : n;
      const total = wall.hour * 60 + wall.minute + mins;
      const days = Math.floor(total / 1440);
      const rem = total % 1440;
      const p = (x: number) => String(x).padStart(2, "0");
      return {
        date: addDays(today, days),
        time: `${p(Math.floor(rem / 60))}:${p(rem % 60)}`,
      };
    },
  },
  {
    re: new RegExp(
      `\\b${LEAD}(?:the\\s+)?(?:end\\s+of\\s+(?:the\\s+|this\\s+)?(next\\s+)?month|month[-\\s]end)\\b`,
      "i",
    ),
    at: (m, { today }) => ({ date: endOfMonth(today, m[1] ? 1 : 0) }),
  },
  {
    re: new RegExp(`\\b${LEAD}(?:the\\s+)?end\\s+of\\s+(?:the\\s+|this\\s+)?year\\b`, "i"),
    at: (_m, { today }) => ({ date: civil(today.getUTCFullYear(), 12, 31) }),
  },
  {
    re: new RegExp(
      `\\b${LEAD}(?:the\\s+)?(?:start|beginning)\\s+of\\s+(?:the\\s+)?next\\s+month\\b|\\b${LEAD}next\\s+month\\b`,
      "i",
    ),
    at: (_m, { today }) => ({
      date: civil(today.getUTCFullYear(), today.getUTCMonth() + 2, 1),
    }),
  },
  {
    re: new RegExp(
      `\\b${LEAD}(?:the\\s+)?end\\s+of\\s+(?:the\\s+|this\\s+)?(next\\s+)?week\\b`,
      "i",
    ),
    at: (m, { today }) => {
      const fri = addDays(today, (5 - dow(today) + 7) % 7);
      return { date: m[1] ? addDays(fri, 7) : fri };
    },
  },
  {
    re: new RegExp(`\\b${LEAD}(this|next|the)?\\s*weekend\\b`, "i"),
    at: (m, { today }) => {
      const d = dow(today);
      const sat = d === 0 ? addDays(today, -1) : addDays(today, (6 - d + 7) % 7);
      const base = d === 0 ? today : sat;
      return { date: m[1]?.toLowerCase() === "next" ? addDays(sat, 7) : base };
    },
  },
  {
    // "next week" → Monday of next week; "this week" is too vague to date.
    re: new RegExp(`\\b${LEAD}(?:the\\s+)?(?:next|following)\\s+week\\b`, "i"),
    at: (_m, { today }) => ({ date: addDays(today, (8 - dow(today)) % 7 || 7) }),
  },
  {
    // "last Friday" (logs)
    re: new RegExp(`\\b(?:last|past)\\s+${WEEKDAY_RE}\\b`, "i"),
    at: (m, { today }) => {
      const target = weekdayIndex(m[1]);
      const diff = (dow(today) - target + 7) % 7 || 7;
      return { date: addDays(today, -diff) };
    },
  },
  {
    // "Friday", "by Friday", "this Friday", "next Tuesday" (= Tuesday of next week)
    re: new RegExp(
      `\\b${LEAD}(this\\s+|next\\s+|coming\\s+|this\\s+coming\\s+)?${WEEKDAY_RE}\\b`,
      "i",
    ),
    at: (m, { today }) => {
      const target = weekdayIndex(m[2]);
      if (target < 0) return null;
      const cur = dow(today);
      if (/next/i.test(m[1] ?? "")) {
        // The named day in the following Monday-based week.
        const nextMonday = addDays(today, (8 - cur) % 7 || 7);
        return { date: addDays(nextMonday, (target + 6) % 7) };
      }
      return { date: addDays(today, (target - cur + 7) % 7 || 7) };
    },
  },
  {
    // "Oct 17", "October 17th, 2027", "on Oct. 17"
    re: new RegExp(
      `\\b${LEAD}${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`,
      "i",
    ),
    at: (m, { today, allowPast }) => {
      const c = monthDay(
        today,
        monthIndex(m[1]),
        Number(m[2]),
        m[3] ? Number(m[3]) : undefined,
        allowPast,
      );
      return c ? { date: c } : null;
    },
  },
  {
    // "17 October", "the 17th of October", "17th Oct 2027"
    re: new RegExp(
      `\\b${LEAD}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`,
      "i",
    ),
    at: (m, { today, allowPast }) => {
      const c = monthDay(
        today,
        monthIndex(m[2]),
        Number(m[1]),
        m[3] ? Number(m[3]) : undefined,
        allowPast,
      );
      return c ? { date: c } : null;
    },
  },
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/,
    at: (m) => {
      const s = `${m[1]}-${m[2]}-${m[3]}`;
      return isIsoDate(s) ? { date: civil(Number(m[1]), Number(m[2]), Number(m[3])) } : null;
    },
  },
  {
    // "by 17/10", "on 17/10/2026" — day first (owner's locale); needs a lead
    // word so fractions ("3/4 of the deck") don't read as dates.
    re: new RegExp(
      `\\b(?:due|by|before|until|till|on)\\s+(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?\\b`,
      "i",
    ),
    at: (m, { today, allowPast }) => {
      const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
      const c = monthDay(today, Number(m[2]) - 1, Number(m[1]), y, allowPast);
      return c ? { date: c } : null;
    },
  },
  {
    // "the 17th", "by the 30th" — this month, else next.
    re: new RegExp(
      `\\b${LEAD}the\\s+(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of\\s+)?${MONTH_RE})`,
      "i",
    ),
    at: (m, { today }) => {
      const c = nextDayOfMonth(today, Number(m[1]));
      return c ? { date: c } : null;
    },
  },
];

// ── times ─────────────────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Followers that make a bare "at 3" read as a time, not "at 3 locations". */
const BARE_FOLLOW =
  "(?=\\s*$|\\s*[,.;!?)]|\\s+(?:on|with|for|to|and|tomorrow|today|tonight|next|this|in|the|sharp|then|please|so|or|by)\\b)";

const TIME_RULES: Array<{ re: RegExp; at: (m: RegExpExecArray) => string | null }> = [
  {
    // 3pm, 3:30 pm, at 10 a.m.
    re: /\b(?:at\s+|@\s*|around\s+|by\s+|before\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)/i,
    at: (m) => {
      let h = Number(m[1]);
      const min = Number(m[2] ?? 0);
      if (h < 1 || h > 12 || min > 59) return null;
      const pm = /^p/i.test(m[3]);
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      return `${pad2(h)}:${pad2(min)}`;
    },
  },
  {
    // 15:30, at 9:15
    re: /\b(?:at\s+|@\s*|around\s+|by\s+|before\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i,
    at: (m) => `${pad2(Number(m[1]))}:${m[2]}`,
  },
  {
    // at 3 o'clock / at 3 (bare): 1–6 → afternoon, 7–11 → morning, 12 → noon
    re: new RegExp(`\\b(?:at|around)\\s+(\\d{1,2})(?:\\s*o'?\\s*clock)?${BARE_FOLLOW}`, "i"),
    at: (m) => {
      const h = Number(m[1]);
      if (h < 1 || h > 24) return null;
      if (h >= 13) return `${pad2(h % 24)}:00`;
      if (h === 12) return "12:00";
      return `${pad2(h <= 6 ? h + 12 : h)}:00`;
    },
  },
  {
    re: /\b(?:at\s+|by\s+|around\s+)?(noon|midday|lunch(?:time)?)\b/i,
    at: () => "12:00",
  },
  { re: /\bin\s+the\s+morning\b/i, at: () => "09:00" },
  { re: /\bin\s+the\s+afternoon\b/i, at: () => "14:00" },
  { re: /\bin\s+the\s+evening\b/i, at: () => "19:00" },
];

function findTime(text: string): { time: string; start: number; end: number } | null {
  let best: { time: string; start: number; end: number } | null = null;
  for (const r of TIME_RULES) {
    const m = r.re.exec(text);
    if (!m) continue;
    const time = r.at(m);
    if (!time) continue;
    if (!best || m.index < best.start) best = { time, start: m.index, end: m.index + m[0].length };
  }
  return best;
}

// ── main ──────────────────────────────────────────────────────────────────────

const CUE =
  /\b(?:by|due|before|until|till|deadline|remind(?:er)?|review|revisit|follow[-\s]?up|check\s+(?:back|in|on)|look\s+(?:at|into)\s+(?:it|this)|schedule[d]?|on\s+(?:the\s+)?\d|on\s+(?:mon|tue|wed|thu|fri|sat|sun)|next\s+(?:week|month)|tomorrow|tonight|today|in\s+\S+\s+(?:days?|weeks?|months?))\b/i;

/**
 * The date spoken in `text`, or null. When several date phrases appear the
 * one with a deadline cue in front of it ("by", "due", "on") wins, else the
 * first. A time ("at 3", "3pm", "noon") anywhere in the text attaches to it;
 * a time with no date means today (tomorrow if that time has passed).
 */
export function parseSpokenDate(text: string, opts: ParseDateOptions = {}): SpokenDate | null {
  if (!text?.trim()) return null;
  const now = opts.now ?? new Date();
  const wall = wallClock(now, opts.timeZone);
  const today = civil(wall.y, wall.m, wall.d);
  const ctx: Ctx = { today, wall, allowPast: !!opts.allowPast };
  if (opts.requireCue && !CUE.test(text)) return null;

  type Cand = Hit & { start: number; end: number; cue: boolean };
  const cands: Cand[] = [];
  for (const rule of RULES) {
    const re = new RegExp(
      rule.re.source,
      rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`,
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const hit = rule.at(m, ctx);
      if (hit) {
        const start = m.index;
        const end = m.index + m[0].length;
        // Skip a match nested inside an earlier (longer) one.
        if (!cands.some((c) => start >= c.start && end <= c.end)) {
          cands.push({
            ...hit,
            start,
            end,
            cue: /^(?:due|by|before|until|till|on|no later than)\b/i.test(m[0]),
          });
        }
      }
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  const usable = cands.filter((c) => ctx.allowPast || c.date.getTime() >= today.getTime());

  let pick: Cand | undefined =
    usable.find((c) => c.cue) ?? [...usable].sort((a, b) => a.start - b.start)[0];

  const timeHit = findTime(text);
  if (!pick && timeHit && (!opts.requireCue || CUE.test(text))) {
    // A time with no date: today, or tomorrow if it has already passed.
    const [h, mi] = timeHit.time.split(":").map(Number);
    const passed = h * 60 + mi <= wall.hour * 60 + wall.minute;
    return {
      date: ymdOf(passed ? addDays(today, 1) : today),
      time: timeHit.time,
      phrase: text.slice(timeHit.start, timeHit.end).trim(),
      start: timeHit.start,
      end: timeHit.end,
    };
  }
  if (!pick) return null;

  let start = pick.start;
  let end = pick.end;
  let time = pick.time;
  if (timeHit && !(timeHit.start >= pick.start && timeHit.end <= pick.end)) {
    // Attach a time said near the date ("next Tuesday at 3", "at 3 on Friday").
    const gap =
      timeHit.start >= end ? text.slice(end, timeHit.start) : text.slice(timeHit.end, start);
    if (gap.length <= 12 && !/[.;!?]/.test(gap)) {
      time = timeHit.time;
      start = Math.min(start, timeHit.start);
      end = Math.max(end, timeHit.end);
    } else if (!time) {
      time = timeHit.time;
    }
  }
  return {
    date: ymdOf(pick.date),
    ...(time ? { time } : {}),
    phrase: text.slice(start, end).trim(),
    start,
    end,
  };
}

/** `text` with the parsed phrase cut out ("ship it by Friday, urgent" → "ship it, urgent"). */
export function stripPhrase(text: string, hit: Pick<SpokenDate, "start" | "end">): string {
  return `${text.slice(0, hit.start)} ${text.slice(hit.end)}`
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/^[\s,;:-]+/, "")
    .replace(/[\s,;:-]+$/, "")
    .trim();
}

/** "Fri 17 Oct", "Fri 17 Oct, 3 pm", "Fri 17 Oct 2027, 15:30" (year only when not this year). */
export function describeDate(
  date: string,
  time?: string,
  opts: { now?: Date; timeZone?: string } = {},
): string {
  if (!isIsoDate(date)) return date;
  const [y, m, d] = date.split("-").map(Number);
  const c = civil(y, m, d);
  const thisYear = wallClock(opts.now ?? new Date(), opts.timeZone).y;
  let out = `${WEEKDAY_SHORT[dow(c)]} ${d} ${MONTH_SHORT[m - 1]}${y !== thisYear ? ` ${y}` : ""}`;
  if (time && isHm(time)) {
    const [h, mi] = time.split(":").map(Number);
    const h12 = h % 12 || 12;
    out += `, ${h12}${mi ? `:${pad2(mi)}` : ""} ${h < 12 ? "am" : "pm"}`;
  }
  return out;
}

/** ISO-8601 instant for a wall-clock date+time in `timeZone` (for Notion date-times). */
export function zonedIso(date: string, time: string, timeZone?: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  // Offset of the zone at that instant (two passes cover DST edges).
  let ts = guess;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClock(new Date(ts), timeZone);
    const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hour, w.minute);
    ts = guess - (asUtc - ts);
  }
  const off = Math.round((guess - ts) / 60_000);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${date}T${pad2(h)}:${pad2(mi)}:00${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export { WEEKDAYS };
