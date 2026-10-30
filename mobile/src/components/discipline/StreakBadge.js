import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, FONTS, SPACING } from '../../constants/theme';

const MILESTONE_DAYS = [3, 7, 14, 30, 60, 100];

function milestoneReached(streak) {
  // Returns the highest milestone that has been reached
  return MILESTONE_DAYS.filter(m => streak >= m).pop() || null;
}

export function StreakBadge({ streak = 0, label, size = 'md' }) {
  const milestone = milestoneReached(streak);
  const isHot = streak >= 3;
  const accentColor = streak === 0
    ? COLORS.textMuted
    : streak >= 14
    ? '#F59E0B'
    : COLORS.primary;

  if (size === 'sm') {
    return (
      <View style={[styles.pill, { borderColor: accentColor + '50', backgroundColor: accentColor + '12' }]}>
        {isHot ? <Ionicons name="flame" size={11} color={accentColor} /> : null}
        <Text style={[styles.pillText, { color: accentColor }]}>
          {streak}d
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.badge, { borderColor: accentColor + '40', backgroundColor: accentColor + '0A' }]}>
      <View style={styles.left}>
        {isHot ? (
          <Ionicons name="flame" size={20} color={accentColor} />
        ) : (
          <Ionicons name="calendar-outline" size={18} color={COLORS.textMuted} />
        )}
      </View>
      <View style={styles.body}>
        <Text style={[styles.value, { color: accentColor }]}>
          {streak} day{streak !== 1 ? 's' : ''}
        </Text>
        {label ? <Text style={styles.label} numberOfLines={1}>{label}</Text> : null}
      </View>
      {milestone ? (
        <View style={[styles.milestonePill, { backgroundColor: accentColor + '20', borderColor: accentColor + '60' }]}>
          <Text style={[styles.milestoneText, { color: accentColor }]}><Ionicons name="trophy-outline" size={10} color={accentColor} /> {milestone}d</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  left: { width: 24, alignItems: 'center' },
  body: { flex: 1, gap: 1 },
  value: { ...FONTS.regular, fontWeight: '700', fontSize: 15 },
  label: { ...FONTS.tiny, color: COLORS.textSecondary, fontSize: 10 },
  milestonePill: {
    borderRadius: 99,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  milestoneText: { ...FONTS.tiny, fontWeight: '700', fontSize: 10 },
  // sm pill
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: 99,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pillText: { ...FONTS.tiny, fontWeight: '700', fontSize: 10 },
});
