/**
 * Theme registry. New themes drop in by importing here and adding to REGISTRY.
 * `getTheme(name)` always returns a valid theme — unknown names fall back to
 * the black-gold default so a stale/typo theme never breaks a render.
 */

import type { Theme, ThemeTokens } from "../types.js";
import { blackGold } from "./black-gold.js";
import { goldLetterhead } from "./gold-letterhead.js";

const REGISTRY: Record<string, Theme> = {
  [blackGold.name]: blackGold,
  [goldLetterhead.name]: goldLetterhead,
};

export const DEFAULT_THEME = blackGold.name;

export function getTheme(name?: string | null): Theme {
  if (name && REGISTRY[name]) return REGISTRY[name];
  return blackGold;
}

export function listThemes(): Array<{ name: string; label: string }> {
  return Object.values(REGISTRY).map((t) => ({ name: t.name, label: t.label }));
}

/** Render theme tokens into a `:root { --token: value }` CSS block. */
export function themeToCssVars(tokens: ThemeTokens): string {
  const lines: string[] = [
    `--bg: ${tokens.bg}`,
    `--surface: ${tokens.surface}`,
    `--surface-alt: ${tokens.surfaceAlt}`,
    `--border: ${tokens.border}`,
    `--text: ${tokens.text}`,
    `--text-muted: ${tokens.textMuted}`,
    `--accent: ${tokens.accent}`,
    `--accent-strong: ${tokens.accentStrong}`,
    `--font-heading: ${tokens.fontHeading}`,
    `--font-body: ${tokens.fontBody}`,
  ];
  return `:root {\n  ${lines.join(";\n  ")};\n}`;
}

/** CSS for a status pill class given a status label (falls back to neutral). */
export function statusPillCss(tokens: ThemeTokens): string {
  return Object.entries(tokens.statusPills)
    .map(([status, c]) => `.pill-${status} { color: ${c.fg}; background: ${c.bg}; }`)
    .join("\n");
}

export { blackGold, goldLetterhead };
