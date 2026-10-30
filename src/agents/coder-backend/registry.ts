/**
 * CoderBackend Registry — factory that returns the configured backend.
 *
 * Config key: `coder.backend` in infinibot.json
 * Default:    "claude-code" (zero behaviour change for existing users)
 *
 * Usage:
 *   import { getCoderBackend } from "./registry.js"
 *   const result = await getCoderBackend().spawn(config, task, workdir)
 *
 * Per-spawn override:
 *   import { createCoderBackend } from "./registry.js"
 *   const backend = createCoderBackend("opencode")
 *
 * COORDINATION: opencode-swap — new file; no existing code modified here.
 */

import { loadConfig } from "../../config/config.js";
import { ClaudeCodeBackend } from "./claude-code.js";
import { OpenCodeBackend } from "./opencode.js";
import { CodexCliBackend } from "./codex.js";
import { GeminiCliBackend } from "./gemini.js";
import { GrokCliBackend } from "./grok.js";
import type { CoderBackend, CoderBackendId } from "./types.js";

// Module-level singletons — one per backend type.
// Backends are stateless (no run-level state), so sharing is safe.
const _instances = new Map<CoderBackendId, CoderBackend>();

function getOrCreate(id: CoderBackendId): CoderBackend {
  let inst = _instances.get(id);
  if (!inst) {
    inst =
      id === "opencode"
        ? new OpenCodeBackend()
        : id === "codex"
          ? new CodexCliBackend()
          : id === "gemini"
            ? new GeminiCliBackend()
            : id === "grok"
              ? new GrokCliBackend()
              : new ClaudeCodeBackend();
    _instances.set(id, inst);
  }
  return inst;
}

/**
 * Return the backend configured in `coder.backend`.
 * Falls back to "claude-code" so existing deployments see zero change.
 */
export function getCoderBackend(): CoderBackend {
  const cfg = loadConfig() as { coder?: { backend?: CoderBackendId } };
  const id: CoderBackendId = cfg.coder?.backend ?? "claude-code";
  return getOrCreate(id);
}

/**
 * Create a backend by explicit id (for per-spawn overrides).
 * Does not read config — caller supplies the backend id directly.
 */
export function createCoderBackend(id: CoderBackendId): CoderBackend {
  return getOrCreate(id);
}

/**
 * Return the configured backend id without constructing the backend object.
 */
export function getCoderBackendId(): CoderBackendId {
  const cfg = loadConfig() as { coder?: { backend?: CoderBackendId } };
  return cfg.coder?.backend ?? "claude-code";
}

/** Clear cached singletons (for testing). */
export function _clearBackendCache(): void {
  _instances.clear();
}
