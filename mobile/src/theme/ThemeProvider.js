// ThemeProvider — pulls the master device's theme via the gateway
// `branding.get` request and subscribes to `branding.update` broadcasts so
// the mobile app re-paints in real time when the user picks a new
// palette/mode/background on the web settings page.
//
// Behaviour summary:
//   1. On mount we mark `isReady=false` and load any local override saved in
//      AsyncStorage. If "sync from master" is OFF, we apply the local
//      override and stop. If ON (default), we wait for the gateway.
//   2. As soon as the gateway hits status==='connected', we issue
//      `branding.get`. On success we feed the payload through
//      setActiveTheme(...) and mark isReady=true.
//   3. We subscribe to `branding.update` broadcasts via gateway.subscribeEvent
//      so subsequent master-side edits flow in without polling.
//   4. The exported `useTheme()` returns the current resolved palette plus
//      mutators (setLocalOverride, setSyncEnabled, etc.) the settings panel
//      consumes.
//
// The provider purposely does NOT block first-frame rendering — screens get
// the fallback palette immediately and the real palette swaps in within a
// second of the WS handshake.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  getActiveTheme,
  getActiveColors,
  getActiveFonts,
  getActiveBackground,
  setActiveTheme,
  subscribeTheme,
} from './runtime.js';
import { BUILT_IN_PALETTES, DEFAULT_THEME, resolveMode } from './palettes.js';

const ThemeContext = createContext(null);

const STORAGE_KEYS = {
  syncEnabled: '@moltbot/theme_sync_enabled',
  localOverride: '@moltbot/theme_local_override',
};

function resolveSystemMode() {
  try {
    const scheme = Appearance.getColorScheme();
    return scheme === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// Web supports `system | dark | light | hud`. Mobile honors all four — `hud`
// is preserved verbatim (its own resolved mode in the resolver), and
// `system` projects to the device's scheme. Anything else falls back to dark
// via resolveMode.
function projectThemeForRuntime(theme) {
  if (!theme) return DEFAULT_THEME;
  let mode;
  if (theme.mode === 'system') mode = resolveSystemMode();
  else if (theme.mode === 'hud') mode = 'hud';
  else mode = resolveMode(theme.mode);
  return {
    mode,
    paletteId: theme.paletteId || DEFAULT_THEME.paletteId,
    background: theme.background || DEFAULT_THEME.background,
    // Forward the full token map verbatim — every web token (overlay*,
    // glass*, blur, radius, …) flows through, and the resolver picks what
    // it needs without us having to filter here.
    tokens: theme.tokens || {},
  };
}

export function ThemeProvider({ gateway, children }) {
  // Render counter wired to the runtime version so a setActiveTheme call
  // anywhere in the app forces this subtree to re-evaluate `useTheme()`.
  const [, setTick] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [palettes, setPalettes] = useState(BUILT_IN_PALETTES);
  const [syncEnabled, setSyncEnabledState] = useState(true);
  const [masterTheme, setMasterTheme] = useState(null);
  const [localOverride, setLocalOverrideState] = useState(null);
  const lastAppliedRef = useRef(null);

  // 1) Subscribe to runtime mutations so the context re-renders the tree
  //    whenever setActiveTheme is called from anywhere.
  useEffect(() => {
    const unsubscribe = subscribeTheme(() => setTick((n) => n + 1));
    return unsubscribe;
  }, []);

  // 2) Load persistence on mount.
  useEffect(() => {
    (async () => {
      try {
        const [syncRaw, overrideRaw] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.syncEnabled),
          AsyncStorage.getItem(STORAGE_KEYS.localOverride),
        ]);
        const syncOn = syncRaw == null ? true : syncRaw === 'true';
        setSyncEnabledState(syncOn);
        if (overrideRaw) {
          try {
            const parsed = JSON.parse(overrideRaw);
            setLocalOverrideState(parsed);
            if (!syncOn) {
              setActiveTheme(projectThemeForRuntime(parsed));
              setIsReady(true);
            }
          } catch {
            /* malformed cache — ignore */
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[theme] failed to load persisted theme settings:', err?.message || err);
      }
    })();
  }, []);

  // 3) Pull master theme + subscribe to branding.update once gateway is up.
  useEffect(() => {
    if (!gateway?.sendReq || !gateway?.subscribeEvent) return undefined;
    const { sendReq, subscribeEvent, status } = gateway;
    if (status !== 'connected') return undefined;

    let cancelled = false;
    (async () => {
      try {
        const payload = await sendReq('branding.get', {});
        if (cancelled || !payload) return;
        if (Array.isArray(payload.palettes) && payload.palettes.length > 0) {
          setPalettes(payload.palettes);
        }
        if (payload.theme) {
          setMasterTheme(payload.theme);
          if (syncEnabled) {
            setActiveTheme(projectThemeForRuntime(payload.theme));
          }
          lastAppliedRef.current = payload.theme;
          setIsReady(true);
        }
      } catch (err) {
        // Non-fatal — keep the fallback palette and try again on the next
        // broadcast. Most likely we're missing the scope or method.
        // eslint-disable-next-line no-console
        console.log('[theme] branding.get unavailable:', err?.message || err);
        setIsReady(true);
      }
    })();

    const unsub = subscribeEvent('branding.update', (payload) => {
      if (!payload?.theme) return;
      if (Array.isArray(payload.palettes) && payload.palettes.length > 0) {
        setPalettes(payload.palettes);
      }
      setMasterTheme(payload.theme);
      lastAppliedRef.current = payload.theme;
      if (syncEnabled) {
        setActiveTheme(projectThemeForRuntime(payload.theme));
      }
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [gateway?.sendReq, gateway?.subscribeEvent, gateway?.status, syncEnabled]);

  // 4) React to "system" mode changes when the device theme switches.
  useEffect(() => {
    const sub = Appearance.addChangeListener(() => {
      const active = syncEnabled ? masterTheme : localOverride;
      if (active?.mode === 'system') {
        setActiveTheme(projectThemeForRuntime(active));
      }
    });
    return () => sub.remove();
  }, [syncEnabled, masterTheme, localOverride]);

  // 5) Mutators ─────────────────────────────────────────────────────────
  const setSyncEnabled = useCallback(
    async (enabled) => {
      setSyncEnabledState(enabled);
      try {
        await AsyncStorage.setItem(STORAGE_KEYS.syncEnabled, enabled ? 'true' : 'false');
      } catch {
        /* ignore */
      }
      if (enabled) {
        // Re-apply master theme if we have it.
        if (masterTheme) {
          setActiveTheme(projectThemeForRuntime(masterTheme));
        }
      } else if (localOverride) {
        setActiveTheme(projectThemeForRuntime(localOverride));
      }
    },
    [masterTheme, localOverride],
  );

  const setLocalOverride = useCallback(async (next) => {
    setLocalOverrideState(next);
    try {
      if (next) {
        await AsyncStorage.setItem(STORAGE_KEYS.localOverride, JSON.stringify(next));
      } else {
        await AsyncStorage.removeItem(STORAGE_KEYS.localOverride);
      }
    } catch {
      /* ignore */
    }
    if (next) {
      setActiveTheme(projectThemeForRuntime(next));
    }
  }, []);

  // Persist a master-side mutation via branding.set. Returns the new payload
  // when successful, throws otherwise. Used by the SettingsScreen toggle to
  // push palette changes back to every connected device.
  const pushThemeToMaster = useCallback(
    async (themePatch) => {
      if (!gateway?.sendReq) throw new Error('Gateway not connected');
      const payload = await gateway.sendReq('branding.set', {
        theme: themePatch,
      });
      if (payload?.theme) {
        setMasterTheme(payload.theme);
        if (syncEnabled) {
          setActiveTheme(projectThemeForRuntime(payload.theme));
        }
      }
      return payload;
    },
    [gateway, syncEnabled],
  );

  const value = useMemo(() => {
    return {
      isReady,
      mode: getActiveTheme().mode,
      palette: getActiveTheme().paletteId,
      background: getActiveBackground(),
      tokens: getActiveTheme().tokens,
      colors: getActiveColors(),
      fonts: getActiveFonts(),
      palettes,
      syncEnabled,
      masterTheme,
      localOverride,
      setSyncEnabled,
      setLocalOverride,
      pushThemeToMaster,
    };
    // The setTick state is what triggers re-evaluation here; we don't depend
    // on it directly because the getters always read live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, palettes, syncEnabled, masterTheme, localOverride, setSyncEnabled, setLocalOverride, pushThemeToMaster]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Fallback so screens that render outside the provider (rare — boot
    // splash) still get usable colors. Reads from the runtime cache.
    return {
      isReady: false,
      mode: getActiveTheme().mode,
      palette: getActiveTheme().paletteId,
      background: getActiveBackground(),
      tokens: getActiveTheme().tokens,
      colors: getActiveColors(),
      fonts: getActiveFonts(),
      palettes: BUILT_IN_PALETTES,
      syncEnabled: true,
      masterTheme: null,
      localOverride: null,
      setSyncEnabled: () => {},
      setLocalOverride: () => {},
      pushThemeToMaster: () => Promise.reject(new Error('Theme provider not mounted')),
    };
  }
  return ctx;
}
