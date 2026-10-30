/**
 * useGatewayResource — the canonical gateway-RPC hook shape.
 *
 * Every data hook in the app follows the same contract (see useKanban.js for
 * the original hand-written version this generalises):
 *
 *   const { items, loading, error, refresh, mutate } =
 *     useGatewayResource(gateway.sendReq, {
 *       method: 'opportunity.list',
 *       params: { stage },
 *       select: (res) => res?.opportunities ?? res ?? [],
 *     });
 *
 * Why a shared hook rather than 20 hand-rolled ones:
 *   · one loading/error state shape, so every screen's Skeleton/EmptyState
 *     wiring is identical
 *   · `sendReq` is the ONLY gateway dependency — hooks stay testable and
 *     screens keep receiving `gateway` as a prop (the app's existing pattern)
 *   · a stale response from a superseded request can never overwrite a newer
 *     one (request generation guard)
 *   · a missing/unregistered RPC degrades to `error` + empty items instead of
 *     an unhandled rejection — gateway methods routinely need a restart
 *     before they exist, and screens must not white-screen in the meantime
 *
 * Options
 *   method    string     the RPC name
 *   params    object     request params; a change re-fetches (compared by
 *                        JSON identity, so inline object literals are fine)
 *   select    fn         response → items. Default: the response itself.
 *   enabled   boolean    skip fetching when false (default true)
 *   auto      boolean    fetch on mount / when params change (default true)
 *   fallback  fn         async () => items, tried when `method` fails. Use for
 *                        the snapshot/legacy path (see useKanban's kanban.*
 *                        fallback behind notion.*).
 *   initial   any        initial items value (default [])
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export function useGatewayResource(sendReq, options = {}) {
  const {
    method,
    params,
    select,
    enabled = true,
    auto = true,
    fallback,
    initial = [],
  } = options;

  const [items, setItems] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(0);

  // Serialize params so an inline object literal doesn't refetch every render.
  const paramsKey = useMemo(() => JSON.stringify(params ?? {}), [params]);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (overrideParams) => {
      if (!sendReq || !method || !enabled) return initial;
      const gen = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const res = await sendReq(method, overrideParams ?? JSON.parse(paramsKey));
        if (!mounted.current || gen !== generation.current) return initial;
        const next = select ? select(res) : res;
        setItems(next);
        setLoadedAt(Date.now());
        return next;
      } catch (err) {
        if (!mounted.current || gen !== generation.current) return initial;
        if (fallback) {
          try {
            const next = await fallback();
            if (!mounted.current || gen !== generation.current) return initial;
            setItems(next);
            setLoadedAt(Date.now());
            return next;
          } catch {
            /* fall through to the original error */
          }
        }
        setError(err?.message || String(err));
        return initial;
      } finally {
        if (mounted.current && gen === generation.current) setLoading(false);
      }
    },
    // `initial` is intentionally excluded — it is a default, not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendReq, method, paramsKey, enabled, select, fallback],
  );

  useEffect(() => {
    if (auto) refresh();
  }, [auto, refresh]);

  /**
   * mutate — fire a write RPC then refresh. Applies `optimistic(items)` first
   * so the row moves immediately, and rolls back if the write throws.
   */
  const mutate = useCallback(
    async (writeMethod, writeParams, { optimistic, refreshAfter = true } = {}) => {
      if (!sendReq) throw new Error('Gateway not connected');
      const snapshot = items;
      if (optimistic) setItems(optimistic(items));
      try {
        const res = await sendReq(writeMethod, writeParams);
        if (refreshAfter) await refresh();
        return res;
      } catch (err) {
        if (optimistic && mounted.current) setItems(snapshot);
        throw err;
      }
    },
    [sendReq, items, refresh],
  );

  return { items, setItems, loading, error, loadedAt, refresh, mutate };
}

/**
 * useGatewayEvent — subscribe to a gateway broadcast for the lifetime of a
 * screen. Pair with useGatewayResource's `refresh` to keep a list live:
 *
 *   useGatewayEvent(gateway.subscribeEvent, 'kanban:changed', refresh);
 */
export function useGatewayEvent(subscribeEvent, event, handler) {
  const saved = useRef(handler);
  useEffect(() => {
    saved.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!subscribeEvent || !event) return undefined;
    const unsub = subscribeEvent(event, (payload) => saved.current?.(payload));
    return () => unsub?.();
  }, [subscribeEvent, event]);
}

export default useGatewayResource;
