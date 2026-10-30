import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetSecureStoreForTests,
  attachSecureClient,
  friendlySecureError,
  getSecureState,
  handleSecureGatewayEvent,
  initialSecureState,
  isSecureLockedError,
  normalizeSecureStatus,
  parseLaneEvent,
  reduceSecure,
  secureActive,
  setSecureMode,
} from "./store";

const on = { enabled: true, unlocked: true, keySource: "secret-tool", keyAccount: "infinibot:abc", updatedAt: 5, allowedTools: ["read"] };
const off = { enabled: false, unlocked: false, keyAccount: "infinibot:abc", updatedAt: 6 };

afterEach(() => __resetSecureStoreForTests());

describe("normalizeSecureStatus", () => {
  it("parses a full status", () => {
    const s = normalizeSecureStatus({ ...on, counts: { projects: 1, tasks: 2, docs: 3, nodes: 4, edges: 5, sessions: 6 }, seededAt: 9 });
    expect(s).toMatchObject({ enabled: true, unlocked: true, keySource: "secret-tool", seededAt: 9, allowedTools: ["read"] });
    expect(s?.counts).toEqual({ projects: 1, tasks: 2, docs: 3, nodes: 4, edges: 5, sessions: 6 });
  });
  it("rejects malformed payloads", () => {
    expect(normalizeSecureStatus(null)).toBeNull();
    expect(normalizeSecureStatus({ unlocked: true })).toBeNull();
  });
  it("keeps the previous allowedTools when an event omits them", () => {
    const prev = normalizeSecureStatus(on);
    expect(normalizeSecureStatus(off, prev)?.allowedTools).toEqual(["read"]);
  });
  it("drops unknown key sources", () => {
    expect(normalizeSecureStatus({ ...on, keySource: "cloud" })?.keySource).toBeUndefined();
  });
});

describe("reduceSecure", () => {
  it("status on → active, clears error", () => {
    const s = reduceSecure({ ...initialSecureState(), error: "old" }, { type: "status", status: on });
    expect(secureActive(s)).toBe(true);
    expect(s.error).toBeNull();
    expect(s.supported).toBe(true);
  });
  it("enabled but locked surfaces the status error", () => {
    const s = reduceSecure(initialSecureState(), { type: "status", status: { ...on, unlocked: false, error: "no keyring" } });
    expect(secureActive(s)).toBe(false);
    expect(s.error).toBe("no keyring");
  });
  it("ignores malformed status but stops loading", () => {
    const s0 = reduceSecure(initialSecureState(), { type: "loading" });
    const s = reduceSecure(s0, { type: "status", status: "nope" });
    expect(s.loading).toBe(false);
    expect(s.status).toBeNull();
  });
  it("unsupported hides status", () => {
    const s = reduceSecure(reduceSecure(initialSecureState(), { type: "status", status: on }), { type: "unsupported" });
    expect(s.supported).toBe(false);
    expect(secureActive(s)).toBe(false);
  });
  it("busy start clears the error; same value is a no-op", () => {
    const s = reduceSecure({ ...initialSecureState(), error: "x" }, { type: "busy", busy: true });
    expect(s.error).toBeNull();
    expect(reduceSecure(s, { type: "busy", busy: true })).toBe(s);
  });
  it("chat-session is identity-stable", () => {
    const s = reduceSecure(initialSecureState(), { type: "chat-session", key: "agent:main:secure-1" });
    expect(s.chatSessionKey).toBe("agent:main:secure-1");
    expect(reduceSecure(s, { type: "chat-session", key: "agent:main:secure-1" })).toBe(s);
  });
});

describe("parseLaneEvent", () => {
  it("accepts known kinds only", () => {
    expect(parseLaneEvent({ kind: "graph", at: 3 })).toEqual({ kind: "graph", at: 3 });
    expect(parseLaneEvent({ kind: "secrets" })).toBeNull();
    expect(parseLaneEvent(null)).toBeNull();
  });
});

describe("errors", () => {
  it("detects the locked lane", () => {
    expect(isSecureLockedError(new Error("Secure Mode is off: the secure lane is locked."))).toBe(true);
    expect(isSecureLockedError(new Error("boom"))).toBe(false);
  });
  it("explains an old gateway", () => {
    expect(friendlySecureError(new Error("unknown method: secure.status"))).toMatch(/does not support Secure Mode/);
  });
});

describe("runtime store", () => {
  it("loads status on attach and follows secure.mode.changed", async () => {
    const request = vi.fn(async () => on);
    attachSecureClient({ request: request as never });
    await vi.waitFor(() => expect(secureActive(getSecureState())).toBe(true));
    expect(request).toHaveBeenCalledWith("secure.status", {});
    expect(handleSecureGatewayEvent("secure.mode.changed", off)).toBe(true);
    expect(secureActive(getSecureState())).toBe(false);
    expect(handleSecureGatewayEvent("secure.lane.changed", { kind: "kanban", at: 1 })).toBe(true);
    expect(handleSecureGatewayEvent("chat", {})).toBe(false);
  });
  it("marks unsupported gateways without calling them", () => {
    const request = vi.fn();
    attachSecureClient({ request: request as never, supports: () => false });
    expect(getSecureState().supported).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it("secure.set failure shows the keyring error inline", async () => {
    attachSecureClient({
      request: vi.fn(async (method: string) => {
        if (method === "secure.status") return off;
        throw new Error("No OS keyring key is reachable (secret-tool missing)");
      }) as never,
    });
    const ok = await setSecureMode(true);
    expect(ok).toBe(false);
    expect(getSecureState().error).toMatch(/keyring/);
    expect(getSecureState().busy).toBe(false);
  });
  it("secure.set success returns true", async () => {
    attachSecureClient({ request: vi.fn(async (method: string) => (method === "secure.set" ? on : off)) as never });
    expect(await setSecureMode(true)).toBe(true);
    expect(secureActive(getSecureState())).toBe(true);
  });
});
