/**
 * useRunReviews — data hook for the "Run reviews" sub-tab (parity with
 * ui/src/ui/views/reviews/index.ts + components/agent-run-review.ts).
 *
 *   agents.reviews.list({ limit, since? })      — every run's in-depth review
 *   agents.reviews.get({ runId } | { id })      — one review (deep link)
 *   agents.reviews.regenerateSummary({ id })    — rebuild the markdown summary
 *   forward actions (respawn / verify / open PR / follow-up) — see
 *   forwardActionPlan() in oversight-model.js
 *
 * Live: the web's lifecycle events + a 20 s poll.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RUN_REVIEW_FILTERS,
  applyRunReviewFilters,
  runReviewsFromList,
  runReviewFromResult,
  sinceFor,
  forwardActionPlan,
  isUnknownMethodError,
} from './oversight-model';
import { withTimeout } from '../../hooks/useOversight';

const POLL_MS = 20_000;
export const RUN_REVIEW_EVENTS = [
  'subagent.complete',
  'subagent.completed',
  'session.completed',
  'reviews:changed',
  'agents.reviews:changed',
  'review.ready',
];

export function useRunReviews(gateway, { active = true } = {}) {
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected' || !gateway?.status;
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [backendMissing, setBackendMissing] = useState(false);
  const [filters, setFilters] = useState(DEFAULT_RUN_REVIEW_FILTERS);
  const [regenerating, setRegenerating] = useState(() => new Set());
  const [actionBusy, setActionBusy] = useState(null); // `${runId}:${index}`
  const [lookup, setLookup] = useState({});
  const inflight = useRef(false);
  const timeRef = useRef(filters.time);
  timeRef.current = filters.time;

  const load = useCallback(async () => {
    if (!sendReq || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const since = sinceFor(timeRef.current);
      const res = await withTimeout(sendReq('agents.reviews.list', { limit: 200, ...(since ? { since } : {}) }), 20_000, 'reviews');
      const list = runReviewsFromList(res);
      setReviews((prev) => {
        // Keep deep-linked records that fell outside the list window.
        const ids = new Set(list.map((r) => r.runId));
        const pinned = prev.filter((r) => r._pinned && !ids.has(r.runId));
        return [...list, ...pinned];
      });
      setBackendMissing(false);
    } catch (e) {
      // Method not registered (older gateway) or transient: graceful empty state.
      if (isUnknownMethodError(e)) setBackendMissing(true);
    } finally {
      inflight.current = false;
      setLoading(false);
      setLoaded(true);
    }
  }, [sendReq]);

  useEffect(() => {
    if (!active || !connected) return;
    load();
  }, [active, connected, filters.time, load]);

  useEffect(() => {
    if (!active || !sendReq) return undefined;
    const id = setInterval(() => load(), POLL_MS);
    return () => clearInterval(id);
  }, [active, sendReq, load]);

  useEffect(() => {
    if (!active || typeof gateway?.subscribeEvent !== 'function') return undefined;
    let t = null;
    const kick = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => load(), 400);
    };
    const unsubs = RUN_REVIEW_EVENTS.map((ev) => gateway.subscribeEvent(ev, kick));
    return () => {
      if (t) clearTimeout(t);
      unsubs.forEach((u) => typeof u === 'function' && u());
    };
  }, [active, gateway, load]);

  const filtered = useMemo(() => applyRunReviewFilters(reviews, filters), [reviews, filters]);
  const setFilter = useCallback((k, v) => setFilters((f) => ({ ...f, [k]: v })), []);
  const clearFilters = useCallback(() => setFilters((f) => ({ ...f, search: '', status: 'all', project: '' })), []);

  const findReview = useCallback((runId) => reviews.find((r) => r.runId === runId || r.id === runId) || null, [reviews]);

  const ensureReview = useCallback(
    async (runId) => {
      if (!sendReq || !runId) return;
      if (reviews.some((r) => r.runId === runId || r.id === runId)) return;
      setLookup((l) => ({ ...l, [runId]: 'loading' }));
      try {
        const res = await withTimeout(sendReq('agents.reviews.get', { runId }), 20_000, 'review');
        const r = runReviewFromResult(res);
        if (r) {
          setReviews((prev) => [{ ...r, _pinned: true }, ...prev.filter((x) => x.runId !== r.runId)]);
          setLookup((l) => ({ ...l, [runId]: 'found' }));
        } else setLookup((l) => ({ ...l, [runId]: 'missing' }));
      } catch {
        setLookup((l) => ({ ...l, [runId]: 'missing' }));
      }
    },
    [sendReq, reviews],
  );

  const regenerate = useCallback(
    async (review) => {
      if (!sendReq || !review || regenerating.has(review.id)) return { ok: false };
      setRegenerating((s) => new Set(s).add(review.id));
      try {
        const res = await withTimeout(sendReq('agents.reviews.regenerateSummary', { id: review.id }), 120_000, 'summary');
        const updated = runReviewFromResult(res);
        if (!updated) return { ok: false, error: res?.error || 'Could not regenerate the summary' };
        setReviews((prev) => prev.map((r) => (r.id === updated.id ? { ...updated, _pinned: r._pinned } : r)));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      } finally {
        setRegenerating((s) => {
          const n = new Set(s);
          n.delete(review.id);
          return n;
        });
      }
    },
    [sendReq, regenerating],
  );

  /**
   * Dispatch one forward action. Returns { ok, note?, fallback? } — the screen
   * opens URLs and hands `fallback: 'chat'` follow-ups to the chat composer.
   */
  const runForward = useCallback(
    async (review, action, index) => {
      const plan = forwardActionPlan(review, action);
      if (plan.type === 'url') return { ok: true, url: plan.url };
      if (plan.type === 'none') return { ok: false, note: 'This action has no handler on the gateway yet.' };
      if (!sendReq) return { ok: false, note: 'Not connected' };
      const key = `${review.runId}:${index}`;
      setActionBusy(key);
      try {
        const res = await withTimeout(sendReq(plan.method, plan.params), 120_000, action.label || 'action');
        if (res && res.ok === false) return { ok: false, note: String(res.error || 'Action failed') };
        load();
        return { ok: true };
      } catch (e) {
        if (isUnknownMethodError(e) && plan.fallback) return { ok: false, fallback: plan.fallback };
        if (isUnknownMethodError(e)) return { ok: false, note: `Needs a gateway update (${plan.method}).` };
        return { ok: false, note: e?.message || String(e) };
      } finally {
        setActionBusy(null);
      }
    },
    [sendReq, load],
  );

  return {
    reviews,
    filtered,
    loading,
    loaded,
    backendMissing,
    filters,
    setFilter,
    clearFilters,
    load,
    findReview,
    ensureReview,
    lookup,
    regenerate,
    regenerating,
    runForward,
    actionBusy,
  };
}

export default useRunReviews;
