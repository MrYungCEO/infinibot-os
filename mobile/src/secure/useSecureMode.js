/**
 * useSecureMode — Secure Mode status for any screen.
 *
 *   const secure = useSecureMode(gateway.sendReq, gateway.subscribeEvent, { connected });
 *   secure.enabled / unlocked / status / error / supported
 *   await secure.setEnabled(true)   → true on success (error text otherwise)
 *
 * Reads `secure.status` on connect, follows `secure.mode.changed`. The last
 * status is shared across screens (module cache + listeners) so a toggle on
 * one screen repaints every other mounted screen at once.
 *
 * useSecureLane(subscribeEvent, kinds, onChange) fires on `secure.lane.changed`
 * for the given lane kinds ("kanban" | "docs" | "graph" | "sessions").
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { isUnknownMethod, secureErrorText } from './secure-logic';

let shared = null; // last known secure.status payload
const listeners = new Set();

function publish(status) {
  shared = status && typeof status === 'object' ? status : null;
  for (const fn of listeners) fn(shared);
}

/** Test hook. */
export function __resetSecureCache() {
  shared = null;
  listeners.clear();
}

export function useSecureMode(sendReq, subscribeEvent, { connected = true } = {}) {
  const [status, setStatus] = useState(shared);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  const sendRef = useRef(sendReq);
  sendRef.current = sendReq;

  useEffect(() => {
    const fn = (s) => setStatus(s);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const refresh = useCallback(async () => {
    const send = sendRef.current;
    if (!send) return null;
    try {
      const s = await send('secure.status', {});
      setSupported(true);
      publish(s);
      return s;
    } catch (err) {
      if (isUnknownMethod(err)) setSupported(false);
      return null;
    }
  }, []);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  useEffect(() => {
    if (!subscribeEvent) return undefined;
    return subscribeEvent('secure.mode.changed', (payload) => {
      if (payload && typeof payload === 'object' && 'enabled' in payload) publish(payload);
      else void refresh();
    });
  }, [subscribeEvent, refresh]);

  const setEnabled = useCallback(async (enabled) => {
    const send = sendRef.current;
    if (!send) { setError('Not connected to the gateway.'); return false; }
    setBusy(true);
    setError(null);
    try {
      const s = await send('secure.set', { enabled: Boolean(enabled) });
      if (s && typeof s === 'object' && 'enabled' in s) publish(s);
      else await refresh();
      if (s?.error && enabled && !s.enabled) { setError(String(s.error)); return false; }
      return true;
    } catch (err) {
      if (isUnknownMethod(err)) setSupported(false);
      setError(secureErrorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return {
    status,
    enabled: Boolean(status?.enabled),
    unlocked: Boolean(status?.unlocked),
    supported,
    busy,
    error,
    clearError: () => setError(null),
    setEnabled,
    refresh,
  };
}

export function useSecureLane(subscribeEvent, kinds, onChange) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = Array.isArray(kinds) ? kinds.join(',') : String(kinds || '');
  useEffect(() => {
    if (!subscribeEvent) return undefined;
    const want = key ? key.split(',') : null;
    return subscribeEvent('secure.lane.changed', (payload) => {
      const kind = payload?.kind;
      if (!want || !kind || want.includes(kind)) cb.current?.(payload);
    });
  }, [subscribeEvent, key]);
}
