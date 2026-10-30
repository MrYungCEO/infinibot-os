/**
 * usePersonWorkloads — derived capacity for a set of People (§18 Workload panel).
 *
 * `person.workload` is per-person by id because workload is DERIVED from the
 * typed-edge relations store, never stored on the record. There is no bulk
 * endpoint, so this hook fans out one call per person and returns a map.
 *
 * The fan-out is capped (`limit`, default 24). People are the humans in the
 * business, not the agent roster, so the real count is small — but the cap is
 * reported through `truncated` so a screen can say what it left out instead of
 * quietly showing a partial roster as if it were the whole one.
 *
 *   const { workloads, truncated } = usePersonWorkloads(sendReq, people);
 *   workloads[person.id]?.activeTaskCount
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export function usePersonWorkloads(sendReq, people, { limit = 24, enabled = true } = {}) {
  const [workloads, setWorkloads] = useState({});
  const [loading, setLoading] = useState(false);

  const ids = useMemo(
    () =>
      (Array.isArray(people) ? people : [])
        .map((p) => p?.id)
        .filter(Boolean)
        .slice(0, limit),
    [people, limit],
  );
  // Compare by identity of the id list, so a re-render with an equal array
  // doesn't refire N requests.
  const idsKey = useMemo(() => ids.join(','), [ids]);

  const total = Array.isArray(people) ? people.length : 0;
  const truncated = Math.max(0, total - ids.length);

  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!sendReq || !enabled || !idsKey) {
      setWorkloads({});
      return {};
    }
    const gen = ++generation.current;
    setLoading(true);

    const settled = await Promise.all(
      idsKey.split(',').map(async (id) => {
        try {
          return [id, await sendReq('person.workload', { id })];
        } catch {
          // A person whose workload can't be derived is simply absent from the
          // map — the panel renders them without a load rather than as zero.
          return [id, null];
        }
      }),
    );

    if (!mounted.current || gen !== generation.current) return {};

    const next = settled.reduce((acc, [id, w]) => (w ? { ...acc, [id]: w } : acc), {});
    setWorkloads(next);
    setLoading(false);
    return next;
  }, [sendReq, enabled, idsKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { workloads, loading, truncated, refresh };
}

export default usePersonWorkloads;
