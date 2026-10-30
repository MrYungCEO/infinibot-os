/**
 * SectionTitle — the all-caps section header with an optional count and a
 * single trailing action.
 *
 * The label is 12px / +1.1 tracking / uppercase. The count is monospaced so
 * a stack of sections keeps its numbers in a column.
 *
 * Props
 *   title      string
 *   count      number|string   trailing count next to the title
 *   subtitle   string          one dim line under the title
 *   actionLabel / onAction     a text action on the right (>=44px tap)
 *   actionIcon Ionicons name   icon-only action instead
 *   right      node            arbitrary right slot (wins over action*)
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import { useUIKit, SPACE } from './tokens';
import { Button, IconButton } from './Button';

export function SectionTitle({
  title,
  count,
  subtitle,
  actionLabel,
  onAction,
  actionIcon,
  right,
  style,
  testID,
}) {
  const { colors, type } = useUIKit();
  return (
    <View style={[styles.wrap, style]} testID={testID}>
      <View style={styles.textCol}>
        <View style={styles.titleRow}>
          <Text style={[type.label, { color: colors.textSecondary }]} accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
          {count !== undefined && count !== null ? (
            <Text style={[type.monoSmall, { color: colors.textMuted }]}>{count}</Text>
          ) : null}
        </View>
        {subtitle ? (
          <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {right
        || (actionIcon && onAction ? (
          <IconButton icon={actionIcon} onPress={onAction} size="sm" accessibilityLabel={actionLabel || actionIcon} />
        ) : actionLabel && onAction ? (
          <Button title={actionLabel} onPress={onAction} variant="ghost" size="sm" />
        ) : null)}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.md,
    marginTop: SPACE.xl,
    marginBottom: SPACE.md,
    minHeight: 24,
  },
  textCol: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
});

export default SectionTitle;
