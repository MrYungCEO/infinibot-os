/**
 * Timeline render pipeline — `timeline.json` → MP4 via direct ffmpeg.
 *
 * Sister module to `render.ts` (which uses Playwright to screen-grab
 * the in-browser composition). This one bypasses the browser entirely
 * and compiles a `Timeline` straight to ffmpeg's `filter_complex`. Use
 * it when:
 *   • You already have a structured `timeline.json` (the editor agent
 *     produces these from the brief + asset library).
 *   • You want a deterministic, headless render that doesn't need
 *     Chromium installed.
 *   • You want to render a proof + master + ProRes from the same
 *     timeline back-to-back without re-mounting a browser.
 *
 * Output: `<projectDir>/renders/<vN>/<output>-<preset>.{mp4|mov}`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { assetsDir, projectDir } from "./project-dir.js";
import { aspectToDims, type Timeline, type TimelineClip } from "./timeline.js";

// ── Presets ───────────────────────────────────────────────────

export type RenderPreset = "proof" | "master" | "prores";

interface CodecConfig {
  vcodec: string;
  vbitrate?: string;
  preset?: string;
  crf?: number;
  acodec: string;
  abitrate: string;
  pixfmt: string;
  fpsCap?: number;
}

const PRESETS: Record<RenderPreset, CodecConfig> = {
  proof: {
    vcodec: "libx264",
    crf: 30,
    preset: "veryfast",
    acodec: "aac",
    abitrate: "96k",
    pixfmt: "yuv420p",
    fpsCap: 30,
  },
  master: {
    vcodec: "libx264",
    crf: 18,
    preset: "slow",
    acodec: "aac",
    abitrate: "192k",
    pixfmt: "yuv420p",
  },
  prores: {
    vcodec: "prores_ks",
    preset: "hq",
    acodec: "pcm_s16le",
    abitrate: "1536k",
    pixfmt: "yuv422p10le",
  },
};

export interface RenderResult {
  output: string;
  preset: RenderPreset;
  durationMs: number;
  version: string;
}

export interface RenderOptions {
  preset?: RenderPreset;
  /** Override the auto-bumped version folder (default: vN+1). */
  version?: string;
  /** Watermark text — recommended for proof renders. */
  watermarkText?: string;
  /** Don't actually run ffmpeg; useful for tests / introspection. */
  dryRun?: boolean;
}

// ── Public API ───────────────────────────────────────────────

export async function renderTimelineToMp4(
  timeline: Timeline,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const preset: RenderPreset = opts.preset ?? "proof";
  const codec = PRESETS[preset];
  const dims = aspectToDims(timeline.aspect);
  const fps = codec.fpsCap ? Math.min(codec.fpsCap, timeline.fps) : timeline.fps;

  const version = opts.version ?? nextVersionDir(timeline.compositionId);
  const outDir = join(projectDir(timeline.compositionId), "renders", version);
  mkdirSync(outDir, { recursive: true });
  const baseName = (timeline.outputName ?? "render").replace(/\.[^.]+$/, "");
  const ext = preset === "prores" ? ".mov" : ".mp4";
  const outPath = join(outDir, `${baseName}-${preset}${ext}`);

  const args = buildFfmpegArgs(timeline, dims, fps, codec, outPath, opts);

  if (opts.dryRun) return { output: outPath, preset, durationMs: 0, version };

  const start = Date.now();
  await runFfmpeg(args);
  return { output: outPath, preset, durationMs: Date.now() - start, version };
}

// ── Filter graph ─────────────────────────────────────────────

function buildFfmpegArgs(
  timeline: Timeline,
  dims: { width: number; height: number },
  fps: number,
  codec: CodecConfig,
  outPath: string,
  opts: RenderOptions,
): string[] {
  const inputs: string[] = [];
  const filterParts: string[] = [];

  // Sort clips so V1 composites first, then V2 over V1, V3 over both.
  const clips = [...timeline.clips].sort((a, b) => {
    const la = layerOrder(a.layer);
    const lb = layerOrder(b.layer);
    if (la !== lb) return la - lb;
    return a.startSec - b.startSec;
  });

  // Solid-color base canvas at the full timeline duration.
  const dur = timeline.durationSec;
  filterParts.push(
    `color=c=${timeline.bgColor}:s=${dims.width}x${dims.height}:r=${fps}:d=${dur}[base]`,
  );

  let lastVideoLabel = "[base]";
  let videoIdx = 0;
  let audioIdx = 0;
  const audioStreams: string[] = [];

  for (const clip of clips) {
    if (!clip.asset) {
      // Pure overlay (text-only on V3).
      if (clip.text) {
        const drawText = buildDrawTextFilter(clip, dims);
        if (drawText) {
          const next = `[v${++videoIdx}]`;
          filterParts.push(`${lastVideoLabel}${drawText}${next}`);
          lastVideoLabel = next;
        }
      }
      continue;
    }

    const inputPath = join(assetsDir(timeline.compositionId), clip.asset);
    const inputIndex = inputs.length;
    inputs.push(inputPath);

    const trim = clip.trimStartSec ?? 0;

    if (isVideoLayer(clip.layer)) {
      const baseV = `${inputIndex}:v`;
      const trimFilter = trim > 0 ? `trim=start=${trim},setpts=PTS-STARTPTS,` : "setpts=PTS-STARTPTS,";
      const scale = `scale=${dims.width}:${dims.height}:force_original_aspect_ratio=decrease,pad=${dims.width}:${dims.height}:(ow-iw)/2:(oh-ih)/2:color=${timeline.bgColor}`;
      const tag = `[vc${videoIdx}]`;
      filterParts.push(`[${baseV}]${trimFilter}${scale},format=yuv420p${tag}`);

      const next = `[v${++videoIdx}]`;
      const enable = `enable='between(t,${clip.startSec},${(clip.startSec + clip.durationSec).toFixed(3)})'`;
      filterParts.push(`${lastVideoLabel}${tag}overlay=0:0:${enable}${next}`);
      lastVideoLabel = next;
    }

    const wantsAudio = isAudioLayer(clip.layer) || (isVideoLayer(clip.layer) && (clip.volume ?? 0) > 0);
    if (wantsAudio) {
      const baseA = `${inputIndex}:a`;
      const tag = `[a${++audioIdx}]`;
      const trimFilter = trim > 0 ? `atrim=start=${trim},asetpts=PTS-STARTPTS,` : "asetpts=PTS-STARTPTS,";
      const vol = clip.volume ?? (isAudioLayer(clip.layer) ? 1 : 0);
      const delayMs = Math.round(clip.startSec * 1000);
      filterParts.push(
        `[${baseA}]${trimFilter}volume=${vol},adelay=${delayMs}|${delayMs},apad${tag}`,
      );
      audioStreams.push(tag);
    }
  }

  if (opts.watermarkText) {
    const next = `[v${++videoIdx}]`;
    filterParts.push(
      `${lastVideoLabel}drawtext=text='${escapeDrawtext(opts.watermarkText)}':fontcolor=white@0.6:fontsize=28:x=w-tw-20:y=h-th-20:box=1:boxcolor=black@0.4:boxborderw=8${next}`,
    );
    lastVideoLabel = next;
  }

  // Audio mix.
  let lastAudioLabel = "";
  if (audioStreams.length === 0) {
    filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=48000:duration=${dur}[asilent]`);
    lastAudioLabel = "[asilent]";
  } else if (audioStreams.length === 1) {
    lastAudioLabel = audioStreams[0];
  } else {
    filterParts.push(`${audioStreams.join("")}amix=inputs=${audioStreams.length}:duration=longest[amix]`);
    lastAudioLabel = "[amix]";
  }

  // Master loudness — applied at render time so every preset hits the
  // same target without an extra pass.
  const target = timeline.audio?.target;
  if (target) {
    filterParts.push(
      `${lastAudioLabel}loudnorm=I=${target.integrated}:TP=${target.truePeak}:LRA=${target.lra}[aout]`,
    );
    lastAudioLabel = "[aout]";
  }

  filterParts.push(`${lastVideoLabel}fps=${fps},trim=duration=${dur},setpts=PTS-STARTPTS[vout]`);

  const args: string[] = ["-hide_banner", "-y"];
  for (const inp of inputs) args.push("-i", inp);
  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", "[vout]", "-map", lastAudioLabel);

  args.push("-c:v", codec.vcodec);
  if (codec.crf != null) args.push("-crf", String(codec.crf));
  if (codec.preset) args.push("-preset", codec.preset);
  if (codec.vbitrate) args.push("-b:v", codec.vbitrate);
  args.push("-pix_fmt", codec.pixfmt);
  args.push("-c:a", codec.acodec);
  args.push("-b:a", codec.abitrate);
  args.push("-movflags", "+faststart");
  args.push(outPath);
  return args;
}

// ── Helpers ───────────────────────────────────────────────────

function layerOrder(layer: string): number {
  if (layer === "V1") return 1;
  if (layer === "V2") return 2;
  if (layer === "V3") return 3;
  if (layer === "A1") return 10;
  if (layer === "A2") return 11;
  if (layer === "A3") return 12;
  return 100;
}

function isVideoLayer(layer: string): boolean { return layer.startsWith("V"); }
function isAudioLayer(layer: string): boolean { return layer.startsWith("A"); }

function buildDrawTextFilter(clip: TimelineClip, dims: { width: number; height: number }): string {
  const t = clip.text!;
  const xPx = t.x != null ? Math.round(t.x * dims.width) : Math.round(dims.width / 2);
  const yPx = t.y != null ? Math.round(t.y * dims.height) : Math.round(dims.height * 0.5);
  const size = t.sizePx ?? 64;
  const color = t.color ?? "white";
  const stroke = t.strokeColor ? `:bordercolor=${t.strokeColor}:borderw=${t.strokeWidth ?? 2}` : "";
  const enable = `enable='between(t,${clip.startSec},${(clip.startSec + clip.durationSec).toFixed(3)})'`;
  return `drawtext=text='${escapeDrawtext(t.text)}':fontcolor=${color}:fontsize=${size}:x=${xPx}-text_w/2:y=${yPx}-text_h/2${stroke}:${enable},`;
}

function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/\n/g, "\\n");
}

function nextVersionDir(compositionId: string): string {
  const root = join(projectDir(compositionId), "renders");
  if (!existsSync(root)) return "v1";
  const numbers: number[] = [];
  for (const entry of readdirSync(root)) {
    const m = entry.match(/^v(\d+)$/);
    if (m) numbers.push(parseInt(m[1], 10));
  }
  return `v${(numbers.length === 0 ? 0 : Math.max(...numbers)) + 1}`;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const bin = process.env.FFMPEG_BIN || "ffmpeg";
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.split("\n").slice(-8).join("\n")}`));
    });
  });
}
