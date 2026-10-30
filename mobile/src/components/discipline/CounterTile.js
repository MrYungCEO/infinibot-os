import React, { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, FONTS, SPACING } from '../../constants/theme';

// Category-keyed icon names
const KIND_ICONS = {
  subagent_started: 'git-branch',
  subagent_completed: 'checkmark-done',
  subagent_failed: 'close-circle',
  kanban_task_completed: 'list-circle',
  workflow_run_completed: 'play-circle',
  gateway_tool_invocation: 'construct',
  voice_session_ended: 'mic',
  edit_session: 'create',
  manual: 'add-circle',
};

export function CounterTile({
  label,
  value = 0,
  kind,
  positive = true,
  onIncrement,
  onDecrement,
  compact = false,
}) {
  const iconName = KIND_ICONS[kind] || (positive ? 'trending-up' : 'trending-down');
  const accentColor = positive ? COLORS.primary : '#EF4444';
  const bg = positive
    ? COLORS.primaryDim
    : 'rgba(239,68,68,0.06)';

  const scaleAnim = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const handlePress = (fn) => {
    if (!fn) return;
    Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.15, duration: 80, useNativeDriver: true }),
      Animated.spring(pulseAnim, { toValue: 1, useNativeDriver: true, tension: 300 }),
    ]).start();
    fn();
  };

  const onPressIn = () =>
    Animated.spring(scaleAnim, { toValue: 0.95, useNativeDriver: true, tension: 200 }).start();
  const onPressOut = () =>
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 200 }).start();

  if (compact) {
    return (
      <Pressable
        onPress={() => handlePress(onIncrement)}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={styles.compact}
      >
        <Animated.View style={[styles.compactInner, { transform: [{ scale: scaleAnim }], backgroundColor: bg, borderColor: accentColor + '30' }]}>
          <Ionicons name={iconName} size={16} color={accentColor} />
          <Animated.Text style={[styles.compactValue, { color: accentColor, transform: [{ scale: pulseAnim }] }]}>
            {value}
          </Animated.Text>
          <Text style={styles.compactLabel} numberOfLines={1}>{label}</Text>
        </Animated.View>
      </Pressable>
    );
  }

  return (
    <View style={[styles.tile, { backgroundColor: bg, borderColor: accentColor + '40' }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={[styles.iconWrap, { backgroundColor: accentColor + '18' }]}>
          <Ionicons name={iconName} size={18} color={accentColor} />
        </View>
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
      </View>

      {/* Value */}
      <Animated.Text style={[styles.value, { color: accentColor, transform: [{ scale: pulseAnim }] }]}>
        {value}
      </Animated.Text>

      {/* Controls */}
      {(onIncrement || onDecrement) ? (
        <View style={styles.controls}>
          {onDecrement ? (
            <TouchableOpacity
              style={[styles.controlBtn, { borderColor: accentColor + '50' }]}
              onPress={() => handlePress(onDecrement)}
            >
              <Ionicons name="remove" size={14} color={accentColor} />
            </TouchableOpacity>
          ) : null}
          {onIncrement ? (
            <TouchableOpacity
              style={[styles.controlBtn, { borderColor: accentColor + '50', flex: 1 }]}
              onPress={() => handlePress(onIncrement)}
            >
              <Ionicons name="add" size={14} color={accentColor} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderRadius: 14,
    borderWidth: 1,
    padding: SPACING.md,
    gap: 8,
    flex: 1,
    minWidth: 100,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...FONTS.tiny,
    color: COLORS.textSecondary,
    flex: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  value: {
    ...FONTS.heading,
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
  controls: { flexDirection: 'row', gap: SPACING.xs },
  controlBtn: {
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    minWidth: 36,
  },
  // Compact styles
  compact: {},
  compactInner: {
    borderRadius: 10,
    borderWidth: 1,
    padding: SPACING.sm,
    alignItems: 'center',
    gap: 4,
    minWidth: 72,
  },
  compactValue: {
    ...FONTS.regular,
    fontWeight: '700',
    fontSize: 20,
  },
  compactLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    textAlign: 'center',
  },
});
