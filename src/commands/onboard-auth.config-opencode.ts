import {
  OPENCODE_ZEN_DEEPSEEK_V4_FLASH_MODEL_REF,
  OPENCODE_ZEN_DEFAULT_MODEL_REF,
} from "../agents/opencode-zen-models.js";
import type { InfinibotConfig } from "../config/config.js";

export function applyOpencodeZenProviderConfig(cfg: InfinibotConfig): InfinibotConfig {
  // Use the built-in opencode provider from pi-ai; seed allowlist aliases for the static catalog.
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENCODE_ZEN_DEFAULT_MODEL_REF] = {
    ...models[OPENCODE_ZEN_DEFAULT_MODEL_REF],
    alias: models[OPENCODE_ZEN_DEFAULT_MODEL_REF]?.alias ?? "Opus",
  };
  models[OPENCODE_ZEN_DEEPSEEK_V4_FLASH_MODEL_REF] = {
    ...models[OPENCODE_ZEN_DEEPSEEK_V4_FLASH_MODEL_REF],
    alias: models[OPENCODE_ZEN_DEEPSEEK_V4_FLASH_MODEL_REF]?.alias ?? "DeepSeek V4 Flash",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

export function applyOpencodeZenConfig(cfg: InfinibotConfig): InfinibotConfig {
  const next = applyOpencodeZenProviderConfig(cfg);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(next.agents?.defaults?.model &&
          "fallbacks" in (next.agents.defaults.model as Record<string, unknown>)
            ? {
                fallbacks: (next.agents.defaults.model as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: OPENCODE_ZEN_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}
