/**
 * useAgencyOps — the native Agencies page data layer.
 *
 * Mirrors the web loader (loadAgencyOperations): agencies.list first, then
 * every panel RPC for the selected agency in parallel (fault isolated — a
 * failed panel keeps its last good value and is named in `failures`), then
 * the slow diagnostics (replication / database health / backups) after the
 * operating data has painted. Mutations go through `call()`, which records a
 * failure under its method name exactly like the web's failed-request banner.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  diagnosticRequests,
  normalizePanels,
  panelRequests,
  pickSelectedAgency,
  roleCaps,
  unwrap,
} from './agency-ops-model';

const STORAGE_KEY = 'infinibot.agencyOps.selectedAgencyId';
const PANEL_TIMEOUT_MS = 45_000;
const CALL_TIMEOUT_MS = 30_000;
const LIVE_EVENTS = ['agency.ops.updated', 'agency.work.updated', 'kanban:changed', 'clients:updated'];

const msg = (e) => (e && e.message ? e.message : String(e));

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

const INITIAL = {
  ...normalizePanels({}, {}),
  loading: true,
  refreshing: false,
  error: null,
  failures: [],
  agencies: [],
  migration: null,
  selectedAgencyId: null,
  lastLoadedAt: null,
  replication: null,
  dbHealth: null,
  backups: [],
};

export function useAgencyOps(gateway) {
  const sendReq = gateway?.sendReq;
  const subscribeEvent = gateway?.subscribeEvent;
  const connected = gateway?.status === 'connected';
  const [state, setState] = useState(INITIAL);
  const [busy, setBusy] = useState(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const genRef = useRef(0);
  const preferredRef = useRef(undefined);

  const req = useCallback((method, params, ms = CALL_TIMEOUT_MS) => {
    if (!sendReq) return Promise.reject(new Error('Gateway not connected'));
    return withTimeout(sendReq(method, params), ms);
  }, [sendReq]);

  const patch = useCallback((p) => setState((prev) => ({ ...prev, ...(typeof p === 'function' ? p(prev) : p) })), []);

  const addFailure = useCallback((method, error) => {
    const entry = `${method} — ${msg(error)}`;
    setState((prev) => (prev.failures.includes(entry) ? prev : { ...prev, failures: [...prev.failures, entry] }));
  }, []);

  const load = useCallback(async ({ background = false, agencyId: forced } = {}) => {
    if (!sendReq) return;
    const gen = ++genRef.current;
    const bg = background || stateRef.current.lastLoadedAt !== null;
    patch({ loading: !bg, refreshing: bg, error: null });
    try {
      if (preferredRef.current === undefined) {
        try { preferredRef.current = (await AsyncStorage.getItem(STORAGE_KEY)) || null; } catch { preferredRef.current = null; }
      }
      const agenciesResult = await req('agency.ops.agencies.list', {});
      if (gen !== genRef.current) return;
      const agencies = unwrap(agenciesResult, 'agencies', []) || [];
      const migration = agenciesResult?.migration ?? null;
      const agencyId = pickSelectedAgency(agencies, forced ?? stateRef.current.selectedAgencyId ?? preferredRef.current);
      if (agencyId && agencyId !== preferredRef.current) {
        preferredRef.current = agencyId;
        AsyncStorage.setItem(STORAGE_KEY, agencyId).catch(() => {});
      }
      patch({ agencies, migration, selectedAgencyId: agencyId });
      if (!agencyId) {
        patch({ ...normalizePanels({}, {}), lastLoadedAt: Date.now(), failures: [] });
        return;
      }
      const failures = [];
      const requests = panelRequests(agencyId);
      const settled = await Promise.all(requests.map(([key, method, params]) =>
        req(method, params, PANEL_TIMEOUT_MS).then((r) => [key, r]).catch((e) => { failures.push(`${method} — ${msg(e)}`); return [key, null]; })));
      if (gen !== genRef.current) return;
      const results = Object.fromEntries(settled);
      setState((prev) => {
        // A different agency's previous panels must not leak in as "last good".
        const base = prev.selectedAgencyId === agencyId && prev.lastLoadedAt ? prev : {};
        return { ...prev, ...normalizePanels(results, base), failures, lastLoadedAt: Date.now() };
      });
      const role = agencies.find((a) => a.id === agencyId)?.role;
      const diag = diagnosticRequests(agencyId, roleCaps(role).canAdmin);
      Promise.all(diag.map(([key, method, params]) => req(method, params, PANEL_TIMEOUT_MS).then((r) => [key, r]).catch(() => [key, null])))
        .then((pairs) => {
          if (gen !== genRef.current) return;
          const r = Object.fromEntries(pairs);
          setState((prev) => ({
            ...prev,
            replication: r.replication ? unwrap(r.replication, 'status', prev.replication) : prev.replication,
            dbHealth: r.dbHealth ?? prev.dbHealth,
            backups: r.backups ? unwrap(r.backups, 'backups', []) : prev.backups,
          }));
        });
    } catch (error) {
      if (gen === genRef.current) patch({ error: msg(error) });
    } finally {
      if (gen === genRef.current) patch({ loading: false, refreshing: false });
    }
  }, [sendReq, req, patch]);

  const selectAgency = useCallback((agencyId) => {
    if (!agencyId || agencyId === stateRef.current.selectedAgencyId) return;
    preferredRef.current = agencyId;
    AsyncStorage.setItem(STORAGE_KEY, agencyId).catch(() => {});
    patch({ selectedAgencyId: agencyId, lastLoadedAt: null, replication: null, dbHealth: null, backups: [] });
    load({ agencyId });
  }, [load, patch]);

  /**
   * Run one mutation. `busyKey` drives button spinners; `reload` refreshes the
   * page in the background afterwards. Throws after recording the failure so
   * callers can keep a sheet open.
   */
  const call = useCallback(async (method, params, { busyKey = null, reload = false, quiet = false } = {}) => {
    if (busyKey) setBusy(busyKey);
    try {
      const result = await req(method, params);
      if (reload) load({ background: true });
      return result;
    } catch (error) {
      if (!quiet) { addFailure(method, error); patch({ error: msg(error) }); }
      throw error;
    } finally {
      if (busyKey) setBusy((b) => (b === busyKey ? null : b));
    }
  }, [req, load, addFailure, patch]);

  /** Optimistic local edit of a list slice (e.g. task status) before the RPC lands. */
  const mutateList = useCallback((key, id, fields) => {
    setState((prev) => ({ ...prev, [key]: (prev[key] || []).map((row) => (row.id === id ? { ...row, ...fields } : row)) }));
  }, []);

  const dismissError = useCallback(() => patch({ error: null }), [patch]);
  const clearFailures = useCallback(() => patch({ failures: [] }), [patch]);

  useEffect(() => {
    if (connected && !stateRef.current.lastLoadedAt) load();
  }, [connected, load]);

  // Live updates: debounced background reload (the payload is ~7 MB, so at most every 15 s).
  const lastLiveRef = useRef(0);
  useEffect(() => {
    if (!subscribeEvent) return undefined;
    let timer = null;
    const bump = () => {
      if (timer) return;
      const wait = Math.max(1500, 15_000 - (Date.now() - lastLiveRef.current));
      timer = setTimeout(() => {
        timer = null;
        lastLiveRef.current = Date.now();
        if (stateRef.current.lastLoadedAt) load({ background: true });
      }, wait);
    };
    const unsubs = LIVE_EVENTS.map((e) => { try { return subscribeEvent(e, bump); } catch { return null; } });
    return () => {
      if (timer) clearTimeout(timer);
      unsubs.forEach((u) => { try { u?.(); } catch { /* ignore */ } });
    };
  }, [subscribeEvent, load]);

  const agency = state.agencies.find((a) => a.id === state.selectedAgencyId) || null;
  return {
    state,
    agency,
    caps: roleCaps(agency?.role),
    busy,
    connected,
    load,
    selectAgency,
    call,
    req,
    patch,
    mutateList,
    addFailure,
    dismissError,
    clearFailures,
  };
}
