/**
 * OpenAI plan-usage puller.
 *
 * Uses the org **Admin API** when an `sk-admin-…` key is configured:
 *   - cost (USD):  GET https://api.openai.com/v1/organization/costs
 *   - tokens:      GET https://api.openai.com/v1/organization/usage/completions
 * Auth: `Authorization: Bearer <admin key>`. Admin keys can't call normal
 * endpoints and vice-versa. Query uses `start_time`/`end_time` in Unix seconds.
 * See docs/research/provider-plans.md §2.
 *
 * Codex ChatGPT Plus/Pro subscriptions have no usage REST → estimated fallback.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ProviderPlanConfig } from "../plan-config.js";
import type { PlanDef } from "../plans/index.js";
import { currentMonthPeriod, estimatedUsage, round2 } from "./estimate.js";
import { fetchJson, sumNumericField } from "./http.js";
import { cliBackedUsage, probeCodexCli } from "./cli.js";
import type { PlanPuller, ProviderPlanUsage } from "./types.js";

const log = createSubsystemLogger("credits").child("puller.openai");
const BASE = "https://api.openai.com/v1/organization";

export const openaiPuller: PlanPuller = {
  provider: "openai",
  async fetchPlanUsage(
    cfg: ProviderPlanConfig,
    planDef: PlanDef | undefined,
  ): Promise<ProviderPlanUsage> {
    const key = cfg.apiKey?.trim();
    // No admin key (the common Codex-subscription case): detect plan + auth from
    // the codex CLI and estimate numbers from the local ledger.
    if (!key) {
      return cliBackedUsage(cfg, probeCodexCli());
    }
    if (!key.startsWith("sk-admin")) {
      return estimatedUsage(
        cfg,
        "ok",
        "Configured key is not an Admin key (sk-admin-…); using local estimate.",
      );
    }
    if (planDef && !planDef.hasUsageApi) {
      return estimatedUsage(cfg, "ok", "Plan has no usage API; using local estimate.");
    }

    const { start, end } = currentMonthPeriod();
    const startTime = Math.floor(start / 1000);
    const endTime = Math.floor(Date.now() / 1000);
    const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json" };

    try {
      const cost = await fetchJson(
        `${BASE}/costs?start_time=${startTime}&end_time=${endTime}&bucket_width=1d`,
        { headers },
      );
      const usedUsd = round2(sumNumericField(cost, "amount"));

      let usedTokens = 0;
      try {
        const usage = await fetchJson(
          `${BASE}/usage/completions?start_time=${startTime}&end_time=${endTime}&bucket_width=1d`,
          { headers },
        );
        usedTokens =
          sumNumericField(usage, "input_tokens") + sumNumericField(usage, "output_tokens");
      } catch (e) {
        log.warn("usage/completions fetch failed; cost-only", { err: String(e) });
      }

      const limitUsd = cfg.monthlyBudgetUsd ?? planDef?.monthlyPriceUsd;
      return {
        provider: "openai",
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
      log.warn("costs fetch failed; falling back to estimate", { err: String(e) });
      return estimatedUsage(cfg, "error", `Admin API error: ${String(e)}`);
    }
  },
};
