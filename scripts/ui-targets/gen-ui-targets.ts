/**
 * Write the static UI target dump (src/ui-targets/ui-targets.json): every
 * target a stock install can have — navigation, curated controls, ALL
 * first-party plugin manifests (as if enabled), core + plugin Learn anchors
 * and core setup checks. Consumers that can't call the gateway (docs
 * generators, InfiniBot self-knowledge) read this file.
 *
 *   node --import tsx scripts/ui-targets/gen-ui-targets.ts [--check]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { coreSetupChecks } from "../../src/gateway/setup-status/core-checks.js";
import { CORE_TRACKS } from "../../src/learn/guided/core/index.js";
import { buildUiTargets } from "../../src/ui-targets/registry.js";
import type { LearnTrackInput, PluginTargetInput, SetupCheckInput } from "../../src/ui-targets/derive.js";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "src/ui-targets/ui-targets.json");

/** Core setup checks, as definitions (never evaluated here). */
function coreSetupCheckInputs(): SetupCheckInput[] {
  return coreSetupChecks().map((c) => ({ id: c.id, title: c.title, tabs: c.tabs, action: c.action, localOnly: c.localOnly, source: "core" }));
}

export function collectStaticSources() {
  const plugins: PluginTargetInput[] = [];
  const learnTracks: LearnTrackInput[] = [...(CORE_TRACKS as unknown as LearnTrackInput[])];
  const extDir = join(ROOT, "extensions");
  for (const dir of readdirSync(extDir).sort()) {
    const mf = join(extDir, dir, "infinibot.plugin.json");
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8")) as PluginTargetInput & { manifestVersion?: number; contributes?: { learn?: string } & PluginTargetInput["contributes"] };
    if (m.manifestVersion !== 2) continue;
    plugins.push({ id: m.id, name: m.name, description: m.description, listing: m.listing, contributes: m.contributes });
    const learnRel = (m.contributes as { learn?: unknown } | undefined)?.learn;
    if (typeof learnRel === "string" && existsSync(join(extDir, dir, learnRel))) {
      const l = JSON.parse(readFileSync(join(extDir, dir, learnRel), "utf8")) as { tracks?: LearnTrackInput[] };
      for (const t of l.tracks ?? []) learnTracks.push({ ...t, pluginId: m.id });
    }
  }
  return { plugins, learnTracks, setupChecks: coreSetupCheckInputs() };
}

export function renderDump(): string {
  const targets = buildUiTargets(collectStaticSources());
  const counts: Record<string, number> = {};
  for (const t of targets) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
  return `${JSON.stringify({ version: 1, generatedBy: "scripts/ui-targets/gen-ui-targets.ts", total: targets.length, counts, targets }, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const body = renderDump();
  if (process.argv.includes("--check")) {
    const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "null";
    // Structural compare: the repo formatter may re-wrap the committed JSON.
    if (JSON.stringify(JSON.parse(cur)) !== JSON.stringify(JSON.parse(body))) {
      console.error("src/ui-targets/ui-targets.json is stale — run: pnpm ui-targets:gen");
      process.exit(1);
    }
    console.log("ui-targets.json up to date");
  } else {
    writeFileSync(OUT, body);
    const n = (JSON.parse(body) as { total: number }).total;
    console.log(`wrote ${OUT} (${n} targets)`);
  }
}
