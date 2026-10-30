/**
 * Coder backend brand kit.
 *
 * Single source of truth for how the activity feed, the topbar pill, and any
 * other UI surface shows which CLI a coder run came from. Importers get a
 * consistent label, accent colour, and inline-SVG logo per backend.
 *
 * Importers:
 *   - ui/src/ui/views/agent-activity.ts (badges + type-strip counters)
 *   - ui/src/ui/components/coder-backend-pill.ts (topbar pill)
 *
 * The colour values stay hex (not CSS tokens) so coder runs stay visually
 * distinct inside the gold HUD instead of dissolving into the brand-primary
 * palette like native sessions. Glyphs are neutral InfiniBot monograms, never
 * third-party logos.
 */

import { html } from "lit";
import type { TemplateResult } from "lit";

export type CoderBackendId = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

/**
 * Wider id used when surfacing CLI provenance on UI cards.
 *
 * The server-side spawn registry only tracks "claude-code" | "opencode" |
 * "codex" (see SubagentRunRecord.coderBackend in
 * src/agents/subagent-registry.ts), but `gemini` shows up in the UI/PTY
 * vocabulary (see coder-backend-id.ts). The icon helper accepts the wider
 * set so subagent cards built from non-registry sources (PTY shells,
 * future Gemini backend) still render the right glyph.
 */
export type CoderBackendIconId = CoderBackendId | "gemini";

export interface CoderBackendBrand {
  id: CoderBackendId;
  /** Long-form human label, e.g. "Claude Code". */
  label: string;
  /** Compact uppercase label for badges, e.g. "CLAUDE". */
  shortLabel: string;
  /** Accent hex colour (no CSS token; keeps backends distinct inside the HUD). */
  accent: string;
  /** Tinted background, derived from accent via color-mix. */
  tone: string;
  /** Inline SVG monogram glyph; inherits currentColor from accent. */
  icon: TemplateResult;
}

// ── Per-backend inline glyphs ──────────────────────────────────────────────
//
// All glyphs are 14×14, currentColor, and self-contained so the parent's
// `color:` drives the tint and we don't have to ship binary assets. Every
// backend gets the same house-style letter monogram in a rounded square
// (C / X / G / OC). These are InfiniBot's own glyphs, not the providers'
// logos: third-party logos need the owner's permission, so the CLI is named
// in plain text (label / tooltip) and the glyph only tells runs apart.
// See docs/licensing/BRAND-USAGE.md.

/** InfiniBot letter monogram in a rounded square. 1–2 letters. */
export function coderMonogramIcon(letters: string, size = 14): TemplateResult {
  const two = letters.length > 1;
  return html`
    <svg
      width="${size}" height="${size}" viewBox="0 0 16 16"
      fill="none" aria-hidden="true"
    >
      <rect x="0.5" y="0.5" width="15" height="15" rx="3.5"
        fill="currentColor" fill-opacity="0.14"
        stroke="currentColor" stroke-width="1"/>
      <text x="8" y="${two ? 11.2 : 11.6}" text-anchor="middle"
        font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif"
        font-size="${two ? 8.4 : 10}" font-weight="800" letter-spacing="-0.3"
        fill="currentColor">${letters}</text>
    </svg>
  `;
}

const claudeIcon = coderMonogramIcon("C");
const codexIcon = coderMonogramIcon("X");
const geminiIcon = coderMonogramIcon("G");
/** Grok Build (xAI): "GK" so it never collides with Gemini's "G". */
const grokIcon = coderMonogramIcon("GK");
/** OpenCode keeps the house "OC" monogram it has always used. */
const opencodeIcon = coderMonogramIcon("OC");

// ── Brand table ────────────────────────────────────────────────────────────

export const CODER_BACKEND_BRAND: Record<CoderBackendId, CoderBackendBrand> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    shortLabel: "CLAUDE",
    accent: "#d97706", // ember
    tone: "color-mix(in srgb, #d97706 10%, transparent)",
    icon: claudeIcon,
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    shortLabel: "OPENCODE",
    accent: "#10b981", // emerald — distinct from ember
    tone: "color-mix(in srgb, #10b981 10%, transparent)",
    icon: opencodeIcon,
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    shortLabel: "CODEX",
    accent: "#0ea5e9", // sky — distinct from claude + opencode
    tone: "color-mix(in srgb, #0ea5e9 10%, transparent)",
    icon: codexIcon,
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    shortLabel: "GEMINI",
    accent: "#a855f7", // violet — distinct from claude/opencode/codex
    tone: "color-mix(in srgb, #a855f7 10%, transparent)",
    icon: geminiIcon,
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    shortLabel: "GROK",
    accent: "#f43f5e", // rose — distinct from claude/opencode/codex/gemini
    tone: "color-mix(in srgb, #f43f5e 10%, transparent)",
    icon: grokIcon,
  },
};

/** Generic fallback used when a row predates the coderBackend stamp. */
export const CODER_BACKEND_BRAND_UNKNOWN: CoderBackendBrand = {
  id: "claude-code",
  label: "Coder",
  shortLabel: "CODER",
  accent: "#60a5fa",
  tone: "color-mix(in srgb, #60a5fa 10%, transparent)",
  icon: html`
    <svg
      width="14" height="14" viewBox="0 0 16 16"
      fill="none" stroke="currentColor" stroke-width="1.4"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    >
      <polyline points="5.5,4 2,8 5.5,12"/>
      <polyline points="10.5,4 14,8 10.5,12"/>
    </svg>
  `,
};

export function isCoderBackendId(x: unknown): x is CoderBackendId {
  return (
    x === "claude-code" || x === "opencode" || x === "codex" || x === "gemini" || x === "grok"
  );
}

/** Pick the brand for a backend id, falling back to the generic CODER brand. */
export function getCoderBackendBrand(id: unknown): CoderBackendBrand {
  return isCoderBackendId(id) ? CODER_BACKEND_BRAND[id] : CODER_BACKEND_BRAND_UNKNOWN;
}

/**
 * Return ONLY the inline-SVG monogram glyph for a coder backend, or null if the value
 * doesn't match a known backend. Permissive — accepts any string so subagent
 * cards rendered from sources outside the typed registry (gemini PTY, future
 * backends) still resolve. Returns null when no glyph applies so callers can
 * skip rendering instead of breaking the card.
 */
export function getCoderBackendIcon(id: unknown): TemplateResult | null {
  if (id === "claude-code") return claudeIcon;
  if (id === "opencode") return opencodeIcon;
  if (id === "codex") return codexIcon;
  if (id === "gemini") return geminiIcon;
  if (id === "grok" || id === "grok-cli") return grokIcon;
  return null;
}

/** Display label for the icon variants, used for tooltips / aria-label. */
export function getCoderBackendIconLabel(id: unknown): string {
  if (id === "claude-code") return "Claude Code";
  if (id === "opencode") return "OpenCode";
  if (id === "codex") return "Codex CLI";
  if (id === "gemini") return "Gemini CLI";
  if (id === "grok" || id === "grok-cli") return "Grok Build";
  return "";
}

export const ALL_CODER_BACKEND_IDS: CoderBackendId[] = [
  "claude-code",
  "opencode",
  "codex",
  "gemini",
  "grok",
];
