/**
 * StatCard (KPI) — a single metric on a glass card.
 *
 * The number is MONOSPACED and the largest thing in the tile; the label is a
 * 12px all-caps eyebrow above it; delta and footnote sit below. Monospace
 * matters here: a column of KPI tiles whose digits don't align reads as noise.
 *
 * Props
 *   label      string    all-caps eyebrow
 *   value      string|number   the metric (rendered monospaced)
 *   unit       string    suffix rendered smaller and dimmer (%, ms, USD…)
 *   delta      number|string   change indicator; sign drives the arrow+tone
 *   deltaLabel string    text next to the delta (e.g. "vs last week")
 *   tone       chip tone for the accent / icon
 *   icon       Ionicons name
 *   footnote   string
 *   loading    boolean   render a Skeleton in the value slot
 *   compact    boolean   smaller metric face for 3-up grids
 *   onPress    fn        makes the tile a drill-down
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Card } from './Card';
import { Skeleton } from './Skeleton';
import { useUIKit, SPACE } from './tokens';
import { toneColor } from './Chip';
import { withAlpha } from '../theme/color-utils';

function deltaMeta(delta, colors) {
  if (delta === undefined || delta === null || delta === '') return null;
  const num = typeof delta === 'number' ? delta : parseFloat(String(delta));
  if (Number.isNaN(num)) {
    return { text: String(delta), color: colors.textSecondary, icon: 'remove' };
  }
  if (num > 0) return { text: `+${delta}`, color: colors.success, icon: 'arrow-up' };
  if (num < 0) return { text: `${delta}`, color: colors.error, icon: 'arrow-down' };
  return { text: `${delta}`, color: colors.textSecondary, icon: 'remove' };
}

export function StatCard({
  label,
  value,
  unit,
  delta,
  deltaLabel,
  tone = 'primary',
  icon,
  footnote,
  loading = false,
  compact = false,
  onPress,
  style,
  testID,
  ...cardProps
}) {
  const { colors, type } = useUIKit();
  const accent = toneColor(tone, colors);
  const d = deltaMeta(delta, colors);

  return (
    <Card
      tint={tone === 'neutral' ? 'primary' : tone}
      depth={1}
      padded={SPACE.md}
      onPress={onPress}
      accessibilityLabel={onPress ? `${label}: ${value ?? ''}${unit || ''}` : undefined}
      style={style}
      testID={testID}
      {...cardProps}
    >
      <View style={styles.head}>
        <Text style={[type.label, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>
          {label}
        </Text>
        {icon ? <Ionicons name={icon} size={15} color={withAlpha(accent, 0.8)} /> : null}
      </View>

      {loading ? (
        <Skeleton width="60%" height={compact ? 22 : 28} style={{ marginTop: SPACE.xs }} />
      ) : (
        <View style={styles.valueRow}>
          <Text
            style={[compact ? type.metricSmall : type.metric, { color: colors.text }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            {value ?? '—'}
          </Text>
          {unit ? (
            <Text style={[type.monoSmall, { color: colors.textMuted }]} numberOfLines={1}>
              {unit}
            </Text>
          ) : null}
        </View>
      )}

      {d || footnote ? (
        <View style={styles.footRow}>
          {d ? (
            <View style={styles.deltaRow}>
              <Ionicons name={d.icon} size={12} color={d.color} />
              <Text style={[type.monoSmall, { color: d.color }]} numberOfLines={1}>
                {d.text}
              </Text>
              {deltaLabel ? (
                <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
                  {deltaLabel}
                </Text>
              ) : null}
            </View>
          ) : null}
          {footnote ? (
            <Text style={[type.caption, { color: colors.textMuted, flex: 1 }]} numberOfLines={1}>
              {footnote}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: SPACE.xs, marginTop: SPACE.xs },
  footRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.sm },
  deltaRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});

export default StatCard;
