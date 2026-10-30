/**
 * useOversight — data hook for the "Oversight" sub-tab of the native Reviews
 * page (parity with ui/src/ui/views/oversight/index.ts).
 *
 * Same RPCs as the web view, verbatim:
 *   subagents.list({ includeCompleted, limit, updatesTail })  — live run spine
 *   subagents.history({ limit, since? })                      — archived runs
 *   subagent_reviews_list({ limit, since? })                  — review overlay
 *   subagent_review_get({ runId })                            — one review (deep link)
 *   subagent_review_force({ runId })                          — (re)generate review
 *   subagent_review_decide({ runId, decision })               — approve / send back
 *   oversight_sampler_run({ limit })                          — drift sampler pass
 *   verification.decide({ runId, action })                   — verdict actions
 *
 * Live updates: the web's lifecycle events + a 15 s safety poll + a 1 s tick
 * while any run is live (durations advance). Filters, expanded rows and
 * acknowledged next steps persist in AsyncStorage under the web's snapshot
 * shape ("oversight:v1"), so the page survives a relaunch like the web
 * survives a reload. All mapping lives in screens/oversight/oversight-model.js.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_OVERSIGHT_FILTERS,
  PERSIST_KEY,
  applyOversightFilters,
  buildEntries,
  rebuildOverlay,
  reviewFromResult,
  rpcFailure,
  sinceFor,
  countActiveOversightFilters,
  clearedOversightFilters,
  parsePersisted,
  filtersFromPersisted,
  ackedFromPersisted,
  toPersisted,
  toggleAck as toggleAckModel,
  entryFromReview,
  normalizeReviewShape,
} from '../screens/oversight/oversight-model';

const POLL_MS = 15_000;
const RPC_TIMEOUT_MS = 20_000;

export const OVERSIGHT_EVENTS = [
  'subagent.spawned',
  'subagent.complete',
  'subagent.error',
  'verification.completion',
  'subagent.timeout',
  'subagent.completed',
  'subagent:completed',
  'session.completed',
  'session:completed',
];

export function withTimeout(promise, ms = RPC_TIMEOUT_MS, label = 'request') {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

export function useOversight(gateway, { active = true } = {}) {
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected' || gateway?.connected === true || !gateway?.status;

  const [live, setLive] = useState([]);
  const [history, setHistory] = useState([]);
  const [overlay, setOverlay] = useState(() => new Map());
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const [filters, setFiltersState] = useState(DEFAULT_OVERSIGHT_FILTERS);
  const [acked, setAcked] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  const [persistedTab, setPersistedTab] = useState(null);
  const tabRef = useRef('reviews');

  const [forcing, setForcing] = useState(() => new Set());
  const [deciding, setDeciding] = useState(() => new Set());
  const decidingRef = useRef(new Set());
  const [samplerRunning, setSamplerRunning] = useState(false);
  const [samplerLastRunAt, setSamplerLastRunAt] = useState(0);
  const [verdictBusy, setVerdictBusy] = useState(null); // { runId, action }

  const inflightRef = useRef(false);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  // ── Persistence ──
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(PERSIST_KEY)
      .then((raw) => {
        if (!alive) return;
        const p = parsePersisted(raw);
        setFiltersState(filtersFromPersisted(p));
        setAcked(ackedFromPersisted(p));
        setExpanded(new Set(p.expandedIds));
        setPersistedTab(p.tab);
        tabRef.current = p.tab;
      })
      .catch(() => {})
      .finally(() => alive && setHydrated(true));
    return () => {
      alive = false;
    };
  }, []);

  const saveTimer = useRef(null);
  const persist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const snap = toPersisted(filtersRef.current, ackedRef.current, expandedRef.current, tabRef.current);
      AsyncStorage.setItem(PERSIST_KEY, JSON.stringify(snap)).catch(() => {});
    }, 150);
  }, []);
  const ackedRef = useRef(acked);
  ackedRef.current = acked;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    if (hydrated) persist();
  }, [hydrated, filters, acked, expanded, persist]);
  useEffect(() => () => saveTimer.current && clearTimeout(saveTimer.current), []);

  const rememberTab = useCallback(
    (tab) => {
      tabRef.current = tab;
      if (hydrated) persist();
    },
    [hydrated, persist],
  );

  // ── Load ──
  const load = useCallback(async () => {
    if (!sendReq || inflightRef.current) return;
    inflightRef.current = true;
    setLoading(true);
    const time = filtersRef.current.time;
    const since = sinceFor(time);
    try {
      const [rv, sl, hi] = await Promise.allSettled([
        withTimeout(sendReq('subagent_reviews_list', { limit: 200, ...(since ? { since } : {}) }), RPC_TIMEOUT_MS, 'reviews'),
        withTimeout(sendReq('subagents.list', { includeCompleted: true, limit: 100, updatesTail: 6 }), RPC_TIMEOUT_MS, 'runs'),
        withTimeout(sendReq('subagents.history', { limit: 300, ...(since ? { since } : {}) }), RPC_TIMEOUT_MS, 'history'),
      ]);
      if (rv.status === 'fulfilled') {
        const res = rv.value;
        const list = Array.isArray(res) ? res : Array.isArray(res?.reviews) ? res.reviews : [];
        setOverlay((prev) => rebuildOverlay(prev, list, decidingRef.current));
      }
      if (sl.status === 'fulfilled') {
        setLive(Array.isArray(sl.value?.subagents) ? sl.value.subagents : []);
      }
      if (hi.status === 'fulfilled') {
        setHistory(Array.isArray(hi.value?.history) ? hi.value.history : []);
      }
      if (sl.status === 'rejected' && hi.status === 'rejected') {
        setError(sl.reason?.message || String(sl.reason));
      } else {
        setError(null);
      }
      setNow(Date.now());
    } finally {
      inflightRef.current = false;
      setLoading(false);
      setLoaded(true);
    }
  }, [sendReq]);

  // Initial + whenever the server-side time window changes.
  useEffect(() => {
    if (!active || !hydrated || !connected) return;
    load();
  }, [active, hydrated, connected, filters.time, load]);

  // 15 s safety poll.
  useEffect(() => {
    if (!active || !sendReq) return undefined;
    const id = setInterval(() => load(), POLL_MS);
    return () => clearInterval(id);
  }, [active, sendReq, load]);

  // Lifecycle events → instant reload (debounced).
  useEffect(() => {
    if (!active || typeof gateway?.subscribeEvent !== 'function') return undefined;
    let t = null;
    const kick = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => load(), 400);
    };
    const unsubs = OVERSIGHT_EVENTS.map((ev) => gateway.subscribeEvent(ev, kick));
    return () => {
      if (t) clearTimeout(t);
      unsubs.forEach((u) => typeof u === 'function' && u());
    };
  }, [active, gateway, load]);

  const entries = useMemo(() => buildEntries(live, history, overlay, filters.time, now), [live, history, overlay, filters.time, now]);
  const hasRunning = useMemo(() => entries.some((e) => e.status === 'running'), [entries]);

  // 1 s tick so running durations advance between polls.
  useEffect(() => {
    if (!active || !hasRunning) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, hasRunning]);

  const filtered = useMemo(() => applyOversightFilters(entries, filters), [entries, filters]);
  const runningCount = useMemo(() => entries.filter((e) => e.status === 'running').length, [entries]);
  const activeFilterCount = useMemo(() => countActiveOversightFilters(filters), [filters]);

  const setFilter = useCallback((key, value) => setFiltersState((f) => ({ ...f, [key]: value })), []);
  const clearFilters = useCallback(() => setFiltersState((f) => clearedOversightFilters(f)), []);
  const resetAllFilters = useCallback(() => setFiltersState(DEFAULT_OVERSIGHT_FILTERS), []);

  const toggleExpanded = useCallback((runId) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(runId)) n.delete(runId);
      else n.add(runId);
      return n;
    });
  }, []);

  const toggleAck = useCallback((runId, index) => setAcked((a) => toggleAckModel(a, runId, index)), []);

  const patchOverlay = useCallback((runId, review) => {
    setOverlay((prev) => {
      const n = new Map(prev);
      if (review) n.set(runId, review);
      else n.delete(runId);
      return n;
    });
  }, []);

  // ── Detail lookup (deep link to a run that isn't in the spine) ──
  const [extra, setExtra] = useState({}); // runId → entry built from a review record
  const [lookup, setLookup] = useState({}); // runId → 'loading' | 'missing' | 'found'
  const ensureRun = useCallback(
    async (runId) => {
      if (!sendReq || !runId) return;
      setLookup((l) => ({ ...l, [runId]: 'loading' }));
      try {
        const res = await withTimeout(sendReq('subagent_review_get', { runId }), RPC_TIMEOUT_MS, 'review');
        const review = reviewFromResult(res);
        if (review) {
          if (!overlayRef.current.has(runId)) patchOverlay(runId, review);
          setExtra((x) => ({ ...x, [runId]: entryFromReview(review) }));
          setLookup((l) => ({ ...l, [runId]: 'found' }));
          return;
        }
        setLookup((l) => ({ ...l, [runId]: 'missing' }));
      } catch {
        setLookup((l) => ({ ...l, [runId]: 'missing' }));
      }
    },
    [sendReq, patchOverlay],
  );

  const findEntry = useCallback(
    (runId) => {
      if (!runId) return null;
      const e = entries.find((x) => x.runId === runId);
      if (e) return e;
      const fromAll = buildEntries(live, history, overlay, 'all', now).find((x) => x.runId === runId);
      if (fromAll) return fromAll;
      const x = extra[runId];
      if (!x) return null;
      const review = overlay.get(runId) || x.review;
      return { ...x, review };
    },
    [entries, live, history, overlay, now, extra],
  );

  // ── Actions ──
  const forceReview = useCallback(
    async (runId) => {
      if (!sendReq || !runId || forcing.has(runId)) return;
      setForcing((s) => new Set(s).add(runId));
      setActionError(null);
      try {
        const res = await withTimeout(sendReq('subagent_review_force', { runId }), 120_000, 'review');
        const fail = rpcFailure(res, 'Review failed');
        if (fail) throw new Error(fail);
        const updated = reviewFromResult(res);
        if (updated) patchOverlay(updated.runId || runId, updated);
      } catch (e) {
        setActionError(e?.message || String(e));
      } finally {
        setForcing((s) => {
          const n = new Set(s);
          n.delete(runId);
          return n;
        });
      }
    },
    [sendReq, forcing, patchOverlay],
  );

  const decide = useCallback(
    async (runId, decision) => {
      if (!sendReq || !runId || decidingRef.current.has(runId)) return;
      const prev = overlayRef.current.get(runId);
      if (!prev) return;
      decidingRef.current.add(runId);
      setDeciding(new Set(decidingRef.current));
      setActionError(null);
      patchOverlay(runId, { ...prev, decision, decidedAt: Date.now() });
      try {
        const res = await withTimeout(sendReq('subagent_review_decide', { runId, decision }), RPC_TIMEOUT_MS, 'decision');
        if (!res || res.ok === false) throw new Error(res?.error || 'decision rejected');
        const updated = res.review ? normalizeReviewShape(res.review) : null;
        if (updated) patchOverlay(runId, updated);
      } catch (e) {
        patchOverlay(runId, prev);
        setActionError(e?.message || String(e));
      } finally {
        decidingRef.current.delete(runId);
        setDeciding(new Set(decidingRef.current));
      }
    },
    [sendReq, patchOverlay],
  );

  const runSampler = useCallback(async () => {
    if (!sendReq || samplerRunning) return;
    setSamplerRunning(true);
    setActionError(null);
    try {
      const res = await withTimeout(sendReq('oversight_sampler_run', { limit: 8 }), 60_000, 'sampler');
      const fail = rpcFailure(res, 'Sampler failed');
      if (fail) throw new Error(fail);
      if (res?.sampledAt) setSamplerLastRunAt(res.sampledAt);
      await load();
    } catch (e) {
      setActionError(e?.message || String(e));
    } finally {
      setSamplerRunning(false);
    }
  }, [sendReq, samplerRunning, load]);

  const verdictDecide = useCallback(
    async (runId, action) => {
      if (!sendReq || !runId || verdictBusy) return { ok: false };
      setVerdictBusy({ runId, action });
      try {
        await withTimeout(sendReq('verification.decide', { runId, action }), 60_000, 'decision');
        await load();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      } finally {
        setVerdictBusy(null);
      }
    },
    [sendReq, verdictBusy, load],
  );

  return {
    entries,
    filtered,
    runningCount,
    loading,
    loaded,
    error,
    actionError,
    clearActionError: () => setActionError(null),
    now,
    hydrated,
    persistedTab,
    rememberTab,
    filters,
    setFilter,
    clearFilters,
    resetAllFilters,
    activeFilterCount,
    expanded,
    toggleExpanded,
    acked,
    toggleAck,
    forcing,
    deciding,
    samplerRunning,
    samplerLastRunAt,
    verdictBusy,
    load,
    ensureRun,
    lookup,
    findEntry,
    forceReview,
    decide,
    runSampler,
    verdictDecide,
  };
}

export default useOversight;
