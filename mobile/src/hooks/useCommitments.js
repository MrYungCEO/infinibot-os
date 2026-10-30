/**
 * useCommitments — KIS Object 8 (Financial Commitments).
 *
 * Two reads, not one: the ledger (`commitment.list`) and the money surfaces
 * (`commitment.aggregates`). The aggregates are computed server-side — money
 * expected / owed / overdue, deposits not received, and the
 * work-proceeding-without-payment exception — so they are NEVER re-derived from
 * the client list. Re-deriving them would drift from the spec's definitions the
 * moment a status or type is added.
 *
 * RPCs: commitment.list · search · get · aggregates · create · update · delete
 * (src/gateway/server-methods/commitment.ts)
 */

import { useCallback, useMemo } from 'react';

import { useGatewayResource } from './useGatewayResource';
import { COMMITMENT_STATUSES, isMoneyIn } from '../kis/vocab';

const selectCommitments = (res) => res?.commitments ?? (Array.isArray(res) ? res : []);
// Aggregates come back as the bare object, so identity is the correct selector.
const selectAggregates = (res) => res ?? null;

export function useCommitments(sendReq, params) {
  const { items, loading, error, loadedAt, refresh, mutate } = useGatewayResource(sendReq, {
    method: 'commitment.list',
    params,
    select: selectCommitments,
  });

  // Narrowed by the same params as list(), per the gateway's contract.
  const {
    items: aggregates,
    loading: aggregatesLoading,
    error: aggregatesError,
    refresh: refreshAggregates,
  } = useGatewayResource(sendReq, {
    method: 'commitment.aggregates',
    params,
    select: selectAggregates,
    initial: null,
  });

  /** Refresh both surfaces together — a write moves the ledger AND the totals. */
  const refreshAll = useCallback(async () => {
    const [list] = await Promise.all([refresh(), refreshAggregates()]);
    return list;
  }, [refresh, refreshAggregates]);

  const create = useCallback(
    async (draft) => {
      const res = await mutate('commitment.create', draft);
      await refreshAggregates();
      return res;
    },
    [mutate, refreshAggregates],
  );

  const update = useCallback(
    async (id, patch) => {
      const res = await mutate(
        'commitment.update',
        { id, ...patch },
        { optimistic: (list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)) },
      );
      await refreshAggregates();
      return res;
    },
    [mutate, refreshAggregates],
  );

  const remove = useCallback(
    async (id) => {
      const res = await mutate(
        'commitment.delete',
        { id },
        { optimistic: (list) => list.filter((c) => c.id !== id) },
      );
      await refreshAggregates();
      return res;
    },
    [mutate, refreshAggregates],
  );

  /**
   * Record a payment. `remainingBalance`, `overdue` and the Paid/Partially Paid
   * status are all derived by the store from amountPaid vs amount, so only
   * amountPaid is written.
   */
  const recordPayment = useCallback((id, amountPaid) => update(id, { amountPaid }), [update]);

  /** Money In / Money Out ledger split — the two sides of the register. */
  const moneyIn = useMemo(() => items.filter(isMoneyIn), [items]);
  const moneyOut = useMemo(() => items.filter((c) => !isMoneyIn(c)), [items]);

  /** Overdue first — `overdue` is a derived field on the record, not a guess. */
  const overdue = useMemo(
    () =>
      items
        .filter((c) => c?.overdue)
        .sort((a, b) => String(a?.dueDate || '').localeCompare(String(b?.dueDate || ''))),
    [items],
  );

  const byStatus = useMemo(() => {
    const groups = new Map();
    for (const status of COMMITMENT_STATUSES) groups.set(status, []);
    for (const c of items) {
      const key = COMMITMENT_STATUSES.includes(c?.status) ? c.status : 'Expected';
      groups.get(key).push(c);
    }
    return groups;
  }, [items]);

  return {
    commitments: items,
    aggregates,
    aggregatesLoading,
    aggregatesError,
    loading,
    error,
    loadedAt,
    refresh: refreshAll,
    refreshLedger: refresh,
    refreshAggregates,
    create,
    update,
    remove,
    recordPayment,
    moneyIn,
    moneyOut,
    overdue,
    byStatus,
  };
}

export default useCommitments;
