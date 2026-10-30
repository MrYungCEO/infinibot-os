// AmbientBackground — app-wide cinematic backdrop.
//
// Layer stack (back → front, all absolute-fill, pointerEvents='none'):
//   1. Solid #000 base
//   2. Two crossed deep-color gradients keyed off `colors.primary`, each
//      slowly pulsing alpha via Animated.loop so the atmosphere breathes
//   3. Static SVG grid (~40px cells) tinted with the primary, drawn through
//      a vignette-aware mask of overlay gradients
//   4. Vignette — vertical + horizontal black→transparent→black gradients
//      stacked to fake a radial fade toward the screen edges
//
// The component is theme-reactive: it reads `colors.primary` via useTheme()
// so a palette switch (red → gold → violet …) re-tints the gradient
// immediately. It does NOT animate the grid; only the two gradient layers
// breathe.
//
// A full-screen opaque page on top (the Infini call page) can pause the
// breathing with useAmbientPause(true): the backdrop is fully hidden there,
// and otherwise its two full-screen layers keep animating underneath every
// frame (on web the non-native Animated driver also re-renders React per
// frame).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, View, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, Pattern, Path, Rect } from 'react-native-svg';

import { useTheme } from '../theme/ThemeProvider';
import { rgba } from '../theme/palettes';

const GRID_CELL = 40;

// ── pause requests (ref-counted, so overlapping pages don't fight) ──────────
let pauseCount = 0;
const pauseListeners = new Set();
function setPaused(delta) {
  const was = pauseCount > 0;
  pauseCount = Math.max(0, pauseCount + delta);
  if (was !== pauseCount > 0) pauseListeners.forEach((l) => l(pauseCount > 0));
}

/** While `paused` is true, the app-wide backdrop stops breathing. */
export function useAmbientPause(paused) {
  useEffect(() => {
    if (!paused) return undefined;
    setPaused(1);
    return () => setPaused(-1);
  }, [paused]);
}

function useAmbientPaused() {
  const [p, setP] = useState(pauseCount > 0);
  useEffect(() => {
    pauseListeners.add(setP);
    setP(pauseCount > 0);
    return () => pauseListeners.delete(setP);
  }, []);
  return p;
}

function PulseGradient({ colors, direction, opacityAnim, style }) {
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { opacity: opacityAnim }, style]}
    >
      <LinearGradient
        colors={colors}
        start={direction.start}
        end={direction.end}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

function StaticGrid({ stroke }) {
  return (
    <Svg
      width="100%"
      height="100%"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <Defs>
        <Pattern
          id="ambientGrid"
          width={GRID_CELL}
          height={GRID_CELL}
          patternUnits="userSpaceOnUse"
        >
          <Path
            d={`M ${GRID_CELL} 0 L 0 0 0 ${GRID_CELL}`}
            fill="none"
            stroke={stroke}
            strokeWidth={0.6}
          />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#ambientGrid)" />
    </Svg>
  );
}

function Vignette() {
  // Two stacked gradients (vertical + horizontal) approximate a radial
  // black→transparent→black fade. The center stays clear; the corners pile
  // up to the strongest dim.
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        colors={['rgba(0,0,0,0.85)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.85)']}
        locations={[0, 0.5, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['rgba(0,0,0,0.6)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.6)']}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

export function AmbientBackground({ children }) {
  const { colors } = useTheme();
  const primary = colors?.primary || '#fbbf24';

  // Two independent opacity loops so the layers crossfade slightly out of
  // phase — gives the breath a little asymmetry.
  const pulseA = useRef(new Animated.Value(0.55)).current;
  const pulseB = useRef(new Animated.Value(0.35)).current;
  const paused = useAmbientPaused();

  useEffect(() => {
    if (paused) return undefined;
    const loopA = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseA, {
          toValue: 0.95,
          duration: 5200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulseA, {
          toValue: 0.45,
          duration: 5200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    const loopB = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseB, {
          toValue: 0.7,
          duration: 7400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulseB, {
          toValue: 0.25,
          duration: 7400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loopA.start();
    loopB.start();
    return () => {
      loopA.stop();
      loopB.stop();
    };
  }, [pulseA, pulseB, paused]);

  // Re-derive the gradient stops whenever the primary swaps.
  const verticalStops = useMemo(
    () => ['#000000', rgba(primary, 0.22), '#000000'],
    [primary],
  );
  const horizontalStops = useMemo(
    () => [rgba(primary, 0.10), 'transparent', rgba(primary, 0.10)],
    [primary],
  );
  const gridStroke = useMemo(() => rgba(primary, 0.16), [primary]);

  return (
    <View style={styles.root}>
      {/* Layers 1–4: the ambient backdrop. All pointer-transparent. */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {/* 1. Solid base */}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />

        {/* 2. Cross-stacked gradients pulsing alpha */}
        <PulseGradient
          colors={verticalStops}
          direction={{ start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } }}
          opacityAnim={pulseA}
        />
        <PulseGradient
          colors={horizontalStops}
          direction={{ start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } }}
          opacityAnim={pulseB}
        />

        {/* 3. Static grid */}
        <StaticGrid stroke={gridStroke} />

        {/* 4. Vignette — dims corners, lifts the middle */}
        <Vignette />
      </View>

      {/* Foreground — navigators, overlays, modals. */}
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  content: { flex: 1, backgroundColor: 'transparent' },
});

export default AmbientBackground;
