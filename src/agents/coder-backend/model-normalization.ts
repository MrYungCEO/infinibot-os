import type { CoderBackendId } from "./types.js";

/**
 * Backend/tool selectors are not model ids. Small models occasionally copy the
 * tool name into `model` (for example codex_coder({ model: "codex" })), which
 * forces the CLI off its configured default and can produce a provider 400.
 */
const BACKEND_MODEL_SENTINELS = new Set([
  "default",
  "claude",
  "claude-code",
  "opencode",
  "codex",
  "gemini",
  "grok",
  "grok-cli",
]);

export type NormalizedCoderModel = {
  model?: string;
  warning?: string;
};

export function normalizeCoderModelOverride(
  rawModel: string | undefined,
  backend: CoderBackendId,
): NormalizedCoderModel {
  const model = rawModel?.trim();
  if (!model) return {};
  if (!BACKEND_MODEL_SENTINELS.has(model.toLowerCase())) return { model };
  return {
    warning: `Ignored invalid model override "${model}" for ${backend}; using the backend's configured default model.`,
  };
}
