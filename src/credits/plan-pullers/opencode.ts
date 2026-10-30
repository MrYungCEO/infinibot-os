/**
 * OpenCode plan-usage puller.
 *
 * OpenCode has no first-party HTTP usage API, but its CLI ships an
 * `opencode stats` command that reports real cost + token totals. We reuse the
 * shared CLI prober (`probeOpencodeCli`) and fall back to the local-ledger
 * estimate when the binary is missing or the output can't be parsed.
 * See docs/research/provider-plans.md §4.
 */
import type { ProviderPlanConfig } from "../plan-config.js";
import type { PlanDef } from "../plans/index.js";
import { cliBackedUsage, probeOpencodeCli } from "./cli.js";
import type { PlanPuller, ProviderPlanUsage } from "./types.js";

export const opencodePuller: PlanPuller = {
  provider: "opencode",
  async fetchPlanUsage(
    cfg: ProviderPlanConfig,
    _planDef: PlanDef | undefined,
  ): Promise<ProviderPlanUsage> {
    return cliBackedUsage(cfg, probeOpencodeCli());
  },
};
