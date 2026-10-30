/**
 * useDecisions — KIS Object 6 (Decisions / CEO Queue).
 *
 * `ceoQueueOnly` switches the RPC rather than filtering client-side: the
 * gateway's `decision.ceoQueue` also applies §17 trigger filtering and urgency
 * ordering that a local filter would not reproduce. Because `method` is part of
 * useGatewayResource's refresh dependencies, flipping the flag refetches.
 *
 * RPCs: decision.list · search · ceoQueue · get · create · update · delete ·
 *       guideTask  (src/gateway/server-methods/decision.ts)
 */

import { useCallback, useMemo } from 'react';

import { useGatewayResource } from './useGatewayResource';
import { DECISION_STATUS_ORDER, CEO_QUEUE_STATUSES } from '../kis/vocab';

const selectDecisions = (res) => res?.decisions ?? (Array.isArray(res) ? res : []);

export function useDecisions(sendReq, { ceoQueueOnly = false, triggerFiltered = false, ...params } = {}) {
  const { items, loading, error, loadedAt, refresh, mutate } = useGatewayResource(sendReq, {
    method: ceoQueueOnly ? 'decision.ceoQueue' : 'decision.list',
    params: ceoQueueOnly ? { triggerFiltered } : params,
    select: selectDecisions,
  });

  const create = useCallback((draft) => mutate('decision.create', draft), [mutate]);

  const update = useCallback(
    (id, patch) =>
      mutate(
        'decision.update',
        { id, ...patch },
        { optimistic: (list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d)) },
      ),
    [mutate],
  );

  const remove = useCallback(
    (id) => mutate('decision.delete', { id }, { optimistic: (list) => list.filter((d) => d.id !== id) }),
    [mutate],
  );

  /**
   * Record the CEO's answer. `Decided` is terminal-with-record and writes an
   * audit entry (§33) server-side, so the decision text and date go with it.
   */
  const decide = useCallback(
    (id, { finalDecision, rationale, decisionDate } = {}) =>
      update(id, {
        status: 'Decided',
        finalDecision,
        rationale,
        decisionDate: decisionDate || new Date().toISOString().slice(0, 10),
      }),
    [update],
  );

  /** Link a decision to the task it governs (decision_guides_task edge). */
  const guideTask = useCallback(
    (decisionId, taskId) => mutate('decision.guideTask', { decisionId, taskId }),
    [mutate],
  );

  /**
   * Status → decisions, in CEO-first lifecycle order. Any status the gateway
   * introduces later still appears, appended after the known ones rather than
   * silently dropped.
   */
  const byStatus = useMemo(() => {
    const groups = new Map();
    for (const d of items) {
      const key = String(d?.status || 'Preparing');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    const known = DECISION_STATUS_ORDER.filter((s) => groups.has(s));
    const drifted = [...groups.keys()].filter((s) => !DECISION_STATUS_ORDER.includes(s)).sort();
    return new Map([...known, ...drifted].map((s) => [s, sortByUrgency(groups.get(s))]));
  }, [items]);

  /** How many decisions are actually sitting on the CEO's desk right now. */
  const ceoQueueCount = useMemo(
    () => items.filter((d) => CEO_QUEUE_STATUSES.includes(String(d?.status))).length,
    [items],
  );

  const financialImpact = useMemo(
    () => items.reduce((sum, d) => sum + (Number(d?.financialImpact) || 0), 0),
    [items],
  );

  return {
    decisions: items,
    loading,
    error,
    loadedAt,
    refresh,
    create,
    update,
    remove,
    decide,
    guideTask,
    byStatus,
    ceoQueueCount,
    financialImpact,
  };
}

/** Priority first (P0 → P3), then the nearest deadline. Matches the web view. */
function sortByUrgency(list) {
  return [...(list || [])].sort((a, b) => {
    const pa = String(a?.priority || 'P2');
    const pb = String(b?.priority || 'P2');
    if (pa !== pb) return pa.localeCompare(pb);
    const da = a?.decisionDeadline || '9999-12-31';
    const db = b?.decisionDeadline || '9999-12-31';
    return String(da).localeCompare(String(db));
  });
}

export default useDecisions;
