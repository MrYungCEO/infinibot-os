import type { InfinibotConfig } from "../config/config.js";

// ── Types ────────────────────────────────────────────

export interface ProviderSubscription {
  provider: string;
  plan: string;
  active: boolean;
  monthlyBudgetUsd?: number;
  rateLimit?: {
    requestsPerMinute?: number;
    tokensPerDay?: number;
  };
  cliTool?: string;
  models: string[];
  tier: 1 | 2 | 3 | 4;
}

// ── Default Subscriptions ────────────────────────────

const DEFAULT_SUBSCRIPTIONS: ProviderSubscription[] = [
  {
    provider: "anthropic",
    plan: "pro",
    active: true,
    cliTool: "claude-code",
    models: ["claude-opus-4-0520", "claude-sonnet-4-20250514", "claude-haiku-3-5"],
    tier: 1,
  },
  {
    provider: "google",
    plan: "advanced",
    active: true,
    cliTool: "gemini-cli",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    tier: 2,
  },
  {
    provider: "openai",
    plan: "api-only",
    active: false,
    models: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
    tier: 2,
  },
  {
    provider: "ollama",
    plan: "free",
    active: true,
    cliTool: "ollama",
    monthlyBudgetUsd: 0,
    models: [],
    tier: 4,
  },
];

// ── Registry ─────────────────────────────────────────

export function getActiveSubscriptions(config?: InfinibotConfig): ProviderSubscription[] {
  const merged = mergeWithConfig(config);
  return merged.filter((s) => s.active);
}

export function getSubscriptionForProvider(
  provider: string,
  config?: InfinibotConfig,
): ProviderSubscription | undefined {
  const merged = mergeWithConfig(config);
  return merged.find((s) => s.provider === provider && s.active);
}

export function getAllSubscriptions(config?: InfinibotConfig): ProviderSubscription[] {
  return mergeWithConfig(config);
}

// ── Config Merge ─────────────────────────────────────

function mergeWithConfig(config?: InfinibotConfig): ProviderSubscription[] {
  const budgetConfig = (config as any)?.budget;
  const configSubs: any[] | undefined = budgetConfig?.subscriptions;
  if (!configSubs || !Array.isArray(configSubs) || configSubs.length === 0) {
    // Apply ollama config if present
    const subs = [...DEFAULT_SUBSCRIPTIONS];
    if (budgetConfig?.ollama?.enabled !== undefined || budgetConfig?.ollama?.models) {
      const ollamaIdx = subs.findIndex((s) => s.provider === "ollama");
      if (ollamaIdx >= 0) {
        const ollama = subs[ollamaIdx];
        subs[ollamaIdx] = {
          ...ollama,
          active: budgetConfig.ollama.enabled !== false,
          models: budgetConfig.ollama.models ?? ollama.models,
        };
      }
    }
    return subs;
  }

  // Merge config overrides onto defaults
  const result = [...DEFAULT_SUBSCRIPTIONS];
  for (const override of configSubs) {
    if (!override.provider) continue;
    const idx = result.findIndex((s) => s.provider === override.provider);
    if (idx >= 0) {
      result[idx] = {
        ...result[idx],
        ...(override.plan !== undefined && { plan: override.plan }),
        ...(override.active !== undefined && { active: override.active }),
        ...(override.monthlyBudgetUsd !== undefined && { monthlyBudgetUsd: override.monthlyBudgetUsd }),
        ...(override.cliTool !== undefined && { cliTool: override.cliTool }),
        ...(override.tier !== undefined && { tier: override.tier as 1 | 2 | 3 | 4 }),
      };
    } else {
      // Add new subscription from config
      result.push({
        provider: override.provider,
        plan: override.plan ?? "api-only",
        active: override.active !== false,
        monthlyBudgetUsd: override.monthlyBudgetUsd,
        cliTool: override.cliTool,
        models: override.models ?? [],
        tier: (override.tier as 1 | 2 | 3 | 4) ?? 3,
      });
    }
  }

  return result;
}
