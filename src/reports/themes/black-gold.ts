/**
 * Default report theme — black & gold.
 *
 * Deep-black surfaces, warm parchment text, gold accent. JetBrains Mono for
 * headings (monospace gives the "operational console" feel), Inter for body.
 * Status pills are tuned for legibility on the dark surfaces.
 */

import type { Theme } from "../types.js";

export const blackGold: Theme = {
  name: "black-gold",
  label: "Black & Gold",
  tokens: {
    bg: "#0a0a0a",
    surface: "#141414",
    surfaceAlt: "#1c1c1c",
    border: "#2a2620",
    text: "#e8e2d0",
    textMuted: "#9a9488",
    accent: "#d4af37",
    accentStrong: "#b8860b",
    fontHeading: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
    fontBody: "'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif",
    statusPills: {
      ok: { fg: "#0a0a0a", bg: "#d4af37" },
      ready: { fg: "#0a0a0a", bg: "#d4af37" },
      sent: { fg: "#0a0a0a", bg: "#c9a227" },
      complete: { fg: "#0a0a0a", bg: "#c9a227" },
      running: { fg: "#0a0a0a", bg: "#8fb98f" },
      queued: { fg: "#e8e2d0", bg: "#3a3a3a" },
      rendering: { fg: "#e8e2d0", bg: "#4a4536" },
      error: { fg: "#f6e8e8", bg: "#7a2222" },
      failed: { fg: "#f6e8e8", bg: "#7a2222" },
      timeout: { fg: "#f6e8e8", bg: "#7a4a22" },
      interrupted: { fg: "#f6e8e8", bg: "#7a4a22" },
    },
  },
};
