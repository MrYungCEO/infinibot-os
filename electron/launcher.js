/**
 * Gateway launcher — invoked by main.js with ELECTRON_RUN_AS_NODE=1 so
 * Electron's bundled Node runtime executes this file as pure Node.
 *
 * We don't need a separate Node binary in the installer because every
 * Electron app already ships one (the runtime that powers the main
 * process). The `ELECTRON_RUN_AS_NODE=1` env var is the documented
 * escape hatch that turns the same executable into `node`.
 *
 * Resolution order for the gateway entry:
 *   1. INFINIBOT_GATEWAY_ENTRY (explicit override, mostly for dev)
 *   2. <electron-resources>/app/dist/entry.js (packaged build)
 *   3. <repo>/dist/entry.js (running from a dev checkout)
 *
 * Anything after `--` on the argv is forwarded to the gateway, so
 * `electron launcher.js -- daemon start --foreground` works.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

function locateEntry() {
  const explicit = process.env.INFINIBOT_GATEWAY_ENTRY;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const candidates = [];
  // Packaged: extraResources places parent's dist/ at resources/app/dist
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app", "dist", "entry.js"));
  }
  // Dev: electron/launcher.js → ../dist/entry.js
  candidates.push(path.resolve(__dirname, "..", "dist", "entry.js"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `infinibot gateway entry not found. Tried: ${candidates.join(", ")}`,
  );
}

function locateRepoRoot(entry) {
  // entry.js lives in dist/ — its parent (dist's parent) is the repo
  // root, which is what InfiniBot uses to find docs/reference/templates,
  // package.json, and other build-time resources.
  return path.resolve(path.dirname(entry), "..");
}

function forwardedArgv() {
  // Everything after a `--` sentinel; otherwise everything past argv[1].
  const all = process.argv.slice(2);
  const sep = all.indexOf("--");
  return sep === -1 ? all : all.slice(sep + 1);
}

const entry = locateEntry();
const repoRoot = locateRepoRoot(entry);

// Surface the repo root to the gateway so its cwd-sensitive helpers
// (template resolution, build-info lookup, plugin discovery) land on
// the bundled tree instead of `/` (Electron's default cwd on macOS).
process.env.INFINIBOT_REPO_ROOT = process.env.INFINIBOT_REPO_ROOT || repoRoot;
process.env.INFINIBOT_LAUNCHED_BY = "electron";

// Re-shape argv so the gateway sees its own argv0 / forwarded args.
process.argv = [process.argv[0], entry, ...forwardedArgv()];

// The gateway is shipped as an ES module (root package.json has
// "type": "module", and extraResources copies it next to dist/ as
// app/package.json). A plain require() of entry.js therefore throws
// ERR_REQUIRE_ESM, so we load it with a dynamic import() — which works
// from CommonJS and handles both ESM and CJS entry points. We still keep
// a require() fast-path for the (legacy) case where entry.js is CJS.
(async () => {
  try {
    require(entry);
  } catch (err) {
    if (err && err.code === "ERR_REQUIRE_ESM") {
      try {
        await import(pathToFileURL(entry).href);
        return;
      } catch (esmErr) {
        // eslint-disable-next-line no-console
        console.error(`[infinibot launcher] failed to import ${entry}:`, esmErr);
        process.exit(1);
      }
    }
    // eslint-disable-next-line no-console
    console.error(`[infinibot launcher] failed to load ${entry}:`, err);
    process.exit(1);
  }
})();
