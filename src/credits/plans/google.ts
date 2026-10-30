/**
 * Google (Gemini) plan definitions.
 * Sources & caveats: docs/research/provider-plans.md §3.
 *
 * No public usage REST endpoint exists for AI-Studio API keys. Vertex AI usage
 * is available via Cloud Monitoring but requires gcloud ADC / a service account
 * the gateway can't assume — so every Google plan currently falls back to
 * local-ledger estimates (Vertex is a documented TODO in the puller).
 */
import type { PlanDef } from "./types.js";

export const GOOGLE_PLANS: PlanDef[] = [
  {
    id: "free",
    provider: "google",
    label: "Gemini Free tier",
    kind: "subscription",
    monthlyPriceUsd: 0,
    rateLimit: { requestsPerMinute: 15, requestsPerDay: 1000, tokensPerMinute: 250_000 },
    hasUsageApi: false,
    notes: "AI Studio free key. No usage REST. Estimated from local ledger.",
  },
  {
    id: "api",
    provider: "google",
    label: "AI Studio paid",
    kind: "api",
    hasUsageApi: false,
    notes: "Billed AI-Studio key, metered per-token. No usage REST. Estimated.",
  },
  {
    id: "pro",
    provider: "google",
    label: "Google AI Pro",
    kind: "subscription",
    monthlyPriceUsd: 20,
    hasUsageApi: false,
    notes: "Consumer subscription bundle. No usage REST. Estimated.",
  },
  {
    id: "vertex",
    provider: "google",
    label: "Vertex AI",
    kind: "api",
    hasUsageApi: false, // Cloud Monitoring exists but needs gcloud ADC — TODO
    notes:
      "GCP project billing. Usage via Cloud Monitoring (needs gcloud ADC/service account) — TODO; estimated for now.",
  },
];
