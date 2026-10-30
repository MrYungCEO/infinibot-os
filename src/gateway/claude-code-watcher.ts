/**
 * Claude Code Transcript Watcher
 *
 * Watches ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl — where the
 * Claude Code CLI appends its top-level session transcripts — and upserts
 * SessionEntry rows into the gateway's session store. This makes ad-hoc
 * Claude Code sessions visible on the infinibot activity page without
 * requiring users to spawn them through the launcher or wire up
 * settings.json hooks.
 *
 * Top-level transcripts only. Nested files like
 * <encoded>/<sessionId>/subagents/agent-X.jsonl belong to a parent session
 * and would otherwise show up as duplicate rows for the same logical
 * session — they are explicitly skipped.
 *
 * Read-only on ~/.claude/. Never writes to the user's transcripts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  updateSessionStore,
  mergeSessionEntry,
  type SessionEntry,
} from "../config/sessions.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway").child("claude-code-watcher");

const SESSION_KEY_PREFIX = "claude-code:";
/** Skip transcript files older than this on startup-add events. */
const STARTUP_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Coalesce all pending file events into a single store flush this often.
 * Each flush re-reads, rewrites (pretty JSON) and invalidates the whole main
 * session store (≈15 MB on a busy install), and some coder transcript is
 * almost always changing — at 500 ms that was ~2 full rewrites/s of churn.
 */
const FLUSH_DEBOUNCE_MS = 5_000;
/** How many bytes to read from the head of a transcript when sniffing cwd. */
const HEAD_SNIFF_BYTES = 16 * 1024;
/** How many bytes to read from the tail when extracting last-message metadata. */
const TAIL_SNIFF_BYTES = 64 * 1024;

export interface ClaudeCodeWatcherOptions {
  /** Override the projects root. Defaults to ~/.claude/projects. */
  projectsDir?: string;
  /** Override which session store path to write to. Defaults to gateway-resolved. */
  storePath?: string;
  /** Override the session-key prefix (tests). */
  keyPrefix?: string;
  /** If true, ignore the startup-freshness filter and process every transcript on startup. */
  processAll?: boolean;
  /** Override the store flush coalescing window (tests). */
  flushDebounceMs?: number;
}

export interface ClaudeCodeWatcherHandle {
  /** Close the watcher. Returns when chokidar has shut down. */
  close: () => Promise<void>;
  /** Number of transcript files currently pending in the next flush. */
  size: () => number;
  /** Path being watched. */
  projectsDir: string;
  /** Resolves once the chokidar `ready` event has fired and initial flush + prune are done. */
  ready: () => Promise<void>;
}

interface TranscriptMetadata {
  sessionId: string;
  cwd?: string;
  cwdLabel?: string;
  gitBranch?: string;
  version?: string;
  lastModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Read the head of a JSONL file and find the first line that carries a `cwd` field. */
function readTranscriptHead(filePath: string): {
  cwd?: string;
  gitBranch?: string;
  version?: string;
} {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(HEAD_SNIFF_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead === 0) return {};
    const text = buf.toString("utf-8", 0, bytesRead);
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const cwd = typeof parsed?.cwd === "string" ? parsed.cwd : undefined;
        if (cwd) {
          return {
            cwd,
            gitBranch: typeof parsed?.gitBranch === "string" ? parsed.gitBranch : undefined,
            version: typeof parsed?.version === "string" ? parsed.version : undefined,
          };
        }
      } catch {
        // skip partial / malformed line
      }
    }
  } catch {
    // ignore read errors
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return {};
}

interface TailUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Scan the tail of a transcript for the most recent assistant `usage` and `model`. */
function readTranscriptTailUsage(filePath: string): TailUsage {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return {};
    const readStart = Math.max(0, stat.size - TAIL_SNIFF_BYTES);
    const readLen = Math.min(stat.size, TAIL_SNIFF_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readStart);
    const lines = buf
      .toString("utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
        const message = parsed?.message as Record<string, unknown> | undefined;
        if (!message || typeof message !== "object") continue;
        const usage = message.usage as Record<string, unknown> | undefined;
        const model = typeof message.model === "string" ? message.model : undefined;
        if (!usage && !model) continue;
        const input =
          typeof usage?.input_tokens === "number" ? (usage.input_tokens as number) : undefined;
        const output =
          typeof usage?.output_tokens === "number" ? (usage.output_tokens as number) : undefined;
        const total =
          typeof usage?.total_tokens === "number"
            ? (usage.total_tokens as number)
            : input != null && output != null
              ? input + output
              : undefined;
        return {
          model,
          inputTokens: input,
          outputTokens: output,
          totalTokens: total,
        };
      } catch {
        // skip malformed
      }
    }
  } catch {
    // ignore
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return {};
}

function deriveSessionId(filePath: string): string {
  const base = path.basename(filePath);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function deriveCwdLabel(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const trimmed = cwd.trim();
  if (!trimmed) return undefined;
  // Split on both separators: a transcript written on Windows carries a
  // backslash cwd, which path.basename() on POSIX would return whole.
  return (
    trimmed
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || trimmed
  );
}

function extractMetadata(filePath: string): TranscriptMetadata {
  const sessionId = deriveSessionId(filePath);
  const head = readTranscriptHead(filePath);
  const tail = readTranscriptTailUsage(filePath);
  return {
    sessionId,
    cwd: head.cwd,
    cwdLabel: deriveCwdLabel(head.cwd),
    gitBranch: head.gitBranch,
    version: head.version,
    lastModel: tail.model,
    inputTokens: tail.inputTokens,
    outputTokens: tail.outputTokens,
    totalTokens: tail.totalTokens,
  };
}

/**
 * Top-level transcripts live at `<projectsDir>/<one-dir>/<file>.jsonl`. Anything
 * deeper (e.g. `.../subagents/agent-X.jsonl`) is internal state for a parent
 * session and should not appear as a separate row in the activity page.
 */
export function isTopLevelTranscript(filePath: string, projectsDir: string): boolean {
  if (!filePath.endsWith(".jsonl")) return false;
  const rel = path.relative(projectsDir, filePath);
  if (!rel || rel.startsWith("..")) return false;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  return parts.length === 2;
}

function resolveDefaultStorePath(): string {
  try {
    const cfg = loadConfig();
    const storeConfig = cfg.session?.store;
    return resolveStorePath(typeof storeConfig === "string" ? storeConfig : undefined);
  } catch {
    return resolveStorePath();
  }
}

function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function buildSessionEntryPatch(params: {
  meta: TranscriptMetadata;
  filePath: string;
  mtimeMs: number;
  existing: SessionEntry | undefined;
}): Partial<SessionEntry> {
  const { meta, filePath, mtimeMs, existing } = params;
  const labelParts = ["Claude Code"];
  if (meta.cwdLabel) labelParts.push(meta.cwdLabel);
  if (meta.gitBranch && meta.gitBranch !== "main" && meta.gitBranch !== "master") {
    labelParts.push(`@${meta.gitBranch}`);
  }
  const displayName = labelParts.join(" • ");
  return {
    sessionId: meta.sessionId,
    sessionFile: filePath,
    updatedAt: Math.max(existing?.updatedAt ?? 0, mtimeMs),
    channel: "claude-code",
    label: meta.cwdLabel ?? existing?.label,
    displayName,
    model: meta.lastModel ?? existing?.model,
    inputTokens: meta.inputTokens ?? existing?.inputTokens,
    outputTokens: meta.outputTokens ?? existing?.outputTokens,
    totalTokens: meta.totalTokens ?? existing?.totalTokens,
  };
}

/**
 * Start the Claude Code transcript watcher.
 */
export function startClaudeCodeWatcher(
  opts: ClaudeCodeWatcherOptions = {},
): ClaudeCodeWatcherHandle {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const storePath = opts.storePath ?? resolveDefaultStorePath();
  const keyPrefix = opts.keyPrefix ?? SESSION_KEY_PREFIX;
  const flushDebounceMs = opts.flushDebounceMs ?? FLUSH_DEBOUNCE_MS;
  const startupCutoff = opts.processAll ? 0 : Date.now() - STARTUP_FRESHNESS_MS;

  /** filePath → latest mtime we've observed. Drained on each flush. */
  const pending = new Map<string, number>();
  let flushTimer: NodeJS.Timeout | null = null;
  let flushChain: Promise<void> = Promise.resolve();
  let readyResolved = false;
  let resolveReady: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const flushNow = async () => {
    if (pending.size === 0) return;
    const batch = Array.from(pending.entries());
    pending.clear();

    // Build the list of patches outside the lock — the file reads are slow.
    const patches: Array<{
      key: string;
      meta: TranscriptMetadata;
      filePath: string;
      mtimeMs: number;
    }> = [];
    for (const [filePath, mtimeMs] of batch) {
      if (!fs.existsSync(filePath)) continue;
      const meta = extractMetadata(filePath);
      if (!meta.sessionId) continue;
      patches.push({ key: `${keyPrefix}${meta.sessionId}`, meta, filePath, mtimeMs });
    }
    if (patches.length === 0) return;

    try {
      await updateSessionStore(storePath, (store) => {
        for (const p of patches) {
          const existing = store[p.key];
          const patch = buildSessionEntryPatch({
            meta: p.meta,
            filePath: p.filePath,
            mtimeMs: p.mtimeMs,
            existing,
          });
          store[p.key] = mergeSessionEntry(existing, patch);
        }
      });
      log.debug(`flushed ${patches.length} transcript update(s)`);
    } catch (err) {
      log.warn(`batch upsert failed (${patches.length} entries): ${String(err)}`);
    }
  };

  /** Serialize flushes — never two `updateSessionStore` runs in flight. */
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushChain = flushChain.then(flushNow).catch((err) => {
        log.warn(`flush chain error: ${String(err)}`);
      });
    }, flushDebounceMs);
  };

  /**
   * Remove claude-code: rows whose backing file no longer matches a top-level
   * transcript path. Cleans up subagent-derived rows from earlier versions of
   * this watcher and rows whose transcript files were moved/deleted.
   */
  const pruneStaleRows = async () => {
    try {
      const store = loadSessionStore(storePath, { skipCache: true });
      const stale: string[] = [];
      for (const [key, entry] of Object.entries(store)) {
        if (!key.startsWith(keyPrefix)) continue;
        const sessionFile = entry?.sessionFile;
        if (!sessionFile) {
          stale.push(key);
          continue;
        }
        if (!fs.existsSync(sessionFile)) {
          stale.push(key);
          continue;
        }
        if (!isTopLevelTranscript(sessionFile, projectsDir)) {
          stale.push(key);
          continue;
        }
      }
      if (stale.length === 0) return;
      await updateSessionStore(storePath, (s) => {
        for (const key of stale) delete s[key];
      });
      log.info(`pruned ${stale.length} stale claude-code session row(s)`);
    } catch (err) {
      log.warn(`prune failed: ${String(err)}`);
    }
  };

  const watcher: FSWatcher = chokidar.watch(projectsDir, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    depth: 2,
  });

  const recordEvent = (filePath: string, mtimeMs: number) => {
    if (!isTopLevelTranscript(filePath, projectsDir)) return;
    const previous = pending.get(filePath) ?? 0;
    pending.set(filePath, Math.max(previous, mtimeMs));
    scheduleFlush();
  };

  watcher.on("add", (filePath, stats) => {
    const mtimeMs = stats?.mtimeMs ?? Date.now();
    if (mtimeMs < startupCutoff) return;
    recordEvent(filePath, mtimeMs);
  });

  watcher.on("change", (filePath, stats) => {
    const mtimeMs = stats?.mtimeMs ?? Date.now();
    recordEvent(filePath, mtimeMs);
  });

  watcher.on("error", (err) => {
    log.warn(`watcher error: ${String(err)}`);
  });

  watcher.on("ready", () => {
    flushChain = flushChain
      .then(flushNow)
      .then(pruneStaleRows)
      .catch((err) => {
        log.warn(`startup chain error: ${String(err)}`);
      })
      .finally(() => {
        if (!readyResolved) {
          readyResolved = true;
          resolveReady?.();
        }
      });
  });

  log.info(`watching ${projectsDir} → ${storePath}`);

  return {
    projectsDir,
    size: () => pending.size,
    ready: () => readyPromise,
    close: async () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      await watcher.close();
      // Make sure any in-flight flush settles before we return.
      await flushChain.catch(() => undefined);
    },
  };
}

/** Convenience helper for gateway startup — respects INFINIBOT_SKIP_CLAUDE_CODE_WATCHER. */
export function startClaudeCodeWatcherIfEnabled(): ClaudeCodeWatcherHandle | null {
  if (isTruthyEnvValue(process.env.INFINIBOT_SKIP_CLAUDE_CODE_WATCHER)) return null;
  if (!fs.existsSync(defaultProjectsDir())) return null;
  try {
    return startClaudeCodeWatcher();
  } catch (err) {
    log.warn(`failed to start: ${String(err)}`);
    return null;
  }
}
