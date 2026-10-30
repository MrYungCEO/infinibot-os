/**
 * One-time HQ progress corrections for past bulk completions.
 *
 * Background: on 2026-09-28 a maintenance script closed 937 stale kanban tasks
 * through `kanban.tasks.update` before the RPC had a `source` flag, so every
 * one of them landed in hq-progress.json as a normal `task.done` event and the
 * Business HQ strip showed "939 cleared this week". The script saved the rows
 * it touched to a backup JSON file; this module reads such a file and marks
 * the matching progress events `bulk: true` (bulkReason "correction"), which
 * excludes them from done-today / streak / week while keeping them in the log.
 *
 * Runs on every gateway boot (src/gateway/server.impl.ts) and is idempotent:
 * each file is keyed by the sha256 of its sorted task-id set and recorded in
 * `hq-progress.json#corrections`, so a file (or an identical copy elsewhere)
 * is applied once. Events are never deleted. A missing or malformed file is a
 * silent no-op; nothing here throws into boot.
 *
 * Files considered (in order):
 *   - INFINIBOT_HQ_BULK_CORRECTION_FILE — one or more paths separated by the
 *     platform path delimiter. When set it REPLACES the defaults; set it to
 *     "off" to disable the correction entirely.
 *   - otherwise: DEFAULT_HQ_BULK_CORRECTION_FILE (the owner's private archive)
 *     plus every `*.json` in `<stateDir>/hq-bulk-corrections/` (drop a backup
 *     there on other machines).
 *
 * Accepted file shapes: an array of task ids, an array of task rows with an
 * `id` (and optionally `notionId` / `taskId` / `objectId`), or an object with
 * an `ids` / `taskIds` / `tasks` array of either.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { getHqProgressStore, type HqProgressStore } from "./store.js";

export const HQ_BULK_CORRECTION_ENV = "INFINIBOT_HQ_BULK_CORRECTION_FILE";
export const HQ_BULK_CORRECTION_DIRNAME = "hq-bulk-corrections";
export const DEFAULT_HQ_BULK_CORRECTION_FILE = join(
  homedir(),
  "Desktop",
  "Development",
  "InfiniBot-private-archive",
  "tasks-bulk-complete-backup-2026-09-28.json",
);

export type HqBulkCorrectionStatus =
  | "applied"
  | "already-applied"
  | "missing"
  | "malformed"
  | "no-progress-log"
  | "error";

export interface HqBulkCorrectionResult {
  file: string;
  status: HqBulkCorrectionStatus;
  ids?: number;
  matched?: number;
  marked?: number;
  error?: string;
}

/** Candidate correction files for this boot (see module doc). */
export function resolveHqBulkCorrectionFiles(
  opts: { env?: NodeJS.ProcessEnv; stateDir?: string } = {},
): string[] {
  const env = opts.env ?? process.env;
  const raw = env[HQ_BULK_CORRECTION_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    if (/^(off|none|0|false)$/i.test(raw.trim())) return [];
    return raw
      .split(delimiter)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => resolve(p));
  }
  const files = [DEFAULT_HQ_BULK_CORRECTION_FILE];
  const dir = join(opts.stateDir ?? resolveStateDir(), HQ_BULK_CORRECTION_DIRNAME);
  try {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".json")) files.push(join(dir, name));
    }
  } catch {
    /* no corrections dir */
  }
  return files;
}

function idsFromEntry(entry: unknown, out: Set<string>): void {
  if (typeof entry === "string") {
    if (entry.trim()) out.add(entry.trim());
    return;
  }
  if (!entry || typeof entry !== "object") return;
  const row = entry as Record<string, unknown>;
  for (const k of ["id", "notionId", "taskId", "objectId"]) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  }
}

/** Task ids in a correction file's parsed JSON; null when the shape isn't recognised or empty. */
export function parseHqBulkCorrectionIds(data: unknown): Set<string> | null {
  let list: unknown[] | null = null;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const k of ["ids", "taskIds", "tasks"]) {
      if (Array.isArray(obj[k])) {
        list = obj[k] as unknown[];
        break;
      }
    }
  }
  if (!list) return null;
  const ids = new Set<string>();
  for (const entry of list) idsFromEntry(entry, ids);
  return ids.size > 0 ? ids : null;
}

/** Stable key for a set of ids: identical copies of a file share it. */
export function hqBulkCorrectionKey(ids: ReadonlySet<string>): string {
  const hash = createHash("sha256")
    .update([...ids].sort().join("\n"))
    .digest("hex");
  return `bulk-ids:${hash}`;
}

/** Apply one correction file to `store`. Never throws. */
export function applyHqBulkCorrectionFile(
  store: HqProgressStore,
  file: string,
): HqBulkCorrectionResult {
  try {
    if (!existsSync(file)) return { file, status: "missing" };
    if (!existsSync(store.file)) return { file, status: "no-progress-log" };
    const buf = readFileSync(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      return { file, status: "malformed" };
    }
    const ids = parseHqBulkCorrectionIds(parsed);
    if (!ids) return { file, status: "malformed" };
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const res = store.applyBulkCorrection(hqBulkCorrectionKey(ids), ids, { file, sha256 });
    return {
      file,
      status: res.applied ? "applied" : "already-applied",
      ids: ids.size,
      matched: res.matched,
      marked: res.marked,
    };
  } catch (err) {
    return { file, status: "error", error: String((err as Error)?.message ?? err) };
  }
}

/**
 * Boot entry point: apply every candidate file to the core progress store.
 * Returns the per-file results (callers log the interesting ones).
 */
export function runHqBulkCorrectionMigration(
  opts: { env?: NodeJS.ProcessEnv; stateDir?: string; store?: HqProgressStore } = {},
): HqBulkCorrectionResult[] {
  try {
    const store = opts.store ?? getHqProgressStore();
    const files = resolveHqBulkCorrectionFiles({ env: opts.env, stateDir: opts.stateDir });
    return files.map((f) => applyHqBulkCorrectionFile(store, f));
  } catch (err) {
    return [{ file: "", status: "error", error: String((err as Error)?.message ?? err) }];
  }
}

/** One log line per result worth mentioning (skips missing default files). */
export function describeHqBulkCorrection(r: HqBulkCorrectionResult): string | null {
  switch (r.status) {
    case "applied":
      return `hq-progress bulk correction: marked ${r.marked} of ${r.matched} matching events as bulk (${r.ids} task ids, ${r.file})`;
    case "malformed":
      return `hq-progress bulk correction: ignored malformed file ${r.file}`;
    case "error":
      return `hq-progress bulk correction failed for ${r.file || "<init>"}: ${r.error}`;
    default:
      return null;
  }
}
