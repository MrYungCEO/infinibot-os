/**
 * Generate InfiniBot's self-knowledge snapshot from the codebase.
 *
 *   node --import tsx scripts/gen-infinibot-knowledge.ts          # write
 *   node --import tsx scripts/gen-infinibot-knowledge.ts --check  # exit 1 if stale
 *
 * Reads navigation.ts (sidebar groups, sub-tabs, routes, titles), the Setup
 * page's section nav, core setup-status checks, every plugin manifest and its
 * learn.json, the core Learn tracks and docs/.
 * Writes:
 *   src/infinibot-knowledge/generated/core-knowledge.generated.ts  (runtime data)
 *   docs/reference/infinibot-knowledge.md                           (digest)
 *
 * Runs as part of `pnpm build` (before tsc). The gateway refreshes plugin
 * entries from the live plugin registry at runtime (runtime.ts).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSnapshot, type BuildInputs, type DocInput, type LearnTrackInput } from "../src/infinibot-knowledge/build.js";
import { renderDigest } from "../src/infinibot-knowledge/digest.js";
import type { PluginManifestLike } from "../src/infinibot-knowledge/plugins.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_TS = path.join(ROOT, "src/infinibot-knowledge/generated/core-knowledge.generated.ts");
const OUT_MD = path.join(ROOT, "docs/reference/infinibot-knowledge.md");
const DOC_DIRS = ["docs/plugins", "docs/autonomy", "docs/saas", "docs/features", "docs/start", "docs/help"];
const DOC_FILES = ["docs/gateway/setup-status.md", "docs/tools/subagents.md", "docs/tts.md"];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** `const NAME: … = { … };` object literal of string arrays → value. */
function extractLiteral(src: string, name: string): Record<string, string[]> {
  const start = src.indexOf(`const ${name}`);
  if (start < 0) return {};
  const open = src.indexOf("{", src.indexOf("=", start));
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  // Literal of string arrays only — safe to evaluate.
  return new Function(`return (${src.slice(open, end + 1)});`)() as Record<string, string[]>;
}

function setupSections(src: string): { id: string; label: string; desc?: string }[] {
  const out: { id: string; label: string; desc?: string }[] = [];
  const nav = src.slice(src.indexOf('<div class="setup-nav">'), src.indexOf('<div class="setup-content">'));
  const parts = nav.split("handleSectionChange('").slice(1);
  for (const part of parts) {
    const id = part.slice(0, part.indexOf("'"));
    const label = part.match(/class="nav-title"[^>]*>([^<]+)</)?.[1]?.trim();
    const desc = part.match(/class="nav-desc"[^>]*>([^<]+)</)?.[1]?.trim();
    if (id && !out.some((s) => s.id === id)) out.push({ id, label: label ?? id.replace(/(^|-)(\w)/g, (_, a, b) => `${a ? " " : ""}${b.toUpperCase()}`), desc });
  }
  return out;
}

function listMd(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.mdx?$/.test(e.name)) out.push(path.relative(ROOT, p));
    }
  };
  walk(abs);
  return out.sort();
}

function docInput(rel: string): DocInput | null {
  const text = read(rel).replace(/^---[\s\S]*?---\s*/, "");
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(rel);
  const body = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("```") && !p.startsWith("|") && !p.startsWith("<") && !p.startsWith(">") && !p.startsWith("!["));
  const headings = [...text.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim());
  return { path: rel, title, summary: (body ?? "").replace(/\s+/g, " ").slice(0, 400), headings };
}

async function main() {
  const check = process.argv.includes("--check");
  // Builds without the UI sources (the fleet gateway image ships no ui/src —
  // Netlify serves the UI) use the committed snapshot as-is.
  if (!fs.existsSync(path.join(ROOT, "ui/src/ui/navigation.ts"))) {
    if (!fs.existsSync(OUT_TS)) throw new Error(`[knowledge] no ui/src and no committed snapshot at ${OUT_TS}`);
    console.log("[knowledge] ui/src not present — using the committed snapshot");
    return;
  }
  const nav = await import(pathToFileURL(path.join(ROOT, "ui/src/ui/navigation.ts")).href);
  const host = await import(pathToFileURL(path.join(ROOT, "ui/src/ui/plugin-host.ts")).href);
  const navSrc = read("ui/src/ui/navigation.ts");
  const busSrc = read("ui/src/ui/control-bus-app-views.ts");
  const setupSrc = read("ui/src/ui/views/setup.ts");

  const { coreSetupChecks } = await import("../src/gateway/setup-status/core-checks.js");
  const checks = coreSetupChecks().map((c) => ({ id: c.id, title: c.title, tabs: c.tabs, localOnly: c.localOnly, action: c.action }));

  // Plugin manifests (+ learn.json).
  const plugins: PluginManifestLike[] = [];
  const learn: LearnTrackInput[] = [];
  for (const dir of fs.readdirSync(path.join(ROOT, "extensions")).sort()) {
    const mf = path.join("extensions", dir, "infinibot.plugin.json");
    if (!fs.existsSync(path.join(ROOT, mf))) continue;
    const raw = read(mf);
    const m = JSON.parse(raw) as PluginManifestLike & { contributes?: { learn?: string } };
    plugins.push(m);
    const learnRel = typeof m.contributes?.learn === "string" ? path.join("extensions", dir, m.contributes.learn) : null;
    if (learnRel && fs.existsSync(path.join(ROOT, learnRel))) {
      const lraw = read(learnRel);
      for (const t of (JSON.parse(lraw).tracks ?? []) as LearnTrackInput[]) learn.push({ ...t, pluginId: m.id });
    }
  }

  const { CORE_TRACKS } = await import("../src/learn/guided/core/index.js");
  for (const t of CORE_TRACKS as LearnTrackInput[]) learn.unshift(t);

  const docs = [...DOC_DIRS.flatMap(listMd), ...DOC_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)))]
    .map(docInput)
    .filter((d): d is DocInput => !!d);

  // Core agent tools are NOT snapshotted: their list depends on config/env.
  // infinibot_help reads the live tool list + allowlist at runtime instead.

  // Status pill labels of a plugin card (views/plugins/model.ts cardStatus).
  const modelSrc = read("ui/src/ui/views/plugins/model.ts");
  const cardFn = modelSrc.slice(modelSrc.indexOf("export function cardStatus"), modelSrc.indexOf("export type PrimaryAction"));
  const pluginCardStatuses = [...cardFn.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);

  const inputs: BuildInputs = {
    nav: {
      groups: nav.TAB_GROUPS,
      retired: nav.RETIRED_TABS,
      hidden: nav.HIDDEN_TABS,
      redirects: nav.TAB_REDIRECTS,
      subviews: nav.HOST_SUBVIEWS,
      paths: nav.TAB_PATHS,
      title: nav.titleForTab,
      subtitle: nav.subtitleForTab,
      navLabel: nav.navLabelForTab,
      searchTerms: nav.navSearchTermsForTab,
      synonyms: extractLiteral(busSrc, "TAB_SYNONYMS"),
      gatedTabs: new Set(Object.values(host.FIRST_PARTY_PAGES as Record<string, string>)),
    },
    setupSections: setupSections(setupSrc),
    setupChecks: checks,
    learn,
    docs,
    plugins,
    pluginCardStatuses,
    inputsHash: "",
  };
  const draft = buildSnapshot(inputs);
  // Content hash of the extracted knowledge (formatting-insensitive).
  inputs.inputsHash = crypto.createHash("sha1").update(JSON.stringify(draft.entries)).digest("hex").slice(0, 16);
  const snap = { ...draft, inputsHash: inputs.inputsHash };
  // Same shape the repo formatter (oxfmt) produces, so a commit hook doesn't churn it.
  const json = JSON.stringify(snap).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const ts = [
    "// GENERATED by scripts/gen-infinibot-knowledge.ts — do not edit.",
    "// Regenerate: node --import tsx scripts/gen-infinibot-knowledge.ts",
    'import type { KnowledgeSnapshot } from "../types.js";',
    "",
    "export const CORE_KNOWLEDGE: KnowledgeSnapshot = JSON.parse(",
    `  '${json}',`,
    ");",
    "",
  ].join("\n");
  const md = renderDigest(snap);

  if (check) {
    // Semantic comparison: formatting of the committed files doesn't matter.
    let current: unknown = null;
    try {
      current = (await import(pathToFileURL(OUT_TS).href)).CORE_KNOWLEDGE;
    } catch {
      current = null;
    }
    if (JSON.stringify(current) !== JSON.stringify(snap)) {
      console.error("[knowledge] snapshot is stale — run: node --import tsx scripts/gen-infinibot-knowledge.ts");
      process.exit(1);
    }
    console.log(`[knowledge] up to date (${snap.entries.length} entries, ${snap.inputsHash})`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT_TS), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_TS, ts);
  fs.writeFileSync(OUT_MD, md);
  console.log(`[knowledge] ${snap.entries.length} entries ${JSON.stringify(snap.counts)} → ${path.relative(ROOT, OUT_TS)}, ${path.relative(ROOT, OUT_MD)}`);
}

await main();
// Imported modules (config, plugin hosts) may leave handles open.
process.exit(0);
