/**
 * Anthropic plan-usage puller.
 *
 * Uses the org **Admin API** when an `sk-ant-admin-…` key is configured:
 *   - cost (USD):  GET https://api.anthropic.com/v1/organizations/cost_report
 *   - tokens:      GET https://api.anthropic.com/v1/organizations/usage_report/messages
 * Auth: `x-api-key: <admin key>`, `anthropic-version: 2023-06-01`.
 * Admin API is org-only and rejects normal `sk-ant-api…` keys.
 * See docs/research/provider-plans.md §1.
 *
 * Any non-admin key, missing key, or error falls back to a local-ledger
 * estimate so the UI always has a number.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ProviderPlanConfig } from "../plan-config.js";
import type { PlanDef } from "../plans/index.js";
import { currentMonthPeriod, estimatedUsage, round2 } from "./estimate.js";
import { fetchJson, sumNumericField } from "./http.js";
import { cliBackedUsage, probeClaudeCli } from "./cli.js";
import type { PlanPuller, ProviderPlanUsage } from "./types.js";

const log = createSubsystemLogger("credits").child("puller.anthropic");
const BASE = "https://api.anthropic.com/v1/organizations";

export const anthropicPuller: PlanPuller = {
  provider: "anthropic",
  async fetchPlanUsage(
    cfg: ProviderPlanConfig,
    planDef: PlanDef | undefined,
  ): Promise<ProviderPlanUsage> {
    const key = cfg.apiKey?.trim();
    // Live numbers require an org Admin key. No key (the common Claude Max/Pro
    // subscription case): detect plan + auth from the claude CLI credentials and
    // estimate numbers from the local ledger.
    if (!key) {
      return cliBackedUsage(cfg, probeClaudeCli());
    }
    if (!key.startsWith("sk-ant-admin")) {
      return estimatedUsage(
        cfg,
        "ok",
        "Configured key is not an Admin key (sk-ant-admin-…); using local estimate.",
      );
    }
    if (planDef && !planDef.hasUsageApi) {
      return estimatedUsage(cfg, "ok", "Plan has no usage API; using local estimate.");
    }

    const { start, end } = currentMonthPeriod();
    const startingAt = new Date(start).toISOString();
    const headers = {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };

    try {
      const cost = await fetchJson(
        `${BASE}/cost_report?starting_at=${encodeURIComponent(startingAt)}&bucket_width=1d`,
        { headers },
      );
      const usedUsd = round2(sumNumericField(cost, "amount"));

      let usedTokens = 0;
      try {
        const usage = await fetchJson(
          `${BASE}/usage_report/messages?starting_at=${encodeURIComponent(startingAt)}&bucket_width=1d`,
          { headers },
        );
        usedTokens =
          sumNumericField(usage, "input_tokens") +
          sumNumericField(usage, "output_tokens") +
          sumNumericField(usage, "uncached_input_tokens") +
          sumNumericField(usage, "cache_read_input_tokens");
      } catch (e) {
        log.warn("usage_report fetch failed; cost-only", { err: String(e) });
      }

      const limitUsd = cfg.monthlyBudgetUsd ?? planDef?.monthlyPriceUsd;
      return {
        provider: "anthropic",
        plan: cfg.plan,
        periodStart: start,
        periodEnd: end,
        usedUsd,
        usedTokens: usedTokens || undefined,
        limitUsd,
        remainingUsd: limitUsd !== undefined ? round2(Math.max(0, limitUsd - usedUsd)) : undefined,
        source: "api",
        status: "ok",
        fetchedAt: Date.now(),
      };
    } catch (e) {
      log.warn("cost_report fetch failed; falling back to estimate", { err: String(e) });
      return estimatedUsage(cfg, "error", `Admin API error: ${String(e)}`);
    }
  },
};
