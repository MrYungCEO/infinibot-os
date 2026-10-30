import { describe, expect, it } from "vitest";

import {
  AGENT_CHAT_EVENT,
  CMO_CHAT_EVENT,
  LAST_AGENT_STORAGE_KEY,
  ThreadStore,
  emptyThread,
  splitHistoryWindow,
  takeOlderChunk,
  threadHasOlder,
  agentIdFromSessionKey,
  filterAgents,
  historyToItems,
  loadLastAgent,
  insertPanelsBeforeReply,
  finishToolItem,
  hasRunningTool,
  insertPanelsAfterTool,
  settleRunningTools,
  startToolItem,
  panelItemsFromToolResult,
  panelsForLastTurn,
  withPanels,
  resolveChatEvent,
  resolveInitialAgent,
  saveLastAgent,
  sessionKeyFor,
  suggestionsFor,
  type ChatItem,
} from "./agent-chat-state";

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

describe("agent chat session keys", () => {
  it("maps each agent to its own quick-chat session", () => {
    expect(sessionKeyFor("main")).toBe("agent:main:quick-chat");
    expect(sessionKeyFor("cmo")).toBe("agent:cmo:quick-chat");
    expect(sessionKeyFor("  ")).toBe("agent:main:quick-chat");
    expect(sessionKeyFor("cmo", "cmo-chat")).toBe("agent:cmo:cmo-chat");
  });

  it("round-trips session keys back to agent ids and ignores foreign sessions", () => {
    expect(agentIdFromSessionKey(sessionKeyFor("research"))).toBe("research");
    expect(agentIdFromSessionKey("agent:main:webchat-123")).toBeNull();
    expect(agentIdFromSessionKey("agent:cmo:cmo-chat")).toBeNull();
    expect(agentIdFromSessionKey("agent:cmo:cmo-chat", "cmo-chat")).toBe("cmo");
    expect(agentIdFromSessionKey(undefined)).toBeNull();
  });
});

describe("per-agent history", () => {
  it("keeps threads separate and restores them when switching back", () => {
    const store = new ThreadStore();
    store.append("main", { role: "user", text: "hi main" });
    store.append("cmo", { role: "user", text: "hi cmo" });
    store.append("main", { role: "assistant", text: "hello" });
    expect(store.get("main").items.map((i) => ("text" in i ? i.text : ""))).toEqual(["hi main", "hello"]);
    expect(store.get("cmo").items).toHaveLength(1);
    expect(store.get("never-opened").items).toEqual([]);
    expect(store.has("never-opened")).toBe(false);
  });

  it("hydrates server history ahead of anything typed meanwhile", () => {
    const store = new ThreadStore();
    store.append("main", { role: "user", text: "new" });
    const history = historyToItems(
      [
        { role: "user", content: "old q" } as { role: string },
        { role: "toolResult", content: "x" } as { role: string },
        { role: "assistant", content: "old a" } as { role: string },
      ],
      (m) => (m as { content?: string }).content ?? null,
    );
    store.hydrate("main", history);
    const t = store.get("main");
    expect(t.hydrated).toBe(true);
    expect(t.items.map((i) => ("text" in i ? i.text : ""))).toEqual(["old q", "old a", "new"]);
  });
});

describe("open events", () => {
  it("legacy infinibot:cmo-chat always opens on the CMO", () => {
    expect(resolveChatEvent(CMO_CHAT_EVENT, undefined)).toEqual({ action: "toggle", agentId: "cmo" });
    expect(resolveChatEvent(CMO_CHAT_EVENT, { action: "open" })).toEqual({ action: "open", agentId: "cmo" });
    expect(resolveChatEvent(CMO_CHAT_EVENT, { action: "close" })).toEqual({ action: "close", agentId: "cmo" });
  });

  it("infinibot:agent-chat opens on detail.agentId, toggles without one", () => {
    expect(resolveChatEvent(AGENT_CHAT_EVENT, { agentId: "research" })).toEqual({
      action: "open",
      agentId: "research",
    });
    expect(resolveChatEvent(AGENT_CHAT_EVENT, null)).toEqual({ action: "toggle", agentId: undefined });
    expect(resolveChatEvent("something-else", {})).toBeNull();
  });

  it("opens on an exact session key (chat follows navigation), agent from the key", () => {
    expect(
      resolveChatEvent(AGENT_CHAT_EVENT, { action: "open", sessionKey: "agent:research:webchat-abc", follow: true }),
    ).toEqual({ action: "open", agentId: "research", sessionKey: "agent:research:webchat-abc", follow: true });
    expect(resolveChatEvent(AGENT_CHAT_EVENT, { sessionKey: "agent:main:secure-x1" })).toEqual({
      action: "open",
      agentId: "main",
      sessionKey: "agent:main:secure-x1",
    });
    // Not a session key → ignored, falls back to the agent id behaviour.
    expect(resolveChatEvent(AGENT_CHAT_EVENT, { sessionKey: "nope", agentId: "cmo" })).toEqual({
      action: "open",
      agentId: "cmo",
    });
  });
});

describe("last-used agent", () => {
  it("persists and restores the last agent", () => {
    const s = memStorage();
    expect(loadLastAgent(s)).toBeNull();
    saveLastAgent("research", s);
    expect(s.map.get(LAST_AGENT_STORAGE_KEY)).toBe("research");
    expect(loadLastAgent(s)).toBe("research");
  });

  it("survives a throwing storage", () => {
    const bad = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveLastAgent("x", bad)).not.toThrow();
    expect(loadLastAgent(bad)).toBeNull();
  });

  it("resolves requested → last used → main → gateway default", () => {
    const agents = [{ id: "main" }, { id: "cmo" }, { id: "ops" }];
    expect(resolveInitialAgent({ requested: "ops", lastUsed: "cmo", agents })).toBe("ops");
    expect(resolveInitialAgent({ lastUsed: "cmo", agents })).toBe("cmo");
    expect(resolveInitialAgent({ lastUsed: "deleted-agent", agents })).toBe("main");
    expect(resolveInitialAgent({ agents: [{ id: "ops" }], defaultId: "ops" })).toBe("ops");
    expect(resolveInitialAgent({})).toBe("main");
  });
});

describe("switcher helpers", () => {
  it("filters by id, name, identity name and model", () => {
    const agents = [
      { id: "main", identity: { name: "Nova" }, model: "anthropic/claude" },
      { id: "cmo", name: "CMO" },
    ];
    expect(filterAgents(agents, "nova").map((a) => a.id)).toEqual(["main"]);
    expect(filterAgents(agents, "claude").map((a) => a.id)).toEqual(["main"]);
    expect(filterAgents(agents, "cm").map((a) => a.id)).toEqual(["cmo"]);
    expect(filterAgents(agents, " ")).toHaveLength(2);
  });

  it("gives the CMO its marketing suggestions and others generic ones", () => {
    expect(suggestionsFor("cmo")[0]).toMatch(/reels/);
    expect(suggestionsFor("main")).not.toEqual(suggestionsFor("cmo"));
    expect(suggestionsFor("x", { id: "x", suggestions: ["custom"] } as never)).toEqual(["custom"]);
  });
});

describe("chat panels in the modal thread", () => {
  const ref = {
    v: 1,
    panelId: "panel_business_1",
    kind: "business",
    query: {},
    title: "Business snapshot",
    display: "inline",
    summary: "3 clients",
    count: 3,
    empty: false,
    error: null,
    link: { tab: "clients", label: "Open clients" },
    refreshMs: 0,
    ts: 1,
  };
  const text = JSON.stringify({ chatPanel: ref, text: "Business snapshot: 3 clients" });

  it("turns a show_panel toolResult in history into a panel item, in order", () => {
    const items = historyToItems(
      [
        { role: "user", content: "show me my business snapshot" } as { role: string },
        { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text }] } as { role: string },
        { role: "assistant", content: "Here it is." } as { role: string },
      ],
      (m) => (typeof (m as { content?: unknown }).content === "string" ? ((m as { content: string }).content) : null),
    );
    expect(items.map((i) => i.role)).toEqual(["user", "panel", "assistant"]);
    expect(items[1]).toMatchObject({ role: "panel", ref: { panelId: "panel_business_1", kind: "business" } });
  });

  it("detects a panel in a live tool result (content text or details)", () => {
    expect(panelItemsFromToolResult({ content: [{ type: "text", text }] })).toHaveLength(1);
    expect(panelItemsFromToolResult({ content: [], details: { chatPanel: ref } })).toHaveLength(1);
    expect(panelItemsFromToolResult({ content: [{ type: "text", text: "ok" }] })).toEqual([]);
    expect(panelItemsFromToolResult(undefined)).toEqual([]);
  });

  it("takes only the latest turn's panels and slots them above the reply", () => {
    const tr = (id: string) => ({
      role: "toolResult",
      content: [{ type: "text", text: JSON.stringify({ chatPanel: { ...ref, panelId: id } }) }],
    });
    const msgs = [{ role: "user" }, tr("old"), { role: "assistant" }, { role: "user" }, tr("new"), { role: "assistant" }];
    const panels = panelsForLastTurn(msgs);
    expect(panels.map((p) => p.role === "panel" && p.ref.panelId)).toEqual(["new"]);
    const items = [
      { role: "user", text: "show me" },
      { role: "assistant", text: "Here it is." },
    ] as const;
    const next = insertPanelsBeforeReply([...items], panels);
    expect(next.map((i) => i.role)).toEqual(["user", "panel", "assistant"]);
    expect(insertPanelsBeforeReply(next, panels)).toBe(next);
  });

  it("does not duplicate a panel already in the thread", () => {
    const panels = panelItemsFromToolResult({ content: [{ type: "text", text }] });
    const once = withPanels([], panels);
    expect(withPanels(once, panels)).toBe(once);
  });
});

describe("history scroll-back window", () => {
  const items = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ role: "user" as const, text: `m${from + i}` }));

  it("shows the newest window and buffers the rest", () => {
    const { visible, older } = splitHistoryWindow(items(100), 80);
    expect(visible).toHaveLength(80);
    expect(visible[0]).toEqual({ role: "user", text: "m20" });
    expect(older).toHaveLength(20);
    expect(splitHistoryWindow(items(5), 80)).toEqual({ visible: items(5), older: [] });
  });

  it("reveals the newest older chunk first", () => {
    const { chunk, rest } = takeOlderChunk(items(50), 40);
    expect(chunk[0]).toEqual({ role: "user", text: "m10" });
    expect(chunk).toHaveLength(40);
    expect(rest).toHaveLength(10);
  });

  it("prepends older pages above the thread and tracks whether more exists", () => {
    const store = new ThreadStore();
    const key = "agent:main:webchat-1";
    store.hydrate(key, items(2, 10));
    store.patch(key, { cursor: 10, hasMoreRemote: true });
    expect(threadHasOlder(store.get(key))).toBe(true);
    store.prepend(key, items(2, 8));
    expect(store.get(key).items.map((i) => ("text" in i ? i.text : ""))).toEqual(["m8", "m9", "m10", "m11"]);
    store.patch(key, { hasMoreRemote: false });
    expect(threadHasOlder(store.get(key))).toBe(false);
    store.patch(key, { olderBuffer: items(1) });
    expect(threadHasOlder(store.get(key))).toBe(true);
  });

  it("keeps threads apart per session and can drop one", () => {
    const store = new ThreadStore();
    store.append("agent:main:webchat-a", { role: "user", text: "a" });
    store.append("agent:main:webchat-b", { role: "user", text: "b" });
    expect(store.get("agent:main:webchat-a").items).toHaveLength(1);
    store.drop("agent:main:webchat-a");
    expect(store.has("agent:main:webchat-a")).toBe(false);
    expect(store.get("agent:main:webchat-a")).toEqual(emptyThread());
    expect(store.has("agent:main:webchat-b")).toBe(true);
  });
});

describe("in-flight tool cards", () => {
  const panel = (id: string): ChatItem => ({ role: "panel", ref: { panelId: id, kind: "flypic.generation", query: {} } as never });

  it("starts once per call id and settles by id", () => {
    let items: ChatItem[] = [{ role: "user", text: "make an image" }];
    items = startToolItem(items, { name: "flypic_generate_image", callId: "tc1", now: 100 });
    expect(startToolItem(items, { name: "flypic_generate_image", callId: "tc1", now: 200 })).toBe(items);
    expect(hasRunningTool(items)).toBe(true);
    items = finishToolItem(items, { name: "flypic_generate_image", callId: "tc1", now: 900 });
    expect(items[1]).toMatchObject({ role: "tool", status: "done", startedAt: 100, endedAt: 900 });
    expect(hasRunningTool(items)).toBe(false);
  });

  it("settles by name when the id is missing, marks errors, ignores unknown calls", () => {
    let items = startToolItem([], { name: "web_search", now: 1 });
    items = startToolItem(items, { name: "web_search", now: 2 });
    items = finishToolItem(items, { name: "web_search", isError: true, now: 3 });
    expect(items.map((it) => (it.role === "tool" ? it.status : null))).toEqual(["running", "error"]);
    expect(finishToolItem(items, { name: "other", callId: "nope", now: 4 })).toBe(items);
  });

  it("settles everything still running when the turn ends", () => {
    const items = startToolItem(startToolItem([], { name: "a", callId: "1", now: 1 }), { name: "b", callId: "2", now: 1 });
    const settled = settleRunningTools(items, 50);
    expect(hasRunningTool(settled)).toBe(false);
    expect(settleRunningTools(settled, 60)).toBe(settled);
  });

  it("puts a tool's result panel right after its card", () => {
    let items: ChatItem[] = startToolItem([], { name: "flypic_generate_image", callId: "tc1", now: 1 });
    items = startToolItem(items, { name: "kanban", callId: "tc2", now: 2 });
    const next = insertPanelsAfterTool(items, "tc1", [panel("p1")]);
    expect(next.map((it) => it.role)).toEqual(["tool", "panel", "tool"]);
    expect(insertPanelsAfterTool(next, "tc1", [panel("p1")])).toBe(next);
    expect(insertPanelsAfterTool(items, undefined, [panel("p2")]).at(-1)).toMatchObject({ role: "panel" });
  });
});
