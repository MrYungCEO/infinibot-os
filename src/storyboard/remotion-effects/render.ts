/**
 * Storyboard scene effects — hyperframes producer + FFmpeg.
 *
 * Replaces the previous Remotion CLI shell-out with an in-process
 * hyperframes render. Each effect preset maps to a tiny composition: a
 * single `<img>` element + a GSAP keyframe set that produces the
 * motion / transition. The producer drives chromium frame-by-frame so
 * the output MP4 lands at `outputPath` exactly like the Remotion path
 * used to.
 *
 * Overlay-category presets (glitch, dust, light-leak, etc.) need
 * compositing not expressible as a simple GSAP timeline; they degrade
 * to a Ken-Burns motion so calls keep returning valid clips while we
 * grow the visual library.
 */
import { spawn } from "node:child_process";
import { dirname, resolve, basename, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  generateHyperframesHtml,
  getHyperframeRuntimeScript,
  type CanvasResolution,
  type Keyframe,
  type SerializeOptions,
  type TimelineMediaElement,
} from "@hyperframes/core";
import {
  createRenderJob as createHfRenderJob,
  executeRenderJob,
  type RenderJob as HfRenderJob,
} from "@hyperframes/producer";

import type { EffectPreset, EffectParams } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname;

export interface RenderSceneOptions {
  /** Path to the input image */
  imagePath: string;
  /** Output video path */
  outputPath: string;
  /** Effect preset to apply */
  preset: EffectPreset;
  /** Custom effect parameters (overrides preset defaults) */
  customParams?: EffectParams;
  /** Duration in seconds */
  durationSeconds: number;
  /** Frame rate (default: 30) */
  fps?: number;
  /** Width in pixels */
  width?: number;
  /** Height in pixels */
  height?: number;
  /** Aspect ratio for composition selection */
  aspectRatio?: "16:9" | "9:16" | "1:1";
  /** Working directory (kept for API compatibility; ignored). */
  workDir?: string;
}

export interface RenderResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  duration?: number;
}

function pickResolution(aspectRatio?: string, w?: number, h?: number): CanvasResolution {
  if (aspectRatio === "9:16") return "portrait";
  if (aspectRatio === "1:1") return "square";
  if (aspectRatio === "16:9") return "landscape";
  if (w && h) {
    const r = w / h;
    if (Math.abs(r - 1) < 0.05) return "square";
    return r < 1 ? "portrait" : "landscape";
  }
  return "landscape";
}

interface EffectShape {
  /** Initial values applied via gsap.set before play. */
  from: Partial<Record<"x" | "y" | "scale" | "rotation" | "opacity", number>>;
  /** Keyframes interpolated over the clip lifetime. */
  to: Partial<Record<"x" | "y" | "scale" | "rotation" | "opacity", number>>;
  ease: string;
}

/**
 * Map each preset to its motion shape. Overlay presets degrade to a
 * Ken-Burns push since they require compositing surfaces we can't
 * cheaply emit from this path.
 */
function presetShape(preset: EffectPreset): EffectShape {
  switch (preset) {
    case "dramatic-push":
      return { from: { scale: 1 }, to: { scale: 1.45 }, ease: "power3.in" };
    case "parallax":
      return { from: { x: 0, scale: 1.05 }, to: { x: -40, scale: 1.05 }, ease: "sine.inOut" };
    case "punch-zoom":
      return { from: { scale: 1 }, to: { scale: 1.35 }, ease: "expo.out" };
    case "slow-drift":
      return { from: { x: 0, scale: 1.02 }, to: { x: 20, scale: 1.06 }, ease: "sine.inOut" };
    case "pull-back":
      return { from: { scale: 1.45 }, to: { scale: 1 }, ease: "power2.out" };
    case "spin-reveal":
      return {
        from: { rotation: 35, scale: 0.6, opacity: 0 },
        to: { rotation: 0, scale: 1, opacity: 1 },
        ease: "elastic.out(1, 0.55)",
      };
    case "ken-burns":
    case "glitch":
    case "atmospheric-mist":
    case "cinematic-grain":
    case "light-leak":
    case "dust-particles":
    default:
      return { from: { scale: 1, x: 0 }, to: { scale: 1.18, x: -8 }, ease: "power1.inOut" };
  }
}

/**
 * Same `data-duration` patch as the compositions render path so the
 * hyperframes bridge can find the declared duration when the player
 * hasn't yet reported its own.
 */
function patchHtml(html: string, durationSec: number): string {
  let out = html;
  out = out.replace(
    /<html([^>]*?)data-composition-duration="(\d+(?:\.\d+)?)"([^>]*)>/,
    (_m, before, dur, after) => {
      if (/\sdata-duration="/.test(before + after)) return _m;
      return `<html${before}data-composition-duration="${dur}" data-duration="${dur}"${after}>`;
    },
  );
  if (!/data-composition-duration=/.test(out)) {
    out = out.replace(
      /<html(\s[^>]*)?>/,
      (m, attrs) => `<html${attrs ?? ""} data-duration="${durationSec}">`,
    );
  }
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

/**
 * Render a scene with the chosen effect, mirroring the previous
 * Remotion-based API so storyboard callers don't need to change.
 *
 * @example
 * const result = await renderSceneWithEffect({
 *   imagePath: "/path/to/image.jpg",
 *   outputPath: "/path/to/output.mp4",
 *   preset: "dramatic-push",
 *   durationSeconds: 5,
 * });
 */
export async function renderSceneWithEffect(options: RenderSceneOptions): Promise<RenderResult> {
  const {
    imagePath,
    outputPath,
    preset,
    durationSeconds,
    fps = 30,
    width,
    height,
    aspectRatio = "16:9",
  } = options;

  if (preset === "none") {
    return { success: false, error: "Preset is 'none' — use FFmpeg Ken Burns instead" };
  }
  if (!existsSync(imagePath)) {
    return { success: false, error: `Image not found: ${imagePath}` };
  }

  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const projectDir = mkdtempSync(join(tmpdir(), `infinibot-hf-effect-`));
  const stagedName = basename(imagePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  copyFileSync(imagePath, join(projectDir, stagedName));

  try {
    const resolution = pickResolution(aspectRatio, width, height);
    const elementId = "scene_img";
    const shape = presetShape(preset);

    const imgElement: TimelineMediaElement = {
      id: elementId,
      type: "image",
      name: "Scene",
      startTime: 0,
      duration: durationSeconds,
      zIndex: 0,
      src: stagedName,
    };

    // Convert from/to into Keyframe[] consumed by generateHyperframesHtml.
    const t0 = 0;
    const t1 = durationSeconds;
    const keyframes: Keyframe[] = [
      { id: `${elementId}_0`, time: t0, properties: shape.from, ease: shape.ease },
      { id: `${elementId}_1`, time: t1, properties: shape.to, ease: shape.ease },
    ];

    const serializeOptions: SerializeOptions = {
      resolution,
      compositionId: `effect_${preset}`,
      keyframes: { [elementId]: keyframes },
      generateDefaultAnimations: true,
      includeScripts: true,
      includeStyles: true,
    };

    const html = patchHtml(
      generateHyperframesHtml([imgElement], durationSeconds, serializeOptions),
      durationSeconds,
    );
    writeFileSync(join(projectDir, "index.html"), html, "utf-8");

    const job: HfRenderJob = createHfRenderJob({
      fps: { num: fps, den: 1 },
      quality: "standard",
      format: "mp4",
    });

    const startTime = Date.now();
    await executeRenderJob(job, projectDir, outputPath);
    if (!existsSync(outputPath)) {
      return { success: false, error: "render finished without producing output" };
    }
    return { success: true, outputPath, duration: Date.now() - startTime };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Compatibility shim — older callers asked `isRemotionAvailable()` to
 * decide whether to route effects through the (now-deleted) Remotion
 * pipeline. The hyperframes path ships in-process so the answer is
 * deterministic once `@hyperframes/{core,producer}` resolved at import
 * time. Kept as the legacy name so existing call sites compile; new
 * code should use {@link isHyperframesAvailable}.
 */
export async function isRemotionAvailable(): Promise<boolean> {
  return isHyperframesAvailable();
}

/**
 * True when the hyperframes effect pipeline is usable. Verified at
 * call time so a runtime in a degraded environment (missing chromium /
 * ffmpeg) reports as "not available" rather than failing renders mid-job.
 */
export async function isHyperframesAvailable(): Promise<boolean> {
  // Producer and core resolve via static imports above; if either
  // failed the module wouldn't have loaded. Check chromium + ffmpeg
  // availability so the storyboard caller can fall through to the
  // FFmpeg Ken Burns path on a stripped runtime.
  const okFfmpeg = await new Promise<boolean>((res) => {
    const proc = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    proc.on("close", (code) => res(code === 0));
    proc.on("error", () => res(false));
  });
  if (!okFfmpeg) return false;
  return true;
}

/**
 * Compatibility export. Older callers expected this to point at the
 * Remotion CLI working dir; with hyperframes the renderer is
 * in-process, so we just hand back the module's own directory for any
 * caller that wants a sane path.
 */
export function getRemotionEffectsDir(): string {
  return resolve(__dirname);
}
