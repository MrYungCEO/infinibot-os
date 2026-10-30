#!/usr/bin/env node
// Checks that InfiniBot's own manifests and LICENSE agree on FSL-1.1-ALv2.
// Third-party packages vendored in the tree are listed in THIRD_PARTY_ALLOW.
// Example plugins meant to be copied into other people's projects carry their
// own permissive LICENSE file and are listed in EXAMPLE_ALLOW with the license
// that LICENSE file grants. Manifests under test/ and fixtures/ directories are
// test scaffolding (e.g. a bare {"type":"commonjs"} marker for a fake binary),
// never published, and are skipped.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EXPECTED = "FSL-1.1-ALv2";
const THIRD_PARTY_ALLOW = new Set(["skills/moltbook/package.json"]);
const EXAMPLE_ALLOW = new Map([["examples/plugin-hello/package.json", "MIT"]]);
const TEST_DIR = /(^|\/)(test|tests|__tests__|fixtures)\//;

const problems = [];

const license = readFileSync("LICENSE", "utf8");
if (!license.startsWith("# Functional Source License, Version 1.1, ALv2 Future License")) {
  problems.push("LICENSE is not the FSL-1.1-ALv2 text");
}
const notice = readFileSync("NOTICE", "utf8");
if (!notice.includes("Copyright (c) 2025 Peter Steinberger")) {
  problems.push("NOTICE is missing the upstream MIT copyright notice");
}

const manifests = execFileSync("git", ["ls-files", "*package.json"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.includes("node_modules/") && !TEST_DIR.test(f));
for (const file of manifests) {
  if (THIRD_PARTY_ALLOW.has(file)) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  const expected = EXAMPLE_ALLOW.get(file) ?? EXPECTED;
  if (pkg.license !== expected) {
    problems.push(`${file}: "license" is ${JSON.stringify(pkg.license)}, expected "${expected}"`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`license-fields: ${p}`);
  process.exit(1);
}
console.log(`license-fields: OK (${manifests.length} manifests checked)`);
