/**
 * Local mock of the plugin marketplace registry (docs/plugins/registry-api.md).
 *
 *   node --import tsx scripts/plugins-mock-registry.ts [options] <plugin-dir-or-zip>...
 *
 * Each argument is a plugin folder (packed on the fly) or a package zip.
 * Several versions of the same plugin id become that plugin's version list.
 *
 * Options:
 *   --port <n>             Port to listen on (default 4010)
 *   --first-party <id>     Mark a plugin as first-party (repeatable)
 *   --paid <id>=<cents>    Make a plugin paid (repeatable), e.g. --paid pro-tool=2900
 *   --token <id>=<token>   An entitlement token that unlocks a paid plugin (repeatable)
 *   --purchase-url <id>=<url>
 *   --changelog <id>@<version>=<text>
 *   --help
 */
import fs from "node:fs";
import path from "node:path";

import { PACKAGE_MANIFEST } from "../src/plugins/packages/format.js";
import { startMockRegistry, type MockPlugin } from "../src/plugins/packages/mock-registry.js";
import { buildPackageZip, collectPackFiles, validatePluginDir } from "../src/plugins/packages/pack.js";
import { openPluginZip } from "../src/plugins/packages/zip-read.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  const source = fs.readFileSync(new URL(import.meta.url), "utf-8");
  console.log(source.slice(source.indexOf("/**") + 3, source.indexOf("*/")).replace(/^ \* ?/gm, ""));
  process.exit(0);
}

let port = 4010;
const firstParty = new Set<string>();
const paid = new Map<string, number>();
const tokens = new Map<string, string[]>();
const purchaseUrls = new Map<string, string>();
const changelogs = new Map<string, string>();
const targets: string[] = [];

const pair = (value: string | undefined, flag: string): [string, string] => {
  const i = value?.indexOf("=") ?? -1;
  if (!value || i <= 0) fail(`${flag} expects <id>=<value>`);
  return [value.slice(0, i), value.slice(i + 1)];
};

for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a === "--port") port = Number(args[++i]);
  else if (a === "--first-party") firstParty.add(args[++i] as string);
  else if (a === "--paid") {
    const [id, cents] = pair(args[++i], a);
    paid.set(id, Number(cents));
  } else if (a === "--token") {
    const [id, key] = pair(args[++i], a);
    tokens.set(id, [...(tokens.get(id) ?? []), key]);
  } else if (a === "--purchase-url") {
    const [id, url] = pair(args[++i], a);
    purchaseUrls.set(id, url);
  } else if (a === "--changelog") {
    const [key, text] = pair(args[++i], a);
    changelogs.set(key, text);
  } else if (a.startsWith("--")) fail(`unknown option ${a}`);
  else targets.push(a);
}
if (!Number.isInteger(port) || port <= 0) fail("--port expects a port number");
if (targets.length === 0) fail("give at least one plugin folder or package zip");

const byId = new Map<string, MockPlugin>();
for (const target of targets) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) fail(`not found: ${abs}`);
  let zip: Buffer;
  if (fs.statSync(abs).isDirectory()) {
    const report = validatePluginDir(abs);
    if (!report.ok) fail(`${target}: ${report.errors.join("; ")}`);
    zip = await buildPackageZip(collectPackFiles(abs));
  } else {
    zip = fs.readFileSync(abs);
  }
  const opened = await openPluginZip(zip);
  const manifest = JSON.parse((await opened.read(PACKAGE_MANIFEST)).toString("utf-8")) as {
    id: string;
    version: string;
    listing?: { category?: string; tags?: string[] };
  };
  const id = manifest.id;
  const plugin: MockPlugin = byId.get(id) ?? {
    releases: [],
    firstParty: firstParty.has(id),
    verified: firstParty.has(id),
    category: manifest.listing?.category,
    tags: manifest.listing?.tags,
    ...(paid.has(id)
      ? {
          pricing: {
            model: "paid" as const,
            priceCents: paid.get(id),
            purchaseUrl: purchaseUrls.get(id) ?? `https://example.com/buy/${id}`,
          },
          tokens: tokens.get(id) ?? [],
        }
      : {}),
  };
  plugin.releases.push({
    zip,
    changelog: changelogs.get(`${id}@${manifest.version}`) ?? "",
    releasedAt: new Date().toISOString(),
  });
  byId.set(id, plugin);
  console.log(`  ${id} ${manifest.version}  sha256 ${opened.sha256}`);
}

const registry = await startMockRegistry([...byId.values()], { port });
console.log(`mock plugin registry on ${registry.url}`);
console.log(`  INFINIBOT_PLUGIN_REGISTRY_URL=${registry.url}`);
