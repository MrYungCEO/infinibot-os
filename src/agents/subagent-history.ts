/**
 * Subagent run history — persistent archive of completed/errored/timeout runs.
 *
 * Lives alongside the live registry (subagent-registry.ts).  The live
 * registry drops finished entries from `runs.json` after a 10-minute grace
 * window so the live UI stays uncluttered.  This module captures a compact
 * archival snapshot of each run the moment it reaches a terminal state so the
 * Agents page history feed has something to show beyond that window.
 *
 * Storage: `<STATE_DIR>/subagents/history.json` — same directory as
 * `runs.json`, same json-file helpers.  This is an extension of the registry's
 * existing store, not a new persistence layer.
 *
 * Retention: 30 days by default, configurable via
 * `INFINIBOT_SUBAGENT_HISTORY_DAYS`.  Pruning runs on every insert.
 */

import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SubagentRunRecord } from "./subagent-registry.js";

const log = createSubsystemLogger("subagent-history");

export type HistoryStatus = "complete" | "error" | "timeout";

export type SubagentHistoryEntry = {
  runId: string;
  label?: string;
  task: string;
  status: HistoryStatus;
  startedAt?: number;
  endedAt: number;
  outcome?: { status: string; error?: string };
  error?: string;
  requesterSessionKey: string;
  kanbanTaskId?: string;
  /** Prior run this one respawned (kanban reconciliation follows the chain). */
  respawnOfRunId?: string;
  /** Working directory of the run (when known). */
  workdir?: string;
  /** Coder CLI that produced the run, when known. */
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /** Total files touched during the run. */
  filesTouchedCount?: number;
  /** Up to 8 most recent file paths, oldest first.  Used for at-a-glance preview. */
  filesTouchedSample?: string[];
  /**
   * The sub-agent's own session key — used by sessions.transcript and specAnalysis
   * to resolve the JSONL transcript file without the live registry.
   */
  childSessionKey?: string;
  /**
   * Absolute path to the JSONL transcript file; set once the coder tool resolves
   * the transcript context at spawn time.  Enables direct transcript reads after
   * the live registry entry has been swept.
   */
  transcriptPath?: string;
};

type PersistedHistoryV1 = {
  version: 1;
  entries: SubagentHistoryEntry[];
};

const HISTORY_VERSION = 1 as const;

const DEFAULT_RETENTION_DAYS = 30;
const MAX_FILE_SAMPLE = 8;
/** Hard upper bound on persisted entries — keeps history.json from growing unbounded. */
const MAX_ENTRIES = 5_000;

let memCache: SubagentHistoryEntry[] | null = null;
// The path that `memCache` was loaded for. Resolved under the ACTIVE profile,
// so a `switchProfile()` (which re-points resolveStateDir) invalidates the
// cache on the next access and we reload the new profile's history.
let cachedForPath: string | null = null;

function resolveHistoryPath(): string {
  return path.join(resolveStateDir(), "subagents", "history.json");
}

function resolveRetentionMs(): number {
  const raw = process.env.INFINIBOT_SUBAGENT_HISTORY_DAYS;
  const parsed = raw ? Number(raw) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

function loadFromDisk(): SubagentHistoryEntry[] {
  const raw = loadJsonFile(resolveHistoryPath());
  if (!raw || typeof raw !== "object") return [];
  const wrapped = raw as Partial<PersistedHistoryV1>;
  if (wrapped.version !== 1 || !Array.isArray(wrapped.entries)) return [];
  const entries: SubagentHistoryEntry[] = [];
  for (const e of wrapped.entries) {
    if (!e || typeof e !== "object") continue;
    const entry = e as Partial<SubagentHistoryEntry>;
    if (
      typeof entry.runId !== "string" ||
      typeof entry.endedAt !== "number" ||
      typeof entry.task !== "string" ||
      typeof entry.requesterSessionKey !== "string" ||
      (entry.status !== "complete" && entry.status !== "error" && entry.status !== "timeout")
    ) {
      continue;
    }
    entries.push(entry as SubagentHistoryEntry);
  }
  return entries;
}

function saveToDisk(entries: SubagentHistoryEntry[]): void {
  try {
    const payload: PersistedHistoryV1 = { version: HISTORY_VERSION, entries };
    saveJsonFile(resolveHistoryPath(), payload);
  } catch (err) {
    log.warn("failed to persist subagent history", {
      err: err instanceof Error ? err.message : String(err),
      size: entries.length,
    });
  }
}

function ensureLoaded(): SubagentHistoryEntry[] {
  const currentPath = resolveHistoryPath();
  if (memCache === null || cachedForPath !== currentPath) {
    memCache = loadFromDisk();
    cachedForPath = currentPath;
  }
  return memCache;
}

function deriveStatus(entry: SubagentRunRecord): HistoryStatus | null {
  if (!entry.endedAt) return null;
  const outcomeStatus = entry.outcome?.status;
  const err = entry.outcome?.error;
  if (outcomeStatus === "ok") return "complete";
  if (outcomeStatus === "error") {
    if (typeof err === "string" && /timeout/i.test(err)) return "timeout";
    return "error";
  }
  return "complete";
}

/**
 * Compact a registry record into an archival entry.  Returns null when the
 * run hasn't actually finished (no endedAt) — we never archive in-flight runs.
 */
export function buildHistoryEntry(run: SubagentRunRecord): SubagentHistoryEntry | null {
  const status = deriveStatus(run);
  if (!status || !run.endedAt) return null;
  const files = run.filesTouched ?? [];
  const sample = files.slice(-MAX_FILE_SAMPLE).map((f) => f.path);
  return {
    runId: run.runId,
    label: run.label,
    task: run.task,
    status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    outcome: run.outcome ? { status: run.outcome.status, error: run.outcome.error } : undefined,
    error: run.outcome?.error,
    requesterSessionKey: run.requesterSessionKey,
    kanbanTaskId: run.kanbanTaskId,
    ...(run.respawnOfRunId ? { respawnOfRunId: run.respawnOfRunId } : {}),
    workdir: run.workdir,
    coderBackend: run.coderBackend,
    filesTouchedCount: files.length,
    filesTouchedSample: sample.length > 0 ? sample : undefined,
    childSessionKey: run.childSessionKey,
    transcriptPath: run.transcriptPath,
  };
}

/**
 * Append (or upsert) a finished run into the history archive.  Idempotent by
 * runId — calling twice for the same run replaces the existing entry rather
 * than duplicating, so we can hook this into multiple lifecycle paths safely.
 */
export function archiveSubagentRun(run: SubagentRunRecord): void {
  const entry = buildHistoryEntry(run);
  if (!entry) return;
  const entries = ensureLoaded();
  const idx = entries.findIndex((e) => e.runId === entry.runId);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  pruneInPlace(entries);
  memCache = entries;
  saveToDisk(entries);
}

function pruneInPlace(entries: SubagentHistoryEntry[]): void {
  const cutoff = Date.now() - resolveRetentionMs();
  let writeIdx = 0;
  for (let readIdx = 0; readIdx < entries.length; readIdx++) {
    const e = entries[readIdx];
    if (e.endedAt >= cutoff) {
      entries[writeIdx++] = e;
    }
  }
  entries.length = writeIdx;
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => a.endedAt - b.endedAt);
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

export type ListHistoryOptions = {
  limit?: number;
  /** Epoch ms — only entries with endedAt >= since are returned. */
  since?: number;
  /** Status filter.  Empty / undefined means all. */
  statusFilter?: HistoryStatus[];
  /** Restrict to a specific requester session key. */
  requesterSessionKey?: string;
};

/**
 * Read the archive.  Always returns most-recent-first.  Applies retention
 * prune before returning so callers never see expired entries.
 */
export function listSubagentHistory(opts: ListHistoryOptions = {}): {
  entries: SubagentHistoryEntry[];
  total: number;
} {
  const entries = ensureLoaded();
  pruneInPlace(entries);
  memCache = entries;
  // Persist the pruned shape so we don't keep re-reading dead rows.
  saveToDisk(entries);

  const since = typeof opts.since === "number" && opts.since > 0 ? opts.since : 0;
  const statusFilter =
    Array.isArray(opts.statusFilter) && opts.statusFilter.length > 0
      ? new Set(opts.statusFilter)
      : null;
  const requester =
    typeof opts.requesterSessionKey === "string" && opts.requesterSessionKey.length > 0
      ? opts.requesterSessionKey
      : null;

  let filtered = entries.filter((e) => {
    if (since && e.endedAt < since) return false;
    if (statusFilter && !statusFilter.has(e.status)) return false;
    if (requester && e.requesterSessionKey !== requester) return false;
    return true;
  });

  filtered.sort((a, b) => b.endedAt - a.endedAt);
  const total = filtered.length;
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? Math.min(opts.limit, 500) : 30;
  if (filtered.length > limit) filtered = filtered.slice(0, limit);
  return { entries: filtered, total };
}

/**
 * Look up a single archived entry by runId.  Cheaper and clearer than
 * `listSubagentHistory()` + scan when callers (e.g. `subagents.detail`) need
 * exactly one row.  Loads from disk on first use, then serves from `memCache`.
 * Returns `undefined` when the runId isn't in the archive (or was pruned).
 */
export function getSubagentHistoryEntryByRunId(runId: string): SubagentHistoryEntry | undefined {
  if (!runId) return undefined;
  const entries = ensureLoaded();
  return entries.find((e) => e.runId === runId);
}

/**
 * Look up the most-recent archived run linked to a kanban task. Lets the
 * "completed tasks" feed in the grid activity panel resolve a task → run
 * even when the live registry has already swept the entry.
 */
export function getSubagentHistoryEntryByKanbanTaskId(
  kanbanTaskId: string,
): SubagentHistoryEntry | undefined {
  if (!kanbanTaskId) return undefined;
  const entries = ensureLoaded();
  let best: SubagentHistoryEntry | undefined;
  for (const e of entries) {
    if (e.kanbanTaskId !== kanbanTaskId) continue;
    if (!best || e.endedAt > best.endedAt) best = e;
  }
  return best;
}

/** Test-only — clears the in-memory cache so each test starts clean. */
export function resetSubagentHistoryForTests(): void {
  memCache = null;
}

/** Test-only — direct insert for assertions. */
export function addHistoryEntryForTests(entry: SubagentHistoryEntry): void {
  const entries = ensureLoaded();
  entries.push(entry);
  memCache = entries;
  saveToDisk(entries);
}
