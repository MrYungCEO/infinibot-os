/**
 * useCredits — read the unified credit ledger from the gateway.
 *
 * Mirrors the desktop controller in `ui/src/ui/controllers/credits.ts` so the
 * mobile view exposes the same shape and parity:
 *   • summary / timeseries / recent / providers / budgets / dashboard
 *   • providerPlans (credits.providers.list) — plan ring cards + AUTO/detect
 *   • a dedicated 24h-by-backend series (credits.timeseries, hour bucket)
 *   • a 48h series split into today/yesterday for the delta pill
 *
 * It calls the SAME `credits.*` gateway RPCs the web uses — no new RPCs.
 * Every fetch runs in parallel; `load()` is wired to pull-to-refresh.
 */

import { useCallback, useEffect, useState } from 'react';

const RANGE_FOR_PERIOD = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  all: 0,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Sum a timeseries point-set into a flat per-key total map.
function sumByKey(points) {
  const agg = new Map();
  for (const p of points ?? []) {
    for (const [key, entry] of Object.entries(p.series ?? {})) {
      const prev = agg.get(key) ?? { costUsd: 0, tokens: 0, requests: 0 };
      prev.costUsd += entry.costUsd ?? 0;
      prev.tokens += entry.tokens ?? 0;
      prev.requests += entry.requests ?? 0;
      agg.set(key, prev);
    }
  }
  return agg;
}

export function useCredits(gateway) {
  const [period, setPeriod] = useState('month');
  const [bucket, setBucket] = useState('day');
  const [groupBy, setGroupBy] = useState('agent_backend');
  const [summary, setSummary] = useState(null);
  const [timeseries, setTimeseries] = useState(null);
  // Dedicated 24h hourly series grouped by agent_backend — matches the desktop
  // <credit-usage-breakdown> widget regardless of the selected period.
  const [usage24h, setUsage24h] = useState(null);
  // { today, yesterday } cost totals derived from a 48h hourly series.
  const [delta, setDelta] = useState(null);
  const [recent, setRecent] = useState([]);
  const [providers, setProviders] = useState([]);
  const [providerPlans, setProviderPlans] = useState([]);
  const [budgets, setBudgets] = useState([]);
  const [budgetStatuses, setBudgetStatuses] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshingPlan, setRefreshingPlan] = useState(null);
  const [error, setError] = useState(null);
  const [lastLoadedAt, setLastLoadedAt] = useState(null);

  const load = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setLoading(true);
    setError(null);
    try {
      const end = Date.now();
      const start = period === 'all' ? 0 : end - (RANGE_FOR_PERIOD[period] || RANGE_FOR_PERIOD.month);
      const start24h = end - DAY_MS;
      const start48h = end - 2 * DAY_MS;

      // Resilient parallel fetch — one failing RPC must not blank the whole
      // page (e.g. credits.providers.list before a gateway restart), and one
      // slow RPC must not hold back the rest: every result is applied as soon
      // as its own call settles.
      let okCount = 0;
      let firstError = null;
      const call = (method, params, apply) =>
        gateway.sendReq(method, params).then(
          (res) => {
            if (res) {
              okCount += 1;
              apply(res);
              // First data in → drop the skeleton without waiting for the rest.
              setLastLoadedAt((prev) => prev || Date.now());
            }
          },
          (e) => {
            if (!firstError) firstError = `${method}: ${e?.message || e}`;
            if (__DEV__) console.log(`[credits] ${method} failed:`, e?.message || e);
          },
        );

      await Promise.all([
        call('credits.summary', { period }, setSummary),
        call('credits.timeseries', { bucket, range: { start, end }, groupBy }, setTimeseries),
        call('credits.timeseries', { bucket: 'hour', range: { start: start24h, end }, groupBy: 'agent_backend' }, setUsage24h),
        call('credits.timeseries', { bucket: 'hour', range: { start: start48h, end }, groupBy: 'agent_backend' }, (ts48h) => {
          if (!ts48h?.points) return;
          const cutoff = end - DAY_MS;
          let today = 0;
          let yesterday = 0;
          for (const p of ts48h.points) {
            const bucketTotal = Object.values(p.series ?? {}).reduce(
              (s, e) => s + (e.costUsd ?? 0),
              0,
            );
            if (p.bucketStart >= cutoff) today += bucketTotal;
            else yesterday += bucketTotal;
          }
          setDelta({ today, yesterday });
        }),
        call('credits.recent', { limit: 100 }, (r) => {
          if (r?.entries) setRecent(r.entries);
        }),
        call('credits.providers', {}, (r) => {
          if (r?.providers) setProviders(r.providers);
        }),
        call('credits.providers.list', {}, (r) => {
          if (r?.providers) setProviderPlans(r.providers);
        }),
        call('credits.budgets.list', {}, (r) => {
          if (r?.budgets) setBudgets(r.budgets);
          if (r?.statuses) setBudgetStatuses(r.statuses);
        }),
        call('credits.dashboard', {}, setDashboard),
      ]);

      // Nothing came back at all → say so instead of rendering a page of zeros.
      if (okCount === 0) {
        setError(firstError || 'No response from the gateway');
        return;
      }
      setLastLoadedAt(Date.now());
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [gateway, period, bucket, groupBy]);

  useEffect(() => {
    load();
  }, [load]);

  const syncProvider = useCallback(
    async (provider) => {
      if (!gateway?.sendReq) return null;
      try {
        const res = await gateway.sendReq('credits.sync', provider ? { provider } : {});
        await load();
        return res;
      } catch (err) {
        setError(String(err?.message || err));
        return null;
      }
    },
    [gateway, load],
  );

  // ── Plan mutations (mirror controllers/credits.ts) ─────────────────

  // Pin a provider to a specific plan (auto=false) — the inline picker.
  const setPlan = useCallback(
    async (provider, plan) => {
      if (!gateway?.sendReq) return;
      setRefreshingPlan(provider);
      try {
        await gateway.sendReq('credits.providers.upsert', { provider, plan, auto: false });
      } catch (err) {
        setError(String(err?.message || err));
      } finally {
        setRefreshingPlan(null);
        await load();
      }
    },
    [gateway, load],
  );

  // Toggle CLI auto-detection for a provider.
  const setAuto = useCallback(
    async (provider, auto) => {
      if (!gateway?.sendReq) return;
      setRefreshingPlan(provider);
      try {
        await gateway.sendReq('credits.providers.upsert', { provider, auto });
      } catch (err) {
        setError(String(err?.message || err));
      } finally {
        setRefreshingPlan(null);
        await load();
      }
    },
    [gateway, load],
  );

  // Re-run the CLI status command for a provider's plan.
  const refreshPlan = useCallback(
    async (provider) => {
      if (!gateway?.sendReq) return;
      setRefreshingPlan(provider);
      try {
        await gateway.sendReq('credits.providers.refresh', { provider });
      } catch (err) {
        setError(String(err?.message || err));
      } finally {
        setRefreshingPlan(null);
        await load();
      }
    },
    [gateway, load],
  );

  return {
    period,
    setPeriod,
    bucket,
    setBucket,
    groupBy,
    setGroupBy,
    summary,
    timeseries,
    usage24h,
    delta,
    recent,
    providers,
    providerPlans,
    budgets,
    budgetStatuses,
    dashboard,
    loading,
    refreshingPlan,
    error,
    lastLoadedAt,
    load,
    syncProvider,
    setPlan,
    setAuto,
    refreshPlan,
    sumByKey,
  };
}
