/**
 * Ollama Monitor Controller
 * 
 * Manages Ollama server status, GPU stats, loaded models, and active sessions.
 * Supports both direct Ollama API calls and gateway method calls.
 */

import type { GatewayBrowserClient } from "../gateway";

// ── Types ─────────────────────────────────────────────────

export interface GPUStats {
  name: string;
  index: number;
  totalVRAM: number;     // bytes
  usedVRAM: number;      // bytes  
  freeVRAM: number;      // bytes
  temperature?: number;  // celsius
  utilization?: number;  // percent
  powerDraw?: number;    // watts
  powerLimit?: number;   // watts
}

export interface LoadedModel {
  name: string;
  model: string;
  size: number;          // bytes in VRAM
  digest: string;
  details: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  expires_at: string;
  size_vram: number;     // bytes
}

export interface AvailableModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;          // bytes on disk
  digest: string;
  details: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface ActiveSession {
  id: string;
  name: string;
  model: string;
  tokensPerMin: number;
  totalTokens: number;
  startedAt: number;
  lastActivity: number;
  isActive: boolean;
}

export interface OllamaStatus {
  online: boolean;
  version?: string;
  gpu: GPUStats | null;
  loadedModels: LoadedModel[];
  availableModels: AvailableModel[];
  activeSessions: ActiveSession[];
  error?: string;
}

export interface OllamaMonitorState {
  status: OllamaStatus | null;
  loading: boolean;
  error: string | null;
  autoRefresh: boolean;
  refreshInterval: number;  // ms, default 5000
  lastRefresh: number;
  ollamaHost: string;
}

// ── Default State ─────────────────────────────────────────

export function createOllamaMonitorState(): OllamaMonitorState {
  return {
    status: null,
    loading: false,
    error: null,
    autoRefresh: true,
    refreshInterval: 5000,
    lastRefresh: 0,
    ollamaHost: detectOllamaHost(),
  };
}

// ── Host Detection ────────────────────────────────────────

function detectOllamaHost(): string {
  // Check localStorage for saved preference
  const saved = localStorage.getItem("ollama-host");
  if (saved) return saved;
  
  return "http://127.0.0.1:11434";
}

export function setOllamaHost(host: string): void {
  localStorage.setItem("ollama-host", host);
}

// ── API Functions ─────────────────────────────────────────

/**
 * Fetch Ollama status via direct API call
 */
export async function fetchOllamaStatus(host: string): Promise<OllamaStatus> {
  const status: OllamaStatus = {
    online: false,
    gpu: null,
    loadedModels: [],
    availableModels: [],
    activeSessions: [],
  };

  try {
    // Check if Ollama is running
    const versionRes = await fetch(`${host}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    
    if (!versionRes.ok) {
      throw new Error(`Ollama returned ${versionRes.status}`);
    }
    
    const versionData = await versionRes.json();
    status.online = true;
    status.version = versionData.version;

    // Get running models (ps)
    const psRes = await fetch(`${host}/api/ps`, {
      signal: AbortSignal.timeout(5000),
    });
    
    if (psRes.ok) {
      const psData = await psRes.json();
      status.loadedModels = (psData.models || []).map((m: any) => ({
        name: m.name,
        model: m.model,
        size: m.size || 0,
        digest: m.digest || '',
        details: m.details || {},
        expires_at: m.expires_at || '',
        size_vram: m.size_vram || m.size || 0,
      }));
    }

    // Get available models (tags)
    const tagsRes = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    
    if (tagsRes.ok) {
      const tagsData = await tagsRes.json();
      status.availableModels = (tagsData.models || []).map((m: any) => ({
        name: m.name,
        model: m.model || m.name,
        modified_at: m.modified_at || '',
        size: m.size || 0,
        digest: m.digest || '',
        details: m.details || {},
      }));
    }

    // Calculate GPU stats from loaded models
    if (status.loadedModels.length > 0) {
      const totalVRAM = status.loadedModels.reduce((sum, m) => sum + m.size_vram, 0);
      status.gpu = {
        name: "GPU",  // We'll get actual name from nvidia-smi if available
        index: 0,
        totalVRAM: 32 * 1024 * 1024 * 1024, // Assume 32GB, will be refined
        usedVRAM: totalVRAM,
        freeVRAM: 32 * 1024 * 1024 * 1024 - totalVRAM,
      };
    }

    return status;
  } catch (err: any) {
    status.error = err.message || "Failed to connect to Ollama";
    return status;
  }
}

/**
 * Load a model via Ollama API (generate with keep_alive)
 */
export async function loadModel(host: string, name: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        prompt: "",
        keep_alive: "24h",  // Keep loaded for 24 hours
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { success: false, error: data.error || `HTTP ${res.status}` };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Unload a model via Ollama API (generate with keep_alive: 0)
 */
export async function unloadModel(host: string, name: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        prompt: "",
        keep_alive: 0,  // Unload immediately
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { success: false, error: data.error || `HTTP ${res.status}` };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Gateway Methods (if available) ───────────────────────

/**
 * `ollama.status` speaks src/ollama-monitor/types.ts, not this file's shape:
 * `connected`/`models`/`sessions` there vs `online`/`availableModels`/
 * `activeSessions` here. Without this translation the `"online" in result`
 * guard below never matched, so every gateway call silently fell through to a
 * cross-origin fetch at the LAN host — which on an install with no reachable
 * Ollama never settles, leaving the monitor on a permanent spinner.
 */
type GatewayOllamaStatus = {
  connected?: boolean;
  host?: string;
  version?: string;
  models?: { name?: string; size?: number; sizeVram?: number; digest?: string; details?: Record<string, string> }[];
  loadedModels?: { name?: string; model?: string; size?: number; sizeVram?: number; expiresAt?: string }[];
  gpu?: { name?: string; vramTotal?: number; vramUsed?: number; vramFree?: number; temperature?: number; utilization?: number; powerDraw?: number } | null;
  sessions?: { id?: string; name?: string; model?: string; startedAt?: number; lastActiveAt?: number; tokensIn?: number; tokensOut?: number }[];
};

function adaptGatewayStatus(raw: GatewayOllamaStatus): OllamaStatus {
  const now = Date.now();
  return {
    online: raw.connected === true,
    version: raw.version,
    gpu: raw.gpu
      ? {
        name: raw.gpu.name ?? "GPU",
        index: 0,
        totalVRAM: raw.gpu.vramTotal ?? 0,
        usedVRAM: raw.gpu.vramUsed ?? 0,
        freeVRAM: raw.gpu.vramFree ?? 0,
        temperature: raw.gpu.temperature,
        utilization: raw.gpu.utilization,
        powerDraw: raw.gpu.powerDraw,
      }
      : null,
    loadedModels: (raw.loadedModels ?? []).map((m) => ({
      name: m.name ?? "",
      model: m.model ?? m.name ?? "",
      size: m.size ?? 0,
      digest: "",
      details: {},
      expires_at: m.expiresAt ?? "",
      size_vram: m.sizeVram ?? m.size ?? 0,
    })),
    availableModels: (raw.models ?? []).map((m) => ({
      name: m.name ?? "",
      model: m.name ?? "",
      modified_at: "",
      size: m.size ?? 0,
      digest: m.digest ?? "",
      details: (m.details ?? {}) as AvailableModel["details"],
    })),
    activeSessions: (raw.sessions ?? []).map((s) => ({
      id: s.id ?? "",
      name: s.name ?? "",
      model: s.model ?? "",
      tokensPerMin: 0,
      totalTokens: (s.tokensIn ?? 0) + (s.tokensOut ?? 0),
      startedAt: s.startedAt ?? now,
      lastActivity: s.lastActiveAt ?? now,
      isActive: true,
    })),
  };
}

/**
 * Try to use gateway methods if available, fall back to direct API
 */
export async function loadStatusViaGateway(
  gw: GatewayBrowserClient | null,
  host: string
): Promise<OllamaStatus> {
  // Try gateway first if available
  if (gw) {
    try {
      const result = await gw.request("ollama.status", {});
      if (result && typeof result === "object") {
        if ("online" in result) return result as OllamaStatus;
        if ("connected" in result) return adaptGatewayStatus(result as GatewayOllamaStatus);
      }
    } catch {
      // Gateway method not available, fall through to direct API
    }
  }

  // Fall back to direct API
  return fetchOllamaStatus(host);
}

export async function loadModelViaGateway(
  gw: GatewayBrowserClient | null,
  host: string,
  name: string
): Promise<{ success: boolean; error?: string }> {
  if (gw) {
    try {
      const result = await gw.request("ollama.models.load", { name });
      if (result && typeof result === "object") {
        return result as { success: boolean; error?: string };
      }
    } catch {
      // Gateway method not available
    }
  }

  return loadModel(host, name);
}

export async function unloadModelViaGateway(
  gw: GatewayBrowserClient | null,
  host: string,
  name: string
): Promise<{ success: boolean; error?: string }> {
  if (gw) {
    try {
      const result = await gw.request("ollama.models.unload", { name });
      if (result && typeof result === "object") {
        return result as { success: boolean; error?: string };
      }
    } catch {
      // Gateway method not available
    }
  }

  return unloadModel(host, name);
}

// ── State Management Helpers ──────────────────────────────

export async function refreshOllamaStatus(
  gw: GatewayBrowserClient | null,
  state: OllamaMonitorState,
  setState: (state: OllamaMonitorState) => void
): Promise<void> {
  setState({ ...state, loading: true, error: null });

  try {
    const status = await loadStatusViaGateway(gw, state.ollamaHost);
    setState({
      ...state,
      status,
      loading: false,
      error: status.error || null,
      lastRefresh: Date.now(),
    });
  } catch (err: any) {
    setState({
      ...state,
      loading: false,
      error: err.message || "Failed to load status",
    });
  }
}

// ── Formatting Helpers ────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function formatVRAM(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}

export function getModelShortName(name: string): string {
  // qwen3:32b -> qwen3:32b
  // llama3.1:8b-instruct-fp16 -> llama3.1:8b
  const parts = name.split(":");
  return parts.length > 1 ? `${parts[0]}:${parts[1].split("-")[0]}` : name;
}

export function getParameterSize(model: LoadedModel | AvailableModel): string {
  return model.details?.parameter_size || "Unknown";
}
