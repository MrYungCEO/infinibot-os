/**
 * Vision Controller
 * Manages vision state for voice chat and text chat UIs
 */

import { GatewayBrowserClient } from "../gateway";

export interface VisionSettings {
  enabled: boolean;
  backend: "auto" | "local" | "claude";
  device: "webcam" | "screen";
  autoCapture: boolean; // Auto-capture on speech end (voice mode)
  captureOnSend: boolean; // Capture when sending message (chat mode)
}

export interface VisionStatus {
  local: {
    status: "connected" | "disconnected" | "unknown";
    model: string;
    modelLoaded: boolean;
    url: string;
  };
  claude: {
    status: "configured" | "missing_key";
  };
  frameBufferDir: string;
  framesStored: number;
}

export interface VisionDevice {
  id: string;
  name: string;
}

export interface VisionState {
  settings: VisionSettings;
  status: VisionStatus | null;
  devices: VisionDevice[];
  loading: boolean;
  error: string | null;
  lastCapture: string | null;
  lastAnalysis: string | null;
  analyzing: boolean;
}

const DEFAULT_SETTINGS: VisionSettings = {
  enabled: false,
  backend: "auto",
  device: "webcam",
  autoCapture: true,
  captureOnSend: false,
};

const STORAGE_KEY = "infinibot_vision_settings";

// ─────────────────────────────────────────────────────────────
// Load/Save Settings
// ─────────────────────────────────────────────────────────────

export function loadVisionSettings(): VisionSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.warn("[vision] Failed to load settings:", e);
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveVisionSettings(settings: VisionSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("[vision] Failed to save settings:", e);
  }
}

// ─────────────────────────────────────────────────────────────
// Gateway API Calls
// ─────────────────────────────────────────────────────────────

// All vision RPCs take a live gateway client instance — `GatewayBrowserClient`
// is a class, not a singleton, so calling `.request()` on the class itself
// throws `(intermediate value).request is not a function`. Callers must hand
// in the connected client they already hold (e.g. `this.gatewayClient` on
// voice-chat). Null returns mean either the client wasn't ready or the RPC
// errored — both are non-fatal for the UI.

export async function fetchVisionStatus(client: GatewayBrowserClient | null): Promise<VisionStatus | null> {
  if (!client) return null;
  try {
    const result = await client.request("vision.status", {});
    return result as VisionStatus;
  } catch (e) {
    console.error("[vision] Failed to fetch status:", e);
    return null;
  }
}

export async function fetchVisionDevices(client: GatewayBrowserClient | null): Promise<VisionDevice[]> {
  if (!client) return [];
  try {
    const result = await client.request("vision.devices", {}) as any;
    return (result.webcams || []).map((name: string) => ({
      id: `video=${name}`,
      name,
    }));
  } catch (e) {
    console.error("[vision] Failed to fetch devices:", e);
    return [];
  }
}

export async function captureFrame(client: GatewayBrowserClient | null, device: "webcam" | "screen"): Promise<string | null> {
  if (!client) return null;
  try {
    const result = await client.request("vision.capture", { device }) as any;
    return result.path || null;
  } catch (e) {
    console.error("[vision] Failed to capture frame:", e);
    return null;
  }
}

export async function analyzeImage(
  client: GatewayBrowserClient | null,
  opts: {
    imagePath?: string;
    device?: "webcam" | "screen";
    prompt?: string;
    backend?: "auto" | "local" | "claude";
  },
): Promise<{ description: string; backend: string; latencyMs: number } | null> {
  if (!client) return null;
  try {
    // If no imagePath, do a look (capture + analyze)
    if (!opts.imagePath) {
      const result = await client.request("vision.look", {
        device: opts.device || "webcam",
        prompt: opts.prompt || "What do you see?",
        backend: opts.backend || "auto",
      }) as any;
      return {
        description: result.description,
        backend: result.backend,
        latencyMs: result.latencyMs,
      };
    }

    // Analyze existing image
    const result = await client.request("vision.analyze", {
      imagePath: opts.imagePath,
      prompt: opts.prompt || "What do you see?",
      backend: opts.backend || "auto",
    }) as any;
    return {
      description: result.description,
      backend: result.backend,
      latencyMs: result.latencyMs,
    };
  } catch (e) {
    console.error("[vision] Failed to analyze:", e);
    return null;
  }
}

export async function quickDescribe(client: GatewayBrowserClient | null, device: "webcam" | "screen"): Promise<string | null> {
  if (!client) return null;
  try {
    const result = await client.request("vision.describe", { device }) as any;
    return result.description || null;
  } catch (e) {
    console.error("[vision] Failed to describe:", e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────

export function createVisionState(): VisionState {
  return {
    settings: loadVisionSettings(),
    status: null,
    devices: [],
    loading: false,
    error: null,
    lastCapture: null,
    lastAnalysis: null,
    analyzing: false,
  };
}

export async function initializeVisionState(state: VisionState): Promise<VisionState> {
  state.loading = true;
  state.error = null;
  
  try {
    const [status, devices] = await Promise.all([
      fetchVisionStatus(),
      fetchVisionDevices(),
    ]);
    
    return {
      ...state,
      status,
      devices,
      loading: false,
    };
  } catch (e) {
    return {
      ...state,
      loading: false,
      error: String(e),
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Available Models
// ─────────────────────────────────────────────────────────────

export const VISION_BACKENDS = [
  { id: "auto", name: "Auto (Smart Routing)", description: "Routes based on task complexity" },
  { id: "local", name: "Local (MiniCPM-V)", description: "Fast ~200-400ms, runs on GPU" },
  { id: "claude", name: "Claude Vision", description: "High quality ~2-3s, API cost" },
] as const;

export const LOCAL_VISION_MODELS = [
  { id: "minicpm-v:8b", name: "MiniCPM-V 8B", size: "5.5GB", speed: "fast" },
  { id: "llava:13b", name: "LLaVA 13B", size: "8GB", speed: "medium" },
  { id: "moondream:1.8b", name: "Moondream 1.8B", size: "1.7GB", speed: "fastest" },
] as const;
