#!/usr/bin/env node
// Stage a self-contained, PRODUCTION-ONLY gateway bundle for one desktop
// target, which electron-builder then copies to resources/app/ (see
// electron/electron-builder.release.cjs).
//
// Why not copy the repo's node_modules (the old extraResources config)?
//  - it ships every devDependency (≈3 GB) and
//  - it only holds native binaries for the BUILD host, so a Linux-built
//    Windows installer shipped Linux better-sqlite3/node-pty/sharp and the
//    gateway could not start on Windows.
//
// This script instead:
//  1. copies the files the npm package ships (npm pack --dry-run) + all of dist/
//  2. writes a prod package.json (no devDeps/scripts, version = desktop version)
//  3. `npm install --omit=dev --ignore-scripts --os=<p> --cpu=x64` so optional
//     per-platform packages (sharp, node-pty, sqlite-vec, canvas…) match the
//     TARGET OS, resolved no later than --before (supply-chain cool-off)
//  4. fetches the better-sqlite3 prebuild for Electron's ABI + target OS
//  5. prunes other-platform binaries, sourcemaps, tests and docs
//
// usage: node scripts/desktop/stage-bundle.mjs --platform linux|win32 \
//          --out <dir> --version 2026.10.7 --electron 35.7.5 [--before 2026-10-05]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const platform = args.platform;
const OUT = path.resolve(args.out || "");
const version = args.version;
const electronVersion = args.electron;
const before = args.before || "2026-10-05";
if (!["linux", "win32"].includes(platform) || !args.out || !version || !electronVersion) {
  console.error("usage: stage-bundle.mjs --platform linux|win32 --out <dir> --version <v> --electron <v>");
  process.exit(2);
}

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { stdio: "inherit", ...opts });
const log = (...m) => console.log("[stage]", ...m);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. npm package file list (without running prepack) + full dist/
const packJson = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
});
const files = JSON.parse(packJson)[0].files.map((f) => f.path);
const skip = (rel) =>
  rel.startsWith("dist/") ||
  rel === "package.json" ||
  rel.startsWith("git-hooks/") ||
  rel.startsWith("scripts/") ||
  /\.map$/.test(rel) ||
  /(?:^|\/)(?:__tests__|__fixtures__)(?:\/|$)/.test(rel) ||
  /\.(?:test|spec)\.(?:[cm]?js|tsx?)$/.test(rel) ||
  /(?:^|\/)\.env(?:\.|$)/.test(rel) ||
  // pnpm workspace back-links / registry copies of infinibot itself
  /^extensions\/[^/]+\/node_modules\/(?:infinibot|\.bin)\//.test(rel) ||
  // internal runbooks, research, perf dumps and landing-site media: not
  // needed by the gateway and not something to ship to end users
  /^docs\/(?:saas|rollouts|research|frames|assets\/landing)\//.test(rel) ||
  /^docs\/[^/]*perf[^/]*\.json$/.test(rel);
let n = 0;
for (const rel of files) {
  if (skip(rel)) continue;
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dst);
  n++;
}
// realpath: a dist/ that is a symlink (build output redirected to another
// disk) would otherwise be copied as the link itself and ship a dangling
// pointer to the build machine.
fs.cpSync(fs.realpathSync(path.join(ROOT, "dist")), path.join(OUT, "dist"), {
  recursive: true,
  dereference: true,
  filter: (src) => !/\.map$|\.test\.js$|[\\/]__tests__([\\/]|$)|[\\/]__fixtures__([\\/]|$)/.test(src),
});
log(`copied ${n} package files + dist/`);

// Workspace extensions keep a few real deps in their own node_modules (the
// hoisted pnpm layout). Carry those over, minus workspace back-links.
for (const ext of fs.readdirSync(path.join(ROOT, "extensions"))) {
  const nm = path.join(ROOT, "extensions", ext, "node_modules");
  if (!fs.existsSync(nm)) continue;
  for (const entry of fs.readdirSync(nm)) {
    if (entry === "infinibot" || entry === ".bin" || entry.startsWith(".")) continue;
    const src = path.join(nm, entry);
    if (fs.lstatSync(src).isSymbolicLink()) continue;
    fs.cpSync(src, path.join(OUT, "extensions", ext, "node_modules", entry), {
      recursive: true,
      dereference: false,
    });
  }
}

// 1b. Browser Relay extension. The unpacked folder already rides along in
// assets/chrome-extension/ (the gateway copies it to a stable folder for
// Chrome's "Load unpacked"); add a zipped copy next to it for moving the
// extension to another computer. The zip has manifest.json at its root.
{
  const extDir = path.join(OUT, "assets", "chrome-extension");
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3 || !/InfiniBot/.test(manifest.name || "")) {
    throw new Error(`browser extension manifest looks wrong: ${manifest.name} v${manifest.manifest_version}`);
  }
  const zip = path.join(OUT, "assets", "infinibot-browser-relay.zip");
  fs.rmSync(zip, { force: true });
  let sevenZip = null;
  try {
    sevenZip = createRequire(path.join(ROOT, "package.json"))("7zip-bin").path7za;
  } catch {
    /* fall back to the zip CLI */
  }
  if (sevenZip && fs.existsSync(sevenZip)) {
    run(sevenZip, ["a", "-tzip", "-mx=9", zip, "./*"], { cwd: extDir, stdio: "ignore" });
  } else {
    run("zip", ["-qr9", zip, "."], { cwd: extDir });
  }
  log(`browser extension v${manifest.version} + ${path.basename(zip)}`);
}

// 2. production package.json
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const prod = {
  name: pkg.name,
  version,
  description: pkg.description,
  license: pkg.license,
  type: pkg.type,
  main: pkg.main,
  exports: pkg.exports,
  bin: pkg.bin,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
  optionalDependencies: { ...(pkg.optionalDependencies || {}) },
  overrides: { ...(pkg.pnpm?.overrides || {}) },
  infinibotDesktop: { platform, electron: electronVersion, builtFrom: process.env.IB_DESKTOP_GIT_SHA || "" },
};
// node-llama-cpp pulls >1 GB of llama.cpp binaries; local GGUF inference is
// not part of the desktop installer (Ollama / providers cover it).
delete prod.optionalDependencies["node-llama-cpp"];
fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify(prod, null, 2) + "\n");

// 3. install for the TARGET platform
const npmArgs = [
  "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
  "--install-links=false", `--before=${before}`, `--os=${platform}`, "--cpu=x64",
  "--libc=" + (platform === "linux" ? "glibc" : ""),
].filter((a) => !a.endsWith("="));
log("npm", npmArgs.join(" "));
run("npm", npmArgs, { cwd: OUT, env: { ...process.env, NODE_ENV: "production" } });

// 4. better-sqlite3 for Electron's ABI on the target OS
const bsq = path.join(OUT, "node_modules", "better-sqlite3");
fs.rmSync(path.join(bsq, "build"), { recursive: true, force: true });
const prebuildBin = [
  path.join(OUT, "node_modules", "prebuild-install", "bin.js"),
  path.join(ROOT, "node_modules", "prebuild-install", "bin.js"),
].find((p) => fs.existsSync(p));
if (!prebuildBin) throw new Error("prebuild-install not found");
run(process.execPath, [
  prebuildBin, "--runtime=electron", `--target=${electronVersion}`, "--arch=x64",
  `--platform=${platform}`, "--verbose",
], { cwd: bsq });
const bsqNode = path.join(bsq, "build", "Release", "better_sqlite3.node");
if (!fs.existsSync(bsqNode)) throw new Error("better-sqlite3 prebuild missing");

// 4b. built-in voice engine on Windows: app-local VC++ runtime next to the
// onnxruntime binding (see electron/build/win-vcredist/README.md), and the
// WebAssembly runtime it falls back to must be present.
if (platform === "win32") {
  const ortBin = path.join(OUT, "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "x64");
  if (!fs.existsSync(path.join(ortBin, "onnxruntime.dll"))) throw new Error(`onnxruntime-node win32 binaries missing in ${ortBin}`);
  const vcDir = path.join(ROOT, "electron", "build", "win-vcredist", "x64");
  for (const dll of ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"]) {
    fs.copyFileSync(path.join(vcDir, dll), path.join(ortBin, dll));
  }
  log("app-local VC++ runtime →", path.relative(OUT, ortBin));
}
{
  const tf = path.join(OUT, "node_modules", "@huggingface", "transformers");
  const web = [path.join(tf, "node_modules", "onnxruntime-web"), path.join(OUT, "node_modules", "onnxruntime-web")].find((d) => fs.existsSync(d));
  if (fs.existsSync(tf) && (!web || !fs.existsSync(path.join(web, "dist", "ort-wasm-simd-threaded.wasm")) || !fs.existsSync(path.join(web, "dist", "ort.node.min.mjs")))) {
    throw new Error("onnxruntime-web (voice engine WebAssembly fallback) missing from the bundle");
  }
}

// 5. prune
const otherOs = platform === "win32" ? ["linux", "darwin", "android"] : ["win32", "darwin", "android"];
const pruneDirRe = new RegExp(
  [
    `[\\\\/]napi-v3[\\\\/](?:${otherOs.join("|")})$`, // onnxruntime-node per-OS bins
    `[\\\\/]prebuilds[\\\\/](?:${otherOs.join("|")})-[a-z0-9]+$`,
    `[\\\\/]prebuilds[\\\\/][a-z0-9]+-arm64$`,
    "[\\\\/]napi-v3[\\\\/][a-z0-9]+[\\\\/]arm64$", // x64-only installers
    "[\\\\/](?:test|tests|__tests__|example|examples|benchmark|benchmarks|\\.github)$",
  ].join("|"),
);
const pruneFileRe = /\.(?:map|md|markdown|ts|tsx|flow|pdb|iobj|ipdb|obj|lib|exp)$/i;
const keepFileRe = /\.d\.ts$|LICENSE|license/;
let pruned = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (pruneDirRe.test(p)) { fs.rmSync(p, { recursive: true, force: true }); pruned++; continue; }
      walk(p);
    } else if (e.isFile() && pruneFileRe.test(e.name) && !keepFileRe.test(e.name)) {
      // .d.ts are kept (some packages resolve them at runtime via jiti)
      fs.rmSync(p); pruned++;
    }
  }
}
walk(path.join(OUT, "node_modules"));
log(`pruned ${pruned} entries`);
for (const f of fs.readdirSync(OUT)) if (f.startsWith(".env")) fs.rmSync(path.join(OUT, f));
fs.rmSync(path.join(OUT, "package-lock.json"), { force: true });
log("done →", OUT);
