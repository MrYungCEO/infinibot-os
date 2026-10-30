/**
 * `gold-letterhead` — the client-facing sibling of black-gold.
 *
 * Black-gold is InfiniBot's *internal* console language: deep-black surfaces
 * for reports the operator reads on screen. Invoices and proposals go the other
 * way — a client receives them, forwards them to their accountant, and prints
 * them. Two things make a dark sheet the wrong choice there:
 *
 *  1. Chromium gives every printed page its margins via `@page { margin }`, but
 *     nothing paints inside that margin box (a `position: fixed` bleed layer is
 *     clipped to the content box), so a dark multi-page document renders as a
 *     dark slab floating on white paper from page 2 onward.
 *  2. A full-black A4 sheet is a genuinely hostile thing to send a client.
 *
 * So this theme keeps the *brand* — gold accent, JetBrains Mono headings, Inter
 * body, the same token names — and moves it onto warm paper. It is a normal
 * registry entry, not a fork: any report kind can request it, and the invoice
 * and proposal kinds render correctly under black-gold too (every colour they
 * use comes from tokens).
 *
 * The gold is deliberately darker than black-gold's `#d4af37`, which fails
 * contrast on white.
 */

import type { Theme } from "../types.js";

export const goldLetterhead: Theme = {
  name: "gold-letterhead",
  label: "Gold Letterhead",
  tokens: {
    bg: "#ffffff",
    surface: "#faf8f3",
    surfaceAlt: "#f3efe4",
    border: "#ded7c6",
    text: "#16140f",
    textMuted: "#6d6656",
    accent: "#a37e12",
    accentStrong: "#75590a",
    fontHeading: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
    fontBody: "'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif",
    // Same vocabulary as black-gold so any template written against the
    // generic pill keys works under either theme.
    statusPills: {
      ok: { fg: "#14401f", bg: "#d8ecd9" },
      ready: { fg: "#14401f", bg: "#d8ecd9" },
      sent: { fg: "#4a3705", bg: "#f2e4b8" },
      complete: { fg: "#14401f", bg: "#d8ecd9" },
      running: { fg: "#3b2f05", bg: "#f7edcb" },
      queued: { fg: "#4a4638", bg: "#eae5d8" },
      rendering: { fg: "#4a4638", bg: "#eae5d8" },
      error: { fg: "#6d1616", bg: "#f6dcdc" },
      failed: { fg: "#6d1616", bg: "#f6dcdc" },
      timeout: { fg: "#6b3c10", bg: "#f8e5cf" },
      interrupted: { fg: "#6b3c10", bg: "#f8e5cf" },
    },
  },
};
