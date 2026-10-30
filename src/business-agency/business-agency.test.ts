import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createBusinessObjectsTool } from "../agents/tools/business-objects-tool.js";
import { createClientContactsTool } from "../agents/tools/client-contacts-tool.js";
import { createLeadScrapeTool } from "../agents/tools/lead-scrape-tool.js";
import { createLeadTool } from "../agents/tools/lead-tool.js";
import { ROSTER_PACKS, STANDARD_AGENT_ROSTER } from "../agents/standard-roster.js";
import type { InfinibotConfig } from "../config/config.js";
import { listGatewayMethods } from "../gateway/server-methods-list.js";
import { applyCoreSurfacePluginMigrations } from "../plugins/core-surface-migrations.js";
import { isCoreToolSlotFilled, isEmptyToolSlot } from "../plugins/core-tool-slots.js";
import { loadInfiniBotPlugins } from "../plugins/loader.js";
import { parseManifestV2 } from "../plugins/manifest-v2.js";
import { resolvePluginMethodScope, setActivePluginRegistry } from "../plugins/runtime.js";
import { businessAgencyCronSkipReason, isBusinessAgencyCronJob } from "./cron.js";
import {
  BUSINESS_AGENCY_PLUGIN_ID,
  businessAgencyPluginMethod,
  isBusinessAgencyLegacyMethod,
  listBusinessAgencyMethods,
} from "./methods.js";
import {
  BUSINESS_AGENCY_AGENT_IDS,
  adoptBusinessAgencyAgents,
  detectBusinessAgencyData,
} from "./migration.js";
import { isBusinessAgencyActive, readBusinessAgencyProviderKey } from "./runtime.js";

const EXT_DIR = path.resolve(import.meta.dirname, "../../extensions/business-agency");
const readManifest = () =>
  JSON.parse(fs.readFileSync(path.join(EXT_DIR, "infinibot.plugin.json"), "utf8")) as Record<
    string,
    unknown
  >;

const tmpDirs: string[] = [];
function tmp(prefix = "ba-"): string {
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
  // No business-agency plugin loaded between tests.
  setActivePluginRegistry({ plugins: [], mediaProviders: [], channels: [] } as never, "ba-reset");
});

function sqlite(file: string, sql: string[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  for (const s of sql) db.exec(s);
  db.close();
}

describe("business-agency manifest", () => {
  it("parses as a v2 manifest with listing assets on disk", () => {
    const raw = readManifest();
    const res = parseManifestV2(BUSINESS_AGENCY_PLUGIN_ID, raw);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.fields.license).toBe("FSL-1.1-ALv2");
    expect(res.fields.appearance.monogram).toBe("BA");
    expect(res.fields.contributes.agents).toEqual(["agents/roster.json"]);
    const listing = raw.listing as {
      category: string;
      cover: string;
      icon: string;
      screenshots: { src: string }[];
    };
    expect(listing.category).toBe("apps");
    for (const rel of [listing.cover, listing.icon, ...listing.screenshots.map((s) => s.src)]) {
      expect(fs.existsSync(path.join(EXT_DIR, rel)), rel).toBe(true);
    }
    expect(listing.screenshots.length).toBeGreaterThanOrEqual(2);
    expect(listing.screenshots.length).toBeLessThanOrEqual(3);
  });

  it("contributes ONE section with the eight pages in order (Business Hub second), and the agency topbar slot", () => {
    const res = parseManifestV2(BUSINESS_AGENCY_PLUGIN_ID, readManifest());
    if (!res.ok) throw new Error(res.error);
    const c = res.fields.contributes;
    expect(c.navSection?.title).toBe("Business & Agency");
    expect(c.navSection?.items?.map((i) => [i.page, i.label])).toEqual([
      ["business-hq", "Business HQ"],
      ["hub", "Business Hub"],
      ["command-ceo", "Command"],
      ["clients", "Clients"],
      ["people-network", "My Network"],
      ["opportunities", "Register"],
      ["funnels", "Funnels & Forms"],
      ["business", "Business settings"],
    ]);
    // Every page is a builtin the control UI routes on the same tab.
    for (const p of c.pages) expect(p.builtin).toBe(p.tab);
    expect(c.topbarSlots).toEqual([
      expect.objectContaining({ id: "agency-selector", builtin: "agency-selector" }),
    ]);
    expect(c.tools).toEqual([
      "lead_generation",
      "lead_scrape",
      "client_contacts",
      "business_objects",
      "business_hub",
      "people_network",
    ]);
  });

  it("declares exactly the seam's methods, scopes and legacy aliases", () => {
    const res = parseManifestV2(BUSINESS_AGENCY_PLUGIN_ID, readManifest());
    if (!res.ok) throw new Error(res.error);
    const table = listBusinessAgencyMethods();
    expect(table.length).toBeGreaterThan(350);
    expect(res.fields.contributes.rpc.map((r) => [r.method, r.scope])).toEqual(
      table.map((m) => [m.method, m.scope]),
    );
    expect(res.fields.contributes.rpcAliases.map((a) => [a.method, a.target, a.scope])).toEqual(
      table.map((m) => [m.legacy, m.method, m.scope]),
    );
  });

  it("keeps secrets write-only and payment providers optional", () => {
    const raw = readManifest() as {
      configSchema: { properties: Record<string, { writeOnly?: boolean }> };
    };
    for (const key of ["whopApiKey", "stripeSecretKey", "squareAccessToken"]) {
      expect(raw.configSchema.properties[key]?.writeOnly, key).toBe(true);
    }
  });

  it("ships the business roster agents with real tool names", () => {
    const roster = JSON.parse(
      fs.readFileSync(path.join(EXT_DIR, "agents/roster.json"), "utf8"),
    ) as {
      agents: { id: string; toolsAllow?: string[]; systemPrompt: string }[];
    };
    expect(roster.agents.map((a) => a.id)).toEqual([...BUSINESS_AGENCY_AGENT_IDS]);
    for (const a of roster.agents) {
      expect(a.systemPrompt.length).toBeGreaterThan(200);
      expect(a.toolsAllow ?? []).not.toContain("lead");
      expect(a.toolsAllow ?? []).not.toContain("funnel");
    }
    // …and they left the core roster (and its packs).
    const coreIds = new Set(STANDARD_AGENT_ROSTER.map((a) => a.id));
    const packIds = new Set(Object.values(ROSTER_PACKS).flat());
    for (const id of BUSINESS_AGENCY_AGENT_IDS) {
      expect(coreIds.has(id), id).toBe(false);
      expect(packIds.has(id), id).toBe(false);
    }
  });
});

describe("business-agency core seam", () => {
  it("maps legacy names into the plugin namespace", () => {
    expect(businessAgencyPluginMethod("clients.list")).toBe("business-agency.clients.list");
    expect(businessAgencyPluginMethod("agency.ops.agencies.list")).toBe(
      "business-agency.agency.ops.agencies.list",
    );
    expect(isBusinessAgencyLegacyMethod("hq.progress.get")).toBe(true);
    // Stays core: typed relations, priorities, app branding, inbox, research.
    for (const m of [
      "objrel.link",
      "priorities.add",
      "branding.get",
      "gmail.list",
      "research:status",
    ]) {
      expect(isBusinessAgencyLegacyMethod(m), m).toBe(false);
    }
  });

  it("core no longer registers or advertises any business method", async () => {
    const { coreGatewayHandlers } = await import("../gateway/server-methods.js");
    const advertised = new Set(listGatewayMethods());
    for (const m of listBusinessAgencyMethods()) {
      expect(coreGatewayHandlers[m.legacy], m.legacy).toBeUndefined();
      expect(advertised.has(m.legacy), m.legacy).toBe(false);
    }
    // Core surfaces that stayed core are still there.
    expect(coreGatewayHandlers["objrel.link"]).toBeTypeOf("function");
    expect(coreGatewayHandlers["priorities.add"]).toBeTypeOf("function");
  });

  it("business tools are empty slots while the plugin is off", () => {
    for (const tool of [
      createLeadTool(),
      createLeadScrapeTool(),
      createClientContactsTool(),
      createBusinessObjectsTool(),
    ]) {
      expect(isEmptyToolSlot(tool), tool.name).toBe(true);
    }
  });

  it("business cron jobs are paused (not disabled) while the plugin is off", () => {
    expect(isBusinessAgencyCronJob("agency-operating-loop")).toBe(true);
    expect(isBusinessAgencyCronJob("ceo-hourly-insights")).toBe(true);
    expect(isBusinessAgencyCronJob("agency-sop:ceo-weekly-operating-review:w1")).toBe(true);
    expect(isBusinessAgencyCronJob("oversight-client-snapshot")).toBe(true);
    expect(isBusinessAgencyCronJob("oversight-morning-brief")).toBe(false);
    expect(isBusinessAgencyCronJob("proactive-daily-brief")).toBe(false);
    expect(businessAgencyCronSkipReason("agency-operating-loop", () => false)).toMatch(
      /turned off/,
    );
    expect(businessAgencyCronSkipReason("agency-operating-loop", () => true)).toBeNull();
    expect(businessAgencyCronSkipReason("heartbeat-proactive", () => false)).toBeNull();
    expect(isBusinessAgencyActive()).toBe(false);
  });

  it("reads payment keys from write-only plugin settings", () => {
    const cfg = {
      plugins: {
        entries: { "business-agency": { config: { whopApiKey: " whop_x ", stripeSecretKey: "" } } },
      },
    };
    expect(readBusinessAgencyProviderKey("whop", () => cfg)).toBe("whop_x");
    expect(readBusinessAgencyProviderKey("stripe", () => cfg)).toBeNull();
    expect(readBusinessAgencyProviderKey("square", () => ({}))).toBeNull();
  });
});

describe("business-agency keep-on migration", () => {
  const cfgOf = (c: unknown) => c as InfinibotConfig;

  it("fresh install: no data, stays off, decision recorded once", () => {
    const stateDir = tmp();
    const res = applyCoreSurfacePluginMigrations({ config: cfgOf({}), stateDir });
    expect(res.changes).toEqual([]);
    const markers = JSON.parse(
      fs.readFileSync(path.join(stateDir, "plugin-migrations.json"), "utf8"),
    );
    expect(markers["core-surface:business-agency"]).toMatchObject({ result: "no-data" });
  });

  it("auto-imported agency rows and HQ progress are not business data", () => {
    const stateDir = tmp();
    sqlite(path.join(stateDir, "agency-operations", "agency.db"), [
      "CREATE TABLE agencies (id TEXT)",
      "INSERT INTO agencies VALUES ('legacy-unassigned')",
      "CREATE TABLE agency_projects (id TEXT)",
      "INSERT INTO agency_projects VALUES ('p1')",
      "CREATE TABLE clients (id TEXT)",
    ]);
    fs.writeFileSync(
      path.join(stateDir, "hq-progress.json"),
      JSON.stringify({ version: 1, events: [{ kind: "task.done" }] }),
    );
    fs.writeFileSync(
      path.join(stateDir, "business.json"),
      JSON.stringify({ businesses: [{ id: "b1", name: "Me", clients: [] }], clients: [] }),
    );
    expect(detectBusinessAgencyData([stateDir])).toEqual([]);
  });

  it("detects clients, register rows and funnels", () => {
    const stateDir = tmp();
    sqlite(path.join(stateDir, "agency-operations", "agency.db"), [
      "CREATE TABLE clients (id TEXT)",
      "INSERT INTO clients VALUES ('c1')",
    ]);
    sqlite(path.join(stateDir, "decision.db"), [
      "CREATE TABLE decisions (id TEXT)",
      "INSERT INTO decisions VALUES ('d1')",
    ]);
    const legacy = tmp("ba-legacy-");
    sqlite(path.join(legacy, "funnels", "funnels.db"), [
      "CREATE TABLE funnels (id TEXT)",
      "INSERT INTO funnels VALUES ('f1')",
    ]);
    const reasons = detectBusinessAgencyData([stateDir, legacy]);
    expect(reasons.join(" | ")).toMatch(/agency workspace \(clients\)/);
    expect(reasons.join(" | ")).toMatch(/decisions register/);
    expect(reasons.join(" | ")).toMatch(/funnels store/);
  });

  it("existing install with data: kept ON, business agents handed to the plugin", () => {
    const stateDir = tmp();
    sqlite(path.join(stateDir, "opportunity.db"), [
      "CREATE TABLE opportunities (id TEXT)",
      "INSERT INTO opportunities VALUES ('o1')",
    ]);
    const config = cfgOf({
      plugins: { entries: { telegram: { enabled: true } } },
      agents: {
        list: [
          { id: "client-director", name: "CD", systemPrompt: "x", _seedVersion: "agency-v10" },
          { id: "ledger", name: "Mine", systemPrompt: "custom" },
          { id: "main", name: "ASH", systemPrompt: "x", _seedVersion: "agency-v10" },
        ],
      },
    });
    const res = applyCoreSurfacePluginMigrations({ config, stateDir });
    const cfg = res.config as unknown as {
      plugins: { entries: Record<string, { enabled?: boolean }> };
      agents: { list: Record<string, unknown>[] };
    };
    expect(cfg.plugins.entries["business-agency"]).toEqual({ enabled: true });
    expect(cfg.plugins.entries.telegram).toEqual({ enabled: true });
    const byId = Object.fromEntries(cfg.agents.list.map((a) => [a.id, a]));
    expect(byId["client-director"]._plugin).toBe("business-agency");
    expect(byId.ledger._plugin).toBeUndefined(); // operator-customised
    expect(byId.main._plugin).toBeUndefined(); // core agent
    expect(res.changes.join("\n")).toMatch(/kept ON/);
    // The input config object is not mutated.
    expect(
      (config as unknown as { agents: { list: Record<string, unknown>[] } }).agents.list[0]._plugin,
    ).toBeUndefined();
  });

  it("an explicit choice always wins, even with data", () => {
    const stateDir = tmp();
    sqlite(path.join(stateDir, "risk.db"), [
      "CREATE TABLE risks (id TEXT)",
      "INSERT INTO risks VALUES ('r')",
    ]);
    const res = applyCoreSurfacePluginMigrations({
      config: cfgOf({ plugins: { entries: { "business-agency": { enabled: false } } } }),
      stateDir,
    });
    expect(
      (res.config as unknown as { plugins: { entries: Record<string, { enabled: boolean }> } })
        .plugins.entries["business-agency"].enabled,
    ).toBe(false);
  });

  it("adoption is idempotent", () => {
    const config = cfgOf({
      agents: { list: [{ id: "scout", name: "S", systemPrompt: "x", _seedVersion: "v" }] },
    });
    expect(adoptBusinessAgencyAgents(config).adopted).toEqual(["scout"]);
    expect(adoptBusinessAgencyAgents(config).adopted).toEqual([]);
  });
});

// The first load transpiles the plugin-sdk tree through jiti when dist/ is
// absent (fresh worktree); later loads hit its cache.
describe("business-agency plugin load", { timeout: 300_000 }, () => {
  function bundledWithPlugin(): string {
    const dir = tmp("ba-bundled-");
    fs.cpSync(EXT_DIR, path.join(dir, "business-agency"), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}assets${path.sep}`),
    });
    process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = dir;
    return dir;
  }

  it("is off by default and registers nothing", () => {
    bundledWithPlugin();
    const registry = loadInfiniBotPlugins({ cache: false, config: {} });
    const rec = registry.plugins.find((p) => p.id === BUSINESS_AGENCY_PLUGIN_ID);
    expect(rec?.status).toBe("disabled");
    expect(
      Object.keys(registry.gatewayHandlers).some(
        (m) => m.startsWith("business") || m.startsWith("agency.") || m.startsWith("clients."),
      ),
    ).toBe(false);
  });

  it("when enabled registers namespaced methods, legacy aliases and fills the tool slots", async () => {
    bundledWithPlugin();
    process.env.INFINIBOT_STATE_DIR = tmp("ba-state-");
    const registry = loadInfiniBotPlugins({
      cache: false,
      config: { plugins: { entries: { "business-agency": { enabled: true } } } },
    });
    const rec = registry.plugins.find((p) => p.id === BUSINESS_AGENCY_PLUGIN_ID);
    expect(rec?.status, rec?.error).toBe("loaded");
    const errors = registry.diagnostics.filter(
      (d) => d.pluginId === BUSINESS_AGENCY_PLUGIN_ID && d.level === "error",
    );
    expect(errors).toEqual([]);
    for (const m of listBusinessAgencyMethods()) {
      expect(registry.gatewayHandlers[m.method], m.method).toBeTypeOf("function");
      expect(registry.gatewayHandlers[m.legacy], m.legacy).toBe(registry.gatewayHandlers[m.method]);
    }

    setActivePluginRegistry(registry, "ba-test");
    expect(isBusinessAgencyActive()).toBe(true);
    expect(resolvePluginMethodScope("business-agency.hq.progress.get")).toBe("read");
    for (const name of ["lead_generation", "lead_scrape", "client_contacts", "business_objects"]) {
      expect(isCoreToolSlotFilled(name), name).toBe(true);
    }
    expect(isEmptyToolSlot(createClientContactsTool())).toBe(false);

    // A legacy alias lazy-loads its core handler module and answers.
    const handler = registry.gatewayHandlers["hq.progress.get"];
    const result = await new Promise<{ ok: boolean; payload: unknown }>((resolve) => {
      void handler({
        req: { type: "req", id: "1", method: "hq.progress.get" },
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload) => resolve({ ok, payload }),
        context: {} as never,
      } as never);
    });
    expect(result.ok).toBe(true);
  });
});
