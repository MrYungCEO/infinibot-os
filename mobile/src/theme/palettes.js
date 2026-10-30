// Mobile palette catalogue — mirrors src/gateway/server-methods/branding.ts
// BUILT_IN_PALETTES *and* ui/src/ui/theme-glass.ts ThemeTokens. Keep all
// three in sync so the picker on web, the broadcast payload, and the mobile
// resolver agree on token names.
//
// ── Token contract (the raw inputs we accept from the master) ──
//
// Color tokens:
//   primary           Primary brand color (hex). Drives accents, focus rings,
//                     and most gold-tinted derivations.
//   accent            Secondary accent color (hex). Pairs with primary in
//                     gradients (gradient-accent etc.).
//   surfaceTint       Cool-cast surface tint (hex). Blended into panel
//                     surfaces; informs `surface` / `card`.
//   bg                App background base (hex). Drives `background`.
//   fg                Text foreground (hex). Drives `text` and derived
//                     text-secondary/-muted tones.
//
// Layout tokens:
//   blur              Default glass blur radius (px). Mobile maps this to
//                     BlurView intensity / decorative shadow only — RN does
//                     not have CSS backdrop-filter parity.
//   blurHeavy         Heavy glass blur radius (px). Same caveat.
//   radius            Corner radius (px, base).
//   surfaceAlpha      Panel surface alpha (0-1). Composed with surfaceTint
//                     to produce semi-transparent surfaces.
//   shadowDepth       Shadow depth multiplier (0.5–2). Drives the dynamic
//                     shadow stack on Card/GlassCard.
//   fontFamily        Font family stack. Forwarded as-is.
//
// Overlay tokens (background tint layer above the animated bg):
//   overlayColor      Hex tint color for the overlay layer.
//   overlayOpacity    Opacity of the overlay layer (0–1).
//   overlayBlur       Backdrop blur applied through the overlay (px).
//   overlayEnabled    Toggle the overlay entirely (default true).
//
// Glassmorphism tokens (panel glass appearance):
//   glassEnabled      Toggle backdrop blur on glass panels (default true).
//   glassTint         Hex tint layered inside glass panels.
//   glassTintStrength Strength of glassTint (0–1).
//   glassBorderColor  Glass panel border override; falls back to primary.
//
// Every token is optional — `resolveColors` fills missing values from the
// active palette's defaults, and missing palette defaults from
// `FALLBACK_TOKENS` below.

const FALLBACK_TOKENS = {
  primary: '#fbbf24',
  accent: '#a855f7',
  surfaceTint: '#1e1b2e',
  bg: '#0a0a0e',
  fg: '#f5f5f4',
  blur: 14,
  blurHeavy: 22,
  radius: 12,
  surfaceAlpha: 0.05,
  shadowDepth: 1,
  fontFamily: undefined,
  overlayColor: 'transparent',
  overlayOpacity: 0,
  overlayBlur: 0,
  overlayEnabled: true,
  glassEnabled: true,
  glassTint: undefined,
  glassTintStrength: 0.12,
  glassBorderColor: undefined,
};

export const BUILT_IN_PALETTES = [
  {
    id: 'infinibot-gold',
    name: 'InfiniBot Gold',
    mode: 'dark',
    tokens: {
      primary: '#fbbf24',
      accent: '#a855f7',
      surfaceTint: '#1e1b2e',
      bg: '#0a0a0e',
      fg: '#f5f5f4',
      blur: 14,
      blurHeavy: 22,
      radius: 12,
      surfaceAlpha: 0.05,
      shadowDepth: 1,
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    mode: 'dark',
    tokens: {
      primary: '#8b5cf6',
      accent: '#ec4899',
      surfaceTint: '#1a1435',
      bg: '#0b0820',
      fg: '#f4f0ff',
      blur: 24,
      blurHeavy: 36,
      radius: 18,
      surfaceAlpha: 0.06,
      shadowDepth: 1.2,
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    mode: 'dark',
    tokens: {
      primary: '#f97316',
      accent: '#eab308',
      surfaceTint: '#2a1a10',
      bg: '#110806',
      fg: '#fff7ed',
      blur: 16,
      blurHeavy: 26,
      radius: 14,
      surfaceAlpha: 0.05,
      shadowDepth: 1.1,
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    mode: 'dark',
    tokens: {
      primary: '#10b981',
      accent: '#22d3ee',
      surfaceTint: '#0e2620',
      bg: '#06120e',
      fg: '#ecfdf5',
      blur: 18,
      blurHeavy: 28,
      radius: 14,
      surfaceAlpha: 0.05,
      shadowDepth: 1,
    },
  },
  {
    id: 'noir',
    name: 'Noir',
    mode: 'dark',
    tokens: {
      primary: '#e5e5e5',
      accent: '#3b82f6',
      surfaceTint: '#1a1a1a',
      bg: '#050505',
      fg: '#fafafa',
      blur: 12,
      blurHeavy: 20,
      radius: 8,
      surfaceAlpha: 0.04,
      shadowDepth: 0.9,
    },
  },
  {
    id: 'porcelain',
    name: 'Porcelain',
    mode: 'light',
    tokens: {
      primary: '#6366f1',
      accent: '#ec4899',
      surfaceTint: '#ffffff',
      bg: '#f4f4f5',
      fg: '#18181b',
      blur: 20,
      blurHeavy: 30,
      radius: 16,
      surfaceAlpha: 0.7,
      shadowDepth: 0.8,
    },
  },
];

// Repo default — matches DEFAULT_BRANDING in app-branding.ts (web): dark
// mode, Noir palette, aurora background. A first-connect mobile client now
// renders the exact same look as the master shell.
export const DEFAULT_THEME = {
  mode: 'dark',
  paletteId: 'noir',
  background: 'aurora',
  tokens: {},
};

// Full canonical background style id list — must stay in sync with the
// BackgroundStyle union in ui/src/ui/controllers/app-branding.ts. The mobile
// AnimatedBackground renderer maps every id here to a distinct static
// fallback so a master-side pick re-skins mobile correctly even when the
// effect has no WebGL parity on RN.
export const BACKGROUND_OPTIONS = [
  'none',
  'gradient',
  'aurora',
  'faulty-terminal',
  'grainient',
  'dither',
  'iridescence',
  'liquid-chrome',
  'lightning',
  'beams',
  'silk',
  'waves',
  'hyperspeed',
  'threads',
  'particles',
  'metaballs',
  'orb',
  'balatro',
  'letter-glitch',
  'squares',
  'dot-grid',
];

export function findPalette(id) {
  return BUILT_IN_PALETTES.find((p) => p.id === id) || BUILT_IN_PALETTES[0];
}

// ── helpers ────────────────────────────────────────────────────

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const int = parseInt(h, 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

export function rgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function lighten(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const lift = (c) => clamp(Math.round(c + (255 - c) * amount), 0, 255);
  return `rgb(${lift(rgb.r)}, ${lift(rgb.g)}, ${lift(rgb.b)})`;
}

function darken(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const dim = (c) => clamp(Math.round(c * (1 - amount)), 0, 255);
  return `rgb(${dim(rgb.r)}, ${dim(rgb.g)}, ${dim(rgb.b)})`;
}

function isHex(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value);
}

// Rotate a hex color around the HSL color wheel. Used to derive decorative
// "rainbow" tokens (purple, cyan, indigo, pink, …) from the active accent so
// they re-tint with the palette instead of staying fixed.
function shiftHue(hex, degrees) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
      default: break;
    }
    h /= 6;
  }
  h = (h + degrees / 360 + 1) % 1;
  const hueToRgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let nr;
  let ng;
  let nb;
  if (s === 0) {
    nr = ng = nb = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    nr = hueToRgb(p, q, h + 1 / 3);
    ng = hueToRgb(p, q, h);
    nb = hueToRgb(p, q, h - 1 / 3);
  }
  const toHex = (c) => {
    const v = clamp(Math.round(c * 255), 0, 255).toString(16);
    return v.length === 1 ? `0${v}` : v;
  };
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

// ── resolver ─────────────────────────────────────────────────────
//
// Build a flat color map the StyleSheet / inline-styles can consume. The
// fields here are a superset of what mobile/src/constants/theme.js
// previously exposed via COLORS plus every token name web's theme-glass.ts
// derives from --g-* variables, so master-side picks reach mobile screens
// without falling through to undefined.

export function resolveColors(theme) {
  const palette = findPalette(theme?.paletteId);
  const tokens = { ...palette.tokens, ...(theme?.tokens || {}) };
  const resolvedMode = resolveMode(theme?.mode);

  const bg = isHex(tokens.bg) ? tokens.bg : palette.tokens.bg ?? FALLBACK_TOKENS.bg;
  const fg = isHex(tokens.fg) ? tokens.fg : palette.tokens.fg ?? FALLBACK_TOKENS.fg;
  const primary = isHex(tokens.primary) ? tokens.primary : palette.tokens.primary ?? FALLBACK_TOKENS.primary;
  const accent = isHex(tokens.accent) ? tokens.accent : palette.tokens.accent ?? FALLBACK_TOKENS.accent;
  const surfaceTint = isHex(tokens.surfaceTint)
    ? tokens.surfaceTint
    : palette.tokens.surfaceTint ?? FALLBACK_TOKENS.surfaceTint;
  const surfaceAlpha = typeof tokens.surfaceAlpha === 'number'
    ? clamp(tokens.surfaceAlpha, 0, 1)
    : palette.tokens.surfaceAlpha ?? FALLBACK_TOKENS.surfaceAlpha;

  const isLight = resolvedMode === 'light';
  const isHud = resolvedMode === 'hud';
  const isDark = !isLight; // hud still reads "dark-like" for shadowing.

  // Surface stack — HUD lifts everything a touch more than dark so panels
  // separate from the deeper bg.
  const tintShiftSurface = isLight ? 0.0 : isHud ? 0.32 : 0.4;
  const tintShiftElev = isLight ? 0.06 : isHud ? 0.22 : 0.3;
  const surface = isLight ? lighten(bg, 0.03) : darken(surfaceTint, tintShiftSurface);
  const surfaceLight = isLight ? lighten(bg, 0.06) : darken(surfaceTint, tintShiftSurface - 0.18);
  const elevated = isLight ? lighten(bg, 0.05) : darken(surfaceTint, tintShiftElev);
  const hover = isLight ? darken(bg, 0.04) : lighten(surface, 0.05);
  const cardLight = isLight ? lighten(bg, 0.08) : lighten(surface, 0.08);

  // Deep surface tier — below the regular `surface` for dense list views
  // (Activity feed, tighter dashboards) that need to feel grounded against
  // the animated background. Derived from `bg` so it always flows from the
  // active palette, never a hex literal.
  //   surfaceDeep        — primary card backdrop on the Activity page
  //   surfaceDeepStrong  — for nested rows / "well" insets
  //   surfaceInset       — semi-transparent overlay tuned for layering on
  //                        top of glass cards without losing the blur
  //   borderSubtle       — softer hairline divider for nested content
  //   borderSubtleStrong — slightly more present nested divider
  const surfaceDeep = isLight
    ? darken(bg, 0.04)
    : isHud
      ? darken(bg, 0.18)
      : darken(bg, 0.35);
  const surfaceDeepStrong = isLight
    ? darken(bg, 0.08)
    : isHud
      ? darken(bg, 0.28)
      : darken(bg, 0.55);
  const surfaceInset = isLight
    ? rgba(fg, 0.04)
    : `rgba(0,0,0,${isHud ? 0.32 : 0.45})`;
  const borderSubtle = rgba(fg, isLight ? 0.06 : 0.06);
  const borderSubtleStrong = rgba(fg, isLight ? 0.12 : 0.12);

  const textStrong = isLight ? darken(fg, 0.3) : fg;
  const textSecondary = rgba(fg, isLight ? 0.65 : 0.7);
  const textMuted = rgba(fg, isLight ? 0.45 : 0.55);
  const textTertiary = rgba(fg, isLight ? 0.35 : 0.4);
  const textDim = rgba(fg, isLight ? 0.55 : 0.5);

  const borderAlpha = isHud ? 0.22 : isLight ? 0.18 : 0.14;
  const borderStrongAlpha = isHud ? 0.45 : isLight ? 0.35 : 0.28;
  const border = rgba(primary, borderAlpha);
  const borderStrong = rgba(primary, borderStrongAlpha);
  const borderLight = rgba(primary, 0.08);

  // Glass / overlay token forwarding — pass through the raw values, plus
  // resolve sensible defaults from the active palette.
  const blur = tokens.blur ?? palette.tokens.blur ?? FALLBACK_TOKENS.blur;
  const blurHeavy = tokens.blurHeavy ?? palette.tokens.blurHeavy ?? FALLBACK_TOKENS.blurHeavy;
  const radius = tokens.radius ?? palette.tokens.radius ?? FALLBACK_TOKENS.radius;
  const shadowDepth = tokens.shadowDepth ?? palette.tokens.shadowDepth ?? FALLBACK_TOKENS.shadowDepth;
  const fontFamily = tokens.fontFamily ?? palette.tokens.fontFamily ?? FALLBACK_TOKENS.fontFamily;

  const overlayEnabled = tokens.overlayEnabled !== false;
  const overlayColor = tokens.overlayColor ?? FALLBACK_TOKENS.overlayColor;
  const overlayOpacityRaw = typeof tokens.overlayOpacity === 'number'
    ? clamp(tokens.overlayOpacity, 0, 1)
    : FALLBACK_TOKENS.overlayOpacity;
  const overlayOpacity = overlayEnabled ? overlayOpacityRaw : 0;
  const overlayBlur = typeof tokens.overlayBlur === 'number'
    ? Math.max(0, tokens.overlayBlur)
    : FALLBACK_TOKENS.overlayBlur;

  const glassEnabled = tokens.glassEnabled !== false;
  const glassTintColor = isHex(tokens.glassTint) ? tokens.glassTint : primary;
  const glassTintStrength = typeof tokens.glassTintStrength === 'number'
    ? clamp(tokens.glassTintStrength, 0, 1)
    : FALLBACK_TOKENS.glassTintStrength;
  const glassTint = glassEnabled
    ? rgba(glassTintColor, glassTintStrength)
    : 'transparent';
  const glassBorderColor = tokens.glassBorderColor ?? null;

  return {
    // mode + palette context
    mode: resolvedMode,
    paletteId: palette.id,
    isLight,
    isDark,
    isHud,

    // base — `bg` is an alias for `background` for any view still using the
    // raw token name (SleekHeader etc.).
    background: bg,
    bg,
    foreground: fg,
    surface,
    surfaceLight,
    surfaceStrong: surfaceLight,
    elevated,
    hover,
    muted: surface,

    // primary (master's chosen brand color)
    primary,
    primaryLight: rgba(primary, 0.15),
    primaryDim: rgba(primary, 0.08),
    primaryDark: darken(primary, 0.25),
    primaryStrong: rgba(primary, 0.35),
    primarySoft: rgba(primary, 0.08),
    primaryMuted: rgba(primary, 0.18),

    // gold aliases (legacy — many screens reference these directly)
    gold: primary,
    goldDim: darken(primary, 0.25),
    goldLight: lighten(primary, 0.1),
    goldBorder: rgba(primary, 0.3),
    goldGradient: [primary, darken(primary, 0.08), darken(primary, 0.18)],
    goldGradientBright: [lighten(primary, 0.1), primary, darken(primary, 0.08)],

    accentHover: lighten(primary, 0.1),
    accentMuted: darken(primary, 0.2),
    accentSubtle: rgba(primary, 0.15),
    accentGlow: rgba(primary, 0.3),

    secondary: accent,
    secondaryLight: rgba(accent, 0.15),

    // accent (paired with primary in gradients)
    accent,
    accentSoft: rgba(accent, 0.08),
    accentStrong: rgba(accent, 0.35),
    accentDim: darken(accent, 0.2),

    // decorative palette derived from primary — rotates around the wheel so
    // any callsite referencing COLORS.purple / .cyan / etc. stays
    // theme-aware (purple stays purple-ish, cyan stays cyan-ish but tinted
    // toward the current accent).
    purple: shiftHue(primary, 250),
    indigo: shiftHue(primary, 220),
    blue: shiftHue(primary, 195),
    cyan: shiftHue(primary, 160),
    green: shiftHue(primary, 100),
    yellow: shiftHue(primary, 45),
    orange: shiftHue(primary, 25),
    red: shiftHue(primary, 0),
    pink: shiftHue(primary, 320),
    magenta: shiftHue(primary, 290),

    // card / glass
    card: surface,
    cardLight,
    cardBg: rgba(surfaceTint, surfaceAlpha + 0.05),
    cardBorder: rgba(primary, 0.1),
    panelBorder: rgba(primary, 0.18),
    panelHeader: rgba(surfaceTint, surfaceAlpha + 0.1),
    glow: rgba(primary, 0.3),
    glowStrong: rgba(primary, 0.5),

    // deep-surface tier (Activity / dense list views)
    surfaceDeep,
    surfaceDeepStrong,
    surfaceInset,
    borderSubtle,
    borderSubtleStrong,

    // text
    text: fg,
    textStrong,
    textSecondary,
    textMuted,
    textTertiary,
    textDim,

    // chat
    userBubble: primary,
    userBubbleText: isLight ? '#ffffff' : darken(bg, 0.2),
    assistantBubble: rgba(surfaceTint, surfaceAlpha + 0.3),
    assistantBubbleText: fg,

    // status
    error: '#ef4444',
    success: '#22c55e',
    warning: '#f59e0b',
    info: '#3b82f6',

    // borders
    border,
    borderStrong,
    borderLight,
    inputBg: rgba(surfaceTint, surfaceAlpha + 0.15),

    // ring / focus
    ring: primary,

    // glass tokens (raw — for inline use by GlassCard/Surface)
    surfaceAlpha,
    blur,
    blurHeavy,
    radius,
    shadowDepth,
    fontFamily,

    // overlay layer (web parity — mobile uses these for the tint View above
    // the animated bg in AnimatedBackground)
    overlayEnabled,
    overlayColor,
    overlayOpacity,
    overlayBlur,

    // glass-layer parity (mobile interprets `glassEnabled` by switching to
    // an opaque card style, and forwards tint + border for inline use)
    glassEnabled,
    glassTint,
    glassTintStrength,
    glassBorderColor,

    // raw token snapshot — useful for screens that want to reapply via
    // pushThemeToMaster without losing fields they don't directly consume.
    _raw: {
      primary,
      accent,
      surfaceTint,
      bg,
      fg,
      blur,
      blurHeavy,
      radius,
      surfaceAlpha,
      shadowDepth,
      fontFamily,
      overlayColor,
      overlayOpacity: overlayOpacityRaw,
      overlayBlur,
      overlayEnabled,
      glassEnabled,
      glassTint: tokens.glassTint,
      glassTintStrength,
      glassBorderColor,
    },
  };
}

export function resolveMode(mode) {
  if (mode === 'light' || mode === 'dark' || mode === 'hud') return mode;
  return 'dark';
}
