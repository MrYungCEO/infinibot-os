/**
 * Scoring service — THIN TS WRAPPER over the vendored Python scorer.
 *
 * Delegates to score_single.py via child_process.spawn (see pipeline-wrapper.ts).
 * Does NOT reimplement scoring logic in TypeScript.
 *
 * Preserves the public API expected by index.ts / consumers.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getContentIntelStore } from "./store.js";
import { scoreReel as pipelineScoreReel } from "./pipeline-wrapper.js";
import type { ContentIntelConfig } from "./types.js";
import type { ScoreResult as WrapperScoreResult, SyncResult } from "./pipeline-wrapper.js";
// Viral-format intelligence: score reels RELATIVE to what wins in their niche.
import { detectNiche } from "../viral-formats/taxonomy.js";
import { extractFormatFeatures } from "../viral-formats/format-framework.js";
import { getViralFormatsStore } from "../viral-formats/benchmark-store.js";
import {
  scoreAgainstNicheBenchmark,
  type RelativeScore,
} from "../viral-formats/relative-scoring.js";

export type { RelativeScore } from "../viral-formats/relative-scoring.js";

/**
 * Compute the niche-relative benchmark verdict for a reel. PURE-ish (reads the
 * benchmark + reel rows from the stores). Fully guarded: any missing data or
 * thrown error yields `undefined` so the absolute score path is never broken.
 */
export function relativeScoreForReel(
  shortcode: string,
  transcript?: string | null,
): RelativeScore | undefined {
  try {
    const reel = getContentIntelStore().getReel(shortcode);
    const caption = reel?.description ?? null;
    const durationSec = reel?.duration_sec ?? null;
    const det = detectNiche({ transcript, caption });
    const feats = extractFormatFeatures({ transcript, caption, durationSec });
    const benchmark = getViralFormatsStore().getNicheBenchmark(det.niche, det.subniche);
    return scoreAgainstNicheBenchmark(feats, benchmark);
  } catch (err) {
    log.warn("relativeScoreForReel failed (non-fatal)", {
      shortcode,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

const log = createSubsystemLogger("content-intel-scoring");

// ── Re-exported types ────────────────────────────────────────────────────────

export interface ValidatedScore {
  shortcode: string;
  hook: number;
  value: number;
  viral: number;
  overall: number;
  tier: string;
  reason: string;
  idea_vs_execution: string;
}

export interface ScoreProgress {
  (msg: string, meta?: Record<string, unknown>): void;
}

export interface ScoreResult {
  scored: number;
  skipped: number;
  failed: number;
  total: number;
}

export {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  tierFromScore,
  extractScoreJson,
  validateScore,
} from "./scoring-legacy.js";

// ── Score a single reel (delegates to Python) ────────────────────────────────

/**
 * Score a single reel via the vendored OpenRouter scoring script.
 * If the reel already has a score in the store, returns that.
 *
 * @param reel - reel row (used for metadata)
 * @param metrics - latest metrics (used for context)
 * @param transcript - transcript text
 * @param apiKey - OpenRouter API key
 * @param opts - optional overrides
 * @returns validated score + model name, or null on failure
 */
export async function scoreReel(
  reel: { shortcode: string },
  _metrics: unknown,
  _transcript: string,
  apiKey: string,
  opts?: {
    primaryModel?: string;
    fallbackModel?: string;
    signal?: AbortSignal;
  },
): Promise<{ score: ValidatedScore; model: string; relative?: RelativeScore } | null> {
  const config: Partial<ContentIntelConfig> = {
    openrouterApiKey: apiKey,
  };
  if (opts?.primaryModel) config.primaryModel = opts.primaryModel;
  if (opts?.fallbackModel) config.fallbackModel = opts.fallbackModel;

  const result = await pipelineScoreReel(reel.shortcode, config);

  if (!result.success || result.overall == null) {
    log.warn("scoreReel failed", { shortcode: reel.shortcode, error: result.error });
    return null;
  }

  return {
    score: {
      shortcode: reel.shortcode,
      hook: result.hook ?? 0,
      value: result.value ?? 0,
      viral: result.viral ?? 0,
      overall: result.overall ?? 0,
      tier: result.tier,
      reason: result.reason,
      idea_vs_execution: result.idea_vs_execution ?? "",
    },
    model: result.model,
    // Niche-relative benchmark verdict (undefined if benchmark is thin/unavailable).
    relative: relativeScoreForReel(reel.shortcode, _transcript),
  };
}

// ── Batch scoring: score all unscored reels ──────────────────────────────────

/**
 * Score all unscored reels (resumable — skips already-scored).
 * Delegates to the Python pipeline's sync gaps logic.
 */
export async function scoreAllUnscored(
  apiKey: string,
  opts?: {
    limit?: number;
    primaryModel?: string;
    fallbackModel?: string;
    signal?: AbortSignal;
    progress?: ScoreProgress;
  },
): Promise<ScoreResult> {
  const progress = opts?.progress ?? (() => {});

  progress("scoring: scanning for unscored reels");

  // Use the incremental gap sync, but only for the scoring step
  const config: Partial<ContentIntelConfig> = {
    openrouterApiKey: apiKey,
  };
  if (opts?.primaryModel) config.primaryModel = opts.primaryModel;
  if (opts?.fallbackModel) config.fallbackModel = opts.fallbackModel;

  // The syncGaps function processes download → transcribe → score.
  // We want only the "score" step for existing transcripts.
  // However, the pipeline-wrapper's syncGaps does all three steps.
  // For now, we use the store's listReelsMissingScore and score each individually.
  const store = getContentIntelStore();
  const reels = store.listReels(10000);
  const total = reels.length;

  let scored = 0;
  let skipped = 0;
  let failed = 0;
  const limit = opts?.limit;

  for (const reel of reels) {
    if (opts?.signal?.aborted) break;

    // Skip already scored (check fresh)
    const existing = store.getScore(reel.shortcode);
    if (existing) {
      skipped++;
      continue;
    }

    // Skip if no transcript
    const transcriptRow = store.getTranscript(reel.shortcode);
    if (!transcriptRow?.text) {
      skipped++;
      continue;
    }

    if (limit && scored >= limit) break;

    progress("scoring", { shortcode: reel.shortcode, index: scored + 1, total });

    const result = await scoreReel(
      reel,
      store.getLatestMetrics(reel.shortcode),
      transcriptRow.text,
      apiKey,
      {
        primaryModel: opts?.primaryModel,
        fallbackModel: opts?.fallbackModel,
        signal: opts?.signal,
      },
    );

    if (result) {
      scored++;
      progress("scored", {
        shortcode: reel.shortcode,
        overall: result.score.overall,
        tier: result.score.tier,
      });
    } else {
      failed++;
    }

    // Courtesy delay
    if (limit && scored < limit) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  progress("scoring complete", { scored, skipped, failed, total });
  return { scored, skipped, failed, total };
}
