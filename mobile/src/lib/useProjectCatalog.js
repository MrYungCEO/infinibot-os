/**
 * useProjectCatalog — every board project for the project picker, shared
 * across screens (one fetch, 60 s cache, refreshed on kanban changes), plus
 * the phone's own "recently / most used" project memory in AsyncStorage.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeProjects, recordUsage, USAGE_KEY } from './project-picker-model';

const TTL_MS = 60_000;
const cache = { list: null, at: 0, inflight: null, usage: null, listeners: new Set() };

function emit() {
  for (const fn of cache.listeners) fn();
}

async function fetchProjects(sendReq, force) {
  if (!force && cache.list && Date.now() - cache.at < TTL_MS) return cache.list;
  if (cache.inflight) return cache.inflight;
  cache.inflight = sendReq('kanban.projects.list', {})
    .then((res) => {
      cache.list = normalizeProjects(res);
      cache.at = Date.now();
      emit();
      return cache.list;
    })
    .finally(() => {
      cache.inflight = null;
    });
  return cache.inflight;
}

async function loadUsage() {
  if (cache.usage) return cache.usage;
  try {
    const raw = await AsyncStorage.getItem(USAGE_KEY);
    cache.usage = raw ? JSON.parse(raw) || {} : {};
  } catch {
    cache.usage = {};
  }
  return cache.usage;
}

export function invalidateProjectCatalog() {
  cache.at = 0;
}

export function useProjectCatalog(gateway, { enabled = true } = {}) {
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    cache.listeners.add(fn);
    void loadUsage().then(fn);
    return () => cache.listeners.delete(fn);
  }, []);

  const refresh = useCallback(
    async (force = true) => {
      if (!sendReq || !connected) return cache.list || [];
      setLoading(true);
      try {
        const list = await fetchProjects(sendReq, force);
        setError(null);
        return list;
      } catch (err) {
        setError(err?.message || String(err));
        return cache.list || [];
      } finally {
        setLoading(false);
      }
    },
    [sendReq, connected],
  );

  useEffect(() => {
    if (enabled && connected) void refresh(false);
  }, [enabled, connected, refresh]);

  // A project created / renamed elsewhere shows up next time the picker opens.
  useEffect(() => {
    const unsub = gateway?.subscribeEvent?.('kanban:changed', (evt) => {
      if (!evt || evt.entity === 'project') invalidateProjectCatalog();
    });
    return () => unsub?.();
  }, [gateway]);

  const markUsed = useCallback((id) => {
    if (!id) return;
    cache.usage = recordUsage(cache.usage || {}, id);
    emit();
    AsyncStorage.setItem(USAGE_KEY, JSON.stringify(cache.usage)).catch(() => {});
  }, []);

  return { projects: cache.list || [], usage: cache.usage || {}, loading: loading && !cache.list, error, refresh, markUsed };
}
