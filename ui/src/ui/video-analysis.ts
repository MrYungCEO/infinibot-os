/**
 * Shared types + helpers for the video analysis UI (components/video-detail.ts,
 * the Files page and chat attachments). Mirrors src/media/video-analysis/types.ts.
 */

export type VideoJobStatus = "queued" | "running" | "done" | "failed";

export interface VideoKeyframeInfo {
  id: string;
  t: number;
  score: number;
  ocr?: { text: string; confidence: number | null };
}

export interface VideoBlockInfo {
  version: 1;
  meta: { duration: number; width: number; height: number; hasAudio: boolean; vcodec: string | null; fps: number | null };
  frameKey: string;
  chunks: Array<{ index: number; start: number; end: number; done: boolean }>;
  keyframes: VideoKeyframeInfo[];
  contactSheet: { id: string; times: number[]; cols: number; rows: number } | null;
  transcript: {
    engine: string | null;
    model: string | null;
    language: string | null;
    segments: Array<{ start: number; end: number; text: string }>;
  };
  proxy: { id: string; bytes: number; height: number } | null;
}

export interface VideoFollowUpInfo {
  id: string;
  question: string;
  times: number[];
  status: VideoJobStatus;
  answer?: string;
  frames: Array<{ t: number; frameId: string }>;
  model?: string | null;
  error?: string;
  createdAt: number;
}

export interface VideoAnalysisInfo {
  id: string;
  analyzer: string;
  agentId?: string;
  model?: string | null;
  createdAt: number;
  summary: string;
  data?: {
    kind: "video-analysis";
    status: VideoJobStatus;
    agentName: string;
    error?: string;
    summary?: string;
    observations?: Array<{ t?: number; text: string }>;
    entities?: Array<{ name: string; type?: string; t?: number; confidence?: number }>;
    moments?: Array<{ t: number; label: string; detail?: string; frameId?: string }>;
    confidence?: number | null;
    openQuestions?: string[];
    followUps?: VideoFollowUpInfo[];
  };
}

export interface VideoGetResult {
  found: boolean;
  lane?: "normal" | "secure";
  entry?: {
    id: string;
    name: string;
    status: "queued" | "processing" | "done" | "failed";
    progress?: { done: number; total: number; stage: string };
    error?: string;
    sha256: string;
    relPath?: string | null;
  };
  video?: VideoBlockInfo | null;
  description?: string | null;
  entities?: string[];
  warnings: string[];
  analyses: VideoAnalysisInfo[];
  jobs?: Array<{ id: string; kind: string; agentId: string; analysisId: string; status: VideoJobStatus; error?: string }>;
}

export interface VideoAnalystOption {
  agentId: string;
  name: string;
  tagline: string;
  icon: string;
  kind: "template" | "agent";
  exists: boolean;
}

const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv)$/i;

export function isVideoFileName(name: string | null | undefined): boolean {
  return VIDEO_RE.test(name ?? "");
}

export function isVideoMime(mime: string | null | undefined): boolean {
  return /^video\//i.test(mime ?? "");
}

/** 83.4 → "01:23", 3725 → "1:02:05". */
export function formatTimecode(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

/** Timecodes typed in a question ("look at 01:23 and 1:40") → seconds. */
export function parseTimecodeInput(text: string): number[] {
  const out: number[] = [];
  const re = /(?<![\d:])(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?![\d:])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const t = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
    if (Number.isFinite(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Distinct, premium palette for per-agent markers (gold first). */
const PALETTE = ["#e3bd5f", "#6fd3c1", "#a99bff", "#ff8fa3", "#7fb8ff", "#b5e08a"];

export function analysisColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}
