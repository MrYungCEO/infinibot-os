/**
 * ui-kit/tokens — the single numeric + typographic contract for the mobile app.
 *
 * Colors are NOT defined here. They come from the live theme runtime
 * (`src/theme/palettes.js` → `resolveColors`) via `useTheme()`, so a
 * master-side palette switch repaints the kit without a remount. This file
 * owns everything the palette does not: spacing, radii, type scale, motion,
 * touch targets and elevation.
 *
 * Density 8 / "Data-Dense Dashboard": the spacing scale is deliberately tight
 * (4/8/12/16/24/32) so list-heavy screens fit more rows per viewport without
 * feeling cramped. Anything that needs more air composes two steps rather
 * than inventing a new one.
 */

import { useMemo } from 'react';
import { Platform } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';

// ── Spacing (density 8) ───────────────────────────────────────────
// The ONLY sanctioned gaps/paddings. Never hand-write a raw pixel gap.
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

// ── Radii ─────────────────────────────────────────────────────────
export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
};

// ── Touch targets ─────────────────────────────────────────────────
// Every interactive element resolves to >= 44x44 of tappable area. When the
// visual box is smaller, the component pads with `hitSlop: HIT.slop`.
export const HIT = {
  min: 44,
  slop: { top: 8, bottom: 8, left: 8, right: 8 },
  // Minimum gap between two adjacent tap targets.
  gap: SPACE.sm,
};

// ── Motion ────────────────────────────────────────────────────────
// Subtle by mandate: dense data must not bounce. No back.out / overshoot
// springs anywhere in the kit — enters ease out, exits are faster than
// enters so dismissal never feels laggy.
export const MOTION = {
  enter: 260,
  exit: 160,
  // List stagger: total reveal window stays inside 300-450ms.
  stagger: { step: 28, max: 420 },
  // Indeterminate shimmer / skeleton pulse.
  loop: 1100,
  // Translate distance for enter transitions. Small on purpose.
  rise: 8,
};

// ── Elevation ─────────────────────────────────────────────────────
// Three tiers only. 0 = flush (rows inside a card), 1 = card, 2 = panel /
// sheet, 3 = modal / floating overlay.
export const ELEVATION = {
  0: { shadowColor: 'transparent', shadowOpacity: 0, shadowRadius: 0, elevation: 0 },
  1: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  2: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 18,
    elevation: 12,
  },
  3: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.6,
    shadowRadius: 30,
    elevation: 20,
  },
};

// ── Blur ──────────────────────────────────────────────────────────
// Android caps out well below iOS; anything above ~65 costs frames for no
// visible gain, so every BlurView in the kit routes through this.
export function blurFor(intensity) {
  return Platform.OS === 'android' ? Math.min(intensity, 65) : intensity;
}

// ── Typography ────────────────────────────────────────────────────
// Hard floor of 12px. `eyebrow`/`label`/`meta` used to render at 9-11px in
// the pre-kit headers; they are 12 here and that is intentional — sub-12
// text fails legibility on a phone at arm's length.
export const MIN_FONT_SIZE = 12;

/**
 * Monospace face. `FONT_FAMILY.mono` in the theme runtime is the literal
 * string 'monospace', which resolves on Android but silently falls back to
 * the system sans on iOS. Data/IDs/metrics/terminals must actually be
 * monospaced on both, so the kit resolves the face per-platform.
 */
export const MONO_FAMILY = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/**
 * Build the type scale against the live font map. Sans for body + headings,
 * mono for data/IDs/metrics/terminal output. Headings use tight negative
 * tracking; mono and all-caps labels use positive tracking.
 */
export function makeType(fonts) {
  const sans = {
    regular: fonts?.regular || 'Inter-Regular',
    medium: fonts?.medium || 'Inter-Medium',
    semiBold: fonts?.semiBold || 'Inter-SemiBold',
    bold: fonts?.bold || 'Inter-Bold',
  };
  const display = fonts?.display || 'SpaceGrotesk-Bold';

  return {
    // Display / headings — tight tracking.
    display: { fontFamily: display, fontSize: 26, lineHeight: 30, letterSpacing: -0.6 },
    h1: { fontFamily: sans.bold, fontSize: 22, lineHeight: 27, letterSpacing: -0.4 },
    h2: { fontFamily: sans.bold, fontSize: 18, lineHeight: 23, letterSpacing: -0.3 },
    h3: { fontFamily: sans.semiBold, fontSize: 15, lineHeight: 20, letterSpacing: -0.1 },

    // Body.
    body: { fontFamily: sans.regular, fontSize: 15, lineHeight: 21 },
    bodyStrong: { fontFamily: sans.semiBold, fontSize: 15, lineHeight: 21 },
    small: { fontFamily: sans.regular, fontSize: 13, lineHeight: 18 },
    smallStrong: { fontFamily: sans.medium, fontSize: 13, lineHeight: 18 },

    // Smallest sanctioned size. Captions, helper text, timestamps.
    caption: { fontFamily: sans.medium, fontSize: 12, lineHeight: 16 },

    // All-caps section/eyebrow labels — positive tracking, 12px floor.
    label: {
      fontFamily: sans.semiBold,
      fontSize: 12,
      lineHeight: 15,
      letterSpacing: 1.1,
      textTransform: 'uppercase',
    },

    // Data faces — monospace. Use for IDs, counts, metrics, terminal text.
    mono: { fontFamily: MONO_FAMILY, fontSize: 13, lineHeight: 18, letterSpacing: 0.2 },
    monoSmall: { fontFamily: MONO_FAMILY, fontSize: 12, lineHeight: 16, letterSpacing: 0.3 },
    // Big KPI numerals.
    metric: { fontFamily: MONO_FAMILY, fontSize: 24, lineHeight: 28, letterSpacing: -0.5 },
    metricSmall: { fontFamily: MONO_FAMILY, fontSize: 18, lineHeight: 22, letterSpacing: -0.3 },
  };
}

/**
 * useUIKit — the one hook every kit component (and every screen) calls to get
 * the live palette plus the static scales already bound together.
 *
 *   const { colors, type, space, radius } = useUIKit();
 */
export function useUIKit() {
  const { colors, fonts, mode, isReady } = useTheme();
  return useMemo(
    () => ({
      colors,
      fonts,
      mode,
      isReady,
      type: makeType(fonts),
      space: SPACE,
      radius: RADIUS,
      motion: MOTION,
      elevation: ELEVATION,
      hit: HIT,
      alpha: withAlpha,
    }),
    [colors, fonts, mode, isReady],
  );
}

/**
 * Stagger delay for the Nth item in a list reveal. Clamped so a 200-row list
 * still finishes its entrance inside MOTION.stagger.max.
 */
export function staggerDelay(index) {
  return Math.min(index * MOTION.stagger.step, MOTION.stagger.max);
}

export default { SPACE, RADIUS, HIT, MOTION, ELEVATION, useUIKit, staggerDelay };
