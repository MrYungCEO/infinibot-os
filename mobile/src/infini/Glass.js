/**
 * <GlassButton> — the Infini page's frosted-glass control.
 *
 * Blurred backdrop (expo-blur), a faint top-lit sheen, a hairline gold
 * border with a brighter top edge, and a polished press state (spring scale
 * + border/sheen brighten + a soft haptic tick) — all on the UI thread.
 *
 * Tones: 'glass' (default), 'gold' (primary action), 'danger' (end call),
 * 'ghost' (light secondary chrome: thin fill, no blur, softer hairline).
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { haptic } from './InfiniFace';

export const GLASS = {
  gold: '#e9b949',
  goldHi: '#fbe6a2',
  hairline: 'rgba(233, 185, 73, 0.34)',
  hairlineHot: 'rgba(251, 230, 162, 0.85)',
  fill: 'rgba(16, 13, 8, 0.74)',
  fillPressed: 'rgba(46, 34, 12, 0.66)',
  text: '#f4ead2',
  textMuted: 'rgba(244, 234, 210, 0.62)',
  danger: '#c2412f',
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function GlassButton({
  children,
  onPress,
  onPressIn,
  onPressOut,
  onLongPress,
  style,
  contentStyle,
  radius = 999,
  tone = 'glass',
  active = false,
  reduced = false,
  hapticKind = 'soft',
  blur = true,
  ...a11y
}) {
  const p = useSharedValue(0);
  const anim = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - 0.045 * p.value }],
  }));
  const sheen = useAnimatedStyle(() => ({ opacity: 0.55 + 0.45 * p.value }));
  const ghost = tone === 'ghost';
  const border = tone === 'danger' ? 'rgba(255, 170, 150, 0.55)' : active ? GLASS.hairlineHot : ghost ? 'rgba(233, 185, 73, 0.2)' : GLASS.hairline;
  const fill = tone === 'danger' ? 'rgba(178, 52, 38, 0.86)' : tone === 'gold' || active ? 'rgba(52, 38, 13, 0.8)' : ghost ? 'rgba(14, 11, 7, 0.34)' : GLASS.fill;

  return (
    <AnimatedPressable
      onPressIn={(e) => {
        p.value = reduced ? 1 : withSpring(1, { damping: 18, stiffness: 520 });
        if (hapticKind) haptic(hapticKind);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        p.value = reduced ? 0 : withTiming(0, { duration: 180 });
        onPressOut?.(e);
      }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[{ borderRadius: radius }, style, anim]}
      {...a11y}
    >
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]} pointerEvents="none">
        {blur && !ghost && Platform.OS !== 'android' ? <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
        <Animated.View style={[StyleSheet.absoluteFill, sheen]}>
          <LinearGradient
            colors={tone === 'danger' ? ['rgba(255,190,170,0.28)', 'rgba(255,190,170,0)'] : ['rgba(255,240,200,0.14)', 'rgba(255,240,200,0.02)', 'rgba(255,240,200,0)']}
            locations={tone === 'danger' ? [0, 1] : [0, 0.45, 1]}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </View>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1, borderColor: border }]} />
      <View style={[styles.content, contentStyle]}>{children}</View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
