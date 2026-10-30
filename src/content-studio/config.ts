/**
 * Content Studio plugin settings that core content code reads.
 *
 * The Content Intelligence reel pipeline is owner-private (PRIVATE-SPLIT §5):
 * nothing points at it unless it is configured. Precedence:
 *   env (INFINIBOT_CONTENT_INTEL_PIPELINE_DIR / REEL_PIPELINE_DIR,
 *        INFINIBOT_CONTENT_INTEL_VENV)
 *   → plugin config (plugins.entries.content-studio.config.{pipelineDir,venvPath})
 *   → legacy config (integrations.contentIntel.{pipelineDir,venvPath})
 *   → "" (pipeline disabled: imports/scoring that need it report so).
 */

import type { InfinibotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { CONTENT_STUDIO_PLUGIN_ID } from "./methods.js";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function contentStudioPluginConfig(cfg?: InfinibotConfig): Record<string, unknown> {
  const config = cfg ?? loadConfig();
  const entries = (
    config?.plugins as { entries?: Record<string, { config?: unknown }> } | undefined
  )?.entries;
  const raw = entries?.[CONTENT_STUDIO_PLUGIN_ID]?.config;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function resolveReelPipelineSettings(
  cfg?: InfinibotConfig,
  env: NodeJS.ProcessEnv = process.env,
): { pipelineDir: string; venvPath: string } {
  const config = cfg ?? loadConfig();
  const plugin = contentStudioPluginConfig(config);
  const legacy = (config?.integrations as { contentIntel?: Record<string, unknown> } | undefined)
    ?.contentIntel;
  return {
    pipelineDir:
      str(env.INFINIBOT_CONTENT_INTEL_PIPELINE_DIR) ||
      str(env.REEL_PIPELINE_DIR) ||
      str(plugin.pipelineDir) ||
      str(legacy?.pipelineDir),
    venvPath:
      str(env.INFINIBOT_CONTENT_INTEL_VENV) || str(plugin.venvPath) || str(legacy?.venvPath),
  };
}
