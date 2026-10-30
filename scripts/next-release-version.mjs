#!/usr/bin/env node
// Picks the version the publish workflow should release.
//
// Calver: YYYY.M.PATCH (month not zero-padded; PATCH restarts at 0 each month).
//
// The result can never collide with a version already on npm:
//   1. base = max(npm `latest`, package.json version)
//   2. if package.json is ahead of npm and belongs to the current month, it was
//      bumped on purpose and is used as-is; otherwise the next patch after
//      `base` is taken (or YYYY.M.0 when the month rolled over)
//   3. the candidate is then advanced until npm has no such version (covers
//      versions published under another dist-tag, or unpublished ones, which
//      npm refuses to reuse)
//
// Usage: node scripts/next-release-version.mjs [--json]
// Test hooks: NEXT_VERSION_NOW=2026-10-01, NEXT_VERSION_PUBLISHED='["2026.6.29"]',
//             NEXT_VERSION_LATEST=2026.6.29, NEXT_VERSION_LOCAL=2026.10.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m) throw new Error(`Not a calver version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compare(a, b) {
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function nextVersion({ local, latest, published, now }) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const taken = new Set(published);
  const base = latest && compare(latest, local) > 0 ? latest : local;
  const [by, bm, bp] = parse(base);

  // Same month (or a base that is somehow ahead of the clock: never go
  // backwards) keeps counting in the base's month; an older base starts the
  // current month at .0.
  const baseIsCurrent = by > year || (by === year && bm >= month);
  const keepLocal = base === local && !taken.has(local);
  const candidate = !baseIsCurrent ? [year, month, 0] : keepLocal ? [by, bm, bp] : [by, bm, bp + 1];
  while (taken.has(candidate.join("."))) candidate[2] += 1;
  return candidate.join(".");
}

function npmView(field) {
  try {
    const out = execFileSync("npm", ["view", pkg.name, field, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out ? JSON.parse(out) : null;
  } catch (err) {
    // A package that was never published is the only acceptable "not found".
    if (String(err.stderr ?? "").includes("E404")) return null;
    throw new Error(`npm view ${pkg.name} ${field} failed: ${String(err.stderr ?? err.message).trim()}`);
  }
}

function main() {
  const env = process.env;
  const local = env.NEXT_VERSION_LOCAL ?? pkg.version;
  const latest = env.NEXT_VERSION_LATEST ?? npmView("dist-tags.latest");
  const rawPublished = env.NEXT_VERSION_PUBLISHED
    ? JSON.parse(env.NEXT_VERSION_PUBLISHED)
    : npmView("versions");
  const published = rawPublished == null ? [] : [rawPublished].flat();
  const now = env.NEXT_VERSION_NOW ? new Date(env.NEXT_VERSION_NOW) : new Date();
  const next = nextVersion({ local, latest, published, now });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ local, latest, next, publishedCount: published.length }));
  } else {
    console.log(next);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
