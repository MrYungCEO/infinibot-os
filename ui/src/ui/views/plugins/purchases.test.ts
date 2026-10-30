import { describe, expect, it } from "vitest";
import { accessBadge, accessBlock, cardStatus, primaryAction } from "./model.js";
import { parseReturnFragment, priceTag } from "./purchases.js";
import type { PluginSummary } from "./api.js";

const base = { id: "flypic", name: "FlyPic", enabled: false, status: "disabled", source: "x", origin: "bundled" } as unknown as PluginSummary;
const locked = {
  ...base,
  access: { status: "locked-purchase", loadable: false, reason: "Paid plugin ($19).", requires: { purchase: true }, price: { priceCents: 1900, currency: "USD", label: "$19" } },
} as PluginSummary;

describe("paid plugin card state", () => {
  it("a locked paid plugin shows Buy and never Enable", () => {
    expect(accessBlock(locked)).toMatchObject({ kind: "paid", label: "Locked" });
    expect(cardStatus(locked).kind).toBe("paid");
    expect(primaryAction(locked)).toEqual({ kind: "buy", label: "Buy · $19" });
    expect(accessBadge(locked)).toEqual({ kind: "paid", label: "$19" });
  });
  it("droid-swarm is a paid plugin with Buy, never a Desktop lock", () => {
    const d = { ...locked, id: "droid-swarm", access: { ...locked.access!, price: { priceCents: 4900, currency: "USD", label: "$49" } } } as PluginSummary;
    expect(cardStatus(d).kind).toBe("paid");
    expect(primaryAction(d)).toEqual({ kind: "buy", label: "Buy · $49" });
    expect(accessBadge(d)).toEqual({ kind: "paid", label: "$49" });
  });
  it("the owner grant shows as Owner", () => {
    const o = { ...locked, access: { ...locked.access!, status: "unlocked", loadable: true, source: "admin:owner" } } as PluginSummary;
    expect(accessBlock(o)).toBeNull();
    expect(accessBadge(o)).toEqual({ kind: "owned", label: "Owner" });
  });
  it("an owned plugin turns on normally", () => {
    const owned = { ...locked, access: { ...locked.access!, status: "unlocked", loadable: true, source: "plan:ceo" } } as PluginSummary;
    expect(accessBlock(owned)).toBeNull();
    expect(primaryAction(owned).kind).toBe("enable");
    expect(accessBadge(owned)).toEqual({ kind: "owned", label: "Included with your CEO plan" });
  });
  it("a paid plugin the hosted cloud plan governs (status free) has no KinglyVault badge or gate", () => {
    const hosted = { ...locked, access: { ...locked.access!, status: "free", loadable: true } } as PluginSummary;
    expect(accessBlock(hosted)).toBeNull();
    expect(accessBadge(hosted)).toBeNull();
  });
  it("free plugins carry no badge", () => {
    expect(accessBadge({ ...base, access: { status: "free", loadable: true, requires: { purchase: false }, price: null } } as PluginSummary)).toBeNull();
  });
});

describe("KinglyVault return fragment", () => {
  it("decodes #kv=<base64url JSON>", () => {
    const payload = { token: "a.b.c", refreshToken: "ibr_x", apiUrl: "https://x", state: "s1234567", plugin: "flypic" };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(parseReturnFragment(`#kv=${b64}`)).toEqual(payload);
  });
  it("ignores anything else", () => {
    expect(parseReturnFragment("#plugin=x")).toBeNull();
    expect(parseReturnFragment("#kv=!!!")).toBeNull();
  });
});

describe("onboarding reads the gateway's compat gate fields", () => {
  it("a locked paid plugin is 'buy', never auto-enabled; an owned one may be enabled", async () => {
    const { decidePlugin } = await import("../../onboarding/plugin-gating.js");
    const row = { id: "flypic", name: "FlyPic", enabled: false, paid: true, priceLabel: "$19", entitled: false };
    expect(decidePlugin("flypic", row, undefined).action).toBe("buy");
    expect(decidePlugin("flypic", { ...row, entitled: true }, undefined).action).toBe("enable");
  });
});

describe("price tag: exactly one of Free / Included / Owned / Buy", () => {
  const unlocked = (source: string) => ({ ...locked, access: { ...locked.access!, status: "unlocked", loadable: true, source } }) as PluginSummary;
  it("not owned → Buy with the price; owned purchase → Owned", () => {
    expect(priceTag(locked)).toMatchObject({ kind: "buy", label: "Buy $19" });
    expect(priceTag(unlocked("purchase"))).toMatchObject({ kind: "owned", label: "Owned" });
    expect(priceTag(unlocked("sandbox"))).toMatchObject({ kind: "owned" });
  });
  it("plan, admin and the owner licence → Included (never a purchase prompt)", () => {
    for (const src of ["plan:ceo", "plan:vip", "admin", "admin:owner"]) {
      const t = priceTag(unlocked(src));
      expect(t?.kind).toBe("included");
      expect(t?.label).toBe(src === "plan:ceo" ? "Included with your CEO plan" : "Included");
    }
  });
  it("free plugins say Free; a cloud plan that includes a paid plugin says Included", () => {
    expect(priceTag({ ...base, access: { status: "free", loadable: true, requires: { purchase: false }, price: null } } as PluginSummary)).toMatchObject({ kind: "free" });
    expect(priceTag(base)).toMatchObject({ kind: "free" });
    const cloudIncluded = { ...locked, access: { ...locked.access!, status: "free", loadable: true, source: undefined }, cloud: { loadable: true, status: "included" } } as unknown as PluginSummary;
    expect(priceTag(cloudIncluded)).toMatchObject({ kind: "included" });
    const cloudLocked = { ...locked, cloud: { loadable: false, status: "locked" } } as unknown as PluginSummary;
    expect(priceTag(cloudLocked)).toBeNull();
  });
});
