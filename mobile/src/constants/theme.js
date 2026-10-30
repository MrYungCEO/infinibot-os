// Mobile theme — back-compat shim over the live theme runtime.
//
// Historically every screen imported `COLORS` / `FONT_FAMILY` from this
// file as a plain object. We now keep those exports in place but route
// them through `../theme/runtime`, where the values come from a live
// runtime cache driven by `ThemeProvider`. Reads via `COLORS.x` /
// `FONT_FAMILY.x` always see the *current* master theme — so any inline
// style or JSX prop ( `color={COLORS.primary}`, `tintColor={...}`, etc. )
// updates in real time when the master device switches palettes.
//
// One caveat to be aware of: `StyleSheet.create({...})` snapshots its
// argument once at module load, so static panel chrome will keep the
// boot-time palette until a remount. Inline JSX consumers — which is the
// vast majority of color/font usage in this app — update live.
//
// Typography metrics (SPACING, GLASS shadow recipes, FONTS line-heights)
// are intentionally static. Only the *colour* tokens follow the master.

import { COLORS as LIVE_COLORS, FONT_FAMILY as LIVE_FONTS } from '../theme/runtime.js';

export const COLORS = LIVE_COLORS;
export const FONT_FAMILY = LIVE_FONTS;

// Typography presets. `fontFamily` reads through to the live proxy, so a
// `fontFamily` change on the master flows here too.
export const FONTS = {
  regular: { fontFamily: FONT_FAMILY.regular, fontSize: 15, lineHeight: 22 },
  small: { fontFamily: FONT_FAMILY.regular, fontSize: 13, lineHeight: 18 },
  tiny: { fontFamily: FONT_FAMILY.medium, fontSize: 11, lineHeight: 14 },
  heading: { fontFamily: FONT_FAMILY.bold, fontSize: 18, lineHeight: 24 },
  mono: { fontFamily: FONT_FAMILY.mono, fontSize: 10, letterSpacing: 1 },
};

export const TYPOGRAPHY = {
  body: { fontFamily: FONT_FAMILY.regular, fontSize: 15, lineHeight: 22 },
  label: {
    fontFamily: FONT_FAMILY.semiBold,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  small: { fontFamily: FONT_FAMILY.regular, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: FONT_FAMILY.medium, fontSize: 11, lineHeight: 14 },
  heading: { fontFamily: FONT_FAMILY.bold, fontSize: 18, lineHeight: 24 },
};

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

// Depth system for layered glassmorphism surfaces. Three tiers:
//   1 = cards, list items   2 = panels, modals   3 = overlays, dock
export const DEPTH = {
  1: {
    shadow: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.32,
      shadowRadius: 12,
      elevation: 6,
    },
    border: { top: 0.08, side: 0.03, bottom: 0.02 },
    blur: 40,
  },
  2: {
    shadow: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.48,
      shadowRadius: 20,
      elevation: 14,
    },
    border: { top: 0.11, side: 0.04, bottom: 0.02 },
    blur: 55,
  },
  3: {
    shadow: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.62,
      shadowRadius: 32,
      elevation: 22,
    },
    border: { top: 0.14, side: 0.05, bottom: 0.03 },
    blur: 70,
  },
};

// Tint overlays — applied on top of the BlurView to unify the colour cast.
export const GLASS_TINT = {
  dark:    'rgba(10,10,16,0.55)',
  light:   'rgba(255,255,255,0.06)',
  neutral: 'rgba(20,20,28,0.45)',
};

// Shared glassmorphism styles. Colour values here reference the live proxy
// so the gold-on-charcoal tint becomes whatever the master has selected.
export const GLASS = {
  card: {
    backgroundColor: 'rgba(15, 15, 15, 0.6)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 16,
  },
  cardShadow: {
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 8,
  },
  innerGlow: {
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
};
