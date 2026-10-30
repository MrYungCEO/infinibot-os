/**
 * <InfiniBackdrop> — the cinematic stage behind the Infini character.
 *
 *   base     deep radial gradient centred on the face, with two faint static
 *            nebula clouds (violet up-left, teal down-right) baked into the
 *            same SVG — no cost per frame
 *   aurora   three slow-drifting gold / teal / violet nebula blobs
 *   dust     far specks are baked into the static base; a near layer of
 *            brighter specks drifts and twinkles over them (parallax)
 *   pool     a soft light pool behind/under the face that takes the mood:
 *            warm gold (idle / speaking) cross-fades to a cool tint
 *            (listening green-cyan, thinking violet-blue, error red)
 *   grain + vignette
 *
 * Performance: every layer is a static SVG / PNG rasterised once (the dust
 * field is a deterministic seed, so it never changes); motion is native
 * transforms + opacity on the UI thread, all driven by ONE shared clock. The
 * light pool only animates opacity on a state change. No per-frame JS, no
 * per-frame SVG edits, no full-screen blur.
 *
 * Still (clock stopped) with Reduce Motion, while `paused` (screen unfocused /
 * app backgrounded) or with `motion={false}` (low-end Android). `lite`
 * (low-end) also drops the near dust layer and the violet blob.
 *
 * `clear`: rects (screen coords) the dust keeps out of — the status text.
 *
 * Purely decorative: pointerEvents none, hidden from accessibility.
 */
import React, { useEffect, useMemo } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Defs, Ellipse, G, RadialGradient, Rect, Stop } from 'react-native-svg';

import { dustField, moodLight } from './backdrop-math';

const GRAIN = require('../../assets/infini/grain.png');
const TAU = 6.2832;
// Web: give every backdrop layer its own compositor layer, so drifting one is
// a GPU transform and the face repainting above never re-rasterises the
// gradients underneath (native views already behave this way).
const LAYER = Platform.OS === 'web' ? { willChange: 'transform' } : null;

function AuroraBlob({ progress, size, color, opacity, x, y, drift, spin, phase = 0 }) {
  const style = useAnimatedStyle(() => {
    const p = (progress.value + phase) % 1;
    const s = Math.sin(p * TAU);
    const c = Math.cos(p * TAU);
    return {
      transform: [
        { translateX: x + s * drift },
        { translateY: y + c * drift * 0.6 },
        { rotate: `${p * spin}deg` },
        { scaleX: 1 + 0.12 * s },
        { scaleY: 0.72 + 0.08 * c },
      ],
    };
  });
  const id = `aur${color.replace('#', '')}`;
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: size, height: size }, LAYER, style]}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color} stopOpacity={opacity} />
            <Stop offset="0.5" stopColor={color} stopOpacity={opacity * 0.4} />
            <Stop offset="1" stopColor={color} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Ellipse cx="50" cy="50" rx="50" ry="50" fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

/** One static dust layer, drifted (and optionally twinkled) by the shared clock. */
function DustLayer({ progress, specks, width, height, pad, drift, phase = 0, twinkle = false, color = '#f6e7c0' }) {
  const style = useAnimatedStyle(() => {
    const p = (progress.value + phase) % 1;
    return {
      opacity: twinkle ? 0.72 + 0.28 * Math.sin(p * TAU * 3) : 1,
      transform: [{ translateX: -pad + Math.sin(p * TAU) * drift }, { translateY: -pad + Math.cos(p * TAU) * drift * 0.5 }],
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: width + pad * 2, height: height + pad * 2 }, LAYER, style]}>
      <Svg width={width + pad * 2} height={height + pad * 2}>
        <G fill={color}>
          {specks.map((d, i) => (
            <Circle key={i} cx={d.x} cy={d.y} r={d.r} opacity={d.o} />
          ))}
        </G>
      </Svg>
    </Animated.View>
  );
}

/** A soft elliptical light pool (static bitmap); only its opacity animates. */
function LightPool({ level, color, left, top, w, h, id }) {
  const style = useAnimatedStyle(() => ({ opacity: level.value }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left, top, width: w, height: h }, LAYER, style]}>
      <Svg width={w} height={h} viewBox="0 0 100 100" preserveAspectRatio="none">
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color} stopOpacity="0.42" />
            <Stop offset="0.45" stopColor={color} stopOpacity="0.15" />
            <Stop offset="1" stopColor={color} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Ellipse cx="50" cy="50" rx="50" ry="50" fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

const CYCLE_MS = 34000;

export function InfiniBackdrop({ width, height, cx, cy, faceSize, clear = [], reduced = false, paused = false, motion = true, lite = false, mood = 'idle' }) {
  const progress = useSharedValue(0.15);
  const still = reduced || paused || !motion;
  useEffect(() => {
    if (still) {
      cancelAnimation(progress);
      if (reduced || !motion) progress.value = 0.15;
      return undefined;
    }
    // Resume from wherever it stopped (layers read `progress % 1`, so a lap
    // from p to p + 1 is seamless).
    const from = progress.value % 1;
    progress.value = from;
    progress.value = withRepeat(withTiming(from + 1, { duration: CYCLE_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(progress);
  }, [still]); // eslint-disable-line react-hooks/exhaustive-deps

  // Light pool: cross-fade warm ↔ cool on a state change (opacity only).
  const light = moodLight(mood);
  const warm = useSharedValue(light.warm);
  const cool = useSharedValue(light.cool);
  useEffect(() => {
    const t = { duration: reduced ? 0 : 700, easing: Easing.inOut(Easing.quad) };
    warm.value = withTiming(light.warm, t);
    cool.value = withTiming(light.cool, t);
  }, [light.warm, light.cool, reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  const big = Math.max(width, height);
  const auraSize = big * 1.1;
  const R = big * 0.95;
  const err = mood === 'error';

  // Dust: deterministic, regenerated only when the box changes size.
  const pad = Math.round(big * 0.04);
  const wq = Math.round(width / 8) * 8;
  const hq = Math.round(height / 8) * 8;
  const avoid = clear.map((r) => ({ left: r.left + pad, top: r.top + pad, width: r.width, height: r.height }));
  const avoidKey = clear.map((r) => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`).join(';');
  const far = useMemo(() => dustField({ seed: 11, count: 46, width: wq, height: hq, rMin: 0.5, rMax: 1.2, cx, cy, hole: faceSize * 0.42, avoid: clear }), [wq, hq, pad, Math.round(cx), Math.round(cy), Math.round(faceSize), avoidKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const near = useMemo(() => dustField({ seed: 29, count: 16, width: wq + pad * 2, height: hq + pad * 2, rMin: 0.9, rMax: 1.9, cx: cx + pad, cy: cy + pad, hole: faceSize * 0.5, avoid }), [wq, hq, pad, Math.round(cx), Math.round(cy), Math.round(faceSize), avoidKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const poolW = faceSize * 1.9;
  const poolH = faceSize * 1.15;
  const poolLeft = cx - poolW / 2;
  const poolTop = cy - poolH * 0.32;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {/* Base: deep radial + two faint static nebula clouds (one bitmap). */}
      <Svg width={width} height={height} style={[StyleSheet.absoluteFill, LAYER]}>
        <Defs>
          <RadialGradient id="bdBase" cx={cx} cy={cy} r={R} fx={cx} fy={cy} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={err ? '#121017' : '#1e1508'} />
            <Stop offset="0.34" stopColor="#0c0907" />
            <Stop offset="0.7" stopColor="#05050a" />
            <Stop offset="1" stopColor="#000000" />
          </RadialGradient>
          <RadialGradient id="bdNebA" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#5a3fb0" stopOpacity="0.22" />
            <Stop offset="1" stopColor="#5a3fb0" stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="bdNebB" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#1d8a9c" stopOpacity="0.2" />
            <Stop offset="1" stopColor="#1d8a9c" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill="url(#bdBase)" />
        <Ellipse cx={width * 0.12} cy={height * 0.16} rx={big * 0.55} ry={big * 0.3} fill="url(#bdNebA)" />
        <Ellipse cx={width * 0.92} cy={height * 0.86} rx={big * 0.5} ry={big * 0.28} fill="url(#bdNebB)" />
        <G fill="#f6e7c0">
          {far.map((d, i) => (
            <Circle key={i} cx={d.x} cy={d.y} r={d.r} opacity={d.o * 0.8} />
          ))}
        </G>
      </Svg>

      <AuroraBlob progress={progress} size={auraSize} color="#e9b949" opacity={0.17} x={cx - auraSize * 0.72} y={cy - auraSize * 0.72} drift={big * 0.05} spin={40} />
      <AuroraBlob progress={progress} size={auraSize} color="#3fc6e8" opacity={0.1} x={cx - auraSize * 0.22} y={cy - auraSize * 0.3} drift={big * 0.06} spin={-30} phase={0.4} />
      {lite ? null : <AuroraBlob progress={progress} size={auraSize * 0.85} color="#7a55e0" opacity={0.09} x={cx - auraSize * 0.1} y={cy - auraSize * 0.8} drift={big * 0.04} spin={25} phase={0.7} />}

      {lite ? null : <DustLayer progress={progress} specks={near} width={wq} height={hq} pad={pad} drift={pad * 0.95} phase={0.25} twinkle />}

      <LightPool level={warm} color="#f6c25a" left={poolLeft} top={poolTop} w={poolW} h={poolH} id="bdPoolWarm" />
      <LightPool level={cool} color={light.tint} left={poolLeft} top={poolTop} w={poolW} h={poolH} id="bdPoolCool" />

      <Image source={GRAIN} resizeMode="repeat" style={[StyleSheet.absoluteFill, LAYER, { width, height, opacity: 0.06 }]} />

      {/* Vignette, one static layer. */}
      <Svg width={width} height={height} style={[StyleSheet.absoluteFill, LAYER]}>
        <Defs>
          <RadialGradient id="bdVig" cx={cx} cy={cy} r={Math.hypot(width, height) * 0.56} gradientUnits="userSpaceOnUse">
            <Stop offset="0.42" stopColor="#000000" stopOpacity="0" />
            <Stop offset="0.8" stopColor="#000000" stopOpacity="0.55" />
            <Stop offset="1" stopColor="#000000" stopOpacity="0.88" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill="url(#bdVig)" />
      </Svg>
    </View>
  );
}
