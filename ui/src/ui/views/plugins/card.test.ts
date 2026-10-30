import { describe, expect, it, vi } from "vitest";
import { nothing, type TemplateResult } from "lit";

import { renderCardIcon, renderCardSkeletons, renderPluginCard, type CardSpec } from "./card.js";
import { vaultOffer } from "./cloud-pricing.js";
import { marketPermissionLines, PluginPackages, type MarketEntry, type PackagesHost } from "./packages.js";

/** A Lit template as text: static parts + bound values (handlers dropped). Enough to assert what renders. */
function text(v: unknown): string {
  if (v === nothing || v === null || v === undefined || v === false) return "";
  if (typeof v === "function") return "";
  if (Array.isArray(v)) return v.map(text).join("");
  if (typeof v === "object" && v && "strings" in v && "values" in v) {
    const t = v as TemplateResult;
    // `attr=${v}` (Lit allows unquoted bindings) reads back as attr="v".
    return t.strings.reduce((out, s, i) => {
      if (i >= t.values.length) return out + s;
      const v = text(t.values[i]);
      return out + s + (/[\w-]=$/.test(s) ? `"${v}"` : v);
    }, "");
  }
  return String(v);
}
const squash = (v: unknown) => text(v).replace(/\s+/g, " ");

const spec = (over: Partial<CardSpec> = {}): CardSpec => ({
  id: "flypic",
  kind: "market",
  name: "FlyPic",
  cover: "https://reg.example/cover.svg",
  icon: { src: "https://reg.example/icon.svg", monogram: "FP" },
  onOpen: () => {},
  publisher: "InfiniBot",
  verified: true,
  version: "2026.10.4",
  tagline: "Studio inside InfiniBot",
  ...over,
});

describe("shared plugin card", () => {
  it("marketplace card: same pm-card markup as installed, cover + icon + byline + tagline", () => {
    const out = squash(renderPluginCard(spec({ footActions: "ACTIONS", tags: "TAGS" })));
    expect(out).toContain('class="pm-card');
    expect(out).toContain('data-market-card="flypic"');
    expect(out).not.toContain('data-plugin-card="flypic"');
    expect(out).toContain('<div class="pm-cover"> <img src="https://reg.example/cover.svg"');
    expect(out).toContain('class="pm-icon md has-img"');
    expect(out).toContain('data-market-detail="flypic"');
    expect(out).toContain("InfiniBot<span class=\"pk-verified\"");
    expect(out).toContain("v2026.10.4");
    expect(out).toContain('<p class="pm-desc">Studio inside InfiniBot</p>');
    expect(out).toContain('<div class="pm-tags">TAGS</div>');
    expect(out).toContain('<span class="pm-foot-actions">ACTIONS</span>');
  });

  it("installed card keeps its hooks (data-plugin-card / -row / open-detail)", () => {
    const out = squash(renderPluginCard(spec({ kind: "plugin", verified: false, className: "is-on" })));
    expect(out).toContain('data-plugin-card="flypic"');
    expect(out).toContain('data-plugin-row="flypic"');
    expect(out).toContain('data-open-detail="flypic"');
    expect(out).toContain("is-on");
    expect(out).not.toContain(`data-market-card="flypic"`);
    expect(out).not.toContain("pk-verified");
  });

  it("no tagline → placeholder; monogram tile without an icon", () => {
    expect(squash(renderPluginCard(spec({ tagline: "" })))).toContain("No description.");
    const mono = squash(renderCardIcon({ monogram: "FP", scopeId: "flypic", scopeStyle: "--x:1" }, "xl"));
    expect(mono).toContain('class="pm-icon xl"');
    expect(mono).toContain(">FP</span>");
    expect(mono).toContain('data-plugin-scope="flypic"');
  });

  it("skeletons are card-shaped (both tabs)", () => {
    const out = squash(renderCardSkeletons(3, "Loading the marketplace"));
    expect(out.match(/pm-card pm-skel/g)).toHaveLength(3);
    expect(out).toContain('aria-label="Loading the marketplace"');
  });
});

const entry = (over: Partial<MarketEntry> = {}): MarketEntry => ({
  id: "demo",
  name: "Demo Tool",
  version: "1.2.0",
  publisher: { id: "acme", name: "Acme", verified: true },
  firstParty: false,
  description: "Does **demo** things",
  category: "apps",
  tags: ["voice", "studio", "extra"],
  pricing: { model: "free", priceCents: 0, currency: "USD", purchaseUrl: null },
  priceLabel: "Free",
  sizeBytes: 1000,
  minHostVersion: "2026.6.30",
  homepageUrl: null,
  listing: { cover: "https://reg.example/demo/cover.svg", icon: "https://reg.example/demo/icon.svg", screenshots: [], tagline: "Demo tagline" },
  installed: null,
  compatible: true,
  blocked: null,
  ...over,
});

const flypic = entry({
  id: "flypic",
  name: "FlyPic",
  firstParty: true,
  publisher: { id: "infinibot", name: "InfiniBot", verified: true },
  pricing: { model: "paid", priceCents: 1900, currency: "USD", purchaseUrl: "https://cloud.example/marketplace/flypic?buy=1" },
  priceLabel: "$19.00",
  sha256: "66b7fd39b6cbbe34224c194d9e74ff12da775beb70a9a1541589062cc3141586",
});

function packages(plugins: MarketEntry[], over: Partial<PackagesHost> = {}) {
  const host: PackagesHost = {
    rpc: vi.fn(async () => ({})) as PackagesHost["rpc"],
    update: () => {},
    refresh: async () => {},
    open: vi.fn(),
    plugins: () => [],
    runningSubagents: () => 0,
    countSubagents: () => {},
    ...over,
  };
  const pk = new PluginPackages(host);
  pk.tab = "marketplace";
  pk.market = { registryUrl: "https://reg.example", generatedAt: "", hostVersion: "", plugins };
  return { pk, host };
}

const card = (pk: PluginPackages, id: string) => {
  const all = squash(pk.renderMarketplace());
  const start = all.indexOf(`data-market-card="${id}"`);
  const next = all.indexOf("data-market-card=", start + 10);
  return all.slice(start, next < 0 ? undefined : next);
};

describe("marketplace card states", () => {
  const vault = (e: MarketEntry) => vaultOffer(e, { ceoUrl: "https://kv.example/ceo", downloadsUrl: "https://kv.example/dl" });

  it("paid first-party on the cloud: CEO badge, Unlock with Vault first, Buy secondary, KinglyVault download link", () => {
    const { pk } = packages([flypic], { vault });
    const c = card(pk, "flypic");
    expect(c).toContain('data-vault-badge>Included in CEO plan</span>');
    expect(c).toMatch(/class="pm-action primary pm-vault-unlock[^"]*" data-vault-unlock="flypic" href="https:\/\/kv.example\/ceo" target="_blank"/);
    expect(c).toMatch(/class="pm-action pm-buy-secondary[^"]*" data-market-buy="flypic"/);
    expect(c).toContain(">Buy · $19.00</button>");
    expect(c.indexOf("data-vault-unlock")).toBeLessThan(c.indexOf("data-market-buy"));
    expect(c).toContain('data-vault-downloads href="https://kv.example/dl"');
    expect(c).toContain("CEO member? Download on KinglyVault");
    // Price chip on the cover, tier pill like the Installed tab.
    expect(c).toContain('<span class="pk-price paid" data-price>$19.00</span>');
    expect(c).toContain('class="pm-tier t-first-party"');
    // Real listing art.
    expect(c).toContain('src="https://reg.example/demo/cover.svg"');
    expect(c).toContain('class="pm-icon md has-img"');
  });

  it("paid without a Vault offer (local gateway): Buy is the primary action, no CEO badge", () => {
    const { pk } = packages([flypic]);
    const c = card(pk, "flypic");
    expect(c).not.toContain("data-vault");
    expect(c).toMatch(/class="pm-action primary\s*" data-market-buy="flypic"/);
  });

  it("free: Free chip + Install; installed: Installed state + Open; update: chip + Update to", () => {
    const { pk } = packages([
      entry({ id: "free-one" }),
      entry({ id: "have-it", installed: { version: "1.2.0", origin: "global", package: true, updateAvailable: false } }),
      entry({ id: "old-one", installed: { version: "1.0.0", origin: "global", package: true, updateAvailable: true } }),
    ]);
    const free = card(pk, "free-one");
    expect(free).toContain('<span class="pk-price free" data-price>Free</span>');
    expect(free).toContain('data-market-install="free-one"');
    expect(free).toContain(">Install</button>");
    const have = card(pk, "have-it");
    expect(have).toContain("data-market-installed");
    expect(have).toContain("Installed · v1.2.0");
    expect(have).toContain('data-market-open="have-it"');
    const old = card(pk, "old-one");
    expect(old).toContain('data-update-badge="old-one"');
    expect(old).toContain(">Update to 1.2.0</button>");
  });

  it("third-party seller: Website link and their Buy, never a CEO badge", () => {
    const ext = entry({
      id: "acme-seller",
      distribution: "external",
      homepageUrl: "https://acme.example",
      pricing: { model: "paid", priceCents: 900, currency: "USD", purchaseUrl: "https://acme.example/buy" },
      priceLabel: "$9.00",
    });
    const { pk } = packages([ext], { vault });
    const c = card(pk, "acme-seller");
    expect(c).toContain('href="https://acme.example" target="_blank" rel="noopener noreferrer">Website</a>');
    expect(c).toContain(">Buy · $9.00</button>");
    expect(c).not.toContain("data-vault");
  });

  it("a broken cover falls back to the generated InfiniBot cover, a broken icon to the monogram", () => {
    const { pk } = packages([entry()]);
    pk.broken = new Set(["https://reg.example/demo/cover.svg", "https://reg.example/demo/icon.svg"]);
    const c = card(pk, "demo");
    expect(c).toContain('src="data:image/svg+xml');
    expect(c).toContain('class="pm-icon md"');
    expect(c).toContain(">DT</span>");
  });

  it("loading shows the same card skeletons", () => {
    const { pk } = packages([]);
    pk.market = null;
    pk.marketLoading = true;
    expect(squash(pk.renderMarketplace())).toContain("data-card-skeletons");
  });
});

describe("marketplace detail page", () => {
  const detail = {
    ...flypic,
    description: "## FlyPic\nLong **markdown**.",
    listing: {
      ...flypic.listing,
      screenshots: [
        { src: "https://reg.example/shot-1.webp", caption: "Studio" },
        { src: "https://reg.example/shot-2.webp", caption: "Library" },
      ],
    },
    permissions: { network: ["flypic.ai"], secrets: ["FLYPIC_API_KEY"], fs: ["<stateDir>/plugin-data/flypic"], exec: false, phi: false },
    versions: [{ version: "1.2.0", releasedAt: "2026-10-04T10:31:57.795Z", changelog: "Motion swap." }],
  };

  it("loads plugins.marketplace.get and renders hero, gallery, markdown, permissions, facts and the action panel", async () => {
    const rpc = vi.fn(async (m: string) => (m === "plugins.marketplace.get" ? { plugin: detail } : {}));
    const md = vi.fn((s: string) => `MD(${s})`);
    const { pk } = packages([flypic], { rpc: rpc as PackagesHost["rpc"], markdown: md, vault: (e) => vaultOffer(e, { ceoUrl: "https://kv.example/ceo", downloadsUrl: "https://kv.example/dl" }) });
    pk.openDetail("flypic");
    await vi.waitFor(() => expect(pk.detailLoading).toBe(false));
    expect(rpc).toHaveBeenCalledWith("plugins.marketplace.get", { id: "flypic" });
    const out = squash(pk.renderMarketDetail());
    expect(out).toContain('data-market-detail-page="flypic"');
    expect(out).toContain('<div class="pm-dhero">');
    expect(out).toContain('class="pm-icon xl has-img"');
    expect(out).toContain('<h1 class="pm-dname">FlyPic</h1>');
    expect(out).toContain('data-vault-badge>Included in CEO plan</span>');
    // Gallery with captions.
    expect(out).toContain("data-gallery");
    expect(out).toContain("<figcaption>Studio</figcaption>");
    expect(out).toContain("<figcaption>Library</figcaption>");
    // Full markdown description through the page's sanitizer.
    expect(md).toHaveBeenCalledWith("## FlyPic\nLong **markdown**.");
    // Permissions in plain English.
    expect(out).toContain("Uses the secret FLYPIC_API_KEY");
    expect(out).toContain("Connects to flypic.ai");
    // Facts: version, size, sha, host version.
    expect(out).toContain("data-market-sha>66b7fd39b6cb…</span>");
    expect(out).toContain("2026.6.30 or newer");
    // Action panel: Unlock with Vault + Buy + KinglyVault downloads.
    const panel = out.slice(out.indexOf("data-market-actions"), out.indexOf("pm-dgrid"));
    expect(panel).toContain("data-vault-unlock");
    expect(panel).toContain(">Buy · $19.00</button>");
    expect(panel).toContain("CEO member? Download on KinglyVault");
    // The list's install state is kept over the detail payload.
    expect(pk.marketEntry()?.installed).toBeNull();
  });

  it("serverless / older gateway: reads the public registry detail instead", async () => {
    const rpc = vi.fn(async () => {
      throw new Error("unknown method: plugins.marketplace.get");
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...detail, priceLabel: undefined }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { pk } = packages([flypic], { rpc: rpc as PackagesHost["rpc"] });
      pk.openDetail("flypic");
      await vi.waitFor(() => expect(pk.detailLoading).toBe(false));
      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/marketplace/plugins/flypic");
      expect(pk.detailError).toBeNull();
      expect(squash(pk.renderMarketDetail())).toContain("Connects to flypic.ai");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Escape and the back button leave the detail page", () => {
    const { pk } = packages([flypic]);
    pk.detailId = "flypic";
    pk.detail = { ...flypic };
    expect(pk.handleEscape()).toBe(true);
    expect(pk.detailId).toBeNull();
    pk.detailId = "flypic";
    pk.setTab("installed");
    expect(pk.detailId).toBeNull();
  });
});

describe("listing permissions in plain English", () => {
  it("riskiest first; nothing invented for an empty summary", () => {
    expect(marketPermissionLines(undefined)).toEqual([]);
    expect(marketPermissionLines({ network: [], exec: false })).toEqual([]);
    const lines = marketPermissionLines({ fs: ["/data"], network: ["a.com", "b.com"], exec: true, gated: ["gated:orders"] });
    expect(lines.map((l) => l.key)).toEqual(["exec", "gated", "network", "fs"]);
    expect(lines.find((l) => l.key === "network")?.text).toBe("Connects to a.com and b.com");
    expect(lines[0]?.risk).toBe("high");
  });
});
