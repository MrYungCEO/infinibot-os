/**
 * Plan service — the facade the gateway RPCs call.
 *
 * Ties together: the plan registry (static metadata), the per-provider plan
 * config (`provider-plans.json`), the pullers (live/estimated usage), and the
 * sqlite usage cache (`provider_plan_usage`). Reads come from the cache; the
 * refresh loop and explicit `refresh` calls populate it.
 */
import { getCreditStore } from "./store.js";
import {
  getProviderPlanConfig,
  listProviderPlanConfigs,
  redactPlanConfig,
  type ProviderPlanConfig,
} from "./plan-config.js";
import { PLAN_PROVIDERS, getPlanDef, listPlansForProvider, type PlanDef } from "./plans/index.js";
import { pullPlanUsage, type ProviderPlanUsage } from "./plan-pullers/index.js";
import { estimatedUsage } from "./plan-pullers/estimate.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("credits").child("plan-service");

export interface ProviderPlanView {
  provider: string;
  configured: boolean;
  /** Redacted config (no raw secrets) — present even for unconfigured providers (defaults). */
  config: ReturnType<typeof redactPlanConfig>;
  planDef?: PlanDef;
  availablePlans: Array<Pick<PlanDef, "id" | "label" | "kind" | "monthlyPriceUsd" | "hasUsageApi">>;
  usage: ProviderPlanUsage;
}

function defaultConfigFor(provider: string): ProviderPlanConfig {
  return {
    provider,
    plan: getPlanDef(provider, undefined)?.id ?? "api",
    updatedAt: 0,
  };
}

/** A view of one provider: config + registry + last-known (cached) usage. */
export function getProviderPlanView(provider: string): ProviderPlanView {
  const stored = getProviderPlanConfig(provider);
  const cfg = stored ?? defaultConfigFor(provider);
  const cached = getCreditStore().getPlanUsage(provider);
  // If nothing cached yet, synthesize an estimate so the UI always has a number.
  const usage = cached ?? estimatedUsage(cfg, "ok", "Not yet refreshed; local estimate.");
  return {
    provider,
    configured: Boolean(stored),
    config: redactPlanConfig(cfg),
    planDef: getPlanDef(provider, cfg.plan),
    availablePlans: listPlansForProvider(provider).map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      monthlyPriceUsd: p.monthlyPriceUsd,
      hasUsageApi: p.hasUsageApi,
    })),
    usage,
  };
}

/** All providers we track (registry order), merged with config + cached usage. */
export function listProviderPlans(): ProviderPlanView[] {
  // Union of registry providers and any configured ones (configured ones are a
  // subset of registry today, but keep it robust).
  const providers = new Set<string>([
    ...PLAN_PROVIDERS,
    ...listProviderPlanConfigs().map((c) => c.provider),
  ]);
  return [...providers].map((p) => getProviderPlanView(p));
}

/** Pull live/estimated usage for one provider and cache it. */
export async function refreshProviderPlan(provider: string): Promise<ProviderPlanUsage> {
  const cfg = getProviderPlanConfig(provider) ?? defaultConfigFor(provider);
  const usage = await pullPlanUsage(cfg);
  try {
    getCreditStore().upsertPlanUsage(usage);
  } catch (e) {
    log.warn("failed to cache plan usage", { provider, err: String(e) });
  }
  return usage;
}

/**
 * Refresh every known provider. Best-effort and isolated: one provider's
 * failure (or a killed fetch) never aborts the others. Returns per-provider
 * results for logging.
 *
 * Covers the UNION of explicitly-configured providers AND every PLAN_PROVIDERS
 * entry — so CLI/OAuth users who have NO `provider-plans.json` still get their
 * plan + auth + usage auto-detected each tick via the CLI pullers (claude,
 * codex, opencode, gemini). Without this, an empty config means the interval
 * sync would do nothing for exactly the users the CLI detection targets.
 */
export async function refreshAllProviderPlans(): Promise<ProviderPlanUsage[]> {
  const providers = new Set<string>([
    ...listProviderPlanConfigs().map((c) => c.provider),
    ...PLAN_PROVIDERS,
  ]);
  const out: ProviderPlanUsage[] = [];
  for (const provider of providers) {
    try {
      out.push(await refreshProviderPlan(provider));
    } catch (e) {
      log.warn("refresh failed", { provider, err: String(e) });
    }
  }
  return out;
}

/**
 * One-shot connection test. Runs the puller and reports whether real
 * (`source:"api"`) numbers came back, without permanently changing UI state
 * differently from a refresh (it does cache the fresh result).
 */
export async function testProviderConnection(provider: string): Promise<{
  ok: boolean;
  source: ProviderPlanUsage["source"];
  status: ProviderPlanUsage["status"];
  message?: string;
  usedUsd?: number;
}> {
  const usage = await refreshProviderPlan(provider);
  return {
    ok: usage.source === "api" && usage.status === "ok",
    source: usage.source,
    status: usage.status,
    message:
      usage.message ??
      (usage.source === "api"
        ? "Live usage retrieved from provider API."
        : "No live API; using local estimate."),
    usedUsd: usage.usedUsd,
  };
}
