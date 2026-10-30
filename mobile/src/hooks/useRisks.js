/**
 * useRisks — KIS Object 7 (Risk Register).
 *
 * `riskScore` is Probability × Impact, computed by the store and never entered,
 * so this hook never writes it — it writes `probability` / `impact` and lets the
 * server recompute. `overdueOnly` switches to `risk.overdue`, which applies the
 * §29 review cadence (3 days for critical, 14 for the rest) that a client-side
 * date filter could not reproduce.
 *
 * RPCs: risk.list · search · get · overdue · links · create · update · delete ·
 *       impacts · unimpacts  (src/gateway/server-methods/risk.ts)
 */

import { useCallback, useMemo } from 'react';

import { useGatewayResource } from './useGatewayResource';
import { RISK_STATUSES, CRITICAL_RISK_SCORE, riskBand } from '../kis/vocab';

const selectRisks = (res) => res?.risks ?? (Array.isArray(res) ? res : []);

export function useRisks(sendReq, { overdueOnly = false, ...params } = {}) {
  const { items, loading, error, loadedAt, refresh, mutate } = useGatewayResource(sendReq, {
    method: overdueOnly ? 'risk.overdue' : 'risk.list',
    params: overdueOnly ? {} : params,
    select: selectRisks,
  });

  const create = useCallback((draft) => mutate('risk.create', draft), [mutate]);

  const update = useCallback(
    (id, patch) =>
      mutate(
        'risk.update',
        { id, ...patch },
        { optimistic: (list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)) },
      ),
    [mutate],
  );

  const remove = useCallback(
    (id) => mutate('risk.delete', { id }, { optimistic: (list) => list.filter((r) => r.id !== id) }),
    [mutate],
  );

  /**
   * Re-score a risk. Sends probability/impact only — the store recomputes
   * riskScore (1–25) and the derived riskLevel band, so the optimistic patch
   * deliberately omits both rather than guessing them into the UI.
   */
  const score = useCallback(
    (id, probability, impact) => update(id, { probability, impact }),
    [update],
  );

  /** Link / unlink the risk_impacts_task edge. */
  const impacts = useCallback(
    (riskId, taskId) => mutate('risk.impacts', { riskId, taskId }),
    [mutate],
  );
  const unimpacts = useCallback(
    (riskId, taskId) => mutate('risk.unimpacts', { riskId, taskId }),
    [mutate],
  );

  /** Typed edges around one risk (thin read; RelatedPanel is the richer view). */
  const links = useCallback((id) => sendReq?.('risk.links', { id }), [sendReq]);

  /** Register order: highest P×I first — the register is read by severity. */
  const byScore = useMemo(
    () => [...items].sort((a, b) => (Number(b?.riskScore) || 0) - (Number(a?.riskScore) || 0)),
    [items],
  );

  /** Status → risks, active lifecycle first. */
  const byStatus = useMemo(() => {
    const groups = new Map();
    for (const status of RISK_STATUSES) groups.set(status, []);
    for (const r of items) {
      const key = RISK_STATUSES.includes(r?.status) ? r.status : 'Open';
      groups.get(key).push(r);
    }
    for (const [k, list] of groups) {
      groups.set(k, [...list].sort((a, b) => (Number(b?.riskScore) || 0) - (Number(a?.riskScore) || 0)));
    }
    return groups;
  }, [items]);

  const criticalCount = useMemo(
    () => items.filter((r) => (Number(r?.riskScore) || 0) >= CRITICAL_RISK_SCORE).length,
    [items],
  );

  const openCount = useMemo(
    () => items.filter((r) => ['Open', 'Monitoring'].includes(String(r?.status))).length,
    [items],
  );

  /** Highest band present, for the header subtitle. */
  const topBand = useMemo(() => {
    const max = items.reduce((m, r) => Math.max(m, Number(r?.riskScore) || 0), 0);
    return max ? riskBand(max) : null;
  }, [items]);

  return {
    risks: items,
    loading,
    error,
    loadedAt,
    refresh,
    create,
    update,
    remove,
    score,
    impacts,
    unimpacts,
    links,
    byScore,
    byStatus,
    criticalCount,
    openCount,
    topBand,
  };
}

export default useRisks;
