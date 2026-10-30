#!/usr/bin/env node
/**
 * Publish an Android APK so the gateway serves it on the Mobile page
 * (GET /api/mobile/apk, /api/mobile/apk/download, signed /mobile-apk/<file>).
 *
 *   node scripts/mobile-apk-publish.mjs <path-to.apk> [--state-dir DIR]
 *        [--version 1.2.3] [--version-code 12] [--package ai.x] [--notes "..."]
 *
 * Version / versionCode / package / minSdk are read from the APK with
 * `aapt2 dump badging` (INFINIBOT_AAPT2, the InfiniBot-managed SDK under
 * ~/.infinibot/android-build-tools, $ANDROID_HOME, or aapt2 on PATH). Flags
 * override or fill in when aapt2 is unavailable.
 *
 * Writes <state>/mobile/apk/infinibot-<version>.apk and latest.json.
 * Default state dir = $INFINIBOT_STATE_DIR or ~/.infinibot.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function usage(code = 1) {
  console.error(
    "usage: node scripts/mobile-apk-publish.mjs <path-to.apk> [--state-dir DIR] [--version V] [--version-code N] [--package ID] [--notes TEXT]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage(0);
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (val === undefined) usage();
      out.flags[key] = val;
    } else if (!out.apk) {
      out.apk = a;
    } else {
      usage();
    }
  }
  if (!out.apk) usage();
  return out;
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function findAapt2() {
  const candidates = [];
  if (process.env.INFINIBOT_AAPT2) candidates.push(process.env.INFINIBOT_AAPT2);
  const sdkRoots = [
    path.join(os.homedir(), ".infinibot", "android-build-tools", "android-sdk"),
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
  ].filter(Boolean);
  for (const root of sdkRoots) {
    const bt = path.join(root, "build-tools");
    let versions = [];
    try {
      versions = fs.readdirSync(bt);
    } catch {
      continue;
    }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) candidates.push(path.join(bt, v, "aapt2"));
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // next
    }
  }
  try {
    execFileSync("aapt2", ["version"], { stdio: "ignore" });
    return "aapt2";
  } catch {
    return null;
  }
}

function readBadging(apk) {
  const aapt2 = findAapt2();
  if (!aapt2) return { source: "none" };
  let out;
  try {
    out = execFileSync(aapt2, ["dump", "badging", apk], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    console.warn(`warn: aapt2 dump badging failed (${err.message.split("\n")[0]})`);
    return { source: "none" };
  }
  const pkgLine = out.split("\n").find((l) => l.startsWith("package:")) ?? "";
  const attr = (name) => new RegExp(`${name}='([^']*)'`).exec(pkgLine)?.[1];
  const sdk = /^(?:minSdkVersion|sdkVersion):'(\d+)'/m.exec(out)?.[1];
  return {
    source: aapt2,
    package: attr("name"),
    versionCode: attr("versionCode"),
    version: attr("versionName"),
    minSdk: sdk,
  };
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const { apk: apkArg, flags } = parseArgs(process.argv.slice(2));
const apk = path.resolve(expandHome(apkArg));
if (!fs.existsSync(apk) || !fs.statSync(apk).isFile()) {
  console.error(`error: APK not found: ${apk}`);
  process.exit(1);
}

const badging = readBadging(apk);
const version = (flags.version ?? badging.version ?? "").trim();
if (!version) {
  console.error("error: could not read versionName (aapt2 unavailable?) — pass --version");
  process.exit(1);
}
const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
const versionCodeRaw = flags["version-code"] ?? badging.versionCode;
const versionCode = versionCodeRaw !== undefined ? Number(versionCodeRaw) : undefined;
const minSdk = badging.minSdk !== undefined ? Number(badging.minSdk) : undefined;
const pkg = flags.package ?? badging.package;

const stateDir = path.resolve(
  expandHome(flags["state-dir"] ?? process.env.INFINIBOT_STATE_DIR?.trim() ?? path.join(os.homedir(), ".infinibot")),
);
const outDir = path.join(stateDir, "mobile", "apk");
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

const file = `infinibot-${safeVersion}.apk`;
const dest = path.join(outDir, file);
const tmp = `${dest}.tmp-${process.pid}`;
fs.copyFileSync(apk, tmp);
fs.renameSync(tmp, dest);

const size = fs.statSync(dest).size;
const digest = sha256(dest);
if (digest !== sha256(apk)) {
  console.error("error: copied file hash mismatch");
  process.exit(1);
}

const manifest = {
  version,
  ...(Number.isFinite(versionCode) ? { versionCode } : {}),
  buildDate: new Date(fs.statSync(apk).mtimeMs).toISOString(),
  size,
  sha256: digest,
  file,
  ...(pkg ? { package: pkg } : {}),
  ...(Number.isFinite(minSdk) ? { minSdk } : {}),
  ...(flags.notes ? { notes: flags.notes } : {}),
};
const manifestPath = path.join(outDir, "latest.json");
const manifestTmp = `${manifestPath}.tmp-${process.pid}`;
fs.writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`);
fs.renameSync(manifestTmp, manifestPath);

console.log(`published ${file} (${(size / 1024 / 1024).toFixed(1)} MB) → ${outDir}`);
console.log(`  metadata source: ${badging.source === "none" ? "flags" : badging.source}`);
console.log(JSON.stringify(manifest, null, 2));
