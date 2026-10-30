import { afterEach, describe, expect, it, vi } from "vitest";
import { openSecureSession, surfaceLaneStorageKeys, switchSurfaceLane } from "./chat-surface";
import { isSecureSessionKey } from "./session-key";
import { __resetSecureStoreForTests } from "./store";

function memStorage() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const yes = async () => true;

afterEach(() => __resetSecureStoreForTests());

describe("surfaceLaneStorageKeys", () => {
  it("namespaces by surface and agent", () => {
    expect(surfaceLaneStorageKeys("sidebar", "ops")).toEqual({
      secure: "ib.secure.surface.sidebar.ops.secure",
      normal: "ib.secure.surface.sidebar.ops.normal",
    });
    expect(surfaceLaneStorageKeys("grid:p1", "")).toEqual(surfaceLaneStorageKeys("grid:p1", "main"));
  });
});

describe("openSecureSession", () => {
  it("uses the gateway-minted key", async () => {
    const request = vi.fn(async () => ({ sessionKey: "agent:ops:secure-gw-abc123" }));
    await expect(openSecureSession("ops", request)).resolves.toBe("agent:ops:secure-gw-abc123");
    expect(request).toHaveBeenCalledWith("secure.session.new", { agentId: "ops" });
  });
  it("falls back to a local secure key when the RPC fails or answers junk", async () => {
    const failing = vi.fn(async () => {
      throw new Error("unknown method");
    });
    const k1 = await openSecureSession("ops", failing);
    expect(isSecureSessionKey(k1)).toBe(true);
    expect(k1.startsWith("agent:ops:secure-")).toBe(true);
    const k2 = await openSecureSession("ops", async () => ({ sessionKey: "agent:ops:main" }));
    expect(k2.startsWith("agent:ops:secure-")).toBe(true);
  });
});

describe("switchSurfaceLane", () => {
  it("on: opens a new secure session and remembers the normal key", async () => {
    const storage = memStorage();
    const request = vi.fn(async () => ({ sessionKey: "agent:main:secure-new-aaaaaa" }));
    const res = await switchSurfaceLane({ on: true, surface: "sidebar", agentId: "main", currentKey: "agent:main:chat-1", ensure: yes, request, storage });
    expect(res).toEqual({ ok: true, key: "agent:main:secure-new-aaaaaa" });
    expect(storage.map.get("ib.secure.surface.sidebar.main.normal")).toBe("agent:main:chat-1");
    expect(storage.map.get("ib.secure.surface.sidebar.main.secure")).toBe("agent:main:secure-new-aaaaaa");
  });

  it("on: reuses the surface's remembered secure key for the same agent only", async () => {
    const storage = memStorage();
    storage.setItem("ib.secure.surface.grid:p1.main.secure", "agent:main:secure-old-bbbbbb");
    storage.setItem("ib.secure.surface.grid:p1.ops.secure", "agent:main:secure-wrong-cccccc");
    const request = vi.fn(async () => ({ sessionKey: "agent:ops:secure-fresh-dddddd" }));
    const a = await switchSurfaceLane({ on: true, surface: "grid:p1", agentId: "main", currentKey: "agent:main:x", ensure: yes, request, storage });
    expect(a).toEqual({ ok: true, key: "agent:main:secure-old-bbbbbb" });
    expect(request).not.toHaveBeenCalled();
    const b = await switchSurfaceLane({ on: true, surface: "grid:p1", agentId: "ops", currentKey: "agent:ops:y", ensure: yes, request, storage });
    expect(b).toEqual({ ok: true, key: "agent:ops:secure-fresh-dddddd" });
  });

  it("on: reports the error and changes nothing when Secure Mode cannot open", async () => {
    const storage = memStorage();
    const res = await switchSurfaceLane({ on: true, surface: "sidebar", agentId: "main", currentKey: "agent:main:chat-1", ensure: async () => false, storage });
    expect(res.ok).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  it("on: already in a secure session is a no-op", async () => {
    const request = vi.fn();
    const res = await switchSurfaceLane({ on: true, surface: "s", agentId: "main", currentKey: "agent:main:secure-k-eeeeee", ensure: yes, request, storage: memStorage() });
    expect(res).toEqual({ ok: true, key: "agent:main:secure-k-eeeeee" });
    expect(request).not.toHaveBeenCalled();
  });

  it("off: returns to the remembered normal key and remembers the secure one", async () => {
    const storage = memStorage();
    storage.setItem("ib.secure.surface.sidebar.main.normal", "agent:main:chat-1");
    const res = await switchSurfaceLane({ on: false, surface: "sidebar", agentId: "main", currentKey: "agent:main:secure-k-ffffff", storage });
    expect(res).toEqual({ ok: true, key: "agent:main:chat-1" });
    expect(storage.map.get("ib.secure.surface.sidebar.main.secure")).toBe("agent:main:secure-k-ffffff");
  });

  it("off: falls back to the surface default, then to a fresh chat (null)", async () => {
    const storage = memStorage();
    const a = await switchSurfaceLane({ on: false, surface: "x", agentId: "main", currentKey: "agent:main:secure-k-gggggg", fallbackNormalKey: "agent:main:quick-chat", storage });
    expect(a).toEqual({ ok: true, key: "agent:main:quick-chat" });
    const b = await switchSurfaceLane({ on: false, surface: "y", agentId: "main", currentKey: "agent:main:secure-k-gggggg", storage });
    expect(b).toEqual({ ok: true, key: null });
    // A remembered key for another agent is not reused.
    storage.setItem("ib.secure.surface.z.main.normal", "agent:ops:chat");
    const c = await switchSurfaceLane({ on: false, surface: "z", agentId: "main", currentKey: "agent:main:secure-k-gggggg", storage });
    expect(c).toEqual({ ok: true, key: null });
  });
});
