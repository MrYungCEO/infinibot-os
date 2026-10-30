/**
 * OpenAI (Codex) plan definitions.
 * Sources & caveats: docs/research/provider-plans.md §2.
 *
 * The **API** plan has a live usage API (org Admin API: organization/costs +
 * organization/usage/completions, requires an `sk-admin-…` key). ChatGPT
 * Plus/Pro Codex subscriptions are rate-limit based with no public usage REST,
 * so they fall back to local-ledger estimates.
 */
import type { PlanDef } from "./types.js";

export const OPENAI_PLANS: PlanDef[] = [
  {
    id: "api",
    provider: "openai",
    label: "API pay-go",
    kind: "api",
    hasUsageApi: true, // org Admin API (sk-admin key)
    notes:
      "Metered per-token. Live usage via Admin API organization/costs + organization/usage/completions when an sk-admin key is supplied.",
  },
  {
    id: "plus",
    provider: "openai",
    label: "ChatGPT Plus (Codex)",
    kind: "subscription",
    monthlyPriceUsd: 20,
    hasUsageApi: false,
    notes:
      "Codex included. Rolling 5h + weekly rate limits; no usage REST. Estimated from local ledger.",
  },
  {
    id: "pro",
    provider: "openai",
    label: "ChatGPT Pro (Codex)",
    kind: "subscription",
    monthlyPriceUsd: 200,
    hasUsageApi: false,
    notes: "Codex included, 5x–20x Plus limits. No usage REST. Estimated.",
  },
  {
    id: "team",
    provider: "openai",
    label: "ChatGPT Team / Business",
    kind: "subscription",
    monthlyPriceUsd: 30,
    hasUsageApi: false,
    notes: "Per-seat. No Codex usage REST. Estimated.",
  },
  {
    id: "enterprise",
    provider: "openai",
    label: "ChatGPT Enterprise",
    kind: "subscription",
    hasUsageApi: false,
    notes: "Custom pricing. No Codex usage REST. Estimated.",
  },
];
