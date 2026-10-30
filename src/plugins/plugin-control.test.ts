import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(() => ({ scheduled: true, delayMs: 400 })),
}));

import {
  AA_TEXT,
  buildAppearanceStylesheet,
  contrastRatio,
  parseAppearanceManifest,
  resolvePluginAppearance,
  validateAppearanceOverride,
  DEFAULT_APPEARANCE,
} from "./appearance.js";
import { buildContributionCatalog, listPermissionItems } from "./contributions.js";
import {
  isPluginHttpRouteActive,
  pluginMethodBlockedReason,
  resetPluginHostStateForTests,
  syncPluginHostStateFromConfig,
} from "./host-state.js";
import { loadInfiniBotPlugins } from "./loader.js";
import { loadPluginManifest } from "./manifest.js";
import { setActivePluginRegistry } from "./runtime.js";
import { buildGatewayReloadPlan, diffConfigPaths } from "../gateway/config-reload.js";
import {
  maskPluginConfig,
  mergePluginConfig,
  pluginGatewayHandlers,
  secretConfigKeys,
} from "../gateway/server-methods/plugins.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const tempDirs: string[] = [];
function tempDir(prefix = "pp") {
  const dir = path.join(os.tmpdir(), `infinibot-${prefix}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── appearance ───────────────────────────────────────────────────────────

describe("appearance manifest", () => {
  it("fills token defaults when the block is absent", () => {
    const res = parseAppearanceManifest("demo", undefined);
    expect(res.ok && res.appearance).toEqual(DEFAULT_APPEARANCE);
  });

  it("requires InfiniBot tokens for colour defaults", () => {
    const hex = parseAppearanceManifest("demo", { accent: "#ff00aa" });
    expect(hex.ok).toBe(false);
    expect(!hex.ok && hex.error).toMatch(/InfiniBot token/);
    const tint = parseAppearanceManifest("demo", { tint: "tomato" });
    expect(tint.ok).toBe(false);
    const ok = parseAppearanceManifest("demo", { accent: "token:info", tint: "token:accent" });
    expect(ok.ok).toBe(true);
    const varHex = parseAppearanceManifest("demo", {
      variables: [{ name: "--plugin-demo-x", type: "color", default: "#123456" }],
    });
    expect(varHex.ok).toBe(false);
  });

  it("namespaces custom variables and validates ranges/layout", () => {
    expect(
      parseAppearanceManifest("demo", {
        variables: [{ name: "--g-primary", type: "color", default: "token:primary" }],
      }).ok,
    ).toBe(false);
    expect(parseAppearanceManifest("demo", { fontScale: 2 }).ok).toBe(false);
    expect(parseAppearanceManifest("demo", { density: "cozy" }).ok).toBe(false);
    expect(parseAppearanceManifest("demo", { monogram: "ABCD" }).ok).toBe(false);
    expect(
      parseAppearanceManifest("demo", {
        layout: [
          { id: "side", label: "Side", type: "select", options: ["left", "right"], default: "up" },
        ],
      }).ok,
    ).toBe(false);
    const good = parseAppearanceManifest("demo", {
      layout: [
        { id: "side", label: "Side", type: "select", options: ["left", "right"], default: "left" },
      ],
      variables: [
        {
          name: "--plugin-demo-glow",
          label: "Glow",
          type: "color",
          default: "token:success",
          role: "ui",
        },
      ],
    });
    expect(good.ok).toBe(true);
  });

  it("rejects a v2 manifest whose appearance violates the rules", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "infinibot.plugin.json"),
      JSON.stringify({
        manifestVersion: 2,
        id: "demo",
        configSchema: { type: "object" },
        engines: { "infinibot-plugin-api": "^2.0.0" },
        appearance: { accent: "#abcdef" },
      }),
    );
    const res = loadPluginManifest(dir);
    expect(res.ok).toBe(false);
  });

  it("keeps manifests without appearance valid (sibling plugins)", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "infinibot.plugin.json"),
      JSON.stringify({
        manifestVersion: 2,
        id: "other",
        configSchema: { type: "object" },
        engines: { "infinibot-plugin-api": "^2.0.0" },
        contributes: {
          tools: [{ name: "other_quote", trust: "read" }],
          cron: [{ id: "scan", schedule: "*/15 * * * *", defaultEnabled: false }],
          sidecars: [{ id: "agent", image: "ghcr.io/x@sha256:abc", ports: [8081] }],
          somethingNew: [{ id: "x" }],
        },
      }),
    );
    const res = loadPluginManifest(dir);
    expect(res.ok).toBe(true);
    expect(res.ok && res.manifest.v2?.catalog.items.map((i) => i.key)).toEqual([
      "tool:other_quote",
      "cron:scan",
      "sidecar:agent",
    ]);
  });
});

describe("appearance contrast + scoping", () => {
  it("default appearance overrides no core tokens", () => {
    const r = resolvePluginAppearance("demo", DEFAULT_APPEARANCE, {});
    expect(r.customized).toBe(false);
    for (const theme of ["dark", "light"] as const) {
      expect(
        Object.keys(r.themes[theme].vars).some((k) => k.startsWith("--g-") || k === "--accent"),
      ).toBe(false);
    }
    // The SDK accent is still AA-safe: gold passes on dark (token var kept)
    // but is nudged darker on the white light-theme surface.
    expect(r.themes.dark.vars["--plugin-accent"]).toMatch(/^var\(--g-primary/);
    const light = r.themes.light.vars["--plugin-accent"];
    expect(light).toMatch(/^#/);
    expect(contrastRatio(light, "#ffffff")).toBeGreaterThanOrEqual(AA_TEXT);
    expect(r.adjustments).toEqual([
      expect.objectContaining({ theme: "light", field: "accent (token:primary)", from: "#fbbf24" }),
    ]);
  });

  it("auto-adjusts a colour that fails AA in one theme only", () => {
    // Pale yellow: fine on the dark surface, unreadable on white.
    const r = resolvePluginAppearance("demo", DEFAULT_APPEARANCE, { accent: "#fde68a" });
    const light = r.adjustments.filter((a) => a.theme === "light" && a.field === "accent");
    const dark = r.adjustments.filter((a) => a.theme === "dark" && a.field === "accent");
    expect(light).toHaveLength(1);
    expect(dark).toHaveLength(0);
    expect(contrastRatio(light[0].to, "#ffffff")).toBeGreaterThanOrEqual(AA_TEXT);
    expect(r.themes.light.vars["--g-primary"]).toBe(light[0].to);
    expect(r.themes.dark.vars["--g-primary"]).toBe("#fde68a");
    expect(r.themes.light.contrast.accentOnSurface).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("adjusts dark-theme failures toward white", () => {
    const r = resolvePluginAppearance("demo", DEFAULT_APPEARANCE, { accent: "#1e3a8a" });
    const dark = r.adjustments.find((a) => a.theme === "dark");
    expect(dark).toBeTruthy();
    expect(contrastRatio(dark!.to, "#0f0f0f")).toBeGreaterThanOrEqual(AA_TEXT);
    expect(r.adjustments.find((a) => a.theme === "light")).toBeUndefined();
  });

  it("reduces an over-strong tint so body text stays AA", () => {
    const r = resolvePluginAppearance("demo", DEFAULT_APPEARANCE, {
      tint: "#ff0000",
      tintStrength: 0.3,
    });
    expect(r.adjustments.some((a) => a.field === "tintStrength")).toBe(true);
    for (const theme of ["dark", "light"] as const) {
      expect(r.themes[theme].contrast.textOnSurface).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("scopes every rule to the plugin container", () => {
    const a = resolvePluginAppearance("infinicode", DEFAULT_APPEARANCE, {
      accent: "#22d3ee",
      density: "compact",
    });
    const b = resolvePluginAppearance("other", DEFAULT_APPEARANCE, { accent: "#f472b6" });
    const css = buildAppearanceStylesheet([a, b]);
    const selectors = css.split("\n").filter((l) => l.endsWith("{"));
    expect(selectors).toHaveLength(4);
    for (const sel of selectors)
      expect(sel).toMatch(/\[data-plugin-scope="(infinicode|other)"\] \{$/);
    expect(css).toContain('[data-plugin-scope="infinicode"] {');
    expect(css).toContain(':root[data-theme="light"] [data-plugin-scope="infinicode"] {');
    expect(css).not.toMatch(/^:root \{/m);
    expect(css).not.toMatch(/^body/m);
  });

  it("drops unsafe plugin ids and CSS injection characters", () => {
    const r = resolvePluginAppearance('x"] body', DEFAULT_APPEARANCE, {});
    expect(buildAppearanceStylesheet([r])).toBe("");
    const bad = validateAppearanceOverride(DEFAULT_APPEARANCE, {
      accent: "red; } body { color: red",
    });
    expect(bad.ok).toBe(false);
    expect(validateAppearanceOverride(DEFAULT_APPEARANCE, { nope: 1 }).ok).toBe(false);
  });
});

// ── contributions + permissions ──────────────────────────────────────────

const infinicodeManifestRaw = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "extensions/infinicode/infinibot.plugin.json"), "utf-8"),
) as Record<string, unknown>;

describe("contribution catalog", () => {
  it("flattens InfiniCode's declarations with permission dependencies", () => {
    const { items } = buildContributionCatalog(infinicodeManifestRaw);
    const keys = items.map((i) => i.key);
    expect(keys).toContain("nav:inficode");
    expect(keys).toContain("page:inficode");
    expect(keys).toContain("rpc:infinicode.fleet.list");
    expect(keys).toContain("http:/plugins/infinicode/commands");
    expect(keys).toContain("service:infinicode-fleet");
    expect(items.find((i) => i.key === "rpc:infinicode.command.request")?.requires).toEqual([
      "exec",
    ]);
    expect(items.find((i) => i.key === "http:/plugins/infinicode/commands")?.requires).toEqual([
      "exec",
    ]);
    expect(items.find((i) => i.key === "nav:inficode")?.live).toBe(true);
  });

  it("derives implicit requirements (exec tools, MCP secrets/hosts) and importers", () => {
    const { items, importers } = buildContributionCatalog({
      contributes: {
        rpc: [{ method: "x.import.csv", scope: "admin" }],
        tools: [{ name: "x_shell", trust: "exec" }],
        mcpServers: [{ id: "m", url: "https://api.example.com/mcp", auth: "secret:X_TOKEN" }],
        importers: [
          { id: "csv", label: "CSV", method: "x.import.csv" },
          { id: "ghost", label: "Ghost", method: "x.not.declared" },
        ],
      },
    });
    expect(items.find((i) => i.key === "tool:x_shell")?.requires).toEqual(["exec"]);
    expect(items.find((i) => i.key === "mcp:m")?.requires.sort()).toEqual([
      "network:api.example.com",
      "secrets:X_TOKEN",
    ]);
    expect(importers.map((i) => i.id)).toEqual(["csv"]);
  });

  it("lists grantable permission keys with consent text", () => {
    const perms = listPermissionItems({
      network: ["a.com"],
      exec: true,
      secrets: ["K"],
      credits: false,
    });
    expect(perms.map((p) => p.key)).toEqual(["network:a.com", "secrets:K", "exec"]);
    expect(perms.every((p) => p.consent.length > 10)).toBe(true);
  });
});

// ── config reload classification ─────────────────────────────────────────

describe("config reload: live plugin keys", () => {
  const base = { plugins: { entries: { infinicode: { enabled: true } } } };
  it("appearance / contributions / permissions changes do not restart", () => {
    for (const patch of [
      { appearance: { accent: "#22d3ee" } },
      { contributions: { disabled: ["nav:inficode"] } },
      { permissions: { revoked: ["exec"] } },
    ]) {
      const next = { plugins: { entries: { infinicode: { enabled: true, ...patch } } } };
      const plan = buildGatewayReloadPlan(diffConfigPaths(base, next));
      expect(plan.restartGateway).toBe(false);
    }
  });
  it("a brand-new entry holding only live keys does not restart", () => {
    const next = {
      plugins: {
        entries: { infinicode: { enabled: true }, other: { appearance: { density: "compact" } } },
      },
    };
    expect(buildGatewayReloadPlan(diffConfigPaths(base, next)).restartGateway).toBe(false);
    const fromNothing = buildGatewayReloadPlan(
      diffConfigPaths({}, { plugins: { entries: { x: { appearance: {} } } } }),
    );
    expect(fromNothing.restartGateway).toBe(false);
  });
  it("enable/config changes still restart", () => {
    const off = { plugins: { entries: { infinicode: { enabled: false } } } };
    expect(buildGatewayReloadPlan(diffConfigPaths(base, off)).restartGateway).toBe(true);
    const cfg = { plugins: { entries: { infinicode: { enabled: true, config: { a: 1 } } } } };
    expect(buildGatewayReloadPlan(diffConfigPaths(base, cfg)).restartGateway).toBe(true);
  });
});

// ── gateway RPCs against a real loaded fixture plugin ────────────────────

const FIXTURE_ID = "ppdemo";
const FIXTURE_MANIFEST = {
  manifestVersion: 2,
  id: FIXTURE_ID,
  name: "PP Demo",
  version: "1.2.3",
  publisher: "acme",
  license: "MIT",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: { region: { type: "string" }, apiToken: { type: "string" } },
  },
  engines: { "infinibot-plugin-api": "^2.0.0" },
  contributes: {
    nav: [{ tab: "ppdemo", label: "PP Demo", group: "Agents" }],
    pages: [{ tab: "ppdemo", route: "/ppdemo", entry: "/plugins/ppdemo/page.js" }],
    rpc: [
      { method: "ppdemo.list", scope: "read" },
      { method: "ppdemo.run", scope: "write", requires: ["exec"] },
      { method: "ppdemo.import.csv", scope: "admin" },
    ],
    http: [{ path: "/plugins/ppdemo/hook", requires: ["network:api.example.com"] }],
    tools: [{ name: "ppdemo_shell", trust: "exec" }],
    cron: [{ id: "nightly", schedule: "0 3 * * *", defaultEnabled: false }],
    importers: [{ id: "csv", label: "CSV import", method: "ppdemo.import.csv" }],
  },
  permissions: { network: ["api.example.com"], exec: true },
  appearance: {
    accent: "token:primary",
    monogram: "PD",
    variables: [
      {
        name: "--plugin-ppdemo-glow",
        label: "Glow",
        type: "color",
        default: "token:success",
        role: "ui",
      },
    ],
  },
};
const FIXTURE_BODY = `module.exports = { id: "${FIXTURE_ID}", register(api) {
  api.registerGatewayMethod("ppdemo.list", ({ respond }) => respond(true, { items: [1] }));
  api.registerGatewayMethod("ppdemo.run", ({ respond }) => respond(true, { ran: true }));
  api.registerGatewayMethod("ppdemo.import.csv", ({ params, respond }) => respond(true, { imported: String(params.csv ?? "").split("\\n").length }));
  api.registerHttpRoute({ path: "/plugins/ppdemo/hook", handler: (_req, res) => { res.end("ok"); } });
  api.logger.info("ppdemo registered");
} };`;

describe("plugins.* RPCs", () => {
  let configPath = "";
  let stateDir = "";
  const prevEnv = { ...process.env };

  beforeAll(() => {
    const pluginDir = tempDir("ppfixture");
    fs.writeFileSync(path.join(pluginDir, "index.js"), FIXTURE_BODY);
    fs.writeFileSync(
      path.join(pluginDir, "infinibot.plugin.json"),
      JSON.stringify(FIXTURE_MANIFEST),
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "ppdemo", infinibot: { extensions: ["./index.js"] } }),
    );
    const root = tempDir("ppstate");
    stateDir = path.join(root, "state");
    configPath = path.join(root, "infinibot.json");
    process.env.INFINIBOT_STATE_DIR = stateDir;
    process.env.INFINIBOT_CONFIG_PATH = configPath;
    process.env.INFINIBOT_DISABLE_CONFIG_CACHE = "1";
    process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = tempDir("nobundled");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          slots: { memory: "none" },
          load: { paths: [pluginDir] },
          entries: {
            [FIXTURE_ID]: { enabled: true, config: { region: "eu", apiToken: "s3cret" } },
          },
        },
      }),
    );
  });

  afterAll(() => {
    process.env = prevEnv;
  });

  beforeEach(() => {
    resetPluginHostStateForTests();
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const registry = loadInfiniBotPlugins({
      config: cfg,
      cache: false,
      workspaceDir: tempDir("ws"),
    });
    const rec = registry.plugins.find((p) => p.id === FIXTURE_ID);
    expect(rec?.status, rec?.error).toBe("loaded");
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    resetPluginHostStateForTests();
  });

  async function call(method: string, params: Record<string, unknown>) {
    let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
    await pluginGatewayHandlers[method]({
      req: { type: "req", id: "1", method, params } as any,
      params,
      client: null,
      isWebchatConnect: () => false,
      context: {} as any,
      respond: (ok: boolean, payload?: unknown, error?: unknown) => {
        out = { ok, payload, error };
      },
    });
    return out;
  }
  const readCfg = () => JSON.parse(fs.readFileSync(configPath, "utf-8"));

  it("list reports tier, health, appearance and off contributions", async () => {
    const res = await call("plugins.list", {});
    const p = res.payload.plugins.find((x: any) => x.id === FIXTURE_ID);
    expect(p.tier).toBe("community");
    expect(p.health.state).toBe("ok");
    expect(p.license).toBe("MIT");
    expect(p.appearance.monogram).toBe("PD");
    expect(p.disabledContributions).toEqual(["cron:nightly"]); // default-off
  });

  it("get returns every tab's data", async () => {
    const res = await call("plugins.get", { id: FIXTURE_ID });
    expect(res.ok).toBe(true);
    expect(res.payload.contributions.map((c: any) => c.key)).toContain("tool:ppdemo_shell");
    expect(res.payload.permissions.find((p: any) => p.key === "exec").dependents.sort()).toEqual([
      "rpc:ppdemo.run",
      "tool:ppdemo_shell",
    ]);
    expect(res.payload.importers.map((i: any) => i.id)).toEqual(["csv"]);
    expect(res.payload.config.secretKeys).toEqual(["apiToken"]);
    expect(res.payload.pluginApiRange).toBe("^2.0.0");
    expect(res.payload.versions.current).toBe("1.2.3");
  });

  it("contribution toggle applies live (RPC gate) and persists", async () => {
    expect(pluginMethodBlockedReason("ppdemo.list")).toBeNull();
    const off = await call("plugins.contributions.set", {
      id: FIXTURE_ID,
      key: "rpc:ppdemo.list",
      enabled: false,
    });
    expect(off.ok).toBe(true);
    expect(off.payload.restartRequired).toBe(false);
    expect(pluginMethodBlockedReason("ppdemo.list")).toMatch(/turned off/);
    expect(readCfg().plugins.entries[FIXTURE_ID].contributions.disabled).toEqual([
      "rpc:ppdemo.list",
    ]);
    // A default-off cron job can be turned on.
    await call("plugins.contributions.set", { id: FIXTURE_ID, key: "cron:nightly", enabled: true });
    expect(readCfg().plugins.entries[FIXTURE_ID].contributions.enabled).toEqual(["cron:nightly"]);
    await call("plugins.contributions.set", {
      id: FIXTURE_ID,
      key: "rpc:ppdemo.list",
      enabled: true,
    });
    expect(pluginMethodBlockedReason("ppdemo.list")).toBeNull();
    const unknown = await call("plugins.contributions.set", {
      id: FIXTURE_ID,
      key: "rpc:nope",
      enabled: false,
    });
    expect(unknown.ok).toBe(false);
  });

  it("the gateway dispatcher refuses a switched-off plugin RPC", async () => {
    const { handleGatewayRequest } = await import("../gateway/server-methods.js");
    await call("plugins.contributions.set", {
      id: FIXTURE_ID,
      key: "rpc:ppdemo.list",
      enabled: false,
    });
    let res: any;
    await handleGatewayRequest({
      req: { type: "req", id: "1", method: "ppdemo.list", params: {} },
      client: { connect: { role: "operator", scopes: ["operator.admin"] } },
      isWebchatConnect: () => false,
      context: {},
      extraHandlers: { "ppdemo.list": ({ respond }: any) => respond(true, { items: [1] }) },
      respond: (ok: boolean, payload?: unknown, error?: any) => {
        res = { ok, payload, error };
      },
    } as any);
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/turned off/);
    await call("plugins.contributions.set", {
      id: FIXTURE_ID,
      key: "rpc:ppdemo.list",
      enabled: true,
    });
  });

  it("revoking a permission cascades to dependent contributions, live", async () => {
    const res = await call("plugins.permissions.set", {
      id: FIXTURE_ID,
      key: "exec",
      granted: false,
    });
    expect(res.ok).toBe(true);
    expect(res.payload.disabledNow.sort()).toEqual(["rpc:ppdemo.run", "tool:ppdemo_shell"]);
    expect(pluginMethodBlockedReason("ppdemo.run")).toMatch(/turned off/);
    expect(pluginMethodBlockedReason("ppdemo.list")).toBeNull();
    const states = res.payload.contributions;
    expect(states.find((c: any) => c.key === "rpc:ppdemo.run")).toMatchObject({
      enabled: false,
      offReason: "permission",
      blockedBy: ["exec"],
    });
    // Network revoke blocks the HTTP route.
    await call("plugins.permissions.set", {
      id: FIXTURE_ID,
      key: "network:api.example.com",
      granted: false,
    });
    expect(isPluginHttpRouteActive(FIXTURE_ID, "/plugins/ppdemo/hook")).toBe(false);
    // Grant back.
    const back = await call("plugins.permissions.set", {
      id: FIXTURE_ID,
      key: "exec",
      granted: true,
    });
    expect(back.payload.enabledNow.sort()).toEqual(["rpc:ppdemo.run", "tool:ppdemo_shell"]);
    await call("plugins.permissions.set", {
      id: FIXTURE_ID,
      key: "network:api.example.com",
      granted: true,
    });
    expect(isPluginHttpRouteActive(FIXTURE_ID, "/plugins/ppdemo/hook")).toBe(true);
    expect(readCfg().plugins.entries[FIXTURE_ID].permissions).toBeUndefined();
  });

  it("the loader re-seeds live state from config", async () => {
    await call("plugins.permissions.set", { id: FIXTURE_ID, key: "exec", granted: false });
    resetPluginHostStateForTests();
    expect(pluginMethodBlockedReason("ppdemo.run")).toBeNull();
    syncPluginHostStateFromConfig(readCfg().plugins);
    expect(pluginMethodBlockedReason("ppdemo.run")).toMatch(/turned off/);
    await call("plugins.permissions.set", { id: FIXTURE_ID, key: "exec", granted: true });
  });

  it("appearance set / preview / strict / reset", async () => {
    const preview = await call("plugins.appearance.preview", {
      id: FIXTURE_ID,
      appearance: { accent: "#fde68a" },
    });
    expect(preview.ok).toBe(true);
    expect(preview.payload.adjustments.length).toBeGreaterThan(0);
    expect(readCfg().plugins.entries[FIXTURE_ID].appearance).toBeUndefined();
    const strict = await call("plugins.appearance.set", {
      id: FIXTURE_ID,
      appearance: { accent: "#fde68a" },
      strict: true,
    });
    // Token colours never trip strict mode (their text-safe nudge is host-side).
    const strictToken = await call("plugins.appearance.set", {
      id: FIXTURE_ID,
      appearance: { accent: "token:info" },
      strict: true,
    });
    expect(strictToken.ok).toBe(true);
    expect(strict.ok).toBe(false);
    expect(strict.error.message).toMatch(/contrast/);
    const set = await call("plugins.appearance.set", {
      id: FIXTURE_ID,
      appearance: {
        accent: "#22d3ee",
        density: "compact",
        variables: { "--plugin-ppdemo-glow": "#16a34a" },
      },
    });
    expect(set.ok).toBe(true);
    expect(set.payload.restartRequired).toBe(false);
    expect(readCfg().plugins.entries[FIXTURE_ID].appearance.accent).toBe("#22d3ee");
    const list = await call("plugins.list", {});
    const item = list.payload.plugins.find((x: any) => x.id === FIXTURE_ID);
    expect(item.appearance.customized).toBe(true);
    expect(item.appearance.themes.dark.vars["--g-primary"]).toBe("#22d3ee");
    const invalid = await call("plugins.appearance.set", {
      id: FIXTURE_ID,
      appearance: { variables: { "--g-bg": "#000" } },
    });
    expect(invalid.ok).toBe(false);
    const reset = await call("plugins.appearance.reset", { id: FIXTURE_ID });
    expect(reset.payload.customized).toBe(false);
    expect(readCfg().plugins.entries[FIXTURE_ID].appearance).toBeUndefined();
  });

  it("config get masks secrets; set keeps them write-only and restarts", async () => {
    const get = await call("plugins.config.get", { id: FIXTURE_ID });
    expect(get.payload.values).toEqual({ region: "eu", apiToken: { __secret: true, set: true } });
    expect(JSON.stringify(get.payload)).not.toContain("s3cret");
    const set = await call("plugins.config.set", {
      id: FIXTURE_ID,
      values: { region: "us", apiToken: { __secret: true, set: true } },
    });
    expect(set.ok).toBe(true);
    expect(set.payload.restartRequired).toBe(true);
    expect(readCfg().plugins.entries[FIXTURE_ID].config).toEqual({
      region: "us",
      apiToken: "s3cret",
    });
    const bad = await call("plugins.config.set", { id: FIXTURE_ID, values: { region: 5 } });
    expect(bad.ok).toBe(false);
  });

  it("health and logs report the plugin's own lines", async () => {
    const health = await call("plugins.health", { id: FIXTURE_ID });
    expect(health.payload.rpc).toMatchObject({ declared: 3, registered: 3, missing: [] });
    expect(health.payload.httpRoutes).toEqual(["/plugins/ppdemo/hook"]);
    const logs = await call("plugins.logs", { id: FIXTURE_ID });
    expect(
      logs.payload.lines.some(
        (l: any) => l.message === "ppdemo registered" && l.source === "plugin",
      ),
    ).toBe(true);
  });

  it("data export / import / clear round-trips the plugin data dir", async () => {
    const dir = path.join(stateDir, "plugin-data", FIXTURE_ID);
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "a.json"), '{"a":1}');
    const exp = await call("plugins.data.export", { id: FIXTURE_ID });
    expect(exp.payload.files.map((f: any) => f.path)).toEqual(["sub/a.json"]);
    const noConfirm = await call("plugins.data.clear", { id: FIXTURE_ID });
    expect(noConfirm.ok).toBe(false);
    const cleared = await call("plugins.data.clear", { id: FIXTURE_ID, confirm: FIXTURE_ID });
    expect(cleared.payload.removed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    const imp = await call("plugins.data.import", { id: FIXTURE_ID, bundle: exp.payload });
    expect(imp.payload.written).toBe(1);
    expect(fs.readFileSync(path.join(dir, "sub", "a.json"), "utf-8")).toBe('{"a":1}');
    const evil = { ...exp.payload, files: [{ path: "../../escape.txt", size: 1, base64: "eA==" }] };
    expect((await call("plugins.data.import", { id: FIXTURE_ID, bundle: evil })).ok).toBe(false);
    const viaImporter = await call("plugins.data.import", {
      id: FIXTURE_ID,
      importer: "csv",
      payload: { csv: "a\nb\nc" },
    });
    expect(viaImporter.payload).toEqual({ imported: 3 });
  });

  it("uninstall keeps or removes data and drops a load-path plugin", async () => {
    const dir = path.join(stateDir, "plugin-data", FIXTURE_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "keep.txt"), "x");
    const before = readCfg();
    const res = await call("plugins.uninstall", { id: FIXTURE_ID, keepData: true });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.payload.restartRequired).toBe(true);
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
    const after = readCfg();
    expect(after.plugins.entries[FIXTURE_ID]).toBeUndefined();
    expect(after.plugins.load.paths).toEqual([]);
    fs.writeFileSync(configPath, JSON.stringify(before));
    const removed = await call("plugins.uninstall", { id: FIXTURE_ID, keepData: false });
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    fs.writeFileSync(configPath, JSON.stringify(before));
  });
});

describe("plugins.* are admin-only", () => {
  it("rejects read/write-scoped operators and allows admin", async () => {
    const { handleGatewayRequest } = await import("../gateway/server-methods.js");
    const ask = async (method: string, scopes: string[]) => {
      let res: any;
      await handleGatewayRequest({
        req: { type: "req", id: "1", method, params: {} },
        client: { connect: { role: "operator", scopes } },
        isWebchatConnect: () => false,
        context: {},
        respond: (ok: boolean, _p?: unknown, error?: any) => {
          res = { ok, error };
        },
      } as any);
      return res;
    };
    for (const method of [
      "plugins.get",
      "plugins.contributions.set",
      "plugins.permissions.set",
      "plugins.config.get",
      "plugins.config.set",
      "plugins.appearance.get",
      "plugins.appearance.set",
      "plugins.appearance.reset",
      "plugins.health",
      "plugins.logs",
      "plugins.data.export",
      "plugins.data.import",
      "plugins.data.clear",
      "plugins.uninstall",
    ]) {
      const denied = await ask(method, ["operator.read", "operator.write"]);
      expect(denied.ok, method).toBe(false);
      expect(denied.error.message, method).toMatch(/operator.admin/);
    }
    const allowed = await ask("plugins.get", ["operator.admin"]);
    // Reaches the handler (fails only on the missing id).
    expect(allowed.error.message).toMatch(/expected \{ id \}/);
  });
});

describe("config form helpers", () => {
  it("detects secrets by hint, schema and name", () => {
    expect(
      secretConfigKeys({
        configJsonSchema: {
          properties: {
            a: { type: "string" },
            b: { type: "string", format: "password" },
            myApiKey: {},
            c: {},
          },
        },
        configUiHints: { c: { sensitive: true } },
      }).sort(),
    ).toEqual(["b", "c", "myApiKey"]);
  });
  it("masks and merges write-only secrets", () => {
    expect(maskPluginConfig({ t: "x" }, ["t", "u"])).toEqual({
      t: { __secret: true, set: true },
      u: { __secret: true, set: false },
    });
    expect(mergePluginConfig({ t: "old", a: 1 }, { a: 2, t: "" }, ["t"])).toEqual({
      a: 2,
      t: "old",
    });
    expect(mergePluginConfig({ t: "old" }, { t: "new" }, ["t"])).toEqual({ t: "new" });
    expect(mergePluginConfig({ t: "old" }, { t: null }, ["t"])).toEqual({});
  });
});
