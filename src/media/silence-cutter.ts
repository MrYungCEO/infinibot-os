/**
 * Silence Cutter — Native ffmpeg pipeline
 *
 * Replaces the external VideoSwift Python service with an in-process
 * implementation using the system ffmpeg binary. Same algorithm:
 *   1. Probe duration
 *   2. silencedetect to find silent intervals
 *   3. Invert to keep-intervals (≥ 150 ms)
 *   4. Cut each segment with libx264/aac
 *   5. Concat into the final file
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export interface SilenceCutOptions {
  thresholdDb: number; // e.g. -35
  minSilenceLen: number; // seconds, e.g. 0.5
  ffmpegBin?: string; // defaults to "ffmpeg" on PATH
}

export interface SilenceCutResult {
  outputPath: string;
  durationIn: number;
  durationOut: number;
  silences: Array<[number, number]>;
  keepIntervals: Array<[number, number]>;
}

function runFFmpegCapture(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/**
 * Collect plausible ffmpeg binary locations. On Windows, the gateway process
 * often runs without the user's PATH (service/Electron/PM2 launchers), so a
 * bare "ffmpeg" spawn fails even when the user has ffmpeg installed. We walk
 * the common install locations (winget, chocolatey, scoop, manual C:\ffmpeg).
 */
function ffmpegCandidates(userProvided?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  if (userProvided) push(userProvided);
  push("ffmpeg");
  if (process.platform === "win32") push("ffmpeg.exe");

  if (process.platform === "win32") {
    const home = homedir();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    // 1) winget shim link (user PATH), if present
    push(path.join(localAppData, "Microsoft", "WinGet", "Links", "ffmpeg.exe"));

    // 2) winget package install tree — walk Gyan.FFmpeg_* subfolders
    try {
      const pkgRoot = path.join(localAppData, "Microsoft", "WinGet", "Packages");
      const entries = readdirSync(pkgRoot, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || !e.name.toLowerCase().startsWith("gyan.ffmpeg")) continue;
        const pkgDir = path.join(pkgRoot, e.name);
        // ffmpeg-*-full_build\bin\ffmpeg.exe
        try {
          for (const inner of readdirSync(pkgDir, { withFileTypes: true })) {
            if (!inner.isDirectory()) continue;
            const bin = path.join(pkgDir, inner.name, "bin", "ffmpeg.exe");
            if (existsSync(bin)) push(bin);
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore — winget may not be present */
    }

    // 3) chocolatey
    push("C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe");
    push(path.join(programFiles, "chocolatey", "bin", "ffmpeg.exe"));

    // 4) scoop (user-scope)
    push(path.join(home, "scoop", "shims", "ffmpeg.exe"));
    push(path.join(home, "scoop", "apps", "ffmpeg", "current", "bin", "ffmpeg.exe"));

    // 5) manual installs
    push("C:\\ffmpeg\\bin\\ffmpeg.exe");
    push(path.join(programFiles, "ffmpeg", "bin", "ffmpeg.exe"));
    push(path.join(programFilesX86, "ffmpeg", "bin", "ffmpeg.exe"));
  } else {
    // Unix-y fallbacks beyond PATH
    push("/usr/local/bin/ffmpeg");
    push("/usr/bin/ffmpeg");
    push("/opt/homebrew/bin/ffmpeg");
    push("/snap/bin/ffmpeg");
  }

  return out;
}

let resolvedFfmpegCache: { key: string; bin: string | null } | null = null;

/**
 * Return a usable ffmpeg binary path, trying PATH first then common install
 * locations. Result is cached per userProvided value so we don't re-probe on
 * every call.
 */
export async function resolveFfmpegBin(userProvided?: string): Promise<string | null> {
  const key = userProvided ?? "";
  if (resolvedFfmpegCache?.key === key && resolvedFfmpegCache.bin) {
    return resolvedFfmpegCache.bin;
  }
  for (const candidate of ffmpegCandidates(userProvided)) {
    // For absolute paths, short-circuit on non-existence to avoid spawn errors.
    if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
    try {
      const { code } = await runFFmpegCapture(candidate, ["-version"]);
      if (code === 0) {
        resolvedFfmpegCache = { key, bin: candidate };
        return candidate;
      }
    } catch {
      /* try next */
    }
  }
  resolvedFfmpegCache = { key, bin: null };
  return null;
}

export function clearFfmpegResolutionCache(): void {
  resolvedFfmpegCache = null;
}

async function runFFmpegOrThrow(bin: string, args: string[]): Promise<string> {
  const { code, stderr } = await runFFmpegCapture(bin, args);
  if (code !== 0) {
    throw new Error(`ffmpeg failed (exit ${code}): ${stderr.split("\n").slice(-20).join("\n")}`);
  }
  return stderr;
}

function parseDuration(stderr: string): number | null {
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("Duration:")) {
      const timePart = line.split("Duration:", 2)[1]?.split(",", 1)[0]?.trim();
      if (!timePart) return null;
      const parts = timePart.split(":");
      if (parts.length !== 3) return null;
      const [h, m, s] = parts;
      const hours = Number(h);
      const minutes = Number(m);
      const seconds = Number(s);
      if (!Number.isFinite(hours + minutes + seconds)) return null;
      return hours * 3600 + minutes * 60 + seconds;
    }
  }
  return null;
}

function parseSilences(stderr: string): Array<[number, number]> {
  const silences: Array<[number, number]> = [];
  let currentStart: number | null = null;
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    const startIdx = line.indexOf("silence_start:");
    if (startIdx >= 0) {
      const token = line
        .slice(startIdx + "silence_start:".length)
        .trim()
        .split(/\s+/)[0];
      const value = Number(token);
      if (Number.isFinite(value)) currentStart = value;
      continue;
    }
    const endIdx = line.indexOf("silence_end:");
    if (endIdx >= 0 && currentStart !== null) {
      const token = line
        .slice(endIdx + "silence_end:".length)
        .trim()
        .split(/\s+/)[0];
      const value = Number(token);
      if (Number.isFinite(value)) {
        silences.push([currentStart, value]);
      }
      currentStart = null;
    }
  }
  silences.sort((a, b) => a[0] - b[0]);
  return silences;
}

function invertToKeepIntervals(
  duration: number,
  silences: Array<[number, number]>,
): Array<[number, number]> {
  const keep: Array<[number, number]> = [];
  let cursor = 0;
  for (const [sStart, sEnd] of silences) {
    if (sStart > cursor) keep.push([cursor, sStart]);
    cursor = Math.max(cursor, sEnd);
  }
  if (cursor < duration - 0.05) keep.push([cursor, duration]);
  // Drop micro-fragments that would cause keyframe issues.
  return keep.filter(([a, b]) => b - a > 0.15);
}

export async function cutSilences(
  inputPath: string,
  outputPath: string,
  options: SilenceCutOptions,
): Promise<SilenceCutResult> {
  const ffmpeg = (await resolveFfmpegBin(options.ffmpegBin)) ?? options.ffmpegBin ?? "ffmpeg";
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  // 1. Probe duration
  const probeStderr = await runFFmpegCapture(ffmpeg, ["-hide_banner", "-i", inputPath]);
  const duration = parseDuration(probeStderr.stderr);
  if (duration === null) {
    throw new Error(
      `Could not parse duration from ffmpeg output. Is the file valid? stderr tail: ${probeStderr.stderr.slice(-400)}`,
    );
  }

  // 2. Detect silences
  const detectStderr = await runFFmpegOrThrow(ffmpeg, [
    "-hide_banner",
    "-i",
    inputPath,
    "-af",
    `silencedetect=noise=${options.thresholdDb}dB:d=${options.minSilenceLen}`,
    "-f",
    "null",
    "-",
  ]);
  const silences = parseSilences(detectStderr);

  // 3. Invert to keep-intervals
  const keep = invertToKeepIntervals(duration, silences);

  const tmpDir = mkdtempSync(path.join(tmpdir(), "moltbot-silence-"));
  try {
    // Handle the "nothing silent" edge case: just copy input.
    if (keep.length === 0) {
      await runFFmpegOrThrow(ffmpeg, ["-y", "-i", inputPath, "-c", "copy", outputPath]);
      return {
        outputPath,
        durationIn: duration,
        durationOut: duration,
        silences,
        keepIntervals: [],
      };
    }

    // 4. Cut each keep-interval
    const segmentPaths: string[] = [];
    for (let i = 0; i < keep.length; i++) {
      const [start, end] = keep[i]!;
      const segPath = path.join(tmpDir, `seg_${String(i).padStart(4, "0")}.mp4`);
      await runFFmpegOrThrow(ffmpeg, [
        "-y",
        "-ss",
        String(start),
        "-to",
        String(end),
        "-i",
        inputPath,
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-preset",
        "veryfast",
        "-movflags",
        "+faststart",
        segPath,
      ]);
      segmentPaths.push(segPath);
    }

    // 5. Concat via demuxer list
    const listPath = path.join(tmpDir, "concat.txt");
    const listBody = segmentPaths
      .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(listPath, listBody, "utf8");

    await runFFmpegOrThrow(ffmpeg, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ]);

    const durationOut = keep.reduce((acc, [a, b]) => acc + (b - a), 0);
    return { outputPath, durationIn: duration, durationOut, silences, keepIntervals: keep };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

export async function downloadVideoToPath(url: string, targetPath: string): Promise<void> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const nodeStream = Readable.fromWeb(
    res.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  await pipeline(nodeStream, createWriteStream(targetPath));
}

export async function isFfmpegAvailable(bin = "ffmpeg"): Promise<boolean> {
  const resolved = await resolveFfmpegBin(bin === "ffmpeg" ? undefined : bin);
  return resolved !== null;
}
