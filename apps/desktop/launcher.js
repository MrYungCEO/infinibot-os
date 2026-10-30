/**
 * InfiniBot Desktop Gateway Launcher
 *
 * Invoked with ELECTRON_RUN_AS_NODE=1 so Electron's bundled Node runtime
 * executes this as pure Node — no GUI, no Chromium, just V8.
 *
 * Resolution order for the gateway entry point (dist/entry.js):
 *   1. INFINIBOT_GATEWAY_ENTRY env var  (explicit override, mostly for dev)
 *   2. <electron-resources>/app/dist/entry.js  (packaged installer)
 *   3. <repo>/dist/entry.js  (running from a dev checkout, apps/desktop → ../../)
 *
 * All argv after "--" is forwarded to the gateway verbatim.
 */
"use strict";

const path = require("path");
const fs = require("fs");

function locateEntry() {
  const explicit = process.env.INFINIBOT_GATEWAY_ENTRY;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const candidates = [];

  // Packaged: extraResources places parent dist/ at resources/app/dist/
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app", "dist", "entry.js"));
  }

  // Dev: this file lives at apps/desktop/launcher.js → repo root is ../../
  candidates.push(path.resolve(__dirname, "..", "..", "dist", "entry.js"));

  // Fallback: one level up (when packed into asar, __dirname resolves differently)
  candidates.push(path.resolve(__dirname, "..", "dist", "entry.js"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `InfiniBot gateway entry not found. Tried:\n${candidates.map((c) => "  " + c).join("\n")}`,
  );
}

function locateRepoRoot(entry) {
  // entry.js lives in dist/; its grandparent is the repo root
  return path.resolve(path.dirname(entry), "..");
}

function forwardedArgv() {
  const all = process.argv.slice(2);
  const sep = all.indexOf("--");
  return sep === -1 ? all : all.slice(sep + 1);
}

let entry;
try {
  entry = locateEntry();
} catch (err) {
  console.error(`[infinibot-desktop launcher] ${err.message}`);
  process.exit(1);
}

const repoRoot = locateRepoRoot(entry);

// Surface repo root so the gateway's cwd-sensitive helpers (templates,
// build-info, plugin discovery) land on the bundled tree instead of /
process.env.INFINIBOT_REPO_ROOT = process.env.INFINIBOT_REPO_ROOT || repoRoot;
process.env.INFINIBOT_LAUNCHED_BY = "electron-desktop";

// Re-shape argv so the gateway sees its own argv[1]
process.argv = [process.argv[0], entry, ...forwardedArgv()];

try {
  require(entry);
} catch (err) {
  console.error(`[infinibot-desktop launcher] Failed to load ${entry}:`, err);
  process.exit(1);
}
