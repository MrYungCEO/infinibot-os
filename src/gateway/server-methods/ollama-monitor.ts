/**
 * Ollama Monitor Gateway Methods
 *
 * Provides gateway RPC methods for monitoring Ollama server status,
 * GPU stats, and active sessions.
 */

import { getOllamaMonitor } from "../../ollama-monitor/service.js";
import { loadConfig } from "../../config/config.js";
import type { GatewayRequestHandlers } from "./types.js";
import type { OllamaSession } from "../../ollama-monitor/types.js";
import { forwardGatewayCall } from "../../federation/hub-forward.js";

const OLLAMA_MODELS_CACHE_TTL_MS = 30_000;

type OllamaTagsModel = {
  name?: string;
  model?: string;
  size?: number;
  modified_at?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
};

type OllamaModelsByNodeResult = {
  models: OllamaTagsModel[];
  reason?: string;
};

const ollamaModelsByNodeCache = new Map<
  string,
  { expiresAt: number; result: OllamaModelsByNodeResult }
>();

function getCachedOllamaModelsByNode(nodeId: string): OllamaModelsByNodeResult | null {
  const cached = ollamaModelsByNodeCache.get(nodeId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    ollamaModelsByNodeCache.delete(nodeId);
    return null;
  }
  return cached.result;
}

function cacheOllamaModelsByNode(nodeId: string, result: OllamaModelsByNodeResult): void {
  ollamaModelsByNodeCache.set(nodeId, {
    expiresAt: Date.now() + OLLAMA_MODELS_CACHE_TTL_MS,
    result,
  });
}

async function fetchLocalOllamaModels(host: string): Promise<OllamaModelsByNodeResult> {
  try {
    const res = await fetch(`${host.replace(/\/$/, "")}/api/tags`);
    if (!res.ok) return { models: [], reason: "ollama unreachable" };
    const json = (await res.json()) as { models?: OllamaTagsModel[] };
    return {
      models: Array.isArray(json.models) ? json.models : [],
    };
  } catch {
    return { models: [], reason: "ollama unreachable" };
  }
}

/**
 * Get Ollama host from config or environment
 */
function getOllamaHost(): string {
  try {
    const config = loadConfig();
    // Check integrations.ollama.host in config
    const integrations = config.integrations as Record<string, any> | undefined;
    if (integrations?.ollama?.host) {
      return integrations.ollama.host;
    }
  } catch {
    // Config not available, use default
  }
  return process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
}

/**
 * Initialize the monitor with configured host
 */
function initMonitor() {
  const monitor = getOllamaMonitor();
  const host = getOllamaHost();
  monitor.setHost(host);
  return monitor;
}

export const ollamaMonitorHandlers: GatewayRequestHandlers = {
  /**
   * List Ollama models on a specific federation node.
   * Params: { nodeId?: string } where omitted/"local" means this gateway.
   */
  "ollama.models.byNode": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const nodeId = typeof p.nodeId === "string" && p.nodeId.trim() ? p.nodeId.trim() : "local";

    const cached = getCachedOllamaModelsByNode(nodeId);
    if (cached) {
      respond(true, cached);
      return;
    }

    if (nodeId !== "local") {
      const fwd = await forwardGatewayCall<OllamaModelsByNodeResult>(
        nodeId,
        "ollama.models.byNode",
        { nodeId: "local" },
      );
      const result: OllamaModelsByNodeResult = fwd.success
        ? {
            models: Array.isArray(fwd.payload?.models) ? fwd.payload.models : [],
            reason: fwd.payload?.reason,
          }
        : { models: [], reason: fwd.error ?? "ollama unreachable" };
      cacheOllamaModelsByNode(nodeId, result);
      respond(true, result);
      return;
    }

    const result = await fetchLocalOllamaModels(getOllamaHost());
    cacheOllamaModelsByNode(nodeId, result);
    respond(true, result);
  },

  /**
   * Get full Ollama status
   * Returns: OllamaStatus
   */
  "ollama.status": async ({ respond }) => {
    try {
      const monitor = initMonitor();
      const status = await monitor.getStatus();
      respond(true, status);
    } catch (e) {
      respond(false, undefined, {
        code: "OLLAMA_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * List available models
   * Returns: OllamaModel[]
   */
  "ollama.models.list": async ({ respond }) => {
    try {
      const monitor = initMonitor();
      const models = await monitor.getModels();
      respond(true, { models });
    } catch (e) {
      respond(false, undefined, {
        code: "OLLAMA_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * List currently loaded models
   * Returns: LoadedModel[]
   */
  "ollama.models.loaded": async ({ respond }) => {
    try {
      const monitor = initMonitor();
      const models = await monitor.getLoadedModels();
      respond(true, { models });
    } catch (e) {
      respond(false, undefined, {
        code: "OLLAMA_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Load a model into memory
   * Params: { model: string, keepAlive?: string }
   */
  "ollama.models.load": async ({ params, respond }) => {
    try {
      const model = params.model;
      if (typeof model !== "string" || !model) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "model is required",
        });
        return;
      }

      const keepAlive = typeof params.keepAlive === "string" ? params.keepAlive : "5m";

      const monitor = initMonitor();
      await monitor.loadModel(model, keepAlive);

      // Return updated loaded models
      const models = await monitor.getLoadedModels();
      respond(true, { success: true, models });
    } catch (e) {
      respond(false, undefined, {
        code: "OLLAMA_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Unload a model from memory
   * Params: { model: string }
   */
  "ollama.models.unload": async ({ params, respond }) => {
    try {
      const model = params.model;
      if (typeof model !== "string" || !model) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "model is required",
        });
        return;
      }

      const monitor = initMonitor();
      await monitor.unloadModel(model);

      // Return updated loaded models
      const models = await monitor.getLoadedModels();
      respond(true, { success: true, models });
    } catch (e) {
      respond(false, undefined, {
        code: "OLLAMA_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Get GPU stats only
   * Returns: GpuStats | null
   */
  "ollama.gpu": async ({ respond }) => {
    try {
      const monitor = initMonitor();
      const gpu = await monitor.getGpuStats();
      respond(true, { gpu });
    } catch (e) {
      respond(false, undefined, {
        code: "GPU_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Get active sessions
   * Returns: OllamaSession[]
   */
  "ollama.sessions": async ({ respond }) => {
    try {
      const monitor = initMonitor();
      const sessions = monitor.getSessions();
      respond(true, { sessions });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Register a new session
   * Params: OllamaSession
   */
  "ollama.session.register": async ({ params, respond }) => {
    try {
      const session: OllamaSession = {
        id: typeof params.id === "string" ? params.id : `session_${Date.now()}`,
        name: typeof params.name === "string" ? params.name : "unknown",
        model: typeof params.model === "string" ? params.model : "unknown",
        startedAt: typeof params.startedAt === "number" ? params.startedAt : Date.now(),
        lastActiveAt: Date.now(),
        tokensIn: typeof params.tokensIn === "number" ? params.tokensIn : 0,
        tokensOut: typeof params.tokensOut === "number" ? params.tokensOut : 0,
        requestCount: typeof params.requestCount === "number" ? params.requestCount : 0,
      };

      const monitor = initMonitor();
      monitor.registerSession(session);

      respond(true, { success: true, session });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Update a session's activity
   * Params: { id: string, tokensIn?: number, tokensOut?: number, requestCount?: number }
   */
  "ollama.session.update": async ({ params, respond }) => {
    try {
      const id = params.id;
      if (typeof id !== "string" || !id) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "id is required",
        });
        return;
      }

      const monitor = initMonitor();
      monitor.updateSession(id, {
        tokensIn: typeof params.tokensIn === "number" ? params.tokensIn : undefined,
        tokensOut: typeof params.tokensOut === "number" ? params.tokensOut : undefined,
        requestCount: typeof params.requestCount === "number" ? params.requestCount : undefined,
      });

      respond(true, { success: true });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Unregister a session
   * Params: { id: string }
   */
  "ollama.session.unregister": async ({ params, respond }) => {
    try {
      const id = params.id;
      if (typeof id !== "string" || !id) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "id is required",
        });
        return;
      }

      const monitor = initMonitor();
      monitor.unregisterSession(id);

      respond(true, { success: true });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Check if Ollama is connected
   * Returns: { connected: boolean, host: string }
   */
  "ollama.ping": async ({ respond }) => {
    try {
      const monitor = initMonitor();
      const connected = await monitor.isConnected();
      respond(true, {
        connected,
        host: monitor.getHost(),
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Start background polling
   */
  "ollama.polling.start": async ({ respond }) => {
    try {
      const monitor = initMonitor();
      monitor.startPolling();
      respond(true, { success: true, message: "Polling started" });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Stop background polling
   */
  "ollama.polling.stop": async ({ respond }) => {
    try {
      const monitor = initMonitor();
      monitor.stopPolling();
      respond(true, { success: true, message: "Polling stopped" });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
