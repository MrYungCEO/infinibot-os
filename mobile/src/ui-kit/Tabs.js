/**
 * Tabs + SegmentedControl — the two horizontal switchers.
 *
 * Tabs           scrollable pill row with per-tab counts. Use when the number
 *                of tabs is unbounded (filters, object types, boards).
 * SegmentedControl  fixed-width equal segments in a recessed track. Use for
 *                2-4 mutually exclusive view modes (Board/List, Day/Week).
 *
 * Both: 44px tap height, selected state exposed to screen readers via
 * accessibilityState.selected, and press feedback via opacity.
 *
 * Items: [{ key, label, icon?, count? }]
 */

import React, { useMemo } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, HIT } from './tokens';
import { a11yPress } from './a11y';
import { withAlpha } from '../theme/color-utils';

export function Tabs({
  tabs = [],
  active,
  onSelect,
  scrollable = true,
  style,
  contentStyle,
  testID,
}) {
  const { colors, type } = useUIKit();

  const row = useMemo(
    () =>
      tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onSelect?.(tab.key)}
            style={({ pressed }) => [
              styles.tab,
              {
                backgroundColor: on ? withAlpha(colors.primary, 0.16) : 'transparent',
                borderColor: on ? withAlpha(colors.primary, 0.42) : 'transparent',
                opacity: pressed ? 0.75 : 1,
              },
              !scrollable && styles.tabFlex,
            ]}
            {...a11yPress({ label: tab.label, role: 'tab', selected: on })}
          >
            {tab.icon ? (
              <Ionicons
                name={tab.icon}
                size={15}
                color={on ? colors.primary : colors.textMuted}
              />
            ) : null}
            <Text
              style={[type.smallStrong, { color: on ? colors.primary : colors.textSecondary }]}
              numberOfLines={1}
            >
              {tab.label}
            </Text>
            {tab.count !== undefined && tab.count !== null ? (
              <Text
                style={[type.monoSmall, { color: on ? withAlpha(colors.primary, 0.75) : colors.textMuted }]}
              >
                {tab.count}
              </Text>
            ) : null}
          </Pressable>
        );
      }),
    [tabs, active, onSelect, colors, type, scrollable],
  );

  if (!scrollable) {
    return (
      <View style={[styles.bar, style]} accessibilityRole="tablist" testID={testID}>
        {row}
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={style}
      contentContainerStyle={[styles.bar, contentStyle]}
      accessibilityRole="tablist"
      testID={testID}
    >
      {row}
    </ScrollView>
  );
}

/**
 * SegmentedControl — equal-width segments in a recessed track.
 * Props: options ([{key,label,icon?}] or ['a','b']), value, onChange, size
 */
export function SegmentedControl({
  options = [],
  value,
  onChange,
  size = 'md',
  style,
  testID,
}) {
  const { colors, type } = useUIKit();
  const items = options.map((o) => (typeof o === 'string' ? { key: o, label: o } : o));
  const height = size === 'sm' ? 36 : HIT.min;

  return (
    <View
      style={[
        styles.segTrack,
        { backgroundColor: withAlpha(colors.text || '#fff', 0.06), borderColor: colors.borderSubtle },
        style,
      ]}
      accessibilityRole="tablist"
      testID={testID}
    >
      {items.map((item) => {
        const on = item.key === value;
        return (
          <Pressable
            key={item.key}
            onPress={() => onChange?.(item.key)}
            style={({ pressed }) => [
              styles.seg,
              { height, opacity: pressed ? 0.75 : 1 },
              on && {
                backgroundColor: withAlpha(colors.primary, 0.16),
                borderColor: withAlpha(colors.primary, 0.4),
                borderWidth: 1,
              },
            ]}
            {...a11yPress({ label: item.label, role: 'tab', selected: on })}
          >
            {item.icon ? (
              <Ionicons name={item.icon} size={15} color={on ? colors.primary : colors.textMuted} />
            ) : null}
            <Text
              style={[type.smallStrong, { color: on ? colors.primary : colors.textSecondary }]}
              numberOfLines={1}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xs },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.xs,
    minHeight: HIT.min,
    paddingHorizontal: SPACE.md,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  tabFlex: { flex: 1 },
  segTrack: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 3,
    gap: 3,
    borderRadius: RADIUS.md,
    borderWidth: 1,
  },
  seg: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.xs,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
});

export default Tabs;
