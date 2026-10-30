/**
 * Card — the canonical glass surface. Consolidates GlassCard + GlassSurface.
 *
 * Layer stack (outer → inner), unchanged from the pre-kit recipe so existing
 * screens look identical:
 *   shadow wrapper        carries elevation, never clips children
 *     clip wrapper        overflow hidden + radius
 *       BlurView          backdrop blur of the AnimatedBackground behind
 *       tint gradient     tint@0.10 → tint@0.02 → black@0.35
 *       inner-top light   white edge "lift"
 *       hairline border   1px tint @ 0.18
 *     children
 *
 * Gold rule: the tint gradient tops out at 10% alpha and the border is a
 * hairline. Gold is an edge and a wash, never a fill.
 *
 * Props
 *   tint         'primary' | 'neutral' | 'success' | 'warning' | 'danger'
 *   depth        0 | 1 | 2 | 3           elevation tier (default 1)
 *   radius       number                  default RADIUS.lg (16)
 *   intensity    number                  blur override; defaults per depth
 *   glow         boolean                 outer tint-colored glow ring
 *   cornerAccents boolean                4 corner ticks (HUD flavour)
 *   padded       boolean | number        inner padding; true → SPACE.lg
 *   animated     boolean                 fade + rise on mount
 *   delay        number                  animation delay (ms)
 *   onPress      fn                      makes the whole card a button
 *   accessibilityLabel string            REQUIRED when onPress is set
 */

import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Pressable } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { useUIKit, SPACE, RADIUS, ELEVATION, MOTION, blurFor } from './tokens';
import { useReducedMotion, a11yPress } from './a11y';
import { withAlpha, glassGradient, innerTopHighlight } from '../theme/color-utils';

const DEPTH_BLUR = { 0: 24, 1: 40, 2: 55, 3: 70 };

export function resolveTint(tint, colors) {
  switch (tint) {
    case 'success': return colors.success;
    case 'warning': return colors.warning;
    case 'danger':  return colors.error;
    case 'info':    return colors.info;
    case 'accent':  return colors.accent;
    case 'neutral': return colors.foreground || colors.text || '#ffffff';
    case 'primary':
    default:        return colors.primary;
  }
}

export function Card({
  children,
  style,
  tint = 'primary',
  depth = 1,
  radius = RADIUS.lg,
  intensity,
  glow = false,
  cornerAccents = false,
  padded = false,
  animated = false,
  delay = 0,
  onPress,
  onLongPress,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
}) {
  const { colors } = useUIKit();
  const reduceMotion = useReducedMotion();
  const tintColor = resolveTint(tint, colors);

  const shouldAnimate = animated && !reduceMotion;
  const fade = useRef(new Animated.Value(shouldAnimate ? 0 : 1)).current;
  const rise = useRef(new Animated.Value(shouldAnimate ? MOTION.rise : 0)).current;

  useEffect(() => {
    if (!shouldAnimate) {
      fade.setValue(1);
      rise.setValue(0);
      return undefined;
    }
    const anim = Animated.parallel([
      Animated.timing(fade, {
        toValue: 1, duration: MOTION.enter, delay, useNativeDriver: true,
      }),
      Animated.timing(rise, {
        toValue: 0, duration: MOTION.enter, delay, useNativeDriver: true,
      }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [shouldAnimate, delay, fade, rise]);

  const shadow = glow
    ? {
        shadowColor: tintColor,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.22,
        shadowRadius: 18,
        elevation: (ELEVATION[depth]?.elevation || 5) + 5,
      }
    : ELEVATION[depth] || ELEVATION[1];

  const pad = padded === true ? SPACE.lg : typeof padded === 'number' ? padded : 0;

  const glass = (
    <View
      style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}
      pointerEvents="none"
    >
      <BlurView
        intensity={blurFor(intensity !== undefined ? intensity : DEPTH_BLUR[depth] ?? 40)}
        tint="dark"
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={glassGradient(tintColor)}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={innerTopHighlight}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 0.55 }}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: radius, borderWidth: 1, borderColor: withAlpha(tintColor, 0.18) },
        ]}
      />
    </View>
  );

  const corners = cornerAccents ? (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.corner, styles.cornerTL, { borderTopColor: tintColor, borderLeftColor: tintColor, borderTopLeftRadius: radius }]} />
      <View style={[styles.corner, styles.cornerTR, { borderTopColor: tintColor, borderRightColor: tintColor, borderTopRightRadius: radius }]} />
      <View style={[styles.corner, styles.cornerBL, { borderBottomColor: tintColor, borderLeftColor: tintColor, borderBottomLeftRadius: radius }]} />
      <View style={[styles.corner, styles.cornerBR, { borderBottomColor: tintColor, borderRightColor: tintColor, borderBottomRightRadius: radius }]} />
    </View>
  ) : null;

  const inner = (
    <>
      {glass}
      {pad ? <View style={{ padding: pad }}>{children}</View> : children}
      {corners}
    </>
  );

  const boxStyle = [{ borderRadius: radius, position: 'relative' }, shadow, style];
  const animStyle = shouldAnimate
    ? { opacity: fade, transform: [{ translateY: rise }] }
    : null;

  if (onPress || onLongPress) {
    return (
      <Animated.View style={animStyle}>
        <Pressable
          onPress={disabled ? undefined : onPress}
          onLongPress={disabled ? undefined : onLongPress}
          disabled={disabled}
          testID={testID}
          style={({ pressed }) => [
            boxStyle,
            pressed && { opacity: 0.82, transform: [{ scale: 0.995 }] },
            disabled && { opacity: 0.5 },
          ]}
          {...a11yPress({ label: accessibilityLabel, hint: accessibilityHint, disabled })}
        >
          {inner}
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[boxStyle, animStyle]} testID={testID}>
      {inner}
    </Animated.View>
  );
}

const CORNER = 12;
const CORNER_W = 1.5;

const styles = StyleSheet.create({
  corner: { position: 'absolute', width: CORNER, height: CORNER, opacity: 0.6 },
  cornerTL: { top: -1, left: -1, borderTopWidth: CORNER_W, borderLeftWidth: CORNER_W },
  cornerTR: { top: -1, right: -1, borderTopWidth: CORNER_W, borderRightWidth: CORNER_W },
  cornerBL: { bottom: -1, left: -1, borderBottomWidth: CORNER_W, borderLeftWidth: CORNER_W },
  cornerBR: { bottom: -1, right: -1, borderBottomWidth: CORNER_W, borderRightWidth: CORNER_W },
});

export default Card;
