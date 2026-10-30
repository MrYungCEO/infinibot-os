/**
 * OpenCode plan definitions.
 * Sources & caveats: docs/research/provider-plans.md §4.
 *
 * OpenCode is a multi-provider wrapper with no first-party usage API. Plan
 * tracking is per underlying provider; here we expose a single "wrapper" plan
 * whose usage is estimated from the local ledger (grouped by the underlying
 * provider recorded on each run).
 */
import type { PlanDef } from "./types.js";

export const OPENCODE_PLANS: PlanDef[] = [
  {
    id: "api",
    provider: "opencode",
    label: "OpenCode (per-provider)",
    kind: "api",
    hasUsageApi: false,
    notes:
      "Wraps Anthropic/OpenAI/Google/zen/local. No first-party usage API — estimated from local ledger. Configure the underlying provider's plan for live numbers.",
  },
];
