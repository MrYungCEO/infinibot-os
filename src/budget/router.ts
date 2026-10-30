import type { InfinibotConfig } from "../config/config.js";
import { loadProviderUsageSummary } from "../infra/provider-usage.load.js";
import type { ProviderUsageSnapshot } from "../infra/provider-usage.types.js";
import { scoreTaskComplexity } from "./complexity.js";
import { getBudgetStore } from "./store.js";
import { getActiveSubscriptions, type ProviderSubscription } from "./subscriptions.js";

// ── Types ────────────────────────────────────────────

export interface DelegationDecision {
  provider: string;
  model: string;
  cliTool?: string;
  agentId?: string;
  tier: number;
  reason: string;
  budgetRemaining: number;
  usagePercent: number;
}

export interface RouteTaskParams {
  title?: string;
  description?: string;
  taskType?: string;
  preferredProvider?: string;
  forceLocal?: boolean;
}

// ── Agent mapping ────────────────────────────────────

const PROVIDER_AGENT_MAP: Record<string, string> = {
  anthropic: "coder-claude",
  google: "coder-gemini",
  openai: "coder",
  ollama: "coder",
};

const USAGE_PROVIDER_MAP: Record<string, string> = {
  anthropic: "anthropic",
  google: "google-gemini-cli",
};

// ── Router ───────────────────────────────────────────

export async function routeTask(
  params: RouteTaskParams,
  config?: InfinibotConfig,
): Promise<DelegationDecision> {
  // 1. Score task complexity
  const complexity = scoreTaskComplexity({
    title: params.title,
    description: params.description,
    taskType: params.taskType,
  });

  // 2. Force local → Ollama
  if (params.forceLocal) {
    return {
      provider: "ollama",
      model: "llama3",
      cliTool: "ollama",
      agentId: "coder",
      tier: 4,
      reason: "forceLocal requested — using Ollama",
      budgetRemaining: Infinity,
      usagePercent: 0,
    };
  }

  // 3. Fetch live provider usage (best-effort)
  let providerSnapshots: ProviderUsageSnapshot[] = [];
  try {
    const summary = await loadProviderUsageSummary({ timeoutMs: 3000 });
    providerSnapshots = summary.providers;
  } catch {
    // Continue without live usage data
  }

  // 4. Get subscriptions and budget info
  const subscriptions = getActiveSubscriptions(config);
  const suggestedTier = complexity.suggestedTier;

  // 5. Try to get budget store (may not be initialized)
  let budgetStore: ReturnType<typeof getBudgetStore> | null = null;
  try {
    budgetStore = getBudgetStore();
  } catch {
    // Store not initialized yet
  }

  // 6. Build candidates
  const candidates: Array<{
    sub: ProviderSubscription;
    usagePercent: number;
    budgetRemaining: number;
    tierDistance: number;
    score: number;
  }> = [];

  for (const sub of subscriptions) {
    if (!sub.active) continue;

    // Get live usage percent for this provider
    const usageProviderId = USAGE_PROVIDER_MAP[sub.provider];
    const snapshot = usageProviderId
      ? providerSnapshots.find((s) => s.provider === usageProviderId)
      : undefined;
    const maxUsagePercent = snapshot?.windows?.length
      ? Math.max(...snapshot.windows.map((w) => w.usedPercent))
      : 0;

    // Get budget remaining
    let budgetRemaining = Infinity;
    if (sub.monthlyBudgetUsd !== undefined && sub.monthlyBudgetUsd > 0 && budgetStore) {
      budgetRemaining = budgetStore.getBudgetRemaining(sub.provider, sub.monthlyBudgetUsd);
    }

    // Skip if over 80% usage on subscription
    if (maxUsagePercent >= 80 && sub.provider !== "ollama") {
      continue;
    }

    // Skip if no budget remaining (for API providers)
    if (budgetRemaining <= 0 && sub.provider !== "ollama") {
      continue;
    }

    // Calculate fit score (lower = better)
    const tierDistance = Math.abs(sub.tier - suggestedTier);
    // Prefer providers that match tier, have low usage, and high budget
    let score = tierDistance * 100;
    score += maxUsagePercent; // prefer lower usage
    if (budgetRemaining !== Infinity && budgetRemaining < 10) {
      score += 50; // penalize low budget
    }

    // Boost preferred provider
    if (params.preferredProvider && sub.provider === params.preferredProvider) {
      score -= 200;
    }

    candidates.push({
      sub,
      usagePercent: maxUsagePercent,
      budgetRemaining,
      tierDistance,
      score,
    });
  }

  // Sort by score (ascending)
  candidates.sort((a, b) => a.score - b.score);

  // 7. Select best candidate
  if (candidates.length > 0) {
    const best = candidates[0];
    const model = selectModel(best.sub, suggestedTier);
    return {
      provider: best.sub.provider,
      model,
      cliTool: best.sub.cliTool,
      agentId: PROVIDER_AGENT_MAP[best.sub.provider],
      tier: best.sub.tier,
      reason: buildReason(best.sub, complexity.level, best.usagePercent, best.budgetRemaining),
      budgetRemaining: best.budgetRemaining === Infinity ? -1 : best.budgetRemaining,
      usagePercent: best.usagePercent,
    };
  }

  // 8. Fallback to Ollama
  const ollamaSub = subscriptions.find((s) => s.provider === "ollama");
  return {
    provider: "ollama",
    model: ollamaSub?.models?.[0] ?? "llama3",
    cliTool: "ollama",
    agentId: "coder",
    tier: 4,
    reason: "All providers exhausted or over budget — falling back to Ollama",
    budgetRemaining: Infinity,
    usagePercent: 0,
  };
}

// ── Helpers ──────────────────────────────────────────

function selectModel(sub: ProviderSubscription, suggestedTier: number): string {
  if (sub.models.length === 0) return "unknown";
  if (sub.models.length === 1) return sub.models[0];

  // For tier 1 tasks, pick the first (best) model; for lower tiers pick cheaper options
  if (suggestedTier <= 1) return sub.models[0];
  if (suggestedTier <= 2) return sub.models[Math.min(1, sub.models.length - 1)];
  return sub.models[sub.models.length - 1]; // cheapest
}

function buildReason(
  sub: ProviderSubscription,
  complexityLevel: string,
  usagePercent: number,
  budgetRemaining: number,
): string {
  const parts: string[] = [];
  parts.push(`Task complexity: ${complexityLevel}`);
  parts.push(`Provider: ${sub.provider} (${sub.plan}, tier ${sub.tier})`);
  if (usagePercent > 0) parts.push(`Usage: ${usagePercent.toFixed(0)}%`);
  if (budgetRemaining !== Infinity && budgetRemaining >= 0) {
    parts.push(`Budget remaining: $${budgetRemaining.toFixed(2)}`);
  }
  if (sub.cliTool) parts.push(`CLI: ${sub.cliTool}`);
  return parts.join(" | ");
}
