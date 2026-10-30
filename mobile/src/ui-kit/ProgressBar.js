/**
 * ProgressBar — determinate + indeterminate.
 *
 * Determinate: a gold gradient fill inside a recessed track. This is the one
 * other place gold gets area, and it is bounded by the value itself.
 * Indeterminate (`value === null/undefined`): a translating shimmer segment,
 * native-driven; under reduce-motion it degrades to a static 35% fill so the
 * user still sees "work in progress" without motion.
 *
 * Props
 *   value      0..1 (or 0..100 — anything > 1 is treated as a percentage)
 *   tone       chip tone (default 'primary')
 *   height     number (default 6)
 *   label      string   shown above the bar
 *   showValue  boolean  render the percentage on the right, monospaced
 *   trackTone  color override for the track
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, StyleSheet, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { useUIKit, SPACE, RADIUS } from './tokens';
import { useReducedMotion } from './a11y';
import { toneColor } from './Chip';
import { withAlpha } from '../theme/color-utils';

function normalize(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  const ratio = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, ratio));
}

export function ProgressBar({
  value,
  tone = 'primary',
  height = 6,
  label,
  showValue = false,
  trackTone,
  style,
  testID,
}) {
  const { colors, type } = useUIKit();
  const reduceMotion = useReducedMotion();
  const ratio = normalize(value);
  const indeterminate = ratio === null;
  const c = toneColor(tone, colors);

  const [width, setWidth] = useState(0);
  const slide = useRef(new Animated.Value(0)).current;
  const fill = useRef(new Animated.Value(ratio ?? 0)).current;

  // Determinate: animate to the new ratio. Width interpolation can't use the
  // native driver, so keep it short and only run it when the value moves.
  useEffect(() => {
    if (indeterminate) return undefined;
    if (reduceMotion) {
      fill.setValue(ratio);
      return undefined;
    }
    const anim = Animated.timing(fill, {
      toValue: ratio,
      duration: 320,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [ratio, indeterminate, reduceMotion, fill]);

  // Indeterminate: translate a segment across the track.
  useEffect(() => {
    if (!indeterminate || reduceMotion || !width) return undefined;
    slide.setValue(0);
    const loop = Animated.loop(
      Animated.timing(slide, {
        toValue: 1,
        duration: 1200,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [indeterminate, reduceMotion, width, slide]);

  const segmentWidth = Math.max(48, width * 0.35);
  const translate = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-segmentWidth, width || segmentWidth],
  });

  return (
    <View
      style={style}
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label || 'Progress'}
      accessibilityValue={
        indeterminate ? undefined : { min: 0, max: 100, now: Math.round(ratio * 100) }
      }
    >
      {label || showValue ? (
        <View style={styles.labelRow}>
          {label ? (
            <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>
              {label}
            </Text>
          ) : null}
          {showValue && !indeterminate ? (
            <Text style={[type.monoSmall, { color: colors.textMuted }]}>
              {Math.round(ratio * 100)}%
            </Text>
          ) : null}
        </View>
      ) : null}

      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={[
          styles.track,
          {
            height,
            borderRadius: height / 2,
            backgroundColor: trackTone || withAlpha(colors.text || '#fff', 0.08),
          },
        ]}
      >
        {indeterminate ? (
          reduceMotion ? (
            <View style={{ width: '35%', height: '100%', backgroundColor: withAlpha(c, 0.7), borderRadius: height / 2 }} />
          ) : (
            <Animated.View
              style={{
                width: segmentWidth,
                height: '100%',
                transform: [{ translateX: translate }],
              }}
            >
              <LinearGradient
                colors={['transparent', c, 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[StyleSheet.absoluteFill, { borderRadius: height / 2 }]}
              />
            </Animated.View>
          )
        ) : (
          <Animated.View
            style={{
              width: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
              height: '100%',
              borderRadius: height / 2,
              overflow: 'hidden',
            }}
          >
            <LinearGradient
              colors={
                tone === 'primary' && colors.goldGradient
                  ? colors.goldGradient
                  : [withAlpha(c, 0.85), c]
              }
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.xs },
  track: { width: '100%', overflow: 'hidden', borderRadius: RADIUS.pill },
});

export default ProgressBar;
