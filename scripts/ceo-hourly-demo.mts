/**
 * Standalone real-data run of the CEO hourly insights kind.
 * Usage: node_modules/.bin/tsx scripts/ceo-hourly-demo.mts [windowMinutes]
 *
 * Exercises collectCeoActivity() against live ~/.infinibot data, spawns the CEO
 * agent via the claude CLI, prints the snapshot + parsed insights + themed HTML.
 * Not shipped — a demonstration/verification harness for the cron manual path.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  collectCeoActivity,
  snapshotToText,
  generateCeoInsights,
  renderCeoHourlyHtml,
  cliCeoAgentSpawner,
} from "../src/reports/kinds/ceo-hourly.js";
import type { Theme } from "../src/reports/types.js";

const BLACK_GOLD: Theme = {
  name: "black-gold",
  label: "Black & Gold",
  tokens: {
    bg: "#0a0a0a",
    surface: "#141414",
    surfaceAlt: "#1d1d1d",
    border: "#2a2a2a",
    text: "#e8e2d0",
    textMuted: "#8a8470",
    accent: "#d4af37",
    accentStrong: "#b8860b",
    fontHeading: "'JetBrains Mono', monospace",
    fontBody: "'Inter', system-ui, sans-serif",
    statusPills: {
      low: { fg: "#9ad", bg: "#16202a" },
      medium: { fg: "#d4af37", bg: "#241f10" },
      high: { fg: "#f0a020", bg: "#2a1d08" },
      critical: { fg: "#f85149", bg: "#2a1010" },
    },
  },
};

const windowMin = Number(process.argv[2] ?? 60);
const windowMs = windowMin * 60_000;
const now = Date.now();

console.error(`\n=== Collecting last ${windowMin} min of activity ===`);
const snapshot = collectCeoActivity({ now, windowMs });
console.error(snapshotToText(snapshot));

console.error(`\n=== Spawning CEO agent (claude CLI) ===`);
const { insights, rawModelOutput } = await generateCeoInsights({
  now,
  windowMs,
  spawner: cliCeoAgentSpawner,
});

console.error(`\n=== Parsed ${insights.length} insights ===`);
console.log(JSON.stringify({ insights }, null, 2));

const html = renderCeoHourlyHtml({ theme: BLACK_GOLD, insights, snapshot, generatedAtMs: now });
const outDir = join(homedir(), ".infinibot", "reports");
try {
  writeFileSync(join(outDir, "ceo-hourly-demo.html"), html);
  console.error(`\nHTML written: ${join(outDir, "ceo-hourly-demo.html")}`);
} catch {
  const fallback = "/tmp/ceo-hourly-demo.html";
  writeFileSync(fallback, html);
  console.error(`\nHTML written: ${fallback}`);
}
console.error(`Raw model output length: ${rawModelOutput.length} chars`);
