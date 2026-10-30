/**
 * Plan registry — single source of truth for provider plan metadata.
 *
 * Aggregates the per-provider modules so callers (settings UI, pullers) can
 * list plans and resolve a `PlanDef` by (provider, planId).
 */
import { ANTHROPIC_PLANS } from "./anthropic.js";
import { OPENAI_PLANS } from "./openai.js";
import { GOOGLE_PLANS } from "./google.js";
import { OPENCODE_PLANS } from "./opencode.js";
import type { PlanDef, PlanProvider } from "./types.js";

export type { PlanDef, PlanProvider, PlanRateLimit } from "./types.js";

/** Every provider we know how to track plans for. */
export const PLAN_PROVIDERS: PlanProvider[] = ["anthropic", "openai", "google", "opencode"];

const REGISTRY: Record<PlanProvider, PlanDef[]> = {
  anthropic: ANTHROPIC_PLANS,
  openai: OPENAI_PLANS,
  google: GOOGLE_PLANS,
  opencode: OPENCODE_PLANS,
};

export function isPlanProvider(p: string): p is PlanProvider {
  return (PLAN_PROVIDERS as string[]).includes(p);
}

export function listPlansForProvider(provider: string): PlanDef[] {
  return isPlanProvider(provider) ? REGISTRY[provider] : [];
}

export function listAllPlans(): PlanDef[] {
  return PLAN_PROVIDERS.flatMap((p) => REGISTRY[p]);
}

/** Resolve a specific plan def. Falls back to the provider's "api" plan. */
export function getPlanDef(provider: string, planId: string | undefined): PlanDef | undefined {
  const plans = listPlansForProvider(provider);
  if (plans.length === 0) return undefined;
  return plans.find((p) => p.id === planId) ?? plans.find((p) => p.id === "api") ?? plans[0];
}
