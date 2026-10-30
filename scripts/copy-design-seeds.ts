#!/usr/bin/env tsx
/**
 * Copy bundled design seeds (skills + systems) from src/design/seed-*
 * into dist/design/seed-* so the compiled gateway can find them.
 *
 * Runs as part of the main `build` script after tsc, alongside the
 * existing canvas-a2ui-copy and hook-metadata copies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const PAIRS = [
  ["src/design/seed-skills", "dist/design/seed-skills"],
  ["src/design/seed-systems", "dist/design/seed-systems"],
];

function copyTree(src: string, dst: string): number {
  let count = 0;
  if (!fs.existsSync(src)) return 0;
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

let total = 0;
for (const [rel, distRel] of PAIRS) {
  const src = path.join(projectRoot, rel);
  const dst = path.join(projectRoot, distRel);
  const n = copyTree(src, dst);
  if (n > 0) {
    console.log(`[copy-design-seeds] ${rel} → ${distRel} (${n} files)`);
    total += n;
  }
}
if (total === 0) {
  console.log("[copy-design-seeds] nothing to copy (no seed dirs found)");
}
