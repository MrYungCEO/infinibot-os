/**
 * Glass-HUD theme system.
 *
 * Exposes a CSS variable design system (--g-*) plus utility classes and a
 * runtime API for dynamic theme overrides. The baseline rules live in the
 * injected <style> block; user/brand overrides are written as inline style
 * properties on :root so they take precedence and can be cleared at will.
 *
 * Usage:
 *   injectGlassTheme();                           // once from bootstrap
 *   setThemeMode("hud");                          // dark | light | hud | system
 *   applyThemeOverrides({ primary: "#8b5cf6" });  // runtime tweak
 *   applyPalette(BUILT_IN_PALETTES[0]);           // swatch pick
 */

import { resolveTheme, type ResolvedTheme, type ThemeMode } from "./theme.js";
import { applyPerfModeClass } from "./lib/perf-mode.js";

let injected = false;

// Performance mode (low-end devices): keep the glass identity — same tints,
// borders, saturation and gold accents — but halve the backdrop-blur radii.
// Backdrop blur is one of the most expensive per-frame GPU passes; smaller
// radii cut that cost while the surfaces still read as frosted glass.
const PERF_GLASS_OVERRIDES = `
:root.perf-mode {
  --g-blur: blur(7px) saturate(150%);
  --g-blur-heavy: blur(11px) saturate(170%);
}
:root.perf-mode[data-theme="hud"] {
  --g-blur: blur(12px) saturate(175%);
  --g-blur-heavy: blur(18px) saturate(195%);
}
/* Trim the always-animating aurora bloom on low-end GPUs. */
:root.perf-mode .hud-aurora,
:root.perf-mode .hud-top-glow {
  filter: blur(40px);
  opacity: 0.6;
}
`;

export function injectGlassTheme(): void {
  if (injected) return;
  injected = true;
  applyPerfModeClass();
  const style = document.createElement("style");
  style.id = "infinibot-glass-theme";
  style.textContent = GLASS_STYLES + PERF_GLASS_OVERRIDES;
  document.head.appendChild(style);
  mountAuroraLayers();
}

function mountAuroraLayers(): void {
  if (typeof document === "undefined") return;
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", mountAuroraLayers, { once: true });
    return;
  }
  if (!document.querySelector(".hud-aurora")) {
    const aurora = document.createElement("div");
    aurora.className = "hud-aurora";
    aurora.setAttribute("aria-hidden", "true");
    document.body.prepend(aurora);
  }
  if (!document.querySelector(".infinibot-bg-overlay")) {
    const overlay = document.createElement("div");
    overlay.className = "infinibot-bg-overlay";
    overlay.setAttribute("aria-hidden", "true");
    // Append AFTER aurora so it sits above the aurora but below app content.
    document.body.prepend(overlay);
  }
  if (!document.querySelector(".glass-ambient")) {
    // Premium glass ambient: slow gold orbs + film grain + vignette that sit
    // behind every frosted surface (styles/glass/shell.css). Pre-blurred
    // radial gradients — no backdrop-filter cost.
    const ambient = document.createElement("div");
    ambient.className = "glass-ambient";
    ambient.setAttribute("aria-hidden", "true");
    for (const n of [1, 2, 3]) {
      const orb = document.createElement("span");
      orb.className = `glass-ambient__orb glass-ambient__orb--${n}`;
      ambient.appendChild(orb);
    }
    document.body.prepend(ambient);
  }
  if (!document.querySelector(".hud-top-glow")) {
    const glow = document.createElement("div");
    glow.className = "hud-top-glow";
    glow.setAttribute("aria-hidden", "true");
    document.body.prepend(glow);
  }
}

// ── Runtime token overrides ────────────────────────────────────────────────

export interface ThemeTokens {
  /** Primary brand color — hex (e.g. "var(--g-primary)"). */
  primary?: string;
  /** Secondary accent — hex. */
  accent?: string;
  /** Cool-cast surface tint — hex. Blended into panels. */
  surfaceTint?: string;
  /** App background base — hex. */
  bg?: string;
  /** Text foreground — hex. */
  fg?: string;
  /** Default blur, px. */
  blur?: number;
  /** Heavy blur, px. */
  blurHeavy?: number;
  /** Corner radius, px (base). */
  radius?: number;
  /** Font family stack. */
  fontFamily?: string;
  /** Panel surface alpha (0-1). */
  surfaceAlpha?: number;
  /** Shadow depth multiplier (0.5 - 2). */
  shadowDepth?: number;
  /** Tint color applied as a fixed overlay above the animated background. */
  overlayColor?: string;
  /** Overlay opacity (0-1). 0 = invisible. */
  overlayOpacity?: number;
  /** Backdrop blur applied through the overlay (px). */
  overlayBlur?: number;
  /** Toggle the background overlay layer entirely. Default true. */
  overlayEnabled?: boolean;
  /** Toggle backdrop-filter blur on glass panels. Default true. */
  glassEnabled?: boolean;
  /** Tint color layered inside glass panels (in addition to surfaceTint). */
  glassTint?: string;
  /** Strength of glassTint, 0-1. */
  glassTintStrength?: number;
  /** Glass panel border color override; falls back to derived primary tint. */
  glassBorderColor?: string;
}

export interface ThemePalette {
  id: string;
  name: string;
  mode: ResolvedTheme;
  tokens: ThemeTokens;
}

export const BUILT_IN_PALETTES: ThemePalette[] = [
  {
    id: "infinibot-gold",
    name: "InfiniBot Gold",
    mode: "dark",
    tokens: {
      primary: "#fbbf24",
      accent: "#a855f7",
      surfaceTint: "#1e1b2e",
      bg: "#0a0a0e",
      fg: "#f5f5f4",
      blur: 14,
      blurHeavy: 22,
      radius: 12,
      surfaceAlpha: 0.05,
      shadowDepth: 1,
    },
  },
  {
    id: "aurora",
    name: "Aurora",
    mode: "dark",
    tokens: {
      primary: "#8b5cf6",
      accent: "#ec4899",
      surfaceTint: "#1a1435",
      bg: "#0b0820",
      fg: "#f4f0ff",
      blur: 24,
      blurHeavy: 36,
      radius: 18,
      surfaceAlpha: 0.06,
      shadowDepth: 1.2,
    },
  },
  {
    id: "ember",
    name: "Ember",
    mode: "dark",
    tokens: {
      primary: "#f97316",
      accent: "#eab308",
      surfaceTint: "#2a1a10",
      bg: "#110806",
      fg: "#fff7ed",
      blur: 16,
      blurHeavy: 26,
      radius: 14,
      surfaceAlpha: 0.05,
      shadowDepth: 1.1,
    },
  },
  {
    id: "forest",
    name: "Forest",
    mode: "dark",
    tokens: {
      primary: "#10b981",
      accent: "#22d3ee",
      surfaceTint: "#0e2620",
      bg: "#06120e",
      fg: "#ecfdf5",
      blur: 18,
      blurHeavy: 28,
      radius: 14,
      surfaceAlpha: 0.05,
      shadowDepth: 1,
    },
  },
  {
    id: "noir",
    name: "Noir",
    mode: "dark",
    tokens: {
      primary: "#e5e5e5",
      accent: "#3b82f6",
      surfaceTint: "#1a1a1a",
      bg: "#050505",
      fg: "#fafafa",
      blur: 12,
      blurHeavy: 20,
      radius: 8,
      surfaceAlpha: 0.04,
      shadowDepth: 0.9,
    },
  },
  {
    id: "porcelain",
    name: "Porcelain",
    mode: "light",
    tokens: {
      primary: "#6366f1",
      accent: "#ec4899",
      surfaceTint: "#ffffff",
      bg: "#f4f4f5",
      fg: "#18181b",
      blur: 20,
      blurHeavy: 30,
      radius: 16,
      surfaceAlpha: 0.7,
      shadowDepth: 0.8,
    },
  },
];

// ── Color utilities ────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const int = parseInt(h, 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (rgb) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  // Non-hex input (e.g. "var(--something)") — fall through to color-mix so
  // we still produce a valid CSS color when callers pass var() references.
  return `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, transparent)`;
}

function lighten(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const lift = (c: number) => Math.max(0, Math.min(255, Math.round(c + (255 - c) * amount)));
  return `rgb(${lift(rgb.r)}, ${lift(rgb.g)}, ${lift(rgb.b)})`;
}

function darken(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const dim = (c: number) => Math.max(0, Math.min(255, Math.round(c * (1 - amount))));
  return `rgb(${dim(rgb.r)}, ${dim(rgb.g)}, ${dim(rgb.b)})`;
}

// ── Runtime token application ─────────────────────────────────────────────

// Full list of CSS custom properties that applyThemeOverrides may write to
// :root.style. Anything we set must be in here so clearThemeOverrides can
// remove it on palette swap / revert; otherwise stale values bleed through
// the next apply.
const OVERRIDE_VAR_NAMES: readonly string[] = [
  "--g-primary",
  "--g-primary-soft",
  "--g-primary-muted",
  "--g-primary-strong",
  "--g-accent",
  "--g-accent-soft",
  "--g-accent-muted",
  "--g-accent-strong",
  "--g-bg",
  "--g-bg-deep",
  "--g-fg",
  "--g-fg-dim",
  "--g-fg-faint",
  "--g-surface",
  "--g-surface-strong",
  "--g-surface-hover",
  "--g-border",
  "--g-border-strong",
  "--g-blur",
  "--g-blur-heavy",
  "--g-radius",
  "--g-radius-sm",
  "--g-radius-lg",
  "--g-shadow",
  "--g-shadow-lg",
  "--g-shadow-sm",
  "--g-gradient-bg",
  "--g-gradient-accent",
  "--g-gradient-ink",
  "--g-gradient-surface",
  "--g-font-family",
  // Overlay + glass layer (controllable via the appearance picker).
  "--g-overlay-color",
  "--g-overlay-opacity",
  "--g-overlay-blur",
  "--g-glass-tint",
  "--g-glass-border",
  // Legacy aliases that applyThemeOverrides writes for older views still
  // consuming bare ("--accent" / "--gold" / etc.) names. Listed so a clear
  // pass also resets them and they don't carry over to a new palette.
  "--c-accent",
  "--c-fg",
  "--gold",
  "--ring",
  "--border-hover",
  "--seam-color",
  "--accent",
  "--primary",
  "--text",
  "--fg",
  "--foreground",
  "--bg",
  "--background",
];

export function applyThemeOverrides(tokens: ThemeTokens): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const setVar = (name: string, value: string | null) => {
    if (value == null || value === "") root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  };

  if (tokens.primary) {
    setVar("--g-primary", tokens.primary);
    setVar("--g-primary-soft", rgba(tokens.primary, 0.08));
    setVar("--g-primary-muted", rgba(tokens.primary, 0.18));
    setVar("--g-primary-strong", rgba(tokens.primary, 0.35));
    setVar("--g-border-strong", rgba(tokens.primary, 0.4));
    // Legacy token bridge — existing views consume these directly.
    setVar("--c-accent", tokens.primary);
    setVar("--gold", tokens.primary);
    setVar("--ring", tokens.primary);
    setVar("--border-hover", tokens.primary);
    setVar("--seam-color", tokens.primary);
    setVar("--accent", tokens.primary);
    setVar("--primary", tokens.primary);
  }
  if (tokens.accent) {
    setVar("--g-accent", tokens.accent);
    setVar("--g-accent-soft", rgba(tokens.accent, 0.08));
    setVar("--g-accent-muted", rgba(tokens.accent, 0.18));
    setVar("--g-accent-strong", rgba(tokens.accent, 0.35));
  }
  if (tokens.bg) {
    setVar("--g-bg", tokens.bg);
    setVar("--g-bg-deep", darken(tokens.bg, 0.4));
  }
  if (tokens.fg) {
    setVar("--g-fg", tokens.fg);
    setVar("--g-fg-dim", rgba(tokens.fg, 0.65));
    setVar("--g-fg-faint", rgba(tokens.fg, 0.4));
    setVar("--c-fg", tokens.fg);
    setVar("--text", tokens.fg);
    setVar("--fg", tokens.fg);
    setVar("--foreground", tokens.fg);
  }
  if (tokens.bg) {
    setVar("--bg", tokens.bg);
    setVar("--background", tokens.bg);
  }
  if (tokens.surfaceTint || tokens.surfaceAlpha != null) {
    const tint = tokens.surfaceTint ?? "#ffffff";
    const alpha = tokens.surfaceAlpha ?? 0.05;
    setVar("--g-surface", rgba(tint, alpha));
    setVar("--g-surface-strong", rgba(tint, Math.min(1, alpha * 2)));
    setVar("--g-surface-hover", rgba(tint, Math.min(1, alpha * 1.6)));
    // Also refresh gradient surfaces derived from tint.
    setVar(
      "--g-gradient-surface",
      `linear-gradient(135deg, ${rgba(tint, Math.min(1, alpha * 1.8))} 0%, ${rgba(tint, alpha * 0.5)} 50%, ${rgba(tint, alpha)} 100%)`,
    );
  }
  // --g-blur / --g-blur-heavy are written below in the glassEnabled block so
  // a single source-of-truth handles both the blur amount and the on/off
  // toggle. (Writing them here as well would be a redundant override.)
  if (tokens.radius != null) {
    setVar("--g-radius", `${tokens.radius}px`);
    setVar("--g-radius-sm", `${Math.max(4, tokens.radius - 4)}px`);
    setVar("--g-radius-lg", `${tokens.radius + 6}px`);
  }
  if (tokens.fontFamily) setVar("--g-font-family", tokens.fontFamily);
  if (tokens.shadowDepth != null) {
    const d = tokens.shadowDepth;
    setVar("--g-shadow-sm", `0 4px 14px rgba(0, 0, 0, ${0.18 * d})`);
    setVar("--g-shadow", `0 12px 40px rgba(0, 0, 0, ${0.35 * d})`);
    setVar("--g-shadow-lg", `0 24px 60px rgba(0, 0, 0, ${0.45 * d})`);
  }
  // Composite gradients reference the var() forms of primary/accent/bg so any
  // future change to a single colour token is picked up automatically — the
  // user's "Primary" pick now visibly refreshes the bg radial and the accent
  // gradients without depending on which other token they touched last. The
  // strings themselves only need to be (re)written when the *recipe* changes,
  // so we set them every call regardless of which colour tokens were passed.
  setVar("--g-gradient-accent", "linear-gradient(135deg, var(--g-primary), var(--g-accent))");
  setVar(
    "--g-gradient-ink",
    "linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 18%, transparent), color-mix(in srgb, var(--g-accent) 14%, transparent))",
  );
  setVar(
    "--g-gradient-bg",
    "radial-gradient(ellipse 80% 60% at 50% 0%, color-mix(in srgb, var(--g-primary) 8%, transparent), transparent 60%), linear-gradient(180deg, var(--g-bg), var(--g-bg-deep))",
  );
  // Overlay tint + blur: rendered by .infinibot-bg-overlay (z-index between
  // the animated background and app content). Each var defaults to a no-op
  // so the overlay is invisible until the user enables it.
  setVar("--g-overlay-color", tokens.overlayColor ?? "transparent");
  // Toggle and opacity multiply: enabled=false zeroes the layer regardless of
  // the configured opacity slider, so the user can disable the overlay
  // without losing the colour/blur values they've dialed in.
  const overlayEnabled = tokens.overlayEnabled !== false;
  const overlayOpacityRaw = tokens.overlayOpacity != null ? Math.max(0, Math.min(1, tokens.overlayOpacity)) : 0;
  setVar("--g-overlay-opacity", String(overlayEnabled ? overlayOpacityRaw : 0));
  setVar(
    "--g-overlay-blur",
    tokens.overlayBlur != null ? `${Math.max(0, tokens.overlayBlur)}px` : "0px",
  );

  // Glassmorphism: when disabled, drop the backdrop-filter so panels read as
  // flat surfaces. The glass tint sits inside .glass / .glass-panel as an
  // optional tinted gradient; strength controls its alpha.
  const glassEnabled = tokens.glassEnabled !== false;
  // Mirror the switch onto the --glass-* system (styles/glass/tokens.css):
  // surfaces go solid and blur is dropped, same as reduced transparency.
  root.classList.toggle("glass-reduced", !glassEnabled);
  setVar(
    "--g-blur",
    glassEnabled
      ? (tokens.blur != null ? `blur(${tokens.blur}px) saturate(160%)` : null)
      : "none",
  );
  setVar(
    "--g-blur-heavy",
    glassEnabled
      ? (tokens.blurHeavy != null ? `blur(${tokens.blurHeavy}px) saturate(180%)` : null)
      : "none",
  );
  if (tokens.glassTint || tokens.glassTintStrength != null) {
    const tint = tokens.glassTint ?? tokens.primary ?? "#ffffff";
    const strength = tokens.glassTintStrength != null
      ? Math.max(0, Math.min(1, tokens.glassTintStrength))
      : 0.12;
    setVar("--g-glass-tint", rgba(tint, strength));
  } else {
    setVar("--g-glass-tint", "transparent");
  }
  setVar("--g-glass-border", tokens.glassBorderColor ?? null);
}

export function clearThemeOverrides(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const name of OVERRIDE_VAR_NAMES) root.style.removeProperty(name);
  root.classList.remove("glass-reduced");
}

export function applyPalette(palette: ThemePalette | null): void {
  if (!palette) {
    clearThemeOverrides();
    return;
  }
  applyThemeOverrides(palette.tokens);
}

export function setThemeMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
}

// ── Baseline CSS (per-mode defaults; overrides above shadow these) ────────

const GLASS_STYLES = `
:root {
  --g-font-family: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --g-primary: var(--c-accent, var(--g-primary));
  --g-primary-soft: rgba(251, 191, 36, 0.08);
  --g-primary-muted: rgba(251, 191, 36, 0.18);
  --g-primary-strong: rgba(251, 191, 36, 0.35);
  --g-accent: #a855f7;
  --g-accent-soft: rgba(168, 85, 247, 0.08);
  --g-accent-muted: rgba(168, 85, 247, 0.18);
  --g-accent-strong: rgba(168, 85, 247, 0.35);
  --g-bg: #0a0a0e;
  --g-bg-deep: #050507;
  --g-fg: var(--c-fg, #f5f5f4);
  --g-fg-dim: rgba(245, 245, 244, 0.65);
  --g-fg-faint: rgba(245, 245, 244, 0.4);
  --g-surface: rgba(255, 255, 255, 0.04);
  --g-surface-strong: rgba(255, 255, 255, 0.08);
  --g-surface-hover: rgba(255, 255, 255, 0.06);
  --g-border: rgba(251, 191, 36, 0.14);
  --g-border-strong: rgba(251, 191, 36, 0.3);
  --g-blur: blur(14px) saturate(160%);
  --g-blur-heavy: blur(22px) saturate(180%);
  --g-radius: 12px;
  --g-radius-sm: 8px;
  --g-radius-lg: 18px;
  --g-shadow-sm: 0 4px 14px rgba(0, 0, 0, 0.18);
  --g-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  --g-shadow-lg: 0 24px 60px rgba(0, 0, 0, 0.45);
  --g-gradient-bg:
    radial-gradient(ellipse 80% 60% at 50% 0%, rgba(251, 191, 36, 0.06), transparent 60%),
    linear-gradient(180deg, #0a0a0e, #050507);
  --g-gradient-accent: linear-gradient(135deg, var(--g-primary), var(--g-accent));
  --g-gradient-ink: linear-gradient(135deg, var(--g-primary-muted), var(--g-accent-muted));
  --g-gradient-surface:
    linear-gradient(135deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.02) 50%, rgba(255, 255, 255, 0.05) 100%);

  /* ── Semantic status palette ────────────────────────────────────
     One vocabulary for "this is fine / watch it / this is broken",
     shared by every surface. Before these existed, status greens,
     ambers and reds were re-declared ad hoc at dozens of call sites
     across the agency screens, so a theme change moved some of them
     and not others. Prefer these over literal hex for anything that
     communicates state; use the -soft variants for fills and the
     -border variants for outlines. */
  --g-success: #22c55e;
  --g-success-soft: color-mix(in srgb, var(--g-success) 12%, transparent);
  --g-success-border: color-mix(in srgb, var(--g-success) 40%, transparent);
  --g-warning: #f59e0b;
  --g-warning-soft: color-mix(in srgb, var(--g-warning) 12%, transparent);
  --g-warning-border: color-mix(in srgb, var(--g-warning) 40%, transparent);
  --g-danger: #ef4444;
  --g-danger-soft: color-mix(in srgb, var(--g-danger) 12%, transparent);
  --g-danger-border: color-mix(in srgb, var(--g-danger) 40%, transparent);
  --g-info: #38bdf8;
  --g-info-soft: color-mix(in srgb, var(--g-info) 12%, transparent);
  --g-info-border: color-mix(in srgb, var(--g-info) 40%, transparent);
  --g-neutral: #94a3b8;
  --g-neutral-soft: color-mix(in srgb, var(--g-neutral) 12%, transparent);
  --g-neutral-border: color-mix(in srgb, var(--g-neutral) 40%, transparent);

  /* ── Metric palette ─────────────────────────────────────────────
     Per-metric chart accent colors. Used by sparklines, gauges, and
     heatmaps so each metric reads as a distinct signal even when the
     primary brand color shifts via the palette picker. Severity tokens
     escalate the same surface through warn → danger as values climb. */
  --g-metric-cpu: #7CFFA0;
  --g-metric-gpu: #61E8FF;
  --g-metric-ram: #FFB347;
  --g-metric-net: #6BA8FF;
  --g-metric-disk: #E289FF;
  --g-state-success: #7CFFA0;
  --g-state-success-soft: color-mix(in oklab, #7CFFA0 16%, transparent);
  --g-state-warn: #FFB347;
  --g-state-warn-soft: color-mix(in oklab, #FFB347 16%, transparent);
  --g-state-danger: #FF4D4D;
  --g-state-danger-soft: color-mix(in oklab, #FF4D4D 16%, transparent);
  --g-state-info: #61E8FF;
  --g-state-info-soft: color-mix(in oklab, #61E8FF 14%, transparent);

  /* Motion tokens — single source of truth for transition timings. */
  --g-motion-fast: 180ms ease;
  --g-motion-medium: 260ms ease;
  --g-motion-slow: 420ms ease;
}

:root[data-theme="light"] {
  --g-bg: #f4f4f5;
  --g-bg-deep: #e4e4e7;
  --g-fg: #18181b;
  --g-fg-dim: rgba(24, 24, 27, 0.7);
  --g-fg-faint: rgba(24, 24, 27, 0.4);
  --g-surface: rgba(255, 255, 255, 0.7);
  --g-surface-strong: rgba(255, 255, 255, 0.88);
  --g-surface-hover: rgba(255, 255, 255, 0.8);
  --g-border: rgba(0, 0, 0, 0.08);
  --g-border-strong: rgba(0, 0, 0, 0.16);
  --g-shadow-sm: 0 4px 14px rgba(0, 0, 0, 0.08);
  --g-shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
  --g-shadow-lg: 0 24px 60px rgba(0, 0, 0, 0.16);
  --g-gradient-bg:
    radial-gradient(ellipse 80% 60% at 50% 0%, rgba(99, 102, 241, 0.05), transparent 60%),
    linear-gradient(180deg, #f4f4f5, #e4e4e7);
  --g-gradient-surface:
    linear-gradient(135deg, rgba(255, 255, 255, 0.8) 0%, rgba(255, 255, 255, 0.5) 50%, rgba(255, 255, 255, 0.7) 100%);

  /* Light-mode metric palette: same hues, darker for contrast on white. */
  --g-metric-cpu: #16a34a;
  --g-metric-gpu: #0891b2;
  --g-metric-ram: #d97706;
  --g-metric-net: #2563eb;
  --g-metric-disk: #a21caf;
  --g-state-success: #16a34a;
  --g-state-success-soft: color-mix(in oklab, #16a34a 14%, transparent);
  --g-state-warn: #d97706;
  --g-state-warn-soft: color-mix(in oklab, #d97706 14%, transparent);
  --g-state-danger: #dc2626;
  --g-state-danger-soft: color-mix(in oklab, #dc2626 14%, transparent);
  --g-state-info: #0891b2;
  --g-state-info-soft: color-mix(in oklab, #0891b2 12%, transparent);
}

:root[data-theme="hud"] {
  /* Default HUD palette is black + gold; every accent value derives from
     --g-primary / --g-accent via color-mix so that the appearance picker's
     primary/accent color choices drive every shade in the theme. */
  --g-bg: #060406;
  --g-bg-deep: #000000;
  --g-primary: #fbbf24;
  --g-primary-soft: color-mix(in srgb, var(--g-primary) 8%, transparent);
  --g-primary-muted: color-mix(in srgb, var(--g-primary) 18%, transparent);
  --g-primary-strong: color-mix(in srgb, var(--g-primary) 35%, transparent);
  --g-accent: #f59e0b;
  --g-accent-soft: color-mix(in srgb, var(--g-accent) 8%, transparent);
  --g-accent-muted: color-mix(in srgb, var(--g-accent) 18%, transparent);
  --g-accent-strong: color-mix(in srgb, var(--g-accent) 35%, transparent);
  --g-surface: rgba(255, 255, 255, 0.045);
  --g-surface-strong: rgba(255, 255, 255, 0.09);
  --g-surface-hover: rgba(255, 255, 255, 0.075);
  --g-border: color-mix(in srgb, var(--g-primary) 18%, rgba(255, 255, 255, 0.08));
  --g-border-strong: color-mix(in srgb, var(--g-primary) 40%, transparent);
  /* Heavier blurs for the "clear depth" reading — backdrop saturates to
     180/220% so colors behind the panel stay vivid through the frost. */
  --g-blur: blur(28px) saturate(190%);
  --g-blur-heavy: blur(42px) saturate(220%);
  --g-radius: 16px;
  --g-radius-sm: 10px;
  --g-radius-lg: 22px;
  --g-shadow-sm: 0 6px 20px rgba(0, 0, 0, 0.45);
  --g-shadow: 0 18px 60px rgba(0, 0, 0, 0.7);
  --g-shadow-lg: 0 36px 110px rgba(0, 0, 0, 0.85);
  --g-gradient-bg:
    radial-gradient(ellipse 70% 50% at 50% 0%, color-mix(in srgb, var(--g-primary) 14%, transparent), transparent 60%),
    radial-gradient(ellipse 60% 40% at 100% 100%, color-mix(in srgb, var(--g-accent) 10%, transparent), transparent 60%),
    linear-gradient(180deg, var(--g-bg), var(--g-bg-deep));
  --g-gradient-surface:
    linear-gradient(155deg,
      rgba(255, 255, 255, 0.10) 0%,
      rgba(255, 255, 255, 0.025) 45%,
      rgba(0, 0, 0, 0.10) 100%);
  /* HUD-only depth tokens — used by the new clear-depth/edge/elevation
     primitives below. Other themes get sane fallbacks. */
  --g-edge-light: rgba(255, 255, 255, 0.18);
  --g-edge-shadow: rgba(0, 0, 0, 0.55);
  --g-glow-primary: 0 0 24px color-mix(in srgb, var(--g-primary) 18%, transparent);
  --g-glow-accent: 0 0 24px color-mix(in srgb, var(--g-accent) 16%, transparent);

  /* ── Knowledge-graph palette ───────────────────────────────────────
     Consumed by <infinibot-knowledge-graph>. The canvas renderer resolves
     these once via getComputedStyle, so they stay theme-driven. Per-kind
     node colors mirror the futuristic accent set the Quickstart restyle
     shipped (gold-forward, violet+cyan atmospherics). */
  --graph-bg: #06040c;
  --graph-edge: rgba(212, 175, 55, 0.34);
  --graph-edge-active: var(--g-accent, #f59e0b);
  --graph-node-project: #ffd278;
  --graph-node-task: #34d399;
  --graph-node-note: #60a5fa;
  --graph-node-agent: #f472b6;
  --graph-node-session: #fb923c;
  --graph-node-database: #a78bfa;
  --graph-node-row: #c084fc;
  --graph-node-skill: #2dd4bf;
  --graph-node-node: #f87171;
  --graph-node-user: #fbbf24;
}

html {
  font-family: var(--g-font-family);
  background: var(--g-bg);
  background-image: var(--g-gradient-bg);
  color: var(--g-fg);
  min-height: 100vh;
}
body {
  /* Transparent so html's gradient + .hud-aurora (z-index:-2) show. */
  background: transparent;
  color: var(--g-fg);
  min-height: 100vh;
  font-family: var(--g-font-family);
}

/* ── Utility classes ───────────────────────────────────────────── */

.glass {
  /* Stack the configurable glass tint above the user-set surface so the user
     can layer a coloured wash on top of the (cool/neutral) surface tint. */
  background: linear-gradient(var(--g-glass-tint, transparent), var(--g-glass-tint, transparent)), var(--g-surface);
  border: 1px solid var(--g-glass-border, var(--g-border));
  border-radius: var(--g-radius);
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
}

.glass-panel {
  position: relative;
  background:
    linear-gradient(var(--g-glass-tint, transparent), var(--g-glass-tint, transparent)),
    var(--g-gradient-surface);
  border: 1px solid var(--g-glass-border, var(--g-border));
  border-radius: var(--g-radius-lg);
  backdrop-filter: var(--g-blur-heavy);
  -webkit-backdrop-filter: var(--g-blur-heavy);
  /* Layered shadow stack: soft far-shadow, mid-distance contact shadow,
     top-edge specular highlight, and bottom-edge recess. Reads as a
     plate of glass floating above the page rather than a flat card. */
  box-shadow:
    0 1px 4px rgba(0, 0, 0, 0.18),
    var(--g-shadow),
    0 24px 64px rgba(0, 0, 0, 0.28),
    inset 0 1px 0 var(--g-edge-light, rgba(255, 255, 255, 0.10)),
    inset 0 -1px 0 var(--g-edge-shadow, rgba(0, 0, 0, 0.35)),
    inset 0 0 0 1px rgba(255, 255, 255, 0.02);
  padding: 18px 20px;
  isolation: isolate;
}

.glass-panel::before {
  /* Top glare arc — 30% wide ellipse just outside the top edge,
     blended in screen mode so it reads like real reflected light. */
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background:
    radial-gradient(ellipse 55% 35% at 50% -10%,
      var(--g-edge-light, rgba(255, 255, 255, 0.10)),
      transparent 60%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.04), transparent 50%);
  mix-blend-mode: screen;
}

.glass-floating {
  position: relative;
  background: var(--g-gradient-surface);
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-lg);
  backdrop-filter: var(--g-blur-heavy);
  -webkit-backdrop-filter: var(--g-blur-heavy);
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.22),
    var(--g-shadow-lg),
    0 36px 96px rgba(0, 0, 0, 0.45),
    inset 0 1px 0 var(--g-edge-light, rgba(255, 255, 255, 0.12)),
    inset 0 -1px 0 var(--g-edge-shadow, rgba(0, 0, 0, 0.4)),
    inset 0 0 0 1px rgba(255, 255, 255, 0.03),
    0 0 0 1px var(--g-primary-soft),
    var(--g-glow-primary, 0 0 32px color-mix(in srgb, var(--g-primary) 14%, transparent));
  isolation: isolate;
}

.glass-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--g-primary-soft);
  border: 1px solid var(--g-primary-muted);
  color: var(--g-primary);
  font-size: 11px;
  letter-spacing: 0.02em;
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
}

.glass-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--g-fg);
  background: var(--g-surface);
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-sm);
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, transform 0.12s ease, box-shadow 0.18s ease;
}
.glass-button:hover {
  background: var(--g-surface-hover);
  border-color: var(--g-primary-muted);
}
.glass-button:active { transform: translateY(1px); }
.glass-button--primary {
  background: var(--g-gradient-accent);
  color: #0a0a0e;
  border-color: transparent;
  box-shadow: 0 6px 18px var(--g-primary-muted);
}
.glass-button--primary:hover {
  box-shadow: 0 10px 28px var(--g-primary-strong);
}

.depth-1 { box-shadow: var(--g-shadow-sm); }
.depth-2 { box-shadow: var(--g-shadow); }
.depth-3 { box-shadow: var(--g-shadow-lg); }

.gradient-ink { background: var(--g-gradient-ink); }
.gradient-accent { background: var(--g-gradient-accent); }
.gradient-bg { background: var(--g-gradient-bg); }

.accent-glow {
  box-shadow:
    0 0 0 1px var(--g-primary-muted),
    0 10px 40px var(--g-primary-soft);
}

/* Smooth transitions when theme tokens change at runtime. */
:root {
  transition: background 0.4s ease, color 0.3s ease;
}
.glass, .glass-panel, .glass-floating, .glass-chip, .glass-button {
  transition: background 0.25s ease, border-color 0.25s ease, box-shadow 0.3s ease;
}

/* ── Ambient aurora background ─────────────────────────────────
   Fixed-positioned layer behind the whole app. Radial plumes in
   primary + accent shift slowly; per-mode opacity so it's loud in
   hud mode, subtle in dark, near-invisible in light. */
.hud-aurora {
  position: fixed;
  inset: -30%;
  z-index: -2;
  pointer-events: none;
  background:
    radial-gradient(ellipse 60% 50% at 25% 20%, var(--g-primary-muted), transparent 55%),
    radial-gradient(ellipse 50% 50% at 80% 75%, var(--g-accent-muted), transparent 55%),
    radial-gradient(ellipse 70% 50% at 50% 100%, var(--g-primary-soft), transparent 60%);
  filter: blur(40px) saturate(140%);
  opacity: 0.55;
  animation: hud-aurora-drift 36s ease-in-out infinite alternate;
  will-change: transform, opacity;
}

/* User-controllable tint + blur layer that sits above the animated bg
   layer (z-index: -3) but below app content. Drives off three CSS vars
   that the appearance picker writes via applyThemeOverrides. */
.infinibot-bg-overlay {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-color: var(--g-overlay-color, transparent);
  opacity: var(--g-overlay-opacity, 0);
  backdrop-filter: blur(var(--g-overlay-blur, 0px));
  -webkit-backdrop-filter: blur(var(--g-overlay-blur, 0px));
  transition: background-color 0.3s ease, opacity 0.3s ease, backdrop-filter 0.3s ease;
}
.hud-aurora::after {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 40% 35% at 70% 30%, var(--g-accent-soft), transparent 60%),
    radial-gradient(ellipse 40% 35% at 30% 70%, var(--g-primary-soft), transparent 60%);
  filter: blur(60px);
  animation: hud-aurora-drift 52s ease-in-out infinite alternate-reverse;
  opacity: 0.8;
}
@keyframes hud-aurora-drift {
  0%   { transform: translate3d(0, 0, 0) rotate(0deg); }
  25%  { transform: translate3d(-4%, 3%, 0) rotate(60deg); }
  50%  { transform: translate3d(2%, -4%, 0) rotate(140deg); }
  75%  { transform: translate3d(4%, 2%, 0) rotate(220deg); }
  100% { transform: translate3d(-2%, -3%, 0) rotate(300deg); }
}

:root[data-theme="hud"] .hud-aurora { opacity: 0.85; }
:root[data-theme="dark"] .hud-aurora { opacity: 0.45; }
:root[data-theme="light"] .hud-aurora { opacity: 0.35; filter: blur(60px) saturate(110%); }

/* When ANY animated effect is active, hide the .hud-aurora layer + the
   html static gradient so the WebGL canvas is the sole visible background.
   Without this, the aurora at z-index -2 and the html gradient leak through
   the animated layer at z-index -3. */
:root[data-background]:not([data-background="gradient"]):not([data-background="none"]) .hud-aurora { display: none; }
:root[data-background]:not([data-background="gradient"]):not([data-background="none"]) {
  background: transparent;
  background-image: none;
}
:root[data-background="none"] .hud-aurora { display: none; }
:root[data-background="none"] .hud-top-glow { display: none; }

/* The hardcoded <terminal-background> in index.html is the page-load default
   (gold faulty-terminal). Once the user picks any background via the
   appearance picker the data-background attribute is set on html, at which
   point hide the static element so the picker's effect (mounted at z-index
   -3) is the only visible animated layer. The picker still owns its own
   faulty-terminal option which mounts via createFaultyTerminal. */
:root[data-background] terminal-background { display: none !important; }

/* Optional shimmer band across the very top of the shell. */
.hud-top-glow {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 2px;
  z-index: 50;
  pointer-events: none;
  background: linear-gradient(90deg,
    transparent 0%,
    var(--g-primary) 25%,
    var(--g-accent) 50%,
    var(--g-primary) 75%,
    transparent 100%);
  background-size: 200% 100%;
  animation: hud-top-glow-slide 8s linear infinite;
  opacity: 0.5;
}
@keyframes hud-top-glow-slide {
  from { background-position: 0% 50%; }
  to   { background-position: 200% 50%; }
}
:root[data-theme="hud"] .hud-top-glow { opacity: 0.9; }

/* ── Floating glass primitives (rounded plate) ──────────────── */

.glass-plate {
  position: relative;
  background: var(--g-gradient-surface);
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-lg);
  backdrop-filter: var(--g-blur-heavy);
  -webkit-backdrop-filter: var(--g-blur-heavy);
  box-shadow:
    var(--g-shadow),
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 0 0 1px rgba(255, 255, 255, 0.02);
  overflow: hidden;
}
.glass-plate::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 50% 30% at 50% 0%, rgba(255, 255, 255, 0.06), transparent 60%);
}

/* ── Clear-depth glass (Vision-Pro / refractive look) ──────────
   Layered effect: backdrop blur frosts what's behind, a top inner
   highlight reads as "light from above", a bottom inner shadow
   suggests recess, and a soft outer halo + drop shadow plant the
   panel above the background. Use this for primary surfaces. */
.glass-deep {
  position: relative;
  background:
    linear-gradient(155deg,
      color-mix(in srgb, var(--g-primary) 4%, rgba(255,255,255,0.08)) 0%,
      rgba(255, 255, 255, 0.02) 55%,
      color-mix(in srgb, var(--g-accent) 5%, rgba(0,0,0,0.05)) 100%);
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-lg);
  backdrop-filter: var(--g-blur-heavy);
  -webkit-backdrop-filter: var(--g-blur-heavy);
  box-shadow:
    /* Outer drop — depth above the background */
    var(--g-shadow-lg),
    /* Top edge specular highlight — light direction */
    inset 0 1px 0 var(--g-edge-light, rgba(255,255,255,0.16)),
    /* Soft inner glow from the top quarter */
    inset 0 18px 36px -22px var(--g-edge-light, rgba(255,255,255,0.22)),
    /* Bottom inner recess */
    inset 0 -1px 0 var(--g-edge-shadow, rgba(0,0,0,0.45)),
    /* Outline from primary tint — premium accent ring */
    0 0 0 1px var(--g-primary-soft);
  overflow: hidden;
  isolation: isolate;
}
.glass-deep::before {
  /* Top glare arc — radial highlight that tracks light angle. */
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 60% 40% at 50% -10%,
      var(--g-edge-light, rgba(255,255,255,0.18)),
      transparent 55%);
  border-radius: inherit;
  mix-blend-mode: screen;
  opacity: 0.85;
}
.glass-deep::after {
  /* Bottom-right primary tint bloom — adds chromatic depth. */
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 40% 30% at 100% 100%,
      var(--g-primary-soft),
      transparent 60%);
  border-radius: inherit;
  mix-blend-mode: screen;
  opacity: 0.6;
}

/* ── Elevated floating card — dramatic altitude above the bg ── */
.glass-elevated {
  position: relative;
  background:
    linear-gradient(160deg,
      rgba(255,255,255,0.10) 0%,
      rgba(255,255,255,0.025) 60%,
      rgba(0,0,0,0.06) 100%);
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-lg);
  backdrop-filter: var(--g-blur-heavy);
  -webkit-backdrop-filter: var(--g-blur-heavy);
  box-shadow:
    /* Stacked drop shadows — soft + sharp = "floating above the page" */
    0 2px 6px rgba(0,0,0,0.25),
    0 12px 32px rgba(0,0,0,0.35),
    0 32px 80px rgba(0,0,0,0.55),
    inset 0 1px 0 var(--g-edge-light, rgba(255,255,255,0.14)),
    inset 0 -1px 0 var(--g-edge-shadow, rgba(0,0,0,0.45)),
    var(--g-glow-primary, 0 0 24px color-mix(in srgb, var(--g-primary) 18%, transparent));
  isolation: isolate;
  overflow: hidden;
}
.glass-elevated::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(135deg,
      var(--g-edge-light, rgba(255,255,255,0.06)) 0%,
      transparent 35%);
  border-radius: inherit;
}

/* Hover lift — gentle altitude bump for interactive panels. */
.lift-on-hover {
  transition:
    transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1),
    box-shadow 0.3s ease,
    border-color 0.25s ease;
}
.lift-on-hover:hover {
  transform: translateY(-2px);
  box-shadow:
    0 4px 10px rgba(0,0,0,0.3),
    0 18px 40px rgba(0,0,0,0.45),
    0 36px 96px rgba(0,0,0,0.6),
    inset 0 1px 0 var(--g-edge-light, rgba(255,255,255,0.18)),
    inset 0 -1px 0 var(--g-edge-shadow, rgba(0,0,0,0.45)),
    0 0 28px color-mix(in srgb, var(--g-primary) 24%, transparent);
  border-color: var(--g-primary-muted);
}

/* ── HUD frame — corner brackets + scan line, premium accent ── */
.hud-frame {
  position: relative;
}
.hud-frame::before,
.hud-frame::after {
  content: "";
  position: absolute;
  width: 14px;
  height: 14px;
  border-color: var(--g-primary);
  pointer-events: none;
  opacity: 0.7;
}
.hud-frame::before {
  top: 6px; left: 6px;
  border-top: 1px solid;
  border-left: 1px solid;
}
.hud-frame::after {
  bottom: 6px; right: 6px;
  border-bottom: 1px solid;
  border-right: 1px solid;
}

/* Edge halo — subtle outer glow ring that matches primary. */
.glass-edge {
  box-shadow:
    inset 0 1px 0 var(--g-edge-light, rgba(255,255,255,0.14)),
    inset 0 -1px 0 var(--g-edge-shadow, rgba(0,0,0,0.45)),
    0 0 0 1px var(--g-primary-muted),
    var(--g-glow-primary, 0 0 22px color-mix(in srgb, var(--g-primary) 16%, transparent));
}

/* ── Film-grain noise overlay ──────────────────────────────────
   Adds a faint analogue-photo texture so panels don't look like
   flat plastic. SVG-based so it's themeable + doesn't ship a PNG. */
.glass-noise {
  position: relative;
  isolation: isolate;
}
.glass-noise::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  background-image: url("data:image/svg+xml;utf8,\
<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>\
<filter id='n'>\
<feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/>\
<feColorMatrix values='0 0 0 0 1   0 0 0 0 1   0 0 0 0 1   0 0 0 0.4 0'/>\
</filter>\
<rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/>\
</svg>");
  opacity: 0.05;
  mix-blend-mode: overlay;
}
:root[data-theme="hud"] .glass-noise::before {
  opacity: 0.07;
}

/* ── Animated gradient border — alive without being noisy ── */
.glass-alive-border {
  position: relative;
  isolation: isolate;
}
.glass-alive-border::before {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(135deg,
    var(--g-primary-muted) 0%,
    transparent 35%,
    transparent 65%,
    var(--g-accent-muted) 100%);
  background-size: 200% 200%;
  animation: glass-alive-pan 14s ease-in-out infinite alternate;
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  z-index: -1;
  pointer-events: none;
  opacity: 0.7;
}
@keyframes glass-alive-pan {
  0%   { background-position: 0% 0%; }
  100% { background-position: 100% 100%; }
}

/* Section header with thin accent underline — for panel titles. */
.hud-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--g-primary);
}
.hud-title::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--g-primary);
  box-shadow: 0 0 10px var(--g-primary);
}
.hud-title--underline {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--g-primary-muted);
  width: 100%;
}

/* Conic spinning border — subtle premium accent on focused surfaces. */
.glass-spin-border {
  position: relative;
  isolation: isolate;
}
.glass-spin-border::after {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  background: conic-gradient(
    from 180deg,
    transparent 0deg,
    var(--g-primary) 60deg,
    var(--g-accent) 180deg,
    transparent 300deg
  );
  z-index: -1;
  animation: glass-spin-rotate 4s linear infinite;
  opacity: 0.35;
}
@keyframes glass-spin-rotate {
  to { transform: rotate(360deg); }
}

/* Shimmer sheen — diagonal light sweeping across the element. */
.shimmer-sheen {
  position: relative;
  overflow: hidden;
}
.shimmer-sheen::after {
  content: "";
  position: absolute;
  top: 0; left: -30%;
  width: 40%;
  height: 100%;
  background: linear-gradient(
    100deg,
    transparent 0%,
    rgba(255, 255, 255, 0.12) 50%,
    transparent 100%
  );
  animation: shimmer-sweep 4s linear infinite;
  pointer-events: none;
}
@keyframes shimmer-sweep {
  0%   { left: -30%; }
  100% { left: 110%; }
}

/* ── Floating rounded shell (applied by layout.css when active) ── */
.shell--floating > aside,
.shell--floating > main {
  border-radius: var(--g-radius-lg);
  backdrop-filter: var(--g-blur-heavy);
  -webkit-backdrop-filter: var(--g-blur-heavy);
}

@media (prefers-reduced-motion: reduce) {
  .hud-aurora,
  .hud-aurora::after,
  .hud-top-glow,
  .glass-spin-border::after,
  .shimmer-sheen::after {
    animation: none !important;
  }
}

/* ══════════════════════════════════════════════════════════════════
   InfiniBot Noir — premium reflective gold animation suite.

   Scoped strictly under :root[data-theme-mode="dark"], which is
   set by applyBrandingToDom() from the active paletteId. We key off
   data-palette (NOT data-theme) on purpose: data-theme carries the
   light/dark/hud *mode* and would not survive a user switching modes
   while keeping the noir palette. data-palette is the single attribute
   that follows the palette pick, so the animations track the theme
   exactly as the operator expects.

   Performance contract (why this is CSS-only, no JS RAF loop):
     • Every keyframe animates ONLY transform / opacity / background-position
       — all GPU-compositor properties, so the main thread stays free and
       there is zero layout/paint per frame on the large surfaces.
     • No box-shadow / width / height / top / left animation anywhere.
     • will-change is reserved for the few elements that genuinely benefit
       (the breathing logo + sweeping pseudo-elements), never blanket-applied.
     • prefers-reduced-motion freezes every animation (see the guard block
       at the very end of this section).
   ══════════════════════════════════════════════════════════════════ */
:root[data-theme-mode="dark"] {
  /* Supplementary gold tokens consumed by the animations below + any view
     that wants the brand gold without re-deriving it from --g-primary. */
  --infinibot-gold: #d4af37;
  --infinibot-gold-soft: #f6c873;
  --infinibot-gold-dim: rgba(212, 175, 55, 0.32);
  --infinibot-gold-bright: #fff3c0; /* shimmer highlight */
  --infinibot-noir-deep: #050505;
}

/* (1) Shimmer sweep — diagonal gold gradient slides across primary CTAs
       every 6s. Pseudo-element only; mix-blend overlay so it reads as a
       reflection rather than a wash. Opacity 0 → 0.55 → 0. */
:root[data-theme-mode="dark"] .btn-primary,
:root[data-theme-mode="dark"] [data-cta="primary"] {
  position: relative;
  overflow: hidden;
  isolation: isolate;
}
:root[data-theme-mode="dark"] .btn-primary::after,
:root[data-theme-mode="dark"] [data-cta="primary"]::after {
  content: "";
  position: absolute;
  inset: -50% -20%;
  pointer-events: none;
  background: linear-gradient(
    115deg,
    transparent 30%,
    var(--infinibot-gold-soft, #f6c873) 47%,
    var(--infinibot-gold-bright, #fff3c0) 50%,
    var(--infinibot-gold-soft, #f6c873) 53%,
    transparent 70%
  );
  mix-blend-mode: overlay;
  opacity: 0;
  transform: translateX(-120%);
  animation: noir-shimmer-sweep 6s ease-in-out infinite;
}
@keyframes noir-shimmer-sweep {
  0%   { transform: translateX(-120%); opacity: 0; }
  45%  { opacity: 0; }
  55%  { opacity: 0.55; }
  80%  { opacity: 0; }
  100% { transform: translateX(120%); opacity: 0; }
}

/* (2) Flow shimmer — slow text-clip gold gradient cycling over 12s on the
       brand mark / title and any opt-in [data-shimmer] text. Subtle: a
       tight gold→bright→gold band drifting through the fill. */
:root[data-theme-mode="dark"] .brand-mark,
:root[data-theme-mode="dark"] .brand-title,
:root[data-theme-mode="dark"] [data-shimmer] {
  background-image: linear-gradient(
    100deg,
    var(--infinibot-gold, #d4af37) 0%,
    var(--infinibot-gold, #d4af37) 38%,
    var(--infinibot-gold-bright, #fff3c0) 50%,
    var(--infinibot-gold, #d4af37) 62%,
    var(--infinibot-gold, #d4af37) 100%
  );
  background-size: 220% 100%;
  background-position: 0% 50%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: noir-flow-shimmer 12s linear infinite;
}
@keyframes noir-flow-shimmer {
  from { background-position: 120% 50%; }
  to   { background-position: -120% 50%; }
}

/* (3) Glass card edge — thin animated conic gold outline via mask compositing
       (no box-shadow animation → no per-frame paint of a blurred shadow).
       18s loop. */
:root[data-theme-mode="dark"] .glass-card[data-theme-edge="gold"] {
  position: relative;
  isolation: isolate;
}
:root[data-theme-mode="dark"] .glass-card[data-theme-edge="gold"]::before {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  padding: 1px;
  pointer-events: none;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    var(--infinibot-gold-dim, rgba(212,175,55,0.32)) 40deg,
    var(--infinibot-gold-bright, #fff3c0) 90deg,
    var(--infinibot-gold-dim, rgba(212,175,55,0.32)) 140deg,
    transparent 200deg,
    transparent 360deg
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: noir-edge-rotate 18s linear infinite;
}
@keyframes noir-edge-rotate {
  to { transform: rotate(360deg); }
}

/* (4) Idle breathing — gentle scale on the app logo + brand-mark image.
       Pure transform, GPU. will-change reserved here because the element is
       small and continuously animating. */
:root[data-theme-mode="dark"] .app-logo,
:root[data-theme-mode="dark"] .brand-mark img {
  will-change: transform;
  animation: noir-logo-breathe 8s ease-in-out infinite;
}
@keyframes noir-logo-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.02); }
}

/* (5) Aurora is INERT for noir — fade the ambient aurora plume to ~25% so the
       noir grid background reads cleanly. We re-show it over ambient-grid
       (the standard rule hides .hud-aurora for any animated background) but
       hold it at 0.25 opacity. Never removed, just quieted. */
:root[data-theme-mode="dark"] .hud-aurora { opacity: 0.25; }
:root[data-theme-mode="dark"][data-background="ambient-grid"] .hud-aurora {
  display: block;
  opacity: 0.25;
}

/* Reduced-motion: freeze every noir animation. Sweeps/edges settle invisible
   or at their start position; the flow-shimmer text stays fully legible by
   restoring an opaque gold fill. */
@media (prefers-reduced-motion: reduce) {
  :root[data-theme-mode="dark"] .btn-primary::after,
  :root[data-theme-mode="dark"] [data-cta="primary"]::after {
    animation: none !important;
    opacity: 0 !important;
  }
  :root[data-theme-mode="dark"] .brand-mark,
  :root[data-theme-mode="dark"] .brand-title,
  :root[data-theme-mode="dark"] [data-shimmer] {
    animation: none !important;
    -webkit-text-fill-color: var(--infinibot-gold, #d4af37);
    color: var(--infinibot-gold, #d4af37);
  }
  :root[data-theme-mode="dark"] .glass-card[data-theme-edge="gold"]::before,
  :root[data-theme-mode="dark"] .app-logo,
  :root[data-theme-mode="dark"] .brand-mark img {
    animation: none !important;
  }
}
`;
