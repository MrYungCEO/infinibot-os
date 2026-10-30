import type { NormalizedUsage } from "../../agents/usage.js";
import { normalizeUsage, hasNonzeroUsage, type UsageLike } from "../../agents/usage.js";
import type { InfinibotConfig } from "../../config/config.js";
import { resolveAgentIdFromSessionKey } from "../../config/sessions.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";

/**
 * Record budget usage from an agent run. Fire-and-forget — errors are silently ignored.
 */
export function recordBudgetUsageFromRun(params: {
  usage?: UsageLike | NormalizedUsage | null;
  provider?: string;
  model?: string;
  sessionKey?: string;
  config?: InfinibotConfig;
}): void {
  try {
    const normalized = normalizeUsage(params.usage as UsageLike | undefined);
    if (!hasNonzeroUsage(normalized)) return;

    const provider = params.provider ?? "unknown";
    const model = params.model ?? "unknown";
    const agentId = params.sessionKey
      ? resolveAgentIdFromSessionKey(params.sessionKey) ?? "unknown"
      : "unknown";

    const costConfig = resolveModelCostConfig({
      provider,
      model,
      config: params.config,
    });
    const costUsd = estimateUsageCost({ usage: normalized, cost: costConfig }) ?? 0;

    // Lazy import to avoid circular dependencies and startup cost
    import("../../budget/store.js")
      .then(({ getBudgetStore }) => {
        try {
          const store = getBudgetStore();
          store.recordUsage({
            provider,
            model,
            tokensIn: normalized.input ?? 0,
            tokensOut: normalized.output ?? 0,
            costUsd,
            agentId,
            sessionKey: params.sessionKey,
            timestamp: Date.now(),
          });
        } catch {
          // Budget store not initialized — skip silently
        }
      })
      .catch(() => {
        // Module load failed — skip silently
      });
  } catch {
    // Never throw from a fire-and-forget hook
  }
}
