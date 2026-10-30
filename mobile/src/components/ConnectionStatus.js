import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { PulsingDot } from './PulsingDot';
import { COLORS, FONTS, SPACING } from '../constants/theme';

const STATUS_CONFIG = {
  disconnected: { color: COLORS.textMuted, label: 'OFFLINE', canReconnect: true },
  connecting: { color: COLORS.warning, label: 'CONNECTING...', canReconnect: false },
  connected: { color: COLORS.success, label: 'CONNECTED', canReconnect: false },
  error: { color: COLORS.error, label: 'ERROR', canReconnect: true },
};

export function ConnectionStatus({ status, onReconnect }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.disconnected;

  return (
    <TouchableOpacity
      style={styles.wrapper}
      onPress={config.canReconnect ? onReconnect : undefined}
      activeOpacity={config.canReconnect ? 0.7 : 1}
    >
      <BlurView intensity={30} tint="dark" style={styles.blur}>
        <View style={styles.container}>
          <View style={styles.left}>
            <PulsingDot color={config.color} size={6} />
            <Text style={[styles.label, { color: config.color }]}>
              {config.label}
            </Text>
          </View>
          <View style={styles.right}>
            {config.canReconnect && (
              <Text style={styles.tapHint}>tap to reconnect</Text>
            )}
            {status === 'connected' && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="radio" size={10} color={COLORS.success} style={{ opacity: 0.5 }} />
                <Text style={styles.live}>LIVE</Text>
              </View>
            )}
          </View>
        </View>
      </BlurView>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    overflow: 'hidden',
  },
  blur: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingVertical: 6,
    backgroundColor: 'rgba(5, 5, 5, 0.6)',
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    ...FONTS.mono,
    fontWeight: '600',
    letterSpacing: 1.5,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tapHint: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    opacity: 0.6,
  },
  live: {
    ...FONTS.mono,
    color: COLORS.success,
    opacity: 0.5,
  },
});
