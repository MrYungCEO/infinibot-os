#!/usr/bin/env -S node --import tsx

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackFile = { path: string; size?: number };
type PackResult = { files?: PackFile[]; size?: number; unpackedSize?: number; entryCount?: number };

const requiredPaths = [
  "dist/entry.js",
  "dist/index.js",
  "dist/build-info.json",
  "dist/control-ui/index.html",
  "dist/discord/send.js",
  "dist/hooks/gmail.js",
  "dist/whatsapp/normalize.js",
  "docs/reference/templates/AGENTS.md",
  "scripts/postinstall.js",
  "scripts/setup-git-hooks.js",
  "scripts/fix-hyperframes-esm.mjs",
  "scripts/install-infinibot.sh",
  "scripts/install-infinibot.ps1",
];
const forbiddenPrefixes = ["dist/InfiniBot.app/", "dist/test-helpers/", "dist/test-utils/"];

// Compiled dirs that are test-only and must stay out of the package.
const distDirsNotShipped = new Set(["test-helpers", "test-utils", "InfiniBot.app"]);

// Things that must never be published, whatever `files[]` says.
const forbiddenPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "env file", pattern: /(^|\/)\.env(\.|$)/ },
  { label: "private key / keystore", pattern: /\.(pem|key|p12|pfx|jks|keystore)$/ },
  { label: "database / state", pattern: /\.(sqlite|sqlite3|db)$/ },
  { label: "log", pattern: /\.log$/ },
  { label: "nested node_modules", pattern: /(^|\/)node_modules\// },
  { label: "test file", pattern: /\.test\.[cm]?[jt]sx?$/ },
  { label: "source map", pattern: /\.map$/ },
  { label: "dev harness (local visual-verify scaffolding)", pattern: /(^|\/)src\/dev\/|-harness\.(html|[cm]?[jt]s)$|-shot\.mjs$/ },
  { label: "marketing site (served from infinibotos.com, not the package)", pattern: /^docs\/(landing\.html|assets\/landing\/|frames\/|videos\/|docs\/)/ },
];

// Credential shapes that must not appear inside any shipped text file.
const secretPattern =
  /sk-ant-[A-Za-z0-9_-]{20,}|sk-or-v1-[a-f0-9]{30,}|sk-proj-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[bap]-[0-9A-Za-z-]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|npm_[A-Za-z0-9]{36}|\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}|sk_live_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{24,}|npg_[A-Za-z0-9]{12,}/;
const binaryExtensions = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|wasm|mp3|mp4|wav|ogg|pdf|zip|gz|onnx|bin)$/i;

// Largest tarball we are willing to publish. The control UI is ~100 MB of
// assets today; this catches an accidental extra payload, not normal growth.
const maxPackedBytes = 160 * 1024 * 1024;

type PackageJson = {
  name?: string;
  version?: string;
};

function runPackDry(): PackResult[] {
  const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw) as PackResult[];
}

function checkPluginVersions() {
  const rootPackagePath = resolve("package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;

  if (!targetVersion) {
    console.error("release-check: root package.json missing version.");
    process.exit(1);
  }

  const extensionsDir = resolve("extensions");
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const mismatches: string[] = [];

  for (const entry of entries) {
    const packagePath = join(extensionsDir, entry.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name || !pkg.version) {
      continue;
    }

    if (pkg.version !== targetVersion) {
      mismatches.push(`${pkg.name} (${pkg.version})`);
    }
  }

  if (mismatches.length > 0) {
    console.error(`release-check: plugin versions must match ${targetVersion}:`);
    for (const item of mismatches) {
      console.error(`  - ${item}`);
    }
    console.error("release-check: run `pnpm plugins:sync` to align plugin versions.");
    process.exit(1);
  }
}

function checkInstallScripts() {
  try {
    execSync("node scripts/sync-install-scripts.mjs --check", { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    console.error(String((err as { stderr?: Buffer }).stderr ?? err));
    process.exit(1);
  }
}

function main() {
  checkPluginVersions();
  checkInstallScripts();

  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));

  const missing = requiredPaths.filter((path) => !paths.has(path));

  // Every compiled top-level dist/ dir must ship: the gateway imports across
  // them, so one missing dir is a crash on first run of the installed CLI.
  if (existsSync("dist")) {
    for (const entry of readdirSync("dist", { withFileTypes: true })) {
      if (!entry.isDirectory() || distDirsNotShipped.has(entry.name)) continue;
      const prefix = `dist/${entry.name}/`;
      if (![...paths].some((path) => path.startsWith(prefix))) {
        missing.push(`${prefix}** (compiled but not in package.json files[])`);
      }
    }
  }

  const forbidden = [...paths].filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
  );
  for (const path of paths) {
    const hit = forbiddenPatterns.find((entry) => entry.pattern.test(path));
    if (hit) forbidden.push(`${path} (${hit.label})`);
  }
  for (const file of files) {
    if (binaryExtensions.test(file.path) || (file.size ?? 0) > 20 * 1024 * 1024) continue;
    let text: string;
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    const match = secretPattern.exec(text);
    if (match) forbidden.push(`${file.path} (looks like a credential: ${match[0].slice(0, 12)}…)`);
  }

  const packedBytes = results.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (packedBytes > maxPackedBytes) {
    forbidden.push(
      `tarball is ${(packedBytes / 1e6).toFixed(1)} MB packed (limit ${(maxPackedBytes / 1e6).toFixed(0)} MB)`,
    );
  }

  if (missing.length > 0 || forbidden.length > 0) {
    if (missing.length > 0) {
      console.error("release-check: missing files in npm pack:");
      for (const path of missing) {
        console.error(`  - ${path}`);
      }
    }
    if (forbidden.length > 0) {
      console.error("release-check: forbidden files in npm pack:");
      for (const path of forbidden) {
        console.error(`  - ${path}`);
      }
    }
    process.exit(1);
  }

  console.log(
    `release-check: npm pack contents look OK (${files.length} files, ${(packedBytes / 1e6).toFixed(1)} MB packed).`,
  );
}

main();
