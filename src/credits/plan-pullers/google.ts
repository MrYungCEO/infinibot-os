/**
 * Google (Gemini) plan-usage puller — FALLBACK ONLY.
 *
 * There is no public usage/quota REST endpoint for AI-Studio API keys, and
 * Vertex AI usage requires gcloud ADC / a service account the gateway can't
 * assume (Cloud Monitoring `aiplatform.googleapis.com` metrics + `serviceusage`
 * quotas). So this puller always returns a local-ledger estimate.
 * See docs/research/provider-plans.md §3 for the Vertex TODO.
 */
import type { ProviderPlanConfig } from "../plan-config.js";
import type { PlanDef } from "../plans/index.js";
import { cliBackedUsage, probeGeminiCli } from "./cli.js";
import type { PlanPuller, ProviderPlanUsage } from "./types.js";

export const googlePuller: PlanPuller = {
  provider: "google",
  async fetchPlanUsage(
    cfg: ProviderPlanConfig,
    _planDef: PlanDef | undefined,
  ): Promise<ProviderPlanUsage> {
    // No usage REST for AI-Studio keys; Vertex needs gcloud creds (TODO).
    // The gemini CLI still reports install/auth state for the plan card, so
    // probe it and fall back to a local-ledger estimate for the numbers.
    return cliBackedUsage(cfg, probeGeminiCli());
  },
};
