/**
 * usePeople — KIS Object 9 (People / Resources).
 *
 * Workload is DERIVED, never stored on the person record: the gateway computes
 * it per person from the typed-edge graph (`person.workload`). So this hook does
 * a second pass after the roster loads, fetching one workload per person and
 * keeping them in a `{ [personId]: PersonWorkload }` map — the same shape the
 * web view's `personState.workloads` uses.
 *
 * A workload fetch that fails is skipped rather than fatal: the roster is still
 * useful without capacity numbers, and `person.workload` 404s for a record that
 * was deleted between the two calls.
 *
 * RPCs: person.list · search · get · workload · create · update · delete ·
 *       assignTask · unassignTask  (src/gateway/server-methods/person.ts)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useGatewayResource } from './useGatewayResource';
import { PERSON_RELATIONSHIP_TYPES } from '../kis/vocab';

const selectPeople = (res) => res?.people ?? (Array.isArray(res) ? res : []);

export function usePeople(sendReq, params) {
  const { items, loading, error, loadedAt, refresh, mutate } = useGatewayResource(sendReq, {
    method: 'person.list',
    params,
    select: selectPeople,
  });

  const [workloads, setWorkloads] = useState({});
  const [workloadsLoading, setWorkloadsLoading] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Only the ids matter for the workload pass — re-running on every unrelated
  // field edit would re-fetch N workloads for nothing.
  const idKey = useMemo(() => items.map((p) => p?.id).filter(Boolean).join(','), [items]);

  const loadWorkloads = useCallback(async () => {
    if (!sendReq) return;
    const ids = idKey ? idKey.split(',') : [];
    if (!ids.length) {
      setWorkloads({});
      return;
    }
    const gen = ++generation.current;
    setWorkloadsLoading(true);
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await sendReq('person.workload', { id })];
        } catch {
          return [id, null];
        }
      }),
    );
    if (!mounted.current || gen !== generation.current) return;
    const next = {};
    for (const [id, workload] of results) if (workload) next[id] = workload;
    setWorkloads(next);
    setWorkloadsLoading(false);
  }, [sendReq, idKey]);

  useEffect(() => {
    void loadWorkloads();
  }, [loadWorkloads]);

  const refreshAll = useCallback(async () => {
    const list = await refresh();
    await loadWorkloads();
    return list;
  }, [refresh, loadWorkloads]);

  const create = useCallback((draft) => mutate('person.create', draft), [mutate]);

  const update = useCallback(
    (id, patch) =>
      mutate(
        'person.update',
        { id, ...patch },
        { optimistic: (list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)) },
      ),
    [mutate],
  );

  const remove = useCallback(
    (id) => mutate('person.delete', { id }, { optimistic: (list) => list.filter((p) => p.id !== id) }),
    [mutate],
  );

  /** task_assigned_to_person edge — this is what workload counts. */
  const assignTask = useCallback(
    async (personId, taskId, status) => {
      const res = await mutate('person.assignTask', { personId, taskId, status });
      await loadWorkloads();
      return res;
    },
    [mutate, loadWorkloads],
  );

  const unassignTask = useCallback(
    async (personId, taskId) => {
      const res = await mutate('person.unassignTask', { personId, taskId });
      await loadWorkloads();
      return res;
    },
    [mutate, loadWorkloads],
  );

  const workloadFor = useCallback((id) => workloads[id] || null, [workloads]);

  /** Relationship type → people. Founders first, then employees/contractors. */
  const byRelationship = useMemo(() => {
    const groups = new Map();
    for (const rel of PERSON_RELATIONSHIP_TYPES) groups.set(rel, []);
    for (const p of items) {
      const key = PERSON_RELATIONSHIP_TYPES.includes(p?.relationshipType) ? p.relationshipType : 'Partner';
      groups.get(key).push(p);
    }
    return groups;
  }, [items]);

  /** Busiest first, by active task count. Unknown workload sorts last. */
  const byWorkload = useMemo(
    () =>
      [...items].sort(
        (a, b) =>
          (workloads[b?.id]?.activeTaskCount ?? -1) - (workloads[a?.id]?.activeTaskCount ?? -1),
      ),
    [items, workloads],
  );

  const activeCount = useMemo(
    () => items.filter((p) => String(p?.status) === 'Active').length,
    [items],
  );

  /** Total active assignments across the roster — the capacity headline. */
  const totalActiveTasks = useMemo(
    () => Object.values(workloads).reduce((sum, w) => sum + (Number(w?.activeTaskCount) || 0), 0),
    [workloads],
  );

  return {
    people: items,
    workloads,
    workloadsLoading,
    workloadFor,
    loading,
    error,
    loadedAt,
    refresh: refreshAll,
    refreshRoster: refresh,
    refreshWorkloads: loadWorkloads,
    create,
    update,
    remove,
    assignTask,
    unassignTask,
    byRelationship,
    byWorkload,
    activeCount,
    totalActiveTasks,
  };
}

export default usePeople;
