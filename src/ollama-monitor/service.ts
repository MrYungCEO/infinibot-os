/**
 * Ollama Monitor Service
 *
 * Singleton service that monitors Ollama server status, GPU stats, and active sessions.
 * - Polls Ollama API every 5 seconds
 * - Polls nvidia-smi for GPU stats
 * - Tracks active sessions (register/unregister)
 * - Calculates throughput metrics
 */

import type {
  GpuStats,
  LoadedModel,
  OllamaModel,
  OllamaSession,
  OllamaStatus,
  OllamaPsResponse,
  OllamaTagsResponse,
  OllamaVersionResponse,
  ThroughputSample,
} from "./types.js";
import { getGpuStats } from "./gpu-stats.js";

// Default configuration
const DEFAULT_HOST = "http://127.0.0.1:11434";
const POLL_INTERVAL_MS = 5000;
const SESSION_STALE_MS = 5 * 60 * 1000; // 5 minutes
const THROUGHPUT_WINDOW_MS = 60 * 1000; // 60 seconds

/**
 * Ollama Monitor Service - Singleton
 */
class OllamaMonitorService {
  private host: string;
  private pollingInterval: NodeJS.Timeout | null = null;
  private gpuPollingInterval: NodeJS.Timeout | null = null;

  // Cached state
  private cachedStatus: OllamaStatus | null = null;
  private cachedGpu: GpuStats | null = null;
  private lastPollAt: number = 0;
  private lastGpuPollAt: number = 0;

  // Session tracking
  private sessions: Map<string, OllamaSession> = new Map();

  // Throughput tracking
  private throughputSamples: ThroughputSample[] = [];

  constructor() {
    this.host = process.env.OLLAMA_HOST || DEFAULT_HOST;
  }

  /**
   * Configure the Ollama host
   */
  setHost(host: string): void {
    this.host = host;
  }

  /**
   * Get the current Ollama host
   */
  getHost(): string {
    return this.host;
  }

  /**
   * Start polling for status updates
   */
  startPolling(): void {
    if (this.pollingInterval) return;

    // Initial poll
    this.pollStatus().catch(() => {});
    this.pollGpu().catch(() => {});

    // Start intervals
    this.pollingInterval = setInterval(() => {
      this.pollStatus().catch(() => {});
    }, POLL_INTERVAL_MS);

    this.gpuPollingInterval = setInterval(() => {
      this.pollGpu().catch(() => {});
    }, POLL_INTERVAL_MS * 2); // GPU poll less frequently
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.gpuPollingInterval) {
      clearInterval(this.gpuPollingInterval);
      this.gpuPollingInterval = null;
    }
  }

  /**
   * Poll Ollama API for status
   */
  private async pollStatus(): Promise<void> {
    try {
      const [tags, ps, version] = await Promise.all([
        this.fetchTags(),
        this.fetchPs(),
        this.fetchVersion(),
      ]);

      const models = this.transformTags(tags);
      const loadedModels = this.transformPs(ps);

      this.cachedStatus = {
        connected: true,
        host: this.host,
        version: version?.version,
        models,
        loadedModels,
        gpu: this.cachedGpu,
        sessions: Array.from(this.sessions.values()),
        throughput: this.calculateThroughput(),
      };
      this.lastPollAt = Date.now();
    } catch {
      this.cachedStatus = {
        connected: false,
        host: this.host,
        models: [],
        loadedModels: [],
        gpu: this.cachedGpu,
        sessions: Array.from(this.sessions.values()),
        throughput: this.calculateThroughput(),
      };
    }
  }

  /**
   * Poll GPU stats
   */
  private async pollGpu(): Promise<void> {
    try {
      this.cachedGpu = await getGpuStats();
      this.lastGpuPollAt = Date.now();
    } catch {
      // Keep last known GPU stats on failure
    }
  }

  /**
   * Fetch available models from Ollama
   */
  private async fetchTags(): Promise<OllamaTagsResponse> {
    const response = await fetch(`${this.host}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }
    return response.json() as Promise<OllamaTagsResponse>;
  }

  /**
   * Fetch loaded models from Ollama
   */
  private async fetchPs(): Promise<OllamaPsResponse> {
    const response = await fetch(`${this.host}/api/ps`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }
    return response.json() as Promise<OllamaPsResponse>;
  }

  /**
   * Fetch Ollama version
   */
  private async fetchVersion(): Promise<OllamaVersionResponse | null> {
    try {
      const response = await fetch(`${this.host}/api/version`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      return response.json() as Promise<OllamaVersionResponse>;
    } catch {
      return null;
    }
  }

  /**
   * Transform tags response to OllamaModel[]
   */
  private transformTags(tags: OllamaTagsResponse): OllamaModel[] {
    return tags.models.map((m) => ({
      name: m.name,
      size: m.size,
      sizeVram: 0, // Not available in tags endpoint
      digest: m.digest,
      details: {
        family: m.details.family,
        parameter_size: m.details.parameter_size,
        quantization_level: m.details.quantization_level,
      },
    }));
  }

  /**
   * Transform ps response to LoadedModel[]
   */
  private transformPs(ps: OllamaPsResponse): LoadedModel[] {
    return ps.models.map((m) => {
      // Count active sessions using this model
      const activeSessions = Array.from(this.sessions.values()).filter(
        (s) => s.model === m.name || s.model === m.model,
      ).length;

      return {
        name: m.name,
        model: m.model,
        size: m.size,
        sizeVram: m.size_vram,
        expiresAt: m.expires_at,
        activeSessions,
      };
    });
  }

  /**
   * Calculate rolling throughput metrics
   */
  private calculateThroughput(): { tokensPerMinute: number; requestsPerMinute: number } {
    const now = Date.now();
    const cutoff = now - THROUGHPUT_WINDOW_MS;

    // Clean old samples
    this.throughputSamples = this.throughputSamples.filter((s) => s.timestamp > cutoff);

    if (this.throughputSamples.length === 0) {
      return { tokensPerMinute: 0, requestsPerMinute: 0 };
    }

    const totalTokens = this.throughputSamples.reduce(
      (sum, s) => sum + s.tokensIn + s.tokensOut,
      0,
    );
    const totalRequests = this.throughputSamples.reduce((sum, s) => sum + s.requestCount, 0);

    // Calculate per-minute rate
    const oldestSample = Math.min(...this.throughputSamples.map((s) => s.timestamp));
    const windowMs = now - oldestSample;
    const windowMinutes = Math.max(windowMs / 60000, 1 / 60); // At least 1 second

    return {
      tokensPerMinute: Math.round(totalTokens / windowMinutes),
      requestsPerMinute: Math.round(totalRequests / windowMinutes),
    };
  }

  // ========== Public API ==========

  /**
   * Get full Ollama status
   */
  async getStatus(): Promise<OllamaStatus> {
    // If we haven't polled recently, do it now
    if (!this.cachedStatus || Date.now() - this.lastPollAt > POLL_INTERVAL_MS * 2) {
      await this.pollStatus();
    }

    return (
      this.cachedStatus || {
        connected: false,
        host: this.host,
        models: [],
        loadedModels: [],
        gpu: null,
        sessions: [],
        throughput: { tokensPerMinute: 0, requestsPerMinute: 0 },
      }
    );
  }

  /**
   * Get available models
   */
  async getModels(): Promise<OllamaModel[]> {
    const status = await this.getStatus();
    return status.models;
  }

  /**
   * Get currently loaded models
   */
  async getLoadedModels(): Promise<LoadedModel[]> {
    const status = await this.getStatus();
    return status.loadedModels;
  }

  /**
   * Load a model into memory
   */
  async loadModel(name: string, keepAlive: string = "5m"): Promise<void> {
    const response = await fetch(`${this.host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        prompt: "",
        keep_alive: keepAlive,
      }),
      signal: AbortSignal.timeout(60000), // Models can take a while to load
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to load model: ${text}`);
    }

    // Consume the response stream
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Refresh status
    await this.pollStatus();
  }

  /**
   * Unload a model from memory
   */
  async unloadModel(name: string): Promise<void> {
    const response = await fetch(`${this.host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        prompt: "",
        keep_alive: "0", // Setting to 0 unloads the model
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to unload model: ${text}`);
    }

    // Consume the response stream
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Refresh status
    await this.pollStatus();
  }

  /**
   * Register an active session
   */
  registerSession(session: OllamaSession): void {
    this.sessions.set(session.id, {
      ...session,
      lastActiveAt: Date.now(),
    });

    // Record throughput sample
    this.throughputSamples.push({
      timestamp: Date.now(),
      tokensIn: session.tokensIn,
      tokensOut: session.tokensOut,
      requestCount: session.requestCount,
    });
  }

  /**
   * Update session activity
   */
  updateSession(
    id: string,
    updates: Partial<Pick<OllamaSession, "tokensIn" | "tokensOut" | "requestCount">>,
  ): void {
    const session = this.sessions.get(id);
    if (!session) return;

    const deltaIn = (updates.tokensIn || 0) - session.tokensIn;
    const deltaOut = (updates.tokensOut || 0) - session.tokensOut;
    const deltaReq = (updates.requestCount || 0) - session.requestCount;

    this.sessions.set(id, {
      ...session,
      ...updates,
      lastActiveAt: Date.now(),
    });

    // Record throughput delta
    if (deltaIn > 0 || deltaOut > 0 || deltaReq > 0) {
      this.throughputSamples.push({
        timestamp: Date.now(),
        tokensIn: Math.max(0, deltaIn),
        tokensOut: Math.max(0, deltaOut),
        requestCount: Math.max(0, deltaReq),
      });
    }
  }

  /**
   * Unregister a session
   */
  unregisterSession(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * Get all active sessions
   */
  getSessions(): OllamaSession[] {
    this.cleanupStaleSessions();
    return Array.from(this.sessions.values());
  }

  /**
   * Clean up stale sessions
   */
  private cleanupStaleSessions(): void {
    const cutoff = Date.now() - SESSION_STALE_MS;
    for (const [id, session] of this.sessions) {
      if (session.lastActiveAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Get GPU stats
   */
  async getGpuStats(): Promise<GpuStats | null> {
    // If we haven't polled recently, do it now
    if (!this.cachedGpu || Date.now() - this.lastGpuPollAt > POLL_INTERVAL_MS * 4) {
      await this.pollGpu();
    }
    return this.cachedGpu;
  }

  /**
   * Check if Ollama is connected
   */
  async isConnected(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/api/version`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Singleton instance
let instance: OllamaMonitorService | null = null;

/**
 * Get the Ollama Monitor Service singleton
 */
export function getOllamaMonitor(): OllamaMonitorService {
  if (!instance) {
    instance = new OllamaMonitorService();
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetOllamaMonitor(): void {
  if (instance) {
    instance.stopPolling();
    instance = null;
  }
}
