/**
 * Plan registry types.
 *
 * A `PlanDef` is the static description of one provider plan tier (its price,
 * included tokens/credit, rate limits, and whether a live usage API exists).
 * The registry under `src/credits/plans/` is the single source of truth for
 * this metadata — see `docs/research/provider-plans.md` for the sourcing.
 */

/** Canonical provider keys we track plans for. */
export type PlanProvider = "anthropic" | "openai" | "google" | "opencode";

export interface PlanRateLimit {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  requestsPerDay?: number;
  tokensPerDay?: number;
}

export interface PlanDef {
  /** Stable id, unique within a provider (e.g. "api", "pro", "max"). */
  id: string;
  provider: PlanProvider;
  /** Human label for the settings dropdown. */
  label: string;
  /** "api" = metered pay-go; "subscription" = flat monthly entitlement. */
  kind: "api" | "subscription";
  /** Flat monthly price for subscription plans (USD). */
  monthlyPriceUsd?: number;
  /** Included monthly tokens for subscription plans (if a clear cap exists). */
  includedTokens?: number;
  /** Included monthly USD credit (e.g. promo credits). Undefined = pure metered. */
  includedUsd?: number;
  rateLimit?: PlanRateLimit;
  /**
   * Whether a live usage/quota API exists for this plan with the right
   * credential. Drives whether the settings UI suggests entering an Admin key.
   */
  hasUsageApi: boolean;
  notes?: string;
}
