#!/usr/bin/env node
/**
 * Artifact Hardening — post-build verification.
 *
 * Fails the build (non-zero exit) if the compiled bundle in dist/ is missing
 * any required feature marker. This guards against a partial/stale build being
 * served where a major surface (Wizard onboarding, Voice, CLI) silently
 * dropped out.
 *
 * Each marker is a case-sensitive substring searched recursively across dist/.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const distDir = join(rootDir, "dist");

const REQUIRED_MARKERS = ["Wizard", "Voice", "CLI"];
// Skip binary-ish output that would never contain source markers.
const SKIP_EXT = new Set([".map", ".png", ".jpg", ".jpeg", ".gif", ".woff", ".woff2", ".ico", ".wasm"]);

if (!existsSync(distDir)) {
  console.error("[verify-build] FAIL: dist/ does not exist — build did not produce output.");
  process.exit(1);
}

const found = new Set();

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs);
      continue;
    }
    if (SKIP_EXT.has(entry.slice(entry.lastIndexOf(".")))) continue;
    if (found.size === REQUIRED_MARKERS.length) return; // all found, stop early
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const marker of REQUIRED_MARKERS) {
      if (!found.has(marker) && content.includes(marker)) found.add(marker);
    }
  }
}

walk(distDir);

const missing = REQUIRED_MARKERS.filter((m) => !found.has(m));
if (missing.length > 0) {
  console.error(
    `[verify-build] FAIL: missing required marker(s) in dist/: ${missing.join(", ")}`,
  );
  process.exit(1);
}

console.log(`[verify-build] OK: all markers present (${REQUIRED_MARKERS.join(", ")})`);
