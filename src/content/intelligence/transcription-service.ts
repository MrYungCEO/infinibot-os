/**
 * Transcription service — THIN TS WRAPPER over the vendored Python transcriber.
 *
 * Delegates to transcribe_single.py via child_process.spawn (see pipeline-wrapper.ts).
 * Does NOT reimplement transcription logic in TypeScript.
 *
 * Preserves the public API expected by index.ts / consumers.
 * The STT route resolution (resolveContentSttRoute) is kept for UI display,
 * but actual transcription is handled by the vendored Python faster-whisper script.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getContentIntelStore } from "./store.js";
import { transcribeReel as pipelineTranscribeReel } from "./pipeline-wrapper.js";
import type { TranscriptRow } from "./types.js";

const log = createSubsystemLogger("content-intel-transcription");

// ── Types ────────────────────────────────────────────────────────────────────

/** Which STT backend to use for a content-intel transcription run. */
export type SttChoice = "cloud" | "local" | "auto";

/** Result of a single transcription. */
export interface TranscribeResult {
  shortcode: string;
  text: string;
  engine: string;
  success: boolean;
  error?: string;
}

/** Result of a batch run. */
export interface BatchTranscribeResult {
  transcribed: number;
  skipped: number;
  failed: number;
  total: number;
}

export interface SttRouteInfo {
  kind: "cloud" | "native" | "docker" | "unconfigured";
  provider: string | null;
  hasKey: boolean;
  error: string | null;
  /** Human-readable description for UI display. */
  label: string;
}

// ── Route resolution (kept for UI display — always reports local now) ──────

/**
 * Resolve the STT route for content-intel transcription.
 *
 * The vendored pipeline uses faster-whisper locally (GPU large-v3).
 * We report "native" as the available route since that's what the
 * Python script uses. In future phases, this can route to cloud STT.
 */
export function resolveContentSttRoute(_choice: SttChoice = "auto"): SttRouteInfo {
  return {
    kind: "native",
    provider: "faster-whisper (large-v3)",
    hasKey: false,
    error: null,
    label: "faster-whisper large-v3 (local GPU)",
  };
}

// ── Transcribe a single audio buffer (delegates to Python) ───────────────────

/**
 * Transcribe a single audio file for a reel via the vendored Python script.
 *
 * @param shortcode reel shortcode (for store write + logging)
 * @param _audio ignored — the wrapper reads directly from the video file
 * @param opts options
 * @returns transcript result
 */
export async function transcribeAudio(
  shortcode: string,
  _audio: Buffer,
  opts?: {
    encoding?: string;
    language?: string;
    choice?: SttChoice;
  },
): Promise<TranscribeResult> {
  // The vendored Python script reads the video file directly from disk.
  // We pass the shortcode and it finds the video in the pipeline output dir.
  const result = await pipelineTranscribeReel(shortcode, undefined, {
    // Pass language hint if provided (unused by transcribe_single.py currently)
  });

  return result;
}

// ── Store write helper ───────────────────────────────────────────────────────

/**
 * Transcribe a reel and write the result into the content-intel store.
 * If the reel already has a transcript, it's overwritten (upsert).
 */
export async function transcribeAndStore(
  shortcode: string,
  audio: Buffer,
  opts?: {
    encoding?: string;
    language?: string;
    choice?: SttChoice;
  },
): Promise<TranscribeResult> {
  const result = await transcribeAudio(shortcode, audio, opts);

  if (result.success && result.text) {
    const store = getContentIntelStore();
    const row: TranscriptRow = {
      shortcode,
      text: result.text,
      engine: result.engine,
      lang: opts?.language ?? null,
      created_at: Date.now(),
    };
    store.upsertTranscript(row);
    log.info("transcript stored", { shortcode, engine: result.engine, chars: result.text.length });
  }

  return result;
}

// ── Batch: transcribe all reels without transcripts ──────────────────────────

export type TranscribeProgress = (msg: string, meta?: Record<string, unknown>) => void;

/**
 * Transcribe all reels that don't yet have a transcript.
 * Resumable: skips reels that already have a transcript in the store.
 *
 * @param _audioSource ignored — the pipeline wrapper reads from the video files directly
 * @param opts options
 */
export async function transcribeAllMissing(
  _audioSource: (shortcode: string) => Promise<Buffer | null>,
  opts?: {
    choice?: SttChoice;
    encoding?: string;
    language?: string;
    limit?: number;
    signal?: AbortSignal;
    progress?: TranscribeProgress;
  },
): Promise<BatchTranscribeResult> {
  const store = getContentIntelStore();
  const reels = store.listReels(10000);
  const progress = opts?.progress ?? (() => {});
  const limit = opts?.limit;

  let transcribed = 0;
  let skipped = 0;
  let failed = 0;
  const total = reels.length;

  for (const reel of reels) {
    if (opts?.signal?.aborted) break;

    // Skip already-transcribed
    const existing = store.getTranscript(reel.shortcode);
    if (existing?.text) {
      skipped++;
      continue;
    }

    // Skip if no video file
    if (!reel.has_video) {
      skipped++;
      continue;
    }

    if (limit && transcribed >= limit) break;

    progress("transcribing", { shortcode: reel.shortcode, index: transcribed + 1, total });

    const result = await pipelineTranscribeReel(reel.shortcode);

    if (result.success) {
      transcribed++;
      progress("transcribed", { shortcode: reel.shortcode, chars: result.text.length });
    } else {
      failed++;
      progress("transcription failed", { shortcode: reel.shortcode, error: result.error });
    }
  }

  progress("batch complete", { transcribed, skipped, failed, total });
  return { transcribed, skipped, failed, total };
}
