#!/usr/bin/env node
/**
 * Starter template generator. Emits 5 JSON templates per category
 * under the matching subdirectory, plus an `index.json` listing.
 *
 * Templates are intentionally simple: a sized canvas with a labelled
 * title rectangle + body text. Designers will replace these with rich
 * starters; the generator exists so the catalogue is never empty.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const CATEGORIES = [
  { id: "social",            label: "Social",            w: 1080, h: 1080 },
  { id: "story",             label: "Story",             w: 1080, h: 1920 },
  { id: "ebook",             label: "Ebook",             w: 1240, h: 1754 },
  { id: "workbook",          label: "Workbook",          w: 1240, h: 1754 },
  { id: "planner",           label: "Planner",           w: 1240, h: 1754 },
  { id: "invoice",           label: "Invoice",           w: 1240, h: 1754 },
  { id: "lead-magnet",       label: "Lead magnet",       w: 1080, h: 1350 },
  { id: "worksheet",         label: "Worksheet",         w: 1240, h: 1754 },
  { id: "course-thumbnail",  label: "Course thumbnail",  w: 1280, h:  720 },
];

const PALETTES = [
  { bg: "#ffffff", fg: "#0b0b14", accent: "#4f46e5" },
  { bg: "#0b0b14", fg: "#ffffff", accent: "#22d3ee" },
  { bg: "#fff8f0", fg: "#3b2a1a", accent: "#f97316" },
  { bg: "#0e1a14", fg: "#e6fff5", accent: "#22c55e" },
  { bg: "#f5f5fa", fg: "#1a1a2e", accent: "#a855f7" },
];

const VARIANTS = ["Minimal", "Bold", "Editorial", "Soft", "Mono"];

function ymd() { return new Date().toISOString().slice(0, 10); }

function tmpl(cat, i) {
  const palette = PALETTES[i % PALETTES.length];
  const variant = VARIANTS[i % VARIANTS.length];
  const id = `${cat.id}-${variant.toLowerCase()}`;
  const cx = cat.w / 2;
  const elements = [
    {
      id: `${id}-bg-accent`,
      type: "rectangle",
      x: 0, y: cat.h * 0.78,
      width: cat.w, height: cat.h * 0.06,
      backgroundColor: palette.accent,
      fillStyle: "solid",
      strokeColor: "transparent",
      strokeWidth: 0,
      roughness: 0,
    },
    {
      id: `${id}-title`,
      type: "text",
      x: cat.w * 0.1, y: cat.h * 0.35,
      width: cat.w * 0.8, height: 96,
      text: `${cat.label} title`,
      fontSize: 64,
      fontFamily: 1,
      textAlign: "center",
      strokeColor: palette.fg,
    },
    {
      id: `${id}-subtitle`,
      type: "text",
      x: cat.w * 0.1, y: cat.h * 0.48,
      width: cat.w * 0.8, height: 48,
      text: `${variant} · ${cat.w}×${cat.h}`,
      fontSize: 28,
      fontFamily: 2,
      textAlign: "center",
      strokeColor: palette.fg,
      opacity: 70,
    },
  ];
  return {
    id,
    category: cat.id,
    name: `${cat.label} · ${variant}`,
    width: cat.w,
    height: cat.h,
    background: palette.bg,
    createdAt: ymd(),
    scene: { elements, appState: {}, files: {} },
  };
}

const index = [];
for (const cat of CATEGORIES) {
  const dir = join(HERE, cat.id);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5; i++) {
    const t = tmpl(cat, i);
    writeFileSync(join(dir, `${t.id}.json`), JSON.stringify(t, null, 2) + "\n");
    index.push(t);
  }
}
writeFileSync(join(HERE, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`wrote ${index.length} templates`);
