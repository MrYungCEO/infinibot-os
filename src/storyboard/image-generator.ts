/**
 * Storyboard Image Generator — local-only backend
 *
 * Supports: Local ComfyUI server (default port 8899). Cloud generators
 * Legacy provider-specific branches were removed; image generation runs
 * entirely through the user's on-device ComfyUI instance.
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { resolve, join } from "path";
import type { ImageGenerator, ImageGenOptions, ImageGenResult, ImageBackend } from "./types.js";
import { getMediaProviderRegistry } from "../media-generation/registry.js";

/**
 * Resolve the directory used to drop generated images. Defaults to a
 * subfolder of the active state dir so a fresh install just works; can
 * be pinned with INFINIBOT_STORYBOARD_OUTPUT_DIR for shared volumes.
 */
function getGeneratedDir(): string {
  const explicit = process.env.INFINIBOT_STORYBOARD_OUTPUT_DIR;
  if (explicit) return explicit;
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const dir = resolve(stateDir, "storyboard-generated");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return dir;
}

/**
 * Working directory for spawned image-gen helpers. Falls back to the
 * generated-images dir so the helper always sees a writable cwd.
 */
function getHelperCwd(): string {
  return process.env.INFINIBOT_STORYBOARD_HELPER_CWD || getGeneratedDir();
}

// ═══════════════════════════════════════════════════════════════
// LOCAL — Stock ComfyUI server (default http://127.0.0.1:8000)
// ═══════════════════════════════════════════════════════════════
//
// Talks the native ComfyUI API: /system_stats for liveness,
// /object_info for model discovery, /prompt to submit a workflow,
// /history/{id} to poll, and /view to fetch the saved image. No
// custom wrapper, no /v1 endpoints — works against a vanilla
// ComfyUI install with `CheckpointLoaderSimple` available.

export class LocalGenerator implements ImageGenerator {
  name = "ComfyUI";
  backend: ImageBackend = "local";
  supportsCharacterRef = false; // txt2img only for now; img2img refs TODO
  supportsStyleTransfer = false;

  private get serverUrl(): string {
    const v = process.env.COMFY_URL || process.env.LOCAL_IMAGE_API_URL;
    if (v && v.trim()) return v.trim().replace(/\/$/, "");
    return "http://127.0.0.1:8000";
  }
  private readonly clientId = "moltbot-storyboard";

  /** Probes ComfyUI's /system_stats — returns 200 with stats JSON when up. */
  async isAvailable(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${this.serverUrl}/system_stats`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async generate(options: ImageGenOptions): Promise<ImageGenResult> {
    const start = Date.now();
    try {
      const checkpoint = options.model || (await this.firstCheckpoint());
      if (!checkpoint) {
        return {
          success: false,
          error:
            "No ComfyUI checkpoints found. Place a model in your checkpoints folder and restart ComfyUI.",
          backend: this.backend,
          duration: Date.now() - start,
        };
      }

      const { width, height } = aspectToDims(options.aspectRatio || "16:9");
      const prompt = buildPromptText(options);
      const workflow = buildTxt2ImgWorkflow({
        ckpt: checkpoint,
        positive: prompt,
        negative: options.negativePrompt || "",
        width,
        height,
        steps: options.steps ?? 25,
        cfg: options.guidance ?? 6,
        seed: options.seed ?? Math.floor(Math.random() * 2 ** 31),
      });

      // Submit
      const submit = await fetch(`${this.serverUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
      });
      if (!submit.ok) {
        const text = await submit.text().catch(() => "");
        return {
          success: false,
          error: `ComfyUI /prompt returned ${submit.status}: ${text || "(empty body)"}`,
          backend: this.backend,
          duration: Date.now() - start,
        };
      }
      const submitJson = (await submit.json()) as { prompt_id?: string };
      const promptId = submitJson.prompt_id;
      if (!promptId) {
        return {
          success: false,
          error: "ComfyUI /prompt did not return a prompt_id",
          backend: this.backend,
          duration: Date.now() - start,
        };
      }

      // Poll history. ComfyUI sometimes takes 30-90s on a cold load,
      // so we cap at 5 minutes and check every 1.5s.
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const hist = await fetch(`${this.serverUrl}/history/${promptId}`);
        if (!hist.ok) continue;
        const histJson = (await hist.json()) as Record<string, ComfyHistoryEntry>;
        const entry = histJson[promptId];
        if (!entry) continue;

        // Bail fast on execution failures — otherwise we'd spin until the
        // 5-minute timeout. ComfyUI surfaces failures via status.messages
        // entries like ["execution_error", { exception_message, node_type, ... }].
        const failure = extractComfyError(entry, checkpoint);
        if (failure) {
          return {
            success: false,
            error: failure,
            backend: this.backend,
            duration: Date.now() - start,
          };
        }

        // Look for a successful SaveImage output.
        const outputs = entry.outputs ?? {};
        for (const nodeOut of Object.values(outputs)) {
          const img = nodeOut?.images?.[0];
          if (img?.filename) {
            const local = await this.persistImage(img);
            return {
              success: true,
              imageUrl: local,
              backend: this.backend,
              duration: Date.now() - start,
            };
          }
        }
      }

      return {
        success: false,
        error: "ComfyUI generation timed out (5 minutes)",
        backend: this.backend,
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        backend: this.backend,
        duration: Date.now() - start,
      };
    }
  }

  /** Full list of checkpoints ComfyUI advertises. Empty array on error. */
  async listCheckpoints(): Promise<string[]> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${this.serverUrl}/object_info/CheckpointLoaderSimple`, {
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) return [];
      const info = (await res.json()) as Record<
        string,
        {
          input?: { required?: { ckpt_name?: [string[]] | [string[], unknown] } };
        }
      >;
      const list = info["CheckpointLoaderSimple"]?.input?.required?.ckpt_name?.[0];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** First checkpoint, used when caller didn't pin a model. */
  private async firstCheckpoint(): Promise<string | null> {
    const list = await this.listCheckpoints();
    return list.length > 0 ? list[0] : null;
  }

  /** Pull a generated image off ComfyUI and copy it into our media dir for stable URLs. */
  private async persistImage(img: {
    filename: string;
    subfolder?: string;
    type?: string;
  }): Promise<string> {
    const params = new URLSearchParams({
      filename: img.filename,
      type: img.type || "output",
      subfolder: img.subfolder || "",
    });
    const url = `${this.serverUrl}/view?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`ComfyUI /view returned ${response.status} for ${img.filename}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const { mkdir, writeFile } = await import("fs/promises");
    const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
    const mediaDir = resolve(stateDir, "media", "storyboard-images");
    await mkdir(mediaDir, { recursive: true });
    const safeName = `${Date.now()}_${img.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const outputPath = resolve(mediaDir, safeName);
    await writeFile(outputPath, buffer);
    return `/media/storyboard-images/${safeName}`;
  }
}

// ── ComfyUI workflow helpers ─────────────────────────────────

// ── ComfyUI history-shape + error extraction ─────────────────

interface ComfyHistoryEntry {
  outputs?: Record<
    string,
    { images?: Array<{ filename: string; subfolder?: string; type?: string }> }
  >;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: Array<[string, Record<string, unknown>]>;
  };
}

/**
 * Pull a useful, user-facing error out of a ComfyUI history entry.
 * Returns null when the entry isn't an error yet (still queued/running).
 *
 * ComfyUI publishes failures via `status.messages` entries shaped like
 *   ["execution_error", { exception_message, node_type, prompt_id, ... }]
 * — we surface `exception_message` plus a hint when the failure is the
 * very common "this checkpoint isn't loadable by CheckpointLoaderSimple"
 * case (Qwen-Image-Edit, FLUX schnell variants without bundled VAE,
 * UNet-only diffusion files, etc.).
 */
function extractComfyError(entry: ComfyHistoryEntry, checkpoint: string): string | null {
  const status = entry.status;
  if (!status) return null;
  // Still running / queued — no error yet.
  if (status.completed && (status.status_str ?? "success") === "success") return null;
  if (!status.completed && (status.status_str ?? "") !== "error") return null;

  // Pull the first execution_error message we can find.
  let detail = "ComfyUI execution failed";
  for (const msg of status.messages ?? []) {
    const [kind, payload] = msg;
    if (kind === "execution_error" && payload && typeof payload === "object") {
      const ex = (payload as { exception_message?: string }).exception_message;
      if (ex) {
        detail = ex;
        break;
      }
    }
  }

  // Common case: user picked a diffusion-only file. Translate the raw
  // RuntimeError into something actionable.
  if (
    /Could not detect model type/i.test(detail) ||
    /This is not a checkpoint file/i.test(detail)
  ) {
    return (
      `ComfyUI couldn't load "${checkpoint}" with CheckpointLoaderSimple — ` +
      `the file looks like a diffusion model only (no bundled CLIP/VAE). ` +
      `Pick a full SD/SDXL/FLUX checkpoint, or load this model manually in ComfyUI.`
    );
  }

  return detail;
}

function aspectToDims(aspect: string): { width: number; height: number } {
  switch (aspect) {
    case "9:16":
      return { width: 768, height: 1344 };
    case "1:1":
      return { width: 1024, height: 1024 };
    case "4:3":
      return { width: 1152, height: 864 };
    case "3:4":
      return { width: 864, height: 1152 };
    case "16:9":
    default:
      return { width: 1344, height: 768 };
  }
}

function buildPromptText(options: ImageGenOptions): string {
  let text = options.prompt;
  if (options.style) text = `${options.style} style. ${text}`;
  if (options.characterRefs && options.characterRefs.length > 0) {
    const charDescs = options.characterRefs
      .map((c) => `${c.name}: ${c.description}${c.styleTokens ? ` (${c.styleTokens})` : ""}`)
      .join(". ");
    text = `${text}. Characters: ${charDescs}`;
  }
  return text;
}

interface Txt2ImgArgs {
  ckpt: string;
  positive: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
}

/** Minimal txt2img workflow that runs against any stock SDXL/FLUX checkpoint. */
function buildTxt2ImgWorkflow(
  a: Txt2ImgArgs,
): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: a.ckpt } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: a.width, height: a.height, batch_size: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: a.positive, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: a.negative, clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: a.seed,
        steps: a.steps,
        cfg: a.cfg,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "moltbot", images: ["8", 0] } },
  };
}

// ═══════════════════════════════════════════════════════════════
// LOCAL KLEIN GENERATOR (ComfyUI Direct - Multi-Reference)
// ═══════════════════════════════════════════════════════════════

export class LocalKleinGenerator implements ImageGenerator {
  name = "Local Klein (ComfyUI)";
  backend: ImageBackend = "local";
  supportsCharacterRef = true; // Multi-reference via composite!
  supportsStyleTransfer = true;

  private get comfyUrl(): string {
    return process.env.COMFY_URL || process.env.LOCAL_COMFY_URL || "http://127.0.0.1:8000";
  }
  /** FLUX 2 Klein helper script. Override with KLEIN_SCRIPT. */
  private get scriptPath(): string {
    return (
      process.env.KLEIN_SCRIPT ||
      join(homedir(), ".infinibot", "skills", "flux2-klein", "flux2-klein-3ref.py")
    );
  }
  private get outputDir(): string {
    return getGeneratedDir();
  }

  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.scriptPath)) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`${this.comfyUrl}/system_stats`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  async generate(options: ImageGenOptions): Promise<ImageGenResult> {
    const start = Date.now();

    console.log("[LocalKlein] generate() called", {
      prompt: options.prompt?.slice(0, 50),
      hasCharacterRefs: !!options.characterRefs?.length,
      characterCount: options.characterRefs?.length || 0,
      characters: options.characterRefs?.map((c) => ({
        name: c.name,
        hasRefPath: !!c.referenceImagePath,
      })),
    });

    try {
      // Collect reference image paths
      const refPaths: string[] = [];
      if (options.characterRefs) {
        for (const char of options.characterRefs) {
          if (char.referenceImagePath) {
            console.log("[LocalKlein] Found ref path for", char.name, ":", char.referenceImagePath);
            refPaths.push(char.referenceImagePath);
          } else {
            console.log("[LocalKlein] No ref path for", char.name);
          }
        }
      }

      console.log("[LocalKlein] refPaths collected:", refPaths.length, refPaths);

      // Need at least one reference for Klein
      if (refPaths.length === 0) {
        console.log("[LocalKlein] REJECTING - no reference images found!");
        return {
          success: false,
          error:
            "FLUX 2 Klein requires at least one character reference image. Add a character to this project with a reference image from the Character Manager.",
          backend: this.backend,
          duration: Date.now() - start,
        };
      }

      // Build prompt with character descriptions
      let fullPrompt = options.prompt;
      if (options.characterRefs && options.characterRefs.length > 0) {
        const charDescs = options.characterRefs
          .map(
            (c) =>
              `${c.name}${c.description ? `: ${c.description}` : ""}${c.styleTokens ? ` (${c.styleTokens})` : ""}`,
          )
          .join(". ");
        fullPrompt = `${charDescs}. ${fullPrompt}`;
      }

      if (options.style) {
        fullPrompt = `${options.style} style. ${fullPrompt}`;
      }

      // Generate unique filename
      const filename = `klein_${Date.now()}.png`;
      const outputPath = resolve(this.outputDir, filename);

      // Use the multi-ref script for 3+ refs, or single ref approach for 1-2
      const result = await this.runKleinGeneration(fullPrompt, refPaths, outputPath);

      if (result.success) {
        // Copy to media directory for gateway serving
        const mediaUrl = await this.copyToMediaDir(outputPath, filename);

        return {
          success: true,
          imageUrl: mediaUrl,
          backend: this.backend,
          duration: Date.now() - start,
        };
      } else {
        return {
          success: false,
          error: result.error,
          backend: this.backend,
          duration: Date.now() - start,
        };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        backend: this.backend,
        duration: Date.now() - start,
      };
    }
  }

  private runKleinGeneration(
    prompt: string,
    refPaths: string[],
    outputPath: string,
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolvePromise) => {
      const escapedPrompt = prompt.replace(/"/g, '\\"');

      // Build ref flags
      const refFlags = refPaths
        .slice(0, 3)
        .map((p) => `"${p}"`)
        .join(" ");

      // Use the 3-ref script which handles compositing
      const command = `python "${this.scriptPath}" -p "${escapedPrompt}" -r ${refFlags} -o "${outputPath}" --steps 25`;

      console.log("[LocalKlein] Running:", { refCount: refPaths.length, outputPath });

      const proc = spawn(command, [], {
        cwd: getHelperCwd(),
        shell: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });

      let stderr = "";
      let stdout = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolvePromise({ success: true });
        } else {
          console.error("[LocalKlein] Failed:", { code, stderr, stdout });
          resolvePromise({
            success: false,
            error: stderr || stdout || `Process exited with code ${code}`,
          });
        }
      });

      proc.on("error", (err) => {
        resolvePromise({ success: false, error: err.message });
      });
    });
  }

  private async copyToMediaDir(sourcePath: string, filename: string): Promise<string> {
    const { mkdir, copyFile } = await import("fs/promises");

    // Copy to gateway's media directory for proper serving
    const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
    const mediaDir = resolve(stateDir, "media", "storyboard-images");
    await mkdir(mediaDir, { recursive: true });

    const destPath = resolve(mediaDir, filename);
    await copyFile(sourcePath, destPath);

    console.log("[LocalKlein] Copied to media dir:", destPath);

    // Return URL that gateway can serve
    return `/media/storyboard-images/${filename}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTO SELECTOR
// ═══════════════════════════════════════════════════════════════

const generators: Record<"local" | "auto", ImageGenerator> = {
  local: new LocalGenerator(),
  auto: new LocalGenerator(),
};

export async function getAvailableGenerators(): Promise<ImageGenerator[]> {
  const available: ImageGenerator[] = [];

  for (const [key, gen] of Object.entries(generators)) {
    if (key === "auto") continue;
    if (await gen.isAvailable()) {
      available.push(gen);
    }
  }

  return available;
}

export async function getBestGenerator(): Promise<ImageGenerator | null> {
  const gen = generators["local"];
  return (await gen.isAvailable()) ? gen : null;
}

export function getGenerator(backend: ImageBackend): ImageGenerator {
  if (backend === "auto") return generators.auto;
  return generators.local;
}

export async function generateImage(
  options: ImageGenOptions,
  backend: ImageBackend = "auto",
): Promise<ImageGenResult> {
  console.log("[ImageGenerator] generateImage called", {
    backend,
    model: options.model,
    prompt: options.prompt?.slice(0, 50),
  });

  if (backend !== "auto" && backend !== "local") {
    const provider = getMediaProviderRegistry().get(backend);
    if (!provider || !provider.kinds.includes("image")) {
      return {
        success: false,
        error: `Image generation provider "${backend}" is not available.`,
        backend,
      };
    }
    try {
      const submitted = await provider.generate({
        kind: "image",
        prompt: options.prompt,
        model: options.model,
        style: options.style,
        aspectRatio: options.aspectRatio,
        negativePrompt: options.negativePrompt,
        seed: options.seed,
        references: options.characterRefs
          ?.map((ref) => ref.referenceImageUrl || ref.referenceImagePath)
          .filter((url): url is string => Boolean(url))
          .map((url) => ({ url, role: "character" as const })),
      });
      const job = await getMediaProviderRegistry().waitForCompletion(backend, submitted);
      const output = job.outputs[0];
      return {
        success: job.status === "succeeded" && Boolean(output?.url),
        imageUrl: output?.url,
        thumbnailUrl: output?.thumbnailUrl,
        error: job.error,
        backend,
        duration: job.updatedAt - job.createdAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        backend,
      };
    }
  }

  let generator: ImageGenerator | null;

  if (backend === "auto") {
    generator = await getBestGenerator();
    if (!generator) {
      return {
        success: false,
        error:
          "No image generation backend available. Start ComfyUI and set COMFY_URL or LOCAL_IMAGE_API_URL if it is not running at http://127.0.0.1:8000.",
        backend: "auto",
      };
    }
  } else {
    generator = getGenerator(backend);
    const available = await generator.isAvailable();
    console.log("[ImageGenerator] Generator:", generator.name, "available:", available);
    if (!available) {
      return {
        success: false,
        error: `${generator.name} is not available. Check API keys.`,
        backend,
      };
    }
  }

  console.log("[ImageGenerator] Calling generator.generate()...");
  const result = await generator.generate(options);
  console.log("[ImageGenerator] Result:", { success: result.success, error: result.error });
  return result;
}
