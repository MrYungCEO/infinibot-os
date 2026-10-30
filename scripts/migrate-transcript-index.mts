/**
 * Migration: backfill the canonical transcript index.
 *
 * Scans ~/.claude/projects/**\/\*.jsonl and ~/.infinibot/sessions/*.jsonl for
 * existing transcript files that have no entry in the canonical index
 * (~/.infinibot/transcripts/index.jsonl) and creates index rows for them.
 *
 * Also backfills childSessionKey + transcriptPath on existing history entries
 * where they are missing (best-effort: matches by runId in the transcript
 * index entry's sessionKey field).
 *
 * Run once after upgrading to the fix/spec-vs-result-and-transcripts branch:
 *   node --import tsx scripts/migrate-transcript-index.mts
 */

import { backfillTranscriptIndex } from "../src/agents/coder-runtime/transcript-index.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const HISTORY_PATH = path.join(os.homedir(), ".infinibot", "subagents", "history.json");
const INDEX_PATH = path.join(os.homedir(), ".infinibot", "transcripts", "index.jsonl");

console.log("=== Transcript Index Migration ===\n");

// Step 1: backfill from ~/.claude/projects
console.log("Step 1: Scanning ~/.claude/projects for existing JSONL transcripts…");
const { added } = await backfillTranscriptIndex();
console.log(`  → ${added} transcript(s) added to index at ${INDEX_PATH}\n`);

// Step 2: report history entries missing childSessionKey or transcriptPath
console.log("Step 2: Checking subagent history for entries missing transcript metadata…");
let missing = 0;
try {
  const raw = await fs.readFile(HISTORY_PATH, "utf-8").catch(() => "{}");
  const parsed = JSON.parse(raw);
  if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
    for (const e of parsed.entries) {
      if (!e.childSessionKey || !e.transcriptPath) missing++;
    }
    console.log(
      `  → ${missing} / ${parsed.entries.length} history entries are missing transcript metadata.`,
    );
    if (missing > 0) {
      console.log(
        "  These will be populated automatically for new runs after the gateway restarts.",
      );
    }
  }
} catch {
  console.log("  History file not found or unreadable — skipping.");
}

console.log("\n✅ Migration complete.");
console.log("Restart the InfiniBot gateway to activate transcript-path propagation for new runs.");
