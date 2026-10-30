/**
 * useAgentMesh — the Agent Mesh's live data, from the same gateway RPCs and
 * push events the web mesh uses:
 *
 *   agents/nodes   federation.status + sessions.list + subagents.list (snapshot,
 *                  reconcile every 10 s) and the live stream (subagent.*,
 *                  session.*, progress, agent tool stream, node.*)
 *                  — ui/src/ui/controllers/agency-data-bridge.ts
 *   review         review.threads.list / review.thread.get, verification.list
 *                  (60 s + after verification.completion), verification.screenshots.list,
 *                  events review.message / verification.* — lib/review-mesh/feed.ts
 *   review status  subagent_reviews_list (15 s) — agency-world-viz pollReviews
 *   holding zone   queue.list + queue.* events — queue-holding-zone.ts
 *   heatmap feeds  credits.recent / subagents.history (8 s, only while a
 *                  heatmap mode is on) — controllers/world-feeds.ts
 *   plugin rooms   plugins.list (the app's plugin store)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { MESH_EVENTS, MESH_SNAPSHOT_RPCS, MeshStore, RESTING_STORAGE_KEY, buildMeshState, parseRestingJson } from '../lib/mesh/mesh-data';
import { HudStatsTracker, ThreadStore, mergeScreenshots } from '../lib/mesh/web-mesh.generated';
import { PACKET_MS, packetFromMessage } from '../lib/mesh/motion';
import { getPluginList, refreshPlugins, subscribePlugins } from '../plugins/plugin-store';
import { OWNER_DECISION_EVENTS, resolveOwnerDecision } from '../lib/mesh/owner-decisions';

const RECONCILE_MS = 10_000;
const REVIEW_POLL_MS = 15_000;
const VERIFICATION_POLL_MS = 60_000;
const FEEDS_POLL_MS = 8_000;
const QUEUE_EVENTS = ['queue.enqueued', 'queue.phase_started', 'queue.phase_completed', 'queue.blocked', 'queue.done', 'queue.failed', 'queue.canceled', 'queue.changed'];
const QUEUE_DROP = new Set(['done', 'canceled', 'cancelled', 'failed']);

function arr(v, ...keys) {
  for (const k of keys) if (Array.isArray(v?.[k])) return v[k];
  return Array.isArray(v) ? v : [];
}

export function useAgentMesh(gateway, { heatmap = null } = {}) {
  const connected = gateway?.status === 'connected';
  const sendReq = gateway?.sendReq;
  const subscribeEvent = gateway?.subscribeEvent;
  const storeRef = useRef(null);
  if (!storeRef.current) {
    storeRef.current = new MeshStore({
      onRestingChange: (json) => { AsyncStorage.setItem(RESTING_STORAGE_KEY, json).catch(() => {}); },
    });
  }
  const hudRef = useRef(new HudStatsTracker());
  const threadsRef = useRef(new ThreadStore(60, 200));
  const lastToolBeat = useRef(0);
  const packetsRef = useRef([]);
  const eventCount = useRef({ received: 0, applied: 0, topics: {} });

  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [plugins, setPlugins] = useState(() => getPluginList());
  const [completed, setCompleted] = useState([]);
  const [screenshots, setScreenshots] = useState([]);
  const [screenshotTotal, setScreenshotTotal] = useState(0);
  const [threadsVersion, setThreadsVersion] = useState(0);
  const [reviews, setReviews] = useState(() => new Map());
  const [queue, setQueue] = useState([]);
  const [feeds, setFeeds] = useState({ burn: {}, failure: {} });
  const [decisions, setDecisions] = useState([]);
  const [decisionError, setDecisionError] = useState(null);

  // Coalesce bursts of events into one render.
  const bumpTimer = useRef(null);
  const bump = useCallback(() => {
    if (bumpTimer.current) return;
    bumpTimer.current = setTimeout(() => {
      bumpTimer.current = null;
      const s = storeRef.current;
      // Tool beats → TOOLS / MIN.
      for (const b of s.toolBeats) if (b.at > lastToolBeat.current) hudRef.current.noteTool(b.at);
      if (s.toolBeats.length) lastToolBeat.current = s.toolBeats[s.toolBeats.length - 1].at;
      setVersion((n) => n + 1);
    }, 120);
  }, []);
  useEffect(() => () => bumpTimer.current && clearTimeout(bumpTimer.current), []);

  // Resting ring from storage (the web keeps it in localStorage).
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(RESTING_STORAGE_KEY).then((json) => {
      if (!alive) return;
      const list = parseRestingJson(json);
      if (list.length && storeRef.current.resting.length === 0) {
        storeRef.current.resting = list;
        bump();
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [bump]);

  // ── Agents / nodes: snapshot + 10 s reconcile ────────────────────────────
  const fetchState = useCallback(async () => {
    if (!sendReq) return;
    try {
      const [fed, sess, sub] = await Promise.all(MESH_SNAPSHOT_RPCS.map(([m, p]) => sendReq(m, p).catch(() => ({}))));
      storeRef.current.applySnapshot(buildMeshState(fed, sess, sub));
      setLoaded(true);
      setError(null);
      bump();
    } catch (e) {
      setError(e?.message || 'Could not load the agent mesh.');
    }
  }, [sendReq, bump]);

  useEffect(() => {
    if (!connected) return undefined;
    fetchState();
    const t = setInterval(fetchState, RECONCILE_MS);
    return () => clearInterval(t);
  }, [connected, fetchState]);

  useEffect(() => {
    if (!connected || !subscribeEvent) return undefined;
    const offs = MESH_EVENTS.map((ev) => subscribeEvent(ev, (payload) => {
      const c = eventCount.current;
      c.received += 1;
      c.topics[ev] = (c.topics[ev] || 0) + 1;
      if (storeRef.current.applyEvent(ev, payload)) {
        c.applied += 1;
        bump();
      }
    }));
    return () => offs.forEach((off) => { try { off?.(); } catch { /* gone */ } });
  }, [connected, subscribeEvent, bump]);

  // ── Plugin rooms ─────────────────────────────────────────────────────────
  useEffect(() => subscribePlugins((st) => setPlugins(st.list)), []);
  useEffect(() => {
    if (connected && sendReq && !getPluginList()) refreshPlugins(sendReq).catch(() => {});
  }, [connected, sendReq]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Review feed ──────────────────────────────────────────────────────────
  const loadThreads = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('review.threads.list', { limit: 30 });
      threadsRef.current.setSummaries(arr(res, 'threads'));
      setThreadsVersion((n) => n + 1);
    } catch { /* older gateway */ }
  }, [sendReq]);
  const loadCompleted = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('verification.list', { limit: 80 });
      setCompleted(arr(res, 'records'));
    } catch { /* older gateway */ }
  }, [sendReq]);
  const loadScreenshots = useCallback(async (params = {}) => {
    if (!sendReq) return { items: [], total: 0 };
    try {
      const res = await sendReq('verification.screenshots.list', { limit: 48, ...params });
      const items = arr(res, 'items');
      if (!params.runId && !params.cursor) {
        setScreenshots((prev) => mergeScreenshots(prev, items));
        if (Number.isFinite(res?.total)) setScreenshotTotal(res.total);
      }
      return { items, total: res?.total ?? items.length, nextCursor: res?.nextCursor ?? null };
    } catch {
      return { items: [], total: 0 };
    }
  }, [sendReq]);
  const loadThread = useCallback(async (runId) => {
    if (!sendReq || !runId) return null;
    try {
      const t = await sendReq('review.thread.get', { runId });
      if (t?.summary) {
        threadsRef.current.setThread(t);
        setThreadsVersion((n) => n + 1);
      }
      return threadsRef.current.get(runId) || t || null;
    } catch {
      return threadsRef.current.get(runId) || null;
    }
  }, [sendReq]);
  const loadReviews = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('subagent_reviews_list', { limit: 50 });
      const rows = arr(res, 'reviews', 'items', 'rows');
      const m = new Map();
      for (const r of rows) {
        const k = r.sessionKey || r.session_key || r.childSessionKey || r.runId || r.run_id;
        if (k && !m.has(k)) m.set(k, r);
      }
      setReviews(m);
    } catch { /* not available */ }
  }, [sendReq]);

  useEffect(() => {
    if (!connected) return undefined;
    loadThreads();
    loadCompleted();
    loadScreenshots();
    loadReviews();
    const t1 = setInterval(loadCompleted, VERIFICATION_POLL_MS);
    const t2 = setInterval(loadReviews, REVIEW_POLL_MS);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [connected, loadThreads, loadCompleted, loadScreenshots, loadReviews]);

  useEffect(() => {
    if (!connected || !subscribeEvent) return undefined;
    let later = null;
    const offs = [
      subscribeEvent('review.message', (p) => {
        if (p?.message) {
          threadsRef.current.ingest(p);
          const pk = packetFromMessage(p.message);
          if (pk) packetsRef.current = [...packetsRef.current.filter((x) => Date.now() - x.born < PACKET_MS), pk].slice(-24);
        }
        else if (p?.summary) threadsRef.current.setSummaries([p.summary]);
        setThreadsVersion((n) => n + 1);
      }),
      subscribeEvent('verification.completion', () => {
        if (later) clearTimeout(later);
        later = setTimeout(loadCompleted, 800);
      }),
      subscribeEvent('verification.screenshots', (p) => {
        const items = arr(p, 'items');
        if (items.length) {
          setScreenshots((prev) => mergeScreenshots(prev, items));
          setScreenshotTotal((n) => n + items.length);
        }
      }),
      ...QUEUE_EVENTS.map((ev) => subscribeEvent(ev, () => loadQueueRef.current?.())),
    ];
    return () => { if (later) clearTimeout(later); offs.forEach((off) => { try { off?.(); } catch { /* gone */ } }); };
  }, [connected, subscribeEvent, loadCompleted]);

  // ── Owner decisions: one aggregate read, existing source events ─────────
  const loadDecisions = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('owner.decisions.list', { limit: 200 });
      setDecisions(arr(res, 'decisions'));
      setDecisionError(null);
    } catch (e) {
      setDecisionError(e?.message || String(e));
    }
  }, [sendReq]);
  useEffect(() => {
    if (!connected) return undefined;
    loadDecisions();
    const timer = setInterval(loadDecisions, 12_000);
    return () => clearInterval(timer);
  }, [connected, loadDecisions]);
  useEffect(() => {
    if (!connected || !subscribeEvent) return undefined;
    let timer = null;
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(loadDecisions, 180);
    };
    const offs = OWNER_DECISION_EVENTS.map((event) => subscribeEvent(event, later));
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => { try { off?.(); } catch {} });
    };
  }, [connected, subscribeEvent, loadDecisions]);

  // ── Holding zone ─────────────────────────────────────────────────────────
  const loadQueue = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('queue.list', {});
      setQueue(arr(res, 'entries').filter((e) => !QUEUE_DROP.has(String(e?.status || '').toLowerCase())));
    } catch { /* no queue */ }
  }, [sendReq]);
  const loadQueueRef = useRef(loadQueue);
  loadQueueRef.current = loadQueue;
  useEffect(() => { if (connected) loadQueue(); }, [connected, loadQueue]);

  // ── Heatmap feeds (only while a heatmap mode is on) ──────────────────────
  useEffect(() => {
    if (!connected || !sendReq || !heatmap) return undefined;
    let alive = true;
    const pull = async () => {
      const [credits, hist] = await Promise.all([
        sendReq('credits.recent', { limit: 300 }).catch(() => null),
        sendReq('subagents.history', { limit: 200 }).catch(() => null),
      ]);
      if (!alive) return;
      const burn = {};
      for (const e of arr(credits, 'entries')) if (e?.sessionKey) burn[e.sessionKey] = (burn[e.sessionKey] || 0) + (Number(e.costUsd) || 0);
      const failure = {};
      for (const h of arr(hist, 'history')) {
        if (h?.sessionKey && (h.status === 'error' || h.status === 'timeout')) failure[h.sessionKey] = (failure[h.sessionKey] || 0) + 1;
      }
      setFeeds({ burn, failure });
    };
    pull();
    const t = setInterval(pull, FEEDS_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [connected, sendReq, heatmap]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const pluginRows = useMemo(() => (Array.isArray(plugins?.plugins) ? plugins.plugins : Array.isArray(plugins) ? plugins : []), [plugins]);
  const agents = useMemo(() => storeRef.current.listAgents(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const nodes = useMemo(() => storeRef.current.listNodes(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const tools = useMemo(() => {
    const m = new Map();
    for (const b of storeRef.current.toolBeats) m.set(b.sessionKey, { kind: b.kind, label: b.label, at: b.at });
    return m;
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const hud = useMemo(() => {
    const now = Date.now();
    const live = storeRef.current.listAgents().filter((a) => !a.resting);
    hudRef.current.noteTokens(live, now);
    return hudRef.current.compute(live, now);
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  // HUD refresh every second (TOOLS / MIN decays).
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const hudNow = useMemo(() => {
    const live = storeRef.current.listAgents().filter((a) => !a.resting);
    return hudRef.current.compute(live, Date.now());
  });

  // ── Actions (same RPCs + params as the web card / radial / review menu) ──
  const req = useCallback((m, p) => (sendReq ? sendReq(m, p) : Promise.reject(new Error('Not connected'))), [sendReq]);
  const actions = useMemo(() => ({
    message: (a, text) => (a.runId && (a.sessionKey.includes(':subagent:') || a.runId)
      ? req('subagents.message', { runId: a.runId, message: text })
      : req('chat.send', { sessionKey: a.sessionKey, message: text, idempotencyKey: `mesh-hover-${Date.now().toString(36)}` })),
    stop: (a) => (a.runId ? req('subagents.stop', { runId: a.runId }) : req('agent.abort', { sessionKey: a.sessionKey })),
    resume: (a) => req('sessions.resume', { runId: a.runId, sessionKey: a.sessionKey }),
    pause: (a) => req('sessions.pause', { runId: a.runId, sessionKey: a.sessionKey }),
    respawn: (a) => (a.runId ? req('subagents.respawn', { runId: a.runId }) : Promise.reject(new Error('This agent has no run to respawn.'))),
    send: (a, text) => req('sessions.send', { runId: a.runId, sessionKey: a.sessionKey, message: text }),
    /** Drag-to-assign (world-interactions/drag-assign.ts): any {method, params} the web fires. */
    rpc: (method, params) => req(method, params),
    spawnReviewPasses: (a, n = 3) => {
      const runId = a.runId ?? a.sessionKey;
      const ANGLES = ['correctness', 'security', 'UX & usability'];
      return Promise.all(Array.from({ length: Math.min(n, ANGLES.length) }, (_, i) => req('sessions.spawn', {
        task: `Independently review sub-agent run ${runId} from the ${ANGLES[i]} angle. Check quality, edge cases, and correctness. Return findings as structured JSON.`,
        agentId: 'coder',
        label: `Review · ${ANGLES[i]} · ${String(runId).slice(0, 8)}`,
      }).catch(() => null)));
    },
    forceReview: (a) => req('subagent_review_force', { runId: a.runId ?? a.sessionKey }).then((r) => { setTimeout(loadReviews, 2000); return r; }),
    bulkReview: (n = 5) => {
      const done = storeRef.current.listAgents().filter((a) => a.status === 'completed' && !reviews.has(a.sessionKey)).slice(-n);
      return Promise.all(done.map((a) => req('subagent_review_force', { runId: a.runId ?? a.sessionKey }).catch(() => null))).then(() => setTimeout(loadReviews, 2000));
    },
    decide: async (decision, action, reply) => {
      const result = await resolveOwnerDecision(sendReq, decision, action, reply);
      setDecisions((rows) => rows.filter((row) => row.id !== decision.id));
      setTimeout(loadDecisions, 500);
      return result;
    },
  }), [req, sendReq, loadReviews, loadDecisions, reviews]);

  return {
    connected, loaded, error, version,
    agents, nodes, tools,
    // plugins.list rows (rooms) + the store's raw list object (deep links).
    plugins: pluginRows,
    pluginList: plugins,
    hud: hudNow || hud,
    completed, screenshots, screenshotTotal,
    threads: threadsRef.current, threadsVersion, loadThread, loadScreenshots,
    reviews, queue, feeds, decisions, decisionError, refreshDecisions: loadDecisions,
    refresh: fetchState,
    packets: () => packetsRef.current,
    /** The web bridge's WorldEvent queue (camera directors drain it each FX tick). */
    drainWorldEvents: () => storeRef.current.drainWorldEvents(),
    /** Verification: queue bridge WorldEvents as if the gateway had pushed them. */
    injectWorldEvents: (events) => { for (const e of events || []) storeRef.current.emit(e); return (events || []).length; },
    /** Verification: apply a gateway event (topic + payload) through the real store path. */
    injectEvent: (topic, payload) => { const ok = storeRef.current.applyEvent(topic, payload); if (ok) bump(); return !!ok; },
    /** Verification: inject a packet as if a review.message arrived. */
    pushPacket: (msg) => { const pk = packetFromMessage(msg); if (pk) packetsRef.current = [...packetsRef.current, pk]; return !!pk; },
    eventStats: () => ({ ...eventCount.current, topics: { ...eventCount.current.topics } }),
    actions,
  };
}
