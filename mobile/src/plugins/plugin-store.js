/**
 * plugin-store — the app-wide view of the gateway's plugins.
 *
 * The gateway broadcasts no plugin-change event: turning a plugin on/off
 * restarts it (plugins.setEnabled → SIGUSR1). So, like the web UI
 * (app-gateway.ts re-runs plugins.list on every hello), we refetch
 * `plugins.list` on every (re)connect and after a `shutdown` broadcast, and
 * poll briefly while a toggle is being applied. The last good answer is cached
 * per gateway in AsyncStorage so a cold start (e.g. a deep-link tap from a
 * killed app) can resolve plugin pages before the socket is up.
 */
import { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { derivePluginSections, mergeCatalogue } from './plugin-nav';
import { SCREEN_SECTIONS } from '../navigation/screen-registry';

const CACHE_PREFIX = '@infinibot/plugins_list_v1:';

let state = {
  list: null, // last plugins.list result { plugins:[…] } or null while unknown
  error: null, // 'scope' | message
  loading: false,
  gatewayKey: null,
  updatedAt: 0,
};
const listeners = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const l of listeners) {
    try { l(state); } catch {}
  }
}

export function getPluginState() {
  return state;
}

export function getPluginList() {
  return state.list;
}

export function subscribePlugins(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Load the cached list for this gateway (cold start). */
export async function hydratePlugins(gatewayKey) {
  if (!gatewayKey) return;
  if (state.gatewayKey !== gatewayKey) set({ gatewayKey, list: null, error: null });
  try {
    const raw = await AsyncStorage.getItem(CACHE_PREFIX + gatewayKey);
    if (raw && !state.list) set({ list: JSON.parse(raw) });
  } catch {}
}

/**
 * Fetch plugins.list. `sendReq` is the gateway's request function.
 * A missing operator.admin scope is not an error the user can fix here — the
 * catalogue just stays on the static fallback.
 */
export async function refreshPlugins(sendReq, gatewayKey) {
  if (typeof sendReq !== 'function') return state.list;
  set({ loading: true });
  try {
    const res = await sendReq('plugins.list', {});
    const list = { plugins: Array.isArray(res?.plugins) ? res.plugins : [], pluginApiVersion: res?.pluginApiVersion ?? null };
    set({ list, error: null, loading: false, updatedAt: Date.now() });
    const key = gatewayKey || state.gatewayKey;
    if (key) AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify(list)).catch(() => {});
    return list;
  } catch (e) {
    const msg = String(e?.message || e);
    set({ loading: false, error: /scope|unauthori|forbidden/i.test(msg) ? 'scope' : msg });
    return state.list;
  }
}

/**
 * Keep the store in sync with a gateway connection. Call from the app root
 * with the useGateway() object.
 */
export function usePluginSync(gateway, gatewayKey) {
  const { status, sendReq, subscribeEvent } = gateway || {};
  useEffect(() => {
    hydratePlugins(gatewayKey);
  }, [gatewayKey]);
  useEffect(() => {
    if (status === 'connected') refreshPlugins(sendReq, gatewayKey);
  }, [status, sendReq, gatewayKey]);
  useEffect(() => {
    if (typeof subscribeEvent !== 'function') return undefined;
    // A restart (plugin toggled elsewhere) → the reconnect effect above refetches;
    // mark the list stale so screens can show "applying".
    return subscribeEvent('shutdown', () => set({ restarting: true }));
  }, [subscribeEvent]);
  useEffect(() => {
    if (status === 'connected' && state.restarting) set({ restarting: false });
  }, [status]);
}

export function usePlugins() {
  const [s, setS] = useState(state);
  useEffect(() => subscribePlugins(setS), []);
  return s;
}

/** Core catalogue merged with one section per enabled plugin. */
export function useScreenSections({ includeLaunchpadOnly = true } = {}) {
  const { list } = usePlugins();
  return useMemo(() => {
    const pluginSections = list ? derivePluginSections(list) : null;
    const merged = mergeCatalogue(SCREEN_SECTIONS, pluginSections);
    return includeLaunchpadOnly ? merged : merged.filter((sec) => !sec.launchpadOnly);
  }, [list, includeLaunchpadOnly]);
}

/**
 * Turn a plugin on/off. The gateway restarts to (un)load the plugin's code;
 * we then poll plugins.list until the new state shows (as the web page does).
 */
export async function setPluginEnabled(sendReq, id, enabled, { timeoutMs = 60000, pollMs = 1500 } = {}) {
  set({ applying: { id, enabled } });
  try {
    await sendReq('plugins.setEnabled', { id, enabled });
  } catch (e) {
    // The socket may drop mid-response because of the restart itself.
    if (!/closed|disconnect|timeout|socket/i.test(String(e?.message || e))) {
      set({ applying: null });
      throw e;
    }
  }
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const list = await refreshPlugins(sendReq);
      const p = list?.plugins?.find((x) => x.id === id);
      if (p && Boolean(p.enabled) === Boolean(enabled) && (!enabled || p.status !== 'disabled')) {
        set({ applying: null });
        return p;
      }
    } catch {}
  }
  set({ applying: null });
  throw new Error('The gateway did not come back in time — pull to refresh in a moment.');
}

export function __resetPluginStoreForTests() {
  state = { list: null, error: null, loading: false, gatewayKey: null, updatedAt: 0 };
  listeners.clear();
}
