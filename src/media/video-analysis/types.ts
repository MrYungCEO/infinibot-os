/**
 * Video analysis types.
 *
 * A video is an ordinary auto-OCR registry entry (src/ocr) handled by the
 * "video" extraction handler. Its sidecar carries:
 *   - `video`      — the VideoBlock below (probe, chunks, keyframes, transcript…)
 *   - `markdown`   — transcript + on-screen text (what search and memory index)
 *   - `analyses[]` — one OcrAnalysis per specialist-agent review, whose
 *                    `data` is a VideoAnalysisData.
 */

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  hasAudio: boolean;
  bitrate: number | null;
  format: string | null;
  rotation: number;
  creationTime: string | null;
}

export interface VideoChunk {
  index: number;
  start: number;
  end: number;
  done: boolean;
}

export interface VideoKeyframe {
  /** Frame-store name, e.g. "k0007". */
  id: string;
  /** Seconds from the start. */
  t: number;
  /** Scene-change score 0..1 (0 for coverage fill frames). */
  score: number;
  /** On-screen text from the OCR engine (omitted when none). */
  ocr?: { text: string; confidence: number | null };
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface VideoBlock {
  version: 1;
  meta: VideoMeta;
  /** Frame-store key (sha256 prefix): frames survive renames/moves. */
  frameKey: string;
  chunkSec: number;
  chunks: VideoChunk[];
  keyframes: VideoKeyframe[];
  contactSheet: { id: string; times: number[]; cols: number; rows: number } | null;
  transcript: {
    engine: string | null;
    model: string | null;
    language: string | null;
    segments: TranscriptSegment[];
  };
  proxy: { id: string; bytes: number; height: number } | null;
}

export type VideoAnalysisStatus = "queued" | "running" | "done" | "failed";

export interface VideoObservation {
  t?: number;
  text: string;
}

export interface VideoEntity {
  name: string;
  type?: string;
  t?: number;
  confidence?: number;
}

export interface VideoMoment {
  t: number;
  label: string;
  detail?: string;
  /** Frame-store name of the thumbnail captured at `t`. */
  frameId?: string;
}

export interface VideoFollowUp {
  id: string;
  question: string;
  /** Seconds the agent looked at (frames extracted at these times). */
  times: number[];
  status: VideoAnalysisStatus;
  answer?: string;
  frames: Array<{ t: number; frameId: string }>;
  model?: string | null;
  error?: string;
  createdAt: number;
}

export interface VideoFindings {
  summary: string;
  observations: VideoObservation[];
  entities: VideoEntity[];
  moments: VideoMoment[];
  /** Overall confidence 0..1. */
  confidence: number | null;
  openQuestions: string[];
}

/** `OcrAnalysis.data` for analyzer "video-analyst". */
export interface VideoAnalysisData extends Partial<VideoFindings> {
  kind: "video-analysis";
  status: VideoAnalysisStatus;
  agentName: string;
  error?: string;
  /** Keyframe ids shown to the model. */
  framesUsed?: string[];
  followUps?: VideoFollowUp[];
  startedAt?: number;
  finishedAt?: number;
}

export const VIDEO_ANALYZER = "video-analyst";
export const VIDEO_EXTS = [".mp4", ".mov", ".webm", ".mkv", ".m4v"] as const;
export const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};
