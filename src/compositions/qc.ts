/**
 * Quality-control checker — validate a rendered file against the brief.
 *
 * Runs after `renderTimelineToMp4` (or any other renderer). The checker
 * uses ffprobe + ffmpeg to gather objective measurements:
 *   • duration (s)
 *   • aspect (width / height)
 *   • integrated LUFS + true-peak (when audio is present)
 *   • caption coverage % (set later — we surface it here when callers
 *     pass a caption manifest)
 *   • hook-window content presence (any visible frame in 0..hookSec)
 *
 * It compares against the brief and returns an issues array the editor
 * agent can read, plus a `passed` boolean.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { measureLoudness } from "./audio-tools.js";
import type { Brief } from "./brief.js";

export interface QcIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface QcReport {
  passed: boolean;
  issues: QcIssue[];
  measurements: {
    durationSec?: number;
    width?: number;
    height?: number;
    aspect?: string;
    integratedLufs?: number;
    truePeakDbtp?: number;
    /** Hook window had at least one non-black frame. */
    hookHasContent?: boolean;
    captionCoveragePct?: number;
  };
}

export interface QcOptions {
  /** Path to the rendered MP4. */
  filePath: string;
  /** Brief to validate against. Pass null to skip brief comparisons. */
  brief: Brief | null;
  /** Optional pre-computed caption coverage % (0..100). */
  captionCoveragePct?: number;
}

// ── Public API ───────────────────────────────────────────────

export async function runQc(opts: QcOptions): Promise<QcReport> {
  const issues: QcIssue[] = [];
  const m: QcReport["measurements"] = {};

  if (!existsSync(opts.filePath)) {
    return {
      passed: false,
      issues: [{ level: "error", code: "MISSING_OUTPUT", message: `Render not found: ${opts.filePath}` }],
      measurements: {},
    };
  }

  // ffprobe — pull duration + dimensions in one call.
  try {
    const probe = await ffprobe(opts.filePath);
    m.durationSec = probe.durationSec;
    m.width = probe.width;
    m.height = probe.height;
    if (probe.width && probe.height) {
      m.aspect = simplifyAspect(probe.width, probe.height);
    }
  } catch (err) {
    issues.push({
      level: "error",
      code: "PROBE_FAILED",
      message: `ffprobe failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Loudness — only meaningful when there's an audio track.
  try {
    const loud = await measureLoudness(opts.filePath);
    m.integratedLufs = loud.integrated;
    m.truePeakDbtp = loud.truePeak;
  } catch {
    // No audio or ffmpeg can't measure — not fatal.
  }

  // Hook-window content sniff.
  if (opts.brief?.format.hookSec && opts.brief.format.hookSec > 0) {
    try {
      m.hookHasContent = await sniffHookFrame(opts.filePath, opts.brief.format.hookSec);
    } catch {
      // Sniff failed — don't fail QC for it; flag as a warning.
      issues.push({
        level: "warning",
        code: "HOOK_SNIFF_FAILED",
        message: "Could not determine if hook window has visible content",
      });
    }
  }

  if (opts.captionCoveragePct != null) {
    m.captionCoveragePct = opts.captionCoveragePct;
  }

  // Brief comparisons.
  if (opts.brief) {
    issues.push(...compareToBrief(opts.brief, m));
  }

  return {
    passed: issues.every((i) => i.level !== "error"),
    issues,
    measurements: m,
  };
}

// ── Brief comparison ─────────────────────────────────────────

function compareToBrief(brief: Brief, m: QcReport["measurements"]): QcIssue[] {
  const out: QcIssue[] = [];

  // Duration tolerance ±5%.
  if (brief.format.durationSec > 0 && m.durationSec != null) {
    const drift = Math.abs(m.durationSec - brief.format.durationSec) / brief.format.durationSec;
    if (drift > 0.05) {
      out.push({
        level: "warning",
        code: "DURATION_DRIFT",
        message: `output ${m.durationSec.toFixed(2)}s drifts ${(drift * 100).toFixed(1)}% from brief target ${brief.format.durationSec}s`,
      });
    }
  }

  // Aspect — exact match required (the renderer can't auto-correct
  // mid-flight, so a mismatch means the user picked the wrong preset).
  if (brief.format.aspect && m.aspect && brief.format.aspect !== m.aspect) {
    out.push({
      level: "error",
      code: "ASPECT_MISMATCH",
      message: `output aspect ${m.aspect} doesn't match brief (${brief.format.aspect})`,
    });
  }

  // LUFS — within 1 LUFS of target.
  if (m.integratedLufs != null) {
    const target = m.integratedLufs > -22 ? -14 : -23; // crude default
    const drift = Math.abs(m.integratedLufs - target);
    if (drift > 1.0) {
      out.push({
        level: "warning",
        code: "LOUDNESS_DRIFT",
        message: `integrated loudness ${m.integratedLufs.toFixed(1)} LUFS drifts ${drift.toFixed(1)} dB from target ${target}`,
      });
    }
  }
  if (m.truePeakDbtp != null && m.truePeakDbtp > -1) {
    out.push({
      level: "error",
      code: "TRUE_PEAK_OVER",
      message: `true peak ${m.truePeakDbtp.toFixed(2)} dBTP exceeds -1 dBTP ceiling`,
    });
  }

  // Hook content.
  if ((brief.format.hookSec ?? 0) > 0 && m.hookHasContent === false) {
    out.push({
      level: "error",
      code: "HOOK_EMPTY",
      message: `first ${brief.format.hookSec}s has no visible content — viewers bounce here`,
    });
  }

  // Caption coverage if reported.
  if (brief.format.captionsBurnedIn && m.captionCoveragePct != null && m.captionCoveragePct < 90) {
    out.push({
      level: "warning",
      code: "CAPTION_COVERAGE_LOW",
      message: `captions cover ${m.captionCoveragePct.toFixed(1)}% — brief expects burned-in captions across the full clip`,
    });
  }

  return out;
}

// ── ffprobe / sniff helpers ──────────────────────────────────

async function ffprobe(filePath: string): Promise<{ durationSec?: number; width?: number; height?: number }> {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "default=noprint_wrappers=1:nokey=0",
    filePath,
  ];
  const stdout = await runProbe(args);
  const out: { durationSec?: number; width?: number; height?: number } = {};
  for (const line of stdout.split(/\r?\n/)) {
    const [k, v] = line.split("=");
    if (!k) continue;
    if (k === "width") out.width = parseInt(v, 10) || undefined;
    else if (k === "height") out.height = parseInt(v, 10) || undefined;
    else if (k === "duration") out.durationSec = parseFloat(v) || undefined;
  }
  return out;
}

/**
 * Run a 1-second sample inside the hook window through ffmpeg's
 * `blackdetect` filter. If it spans the whole hook, we say there's
 * no content; otherwise hook is covered.
 */
async function sniffHookFrame(filePath: string, hookSec: number): Promise<boolean> {
  const args = [
    "-hide_banner",
    "-nostats",
    "-i", filePath,
    "-vf", `trim=duration=${hookSec},blackdetect=d=${Math.max(0.5, hookSec * 0.6)}:pic_th=0.98`,
    "-an",
    "-f", "null",
    "-",
  ];
  const stderr = await runFfmpegStderr(args);
  // If blackdetect printed *no* "black_start" line, the hook had picture.
  return !/black_start/.test(stderr);
}

function runProbe(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const bin = process.env.FFPROBE_BIN || "ffprobe";
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (b: Buffer) => { stdout += b.toString(); });
    proc.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`ffprobe exited ${code}: ${stderr.split("\n").slice(-3).join("\n")}`));
    });
  });
}

function runFfmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const bin = process.env.FFMPEG_BIN || "ffmpeg";
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    proc.on("error", reject);
    proc.on("close", () => resolvePromise(stderr));
  });
}

function simplifyAspect(w: number, h: number): string {
  const ratio = w / h;
  if (Math.abs(ratio - 16 / 9) < 0.02) return "16:9";
  if (Math.abs(ratio - 9 / 16) < 0.02) return "9:16";
  if (Math.abs(ratio - 1) < 0.02) return "1:1";
  if (Math.abs(ratio - 4 / 5) < 0.02) return "4:5";
  return `${w}:${h}`;
}
