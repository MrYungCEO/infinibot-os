/**
 * useKgController — one KgController per screen mount, re-rendering on its
 * changes. Wires the gateway (RPC + reconnect refresh + 30 s poll, like the
 * web graph), AsyncStorage prefs, haptics, clipboard and native "Open".
 */
import { useEffect, useReducer, useRef } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { KgController } from './kg-controller';

let Haptics = null;
try {
  // eslint-disable-next-line global-require
  Haptics = require('expo-haptics');
} catch {
  Haptics = null;
}
let Clipboard = null;
try {
  // eslint-disable-next-line global-require
  Clipboard = require('expo-clipboard');
} catch {
  Clipboard = null;
}

export const POLL_MS = 30_000;

function haptic(style) {
  if (!Haptics || Platform.OS === 'web') return;
  let p;
  if (style === 'selection') p = Haptics.selectionAsync();
  else if (style === 'success' || style === 'warning' || style === 'error') {
    const T = Haptics.NotificationFeedbackType || {};
    p = Haptics.notificationAsync(T[style[0].toUpperCase() + style.slice(1)]);
  } else {
    const S = Haptics.ImpactFeedbackStyle || {};
    p = Haptics.impactAsync(S[style[0].toUpperCase() + style.slice(1)]);
  }
  p?.catch?.(() => {});
}

export function useKgController(gateway, { openNode, active = true } = {}) {
  const [, bump] = useReducer((x) => x + 1, 0);
  const gwRef = useRef(gateway);
  gwRef.current = gateway;
  const openRef = useRef(openNode);
  openRef.current = openNode;
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = new KgController({
      request: (method, params) => {
        const gw = gwRef.current;
        if (!gw?.sendReq) return Promise.reject(new Error('Not connected to the gateway.'));
        return gw.sendReq(method, params);
      },
      storage: AsyncStorage,
      haptic,
      openNode: (n) => openRef.current?.(n),
      copy: (text) => (Clipboard?.setStringAsync ? Clipboard.setStringAsync(text) : Promise.reject(new Error('no clipboard'))),
    });
  }
  const c = ref.current;

  useEffect(() => {
    const off = c.subscribe(() => bump());
    void c.loadPrefs();
    let sub = null;
    AccessibilityInfo.isReduceMotionEnabled?.().then((on) => c.setSystemReducedMotion(on)).catch(() => {});
    try {
      sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (on) => c.setSystemReducedMotion(on));
    } catch {
      sub = null;
    }
    return () => {
      off();
      sub?.remove?.();
      c.dispose();
    };
  }, [c]);

  const connected = gateway?.status === 'connected';
  // First load + reconnects.
  useEffect(() => {
    if (connected) void c.refresh();
  }, [connected, c]);
  // 30 s poll while the screen is focused (the web graph polls the same).
  useEffect(() => {
    if (!connected || !active) return undefined;
    const t = setInterval(() => void c.refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [connected, active, c]);

  return c;
}
