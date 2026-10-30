/**
 * Ollama Monitor Types
 * Types for tracking Ollama server status, GPU stats, and active sessions.
 */

export interface OllamaModel {
  name: string;
  size: number;        // bytes
  sizeVram: number;    // VRAM usage
  digest: string;
  details: {
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

export interface LoadedModel {
  name: string;
  model: string;
  size: number;
  sizeVram: number;
  expiresAt: string;
  activeSessions: number;
}

export interface GpuStats {
  name: string;           // "NVIDIA GeForce RTX 5090"
  vramTotal: number;      // bytes
  vramUsed: number;
  vramFree: number;
  temperature: number;    // celsius
  utilization: number;    // 0-100
  powerDraw: number;      // watts
}

export interface OllamaSession {
  id: string;
  name: string;           // "agent:main", "infinicode:001", etc.
  model: string;
  startedAt: number;
  lastActiveAt: number;
  tokensIn: number;
  tokensOut: number;
  requestCount: number;
}

export interface OllamaStatus {
  connected: boolean;
  host: string;
  version?: string;
  models: OllamaModel[];
  loadedModels: LoadedModel[];
  gpu: GpuStats | null;
  sessions: OllamaSession[];
  throughput: {
    tokensPerMinute: number;
    requestsPerMinute: number;
  };
}

/**
 * Internal types for throughput calculation
 */
export interface ThroughputSample {
  timestamp: number;
  tokensIn: number;
  tokensOut: number;
  requestCount: number;
}

/**
 * Ollama API response types
 */
export interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    modified_at: string;
    size: number;
    digest: string;
    details: {
      parent_model?: string;
      format: string;
      family: string;
      families?: string[];
      parameter_size: string;
      quantization_level: string;
    };
  }>;
}

export interface OllamaPsResponse {
  models: Array<{
    name: string;
    model: string;
    size: number;
    digest: string;
    details: {
      parent_model?: string;
      format: string;
      family: string;
      families?: string[];
      parameter_size: string;
      quantization_level: string;
    };
    expires_at: string;
    size_vram: number;
  }>;
}

export interface OllamaVersionResponse {
  version: string;
}
