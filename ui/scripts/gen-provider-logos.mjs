#!/usr/bin/env node
/**
 * Generates the coder-backend badge PNGs used by the agent mesh map
 * (ui/src/ui/views/agent-ops/provider-logos.ts), the map build chips and the
 * agent hover tooltip.
 *
 *   node ui/scripts/gen-provider-logos.mjs
 *
 * Output: ui/public/providers/<id>.png (96px) and <id>@2x.png (192px),
 * transparent background.
 *
 * These are InfiniBot's own neutral letter monograms (gold letter on a dark
 * disc with a gold ring, like the sprite-sheet letter badges), not the
 * providers' logos: third-party logos need the owner's written permission, so
 * the CLI is named in text next to the badge instead. See
 * docs/licensing/BRAND-USAGE.md. Do not add third-party logo path data here.
 *
 *   mono-c  → Claude Code     mono-x → Codex CLI
 *   mono-g  → Gemini CLI      mono-o → OpenCode
 *   infinibot → fallback, downscaled from ui/public/infinibot-logo.png
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let sharp;
for (const p of ["sharp", resolve(here, "../../node_modules/sharp")]) {
  try { sharp = require(p); break; } catch { /* try next */ }
}
if (!sharp) throw new Error("sharp not found — run from the repo with node_modules installed");

const OUT = resolve(here, "../public/providers");
mkdirSync(OUT, { recursive: true });

const GOLD = "#E8B84A";
const GOLD_HI = "#FFE08A";
const PLATE = "#0E0D12";

// 100×100 box: dark disc, gold ring, bold gold letter.
const monogram = (letter) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${GOLD_HI}"/><stop offset="1" stop-color="${GOLD}"/>
    </linearGradient>
  </defs>
  <circle cx="50" cy="50" r="45" fill="${PLATE}" fill-opacity="0.92"/>
  <circle cx="50" cy="50" r="45" fill="none" stroke="url(#g)" stroke-width="6"/>
  <text x="50" y="68" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif"
    font-weight="700" font-size="52" fill="url(#g)">${letter}</text>
</svg>`;

const MONOGRAMS = { "mono-c": "C", "mono-x": "X", "mono-g": "G", "mono-o": "O" };

for (const [id, letter] of Object.entries(MONOGRAMS)) {
  for (const [size, suffix] of [[96, ""], [192, "@2x"]]) {
    await sharp(Buffer.from(monogram(letter)), { density: (72 * size) / 100 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(resolve(OUT, `${id}${suffix}.png`));
  }
}
for (const [size, suffix] of [[96, ""], [192, "@2x"]]) {
  // Trim the source's transparent padding first so the mark fills the badge.
  const trimmed = await sharp(resolve(here, "../public/infinibot-logo.png")).trim().png().toBuffer();
  const inner = Math.round(size * 0.86);
  await sharp(trimmed)
    .resize(inner, inner, { fit: "contain", kernel: "lanczos3", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: (size - inner) >> 1, bottom: size - inner - ((size - inner) >> 1), left: (size - inner) >> 1, right: size - inner - ((size - inner) >> 1), background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(resolve(OUT, `infinibot${suffix}.png`));
}
console.log("provider badges written to", OUT);
