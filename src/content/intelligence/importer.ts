/**
 * Meta CSV importer + one-shot backfill.
 *
 * The importer is idempotent: re-importing the same CSV will upsert
 * (not duplicate) reels, and insert a new metrics snapshot row each
 * time (so historical snapshots accumulate).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveReelPipelineSettings } from "../../content-studio/config.js";
import { getContentIntelStore } from "./store.js";
import { parseMetaCsv, parseShortcode } from "./csv-parser.js";
import type {
  ImportResult,
  BackfillResult,
  BackfillProgress,
  ReelRow,
  ReelMetricsRow,
  TranscriptRow,
  ScoreRow,
} from "./types.js";

/**
 * Default account filter — empty means no filter (ingest all accounts).
 * Set the CONTENT_INTEL_ACCOUNT env var to restrict to a single handle.
 */
export const DEFAULT_ACCOUNT = process.env.CONTENT_INTEL_ACCOUNT ?? "";

/** Only IG reel post type is ingested (skip carousel, stories, etc.). */
const IG_REEL_TYPE = "IG reel";

/** Reel-pipeline path — empty cleanly disables imports that need external files. */
function reelPipelinePath(...parts: string[]): string {
  const { pipelineDir } = resolveReelPipelineSettings();
  return pipelineDir ? join(pipelineDir, ...parts) : "";
}

/** Downloads dir — where Meta Business Suite CSVs land. */
const DOWNLOADS_DIR = `${process.env.HOME ?? ""}/Downloads`;

// ═══════════════════════════════════════════════════════════════════
// PIPELINE VIDEO FILE HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Scan the reel-pipeline output directory and build a shortcode → video path map.
 * gallery-dl names files by media ID (numeric), with shortcodes embedded in JSON sidecars.
 */
function buildVideoMap(outputDir: string = reelPipelinePath("output")): Map<string, string> {
  const videoMap = new Map<string, string>();
  if (!existsSync(outputDir)) return videoMap;

  const entries = readdirSync(outputDir);
  for (const entry of entries) {
    const entryPath = join(outputDir, entry);
    if (!existsSync(entryPath) || !existsSync(`${entryPath}/instagram`)) continue;
    // gallery-dl structure: output/instagram/<username>/
    const accountDir = join(entryPath, "instagram");
    if (!existsSync(accountDir)) continue;
    const accounts = readdirSync(accountDir);
    for (const acct of accounts) {
      const acctPath = join(accountDir, acct);
      if (!existsSync(acctPath)) continue;
      const files = readdirSync(acctPath);
      for (const file of files) {
        if (!file.endsWith(".mp4.json")) continue;
        const jsonPath = join(acctPath, file);
        try {
          const text = readFileSync(jsonPath, "utf-8");
          const data = JSON.parse(text);
          const list = Array.isArray(data) ? data : [data];
          const shortcode = list[0]?.shortcode ?? list[0]?.post_shortcode ?? "";
          if (shortcode) {
            const mp4 = file.replace(/\.mp4\.json$/, ".mp4");
            const mp4Path = join(acctPath, mp4);
            if (existsSync(mp4Path)) {
              videoMap.set(shortcode, mp4Path);
            }
          }
        } catch {
          // skip unparseable sidecars
        }
      }
    }
  }
  return videoMap;
}

/**
 * Scan and update has_video flags for all reels in the store
 * by checking against pipeline output files.
 */
export function syncVideoFlags(): { set: number; missing: number } {
  const store = getContentIntelStore();
  const videoMap = buildVideoMap();
  const allReels = store.listReels(10000);
  let set = 0;
  let missing = 0;

  for (const reel of allReels) {
    if (videoMap.has(reel.shortcode)) {
      store.setHasVideo(reel.shortcode, true);
      set++;
    } else {
      missing++;
    }
  }
  return { set, missing };
}

/**
 * Sync flags for a specific shortcode — check if video file exists.
 */
export function checkVideoExists(shortcode: string): boolean {
  const videoMap = buildVideoMap();
  return videoMap.has(shortcode);
}

/**
 * Import a single Meta CSV file into the store.
 *
 * @param filePath absolute path to the CSV
 * @param accountFilter only ingest rows matching this username (empty = all)
 * @param capturedAt override the `captured_at` timestamp for metrics (default: now)
 */
export function importMetaCsv(
  filePath: string,
  accountFilter: string = DEFAULT_ACCOUNT,
  capturedAt: number = Date.now(),
): ImportResult {
  const result: ImportResult = {
    file: basename(filePath),
    totalRows: 0,
    igReelRows: 0,
    accountFiltered: 0,
    inserted: 0,
    updated: 0,
    errors: [],
  };

  if (!existsSync(filePath)) {
    result.errors.push(`file not found: ${filePath}`);
    return result;
  }

  const text = readFileSync(filePath, "utf-8");
  const rows = parseMetaCsv(text);
  result.totalRows = rows.length;

  const store = getContentIntelStore();
  const videoMap = buildVideoMap();

  for (const row of rows) {
    // Filter: IG reel only
    if (row.postType !== IG_REEL_TYPE) continue;
    result.igReelRows++;

    // Filter: account
    if (accountFilter && row.accountUsername !== accountFilter) continue;
    result.accountFiltered++;

    // Extract shortcode from permalink
    const shortcode = parseShortcode(row.permalink);
    if (!shortcode) {
      result.errors.push(`no shortcode in permalink: ${row.permalink}`);
      continue;
    }

    const now = Date.now();
    // Check if video already exists in pipeline output
    const hasVideo = videoMap.has(shortcode) ? 1 : 0;
    // Check if transcript already exists (will be updated after import)
    const existingTranscript = store.getTranscript(shortcode);

    const reelRow: ReelRow = {
      shortcode,
      url: row.permalink,
      post_id: row.postId,
      publish_time: row.publishTime,
      duration_sec: row.durationSec,
      account: row.accountUsername,
      description: row.description,
      has_video: hasVideo,
      has_transcript: existingTranscript ? 1 : 0,
      has_score: 0, // set after score import
      created_at: now,
      updated_at: now,
    };

    const wasNew = store.upsertReel(reelRow);
    if (wasNew) result.inserted++;
    else result.updated++;

    // Insert metrics snapshot
    const metricsRow: ReelMetricsRow = {
      shortcode,
      views: row.views,
      reach: row.reach,
      likes: row.likes,
      shares: row.shares,
      follows: row.follows,
      comments: row.comments,
      saves: row.saves,
      captured_at: capturedAt,
    };
    store.insertMetrics(metricsRow);
  }

  // Audit run
  store.insertRun({
    id: randomUUID(),
    kind: "import",
    started_at: capturedAt,
    finished_at: Date.now(),
    status: "done",
    details: JSON.stringify({ file: filePath, result }),
    reel_count: result.inserted + result.updated,
  });

  return result;
}

/**
 * Parse the reel-pipeline manifest CSV and upsert reels + metrics.
 *
 * The manifest has a different (simpler) format:
 *   shortcode,url,post_id,publish_time,duration_sec,views,reach,likes,shares,follows,comments,saves,description
 */
export function importManifest(
  manifestPath: string = reelPipelinePath("data", "manifest.csv"),
  capturedAt: number = Date.now(),
): ImportResult {
  const result: ImportResult = {
    file: basename(manifestPath),
    totalRows: 0,
    igReelRows: 0,
    accountFiltered: 0,
    inserted: 0,
    updated: 0,
    errors: [],
  };

  if (!existsSync(manifestPath)) {
    result.errors.push(`manifest not found: ${manifestPath}`);
    return result;
  }

  const text = readFileSync(manifestPath, "utf-8");
  const lines = text.trim().split("\n");
  if (lines.length < 2) {
    result.errors.push("manifest is empty");
    return result;
  }

  // Parse header
  const header = lines[0].split(",").map((h) => h.trim());
  const colIndex: Record<string, number> = {};
  header.forEach((h, i) => {
    colIndex[h] = i;
  });

  const store = getContentIntelStore();
  const now = Date.now();
  const videoMap = buildVideoMap();

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(",");
    if (fields.length < header.length) continue;
    result.totalRows++;

    const shortcode = fields[colIndex["shortcode"]]?.trim() ?? "";
    if (!shortcode) {
      result.errors.push(`line ${i}: missing shortcode`);
      continue;
    }

    // Check if video file exists
    const hasVideo = videoMap.has(shortcode) ? 1 : 0;

    const reelRow: ReelRow = {
      shortcode,
      url: fields[colIndex["url"]]?.trim() ?? "",
      post_id: fields[colIndex["post_id"]]?.trim() ?? "",
      publish_time: fields[colIndex["publish_time"]]?.trim() ?? "",
      duration_sec: Number(fields[colIndex["duration_sec"]]?.trim() ?? "") || null,
      account: fields[colIndex["account"]]?.trim() ?? DEFAULT_ACCOUNT,
      description: fields[colIndex["description"]]?.trim() ?? "",
      has_video: hasVideo,
      has_transcript: 0, // set after we import transcripts
      has_score: 0, // set after we import scores
      created_at: now,
      updated_at: now,
    };

    const wasNew = store.upsertReel(reelRow);
    if (wasNew) result.inserted++;
    else result.updated++;

    // Insert metrics snapshot from manifest
    const metricsRow: ReelMetricsRow = {
      shortcode,
      views: Number(fields[colIndex["views"]]?.trim() ?? "") || null,
      reach: Number(fields[colIndex["reach"]]?.trim() ?? "") || null,
      likes: Number(fields[colIndex["likes"]]?.trim() ?? "") || null,
      shares: Number(fields[colIndex["shares"]]?.trim() ?? "") || null,
      follows: Number(fields[colIndex["follows"]]?.trim() ?? "") || null,
      comments: Number(fields[colIndex["comments"]]?.trim() ?? "") || null,
      saves: Number(fields[colIndex["saves"]]?.trim() ?? "") || null,
      captured_at: capturedAt,
    };
    store.insertMetrics(metricsRow);
  }

  // Audit run
  store.insertRun({
    id: randomUUID(),
    kind: "import",
    started_at: capturedAt,
    finished_at: Date.now(),
    status: "done",
    details: JSON.stringify({ file: manifestPath, result }),
    reel_count: result.inserted + result.updated,
  });

  return result;
}

/**
 * Import all transcripts from the reel-pipeline transcripts/ dir.
 *
 * Each file is named `<shortcode>.txt` and contains the Whisper transcript.
 */
export function importTranscripts(transcriptsDir: string = reelPipelinePath("transcripts")): {
  inserted: number;
  skipped: number;
} {
  const store = getContentIntelStore();
  let inserted = 0;
  let skipped = 0;

  if (!existsSync(transcriptsDir)) {
    return { inserted, skipped };
  }

  const files = readdirSync(transcriptsDir).filter((f) => f.endsWith(".txt"));
  const now = Date.now();

  for (const file of files) {
    const shortcode = file.replace(/\.txt$/, "");
    const text = readFileSync(join(transcriptsDir, file), "utf-8").trim();
    if (!text) {
      skipped++;
      continue;
    }

    const row: TranscriptRow = {
      shortcode,
      text,
      engine: "whisper",
      lang: null,
      created_at: now,
    };
    store.upsertTranscript(row);
    store.setHasTranscript(shortcode, true);
    inserted++;
  }

  return { inserted, skipped };
}

/**
 * Import existing scores from the reel-pipeline's scored_manifest.csv.
 *
 * The scored_manifest has the same columns as manifest.csv plus:
 *   hook, value, viral, overall, tier, reason, idea_vs_execution, scored_by
 *
 * This is idempotent — upserts by shortcode.
 */
export function importScoredManifest(
  scoredPath: string = reelPipelinePath("data", "scored_manifest.csv"),
): {
  inserted: number;
  skipped: number;
} {
  const result = { inserted: 0, skipped: 0 };
  if (!existsSync(scoredPath)) return result;

  const text = readFileSync(scoredPath, "utf-8");
  const lines = text.trim().split("\n");
  if (lines.length < 2) return result;

  const header = lines[0].split(",").map((h) => h.trim());
  const colIndex: Record<string, number> = {};
  header.forEach((h, i) => {
    colIndex[h] = i;
  });

  const store = getContentIntelStore();
  const now = Date.now();

  for (let i = 1; i < lines.length; i++) {
    // Use the header to split properly — handle potential embedded commas
    const fields = lines[i].split(",");
    if (fields.length < header.length) continue;

    const shortcode = fields[colIndex["shortcode"]]?.trim() ?? "";
    if (!shortcode) continue;

    const parseNum = (key: string): number | null => {
      const v = fields[colIndex[key]]?.trim() ?? "";
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const scoreRow: ScoreRow = {
      shortcode,
      hook: parseNum("hook"),
      value: parseNum("value"),
      viral: parseNum("viral"),
      overall: parseNum("overall"),
      tier: fields[colIndex["tier"]]?.trim() ?? "C",
      reason: fields[colIndex["reason"]]?.trim() ?? "",
      idea_vs_execution: fields[colIndex["idea_vs_execution"]]?.trim() ?? null,
      scored_by: fields[colIndex["scored_by"]]?.trim() ?? "unknown",
      model: fields[colIndex["scored_by"]]?.trim() ?? "unknown",
      created_at: now,
    };

    const wasNew = store.upsertScore(scoreRow);
    store.setHasScore(shortcode, true);
    if (wasNew) result.inserted++;
    else result.skipped++;
  }

  return result;
}

/**
 * One-shot backfill: imports the 3 Meta CSVs from ~/Downloads, the
 * existing reel-pipeline manifest, and all transcripts.
 */
export async function backfillAll(opts?: {
  accountFilter?: string;
  downloadsDir?: string;
  manifestPath?: string;
  transcriptsDir?: string;
  scoredManifestPath?: string;
  progress?: BackfillProgress;
}): Promise<BackfillResult> {
  const account = opts?.accountFilter ?? DEFAULT_ACCOUNT;
  const downloadsDir = opts?.downloadsDir ?? DOWNLOADS_DIR;
  const manifestPath = opts?.manifestPath ?? reelPipelinePath("data", "manifest.csv");
  const transcriptsDir = opts?.transcriptsDir ?? reelPipelinePath("transcripts");
  const scoredManifestPath =
    opts?.scoredManifestPath ?? reelPipelinePath("data", "scored_manifest.csv");
  const progress = opts?.progress ?? (() => {});

  const csvResults: ImportResult[] = [];

  // 1. Import Meta CSVs from Downloads
  const csvFiles = existsSync(downloadsDir)
    ? readdirSync(downloadsDir)
        .filter((f) => f.startsWith("Jan-01-") && f.endsWith(".csv"))
        .map((f) => join(downloadsDir, f))
    : [];

  for (const csvFile of csvFiles) {
    progress("importing Meta CSV", { file: csvFile });
    const res = importMetaCsv(csvFile, account);
    csvResults.push(res);
    progress("Meta CSV done", {
      file: res.file,
      inserted: res.inserted,
      updated: res.updated,
      errors: res.errors.length,
    });
  }

  // 2. Import reel-pipeline manifest (has all 181 reels)
  progress("importing manifest", { manifestPath });
  const manifestResult = importManifest(manifestPath);
  progress("manifest done", {
    inserted: manifestResult.inserted,
    updated: manifestResult.updated,
  });

  // 3. Import transcripts
  progress("importing transcripts", { transcriptsDir });
  const transcriptRes = importTranscripts(transcriptsDir);
  progress("transcripts done", transcriptRes);

  // 4. Import existing scores from scored_manifest.csv
  progress("importing scores", { scoredManifestPath });
  const scoreRes = importScoredManifest(scoredManifestPath);
  progress("scores done", scoreRes);

  // 5. Sync video flags from pipeline output
  progress("syncing video flags");
  const videoSync = syncVideoFlags();
  progress("video flags synced", videoSync);

  // 6. Final count
  const store = getContentIntelStore();
  const totalReels = store.countReels();

  return {
    csvResults,
    manifestResult,
    transcriptsInserted: transcriptRes.inserted,
    transcriptsSkipped: transcriptRes.skipped,
    scoresInserted: scoreRes.inserted,
    scoresSkipped: scoreRes.skipped,
    totalReels,
  };
}
