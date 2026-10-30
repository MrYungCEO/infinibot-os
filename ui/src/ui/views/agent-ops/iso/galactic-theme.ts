/**
 * Galactic HQ theme — palette and accent engine for the black & gold
 * isometric station (see docs/design/galactic-hq-activity-map.md).
 *
 * The palette is MUTABLE: setGalacticAccent(color) re-derives the accent
 * ramp (gold/goldLt/goldDp) and the subtly-tinted surfaces from any base
 * color, simulating InfiniBot's dynamic theme system. After changing the
 * accent, callers must rebake textures and rebuild the world
 * (ActivityMap.setAccent does this).
 */

export interface GalacticPalette {
  void: number;
  nebula: number;
  floor: number;
  floorAlt: number;
  panel: number;
  glass: number;
  gold: number;
  goldLt: number;
  goldDp: number;
  hud: number;
  text: number;
  muted: number;
  ok: number;
  err: number;
  warn: number;
  info: number;
  /** Secondary brand accent (CSS --g-accent) — used for FX / heartbeat sheen. */
  accent2: number;
  /** Holographic sheen highlight — bright mix of accent + accent2. */
  sheen: number;
}

/** Linear mix between two 0xRRGGBB colors; t=0 → a, t=1 → b. */
export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export const DEFAULT_ACCENT = 0xd4af37;
export const DEFAULT_ACCENT2 = 0xa855f7;

/** Accent presets offered by the in-map theme picker. */
export const ACCENT_PRESETS: { name: string; color: number }[] = [
  { name: 'GOLD', color: 0xd4af37 },
  { name: 'CYAN', color: 0x3ec6d8 },
  { name: 'VIOLET', color: 0x9a6cf0 },
  { name: 'EMERALD', color: 0x3ed88e },
  { name: 'CRIMSON', color: 0xe05a5a },
  { name: 'ICE', color: 0xa8cfee },
];

/** Mutable palette — import and read fields; never destructure at module load. */
export const GALACTIC: GalacticPalette = {
  void: 0x14141c,
  nebula: 0x1c1828,
  floor: 0x1a1916,
  floorAlt: 0x221f1a,
  panel: 0x24201a,
  glass: 0x1a2026,
  gold: 0xd4af37,
  goldLt: 0xf4d77a,
  goldDp: 0xa87a1e,
  hud: 0xfbbf24,
  text: 0xece6d8,
  muted: 0x9a917f,
  ok: 0x22c55e,
  err: 0xef4444,
  warn: 0xf59e0b,
  info: 0x3b82f6,
  accent2: DEFAULT_ACCENT2,
  sheen: 0xfff4d0,
};

/** The base (void/bg) color the station floats against. CSS --g-bg drives it. */
let baseVoid = 0x050507;

/**
 * Re-derive the full palette from a primary accent, an optional secondary
 * accent (brand --g-accent), and an optional base/void color (--g-bg). This is
 * the single source of truth the dynamic theme system funnels through.
 */
export function setGalacticTheme(accent: number, accent2?: number, bg?: number): void {
  GALACTIC.gold = accent;
  GALACTIC.goldLt = mixColor(accent, 0xffffff, 0.42);
  GALACTIC.goldDp = mixColor(accent, 0x000000, 0.38);
  GALACTIC.hud = mixColor(accent, 0xffffff, 0.18);
  GALACTIC.accent2 = accent2 ?? GALACTIC.accent2;
  // Holographic sheen — a bright wash that leans toward the secondary accent so
  // edge highlights read as "two-tone chrome" rather than flat gold.
  GALACTIC.sheen = mixColor(mixColor(accent, GALACTIC.accent2, 0.35), 0xffffff, 0.55);
  if (bg !== undefined) baseVoid = bg;
  GALACTIC.void = mixColor(0x050507, baseVoid, 0.85);
  // Surfaces pick up a whisper of the accent so the world feels re-themed
  GALACTIC.floor = mixColor(mixColor(0x0b0b0c, baseVoid, 0.4), accent, 0.05);
  GALACTIC.floorAlt = mixColor(mixColor(0x101012, baseVoid, 0.4), accent, 0.07);
  GALACTIC.panel = mixColor(0x131315, accent, 0.1);
  GALACTIC.glass = mixColor(0x181c22, accent, 0.12);
  GALACTIC.nebula = mixColor(0x0c0a12, accent, 0.07);
  GALACTIC.muted = mixColor(0x8c8c8c, accent, 0.18);
  GALACTIC.text = mixColor(0xe8e8e4, accent, 0.1);
  emitThemeChange();
}

/** Back-compat shim — accent-only re-theme. */
export function setGalacticAccent(accent: number): void {
  setGalacticTheme(accent);
}

// ── Theme change event channel ───────────────────────────────────
// Purely additive: lets DOM overlays (rendered outside the Pixi tree) react to
// live accent swaps. Pixi consumers keep reading GALACTIC directly — unchanged.

type ThemeListener = (palette: GalacticPalette) => void;
const themeListeners = new Set<ThemeListener>();

/**
 * Subscribe to live palette changes. Fires once on the next microtask with the
 * current palette so consumers can initialize without a separate read. Returns
 * an unsubscribe fn.
 */
export function subscribeGalacticTheme(cb: ThemeListener): () => void {
  themeListeners.add(cb);
  // Fire once with current palette so consumers init.
  queueMicrotask(() => {
    if (themeListeners.has(cb)) {
      try { cb(GALACTIC); } catch (e) { console.warn('[galactic-theme] listener failed', e); }
    }
  });
  return () => themeListeners.delete(cb);
}

function emitThemeChange(): void {
  for (const cb of themeListeners) {
    try { cb(GALACTIC); } catch (e) { console.warn('[galactic-theme] listener failed', e); }
  }
}

// ── CSS custom-property bridge ───────────────────────────────────
// Mirrors the live palette into --gx-* CSS variables on a root element so DOM
// overlays can style themselves with var() and re-tint in one frame on a swap.

/**
 * Write the current palette into --gx-* custom properties on `root`
 * (default: document root). Pair with subscribeGalacticTheme to keep DOM
 * overlays bound to the live Galactic accent.
 */
export function applyGalacticThemeToRoot(
  palette: GalacticPalette,
  root: HTMLElement = document.documentElement,
): void {
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  const rgba = (n: number, a: number) => {
    const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    return `rgba(${r},${g},${b},${a})`;
  };
  root.style.setProperty('--gx-gold', hex(palette.gold));
  root.style.setProperty('--gx-gold-lt', hex(palette.goldLt));
  root.style.setProperty('--gx-gold-dp', hex(palette.goldDp));
  root.style.setProperty('--gx-hud', hex(palette.hud));
  root.style.setProperty('--gx-accent2', hex(palette.accent2));
  root.style.setProperty('--gx-sheen', hex(palette.sheen));
  root.style.setProperty('--gx-void', hex(palette.void));
  root.style.setProperty('--gx-panel', hex(palette.panel));
  root.style.setProperty('--gx-glass', hex(palette.glass));
  root.style.setProperty('--gx-muted', hex(palette.muted));
  root.style.setProperty('--gx-text', hex(palette.text));
  root.style.setProperty('--gx-gold-15', rgba(palette.gold, 0.15));
  root.style.setProperty('--gx-gold-30', rgba(palette.gold, 0.3));
  root.style.setProperty('--gx-gold-50', rgba(palette.gold, 0.5));
  root.style.setProperty('--gx-gold-80', rgba(palette.gold, 0.8));
  root.style.setProperty('--gx-accent2-20', rgba(palette.accent2, 0.2));
  root.style.setProperty('--gx-accent2-40', rgba(palette.accent2, 0.4));
}

let rootBridgeInstalled = false;
/**
 * Idempotent one-time installer: subscribes the document root to live palette
 * changes. Safe to call from multiple mount points — only the first wires up.
 */
export function installGalacticThemeRootBridge(): void {
  if (rootBridgeInstalled) return;
  if (typeof document === 'undefined') return;
  rootBridgeInstalled = true;
  subscribeGalacticTheme((palette) => applyGalacticThemeToRoot(palette));
  // Debug affordance — lets the live theme be driven from the console for QA
  // (e.g. `__galacticTheme.setAccent(0xff6b9d)`). Purely additive.
  try {
    (window as unknown as Record<string, unknown>).__galacticTheme = {
      setAccent: setGalacticAccent,
      setTheme: setGalacticTheme,
      palette: GALACTIC,
      subscribe: subscribeGalacticTheme,
    };
  } catch { /* non-browser env */ }
}

// ── Dynamic CSS theme bridge ─────────────────────────────────────
// Reads the app's live theme tokens (set by theme-glass.ts via
// applyThemeOverrides / setThemeMode) so the Pixi palette tracks light/dark/
// brand swaps without any per-view config. A single resolveTheme() keeps the
// mapping in one place for future tokens.

/** Parse a CSS color string (#rgb, #rrggbb, rgb()/rgba()) → 0xRRGGBB or null. */
export function parseCssColor(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex.slice(0, 6);
    const n = parseInt(full, 16);
    return Number.isFinite(n) ? n : null;
  }
  const m = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) return (parseInt(m[1], 10) << 16) | (parseInt(m[2], 10) << 8) | parseInt(m[3], 10);
  return null;
}

export interface ResolvedGalacticTheme {
  accent: number;
  accent2: number;
  bg: number;
}

/** Read the live CSS theme tokens into a resolved galactic theme. */
export function resolveGalacticTheme(): ResolvedGalacticTheme {
  const fallback: ResolvedGalacticTheme = { accent: DEFAULT_ACCENT, accent2: DEFAULT_ACCENT2, bg: 0x0a0a0e };
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  try {
    const cs = getComputedStyle(document.documentElement);
    const read = (name: string, fb: number) => parseCssColor(cs.getPropertyValue(name)) ?? fb;
    return {
      accent: read('--g-primary', fallback.accent),
      accent2: read('--g-accent', fallback.accent2),
      bg: read('--g-bg', fallback.bg),
    };
  } catch {
    return fallback;
  }
}

// Initialize derived fields so defaults and derivation never drift
setGalacticTheme(DEFAULT_ACCENT, DEFAULT_ACCENT2, 0x0a0a0e);

// Self-install the document-root --gx-* bridge on first import. Every overlay
// surface (dashboard band / agent-ops grid / activity page) loads this module
// transitively via ActivityMap, so the DOM overlays always track the live
// accent without each mount point wiring it up. Idempotent + DOM-guarded.
installGalacticThemeRootBridge();

// Station grid sizing lives in sector-layout.ts (STATION_GRID).
