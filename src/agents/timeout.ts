import type { InfinibotConfig } from "../config/config.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

export function resolveAgentTimeoutSeconds(cfg?: InfinibotConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.max(seconds, 1);
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: InfinibotConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const defaultMs = resolveAgentTimeoutSeconds(opts.cfg) * 1000;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs <= 0) return defaultMs;
    return Math.max(overrideMs, minMs);
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds <= 0) return defaultMs;
    return Math.max(overrideSeconds * 1000, minMs);
  }
  return Math.max(defaultMs, minMs);
}

const DEFAULT_LOCAL_TIMEOUT_SECONDS = 20 * 60;

/** Turn timeout for local-model and Secure Mode runs (agents.defaults.localTimeoutSeconds). */
export function resolveLocalTurnTimeoutSeconds(cfg?: InfinibotConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.localTimeoutSeconds);
  return Math.max(raw ?? DEFAULT_LOCAL_TIMEOUT_SECONDS, 1);
}

/**
 * Local models are slower and share the GPU with background OCR/vision, so a
 * local-model or Secure Mode turn that arrives with the DEFAULT timeout gets
 * the longer local one. An explicit timeout (anything but the default) wins.
 */
export function resolveTurnTimeoutMs(params: {
  cfg?: InfinibotConfig;
  timeoutMs: number;
  local: boolean;
}): number {
  if (!params.local) return params.timeoutMs;
  const defaultMs = resolveAgentTimeoutSeconds(params.cfg) * 1000;
  if (params.timeoutMs !== defaultMs) return params.timeoutMs;
  // Configured localTimeoutSeconds is used as-is; otherwise never shorter
  // than the general default.
  const configured = normalizeNumber(params.cfg?.agents?.defaults?.localTimeoutSeconds);
  if (configured !== undefined) return Math.max(configured, 1) * 1000;
  return Math.max(params.timeoutMs, DEFAULT_LOCAL_TIMEOUT_SECONDS * 1000);
}
