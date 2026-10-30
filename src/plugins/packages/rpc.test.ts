/**
 * End-to-end over the gateway handlers: chunked zip upload → review →
 * commit, marketplace install, update badge → update → rollback, permission
 * re-prompt, auto-update switch, payment and cloud-policy refusals.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(() => ({ scheduled: true, delayMs: 400 })),
}));

import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { pluginGatewayHandlers } from "../../gateway/server-methods/plugins.js";
import {
  pluginPackageHandlers,
  resetPluginPackageSessionsForTests,
} from "../../gateway/server-methods/plugins-packages.js";
import { resolveConfigDir } from "../../utils.js";
import { resetPluginHostStateForTests } from "../host-state.js";
import { loadInfiniBotPlugins } from "../loader.js";
import { setActivePluginRegistry } from "../runtime.js";
import { startMockRegistry, type MockPlugin, type MockRegistry } from "./mock-registry.js";
import { fixturePackageFiles, fixturePackageZip, type FixtureOptions } from "./package-fixtures.js";
import { resolvePackagePaths } from "./store.js";
import { sha256OfBuffer } from "./zip-read.js";

const handlers = { ...pluginGatewayHandlers, ...pluginPackageHandlers };
const prevEnv = { ...process.env };
const temps: string[] = [];
let configPath = "";
let bundledDir = "";
let server: MockRegistry | null = null;

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ib-pkg-rpc-${prefix}-`));
  temps.push(dir);
  return dir;
}

type Reply = { ok: boolean; payload?: any; error?: any };
async function call(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
  let out: Reply = { ok: false };
  await handlers[method]!({
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
const writeCfg = (cfg: unknown) => fs.writeFileSync(configPath, JSON.stringify(cfg));

function reloadRegistry() {
  const registry = loadInfiniBotPlugins({
    config: readCfg(),
    cache: false,
    workspaceDir: tempDir("ws"),
  });
  setActivePluginRegistry(registry);
  return registry;
}

/** Upload a zip in chunks exactly as the Plugins page does. */
async function upload(zip: Buffer, fileName = "plugin.ibplugin.zip") {
  const begin = await call("plugins.install.begin", { fileName, sizeBytes: zip.length });
  expect(begin.ok, JSON.stringify(begin.error)).toBe(true);
  const { uploadId, chunkBytes } = begin.payload;
  let index = 0;
  for (let off = 0; off < zip.length; off += chunkBytes) {
    const res = await call("plugins.install.chunk", {
      uploadId,
      index: index++,
      data: zip.subarray(off, off + chunkBytes).toString("base64"),
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
  }
  return uploadId as string;
}

async function installFromZip(opts: FixtureOptions, accept = true) {
  const zip = await fixturePackageZip(opts);
  const uploadId = await upload(zip);
  const review = await call("plugins.install.inspect", { uploadId });
  expect(review.ok, JSON.stringify(review.error)).toBe(true);
  const commit = await call("plugins.install.commit", {
    reviewId: review.payload.reviewId,
    acceptedPermissions: accept ? review.payload.permissions.map((p: any) => p.key) : [],
  });
  return { zip, review: review.payload, commit };
}

async function useRegistry(plugins: MockPlugin[]) {
  if (server) await server.close();
  server = await startMockRegistry(plugins);
  process.env.INFINIBOT_PLUGIN_REGISTRY_URL = server.url;
  resetPluginPackageSessionsForTests();
  return server;
}

const listed = async (id: string) =>
  (await call("plugins.list")).payload.plugins.find((p: any) => p.id === id);

beforeAll(() => {
  const root = tempDir("cfg");
  configPath = path.join(root, "infinibot.json");
  process.env.INFINIBOT_CONFIG_PATH = configPath;
  process.env.INFINIBOT_DISABLE_CONFIG_CACHE = "1";
  process.env.INFINIBOT_DISABLE_PLUGIN_MANIFEST_CACHE = "1";
  // One "bundled" plugin so override rules are exercised for real.
  bundledDir = tempDir("bundled");
  const files = fixturePackageFiles({
    id: "shipped",
    name: "Shipped",
    version: "1.0.0",
    publisher: "infinibot",
  });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(bundledDir, "shipped", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = bundledDir;
});

afterAll(async () => {
  if (server) await server.close();
  process.env = prevEnv;
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  const paths = resolvePackagePaths();
  fs.rmSync(paths.extensionsDir, { recursive: true, force: true });
  fs.rmSync(paths.stateDir, { recursive: true, force: true });
  writeCfg({ plugins: { slots: { memory: "none" } } });
  resetPluginHostStateForTests();
  resetPluginPackageSessionsForTests();
  vi.mocked(scheduleGatewaySigusr1Restart).mockClear();
  delete process.env.INFINIBOT_PLUGIN_REGISTRY_URL;
  delete process.env.SAAS_MODE;
  delete process.env.FLEET_TENANT_ID;
  reloadRegistry();
});

afterEach(() => {
  resetPluginHostStateForTests();
});

describe("zip import over RPC", () => {
  it("uploads in chunks, shows the permission review, installs OFF, and lists it without a restart", async () => {
    const { zip, review, commit } = await installFromZip({
      permissions: {
        network: ["api.example.com"],
        gated: [{ id: "orders", label: "Place orders" }],
      },
      changelog: "# Changelog\n\n## 0.1.0\n- First.\n",
    });
    expect(review).toMatchObject({
      action: "install",
      currentVersion: null,
      sha256: sha256OfBuffer(zip),
      sizeBytes: zip.length,
      source: "zip",
      plugin: { id: "demo-plugin", name: "Demo Plugin", version: "0.1.0", publisher: "acme" },
      newPermissions: ["gated:orders", "network:api.example.com"],
      needsOverrideConfirmation: false,
    });
    expect(review.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "network:api.example.com", isNew: true, gated: false }),
        expect.objectContaining({
          key: "gated:orders",
          isNew: true,
          gated: true,
          label: "Place orders",
        }),
      ]),
    );
    expect(review.changelog).toMatch(/First\./);
    expect(review.notes.enable).toMatch(/does not turn the plugin on/);

    expect(commit.ok, JSON.stringify(commit.error)).toBe(true);
    expect(commit.payload).toMatchObject({
      id: "demo-plugin",
      version: "0.1.0",
      action: "install",
      restartRequired: false,
      rollbackAvailable: false,
    });
    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();

    const cfg = readCfg();
    expect(cfg.plugins.installs["demo-plugin"]).toMatchObject({
      source: "zip",
      version: "0.1.0",
      sha256: sha256OfBuffer(zip),
      reviewedPermissions: ["gated:orders", "network:api.example.com"],
    });
    expect(cfg.plugins.entries?.["demo-plugin"]).toBeUndefined();
    expect(
      fs.existsSync(path.join(resolveConfigDir(), "extensions", "demo-plugin", "index.js")),
    ).toBe(true);

    const p = await listed("demo-plugin");
    expect(p).toMatchObject({
      enabled: false,
      status: "disabled",
      origin: "global",
      version: "0.1.0",
    });
    // Still off after a real reload, and the gated permission is not granted.
    const record = reloadRegistry().plugins.find((x) => x.id === "demo-plugin");
    expect(record).toMatchObject({
      enabled: false,
      status: "disabled",
      error: "installed (not turned on yet)",
    });
    const detail = await call("plugins.get", { id: "demo-plugin" });
    expect(detail.payload.permissions.find((x: any) => x.key === "gated:orders")).toMatchObject({
      granted: false,
    });
    expect(detail.payload.versions).toMatchObject({
      source: "zip",
      managed: true,
      rollbackAvailable: false,
    });
  });

  it("refuses to commit until every requested permission is accepted", async () => {
    const zip = await fixturePackageZip({ permissions: { exec: true } });
    const review = await call("plugins.install.inspect", { uploadId: await upload(zip) });
    const refused = await call("plugins.install.commit", {
      reviewId: review.payload.reviewId,
      acceptedPermissions: [],
    });
    expect(refused.ok).toBe(false);
    expect(refused.error.details.code).toBe("permissions");
    expect(readCfg().plugins.installs).toBeUndefined();
    // The same review can then be accepted.
    const ok = await call("plugins.install.commit", {
      reviewId: review.payload.reviewId,
      acceptedPermissions: ["exec"],
    });
    expect(ok.ok).toBe(true);
    // …once: a review is single-use.
    const again = await call("plugins.install.commit", {
      reviewId: review.payload.reviewId,
      acceptedPermissions: ["exec"],
    });
    expect(again.ok).toBe(false);
    expect(again.error.message).toMatch(/expired/);
  });

  it("rejects bad uploads", async () => {
    expect((await call("plugins.install.begin", { fileName: "x.zip", sizeBytes: 0 })).ok).toBe(
      false,
    );
    const huge = await call("plugins.install.begin", {
      fileName: "x.zip",
      sizeBytes: 5 * 1024 * 1024 * 1024,
    });
    expect(huge.error.details.code).toBe("too-large");
    const begin = await call("plugins.install.begin", { fileName: "x.zip", sizeBytes: 10 });
    const id = begin.payload.uploadId;
    expect(
      (await call("plugins.install.chunk", { uploadId: id, index: 3, data: "AAAA" })).error.message,
    ).toMatch(/expected chunk 0/);
    expect((await call("plugins.install.inspect", { uploadId: id })).error.message).toMatch(
      /not complete/,
    );
    const over = await call("plugins.install.chunk", {
      uploadId: id,
      index: 0,
      data: Buffer.alloc(64).toString("base64"),
    });
    expect(over.error.message).toMatch(/larger than declared/);
    expect(
      (await call("plugins.install.chunk", { uploadId: id, index: 0, data: "AAAA" })).error.message,
    ).toMatch(/unknown or expired/);
    // Garbage that is not a zip.
    const junk = Buffer.from("this is not a zip file at all, sorry".repeat(3));
    const res = await call("plugins.install.inspect", { uploadId: await upload(junk) });
    expect(res.ok).toBe(false);
    expect(res.error.details.code).toBe("bad-zip");
    // Nothing is left in the uploads folder.
    expect(fs.readdirSync(resolvePackagePaths().uploadsDir)).toEqual([]);
  });

  it("verifies a supplied sha256", async () => {
    const zip = await fixturePackageZip();
    const bad = await call("plugins.install.inspect", {
      uploadId: await upload(zip),
      sha256: "0".repeat(64),
    });
    expect(bad.error.details.code).toBe("checksum");
    const ok = await call("plugins.install.inspect", {
      uploadId: await upload(zip),
      sha256: sha256OfBuffer(zip),
    });
    expect(ok.ok).toBe(true);
  });

  it("a zip claiming a bundled plugin's id needs explicit confirmation and a newer version", async () => {
    const older = await call("plugins.install.inspect", {
      uploadId: await upload(
        await fixturePackageZip({
          id: "shipped",
          name: "Shipped",
          version: "0.9.0",
          publisher: "infinibot",
        }),
      ),
    });
    // Older than the shipped copy: not an error, the review says it's already here.
    expect(older.ok).toBe(true);
    expect(older.payload).toMatchObject({
      action: "already-installed",
      currentVersion: "1.0.0",
      existing: { origin: "bundled" },
      permissions: expect.any(Array),
      newPermissions: [],
    });
    const nothing = await call("plugins.install.commit", {
      reviewId: older.payload.reviewId,
      acceptedPermissions: [],
    });
    expect(nothing.error.message).toMatch(/already here; turn it on/);

    const zip = await fixturePackageZip({
      id: "shipped",
      name: "Shipped",
      version: "1.5.0",
      publisher: "infinibot",
    });
    const review = await call("plugins.install.inspect", { uploadId: await upload(zip) });
    expect(review.payload).toMatchObject({
      action: "override-bundled",
      currentVersion: "1.0.0",
      needsOverrideConfirmation: true,
    });
    const refused = await call("plugins.install.commit", {
      reviewId: review.payload.reviewId,
      acceptedPermissions: [],
    });
    expect(refused.error.details.code).toBe("collision");
    const ok = await call("plugins.install.commit", {
      reviewId: review.payload.reviewId,
      acceptedPermissions: [],
      overrideBundled: true,
    });
    expect(ok.payload).toMatchObject({
      action: "override-bundled",
      version: "1.5.0",
      previousVersion: "1.0.0",
      rollbackAvailable: true,
    });
    // One row for the id, and it is the newer installed package.
    const rows = (await call("plugins.list")).payload.plugins.filter(
      (p: any) => p.id === "shipped",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: "1.5.0", origin: "global", enabled: false });
    expect(reloadRegistry().plugins.find((p) => p.id === "shipped")).toMatchObject({
      version: "1.5.0",
      origin: "global",
    });

    // Rollback returns to the bundled copy.
    const back = await call("plugins.rollback", { id: "shipped" });
    expect(back.payload).toMatchObject({ restored: "bundled", version: "1.0.0", from: "1.5.0" });
    expect(await listed("shipped")).toMatchObject({ version: "1.0.0", origin: "bundled" });
    expect(readCfg().plugins.installs?.shipped).toBeUndefined();
  });

  it("uninstall removes the package, its record and the kept previous version", async () => {
    await installFromZip({ version: "1.0.0" });
    await installFromZip({ version: "1.1.0" });
    const paths = resolvePackagePaths();
    expect(fs.readdirSync(path.join(paths.versionsDir, "demo-plugin"))).toHaveLength(1);
    const res = await call("plugins.uninstall", { id: "demo-plugin" });
    expect(res.payload).toMatchObject({ ok: true, removedPackage: true });
    expect(fs.existsSync(path.join(paths.extensionsDir, "demo-plugin"))).toBe(false);
    expect(fs.existsSync(path.join(paths.versionsDir, "demo-plugin"))).toBe(false);
    expect(readCfg().plugins.installs?.["demo-plugin"]).toBeUndefined();
  });

  it("cloud tenants cannot install uploads, URLs or third-party plugins", async () => {
    process.env.SAAS_MODE = "1";
    process.env.FLEET_TENANT_ID = "t_1";
    const res = await call("plugins.install.inspect", {
      uploadId: await upload(await fixturePackageZip()),
    });
    expect(res.ok).toBe(false);
    expect(res.error.details.code).toBe("policy");
    const url = await call("plugins.install.inspect", { url: "https://example.com/x.zip" });
    expect(url.error.message).toMatch(/marketplace only/);
  });
});

describe("marketplace, updates and rollback over RPC", () => {
  it("lists the marketplace with price, install state and compatibility", async () => {
    await installFromZip({ version: "1.0.0" });
    await useRegistry([
      { releases: [{ zip: await fixturePackageZip({ version: "1.2.0" }) }], verified: true },
      {
        releases: [
          { zip: await fixturePackageZip({ id: "pro-tool", name: "Pro Tool", version: "3.0.0" }) },
        ],
        pricing: { model: "paid", priceCents: 2900, purchaseUrl: "https://buy.example/pro-tool" },
        tokens: ["ibin1.p.tok-1"],
      },
      {
        releases: [
          {
            zip: await fixturePackageZip({
              id: "seller-tool",
              name: "Seller Tool",
              version: "1.0.0",
            }),
          },
        ],
        pricing: { model: "paid", priceCents: 1500, purchaseUrl: "https://seller.example/buy" },
        external: true,
      },
      {
        releases: [
          {
            zip: await fixturePackageZip({
              id: "future",
              name: "Future",
              version: "1.0.0",
              minHostVersion: "2099.1.1",
            }),
          },
        ],
      },
    ]);
    const res = await call("plugins.marketplace.list", { refresh: true });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.payload.registryUrl).toBe(server!.url);
    const byId = Object.fromEntries(res.payload.plugins.map((p: any) => [p.id, p]));
    expect(byId["demo-plugin"]).toMatchObject({
      priceLabel: "Free",
      compatible: true,
      installed: { version: "1.0.0", package: true, updateAvailable: true },
    });
    expect(byId["pro-tool"]).toMatchObject({
      priceLabel: "$29.00",
      installed: null,
      pricing: { model: "paid", purchaseUrl: "https://buy.example/pro-tool" },
      distribution: "hosted",
    });
    // A seller-delivered listing is shown (Buy → their page), with nothing to download.
    expect(byId["seller-tool"]).toMatchObject({
      priceLabel: "$15.00",
      distribution: "external",
      downloadUrl: null,
      installed: null,
      pricing: { purchaseUrl: "https://seller.example/buy" },
    });
    expect(byId.future).toMatchObject({ compatible: false });
    const detail = await call("plugins.marketplace.get", { id: "pro-tool" });
    expect(detail.payload.plugin.versions).toHaveLength(1);
  });

  it("installs from the marketplace; a paid plugin needs the token from its purchase page", async () => {
    await useRegistry([
      {
        releases: [
          { zip: await fixturePackageZip({ id: "pro-tool", name: "Pro Tool", version: "3.0.0" }) },
        ],
        pricing: { model: "paid", priceCents: 2900, purchaseUrl: "https://buy.example/pro-tool" },
        tokens: ["ibin1.p.tok-1"],
      },
    ]);
    const unpaid = await call("plugins.install.inspect", { registry: { id: "pro-tool" } });
    expect(unpaid.ok).toBe(false);
    expect(unpaid.error.details).toEqual({
      code: "payment_required",
      purchaseUrl: "https://buy.example/pro-tool",
      pluginId: "pro-tool",
    });
    const review = await call("plugins.install.inspect", {
      registry: { id: "pro-tool", token: "ibin1.p.tok-1" },
    });
    expect(review.payload).toMatchObject({
      action: "install",
      source: "registry",
      plugin: { id: "pro-tool", version: "3.0.0" },
    });
    const commit = await call("plugins.install.commit", {
      reviewId: review.payload.reviewId,
      acceptedPermissions: [],
    });
    expect(commit.ok).toBe(true);
    expect(readCfg().plugins.installs["pro-tool"]).toMatchObject({
      source: "registry",
      registryUrl: server!.url,
      version: "3.0.0",
    });
    // The token is used once and never written anywhere (no licence keys any more).
    expect(JSON.stringify(readCfg())).not.toMatch(/tok-1/);
    expect(fs.existsSync(path.join(resolvePackagePaths().stateDir, "licenses.json"))).toBe(false);
  });

  it("shows an update badge, updates a stopped plugin without a restart, then rolls back", async () => {
    await installFromZip({ version: "1.0.0", permissions: { network: ["a.example"] } });
    await useRegistry([
      {
        releases: [
          {
            zip: await fixturePackageZip({
              version: "1.1.0",
              permissions: { network: ["a.example"] },
            }),
            changelog: "Adds search.",
          },
        ],
      },
    ]);
    expect((await listed("demo-plugin")).updateAvailable).toBeNull();

    const check = await call("plugins.updates.check", { force: true });
    expect(check.payload.plugins["demo-plugin"]).toMatchObject({
      updateAvailable: true,
      latestVersion: "1.1.0",
    });
    const list = await call("plugins.list");
    expect(list.payload.updates).toMatchObject({
      available: 1,
      registryUrl: server!.url,
      error: null,
    });
    expect(list.payload.plugins.find((p: any) => p.id === "demo-plugin").updateAvailable).toBe(
      "1.1.0",
    );
    const before = (await call("plugins.get", { id: "demo-plugin" })).payload.versions;
    expect(before).toMatchObject({
      updateAvailable: "1.1.0",
      changelog: [{ version: "1.1.0", notes: "Adds search." }],
      rollbackAvailable: false,
      autoUpdate: false,
    });
    // A second check inside the freshness window is served from cache.
    expect((await call("plugins.updates.check")).payload.cached).toBe(true);

    const update = await call("plugins.update", { id: "demo-plugin" });
    expect(update.payload).toMatchObject({
      status: "updated",
      version: "1.1.0",
      previousVersion: "1.0.0",
      rollbackAvailable: true,
      restartRequired: false,
    });
    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
    expect(await listed("demo-plugin")).toMatchObject({ version: "1.1.0", updateAvailable: null });
    expect((await call("plugins.get", { id: "demo-plugin" })).payload.versions).toMatchObject({
      current: "1.1.0",
      source: "registry",
      rollbackAvailable: true,
      previousVersion: "1.0.0",
    });
    // Asking again is a no-op.
    expect((await call("plugins.update", { id: "demo-plugin" })).payload.status).toBe("up-to-date");

    const back = await call("plugins.rollback", { id: "demo-plugin" });
    expect(back.payload).toMatchObject({
      version: "1.0.0",
      from: "1.1.0",
      restored: "previous-package",
      restartRequired: false,
    });
    expect(await listed("demo-plugin")).toMatchObject({ version: "1.0.0" });
    expect(readCfg().plugins.installs["demo-plugin"]).toMatchObject({
      version: "1.0.0",
      previous: { version: "1.1.0" },
    });
  });

  it("updating a RUNNING plugin keeps it on, keeps its settings and restarts the gateway", async () => {
    await installFromZip({ version: "1.0.0" });
    const cfg = readCfg();
    cfg.plugins.entries = { "demo-plugin": { enabled: true, config: { greeting: "Yo" } } };
    writeCfg(cfg);
    expect(reloadRegistry().plugins.find((p) => p.id === "demo-plugin")).toMatchObject({
      status: "loaded",
      version: "1.0.0",
    });
    await useRegistry([{ releases: [{ zip: await fixturePackageZip({ version: "1.1.0" }) }] }]);

    const update = await call("plugins.update", { id: "demo-plugin" });
    expect(update.payload).toMatchObject({
      status: "updated",
      version: "1.1.0",
      restartRequired: true,
    });
    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledTimes(1);
    expect(readCfg().plugins.entries["demo-plugin"]).toEqual({
      enabled: true,
      config: { greeting: "Yo" },
    });
    // After the restart it loads the new version, still on.
    expect(reloadRegistry().plugins.find((p) => p.id === "demo-plugin")).toMatchObject({
      status: "loaded",
      version: "1.1.0",
    });

    vi.mocked(scheduleGatewaySigusr1Restart).mockClear();
    const back = await call("plugins.rollback", { id: "demo-plugin" });
    expect(back.payload).toMatchObject({ version: "1.0.0", restartRequired: true });
    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledTimes(1);
    expect(reloadRegistry().plugins.find((p) => p.id === "demo-plugin")).toMatchObject({
      status: "loaded",
      version: "1.0.0",
    });
  });

  it("an in-process restart runs the UPDATED code, not the cached old module", async () => {
    const entry = (label: string) => `export default {
  id: "demo-plugin",
  register(api) {
    api.registerGatewayMethod("demo-plugin.greet", ({ respond }) => respond(true, { code: "${label}" }));
    api.registerTool({ name: "demo_plugin_greet", description: "d", parameters: { type: "object", properties: {} }, async execute() { return { content: [] }; } });
    api.registerHttpRoute({ path: "/plugins/demo-plugin/ui.js", publicAsset: true, handler: (_q, r) => r.end("") });
  },
};
`;
    const probe = async (registry: ReturnType<typeof reloadRegistry>) => {
      let reply: any;
      await registry.gatewayHandlers["demo-plugin.greet"]!({
        params: {},
        respond: (_ok: boolean, payload: unknown) => (reply = payload),
      } as any);
      return reply?.code;
    };
    // The gateway keeps the loader cache across an in-process restart.
    const load = () => {
      const registry = loadInfiniBotPlugins({ config: readCfg(), workspaceDir: "/nonexistent-ws" });
      setActivePluginRegistry(registry);
      return registry;
    };
    await installFromZip({ version: "1.0.0", files: { "index.js": entry("v1") } });
    const cfg = readCfg();
    cfg.plugins.entries = { "demo-plugin": { enabled: true } };
    writeCfg(cfg);
    expect(await probe(load())).toBe("v1");

    await useRegistry([
      {
        releases: [
          {
            zip: await fixturePackageZip({ version: "1.1.0", files: { "index.js": entry("v2") } }),
          },
        ],
      },
    ]);
    const update = await call("plugins.update", { id: "demo-plugin" });
    expect(update.payload).toMatchObject({ status: "updated", restartRequired: true });
    const afterUpdate = load();
    expect(afterUpdate.plugins.find((p) => p.id === "demo-plugin")).toMatchObject({
      status: "loaded",
      version: "1.1.0",
    });
    expect(await probe(afterUpdate)).toBe("v2");

    await call("plugins.rollback", { id: "demo-plugin" });
    const afterRollback = load();
    expect(afterRollback.plugins.find((p) => p.id === "demo-plugin")).toMatchObject({
      version: "1.0.0",
    });
    expect(await probe(afterRollback)).toBe("v1");
  });

  it("re-prompts when the new version asks for NEW permissions, and only for those", async () => {
    await installFromZip({ version: "1.0.0", permissions: { network: ["a.example"] } });
    await useRegistry([
      {
        releases: [
          {
            zip: await fixturePackageZip({
              version: "2.0.0",
              permissions: { network: ["a.example"], exec: true },
            }),
          },
        ],
      },
    ]);
    const res = await call("plugins.update", { id: "demo-plugin" });
    expect(res.payload.status).toBe("needs-review");
    expect(res.payload.review).toMatchObject({
      action: "update",
      currentVersion: "1.0.0",
      newPermissions: ["exec"],
    });
    expect(res.payload.review.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "exec", isNew: true }),
        expect.objectContaining({ key: "network:a.example", isNew: false }),
      ]),
    );
    // Nothing was installed yet.
    expect(await listed("demo-plugin")).toMatchObject({ version: "1.0.0" });
    const refused = await call("plugins.install.commit", {
      reviewId: res.payload.review.reviewId,
      acceptedPermissions: [],
    });
    expect(refused.error.details.code).toBe("permissions");
    const ok = await call("plugins.install.commit", {
      reviewId: res.payload.review.reviewId,
      acceptedPermissions: ["exec"],
    });
    expect(ok.payload).toMatchObject({ action: "update", version: "2.0.0" });
    expect(readCfg().plugins.installs["demo-plugin"].reviewedPermissions).toEqual([
      "exec",
      "network:a.example",
    ]);
  });

  it("offers a first-party registry update for a bundled plugin and applies it without the override prompt", async () => {
    await useRegistry([
      {
        releases: [
          {
            zip: await fixturePackageZip({
              id: "shipped",
              name: "Shipped",
              version: "1.4.0",
              publisher: "infinibot",
            }),
          },
        ],
        firstParty: true,
      },
    ]);
    await call("plugins.updates.check", { force: true });
    expect((await listed("shipped")).updateAvailable).toBe("1.4.0");
    const update = await call("plugins.update", { id: "shipped" });
    expect(update.payload).toMatchObject({
      status: "updated",
      version: "1.4.0",
      previousVersion: "1.0.0",
    });
    expect(await listed("shipped")).toMatchObject({
      version: "1.4.0",
      origin: "global",
      enabled: false,
    });
    expect(readCfg().plugins.installs.shipped).toMatchObject({
      overridesBundled: true,
      source: "registry",
    });
  });

  it("stores the auto-update switch (default off)", async () => {
    await installFromZip({ version: "1.0.0" });
    expect((await listed("demo-plugin")).autoUpdate).toBe(false);
    expect((await call("plugins.updates.setAuto", { id: "demo-plugin", auto: true })).ok).toBe(
      true,
    );
    expect(readCfg().plugins.entries["demo-plugin"]).toEqual({ autoUpdate: true });
    expect((await listed("demo-plugin")).autoUpdate).toBe(true);
    // The switch alone must not flip the plugin on at the next load.
    expect(reloadRegistry().plugins.find((p) => p.id === "demo-plugin")).toMatchObject({
      enabled: false,
    });
    await call("plugins.updates.setAuto", { id: "demo-plugin", auto: false });
    expect(readCfg().plugins.entries?.["demo-plugin"]).toBeUndefined();
    expect((await call("plugins.updates.setAuto", { id: "nope", auto: true })).ok).toBe(false);
  });

  it("reports rollback errors plainly", async () => {
    await installFromZip({ version: "1.0.0" });
    const res = await call("plugins.rollback", { id: "demo-plugin" });
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/no previous version/);
  });
});
