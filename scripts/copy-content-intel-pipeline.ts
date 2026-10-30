#!/usr/bin/env tsx
/**
 * Copy the vendored content-intel pipeline scripts (Python) from
 * src/content/intelligence/pipeline/ into dist/content/intelligence/pipeline/
 * so the compiled gateway can spawn them.
 *
 * tsc only emits .js, so the .py scorer/downloader/transcriber never reached
 * dist — making pipeline-wrapper's `scriptsDir()` resolve to a non-existent
 * path and every gateway scoring call fail with "Script not found". This copy
 * runs as part of the main `build` script after tsc, alongside the existing
 * copy-design-seeds / copy-hook-metadata steps.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const SRC = path.join(projectRoot, "src/content/intelligence/pipeline");
const DST = path.join(projectRoot, "dist/content/intelligence/pipeline");

function copyPyTree(src: string, dst: string): number {
  let count = 0;
  if (!fs.existsSync(src)) return 0;
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyPyTree(s, d);
    } else if (entry.isFile() && (entry.name.endsWith(".py") || entry.name === "requirements.txt")) {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

const n = copyPyTree(SRC, DST);
if (n > 0) {
  console.log(`[copy-content-intel-pipeline] copied ${n} pipeline files → dist`);
} else {
  console.log("[copy-content-intel-pipeline] nothing to copy (no pipeline dir found)");
}
