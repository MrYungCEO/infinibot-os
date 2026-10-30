// Hands jiti the in-process plugin SDK so loading the real plugin stays cheap.
import "../../test/helpers/bundled-plugins.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { loadInfiniBotPlugins } from "../plugins/loader.js";
import { parseManifestV2 } from "../plugins/manifest-v2.js";
import { resolvePluginMethodScope, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  CONTENT_STUDIO_NETWORK_METHODS,
  CONTENT_STUDIO_PLUGIN_ID,
  contentStudioPluginMethod,
  listContentStudioMethods,
  listContentStudioNativeMethods,
} from "./methods.js";
import {
  CONTENT_STUDIO_MIGRATION_MARKER,
  detectContentStudioData,
  migrateContentStudioEnablement,
} from "./migration.js";

const EXT_DIR = path.resolve(import.meta.dirname, "../../extensions/content-studio");
const readManifest = () =>
  JSON.parse(fs.readFileSync(path.join(EXT_DIR, "infinibot.plugin.json"), "utf8")) as Record<
    string,
    unknown
  >;

const tmpDirs: string[] = [];
function tmp(prefix = "cs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const prevBundled = process.env.INFINIBOT_BUNDLED_PLUGINS_DIR;
const prevState = process.env.INFINIBOT_STATE_DIR;

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (prevBundled === undefined) delete process.env.INFINIBOT_BUNDLED_PLUGINS_DIR;
  else process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = prevBundled;
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
});

describe("content-studio manifest", () => {
  it("parses as a v2 manifest with listing assets on disk", () => {
    const raw = readManifest();
    const res = parseManifestV2(CONTENT_STUDIO_PLUGIN_ID, raw);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.fields.license).toBe("FSL-1.1-ALv2");
    expect(res.fields.appearance.monogram).toBe("CS");
    expect((raw.contributes as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain(
      "content_pipeline",
    );
    expect(res.fields.contributes.pages.map((p) => p.builtin)).toEqual([
      "content-pages",
      "content-intel",
    ]);
    expect(res.fields.contributes.agents).toEqual(["agents/roster.json"]);
    const listing = raw.listing as { cover: string; icon: string; screenshots: { src: string }[] };
    for (const rel of [listing.cover, listing.icon, ...listing.screenshots.map((s) => s.src)]) {
      expect(fs.existsSync(path.join(EXT_DIR, rel)), rel).toBe(true);
    }
    expect(listing.screenshots.length).toBeGreaterThanOrEqual(2);
  });

  it("declares exactly the seam's methods, scopes and legacy aliases", () => {
    const res = parseManifestV2(CONTENT_STUDIO_PLUGIN_ID, readManifest());
    if (!res.ok) throw new Error(res.error);
    const table = listContentStudioMethods();
    const native = listContentStudioNativeMethods();
    expect(res.fields.contributes.rpc.map((r) => [r.method, r.scope])).toEqual([
      ...table.map((m) => [m.method, m.scope]),
      ...native.map((m) => [m.method, m.scope]),
    ]);
    // Native methods have no legacy alias; only importUrl reaches the network.
    const raw = (readManifest().contributes as { rpc: { method: string; requires?: string[] }[] })
      .rpc;
    for (const r of raw.filter((x) => native.some((n) => n.method === x.method))) {
      expect(r.requires?.includes("network") ?? false, r.method).toBe(
        CONTENT_STUDIO_NETWORK_METHODS.has(r.method),
      );
    }
    expect(res.fields.contributes.http).toContain("/plugins/content-studio/media");
    expect(res.fields.contributes.rpcAliases.map((a) => [a.method, a.target, a.scope])).toEqual(
      table.map((m) => [m.legacy, m.method, m.scope]),
    );
  });

  it("maps legacy names into the plugin namespace", () => {
    expect(contentStudioPluginMethod("content.pages.list")).toBe("content-studio.pages.list");
    expect(contentStudioPluginMethod("scripts.generate")).toBe("content-studio.scripts.generate");
    expect(contentStudioPluginMethod("viral.formats.watch")).toBe(
      "content-studio.viral.formats.watch",
    );
  });

  it("ships the content roster agents with their tools", () => {
    const roster = JSON.parse(
      fs.readFileSync(path.join(EXT_DIR, "agents/roster.json"), "utf8"),
    ) as { agents: { id: string; toolsAllow?: string[]; systemPrompt: string }[] };
    expect(roster.agents.map((a) => a.id)).toEqual([
      "cmo",
      "content-director",
      "scriptwriter",
      "brand-designer",
      "video-editor-agent",
    ]);
    const cmo = roster.agents.find((a) => a.id === "cmo");
    expect(cmo?.toolsAllow).toEqual(
      expect.arrayContaining(["content_intel", "script", "content_pages", "content_pipeline"]),
    );
    for (const a of roster.agents) expect(a.systemPrompt.length).toBeGreaterThan(200);
  });
});

// The first load transpiles the plugin-sdk tree through jiti when dist/ is
// absent (fresh worktree); later loads hit its cache.
describe("content-studio plugin load", { timeout: 300_000 }, () => {
  function bundledWithPlugin(): string {
    const dir = tmp("cs-bundled-");
    fs.cpSync(EXT_DIR, path.join(dir, "content-studio"), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}assets${path.sep}`),
    });
    process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = dir;
    return dir;
  }

  it("is off by default and registers nothing", () => {
    bundledWithPlugin();
    const registry = loadInfiniBotPlugins({ cache: false, config: {} });
    const rec = registry.plugins.find((p) => p.id === CONTENT_STUDIO_PLUGIN_ID);
    expect(rec?.status).toBe("disabled");
    expect(Object.keys(registry.gatewayHandlers).some((m) => m.startsWith("content"))).toBe(false);
    expect(registry.tools.length).toBe(0);
  });

  it("when enabled registers namespaced methods, legacy aliases, tools, service and route", () => {
    bundledWithPlugin();
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { entries: { "content-studio": { enabled: true } } } },
    });
    const rec = registry.plugins.find((p) => p.id === CONTENT_STUDIO_PLUGIN_ID);
    expect(rec?.status, rec?.error).toBe("loaded");
    const errors = registry.diagnostics.filter(
      (d) => d.pluginId === CONTENT_STUDIO_PLUGIN_ID && d.level === "error",
    );
    expect(errors).toEqual([]);
    for (const m of listContentStudioMethods()) {
      expect(registry.gatewayHandlers[m.method], m.method).toBeTypeOf("function");
      // The alias is the same handler as its namespaced target.
      expect(registry.gatewayHandlers[m.legacy], m.legacy).toBe(registry.gatewayHandlers[m.method]);
    }
    expect(rec?.toolNames).toEqual([
      "content_intel",
      "script",
      "viral_watch",
      "content_pages",
      "content_pipeline",
      "content_posting",
    ]);
    for (const { method } of listContentStudioNativeMethods()) {
      expect(registry.gatewayHandlers[method], method).toBeTypeOf("function");
    }
    expect(registry.services.map((s) => s.service.id)).toContain("content-studio-instagram-sync");
    expect(registry.services.map((s) => s.service.id)).toContain("content-studio-posting");
    expect(registry.httpRoutes.map((r) => r.path)).toContain("/plugins/content-studio/video");
    expect(registry.httpRoutes.map((r) => r.path)).toContain("/plugins/content-studio/media");

    setActivePluginRegistry(registry, "cs-test");
    expect(resolvePluginMethodScope("content.pages.list")).toBe("read");
    expect(resolvePluginMethodScope("content.pages.create")).toBe("write");
    expect(resolvePluginMethodScope("content-studio.intel.list")).toBe("admin");
  });

  it("aliases never shadow a core method", () => {
    bundledWithPlugin();
    const core = { "content.pages.list": () => undefined };
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { entries: { "content-studio": { enabled: true } } } },
      coreGatewayHandlers: core,
    });
    expect(registry.gatewayHandlers["content.pages.list"]).toBeUndefined();
    expect(
      registry.diagnostics.some((d) => d.message.includes("rpc alias content.pages.list skipped")),
    ).toBe(true);
  });

  it("namespaced handlers lazy-load the content module and answer", async () => {
    bundledWithPlugin();
    process.env.INFINIBOT_STATE_DIR = tmp("cs-state-");
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { entries: { "content-studio": { enabled: true } } } },
    });
    const handler = registry.gatewayHandlers["manychat.status"];
    const result = await new Promise<{ ok: boolean; payload: unknown }>((resolve) => {
      void handler({
        req: { type: "req", id: "1", method: "manychat.status" },
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload) => resolve({ ok, payload }),
        context: {} as never,
      } as never);
    });
    expect(result).toEqual({
      ok: true,
      payload: { connected: false, accountName: null, subscriberCount: null, connectedAt: null },
    });
  });
});

describe("content-studio enablement migration", () => {
  let stateDir: string;
  let pluginDataDir: string;
  beforeEach(() => {
    stateDir = tmp("cs-mig-");
    pluginDataDir = path.join(stateDir, "plugin-data", "content-studio");
  });

  const seedReels = (dir: string, n: number) => {
    const db = new Database(path.join(dir, "content-intel.db"));
    db.exec("CREATE TABLE reels (shortcode TEXT PRIMARY KEY)");
    const ins = db.prepare("INSERT INTO reels VALUES (?)");
    for (let i = 0; i < n; i++) ins.run(`sc${i}`);
    db.close();
  };

  it("fresh install: stays off and records the decision once", () => {
    const res = migrateContentStudioEnablement({
      config: {} as InfinibotConfig,
      pluginDataDir,
      stateDirs: [stateDir],
    });
    expect(res.changed).toBe(false);
    expect(res.summary).toMatch(/stays off/);
    expect(fs.existsSync(path.join(pluginDataDir, CONTENT_STUDIO_MIGRATION_MARKER))).toBe(true);
    // Data appearing later does not flip it: the migration is one-time.
    seedReels(stateDir, 3);
    const again = migrateContentStudioEnablement({
      config: {} as InfinibotConfig,
      pluginDataDir,
      stateDirs: [stateDir],
    });
    expect(again).toMatchObject({ changed: false, summary: null });
  });

  it("empty stores are not data", () => {
    seedReels(stateDir, 0);
    fs.mkdirSync(path.join(stateDir, "secrets"));
    fs.writeFileSync(path.join(stateDir, "secrets", "instagram.json"), "");
    expect(detectContentStudioData([stateDir])).toEqual([]);
  });

  it("existing data: enables the plugin and hands seed-managed content agents over", () => {
    seedReels(stateDir, 5);
    const legacy = tmp("cs-legacy-");
    const db = new Database(path.join(legacy, "databases.db"));
    db.exec("CREATE TABLE content_pages (id TEXT)");
    db.prepare("INSERT INTO content_pages VALUES ('p1')").run();
    db.close();
    const config = {
      plugins: { entries: { telegram: { enabled: true } } },
      agents: {
        list: [
          { id: "cmo", name: "CMO", systemPrompt: "x", _seedVersion: "agency-v10" },
          { id: "scriptwriter", name: "Mine", systemPrompt: "custom" },
          { id: "main", name: "ASH", systemPrompt: "x", _seedVersion: "agency-v10" },
        ],
      },
    } as unknown as InfinibotConfig;
    const res = migrateContentStudioEnablement({
      config,
      pluginDataDir,
      stateDirs: [stateDir, legacy],
    });
    expect(res.changed).toBe(true);
    expect(res.summary).toMatch(/5 reels/);
    expect(res.summary).toMatch(/1 content pages/);
    const cfg = res.config as unknown as {
      plugins: { entries: Record<string, { enabled?: boolean }> };
      agents: { list: Record<string, unknown>[] };
    };
    expect(cfg.plugins.entries["content-studio"]).toEqual({ enabled: true });
    expect(cfg.plugins.entries.telegram).toEqual({ enabled: true });
    const byId = Object.fromEntries(cfg.agents.list.map((a) => [a.id, a]));
    expect(byId.cmo._plugin).toBe("content-studio");
    expect(byId.scriptwriter._plugin).toBeUndefined(); // operator-customised
    expect(byId.main._plugin).toBeUndefined(); // not a content agent
  });

  it("an explicit enabled flag always wins", () => {
    seedReels(stateDir, 5);
    const config = {
      plugins: { entries: { "content-studio": { enabled: false } } },
    } as unknown as InfinibotConfig;
    const res = migrateContentStudioEnablement({ config, pluginDataDir, stateDirs: [stateDir] });
    expect(res.changed).toBe(false);
    expect(
      (res.config as unknown as { plugins: { entries: Record<string, { enabled: boolean }> } })
        .plugins.entries["content-studio"].enabled,
    ).toBe(false);
  });
});
