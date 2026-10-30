/**
 * Canonical transcript index.
 *
 * Maintains a JSONL index at ~/.infinibot/transcripts/index.jsonl that maps
 * every coder run to its JSONL transcript file.  Entries survive gateway restarts
 * and live-registry sweeps, enabling long-term transcript lookup by runId or
 * sessionKey without hitting the session store.
 *
 * Schema (one JSON object per line):
 *   { v:1, runId, sessionKey, agentId, label, spawnedAt, finishedAt?, transcriptPath }
 *
 * The index is append-only (writes never modify existing lines) — it is cheap to
 * write but requires a linear scan to look up an entry.  For the expected scale
 * (thousands of runs per installation) a linear scan is acceptable.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("transcript-index");

function indexPath(): string {
  return path.join(os.homedir(), ".infinibot", "transcripts", "index.jsonl");
}

export interface TranscriptIndexEntry {
  v: 1;
  runId: string;
  sessionKey: string;
  agentId: string;
  label?: string;
  spawnedAt: number;
  finishedAt?: number;
  transcriptPath: string;
}

let writeP: Promise<void> = Promise.resolve();

async function appendEntry(entry: TranscriptIndexEntry): Promise<void> {
  const prev = writeP;
  writeP = prev
    .catch(() => undefined)
    .then(async () => {
      const file = indexPath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf-8");
    });
  await writeP;
}

/**
 * Record a new transcript at spawn time.  Call again with finishedAt on completion.
 * Idempotent by design (append-only; dedup is done at read time by latest entry
 * winning on matching runId).
 */
export async function indexTranscript(entry: Omit<TranscriptIndexEntry, "v">): Promise<void> {
  try {
    await appendEntry({ v: 1, ...entry });
  } catch (err) {
    log.warn("indexTranscript: write failed (best-effort)", {
      runId: entry.runId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Update an existing index entry with finishedAt.  Appends a new line with
 * the updated timestamp; dedup at read time picks the latest.
 */
export async function finalizeTranscriptIndex(
  runId: string,
  transcriptPath: string,
  sessionKey: string,
  agentId: string,
  label: string | undefined,
  spawnedAt: number,
  finishedAt: number,
): Promise<void> {
  try {
    await appendEntry({
      v: 1,
      runId,
      sessionKey,
      agentId,
      label,
      spawnedAt,
      finishedAt,
      transcriptPath,
    });
  } catch (err) {
    log.warn("finalizeTranscriptIndex: write failed (best-effort)", { runId, err: String(err) });
  }
}

/**
 * Look up the transcript path for a given runId.  Returns the LATEST matching
 * entry (highest finishedAt or spawnedAt) so a re-indexed run overwrites the old one.
 */
export async function findTranscriptByRunId(runId: string): Promise<TranscriptIndexEntry | null> {
  try {
    const raw = await fs.readFile(indexPath(), "utf-8");
    let best: TranscriptIndexEntry | null = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TranscriptIndexEntry;
        if (entry.runId !== runId) continue;
        if (!best || (entry.finishedAt ?? entry.spawnedAt) > (best.finishedAt ?? best.spawnedAt)) {
          best = entry;
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Backfill: scan ~/.claude/projects/ subdirs for *.jsonl and create index entries for any
 * JSONL files that have no entry in the index yet (based on file path).
 * Best-effort; logs but never throws.
 */
export async function backfillTranscriptIndex(): Promise<{ added: number }> {
  let added = 0;
  try {
    const claudeProjects = path.join(os.homedir(), ".claude", "projects");
    const projects = await fs.readdir(claudeProjects).catch(() => [] as string[]);
    const indexRaw = await fs.readFile(indexPath(), "utf-8").catch(() => "");
    const indexed = new Set<string>(
      indexRaw
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return (JSON.parse(l) as TranscriptIndexEntry).transcriptPath;
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    );

    for (const proj of projects) {
      const dir = path.join(claudeProjects, proj);
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const absPath = path.join(dir, f);
        if (indexed.has(absPath)) continue;
        // Derive a plausible sessionKey from the filename (strip .jsonl).
        const sessionKey = f.replace(/\.jsonl$/, "");
        try {
          const stat = await fs.stat(absPath);
          await appendEntry({
            v: 1,
            runId: sessionKey,
            sessionKey,
            agentId: "unknown",
            spawnedAt: stat.birthtimeMs || stat.ctimeMs,
            finishedAt: stat.mtimeMs,
            transcriptPath: absPath,
          });
          indexed.add(absPath);
          added++;
        } catch {
          /* skip */
        }
      }
    }
  } catch (err) {
    log.warn("backfillTranscriptIndex: error during backfill", { err: String(err) });
  }
  return { added };
}
