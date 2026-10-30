/**
 * Terminal Theme — Matches Web Masonry Grid Exactly
 * Futuristic terminal aesthetic with sharp edges and monospace typography
 *
 * NOTE: The gold-accent tokens (gold, goldDim, goldGlow, …) and any token
 * derived from the primary brand color are routed through the live theme
 * runtime via a Proxy so they re-paint whenever the master device switches
 * palettes. Plain-string tokens (bg*, text*, ok/warning/danger, ANSI yellow)
 * stay static because they describe canonical terminal semantics, not branding.
 */

import { COLORS as LIVE_COLORS } from '../theme/runtime.js';

// Static keys — these are not part of the dynamic theme.
const STATIC_TERMINAL_COLORS = {
  // Backgrounds
  bg0: '#040404',        // Deepest black
  bg1: '#0a0a0a',        // Primary background
  bg2: '#111111',        // Elevated surface
  bg3: '#1a1a1a',        // Card/panel background

  // Text
  text: '#e4e4e7',
  textStrong: '#ffffff',
  textMuted: '#a1a1aa',
  textDim: '#71717a',
  textSubtle: '#52525b',

  // Borders
  border: '#27272a',
  borderLight: 'rgba(255, 255, 255, 0.1)',
  borderStrong: '#3f3f46',

  // Status
  ok: '#22c55e',
  okGlow: 'rgba(34, 197, 94, 0.5)',
  danger: '#ef4444',
  dangerGlow: 'rgba(239, 68, 68, 0.5)',
  warning: '#f59e0b',
  info: '#3b82f6',

  userBubbleText: '#040404',
  assistantBubble: 'rgba(10, 10, 10, 0.95)',
  assistantBubbleText: '#e4e4e7',

  panelHeader: 'rgba(0, 0, 0, 0.6)',

  inputBg: '#0d0d15',
  inputBorder: 'rgba(255, 255, 255, 0.15)',
};

// Gold-accent keys that should follow the master's primary color in real time.
// Resolved on every read so a master-side palette switch propagates instantly.
const DYNAMIC_KEYS = {
  gold:                    () => LIVE_COLORS.primary,
  goldDim:                 () => LIVE_COLORS.primaryDark,
  goldLight:               () => LIVE_COLORS.goldLight,
  goldGlow:                () => LIVE_COLORS.glow,        // rgba(primary, 0.3)
  goldSubtle:              () => LIVE_COLORS.primaryDim,  // rgba(primary, 0.08)
  goldBorder:              () => LIVE_COLORS.cardBorder,  // rgba(primary, 0.1)
  goldHover:               () => LIVE_COLORS.primaryLight,// rgba(primary, 0.15)
  goldGradient:            () => LIVE_COLORS.goldGradient,
  goldGradientBright:      () => LIVE_COLORS.goldGradientBright,
  goldGradientDark:        () => [LIVE_COLORS.primaryDark, LIVE_COLORS.primaryDark, LIVE_COLORS.primaryDark],
  userBubble:              () => LIVE_COLORS.primary,
  assistantBubbleBorder:   () => LIVE_COLORS.cardBorder,
  panelBorder:             () => LIVE_COLORS.panelBorder, // rgba(primary, 0.18)
  panelActive:             () => LIVE_COLORS.primaryMuted,// rgba(primary, 0.18)
  inputFocus:              () => LIVE_COLORS.primary,
};

export const TERMINAL_COLORS = new Proxy(STATIC_TERMINAL_COLORS, {
  get(target, key) {
    if (key in DYNAMIC_KEYS) return DYNAMIC_KEYS[key]();
    return target[key];
  },
  has(target, key) {
    return key in target || key in DYNAMIC_KEYS;
  },
  ownKeys(target) {
    return [...Reflect.ownKeys(target), ...Object.keys(DYNAMIC_KEYS)];
  },
  getOwnPropertyDescriptor(target, key) {
    if (key in DYNAMIC_KEYS) {
      return { enumerable: true, configurable: true, value: DYNAMIC_KEYS[key]() };
    }
    const desc = Object.getOwnPropertyDescriptor(target, key);
    return desc;
  },
});

// Typography — Modern + Monospace Mix
// Uses Inter for UI, monospace for terminal elements
export const TERMINAL_FONTS = {
  // Primary text - Inter for readability
  body: {
    fontFamily: 'Inter-Regular',
    fontSize: 14,
    lineHeight: 22,
    letterSpacing: 0.2,
  },
  
  // Small text
  small: {
    fontFamily: 'Inter-Regular',
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: 0.1,
  },
  
  // Tiny labels
  tiny: {
    fontFamily: 'Inter-Medium',
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  
  // Headings - Space Grotesk for impact
  heading: {
    fontFamily: 'SpaceGrotesk-Bold',
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: 0.3,
  },
  
  // Terminal prompts - monospace for authenticity
  prompt: {
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  
  // Code blocks - monospace
  code: {
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 20,
    letterSpacing: 0,
  },
  
  // Panel titles
  panelTitle: {
    fontFamily: 'Inter-SemiBold',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  
  // Status indicators
  status: {
    fontFamily: 'Inter-Bold',
    fontSize: 9,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
};

// Spacing — Tighter terminal feel
export const TERMINAL_SPACING = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  xxl: 28,
};

// Border radius — Sharp terminal aesthetic
export const TERMINAL_RADIUS = {
  none: 0,
  xs: 2,
  sm: 4,
  md: 6,
  lg: 8,
  panel: 8,
  bubble: 6,
};

// Shadows — Subtle glow effects. The shadowColor on the gold-glow recipes
// reads through TERMINAL_COLORS so a master-side palette change re-tints them
// at next render. (RN style objects are deep-frozen by StyleSheet.create, but
// inline usages — `...TERMINAL_SHADOWS.panel` — pull the live value here.)
export const TERMINAL_SHADOWS = {
  get panel() {
    return {
      shadowColor: TERMINAL_COLORS.gold,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.1,
      shadowRadius: 12,
      elevation: 8,
    };
  },
  get panelActive() {
    return {
      shadowColor: TERMINAL_COLORS.gold,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.25,
      shadowRadius: 20,
      elevation: 12,
    };
  },
  get glow() {
    return {
      shadowColor: TERMINAL_COLORS.gold,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.15,
      shadowRadius: 10,
      elevation: 6,
    };
  },
  status: {
    shadowColor: '#22c55e',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 4,
  },
};

// Panel presets
export const TERMINAL_PANEL = {
  header: {
    height: 36,
    backgroundColor: TERMINAL_COLORS.panelHeader,
    borderBottomWidth: 1,
    borderBottomColor: TERMINAL_COLORS.goldBorder,
  },
  container: {
    backgroundColor: TERMINAL_COLORS.bg1,
    borderWidth: 1,
    borderColor: TERMINAL_COLORS.panelBorder,
    borderRadius: TERMINAL_RADIUS.panel,
    overflow: 'hidden',
  },
  containerActive: {
    borderColor: TERMINAL_COLORS.gold,
    ...TERMINAL_SHADOWS.panelActive,
  },
};

// Status LED styles
export const TERMINAL_LED = {
  base: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  active: {
    backgroundColor: TERMINAL_COLORS.ok,
    ...TERMINAL_SHADOWS.status,
  },
  inactive: {
    backgroundColor: TERMINAL_COLORS.textDim,
  },
  streaming: {
    backgroundColor: TERMINAL_COLORS.gold,
    shadowColor: TERMINAL_COLORS.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 4,
  },
};

// Message prompt symbols
export const TERMINAL_PROMPTS = {
  user: '❯',
  assistant: '→',
  system: '*',
  error: '✗',
  thinking: '◆',
};

// ANSI-style colors for syntax highlighting
export const ANSI_COLORS = {
  black: '#000000',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#FFD700',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fde047',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

export default {
  COLORS: TERMINAL_COLORS,
  FONTS: TERMINAL_FONTS,
  SPACING: TERMINAL_SPACING,
  RADIUS: TERMINAL_RADIUS,
  SHADOWS: TERMINAL_SHADOWS,
  PANEL: TERMINAL_PANEL,
  LED: TERMINAL_LED,
  PROMPTS: TERMINAL_PROMPTS,
  ANSI: ANSI_COLORS,
};
