#!/usr/bin/env node
// Package every first-party plugin in extensions/ into a deterministic, versioned
// zip for the cloud marketplace, and (optionally) publish them.
//
//   node scripts/package-first-party-plugins.mjs                 # dry run → dist/plugin-packages/
//   node scripts/package-first-party-plugins.mjs --out <dir> --only flypic,robovoice
//   node scripts/package-first-party-plugins.mjs --root <checkout>   # pack <checkout>/extensions instead
//   MARKETPLACE_DATABASE_URL=postgres://… node \
//     scripts/package-first-party-plugins.mjs --publish [--yes]  # upload + upsert as firstParty
//
// What is packaged: every extensions/<dir> whose infinibot.plugin.json is a v2
// manifest with a `listing` block. Channel adapters (a `channels` list, or listing
// category "channels") and v1 manifests are skipped.
//
// There is ONE packer: src/plugins/packages/pack.ts, the same code behind
// `infinibot plugins pack` and `infinibot plugins validate`. This script only
// chooses which folders to pack and what a first-party build leaves out
// (FIRST_PARTY_IGNORE below). A plugin that fails pack validation fails the run.
// The packer is TypeScript; when this script runs under plain `node` it loads it
// through tsx (a dev dependency), so no flag is needed.
//
// Zip layout (the same one a publisher uploads, and what `infinibot plugins install`
// expects): the manifest at the zip root, then the plugin's files.
//
// Deterministic: entries are sorted, timestamps are fixed (1980-01-01), modes are
// 0644 and compression is deflate level 9 — the same tree gives the same sha256.
//
// --publish stores the zips + listing images in the marketplace blob store and
// upserts marketplace_plugins / marketplace_versions (publisher "InfiniBot",
// firstParty, pricing free by default). Pricing, plans, featured and visibility are
// owned by the admin console and are never overwritten on re-publish. It refuses a
// non-local database unless --yes is passed.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..");
export const MANIFEST = "infinibot.plugin.json";
export const DEFAULT_OUT = path.join(REPO_ROOT, "dist/plugin-packages");

/** What a first-party build leaves out (`.ibpluginignore` syntax). Dotfiles are left out too. */
export const FIRST_PARTY_IGNORE = `
node_modules/
test/
tests/
__tests__/
__snapshots__/
coverage/
dist/
*.test.ts
*.test.tsx
*.test.js
*.test.mjs
*.spec.ts
*.spec.js
*.e2e.ts
*.map
*.log
*.tsbuildinfo
`;
const PACK_OPTIONS = { ignore: FIRST_PARTY_IGNORE, ignoreDotfiles: true };

// ── load TypeScript modules (the core packer, the marketplace store) ─────────

/** Import a repo .ts module: directly under tsx/vitest, through tsx's API under plain node. */
async function loadTs(rel) {
  const file = path.join(REPO_ROOT, rel);
  try {
    return await import(pathToFileURL(file).href);
  } catch (direct) {
    try {
      const { tsImport } = await import("tsx/esm/api");
      return await tsImport(pathToFileURL(file).href, import.meta.url);
    } catch (err) {
      throw new Error(`could not load ${rel} (${err.message}; direct import: ${direct.message})`);
    }
  }
}

let packerPromise;
const corePacker = () => (packerPromise ??= loadTs("src/plugins/packages/pack.ts"));

// ── enumerate + pack ────────────────────────────────────────────────────────

/**
 * First-party plugins that belong in the marketplace: v2 manifest + listing,
 * not a channel adapter. Sorted by id.
 * @returns {{dir: string, id: string, name: string, version: string, manifest: any}[]}
 */
export function enumerateFirstPartyPlugins(root = REPO_ROOT) {
  const ext = path.join(root, "extensions");
  const out = [];
  for (const name of readdirSync(ext).sort()) {
    const file = path.join(ext, name, MANIFEST);
    if (!existsSync(file)) continue;
    let m;
    try {
      m = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (m?.manifestVersion !== 2 || !m.listing || typeof m.id !== "string" || typeof m.version !== "string") continue;
    if ((Array.isArray(m.channels) && m.channels.length) || m.listing.category === "channels") continue;
    out.push({ dir: path.join(ext, name), id: m.id, name: m.name ?? m.id, version: m.version, manifest: m });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Release notes for `version` from a plugin's CHANGELOG.md: the section under the
 * first heading that names the version (up to the next heading of the same depth).
 * "" when there is no changelog or no such section.
 */
export function changelogFor(dir, version) {
  const file = path.join(dir, "CHANGELOG.md");
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,3}\s/.test(l) && l.includes(version));
  if (start < 0) return "";
  const depth = lines[start].match(/^#+/)[0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => new RegExp(`^#{1,${depth}}\\s`).test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim().slice(0, 20_000);
}

/**
 * Pack one plugin folder with the core packer →
 * { id, name, version, file, zip, sha256, sizeBytes, files, warnings }.
 * Throws when the folder fails pack validation.
 */
export async function packPlugin(plugin) {
  const { packPluginBuffer } = await corePacker();
  const r = await packPluginBuffer(plugin.dir, PACK_OPTIONS);
  if (!r.ok) throw new Error(`${plugin.id} failed pack validation: ${r.errors.join("; ")}`);
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    file: `${plugin.id}-${plugin.version}.zip`,
    zip: r.buffer,
    sha256: r.sha256,
    sizeBytes: r.sizeBytes,
    files: r.files,
    changelog: changelogFor(plugin.dir, plugin.version),
    warnings: r.warnings,
  };
}

/**
 * Pack every first-party plugin into `outDir` and write index.json next to them.
 * @param {{root?: string, outDir?: string, only?: string[], write?: boolean}} [opts]
 */
export async function packAll(opts = {}) {
  const outDir = opts.outDir ?? DEFAULT_OUT;
  const plugins = enumerateFirstPartyPlugins(opts.root ?? REPO_ROOT).filter((p) => !opts.only?.length || opts.only.includes(p.id));
  const packed = [];
  for (const p of plugins) packed.push(await packPlugin(p));
  if (opts.write !== false) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const p of packed) writeFileSync(path.join(outDir, p.file), p.zip);
    const index = { schemaVersion: 1, publisher: "InfiniBot", plugins: packed.map(({ zip: _z, warnings: _w, changelog: _c, ...rest }) => rest) };
    writeFileSync(path.join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  }
  return packed;
}

// ── publish ─────────────────────────────────────────────────────────────────

async function publish(packed, { yes }) {
  const url = process.env.MARKETPLACE_DATABASE_URL;
  if (!url) throw new Error("--publish needs MARKETPLACE_DATABASE_URL (the control-plane Postgres to publish into)");
  const host = new URL(url).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local && !yes) throw new Error(`refusing to publish to ${host} without --yes`);
  const [{ publishFirstParty }, { runMarketplaceMigrations }, { postgresBlobStore }, { default: postgres }] = await Promise.all([
    loadTs("src/saas/cloud/marketplace/store.ts"),
    loadTs("src/saas/cloud/marketplace/schema.ts"),
    loadTs("src/saas/cloud/marketplace/blobs.ts"),
    import("postgres"),
  ]);
  const sql = postgres(url, { ssl: local ? false : "require", max: 1, prepare: false, onnotice: () => {} });
  try {
    await runMarketplaceMigrations(sql);
    const blobs = postgresBlobStore(sql);
    console.log(`publishing ${packed.length} first-party plugins to ${host}`);
    for (const p of packed) {
      const r = await publishFirstParty(sql, blobs, p.zip, { changelog: p.changelog });
      console.log(`  ${r.created ? "created" : "updated"}  ${r.id}@${r.version}  ${r.sha256.slice(0, 12)}  ${(r.sizeBytes / 1024).toFixed(0)} KB`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ── cli ─────────────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const known = new Set(["--dry-run", "--publish", "--yes", "--out", "--only", "--quiet", "--root"]);
  const bad = args.find((a) => a.startsWith("--") && !known.has(a));
  if (bad) {
    console.error(`unknown flag: ${bad}`);
    process.exit(2);
  }
  const outDir = path.resolve(value("--out") ?? DEFAULT_OUT);
  const only = value("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    // Fail before packing: a publish with no (or a refused) target never builds anything.
    if (flag("--publish")) {
      const url = process.env.MARKETPLACE_DATABASE_URL;
      if (!url) throw new Error("--publish needs MARKETPLACE_DATABASE_URL (the control-plane Postgres to publish into)");
      const host = new URL(url).hostname;
      if (!["localhost", "127.0.0.1", "::1"].includes(host) && !flag("--yes")) throw new Error(`refusing to publish to ${host} without --yes`);
    }
    const root = value("--root") ? path.resolve(value("--root")) : undefined;
    const packed = await packAll({ outDir, only, root });
    if (!packed.length) throw new Error("no first-party plugins found (v2 manifest + listing)");
    if (!flag("--quiet")) {
      for (const p of packed) console.log(`${p.file.padEnd(38)} ${String(p.files).padStart(4)} files ${(p.sizeBytes / 1024).toFixed(0).padStart(6)} KB  sha256 ${p.sha256}`);
      console.log(`${packed.length} packages -> ${path.relative(REPO_ROOT, outDir) || outDir}`);
    }
    if (flag("--publish")) await publish(packed, { yes: flag("--yes") });
    else if (!flag("--quiet")) console.log("dry run: nothing uploaded (pass --publish to upsert into the marketplace)");
    process.exit(0);
  } catch (err) {
    console.error(`package-first-party-plugins: ${err.message}`);
    process.exit(1);
  }
}
