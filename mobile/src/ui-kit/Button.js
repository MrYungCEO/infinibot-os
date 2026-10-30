/**
 * Button + IconButton — canonical actions. Consolidates GlowButton.
 *
 * Variants
 *   'primary'   gold gradient fill, obsidian label. The ONE place a large
 *               gold fill is allowed — a primary CTA. Use at most one per
 *               visible screen region.
 *   'secondary' filled with the surface tone + gold hairline border
 *   'outline'   transparent + gold hairline border
 *   'ghost'     transparent, gold label, no border
 *   'danger'    error-toned outline (destructive actions)
 *
 * Sizes  sm (36 box / 44 tap via hitSlop) · md (44) · lg (52)
 *
 * Every size resolves to >= 44x44 of tappable area. `loading` swaps the label
 * for a spinner and blocks presses; `disabled` dims to 0.45 and blocks too.
 * Press feedback is a 0.97 scale + opacity, native-driven, skipped under
 * reduce-motion.
 */

import React, { useRef } from 'react';
import {
  View,
  Text,
  Animated,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, HIT } from './tokens';
import { useReducedMotion, a11yPress } from './a11y';
import { bestLabelOn, ensureFillOn } from './contrast';
import { withAlpha } from '../theme/color-utils';

const SIZES = {
  sm: { height: 36, padX: SPACE.md, gap: 6,        icon: 15, text: 'caption' },
  md: { height: 44, padX: SPACE.lg, gap: SPACE.sm, icon: 17, text: 'smallStrong' },
  lg: { height: 52, padX: SPACE.xl, gap: SPACE.sm, icon: 19, text: 'bodyStrong' },
};

function usePressScale(enabled) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v) => {
    if (!enabled) return;
    Animated.spring(scale, {
      toValue: v,
      useNativeDriver: true,
      speed: 50,
      // bounciness 0 — no overshoot. Dense UI must not wobble.
      bounciness: 0,
    }).start();
  };
  return { scale, onIn: () => to(0.97), onOut: () => to(1) };
}

export function Button({
  title,
  onPress,
  onLongPress,
  icon,
  iconRight,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  style,
  textStyle,
  accessibilityLabel,
  accessibilityHint,
  testID,
}) {
  const { colors, type } = useUIKit();
  const reduceMotion = useReducedMotion();
  const off = disabled || loading;
  const cfg = SIZES[size] || SIZES.md;
  const { scale, onIn, onOut } = usePressScale(!reduceMotion && !off);

  const tone = variant === 'danger' ? colors.error : colors.primary;
  const rawGradient = colors.goldGradient || [tone, tone, tone];
  // The primary variant is the one sanctioned large fill, so its label must
  // stay legible on EVERY stop of the gradient. Lifting it to clear only the
  // darkest stop pushes it past the lightest one (aurora's purple does this),
  // so pick the pole with the best worst-case instead. On gold the theme's own
  // obsidian label already clears everywhere and is kept verbatim.
  const primaryLabel = bestLabelOn(rawGradient, {
    min: 4.5,
    preferred: colors.userBubbleText || '#0a0a0e',
  });
  // If no label clears the brand gradient (aurora's mid-purple tops out at
  // 4.23:1 against pure white), deepen the fill rather than ship an
  // illegible CTA. Hue is preserved; on gold this is a no-op.
  const gradient = variant === 'primary' ? ensureFillOn(rawGradient, primaryLabel, 4.5) : rawGradient;
  const labelColor =
    variant === 'primary'
      ? primaryLabel
      : variant === 'secondary'
        ? colors.text
        : tone;

  const box = {
    height: cfg.height,
    minHeight: HIT.min >= cfg.height ? cfg.height : cfg.height,
    paddingHorizontal: cfg.padX,
    gap: cfg.gap,
    borderRadius: RADIUS.md,
  };

  const skin =
    variant === 'secondary'
      ? { backgroundColor: withAlpha(colors.text || '#fff', 0.06), borderWidth: 1, borderColor: withAlpha(tone, 0.28) }
      : variant === 'outline' || variant === 'danger'
        ? { backgroundColor: 'transparent', borderWidth: 1, borderColor: withAlpha(tone, 0.45) }
        : variant === 'ghost'
          ? { backgroundColor: 'transparent' }
          : null; // primary → gradient

  const content = (
    <>
      {loading ? (
        <ActivityIndicator size="small" color={labelColor} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={cfg.icon} color={labelColor} /> : null}
          {title ? (
            <Text style={[type[cfg.text], { color: labelColor }, textStyle]} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
          {iconRight ? <Ionicons name={iconRight} size={cfg.icon} color={labelColor} /> : null}
        </>
      )}
    </>
  );

  return (
    <Pressable
      onPress={off ? undefined : onPress}
      onLongPress={off ? undefined : onLongPress}
      onPressIn={onIn}
      onPressOut={onOut}
      disabled={off}
      hitSlop={cfg.height < HIT.min ? HIT.slop : undefined}
      testID={testID}
      style={fullWidth ? styles.fullWidth : undefined}
      {...a11yPress({
        label: accessibilityLabel || title,
        hint: accessibilityHint,
        disabled,
        busy: loading,
      })}
    >
      {({ pressed }) => (
        <Animated.View
          style={[
            styles.base,
            box,
            skin,
            fullWidth && styles.fullWidth,
            { transform: [{ scale }] },
            off && styles.off,
            pressed && !off && { opacity: 0.9 },
            style,
          ]}
        >
          {variant === 'primary' ? (
            <LinearGradient
              colors={gradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[StyleSheet.absoluteFill, { borderRadius: RADIUS.md }]}
              pointerEvents="none"
            />
          ) : null}
          {content}
        </Animated.View>
      )}
    </Pressable>
  );
}

/**
 * IconButton — square, icon-only. Always 44x44 of tap area.
 *
 * Props: icon, onPress, variant ('ghost' default | 'solid' | 'outline'),
 * size (sm 36 | md 44 | lg 52), tone (color override), badge (number|string),
 * accessibilityLabel (REQUIRED — an icon has no text for a screen reader).
 */
export function IconButton({
  icon,
  onPress,
  onLongPress,
  variant = 'ghost',
  size = 'md',
  tone,
  disabled = false,
  loading = false,
  badge,
  style,
  accessibilityLabel,
  accessibilityHint,
  testID,
}) {
  const { colors, type } = useUIKit();
  const reduceMotion = useReducedMotion();
  const off = disabled || loading;
  const box = size === 'sm' ? 36 : size === 'lg' ? 52 : HIT.min;
  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 22 : 19;
  const color = tone || colors.primary;
  const { scale, onIn, onOut } = usePressScale(!reduceMotion && !off);

  const skin =
    variant === 'solid'
      ? { backgroundColor: withAlpha(color, 0.14), borderWidth: 1, borderColor: withAlpha(color, 0.32) }
      : variant === 'outline'
        ? { backgroundColor: 'transparent', borderWidth: 1, borderColor: withAlpha(color, 0.32) }
        : { backgroundColor: 'transparent' };

  if (__DEV__ && !accessibilityLabel) {
    // eslint-disable-next-line no-console
    console.warn(`[ui-kit] IconButton "${icon}" is missing accessibilityLabel`);
  }

  return (
    <Pressable
      onPress={off ? undefined : onPress}
      onLongPress={off ? undefined : onLongPress}
      onPressIn={onIn}
      onPressOut={onOut}
      disabled={off}
      hitSlop={box < HIT.min ? HIT.slop : undefined}
      testID={testID}
      {...a11yPress({ label: accessibilityLabel || icon, hint: accessibilityHint, disabled, busy: loading })}
    >
      <Animated.View
        style={[
          styles.base,
          skin,
          { width: box, height: box, borderRadius: RADIUS.md, transform: [{ scale }] },
          off && styles.off,
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={color} />
        ) : (
          <Ionicons name={icon} size={iconSize} color={color} />
        )}
        {badge !== undefined && badge !== null && badge !== 0 ? (
          <View style={[styles.badge, { backgroundColor: colors.error }]}>
            <Text style={[type.caption, { color: '#fff' }]} numberOfLines={1}>
              {badge}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  fullWidth: { alignSelf: 'stretch', width: '100%' },
  off: { opacity: 0.45 },
  badge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default Button;
