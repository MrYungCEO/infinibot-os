#!/usr/bin/env node
/**
 * One-shot codemod: add `.js` extensions to internal imports in the
 * `@hyperframes/{core,engine,producer}` packages.
 *
 * Hyperframes ships TypeScript-compiled ESM with bare specifiers like
 *   `import { foo } from "./bar";`
 * which is invalid under strict Node ESM resolution (Node ≥18). The package
 * works fine inside bundlers (Vite, webpack) that auto-resolve missing
 * extensions, but not under `tsx`, `vitest`, or plain `node`.
 *
 * This script walks each package's `dist/` tree and rewrites every relative
 * import / re-export specifier to its on-disk file:
 *   - "./bar"      → "./bar.js"        (when ./bar.js exists)
 *   - "./bar"      → "./bar/index.js"  (when ./bar is a directory)
 *
 * Idempotent — running it twice produces no further changes. Invoked from
 * `scripts/postinstall.js` so a fresh `pnpm install` always lands a working
 * node_modules state.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const PKG_DIRS = [
  "node_modules/@hyperframes/core/dist",
  "node_modules/@hyperframes/engine/dist",
  "node_modules/@hyperframes/producer/dist",
];

// `from "X"`, `from 'X'`, `import('X')`, `import "X"`, plus `export ... from "X"`.
const SPECIFIER_RE = /(from\s+|import\s*\(\s*|import\s+)(["'])(\.{1,2}\/[^"']+?)(["'])/g;

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of readdirSync(cur)) {
      const full = join(cur, name);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (/\.(?:js|mjs|cjs)$/.test(name)) out.push(full);
    }
  }
  return out;
}

function resolveSpecifier(fileDir, spec) {
  // Skip specifiers that already carry an extension.
  if (/\.(?:js|mjs|cjs|json|wasm|css|node)$/.test(spec)) return null;
  const candidateFile = resolve(fileDir, `${spec}.js`);
  if (existsSync(candidateFile) && statSync(candidateFile).isFile()) {
    return `${spec}.js`;
  }
  const candidateDir = resolve(fileDir, spec);
  if (existsSync(candidateDir) && statSync(candidateDir).isDirectory()) {
    const indexFile = join(candidateDir, "index.js");
    if (existsSync(indexFile)) return `${spec.replace(/\/$/, "")}/index.js`;
  }
  return null;
}

function rewriteFile(filePath) {
  const src = readFileSync(filePath, "utf-8");
  const dir = dirname(filePath);
  let mutated = false;
  const next = src.replace(SPECIFIER_RE, (match, prefix, quoteOpen, spec, quoteClose) => {
    const resolved = resolveSpecifier(dir, spec);
    if (!resolved) return match;
    mutated = true;
    return `${prefix}${quoteOpen}${resolved}${quoteClose}`;
  });
  if (mutated) writeFileSync(filePath, next, "utf-8");
  return mutated;
}

/**
 * @hyperframes/engine ships with `main` / `types` / `exports` pointing at
 * `./src/*.ts` — TypeScript source, not compiled JS. Node refuses to load
 * `.ts` directly, and tsc walks the source files (each with its own type
 * errors against newer puppeteer-core) when our code imports from
 * `@hyperframes/engine`. The actual build lands in `./dist/`. Repoint
 * the manifest at the built artifacts.
 *
 * Hardlink safety: pnpm hardlinks package.json from the global CAS, so an
 * in-place edit would mutate every project on the machine sharing the
 * same version. `unlinkSync` + `writeFileSync` breaks the hardlink so
 * only this install is affected.
 */
function patchEnginePackageJson() {
  const pkgPath = resolve(REPO_ROOT, "node_modules/@hyperframes/engine/package.json");
  if (!existsSync(pkgPath)) return;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return;
  }
  const swapJs = (val) =>
    typeof val === "string" && val.startsWith("./src/")
      ? val.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js")
      : val;
  const swapDts = (val) =>
    typeof val === "string" && val.startsWith("./src/")
      ? val.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".d.ts")
      : val;
  let mutated = false;
  if (pkg.main && pkg.main.startsWith("./src/")) {
    pkg.main = swapJs(pkg.main);
    mutated = true;
  }
  if (pkg.types && pkg.types.startsWith("./src/")) {
    pkg.types = swapDts(pkg.types);
    mutated = true;
  }
  if (pkg.exports && typeof pkg.exports === "object") {
    const next = {};
    for (const [key, value] of Object.entries(pkg.exports)) {
      if (typeof value === "string") {
        if (value.startsWith("./src/")) {
          next[key] = { types: swapDts(value), import: swapJs(value) };
          mutated = true;
        } else {
          next[key] = value;
        }
      } else if (value && typeof value === "object") {
        const inner = {};
        for (const [cond, condVal] of Object.entries(value)) {
          if (typeof condVal !== "string") {
            inner[cond] = condVal;
            continue;
          }
          if (cond === "types") {
            const v = swapDts(condVal);
            if (v !== condVal) mutated = true;
            inner[cond] = v;
          } else {
            const v = swapJs(condVal);
            if (v !== condVal) mutated = true;
            inner[cond] = v;
          }
        }
        next[key] = inner;
      } else {
        next[key] = value;
      }
    }
    pkg.exports = next;
  }
  if (mutated) {
    unlinkSync(pkgPath);
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
    console.log(`[fix-hyperframes-esm] repointed @hyperframes/engine manifest src/ → dist/`);
  }
}

function run() {
  let touched = 0;
  let scanned = 0;
  for (const rel of PKG_DIRS) {
    const abs = resolve(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      scanned++;
      if (rewriteFile(file)) touched++;
    }
  }
  if (touched > 0) {
    console.log(`[fix-hyperframes-esm] rewrote ${touched}/${scanned} files`);
  }
  patchEnginePackageJson();
}

run();
