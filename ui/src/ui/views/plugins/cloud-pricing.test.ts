import { describe, expect, it } from "vitest";

import {
  formatPrice,
  loadCloudPricing,
  paidGate,
  toMarketEntry,
  vaultForPlugin,
  vaultOffer,
  VAULT_DOWNLOADS_ACTION,
  VAULT_INCLUDED_LABEL,
  VAULT_UNLOCK_ACTION,
  type CloudPricing,
} from "./cloud-pricing.js";
import { kinglyVaultUrls, KINGLYVAULT_CEO_URL_DEFAULT, KINGLYVAULT_DOWNLOADS_URL_DEFAULT } from "../../marketplace/kinglyvault.js";

const reg = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  version: "1.0.0",
  publisher: { id: "infinibot", name: "InfiniBot", verified: true },
  firstParty: true,
  description: "",
  category: "media",
  tags: [],
  pricing: { model: "free", priceCents: 0, currency: "USD", purchaseUrl: null },
  sizeBytes: 1,
  minHostVersion: "0.0.0",
  homepageUrl: null,
  listing: { cover: null, icon: null, screenshots: [] },
  distribution: "hosted",
  ...over,
});

const paid = (id: string, cents: number, over: Record<string, unknown> = {}) =>
  reg(id, {
    pricing: { model: "paid", priceCents: cents, currency: "USD", purchaseUrl: `https://cloud.infinibotos.com/marketplace/${id}?buy=1` },
    ...over,
  });

const INDEX = {
  schemaVersion: 1,
  plugins: [
    paid("flypic", 1900),
    paid("owned-app", 4900),
    paid("pending-app", 2900),
    reg("notes-lite"),
    paid("seller-app", 1500, { firstParty: false, distribution: "external", homepageUrl: "https://seller.example/app", pricing: { model: "paid", priceCents: 1500, currency: "USD", purchaseUrl: null } }),
  ],
};

type Call = { url: string; auth?: string };

function fakeFetch(calls: Call[], opts: { indexStatus?: number } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ url, auth });
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/index.json")) return res(opts.indexStatus ?? 200, INDEX);
    const id = new URL(url, "https://x").searchParams.get("plugin");
    if (id === "owned-app") return res(200, { access: { kind: "purchase" }, links: { installToken: "ibin1.p.abc.1.tok" } });
    if (id === "pending-app") return res(202, { pending: true });
    return res(402, { error: "not_purchased" });
  }) as typeof fetch;
}

const deps = (calls: Call[], token: string | null = "jwt", indexStatus?: number) => ({
  fetch: fakeFetch(calls, { indexStatus }),
  token: async () => token,
  apiBase: "/api/marketplace",
});

describe("formatPrice", () => {
  it("matches the gateway's price label", () => {
    expect(formatPrice({ model: "paid", priceCents: 1900, currency: "USD" })).toBe("$19.00");
    expect(formatPrice({ model: "free", priceCents: 0, currency: "USD" })).toBe("Free");
  });
});

describe("loadCloudPricing", () => {
  it("reads the index and checks access only for paid hosted first-party plugins, with the bearer", async () => {
    const calls: Call[] = [];
    const pricing = await loadCloudPricing(deps(calls));
    expect(pricing).not.toBeNull();
    expect(pricing!.entries.get("flypic")?.priceLabel).toBe("$19.00");
    expect(pricing!.ownership.get("flypic")).toBe("not-owned");
    expect(pricing!.ownership.get("owned-app")).toBe("owned");
    expect(pricing!.ownership.get("pending-app")).toBe("unknown");
    expect(pricing!.ownership.has("notes-lite")).toBe(false);
    expect(pricing!.ownership.has("seller-app")).toBe(false);
    expect(pricing!.tokens.get("owned-app")).toBe("ibin1.p.abc.1.tok");
    const access = calls.filter((c) => c.url.includes("/purchases/access"));
    expect(access.map((c) => new URL(c.url, "https://x").searchParams.get("plugin")).sort()).toEqual(["flypic", "owned-app", "pending-app"]);
    expect(access.every((c) => c.auth === "Bearer jwt")).toBe(true);
  });

  it("signed out: paid first-party plugins are not owned, no access calls", async () => {
    const calls: Call[] = [];
    const pricing = await loadCloudPricing(deps(calls, null));
    expect(pricing!.ownership.get("flypic")).toBe("not-owned");
    expect(calls.some((c) => c.url.includes("/purchases/access"))).toBe(false);
  });

  it("returns null when the marketplace is unreachable (cards fall back to Enable)", async () => {
    expect(await loadCloudPricing(deps([], "jwt", 503))).toBeNull();
    const throwing = { fetch: (async () => { throw new Error("offline"); }) as typeof fetch, token: async () => "jwt", apiBase: "/api/marketplace" };
    expect(await loadCloudPricing(throwing)).toBeNull();
  });
});

describe("paidGate", () => {
  const load = async (): Promise<CloudPricing> => (await loadCloudPricing(deps([])))!;
  const off = (id: string, origin = "bundled") => ({ id, enabled: false, origin });

  it("paid + not owned → Buy · $X linking to the cloud checkout", async () => {
    const g = paidGate(off("flypic"), await load());
    expect(g).toMatchObject({ kind: "buy", label: "Buy · $19.00", url: "https://cloud.infinibotos.com/marketplace/flypic?buy=1" });
  });

  it("owned, unknown, free, unlisted or already-on plugins keep Enable", async () => {
    const pricing = await load();
    expect(paidGate(off("owned-app"), pricing)).toBeNull();
    expect(paidGate(off("pending-app"), pricing)).toBeNull();
    expect(paidGate(off("notes-lite"), pricing)).toBeNull();
    expect(paidGate(off("not-in-registry"), pricing)).toBeNull();
    expect(paidGate({ id: "flypic", enabled: true, origin: "bundled" }, pricing)).toBeNull();
  });

  it("self-hosted / no pricing → no gate (today's Enable)", () => {
    expect(paidGate(off("flypic"), null)).toBeNull();
  });

  it("external paid: Buy on the seller's page unless it was imported", async () => {
    const pricing = await load();
    expect(paidGate(off("seller-app"), pricing)).toMatchObject({ kind: "external", label: "Buy · $15.00", url: "https://seller.example/app" });
    expect(paidGate(off("seller-app", "package"), pricing)).toBeNull();
  });
});

describe("Vault offer (KinglyVault CEO plan: labels and links only)", () => {
  const URLS = { ceoUrl: "https://kinglyvault.com/infinibot-plugins", downloadsUrl: "https://kinglyvault.com/infinibot/downloads" };
  const entry = (id: string) => toMarketEntry(INDEX.plugins.find((p) => p.id === id) as never);
  const off = (id: string) => ({ id, enabled: false, origin: "bundled" });

  it("signed out: paid first-party → Included in CEO plan + Unlock with Vault, Buy · $X kept", async () => {
    const calls: Call[] = [];
    const pricing = (await loadCloudPricing(deps(calls, null)))!;
    expect(vaultOffer(entry("flypic"), URLS)).toEqual({ badge: VAULT_INCLUDED_LABEL, ...URLS });
    expect(paidGate(off("flypic"), pricing)).toMatchObject({ kind: "buy", label: "Buy · $19.00", vault: { badge: "Included in CEO plan", ...URLS } });
    expect(vaultForPlugin("flypic", pricing, URLS)?.badge).toBe(VAULT_INCLUDED_LABEL);
    expect(VAULT_UNLOCK_ACTION).toBe("Unlock with Vault");
    expect(VAULT_DOWNLOADS_ACTION).toBe("CEO member? Download on KinglyVault");
  });

  it("paid, signed in, not owned: same offer next to the per-plugin Buy", async () => {
    const pricing = (await loadCloudPricing(deps([])))!;
    const gate = paidGate(off("flypic"), pricing)!;
    expect(gate.kind).toBe("buy");
    expect(gate.url).toBe("https://cloud.infinibotos.com/marketplace/flypic?buy=1");
    expect(gate.vault?.ceoUrl).toBe(KINGLYVAULT_CEO_URL_DEFAULT);
    expect(gate.vault?.downloadsUrl).toBe(KINGLYVAULT_DOWNLOADS_URL_DEFAULT);
  });

  it("owned (per-plugin purchase check): no gate, so Install / Enable as today; badge only", async () => {
    const calls: Call[] = [];
    const pricing = (await loadCloudPricing(deps(calls)))!;
    expect(paidGate(off("owned-app"), pricing)).toBeNull();
    expect(pricing.tokens.get("owned-app")).toBe("ibin1.p.abc.1.tok");
    expect(vaultForPlugin("owned-app", pricing, URLS)?.badge).toBe(VAULT_INCLUDED_LABEL);
    // never asks the server about a CEO plan
    expect(calls.some((c) => /ceo|owned$|all-?access/i.test(c.url))).toBe(false);
  });

  it("free plugins: no badge, no Vault button", async () => {
    const pricing = (await loadCloudPricing(deps([])))!;
    expect(vaultOffer(entry("notes-lite"), URLS)).toBeNull();
    expect(vaultForPlugin("notes-lite", pricing, URLS)).toBeNull();
    expect(paidGate(off("notes-lite"), pricing)).toBeNull();
  });

  it("external / third-party paid: keeps the seller link, never the CEO badge", async () => {
    const pricing = (await loadCloudPricing(deps([])))!;
    expect(vaultOffer(entry("seller-app"), URLS)).toBeNull();
    expect(paidGate(off("seller-app"), pricing)).toMatchObject({ kind: "external", url: "https://seller.example/app", vault: null });
    // a paid plugin by another publisher hosted here is not in the plan either
    expect(vaultOffer({ ...entry("flypic"), firstParty: false }, URLS)).toBeNull();
  });

  it("Vault URLs come from VITE_KINGLYVAULT_* (https only) with KinglyVault defaults", () => {
    expect(kinglyVaultUrls({})).toEqual({ ceoUrl: KINGLYVAULT_CEO_URL_DEFAULT, downloadsUrl: KINGLYVAULT_DOWNLOADS_URL_DEFAULT });
    expect(KINGLYVAULT_CEO_URL_DEFAULT).toBe("https://kinglyvault.com/infinibot-plugins");
    expect(KINGLYVAULT_DOWNLOADS_URL_DEFAULT).toBe("https://kinglyvault.com/infinibot/downloads");
    expect(kinglyVaultUrls({ VITE_KINGLYVAULT_CEO_URL: " https://kinglyvault.app/ceo ", VITE_KINGLYVAULT_DOWNLOADS_URL: "https://kinglyvault.app/dl" }))
      .toEqual({ ceoUrl: "https://kinglyvault.app/ceo", downloadsUrl: "https://kinglyvault.app/dl" });
    expect(kinglyVaultUrls({ VITE_KINGLYVAULT_CEO_URL: "javascript:alert(1)", VITE_KINGLYVAULT_DOWNLOADS_URL: "http://kinglyvault.com" }))
      .toEqual({ ceoUrl: KINGLYVAULT_CEO_URL_DEFAULT, downloadsUrl: KINGLYVAULT_DOWNLOADS_URL_DEFAULT });
  });
});
