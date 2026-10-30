/**
 * Canonical timeline.json schema for the production editor.
 *
 * The timeline lives at `<projectDir>/timeline.json` and is the single
 * source of truth for what the renderer compiles. It's intentionally
 * smaller than full OTIO — just enough fields to deterministically
 * produce an MP4 across the layers we care about (V1/V2/A1/A2/A3 +
 * captions + overlays).
 *
 * Validate before render: `validateTimeline()` reports clip overruns,
 * missing assets, aspect mismatches, brief drift (duration / hook),
 * and missing audio targets — every condition that would silently
 * produce a wrong-looking export.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { assetsDir, listAssets, type AssetMetadata } from "./project-dir.js";
import type { Brief } from "./brief.js";

// ── Types ─────────────────────────────────────────────────────

export type Aspect = "16:9" | "9:16" | "1:1" | "4:5";

export type LayerName =
  | "V1" // main video bed
  | "V2" // b-roll / cutaways
  | "V3" // overlays / lower thirds
  | "A1" // VO / dialogue
  | "A2" // music bed
  | "A3" // SFX
  | string; // freeform layer for custom rigs

export type EasingFn = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring";

export interface KeyframeNumber {
  /** Time in seconds along the *clip*, not the timeline. */
  t: number;
  v: number;
  ease?: EasingFn;
}

export interface Transform {
  /** Top-left x as percent of frame width (0..1). */
  x?: KeyframeNumber[] | number;
  /** Top-left y as percent of frame height (0..1). */
  y?: KeyframeNumber[] | number;
  /** Scale factor — 1 = native size. Animatable via keyframes. */
  scale?: KeyframeNumber[] | number;
  /** Rotation in degrees. */
  rotate?: KeyframeNumber[] | number;
  /** Opacity 0..1. */
  opacity?: KeyframeNumber[] | number;
}

export interface Transition {
  kind: "cut" | "fade" | "crossfade" | "wipe" | "slide" | "dip-to-black";
  /** Duration in seconds. Default 0.3 for fade/crossfade. */
  durationSec?: number;
  /** Direction for slide/wipe. */
  direction?: "left" | "right" | "up" | "down";
}

export interface TextOverlay {
  text: string;
  /** Position on V3. Defaults to centered safe-area-aware placement. */
  x?: number;
  y?: number;
  /** Font, weight, size in CSS units (px). */
  font?: string;
  weight?: number | string;
  sizePx?: number;
  color?: string;
  /** Stroke (outline) for legibility on busy footage. */
  strokeColor?: string;
  strokeWidth?: number;
  /** Drop shadow CSS string. */
  shadow?: string;
}

export interface TimelineClip {
  /** Stable clip id, used for selection / undo / patch ops. */
  id: string;
  /** Layer this clip lives on. Determines render order + audio routing. */
  layer: LayerName;
  /** Asset filename in <projectDir>/assets/. Empty for pure overlays. */
  asset?: string;
  /** Where the clip starts on the timeline (seconds). */
  startSec: number;
  /** Duration on the timeline (seconds). */
  durationSec: number;
  /** Inset into the source asset (skip the first N seconds). */
  trimStartSec?: number;
  /** Volume gain (0..1). Default 1 for audio layers, 0 for video. */
  volume?: number;
  /** Per-clip transform / motion. */
  transform?: Transform;
  /** Transition leading INTO this clip from the previous one. */
  transitionIn?: Transition;
  /** Transition leading OUT of this clip to the next. */
  transitionOut?: Transition;
  /** Text payload — only meaningful for V3 overlay clips. */
  text?: TextOverlay;
  /** LUT to apply (filename in <projectDir>/luts/). */
  lut?: string;
  /** Caption locker — pin word-level captions to this clip range. */
  captions?: { srt?: string; words?: Array<{ t: number; w: string }> };
  /** Loose key-value bag for extensions. */
  meta?: Record<string, unknown>;
}

export interface Timeline {
  version: 1;
  /** Composition this timeline belongs to. */
  compositionId: string;
  /** Aspect for the export. Drives canvas dimensions. */
  aspect: Aspect;
  /** Total duration of the export. Clips beyond this are clipped at render. */
  durationSec: number;
  /** Frame rate. */
  fps: number;
  /** Background color (when no V1 clip is present at a given second). */
  bgColor: string;
  /** Loudness target for the master mix. */
  audio: {
    target: { integrated: number; truePeak: number; lra: number };
    /** When true the renderer applies sidechain ducking to A2 under A1. */
    duckMusicUnderVo: boolean;
  };
  /** Clips, in unspecified order. The renderer sorts by layer + startSec. */
  clips: TimelineClip[];
  /** Filename (under renders/{vN}/) for the proof / final exports. */
  outputName?: string;
  /** Per-timeline grade — applies to every video clip. */
  grade?: { lut?: string; brightness?: number; saturation?: number };
}

export interface TimelineIssue {
  level: "error" | "warning";
  clipId?: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: TimelineIssue[];
}

// ── Defaults ─────────────────────────────────────────────────

export function emptyTimeline(compositionId: string, aspect: Aspect = "9:16"): Timeline {
  return {
    version: 1,
    compositionId,
    aspect,
    durationSec: 30,
    fps: 30,
    bgColor: "#000000",
    audio: {
      target: { integrated: -14, truePeak: -1, lra: 11 },
      duckMusicUnderVo: true,
    },
    clips: [],
    outputName: "proof.mp4",
  };
}

export function aspectToDims(aspect: Aspect): { width: number; height: number } {
  switch (aspect) {
    case "16:9": return { width: 1920, height: 1080 };
    case "9:16": return { width: 1080, height: 1920 };
    case "1:1":  return { width: 1080, height: 1080 };
    case "4:5":  return { width: 1080, height: 1350 };
  }
}

// ── Validator ─────────────────────────────────────────────────

const MAX_CLIPS = 500;

/**
 * Run a deep check against a timeline + the workspace's actual assets
 * + (optionally) the brief. Produces a report agents can read and fix
 * before render.
 *
 * Catches:
 *   • clip references an asset that doesn't exist on disk
 *   • clip's trimStart + duration exceeds source duration
 *   • timeline duration drifts ±5% from brief.format.durationSec
 *   • aspect mismatches brief.format.aspect
 *   • hook window (0..3s) has no V1 clip when brief says hookSec≥3
 *   • A1 (VO) layer present but no audio target / loudness goal
 *   • clip count exploded (>500) — almost always a runaway agent
 */
export function validateTimeline(
  timeline: Timeline,
  brief?: Brief | null,
): ValidationReport {
  const issues: TimelineIssue[] = [];

  if (timeline.version !== 1) {
    issues.push({ level: "error", message: `Unknown timeline version ${timeline.version}` });
  }
  if (!timeline.compositionId) {
    issues.push({ level: "error", message: "compositionId is required" });
  }
  if (timeline.durationSec <= 0) {
    issues.push({ level: "error", message: "durationSec must be > 0" });
  }
  if (timeline.fps < 12 || timeline.fps > 60) {
    issues.push({ level: "warning", message: `fps=${timeline.fps} outside 12..60 — clamp at render` });
  }
  if (timeline.clips.length > MAX_CLIPS) {
    issues.push({ level: "error", message: `Clip count ${timeline.clips.length} > ${MAX_CLIPS} — refusing to render` });
  }

  // Build asset index for cross-checks.
  let assets: AssetMetadata[] = [];
  try {
    assets = listAssets(timeline.compositionId);
  } catch {
    issues.push({ level: "warning", message: `Could not list assets for ${timeline.compositionId}` });
  }
  const assetByName = new Map(assets.map((a) => [a.filename, a] as const));

  let hasV1InHookWindow = false;
  let hasA1 = false;
  let lastEndPerLayer: Record<string, number> = {};

  for (const c of timeline.clips) {
    if (!c.id) {
      issues.push({ level: "error", message: "clip missing id" });
      continue;
    }
    if (c.startSec < 0) {
      issues.push({ level: "error", clipId: c.id, message: `startSec ${c.startSec} < 0` });
    }
    if (c.durationSec <= 0) {
      issues.push({ level: "error", clipId: c.id, message: "durationSec must be > 0" });
    }
    const endSec = c.startSec + c.durationSec;
    if (endSec > timeline.durationSec + 0.001) {
      issues.push({
        level: "warning",
        clipId: c.id,
        message: `clip extends to ${endSec.toFixed(2)}s past timeline duration (${timeline.durationSec}s) — will be clipped at render`,
      });
    }
    if (c.asset) {
      const a = assetByName.get(c.asset);
      if (!a) {
        issues.push({ level: "error", clipId: c.id, message: `asset "${c.asset}" not found in metadata.json` });
      } else {
        if (a.durationSec) {
          const need = (c.trimStartSec ?? 0) + c.durationSec;
          if (need > a.durationSec + 0.05) {
            issues.push({
              level: "error",
              clipId: c.id,
              message: `trimStart+duration=${need.toFixed(2)}s exceeds source asset duration ${a.durationSec.toFixed(2)}s`,
            });
          }
        }
        // Disk existence — handles the case where metadata.json is
        // stale and the file was moved/deleted out of band.
        const path = join(assetsDir(timeline.compositionId), a.filename);
        if (!existsSync(path)) {
          issues.push({
            level: "error",
            clipId: c.id,
            message: `asset file missing on disk: ${a.filename}`,
          });
        }
      }
    }
    // Layer overlap detection — overlap inside the same layer means
    // one clip will hide the other (or one VO will mask the next).
    const prevEnd = lastEndPerLayer[c.layer];
    if (prevEnd !== undefined && c.startSec < prevEnd - 0.001) {
      issues.push({
        level: "warning",
        clipId: c.id,
        message: `clip overlaps another clip on layer ${c.layer} (prev ends at ${prevEnd.toFixed(2)}s, this starts at ${c.startSec.toFixed(2)}s)`,
      });
    }
    lastEndPerLayer[c.layer] = Math.max(prevEnd ?? 0, endSec);

    if (c.layer === "V1" && c.startSec < 3 && endSec > 0) hasV1InHookWindow = true;
    if (c.layer === "A1") hasA1 = true;
  }

  // Brief cross-checks.
  if (brief?.format) {
    const target = brief.format.durationSec;
    if (target > 0) {
      const drift = Math.abs(timeline.durationSec - target) / target;
      if (drift > 0.05) {
        issues.push({
          level: "warning",
          message: `timeline duration ${timeline.durationSec}s drifts ${(drift * 100).toFixed(1)}% from brief target ${target}s`,
        });
      }
    }
    if (brief.format.aspect && brief.format.aspect !== timeline.aspect) {
      issues.push({
        level: "error",
        message: `aspect ${timeline.aspect} doesn't match brief (${brief.format.aspect})`,
      });
    }
    if ((brief.format.hookSec ?? 0) > 0 && !hasV1InHookWindow) {
      issues.push({
        level: "warning",
        message: `brief specifies a hook window but no V1 clip exists in the first 3s`,
      });
    }
  }

  if (hasA1 && timeline.audio?.target?.integrated == null) {
    issues.push({
      level: "warning",
      message: "VO present on A1 but no integrated-LUFS target set — using -14 default",
    });
  }

  return { ok: issues.every((i) => i.level !== "error"), issues };
}

// ── On-disk helpers ──────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { projectDir } from "./project-dir.js";

export function timelinePath(compositionId: string): string {
  return join(projectDir(compositionId), "timeline.json");
}

export function readTimeline(compositionId: string): Timeline | null {
  const p = timelinePath(compositionId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Timeline;
  } catch {
    return null;
  }
}

export function writeTimeline(compositionId: string, timeline: Timeline): void {
  const p = timelinePath(compositionId);
  mkdirSync(dirname(p), { recursive: true });
  // Same atomic-write pattern as project-dir's metadata writer.
  const tmp = `${p}.tmp.${process.pid}.${Date.now().toString(36)}`;
  writeFileSync(tmp, JSON.stringify(timeline, null, 2), "utf-8");
  try {
    require("node:fs").renameSync(tmp, p);
  } catch {
    writeFileSync(p, JSON.stringify(timeline, null, 2), "utf-8");
    try { require("node:fs").unlinkSync(tmp); } catch { /* ignore */ }
  }
}
