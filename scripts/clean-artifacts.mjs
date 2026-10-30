#!/usr/bin/env node
/**
 * Artifact Hardening — pre-build clean.
 *
 * Purges stale build output before every build so the served bundle can never
 * drift from source. By default this removes ONLY build artifacts (dist/, any
 * .next/, vite UI output, *.tsbuildinfo) which is safe and fast.
 *
 * Pass --deep (or set CLEAN_DEPS=1) to also wipe node_modules — the literal
 * "purge node_modules before build" behaviour. This is intentionally opt-in
 * because a normal build needs node_modules present (tsc, tsx) and wiping it
 * forces a full reinstall every time.
 *
 * Usage:
 *   node scripts/clean-artifacts.mjs            # artifacts only (build chain default)
 *   node scripts/clean-artifacts.mjs --deep     # also remove node_modules
 *   CLEAN_DEPS=1 node scripts/clean-artifacts.mjs
 */
import { rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const deep = process.argv.includes("--deep") || process.env.CLEAN_DEPS === "1";

// Build artifacts purged on every build. dist/ already contains the vite UI
// output (ui/vite.config -> ../dist/control-ui), so removing dist covers it.
const artifactTargets = [
  "dist",
  ".next",
  "ui/.next",
  "ui/dist",
  "tsconfig.tsbuildinfo",
  ".tsbuildinfo",
];

// Only when --deep / CLEAN_DEPS=1.
const depTargets = ["node_modules", "ui/node_modules", "electron/node_modules"];

const targets = deep ? [...artifactTargets, ...depTargets] : artifactTargets;

let removed = 0;
for (const rel of targets) {
  const abs = join(rootDir, rel);
  if (!existsSync(abs)) continue;
  rmSync(abs, { recursive: true, force: true });
  console.log(`  ✗ purged ${rel}`);
  removed++;
}

console.log(
  `[clean-artifacts] removed ${removed} target(s)${deep ? " (deep: node_modules wiped — reinstall required)" : ""}`,
);
