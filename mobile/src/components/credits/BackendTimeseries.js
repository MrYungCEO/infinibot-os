/**
 * BackendTimeseries — 24h stacked usage bars grouped by agent_backend.
 *
 * Mobile mirror of the desktop timeseries chart + <credit-usage-breakdown>.
 * Each hourly bucket is a stacked column; segments are coloured from the
 * canonical coder-brand table (claude-code / opencode / codex / gemini / …) so
 * the colours match web exactly. A legend with per-backend 24h cost totals sits
 * below, sorted by spend.
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

import { backendAccent, backendLabel } from './backend-brand';

const usd = (n) => {
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return '$0';
};

export function BackendTimeseries({ points, colors, height = 150 }) {
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const { keys, max, totals } = useMemo(() => {
    const set = new Set();
    const tot = new Map();
    let m = 0;
    for (const p of points ?? []) {
      let sum = 0;
      for (const [k, v] of Object.entries(p.series ?? {})) {
        set.add(k);
        sum += v?.costUsd ?? 0;
        tot.set(k, (tot.get(k) ?? 0) + (v?.costUsd ?? 0));
      }
      if (sum > m) m = sum;
    }
    // Order keys by total spend so the legend + stack order are stable.
    const ordered = [...set].sort((a, b) => (tot.get(b) ?? 0) - (tot.get(a) ?? 0));
    return { keys: ordered, max: Math.max(m, 0.0001), totals: tot };
  }, [points]);

  if (!points || points.length === 0 || keys.length === 0) {
    return (
      <View style={[styles.empty, { height }]}>
        <Text style={styles.emptyText}>NO USAGE DATA · awaiting traffic</Text>
      </View>
    );
  }

  const bars = points.slice(-24);

  return (
    <View>
      <View style={[styles.chart, { height }]}>
        {bars.map((p, i) => {
          const total = keys.reduce((s, k) => s + (p.series?.[k]?.costUsd ?? 0), 0);
          const heightPct = (total / max) * 100;
          return (
            <View key={i} style={styles.col}>
              <View style={[styles.barWrap, { height: `${Math.max(heightPct, total > 0 ? 2 : 0)}%` }]}>
                {keys.map((k) => {
                  const v = p.series?.[k]?.costUsd ?? 0;
                  if (v <= 0) return null;
                  const seg = total > 0 ? (v / total) * 100 : 0;
                  return <View key={k} style={{ height: `${seg}%`, backgroundColor: backendAccent(k) }} />;
                })}
              </View>
            </View>
          );
        })}
      </View>
      <View style={styles.legend}>
        {keys.map((k) => (
          <View key={k} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: backendAccent(k) }]} />
            <Text style={styles.legendLabel} numberOfLines={1}>{backendLabel(k)}</Text>
            <Text style={styles.legendVal}>{usd(totals.get(k) ?? 0)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, paddingVertical: 8 },
    col: { flex: 1, justifyContent: 'flex-end', height: '100%' },
    barWrap: { width: '100%', flexDirection: 'column-reverse', borderRadius: 2, overflow: 'hidden', backgroundColor: colors.primary + '0d' },
    empty: { justifyContent: 'center', alignItems: 'center' },
    emptyText: { color: colors.textMuted, fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase' },
    legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: '45%' },
    swatch: { width: 10, height: 10, borderRadius: 2 },
    legendLabel: { color: colors.text, fontSize: 11, flex: 1 },
    legendVal: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  });
}

export default BackendTimeseries;
