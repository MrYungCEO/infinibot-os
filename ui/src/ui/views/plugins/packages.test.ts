import { describe, expect, it } from "vitest";

import {
  bytesToBase64,
  filterMarket,
  marketAction,
  orderMarket,
  parseInstallLink,
  PluginPackages,
  type InstallReview,
  type MarketEntry,
  type PackagesHost,
} from "./packages.js";

const entry = (over: Partial<MarketEntry> = {}): MarketEntry => ({
  id: "demo",
  name: "Demo",
  version: "1.2.0",
  publisher: { id: "acme", name: "Acme", verified: true },
  firstParty: false,
  description: "Does demo things",
  category: "apps",
  tags: ["voice"],
  pricing: { model: "free", priceCents: 0, currency: "USD", purchaseUrl: null },
  priceLabel: "Free",
  sizeBytes: 1000,
  minHostVersion: "2026.6.30",
  homepageUrl: null,
  listing: { cover: null, icon: null, screenshots: [] },
  installed: null,
  compatible: true,
  blocked: null,
  ...over,
});

describe("marketplace card action", () => {
  it("install for a free plugin that is not installed", () => {
    expect(marketAction(entry())).toEqual({ kind: "install", label: "Install" });
  });

  it("buy for a paid plugin, with the price in the label", () => {
    const paid = entry({
      pricing: { model: "paid", priceCents: 2900, currency: "USD", purchaseUrl: "https://buy.example" },
      priceLabel: "$29.00",
    });
    expect(marketAction(paid)).toEqual({ kind: "buy", label: "Buy · $29.00" });
    // With the token from the purchase page in hand it installs.
    expect(marketAction(paid, { tokenInHand: true })).toEqual({ kind: "install", label: "Install" });
  });

  it("external for a plugin its publisher sells and delivers (no download from the registry)", () => {
    const ext = entry({
      distribution: "external",
      pricing: { model: "paid", priceCents: 1500, currency: "USD", purchaseUrl: "https://seller.example/buy" },
      priceLabel: "$15.00",
    });
    expect(marketAction(ext)).toEqual({ kind: "external", label: "Buy · $15.00" });
    // A token never turns it into an install, and an installed copy (zip import) is not "updated" from here.
    expect(marketAction(ext, { tokenInHand: true }).kind).toBe("external");
    const installed = { version: "1.0.0", origin: "global", package: true, updateAvailable: true };
    expect(marketAction(entry({ ...ext, installed })).kind).toBe("open");
  });

  it("update / open when installed", () => {
    const installed = { version: "1.0.0", origin: "global", package: true, updateAvailable: true };
    expect(marketAction(entry({ installed }))).toEqual({ kind: "update", label: "Update to 1.2.0" });
    expect(marketAction(entry({ installed: { ...installed, updateAvailable: false } })).kind).toBe("open");
    // An owned paid plugin is never offered for sale again.
    expect(
      marketAction(
        entry({
          installed: { ...installed, updateAvailable: false },
          pricing: { model: "paid", priceCents: 1, currency: "USD", purchaseUrl: null },
        }),
      ).kind,
    ).toBe("open");
  });

  it("blocked when the host is too old or the cloud plan refuses it", () => {
    expect(marketAction(entry({ compatible: false, minHostVersion: "2099.1.1" }))).toMatchObject({
      kind: "blocked",
      reason: "Needs InfiniBot 2099.1.1 or newer.",
    });
    expect(marketAction(entry({ blocked: "Not included in your plan." }))).toMatchObject({
      kind: "blocked",
      reason: "Not included in your plan.",
    });
  });
});

describe("marketplace search", () => {
  const list = [entry(), entry({ id: "other", name: "Other", description: "x", tags: [], publisher: { id: "zed", name: "Zed Co", verified: false } })];
  it("matches id, name, description, publisher and tags", () => {
    expect(filterMarket(list, "")).toHaveLength(2);
    expect(filterMarket(list, "DEMO").map((e) => e.id)).toEqual(["demo"]);
    expect(filterMarket(list, "voice").map((e) => e.id)).toEqual(["demo"]);
    expect(filterMarket(list, "zed").map((e) => e.id)).toEqual(["other"]);
    expect(filterMarket(list, "nothing-matches")).toEqual([]);
  });
});

describe("upload chunk encoding", () => {
  it("round-trips arbitrary bytes, including chunks larger than the slice size", () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.every((b, i) => b === bytes[i])).toBe(true);
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });
});

describe("install deep link (marketplace site → Plugins page)", () => {
  it("reads the hosted and the desktop form of the link", () => {
    // /app/plugins?install=<id>&source=marketplace
    expect(parseInstallLink("?install=flypic&source=marketplace")).toEqual({ id: "flypic", source: "marketplace", token: null });
    // infinibot://web/plugins?install=<id> → /plugins?install=<id>
    expect(parseInstallLink("?install=droid-swarm")).toEqual({ id: "droid-swarm", source: null, token: null });
    expect(parseInstallLink("?install=FlyPic")).toEqual({ id: "flypic", source: null, token: null });
  });

  it("keeps the entitlement token from a purchase page, and drops anything that is not one", () => {
    const tok = "ibin1.p.6f1c2d3e-0000-4000-8000-000000000001.1790000000.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd";
    expect(parseInstallLink(`?install=flypic&source=marketplace&entitlement=${tok}`)?.token).toBe(tok);
    expect(parseInstallLink(`?install=flypic&entitlement=ibin1.t.pro~user_1.1790000000.AbCdEfGhIjKlMnOpQrStUvWxYz0123`)?.token).toMatch(/^ibin1\.t\./);
    for (const bad of ["IBL-AAAAA-BBBBB", "ibrc1.p.x.0.AbCdEfGhIjKlMnOpQrStUvWxYz", "ibin1.p.x.1.short", "<script>"]) {
      expect(parseInstallLink(`?install=flypic&entitlement=${encodeURIComponent(bad)}`)?.token, bad).toBeNull();
    }
    // `?token=` is the gateway's own auth token (app-settings.ts consumes it): never read as an entitlement.
    expect(parseInstallLink(`?install=flypic&token=${tok}`)?.token).toBeNull();
  });

  it("ignores a missing or malformed id", () => {
    for (const bad of ["", "?plugin=flypic", "?install=", "?install=a", "?install=../etc", "?install=x%20y", "?install=<script>"]) {
      expect(parseInstallLink(bad), bad).toBeNull();
    }
    expect(parseInstallLink("?install=flypic&source=<b>")?.source).toBeNull();
  });

  it("lists the linked plugin first, then featured ones", () => {
    const list = [entry({ id: "aa" }), entry({ id: "bb", featured: true }), entry({ id: "cc" })];
    expect(orderMarket(list, null).map((e) => e.id)).toEqual(["bb", "aa", "cc"]);
    expect(orderMarket(list, "cc").map((e) => e.id)).toEqual(["cc", "bb", "aa"]);
  });

  const review = (over: Partial<InstallReview> = {}): InstallReview => ({
    reviewId: "rev-1",
    plugin: { id: "demo", name: "Demo", version: "1.2.0", publisher: "acme", minHostVersion: "2026.6.30" },
    action: "install",
    currentVersion: null,
    sha256: "a".repeat(64),
    sizeBytes: 1000,
    unpackedBytes: 2000,
    files: 3,
    source: "registry",
    firstParty: false,
    permissions: [{ key: "network:api.acme.dev", category: "network", consent: "Reach api.acme.dev", isNew: true, gated: false, blocked: null }],
    newPermissions: ["network:api.acme.dev"],
    needsOverrideConfirmation: false,
    warnings: [],
    changelog: null,
    notes: { enable: "Installed plugins start switched off.", gated: "", restart: null },
    ...over,
  });

  function rig(plugins: MarketEntry[], opts: { failList?: string } = {}) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const host: PackagesHost = {
      rpc: async <T,>(method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "plugins.marketplace.list") {
          if (opts.failList) throw new Error(opts.failList);
          return { registryUrl: "http://127.0.0.1:4810", generatedAt: "", hostVersion: "2026.6.30", plugins } as T;
        }
        if (method === "plugins.install.inspect") return review() as T;
        throw new Error(`unexpected rpc ${method}`);
      },
      update: () => undefined,
      refresh: async () => undefined,
      open: () => undefined,
      plugins: () => [],
      runningSubagents: () => null,
      countSubagents: () => undefined,
    };
    return { pk: new PluginPackages(host), calls };
  }
  const methods = (calls: Array<{ method: string }>) => calls.map((c) => c.method);

  it("free plugin: opens the Marketplace tab on it and stops at the review (nothing installed or enabled)", async () => {
    const { pk, calls } = rig([entry({ id: "other" }), entry()]);
    await pk.openInstallLink({ id: "demo", source: "marketplace", token: null });
    expect(pk.tab).toBe("marketplace");
    expect(pk.focusId).toBe("demo");
    expect(methods(calls)).toEqual(["plugins.marketplace.list", "plugins.install.inspect"]);
    expect(calls[1]!.params).toEqual({ registry: { id: "demo" } });
    // The review is open and its permissions are NOT pre-accepted.
    expect(pk.review?.reviewId).toBe("rev-1");
    expect(pk.reviewAccepted).toBe(false);
    // Confirming without ticking the box does nothing.
    await pk.commitReview();
    expect(methods(calls)).not.toContain("plugins.install.commit");
    expect(methods(calls).some((m) => /enable/i.test(m))).toBe(false);
  });

  it("paid plugin without a token: shows the card and sends the user to buy it (no licence key field)", async () => {
    const paid = entry({ firstParty: true, pricing: { model: "paid", priceCents: 2900, currency: "USD", purchaseUrl: "https://cloud.example/marketplace/demo?buy=1" }, priceLabel: "$29.00" });
    const { pk, calls } = rig([paid]);
    await pk.openInstallLink({ id: "demo", source: null, token: null });
    expect(methods(calls)).toEqual(["plugins.marketplace.list"]);
    expect(pk.review).toBeNull();
    expect(pk.focusId).toBe("demo");
    expect(pk.notice).toMatchObject({ kind: "warn" });
    expect(pk.notice?.text).toContain("Install in InfiniBot on your purchase page");
    expect(pk.notice?.text).not.toMatch(/licen[cs]e/i);
  });

  it("paid plugin with the purchase page's token: straight to the review, the token goes to the registry only", async () => {
    const paid = entry({ firstParty: true, pricing: { model: "paid", priceCents: 2900, currency: "USD", purchaseUrl: "https://cloud.example/marketplace/demo?buy=1" }, priceLabel: "$29.00" });
    const { pk, calls } = rig([paid]);
    const tok = "ibin1.p.6f1c2d3e-0000-4000-8000-000000000001.1790000000.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd";
    await pk.openInstallLink({ id: "demo", source: "marketplace", token: tok });
    expect(methods(calls)).toEqual(["plugins.marketplace.list", "plugins.install.inspect"]);
    expect(calls[1]!.params).toEqual({ registry: { id: "demo", token: tok } });
    expect(pk.review?.reviewId).toBe("rev-1");
    expect(pk.reviewAccepted).toBe(false);
  });

  it("seller-delivered plugin: explains the zip import, never tries to download", async () => {
    const ext = entry({ distribution: "external", pricing: { model: "paid", priceCents: 1500, currency: "USD", purchaseUrl: "https://seller.example/buy" }, priceLabel: "$15.00" });
    const { pk, calls } = rig([ext]);
    await pk.openInstallLink({ id: "demo", source: null, token: null });
    expect(methods(calls)).toEqual(["plugins.marketplace.list"]);
    expect(pk.notice?.text).toContain("Import plugin");
    expect(pk.notice?.text).toContain("Acme");
  });

  it("already installed: no install flow, offers to open it", async () => {
    const { pk, calls } = rig([entry({ installed: { version: "1.2.0", origin: "global", package: true, updateAvailable: false } })]);
    await pk.openInstallLink({ id: "demo", source: null, token: null });
    expect(methods(calls)).toEqual(["plugins.marketplace.list"]);
    expect(pk.notice).toMatchObject({ kind: "ok", pluginId: "demo" });
  });

  it("unknown plugin or unreachable registry: a clear message, no install", async () => {
    const a = rig([entry({ id: "other" })]);
    await a.pk.openInstallLink({ id: "demo", source: null, token: null });
    expect(a.pk.notice).toMatchObject({ kind: "err" });
    expect(a.pk.notice?.text).toContain("demo");
    expect(a.pk.focusId).toBeNull();
    const b = rig([], { failList: "registry down" });
    await b.pk.openInstallLink({ id: "demo", source: null, token: null });
    expect(b.pk.marketError).toBe("registry down");
    expect(b.pk.review).toBeNull();
  });
});
