/**
 * Composition render pipeline — hyperframes producer + FFmpeg.
 *
 * The InfiniBot timeline JSON model is the source of truth. At render
 * time we run it through `hyperframes-translator.ts` to produce a
 * hyperframes HTML composition, stage referenced media assets into a
 * temp project dir, then hand the dir to `@hyperframes/producer`'s
 * `executeRenderJob` which drives headless Chromium + FFmpeg end-to-end.
 *
 * Public surface preserved for gateway + agent callers:
 *   startRender()       → returns a jobId immediately, render runs in background
 *   getJob(id)          → polled by the UI for {status, progress, frame, total}
 *   cancelJob(id)       → kills the underlying browser + ffmpeg processes
 *   captureFrame()      → single-frame snapshot for agent grounding
 *   buildRenderHtml()   → kept as a thin wrapper around the translator so any
 *                         legacy callers continue to get a self-contained page
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  clampDurations,
  compileTimingAttrs,
  generateHyperframesHtml,
  getHyperframeRuntimeScript,
  injectDurations,
} from "@hyperframes/core";
import {
  createRenderJob as createHfRenderJob,
  executeRenderJob,
  RenderCancelledError,
  type RenderJob as HfRenderJob,
} from "@hyperframes/producer";

import { resolveFfmpegBin } from "../media/silence-cutter.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { assetsDir } from "./project-dir.js";
import { getCompositionsStore } from "./store.js";
import type { CompositionWithChildren } from "./types.js";
import { emitMediaArtifact } from "../proactive/media-artifacts.js";
import { compositionToHyperframes } from "./hyperframes-translator.js";
import { readTransitions } from "./transitions.js";

const log = createSubsystemLogger("comp-render");

// ── Job registry (in-memory; lives for the lifetime of the gateway) ──

export type RenderStatus =
  | "queued"
  | "preparing"
  | "rendering"
  | "encoding"
  | "completed"
  | "failed"
  | "cancelled";

export interface RenderJob {
  id: string;
  compositionId: string;
  status: RenderStatus;
  progress: number; // 0..1
  frame: number;
  totalFrames: number;
  startedAt: number;
  endedAt?: number;
  outputPath?: string;
  outputUrl?: string;
  error?: string;
  /** When the user clicks Cancel we set this and tear down the workers. */
  cancelToken: { aborted: boolean };
  /** AbortController forwarded into the producer's render pipeline. */
  abortController?: AbortController;
  /**
   * Latest preview frame as a JPEG buffer — snapped from the rendered
   * MP4 once the producer finishes so the UI thumbnail polls work even
   * though we don't stream frames manually anymore.
   */
  latestPreviewJpeg?: Buffer;
  latestPreviewFrame?: number;
  /**
   * Resolved transition windows for this render. Surfaces both the
   * structured intent (kind/duration/ease) AND the resolved time
   * window so a Phase 5 engine hook can intercept individual frames
   * for real shader compositing. UI polls render.status and shows
   * "wiping" / "dissolving" badges keyed to the current frame.
   */
  transitions?: RenderTransitionWindow[];
}

const jobs = new Map<string, RenderJob>();

export function getJob(id: string): RenderJob | undefined {
  return jobs.get(id);
}
export function listJobs(): RenderJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return false;
  }
  job.cancelToken.aborted = true;
  job.status = "cancelled";
  job.endedAt = Date.now();
  try {
    job.abortController?.abort();
  } catch {
    /* ignore */
  }
  return true;
}

// ── Output dir ──────────────────────────────────────────────────────

function outputRoot(): string {
  // Drop into the existing ~/.infinibot/media/ root so the gateway's
  // media file handler (handleMediaFileRequest) serves it without extra
  // wiring.
  const root = process.env.INFINIBOT_MEDIA_ROOT
    ? resolve(process.env.INFINIBOT_MEDIA_ROOT, "rendered-compositions")
    : resolve(homedir(), ".infinibot", "media", "rendered-compositions");
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

/** URL the gateway's media server can hand back to the browser. */
function publicUrlFor(filename: string): string {
  return `/media/rendered-compositions/${encodeURIComponent(filename)}`;
}

// ── Asset staging ───────────────────────────────────────────────────

/**
 * Resolve a clip src reference (relative path, absolute file path, a
 * `/media/assets/<compId>/<filename>` gateway URL, or a bare basename)
 * to an actual file on disk inside the composition's assets dir.
 */
function resolveClipAssetPath(compId: string, src: string): string | undefined {
  if (!src) return undefined;
  if (src.startsWith("http://") || src.startsWith("https://")) return undefined;
  if (src.startsWith("/")) {
    const candidate = src.startsWith("/media/assets/")
      ? join(assetsDir(compId), decodeURIComponent(src.split("/").slice(4).join("/")))
      : src;
    if (existsSync(candidate)) return candidate;
  }
  const local = join(assetsDir(compId), src.replace(/^\.\//, ""));
  if (existsSync(local)) return local;
  const fallback = join(assetsDir(compId), decodeURIComponent(basename(src)));
  if (existsSync(fallback)) return fallback;
  return undefined;
}

/**
 * Stage every media asset referenced by the translated timeline into
 * `projectDir` so the producer's file server hands them to chromium
 * with stable relative URLs. Mutates `elements[].src` in place.
 */
function stageAssets(
  comp: CompositionWithChildren,
  elements: ReadonlyArray<{ id: string; type: string; src?: string }>,
  projectDir: string,
): void {
  const used = new Set<string>();
  for (const el of elements) {
    if (!("src" in el) || typeof el.src !== "string" || !el.src) continue;
    if (el.src.startsWith("http://") || el.src.startsWith("https://")) continue;
    const resolved = resolveClipAssetPath(comp.id, el.src);
    if (!resolved) {
      log.warn(`asset for element ${el.id} not on disk: ${el.src}`);
      continue;
    }
    let name = basename(resolved);
    let attempt = 0;
    while (used.has(name)) {
      attempt += 1;
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
      const stem = ext ? name.slice(0, -ext.length) : name;
      name = `${stem}-${attempt}${ext}`;
    }
    used.add(name);
    copyFileSync(resolved, join(projectDir, name));
    (el as { src: string }).src = name;
  }
}

// ── HTML build (kept as a wrapper for any legacy callers) ───────────

/**
 * Tighten the generated hyperframes HTML so the producer's frame
 * capture finds the seek protocol on first paint.
 *
 * - `data-duration`: the producer's bridge polls
 *   `document.querySelector('[data-composition-id]').getAttribute('data-duration')`
 *   when window.__player isn't ready yet. `generateHyperframesHtml`
 *   only writes `data-composition-duration` and `data-duration` on the
 *   stage div, so we copy the value to the `<html>` element which
 *   actually carries `[data-composition-id]`.
 * - Hyperframe runtime IIFE: producer auto-injects this when serving
 *   the file, but injecting here as well gives `tsx`-based smoke
 *   harnesses and any consumer that hands the raw HTML to another
 *   renderer the same contract surface.
 */
function injectHfRuntime(html: string): string {
  let out = html;
  // 1. Copy data-composition-duration onto data-duration so the bridge
  //    can find a positive declared duration when the player hasn't yet
  //    started reporting its own.
  out = out.replace(
    /<html([^>]*?)data-composition-duration="(\d+(?:\.\d+)?)"([^>]*)>/,
    (_m, before, dur, after) => {
      if (/\sdata-duration="/.test(before + after)) {
        return _m;
      }
      return `<html${before}data-composition-duration="${dur}" data-duration="${dur}"${after}>`;
    },
  );
  // 2. Inline the runtime IIFE. Safe to repeat — the runtime is
  //    idempotent and the producer's auto-inject would skip embedded
  //    runtime markers (`__hyperframeRuntimeBootstrapped`).
  const runtime = getHyperframeRuntimeScript();
  if (runtime) {
    const tag = `<script data-hf-runtime="1">${runtime}</script>`;
    const headClose = out.indexOf("</head>");
    out =
      headClose === -1
        ? `${tag}\n${out}`
        : `${out.slice(0, headClose)}${tag}\n${out.slice(headClose)}`;
  }
  return out;
}

export function buildRenderHtml(comp: CompositionWithChildren): string {
  const t = compositionToHyperframes(comp);
  const html = generateHyperframesHtml(t.elements, t.totalDuration, t.options);
  // Timing compiler pass: ensures every `[data-start]` element ends up
  // with a consistent `data-end` AND clamps media durations to their
  // source so a 5.04s clip on a 3s declared duration plays the full
  // 3s without overrunning. Unresolved media (no declared duration)
  // gets its data-duration injected from the asset's known
  // sourceDurationSec — the editor's `quickAdd`s already write this on
  // upload, so the only "unresolved" cases are clips authored by a
  // remote agent or imported HTML.
  return injectHfRuntime(applyTimingCompiler(html, comp));
}

/**
 * Run the @hyperframes/core timing compiler against the generated
 * HTML and inject resolved durations from the composition's known
 * media assets.
 */
function applyTimingCompiler(html: string, comp: CompositionWithChildren): string {
  if (typeof compileTimingAttrs !== "function") return html;

  const compiled = compileTimingAttrs(html);
  let out = compiled.html;

  // Resolve unresolved media via the clip's `sourceDurationSec` (set on
  // the asset at upload time). The unresolved entry's `id` matches the
  // clip id we emitted on the generated element.
  const clipById = new Map<string, { sourceDurationSec?: number; durationSec: number }>();
  for (const clip of comp.clips) {
    const p = clip.props as { sourceDurationSec?: number; durationSec?: number };
    clipById.set(clip.id, {
      sourceDurationSec: p.sourceDurationSec,
      durationSec: clip.durationSec,
    });
  }
  const resolutions = compiled.unresolved
    .map((u: { id: string }) => {
      const meta = clipById.get(u.id);
      const dur = meta?.sourceDurationSec ?? meta?.durationSec;
      if (!dur || !Number.isFinite(dur) || dur <= 0) return null;
      return { id: u.id, duration: dur };
    })
    .filter(
      (x: { id: string; duration: number } | null): x is { id: string; duration: number } =>
        x !== null,
    );
  if (resolutions.length > 0) {
    out = injectDurations(out, resolutions);
  }

  // Clamp pass: any clip whose declared duration exceeds its known
  // source media duration gets clamped down — prevents the export
  // pipeline from trying to read 8s of frames from a 5s mp4.
  const clamps: Array<{ id: string; duration: number }> = [];
  for (const clip of comp.clips) {
    const p = clip.props as { sourceDurationSec?: number };
    if (
      typeof p.sourceDurationSec === "number" &&
      p.sourceDurationSec > 0 &&
      clip.durationSec > p.sourceDurationSec
    ) {
      clamps.push({ id: clip.id, duration: p.sourceDurationSec });
    }
  }
  if (clamps.length > 0) out = clampDurations(out, clamps);
  return out;
}

// ── Render entry point ─────────────────────────────────────────────

/**
 * Structured snapshot of a clip transition window — emitted alongside
 * the render job so a future Phase 5 can swap the CSS approximation in
 * the editor for real shader-driven compositing in the engine. Each
 * entry carries enough info that the engine can:
 *
 *   1. At time t ∈ [centerSec - durationSec/2, centerSec + durationSec/2],
 *      render the outgoing clip's "isolated" frame and the incoming
 *      clip's "isolated" frame separately (instead of one composited).
 *   2. Look up the `kind` and run @hyperframes/engine/shader-transitions
 *      math against the two rgb48le buffers.
 *   3. Write the blended frame to the output stream.
 *
 * `progress` callback fires once per transition window when the
 * composition advances into it during render, so any engine hook can
 * latch on without re-parsing the composition.
 */
export interface RenderTransitionWindow {
  id: string;
  fromClipId: string;
  toClipId: string;
  kind: string;
  centerSec: number;
  durationSec: number;
  ease?: string;
}

export interface StartRenderOptions {
  compositionId: string;
  /** Frame rate override; default = composition fps. */
  fps?: number;
  /** Output container; default mp4. */
  format?: "mp4" | "webm";
}

export async function startRender(opts: StartRenderOptions): Promise<RenderJob> {
  const stateDir = resolveStateDir();
  const store = getCompositionsStore(stateDir);
  const comp = store.getWithChildren(opts.compositionId);
  if (!comp) throw new Error(`Composition ${opts.compositionId} not found`);

  // Resolve transition windows up front so the job carries the
  // structured intent before the producer even spawns. A future Phase 5
  // can read job.transitions inside an engine hook to invoke shader
  // compositing instead of trusting the CSS approximation.
  const transitionsRaw = readTransitions(comp.meta as Record<string, unknown> | undefined);
  const clipById = new Map(comp.clips.map((c) => [c.id, c] as const));
  const transitionWindows: RenderTransitionWindow[] = [];
  for (const tr of transitionsRaw) {
    const fromClip = clipById.get(tr.fromClipId);
    const toClip = clipById.get(tr.toClipId);
    if (!fromClip || !toClip) continue;
    const fromEnd = fromClip.startSec + fromClip.durationSec;
    const toStart = toClip.startSec;
    transitionWindows.push({
      id: tr.id,
      fromClipId: tr.fromClipId,
      toClipId: tr.toClipId,
      kind: tr.kind,
      centerSec: (fromEnd + toStart) / 2,
      durationSec: tr.durationSec,
      ease: tr.ease,
    });
  }

  const job: RenderJob = {
    id: `render_${randomUUID()}`,
    compositionId: comp.id,
    status: "queued",
    progress: 0,
    frame: 0,
    totalFrames: 0,
    startedAt: Date.now(),
    cancelToken: { aborted: false },
    abortController: new AbortController(),
    transitions: transitionWindows.length > 0 ? transitionWindows : undefined,
  };
  jobs.set(job.id, job);

  if (transitionWindows.length > 0) {
    log.info(
      `render ${job.id}: ${transitionWindows.length} transition window${transitionWindows.length === 1 ? "" : "s"} resolved — shader-engine hook can intercept`,
    );
  }

  void run(job, comp, opts).catch((err) => {
    if (job.status !== "cancelled") {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.endedAt = Date.now();
    }
    log.warn(`render ${job.id} failed: ${job.error ?? "unknown"}`);
  });

  return job;
}

/**
 * Yank the final rendered MP4's last frame as a downsized JPEG so UI
 * polling clients always have a thumbnail available, even though we
 * don't stream frames manually through ffmpeg anymore.
 */
async function snapshotFinalFrame(mp4Path: string, ffmpegBin: string): Promise<Buffer | null> {
  return await new Promise((res) => {
    const args = [
      "-y",
      "-sseof",
      "-0.1",
      "-i",
      mp4Path,
      "-vf",
      "scale=480:-1",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-",
    ];
    const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c) => chunks.push(Buffer.from(c)));
    proc.on("close", () => res(chunks.length ? Buffer.concat(chunks) : null));
    proc.on("error", () => res(null));
  });
}

async function run(
  job: RenderJob,
  comp: CompositionWithChildren,
  opts: StartRenderOptions,
): Promise<void> {
  const fps = opts.fps && opts.fps > 0 ? Math.round(opts.fps) : comp.fps;
  const totalFrames = Math.max(1, Math.round(comp.durationSec * fps));
  job.totalFrames = totalFrames;
  job.status = "preparing";

  const ffmpegBin = (await resolveFfmpegBin()) ?? "ffmpeg";
  const outDir = outputRoot();
  const filename = `${comp.slug || comp.id}-${Date.now()}.${opts.format ?? "mp4"}`;
  const outPath = join(outDir, filename);

  const projectDir = mkdtempSync(join(tmpdir(), `infinibot-hf-${job.id}-`));
  const translation = compositionToHyperframes(comp);
  stageAssets(comp, translation.elements, projectDir);
  const html = injectHfRuntime(
    generateHyperframesHtml(translation.elements, translation.totalDuration, translation.options),
  );
  writeFileSync(join(projectDir, "index.html"), html, "utf-8");

  // Producer probes `ffmpeg` on PATH; surface our resolved binary by
  // prepending its dir so the spawn picks the right one.
  const prevPath = process.env.PATH;
  if (ffmpegBin !== "ffmpeg") {
    process.env.PATH = `${dirname(ffmpegBin)}:${process.env.PATH ?? ""}`;
  }

  const hfJob: HfRenderJob = createHfRenderJob({
    fps: { num: fps, den: 1 },
    quality: "standard",
    format: opts.format === "webm" ? "webm" : "mp4",
  });

  try {
    job.status = "rendering";
    await executeRenderJob(
      hfJob,
      projectDir,
      outPath,
      (status) => {
        // Producer's `progress` field is 0..1 in spec but observed to
        // exceed 1 mid-pipeline (e.g. capture phase). Clamp so the UI
        // progress bar stays sane.
        const p = Math.max(0, Math.min(1, status.progress));
        job.progress = p;
        job.frame = status.framesRendered ?? Math.round(p * totalFrames);
        if (status.status === "complete") {
          job.status = "completed";
        } else if (status.status === "failed") {
          job.status = "failed";
          job.error = status.error;
        } else if (status.status === "cancelled") {
          job.status = "cancelled";
        } else if (status.status === "encoding" || status.status === "assembling") {
          job.status = "encoding";
        } else {
          job.status = "rendering";
        }
      },
      job.abortController?.signal,
    );

    if (!existsSync(outPath)) {
      throw new Error("render finished without producing the output file");
    }
    job.outputPath = outPath;
    job.outputUrl = publicUrlFor(filename);
    job.status = "completed";
    job.progress = 1;
    job.frame = totalFrames;
    job.endedAt = Date.now();

    // Mandatory media visualization: the rendered video MUST appear on screen.
    emitMediaArtifact({
      agentId: "hyperframes",
      agentName: "Hyperframes",
      title: comp.name || comp.slug || comp.id,
      body: "Video render complete",
      dedupKey: `video:hyperframes:${job.id}`,
      media: {
        kind: "video",
        payload: {
          url: job.outputUrl,
          caption: comp.name || comp.slug || comp.id,
          durationMs: Math.round(comp.durationSec * 1000),
        },
      },
    });

    try {
      const snap = await snapshotFinalFrame(outPath, ffmpegBin);
      if (snap) {
        job.latestPreviewJpeg = snap;
        job.latestPreviewFrame = totalFrames - 1;
      }
    } catch {
      /* preview is best-effort */
    }
  } catch (err) {
    if (err instanceof RenderCancelledError || job.cancelToken.aborted) {
      job.status = "cancelled";
      job.endedAt = Date.now();
      return;
    }
    throw err;
  } finally {
    if (prevEnvShouldRestore(prevPath)) process.env.PATH = prevPath;
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function prevEnvShouldRestore(prev: string | undefined): prev is string {
  return prev !== undefined;
}

// ── Single-frame snapshot — multimodal grounding for the agent ────

export interface CaptureFrameOptions {
  compositionId: string;
  /** Composition-relative time. Defaults to 0. */
  atSec?: number;
  /** Optional override; shrinks the captured image proportionally for tokens. */
  maxWidth?: number;
}

export interface CapturedFrame {
  base64: string;
  mime: "image/png";
  widthPx: number;
  heightPx: number;
  atSec: number;
}

/**
 * Capture a single frame of a composition at `atSec` and return it as a
 * base64 PNG. Implemented by rendering a one-frame MP4 via the producer
 * and pulling the PNG out with ffmpeg — leaning on the producer keeps
 * us off the engine's lower-level surface.
 */
export async function captureFrame(opts: CaptureFrameOptions): Promise<CapturedFrame> {
  const stateDir = resolveStateDir();
  const store = getCompositionsStore(stateDir);
  const comp = store.getWithChildren(opts.compositionId);
  if (!comp) throw new Error(`Composition ${opts.compositionId} not found`);
  const atSec = Math.max(0, Math.min(comp.durationSec, opts.atSec ?? 0));
  const maxW = Math.max(120, Math.min(opts.maxWidth ?? 1280, comp.widthPx));
  const scale = maxW / comp.widthPx;
  const captureW = Math.round(comp.widthPx * scale);
  const captureH = Math.round(comp.heightPx * scale);
  const ffmpegBin = (await resolveFfmpegBin()) ?? "ffmpeg";

  const projectDir = mkdtempSync(join(tmpdir(), `infinibot-hf-snap-`));
  const outMp4 = join(projectDir, "snap.mp4");
  try {
    const translation = compositionToHyperframes(comp);
    stageAssets(comp, translation.elements, projectDir);
    const html = generateHyperframesHtml(
      translation.elements,
      translation.totalDuration,
      translation.options,
    );
    writeFileSync(join(projectDir, "index.html"), html, "utf-8");

    const fps = Math.max(1, comp.fps);
    const hfJob: HfRenderJob = createHfRenderJob({
      fps: { num: fps, den: 1 },
      quality: "draft",
      format: "mp4",
    });
    await executeRenderJob(hfJob, projectDir, outMp4);

    const pngBuf = await new Promise<Buffer>((res, rej) => {
      const args = [
        "-y",
        "-ss",
        atSec.toFixed(3),
        "-i",
        outMp4,
        "-frames:v",
        "1",
        "-vf",
        scale === 1 ? "null" : `scale=${captureW}:${captureH}`,
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-",
      ];
      const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      proc.stdout.on("data", (c) => chunks.push(Buffer.from(c)));
      proc.on("close", (code) =>
        code === 0 ? res(Buffer.concat(chunks)) : rej(new Error(`ffmpeg snap exited ${code}`)),
      );
      proc.on("error", rej);
    });

    return {
      base64: pngBuf.toString("base64"),
      mime: "image/png",
      widthPx: scale === 1 ? comp.widthPx : captureW,
      heightPx: scale === 1 ? comp.heightPx : captureH,
      atSec,
    };
  } finally {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
