/**
 * Pure planning helpers: chunking, adaptive keyframe selection, timecodes.
 * No I/O here — ./ffmpeg.ts runs the commands, these decide what to run.
 */
import type { VideoChunk } from "./types.js";

export interface SamplingLimits {
  /** Seconds per processing chunk (long videos are processed chunk by chunk). */
  chunkSec: number;
  /** Hard cap on keyframes for the whole video. */
  maxFrames: number;
  /** Never keep two keyframes closer than this (seconds). */
  minGapSec: number;
  /** Coverage fill: no gap between keyframes longer than this (seconds). */
  maxGapSec: number;
}

export const DEFAULT_LIMITS: SamplingLimits = {
  chunkSec: 300,
  maxFrames: 48,
  minGapSec: 2,
  maxGapSec: 20,
};

/** Split [0, duration) into chunks; a short tail (< 25% of a chunk) joins the previous one. */
export function planChunks(duration: number, chunkSec: number): VideoChunk[] {
  const d = Math.max(0, duration);
  const size = Math.max(10, chunkSec);
  if (d <= 0) return [{ index: 0, start: 0, end: 0, done: false }];
  const out: VideoChunk[] = [];
  for (let start = 0, i = 0; start < d; start += size, i++) {
    out.push({
      index: i,
      start: round3(start),
      end: round3(Math.min(d, start + size)),
      done: false,
    });
  }
  if (out.length > 1) {
    const tail = out[out.length - 1];
    if (tail.end - tail.start < size * 0.25) {
      out.pop();
      out[out.length - 1].end = tail.end;
    }
  }
  return out;
}

/** Keyframe budget for the whole video: ~1 per 5 s, at least 6, capped. */
export function frameBudget(duration: number, maxFrames: number): number {
  return Math.max(Math.min(6, maxFrames), Math.min(maxFrames, Math.ceil(duration / 5)));
}

/** Share of the budget a chunk gets (proportional to its length, at least 2). */
export function chunkBudget(chunk: VideoChunk, duration: number, total: number): number {
  if (duration <= 0) return Math.min(total, 2);
  return Math.max(2, Math.round((total * (chunk.end - chunk.start)) / duration));
}

export interface SceneCandidate {
  t: number;
  score: number;
}

/** Parse `showinfo` lines (pts_time) + `scene_score` metadata from ffmpeg stderr. */
export function parseSceneLog(stderr: string, offset = 0): SceneCandidate[] {
  const out: SceneCandidate[] = [];
  let pendingScore: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (s) {
      pendingScore = Number(s[1]);
      continue;
    }
    const m = /pts_time:\s*([\d.]+)/.exec(line);
    if (m && /showinfo/.test(line)) {
      const t = Number(m[1]);
      if (Number.isFinite(t)) {
        out.push({ t: round3(t + offset), score: pendingScore ?? 0.5 });
        pendingScore = null;
      }
    }
  }
  return out;
}

/**
 * Adaptive selection: highest scene-change scores first (respecting minGap),
 * then coverage fill so no gap exceeds maxGap, all within `budget`.
 * Always keeps a frame near the chunk start.
 */
export function selectKeyframes(params: {
  candidates: SceneCandidate[];
  start: number;
  end: number;
  budget: number;
  minGapSec: number;
  maxGapSec: number;
}): SceneCandidate[] {
  const { start, end, minGapSec, maxGapSec } = params;
  const budget = Math.max(1, Math.floor(params.budget));
  const span = Math.max(0, end - start);
  const first = { t: round3(start + Math.min(0.5, span / 2)), score: 0 };
  const chosen: SceneCandidate[] = [first];
  const far = (t: number) => chosen.every((c) => Math.abs(c.t - t) >= minGapSec);
  const ranked = params.candidates
    .filter((c) => c.t >= start && c.t < end)
    .sort((a, b) => b.score - a.score || a.t - b.t);
  for (const c of ranked) {
    if (chosen.length >= budget) break;
    if (far(c.t)) chosen.push({ t: round3(c.t), score: c.score });
  }
  // Coverage fill: split the largest gap (including the tail) until none exceeds maxGap.
  for (let guard = 0; chosen.length < budget && guard < 500; guard++) {
    chosen.sort((a, b) => a.t - b.t);
    let bestGap = 0;
    let at = -1;
    for (let i = 0; i < chosen.length; i++) {
      const next = i + 1 < chosen.length ? chosen[i + 1].t : end;
      const gap = next - chosen[i].t;
      if (gap > bestGap) {
        bestGap = gap;
        at = i;
      }
    }
    if (at < 0 || bestGap <= maxGapSec) break;
    const next = at + 1 < chosen.length ? chosen[at + 1].t : end;
    const t = round3(chosen[at].t + (next - chosen[at].t) / 2);
    if (!far(t) && bestGap < minGapSec * 2) break;
    chosen.push({ t, score: 0 });
  }
  return chosen.sort((a, b) => a.t - b.t);
}

/** Pick `n` evenly spaced items (keeps first and last). */
export function evenlyPick<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  if (n <= 1) return [items[0]];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return out;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 83.4 → "01:23", 3725 → "1:02:05". */
export function formatTimecode(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

/** Parse "01:23", "1:02:05", "83s", "83.5" → seconds (null when not a timecode). */
export function parseTimecode(raw: string): number | null {
  const v = raw.trim().replace(/^@/, "");
  let m = /^(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = /^(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/i.exec(v);
  if (m) return Number(m[1]);
  return null;
}

/** All timecodes mentioned in free text ("look at 01:23 and 1:40"). */
export function timecodesInText(text: string): number[] {
  const out: number[] = [];
  const re =
    /(?<![\d:])(\d{1,2}:\d{1,2}:\d{1,2}|\d{1,3}:\d{2})(?![\d:])|\b(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)\b/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const t = m[1] ? parseTimecode(m[1]) : Number(m[2]);
    if (t !== null && Number.isFinite(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Frames to extract for a "look again" at `t`: the moment plus a little context. */
export function lookAroundTimes(t: number, duration: number, spread = 1.5): number[] {
  const clamp = (x: number) => round3(Math.min(Math.max(0, x), Math.max(0, duration - 0.05)));
  return [...new Set([clamp(t - spread), clamp(t), clamp(t + spread)])];
}
