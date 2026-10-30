/**
 * Read-side helpers. All queries flow through `getCreditStore()` so they
 * see writes from every adapter. A 30-second in-process cache keeps the UI
 * snappy without hammering SQLite on every poll.
 */

import { getCreditStore } from "./store.js";
import type {
  BackendCost,
  BillingPeriod,
  CreditAggregate,
  CreditBudget,
  CreditBudgetStatus,
  CreditEntry,
  ProviderCost,
  TimeseriesBucket,
  TimeseriesPoint,
} from "./types.js";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: unknown }>();

function memo<T>(key: string, fn: () => T): T {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function invalidateAggregatorCache(): void {
  cache.clear();
}

function periodToRange(period: BillingPeriod): { start: number; end: number } {
  // `end` is an EXCLUSIVE bound in every query (`timestamp < ?`), so it has to
  // sit just past "now" — otherwise a credit recorded in the current
  // millisecond is left out of the window it was just written into.
  const end = Date.now() + 1;
  switch (period) {
    case "hour":
      return { start: end - 60 * 60 * 1000, end };
    case "day":
      return { start: end - 24 * 60 * 60 * 1000, end };
    case "week":
      return { start: end - 7 * 24 * 60 * 60 * 1000, end };
    case "month":
      return { start: end - 30 * 24 * 60 * 60 * 1000, end };
    case "all":
      return { start: 0, end };
  }
}

export interface SummaryFilters {
  provider?: string;
  agentBackend?: string;
  projectId?: string;
  sessionKey?: string;
  /** Roll up a single run — CLI credit entries are keyed by taskId = runId. */
  taskId?: string;
}

function buildWhere(
  start: number,
  end: number,
  f: SummaryFilters,
): { sql: string; args: unknown[] } {
  const parts = ["timestamp >= ?", "timestamp < ?"];
  const args: unknown[] = [start, end];
  if (f.provider) {
    parts.push("provider = ?");
    args.push(f.provider);
  }
  if (f.agentBackend) {
    parts.push("agent_backend = ?");
    args.push(f.agentBackend);
  }
  if (f.projectId) {
    parts.push("project_id = ?");
    args.push(f.projectId);
  }
  if (f.sessionKey) {
    parts.push("session_key = ?");
    args.push(f.sessionKey);
  }
  if (f.taskId) {
    parts.push("task_id = ?");
    args.push(f.taskId);
  }
  return { sql: `WHERE ${parts.join(" AND ")}`, args };
}

export interface SummaryOptions {
  period: BillingPeriod;
  filters?: SummaryFilters;
}

export function summary(opts: SummaryOptions): CreditAggregate {
  const filters = opts.filters ?? {};
  const cacheKey = `summary:${opts.period}:${JSON.stringify(filters)}`;
  return memo(cacheKey, () => computeSummary(opts.period, filters));
}

function computeSummary(period: BillingPeriod, filters: SummaryFilters): CreditAggregate {
  const store = getCreditStore();
  const { start, end } = periodToRange(period);
  const { sql, args } = buildWhere(start, end, filters);

  const totals = store.db
    .prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(tokens_in), 0) AS tokensIn,
      COALESCE(SUM(tokens_out), 0) AS tokensOut,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
      COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
      COALESCE(SUM(cost_usd), 0) AS costUsd,
      COALESCE(SUM(CASE WHEN autonomous = 1 THEN tokens_in + tokens_out ELSE 0 END), 0) AS autonomousTokens,
      COALESCE(SUM(tokens_in + tokens_out), 0) AS allTokens
    FROM credit_entries ${sql}
  `)
    .get(...args) as Record<string, number>;

  const byProvider = store.db
    .prepare(`
    SELECT provider, model,
      COUNT(*) AS requests,
      SUM(tokens_in) AS tokensIn,
      SUM(tokens_out) AS tokensOut,
      SUM(cache_read_tokens) AS cacheRead,
      SUM(cache_write_tokens) AS cacheWrite,
      SUM(cost_usd) AS costUsd
    FROM credit_entries ${sql}
    GROUP BY provider, model
    ORDER BY costUsd DESC
  `)
    .all(...args) as Array<Record<string, number | string>>;

  const providerMap = new Map<string, ProviderCost>();
  const modelRows: CreditAggregate["byModel"] = [];
  for (const r of byProvider) {
    const prov = String(r.provider);
    const model = String(r.model);
    const tokens = Number(r.tokensIn ?? 0) + Number(r.tokensOut ?? 0);
    modelRows.push({
      provider: prov,
      model,
      tokens,
      costUsd: Number(r.costUsd ?? 0),
      requests: Number(r.requests ?? 0),
    });
    const existing = providerMap.get(prov) ?? {
      provider: prov,
      model: "",
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      requests: 0,
    };
    existing.tokensIn += Number(r.tokensIn ?? 0);
    existing.tokensOut += Number(r.tokensOut ?? 0);
    existing.cacheReadTokens += Number(r.cacheRead ?? 0);
    existing.cacheWriteTokens += Number(r.cacheWrite ?? 0);
    existing.costUsd += Number(r.costUsd ?? 0);
    existing.requests += Number(r.requests ?? 0);
    providerMap.set(prov, existing);
  }

  const byBackend: BackendCost[] = (
    store.db
      .prepare(`
    SELECT agent_backend AS backend,
      COUNT(*) AS requests,
      SUM(tokens_in) AS tokensIn,
      SUM(tokens_out) AS tokensOut,
      SUM(cost_usd) AS costUsd
    FROM credit_entries ${sql}
    GROUP BY agent_backend
    ORDER BY costUsd DESC
  `)
      .all(...args) as Array<Record<string, number | string>>
  ).map((r) => ({
    agentBackend: (String(r.backend) || "unknown") as BackendCost["agentBackend"],
    tokensIn: Number(r.tokensIn ?? 0),
    tokensOut: Number(r.tokensOut ?? 0),
    costUsd: Number(r.costUsd ?? 0),
    requests: Number(r.requests ?? 0),
  }));

  const byProject = (
    store.db
      .prepare(`
    SELECT project_id AS projectId,
      COUNT(*) AS requests,
      SUM(tokens_in + tokens_out) AS tokens,
      SUM(cost_usd) AS costUsd
    FROM credit_entries ${sql} AND project_id IS NOT NULL
    GROUP BY project_id
    ORDER BY costUsd DESC
    LIMIT 20
  `)
      .all(...args) as Array<Record<string, number | string>>
  ).map((r) => ({
    projectId: String(r.projectId),
    requests: Number(r.requests ?? 0),
    tokens: Number(r.tokens ?? 0),
    costUsd: Number(r.costUsd ?? 0),
  }));

  const bySession = (
    store.db
      .prepare(`
    SELECT session_key AS sessionKey,
      COUNT(*) AS requests,
      SUM(tokens_in + tokens_out) AS tokens,
      SUM(cost_usd) AS costUsd
    FROM credit_entries ${sql} AND session_key IS NOT NULL
    GROUP BY session_key
    ORDER BY costUsd DESC
    LIMIT 20
  `)
      .all(...args) as Array<Record<string, number | string>>
  ).map((r) => ({
    sessionKey: String(r.sessionKey),
    requests: Number(r.requests ?? 0),
    tokens: Number(r.tokens ?? 0),
    costUsd: Number(r.costUsd ?? 0),
  }));

  const allTokens = Number(totals.allTokens ?? 0);
  const autonomousTokens = Number(totals.autonomousTokens ?? 0);

  return {
    period,
    periodStart: start,
    periodEnd: end,
    totalRequests: Number(totals.requests ?? 0),
    totalTokensIn: Number(totals.tokensIn ?? 0),
    totalTokensOut: Number(totals.tokensOut ?? 0),
    totalCacheReadTokens: Number(totals.cacheRead ?? 0),
    totalCacheWriteTokens: Number(totals.cacheWrite ?? 0),
    totalCostUsd: Number(totals.costUsd ?? 0),
    byProvider: Array.from(providerMap.values()).sort((a, b) => b.costUsd - a.costUsd),
    byBackend,
    byModel: modelRows.slice(0, 50),
    byProject,
    bySession,
    autonomousPercent: allTokens > 0 ? (autonomousTokens / allTokens) * 100 : 0,
  };
}

export interface TimeseriesOptions {
  bucket: TimeseriesBucket;
  range: { start: number; end: number };
  groupBy?: "agent_backend" | "provider" | "model" | "project_id";
  filters?: SummaryFilters;
}

function bucketMs(bucket: TimeseriesBucket): number {
  switch (bucket) {
    case "minute":
      return 60_000;
    case "hour":
      return 60 * 60_000;
    case "day":
      return 24 * 60 * 60_000;
    case "week":
      return 7 * 24 * 60 * 60_000;
  }
}

export function timeseries(opts: TimeseriesOptions): TimeseriesPoint[] {
  const key = `ts:${JSON.stringify(opts)}`;
  return memo(key, () => computeTimeseries(opts));
}

function computeTimeseries(opts: TimeseriesOptions): TimeseriesPoint[] {
  const store = getCreditStore();
  const filters = opts.filters ?? {};
  const { sql, args } = buildWhere(opts.range.start, opts.range.end, filters);
  const slice = bucketMs(opts.bucket);
  const group = opts.groupBy ?? "agent_backend";
  const rows = store.db
    .prepare(`
    SELECT (timestamp / ?) AS bucket,
      ${group} AS series,
      COUNT(*) AS requests,
      SUM(tokens_in + tokens_out) AS tokens,
      SUM(cost_usd) AS costUsd
    FROM credit_entries ${sql}
    GROUP BY bucket, series
    ORDER BY bucket ASC
  `)
    .all(slice, ...args) as Array<Record<string, number | string>>;

  const out = new Map<number, TimeseriesPoint>();
  for (const r of rows) {
    const bucketStart = Number(r.bucket) * slice;
    const series = String(r.series ?? "unknown");
    const point = out.get(bucketStart) ?? { bucketStart, series: {} };
    point.series[series] = {
      tokens: Number(r.tokens ?? 0),
      costUsd: Number(r.costUsd ?? 0),
      requests: Number(r.requests ?? 0),
    };
    out.set(bucketStart, point);
  }
  return Array.from(out.values()).sort((a, b) => a.bucketStart - b.bucketStart);
}

export interface TopConsumerOptions {
  axis: "provider" | "model" | "agent_backend" | "project_id" | "session_key";
  limit?: number;
  period?: BillingPeriod;
}

export function topConsumers(
  opts: TopConsumerOptions,
): Array<{ key: string; tokens: number; costUsd: number; requests: number }> {
  const period = opts.period ?? "month";
  const cacheKey = `top:${opts.axis}:${period}:${opts.limit ?? 10}`;
  return memo(cacheKey, () => {
    const store = getCreditStore();
    const { start, end } = periodToRange(period);
    const rows = store.db
      .prepare(`
      SELECT ${opts.axis} AS k,
        COUNT(*) AS requests,
        SUM(tokens_in + tokens_out) AS tokens,
        SUM(cost_usd) AS costUsd
      FROM credit_entries
      WHERE timestamp >= ? AND timestamp < ? AND ${opts.axis} IS NOT NULL
      GROUP BY k
      ORDER BY costUsd DESC
      LIMIT ?
    `)
      .all(start, end, opts.limit ?? 10) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      key: String(r.k ?? "unknown"),
      requests: Number(r.requests ?? 0),
      tokens: Number(r.tokens ?? 0),
      costUsd: Number(r.costUsd ?? 0),
    }));
  });
}

export function recentEntries(limit = 100, cursor?: number): CreditEntry[] {
  return getCreditStore().recent(limit, cursor);
}

export function sessionEntries(sessionKey: string): CreditEntry[] {
  return getCreditStore().bySession(sessionKey);
}

export function projectEntries(projectId: string): CreditEntry[] {
  return getCreditStore().byProject(projectId);
}

// ── Budget evaluation ─────────────────────────────────────────

function monthKey(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function budgetStatuses(): CreditBudgetStatus[] {
  const store = getCreditStore();
  const budgets = store.listBudgets();
  const month = monthKey(Date.now());
  const monthStart = new Date(`${month}-01T00:00:00Z`).getTime();
  return budgets.map((b) => {
    const where: string[] = ["timestamp >= ?"];
    const args: unknown[] = [monthStart];
    if (b.scopeAxis !== "all" && b.scopeValue) {
      where.push(`${b.scopeAxis} = ?`);
      args.push(b.scopeValue);
    }
    const row = store.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd),0) AS spend FROM credit_entries WHERE ${where.join(" AND ")}`,
      )
      .get(...args) as { spend: number };
    const spend = Number(row.spend ?? 0);
    const pctUsed = b.monthlyLimitUsd > 0 ? (spend / b.monthlyLimitUsd) * 100 : 0;
    let state: CreditBudgetStatus["state"] = "ok";
    if (pctUsed >= 100) state = "exceeded";
    else if (pctUsed >= b.hardThresholdPct) state = "hard";
    else if (pctUsed >= b.warnThresholdPct) state = "warn";
    return {
      ...b,
      monthKey: month,
      currentSpendUsd: spend,
      pctUsed,
      state,
      remainingUsd: Math.max(0, b.monthlyLimitUsd - spend),
    };
  });
}

/** Returns the first blocking budget if any spawn for this scope must be refused. */
export function checkSpawnGuard(scope: {
  provider?: string;
  agentBackend?: string;
  projectId?: string;
  sessionKey?: string;
}): CreditBudgetStatus | null {
  const statuses = budgetStatuses();
  for (const s of statuses) {
    if (!s.blockOnHard) continue;
    if (s.state !== "hard" && s.state !== "exceeded") continue;
    if (s.scopeAxis === "all") return s;
    if (s.scopeAxis === "provider" && s.scopeValue === scope.provider) return s;
    if (s.scopeAxis === "agent_backend" && s.scopeValue === scope.agentBackend) return s;
    if (s.scopeAxis === "project_id" && s.scopeValue === scope.projectId) return s;
    if (s.scopeAxis === "session_key" && s.scopeValue === scope.sessionKey) return s;
  }
  return null;
}

export function listBudgets(): CreditBudget[] {
  return getCreditStore().listBudgets();
}
