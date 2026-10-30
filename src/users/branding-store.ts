/**
 * Per-profile branding store.
 *
 * Theme tokens, palette choice, background style, and app branding are
 * user-facing visual prefs — they should switch with the active profile
 * the same way databases and agent memory do. Persisting them in the
 * SHARED `infinibot.json` (the old behaviour) caused every profile to
 * see the same theme and silently overwrote each other's tweaks.
 *
 * Storage:
 *   <resolveStateDir>/branding.json   ← profile-aware via paths.ts
 *
 * For the default profile that path resolves to ~/.infinibot/branding.json
 * (i.e. shared root, but as a dedicated file — never mixed back into
 * infinibot.json). Other profiles get ~/.infinibot/users/<id>/branding.json.
 *
 * On first read with no file present, we one-shot migrate any legacy
 * `ui.theme` / `ui.branding` from the shared infinibot.json so existing
 * users don't lose their look.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir, getCurrentUserId, DEFAULT_USER_ID } from "../config/paths.js";
import { loadConfig } from "../config/config.js";

const FILENAME = "branding.json";

export interface ThemeTokens {
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

export interface ThemeConfig {
  mode?: "system" | "dark" | "light" | "hud";
  paletteId?: string;
  background?: string;
  tokens?: ThemeTokens;
}

export interface BrandingConfig {
  appName?: string;
  tagline?: string;
  logoUrl?: string;
  logoDataUrl?: string;
  faviconUrl?: string;
}

export interface StoredBranding {
  theme?: ThemeConfig;
  branding?: BrandingConfig;
}

function brandingPath(): string {
  return path.join(resolveStateDir(), FILENAME);
}

/**
 * Read this profile's stored branding. Returns {} when nothing's saved.
 * On first call for a profile with no file, migrate legacy ui.* fields
 * out of the shared infinibot.json so existing installs don't reset.
 */
export function readBranding(): StoredBranding {
  const file = brandingPath();
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object") return parsed as StoredBranding;
    } catch {
      // Corrupt file — fall through to legacy migration / empty.
    }
  }

  // No per-profile file yet. Only the default profile inherits the legacy
  // ui.theme/ui.branding from the shared infinibot.json — new profiles
  // start clean so they don't silently adopt the default profile's theme.
  if (getCurrentUserId() !== DEFAULT_USER_ID) return {};
  try {
    const cfg = loadConfig() as { ui?: { theme?: ThemeConfig; branding?: BrandingConfig } };
    const ui = cfg.ui;
    if (ui && (ui.theme || ui.branding)) {
      const lifted: StoredBranding = {};
      if (ui.theme) lifted.theme = ui.theme;
      if (ui.branding) lifted.branding = ui.branding;
      // Persist immediately so subsequent reads are stable and a later
      // schema scrub of infinibot.json can't lose the user's theme.
      writeBranding(lifted);
      return lifted;
    }
  } catch {
    // Config unreadable — that's the loader's problem, not ours.
  }
  return {};
}

export function writeBranding(value: StoredBranding): void {
  const file = brandingPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}
