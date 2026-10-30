/**
 * TokenDonut — input / output / cache-read / cache-write token split.
 *
 * Mobile mirror of `renderTokenDonut()` in ui/src/ui/views/credits.ts. Reads
 * the four token totals straight off credits.summary. Per the
 * `credits_codex_tokens_and_page` note, codex `output_tokens` already includes
 * reasoning, so we plot the summary fields verbatim — no double-add.
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

const compact = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

export function TokenDonut({ summary, colors }) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const segments = [
    { key: 'input', label: 'Input', value: summary?.totalTokensIn ?? 0, color: colors.primary },
    { key: 'output', label: 'Output', value: summary?.totalTokensOut ?? 0, color: colors.success || '#6cd49a' },
    { key: 'cacheRead', label: 'Cache read', value: summary?.totalCacheReadTokens ?? 0, color: '#7aa8ff' },
    { key: 'cacheWrite', label: 'Cache write', value: summary?.totalCacheWriteTokens ?? 0, color: '#c78bff' },
  ];
  const total = segments.reduce((acc, s) => acc + s.value, 0);

  if (total <= 0) {
    return <Text style={styles.empty}>No token usage in this range yet.</Text>;
  }

  const size = 168;
  const stroke = 28;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const frac = s.value / total;
      const dash = frac * circ;
      const arc = (
        <Circle
          key={s.key}
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={s.color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={-offset}
        />
      );
      offset += dash;
      return arc;
    });

  return (
    <View style={styles.wrap}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
          {arcs}
        </Svg>
        <Text style={styles.totalValue}>{compact(total)}</Text>
        <Text style={styles.totalLabel}>TOTAL TOKENS</Text>
      </View>
      <View style={styles.legend}>
        {segments.map((s) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          return (
            <View key={s.key} style={styles.legendRow}>
              <View style={[styles.swatch, { backgroundColor: s.color }]} />
              <Text style={styles.legendLabel}>{s.label}</Text>
              <Text style={styles.legendVal}>{compact(s.value)}</Text>
              <Text style={styles.legendPct}>{pct.toFixed(1)}%</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    wrap: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap', justifyContent: 'center' },
    totalValue: { color: colors.text, fontSize: 22, fontWeight: '800' },
    totalLabel: { color: colors.textMuted, fontSize: 9, letterSpacing: 1, marginTop: 2 },
    legend: { flex: 1, minWidth: 150, gap: 8 },
    legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    swatch: { width: 12, height: 12, borderRadius: 3 },
    legendLabel: { color: colors.text, fontSize: 12, flex: 1 },
    legendVal: { color: colors.textMuted, fontSize: 12 },
    legendPct: { color: colors.text, fontSize: 12, width: 46, textAlign: 'right' },
    empty: { color: colors.textMuted, fontSize: 12, textAlign: 'center', padding: 16 },
  });
}

export default TokenDonut;
