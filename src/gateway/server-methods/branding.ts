/**
 * branding.* — Theme tokens + app branding (name/tagline/logo) persisted in
 * a per-profile `branding.json` file (see users/branding-store.ts).
 * Broadcasts "branding.update" so other clients on the SAME profile can
 * live-update when one operator edits the theme.
 *
 * Per-profile is the point: each profile gets its own theme + branding,
 * matching how data dirs and agent memory already isolate. Legacy
 * `ui.theme` / `ui.branding` in the shared infinibot.json is migrated
 * into the default profile's branding.json on first read.
 */

import { readBranding, writeBranding } from "../../users/branding-store.js";
import type { GatewayRequestHandlers } from "./types.js";

type ThemeMode = "system" | "dark" | "light" | "hud";

interface ThemeTokens {
  primary?: string;
  accent?: string;
  surfaceTint?: string;
  bg?: string;
  fg?: string;
  blur?: number;
  blurHeavy?: number;
  radius?: number;
  surfaceAlpha?: number;
  shadowDepth?: number;
  fontFamily?: string;
  overlayColor?: string;
  overlayOpacity?: number;
  overlayBlur?: number;
  overlayEnabled?: boolean;
  glassEnabled?: boolean;
  glassTint?: string;
  glassTintStrength?: number;
  glassBorderColor?: string;
}

type BackgroundStyle =
  | "none"
  | "gradient"
  | "aurora"
  | "ambient-grid"
  | "faulty-terminal"
  | "grainient"
  | "dither"
  | "iridescence"
  | "liquid-chrome"
  | "lightning"
  | "beams"
  | "silk"
  | "waves"
  | "hyperspeed"
  | "threads"
  | "particles"
  | "metaballs"
  | "orb"
  | "balatro"
  | "letter-glitch"
  | "squares"
  | "dot-grid";

const VALID_BG_STYLES: readonly BackgroundStyle[] = [
  "none",
  "gradient",
  "aurora",
  "ambient-grid",
  "faulty-terminal",
  "grainient",
  "dither",
  "iridescence",
  "liquid-chrome",
  "lightning",
  "beams",
  "silk",
  "waves",
  "hyperspeed",
  "threads",
  "particles",
  "metaballs",
  "orb",
  "balatro",
  "letter-glitch",
  "squares",
  "dot-grid",
];

interface ThemeConfig {
  mode?: ThemeMode;
  paletteId?: string;
  background?: BackgroundStyle;
  tokens?: ThemeTokens;
}

interface BrandingConfig {
  appName?: string;
  tagline?: string;
  logoUrl?: string;
  logoDataUrl?: string;
  faviconUrl?: string;
}

interface BrandingPayload {
  theme: ThemeConfig;
  branding: BrandingConfig;
  /** Static palette list for the UI swatch picker. */
  palettes: Array<{
    id: string;
    name: string;
    mode: "dark" | "light";
    tokens: ThemeTokens;
  }>;
}

const BUILT_IN_PALETTES: BrandingPayload["palettes"] = [
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

const DEFAULT_BRANDING: BrandingConfig = {
  appName: "InfiniBot",
  tagline: "Control Terminal",
};

function sanitizeHex(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  return undefined;
}

function sanitizeNumber(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}

function sanitizeTokens(raw: unknown): ThemeTokens {
  if (!raw || typeof raw !== "object") return {};
  const t = raw as Record<string, unknown>;
  const out: ThemeTokens = {};
  const primary = sanitizeHex(t.primary);
  if (primary) out.primary = primary;
  const accent = sanitizeHex(t.accent);
  if (accent) out.accent = accent;
  const surfaceTint = sanitizeHex(t.surfaceTint);
  if (surfaceTint) out.surfaceTint = surfaceTint;
  const bg = sanitizeHex(t.bg);
  if (bg) out.bg = bg;
  const fg = sanitizeHex(t.fg);
  if (fg) out.fg = fg;
  const blur = sanitizeNumber(t.blur, 0, 80);
  if (blur != null) out.blur = blur;
  const blurHeavy = sanitizeNumber(t.blurHeavy, 0, 120);
  if (blurHeavy != null) out.blurHeavy = blurHeavy;
  const radius = sanitizeNumber(t.radius, 0, 48);
  if (radius != null) out.radius = radius;
  const surfaceAlpha = sanitizeNumber(t.surfaceAlpha, 0, 1);
  if (surfaceAlpha != null) out.surfaceAlpha = surfaceAlpha;
  const shadowDepth = sanitizeNumber(t.shadowDepth, 0, 4);
  if (shadowDepth != null) out.shadowDepth = shadowDepth;
  if (
    typeof t.fontFamily === "string" &&
    t.fontFamily.trim().length > 0 &&
    t.fontFamily.length < 200
  ) {
    out.fontFamily = t.fontFamily.trim();
  }
  // Background overlay layer
  const overlayColor = sanitizeHex(t.overlayColor);
  if (overlayColor) out.overlayColor = overlayColor;
  const overlayOpacity = sanitizeNumber(t.overlayOpacity, 0, 1);
  if (overlayOpacity != null) out.overlayOpacity = overlayOpacity;
  const overlayBlur = sanitizeNumber(t.overlayBlur, 0, 80);
  if (overlayBlur != null) out.overlayBlur = overlayBlur;
  if (typeof t.overlayEnabled === "boolean") out.overlayEnabled = t.overlayEnabled;
  // Glassmorphism
  if (typeof t.glassEnabled === "boolean") out.glassEnabled = t.glassEnabled;
  const glassTint = sanitizeHex(t.glassTint);
  if (glassTint) out.glassTint = glassTint;
  const glassTintStrength = sanitizeNumber(t.glassTintStrength, 0, 1);
  if (glassTintStrength != null) out.glassTintStrength = glassTintStrength;
  const glassBorderColor = sanitizeHex(t.glassBorderColor);
  if (glassBorderColor) out.glassBorderColor = glassBorderColor;
  return out;
}

function sanitizeBranding(raw: unknown): BrandingConfig {
  if (!raw || typeof raw !== "object") return {};
  const b = raw as Record<string, unknown>;
  const out: BrandingConfig = {};
  if (typeof b.appName === "string" && b.appName.trim().length > 0 && b.appName.length < 80) {
    out.appName = b.appName.trim();
  }
  if (typeof b.tagline === "string" && b.tagline.length < 200) {
    out.tagline = b.tagline.trim();
  }
  if (typeof b.logoUrl === "string" && b.logoUrl.length < 2048) {
    out.logoUrl = b.logoUrl.trim();
  }
  if (
    typeof b.logoDataUrl === "string" &&
    b.logoDataUrl.startsWith("data:") &&
    // 4 MB base64 cap
    b.logoDataUrl.length < 4 * 1024 * 1024
  ) {
    out.logoDataUrl = b.logoDataUrl;
  }
  if (typeof b.faviconUrl === "string" && b.faviconUrl.length < 2048) {
    out.faviconUrl = b.faviconUrl.trim();
  }
  return out;
}

function buildPayload(): BrandingPayload {
  const stored = readBranding();
  const theme = (stored.theme ?? {}) as ThemeConfig;
  const branding = { ...DEFAULT_BRANDING, ...stored.branding } as BrandingConfig;
  return {
    theme: {
      // Repo defaults — InfiniBot Gold palette + dark mode + ambient-grid
      // background. Static (non-animated) grid is the premium-feel default;
      // every other background (aurora, grainient, faulty-terminal, etc.)
      // stays available in Settings → Appearance.
      // Keep these in lock-step with DEFAULT_BRANDING in
      // ui/src/ui/controllers/app-branding.ts so the server doesn't hand
      // back a different shape than the UI's cached default on first connect.
      mode: theme.mode ?? "dark",
      paletteId: theme.paletteId ?? "infinibot-gold",
      background: theme.background ?? "ambient-grid",
      tokens: theme.tokens ?? {},
    },
    branding,
    palettes: BUILT_IN_PALETTES,
  };
}

export const brandingHandlers: GatewayRequestHandlers = {
  "branding.get": async ({ respond }) => {
    try {
      respond(true, buildPayload());
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "branding.set": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const current = readBranding();
      const nextStored: { theme?: ThemeConfig; branding?: BrandingConfig } = {
        theme: { ...current.theme } as ThemeConfig,
        branding: { ...current.branding },
      };

      if (p.theme !== undefined) {
        const t = (p.theme && typeof p.theme === "object" ? p.theme : {}) as Record<
          string,
          unknown
        >;
        const nextTheme: ThemeConfig = { ...nextStored.theme };
        if (t.mode === "system" || t.mode === "dark" || t.mode === "light" || t.mode === "hud") {
          nextTheme.mode = t.mode;
        }
        if (typeof t.paletteId === "string" && t.paletteId.length > 0 && t.paletteId.length < 80) {
          nextTheme.paletteId = t.paletteId;
        }
        if (
          typeof t.background === "string" &&
          (VALID_BG_STYLES as readonly string[]).includes(t.background)
        ) {
          nextTheme.background = t.background as BackgroundStyle;
        }
        if (t.tokens !== undefined) {
          // Replace semantics — clients send the full intended token set, so
          // an explicit empty object means "drop all overrides and let the
          // palette + mode defaults show through".
          nextTheme.tokens = t.tokens === null ? {} : sanitizeTokens(t.tokens);
        }
        nextStored.theme = nextTheme;
      }

      if (p.branding !== undefined) {
        nextStored.branding = {
          ...nextStored.branding,
          ...sanitizeBranding(p.branding),
        };
      }

      writeBranding(nextStored);

      const payload = buildPayload();
      try {
        context.broadcast("branding.update", payload);
      } catch {
        /* non-fatal */
      }
      respond(true, payload);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "branding.palettes.list": async ({ respond }) => {
    respond(true, { palettes: BUILT_IN_PALETTES });
  },
};
