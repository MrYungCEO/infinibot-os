/**
 * "Is this model free to use?" — sourced classification for the model picker.
 *
 * Three honest states (never guessed from a name):
 *   free       the model itself costs $0 per token (pricing data says so)
 *   free-tier  a paid model the provider lets you use at no cost within
 *              published rate limits
 *   local      runs on the user's own machine / LAN
 *
 * Sources, in order:
 *   1. LIVE pricing from a provider API or models.dev (`cost` + `costSource` on
 *      the catalog entry, see model-catalog-reference.ts) → "free" when 0/0;
 *      plus OpenRouter's documented ":free" variant suffix
 *   2. FREE_TIER_TABLE below — a small, hand-verified table with a source URL
 *      and a "last verified" date per provider → "free-tier"
 *   3. a local endpoint → "local"
 *
 * A $0 cost on a provider whose pricing we do NOT source (subscription plans,
 * custom endpoints, providers with unpublished rates) means "not metered
 * here", not "free", and is never badged.
 */

export type FreeKind = "free" | "free-tier" | "local";

export type FreeInfo = {
  kind: FreeKind;
  /** Short human note for the tooltip (limits, conditions). */
  note: string;
  /** Where the claim comes from (URL or data source). */
  source: string;
  /** ISO date the claim was last checked by hand; absent for live pricing data. */
  verified?: string;
};

export type FreeTierEntry = {
  /** Display label for the provider header / connect row. */
  label: string;
  note: string;
  source: string;
  /** ISO date this row was last checked against `source`. */
  verified: string;
  /** Where a beginner gets a key. */
  keyUrl: string;
  /** Which of the provider's chat models the free tier covers. */
  covers: (modelId: string) => boolean;
};

/** Gemini API models whose Free Tier column reads "Free of charge". */
const GOOGLE_FREE_TIER_IDS: ReadonlySet<string> = new Set([
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
]);

/** Chat models in Groq's "Free Plan Limits" table (the rest of the table is audio / guard models). */
const GROQ_FREE_PLAN_IDS: ReadonlySet<string> = new Set([
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
]);

/**
 * Providers with a standing free allowance on paid models.
 *
 * Keep this table small and re-verify before editing: every row must cite the
 * provider's own page. Deliberately NOT listed (checked 2026-10-01):
 *   - cerebras: only a 30-day, $5 trial credit — not a free tier
 *   - mistral: free "Experiment" plan could not be confirmed from a live doc page
 */
export const FREE_TIER_TABLE: Readonly<Record<string, FreeTierEntry>> = {
  google: {
    label: "Free tier",
    note: "Google AI Studio free tier: no charge within daily rate limits; prompts may be used to improve Google products.",
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    verified: "2026-10-01",
    keyUrl: "https://aistudio.google.com/apikey",
    // Latest-aliases point at the current Flash / Flash-Lite, both free-tier models.
    covers: (id) =>
      GOOGLE_FREE_TIER_IDS.has(id) ||
      id === "gemini-flash-latest" ||
      id === "gemini-flash-lite-latest" ||
      id.startsWith("gemma-"),
  },
  groq: {
    label: "Free tier",
    note: "Groq free plan: no charge within per-model rate limits (30 requests/min, 1K requests/day).",
    source: "https://console.groq.com/docs/rate-limits",
    verified: "2026-10-01",
    keyUrl: "https://console.groq.com/keys",
    covers: (id) => GROQ_FREE_PLAN_IDS.has(id),
  },
};

/** Provider-level notes for providers that carry $0-priced models. */
const FREE_MODEL_PROVIDER_NOTES: Readonly<
  Record<string, { note: string; source: string; verified: string; keyUrl: string }>
> = {
  openrouter: {
    note: "Free model variants: 20 requests/min, 50 requests/day (1,000/day once you have bought 10 credits).",
    source: "https://openrouter.ai/docs/api-reference/limits",
    verified: "2026-10-01",
    keyUrl: "https://openrouter.ai/keys",
  },
  opencode: {
    note: "Free on OpenCode Zen for a limited time; a Zen account and API key are still required.",
    source: "https://opencode.ai/docs/zen/",
    verified: "2026-10-01",
    keyUrl: "https://opencode.ai/auth",
  },
};

/**
 * Providers whose $0 catalog cost is real pricing data (models.dev or the
 * provider's API), so 0/0 can be trusted to mean "free".
 */
const PRICED_PROVIDERS: ReadonlySet<string> = new Set([
  "openrouter",
  "opencode",
  "google",
  "google-vertex",
  "openai",
  "anthropic",
  "groq",
  "mistral",
  "xai",
  "cerebras",
]);

/** Providers that run on the user's own hardware by definition. */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama"]);

export type FreeModelInput = {
  provider: string;
  id: string;
  cost?: { input: number; output: number };
  /** Set when `cost` was refreshed from a live source ("openrouter-api", "models.dev", …). */
  costSource?: string;
  /** The provider endpoint is on this machine / LAN. */
  local?: boolean;
};

const PRICING_SOURCE_LABEL: Readonly<Record<string, string>> = {
  "openrouter-api": "OpenRouter models API (pricing 0)",
  "models.dev": "models.dev pricing (0)",
  "provider-api": "models.dev pricing (0), id confirmed by the provider API",
};

export function classifyModelFree(m: FreeModelInput): FreeInfo | null {
  const provider = m.provider.trim().toLowerCase();
  if (m.local || LOCAL_PROVIDERS.has(provider)) {
    return {
      kind: "local",
      note: "Runs on your own hardware — no per-token cost.",
      source: "local endpoint",
    };
  }
  // Only live pricing counts: the registry's bundled prices are a build-time
  // snapshot and a model that was free then may be paid now.
  const zero =
    Boolean(m.costSource) && m.cost !== undefined && m.cost.input === 0 && m.cost.output === 0;
  // OpenRouter documents the ":free" suffix as its zero-cost variant marker.
  const openRouterFree = provider === "openrouter" && m.id.toLowerCase().endsWith(":free");
  if ((zero && PRICED_PROVIDERS.has(provider)) || openRouterFree) {
    const extra = FREE_MODEL_PROVIDER_NOTES[provider];
    return {
      kind: "free",
      note: extra?.note ?? "Priced at $0 per token.",
      source:
        zero && m.costSource
          ? (PRICING_SOURCE_LABEL[m.costSource] ?? m.costSource)
          : (extra?.source ?? "provider documentation"),
      ...(extra ? { verified: extra.verified } : {}),
    };
  }
  const tier = FREE_TIER_TABLE[provider];
  if (tier?.covers(m.id)) {
    return { kind: "free-tier", note: tier.note, source: tier.source, verified: tier.verified };
  }
  return null;
}

export type ProviderFreeInfo = {
  kind: FreeKind;
  /** Chip text: "Free tier", "Free models", "Local". */
  label: string;
  note: string;
  source: string;
  verified?: string;
  /** Where to get a key (absent for local providers). */
  keyUrl?: string;
  /** How many of the provider's listed models are badged. */
  count: number;
};

/** Provider-level badge, derived from its models' classifications. */
export function classifyProviderFree(
  provider: string,
  models: Array<FreeInfo | null | undefined>,
): ProviderFreeInfo | null {
  const id = provider.trim().toLowerCase();
  const badged = models.filter((m): m is FreeInfo => Boolean(m));
  if (badged.length === 0) return null;
  if (badged.every((m) => m.kind === "local")) {
    return {
      kind: "local",
      label: "Local",
      note: "Runs on your own hardware — no per-token cost.",
      source: "local endpoint",
      count: badged.length,
    };
  }
  const tier = FREE_TIER_TABLE[id];
  if (tier && badged.some((m) => m.kind === "free-tier")) {
    return {
      kind: "free-tier",
      label: tier.label,
      note: tier.note,
      source: tier.source,
      verified: tier.verified,
      keyUrl: tier.keyUrl,
      count: badged.length,
    };
  }
  const free = badged.filter((m) => m.kind === "free");
  if (free.length === 0) return null;
  const extra = FREE_MODEL_PROVIDER_NOTES[id];
  return {
    kind: "free",
    label: free.length === models.length ? "Free" : "Free models",
    note:
      extra?.note ?? `${free.length} model${free.length === 1 ? "" : "s"} priced at $0 per token.`,
    source: extra?.source ?? free[0].source,
    ...(extra ? { verified: extra.verified, keyUrl: extra.keyUrl } : {}),
    count: free.length,
  };
}
