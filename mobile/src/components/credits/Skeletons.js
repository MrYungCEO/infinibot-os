/**
 * Loading skeletons for the Credits screen — gentle pulse blocks that match the
 * gold-glass theme. Shown on first load before any RPC has resolved.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

function useShimmer() {
  const anim = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 0.9, duration: 800, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.4, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return anim;
}

function Block({ style, colors, opacity }) {
  return (
    <Animated.View
      style={[{ backgroundColor: colors.primary + '1a', borderRadius: 8, opacity }, style]}
    />
  );
}

export function CreditsSkeleton({ colors }) {
  const opacity = useShimmer();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View>
      <Block colors={colors} opacity={opacity} style={styles.total} />
      <View style={styles.row2}>
        <Block colors={colors} opacity={opacity} style={styles.card} />
        <Block colors={colors} opacity={opacity} style={styles.card} />
      </View>
      <View style={styles.row2}>
        <Block colors={colors} opacity={opacity} style={styles.card} />
        <Block colors={colors} opacity={opacity} style={styles.card} />
      </View>
      <Block colors={colors} opacity={opacity} style={styles.chart} />
      <Block colors={colors} opacity={opacity} style={styles.donut} />
      {[0, 1, 2].map((i) => (
        <Block key={i} colors={colors} opacity={opacity} style={styles.line} />
      ))}
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
    total: { height: 96, marginBottom: 16 },
    row2: { flexDirection: 'row', gap: 10, marginBottom: 10 },
    card: { flex: 1, height: 150, borderRadius: 14 },
    chart: { height: 170, marginVertical: 14 },
    donut: { height: 180, marginBottom: 14 },
    line: { height: 48, marginBottom: 8 },
  });
}

export default CreditsSkeleton;
