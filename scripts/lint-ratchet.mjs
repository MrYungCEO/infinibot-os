#!/usr/bin/env node
// Lint ratchet: run oxlint over src + test and fail only on violations that
// are not in the committed baseline (.oxlint-baseline.json).
//
// Why: the type-aware correctness rules report several hundred long-standing
// errors across the tree. Fixing them all in one go is a large, risky change,
// and failing every PR on them makes the Lint check useless. The baseline
// records the known count per file + rule; anything above it is new and fails.
// The baseline may only shrink: when a file gets cleaner, run
// `pnpm lint:baseline` and commit the smaller file.
//
//   pnpm lint            fail on new violations only
//   pnpm lint:baseline   rewrite the baseline from the current tree
//   pnpm lint:full       plain oxlint, every violation (baseline ignored)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, ".oxlint-baseline.json");
const update = process.argv.includes("--update");

const run = spawnSync("oxlint", ["--type-aware", "-f", "json", "src", "test"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  shell: process.platform === "win32",
});
if (run.error) {
  console.error(`lint-ratchet: could not run oxlint: ${run.error.message}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error("lint-ratchet: oxlint did not return JSON");
  console.error(run.stdout.slice(0, 2000));
  console.error(run.stderr.slice(0, 2000));
  process.exit(2);
}

const diagnostics = report.diagnostics.filter((d) => d.severity === "error");
const key = (d) => `${d.filename.split(path.sep).join("/")}|${d.code}`;

const current = {};
for (const d of diagnostics) current[key(d)] = (current[key(d)] ?? 0) + 1;

if (update) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(
    `lint-ratchet: baseline written (${diagnostics.length} known violations, ${Object.keys(sorted).length} file+rule entries)`,
  );
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch {
  // No baseline: every violation counts as new.
}

const over = Object.entries(current).filter(([k, n]) => n > (baseline[k] ?? 0));
const stale = Object.entries(baseline).filter(([k, n]) => (current[k] ?? 0) < n);
const known = diagnostics.length;

if (over.length === 0) {
  console.log(
    `lint-ratchet: no new violations (${known} known in baseline, ${report.number_of_files} files checked)`,
  );
  if (stale.length > 0) {
    console.log(
      `lint-ratchet: ${stale.length} baseline entries can shrink; run \`pnpm lint:baseline\` and commit it.`,
    );
  }
  process.exit(0);
}

const overKeys = new Map(over);
console.error(`lint-ratchet: new violations in ${over.length} file+rule group(s):\n`);
for (const d of diagnostics) {
  const k = key(d);
  if (!overKeys.has(k)) continue;
  const span = d.labels?.[0]?.span;
  const where = span ? `${d.filename}:${span.line}:${span.column}` : d.filename;
  console.error(`${where}: ${d.code}: ${d.message}`);
}
console.error("");
for (const [k, n] of over) {
  const [file, rule] = k.split("|");
  console.error(`  ${file}: ${rule} ${baseline[k] ?? 0} -> ${n}`);
}
console.error(
  "\nA group lists all of its violations because the baseline stores counts, not positions. Fix the new ones; do not raise the baseline.",
);
process.exit(1);
