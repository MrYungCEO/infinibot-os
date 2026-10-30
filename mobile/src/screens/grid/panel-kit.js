/**
 * panel-kit — small shared pieces for the native Grid panel bodies:
 *   useRpc       load gateway RPCs with a timeout, reload on refreshSignal,
 *                optional poll; keeps the last good data on a failed refresh
 *   PanelLoading / PanelError / PanelEmpty   the three non-data states
 *   PanelOpen    the "Open <page>" footer row that hands off to the full screen
 *   MiniLabel    12px all-caps eyebrow inside a panel
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { EmptyState, Skeleton, SPACE, useUIKit } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';

export function withTimeout(promise, ms = 15000, label = 'request') {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timed out`)), ms);
    }),
  ]);
}

/** Friendly text for "the gateway does not serve this RPC". */
export function rpcErrorText(err) {
  const msg = String(err?.message || err || 'Request failed');
  if (/unknown method|no handler|not found|method not/i.test(msg)) return `This gateway does not serve this panel yet (${msg}). It needs a gateway update.`;
  return msg.replace(/^Error:\s*/, '');
}

/**
 * useRpc(gateway, loader, deps, { refreshSignal, pollMs, enabled })
 *   loader(sendReq) → Promise<data>
 * Returns { data, loading, error, reload }.
 */
export function useRpc(gateway, loader, deps = [], { refreshSignal = 0, pollMs = 0, enabled = true } = {}) {
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(Boolean(enabled));
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async ({ quiet = false } = {}) => {
    if (!enabled || !sendReq || !connected) return;
    const my = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const res = await loaderRef.current(sendReq);
      if (my !== seq.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (my !== seq.current) return;
      setError(rpcErrorText(err));
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sendReq, connected, ...deps]);

  useEffect(() => { reload(); }, [reload, refreshSignal]);

  useEffect(() => {
    if (!pollMs || !enabled) return undefined;
    const id = setInterval(() => reload({ quiet: true }), pollMs);
    return () => clearInterval(id);
  }, [pollMs, enabled, reload]);

  return { data, loading, error, reload, connected };
}

export function PanelLoading({ rows = 4 }) {
  return (
    <View style={styles.pad} accessibilityLabel="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} height={i === 0 ? 18 : 40} width={i === 0 ? '45%' : '100%'} style={{ marginBottom: SPACE.sm }} />
      ))}
    </View>
  );
}

export function PanelError({ message, onRetry }) {
  return (
    <EmptyState
      compact
      tone="danger"
      icon="cloud-offline-outline"
      title="Couldn't load"
      message={message}
      actionLabel={onRetry ? 'Retry' : undefined}
      onAction={onRetry}
    />
  );
}

export function PanelEmpty({ icon, title, message, actionLabel, onAction }) {
  return <EmptyState compact icon={icon} title={title} message={message} actionLabel={actionLabel} onAction={onAction} />;
}

/** Footer row: "Open <label>" → the full native page. */
export function PanelOpen({ label, onPress, icon = 'open-outline' }) {
  const { colors, type } = useUIKit();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.open, { borderTopColor: colors.borderSubtle, opacity: pressed ? 0.7 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${label}`}
    >
      <Ionicons name={icon} size={15} color={colors.primary} />
      <Text style={[type.smallStrong, { color: colors.primary, flex: 1 }]} numberOfLines={1}>{`Open ${label}`}</Text>
      <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />
    </Pressable>
  );
}

export function MiniLabel({ children, right, style }) {
  const { colors, type } = useUIKit();
  return (
    <View style={[styles.miniRow, style]}>
      <Text style={[type.label, { color: colors.textMuted, flex: 1 }]} numberOfLines={1}>{children}</Text>
      {right}
    </View>
  );
}

/** Thin horizontal share bar (gold is the fill of a determinate bar — sanctioned). */
export function ShareBar({ value, tone }) {
  const { colors } = useUIKit();
  const c = tone || colors.primary;
  const pct = Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <View style={[styles.track, { backgroundColor: withAlpha(colors.text, 0.08) }]}>
      <View style={[styles.fill, { width: `${Math.round(pct * 100)}%`, backgroundColor: c }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: SPACE.md },
  open: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, paddingHorizontal: SPACE.md, borderTopWidth: StyleSheet.hairlineWidth },
  miniRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.md, marginBottom: SPACE.xs },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});
