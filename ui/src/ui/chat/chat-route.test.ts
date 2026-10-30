import { describe, expect, it } from "vitest";

import {
  AGENT_ROUTE,
  adoptDraftRoute,
  backendInfoFromRouting,
  claudeBridgeNotice,
  folderName,
  messageRoute,
  normalizeBackend,
  parseRoute,
  parseRouteCommand,
  readLastCli,
  readRecentFolders,
  readRoute,
  rememberFolder,
  routeDividers,
  routeId,
  writeRoute,
} from "./chat-route";

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

describe("route persistence", () => {
  it("defaults every thread to the agent", () => {
    const s = memStore();
    expect(readRoute("agent:main:webchat-a", s)).toEqual(AGENT_ROUTE);
    expect(readRoute(null, s)).toEqual(AGENT_ROUTE);
  });

  it("keeps the choice per thread", () => {
    const s = memStore();
    writeRoute("t1", { mode: "cli", backend: "codex", cwd: "/repo" }, s);
    writeRoute("t2", { mode: "cli", backend: "claude-code" }, s);
    expect(readRoute("t1", s)).toEqual({ mode: "cli", backend: "codex", cwd: "/repo" });
    expect(readRoute("t2", s)).toEqual({ mode: "cli", backend: "claude-code" });
    expect(readRoute("t3", s)).toEqual(AGENT_ROUTE);
  });

  it("switching back to the agent clears the thread's entry", () => {
    const s = memStore();
    writeRoute("t1", { mode: "cli", backend: "gemini" }, s);
    writeRoute("t1", AGENT_ROUTE, s);
    expect(readRoute("t1", s)).toEqual(AGENT_ROUTE);
    expect([...s.raw.keys()].some((k) => k.endsWith(".t1"))).toBe(false);
  });

  it("remembers the last CLI for the segmented control", () => {
    const s = memStore();
    expect(readLastCli(s)).toBeNull();
    writeRoute("t1", { mode: "cli", backend: "opencode", cwd: "/x" }, s);
    writeRoute("t1", AGENT_ROUTE, s);
    expect(readLastCli(s)).toEqual({ mode: "cli", backend: "opencode", cwd: "/x" });
  });

  it("a new chat inherits the draft route under its real key", () => {
    const s = memStore();
    writeRoute(null, { mode: "cli", backend: "codex", cwd: "/r" }, s);
    expect(adoptDraftRoute("agent:main:webchat-new", s)).toEqual({ mode: "cli", backend: "codex", cwd: "/r" });
    expect(readRoute("agent:main:webchat-new", s)).toEqual({ mode: "cli", backend: "codex", cwd: "/r" });
  });

  it("ignores corrupt or unknown stored values", () => {
    const s = memStore();
    s.setItem("infinibot.chat.route.t1", "{not json");
    s.setItem("infinibot.chat.route.t2", JSON.stringify({ mode: "cli", backend: "cursor" }));
    expect(readRoute("t1", s)).toEqual(AGENT_ROUTE);
    expect(readRoute("t2", s)).toEqual(AGENT_ROUTE);
    expect(parseRoute({ mode: "cli", backend: "claude", cwd: "  ", model: " opus " })).toEqual({
      mode: "cli",
      backend: "claude-code",
      model: "opus",
    });
  });

  it("recent folders: newest first, deduped, capped", () => {
    const s = memStore();
    for (let i = 0; i < 10; i++) rememberFolder(`/p${i}`, s);
    rememberFolder("/p3", s);
    const list = readRecentFolders(s);
    expect(list[0]).toBe("/p3");
    expect(list).toHaveLength(8);
    expect(new Set(list).size).toBe(8);
  });
});

describe("slash commands", () => {
  it("/cli <backend> [folder]", () => {
    expect(parseRouteCommand("/cli codex")).toEqual({ kind: "cli", backend: "codex" });
    expect(parseRouteCommand("/cli claude ~/Desktop/Development/InfiniBot-fresh")).toEqual({
      kind: "cli",
      backend: "claude-code",
      cwd: "~/Desktop/Development/InfiniBot-fresh",
    });
    expect(parseRouteCommand("  /CLI  Gemini  ")).toEqual({ kind: "cli", backend: "gemini" });
  });

  it("/cli alone and /cli <folder> keep the last CLI", () => {
    expect(parseRouteCommand("/cli")).toEqual({ kind: "cli", backend: null });
    expect(parseRouteCommand("/cli ~/proj")).toEqual({ kind: "cli", backend: null, cwd: "~/proj" });
  });

  it("shortcuts and the agent command", () => {
    expect(parseRouteCommand("/codex")).toEqual({ kind: "cli", backend: "codex" });
    expect(parseRouteCommand("/opencode /tmp")).toEqual({ kind: "cli", backend: "opencode", cwd: "/tmp" });
    expect(parseRouteCommand("/agent")).toEqual({ kind: "agent" });
    expect(parseRouteCommand("/agent cmo")).toEqual({ kind: "agent", agentId: "cmo" });
  });

  it("unknown CLIs are reported, other text passes through", () => {
    expect(parseRouteCommand("/cli cursor")).toEqual({ kind: "cli-unknown", name: "cursor" });
    expect(parseRouteCommand("/cli grok ~/p")).toEqual({ kind: "cli", backend: "grok", cwd: "~/p" });
    expect(parseRouteCommand("/claude on")).toBeNull(); // the gateway's own bridge command
    expect(parseRouteCommand("/model opus")).toBeNull();
    expect(parseRouteCommand("use /cli codex please")).toBeNull();
    expect(parseRouteCommand("/client list")).toBeNull();
  });
});

describe("routing helpers", () => {
  it("normalizes backend vocabularies", () => {
    expect(normalizeBackend("claude-cli")).toBe("claude-code");
    expect(normalizeBackend("cc")).toBe("claude-code");
    expect(normalizeBackend("codex-cli")).toBe("codex");
    expect(normalizeBackend("nope")).toBeNull();
    expect(routeId({ mode: "cli", backend: "gemini" })).toBe("gemini");
    expect(routeId(AGENT_ROUTE)).toBe("agent");
  });

  it("maps cliRouting.status rows to switcher status dots", () => {
    expect(backendInfoFromRouting({ id: "claude-cli", installed: true, auth: "signed-in", ready: true, version: "2.1.310 (Claude Code)", model: "sonnet" })).toMatchObject({
      id: "claude-code",
      status: "ready",
      version: "2.1.310",
      defaultModel: "sonnet",
    });
    expect(backendInfoFromRouting({ id: "codex-cli", installed: true, auth: "signed-out" })?.status).toBe("login");
    expect(backendInfoFromRouting({ id: "gemini-cli", installed: false })?.status).toBe("unavailable");
    expect(backendInfoFromRouting({ id: "cursor-cli", installed: true })).toBeNull();
    expect(backendInfoFromRouting({ id: "grok-cli", installed: true })).toMatchObject({ id: "grok", label: "Grok Build", status: "ready" });
  });

  it("reads the CLI badge off gateway messages", () => {
    expect(messageRoute({ role: "assistant", cli: { backend: "codex" } })).toBe("codex");
    expect(messageRoute({ role: "user" })).toBe("agent");
    expect(messageRoute(null)).toBe("agent");
  });

  it("puts a divider wherever the target changes", () => {
    expect(routeDividers(["agent", "agent", "codex", "codex", "claude-code", "agent"])).toEqual([
      { index: 2, to: "codex" },
      { index: 4, to: "claude-code" },
      { index: 5, to: "agent" },
    ]);
    expect(routeDividers(["codex"])).toEqual([{ index: 0, to: "codex" }]);
  });

  it("recognizes the /claude bridge notices", () => {
    expect(claudeBridgeNotice("🟣 Claude mode ON — messages now go to a new Claude Code session.")).toBe("on");
    expect(claudeBridgeNotice("⚪ Claude mode OFF — back to the gateway agent.")).toBe("off");
    expect(claudeBridgeNotice("Claude mode is already off.")).toBe("off");
    expect(claudeBridgeNotice("I think Claude mode ON is neat")).toBeNull();
  });

  it("folderName", () => {
    expect(folderName("/home/u/Desktop/Development/InfiniBot-fresh/")).toBe("InfiniBot-fresh");
    expect(folderName(undefined)).toBe("Home");
  });
});
