import React, { useRef, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, FONTS, SPACING } from '../../constants/theme';

const SEVERITY_COLORS = {
  info: '#3B82F6',
  success: '#10B981',
  warn: '#F59E0B',
  error: '#EF4444',
  critical: '#DC2626',
};

const SEVERITY_ICONS = {
  info: 'information-circle',
  success: 'checkmark-circle',
  warn: 'warning',
  error: 'alert-circle',
  critical: 'nuclear',
};

export function AlertBanner({ alerts = [], onDismiss, onPress }) {
  if (!alerts.length) return null;
  return (
    <View style={styles.stack}>
      {alerts.slice(0, 3).map((alert, i) => (
        <SingleAlert
          key={alert.id || i}
          alert={alert}
          onDismiss={() => onDismiss?.(alert)}
          onPress={() => onPress?.(alert)}
        />
      ))}
      {alerts.length > 3 ? (
        <Text style={styles.more}>+{alerts.length - 3} more alerts</Text>
      ) : null}
    </View>
  );
}

function SingleAlert({ alert, onDismiss, onPress }) {
  const severity = alert.severity || 'info';
  const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.info;
  const iconName = SEVERITY_ICONS[severity] || 'information-circle';

  const slideAnim = useRef(new Animated.Value(-8)).current;
  const opacAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: 0, duration: 250, useNativeDriver: true }),
      Animated.timing(opacAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View
      style={[
        styles.banner,
        {
          backgroundColor: color + '12',
          borderColor: color + '40',
          opacity: opacAnim,
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      <TouchableOpacity style={styles.bannerInner} onPress={onPress} activeOpacity={0.8}>
        <Ionicons name={iconName} size={16} color={color} />
        <View style={styles.bannerBody}>
          {alert.title ? (
            <Text style={[styles.bannerTitle, { color }]} numberOfLines={1}>{alert.title}</Text>
          ) : null}
          <Text style={styles.bannerText} numberOfLines={2}>
            {alert.body || alert.message || ''}
          </Text>
        </View>
        {onDismiss ? (
          <TouchableOpacity onPress={onDismiss} hitSlop={12} style={styles.dismissBtn}>
            <Ionicons name="close" size={14} color={COLORS.textMuted} />
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SPACING.xs },
  banner: {
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  bannerInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: SPACING.sm,
    gap: SPACING.sm,
  },
  bannerBody: { flex: 1, gap: 2 },
  bannerTitle: { ...FONTS.small, fontWeight: '700', fontSize: 12 },
  bannerText: { ...FONTS.tiny, color: COLORS.textSecondary, lineHeight: 16 },
  dismissBtn: { alignSelf: 'center' },
  more: { ...FONTS.tiny, color: COLORS.textMuted, textAlign: 'center', paddingVertical: 4 },
});
