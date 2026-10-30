/**
 * Image Processing Service
 *
 * Provides image manipulation capabilities accessible via federation:
 * - Cropping
 * - Upscaling (Real-ESRGAN, Lanczos, NVENC)
 * - Background removal (rembg)
 * - Format conversion
 *
 * All operations accept base64 input and return base64 output.
 */

import { exec as execCb } from "node:child_process";
import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSubsystemLogger } from "../logging/subsystem.js";

const exec = promisify(execCb);
const log = createSubsystemLogger("media").child("image");

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface CropOptions {
  /** Base64 encoded input image */
  input: string;
  /** Crop X position (pixels from left) */
  x: number;
  /** Crop Y position (pixels from top) */
  y: number;
  /** Crop width */
  width: number;
  /** Crop height */
  height: number;
  /** Output format (default: same as input) */
  format?: "png" | "jpg" | "webp";
}

export interface UpscaleOptions {
  /** Base64 encoded input image */
  input: string;
  /** Scale factor (2 or 4) */
  scale: 2 | 4;
  /** Upscaling model/method */
  model?: "realesrgan" | "lanczos" | "bicubic";
  /** Output format */
  format?: "png" | "jpg" | "webp";
}

export interface RemoveBgOptions {
  /** Base64 encoded input image */
  input: string;
  /** Output format (default: png for transparency) */
  format?: "png" | "webp";
  /** Alpha matting for edge refinement */
  alphaMatting?: boolean;
}

export interface BatchOperation {
  type: "crop" | "upscale" | "removeBg";
  options: CropOptions | UpscaleOptions | RemoveBgOptions;
}

export interface ImageResult {
  success: boolean;
  output?: string; // Base64
  format?: string;
  width?: number;
  height?: number;
  error?: string;
  processingTimeMs?: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

const TEMP_DIR = join(tmpdir(), "infinibot-media");

async function ensureTempDir(): Promise<void> {
  try {
    await mkdir(TEMP_DIR, { recursive: true });
  } catch {
    // Already exists
  }
}

function detectFormat(base64: string): string {
  if (base64.startsWith("/9j/")) return "jpg";
  if (base64.startsWith("iVBOR")) return "png";
  if (base64.startsWith("UklGR")) return "webp";
  if (base64.startsWith("R0lGO")) return "gif";
  return "png"; // Default
}

async function saveTempFile(base64: string, format?: string): Promise<string> {
  await ensureTempDir();
  const detectedFormat = format ?? detectFormat(base64);
  const filename = `${randomUUID()}.${detectedFormat}`;
  const filepath = join(TEMP_DIR, filename);
  const buffer = Buffer.from(base64, "base64");
  await writeFile(filepath, buffer);
  return filepath;
}

async function readAsBase64(filepath: string): Promise<string> {
  const buffer = await readFile(filepath);
  return buffer.toString("base64");
}

async function cleanup(...files: string[]): Promise<void> {
  for (const file of files) {
    try {
      await unlink(file);
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function getImageDimensions(filepath: string): Promise<{ width: number; height: number }> {
  try {
    // Try ImageMagick first
    const { stdout } = await exec(`magick identify -format "%w %h" "${filepath}"`, {
      timeout: 10000,
    });
    const [w, h] = stdout.trim().split(" ").map(Number);
    return { width: w, height: h };
  } catch {
    try {
      // Fall back to ffprobe
      const { stdout } = await exec(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filepath}"`,
        { timeout: 10000 },
      );
      const [w, h] = stdout.trim().split("x").map(Number);
      return { width: w, height: h };
    } catch {
      return { width: 0, height: 0 };
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Image Operations
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Crop an image to specified dimensions.
 */
export async function cropImage(options: CropOptions): Promise<ImageResult> {
  const startMs = Date.now();
  let inputPath = "";
  let outputPath = "";

  try {
    inputPath = await saveTempFile(options.input);
    const format = options.format ?? detectFormat(options.input);
    outputPath = join(TEMP_DIR, `${randomUUID()}.${format}`);

    // Use FFmpeg for cropping (faster, GPU accelerated if available)
    const cmd = `ffmpeg -y -i "${inputPath}" -vf "crop=${options.width}:${options.height}:${options.x}:${options.y}" "${outputPath}"`;
    await exec(cmd, { timeout: 30000 });

    const output = await readAsBase64(outputPath);
    const dims = await getImageDimensions(outputPath);

    log.info(`cropped image to ${options.width}x${options.height} in ${Date.now() - startMs}ms`);

    return {
      success: true,
      output,
      format,
      width: dims.width,
      height: dims.height,
      processingTimeMs: Date.now() - startMs,
    };
  } catch (err) {
    log.error(`crop failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      processingTimeMs: Date.now() - startMs,
    };
  } finally {
    await cleanup(inputPath, outputPath);
  }
}

/**
 * Upscale an image using specified method.
 */
export async function upscaleImage(options: UpscaleOptions): Promise<ImageResult> {
  const startMs = Date.now();
  let inputPath = "";
  let outputPath = "";

  try {
    inputPath = await saveTempFile(options.input);
    const format = options.format ?? detectFormat(options.input);
    outputPath = join(TEMP_DIR, `${randomUUID()}.${format}`);
    const model = options.model ?? "lanczos";

    if (model === "realesrgan") {
      // Use Real-ESRGAN (best quality, requires installation)
      try {
        const cmd = `python -m realesrgan.inference_realesrgan -i "${inputPath}" -o "${outputPath}" -s ${options.scale}`;
        await exec(cmd, { timeout: 120000 });
      } catch {
        // Fall back to lanczos if realesrgan fails
        log.warn("Real-ESRGAN not available, falling back to lanczos");
        const scale = options.scale;
        const cmd = `ffmpeg -y -i "${inputPath}" -vf "scale=iw*${scale}:ih*${scale}:flags=lanczos" "${outputPath}"`;
        await exec(cmd, { timeout: 60000 });
      }
    } else {
      // Use FFmpeg with specified scaling algorithm
      const flags = model === "bicubic" ? "bicubic" : "lanczos";
      const scale = options.scale;
      const cmd = `ffmpeg -y -i "${inputPath}" -vf "scale=iw*${scale}:ih*${scale}:flags=${flags}" "${outputPath}"`;
      await exec(cmd, { timeout: 60000 });
    }

    const output = await readAsBase64(outputPath);
    const dims = await getImageDimensions(outputPath);

    log.info(`upscaled image ${options.scale}x using ${model} in ${Date.now() - startMs}ms`);

    return {
      success: true,
      output,
      format,
      width: dims.width,
      height: dims.height,
      processingTimeMs: Date.now() - startMs,
    };
  } catch (err) {
    log.error(`upscale failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      processingTimeMs: Date.now() - startMs,
    };
  } finally {
    await cleanup(inputPath, outputPath);
  }
}

/**
 * Remove background from an image using rembg.
 */
export async function removeBackground(options: RemoveBgOptions): Promise<ImageResult> {
  const startMs = Date.now();
  let inputPath = "";
  let outputPath = "";

  try {
    inputPath = await saveTempFile(options.input);
    const format = options.format ?? "png"; // PNG for transparency
    outputPath = join(TEMP_DIR, `${randomUUID()}.${format}`);

    // Build rembg command
    let cmd = `python -m rembg i "${inputPath}" "${outputPath}"`;
    if (options.alphaMatting) {
      cmd += " -a -ae 15 -af 240";
    }

    await exec(cmd, { timeout: 120000 });

    const output = await readAsBase64(outputPath);
    const dims = await getImageDimensions(outputPath);

    log.info(`removed background in ${Date.now() - startMs}ms`);

    return {
      success: true,
      output,
      format,
      width: dims.width,
      height: dims.height,
      processingTimeMs: Date.now() - startMs,
    };
  } catch (err) {
    log.error(`background removal failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      processingTimeMs: Date.now() - startMs,
    };
  } finally {
    await cleanup(inputPath, outputPath);
  }
}

/**
 * Process multiple operations in batch.
 */
export async function batchProcess(operations: BatchOperation[]): Promise<ImageResult[]> {
  const results: ImageResult[] = [];

  for (const op of operations) {
    let result: ImageResult;

    switch (op.type) {
      case "crop":
        result = await cropImage(op.options as CropOptions);
        break;
      case "upscale":
        result = await upscaleImage(op.options as UpscaleOptions);
        break;
      case "removeBg":
        result = await removeBackground(op.options as RemoveBgOptions);
        break;
      default:
        result = {
          success: false,
          error: `Unknown operation type: ${(op as BatchOperation).type}`,
        };
    }

    results.push(result);
  }

  return results;
}

/**
 * Get service status and available capabilities.
 */
export async function getServiceStatus(): Promise<{
  available: boolean;
  capabilities: {
    crop: boolean;
    upscale: string[];
    removeBg: boolean;
  };
}> {
  const capabilities = {
    crop: false,
    upscale: [] as string[],
    removeBg: false,
  };

  // Check FFmpeg for cropping and basic upscaling
  try {
    await exec("ffmpeg -version", { timeout: 5000 });
    capabilities.crop = true;
    capabilities.upscale.push("lanczos", "bicubic");
  } catch {
    // FFmpeg not available
  }

  // Check rembg
  try {
    await exec('python -c "import rembg"', { timeout: 5000 });
    capabilities.removeBg = true;
  } catch {
    // rembg not available
  }

  // Check Real-ESRGAN
  try {
    await exec('python -c "import realesrgan"', { timeout: 5000 });
    capabilities.upscale.push("realesrgan");
  } catch {
    // Real-ESRGAN not available
  }

  return {
    available: capabilities.crop || capabilities.removeBg || capabilities.upscale.length > 0,
    capabilities,
  };
}
