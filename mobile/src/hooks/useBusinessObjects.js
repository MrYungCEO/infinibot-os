/**
 * useBusinessObjects — the KIS Phase 1 object stores, loaded in one pass.
 *
 * The React Native counterpart of `ui/src/ui/controllers/business-hq-objects.ts`.
 * The Executive (§15) and Operations (§18) Command Centers both need the same
 * eight live slices, so they share one hook rather than each opening its own
 * eight sockets.
 *
 * Every RPC is guarded INDEPENDENTLY. The `*.list` methods only respond once the
 * gateway has been restarted to serve them, so a pre-restart gateway simply
 * leaves that slice empty and the screen renders a labelled EmptyState — never a
 * crash, never fabricated rows. `anyServed` is true as soon as one call answers,
 * which is how the screens tell "the org is genuinely clean" apart from "the
 * gateway hasn't been restarted yet".
 *
 *   const O = useBusinessObjects(gateway.sendReq);
 *   O.ceoDecisions   // decision.ceoQueue({ triggerFiltered: true }), §16-gated
 *   O.risks          // risk.list
 *   O.refresh()
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * One entry per slice. `pick` unwraps the gateway envelope; each handler
 * responds with a named collection (`{ decisions, count }`), so a bare array
 * fallback keeps us honest against a handler that changes its shape.
 */
const SOURCES = [
  { key: 'opportunities', method: 'opportunity.list', params: {}, pick: (r) => r?.opportunities },
  { key: 'products', method: 'product.list', params: {}, pick: (r) => r?.products },
  { key: 'decisions', method: 'decision.list', params: {}, pick: (r) => r?.decisions },
  // §16: the trigger-gated CEO queue. The store applies the CEO Decision
  // Trigger gate server-side and enriches each row with its inferred
  // `ceoTriggers`, so the app never has to re-implement the trigger engine.
  {
    key: 'ceoDecisions',
    method: 'decision.ceoQueue',
    params: { triggerFiltered: true },
    pick: (r) => r?.decisions,
  },
  { key: 'risks', method: 'risk.list', params: {}, pick: (r) => r?.risks },
  { key: 'commitments', method: 'commitment.list', params: {}, pick: (r) => r?.commitments },
  { key: 'people', method: 'person.list', params: {}, pick: (r) => r?.people },
  { key: 'clients', method: 'clients.list', params: { pageSize: 500 }, pick: (r) => r?.clients },
];

const EMPTY = SOURCES.reduce((acc, s) => ({ ...acc, [s.key]: [] }), {});

export function useBusinessObjects(sendReq, { enabled = true, auto = true } = {}) {
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
          const res = await sendReq(s.method, s.params);
          served = true;
          const picked = s.pick(res);
          return [s.key, Array.isArray(picked) ? picked : Array.isArray(res) ? res : []];
        } catch (err) {
          nextErrors[s.method] = err?.message || String(err);
          return [s.key, []];
        }
      }),
    );

    // A superseded request must never overwrite a newer one.
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

  /** Human-readable reason the slices are empty, or null when they're genuine. */
  const unavailableReason = useMemo(() => {
    const failed = Object.keys(errors);
    if (!failed.length) return null;
    if (!anyServed) {
      return 'The Phase 1 object stores are not being served yet — restart the gateway to enable them.';
    }
    return `${failed.length} of ${SOURCES.length} object stores are unavailable (${failed.join(', ')}).`;
  }, [errors, anyServed]);

  return { ...data, loading, errors, anyServed, loadedAt, unavailableReason, refresh };
}

export default useBusinessObjects;
