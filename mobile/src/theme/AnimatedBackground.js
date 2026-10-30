// AnimatedBackground — static fallback renderers for every web background id.
//
// Reanimated/Worklets were intentionally removed to unblock Expo Go SDK 54
// (Reanimated 4 requires the New Architecture; mismatches silently crash on
// app open). DO NOT add them back. Every effect is a deterministic static
// scene built from LinearGradient, plain Views, and react-native-svg shapes
// — distinct enough that the user can tell which web background they picked
// without us shipping a WebGL parity layer.
//
// Every BackgroundStyle id from ui/src/ui/controllers/app-branding.ts is
// handled explicitly below. Truly-unknown ids fall through to the soft
// `gradient` look so a stale persisted value can't strand a screen on a
// blank backdrop.

import React, { useMemo } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  Polygon,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

import { useTheme } from './ThemeProvider.js';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Cheap deterministic PRNG so each renderer paints the same noise every
// time without pulling in Reanimated/Math.random in render paths.
function seeded(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ── Backdrops ────────────────────────────────────────────────────

function GradientBackdrop({ colors }) {
  const gradientColors = useMemo(() => {
    const bg = colors.background;
    const surf = colors.surface;
    const tint = colors.accentSubtle || colors.primaryLight || 'rgba(255,215,0,0.04)';
    return [bg, surf, bg, tint, bg];
  }, [colors.background, colors.accentSubtle, colors.primaryLight, colors.surface]);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <LinearGradient
        colors={gradientColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.bloom, { backgroundColor: colors.primary || '#FFD700' }]} />
      <View
        style={[
          styles.bloomSecondary,
          { backgroundColor: colors.accent || colors.primary || '#FFD700' },
        ]}
      />
    </View>
  );
}

function NoneBackdrop({ colors }) {
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />;
}

function AuroraBackdrop({ colors }) {
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.auroraPlume,
          {
            backgroundColor: colors.primary,
            opacity: 0.22,
            transform: [
              { translateX: -SCREEN_W * 0.15 },
              { translateY: -SCREEN_H * 0.1 },
            ],
          },
        ]}
      />
      <View
        style={[
          styles.auroraPlume,
          {
            backgroundColor: colors.accent || colors.primary,
            opacity: 0.18,
            transform: [
              { translateX: SCREEN_W * 0.2 },
              { translateY: SCREEN_H * 0.3 },
              { scale: 1.1 },
            ],
          },
        ]}
      />
      <View
        style={[
          styles.auroraPlume,
          {
            backgroundColor: colors.primary,
            opacity: 0.12,
            transform: [
              { translateX: SCREEN_W * 0.05 },
              { translateY: SCREEN_H * 0.55 },
              { scale: 0.9 },
            ],
          },
        ]}
      />
    </View>
  );
}

function BeamsBackdrop({ colors }) {
  const lines = [0.12, 0.28, 0.44, 0.6, 0.76];
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      {lines.map((top, i) => (
        <View
          key={top}
          style={[
            styles.beam,
            {
              backgroundColor: i % 2 === 0 ? colors.primary : colors.accent || colors.primary,
              top: SCREEN_H * top,
              opacity: 0.3 - i * 0.04,
              width: SCREEN_W * (0.4 + (i % 2) * 0.4),
              left: (i % 2) * SCREEN_W * 0.4,
            },
          ]}
        />
      ))}
    </View>
  );
}

function DotGridBackdrop({ colors }) {
  const cols = 14;
  const rows = Math.ceil((SCREEN_H / SCREEN_W) * cols);
  const cellW = SCREEN_W / cols;
  const cellH = cellW;
  const dots = useMemo(() => {
    const out = [];
    for (let row = 0; row < rows + 1; row += 1) {
      for (let col = 0; col < cols + 1; col += 1) {
        out.push({ cx: col * cellW, cy: row * cellH, key: `${col}-${row}` });
      }
    }
    return out;
  }, [cellW, cellH, cols, rows]);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        <G>
          {dots.map((d) => (
            <Circle key={d.key} cx={d.cx} cy={d.cy} r={1.1} fill={colors.primary} opacity={0.2} />
          ))}
        </G>
      </Svg>
    </View>
  );
}

function ParticlesBackdrop({ colors }) {
  const count = 26;
  const particles = useMemo(() => {
    const rand = seeded(42);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      out.push({
        key: i,
        x: rand() * SCREEN_W,
        y: rand() * SCREEN_H,
        size: 3 + rand() * 5,
      });
    }
    return out;
  }, []);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <GradientBackdrop colors={colors} />
      {particles.map((p) => (
        <View
          key={p.key}
          style={[
            styles.particle,
            {
              left: p.x,
              top: p.y,
              width: p.size,
              height: p.size,
              borderRadius: p.size / 2,
              backgroundColor: colors.primary,
              shadowColor: colors.primary,
            },
          ]}
        />
      ))}
    </View>
  );
}

function IridescenceBackdrop({ colors }) {
  // Wide multi-stop sweep evokes the rainbow sheen without animation.
  const stops = useMemo(() => {
    const p = colors.primary;
    const a = colors.accent || colors.primary;
    return [colors.background, p, colors.cyan, a, colors.pink, colors.background];
  }, [colors.background, colors.primary, colors.accent, colors.cyan, colors.pink]);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <LinearGradient
        colors={stops}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, opacity: 0.55 }]} />
    </View>
  );
}

function LiquidChromeBackdrop({ colors }) {
  // Stacked horizontal bands at varying alphas read as molten metal.
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <LinearGradient
        colors={[colors.background, colors.surface, colors.primary, colors.surface, colors.background]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['transparent', colors.accent, 'transparent']}
        start={{ x: 0, y: 0.4 }}
        end={{ x: 1, y: 0.6 }}
        style={[StyleSheet.absoluteFill, { opacity: 0.18 }]}
      />
    </View>
  );
}

function LightningBackdrop({ colors }) {
  // Three jagged polylines anchored to the corners — classic forked bolts.
  const bolts = useMemo(() => {
    const rand = seeded(7);
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      const startX = (0.2 + i * 0.3) * SCREEN_W;
      const points = [`${startX},0`];
      let x = startX;
      let y = 0;
      while (y < SCREEN_H) {
        x += (rand() - 0.5) * SCREEN_W * 0.12;
        y += SCREEN_H * (0.08 + rand() * 0.08);
        points.push(`${x},${y}`);
      }
      out.push(points.join(' '));
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="lg-glow" cx="50%" cy="40%" r="60%">
            <Stop offset="0%" stopColor={colors.primary} stopOpacity={0.22} />
            <Stop offset="100%" stopColor={colors.background} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={SCREEN_W} height={SCREEN_H} fill="url(#lg-glow)" />
        {bolts.map((points, i) => (
          <Polygon
            key={i}
            points={points}
            stroke={colors.primary}
            strokeWidth={1.2}
            fill="none"
            opacity={0.55 - i * 0.12}
          />
        ))}
      </Svg>
    </View>
  );
}

function SilkBackdrop({ colors }) {
  // Soft cross-fade of three sinuous bands (achieved via overlapping
  // gradients at offset angles). Reads silky without movement.
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <LinearGradient
        colors={[colors.background, colors.primaryDim, colors.background]}
        start={{ x: 0, y: 0.15 }}
        end={{ x: 1, y: 0.45 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['transparent', colors.accentSoft, 'transparent']}
        start={{ x: 1, y: 0.35 }}
        end={{ x: 0, y: 0.7 }}
        style={[StyleSheet.absoluteFill, { opacity: 0.6 }]}
      />
      <LinearGradient
        colors={['transparent', colors.primaryLight, 'transparent']}
        start={{ x: 0, y: 0.6 }}
        end={{ x: 1, y: 0.95 }}
        style={[StyleSheet.absoluteFill, { opacity: 0.4 }]}
      />
    </View>
  );
}

function WavesBackdrop({ colors }) {
  // Stacked sine-ish polylines — reads as an oscillating line grid.
  const lines = useMemo(() => {
    const rows = 18;
    const out = [];
    for (let r = 0; r < rows; r += 1) {
      const yMid = (r / rows) * SCREEN_H;
      const amp = 8 + (r % 3) * 4;
      const points = [];
      const step = SCREEN_W / 24;
      for (let i = 0; i <= 24; i += 1) {
        const x = i * step;
        const y = yMid + Math.sin((i + r) * 0.6) * amp;
        points.push(`${x},${y}`);
      }
      out.push({ key: r, d: points.join(' '), opacity: 0.12 + (r % 4) * 0.04 });
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        {lines.map((l) => (
          <Polygon
            key={l.key}
            points={l.d}
            stroke={colors.primary}
            strokeWidth={1}
            fill="none"
            opacity={l.opacity}
          />
        ))}
      </Svg>
    </View>
  );
}

function ThreadsBackdrop({ colors }) {
  // Long diagonal "strings" with subtle bow — string art look.
  const threads = useMemo(() => {
    const out = [];
    for (let i = 0; i < 14; i += 1) {
      const t = i / 14;
      out.push({
        key: i,
        x1: -SCREEN_W * 0.2,
        y1: t * SCREEN_H,
        x2: SCREEN_W * 1.2,
        y2: t * SCREEN_H + (i % 2 === 0 ? SCREEN_H * 0.05 : -SCREEN_H * 0.05),
      });
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        {threads.map((t) => (
          <Line
            key={t.key}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={colors.primary}
            strokeWidth={0.6}
            opacity={0.25}
          />
        ))}
      </Svg>
    </View>
  );
}

function MetaballsBackdrop({ colors }) {
  // Half-dozen overlapping radial blobs at staggered scales — frozen meta.
  const blobs = useMemo(() => {
    const rand = seeded(91);
    const out = [];
    for (let i = 0; i < 6; i += 1) {
      const size = SCREEN_W * (0.45 + rand() * 0.35);
      out.push({
        key: i,
        size,
        x: rand() * SCREEN_W - size * 0.3,
        y: rand() * SCREEN_H - size * 0.3,
        color: i % 2 === 0 ? colors.primary : colors.accent || colors.primary,
      });
    }
    return out;
  }, [colors.primary, colors.accent]);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      {blobs.map((b) => (
        <View
          key={b.key}
          style={{
            position: 'absolute',
            left: b.x,
            top: b.y,
            width: b.size,
            height: b.size,
            borderRadius: b.size / 2,
            backgroundColor: b.color,
            opacity: 0.18,
          }}
        />
      ))}
    </View>
  );
}

function OrbBackdrop({ colors }) {
  const size = Math.min(SCREEN_W, SCREEN_H) * 0.75;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="orb-core" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={colors.primary} stopOpacity={0.85} />
            <Stop offset="55%" stopColor={colors.accent || colors.primary} stopOpacity={0.25} />
            <Stop offset="100%" stopColor={colors.background} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle
          cx={SCREEN_W / 2}
          cy={SCREEN_H / 2}
          r={size / 2}
          fill="url(#orb-core)"
        />
      </Svg>
    </View>
  );
}

function BalatroBackdrop({ colors }) {
  // Cosmic conic-spin look — radiating sectors plus orbital ring.
  const sectors = useMemo(() => {
    const cx = SCREEN_W / 2;
    const cy = SCREEN_H / 2;
    const out = [];
    const slices = 16;
    const radius = Math.max(SCREEN_W, SCREEN_H);
    for (let i = 0; i < slices; i += 1) {
      const a1 = (i / slices) * Math.PI * 2;
      const a2 = ((i + 1) / slices) * Math.PI * 2;
      const x1 = cx + Math.cos(a1) * radius;
      const y1 = cy + Math.sin(a1) * radius;
      const x2 = cx + Math.cos(a2) * radius;
      const y2 = cy + Math.sin(a2) * radius;
      out.push({
        key: i,
        points: `${cx},${cy} ${x1},${y1} ${x2},${y2}`,
        opacity: i % 2 === 0 ? 0.14 : 0.06,
      });
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        {sectors.map((s) => (
          <Polygon key={s.key} points={s.points} fill={colors.primary} opacity={s.opacity} />
        ))}
        <Circle
          cx={SCREEN_W / 2}
          cy={SCREEN_H / 2}
          r={Math.min(SCREEN_W, SCREEN_H) * 0.25}
          stroke={colors.accent || colors.primary}
          strokeWidth={1}
          fill="none"
          opacity={0.4}
        />
      </Svg>
    </View>
  );
}

function LetterGlitchBackdrop({ colors }) {
  // Faux "code rain" — columns of cells filled in primary-tinted alpha.
  const cells = useMemo(() => {
    const rand = seeded(73);
    const cols = 30;
    const rows = 50;
    const cellW = SCREEN_W / cols;
    const cellH = SCREEN_H / rows;
    const out = [];
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) {
        const lit = rand() > 0.78;
        if (!lit) continue;
        out.push({
          key: `${c}-${r}`,
          x: c * cellW,
          y: r * cellH,
          w: cellW * 0.55,
          h: cellH * 0.5,
          opacity: 0.08 + rand() * 0.18,
        });
      }
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        {cells.map((c) => (
          <Rect
            key={c.key}
            x={c.x}
            y={c.y}
            width={c.w}
            height={c.h}
            fill={colors.primary}
            opacity={c.opacity}
          />
        ))}
      </Svg>
    </View>
  );
}

function SquaresBackdrop({ colors }) {
  // Outlined grid of squares, brighter near the center.
  const cells = useMemo(() => {
    const cols = 8;
    const rows = Math.ceil((SCREEN_H / SCREEN_W) * cols);
    const cellW = SCREEN_W / cols;
    const cellH = cellW;
    const cx = cols / 2;
    const cy = rows / 2;
    const out = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const dist = Math.hypot(c - cx, r - cy);
        out.push({
          key: `${c}-${r}`,
          x: c * cellW + 4,
          y: r * cellH + 4,
          w: cellW - 8,
          h: cellH - 8,
          opacity: Math.max(0.04, 0.4 - dist * 0.06),
        });
      }
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        {cells.map((c) => (
          <Rect
            key={c.key}
            x={c.x}
            y={c.y}
            width={c.w}
            height={c.h}
            stroke={colors.primary}
            strokeWidth={0.8}
            fill="none"
            opacity={c.opacity}
          />
        ))}
      </Svg>
    </View>
  );
}

function FaultyTerminalBackdrop({ colors }) {
  // CRT scanlines + occasional glitched rectangles.
  const scanlines = useMemo(() => {
    const out = [];
    const step = 3;
    for (let y = 0; y < SCREEN_H; y += step) {
      out.push({ key: y, y });
    }
    return out;
  }, []);
  const glitches = useMemo(() => {
    const rand = seeded(31);
    const out = [];
    for (let i = 0; i < 8; i += 1) {
      out.push({
        key: i,
        y: rand() * SCREEN_H,
        h: 6 + rand() * 14,
        w: SCREEN_W * (0.4 + rand() * 0.6),
        x: rand() * SCREEN_W * 0.2,
        opacity: 0.12 + rand() * 0.16,
      });
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.primaryDim }]} />
      <Svg width="100%" height="100%">
        {scanlines.map((s) => (
          <Line
            key={s.key}
            x1={0}
            y1={s.y}
            x2={SCREEN_W}
            y2={s.y}
            stroke={colors.primary}
            strokeWidth={0.4}
            opacity={0.08}
          />
        ))}
        {glitches.map((g) => (
          <Rect
            key={g.key}
            x={g.x}
            y={g.y}
            width={g.w}
            height={g.h}
            fill={colors.accent || colors.primary}
            opacity={g.opacity}
          />
        ))}
      </Svg>
    </View>
  );
}

function GrainientBackdrop({ colors }) {
  // Three primary radials plus an SVG noise overlay (Rect at low opacity
  // stippled via the metaball-style blob approach for fall-back grain).
  const grain = useMemo(() => {
    const rand = seeded(11);
    const out = [];
    for (let i = 0; i < 220; i += 1) {
      out.push({
        key: i,
        x: rand() * SCREEN_W,
        y: rand() * SCREEN_H,
      });
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <LinearGradient
        colors={[colors.primary, colors.accent || colors.primary, colors.background]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[StyleSheet.absoluteFill, { opacity: 0.5 }]}
      />
      <Svg width="100%" height="100%">
        {grain.map((g) => (
          <Rect key={g.key} x={g.x} y={g.y} width={1} height={1} fill={colors.text} opacity={0.18} />
        ))}
      </Svg>
    </View>
  );
}

function DitherBackdrop({ colors }) {
  // Bayer-dither look — two-tone checker that fades vertically.
  const dots = useMemo(() => {
    const size = 6;
    const cols = Math.ceil(SCREEN_W / size);
    const rows = Math.ceil(SCREEN_H / size);
    const out = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if ((r + c) % 2 !== 0) continue;
        const yT = r / rows;
        out.push({
          key: `${c}-${r}`,
          x: c * size,
          y: r * size,
          opacity: 0.05 + yT * 0.18,
        });
      }
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        {dots.map((d) => (
          <Rect key={d.key} x={d.x} y={d.y} width={3} height={3} fill={colors.primary} opacity={d.opacity} />
        ))}
      </Svg>
    </View>
  );
}

function HyperspeedBackdrop({ colors }) {
  // Vanishing-point streaks emanating from screen center.
  const streaks = useMemo(() => {
    const cx = SCREEN_W / 2;
    const cy = SCREEN_H / 2;
    const out = [];
    for (let i = 0; i < 40; i += 1) {
      const a = (i / 40) * Math.PI * 2;
      const rad = Math.max(SCREEN_W, SCREEN_H) * 1.1;
      out.push({
        key: i,
        x1: cx + Math.cos(a) * 30,
        y1: cy + Math.sin(a) * 30,
        x2: cx + Math.cos(a) * rad,
        y2: cy + Math.sin(a) * rad,
        opacity: 0.18 + (i % 3) * 0.08,
      });
    }
    return out;
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="hs-glow" cx="50%" cy="50%" r="45%">
            <Stop offset="0%" stopColor={colors.primary} stopOpacity={0.4} />
            <Stop offset="100%" stopColor={colors.background} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={SCREEN_W} height={SCREEN_H} fill="url(#hs-glow)" />
        {streaks.map((s) => (
          <Line
            key={s.key}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={colors.primary}
            strokeWidth={0.7}
            opacity={s.opacity}
          />
        ))}
      </Svg>
    </View>
  );
}

// ── Overlay layer ───────────────────────────────────────────────
// Mirrors the web's `.infinibot-bg-overlay`: a tint View above the animated
// backdrop but below app content. Driven by the overlay* tokens broadcast
// by the master.

function OverlayLayer({ colors }) {
  const { overlayColor, overlayOpacity } = colors;
  if (!overlayOpacity) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: overlayColor,
          opacity: overlayOpacity,
        },
      ]}
    />
  );
}

// ── Public component ───────────────────────────────────────────

export function AnimatedBackground({ children }) {
  const { background, colors } = useTheme();

  let Backdrop;
  switch (background) {
    case 'none':
      Backdrop = NoneBackdrop;
      break;
    case 'aurora':
      Backdrop = AuroraBackdrop;
      break;
    case 'beams':
      Backdrop = BeamsBackdrop;
      break;
    case 'dot-grid':
      Backdrop = DotGridBackdrop;
      break;
    case 'particles':
      Backdrop = ParticlesBackdrop;
      break;
    case 'iridescence':
      Backdrop = IridescenceBackdrop;
      break;
    case 'liquid-chrome':
      Backdrop = LiquidChromeBackdrop;
      break;
    case 'lightning':
      Backdrop = LightningBackdrop;
      break;
    case 'silk':
      Backdrop = SilkBackdrop;
      break;
    case 'waves':
      Backdrop = WavesBackdrop;
      break;
    case 'threads':
      Backdrop = ThreadsBackdrop;
      break;
    case 'metaballs':
      Backdrop = MetaballsBackdrop;
      break;
    case 'orb':
      Backdrop = OrbBackdrop;
      break;
    case 'balatro':
      Backdrop = BalatroBackdrop;
      break;
    case 'letter-glitch':
      Backdrop = LetterGlitchBackdrop;
      break;
    case 'squares':
      Backdrop = SquaresBackdrop;
      break;
    case 'faulty-terminal':
      Backdrop = FaultyTerminalBackdrop;
      break;
    case 'grainient':
      Backdrop = GrainientBackdrop;
      break;
    case 'dither':
      Backdrop = DitherBackdrop;
      break;
    case 'hyperspeed':
      Backdrop = HyperspeedBackdrop;
      break;
    case 'gradient':
      Backdrop = GradientBackdrop;
      break;
    default:
      // Truly unknown id — graceful fall-through.
      Backdrop = GradientBackdrop;
      break;
  }

  return (
    <View style={styles.shell}>
      <Backdrop colors={colors} />
      <OverlayLayer colors={colors} />
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: '#000' },
  content: { flex: 1, backgroundColor: 'transparent' },
  bloom: {
    position: 'absolute',
    top: -SCREEN_H * 0.18,
    alignSelf: 'center',
    width: SCREEN_W * 1.2,
    height: SCREEN_W * 1.2,
    borderRadius: SCREEN_W * 0.6,
    opacity: 0.1,
  },
  bloomSecondary: {
    position: 'absolute',
    bottom: SCREEN_H * 0.1,
    right: -SCREEN_W * 0.25,
    width: SCREEN_W * 0.7,
    height: SCREEN_W * 0.7,
    borderRadius: SCREEN_W * 0.35,
    opacity: 0.05,
  },
  auroraPlume: {
    position: 'absolute',
    width: SCREEN_W * 1.3,
    height: SCREEN_W * 1.3,
    borderRadius: SCREEN_W,
  },
  beam: {
    position: 'absolute',
    width: SCREEN_W * 0.4,
    height: 2,
    top: SCREEN_H * 0.15,
    borderRadius: 1,
  },
  particle: {
    position: 'absolute',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 6,
  },
});
