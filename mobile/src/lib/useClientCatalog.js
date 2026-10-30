/**
 * useClientCatalog — every CRM client of the active business for the client
 * picker, shared across screens (one fetch, 60 s cache), plus the phone's own
 * "recently / most used" client memory.
 *
 * capture.clients is the same list the gateway's AI matches against. Older
 * gateways don't have it, so it falls back to clients.list {all: true}.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { CLIENT_USAGE_KEY, normalizeClients, recordUsage } from './client-picker-model';

const TTL_MS = 60_000;
const UNKNOWN_METHOD = /unknown method|no handler|method not found/i;
const cache = { list: null, at: 0, inflight: null, usage: null, listeners: new Set() };

function emit() {
  for (const fn of cache.listeners) fn();
}

async function fetchClients(sendReq, force) {
  if (!force && cache.list && Date.now() - cache.at < TTL_MS) return cache.list;
  if (cache.inflight) return cache.inflight;
  cache.inflight = sendReq('capture.clients', {})
    .catch((err) => {
      if (!UNKNOWN_METHOD.test(String(err?.message || err))) throw err;
      return sendReq('clients.list', { all: true });
    })
    .then((res) => {
      cache.list = normalizeClients(res);
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
    const raw = await AsyncStorage.getItem(CLIENT_USAGE_KEY);
    cache.usage = raw ? JSON.parse(raw) || {} : {};
  } catch {
    cache.usage = {};
  }
  return cache.usage;
}

export function invalidateClientCatalog() {
  cache.at = 0;
}

export function useClientCatalog(gateway, { enabled = true } = {}) {
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
        const list = await fetchClients(sendReq, force);
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

  const markUsed = useCallback((id) => {
    if (!id) return;
    cache.usage = recordUsage(cache.usage || {}, id);
    emit();
    AsyncStorage.setItem(CLIENT_USAGE_KEY, JSON.stringify(cache.usage)).catch(() => {});
  }, []);

  return { clients: cache.list || [], usage: cache.usage || {}, loading: loading && !cache.list, error, refresh, markUsed };
}
