/**
 * <InfiniFace> — the friendly InfiniBot character.
 *
 * A gold glass orb (the logo's orb, globe meridians etched in) wearing a
 * dark glass visor. The eyes are the logo's ∞: one glowing stroke, a pupil
 * inside each loop.
 *
 *   idle       breathing, blinks, looks around now and then
 *   listening  leans in; the orb squash/stretches and pulses with the mic
 *              envelope, eyes widen with loudness, a glow ring scales with
 *              amplitude and ripples fire on peaks
 *   thinking   pupils circle their loops, a particle shimmer orbits
 *   speaking   the mouth lip-syncs to the TTS amplitude
 *   error      a little sad (cool tint, worried brows, small frown)
 *   muted      (prop, the mic mute) lips sealed with a stitched line, no
 *              mouth movement from the mic
 *
 * Rendering: react-native-svg driven by Reanimated. One frame callback on
 * the UI thread advances the clock and the attack/release envelope
 * (face-math `envelopeStep`, 40 ms / 180 ms); one derived value evaluates
 * `faceFrame` (state weights cross-fade on every state change) and the
 * animated props read from it — nothing re-renders React per frame. The JS
 * thread only copies `levelRef.current` (mic metering / TTS amplitude) into
 * a shared value ~30×/s (and only when it changed).
 *
 * Per-frame cost is kept to what actually moves:
 *   - The big soft glows (bloom / sad / cyan) are static SVGs rasterised
 *     once; breathing and loudness move them with native opacity + scale
 *     transforms, so the 2×-size aura bitmap is never re-drawn for them.
 *     The sad and cyan glows are only mounted around error / thinking.
 *   - Effects that are invisible return constant props (Reanimated skips
 *     unchanged props), so the aura SVG only re-renders while the ring,
 *     ripples or thinking particles are actually showing, the tint path
 *     only while in error, and the swirl only while thinking.
 *   - `paused` (screen not focused / app in background) stops the frame
 *     loop and the meter copy entirely.
 *   - `particles` trims the thinking shimmer on low-end devices.
 *   - `rippleGrowth` caps how far ripples swell so they stop short of the
 *     screen edge on phones (see layout `face.room`).
 *
 * Reduce Motion: the clock stops (no breathing, wobble, ripples, particles);
 * expressions still change per state and the mouth still follows speech.
 *
 * Interaction: tap → onPress. With `onHoldStart`, pressing and holding the
 * face is push-to-talk: onHoldStart fires after `holdDelay` ms and onHoldEnd
 * on release (the face stays squished while held). Without it, long-press →
 * onLongPress. Tactile squish and haptics either way. `perkKey` changing plays the wake-word "perk up".
 */

import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';

import { FACE_COLORS, blobPath, envelopeStep, faceFrame, infinityEyes, isPeak, mouthShape, quantize } from './face-math';

let Haptics = null;
try {
  // Optional native module (present in Expo Go and dev builds that include it).
  Haptics = require('expo-haptics');
} catch {
  Haptics = null;
}
const fallbackHaptics = require('../utils/haptics');

export function haptic(kind = 'light') {
  try {
    if (Haptics && Platform.OS !== 'web') {
      if (kind === 'success') return void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (kind === 'warn') return void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      if (kind === 'soft') return void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft ?? Haptics.ImpactFeedbackStyle.Light);
      return void Haptics.impactAsync(kind === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
    }
  } catch {
    /* fall back below */
  }
  if (kind === 'success') fallbackHaptics.success();
  else if (kind === 'warn') fallbackHaptics.warn();
  else fallbackHaptics.tap();
}

const APath = Animated.createAnimatedComponent(Path);
const ACircle = Animated.createAnimatedComponent(Circle);
const AG = Animated.createAnimatedComponent(G);

const STATE_KEYS = ['idle', 'listen', 'think', 'speak', 'error', 'connect'];
const STATE_TO_KEY = { idle: 'idle', listening: 'listen', thinking: 'think', speaking: 'speak', error: 'error', connecting: 'connect' };
const AUDIO_STATES = new Set(['listening', 'speaking']);
const TRANSITION = { duration: 420, easing: Easing.inOut(Easing.cubic) };
const RIPPLE_MS = 760;
const PARTICLES = 14;
const RIPPLE_GROWTH = 0.42;
// The bloom is drawn once at its largest radius and scaled down natively.
const BLOOM_MAX = 1.9;

// The face is drawn in face-math's 200-unit space; the orb (radius 74 + wobble)
// is framed by a 160-unit viewBox so it fills ~92% of the face box.
const VB = '20 20 160 160';
// The aura (glow, ring, ripples, particles) is twice the face box: 320 units, centre 160.
const AURA = 2;
const AC = 160;

/** `on`, held true for `ms` after it turns off (so a layer can fade out before unmounting). */
function useLinger(on, ms) {
  const [shown, setShown] = useState(on);
  useEffect(() => {
    if (on) {
      setShown(true);
      return undefined;
    }
    const id = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(id);
  }, [on, ms]);
  return on || shown;
}

function useStateWeights(state, reduced) {
  const w = {
    idle: useSharedValue(state === 'idle' ? 1 : 0),
    listen: useSharedValue(state === 'listening' ? 1 : 0),
    think: useSharedValue(state === 'thinking' ? 1 : 0),
    speak: useSharedValue(state === 'speaking' ? 1 : 0),
    error: useSharedValue(state === 'error' ? 1 : 0),
    connect: useSharedValue(state === 'connecting' ? 1 : 0),
  };
  useEffect(() => {
    const on = STATE_TO_KEY[state] || 'idle';
    for (const k of STATE_KEYS) {
      const v = k === on ? 1 : 0;
      w[k].value = reduced ? v : withTiming(v, TRANSITION);
    }
  }, [state, reduced]); // eslint-disable-line react-hooks/exhaustive-deps
  return w;
}

function Particle({ i, n, clock, think }) {
  const props = useAnimatedProps(() => {
    // Invisible outside thinking: constant props → no SVG re-render.
    if (think.value < 0.004) return { cx: AC, cy: AC, r: 0, opacity: 0 };
    const t = clock.value;
    const dir = i % 2 ? 1 : -1;
    const ring = 92 + (i % 3) * 13 + Math.sin(t * 1.3 + i) * 5;
    const a = t * (0.8 + (i % 4) * 0.22) * dir + i * (6.2832 / n);
    const tw = Math.sin(t * 3.1 + i * 1.7) * 0.5 + 0.5;
    return {
      cx: AC + Math.cos(a) * ring,
      cy: AC + Math.sin(a) * ring * 0.92,
      r: 1.3 + (i % 3) * 0.8 + tw * 0.9,
      opacity: think.value * (0.25 + 0.75 * tw),
    };
  });
  return <ACircle animatedProps={props} fill={i % 4 === 0 ? '#9fe8ff' : FACE_COLORS.goldHi} />;
}

function Ripple({ slot, clock, ripples, growth }) {
  const props = useAnimatedProps(() => {
    const start = ripples.value[slot * 2];
    const strength = ripples.value[slot * 2 + 1];
    const age = start < 0 ? 1 : (clock.value * 1000 - start) / RIPPLE_MS;
    if (age < 0 || age >= 1) return { r: 74, opacity: 0, strokeWidth: 0.4 };
    const a = age;
    const ease = 1 - (1 - a) * (1 - a);
    return {
      r: 74 * (1.03 + ease * growth),
      opacity: (1 - a) * 0.7 * strength,
      strokeWidth: 3.2 * (1 - a) + 0.4,
    };
  });
  return <ACircle cx={AC} cy={AC} fill="none" stroke={FACE_COLORS.goldHi} animatedProps={props} />;
}

export function InfiniFace({
  state = 'idle',
  levelRef,
  size = 260,
  reducedMotion = false,
  perkKey = 0,
  muted = false,
  paused = false,
  particles = PARTICLES,
  rippleGrowth = RIPPLE_GROWTH,
  swirl = 1.3,
  onPress,
  onLongPress,
  onHoldStart,
  onHoldEnd,
  holdDelay = 260,
  accessibilityLabel,
  accessibilityHint,
  testID = 'infini-face',
}) {
  const motion = reducedMotion ? 0 : 1;
  const w = useStateWeights(state, reducedMotion);
  // Start mid-cycle so the first blink isn't at a fixed moment after mount.
  const clock = useSharedValue(1.3);
  const raw = useSharedValue(0);
  const env = useSharedValue(0);
  const lastRipple = useSharedValue(-1e9);
  const ripples = useSharedValue([-1, 0, -1, 0, -1, 0]);
  const rippleSlot = useSharedValue(0);
  const press = useSharedValue(0);
  const perk = useSharedValue(0);

  // JS → UI: copy the meter (mic dB / TTS amplitude) into a shared value ~30×/s.
  // Skipped while paused, and a write only happens when the level moved, so
  // silence costs nothing on either thread.
  const audio = AUDIO_STATES.has(state) && !paused;
  useEffect(() => {
    if (!audio) {
      raw.value = 0;
      if (reducedMotion) env.value = 0;
      return undefined;
    }
    let last = -1;
    const id = setInterval(() => {
      const v = levelRef && typeof levelRef.current === 'number' ? levelRef.current : 0;
      if (Math.abs(v - last) < 0.004) return;
      last = v;
      raw.value = v;
      if (reducedMotion) env.value = v; // no frame loop: follow the level directly
    }, 33);
    return () => clearInterval(id);
  }, [audio, levelRef, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  // UI thread: clock + attack/release envelope + peak → ripple.
  const frame = useFrameCallback((fi) => {
    'worklet';
    const dt = fi.timeSincePreviousFrame == null ? 16 : Math.min(64, fi.timeSincePreviousFrame);
    clock.value += dt / 1000;
    const prev = env.value;
    const next = envelopeStep(prev, raw.value, dt, 40, 180);
    env.value = next;
    const nowMs = clock.value * 1000;
    if (isPeak(prev, next, nowMs - lastRipple.value)) {
      lastRipple.value = nowMs;
      const s = rippleSlot.value;
      const arr = ripples.value.slice();
      arr[s * 2] = nowMs;
      arr[s * 2 + 1] = Math.min(1, 0.45 + next * 0.7);
      ripples.value = arr;
      rippleSlot.value = (s + 1) % 3;
    }
  }, false);
  // The loop only runs while the face is on screen and the app is in front.
  useEffect(() => {
    frame.setActive(!reducedMotion && !paused);
    return () => frame.setActive(false);
  }, [reducedMotion, paused]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wake-word perk-up.
  const firstPerk = useRef(true);
  useEffect(() => {
    if (firstPerk.current) {
      firstPerk.current = false;
      return;
    }
    perk.value = reducedMotion ? withSequence(withTiming(1, { duration: 0 }), withTiming(0, { duration: 600 })) : withSequence(withTiming(1, { duration: 140, easing: Easing.out(Easing.back(2)) }), withSpring(0, { damping: 7, stiffness: 120 }));
  }, [perkKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const F = useDerivedValue(() => {
    const weights = { idle: w.idle.value, listen: w.listen.value, think: w.think.value, speak: w.speak.value, error: w.error.value, connect: w.connect.value };
    const f = faceFrame(weights, clock.value, env.value, motion, press.value, perk.value);
    const eyes = infinityEyes({ a: f.eyeA, height: f.eyeH, squash: f.blink, steps: 40 });
    return {
      ...f,
      body: blobPath(clock.value, { wobble: f.wobble, energy: env.value }),
      eyesD: eyes.d,
      eyeL: eyes.left,
      eyeR: eyes.right,
      pupilR: 6.6 * Math.max(0.15, eyes.openness) * f.pupil.grow,
      mouthD: mouthShape(f.mouth),
    };
  });

  const orbStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (F.value.floatY * size) / 160 }, { scaleX: F.value.sx }, { scaleY: F.value.sy }],
  }));
  const swirlStyle = useAnimatedStyle(() =>
    F.value.swirl < 0.004
      ? { opacity: 0, transform: [{ rotate: '0deg' }] }
      : { opacity: F.value.swirl * 0.85, transform: [{ rotate: `${(clock.value * 140) % 360}deg` }] },
  );

  const bodyProps = useAnimatedProps(() => ({ d: F.value.body }));
  // The error tint follows the body only while it is visible.
  const tintProps = useAnimatedProps(() => (F.value.tint < 0.004 ? { d: 'M100 100 Z', opacity: 0 } : { d: F.value.body, opacity: F.value.tint }));
  const eyesProps = useAnimatedProps(() => ({ d: F.value.eyesD }));
  const mouthProps = useAnimatedProps(() => ({ d: F.value.mouthD }));
  const pupilLProps = useAnimatedProps(() => ({ cx: F.value.eyeL.x + F.value.pupil.dx, cy: F.value.eyeL.y + 6 + F.value.pupil.dy, r: F.value.pupilR }));
  const pupilRProps = useAnimatedProps(() => ({ cx: F.value.eyeR.x + F.value.pupil.dx, cy: F.value.eyeR.y + 6 + F.value.pupil.dy, r: F.value.pupilR }));
  const glintLProps = useAnimatedProps(() => ({ cx: F.value.eyeL.x + F.value.pupil.dx + 2.2, cy: F.value.eyeL.y + 3.8 + F.value.pupil.dy, r: F.value.pupilR * 0.34 }));
  const glintRProps = useAnimatedProps(() => ({ cx: F.value.eyeR.x + F.value.pupil.dx + 2.2, cy: F.value.eyeR.y + 3.8 + F.value.pupil.dy, r: F.value.pupilR * 0.34 }));
  const browProps = useAnimatedProps(() => ({ opacity: F.value.brows }));

  // Glows: native opacity / scale on pre-rasterised gradients.
  const bloomStyle = useAnimatedStyle(() => ({
    opacity: quantize(F.value.glow * (1 - w.error.value), 0.002),
    transform: [{ scale: quantize((1.55 + 0.35 * env.value) / BLOOM_MAX, 0.001) }],
  }));
  const sadStyle = useAnimatedStyle(() => ({ opacity: quantize(F.value.glow * w.error.value, 0.002) }));
  const cyanStyle = useAnimatedStyle(() => ({ opacity: 0.55 * F.value.swirl }));
  const ringProps = useAnimatedProps(() =>
    F.value.ring.opacity < 0.004 ? { r: 76, opacity: 0, strokeWidth: 1 } : { r: F.value.ring.r, opacity: F.value.ring.opacity, strokeWidth: F.value.ring.width },
  );
  // Mount the sad / cyan glows only around the states that show them.
  const showSad = useLinger(state === 'error', 600);
  const showCyan = useLinger(state === 'thinking' || state === 'connecting', 600);
  const thinkSV = useDerivedValue(() => F.value.swirl * motion);

  const auraSize = size * AURA;
  const auraBox = { position: 'absolute', width: auraSize, height: auraSize };
  const holding = useRef(false);
  const onIn = () => {
    press.value = reducedMotion ? 1 : withSpring(1, { damping: 14, stiffness: 420 });
  };
  const onOut = () => {
    press.value = reducedMotion ? 0 : withSpring(0, { damping: 6, stiffness: 260 });
    if (holding.current) {
      holding.current = false;
      haptic('light');
      onHoldEnd?.();
    }
  };
  // A held turn must end even if the face unmounts mid-hold (rotation, close).
  const holdEndRef = useRef(onHoldEnd);
  holdEndRef.current = onHoldEnd;
  useEffect(
    () => () => {
      if (holding.current) {
        holding.current = false;
        holdEndRef.current?.();
      }
    },
    [],
  );

  return (
    <Pressable
      onPressIn={onIn}
      onPressOut={onOut}
      onPress={() => {
        haptic('light');
        onPress?.();
      }}
      onLongPress={() => {
        haptic('medium');
        if (onHoldStart) {
          // Push-to-talk: stay pressed in while held; release ends the turn.
          holding.current = true;
          if (!reducedMotion) press.value = withSpring(1.25, { damping: 14, stiffness: 380 });
          onHoldStart();
          return;
        }
        if (!reducedMotion) press.value = withSequence(withTiming(1.6, { duration: 120 }), withSpring(0, { damping: 5, stiffness: 200 }));
        onLongPress?.();
      }}
      delayLongPress={onHoldStart ? holdDelay : 550}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || 'InfiniBot'}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ busy: state === 'thinking' || state === 'connecting' }}
      testID={testID}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      {/* Aura: bloom, glow ring, ripples, thinking shimmer — twice the face box, never clipped. */}
      <View pointerEvents="none" style={[auraBox, { left: (size - auraSize) / 2, top: (size - auraSize) / 2 }]}>
        <Animated.View style={[StyleSheet.absoluteFill, bloomStyle]}>
          <Svg width={auraSize} height={auraSize} viewBox="0 0 320 320">
            <Defs>
              <RadialGradient id="ifBloom" cx="50%" cy="50%" r="50%">
                <Stop offset="0.3" stopColor={FACE_COLORS.gold} stopOpacity="0.55" />
                <Stop offset="0.55" stopColor={FACE_COLORS.goldMid} stopOpacity="0.2" />
                <Stop offset="1" stopColor={FACE_COLORS.goldMid} stopOpacity="0" />
              </RadialGradient>
            </Defs>
            <Circle cx={AC} cy={AC} r={74 * BLOOM_MAX} fill="url(#ifBloom)" />
          </Svg>
        </Animated.View>
        {showSad ? (
          <Animated.View style={[StyleSheet.absoluteFill, sadStyle]}>
            <Svg width={auraSize} height={auraSize} viewBox="0 0 320 320">
              <Defs>
                <RadialGradient id="ifSad" cx="50%" cy="50%" r="50%">
                  <Stop offset="0.3" stopColor={FACE_COLORS.sad} stopOpacity="0.45" />
                  <Stop offset="1" stopColor={FACE_COLORS.sad} stopOpacity="0" />
                </RadialGradient>
              </Defs>
              <Circle cx={AC} cy={AC} r={150} fill="url(#ifSad)" />
            </Svg>
          </Animated.View>
        ) : null}
        {showCyan ? (
          <Animated.View style={[StyleSheet.absoluteFill, cyanStyle]}>
            <Svg width={auraSize} height={auraSize} viewBox="0 0 320 320">
              <Defs>
                <RadialGradient id="ifCyan" cx="50%" cy="50%" r="50%">
                  <Stop offset="0.35" stopColor="#6fd8ff" stopOpacity="0.28" />
                  <Stop offset="1" stopColor="#6fd8ff" stopOpacity="0" />
                </RadialGradient>
              </Defs>
              <Circle cx={AC} cy={AC} r={156} fill="url(#ifCyan)" />
            </Svg>
          </Animated.View>
        ) : null}
        {/* Strokes + particles: only re-rendered while one of them is showing. */}
        <Svg width={auraSize} height={auraSize} viewBox="0 0 320 320" style={StyleSheet.absoluteFill}>
          <ACircle cx={AC} cy={AC} fill="none" stroke={FACE_COLORS.goldHi} animatedProps={ringProps} />
          <Ripple slot={0} clock={clock} ripples={ripples} growth={rippleGrowth} />
          <Ripple slot={1} clock={clock} ripples={ripples} growth={rippleGrowth} />
          <Ripple slot={2} clock={clock} ripples={ripples} growth={rippleGrowth} />
          {Array.from({ length: particles }, (_, i) => (
            <Particle key={i} i={i} n={particles} clock={clock} think={thinkSV} />
          ))}
        </Svg>
      </View>

      {/* Thinking swirl: two comet arcs rotating on the native transform. */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size * swirl, height: size * swirl, left: (size - size * swirl) / 2, top: (size - size * swirl) / 2 }, swirlStyle]}>
        <Svg width="100%" height="100%" viewBox="0 0 208 208">
          <Defs>
            <LinearGradient id="ifComet" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={FACE_COLORS.goldHi} stopOpacity="0" />
              <Stop offset="1" stopColor={FACE_COLORS.goldHi} stopOpacity="1" />
            </LinearGradient>
          </Defs>
          <Path d="M104 6 A98 98 0 0 1 202 104" stroke="url(#ifComet)" strokeWidth={2.4} strokeLinecap="round" fill="none" />
          <Path d="M104 202 A98 98 0 0 1 6 104" stroke="url(#ifComet)" strokeWidth={1.6} strokeLinecap="round" fill="none" opacity={0.6} />
        </Svg>
      </Animated.View>

      <Animated.View pointerEvents="none" style={[{ width: size, height: size }, orbStyle]} nativeID="infini-face-art" dataSet={{ faceState: muted ? 'muted' : state }}>
        <Svg width={size} height={size} viewBox={VB}>
          <Defs>
            <RadialGradient id="ifBody" cx="36%" cy="28%" r="80%">
              <Stop offset="0" stopColor="#fff6d6" />
              <Stop offset="0.16" stopColor={FACE_COLORS.goldHi} />
              <Stop offset="0.42" stopColor={FACE_COLORS.gold} />
              <Stop offset="0.76" stopColor={FACE_COLORS.goldMid} />
              <Stop offset="1" stopColor="#5e3a0c" />
            </RadialGradient>
            <RadialGradient id="ifInner" cx="50%" cy="44%" r="54%">
              <Stop offset="0.72" stopColor="#3a2204" stopOpacity="0" />
              <Stop offset="1" stopColor="#2a1702" stopOpacity="0.6" />
            </RadialGradient>
            <LinearGradient id="ifRim" x1="0.15" y1="0.05" x2="0.85" y2="0.95">
              <Stop offset="0" stopColor="#fff8e1" stopOpacity="0.95" />
              <Stop offset="0.4" stopColor="#fff8e1" stopOpacity="0" />
              <Stop offset="0.75" stopColor="#8fe1ff" stopOpacity="0" />
              <Stop offset="1" stopColor="#8fe1ff" stopOpacity="0.55" />
            </LinearGradient>
            <LinearGradient id="ifVisor" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#2a1f0e" />
              <Stop offset="0.5" stopColor={FACE_COLORS.visor} />
              <Stop offset="1" stopColor="#010101" />
            </LinearGradient>
            <LinearGradient id="ifVisorEdge" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#fbe6a2" stopOpacity="0.75" />
              <Stop offset="0.5" stopColor="#fbe6a2" stopOpacity="0.15" />
              <Stop offset="1" stopColor="#fbe6a2" stopOpacity="0.5" />
            </LinearGradient>
            <RadialGradient id="ifEyeGlow" cx="50%" cy="55%" r="50%">
              <Stop offset="0" stopColor={FACE_COLORS.feature} stopOpacity="0.22" />
              <Stop offset="1" stopColor={FACE_COLORS.feature} stopOpacity="0" />
            </RadialGradient>
            <LinearGradient id="ifShine" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#ffffff" stopOpacity="0.75" />
              <Stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </LinearGradient>
            <ClipPath id="ifOrbClip">
              <Circle cx="100" cy="100" r="72" />
            </ClipPath>
            <LinearGradient id="ifStroke" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={FACE_COLORS.featureHot} />
              <Stop offset="1" stopColor={FACE_COLORS.feature} />
            </LinearGradient>
          </Defs>

          {/* Orb: gold body, inner shadow, rim light */}
          <APath animatedProps={bodyProps} fill="url(#ifBody)" />
          <APath animatedProps={bodyProps} fill="url(#ifInner)" />
          <G stroke={FACE_COLORS.goldDeep} strokeWidth={1.4} fill="none" opacity={0.36} clipPath="url(#ifOrbClip)">
            <Path d="M42 66 Q100 50 158 66" />
            <Path d="M100 27 L100 58" />
            <Path d="M66 34 Q74 52 72 62 M134 34 Q126 52 128 62" />
            <Path d="M44 150 Q100 168 156 150" />
            <Path d="M100 154 L100 174" />
          </G>
          <APath animatedProps={bodyProps} fill="none" stroke="url(#ifRim)" strokeWidth={2.2} />
          {/* Specular highlights */}
          <Ellipse cx="72" cy="50" rx="32" ry="16" fill="url(#ifShine)" transform="rotate(-26 72 50)" opacity={0.85} />
          <Ellipse cx="60" cy="58" rx="6" ry="3.2" fill="#ffffff" opacity={0.85} transform="rotate(-30 60 58)" />
          <Ellipse cx="140" cy="160" rx="22" ry="6" fill="#fff1c4" opacity={0.14} transform="rotate(-24 140 160)" />
          <APath animatedProps={tintProps} fill={FACE_COLORS.sad} />

          {/* Visor */}
          <Ellipse cx="100" cy="108" rx="60" ry="42" fill="url(#ifVisor)" stroke="url(#ifVisorEdge)" strokeWidth={1.4} />
          <Ellipse cx="100" cy="100" rx="52" ry="30" fill="url(#ifEyeGlow)" />
          <Path d="M52 96 Q100 70 148 96 Q100 80 52 96 Z" fill="#ffffff" opacity={0.07} />

          {/* ∞ eyes */}
          <G transform="translate(0 6)">
            <APath animatedProps={eyesProps} stroke={FACE_COLORS.feature} strokeWidth={10} strokeLinejoin="round" fill="none" opacity={0.16} />
            <APath animatedProps={eyesProps} stroke="url(#ifStroke)" strokeWidth={4.4} strokeLinejoin="round" fill="none" />
          </G>
          <ACircle animatedProps={pupilLProps} fill={FACE_COLORS.featureHot} />
          <ACircle animatedProps={pupilRProps} fill={FACE_COLORS.featureHot} />
          <ACircle animatedProps={glintLProps} fill="#ffffff" opacity={0.95} />
          <ACircle animatedProps={glintRProps} fill="#ffffff" opacity={0.95} />

          {/* Worried brows (error) */}
          <AG animatedProps={browProps} stroke={FACE_COLORS.sad} strokeWidth={3} strokeLinecap="round">
            <Path d="M64 73 L81 67" />
            <Path d="M136 73 L119 67" />
          </AG>

          {/* Mouth: one closed shape that morphs smile ↔ open — sealed while the mic is muted */}
          {muted ? (
            <G testID="infini-face-sealed">
              <Path d="M85 129 H115" stroke={FACE_COLORS.feature} strokeWidth={3.4} strokeLinecap="round" />
              <Path d="M90 125.5 V132.5 M100 125.5 V132.5 M110 125.5 V132.5" stroke={FACE_COLORS.feature} strokeWidth={2} strokeLinecap="round" opacity={0.8} />
            </G>
          ) : (
            <APath animatedProps={mouthProps} stroke={FACE_COLORS.feature} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" fill="#2a1a05" />
          )}
        </Svg>
      </Animated.View>
    </Pressable>
  );
}
