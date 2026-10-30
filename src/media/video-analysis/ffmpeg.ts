/**
 * ffmpeg / ffprobe wrappers (local binaries only). Every output goes to a
 * caller-provided scratch dir; callers clean it up.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseSceneLog, round3, formatTimecode, type SceneCandidate } from "./sampling.js";
import type { VideoMeta } from "./types.js";
import { coerceString } from "../../shared/text/coerce.js";

const execFileAsync = promisify(execFile);

export interface FfmpegBins {
  ffmpeg: string;
  ffprobe: string;
}

export function resolveBins(env: NodeJS.ProcessEnv = process.env): FfmpegBins {
  return {
    ffmpeg: env.INFINIBOT_FFMPEG?.trim() || "ffmpeg",
    ffprobe: env.INFINIBOT_FFPROBE?.trim() || "ffprobe",
  };
}

/** Minimal env for media subprocesses (no proxies, no network-capable config). */
function mediaEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "LANG", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

async function run(bin: string, args: string[], timeoutMs: number) {
  return await execFileAsync(bin, args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: mediaEnv(),
  });
}

/** Parse ffprobe -show_format -show_streams JSON. */
export function parseProbe(json: string): VideoMeta {
  const d = JSON.parse(json) as {
    format?: Record<string, unknown>;
    streams?: Array<Record<string, unknown>>;
  };
  const streams = d.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !(s.disposition as any)?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const num = (x: unknown) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const rate = (r: unknown) => {
    const m = /^(\d+)\/(\d+)$/.exec(coerceString(r));
    if (!m || Number(m[2]) === 0) return null;
    return Math.round((Number(m[1]) / Number(m[2])) * 100) / 100;
  };
  const tags = (d.format?.tags ?? {}) as Record<string, string>;
  const sideRot = ((v?.side_data_list as Array<Record<string, unknown>>) ?? []).find(
    (s) => s.rotation !== undefined,
  )?.rotation;
  const rotation = Number((v?.tags as Record<string, string>)?.rotate ?? sideRot ?? 0) || 0;
  const duration = num(d.format?.duration) ?? num(v?.duration) ?? num(a?.duration) ?? 0;
  let width = Number(v?.width ?? 0);
  let height = Number(v?.height ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return {
    duration: round3(duration),
    width,
    height,
    fps: rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate),
    vcodec: (v?.codec_name as string) ?? null,
    acodec: (a?.codec_name as string) ?? null,
    hasAudio: Boolean(a),
    bitrate: num(d.format?.bit_rate),
    format: (d.format?.format_name as string) ?? null,
    rotation,
    creationTime: tags.creation_time ?? null,
  };
}

export async function probe(bins: FfmpegBins, file: string): Promise<VideoMeta> {
  const { stdout } = await run(
    bins.ffprobe,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    60_000,
  );
  const meta = parseProbe(stdout);
  if (!meta.width || !meta.height) throw new Error("no video stream found");
  return meta;
}

/** Scene-change candidates in [start, start+len) at a low threshold (ranked later). */
export async function detectScenes(
  bins: FfmpegBins,
  file: string,
  start: number,
  len: number,
  threshold = 0.2,
): Promise<SceneCandidate[]> {
  const { stderr } = await run(
    bins.ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-ss",
      String(start),
      "-t",
      String(len),
      "-i",
      file,
      "-an",
      "-sn",
      "-vf",
      `scale=320:-2,select='gt(scene,${threshold})',metadata=print,showinfo`,
      "-f",
      "null",
      "-",
    ],
    Math.max(120_000, len * 4000),
  );
  return parseSceneLog(stderr, start);
}

/** One small JPEG at `t` (max 640 px wide). */
export async function extractFrame(
  bins: FfmpegBins,
  file: string,
  t: number,
  out: string,
  width = 640,
): Promise<string> {
  await run(
    bins.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(Math.max(0, t)),
      "-i",
      file,
      "-frames:v",
      "1",
      "-an",
      "-vf",
      `scale='min(${width},iw)':-2`,
      "-q:v",
      "6",
      out,
    ],
    60_000,
  );
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error(`could not extract a frame at ${formatTimecode(t)}`);
  }
  return out;
}

/** Contact sheet: labelled thumbnails tiled cols×rows into one JPEG. */
export async function contactSheet(
  bins: FfmpegBins,
  frames: Array<{ path: string; t: number }>,
  out: string,
  cols = 4,
): Promise<{ path: string; cols: number; rows: number }> {
  if (!frames.length) throw new Error("no frames for a contact sheet");
  const dir = path.join(path.dirname(out), `sheet-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const font = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"].find((f) =>
      fs.existsSync(f),
    );
    for (let i = 0; i < frames.length; i++) {
      const label = formatTimecode(frames[i].t).replace(/:/g, "\\:");
      const draw = font
        ? `,drawbox=x=0:y=ih-26:w=88:h=26:color=black@0.7:t=fill,drawtext=fontfile=${font}:text='${label}':fontcolor=white:fontsize=18:x=8:y=h-22`
        : "";
      await run(
        bins.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          frames[i].path,
          "-vf",
          `scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black${draw}`,
          "-q:v",
          "5",
          path.join(dir, `${String(i + 1).padStart(4, "0")}.jpg`),
        ],
        30_000,
      );
    }
    const c = Math.min(cols, frames.length);
    const rows = Math.ceil(frames.length / c);
    await run(
      bins.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        "1",
        "-i",
        path.join(dir, "%04d.jpg"),
        "-vf",
        `tile=${c}x${rows}:padding=4:color=black`,
        "-frames:v",
        "1",
        "-q:v",
        "5",
        out,
      ],
      60_000,
    );
    return { path: out, cols: c, rows };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 16 kHz mono WAV of [start, start+len) for speech-to-text. */
export async function extractAudio(
  bins: FfmpegBins,
  file: string,
  start: number,
  len: number,
  out: string,
): Promise<string> {
  await run(
    bins.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(start),
      "-t",
      String(len),
      "-i",
      file,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      out,
    ],
    Math.max(120_000, len * 2000),
  );
  return out;
}

/** Small browser-playable H.264 proxy (360p) for the player in both lanes. */
export async function makeProxy(
  bins: FfmpegBins,
  file: string,
  out: string,
  hasAudio: boolean,
  duration: number,
): Promise<string> {
  await run(
    bins.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      file,
      "-vf",
      "scale=-2:'min(360,ih)'",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "31",
      "-maxrate",
      "600k",
      "-bufsize",
      "1200k",
      "-pix_fmt",
      "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "64k", "-ac", "1"] : ["-an"]),
      "-movflags",
      "+faststart",
      out,
    ],
    Math.max(300_000, duration * 3000),
  );
  return out;
}
