/**
 * Skeleton — loading placeholder with a soft opacity pulse.
 *
 * Opacity-only (native driver) so it costs nothing on the JS thread, and it
 * freezes to a flat block under reduce-motion. Never animate width/left here:
 * a translating shimmer bar inside a long list is the classic mobile jank
 * source.
 *
 * Props: width (number|%), height, radius, style, count (stacked lines), gap
 */

import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

import { useUIKit, RADIUS, SPACE, MOTION } from './tokens';
import { useReducedMotion } from './a11y';
import { withAlpha } from '../theme/color-utils';

export function Skeleton({
  width = '100%',
  height = 14,
  radius = RADIUS.sm,
  count = 1,
  gap = SPACE.sm,
  style,
  testID,
}) {
  const { colors } = useUIKit();
  const reduceMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(reduceMotion ? 0.5 : 0.35)).current;

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(0.5);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.7, duration: MOTION.loop, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: MOTION.loop, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, pulse]);

  const base = withAlpha(colors.text || '#fff', 0.09);

  return (
    <View style={[count > 1 && { gap }, style]} accessibilityRole="progressbar" accessibilityLabel="Loading" testID={testID}>
      {Array.from({ length: count }).map((_, i) => (
        <Animated.View
          key={i}
          style={{
            width: i === count - 1 && count > 1 ? '70%' : width,
            height,
            borderRadius: radius,
            backgroundColor: base,
            opacity: pulse,
          }}
        />
      ))}
    </View>
  );
}

/** SkeletonRow — a ListRow-shaped placeholder for list loading states. */
export function SkeletonRow({ avatar = true, style }) {
  return (
    <View style={[styles.row, style]}>
      {avatar ? <Skeleton width={34} height={34} radius={RADIUS.sm} /> : null}
      <View style={styles.col}>
        <Skeleton width="55%" height={14} />
        <Skeleton width="80%" height={11} />
      </View>
      <Skeleton width={40} height={12} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: SPACE.md, paddingHorizontal: SPACE.md },
  col: { flex: 1, gap: SPACE.sm },
});

export default Skeleton;
