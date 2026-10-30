/**
 * useOpportunities — KIS Object 2 (Opportunity Pipeline).
 *
 * Mirrors useKanban.js's contract as mandated by MASTER §11 step 2: takes
 * `sendReq` (never the whole gateway), owns its own loading/error, and returns
 * loaders plus mutators. The generalised useGatewayResource does the stale-
 * response guard and — importantly here — degrades an unregistered RPC to
 * `error` + empty items, because `opportunity.*` only starts being served after
 * the next gateway restart.
 *
 * RPCs: opportunity.list · search · get · create · update · delete · convert
 * (src/gateway/server-methods/opportunity.ts)
 */

import { useCallback, useMemo } from 'react';

import { useGatewayResource } from './useGatewayResource';
import { PIPELINE_STAGES, TERMINAL_STAGES } from '../kis/vocab';

// Module-level so it is referentially stable across renders — useGatewayResource
// puts `select` in its refresh dependency list.
const selectOpportunities = (res) => res?.opportunities ?? (Array.isArray(res) ? res : []);

export function useOpportunities(sendReq, params) {
  const { items, loading, error, loadedAt, refresh, mutate } = useGatewayResource(sendReq, {
    method: 'opportunity.list',
    params,
    select: selectOpportunities,
  });

  const create = useCallback(
    (draft) => mutate('opportunity.create', draft),
    [mutate],
  );

  const update = useCallback(
    (id, patch) =>
      mutate(
        'opportunity.update',
        { id, ...patch },
        { optimistic: (list) => list.map((o) => (o.id === id ? { ...o, ...patch } : o)) },
      ),
    [mutate],
  );

  const remove = useCallback(
    (id) =>
      mutate(
        'opportunity.delete',
        { id },
        { optimistic: (list) => list.filter((o) => o.id !== id) },
      ),
    [mutate],
  );

  /** Move a card between pipeline stages. The stage IS the primary state. */
  const moveStage = useCallback((id, stage) => update(id, { stage }), [update]);

  /**
   * §24: winning an opportunity does NOT auto-create a project. The gateway
   * requires a human-supplied projectId, so this only links an existing one.
   */
  const convert = useCallback(
    (id, projectId) => mutate('opportunity.convert', { id, projectId }),
    [mutate],
  );

  /** Stage → opportunities, in board-column order, terminal stages last. */
  const byStage = useMemo(() => {
    const groups = new Map();
    for (const stage of PIPELINE_STAGES) groups.set(stage, []);
    for (const opp of items) {
      const key = PIPELINE_STAGES.includes(opp?.stage) ? opp.stage : 'New';
      groups.get(key).push(opp);
    }
    return groups;
  }, [items]);

  /** Total estimatedValue of everything still in play (non-terminal stages). */
  const pipelineValue = useMemo(
    () =>
      items.reduce(
        (sum, o) => (TERMINAL_STAGES.includes(o?.stage) ? sum : sum + (Number(o?.estimatedValue) || 0)),
        0,
      ),
    [items],
  );

  const wonValue = useMemo(
    () =>
      items.reduce((sum, o) => (o?.stage === 'Won' ? sum + (Number(o?.estimatedValue) || 0) : sum), 0),
    [items],
  );

  /** Derived flags the store populates on list()/get() — never invented here. */
  const needsAction = useMemo(() => items.filter((o) => o?.needsAction), [items]);
  const stale = useMemo(() => items.filter((o) => o?.stale), [items]);

  return {
    opportunities: items,
    loading,
    error,
    loadedAt,
    refresh,
    create,
    update,
    remove,
    moveStage,
    convert,
    byStage,
    pipelineValue,
    wonValue,
    needsAction,
    stale,
  };
}

export default useOpportunities;
