#!/usr/bin/env node
/**
 * Rebuild the gateway's native modules against the bundled Electron's ABI.
 *
 * Why this exists instead of plain `electron-rebuild`:
 *   The repo is a pnpm workspace, so native deps live under a symlinked
 *   `.pnpm/<pkg>@<ver>/node_modules/<pkg>` tree. `electron-rebuild -m ..`
 *   silently fails to traverse that layout — it reports "Rebuild Complete"
 *   without ever touching the `.node`, leaving `better-sqlite3` compiled
 *   for native Node (NODE_MODULE_VERSION mismatch → the packaged gateway
 *   crashes on boot). This script resolves the real package directory and
 *   compiles it from source against the Electron headers.
 *
 *   `sharp` (>=0.33) and `@lydell/node-pty` ship N-API prebuilds, which are
 *   ABI-stable across Node/Electron versions — they need no rebuild, so we
 *   only force-compile better-sqlite3.
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, "..");
const repoRoot = join(electronDir, "..");
const require = createRequire(join(electronDir, "package.json"));

function electronVersion() {
  const pkg = require("electron/package.json");
  return pkg.version;
}

function resolvePackageDir(name) {
  // Resolve from the repo root so we land on the real pnpm package dir.
  const repoRequire = createRequire(join(repoRoot, "package.json"));
  const pkgJson = repoRequire.resolve(`${name}/package.json`);
  return dirname(pkgJson);
}

function nodeGypBin() {
  // Prefer @electron/node-gyp (knows about Electron headers), fall back to
  // the workspace node-gyp.
  for (const cand of [
    "@electron/node-gyp/bin/node-gyp.js",
    "node-gyp/bin/node-gyp.js",
  ]) {
    try {
      const repoRequire = createRequire(join(repoRoot, "package.json"));
      return repoRequire.resolve(cand);
    } catch {
      try {
        return require.resolve(cand);
      } catch {
        /* try next */
      }
    }
  }
  throw new Error("node-gyp not found in electron/ or repo node_modules");
}

const version = electronVersion();
const gyp = nodeGypBin();
const env = {
  ...process.env,
  npm_config_runtime: "electron",
  npm_config_target: version,
  npm_config_disturl: "https://electronjs.org/headers",
  npm_config_arch: process.arch,
};
// Electron's argv injection breaks node-gyp's child node invocations.
delete env.NODE_OPTIONS;

const bs = resolvePackageDir("better-sqlite3");
console.log(`[rebuild-native] electron=${version} arch=${process.arch}`);
console.log(`[rebuild-native] compiling better-sqlite3 from source @ ${bs}`);
execFileSync(process.execPath, [gyp, "rebuild", "--release"], {
  cwd: bs,
  env,
  stdio: "inherit",
});

const out = join(bs, "build", "Release", "better_sqlite3.node");
if (!existsSync(out)) {
  throw new Error(`expected ${out} after rebuild`);
}
console.log(`[rebuild-native] ok → ${out}`);
console.log("[rebuild-native] sharp + @lydell/node-pty use N-API prebuilds (no rebuild needed)");
