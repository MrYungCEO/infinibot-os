/**
 * Audio Tools — LUFS measurement, loudness normalization, sidechain
 * ducking. All built on `ffmpeg` so no extra dependencies.
 *
 * Platform targets (defaults map to the most common short-form specs):
 *   • TikTok / Reels / Shorts: integrated -14 LUFS, true-peak ≤ -1 dBTP
 *   • YouTube long-form:        integrated -14 LUFS, TP ≤ -1 dBTP
 *   • Broadcast (EBU R128):     integrated -23 LUFS, TP ≤ -1 dBTP
 *
 * The ducking helper layers a music bed under a voiceover with a
 * sidechain compressor — when the VO talks, the music drops; when the
 * VO pauses, music rides back up. Threshold/ratio/attack/release tuned
 * for spoken-word podcasts as defaults; tweak per project.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Types ─────────────────────────────────────────────────────

export interface LoudnessReading {
  /** Integrated loudness over the full file (LUFS). */
  integrated: number;
  /** True-peak (dBTP). */
  truePeak: number;
  /** Loudness range (LRA). */
  lra: number;
  /** Loudness threshold used by ffmpeg's gating. */
  threshold: number;
  /** Raw `ebur128` summary keyed exactly as ffmpeg printed it. */
  raw: Record<string, string>;
}

export interface LoudnessTarget {
  /** Integrated loudness target (LUFS). Default: -14. */
  integrated?: number;
  /** True-peak ceiling (dBTP). Default: -1. */
  truePeak?: number;
  /** Loudness range (LRA). Default: 11 (broadcast-friendly). */
  lra?: number;
}

export type DeliveryPreset = "tiktok" | "reels" | "shorts" | "youtube" | "broadcast";

export const LOUDNESS_PRESETS: Record<DeliveryPreset, Required<LoudnessTarget>> = {
  tiktok:    { integrated: -14, truePeak: -1, lra: 11 },
  reels:     { integrated: -14, truePeak: -1, lra: 11 },
  shorts:    { integrated: -14, truePeak: -1, lra: 11 },
  youtube:   { integrated: -14, truePeak: -1, lra: 11 },
  broadcast: { integrated: -23, truePeak: -1, lra: 11 },
};

export interface DuckingOptions {
  /** Threshold in dB the sidechain detector trips at. Default: -25. */
  threshold?: number;
  /** Compression ratio. Default: 8. */
  ratio?: number;
  /** Attack in ms — how fast the duck engages. Default: 5. */
  attackMs?: number;
  /** Release in ms — how fast the music returns. Default: 250. */
  releaseMs?: number;
  /** Dry music level before ducking (0..1). Default: 0.6. */
  bedLevel?: number;
}

// ── Helpers ───────────────────────────────────────────────────

function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || "ffmpeg";
}

function runFfmpeg(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${opts.timeoutMs ?? 600_000}ms`));
    }, opts.timeoutMs ?? 600_000);
    proc.stdout?.on("data", (b: Buffer) => { stdout += b.toString(); });
    proc.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.split("\n").slice(-5).join("\n")}`));
    });
  });
}

// ── Loudness measurement ─────────────────────────────────────

/**
 * Measure integrated LUFS, true-peak, and LRA for an audio source via
 * ffmpeg's `ebur128` filter. The filter prints a structured "Summary"
 * block at the end of its stderr stream which we parse out.
 */
export async function measureLoudness(filePath: string): Promise<LoudnessReading> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const { stderr } = await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-i", filePath,
    "-filter:a", "ebur128=peak=true",
    "-f", "null",
    "-", // null muxer
  ]);

  // ebur128's summary lines look like "  Integrated loudness:" then
  // indented "I:         -14.2 LUFS". Walk lines, capture key/value
  // pairs after the "Summary:" marker.
  const raw: Record<string, string> = {};
  const lines = stderr.split(/\r?\n/);
  let inSummary = false;
  for (const line of lines) {
    if (/Summary:/.test(line)) { inSummary = true; continue; }
    if (!inSummary) continue;
    const m = line.match(/^\s+([A-Za-z][A-Za-z _.()/0-9+-]*?):\s+(\S.*?)\s*$/);
    if (m) raw[m[1].trim()] = m[2].trim();
  }

  const num = (k: string): number => {
    const v = raw[k];
    if (!v) return Number.NaN;
    // Values are like "-14.2 LUFS" / "-1.3 dBFS" — split on space.
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : Number.NaN;
  };
  const integrated = num("I") || num("Integrated loudness");
  const truePeak = num("Peak") || num("True peak");
  const lra = num("LRA") || num("Loudness range");
  const threshold = num("Threshold");

  if (!Number.isFinite(integrated)) {
    throw new Error("ffmpeg ebur128 did not report integrated loudness");
  }
  return { integrated, truePeak, lra, threshold, raw };
}

// ── Normalization ────────────────────────────────────────────

/**
 * Two-pass loudnorm to a target LUFS. Pass 1 measures the source; pass
 * 2 applies the linear correction so the output sits exactly on target
 * without re-quantizing dynamics. Output codec defaults to AAC@192k
 * which covers TikTok/Reels/YT in one pass; override via opts.codec.
 */
export async function normalizeToTarget(
  inputPath: string,
  outputPath: string,
  preset: DeliveryPreset | LoudnessTarget = "tiktok",
  opts: { codec?: string; bitrate?: string } = {},
): Promise<{ output: string; before: LoudnessReading; after: LoudnessReading }> {
  if (!existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
  ensureDirFor(outputPath);

  const target = typeof preset === "string"
    ? LOUDNESS_PRESETS[preset]
    : { ...LOUDNESS_PRESETS.tiktok, ...preset };

  const before = await measureLoudness(inputPath);

  // Pass 1 — gather ffmpeg loudnorm's per-file analysis JSON. We run
  // with `print_format=json` so pass 2 can use the precise stats.
  const pass1Filter = `loudnorm=I=${target.integrated}:TP=${target.truePeak}:LRA=${target.lra}:print_format=json`;
  const { stderr: p1Err } = await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-i", inputPath,
    "-filter:a", pass1Filter,
    "-f", "null",
    "-",
  ]);

  // ffmpeg prints the JSON block at the end of stderr with a trailing
  // newline. Grab the last `{...}` we can find.
  const jsonMatch = p1Err.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  let stats: Record<string, string> | null = null;
  if (jsonMatch) {
    try { stats = JSON.parse(jsonMatch[0]); } catch { stats = null; }
  }

  // Pass 2 — apply with measured offsets. Falls back to single-pass
  // when stats parsing failed (still corrects, just less precisely).
  const pass2Filter = stats
    ? `loudnorm=I=${target.integrated}:TP=${target.truePeak}:LRA=${target.lra}` +
      `:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}` +
      `:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}` +
      `:offset=${stats.target_offset}:linear=true:print_format=summary`
    : `loudnorm=I=${target.integrated}:TP=${target.truePeak}:LRA=${target.lra}:print_format=summary`;

  const codec = opts.codec ?? "aac";
  const bitrate = opts.bitrate ?? "192k";
  await runFfmpeg([
    "-hide_banner",
    "-y",
    "-i", inputPath,
    "-filter:a", pass2Filter,
    "-c:a", codec,
    "-b:a", bitrate,
    outputPath,
  ]);

  const after = await measureLoudness(outputPath);
  return { output: outputPath, before, after };
}

// ── Sidechain ducking (music under VO) ───────────────────────

/**
 * Mix a music bed with a voiceover, ducking the bed when the VO is
 * speaking via ffmpeg's `sidechaincompress` filter.
 *
 * The filter graph:
 *   [bed]  →  volume=bedLevel  →  [bed-quiet]
 *   [bed-quiet] sidechaincompress(threshold,ratio,attack,release)←[vo] → [ducked]
 *   [vo] [ducked]  →  amix  →  [out]
 */
export async function sidechainDuck(
  bedPath: string,
  voPath: string,
  outputPath: string,
  options: DuckingOptions = {},
): Promise<{ output: string }> {
  if (!existsSync(bedPath)) throw new Error(`Music bed not found: ${bedPath}`);
  if (!existsSync(voPath)) throw new Error(`Voiceover not found: ${voPath}`);
  ensureDirFor(outputPath);

  const threshold = options.threshold ?? -25;
  const ratio = options.ratio ?? 8;
  const attackMs = options.attackMs ?? 5;
  const releaseMs = options.releaseMs ?? 250;
  const bedLevel = options.bedLevel ?? 0.6;

  // ffmpeg's sidechaincompress wants threshold as a linear gain (0..1)
  // — convert from dB.
  const linThreshold = Math.pow(10, threshold / 20);
  const filter = [
    `[0:a]volume=${bedLevel.toFixed(3)}[bed_pre]`,
    `[bed_pre][1:a]sidechaincompress=threshold=${linThreshold.toFixed(4)}:ratio=${ratio}:attack=${attackMs}:release=${releaseMs}:detection=peak[ducked]`,
    `[ducked][1:a]amix=inputs=2:duration=longest:dropout_transition=0[out]`,
  ].join(";");

  await runFfmpeg([
    "-hide_banner",
    "-y",
    "-i", bedPath,
    "-i", voPath,
    "-filter_complex", filter,
    "-map", "[out]",
    "-c:a", "aac",
    "-b:a", "192k",
    outputPath,
  ]);

  return { output: outputPath };
}
