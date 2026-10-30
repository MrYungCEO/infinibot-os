#!/usr/bin/env node
/**
 * Cross-platform federation self-test orchestrator.
 *
 * Selects the right per-OS subscript and forwards all CLI arguments:
 *   Windows  → scripts/federation-windows-selftest.mjs
 *   POSIX    → scripts/federation-selftest.mjs  (existing routing-matrix selftest)
 *
 * Usage:
 *   node scripts/federation-selftest-runner.mjs              # auto-detect OS
 *   node scripts/federation-selftest-runner.mjs --dry-run    # skip platform checks
 *   node scripts/federation-selftest-runner.mjs --spawn      # POSIX: real spawn test
 *   node scripts/federation-selftest-runner.mjs --port 18789 # Windows: override port
 *
 * CI: run this script from any node — it picks the right subscript automatically.
 * Build first:  pnpm build
 */

import { platform } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolve(name) {
  return path.join(__dirname, name);
}

const IS_WIN = platform() === "win32";
const args   = process.argv.slice(2);

// On POSIX add --spawn by default so the posix selftest exercises real routes.
// The caller can suppress this by passing --no-spawn explicitly.
const posixArgs =
  !args.includes("--spawn") && !args.includes("--no-spawn")
    ? ["--spawn", ...args]
    : args.filter(a => a !== "--no-spawn");

const script    = IS_WIN ? resolve("federation-windows-selftest.mjs") : resolve("federation-selftest.mjs");
const scriptArgs = IS_WIN ? args : posixArgs;

console.log(`federation-selftest-runner: ${IS_WIN ? "Windows" : "POSIX"} path`);
console.log(`  → node ${script} ${scriptArgs.join(" ")}\n`);

const result = spawnSync(process.execPath, [script, ...scriptArgs], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(`Runner error: ${result.error.message}`);
  process.exit(2);
}

process.exit(result.status ?? 0);
