/**
 * Content Intelligence — type definitions.
 *
 * These mirror the tables in the SQLite store at
 * `<stateDir>/content-intel.db`. See {@link store.ts} for the schema.
 */

// ═══════════════════════════════════════════════════════════════════
// ROW TYPES (DB-facing)
// ═══════════════════════════════════════════════════════════════════

/** A reel row — one per Instagram shortcode. */
export interface ReelRow {
  shortcode: string;
  url: string;
  post_id: string;
  publish_time: string; // raw Meta format: "MM/DD/YYYY HH:mm"
  duration_sec: number | null;
  account: string;
  description: string;
  created_at: number; // ms epoch
  updated_at: number; // ms epoch
  // Pipeline state flags (added Phase 1)
  has_video: number; // 0 | 1 — video file exists locally
  has_transcript: number; // 0 | 1 — transcript in store
  has_score: number; // 0 | 1 — score in store
}

/** Snapshot of Meta analytics for a reel at a point in time. */
export interface ReelMetricsRow {
  shortcode: string;
  views: number | null;
  reach: number | null;
  likes: number | null;
  shares: number | null;
  follows: number | null;
  comments: number | null;
  saves: number | null;
  captured_at: number; // ms epoch — when the CSV was exported
}

/** Transcription for a reel. */
export interface TranscriptRow {
  shortcode: string;
  text: string;
  engine: string; // "whisper" | "groq" | "native" | "manual" | ...
  lang: string | null;
  created_at: number;
}

/** AI score for a reel. */
export interface ScoreRow {
  shortcode: string;
  hook: number | null;
  value: number | null;
  viral: number | null;
  overall: number | null;
  tier: string; // "S" | "A" | "B" | "C" | "D"
  reason: string;
  idea_vs_execution: string | null;
  scored_by: string; // agent or model id
  model: string;
  created_at: number;
}

/** Pipeline run audit. */
export interface RunRow {
  id: string; // uuid
  kind: string; // "import" | "transcribe" | "score" | "backfill"
  started_at: number;
  finished_at: number | null;
  status: string; // "running" | "done" | "failed"
  details: string | null; // JSON blob
  reel_count: number;
}

// ═══════════════════════════════════════════════════════════════════
// CSV PARSE TYPES
// ═══════════════════════════════════════════════════════════════════

/** A single row parsed from a Meta Business Suite CSV export. */
export interface ParsedMetaRow {
  postId: string;
  accountId: string;
  accountUsername: string;
  accountName: string;
  description: string;
  durationSec: number | null;
  publishTime: string;
  permalink: string;
  postType: string;
  views: number | null;
  reach: number | null;
  likes: number | null;
  shares: number | null;
  follows: number | null;
  comments: number | null;
  saves: number | null;
}

/** Result of importing a CSV. */
export interface ImportResult {
  file: string;
  totalRows: number;
  igReelRows: number;
  accountFiltered: number;
  inserted: number;
  updated: number;
  errors: string[];
}

/** Backfill progress callback. */
export type BackfillProgress = (msg: string, meta?: Record<string, unknown>) => void;

/** Backfill result. */
export interface BackfillResult {
  csvResults: ImportResult[];
  manifestResult: ImportResult;
  transcriptsInserted: number;
  transcriptsSkipped: number;
  scoresInserted: number;
  scoresSkipped: number;
  totalReels: number;
}

/** A row from the reel-pipeline's scored_manifest.csv. */
export interface ScoredManifestRow {
  shortcode: string;
  hook: number | null;
  value: number | null;
  viral: number | null;
  overall: number | null;
  tier: string;
  reason: string;
  idea_vs_execution: string | null;
  scored_by: string;
}

/** Configuration for the content-intel pipeline (venv path, cookies, etc.). */
export interface ContentIntelConfig {
  /** Path to the Python venv that has faster-whisper, gallery-dl, etc. */
  venvPath: string;
  /** Path to the reel-pipeline directory (for existing artifacts). */
  pipelineDir: string;
  /** Browser to read cookies from for gallery-dl (e.g. "firefox"). */
  cookiesFromBrowser: string;
  /** Directory where downloaded videos are stored. */
  downloadDir: string;
  /** OpenRouter API key (read from env if not set). */
  openrouterApiKey: string;
  /** Primary free model for scoring. */
  primaryModel: string;
  /** Fallback model for scoring. */
  fallbackModel: string;
}

/** Default config values. */
export const DEFAULT_CONTENT_INTEL_CONFIG: ContentIntelConfig = {
  venvPath: "",
  pipelineDir: "",
  cookiesFromBrowser: "firefox",
  downloadDir: "", // defaults to <pipelineDir>/output
  openrouterApiKey: "", // read from env OPENROUTER_API_KEY
  primaryModel: "deepseek/deepseek-chat-v3-0324",
  fallbackModel: "meta-llama/llama-3.3-70b-instruct",
};
