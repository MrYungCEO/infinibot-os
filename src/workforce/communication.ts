/**
 * Communication profiles — the structured replacement for `Worker.communicationCadence`.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * `communicationCadence` was a single free-text string ("Daily async update;
 * weekly campaign scorecard"). It told an operator *when* an employee reports,
 * and told the runtime nothing at all. Nothing about it could make an AI
 * employee sound like a person: no register, no latency policy, no per-channel
 * shape, no working hours, no hand-off phrasing.
 *
 * A `CommunicationProfile` is that missing structure. It is stored as JSON on
 * the worker row (`wf_workers.communication_profile_json`) and is *derived*
 * from the legacy string the first time it is read, so no operator data is
 * lost: the original text survives verbatim in `legacyCadence`, and the legacy
 * column keeps a human-readable one-line summary so old readers still work.
 *
 * ── Human cadence, deliberately ─────────────────────────────────────────────
 * The single most bot-like behaviour is replying instantly to everything, one
 * reply per inbound message, at 03:00, in the same register on every channel.
 * `responseLatency` therefore carries an explicit *minimum* delay and a batch
 * window (collect what arrives inside the window and answer once), working
 * hours defer to `wf_employee_schedules`, and per-channel overrides let the
 * same employee be a two-line Slack colleague and a signed-off email writer.
 */

import { normalizeChatChannelId, type ChatChannelId } from "../channels/registry.js";

export const COMMUNICATION_PROFILE_VERSION = 1 as const;

export const COMMUNICATION_TONES = [
  "formal",
  "professional",
  "friendly",
  "casual",
  "blunt",
] as const;
export type CommunicationTone = (typeof COMMUNICATION_TONES)[number];

export const COMMUNICATION_VERBOSITY = ["terse", "concise", "balanced", "detailed"] as const;
export type CommunicationVerbosity = (typeof COMMUNICATION_VERBOSITY)[number];

export const PROACTIVITY_LEVELS = ["reactive", "responsive", "proactive", "driving"] as const;
export type ProactivityLevel = (typeof PROACTIVITY_LEVELS)[number];

export const EMOJI_USAGE = ["none", "sparing", "expressive"] as const;
export type EmojiUsage = (typeof EMOJI_USAGE)[number];

export const OUTSIDE_HOURS_BEHAVIOURS = ["defer", "auto_reply", "respond"] as const;
export type OutsideHoursBehaviour = (typeof OUTSIDE_HOURS_BEHAVIOURS)[number];

export const REPORT_CADENCES = [
  "continuous",
  "hourly",
  "daily",
  "weekly",
  "biweekly",
  "monthly",
] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

/**
 * Reply timing. A human does not answer in 200 ms, and does not send five
 * replies to five messages that arrived in the same minute.
 */
export type ResponseLatencyPolicy = {
  /** Never reply sooner than this. 0 means "instant" (explicitly bot-like). */
  minSeconds: number;
  /** The cadence to aim for on a normal message. */
  targetSeconds: number;
  /** Hard ceiling: past this the employee must at least acknowledge. */
  maxSeconds: number;
  /** Collect messages arriving inside this window and answer once. */
  batchWindowSeconds: number;
  /** Urgent/escalated traffic ignores `minSeconds` and the batch window. */
  urgentBypass: boolean;
  /** Emit a typing indicator while the artificial delay elapses. */
  typingIndicator: boolean;
};

export type WorkingHoursPolicy = {
  /** Honour the worker's rows in `wf_employee_schedules`. */
  respectSchedule: boolean;
  /** What happens to a message that lands outside the shift. */
  outsideHours: OutsideHoursBehaviour;
  /** Sent once per conversation when `outsideHours` is `auto_reply`. */
  outsideHoursMessage: string | null;
  /** Timezone used when the worker has no schedule row. */
  fallbackTimezone: string;
};

export type EscalationPolicy = {
  /** Silence for this long on an open thread escalates to the manager. */
  escalateAfterMinutes: number;
  /** Phrasing used when escalating upward. */
  escalationPhrase: string;
  /** Phrasing used when handing a thread to another employee or a human. */
  handoffPhrase: string;
  /** Always notify the manager instead of resolving alone. */
  notifyManager: boolean;
};

/**
 * A Slack message is not an email. Anything omitted inherits from the profile.
 */
export type ChannelCommunicationOverride = {
  channelId: ChatChannelId;
  tone?: CommunicationTone;
  verbosity?: CommunicationVerbosity;
  emojiUse?: EmojiUsage;
  /** Partial latency override — merged over the profile-level policy. */
  responseLatency?: Partial<ResponseLatencyPolicy>;
  /** Soft cap before the reply is split or trimmed. */
  maxMessageChars?: number;
  greeting?: string | null;
  signOff?: string | null;
  signature?: string | null;
  /** Free-form extra rules for this channel only. */
  notes?: string;
};

/** How the employee writes, and when. */
export interface CommunicationProfile {
  version: typeof COMMUNICATION_PROFILE_VERSION;
  tone: CommunicationTone;
  verbosity: CommunicationVerbosity;
  /** BCP-47 tag the employee writes in by default. */
  language: string;
  emojiUse: EmojiUsage;
  proactivity: ProactivityLevel;
  responseLatency: ResponseLatencyPolicy;
  workingHours: WorkingHoursPolicy;
  escalation: EscalationPolicy;
  /** Standing report rhythm (what the legacy string usually encoded). */
  reportCadence: ReportCadence;
  /** Local time-of-day for the standing report, HH:MM. */
  reportTime: string;
  greeting: string | null;
  signOff: string | null;
  signature: string | null;
  /** Small realism switches; all default on except `mirrorUserFormality`. */
  humanising: {
    useContractions: boolean;
    varyOpenings: boolean;
    admitUncertainty: boolean;
    mirrorUserFormality: boolean;
  };
  channelOverrides: ChannelCommunicationOverride[];
  /** The operator's original free-text cadence, preserved verbatim. */
  legacyCadence: string | null;
  /** Anything the operator wants the employee to know about how to talk. */
  notes: string;
  updatedAt: number;
}

// ── coercion helpers ────────────────────────────────────────────────────────

const oneOf = <T extends string>(values: readonly T[], raw: unknown, fallback: T): T =>
  typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : fallback;

const int = (raw: unknown, fallback: number, min: number, max: number): number => {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : fallback;
  return Math.min(max, Math.max(min, value));
};

const bool = (raw: unknown, fallback: boolean): boolean =>
  typeof raw === "boolean" ? raw : fallback;

const text = (raw: unknown, fallback: string): string =>
  typeof raw === "string" ? raw.trim() : fallback;

const nullableText = (raw: unknown, fallback: string | null): string | null => {
  if (raw === null) return null;
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function timeOfDay(raw: unknown, fallback: string): string {
  return typeof raw === "string" && HHMM.test(raw.trim()) ? raw.trim() : fallback;
}

// ── defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_RESPONSE_LATENCY: ResponseLatencyPolicy = {
  minSeconds: 45,
  targetSeconds: 300,
  maxSeconds: 3_600,
  batchWindowSeconds: 120,
  urgentBypass: true,
  typingIndicator: true,
};

export function defaultCommunicationProfile(now = Date.now()): CommunicationProfile {
  return {
    version: COMMUNICATION_PROFILE_VERSION,
    tone: "professional",
    verbosity: "concise",
    language: "en",
    emojiUse: "sparing",
    proactivity: "responsive",
    responseLatency: { ...DEFAULT_RESPONSE_LATENCY },
    workingHours: {
      respectSchedule: true,
      outsideHours: "defer",
      outsideHoursMessage: null,
      fallbackTimezone: "UTC",
    },
    escalation: {
      escalateAfterMinutes: 240,
      escalationPhrase:
        "I'm going to loop in {manager} on this so it doesn't stall — here's where it stands:",
      handoffPhrase: "Handing this to {assignee}, who owns it from here. Full context below.",
      notifyManager: true,
    },
    reportCadence: "daily",
    reportTime: "09:00",
    greeting: null,
    signOff: null,
    signature: null,
    humanising: {
      useContractions: true,
      varyOpenings: true,
      admitUncertainty: true,
      mirrorUserFormality: false,
    },
    channelOverrides: [],
    legacyCadence: null,
    notes: "",
    updatedAt: now,
  };
}

// ── legacy string migration ─────────────────────────────────────────────────

/**
 * Derive a profile from the legacy free-text `communicationCadence`.
 *
 * Only the parts the string genuinely encodes are inferred (report rhythm,
 * report time, a nudge to `proactivity` when the operator wrote "async"); the
 * rest are defaults. The original text is preserved verbatim in
 * `legacyCadence` so nothing an operator typed is ever thrown away.
 */
export function migrateCommunicationCadence(
  cadence: string | null | undefined,
  now = Date.now(),
): CommunicationProfile {
  const profile = defaultCommunicationProfile(now);
  const raw = (cadence ?? "").trim();
  if (!raw) return profile;
  profile.legacyCadence = raw;
  const lower = raw.toLowerCase();

  // Report rhythm: most specific wins, so "twice daily" is not read as monthly.
  if (/\bcontinuous|\breal[- ]?time\b/.test(lower)) profile.reportCadence = "continuous";
  else if (/\bhourly\b/.test(lower)) profile.reportCadence = "hourly";
  else if (/\bdaily\b|\beach day\b|\bevery day\b/.test(lower)) profile.reportCadence = "daily";
  else if (/\bbi-?weekly\b|\bfortnight/.test(lower)) profile.reportCadence = "biweekly";
  else if (/\bweekly\b|\bmonday\b|\bsprint\b/.test(lower)) profile.reportCadence = "weekly";
  else if (/\bmonthly\b|\bboard memo\b/.test(lower)) profile.reportCadence = "monthly";

  const time = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(raw);
  if (time) {
    profile.reportTime = `${time[1]!.padStart(2, "0")}:${time[2]}`;
  }

  // "async" is an explicit statement that this employee does not interrupt.
  if (/\basync\b/.test(lower)) {
    profile.proactivity = "responsive";
    profile.responseLatency = {
      ...profile.responseLatency,
      minSeconds: 120,
      batchWindowSeconds: 300,
    };
  }
  if (/\bstandup\b|\bbrief\b/.test(lower)) profile.proactivity = "proactive";
  if (/\bwritten\b|\bmemo\b/.test(lower)) profile.verbosity = "balanced";

  return profile;
}

/**
 * The profile for a worker: the stored JSON when present, otherwise one
 * migrated from the legacy string. Pure — never writes.
 */
export function resolveCommunicationProfile(worker: {
  communicationProfile?: CommunicationProfile | null;
  communicationCadence?: string | null;
}): CommunicationProfile {
  if (worker.communicationProfile) return worker.communicationProfile;
  return migrateCommunicationCadence(worker.communicationCadence ?? null);
}

// ── normalisation (what the store persists) ─────────────────────────────────

function normalizeLatency(raw: unknown, base: ResponseLatencyPolicy): ResponseLatencyPolicy {
  const patch = (raw ?? {}) as Record<string, unknown>;
  const minSeconds = int(patch.minSeconds, base.minSeconds, 0, 86_400);
  const targetSeconds = Math.max(
    minSeconds,
    int(patch.targetSeconds, base.targetSeconds, 0, 86_400),
  );
  return {
    minSeconds,
    targetSeconds,
    maxSeconds: Math.max(targetSeconds, int(patch.maxSeconds, base.maxSeconds, 0, 604_800)),
    batchWindowSeconds: int(patch.batchWindowSeconds, base.batchWindowSeconds, 0, 86_400),
    urgentBypass: bool(patch.urgentBypass, base.urgentBypass),
    typingIndicator: bool(patch.typingIndicator, base.typingIndicator),
  };
}

function normalizeOverride(raw: unknown): ChannelCommunicationOverride | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  // Channel ids are validated against the channel registry, never free text.
  const channelId = normalizeChatChannelId(
    typeof value.channelId === "string" ? value.channelId : null,
  );
  if (!channelId) return null;
  const override: ChannelCommunicationOverride = { channelId };
  if (value.tone !== undefined)
    override.tone = oneOf(COMMUNICATION_TONES, value.tone, "professional");
  if (value.verbosity !== undefined)
    override.verbosity = oneOf(COMMUNICATION_VERBOSITY, value.verbosity, "concise");
  if (value.emojiUse !== undefined)
    override.emojiUse = oneOf(EMOJI_USAGE, value.emojiUse, "sparing");
  if (value.responseLatency && typeof value.responseLatency === "object") {
    const partial: Partial<ResponseLatencyPolicy> = {};
    const src = value.responseLatency as Record<string, unknown>;
    for (const key of [
      "minSeconds",
      "targetSeconds",
      "maxSeconds",
      "batchWindowSeconds",
    ] as const) {
      if (src[key] !== undefined) partial[key] = int(src[key], 0, 0, 604_800);
    }
    for (const key of ["urgentBypass", "typingIndicator"] as const) {
      if (src[key] !== undefined) partial[key] = bool(src[key], true);
    }
    if (Object.keys(partial).length) override.responseLatency = partial;
  }
  if (value.maxMessageChars !== undefined)
    override.maxMessageChars = int(value.maxMessageChars, 2_000, 40, 40_000);
  if (value.greeting !== undefined) override.greeting = nullableText(value.greeting, null);
  if (value.signOff !== undefined) override.signOff = nullableText(value.signOff, null);
  if (value.signature !== undefined) override.signature = nullableText(value.signature, null);
  if (value.notes !== undefined) override.notes = text(value.notes, "").slice(0, 2_000);
  return override;
}

/**
 * Coerce arbitrary (RPC) input into a complete, storable profile. Unknown
 * fields are dropped, out-of-range numbers clamped, unknown channel ids in
 * overrides discarded. Never throws — invalid input degrades to the base.
 */
export function normalizeCommunicationProfile(
  raw: unknown,
  base: CommunicationProfile = defaultCommunicationProfile(),
  now = Date.now(),
): CommunicationProfile {
  const value = (raw ?? {}) as Record<string, unknown>;
  const workingHours = (value.workingHours ?? {}) as Record<string, unknown>;
  const escalation = (value.escalation ?? {}) as Record<string, unknown>;
  const humanising = (value.humanising ?? {}) as Record<string, unknown>;
  const overridesRaw = Array.isArray(value.channelOverrides) ? value.channelOverrides : null;

  const seen = new Set<ChatChannelId>();
  const channelOverrides = (overridesRaw ?? base.channelOverrides)
    .map((entry) => normalizeOverride(entry))
    .filter((entry): entry is ChannelCommunicationOverride => entry !== null)
    // One override per channel; the last declaration wins.
    .filter((entry) => {
      if (seen.has(entry.channelId)) return false;
      seen.add(entry.channelId);
      return true;
    });

  return {
    version: COMMUNICATION_PROFILE_VERSION,
    tone: oneOf(COMMUNICATION_TONES, value.tone, base.tone),
    verbosity: oneOf(COMMUNICATION_VERBOSITY, value.verbosity, base.verbosity),
    language: text(value.language, base.language).slice(0, 32) || base.language,
    emojiUse: oneOf(EMOJI_USAGE, value.emojiUse, base.emojiUse),
    proactivity: oneOf(PROACTIVITY_LEVELS, value.proactivity, base.proactivity),
    responseLatency: normalizeLatency(value.responseLatency, base.responseLatency),
    workingHours: {
      respectSchedule: bool(workingHours.respectSchedule, base.workingHours.respectSchedule),
      outsideHours: oneOf(
        OUTSIDE_HOURS_BEHAVIOURS,
        workingHours.outsideHours,
        base.workingHours.outsideHours,
      ),
      outsideHoursMessage: nullableText(
        workingHours.outsideHoursMessage,
        base.workingHours.outsideHoursMessage,
      ),
      fallbackTimezone:
        text(workingHours.fallbackTimezone, base.workingHours.fallbackTimezone).slice(0, 64) ||
        base.workingHours.fallbackTimezone,
    },
    escalation: {
      escalateAfterMinutes: int(
        escalation.escalateAfterMinutes,
        base.escalation.escalateAfterMinutes,
        1,
        43_200,
      ),
      escalationPhrase: text(escalation.escalationPhrase, base.escalation.escalationPhrase).slice(
        0,
        500,
      ),
      handoffPhrase: text(escalation.handoffPhrase, base.escalation.handoffPhrase).slice(0, 500),
      notifyManager: bool(escalation.notifyManager, base.escalation.notifyManager),
    },
    reportCadence: oneOf(REPORT_CADENCES, value.reportCadence, base.reportCadence),
    reportTime: timeOfDay(value.reportTime, base.reportTime),
    greeting: nullableText(value.greeting, base.greeting),
    signOff: nullableText(value.signOff, base.signOff),
    signature: nullableText(value.signature, base.signature),
    humanising: {
      useContractions: bool(humanising.useContractions, base.humanising.useContractions),
      varyOpenings: bool(humanising.varyOpenings, base.humanising.varyOpenings),
      admitUncertainty: bool(humanising.admitUncertainty, base.humanising.admitUncertainty),
      mirrorUserFormality: bool(
        humanising.mirrorUserFormality,
        base.humanising.mirrorUserFormality,
      ),
    },
    channelOverrides,
    // The operator's original words are never editable away by accident: an
    // explicit null clears them, anything else keeps what we already had.
    legacyCadence:
      value.legacyCadence === null ? null : nullableText(value.legacyCadence, base.legacyCadence),
    notes: text(value.notes, base.notes).slice(0, 4_000),
    updatedAt: now,
  };
}

/** Effective settings for one channel: profile values with the override applied. */
export function effectiveChannelProfile(
  profile: CommunicationProfile,
  channelId: ChatChannelId,
): {
  tone: CommunicationTone;
  verbosity: CommunicationVerbosity;
  emojiUse: EmojiUsage;
  responseLatency: ResponseLatencyPolicy;
  maxMessageChars: number | null;
  greeting: string | null;
  signOff: string | null;
  signature: string | null;
  notes: string;
} {
  const override = profile.channelOverrides.find((entry) => entry.channelId === channelId);
  return {
    tone: override?.tone ?? profile.tone,
    verbosity: override?.verbosity ?? profile.verbosity,
    emojiUse: override?.emojiUse ?? profile.emojiUse,
    responseLatency: { ...profile.responseLatency, ...override?.responseLatency },
    maxMessageChars: override?.maxMessageChars ?? null,
    greeting: override?.greeting !== undefined ? override.greeting : profile.greeting,
    signOff: override?.signOff !== undefined ? override.signOff : profile.signOff,
    signature: override?.signature !== undefined ? override.signature : profile.signature,
    notes: override?.notes ?? "",
  };
}

// ── Schedule-aware response planning ────────────────────────────────────────

/**
 * Structural shape of a `wf_employee_schedules` row. Declared structurally
 * rather than imported from `./types.js` so this module stays free of a cycle
 * (types.ts imports `CommunicationProfile` from here). `EmployeeSchedule` is
 * assignable to it.
 */
export type ScheduleWindow = {
  timezone: string;
  weekdays: number[];
  shiftStart: string;
  shiftEnd: string;
  enabled: boolean;
};

export type ResponsePlan = {
  /** What the employee should actually do with this inbound message. */
  action: "respond" | "defer" | "auto_reply";
  /** Artificial delay before replying, in seconds. */
  delaySeconds: number;
  /** Collect further inbound messages for this long, then answer once. */
  batchWindowSeconds: number;
  /** Epoch ms at which the reply should go out. */
  respondAt: number;
  withinWorkingHours: boolean;
  /** Set only when `action` is `auto_reply`. */
  autoReplyMessage: string | null;
  reason: string;
};

const MINUTES_PER_DAY = 24 * 60;

/** Weekday (0=Sun) and minutes-since-midnight for `now` in `timezone`. */
function localClock(now: number, timezone: string): { weekday: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(now));
  } catch {
    // An unknown IANA zone must not break message handling; fall back to UTC.
    const date = new Date(now);
    return { weekday: date.getUTCDay(), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = Math.max(0, days.indexOf(lookup("weekday")));
  // `hour12: false` can render midnight as "24" in some ICU builds.
  const hour = Number(lookup("hour")) % 24;
  const minute = Number(lookup("minute"));
  return {
    weekday,
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  };
}

const hhmmToMinutes = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
};

/**
 * Is `now` inside any enabled shift? Overnight shifts (end <= start) are
 * treated as spanning midnight into the next day, which is how an operator
 * reads "22:00–06:00".
 */
export function isWithinWorkingHours(
  schedules: ScheduleWindow[],
  now: number,
  fallbackTimezone: string,
): boolean {
  const active = schedules.filter((schedule) => schedule.enabled);
  // No shift configured at all = always available. Absence of a schedule is
  // not evidence of being off-shift, and must not silently mute an employee.
  if (!active.length) return true;
  return active.some((schedule) => {
    const timezone = schedule.timezone?.trim() || fallbackTimezone;
    const { weekday, minutes } = localClock(now, timezone);
    const start = hhmmToMinutes(schedule.shiftStart);
    const end = hhmmToMinutes(schedule.shiftEnd);
    if (start === null || end === null) return false;
    const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
    // An empty weekday list means every day, matching the store's semantics.
    const onToday = !weekdays.length || weekdays.includes(weekday);
    if (end > start) {
      return onToday && minutes >= start && minutes < end;
    }
    // Overnight: either late today (on a rostered day) or early the morning
    // after a rostered day.
    const yesterday = (weekday + 6) % 7;
    const rosteredYesterday = !weekdays.length || weekdays.includes(yesterday);
    return (onToday && minutes >= start) || (rosteredYesterday && minutes < end);
  });
}

/** Minutes until the next enabled shift opens; null when never. */
function minutesUntilNextShift(
  schedules: ScheduleWindow[],
  now: number,
  fallbackTimezone: string,
): number | null {
  let best: number | null = null;
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const timezone = schedule.timezone?.trim() || fallbackTimezone;
    const { weekday, minutes } = localClock(now, timezone);
    const start = hhmmToMinutes(schedule.shiftStart);
    if (start === null) continue;
    const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
    for (let offset = 0; offset <= 7; offset += 1) {
      const day = (weekday + offset) % 7;
      if (weekdays.length && !weekdays.includes(day)) continue;
      const delta = offset * MINUTES_PER_DAY + start - minutes;
      if (delta < 0) continue;
      if (best === null || delta < best) best = delta;
      break;
    }
  }
  return best;
}

/**
 * When and how this employee should answer a message that just arrived.
 *
 * Combines the (channel-resolved) latency policy with the worker's real shifts
 * from `wf_employee_schedules`, so an employee does not reply at 03:00 unless
 * the operator rostered them for 03:00. Urgent traffic bypasses both the
 * artificial delay and the working-hours deferral when `urgentBypass` is set,
 * because an out-of-hours pager still has to page.
 */
export function planResponse(input: {
  profile: CommunicationProfile;
  channelId?: ChatChannelId | null;
  schedules?: ScheduleWindow[];
  now?: number;
  urgent?: boolean;
}): ResponsePlan {
  const now = input.now ?? Date.now();
  const urgent = input.urgent === true;
  const effective = input.channelId
    ? effectiveChannelProfile(input.profile, input.channelId)
    : {
        responseLatency: input.profile.responseLatency,
      };
  const latency = effective.responseLatency;
  const bypass = urgent && latency.urgentBypass;

  const schedules = input.schedules ?? [];
  const respectSchedule = input.profile.workingHours.respectSchedule;
  const withinWorkingHours = respectSchedule
    ? isWithinWorkingHours(schedules, now, input.profile.workingHours.fallbackTimezone)
    : true;

  if (bypass) {
    return {
      action: "respond",
      delaySeconds: 0,
      batchWindowSeconds: 0,
      respondAt: now,
      withinWorkingHours,
      autoReplyMessage: null,
      reason: "urgent: latency and working-hours policy bypassed",
    };
  }

  const delaySeconds = Math.max(
    latency.minSeconds,
    Math.min(latency.targetSeconds, latency.maxSeconds),
  );

  if (!withinWorkingHours) {
    const behaviour = input.profile.workingHours.outsideHours;
    if (behaviour === "respond") {
      return {
        action: "respond",
        delaySeconds,
        batchWindowSeconds: latency.batchWindowSeconds,
        respondAt: now + delaySeconds * 1_000,
        withinWorkingHours: false,
        autoReplyMessage: null,
        reason: "outside working hours, but policy is respond",
      };
    }
    const waitMinutes = minutesUntilNextShift(
      schedules,
      now,
      input.profile.workingHours.fallbackTimezone,
    );
    // Deferring to a shift that never opens would mute the employee forever;
    // fall back to the normal delay instead.
    const respondAt =
      waitMinutes === null ? now + delaySeconds * 1_000 : now + waitMinutes * 60_000;
    return {
      action: behaviour === "auto_reply" ? "auto_reply" : "defer",
      delaySeconds: Math.max(0, Math.round((respondAt - now) / 1_000)),
      batchWindowSeconds: latency.batchWindowSeconds,
      respondAt,
      withinWorkingHours: false,
      autoReplyMessage:
        behaviour === "auto_reply" ? input.profile.workingHours.outsideHoursMessage : null,
      reason:
        waitMinutes === null
          ? "outside working hours and no upcoming shift; replying anyway"
          : `outside working hours; next shift opens in ${waitMinutes} minutes`,
    };
  }

  return {
    action: "respond",
    delaySeconds,
    batchWindowSeconds: latency.batchWindowSeconds,
    respondAt: now + delaySeconds * 1_000,
    withinWorkingHours: true,
    reason:
      delaySeconds > 0
        ? `on shift; hold the reply ${delaySeconds}s to stay human-paced`
        : "on shift; reply immediately",
    autoReplyMessage: null,
  };
}

/**
 * One-line human-readable rendering, written back into the legacy
 * `communicationCadence` column so every existing reader (and the operator's
 * own eye) still sees something meaningful.
 */
export function summarizeCommunicationProfile(profile: CommunicationProfile): string {
  const parts = [
    `${profile.reportCadence} report ${profile.reportTime}`,
    `${profile.tone}/${profile.verbosity}`,
    profile.responseLatency.minSeconds > 0
      ? `replies after ~${Math.round(profile.responseLatency.targetSeconds / 60)}m`
      : "replies immediately",
    profile.workingHours.respectSchedule ? "working hours enforced" : "always on",
  ];
  if (profile.channelOverrides.length) {
    parts.push(`channels: ${profile.channelOverrides.map((o) => o.channelId).join("/")}`);
  }
  return parts.join("; ");
}

/**
 * The prompt block handed to a running employee. Rendered from the profile so
 * that changing the profile changes how the employee actually writes.
 */
export function renderCommunicationPrompt(profile: CommunicationProfile): string {
  const lines: string[] = [
    `Tone: ${profile.tone}. Verbosity: ${profile.verbosity}. Language: ${profile.language}.`,
    `Emoji: ${profile.emojiUse}. Initiative: ${profile.proactivity}.`,
    profile.responseLatency.minSeconds > 0
      ? `Do NOT answer instantly. Wait at least ${profile.responseLatency.minSeconds}s, aim for ` +
        `${profile.responseLatency.targetSeconds}s, and batch anything that arrives within ` +
        `${profile.responseLatency.batchWindowSeconds}s into a single reply.` +
        (profile.responseLatency.urgentBypass ? " Urgent items bypass this delay." : "")
      : "Reply as soon as you have an answer.",
    profile.workingHours.respectSchedule
      ? `Respect your working hours (${profile.workingHours.fallbackTimezone} when no shift is set); ` +
        `outside them: ${profile.workingHours.outsideHours}.`
      : "You are available at any hour.",
    `Standing report: ${profile.reportCadence} at ${profile.reportTime}.`,
    `Escalate after ${profile.escalation.escalateAfterMinutes} minutes of no progress. ` +
      `Escalation phrasing: "${profile.escalation.escalationPhrase}". ` +
      `Hand-off phrasing: "${profile.escalation.handoffPhrase}".`,
  ];
  if (profile.greeting) lines.push(`Open with: "${profile.greeting}".`);
  if (profile.signOff) lines.push(`Sign off with: "${profile.signOff}".`);
  if (profile.signature) lines.push(`Signature: ${profile.signature}`);
  const human: string[] = [];
  if (profile.humanising.useContractions) human.push("use contractions");
  if (profile.humanising.varyOpenings) human.push("vary your openings — never reuse one template");
  if (profile.humanising.admitUncertainty) human.push("say plainly when you are not sure");
  if (profile.humanising.mirrorUserFormality) human.push("mirror the other person's formality");
  if (human.length) lines.push(`Write like a person: ${human.join("; ")}.`);
  for (const override of profile.channelOverrides) {
    const effective = effectiveChannelProfile(profile, override.channelId);
    lines.push(
      `On ${override.channelId}: ${effective.tone}/${effective.verbosity}` +
        (effective.maxMessageChars ? `, max ${effective.maxMessageChars} chars` : "") +
        (effective.signOff ? `, sign off "${effective.signOff}"` : "") +
        (effective.notes ? ` — ${effective.notes}` : "") +
        ".",
    );
  }
  if (profile.notes.trim()) lines.push(profile.notes.trim());
  if (profile.legacyCadence)
    lines.push(`Operator's original cadence note: ${profile.legacyCadence}`);
  return lines.join("\n");
}
