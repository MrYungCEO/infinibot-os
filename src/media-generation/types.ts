/** Generic image/video generation contract shared by core and plugins. */

export type MediaKind = "image" | "video";
export type MediaJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type MediaReference = {
  url: string;
  role?: "source" | "character" | "style" | "mask";
  description?: string;
};

export type MediaGenerateRequest = {
  kind: MediaKind;
  prompt: string;
  model?: string;
  style?: string;
  aspectRatio?: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  seed?: number;
  references?: MediaReference[];
  metadata?: Record<string, unknown>;
};

export type MediaEditRequest = Omit<MediaGenerateRequest, "prompt"> & {
  sourceUrl: string;
  instruction: string;
};

export type MediaOutput = {
  url: string;
  thumbnailUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
};

export type MediaGenerationJob = {
  id: string;
  providerId: string;
  kind: MediaKind;
  status: MediaJobStatus;
  prompt?: string;
  model?: string;
  outputs: MediaOutput[];
  error?: string;
  cost?: { amount: number; currency: string; credits?: number; estimated?: boolean };
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

export type MediaModel = {
  id: string;
  name: string;
  kinds: MediaKind[];
  capabilities?: Array<"generate" | "edit" | "references">;
  description?: string;
};

export type MediaCostEstimate = {
  amount: number;
  currency: string;
  credits?: number;
  estimated: true;
  details?: Record<string, unknown>;
};

export interface MediaGenerationProvider {
  id: string;
  name: string;
  kinds: readonly MediaKind[];
  generate(request: MediaGenerateRequest): Promise<MediaGenerationJob>;
  edit?(request: MediaEditRequest): Promise<MediaGenerationJob>;
  getStatus(jobId: string): Promise<MediaGenerationJob>;
  listModels(): Promise<MediaModel[]>;
  estimateCost(request: MediaGenerateRequest | MediaEditRequest): Promise<MediaCostEstimate>;
}
