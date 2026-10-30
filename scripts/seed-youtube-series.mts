#!/usr/bin/env node
/**
 * Seed the Iam.YungCEO YouTube page and the "InfiniBot: Your AI Team"
 * Season 1 series (episodes 0–13 at Outlined + Bonus/Season 2 ideas), linked
 * both ways to the @iam.yungceo Instagram page. Idempotent; see
 * src/content/seed-youtube-series.ts for exactly what it touches.
 *
 * Usage (node 22):
 *   node --import tsx scripts/seed-youtube-series.mts --state-dir <dir> [--youtube-handle @x]
 *
 * Writes only <state-dir>/databases.db. Never opens content-intel.db.
 */

import fs from "node:fs";
import path from "node:path";

import { seedYoutubeSeries } from "../src/content/seed-youtube-series.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const stateDirArg = arg("--state-dir");
if (!stateDirArg) {
  console.error("usage: seed-youtube-series.mts --state-dir <dir> [--youtube-handle @handle]");
  process.exit(2);
}
const stateDir = path.resolve(stateDirArg);
if (!fs.existsSync(path.join(stateDir, "databases.db"))) {
  console.error(`no databases.db in ${stateDir} — refusing to create a new one`);
  process.exit(2);
}

const report = seedYoutubeSeries({ stateDir, youtubeHandle: arg("--youtube-handle") });
console.log(JSON.stringify(report, null, 2));
