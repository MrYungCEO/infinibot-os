/**
 * Credits view controller — owns gateway calls + local state.
 *
 * Mirrors the pattern in `controllers/business.ts`: a small `CreditsState`
 * object held on the host (`state.creditsState`), plus pure load/sync
 * helpers that mutate it and call `requestUpdate`.
 */

import type { GatewayBrowserClient } from "../gateway";

export type CreditsPeriod = "hour" | "day" | "week" | "month" | "all";
export type CreditsBucket = "minute" | "hour" | "day" | "week";

export interface CreditsBudget {
  id: string;
  name: string;
  scopeAxis: "provider" | "agent_backend" | "project_id" | "session_key" | "all";
  scopeValue?: string;
  monthlyLimitUsd: number;
  warnThresholdPct: number;
  hardThresholdPct: number;
  blockOnHard: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreditsBudgetStatus extends CreditsBudget {
  monthKey: string;
  currentSpendUsd: number;
  pctUsed: number;
  state: "ok" | "warn" | "hard" | "exceeded";
  remainingUsd: number;
}

export interface CreditsSummary {
  period: CreditsPeriod;
  periodStart: number;
  periodEnd: number;
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  byProvider: Array<{ provider: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; requests: number }>;
  byBackend: Array<{ agentBackend: string; tokensIn: number; tokensOut: number; costUsd: number; requests: number }>;
  byModel: Array<{ provider: string; model: string; tokens: number; costUsd: number; requests: number }>;
  byProject: Array<{ projectId: string; tokens: number; costUsd: number; requests: number }>;
  bySession: Array<{ sessionKey: string; tokens: number; costUsd: number; requests: number }>;
  autonomousPercent: number;
}

export interface CreditsEntry {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  kind: string;
  agentBackend: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  sessionKey?: string;
  taskId?: string;
  projectId?: string;
  agentId?: string;
  autonomous: boolean;
  success: boolean;
}

export interface CreditsTimeseriesPoint {
  bucketStart: number;
  series: Record<string, { tokens: number; costUsd: number; requests: number }>;
}

export interface CreditsTimeseries {
  bucket: CreditsBucket;
  range: { start: number; end: number };
  points: CreditsTimeseriesPoint[];
}

export interface CreditsProviderInfo {
  provider: string;
  lastSyncAt?: number;
  lastReconciledTotalUsd?: number;
  status: "configured" | "missing-credentials" | "unsupported" | "error" | "ok";
  message?: string;
}

export interface CreditsSubscription {
  id: string;
  provider: string;
  plan: string;
  monthlyAmountUsd: number;
  billingAnchor: string;
  isActive: boolean;
  notes?: string;
  period: { start: number; end: number; periodCostUsd: number };
}

export interface CreditsDashboard {
  period: { start: number; end: number; label: string };
  subscriptions: CreditsSubscription[];
  usageByProvider: Array<{ provider: string; inputTokens: number; outputTokens: number; costUsd: number; requests: number }>;
  usageByBackend: Array<{ backend: string; inputTokens: number; outputTokens: number; costUsd: number; requests: number }>;
  usageByModel: Array<{ model: string; provider: string; tokens: number; costUsd: number; requests: number }>;
  usageTotals: { tokensIn: number; tokensOut: number; costUsd: number; requests: number; autonomousPercent: number };
  totalSubscriptionUsd: number;
  totalUsageUsd: number;
  totalMonthlyCostUsd: number;
  trends: { daily7d: CreditsTimeseriesPoint[]; daily30d: CreditsTimeseriesPoint[] };
  topSessions: Array<{ sessionKey: string; costUsd: number; tokens: number; requests: number }>;
  generatedAt: number;
}

export interface CreditsPlanUsage {
  provider: string;
  plan: string;
  /** Plan the CLI/credential cache reports (suggestion source). */
  detectedPlan?: string;
  periodStart: number;
  periodEnd: number;
  usedTokens?: number;
  usedUsd?: number;
  remainingUsd?: number;
  limitUsd?: number;
  limitTokens?: number;
  source: "api" | "estimated";
  status: "ok" | "error" | "missing-credentials" | "unsupported";
  message?: string;
  fetchedAt: number;
}

export interface CreditsPlanOption {
  id: string;
  label: string;
  kind: "api" | "subscription";
  monthlyPriceUsd?: number;
  hasUsageApi: boolean;
}

export interface CreditsProviderPlan {
  provider: string;
  configured: boolean;
  config: {
    provider: string;
    plan: string;
    /** When true, plan tracks CLI detection; when false the user pinned it. */
    auto?: boolean;
    orgId?: string;
    monthlyBudgetUsd?: number;
    monthlyTokenCap?: number;
    hasApiKey: boolean;
    hasOauthToken: boolean;
    updatedAt: number;
  };
  planDef?: CreditsPlanOption;
  availablePlans: CreditsPlanOption[];
  usage: CreditsPlanUsage;
}

/** Editor draft for the provider-plan modal. */
export interface CreditsPlanDraft {
  provider: string;
  plan: string;
  apiKey?: string;
  orgId?: string;
  oauthToken?: string;
  monthlyBudgetUsd?: number;
  monthlyTokenCap?: number;
  availablePlans: CreditsPlanOption[];
  hasApiKey: boolean;
}

export interface CreditsState {
  loading: boolean;
  error?: string;
  period: CreditsPeriod;
  bucket: CreditsBucket;
  groupBy: "agent_backend" | "provider" | "model" | "project_id";
  /** Which metric the timeseries chart plots — tokens, cost, or request count. */
  metric: "tokens" | "cost" | "requests";
  summary?: CreditsSummary;
  timeseries?: CreditsTimeseries;
  recent: CreditsEntry[];
  providers: CreditsProviderInfo[];
  pricedModels: string[];
  budgets: CreditsBudget[];
  budgetStatuses: CreditsBudgetStatus[];
  dashboard?: CreditsDashboard;
  filter: { provider?: string; agentBackend?: string };
  lastLoadedAt?: number;
  refreshingProvider?: string | null;
  /** Open the budget editor with this payload (or undefined for closed). */
  budgetDraft?: Partial<CreditsBudget> | null;
  /** Plan-aware provider usage (credits.providers.list). */
  providerPlans: CreditsProviderPlan[];
  /** Open the plan editor with this payload (or null/undefined for closed). */
  planDraft?: CreditsPlanDraft | null;
  /** Provider whose plan usage is being refreshed/tested. */
  refreshingPlan?: string | null;
  /** Last test-connection result, keyed by provider. */
  planTestResult?: Record<string, { ok: boolean; source: string; status: string; message?: string }>;
  /** Transient confirmation toast (auto-cleared). */
  toast?: { text: string; tone: "ok" | "warn" } | null;
}

export function createCreditsState(): CreditsState {
  return {
    loading: false,
    period: "month",
    bucket: "day",
    groupBy: "agent_backend",
    metric: "tokens",
    recent: [],
    providers: [],
    pricedModels: [],
    budgets: [],
    budgetStatuses: [],
    filter: {},
    providerPlans: [],
    planTestResult: {},
  };
}

interface AppLike {
  creditsState?: CreditsState;
  requestUpdate?: () => void;
}

function ensureState(host: AppLike): CreditsState {
  if (!host.creditsState) host.creditsState = createCreditsState();
  return host.creditsState;
}

function update(host: AppLike): void {
  host.requestUpdate?.();
}

/** Single-shot load of every panel — summary, timeseries, top tables, providers, budgets. */
export async function loadCredits(host: AppLike, client: GatewayBrowserClient): Promise<void> {
  const s = ensureState(host);
  s.loading = true;
  s.error = undefined;
  update(host);

  try {
    const end = Date.now();
    let start = end - 30 * 24 * 60 * 60 * 1000;
    if (s.period === "hour") start = end - 60 * 60 * 1000;
    else if (s.period === "day") start = end - 24 * 60 * 60 * 1000;
    else if (s.period === "week") start = end - 7 * 24 * 60 * 60 * 1000;
    else if (s.period === "month") start = end - 30 * 24 * 60 * 60 * 1000;
    else if (s.period === "all") start = 0;

    const [summary, ts, recent, providers, budgets, dashboard, plans] = await Promise.all([
      client.request("credits.summary", { period: s.period, filters: s.filter }),
      client.request("credits.timeseries", { bucket: s.bucket, range: { start, end }, groupBy: s.groupBy, filters: s.filter }),
      client.request("credits.recent", { limit: 100 }),
      client.request("credits.providers", {}),
      client.request("credits.budgets.list", {}),
      client.request("credits.dashboard", {}),
      client.request("credits.providers.list", {}),
    ]);

    s.summary = summary as CreditsSummary;
    s.timeseries = ts as CreditsTimeseries;
    s.recent = (recent as { entries?: CreditsEntry[] }).entries ?? [];
    s.providers = (providers as { providers?: CreditsProviderInfo[] }).providers ?? [];
    s.pricedModels = (providers as { pricedModels?: string[] }).pricedModels ?? [];
    s.budgets = (budgets as { budgets?: CreditsBudget[] }).budgets ?? [];
    s.budgetStatuses = (budgets as { statuses?: CreditsBudgetStatus[] }).statuses ?? [];
    s.dashboard = dashboard as CreditsDashboard;
    s.providerPlans = (plans as { providers?: CreditsProviderPlan[] }).providers ?? [];
    s.lastLoadedAt = Date.now();
  } catch (e) {
    s.error = String(e);
  } finally {
    s.loading = false;
    update(host);
  }
}

export function setCreditsPeriod(host: AppLike, period: CreditsPeriod): void {
  const s = ensureState(host);
  s.period = period;
  update(host);
}

export function setCreditsBucket(host: AppLike, bucket: CreditsBucket): void {
  const s = ensureState(host);
  s.bucket = bucket;
  update(host);
}

export function setCreditsGroupBy(host: AppLike, groupBy: CreditsState["groupBy"]): void {
  const s = ensureState(host);
  s.groupBy = groupBy;
  update(host);
}

export function setCreditsMetric(host: AppLike, metric: CreditsState["metric"]): void {
  const s = ensureState(host);
  s.metric = metric;
  update(host);
}

export function setCreditsFilter(host: AppLike, filter: CreditsState["filter"]): void {
  const s = ensureState(host);
  s.filter = filter;
  update(host);
}

export async function syncProvider(
  host: AppLike,
  client: GatewayBrowserClient,
  provider?: string,
): Promise<void> {
  const s = ensureState(host);
  s.refreshingProvider = provider ?? "*";
  update(host);
  try {
    await client.request("credits.sync", provider ? { provider } : {});
  } catch (e) {
    s.error = String(e);
  } finally {
    s.refreshingProvider = null;
    update(host);
    await loadCredits(host, client);
  }
}

export function openBudgetDraft(host: AppLike, draft?: Partial<CreditsBudget>): void {
  const s = ensureState(host);
  s.budgetDraft = draft ?? { name: "New budget", scopeAxis: "all", monthlyLimitUsd: 50, warnThresholdPct: 80, hardThresholdPct: 100, blockOnHard: false };
  update(host);
}

export function closeBudgetDraft(host: AppLike): void {
  const s = ensureState(host);
  s.budgetDraft = null;
  update(host);
}

export async function saveBudgetDraft(host: AppLike, client: GatewayBrowserClient): Promise<void> {
  const s = ensureState(host);
  if (!s.budgetDraft) return;
  await client.request("credits.budgets.upsert", s.budgetDraft as unknown as Record<string, unknown>);
  s.budgetDraft = null;
  update(host);
  await loadCredits(host, client);
}

export async function deleteBudget(host: AppLike, client: GatewayBrowserClient, id: string): Promise<void> {
  await client.request("credits.budgets.delete", { id });
  await loadCredits(host, client);
}

// ── Provider plans ──────────────────────────────────────────────

export function openPlanDraft(host: AppLike, plan: CreditsProviderPlan): void {
  const s = ensureState(host);
  s.planDraft = {
    provider: plan.provider,
    plan: plan.config.plan,
    orgId: plan.config.orgId,
    monthlyBudgetUsd: plan.config.monthlyBudgetUsd,
    monthlyTokenCap: plan.config.monthlyTokenCap,
    // Secrets are never sent back to the client; leave blank (placeholder shows
    // whether one is already stored). An empty submit leaves the stored key intact.
    apiKey: undefined,
    oauthToken: undefined,
    availablePlans: plan.availablePlans,
    hasApiKey: plan.config.hasApiKey,
  };
  update(host);
}

export function closePlanDraft(host: AppLike): void {
  const s = ensureState(host);
  s.planDraft = null;
  update(host);
}

export async function savePlanDraft(host: AppLike, client: GatewayBrowserClient): Promise<void> {
  const s = ensureState(host);
  const d = s.planDraft;
  if (!d) return;
  const payload: Record<string, unknown> = { provider: d.provider, plan: d.plan };
  // Only send credentials/overrides the user actually edited (undefined = leave
  // untouched server-side; the upsert preserves existing secrets).
  if (d.apiKey !== undefined) payload.apiKey = d.apiKey;
  if (d.orgId !== undefined) payload.orgId = d.orgId;
  if (d.oauthToken !== undefined) payload.oauthToken = d.oauthToken;
  if (d.monthlyBudgetUsd !== undefined) payload.monthlyBudgetUsd = d.monthlyBudgetUsd;
  if (d.monthlyTokenCap !== undefined) payload.monthlyTokenCap = d.monthlyTokenCap;
  try {
    await client.request("credits.providers.upsert", payload);
    s.planDraft = null;
  } catch (e) {
    s.error = String(e);
  }
  update(host);
  await loadCredits(host, client);
}

export async function refreshPlan(host: AppLike, client: GatewayBrowserClient, provider: string): Promise<void> {
  const s = ensureState(host);
  s.refreshingPlan = provider;
  update(host);
  try {
    await client.request("credits.providers.refresh", { provider });
  } catch (e) {
    s.error = String(e);
  } finally {
    s.refreshingPlan = null;
    await loadCredits(host, client);
  }
}

export async function testPlanConnection(host: AppLike, client: GatewayBrowserClient, provider: string): Promise<void> {
  const s = ensureState(host);
  s.refreshingPlan = provider;
  update(host);
  try {
    const r = (await client.request("credits.providers.testConnection", { provider })) as {
      ok: boolean; source: string; status: string; message?: string;
    };
    s.planTestResult = { ...(s.planTestResult ?? {}), [provider]: r };
  } catch (e) {
    s.planTestResult = { ...(s.planTestResult ?? {}), [provider]: { ok: false, source: "error", status: "error", message: String(e) } };
  } finally {
    s.refreshingPlan = null;
    await loadCredits(host, client);
  }
}

export function updatePlanDraft(host: AppLike, patch: Partial<CreditsPlanDraft>): void {
  const s = ensureState(host);
  if (!s.planDraft) return;
  s.planDraft = { ...s.planDraft, ...patch };
  update(host);
}

/** Show a transient confirmation toast that clears itself. */
export function showCreditsToast(host: AppLike, text: string, tone: "ok" | "warn" = "ok"): void {
  const s = ensureState(host);
  s.toast = { text, tone };
  update(host);
  setTimeout(() => {
    const cur = host.creditsState;
    if (cur && cur.toast?.text === text) {
      cur.toast = null;
      update(host);
    }
  }, 3200);
}

/**
 * Pin a provider to a specific plan (auto=false) — the one-tap inline picker.
 * Writes to the same store the page reads from, then reloads so the usage % and
 * plan label recompute against the new plan's limit. Confirms with a toast.
 */
export async function setProviderPlan(
  host: AppLike,
  client: GatewayBrowserClient,
  provider: string,
  plan: string,
  label?: string,
): Promise<void> {
  const s = ensureState(host);
  s.refreshingPlan = provider;
  update(host);
  try {
    await client.request("credits.providers.upsert", { provider, plan, auto: false });
    showCreditsToast(host, `${provider} plan set to ${label ?? plan}`);
  } catch (e) {
    s.error = String(e);
    showCreditsToast(host, `Failed to set plan: ${String(e)}`, "warn");
  } finally {
    s.refreshingPlan = null;
    await loadCredits(host, client);
  }
}

/**
 * Toggle CLI auto-detection for a provider. When turned on, the plan locks to
 * whatever the CLI reports; when off, the current plan becomes a manual pin.
 */
export async function setProviderAuto(
  host: AppLike,
  client: GatewayBrowserClient,
  provider: string,
  auto: boolean,
): Promise<void> {
  const s = ensureState(host);
  s.refreshingPlan = provider;
  update(host);
  try {
    await client.request("credits.providers.upsert", { provider, auto });
    showCreditsToast(host, auto ? `${provider} now follows CLI detection` : `${provider} plan pinned`);
  } catch (e) {
    s.error = String(e);
    showCreditsToast(host, `Failed: ${String(e)}`, "warn");
  } finally {
    s.refreshingPlan = null;
    await loadCredits(host, client);
  }
}

export async function exportRecentCsv(host: AppLike): Promise<string> {
  const s = ensureState(host);
  const header = ["timestamp", "provider", "model", "backend", "tokensIn", "tokensOut", "cacheRead", "cacheWrite", "costUsd", "sessionKey", "projectId", "agentId", "success"];
  const rows = s.recent.map((e) =>
    [
      new Date(e.timestamp).toISOString(),
      e.provider,
      e.model,
      e.agentBackend,
      e.tokensIn,
      e.tokensOut,
      e.cacheReadTokens,
      e.cacheWriteTokens,
      e.costUsd,
      e.sessionKey ?? "",
      e.projectId ?? "",
      e.agentId ?? "",
      e.success ? 1 : 0,
    ]
      .map((v) => (typeof v === "string" && v.includes(",") ? `"${v.replace(/"/g, '""')}"` : String(v)))
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}
