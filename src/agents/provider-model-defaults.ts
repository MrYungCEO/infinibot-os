// Per-provider default model ids + the table of upstream-retired model refs.
//
// Dependency-free on purpose: imported by the gateway runtime, the boot config
// migration AND the control UI (setup wizard), so there is exactly one place
// to bump a provider default when upstream retires a model.

/**
 * Ollama Cloud (Turbo) default. kimi-k2.5 was retired by Ollama on 2026-07-31
 * (HTTP 410) — gpt-oss:120b is the long-lived replacement.
 */
export const OLLAMA_CLOUD_DEFAULT_MODEL_ID = "gpt-oss:120b";

/** Provider id → the model to heal onto when a configured model is unavailable. */
export const PROVIDER_DEFAULT_MODEL_IDS: Readonly<Record<string, string>> = {
  "ollama-cloud": OLLAMA_CLOUD_DEFAULT_MODEL_ID,
};

/**
 * Model refs ("provider/model") known to be retired upstream, mapped to their
 * replacement. The boot migration rewrites these in agents.defaults.model and
 * agents.list[].model so configs heal permanently, not just per turn.
 */
export const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
  "ollama-cloud/kimi-k2.5": `ollama-cloud/${OLLAMA_CLOUD_DEFAULT_MODEL_ID}`,
};
