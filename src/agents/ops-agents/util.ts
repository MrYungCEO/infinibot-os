/**
 * Small date/predicate helpers shared by the three ops agents. Pure and
 * deterministic — every function takes `now` (Unix ms) explicitly so callers
 * and tests never depend on the wall clock.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default lookahead window for "upcoming" deadlines/milestones (days). */
export const UPCOMING_WINDOW_DAYS = 3;

/**
 * Parse an ISO date (YYYY-MM-DD, or any Date-parseable string) to Unix ms.
 * Returns null for empty/invalid input so callers can treat "no date" cleanly.
 */
export function parseIsoDate(value: string | undefined | null): number | null {
  if (!value || !String(value).trim()) return null;
  const ms = Date.parse(String(value).trim());
  return Number.isFinite(ms) ? ms : null;
}

/** True when `iso` is a real date strictly in the past relative to `now`. */
export function isPastDue(iso: string | undefined | null, now: number): boolean {
  const ms = parseIsoDate(iso);
  return ms != null && ms < now;
}

/**
 * True when `iso` is a real date within the next `windowDays` (inclusive of
 * today, exclusive of already-past). "Upcoming", not overdue.
 */
export function isUpcoming(
  iso: string | undefined | null,
  now: number,
  windowDays: number = UPCOMING_WINDOW_DAYS,
): boolean {
  const ms = parseIsoDate(iso);
  if (ms == null) return false;
  return ms >= now && ms <= now + windowDays * DAY_MS;
}

/** Whole days from `now` until `iso` (negative = overdue). null if no date. */
export function daysUntil(iso: string | undefined | null, now: number): number | null {
  const ms = parseIsoDate(iso);
  if (ms == null) return null;
  return Math.round((ms - now) / DAY_MS);
}

/** A record has a non-blank string value at `field`. */
export function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Sort rank for a P0–P3 priority string (lower = more urgent). Mirrors
 * business-objects/rules.ts::priorityRank but tolerates the kanban
 * "Immediate/High/Medium/Low" scale too so a mixed list sorts sensibly.
 */
export function rank(priority: string | undefined | null): number {
  switch (String(priority ?? "").toUpperCase()) {
    case "P0":
    case "IMMEDIATE":
    case "CRITICAL":
      return 0;
    case "P1":
    case "HIGH":
      return 1;
    case "P2":
    case "MEDIUM":
    case "NORMAL":
      return 2;
    case "P3":
    case "LOW":
      return 3;
    default:
      return 4;
  }
}
