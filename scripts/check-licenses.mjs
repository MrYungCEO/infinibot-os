#!/usr/bin/env node
/**
 * InfiniBot production dependency license gate.
 *
 * Usage:
 *   node /path/to/check-licenses.mjs
 *   node /path/to/check-licenses.mjs --repo /path/to/repository
 *
 * It checks pnpm production dependencies plus mobile/electron npm lockfiles.
 * The gate is allowlist-based: unknown/custom/copyleft licenses fail; licenses
 * with redistribution conditions (MPL/LGPL/EPL/CC-BY) pass with warnings.
 * It also catches the currently unpinned Python requirements that are known to
 * resolve to disallowed components. Pin Python dependencies and extend this
 * script to consume a deterministic Python lock before treating that ecosystem
 * as completely gated.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function parseRepoArg(argv) {
  const index = argv.indexOf("--repo");
  if (index === -1) return path.resolve(process.cwd());
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    console.error("Usage: check-licenses.mjs [--repo /path/to/repository]");
    process.exit(2);
  }
  return path.resolve(value);
}

const repo = parseRepoArg(process.argv.slice(2));
const failures = [];
const warnings = [];

if (!fs.existsSync(path.join(repo, "package.json")) || !fs.existsSync(path.join(repo, "pnpm-lock.yaml"))) {
  console.error(`Repository root is invalid or lacks package.json/pnpm-lock.yaml: ${repo}`);
  process.exit(2);
}

const resolvedUnknowns = new Map([
  ["@hyperframes/core@0.6.63", "Apache-2.0"],
  ["@hyperframes/engine@0.6.63", "Apache-2.0"],
  ["@hyperframes/producer@0.6.63", "Apache-2.0"],
  ["@mistralai/mistralai@1.10.0", "Apache-2.0"],
  ["@react-three/rapier@2.2.0", "MIT"],
  ["khroma@2.1.0", "MIT"],
  ["qrcode-terminal@0.11.0", "Apache-2.0"],
  ["requireg@0.2.2", "MIT"],
]);

const aliases = new Map([
  ["Apache 2.0", "Apache-2.0"],
  ["Apache License 2.0", "Apache-2.0"],
  ["MIT OR Apache", "MIT OR Apache-2.0"],
]);

const allowed = /^(?:MIT(?:-0|-CMU)?|BSD-[23]-Clause|ISC|Apache-2\.0|0BSD|Unlicense|CC0-1\.0|OFL-1\.1|Python-2\.0|PSF-2\.0|BlueOak-1\.0\.0|Zlib|WTFPL|AFL-2\.1)$/i;
const conditional = /LGPL|MPL|EPL|CC-BY(?:-|$)|Beerware|EUPL/i;
const disallowed = /AGPL|SSPL|GPL|CC-BY-NC|LicenseRef|UNKNOWN|UNLICENSED|Standard 'no charge'/i;

function atomStatus(atom) {
  const value = atom.replace(/[()]/g, "").trim();
  if (allowed.test(value)) return "allow";
  if (conditional.test(value)) return "warn";
  if (disallowed.test(value)) return "fail";
  return "fail";
}

function expressionStatus(raw) {
  const value = aliases.get(String(raw).trim()) ?? String(raw).trim();
  if (/\s+OR\s+/i.test(value)) {
    const options = value.split(/\s+OR\s+/i).map(atomStatus);
    if (options.includes("allow")) return "allow";
    if (options.includes("warn")) return "warn";
    return "fail";
  }
  if (/\s+AND\s+/i.test(value)) {
    const requirements = value.split(/\s+AND\s+/i).map(atomStatus);
    if (requirements.includes("fail")) return "fail";
    if (requirements.includes("warn")) return "warn";
    return "allow";
  }
  return atomStatus(value);
}

function check(name, version, declared, source) {
  const key = `${name}@${version}`;
  const license = resolvedUnknowns.get(key) ?? declared ?? "UNKNOWN";
  const status = expressionStatus(license);
  const message = `${key}: ${license} (${source})`;
  if (status === "fail") failures.push(message);
  if (status === "warn") warnings.push(message);
}

function runPnpm() {
  let output;
  try {
    output = execFileSync("pnpm", ["--config.engine-strict=false", "licenses", "list", "--prod", "--json"], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 200 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    failures.push(`pnpm production scan could not run: ${error.message}`);
    return;
  }
  const grouped = JSON.parse(output);
  for (const [groupLicense, packages] of Object.entries(grouped)) {
    if (!Array.isArray(packages)) continue;
    for (const pkg of packages) {
      for (const version of pkg.versions ?? [""]) {
        check(pkg.name, version, pkg.license ?? groupLicense, "pnpm-lock.yaml");
      }
    }
  }
}

function checkNpmLock(relativePath) {
  const file = path.join(repo, relativePath);
  if (!fs.existsSync(file)) return;
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [packagePath, pkg] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || pkg.dev) continue;
    const name = pkg.name ?? packagePath.split("node_modules/").at(-1);
    check(name, pkg.version ?? "UNKNOWN", pkg.license ?? "UNKNOWN", relativePath);
  }
}

function checkKnownPythonBlockers() {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^requirements.*\.txt$/i.test(entry.name)) files.push(full);
    }
  };
  walk(repo);
  for (const file of files) {
    const relative = path.relative(repo, file);
    const text = fs.readFileSync(file, "utf8");
    if (/^\s*gallery-dl\b/im.test(text)) {
      failures.push(`gallery-dl: GPL-2.0-only (${relative})`);
    }
    if (/^\s*livekit-agents\s*>?=/im.test(text)) {
      failures.push(`livekit-agents is unpinned and currently resolves livekit-local-inference under the restrictive LiveKit Model License (${relative})`);
    }
  }
}

runPnpm();
checkNpmLock("mobile/package-lock.json");
checkNpmLock("electron/package-lock.json");
checkKnownPythonBlockers();

for (const message of [...new Set(warnings)].sort()) console.warn(`WARN conditional license: ${message}`);
for (const message of [...new Set(failures)].sort()) console.error(`FAIL disallowed license: ${message}`);

const uniqueFailures = new Set(failures).size;
const uniqueWarnings = new Set(warnings).size;
console.log(`License gate: ${uniqueFailures} failure(s), ${uniqueWarnings} conditional warning(s).`);
process.exitCode = uniqueFailures ? 1 : 0;
