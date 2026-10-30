/**
 * useKnowledgeGraph — the web /knowledge-graph data on the phone.
 *
 * Calls the SAME RPC as ui/src/ui/components/knowledge-graph.ts:
 *   graph.global.snapshot({ types, refresh? }) → { nodes, edges, typeStats, hidden, insights }
 * The gateway caches a snapshot per `types` key for 5s; `refresh: true`
 * bypasses it (pull-to-refresh / after an edit).
 *
 * Filter prefs (layers, statuses, group mode) persist per device.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_KINDS, DEFAULT_STATUSES, FILTER_KINDS, STATUS_FILTERS, sanitizeSnapshot, snapshotTypes } from '../lib/kg-model';

const PREFS_KEY = '@infinibot/kg_prefs_v1';
const MODES = ['type', 'project', 'status'];

export const DEFAULT_PREFS = {
  kinds: [...DEFAULT_KINDS.filter((k) => FILTER_KINDS.includes(k)), 'research'],
  statuses: DEFAULT_STATUSES,
  mode: 'project',
};

function cleanPrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const kinds = Array.isArray(p.kinds) ? p.kinds.filter((k) => FILTER_KINDS.includes(k)) : DEFAULT_PREFS.kinds;
  const statusKeys = STATUS_FILTERS.map((s) => s.key);
  const statuses = Array.isArray(p.statuses) ? p.statuses.filter((s) => statusKeys.includes(s)) : DEFAULT_PREFS.statuses;
  return {
    kinds: kinds.length ? kinds : DEFAULT_PREFS.kinds,
    statuses: statuses.length ? statuses : DEFAULT_PREFS.statuses,
    mode: MODES.includes(p.mode) ? p.mode : DEFAULT_PREFS.mode,
  };
}

export function useKnowledgeGraph(gateway) {
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';
  const [prefs, setPrefsState] = useState(DEFAULT_PREFS);
  const [prefsReady, setPrefsReady] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(PREFS_KEY)
      .then((v) => { if (alive && v) setPrefsState(cleanPrefs(JSON.parse(v))); })
      .catch(() => {})
      .finally(() => { if (alive) setPrefsReady(true); });
    return () => { alive = false; };
  }, []);

  const setPrefs = useCallback((patch) => {
    setPrefsState((prev) => {
      const next = cleanPrefs({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) });
      AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  // Only the layer set changes what we fetch; status/mode are client-side.
  const typesKey = snapshotTypes(prefs.kinds).sort().join(',');

  const load = useCallback(async ({ refresh = false } = {}) => {
    if (!sendReq || !connected) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const raw = await sendReq('graph.global.snapshot', { types: typesKey.split(','), ...(refresh ? { refresh: true } : {}) });
      if (my !== seq.current) return;
      const snap = sanitizeSnapshot(raw);
      if (!snap) throw new Error('The gateway returned an unreadable graph.');
      setSnapshot(snap);
      setFetchedAt(Date.now());
    } catch (e) {
      if (my !== seq.current) return;
      const msg = e?.message || String(e);
      setError(/unknown method|no handler|not found/i.test(msg) ? 'This gateway does not serve the knowledge graph yet (graph.global.snapshot).' : msg);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [sendReq, connected, typesKey]);

  useEffect(() => {
    if (prefsReady) load();
  }, [prefsReady, load]);

  return { snapshot, loading, error, load, prefs, setPrefs, prefsReady, connected, fetchedAt };
}
