#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const uiDir = path.join(repoRoot, "ui");

function usage() {
  // keep this tiny; it's invoked from npm scripts too
  process.stderr.write(
    "Usage: node scripts/ui.js <install|dev|build|test> [...args]\n",
  );
}

function which(cmd) {
  try {
    const key = process.platform === "win32" ? "Path" : "PATH";
    const paths = (process.env[key] ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    const extensions =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean)
        : [""];
    for (const entry of paths) {
      for (const ext of extensions) {
        const candidate = path.join(entry, process.platform === "win32" ? `${cmd}${ext}` : cmd);
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveRunner() {
  const pnpm = which("pnpm");
  if (pnpm) return { cmd: pnpm, kind: "pnpm" };
  return null;
}

function run(cmd, args) {
  const child = spawn(cmd, args, {
    cwd: uiDir,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

function runSync(cmd, args, envOverride) {
  const result = spawnSync(cmd, args, {
    cwd: uiDir,
    stdio: "inherit",
    env: envOverride ?? process.env,
    shell: process.platform === "win32",
  });
  if (result.signal) process.exit(1);
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

function depsInstalled(kind) {
  try {
    const require = createRequire(path.join(uiDir, "package.json"));
    require.resolve("vite");
    require.resolve("dompurify");
    if (kind === "test") {
      require.resolve("vitest");
      require.resolve("@vitest/browser-playwright");
      require.resolve("playwright");
    }
    return true;
  } catch {
    return false;
  }
}

const [, , action, ...rest] = process.argv;
if (!action) {
  usage();
  process.exit(2);
}

const runner = resolveRunner();
if (!runner) {
  process.stderr.write("Missing UI runner: install pnpm, then retry.\n");
  process.exit(1);
}

const script =
  action === "install"
    ? null
    : action === "dev"
      ? "dev"
      : action === "build"
        ? "build"
        : action === "test"
          ? "test"
          : null;

if (action !== "install" && !script) {
  usage();
  process.exit(2);
}

if (action === "install") run(runner.cmd, ["install", ...rest]);
else {
  if (!depsInstalled(action === "test" ? "test" : "build")) {
    const installEnv =
      action === "build"
        ? { ...process.env, NODE_ENV: "production" }
        : process.env;
    const installArgs =
      action === "build" ? ["install", "--prod"] : ["install"];
    runSync(runner.cmd, installArgs, installEnv);
  }
  // Invoke the tool from its RESOLVED module path rather than `pnpm run
  // <script>`. `pnpm run` relies on the package-local .bin shim
  // (ui/node_modules/.bin/vite), which breaks under node-linker=hoisted — the
  // deps live in the ROOT node_modules, so the shim points at a path that no
  // longer exists. createRequire resolves the real bin under BOTH the isolated
  // and hoisted layouts, so the build/dev/test commands work either way.
  void script;
  const uiRequire = createRequire(path.join(uiDir, "package.json"));
  // Resolve the package DIRECTORY via its package.json (always exported), then
  // join the bin path. Resolving the bin subpath directly fails on packages
  // with an `exports` map (vite → ERR_PACKAGE_PATH_NOT_EXPORTED).
  const pkgDir = (name) => path.dirname(uiRequire.resolve(`${name}/package.json`));
  if (action === "test") {
    run(process.execPath, [path.join(pkgDir("vitest"), "vitest.mjs"), "run", ...rest]);
  } else {
    const viteBin = path.join(pkgDir("vite"), "bin", "vite.js");
    run(process.execPath, [viteBin, ...(action === "build" ? ["build"] : []), ...rest]);
  }
}
