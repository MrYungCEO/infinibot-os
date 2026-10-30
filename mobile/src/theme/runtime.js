// Theme runtime — a module-level mutable cache plus a tiny pub/sub. The
// existing screens import `COLORS` and `FONT_FAMILY` from
// `../constants/theme`, and StyleSheet.create freezes those values at module
// load. We can't change that. What we *can* do is keep the module exports
// stable by handing out **proxy objects** whose keys are getters that read
// from this runtime cache — so any inline-style or JSX-prop read (the hot
// path) sees the live palette, and StyleSheet-frozen values pick up the
// latest palette the next time the user warm-reloads or remounts the screen.
//
// This is the bridge that lets the dynamic-theme refactor land without
// touching every screen file.

import { resolveColors, DEFAULT_THEME, findPalette, resolveMode } from './palettes.js';

const DEFAULT_FONTS = {
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semiBold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
  extraBold: 'Inter-ExtraBold',
  display: 'SpaceGrotesk-Bold',
  displayMedium: 'SpaceGrotesk-Medium',
  mono: 'monospace',
};

// Legacy aliases — older callers reach for slightly different token names
// than the resolved palette exposes. Map them once here so a single
// `aliasMap[key] ?? colors[key]` lookup in the proxy keeps them resolving.
// New tokens should be added to `resolveColors` directly, not here.
const COLOR_ALIASES = {
  backgroundColor: 'background',
  fg: 'text',
  accentColor: 'accent',
  brand: 'primary',
};

// Live state shared across the whole app. Mutated by setActiveTheme().
const state = {
  theme: { ...DEFAULT_THEME },
  background: DEFAULT_THEME.background,
  colors: resolveColors(DEFAULT_THEME),
  fonts: { ...DEFAULT_FONTS },
  // Bumped on every setActiveTheme call so listeners can re-render. Useful
  // for the React context wrapper.
  version: 0,
};

const listeners = new Set();

export function getActiveTheme() {
  return state.theme;
}

export function getActiveColors() {
  return state.colors;
}

export function getActiveFonts() {
  return state.fonts;
}

export function getActiveBackground() {
  return state.background;
}

export function getThemeVersion() {
  return state.version;
}

export function subscribeTheme(handler) {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

export function setActiveTheme(theme, options = {}) {
  const next = {
    mode: theme?.mode ?? state.theme.mode,
    paletteId: theme?.paletteId ?? state.theme.paletteId,
    background: theme?.background ?? state.theme.background,
    // The branding broadcast can ship the full ThemeTokens shape (colors,
    // blur/radius, overlay, glass…). Forward every field — resolveColors
    // picks what it needs and the rest stays available via `_raw`.
    tokens: { ...(state.theme.tokens || {}), ...(theme?.tokens || {}) },
  };
  // Make sure the palette resolves cleanly — fall back to default if id is bad.
  if (!findPalette(next.paletteId)) {
    next.paletteId = DEFAULT_THEME.paletteId;
  }
  // Normalize mode — accept `system` as-is (the caller projects to
  // light/dark/hud before reaching here, but be defensive).
  if (next.mode !== 'system') {
    next.mode = resolveMode(next.mode);
  }
  state.theme = next;
  state.background = next.background || 'gradient';
  state.colors = resolveColors(next);
  // Honor a font override from the palette tokens too, so a master picking
  // a custom `fontFamily` re-skins the mobile typography stack.
  const tokenFont = state.colors.fontFamily;
  if (options.fonts || tokenFont) {
    state.fonts = {
      ...DEFAULT_FONTS,
      ...(tokenFont
        ? {
            regular: tokenFont,
            medium: tokenFont,
            semiBold: tokenFont,
            bold: tokenFont,
            extraBold: tokenFont,
            display: tokenFont,
            displayMedium: tokenFont,
          }
        : {}),
      ...(options.fonts || {}),
    };
  } else if (!tokenFont) {
    // Reset back to defaults when the master clears its font override —
    // otherwise a previous `fontFamily` token would stick.
    state.fonts = { ...DEFAULT_FONTS };
  }
  state.version += 1;
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[theme] listener error:', err?.message || err);
    }
  }
}

// ── Live proxy exports (back-compat) ───────────────────────────────
//
// We want `import { COLORS } from '../constants/theme'` to keep working.
// Returning a plain object would snapshot the values at import time. A
// Proxy with a `get` trap reads through to the live state every time.
//
// React Native (Hermes) supports Proxy; we use it sparingly here.

function readColor(key) {
  const direct = state.colors[key];
  if (direct !== undefined) return direct;
  const aliased = COLOR_ALIASES[key];
  if (aliased) return state.colors[aliased];
  return undefined;
}

export const COLORS = new Proxy(
  {},
  {
    get(_, key) {
      return readColor(key);
    },
    ownKeys() {
      return Reflect.ownKeys(state.colors);
    },
    getOwnPropertyDescriptor(_, key) {
      const value = readColor(key);
      if (value === undefined) return undefined;
      return {
        enumerable: true,
        configurable: true,
        value,
      };
    },
    has(_, key) {
      return key in state.colors || key in COLOR_ALIASES;
    },
  },
);

export const FONT_FAMILY = new Proxy(
  {},
  {
    get(_, key) {
      return state.fonts[key];
    },
    ownKeys() {
      return Reflect.ownKeys(state.fonts);
    },
    getOwnPropertyDescriptor(_, key) {
      return {
        enumerable: true,
        configurable: true,
        value: state.fonts[key],
      };
    },
    has(_, key) {
      return key in state.fonts;
    },
  },
);
