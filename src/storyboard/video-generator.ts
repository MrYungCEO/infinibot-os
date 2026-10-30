/**
 * Storyboard Video Generator — FFmpeg Ken Burns effects & video assembly
 *
 * Converts static scene images into animated clips with subtle zoom/pan,
 * then assembles into final video.
 */

import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import type { StoryboardProject, EffectPreset } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type ZoomDirection = "in" | "out" | "random";
export type PanDirection = "left" | "right" | "up" | "down" | "random" | "none";

export interface KenBurnsOptions {
  zoomDirection: ZoomDirection;
  zoomAmount: number; // 1.0 = no zoom, 1.2 = 20% zoom
  panDirection: PanDirection;
  panAmount: number; // Pixels to pan
  easing: "linear" | "ease-in" | "ease-out" | "ease-in-out";
}

export interface VideoGenOptions {
  inputImage: string;
  outputPath: string;
  duration: number; // seconds
  fps: number;
  width?: number;
  height?: number;
  kenBurns?: KenBurnsOptions;
}

export interface AssembleOptions {
  clips: { path: string; duration: number }[];
  outputPath: string;
  fps: number;
  includeAudio?: boolean;
  audioPath?: string;
  fadeTransition?: number; // seconds
}

// ═══════════════════════════════════════════════════════════════
// DEFAULT OPTIONS
// ═══════════════════════════════════════════════════════════════

const DEFAULT_KEN_BURNS: KenBurnsOptions = {
  zoomDirection: "random",
  zoomAmount: 1.08, // 8% zoom - subtle
  panDirection: "random",
  panAmount: 30,
  easing: "ease-in-out",
};

type HyperframesRenderModule = typeof import("./remotion-effects/render.js");

let hyperframesRenderModulePromise: Promise<HyperframesRenderModule> | null = null;

async function loadHyperframesRenderModule(): Promise<HyperframesRenderModule> {
  if (!hyperframesRenderModulePromise) {
    hyperframesRenderModulePromise = import("./remotion-effects/render.js");
  }
  return hyperframesRenderModulePromise;
}

const ZOOM_EFFECTS = [
  { zoom: "in", x: "center", y: "center" },
  { zoom: "out", x: "center", y: "center" },
  { zoom: "in", x: "left", y: "top" },
  { zoom: "in", x: "right", y: "bottom" },
  { zoom: "out", x: "left", y: "bottom" },
  { zoom: "out", x: "right", y: "top" },
];

// ═══════════════════════════════════════════════════════════════
// KEN BURNS CLIP GENERATION
// ═══════════════════════════════════════════════════════════════

export async function generateKenBurnsClip(
  options: VideoGenOptions,
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const {
    inputImage,
    outputPath,
    duration,
    fps = 30,
    width = 1920,
    height = 1080,
    kenBurns = DEFAULT_KEN_BURNS,
  } = options;

  // Ensure output directory exists
  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Pick random effect if random mode
  const effect = pickKenBurnsEffect(kenBurns);

  // Build FFmpeg zoompan filter
  const filter = buildZoompanFilter({
    duration,
    fps,
    width,
    height,
    ...effect,
  });

  const args = [
    "-y", // Overwrite output
    "-loop",
    "1", // Loop input image
    "-i",
    inputImage,
    "-vf",
    filter,
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    outputPath,
  ];

  return runFFmpeg(args);
}

function pickKenBurnsEffect(options: KenBurnsOptions): {
  zoomIn: boolean;
  zoomAmount: number;
  panX: number;
  panY: number;
} {
  // Determine zoom direction
  let zoomIn = options.zoomDirection === "in";
  if (options.zoomDirection === "random") {
    zoomIn = Math.random() > 0.5;
  }

  // Determine pan direction
  let panX = 0;
  let panY = 0;

  let panDir = options.panDirection;
  if (panDir === "random") {
    const dirs: PanDirection[] = ["left", "right", "up", "down", "none"];
    panDir = dirs[Math.floor(Math.random() * dirs.length)];
  }

  const panAmount = options.panAmount;
  switch (panDir) {
    case "left":
      panX = -panAmount;
      break;
    case "right":
      panX = panAmount;
      break;
    case "up":
      panY = -panAmount;
      break;
    case "down":
      panY = panAmount;
      break;
  }

  return {
    zoomIn,
    zoomAmount: options.zoomAmount,
    panX,
    panY,
  };
}

function buildZoompanFilter(opts: {
  duration: number;
  fps: number;
  width: number;
  height: number;
  zoomIn: boolean;
  zoomAmount: number;
  panX: number;
  panY: number;
}): string {
  const { duration, fps, width, height, zoomIn, zoomAmount, panX, panY } = opts;
  const totalFrames = Math.ceil(duration * fps);

  // Calculate zoom per frame
  // For zoom in: start at 1, end at zoomAmount
  // For zoom out: start at zoomAmount, end at 1
  const startZoom = zoomIn ? 1 : zoomAmount;
  const endZoom = zoomIn ? zoomAmount : 1;

  // zoompan filter syntax:
  // z: zoom level expression
  // x, y: pan position expressions
  // d: duration in frames
  // s: output size
  // fps: frame rate

  // Expression for smooth zoom
  // on=frame_number, pzoom=previous_zoom
  const zoomExpr = zoomIn
    ? `zoom+${(zoomAmount - 1) / totalFrames}` // Increase zoom each frame
    : `if(eq(on,1),${zoomAmount},zoom-${(zoomAmount - 1) / totalFrames})`; // Decrease from zoomAmount

  // Pan expressions (move from center, accounting for zoom)
  // x = (iw - iw/zoom)/2 + offset based on frame
  const panXPerFrame = panX / totalFrames;
  const panYPerFrame = panY / totalFrames;

  const xExpr = `(iw-iw/zoom)/2+${panXPerFrame}*on`;
  const yExpr = `(ih-ih/zoom)/2+${panYPerFrame}*on`;

  // Scale up first to have room for zoom, then apply zoompan
  return [
    `scale=8000:-1`, // Scale up for smooth zoom
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${width}x${height}:fps=${fps}`,
  ].join(",");
}

// ═══════════════════════════════════════════════════════════════
// VIDEO ASSEMBLY
// ═══════════════════════════════════════════════════════════════

export async function assembleVideo(
  options: AssembleOptions,
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const { clips, outputPath, fps, fadeTransition = 0.5 } = options;

  if (clips.length === 0) {
    return { success: false, error: "No clips to assemble" };
  }

  // Ensure output directory exists
  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Create concat file
  const concatPath = resolve(outDir, `concat_${Date.now()}.txt`);
  const concatContent = clips.map((c) => `file '${c.path.replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync(concatPath, concatContent);

  try {
    // Simple concat with crossfade
    if (fadeTransition > 0 && clips.length > 1) {
      // Complex filter for crossfades
      return await assembleWithCrossfade(clips, outputPath, fps, fadeTransition);
    } else {
      // Simple concat
      const args = [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatPath,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(fps),
        outputPath,
      ];

      const result = await runFFmpeg(args);
      unlinkSync(concatPath);
      return result;
    }
  } catch (err) {
    try {
      unlinkSync(concatPath);
    } catch {}
    return { success: false, error: String(err) };
  }
}

async function assembleWithCrossfade(
  clips: { path: string; duration: number }[],
  outputPath: string,
  fps: number,
  fadeSeconds: number,
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  // Build FFmpeg complex filter for crossfades
  const inputs: string[] = [];
  const filterParts: string[] = [];

  clips.forEach((clip, i) => {
    inputs.push("-i", clip.path);
  });

  // Build xfade chain
  // [0][1]xfade=transition=fade:duration=0.5:offset=D1[v01]
  // [v01][2]xfade=...

  let prevLabel = "0:v";
  let offset = 0;

  for (let i = 0; i < clips.length - 1; i++) {
    const nextLabel = i === clips.length - 2 ? "outv" : `v${i}${i + 1}`;
    const clipDuration = clips[i].duration;

    filterParts.push(
      `[${prevLabel}][${i + 1}:v]xfade=transition=fade:duration=${fadeSeconds}:offset=${offset + clipDuration - fadeSeconds}[${nextLabel}]`,
    );

    offset += clipDuration - fadeSeconds;
    prevLabel = nextLabel;
  }

  // If only one clip, just copy it
  if (clips.length === 1) {
    const args = [
      "-y",
      "-i",
      clips[0].path,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ];
    return runFFmpeg(args);
  }

  const filterComplex = filterParts.join(";");

  const args = [
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    outputPath,
  ];

  return runFFmpeg(args);
}

// ═══════════════════════════════════════════════════════════════
// FULL STORYBOARD EXPORT
// ═══════════════════════════════════════════════════════════════

export async function exportStoryboardVideo(
  project: StoryboardProject,
  outputDir: string,
  options?: {
    fps?: number;
    fadeTransition?: number;
    kenBurns?: KenBurnsOptions;
    forceRemotionCheck?: boolean; // Check effect-renderer availability before starting
  },
): Promise<{ success: boolean; outputPath?: string; error?: string; clips?: string[] }> {
  const fps = options?.fps || 30;
  const kenBurns = options?.kenBurns || DEFAULT_KEN_BURNS;
  const fadeTransition = options?.fadeTransition ?? 0.3;

  // Filter scenes with completed images
  const completedScenes = project.scenes.filter((s) => s.imageStatus === "complete" && s.imageUrl);

  if (completedScenes.length === 0) {
    return { success: false, error: "No completed scene images to export" };
  }

  // Check if any scenes use motion/transition effects (formerly Remotion-only).
  const scenesWithEffects = completedScenes.filter(
    (s) => s.effectPreset && s.effectPreset !== "none",
  );

  // Probe the hyperframes effect renderer if any scene needs effects.
  let effectsAvailable = false;
  if (scenesWithEffects.length > 0 || options?.forceRemotionCheck) {
    try {
      const { isHyperframesAvailable } = await loadHyperframesRenderModule();
      effectsAvailable = await isHyperframesAvailable();
    } catch {
      effectsAvailable = false;
    }
    if (scenesWithEffects.length > 0 && !effectsAvailable) {
      console.warn(
        `[VideoGen] ${scenesWithEffects.length} scenes request effects but the hyperframes effect renderer is unavailable. Using FFmpeg Ken Burns fallback.`,
      );
    }
  }

  // Ensure output directory
  const clipsDir = resolve(outputDir, "clips");
  if (!existsSync(clipsDir)) {
    mkdirSync(clipsDir, { recursive: true });
  }

  // Generate clips for each scene (mixed pipeline)
  const clips: { path: string; duration: number }[] = [];
  const clipPaths: string[] = [];

  for (const scene of completedScenes) {
    const inputPath = scene.imageUrl!.replace("file://", "");
    const sceneNum = String(scene.index).padStart(3, "0");
    const effectPreset = scene.effectPreset || "none";

    // Decide whether to use the hyperframes effect renderer or the
    // FFmpeg Ken Burns fallback (always available for "none").
    const useEffectRenderer = effectsAvailable && effectPreset !== "none";

    let outputPath: string;
    let result: { success: boolean; outputPath?: string; error?: string };

    if (useEffectRenderer) {
      outputPath = resolve(clipsDir, `scene_${sceneNum}_${effectPreset}.mp4`);
      console.log(`[VideoGen] Scene ${scene.index}: using hyperframes effect "${effectPreset}"`);

      try {
        const { renderSceneWithEffect } = await loadHyperframesRenderModule();
        result = await renderSceneWithEffect({
          imagePath: inputPath,
          outputPath,
          preset: effectPreset as EffectPreset,
          durationSeconds: scene.durationSeconds,
          fps,
          aspectRatio: project.aspectRatio as "16:9" | "9:16" | "1:1",
        });
      } catch (err) {
        result = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      // Use FFmpeg Ken Burns
      outputPath = resolve(clipsDir, `scene_${sceneNum}.mp4`);
      console.log(`[VideoGen] Scene ${scene.index}: Using FFmpeg Ken Burns`);

      result = await generateKenBurnsClip({
        inputImage: inputPath,
        outputPath,
        duration: scene.durationSeconds,
        fps,
        kenBurns,
      });
    }

    if (!result.success) {
      console.error(`[VideoGen] Failed to generate clip for scene ${scene.index}:`, result.error);
      continue;
    }

    clips.push({ path: outputPath, duration: scene.durationSeconds });
    clipPaths.push(outputPath);
  }

  if (clips.length === 0) {
    return { success: false, error: "Failed to generate any clips" };
  }

  // Assemble final video
  const finalPath = resolve(
    outputDir,
    `${project.name.replace(/[^a-zA-Z0-9]/g, "_")}_storyboard.mp4`,
  );

  const assembleResult = await assembleVideo({
    clips,
    outputPath: finalPath,
    fps,
    fadeTransition,
  });

  if (!assembleResult.success) {
    return { success: false, error: assembleResult.error, clips: clipPaths };
  }

  return { success: true, outputPath: finalPath, clips: clipPaths };
}

// ═══════════════════════════════════════════════════════════════
// FFMPEG RUNNER
// ═══════════════════════════════════════════════════════════════

function runFFmpeg(
  args: string[],
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", args, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        // Find output path from args
        const outputIdx = args.findIndex((a) => a.endsWith(".mp4"));
        resolve({ success: true, outputPath: outputIdx >= 0 ? args[outputIdx] : undefined });
      } else {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` });
      }
    });

    proc.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════

export function getAspectDimensions(aspectRatio: string): { width: number; height: number } {
  switch (aspectRatio) {
    case "9:16":
      return { width: 1080, height: 1920 };
    case "1:1":
      return { width: 1080, height: 1080 };
    case "4:3":
      return { width: 1440, height: 1080 };
    case "16:9":
    default:
      return { width: 1920, height: 1080 };
  }
}
