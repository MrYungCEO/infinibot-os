import { describe, expect, it } from "vitest";
import { isUnknownMethod, kvView, tokenFromPaste, type KvStatus } from "./kv-connect-model.js";

const caps = (available: boolean) => ({ available, reason: available ? null : "Connecting a KinglyVault account isn't switched on yet.", checkedAt: "2026-10-19T00:00:00Z", webUrl: "https://kinglyvault.com" });
const account = (over: Partial<KvStatus["account"]> = {}): KvStatus["account"] => ({
  linked: false, email: null, state: "none", lastRefreshAt: null, lastError: null, canRefresh: false, items: [], ...over,
});

describe("kvView", () => {
  it("older gateway → hidden; first load → loading", () => {
    expect(kvView("unsupported", null)).toEqual({ kind: "hidden" });
    expect(kvView(null, null)).toEqual({ kind: "loading" });
  });
  it("KinglyVault endpoints not live → the button is disabled with the reason", () => {
    expect(kvView({ capabilities: caps(false), account: account(), connect: null }, null)).toEqual({
      kind: "unavailable",
      reason: "Connecting a KinglyVault account isn't switched on yet.",
    });
  });
  it("ready → waiting with the code → linked as <email>", () => {
    const status: KvStatus = { capabilities: caps(true), account: account(), connect: null };
    expect(kvView(status, null)).toEqual({ kind: "ready", note: null });
    const c = { id: "c1", status: "pending" as const, userCode: "BCDF-GHJK", verificationUri: "https://kv/infinibot/connect", verificationUriComplete: "https://kv/infinibot/connect?code=BCDF-GHJK", expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null, email: null, changed: [], restart: null };
    expect(kvView(status, c)).toMatchObject({ kind: "waiting", code: "BCDF-GHJK", url: c.verificationUriComplete });
    const linked = kvView({ ...status, account: account({ linked: true, state: "valid", email: "ceo@kv.test", items: [{ pluginId: "*", source: "plan:ceo", until: null, active: true }] }) }, c);
    expect(linked).toMatchObject({ kind: "linked", email: "ceo@kv.test" });
    if (linked.kind === "linked") expect(linked.detail).toMatch(/includes every paid plugin/);
  });
  it("a denied / expired request returns to ready with the reason", () => {
    const status: KvStatus = { capabilities: caps(true), account: account(), connect: null };
    const c = { id: "c1", status: "denied" as const, userCode: "X", verificationUri: "", verificationUriComplete: "", expiresAt: new Date(Date.now() + 60_000).toISOString(), error: "The request was denied on KinglyVault.", email: null, changed: [], restart: null };
    expect(kvView(status, c)).toEqual({ kind: "ready", note: "The request was denied on KinglyVault." });
  });
  it("offline grace is a warning, not a disconnect", () => {
    const v = kvView({ capabilities: caps(false), account: account({ linked: true, state: "grace", email: "a@b.c" }), connect: null }, null);
    expect(v).toMatchObject({ kind: "linked", warn: expect.stringMatching(/Offline/) });
  });
});

describe("helpers", () => {
  it("isUnknownMethod matches the gateway's reply for a missing RPC", () => {
    expect(isUnknownMethod(new Error("unknown method: plugins.kv.status"))).toBe(true);
    expect(isUnknownMethod(new Error("KinglyVault can't be reached"))).toBe(false);
  });
  it("tokenFromPaste takes a bare key or one inside a pasted link", () => {
    expect(tokenFromPaste("  aaa.bbb.ccc \n")).toBe("aaa.bbb.ccc");
    expect(tokenFromPaste("infinibot://license?token=aaa.bbb.ccc&x=1")).toBe("aaa.bbb.ccc");
    expect(tokenFromPaste("not a key")).toBeNull();
  });
});
