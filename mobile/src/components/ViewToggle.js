import React from 'react';
import { View, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';

const MODES = [
  { key: 'board',   icon: 'apps-outline' },
  { key: 'gallery', icon: 'images-outline' },
  { key: 'list',    icon: 'list-outline' },
];

function alpha(hex, a) {
  if (!hex) return `rgba(255,255,255,${a})`;
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// 3-way segmented control: Board / Gallery / List.
// Self-contained — does not depend on parent styles.
// Pass `accent` (the active-state color) and `muted` (inactive icon color).
export function ViewToggle({ viewMode, setViewMode, accent = '#D4AF37', muted = '#71717A', compact = true }) {
  return (
    <View style={styles.wrap}>
      <BlurView intensity={Platform.OS === 'android' ? 30 : 50} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.32)' }]} />
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: alpha(accent, 0.22) }]}
      />
      <View style={styles.row}>
        {MODES.map(mode => {
          const active = viewMode === mode.key;
          return (
            <TouchableOpacity
              key={mode.key}
              onPress={() => setViewMode(mode.key)}
              activeOpacity={0.75}
              style={[
                styles.btn,
                compact && styles.btnCompact,
                active && { backgroundColor: alpha(accent, 0.22), borderColor: alpha(accent, 0.4) },
              ]}
              hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${mode.key} view`}
            >
              <Ionicons
                name={mode.icon}
                size={compact ? 14 : 16}
                color={active ? accent : muted}
              />
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    padding: 2,
  },
  btn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    marginHorizontal: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnCompact: {
    paddingHorizontal: 7,
    paddingVertical: 5,
  },
});

export default ViewToggle;
