/**
 * EmptyState — the "nothing here" surface. Also covers the error case, which
 * is an empty state with a retry.
 *
 * An empty list must never be a blank screen: say what would be here, why it
 * isn't, and give the one action that changes that.
 *
 * Props
 *   icon        Ionicons name (default 'file-tray-outline')
 *   title       string   what's missing
 *   message     string   why / what to do
 *   actionLabel / onAction   the primary way out
 *   secondaryLabel / onSecondary
 *   tone        chip tone — pass 'danger' for error states
 *   compact     boolean  inline variant for inside a Card
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS } from './tokens';
import { Button } from './Button';
import { toneColor } from './Chip';
import { withAlpha } from '../theme/color-utils';

export function EmptyState({
  icon = 'file-tray-outline',
  title = 'Nothing here yet',
  message,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  tone = 'neutral',
  compact = false,
  style,
  testID,
}) {
  const { colors, type } = useUIKit();
  const c = toneColor(tone, colors);

  return (
    <View
      style={[styles.wrap, compact && styles.compact, style]}
      testID={testID}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={message ? `${title}. ${message}` : title}
    >
      <View
        style={[
          styles.iconWrap,
          compact && styles.iconWrapCompact,
          { backgroundColor: withAlpha(c, 0.1), borderColor: withAlpha(c, 0.22) },
        ]}
      >
        <Ionicons name={icon} size={compact ? 20 : 28} color={withAlpha(c, 0.85)} />
      </View>

      <Text style={[compact ? type.bodyStrong : type.h3, { color: colors.text, textAlign: 'center' }]}>
        {title}
      </Text>
      {message ? (
        <Text style={[type.caption, { color: colors.textSecondary, textAlign: 'center', maxWidth: 300 }]}>
          {message}
        </Text>
      ) : null}

      {actionLabel && onAction ? (
        <View style={styles.actions}>
          <Button title={actionLabel} onPress={onAction} variant="primary" size={compact ? 'sm' : 'md'} />
          {secondaryLabel && onSecondary ? (
            <Button title={secondaryLabel} onPress={onSecondary} variant="ghost" size={compact ? 'sm' : 'md'} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.sm,
    paddingVertical: SPACE.xxl,
    paddingHorizontal: SPACE.lg,
  },
  compact: { paddingVertical: SPACE.lg, gap: SPACE.xs },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACE.xs,
  },
  iconWrapCompact: { width: 40, height: 40, borderRadius: RADIUS.md },
  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.md },
});

export default EmptyState;
