/**
 * Plan-usage puller contract.
 *
 * Each provider implements `fetchPlanUsage(config) → ProviderPlanUsage`. Pullers
 * return real numbers (`source:"api"`) when the provider exposes a usage API and
 * the right credential is configured; otherwise they fall back to summing the
 * local credit ledger for the current month and mark `source:"estimated"`.
 *
 * Pullers must NEVER throw — they catch their own errors and return a usage
 * object with `status:"error"` so the refresh loop can cache last-good state.
 */
import type { ProviderPlanConfig } from "../plan-config.js";
import type { PlanDef } from "../plans/index.js";

export type PlanUsageSource = "api" | "estimated";
export type PlanUsageStatus = "ok" | "error" | "missing-credentials" | "unsupported";

export interface ProviderPlanUsage {
  provider: string;
  /** Effective plan used for the limit denominator (manual pin or detected). */
  plan: string;
  /**
   * Plan the provider's CLI/credential cache reports, when detectable. Surfaced
   * so the UI can offer "CLI says X — use detected?" without silently changing a
   * manually-pinned plan. Undefined when the CLI can't report a plan.
   */
  detectedPlan?: string;
  periodStart: number;
  periodEnd: number;
  usedTokens?: number;
  usedUsd?: number;
  remainingTokens?: number;
  remainingUsd?: number;
  /** Denominator for the progress bar (budget / cap). */
  limitUsd?: number;
  limitTokens?: number;
  source: PlanUsageSource;
  status: PlanUsageStatus;
  message?: string;
  fetchedAt: number;
}

export interface PlanPuller {
  provider: string;
  fetchPlanUsage(cfg: ProviderPlanConfig, planDef: PlanDef | undefined): Promise<ProviderPlanUsage>;
}
