/**
 * Gateway methods for the token/usage ledger.
 *
 * Web + mobile clients call `credits.summary`, `credits.timeseries`,
 * `credits.recent`, `credits.budgets.*`, etc. via the standard gateway
 * RPC envelope. All reads go through the aggregator's 30s cache so
 * polling the dashboard doesn't hammer SQLite.
 *
 * ──────────────────────────────────────────────────────────────────────
 * NAMING NOTE (UI rename is intentionally NOT mirrored here):
 *
 * The product has no "credits" — usage is BYOK (users bring their own LLM
 * keys / CLI subscriptions) and licensing is via Whop + KinglyVault. The UI
 * surface for this data was renamed to **Tokens & Subscriptions** (the web
 * `/credits` page is now titled that, the nav label is "Tokens", and the
 * reusable component is `<token-usage-breakdown>`).
 *
 * These RPC method names (`credits.*`) are deliberately LEFT UNCHANGED to keep
 * the gateway wire protocol backward-compatible. Renaming them would require a
 * gateway restart and would break every existing consumer (web, mobile,
 * federation peers, MCP, saved workflows). The rename is UI-only by design;
 * `costUsd` and other USD fields are real numbers and also stay as-is.
 * ──────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from "node:crypto";

import {
  budgetStatuses,
  listBudgets,
  invalidateAggregatorCache,
  projectEntries,
  recentEntries,
  sessionEntries,
  summary,
  timeseries,
  topConsumers,
} from "../../credits/aggregator.js";
import { getCreditStore } from "../../credits/store.js";
import { listPricedModels, reloadPricingTable } from "../../credits/pricing.js";
import {
  currentPeriod as currentSubscriptionPeriod,
  listSubscriptions,
  totalActiveCommitmentUsd,
  withPeriod as subscriptionWithPeriod,
  writeSubscriptions,
  type FlatRateSubscription,
} from "../../credits/subscriptions.js";
import { listProviderCursors, syncAll, syncProvider } from "../../credits/sync.js";
import {
  listProviderPlans,
  refreshProviderPlan,
  testProviderConnection,
} from "../../credits/plan-service.js";
import { upsertProviderPlanConfig } from "../../credits/plan-config.js";
import type { BillingPeriod, CreditBudget, TimeseriesBucket } from "../../credits/types.js";
import type { GatewayRequestHandlers } from "./types.js";

const VALID_PERIODS: BillingPeriod[] = ["hour", "day", "week", "month", "all"];
const VALID_BUCKETS: TimeseriesBucket[] = ["minute", "hour", "day", "week"];

function strOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parsePeriod(v: unknown, fallback: BillingPeriod = "month"): BillingPeriod {
  return typeof v === "string" && (VALID_PERIODS as string[]).includes(v)
    ? (v as BillingPeriod)
    : fallback;
}

function parseBucket(v: unknown, fallback: TimeseriesBucket = "day"): TimeseriesBucket {
  return typeof v === "string" && (VALID_BUCKETS as string[]).includes(v)
    ? (v as TimeseriesBucket)
    : fallback;
}

export const creditsHandlers: GatewayRequestHandlers = {
  "credits.summary": async ({ params, respond }) => {
    try {
      const period = parsePeriod(params?.period);
      const filters = (params?.filters as Record<string, unknown> | undefined) ?? {};
      const result = summary({
        period,
        filters: {
          provider: strOrUndefined(filters.provider),
          agentBackend: strOrUndefined(filters.agentBackend),
          projectId: strOrUndefined(filters.projectId),
          sessionKey: strOrUndefined(filters.sessionKey),
          // taskId lets callers roll up cost/tokens for a single run
          // (the CLI credit hook records entries keyed by taskId = runId).
          taskId: strOrUndefined(filters.taskId),
        },
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.timeseries": async ({ params, respond }) => {
    try {
      const bucket = parseBucket(params?.bucket);
      const rangeRaw = (params?.range as { start?: number; end?: number } | undefined) ?? {};
      const end = numOrUndefined(rangeRaw.end) ?? Date.now();
      const start = numOrUndefined(rangeRaw.start) ?? end - 24 * 60 * 60 * 1000;
      const groupBy =
        typeof params?.groupBy === "string" &&
        ["agent_backend", "provider", "model", "project_id"].includes(params.groupBy)
          ? (params.groupBy as "agent_backend" | "provider" | "model" | "project_id")
          : "agent_backend";
      const filters = (params?.filters as Record<string, unknown> | undefined) ?? {};
      const result = timeseries({
        bucket,
        range: { start, end },
        groupBy,
        filters: {
          provider: strOrUndefined(filters.provider),
          agentBackend: strOrUndefined(filters.agentBackend),
          projectId: strOrUndefined(filters.projectId),
          sessionKey: strOrUndefined(filters.sessionKey),
        },
      });
      respond(true, { bucket, range: { start, end }, points: result });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.top": async ({ params, respond }) => {
    try {
      const axis =
        typeof params?.axis === "string" &&
        ["provider", "model", "agent_backend", "project_id", "session_key"].includes(params.axis)
          ? (params.axis as "provider" | "model" | "agent_backend" | "project_id" | "session_key")
          : "provider";
      const period = parsePeriod(params?.period);
      const limit = Math.min(numOrUndefined(params?.limit) ?? 10, 100);
      respond(true, topConsumers({ axis, period, limit }));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.recent": async ({ params, respond }) => {
    try {
      const limit = Math.min(numOrUndefined(params?.limit) ?? 100, 500);
      const cursor = numOrUndefined(params?.cursor);
      const entries = recentEntries(limit, cursor);
      respond(true, {
        entries,
        nextCursor: entries.length > 0 ? entries[entries.length - 1].timestamp : null,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.byProject": async ({ params, respond }) => {
    try {
      const projectId = strOrUndefined(params?.projectId);
      if (!projectId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "projectId required" });
        return;
      }
      const period = parsePeriod(params?.period);
      const entries = projectEntries(projectId);
      const sum = summary({ period, filters: { projectId } });
      respond(true, { projectId, summary: sum, entries });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.bySession": async ({ params, respond }) => {
    try {
      const sessionKey = strOrUndefined(params?.sessionKey);
      if (!sessionKey) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "sessionKey required" });
        return;
      }
      const period = parsePeriod(params?.period, "all");
      const entries = sessionEntries(sessionKey);
      const sum = summary({ period, filters: { sessionKey } });
      respond(true, { sessionKey, summary: sum, entries });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.providers": async ({ respond }) => {
    try {
      const cursors = listProviderCursors();
      respond(true, { providers: cursors, pricedModels: listPricedModels() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Plan-aware provider usage ─────────────────────────────────
  // These augment (do NOT replace) the legacy `credits.providers` sync-cursor
  // endpoint above. They surface the user's actual plan + live/estimated usage.

  "credits.providers.list": async ({ respond }) => {
    try {
      respond(true, { providers: listProviderPlans() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.providers.upsert": async ({ params, respond }) => {
    try {
      const provider = strOrUndefined(params?.provider);
      if (!provider) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "provider required" });
        return;
      }
      // Only forward fields the client actually sent so secrets aren't wiped on
      // a plan-only save (undefined = leave untouched; "" = explicit clear).
      const cfg = upsertProviderPlanConfig({
        provider,
        plan: typeof params?.plan === "string" ? params.plan : undefined,
        auto: typeof params?.auto === "boolean" ? params.auto : undefined,
        apiKey: typeof params?.apiKey === "string" ? params.apiKey : undefined,
        orgId: typeof params?.orgId === "string" ? params.orgId : undefined,
        oauthToken: typeof params?.oauthToken === "string" ? params.oauthToken : undefined,
        monthlyBudgetUsd:
          typeof params?.monthlyBudgetUsd === "number" ? params.monthlyBudgetUsd : undefined,
        monthlyTokenCap:
          typeof params?.monthlyTokenCap === "number" ? params.monthlyTokenCap : undefined,
      });
      // Pull fresh usage immediately so the UI reflects the new plan/creds.
      const usage = await refreshProviderPlan(provider);
      respond(true, { provider: cfg.provider, plan: cfg.plan, usage });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.providers.refresh": async ({ params, respond }) => {
    try {
      const provider = strOrUndefined(params?.provider);
      if (!provider) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "provider required" });
        return;
      }
      const usage = await refreshProviderPlan(provider);
      invalidateAggregatorCache();
      respond(true, { provider, usage });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.providers.testConnection": async ({ params, respond }) => {
    try {
      const provider = strOrUndefined(params?.provider);
      if (!provider) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "provider required" });
        return;
      }
      respond(true, await testProviderConnection(provider));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.sync": async ({ params, respond }) => {
    try {
      const provider = strOrUndefined(params?.provider);
      if (provider) {
        const result = await syncProvider(provider as Parameters<typeof syncProvider>[0]);
        invalidateAggregatorCache();
        respond(true, result);
      } else {
        const results = await syncAll();
        invalidateAggregatorCache();
        respond(true, { results });
      }
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.pricing.reload": async ({ respond }) => {
    try {
      reloadPricingTable();
      respond(true, { models: listPricedModels() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.budgets.list": async ({ respond }) => {
    try {
      respond(true, { budgets: listBudgets(), statuses: budgetStatuses() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.budgets.upsert": async ({ params, respond }) => {
    try {
      const now = Date.now();
      const budget: CreditBudget = {
        id: strOrUndefined(params?.id) ?? `bud_${now.toString(36)}_${randomUUID().slice(0, 6)}`,
        name: strOrUndefined(params?.name) ?? "Untitled budget",
        scopeAxis:
          typeof params?.scopeAxis === "string" &&
          ["provider", "agent_backend", "project_id", "session_key", "all"].includes(
            params.scopeAxis,
          )
            ? (params.scopeAxis as CreditBudget["scopeAxis"])
            : "all",
        scopeValue: strOrUndefined(params?.scopeValue),
        monthlyLimitUsd: numOrUndefined(params?.monthlyLimitUsd) ?? 0,
        warnThresholdPct: numOrUndefined(params?.warnThresholdPct) ?? 80,
        hardThresholdPct: numOrUndefined(params?.hardThresholdPct) ?? 100,
        blockOnHard: params?.blockOnHard === true,
        createdAt: numOrUndefined(params?.createdAt) ?? now,
        updatedAt: now,
      };
      getCreditStore().upsertBudget(budget);
      invalidateAggregatorCache();
      respond(true, { budget });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.budgets.delete": async ({ params, respond }) => {
    try {
      const id = strOrUndefined(params?.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      getCreditStore().deleteBudget(id);
      invalidateAggregatorCache();
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.subscriptions.list": async ({ respond }) => {
    try {
      const subs = listSubscriptions().map((s) => subscriptionWithPeriod(s));
      respond(true, {
        subscriptions: subs,
        totalActiveMonthlyUsd: totalActiveCommitmentUsd(),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.subscriptions.upsert": async ({ params, respond }) => {
    try {
      const existing = listSubscriptions();
      const id = strOrUndefined(params?.id);
      const incoming: FlatRateSubscription = {
        id: id ?? `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        provider: strOrUndefined(params?.provider) ?? "unknown",
        plan: strOrUndefined(params?.plan) ?? "subscription",
        monthlyAmountUsd: numOrUndefined(params?.monthlyAmountUsd) ?? 0,
        billingAnchor: strOrUndefined(params?.billingAnchor) ?? new Date().toISOString(),
        isActive: params?.isActive !== false,
        notes: strOrUndefined(params?.notes),
      };
      const idx = existing.findIndex((s) => s.id === incoming.id);
      const next = [...existing];
      if (idx >= 0) next[idx] = incoming;
      else next.push(incoming);
      writeSubscriptions(next);
      respond(true, { subscription: subscriptionWithPeriod(incoming) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "credits.subscriptions.delete": async ({ params, respond }) => {
    try {
      const id = strOrUndefined(params?.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const next = listSubscriptions().filter((s) => s.id !== id);
      writeSubscriptions(next);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Single endpoint backing the web + mobile credits dashboards. Returns
   * subscriptions, current-month usage, per-provider and per-model breakdowns,
   * 7d/30d daily-cost trends, and top sessions — so each client can render
   * the whole view with one round-trip.
   */
  "credits.dashboard": async ({ respond }) => {
    try {
      const now = Date.now();
      const subPeriod = currentSubscriptionPeriod(now);

      // Usage summary aligned to the calendar month (matches subscription period).
      const monthSummary = summary({ period: "month" });

      // 7d / 30d trends.
      const daily7d = timeseries({
        bucket: "day",
        range: { start: now - 7 * 24 * 60 * 60 * 1000, end: now },
        groupBy: "agent_backend",
      });
      const daily30d = timeseries({
        bucket: "day",
        range: { start: now - 30 * 24 * 60 * 60 * 1000, end: now },
        groupBy: "agent_backend",
      });

      // Top sessions by spend (this month).
      const topSessions = topConsumers({ axis: "session_key", period: "month", limit: 10 }).map(
        (s) => ({ sessionKey: s.key, costUsd: s.costUsd, tokens: s.tokens, requests: s.requests }),
      );

      const subscriptions = listSubscriptions().map((s) => subscriptionWithPeriod(s, now));
      const totalSubscriptionUsd = subscriptions
        .filter((s) => s.isActive)
        .reduce((sum, s) => sum + s.period.periodCostUsd, 0);

      // Plan-aware usage per provider — pulled from each provider's plan API
      // when available, else estimated from the local ledger (badged in the UI).
      const planUsage = listProviderPlans().map((p) => ({
        provider: p.provider,
        plan: p.config.plan,
        auto: p.config.auto ?? true,
        detectedPlan: p.usage.detectedPlan,
        configured: p.configured,
        planLabel: p.planDef?.label,
        hasUsageApi: p.planDef?.hasUsageApi ?? false,
        usedUsd: p.usage.usedUsd,
        usedTokens: p.usage.usedTokens,
        limitUsd: p.usage.limitUsd,
        remainingUsd: p.usage.remainingUsd,
        source: p.usage.source,
        status: p.usage.status,
        message: p.usage.message,
        fetchedAt: p.usage.fetchedAt,
      }));

      respond(true, {
        period: {
          start: subPeriod.start,
          end: subPeriod.end,
          label: "current_month",
        },
        subscriptions,
        usageByProvider: monthSummary.byProvider.map((p) => ({
          provider: p.provider,
          inputTokens: p.tokensIn,
          outputTokens: p.tokensOut,
          cacheReadTokens: p.cacheReadTokens,
          cacheWriteTokens: p.cacheWriteTokens,
          costUsd: p.costUsd,
          requests: p.requests,
        })),
        usageByBackend: monthSummary.byBackend.map((b) => ({
          backend: b.agentBackend,
          inputTokens: b.tokensIn,
          outputTokens: b.tokensOut,
          costUsd: b.costUsd,
          requests: b.requests,
        })),
        usageByModel: monthSummary.byModel.map((m) => ({
          model: m.model,
          provider: m.provider,
          tokens: m.tokens,
          costUsd: m.costUsd,
          requests: m.requests,
        })),
        usageTotals: {
          tokensIn: monthSummary.totalTokensIn,
          tokensOut: monthSummary.totalTokensOut,
          cacheReadTokens: monthSummary.totalCacheReadTokens,
          cacheWriteTokens: monthSummary.totalCacheWriteTokens,
          costUsd: monthSummary.totalCostUsd,
          requests: monthSummary.totalRequests,
          autonomousPercent: monthSummary.autonomousPercent,
        },
        totalSubscriptionUsd,
        totalUsageUsd: monthSummary.totalCostUsd,
        totalMonthlyCostUsd: totalSubscriptionUsd + monthSummary.totalCostUsd,
        planUsage,
        trends: {
          daily7d: daily7d.map((p) => ({ bucketStart: p.bucketStart, series: p.series })),
          daily30d: daily30d.map((p) => ({ bucketStart: p.bucketStart, series: p.series })),
        },
        topSessions,
        generatedAt: now,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
