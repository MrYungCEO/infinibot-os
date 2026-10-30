/**
 * Shared local-ledger estimate helper used as the universal fallback when a
 * provider has no usage API (or its credential is missing). Sums the local
 * `credit_entries` ledger for the current calendar month for a given provider.
 *
 * This is what makes the `(estimated)` numbers possible everywhere — the local
 * per-run cost recording keeps working regardless of whether a puller succeeds.
 */
import { getCreditStore } from "../store.js";
import { getPlanDef } from "../plans/index.js";
import type { ProviderPlanConfig } from "../plan-config.js";
import type { ProviderPlanUsage, PlanUsageStatus } from "./types.js";

/** Start/end of the current calendar month (UTC) — matches subscriptions.ts. */
export function currentMonthPeriod(now = Date.now()): { start: number; end: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
}

/**
 * Sum local ledger spend + tokens for one provider this month. The provider
 * key on ledger rows matches the canonical provider name (e.g. "anthropic").
 * For opencode we sum by `agent_backend` instead since runs are recorded under
 * the underlying provider, not "opencode".
 */
export function localMonthUsage(provider: string): { usd: number; tokens: number } {
  const { start } = currentMonthPeriod();
  const store = getCreditStore();
  const byBackend = provider === "opencode";
  const sql = byBackend
    ? `SELECT COALESCE(SUM(cost_usd),0) AS usd,
              COALESCE(SUM(tokens_in + tokens_out),0) AS tokens
         FROM credit_entries WHERE agent_backend = 'opencode' AND timestamp >= ?`
    : `SELECT COALESCE(SUM(cost_usd),0) AS usd,
              COALESCE(SUM(tokens_in + tokens_out),0) AS tokens
         FROM credit_entries WHERE provider = ? AND timestamp >= ?`;
  const row = (
    byBackend ? store.db.prepare(sql).get(start) : store.db.prepare(sql).get(provider, start)
  ) as { usd: number; tokens: number } | undefined;
  return { usd: Number(row?.usd ?? 0), tokens: Number(row?.tokens ?? 0) };
}

/**
 * Build an `estimated` usage object from the local ledger. The progress-bar
 * denominator comes from (in priority order): manual override budget/cap,
 * else the plan's flat monthly price / included tokens, else undefined.
 */
export function estimatedUsage(
  cfg: ProviderPlanConfig,
  status: PlanUsageStatus = "ok",
  message?: string,
): ProviderPlanUsage {
  const { start, end } = currentMonthPeriod();
  const local = localMonthUsage(cfg.provider);
  const planDef = getPlanDef(cfg.provider, cfg.plan);
  const limitUsd = cfg.monthlyBudgetUsd ?? planDef?.monthlyPriceUsd ?? planDef?.includedUsd;
  const limitTokens = cfg.monthlyTokenCap ?? planDef?.includedTokens;
  return {
    provider: cfg.provider,
    plan: cfg.plan,
    periodStart: start,
    periodEnd: end,
    usedUsd: round2(local.usd),
    usedTokens: local.tokens,
    remainingUsd: limitUsd !== undefined ? round2(Math.max(0, limitUsd - local.usd)) : undefined,
    remainingTokens:
      limitTokens !== undefined ? Math.max(0, limitTokens - local.tokens) : undefined,
    limitUsd,
    limitTokens,
    source: "estimated",
    status,
    message,
    fetchedAt: Date.now(),
  };
}

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
