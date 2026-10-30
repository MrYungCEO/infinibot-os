/**
 * Cosmetics apply API for the Agency World map.
 *
 * `applyTheme(id)` writes `data-world-theme="<id>"` onto `<html>` and persists
 * the choice; the generated stylesheet (`:root[data-world-theme=...]`) cascades
 * the theme's `--world-*` tokens to every world layer. Browser-only but
 * import-safe: all DOM access is guarded.
 *
 * Mount once at app boot:  initCosmetics();
 * Then anywhere:           applyTheme("midnight");
 */

import { COSMETIC_THEMES, DEFAULT_THEME_ID, getTheme, type CosmeticTheme } from "./themes.js";

export { COSMETIC_THEMES, DEFAULT_THEME_ID, getTheme, type CosmeticTheme } from "./themes.js";

const STORAGE_KEY = "infinibot-world-theme";
const STYLE_ID = "infinibot-cosmetics";
const THEME_ATTR = "data-world-theme";

/** Build the full `:root[data-world-theme=...]` stylesheet from the registry. */
export function buildThemeStylesheet(): string {
  const blocks = COSMETIC_THEMES.map((theme) => {
    const decls = Object.entries(theme.tokens)
      .map(([k, v]) => `  --world-${k}: ${v};`)
      .join("\n");
    // The default theme also answers the bare `:root` selector so the world
    // looks right before any attribute is set.
    const selector =
      theme.id === DEFAULT_THEME_ID
        ? `:root, :root[${THEME_ATTR}="${theme.id}"]`
        : `:root[${THEME_ATTR}="${theme.id}"]`;
    return `${selector} {\n${decls}\n}`;
  });
  return blocks.join("\n\n");
}

/** Inject (idempotently) the generated stylesheet into <head>. */
export function injectThemeStyles(): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const css = buildThemeStylesheet();
  if (el.textContent !== css) el.textContent = css;
}

/** The currently-active theme id (html attr → storage → default). */
export function getActiveThemeId(): string {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute(THEME_ATTR);
    if (attr && getTheme(attr)) return attr;
  }
  if (typeof localStorage !== "undefined") {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && getTheme(stored)) return stored;
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_THEME_ID;
}

export function getActiveTheme(): CosmeticTheme {
  return getTheme(getActiveThemeId()) ?? COSMETIC_THEMES[0];
}

export function listThemes(): CosmeticTheme[] {
  return COSMETIC_THEMES;
}

/**
 * Apply a theme: ensure styles are injected, set the html attribute, persist,
 * and broadcast `infinibot:world-theme-change`. Returns the resolved theme.
 */
export function applyTheme(id: string): CosmeticTheme {
  const theme = getTheme(id) ?? COSMETIC_THEMES[0];
  injectThemeStyles();
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute(THEME_ATTR, theme.id);
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, theme.id);
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("infinibot:world-theme-change", { detail: { id: theme.id } }),
    );
  }
  return theme;
}

/** Inject styles + apply the persisted (or default) theme. Call once at boot. */
export function initCosmetics(): CosmeticTheme {
  injectThemeStyles();
  return applyTheme(getActiveThemeId());
}
