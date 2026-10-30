import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../types";
import {
  LAST_SESSION_STORAGE_KEY,
  agentIdFromKey,
  fetchChatSessionsPage,
  fetchHistoryPage,
  forgetRememberedSession,
  isChatSessionKey,
  isSessionListEvent,
  loadRememberedSession,
  matchesSessionSearch,
  mergeSessionRows,
  newChatSessionKey,
  rememberSession,
  sessionPreview,
  sessionTitle,
  webchatPathForKey,
} from "./chat-sessions";

const row = (key: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  kind: "direct",
  updatedAt: 1,
  ...extra,
});

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

type Client = Parameters<typeof fetchChatSessionsPage>[0];
const asClient = (request: unknown) => ({ request }) as unknown as Client;

const UNSUPPORTED = new Error("invalid sessions.list params: at root: unexpected property \"offset\"");

describe("session keys", () => {
  it("recognises the user's chat threads only", () => {
    expect(isChatSessionKey("agent:main:webchat-abc")).toBe(true);
    expect(isChatSessionKey("agent:cmo:quick-chat")).toBe(true);
    expect(isChatSessionKey("agent:cmo:cmo-chat")).toBe(true);
    expect(isChatSessionKey("agent:main:telegram:dm:1")).toBe(false);
    // Agent group chats list as chats; their hidden member sessions don't.
    expect(isChatSessionKey("agent:main:groupchat-abc123")).toBe(true);
    expect(isChatSessionKey("agent:coder:gcmember-abc123")).toBe(false);
    expect(isChatSessionKey("agent:main:quick-chat-x")).toBe(false);
    expect(isChatSessionKey("main")).toBe(false);
  });

  it("mints unique webchat-shaped keys for an agent", () => {
    const a = newChatSessionKey("ops", 1_700_000_000_000, 0.1);
    const b = newChatSessionKey("ops", 1_700_000_000_000, 0.9);
    expect(a).toMatch(/^agent:ops:webchat-[0-9a-z]+$/);
    expect(a).not.toBe(b);
    expect(isChatSessionKey(a)).toBe(true);
    expect(agentIdFromKey(a)).toBe("ops");
  });

  it("deep-links to the same session in webchat under a base path", () => {
    expect(webchatPathForKey("agent:main:webchat-1")).toBe("/webchat/agent%3Amain%3Awebchat-1");
    expect(webchatPathForKey("agent:main:webchat-1", "/app/")).toBe("/app/webchat/agent%3Amain%3Awebchat-1");
    expect(webchatPathForKey(null, "/app")).toBe("/app/webchat");
  });
});

describe("titles + previews", () => {
  it("prefers the label, then the cleaned first message", () => {
    expect(sessionTitle(row("k", { label: "Roadmap", derivedTitle: "x" }))).toBe("Roadmap");
    expect(sessionTitle(row("k", { derivedTitle: "Hello there [message_id: 12]" }))).toBe("Hello there");
    expect(sessionTitle(row("k"))).toBe("New chat");
  });

  it("previews collapse whitespace and truncate", () => {
    expect(sessionPreview(row("k", { lastMessagePreview: "a\n\n b" }))).toBe("a b");
    expect(sessionPreview(row("k", { lastMessagePreview: "x".repeat(300) }), 20)).toHaveLength(20);
  });

  it("client-side search looks at title, preview and key", () => {
    const r = row("agent:main:webchat-1", { derivedTitle: "Quarterly plan", lastMessagePreview: "ship it" });
    expect(matchesSessionSearch(r, "quarter")).toBe(true);
    expect(matchesSessionSearch(r, "SHIP")).toBe(true);
    expect(matchesSessionSearch(r, "nope")).toBe(false);
  });

  it("merges pages by key, newest first", () => {
    const merged = mergeSessionRows([row("a", { updatedAt: 1 }), row("b", { updatedAt: 3 })], [row("a", { updatedAt: 5 })]);
    expect(merged.map((r) => r.key)).toEqual(["a", "b"]);
  });
});

describe("fetchChatSessionsPage", () => {
  it("asks the gateway for a filtered, paged list", async () => {
    const request = vi.fn().mockResolvedValue({
      sessions: [row("agent:main:webchat-1"), row("agent:main:telegram:dm:1")],
      hasMore: true,
      total: 40,
    });
    const page = await fetchChatSessionsPage({ request }, { agentId: "main", search: "plan", offset: 30, limit: 30 });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      sessionPrefixes: ["webchat-", "groupchat-", "quick-chat", "cmo-chat"],
      agentId: "main",
      search: "plan",
      offset: 30,
      limit: 30,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    expect(page.sessions.map((r) => r.key)).toEqual(["agent:main:webchat-1"]);
    expect(page).toMatchObject({ hasMore: true, total: 40 });
  });

  it("falls back to client-side filter/search/paging on an older gateway", async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(`agent:main:webchat-${i}`, { derivedTitle: i === 3 ? "Budget" : `c${i}` })),
      row("agent:main:discord:1"),
    ];
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      if ("offset" in params) throw UNSUPPORTED;
      return { sessions: rows };
    });
    const client = asClient(request);
    const p1 = await fetchChatSessionsPage(client, { limit: 2 });
    expect(p1.sessions.map((r) => r.key)).toEqual(["agent:main:webchat-0", "agent:main:webchat-1"]);
    expect(p1).toMatchObject({ hasMore: true, total: 5 });
    const p3 = await fetchChatSessionsPage(client, { offset: 4, limit: 2 });
    expect(p3.sessions.map((r) => r.key)).toEqual(["agent:main:webchat-4"]);
    expect(p3.hasMore).toBe(false);
    const hit = await fetchChatSessionsPage(client, { search: "budget" });
    expect(hit.sessions.map((r) => r.key)).toEqual(["agent:main:webchat-3"]);
    // New params are only tried once per client.
    expect(request.mock.calls.filter(([, p]) => "offset" in (p as object))).toHaveLength(1);
  });

  it("surfaces real errors", async () => {
    const request = vi.fn().mockRejectedValue(new Error("gateway offline"));
    await expect(fetchChatSessionsPage({ request })).rejects.toThrow("gateway offline");
  });
});

describe("fetchHistoryPage", () => {
  it("pages with the beforeIndex cursor", async () => {
    const request = vi.fn().mockResolvedValue({ messages: [{ role: "user" }], startIndex: 120, hasMore: true });
    const page = await fetchHistoryPage({ request }, "agent:main:webchat-1", { beforeIndex: 180, limit: 60 });
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:main:webchat-1",
      limit: 60,
      beforeIndex: 180,
    });
    expect(page).toMatchObject({ startIndex: 120, hasMore: true });
  });

  it("loads the whole transcript from a gateway without cursors", async () => {
    const full = Array.from({ length: 300 }, () => ({ role: "assistant" }));
    const request = vi.fn(async (_m: string, p: { limit: number }) => ({ messages: full.slice(-p.limit) }));
    const page = await fetchHistoryPage(asClient(request), "k", { limit: 60 });
    expect(page.messages).toHaveLength(300);
    expect(page).toMatchObject({ startIndex: 0, hasMore: false });
    expect(request).toHaveBeenLastCalledWith("chat.history", { sessionKey: "k", limit: 10_000 });
  });

  it("a short legacy transcript needs no second request", async () => {
    const request = vi.fn().mockResolvedValue({ messages: [{ role: "user" }] });
    const page = await fetchHistoryPage({ request }, "k", { limit: 60 });
    expect(page.messages).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("live list signals", () => {
  const knows = (k: string) => k === "agent:main:webchat-known";
  it("refreshes on sessions.changed, new chat keys and finished turns", () => {
    expect(isSessionListEvent({ event: "sessions.changed", payload: {} }, knows)).toBe(true);
    expect(
      isSessionListEvent({ event: "chat", payload: { sessionKey: "agent:main:webchat-new", state: "delta" } }, knows),
    ).toBe(true);
    expect(
      isSessionListEvent({ event: "chat", payload: { sessionKey: "agent:main:webchat-known", state: "delta" } }, knows),
    ).toBe(false);
    expect(
      isSessionListEvent({ event: "chat", payload: { sessionKey: "agent:main:webchat-known", state: "final" } }, knows),
    ).toBe(true);
    expect(isSessionListEvent({ event: "chat", payload: { sessionKey: "agent:main:telegram:1" } }, knows)).toBe(false);
    expect(isSessionListEvent({ event: "tick" }, knows)).toBe(false);
  });
});

describe("remembered session per agent", () => {
  it("remembers, reads back per agent and forgets deleted sessions", () => {
    const s = memStorage();
    rememberSession("agent:main:webchat-a", s);
    rememberSession("agent:ops:webchat-b", s);
    expect(loadRememberedSession("main", s)).toBe("agent:main:webchat-a");
    expect(loadRememberedSession("ops", s)).toBe("agent:ops:webchat-b");
    expect(loadRememberedSession("cmo", s)).toBeNull();
    forgetRememberedSession("agent:main:webchat-a", s);
    expect(loadRememberedSession("main", s)).toBeNull();
    expect(loadRememberedSession("ops", s)).toBe("agent:ops:webchat-b");
  });

  it("ignores corrupt or mismatched entries", () => {
    const s = memStorage();
    s.setItem(LAST_SESSION_STORAGE_KEY, "{not json");
    expect(loadRememberedSession("main", s)).toBeNull();
    s.setItem(LAST_SESSION_STORAGE_KEY, JSON.stringify({ main: "agent:ops:webchat-x" }));
    expect(loadRememberedSession("main", s)).toBeNull();
  });
});
