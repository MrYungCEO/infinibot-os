/**
 * Anthropic (Claude Code) plan definitions.
 * Sources & caveats: docs/research/provider-plans.md §1.
 *
 * Only the **API** plan has a live usage API (the org Admin API:
 * cost_report + usage_report/messages, requires an `sk-ant-admin-…` key).
 * Pro/Max/Team/Enterprise subscriptions have no public usage REST endpoint,
 * so they fall back to local-ledger estimates.
 */
import type { PlanDef } from "./types.js";

export const ANTHROPIC_PLANS: PlanDef[] = [
  {
    id: "api",
    provider: "anthropic",
    label: "API pay-go",
    kind: "api",
    hasUsageApi: true, // org Admin API (sk-ant-admin key)
    notes:
      "Metered per-token. Live usage via Admin API cost_report + usage_report/messages when an sk-ant-admin key is supplied.",
  },
  {
    id: "pro",
    provider: "anthropic",
    label: "Claude Pro",
    kind: "subscription",
    monthlyPriceUsd: 20,
    hasUsageApi: false,
    notes: "Consumer subscription. No usage API — estimated from local ledger.",
  },
  {
    id: "max",
    provider: "anthropic",
    label: "Claude Max",
    kind: "subscription",
    monthlyPriceUsd: 100,
    hasUsageApi: false,
    notes: "Consumer subscription (5x/20x tiers ~$100/$200). No usage API.",
  },
  {
    id: "team",
    provider: "anthropic",
    label: "Claude Team",
    kind: "subscription",
    monthlyPriceUsd: 30,
    hasUsageApi: true, // org Admin API available for orgs
    notes: "Per-seat org plan. Admin API usable with an org Admin key.",
  },
  {
    id: "enterprise",
    provider: "anthropic",
    label: "Claude Enterprise",
    kind: "subscription",
    hasUsageApi: true,
    notes: "Custom org pricing. Admin API usable with an org Admin key.",
  },
];
