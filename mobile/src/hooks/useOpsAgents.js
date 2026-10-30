/**
 * useOpsAgents — the three KIS Phase 1 operations agents (§19–§21).
 *
 *   opsagent.ceoBriefing    §19 Daily CEO Briefing      → { briefing }
 *   opsagent.monitor        §20 Operations Monitor      → { report } (exceptions)
 *   opsagent.projectHealth  §21 Project Health          → { report } (Green/Yellow/Red)
 *
 * All three are authority L1 — they observe and recommend, never mutate. They
 * are pure functions over a snapshot of the live stores, so this hook only ever
 * reads; there are no mutators by design.
 *
 * Each call is guarded independently: the RPCs land on the next gateway restart,
 * and until then each slice stays null and the screen shows an EmptyState that
 * says so. Nothing is ever synthesised to fill the gap.
 *
 *   const ops = useOpsAgents(gateway.sendReq);
 *   ops.briefing?.today.criticalBlockers
 *   ops.monitor?.groups
 *   ops.health?.projects
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const SOURCES = [
  { key: 'briefing', method: 'opsagent.ceoBriefing', pick: (r) => r?.briefing },
  { key: 'monitor', method: 'opsagent.monitor', pick: (r) => r?.report },
  { key: 'health', method: 'opsagent.projectHealth', pick: (r) => r?.report },
];

const EMPTY = { briefing: null, monitor: null, health: null };

export function useOpsAgents(sendReq, { enabled = true, auto = true } = {}) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [anyServed, setAnyServed] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);

  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!sendReq || !enabled) return EMPTY;
    const gen = ++generation.current;
    setLoading(true);

    const nextErrors = {};
    let served = false;

    const settled = await Promise.all(
      SOURCES.map(async (s) => {
        try {
          const res = await sendReq(s.method, {});
          served = true;
          return [s.key, s.pick(res) ?? null];
        } catch (err) {
          nextErrors[s.method] = err?.message || String(err);
          return [s.key, null];
        }
      }),
    );

    if (!mounted.current || gen !== generation.current) return EMPTY;

    const next = settled.reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
    setData(next);
    setErrors(nextErrors);
    setAnyServed((prev) => prev || served);
    setLoadedAt(Date.now());
    setLoading(false);
    return next;
  }, [sendReq, enabled]);

  useEffect(() => {
    if (auto) refresh();
  }, [auto, refresh]);

  /**
   * Why a slice is missing, phrased for an EmptyState. Null when everything the
   * caller asked about answered.
   */
  const reasonFor = useCallback(
    (key) => {
      const src = SOURCES.find((s) => s.key === key);
      if (!src) return null;
      const err = errors[src.method];
      if (!err) return null;
      return anyServed
        ? `${src.method} is unavailable: ${err}`
        : `${src.method} lands on the next gateway restart. Nothing is shown until it serves real data.`;
    },
    [errors, anyServed],
  );

  const unavailableReason = useMemo(() => {
    const failed = Object.keys(errors);
    if (!failed.length) return null;
    if (!anyServed) {
      return 'The operations agents are not being served yet — restart the gateway to enable them.';
    }
    return `${failed.length} of ${SOURCES.length} operations agents are unavailable.`;
  }, [errors, anyServed]);

  return { ...data, loading, errors, anyServed, loadedAt, reasonFor, unavailableReason, refresh };
}

export default useOpsAgents;
