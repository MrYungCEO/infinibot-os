#!/usr/bin/env node
// The installers are authored once in scripts/install-infinibot.{sh,ps1} and
// served from several places. This copies them to every served location, or
// with --check fails when a copy has drifted.
//
//   docs/install.{sh,ps1}                    -> https://infinibotos.com/install.{sh,ps1} (Netlify, publish dir = docs/)
//   install-scripts-static/install.{sh,ps1}  -> optional standalone static host
//   (the gateway serves scripts/install-infinibot.* directly at /install.sh and /install.ps1)

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const targets = {
  "scripts/install-infinibot.sh": ["docs/install.sh", "install-scripts-static/install.sh"],
  "scripts/install-infinibot.ps1": ["docs/install.ps1", "install-scripts-static/install.ps1"],
};

const drifted = [];
for (const [source, copies] of Object.entries(targets)) {
  const sourcePath = resolve(root, source);
  const wanted = readFileSync(sourcePath);
  for (const copy of copies) {
    const copyPath = resolve(root, copy);
    const same = existsSync(copyPath) && readFileSync(copyPath).equals(wanted);
    if (same) continue;
    if (check) {
      drifted.push(`${copy} (source: ${source})`);
    } else {
      copyFileSync(sourcePath, copyPath);
      console.log(`synced ${copy}`);
    }
  }
}

if (drifted.length > 0) {
  console.error("install scripts out of sync:");
  for (const item of drifted) console.error(`  - ${item}`);
  console.error("run `pnpm install-scripts:sync` and commit the result.");
  process.exit(1);
}
if (check) console.log("install scripts in sync.");
