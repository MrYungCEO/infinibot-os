/**
 * Plan-puller registry + safe dispatch.
 *
 * `pullPlanUsage()` resolves the right puller for a provider, runs it inside a
 * hard try/catch (pullers shouldn't throw, but defense in depth), and always
 * returns a usage object — never rejects. This is the single entry point used
 * by the refresh loop and the `credits.providers.refresh` RPC.
 */
import { getPlanDef } from "../plans/index.js";
import type { ProviderPlanConfig } from "../plan-config.js";
import { estimatedUsage } from "./estimate.js";
import { anthropicPuller } from "./anthropic.js";
import { openaiPuller } from "./openai.js";
import { googlePuller } from "./google.js";
import { opencodePuller } from "./opencode.js";
import type { PlanPuller, ProviderPlanUsage } from "./types.js";

export type { ProviderPlanUsage, PlanUsageSource, PlanUsageStatus } from "./types.js";

const PULLERS: Record<string, PlanPuller> = {
  anthropic: anthropicPuller,
  openai: openaiPuller,
  google: googlePuller,
  opencode: opencodePuller,
};

export function hasPuller(provider: string): boolean {
  return provider in PULLERS;
}

/** Run a provider's puller. Never throws — errors become an estimated result. */
export async function pullPlanUsage(cfg: ProviderPlanConfig): Promise<ProviderPlanUsage> {
  const puller = PULLERS[cfg.provider];
  if (!puller) {
    return estimatedUsage(cfg, "unsupported", `No puller for provider ${cfg.provider}.`);
  }
  try {
    return await puller.fetchPlanUsage(cfg, getPlanDef(cfg.provider, cfg.plan));
  } catch (e) {
    // Pullers are supposed to self-handle; this is the last safety net.
    return estimatedUsage(cfg, "error", `Puller threw: ${String(e)}`);
  }
}
