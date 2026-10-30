/**
 * The manifest reference can't drift from the schema:
 *  1. docs/plugins/manifest-reference.md is exactly what the catalog renders;
 *  2. a manifest using EVERY documented field passes the real (strict) parser
 *     and the package validator — so a documented field that the parser
 *     rejects, renames or re-types breaks this test;
 *  3. every field a bundled plugin's manifest uses is documented;
 *  4. every key of the parsed types is documented (the key records in
 *     manifest-fields.ts are `Record<keyof …, true>`, enforced by tsc).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { loadPluginManifest } from "./manifest.js";
import {
  CONTRIBUTES_KEYS,
  LISTING_KEYS,
  MANIFEST_FIELDS,
  PERMISSION_KEYS,
  UPDATE_KEYS,
  manifestKeyPaths,
  renderManifestReference,
} from "./manifest-fields.js";
import { validateDistributionManifest } from "./packages/format.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DOC = path.join(REPO_ROOT, "docs", "plugins", "manifest-reference.md");
const documented = new Set(MANIFEST_FIELDS.map((f) => f.path));

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

/** A manifest that uses every documented field. Keep in step with the catalog. */
const KITCHEN_SINK = {
  manifestVersion: 2,
  id: "sink",
  name: "Kitchen Sink",
  version: "1.2.3",
  description: "Uses every manifest field.",
  publisher: "acme",
  license: "MIT",
  homepage: "https://acme.example/sink",
  minHostVersion: "2026.6.30",
  engines: { "infinibot-plugin-api": "^2.0.0" },
  rpcNamespace: "sink",
  kind: "memory",
  optionalPlugins: ["other"],
  configSchema: { type: "object", properties: { token: { type: "string" } } },
  uiHints: { token: { label: "Token", sensitive: true } },
  channels: ["sinkchat"],
  providers: ["sinkai"],
  skills: ["skills/sink"],
  ui: { navLabel: "Sink", navIcon: "box", entry: "/plugins/sink/panel.js" },
  listing: {
    tagline: "Everything, including the sink.",
    description: "Long **markdown**.",
    category: "apps",
    tags: ["demo"],
    cover: "assets/cover.png",
    icon: "assets/icon.svg",
    screenshots: [{ src: "assets/shot.webp", caption: "A screenshot" }],
    publisher: { name: "Acme", url: "https://acme.example" },
    links: {
      docs: "https://acme.example/docs",
      support: "https://acme.example/help",
      source: "https://acme.example/src",
    },
  },
  update: { registryUrl: "https://plugins.acme.example", changelog: "CHANGELOG.md" },
  permissions: {
    network: ["api.acme.example"],
    fs: ["~/Documents/sink"],
    exec: true,
    secrets: ["SINK_TOKEN"],
    channels: ["telegram"],
    credits: true,
    phi: true,
    gated: [{ id: "orders", label: "Place orders", description: "Places real orders." }],
  },
  appearance: {
    accent: "token:info",
    tint: "token:accent",
    tintStrength: 0.1,
    density: "compact",
    fontScale: 1,
    icon: "box",
    monogram: "KS",
    layout: [
      { id: "side", label: "Side", type: "select", options: ["left", "right"], default: "left" },
    ],
    variables: [
      {
        name: "--plugin-sink-glow",
        label: "Glow",
        type: "color",
        default: "token:success",
        role: "ui",
      },
      { name: "--plugin-sink-gap", label: "Gap", type: "number", default: 4, min: 0, max: 12 },
      {
        name: "--plugin-sink-mode",
        label: "Mode",
        type: "select",
        default: "a",
        options: ["a", "b"],
      },
    ],
  },
  contributes: {
    pages: [
      {
        tab: "sink",
        route: "/sink",
        builtin: "sink",
        entry: "/plugins/sink/page.js",
        title: "Sink",
      },
      { tab: "sink-more", route: "/sink/more", builtin: "sink-more" },
    ],
    nav: [
      {
        tab: "sink",
        label: "Sink",
        icon: "box",
        group: "Apps",
        requires: ["network:api.acme.example"],
      },
    ],
    navSection: {
      title: "Sink",
      order: 10,
      collapsedByDefault: false,
      items: [{ page: "sink", label: "Home", icon: "box" }],
    },
    landing: "sink",
    rpc: [
      { method: "sink.list", scope: "read", aliases: ["legacy.sinkList"], requires: ["network"] },
      "sink.admin",
    ],
    rpcAliases: [{ method: "oldsink.list", target: "sink.list" }],
    http: [
      "/plugins/sink/panel.js",
      { path: "/plugins/sink/hook", requires: ["secrets:SINK_TOKEN"] },
    ],
    selfAuthHttp: ["/plugins/sink/hook"],
    tools: ["sink_read", { name: "sink_run", trust: "exec", requires: ["gated:orders"] }],
    panels: ["sink.table"],
    services: ["sink-sync"],
    voiceProviders: ["sink-voice"],
    agents: ["agents/sink.json"],
    mcpServers: [{ id: "sink-mcp", label: "Sink MCP", command: "node", args: ["mcp.js"] }],
    clockSections: [
      {
        id: "sink-clock",
        label: "Sink time",
        description: "d",
        builtin: "sink-clock",
        defaultEnabled: false,
      },
    ],
    topbarSlots: [
      {
        id: "sink-slot",
        label: "Sink",
        description: "d",
        builtin: "sink-slot",
        order: 5,
        placement: "right",
      },
    ],
    settings: [
      { id: "sink-settings", label: "Sink", description: "d", builtin: "sink-settings", order: 5 },
    ],
    setupChecks: [
      {
        id: "sink.token",
        title: "Sink token",
        tabs: ["sink"],
        action: { label: "Set up", tab: "sink", view: "token" },
      },
    ],
    mapRoom: {
      title: "Sink",
      theme: "generic",
      accent: "token:info",
      props: ["desk"],
      size: "M",
      placement: "auto",
    },
    learn: "learn.json",
    importers: [
      {
        id: "csv",
        label: "CSV",
        description: "d",
        method: "sink.admin",
        accept: ".csv",
        input: "file",
      },
    ],
    cron: [{ id: "nightly", label: "Nightly", schedule: "0 3 * * *" }],
    subviews: [{ id: "sv", label: "Sub", host: "clients" }],
    widgets: [{ id: "w", label: "Widget", surface: "dashboard" }],
    overlays: [{ id: "o", label: "Overlay", trigger: "hotkey" }],
    launchpad: [{ id: "l", label: "Launch" }],
    mapLayers: [{ id: "m", label: "Layer" }],
    panelKinds: [{ id: "sink.card", label: "Card" }],
    skills: ["skills/sink"],
    roster: [{ agentId: "sink-agent", label: "Sink agent" }],
    channels: ["sinkchat"],
    providers: [{ id: "sinkai", label: "Sink AI", kind: "llm" }],
    hooks: ["message:received"],
    sidecars: [{ id: "db", label: "DB", image: "postgres:16" }],
  },
};

/** Write the manifest plus the learn.json it points at (a real track, re-namespaced). */
function writeSink(dir: string, manifest: unknown) {
  fs.writeFileSync(path.join(dir, "infinibot.plugin.json"), JSON.stringify(manifest));
  const learn = fs
    .readFileSync(path.join(REPO_ROOT, "extensions", "flypic", "learn.json"), "utf-8")
    .replaceAll("flypic", "sink");
  fs.writeFileSync(path.join(dir, "learn.json"), learn);
}

describe("manifest reference", () => {
  it("docs/plugins/manifest-reference.md is generated from the catalog and up to date", () => {
    expect(
      fs.readFileSync(DOC, "utf-8"),
      "stale doc: run `node --import tsx scripts/gen-plugin-manifest-reference.ts`",
    ).toBe(renderManifestReference());
  });

  it("documents each field once", () => {
    expect(MANIFEST_FIELDS.length).toBe(documented.size);
    for (const field of MANIFEST_FIELDS) {
      expect(field.description.length, field.path).toBeGreaterThan(3);
      expect(field.description.includes("\n"), field.path).toBe(false);
    }
  });

  it("the kitchen-sink manifest uses every documented field, and nothing undocumented", () => {
    const used = new Set(manifestKeyPaths(KITCHEN_SINK));
    expect(
      [...used].filter((p) => !documented.has(p)),
      "used but not documented",
    ).toEqual([]);
    expect(
      [...documented].filter((p) => !used.has(p)),
      "documented but not exercised",
    ).toEqual([]);
  });

  it("the real parser accepts every documented field (strict v2 contract + package rules)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-manifest-fields-"));
    temps.push(dir);
    writeSink(dir, KITCHEN_SINK);
    const loaded = loadPluginManifest(dir);
    expect(loaded.ok, loaded.ok ? "" : loaded.error).toBe(true);
    if (!loaded.ok) return;
    const m = loaded.manifest;
    // Nothing was dropped on the way through.
    expect(m.listingWarnings).toBeUndefined();
    expect(m.minHostVersion).toBe("2026.6.30");
    expect(m.update).toEqual({
      registryUrl: "https://plugins.acme.example",
      changelog: "CHANGELOG.md",
    });
    expect(m.ui).toEqual({ navLabel: "Sink", navIcon: "box", entry: "/plugins/sink/panel.js" });
    expect(m.kind).toBe("memory");
    expect(m.v2?.engines.pluginApi).toBe("^2.0.0");
    expect(m.v2?.publisher).toBe("acme");

    const dist = validateDistributionManifest(KITCHEN_SINK);
    expect(dist.ok, dist.ok ? "" : dist.errors.join("; ")).toBe(true);

    // Every key the parser produces is documented, and every documented
    // contributes/permissions/listing/update key reaches the parsed result.
    const contributes = m.v2!.contributes as Record<string, unknown>;
    for (const key of Object.keys(CONTRIBUTES_KEYS)) {
      expect(contributes[key], `contributes.${key} was not parsed`).toBeDefined();
      expect(
        [...documented].some(
          (p) =>
            p === `contributes.${key}` ||
            p.startsWith(`contributes.${key}.`) ||
            p.startsWith(`contributes.${key}[`),
        ),
        `contributes.${key} is not documented`,
      ).toBe(true);
    }
    expect(Object.keys(contributes).filter((k) => !(k in CONTRIBUTES_KEYS))).toEqual([]);
    const permissions = m.v2!.permissions as Record<string, unknown>;
    for (const key of Object.keys(PERMISSION_KEYS)) {
      expect(permissions[key], `permissions.${key} was not parsed`).toBeTruthy();
      expect(
        [...documented].some((p) => p.startsWith(`permissions.${key}`)),
        `permissions.${key}`,
      ).toBe(true);
    }
    const listing = m.listing as Record<string, unknown>;
    for (const key of Object.keys(LISTING_KEYS)) {
      expect(listing[key], `listing.${key} was not parsed`).toBeTruthy();
      expect(
        [...documented].some((p) => p.startsWith(`listing.${key}`)),
        `listing.${key}`,
      ).toBe(true);
    }
    for (const key of Object.keys(UPDATE_KEYS)) {
      expect(documented.has(`update.${key}`), `update.${key}`).toBe(true);
    }
    // Catalog-only (listed) contributions are picked up for Setup › Plugins.
    const kinds = new Set(m.v2!.catalog.items.map((i) => i.kind));
    for (const kind of [
      "cron",
      "subview",
      "widget",
      "overlay",
      "launchpad",
      "mapLayer",
      "panelKind",
      "skill",
      "agent",
      "channel",
      "provider",
      "hook",
      "sidecar",
      "importer",
    ]) {
      expect(kinds.has(kind as never), `catalog kind ${kind}`).toBe(true);
    }
  });

  it("a documented field with a wrong value is rejected by the parser (the doc describes a real contract)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-manifest-fields-"));
    temps.push(dir);
    const broken: [string, (m: any) => void, RegExp][] = [
      ["engines", (m) => delete m.engines["infinibot-plugin-api"], /infinibot-plugin-api/],
      ["rpc namespace", (m) => (m.contributes.rpc[0].method = "elsewhere.x"), /namespaced/],
      ["rpc scope", (m) => (m.contributes.rpc[0].scope = "root"), /unknown scope/],
      ["http prefix", (m) => (m.contributes.http[0] = "/elsewhere"), /must live under/],
      [
        "page needs builtin|entry",
        (m) => (m.contributes.pages[1] = { tab: "x", route: "/x" }),
        /needs builtin or entry/,
      ],
      ["nav → page", (m) => (m.contributes.nav[0].tab = "nope"), /no matching contributes.pages/],
      ["landing → page", (m) => (m.contributes.landing = "nope"), /no matching contributes.pages/],
      [
        "gated needs label",
        (m) => delete m.permissions.gated[0].label,
        /gated entries need id \+ label/,
      ],
      ["mapRoom theme", (m) => (m.contributes.mapRoom.theme = "castle"), /mapRoom theme/],
      ["topbar placement", (m) => (m.contributes.topbarSlots[0].placement = "top"), /placement/],
      ["appearance token", (m) => (m.appearance.accent = "#ff0000"), /InfiniBot token/],
      ["minHostVersion", (m) => (m.minHostVersion = "newest"), /minHostVersion/],
      ["update.registryUrl", (m) => (m.update.registryUrl = "ftp://x"), /update.registryUrl/],
      ["manifestVersion", (m) => (m.manifestVersion = 3), /unsupported manifestVersion/],
    ];
    for (const [label, mutate, pattern] of broken) {
      const m = structuredClone(KITCHEN_SINK);
      mutate(m);
      writeSink(dir, m);
      const res = loadPluginManifest(dir);
      expect(res.ok, label).toBe(false);
      if (!res.ok) expect(res.error, label).toMatch(pattern);
    }
  });

  it("every field used by a bundled plugin manifest is documented", () => {
    const extensions = path.join(REPO_ROOT, "extensions");
    const undocumented: string[] = [];
    let checked = 0;
    for (const name of fs.readdirSync(extensions)) {
      const file = path.join(extensions, name, "infinibot.plugin.json");
      if (!fs.existsSync(file)) continue;
      checked += 1;
      for (const p of manifestKeyPaths(JSON.parse(fs.readFileSync(file, "utf-8")))) {
        if (!documented.has(p)) undocumented.push(`${name}: ${p}`);
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(undocumented).toEqual([]);
  });

  it("the example plugin and the scaffold use documented fields only", () => {
    const file = path.join(REPO_ROOT, "examples", "plugin-hello", "infinibot.plugin.json");
    const paths = manifestKeyPaths(JSON.parse(fs.readFileSync(file, "utf-8")));
    expect(paths.filter((p) => !documented.has(p))).toEqual([]);
  });
});
