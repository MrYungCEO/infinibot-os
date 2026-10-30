/**
 * Shared entry points for the gateway RPC and the agent tool. Heavy work (the
 * rollup parses multi-MB run stores) runs in a short-lived child process so
 * the long-lived gateway heap never grows: the gateway only reads the small
 * per-day JSON files.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDay, readIndex } from "./rollup.js";
import type { DayIndexEntry, DayRollup } from "./types.js";
import { addDays, isDayKey, today } from "./util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.extname(fileURLToPath(import.meta.url)) || ".js";

let inflight: Promise<void> | null = null;

/** Run `cli refresh` in a child process (deduplicated). */
export function refreshInChild(args: string[] = ["refresh"], timeoutMs = 180_000): Promise<void> {
  if (inflight) return inflight;
  inflight = new Promise<void>((resolve) => {
    const execArgv = ext === ".ts" ? ["--import", "tsx"] : [];
    const child = spawn(process.execPath, [...execArgv, path.join(here, `cli${ext}`), ...args], {
      stdio: "ignore",
      env: process.env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Day record; today's is refreshed when older than `maxAgeMs`. */
export async function getDay(
  date: string | undefined,
  opts: { maxAgeMs?: number; force?: boolean } = {},
): Promise<DayRollup | null> {
  const day = isDayKey(date) ? date : today();
  let r = readDay(day);
  const maxAge = opts.maxAgeMs ?? 5 * 60_000;
  const stale = !r || (r.partial && Date.now() - r.generatedAt > maxAge);
  if (opts.force || stale) {
    await refreshInChild(day === today() ? ["refresh"] : ["day", day]);
    r = readDay(day);
  }
  return r;
}

export type RangeName = "week" | "month" | "quarter" | "year" | "all";

export function resolveRange(
  range: string | undefined,
  from?: string,
  to?: string,
): { from: string; to: string } {
  const end = isDayKey(to) ? to : today();
  if (isDayKey(from)) return { from, to: end };
  const span: Record<string, number> = { week: 6, month: 29, quarter: 89, year: 364, all: 4000 };
  return { from: addDays(end, -(span[range ?? "month"] ?? 29)), to: end };
}

export function getRange(range?: string, from?: string, to?: string): DayIndexEntry[] {
  const r = resolveRange(range, from, to);
  return readIndex().filter((e) => e.date >= r.from && e.date <= r.to);
}
