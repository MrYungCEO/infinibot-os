/**
 * Schedule math for scheduled tasks — reuses the cron scheduler's
 * `computeNextRunAtMs` (croner + IANA timezone) so both schedulers agree.
 */

import { computeNextRunAtMs } from "../../cron/schedule.js";

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Throws a user-facing error when the cron expression or timezone is invalid. */
export function validateSchedule(cron: string, timezone: string): void {
  const expr = cron.trim();
  if (!expr) throw new Error("cron expression is required");
  const fields = expr.split(/\s+/).length;
  if (fields < 5 || fields > 6)
    throw new Error(`cron expression must have 5 or 6 fields, got ${fields}: "${expr}"`);
  if (!isValidTimezone(timezone)) throw new Error(`unknown timezone: ${timezone}`);
  try {
    if (computeNextRunAtMs({ kind: "cron", expr, tz: timezone }, Date.now()) === undefined)
      throw new Error("never fires");
  } catch (err) {
    throw new Error(`invalid cron expression "${expr}": ${String((err as Error).message ?? err)}`);
  }
}

export function nextRunAt(cron: string, timezone: string, nowMs: number): number | null {
  try {
    return computeNextRunAtMs({ kind: "cron", expr: cron.trim(), tz: timezone }, nowMs) ?? null;
  } catch {
    return null;
  }
}

/** Human "Sat 27 Sep, 17:00 (Asia/Bangkok)" for reports and chat replies. */
export function formatInZone(ms: number, timezone: string): string {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
  return `${s} (${timezone})`;
}

/** Small cron → English helper for the common shapes; falls back to the expression. */
export function describeCron(cron: string, timezone: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    const hm = /^\d+$/.test(min) && /^\d+$/.test(hour);
    const time = hm ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` : "";
    if (hm && dom === "*" && mon === "*" && dow === "*") return `Daily at ${time} ${timezone}`;
    if (hm && dom === "*" && mon === "*" && dow === "1-5") return `Weekdays at ${time} ${timezone}`;
    if (hm && dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) {
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number(dow)];
      return `${day} at ${time} ${timezone}`;
    }
  }
  return `${cron} (${timezone})`;
}

/**
 * On boot: a run that was due while the gateway was down fires once if it was
 * missed by less than `catchUpMs`; otherwise it is skipped to the next slot.
 */
export function resolveMissedRun(
  nextRun: number | null,
  nowMs: number,
  catchUpMs: number,
): "run" | "skip" | "wait" {
  if (nextRun === null) return "skip";
  if (nextRun > nowMs) return "wait";
  return nowMs - nextRun <= catchUpMs ? "run" : "skip";
}
