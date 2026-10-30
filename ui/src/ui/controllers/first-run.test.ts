import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", memoryStorage());
});

async function load() {
  return await import("./first-run");
}

describe("first-run classification", () => {
  it("treats a gateway with only system sessions as a new install", async () => {
    const fr = await load();
    const fresh = [
      "agent:main:main",
      "agent:main:mcp-host-123",
      "agent:main:voice",
      "agent:overseer:subagent:6158f088",
      "agent:main:claude-coder:coder-x",
    ];
    expect(fr.countUserSessions(fresh)).toBe(0);
    expect(fr.classifyInstall(fresh)).toBe("new");
  });

  it("treats real conversations as an established install", async () => {
    const fr = await load();
    expect(fr.classifyInstall(["agent:main:main", "agent:main:webchat-abc"])).toBe("established");
    expect(fr.classifyInstall(["agent:main:grid-session-1"])).toBe("established");
    expect(fr.classifyInstall(["agent:main:telegram:dm:42"])).toBe("established");
  });

  it("treats a large history as established regardless of keys", async () => {
    const fr = await load();
    const many = Array.from({ length: 30 }, (_, i) => `agent:main:subagent:${i}`);
    expect(fr.classifyInstall(many)).toBe("established");
  });
});

describe("first-run evaluation + persistence", () => {
  const client = (keys: string[]) =>
    ({ request: vi.fn(async () => ({ sessions: keys.map((key) => ({ key })) })) }) as never;

  it("activates the checklist on a fresh gateway and remembers it", async () => {
    const fr = await load();
    const onChange = vi.fn();
    await fr.evaluateFirstRun(client(["agent:main:main"]), onChange);
    expect(fr.isFirstRunActive()).toBe(true);
    expect(onChange).toHaveBeenCalled();
    // After a first chat the decision does not flip back.
    vi.resetModules();
    const again = await load();
    await again.evaluateFirstRun(client(["agent:main:webchat-1"]), () => {});
    expect(again.isFirstRunActive()).toBe(true);
  });

  it("never shows the checklist to an existing install", async () => {
    const fr = await load();
    await fr.evaluateFirstRun(client(["agent:main:webchat-1", "agent:main:main"]), () => {});
    expect(fr.getFirstRunStatus()).toBe("established");
    expect(fr.isFirstRunActive()).toBe(false);
  });

  it("dismissing sticks across reloads", async () => {
    const fr = await load();
    await fr.evaluateFirstRun(client([]), () => {});
    expect(fr.isFirstRunActive()).toBe(true);
    fr.setFirstRunStatus("dismissed");
    vi.resetModules();
    const again = await load();
    expect(again.isFirstRunActive()).toBe(false);
    expect(again.getFirstRunStatus()).toBe("dismissed");
  });

  it("leaves the decision open when the RPC fails", async () => {
    const fr = await load();
    const bad = { request: vi.fn(async () => { throw new Error("offline"); }) } as never;
    await fr.evaluateFirstRun(bad, () => {});
    expect(fr.getFirstRunStatus()).toBeNull();
  });

  it("tracks manually ticked items", async () => {
    const fr = await load();
    expect(fr.firstRunProgress()).toEqual({ done: 0, total: 6 });
    fr.markFirstRunItem("learn");
    expect(fr.isFirstRunItemDone("learn")).toBe(true);
    expect(fr.firstRunProgress().done).toBe(1);
    fr.markFirstRunItem("learn", false);
    expect(fr.isFirstRunItemDone("learn")).toBe(false);
  });
});
