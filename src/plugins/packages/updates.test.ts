import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../../config/config.js";
import { loadPluginManifest } from "../manifest.js";
import { commitPluginPackage, inspectPluginPackage, type ExistingPlugin } from "./install.js";
import { startMockRegistry, type MockPlugin, type MockRegistry } from "./mock-registry.js";
import { fixturePackageZip } from "./package-fixtures.js";
import {
  createRegistryClient,
  DEFAULT_PLUGIN_REGISTRY_URL,
  fetchPackage,
  formatPrice,
  normalizeRegistryUrl,
  parseRegistryEntry,
  PaymentRequiredError,
  resolveRegistryUrl,
} from "./registry-client.js";
import { readUpdateState, resolvePackagePaths, type PackagePaths } from "./store.js";
import {
  checkPluginUpdates,
  fetchRegistryPackage,
  marketplaceRegistryUrl,
  pickUpdateVersion,
  prepareRegistryInstall,
  registryUrlForPlugin,
  runAutoUpdates,
  setAutoUpdateInConfig,
  type InstalledPluginRef,
} from "./updates.js";
import { PackageError, sha256OfBuffer } from "./zip-read.js";

const temps: string[] = [];
const servers: MockRegistry[] = [];
function sandbox(): PackagePaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-pkg-updates-"));
  temps.push(dir);
  return resolvePackagePaths(dir);
}
async function registry(plugins: MockPlugin[]) {
  const server = await startMockRegistry(plugins);
  servers.push(server);
  return server;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

const HOST = "2026.6.30";
const NO_ENV = {} as NodeJS.ProcessEnv;

function existingFrom(paths: PackagePaths, extra: ExistingPlugin[] = []) {
  return (id: string): ExistingPlugin[] => {
    const dir = path.join(paths.extensionsDir, id);
    const m = fs.existsSync(dir) ? loadPluginManifest(dir) : null;
    return [
      ...(m?.ok ? [{ origin: "global" as const, version: m.manifest.version, rootDir: dir }] : []),
      ...extra.filter((e) => e.rootDir.endsWith(`/${id}`)),
    ];
  };
}

/** Install a fixture package from a zip, as the owner would. */
async function installZip(
  paths: PackagePaths,
  config: InfinibotConfig,
  opts: Parameters<typeof fixturePackageZip>[0],
) {
  const inspection = await inspectPluginPackage({
    buffer: await fixturePackageZip(opts),
    source: { kind: "zip" },
    config,
    hostVersion: HOST,
    env: NO_ENV,
    paths,
    resolveExisting: existingFrom(paths),
  });
  return commitPluginPackage(inspection, {
    config,
    acceptedPermissions: inspection.permissionKeys,
    paths,
  });
}

const ref = (over: Partial<InstalledPluginRef> = {}): InstalledPluginRef => ({
  id: "demo-plugin",
  version: "1.0.0",
  origin: "global",
  publisher: "acme",
  ...over,
});

describe("registry client (against the mock registry)", () => {
  it("reads the index and a plugin's versions", async () => {
    const zip = await fixturePackageZip({ version: "1.2.0" });
    const server = await registry([
      {
        releases: [
          { zip: await fixturePackageZip({ version: "1.0.0" }), changelog: "First." },
          { zip, changelog: "Faster." },
        ],
        verified: true,
        publisherName: "Acme Inc",
        tags: ["demo"],
        homepageUrl: "https://acme.example/demo",
        listing: {
          icon: "/img/icon.png",
          // Both shapes a registry may send: a bare URL, or {src, caption}.
          screenshots: [
            "https://cdn.example/s1.png",
            "javascript:alert(1)",
            { src: "/img/s2.png", caption: "The board" },
            { src: "javascript:alert(2)", caption: "dropped" },
          ],
          tagline: "A demo plugin",
        },
        featured: true,
        affiliate: { enabled: true },
      },
    ]);
    const client = createRegistryClient({ registryUrl: `${server.url}/` });
    const index = await client.index();
    expect(index.schemaVersion).toBe(1);
    expect(index.plugins).toHaveLength(1);
    expect(index.plugins[0]).toMatchObject({
      id: "demo-plugin",
      name: "Demo Plugin",
      version: "1.2.0",
      publisher: { id: "acme", name: "Acme Inc", verified: true },
      firstParty: false,
      pricing: {
        model: "free",
        priceCents: 0,
        currency: "USD",
        purchaseUrl: null,
        includedPlans: [],
      },
      sha256: sha256OfBuffer(zip),
      sizeBytes: zip.length,
      minHostVersion: "2026.6.30",
      homepageUrl: "https://acme.example/demo",
      // Relative URLs resolve against the registry; non-http(s) ones are dropped.
      listing: {
        icon: `${server.url}/img/icon.png`,
        cover: null,
        screenshots: [
          { src: "https://cdn.example/s1.png" },
          { src: `${server.url}/img/s2.png`, caption: "The board" },
        ],
        tagline: "A demo plugin",
      },
      affiliate: { enabled: true },
      featured: true,
    });
    const detail = await client.plugin("demo-plugin");
    expect(detail.versions.map((v) => v.version)).toEqual(["1.2.0", "1.0.0"]);
    expect(detail.versions[0]).toMatchObject({ changelog: "Faster.", sha256: sha256OfBuffer(zip) });
    // No summary in the listing → none invented.
    expect(detail.permissions).toBeUndefined();
    expect(server.requests).toEqual([
      "GET /api/marketplace/index.json",
      "GET /api/marketplace/plugins/demo-plugin",
    ]);
  });

  it("passes the listing's permission summary through, cleaned", async () => {
    const zip = await fixturePackageZip({ version: "1.0.0" });
    const server = await registry([
      {
        releases: [{ zip }],
        permissions: {
          network: ["flypic.ai", 42, " "],
          secrets: ["FLYPIC_API_KEY"],
          exec: "yes",
          phi: true,
        },
      },
    ]);
    const detail = await createRegistryClient({ registryUrl: server.url }).plugin("demo-plugin");
    expect(detail.permissions).toEqual({
      network: ["flypic.ai"],
      fs: [],
      secrets: ["FLYPIC_API_KEY"],
      channels: [],
      gated: [],
      exec: false,
      phi: true,
      credits: false,
    });
  });

  it("downloads through the 302 and returns the exact bytes", async () => {
    const zip = await fixturePackageZip({ version: "1.2.0" });
    const server = await registry([{ releases: [{ zip }] }]);
    const dl = await createRegistryClient({ registryUrl: server.url }).download("demo-plugin", {
      version: "1.2.0",
    });
    expect(dl.buffer.equals(zip)).toBe(true);
    expect(dl.url).toBe(`${server.url}/files/demo-plugin/1.2.0.zip`);
    expect(server.requests).toContain(
      "GET /api/marketplace/plugins/demo-plugin/download?version=1.2.0",
    );
  });

  it("maps 402 to PaymentRequiredError with the purchase URL, and an entitlement token unlocks it", async () => {
    const zip = await fixturePackageZip({ version: "1.0.0" });
    const server = await registry([
      {
        releases: [{ zip }],
        pricing: {
          model: "paid",
          priceCents: 4900,
          currency: "usd",
          purchaseUrl: "https://buy.example/demo",
        },
        tokens: ["ibin1.p.good"],
      },
    ]);
    const client = createRegistryClient({ registryUrl: server.url });
    const entry = (await client.index()).plugins[0]!;
    expect(entry.pricing).toEqual({
      model: "paid",
      priceCents: 4900,
      currency: "USD",
      purchaseUrl: "https://buy.example/demo",
      includedPlans: [],
    });
    // A paid plugin the registry hosts (first-party) still has a download and a checksum.
    expect(entry.downloadUrl).toBe(
      `${server.url}/api/marketplace/plugins/demo-plugin/download?version=latest`,
    );
    expect(entry.distribution).toBe("hosted");
    expect(formatPrice(entry.pricing)).toBe("$49.00");
    const err = await client.download("demo-plugin").catch((e) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect(err).toMatchObject({
      code: "payment",
      purchaseUrl: "https://buy.example/demo",
      pluginId: "demo-plugin",
    });
    await expect(client.download("demo-plugin", { token: "ibin1.p.bad" })).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    const ok = await client.download("demo-plugin", { token: "ibin1.p.good" });
    expect(ok.buffer.equals(zip)).toBe(true);
    // The token never ends up in the recorded download URL.
    expect(ok.url).not.toMatch(/ibin1/);
  });

  it("keeps an external (seller-delivered) listing, and its download says the publisher delivers it", async () => {
    const server = await registry([
      {
        releases: [{ zip: await fixturePackageZip({ version: "2.0.0" }) }],
        pricing: { model: "paid", priceCents: 1500, purchaseUrl: "https://seller.example/buy" },
        external: true,
      },
    ]);
    const client = createRegistryClient({ registryUrl: server.url });
    const entry = (await client.index()).plugins[0]!;
    expect(entry).toMatchObject({
      id: "demo-plugin",
      distribution: "external",
      downloadUrl: null,
      sha256: "",
      sizeBytes: 0,
      pricing: { model: "paid", purchaseUrl: "https://seller.example/buy" },
    });
    await expect(client.download("demo-plugin")).rejects.toThrow(
      /not hosted by the registry: the publisher delivers it/,
    );
    // A hosted entry without a checksum is still dropped.
    const wire = {
      id: "demo-plugin",
      name: "Demo",
      version: "2.0.0",
      pricing: { model: "free" },
      listing: {},
    };
    expect(
      parseRegistryEntry(
        { ...wire, distribution: "hosted", downloadUrl: "https://r.example/x", sha256: "" },
        server.url,
      ),
    ).toBeNull();
    expect(
      parseRegistryEntry(
        { ...wire, distribution: "external", downloadUrl: null, sha256: "" },
        server.url,
      )?.distribution,
    ).toBe("external");
  });

  it("rejects bad registries and bad responses", async () => {
    expect(() => normalizeRegistryUrl("http://registry.example.com")).toThrow(/https/);
    expect(() => normalizeRegistryUrl("file:///tmp")).toThrow(/https/);
    const server = await registry([{ releases: [{ zip: await fixturePackageZip() }] }]);
    const client = createRegistryClient({ registryUrl: server.url });
    await expect(client.plugin("nope")).rejects.toThrow(/not found/);
    await expect(client.plugin("../etc")).rejects.toThrow(/invalid plugin id/);
    const wrongSchema = createRegistryClient({
      registryUrl: server.url,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ schemaVersion: 2, plugins: [] }))) as typeof fetch,
    });
    await expect(wrongSchema.index()).rejects.toThrow(/unsupported schema/);
    const html = createRegistryClient({
      registryUrl: server.url,
      fetchImpl: (async () => new Response("<html>login</html>")) as typeof fetch,
    });
    await expect(html.index()).rejects.toThrow(/invalid JSON/);
    const down = createRegistryClient({ registryUrl: "http://127.0.0.1:9" });
    await expect(down.index()).rejects.toThrow(/could not reach the plugin registry/);
  });

  it("drops index entries that don't meet the contract instead of trusting them", () => {
    const good = {
      id: "ok",
      name: "OK",
      version: "1.0.0",
      sha256: "a".repeat(64),
      publisher: { id: "p", name: "P", verified: "yes" },
      pricing: { model: "weird", priceCents: -5, purchaseUrl: "javascript:alert(1)" },
    };
    const parsed = parseRegistryEntry(good, "https://r.example");
    expect(parsed).toMatchObject({
      publisher: { verified: false },
      pricing: { model: "free", priceCents: 0, purchaseUrl: null },
      firstParty: false,
    });
    expect(parseRegistryEntry({ ...good, id: "../x" }, "https://r.example")).toBeNull();
    expect(parseRegistryEntry({ ...good, version: "latest" }, "https://r.example")).toBeNull();
    expect(parseRegistryEntry({ ...good, sha256: "abc" }, "https://r.example")).toBeNull();
    expect(parseRegistryEntry("nope", "https://r.example")).toBeNull();
  });

  it("refuses downloads from non-https hosts and redirect loops", async () => {
    await expect(fetchPackage("http://example.com/x.zip")).rejects.toThrow(/https only/);
    const hop = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://evil.example/x.zip" },
      })) as typeof fetch;
    await expect(fetchPackage("https://ok.example/x.zip", { fetchImpl: hop })).rejects.toThrow(
      /https only/,
    );
    const loop = (async (u: string) =>
      new Response(null, {
        status: 302,
        headers: { location: `${u}0` },
      })) as unknown as typeof fetch;
    await expect(fetchPackage("https://ok.example/x.zip", { fetchImpl: loop })).rejects.toThrow(
      /too many redirects/,
    );
    const big = (async () => new Response(new Uint8Array(2048))) as typeof fetch;
    await expect(
      fetchPackage("https://ok.example/x.zip", { fetchImpl: big, maxBytes: 1024 }),
    ).rejects.toThrow(/larger than/);
  });

  it("resolves the registry URL: env > config > default; fleet ignores tenant config", () => {
    expect(resolveRegistryUrl({}, NO_ENV)).toBe(DEFAULT_PLUGIN_REGISTRY_URL);
    expect(DEFAULT_PLUGIN_REGISTRY_URL).toBe("https://cloud.infinibotos.com");
    const cfg: InfinibotConfig = { plugins: { registryUrl: "https://plugins.example.com/" } };
    expect(resolveRegistryUrl(cfg, NO_ENV)).toBe("https://plugins.example.com");
    const env = { INFINIBOT_PLUGIN_REGISTRY_URL: "http://localhost:4010" } as NodeJS.ProcessEnv;
    expect(resolveRegistryUrl(cfg, env)).toBe("http://localhost:4010");
    const fleet = { SAAS_MODE: "1", FLEET_TENANT_ID: "t1" } as NodeJS.ProcessEnv;
    expect(marketplaceRegistryUrl({ config: cfg, env: fleet })).toBe(DEFAULT_PLUGIN_REGISTRY_URL);
    expect(
      registryUrlForPlugin(
        { id: "x", updateRegistryUrl: "https://evil.example" },
        { config: cfg, env: fleet },
      ),
    ).toBe(DEFAULT_PLUGIN_REGISTRY_URL);
    expect(
      registryUrlForPlugin(
        { id: "x", updateRegistryUrl: "https://own.example" },
        { config: cfg, env: NO_ENV },
      ),
    ).toBe("https://own.example");
  });
});

describe("update check", () => {
  it("finds a newer version, with the changelog since the installed one, and caches it", async () => {
    const paths = sandbox();
    const v1 = await installZip(paths, {}, { version: "1.0.0" });
    const server = await registry([
      {
        releases: [
          { zip: await fixturePackageZip({ version: "1.0.0" }), changelog: "First." },
          {
            zip: await fixturePackageZip({ version: "1.1.0" }),
            changelog: "Adds search.",
            releasedAt: "2026-09-01T00:00:00Z",
          },
          {
            zip: await fixturePackageZip({ version: "1.2.0" }),
            changelog: "Fixes sync.",
            releasedAt: "2026-10-01T00:00:00Z",
          },
        ],
      },
    ]);
    const config: InfinibotConfig = {
      ...v1.config,
      plugins: { ...v1.config.plugins, registryUrl: server.url },
    };
    const state = await checkPluginUpdates([ref()], {
      config,
      env: NO_ENV,
      hostVersion: HOST,
      paths,
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(state.checkedAt).toBe("2026-10-02T00:00:00.000Z");
    expect(state.registryUrl).toBe(server.url);
    expect(state.plugins["demo-plugin"]).toMatchObject({
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      updateAvailable: true,
      changelog: [
        { version: "1.2.0", releasedAt: "2026-10-01T00:00:00Z", notes: "Fixes sync." },
        { version: "1.1.0", releasedAt: "2026-09-01T00:00:00Z", notes: "Adds search." },
      ],
    });
    expect(readUpdateState(paths)).toEqual(state);
    // Up to date → listed, no update.
    const none = await checkPluginUpdates([ref({ version: "1.2.0" })], {
      config,
      env: NO_ENV,
      hostVersion: HOST,
      paths,
    });
    expect(none.plugins["demo-plugin"]).toMatchObject({
      updateAvailable: false,
      latestVersion: "1.2.0",
    });
  });

  it("only offers versions this host can run (minHostVersion gate)", async () => {
    const paths = sandbox();
    const v1 = await installZip(paths, {}, { version: "1.0.0" });
    const server = await registry([
      {
        releases: [
          { zip: await fixturePackageZip({ version: "1.1.0" }) },
          { zip: await fixturePackageZip({ version: "2.0.0", minHostVersion: "2027.1.0" }) },
        ],
      },
    ]);
    const config: InfinibotConfig = {
      ...v1.config,
      plugins: { ...v1.config.plugins, registryUrl: server.url },
    };
    const state = await checkPluginUpdates([ref()], {
      config,
      env: NO_ENV,
      hostVersion: HOST,
      paths,
    });
    expect(state.plugins["demo-plugin"]).toMatchObject({
      updateAvailable: true,
      latestVersion: "1.1.0",
    });
    expect(state.plugins["demo-plugin"]?.blocked).toMatch(/2\.0\.0 needs InfiniBot 2027\.1\.0/);
    // Nothing compatible at all → no update, with the reason.
    const stuck = await checkPluginUpdates([ref({ version: "1.1.0" })], {
      config,
      env: NO_ENV,
      hostVersion: HOST,
      paths,
    });
    expect(stuck.plugins["demo-plugin"]).toMatchObject({
      updateAvailable: false,
      latestVersion: "2.0.0",
    });
    expect(stuck.plugins["demo-plugin"]?.blocked).toMatch(
      /needs InfiniBot 2027\.1\.0 or newer \(this is 2026\.6\.30\)/,
    );
    await expect(
      fetchRegistryPackage({
        id: "demo-plugin",
        version: "2.0.0",
        registryUrl: server.url,
        hostVersion: HOST,
      }),
    ).rejects.toMatchObject({ code: "host" });
  });

  it("pickUpdateVersion orders by semver, not by list order", () => {
    const v = (version: string, minHostVersion = "0.0.0") => ({
      version,
      minHostVersion,
      releasedAt: "",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      changelog: "",
    });
    const pick = pickUpdateVersion(
      {
        version: "1.10.0",
        sha256: "",
        sizeBytes: 0,
        minHostVersion: "0.0.0",
        versions: [v("1.2.0"), v("1.10.0"), v("1.9.0"), v("2.0.0-beta.1", "2099.1.1")],
      },
      "1.2.0",
      HOST,
    );
    expect(pick.best?.version).toBe("1.10.0");
    expect(pick.newest?.version).toBe("2.0.0-beta.1");
    expect(pick.newer.map((x) => x.version)).toEqual(["2.0.0-beta.1", "1.10.0", "1.9.0"]);
  });

  it("covers bundled first-party plugins, but only from a first-party registry entry", async () => {
    const paths = sandbox();
    const zip = await fixturePackageZip({ version: "2026.10.1", publisher: "infinibot" });
    const bundled = ref({ origin: "bundled", version: "2026.9.28", publisher: "infinibot" });
    const firstParty = await registry([{ releases: [{ zip }], firstParty: true }]);
    const ok = await checkPluginUpdates([bundled], {
      config: { plugins: { registryUrl: firstParty.url } },
      env: NO_ENV,
      hostVersion: HOST,
      paths,
    });
    expect(ok.plugins["demo-plugin"]).toMatchObject({
      updateAvailable: true,
      latestVersion: "2026.10.1",
    });

    const impostor = await registry([{ releases: [{ zip }], firstParty: false }]);
    const no = await checkPluginUpdates([bundled], {
      config: { plugins: { registryUrl: impostor.url } },
      env: NO_ENV,
      hostVersion: HOST,
      paths,
    });
    expect(no.plugins["demo-plugin"]?.updateAvailable).toBe(false);
    expect(no.plugins["demo-plugin"]?.error).toMatch(/not first-party/);
  });

  it("refuses an update from a different publisher, and skips plugins the registry doesn't manage", async () => {
    const paths = sandbox();
    const v1 = await installZip(paths, {}, { version: "1.0.0" });
    const server = await registry([
      { releases: [{ zip: await fixturePackageZip({ version: "9.0.0", publisher: "mallory" }) }] },
    ]);
    const config: InfinibotConfig = {
      ...v1.config,
      plugins: { ...v1.config.plugins, registryUrl: server.url },
    };
    const state = await checkPluginUpdates(
      [ref(), ref({ id: "hand-made", origin: "global" }), ref({ id: "ws", origin: "workspace" })],
      { config, env: NO_ENV, hostVersion: HOST, paths },
    );
    expect(state.plugins["demo-plugin"]?.error).toMatch(/different publisher \(mallory\)/);
    expect(state.plugins["demo-plugin"]?.updateAvailable).toBe(false);
    expect(state.plugins["hand-made"]).toBeUndefined();
    expect(state.plugins.ws).toBeUndefined();
  });

  it("records a registry outage without throwing", async () => {
    const paths = sandbox();
    const v1 = await installZip(paths, {}, { version: "1.0.0" });
    const config: InfinibotConfig = {
      ...v1.config,
      plugins: { ...v1.config.plugins, registryUrl: "http://127.0.0.1:9" },
    };
    const state = await checkPluginUpdates([ref()], {
      config,
      env: NO_ENV,
      hostVersion: HOST,
      paths,
    });
    expect(state.error).toMatch(/could not reach the plugin registry/);
    expect(state.plugins["demo-plugin"]).toMatchObject({ updateAvailable: false });
  });
});

describe("update + rollback through the registry", () => {
  it("updates with checksum verification, keeps the owner's choices, and rolls back", async () => {
    const paths = sandbox();
    const v1 = await installZip(
      paths,
      {},
      { version: "1.0.0", permissions: { network: ["a.example"] } },
    );
    const owned: InfinibotConfig = {
      ...v1.config,
      plugins: {
        ...v1.config.plugins,
        entries: {
          "demo-plugin": {
            enabled: true,
            config: { greeting: "Yo" },
            permissions: { revoked: ["network:a.example"] },
          },
        },
      },
    };
    const zip2 = await fixturePackageZip({
      version: "1.1.0",
      permissions: { network: ["a.example"] },
    });
    const server = await registry([{ releases: [{ zip: zip2, changelog: "Better." }] }]);
    const ctx = {
      config: owned,
      env: NO_ENV,
      hostVersion: HOST,
      paths,
      resolveExisting: existingFrom(paths),
    };
    const { inspection, pkg } = await prepareRegistryInstall(
      { id: "demo-plugin", registryUrl: server.url },
      ctx,
    );
    expect(pkg.version.version).toBe("1.1.0");
    expect(inspection).toMatchObject({
      action: "update",
      newPermissions: [],
      sha256: sha256OfBuffer(zip2),
    });
    const res = await commitPluginPackage(inspection, {
      config: owned,
      acceptedPermissions: [],
      paths,
    });
    expect(res.record).toMatchObject({
      source: "registry",
      registryUrl: server.url,
      version: "1.1.0",
      sha256: sha256OfBuffer(zip2),
      previous: { version: "1.0.0" },
    });
    expect(res.config.plugins?.entries).toEqual(owned.plugins?.entries);
    expect(loadPluginManifest(res.targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "1.1.0" },
    });
  });

  it("refuses a download whose checksum differs from what the registry published", async () => {
    const paths = sandbox();
    const server = await registry([
      {
        releases: [
          { zip: await fixturePackageZip({ version: "1.0.0" }), sha256Override: "f".repeat(64) },
        ],
      },
    ]);
    const err = await prepareRegistryInstall(
      { id: "demo-plugin", registryUrl: server.url },
      { config: {}, env: NO_ENV, hostVersion: HOST, paths, resolveExisting: existingFrom(paths) },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PackageError);
    expect(err.code).toBe("checksum");
    expect(fs.existsSync(paths.extensionsDir)).toBe(false);
  });

  it("a paid plugin installs with the token from its purchase page, which is never stored", async () => {
    const paths = sandbox();
    const server = await registry([
      {
        releases: [{ zip: await fixturePackageZip({ version: "1.0.0" }) }],
        pricing: { model: "paid", priceCents: 1900, purchaseUrl: "https://buy.example/x" },
        tokens: ["ibin1.p.tok-1"],
      },
    ]);
    const ctx = {
      config: {},
      env: NO_ENV,
      hostVersion: HOST,
      paths,
      resolveExisting: existingFrom(paths),
    };
    await expect(
      prepareRegistryInstall({ id: "demo-plugin", registryUrl: server.url }, ctx),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    const { inspection, pkg } = await prepareRegistryInstall(
      { id: "demo-plugin", registryUrl: server.url, token: "ibin1.p.tok-1" },
      ctx,
    );
    expect(inspection.action).toBe("install");
    expect(pkg.url).not.toContain("tok-1");
    // Nothing remembers the token: the next install without it needs a fresh one.
    await expect(
      prepareRegistryInstall({ id: "demo-plugin", registryUrl: server.url }, ctx),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    const written = fs.existsSync(paths.stateDir)
      ? fs.readdirSync(paths.stateDir, { recursive: true }).map(String)
      : [];
    expect(written.some((f) => f.includes("licenses"))).toBe(false);
  });
});

describe("auto-update (default off)", () => {
  async function setup(nextPermissions?: Record<string, unknown>) {
    const paths = sandbox();
    const v1 = await installZip(
      paths,
      {},
      { version: "1.0.0", permissions: { network: ["a.example"] } },
    );
    const server = await registry([
      {
        releases: [
          {
            zip: await fixturePackageZip({
              version: "1.1.0",
              permissions: nextPermissions ?? { network: ["a.example"] },
            }),
          },
        ],
      },
    ]);
    const config: InfinibotConfig = {
      ...v1.config,
      plugins: { ...v1.config.plugins, registryUrl: server.url },
    };
    const ctx = {
      config,
      env: NO_ENV,
      hostVersion: HOST,
      paths,
      resolveExisting: existingFrom(paths),
    };
    const state = await checkPluginUpdates([ref()], ctx);
    return { paths, config, ctx, state, targetDir: v1.targetDir };
  }

  it("does nothing unless the owner turned it on for that plugin", async () => {
    const { ctx, state, targetDir } = await setup();
    const res = await runAutoUpdates([ref()], state, ctx);
    expect(res.outcomes).toEqual([]);
    expect(loadPluginManifest(targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "1.0.0" },
    });
  });

  it("applies the update when on, keeping rollback", async () => {
    const { ctx, config, state, targetDir } = await setup();
    const on = setAutoUpdateInConfig(config, "demo-plugin", true);
    expect(on.plugins?.entries?.["demo-plugin"]).toEqual({ autoUpdate: true });
    const res = await runAutoUpdates([ref()], state, { ...ctx, config: on });
    expect(res.outcomes).toMatchObject([
      { id: "demo-plugin", status: "updated", from: "1.0.0", to: "1.1.0" },
    ]);
    expect(res.config.plugins?.installs?.["demo-plugin"]).toMatchObject({
      version: "1.1.0",
      previous: { version: "1.0.0" },
    });
    expect(loadPluginManifest(targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "1.1.0" },
    });
    // Turning it off removes the flag (and the now-empty entry).
    expect(
      setAutoUpdateInConfig(on, "demo-plugin", false).plugins?.entries?.["demo-plugin"],
    ).toBeUndefined();
  });

  it("never applies a version that asks for new permissions", async () => {
    const { ctx, config, state, targetDir } = await setup({ network: ["a.example"], exec: true });
    const on = setAutoUpdateInConfig(config, "demo-plugin", true);
    const res = await runAutoUpdates([ref()], state, { ...ctx, config: on });
    expect(res.commits).toEqual([]);
    expect(res.outcomes).toMatchObject([{ id: "demo-plugin", status: "skipped" }]);
    expect(res.outcomes[0]?.message).toMatch(/asks for new permissions \(exec\)/);
    expect(loadPluginManifest(targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "1.0.0" },
    });
  });
});
