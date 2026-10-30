import { randomUUID } from "node:crypto";

import type { ImageGenerator } from "../storyboard/types.js";
import type {
  MediaCostEstimate,
  MediaGenerateRequest,
  MediaGenerationJob,
  MediaGenerationProvider,
  MediaModel,
} from "./types.js";

/** Built-in adapter around the existing local ComfyUI storyboard path. */
export class ComfyUiMediaProvider implements MediaGenerationProvider {
  readonly id = "comfyui";
  readonly name = "ComfyUI (local)";
  readonly kinds = ["image"] as const;

  private generator?: ImageGenerator;
  private readonly jobs = new Map<string, MediaGenerationJob>();

  constructor(generator?: ImageGenerator) {
    this.generator = generator;
  }

  private async getGenerator(): Promise<
    ImageGenerator & { listCheckpoints?: () => Promise<string[]> }
  > {
    if (!this.generator) {
      const { LocalGenerator } = await import("../storyboard/image-generator.js");
      this.generator = new LocalGenerator();
    }
    return this.generator;
  }

  async generate(request: MediaGenerateRequest): Promise<MediaGenerationJob> {
    if (request.kind !== "image")
      throw new Error("ComfyUI provider supports image generation only");
    const id = `comfyui-${randomUUID()}`;
    const createdAt = Date.now();
    const generator = await this.getGenerator();
    const result = await generator.generate({
      prompt: request.prompt,
      model: request.model,
      style: request.style,
      aspectRatio: request.aspectRatio,
      negativePrompt: request.negativePrompt,
      seed: request.seed,
      characterRefs: request.references?.map((ref, index) => ({
        id: `${id}-ref-${index}`,
        name: ref.description || `Reference ${index + 1}`,
        description: ref.description || "",
        referenceImageUrl: ref.url,
      })),
    });
    const job: MediaGenerationJob = {
      id,
      providerId: this.id,
      kind: "image",
      status: result.success ? "succeeded" : "failed",
      prompt: request.prompt,
      model: request.model,
      outputs: result.imageUrl
        ? [{ url: result.imageUrl, thumbnailUrl: result.thumbnailUrl, mimeType: "image/png" }]
        : [],
      error: result.error,
      cost: { amount: 0, currency: "USD", credits: 0, estimated: false },
      createdAt,
      updatedAt: Date.now(),
    };
    this.jobs.set(id, job);
    return job;
  }

  async getStatus(jobId: string): Promise<MediaGenerationJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown ComfyUI job: ${jobId}`);
    return job;
  }

  async listModels(): Promise<MediaModel[]> {
    const generator = await this.getGenerator();
    const checkpoints = generator.listCheckpoints ? await generator.listCheckpoints() : [];
    return checkpoints.map((id) => ({
      id,
      name: id,
      kinds: ["image"],
      capabilities: ["generate"],
    }));
  }

  async estimateCost(): Promise<MediaCostEstimate> {
    return { amount: 0, currency: "USD", credits: 0, estimated: true };
  }
}
