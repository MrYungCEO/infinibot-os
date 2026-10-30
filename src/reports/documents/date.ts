/**
 * Deterministic date formatting for documents.
 *
 * Everything is rendered in UTC and with an explicit month table rather than
 * `toLocaleDateString`, so the same epoch produces the same bytes on a CI box
 * in UTC and on a laptop in UTC-7. Document dates are legal facts; they must
 * not shift with the renderer's timezone.
 */

const MONTHS = [
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
] as const;

/** e.g. `14 Mar 2026`. Returns `fallback` for null/invalid input. */
export function formatDocumentDate(epochMs: number | null | undefined, fallback = "—"): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return fallback;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return fallback;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** ISO calendar date (`2026-03-14`) for machine-readable attributes and filenames. */
export function toIsoDate(epochMs: number | null | undefined): string | null {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, positive when `to` is in the future. */
export function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / 86_400_000);
}
