/**
 * The plugin docs stay true to the code: the registry contract is quoted
 * verbatim, numbers in the packaging spec match the limits, the walkthrough
 * quotes the real example plugin, and relative links resolve.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PACKAGE_EXTENSION,
  PACKAGE_FORMAT,
  PACKAGE_LIMITS,
  RESERVED_PACKAGE_IDS,
} from "./format.js";
import { DEFAULT_PLUGIN_REGISTRY_URL, REGISTRY_URL_ENV } from "./registry-client.js";
import { SCAFFOLD_MIN_HOST_VERSION } from "./scaffold.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOCS = path.join(REPO_ROOT, "docs", "plugins");
const read = (name: string) => fs.readFileSync(path.join(DOCS, name), "utf-8");

const NEW_DOCS = [
  "README.md",
  "getting-started.md",
  "manifest-reference.md",
  "api-reference.md",
  "ui-guide.md",
  "packaging.md",
  "updates.md",
  "security-model.md",
  "publishing.md",
  "registry-api.md",
];

/**
 * The contract the cloud registry implements (as built: see
 * src/saas/cloud/marketplace/registry-contract.test.ts). Change it only together
 * with the client, the cloud handlers and docs/plugins/registry-api.md.
 */
const REGISTRY_CONTRACT = [
  "- GET {registry}/api/marketplace/index.json → {schemaVersion:1, generatedAt, plugins:[Entry]}",
  "- GET {registry}/api/marketplace/plugins/:id → Entry & {versions:[{version, releasedAt, sha256, sizeBytes, minHostVersion, changelog}]}",
  '- GET {registry}/api/marketplace/plugins/:id/download?version=<semver|latest>&token=<entitlement?> → 302 to zip, or the zip; 402 JSON {error:"payment_required", purchaseUrl} when paid and no valid entitlement; 404 JSON {error:"external_distribution", purchaseUrl, homepageUrl} when the publisher delivers it.',
  '- Entry = {id, name, version, publisher:{id,name,verified}, firstParty:boolean, description, category, tags[], pricing:{model:"free"|"paid", priceCents, currency, purchaseUrl|null, includedPlans?:string[]}, downloadUrl|null, sha256, sizeBytes, minHostVersion, homepageUrl|null, listing:{cover, icon, screenshots:[{src, caption?}], tagline?}, affiliate?:{enabled:boolean}, featured?:boolean, distribution?:"hosted"|"external", cloud?:{availability:"available"|"partial"|"coming-soon"|"self-host-only", note?, selfHostOnly?:[{feature, why}]}}',
];

describe("plugin docs", () => {
  it("every doc exists and its relative links resolve", () => {
    for (const name of NEW_DOCS) {
      const text = read(name);
      expect(text.startsWith("# "), name).toBe(true);
      for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = (m[1] as string).split("#")[0] as string;
        if (!target || /^[a-z]+:/i.test(target)) continue;
        expect(fs.existsSync(path.resolve(DOCS, target)), `${name} → ${m[1]}`).toBe(true);
      }
    }
  });

  it("registry-api.md carries the registry contract verbatim", () => {
    const text = read("registry-api.md");
    for (const line of REGISTRY_CONTRACT) expect(text, line.slice(0, 60)).toContain(line);
    expect(text).toContain(DEFAULT_PLUGIN_REGISTRY_URL);
    expect(text).toContain(REGISTRY_URL_ENV);
  });

  it("packaging.md states the real limits, format id and reserved ids", () => {
    const text = read("packaging.md");
    const mb = (n: number) => `${n / 1024 / 1024} MB`;
    expect(text).toContain(`| Zip size | ${mb(PACKAGE_LIMITS.maxZipBytes)} |`);
    expect(text).toContain(
      `| Unpacked size (all files) | ${mb(PACKAGE_LIMITS.maxUnpackedBytes)} |`,
    );
    expect(text).toContain(`| One file, unpacked | ${mb(PACKAGE_LIMITS.maxFileBytes)} |`);
    expect(text).toContain(
      `| Number of files | ${PACKAGE_LIMITS.maxFiles.toLocaleString("en-US")} |`,
    );
    expect(text).toContain(`| Compression ratio | ${PACKAGE_LIMITS.maxCompressionRatio}:1`);
    expect(text).toContain(`| Path length | ${PACKAGE_LIMITS.maxPathLength} characters |`);
    expect(text).toContain(`| Folder depth | ${PACKAGE_LIMITS.maxPathDepth} |`);
    expect(text).toContain(`| Manifest size | ${mb(PACKAGE_LIMITS.maxManifestBytes)} |`);
    expect(text).toContain(PACKAGE_FORMAT);
    expect(text).toContain(PACKAGE_EXTENSION);
    for (const id of RESERVED_PACKAGE_IDS) expect(text, id).toContain(`\`${id}\``);
  });

  it("getting-started.md quotes the real example plugin", () => {
    const text = read("getting-started.md");
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "examples", "plugin-hello", "infinibot.plugin.json"),
        "utf-8",
      ),
    );
    expect(text).toContain(`"id": "${manifest.id}"`);
    expect(text).toContain(`"version": "${manifest.version}"`);
    expect(text).toContain(`"publisher": "${manifest.publisher}"`);
    expect(text).toContain(`"minHostVersion": "${SCAFFOLD_MIN_HOST_VERSION}"`);
    expect(text).toContain(manifest.contributes.rpc[0].method);
    expect(text).toContain(manifest.contributes.tools[0]);
    expect(text).toContain(manifest.ui.entry);
    const entry = fs.readFileSync(
      path.join(REPO_ROOT, "examples", "plugin-hello", "index.js"),
      "utf-8",
    );
    for (const snippet of [
      'api.registerGatewayMethod("hello.greet"',
      'name: "hello_greet"',
      "publicAsset: true",
    ]) {
      expect(entry, snippet).toContain(snippet);
      expect(text, snippet).toContain(snippet);
    }
    // Every command the guide names exists in the CLI.
    const cli =
      fs.readFileSync(path.join(REPO_ROOT, "src", "cli", "plugins-cli.ts"), "utf-8") +
      fs.readFileSync(path.join(REPO_ROOT, "src", "cli", "plugins-packages-cli.ts"), "utf-8");
    for (const cmd of [
      "create",
      "validate",
      "pack",
      "install",
      "enable",
      "disable",
      "updates",
      "update",
      "rollback",
      "auto-update",
      "marketplace",
      "list",
      "info",
      "doctor",
    ]) {
      expect(cli, cmd).toContain(`.command("${cmd}")`);
      expect(text, cmd).toContain(`infinibot plugins ${cmd}`);
    }
  });
});
