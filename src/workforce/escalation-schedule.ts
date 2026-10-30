/**
 * Timing rules for the escalation protocol.
 *
 * Two questions, both pure so they can be asserted directly:
 *   1. Is `now` inside the agency's quiet hours? (a 03:00 suggestion must wait)
 *   2. When does the current digest window close? (so batched insights leave as
 *      one message at a real cadence rather than one message per thought)
 *
 * Working hours themselves are NOT re-implemented here — `planResponse` in
 * `communication.ts` already owns the worker's `wf_employee_schedules`. Quiet
 * hours are the *agency*'s policy and sit on top of it.
 */

import type { AgencyEscalationPolicy, DigestCadence } from "./escalation-types.js";

/** Weekday (0=Sun) and minutes-since-midnight for `now` in `timezone`. */
export function localClock(now: number, timezone: string): { weekday: number; minutes: number } {
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
    // An unknown IANA zone must never stop an escalation going out.
    const date = new Date(now);
    return { weekday: date.getUTCDay(), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = Math.max(0, days.indexOf(lookup("weekday")));
  const hour = Number(lookup("hour")) % 24;
  const minute = Number(lookup("minute"));
  return {
    weekday,
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  };
}

const hhmmToMinutes = (value: string): number => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
  return (Number(match[1]) % 24) * 60 + Number(match[2]);
};

/** `start > end` spans midnight, which is how an operator reads "22:00–07:00". */
export function isWithinQuietHours(policy: AgencyEscalationPolicy, now: number): boolean {
  if (!policy.quietHours.enabled) return false;
  const { minutes } = localClock(now, policy.quietHours.timezone);
  const start = hhmmToMinutes(policy.quietHours.start);
  const end = hhmmToMinutes(policy.quietHours.end);
  if (start === end) return false;
  return end > start ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Epoch ms at which quiet hours next end. Returns `now` when not in them. */
export function quietHoursEndAt(policy: AgencyEscalationPolicy, now: number): number {
  if (!isWithinQuietHours(policy, now)) return now;
  const { minutes } = localClock(now, policy.quietHours.timezone);
  const end = hhmmToMinutes(policy.quietHours.end);
  const deltaMinutes = end > minutes ? end - minutes : 24 * 60 - minutes + end;
  return now + deltaMinutes * 60_000;
}

/**
 * When the digest window containing `now` closes.
 *
 * hourly — the next whole hour.
 * daily  — the next `timeOfDay` in the digest timezone.
 * weekly — the next Monday `timeOfDay`.
 *
 * Always strictly in the future, so a raise that lands exactly on the boundary
 * joins the *next* digest rather than one that is already being flushed.
 */
export function nextDigestAt(
  cadence: DigestCadence,
  timeOfDay: string,
  timezone: string,
  now: number,
): number {
  if (cadence === "hourly") {
    const hour = 3_600_000;
    return Math.floor(now / hour) * hour + hour;
  }
  const { weekday, minutes } = localClock(now, timezone);
  const target = hhmmToMinutes(timeOfDay);
  const day = 24 * 60;
  if (cadence === "daily") {
    const delta = target > minutes ? target - minutes : day - minutes + target;
    return now + delta * 60_000;
  }
  // Weekly: Monday (weekday 1).
  let deltaDays = (1 - weekday + 7) % 7;
  if (deltaDays === 0 && target <= minutes) deltaDays = 7;
  return now + (deltaDays * day - minutes + target) * 60_000;
}
