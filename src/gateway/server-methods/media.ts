/**
 * Media Service Gateway Handlers
 *
 * Provides image and video processing endpoints accessible via federation.
 * These handlers allow satellite nodes to use master's GPU for media processing.
 */

import { z } from "zod";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import {
  cropImage,
  upscaleImage,
  removeBackground,
  batchProcess,
  getServiceStatus,
  type CropOptions,
  type UpscaleOptions,
  type RemoveBgOptions,
  type BatchOperation,
} from "../../media/image-service.js";

// ══════════════════════════════════════════════════════════════════════════════
// Schemas
// ══════════════════════════════════════════════════════════════════════════════

const CropSchema = z.object({
  input: z.string().min(1, "Input image (base64) is required"),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.enum(["png", "jpg", "webp"]).optional(),
});

const UpscaleSchema = z.object({
  input: z.string().min(1, "Input image (base64) is required"),
  scale: z.union([z.literal(2), z.literal(4)]),
  model: z.enum(["realesrgan", "lanczos", "bicubic"]).optional(),
  format: z.enum(["png", "jpg", "webp"]).optional(),
});

const RemoveBgSchema = z.object({
  input: z.string().min(1, "Input image (base64) is required"),
  format: z.enum(["png", "webp"]).optional(),
  alphaMatting: z.boolean().optional(),
});

const BatchOperationSchema = z.object({
  type: z.enum(["crop", "upscale", "removeBg"]),
  options: z.record(z.string(), z.unknown()),
});

const BatchSchema = z.object({
  operations: z.array(BatchOperationSchema),
});

// ══════════════════════════════════════════════════════════════════════════════
// Handlers
// ══════════════════════════════════════════════════════════════════════════════

export const mediaHandlers: GatewayRequestHandlers = {
  /**
   * Get media service status and capabilities
   */
  "media.status": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const status = await getServiceStatus();
      opts.respond(true, status);
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Crop an image
   */
  "media.image.crop": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const parsed = CropSchema.parse(opts.params);
      const result = await cropImage(parsed as CropOptions);

      if (result.success) {
        opts.respond(true, {
          output: result.output,
          format: result.format,
          width: result.width,
          height: result.height,
          processingTimeMs: result.processingTimeMs,
        });
      } else {
        opts.respond(false, undefined, {
          code: "PROCESSING_FAILED",
          message: result.error ?? "Crop operation failed",
        });
      }
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Upscale an image (2x or 4x)
   */
  "media.image.upscale": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const parsed = UpscaleSchema.parse(opts.params);
      const result = await upscaleImage(parsed as UpscaleOptions);

      if (result.success) {
        opts.respond(true, {
          output: result.output,
          format: result.format,
          width: result.width,
          height: result.height,
          processingTimeMs: result.processingTimeMs,
        });
      } else {
        opts.respond(false, undefined, {
          code: "PROCESSING_FAILED",
          message: result.error ?? "Upscale operation failed",
        });
      }
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Remove background from an image
   */
  "media.image.removeBg": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const parsed = RemoveBgSchema.parse(opts.params);
      const result = await removeBackground(parsed as RemoveBgOptions);

      if (result.success) {
        opts.respond(true, {
          output: result.output,
          format: result.format,
          width: result.width,
          height: result.height,
          processingTimeMs: result.processingTimeMs,
        });
      } else {
        opts.respond(false, undefined, {
          code: "PROCESSING_FAILED",
          message: result.error ?? "Background removal failed",
        });
      }
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Process multiple images in batch
   */
  "media.image.batch": async (opts: GatewayRequestHandlerOptions) => {
    try {
      const parsed = BatchSchema.parse(opts.params);

      // Validate each operation's options based on type
      const validatedOps: BatchOperation[] = [];
      for (const op of parsed.operations) {
        const opOptions = op.options as Record<string, unknown>;
        switch (op.type) {
          case "crop":
            validatedOps.push({ type: "crop", options: CropSchema.parse(opOptions) as CropOptions });
            break;
          case "upscale":
            validatedOps.push({ type: "upscale", options: UpscaleSchema.parse(opOptions) as UpscaleOptions });
            break;
          case "removeBg":
            validatedOps.push({ type: "removeBg", options: RemoveBgSchema.parse(opOptions) as RemoveBgOptions });
            break;
        }
      }

      const results = await batchProcess(validatedOps);

      opts.respond(true, {
        results: results.map((r) => ({
          success: r.success,
          output: r.output,
          format: r.format,
          width: r.width,
          height: r.height,
          error: r.error,
          processingTimeMs: r.processingTimeMs,
        })),
        totalProcessingTimeMs: results.reduce((sum, r) => sum + (r.processingTimeMs ?? 0), 0),
      });
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
