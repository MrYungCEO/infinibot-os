import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_FOLLOW_PILL_EVENT,
  CHAT_FOLLOW_PREFS_KEY,
  DEFAULT_CHAT_FOLLOW_PREFS,
  TOOL_SIGNAL_TTL_MS,
  __chatFollowSignals,
  __resetChatFollowForTests,
  beginAgentNav,
  chatKeyForSession,
  endAgentNav,
  inAppRouteForHref,
  isAgentNavActive,
  loadChatFollowPrefs,
  noteGatewayEvent,
  onAppTabChanged,
  parseChatFollowPrefs,
  planFollow,
  resolveFollowSession,
  saveChatFollowPrefs,
  sessionKeyFromChatPath,
  withAgentNav,
} from "./chat-follow-nav";

function memStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("prefs", () => {
  it("defaults: agent-driven ON, manual OFF", () => {
    expect(DEFAULT_CHAT_FOLLOW_PREFS).toEqual({ agent: true, manual: false });
    expect(parseChatFollowPrefs(null)).toEqual({ agent: true, manual: false });
    expect(parseChatFollowPrefs("{bad")).toEqual({ agent: true, manual: false });
    expect(parseChatFollowPrefs('{"manual":true}')).toEqual({ agent: true, manual: true });
  });

  it("persists a patch", () => {
    const s = memStorage();
    expect(saveChatFollowPrefs({ agent: false }, s)).toEqual({ agent: false, manual: false });
    expect(JSON.parse(s.map.get(CHAT_FOLLOW_PREFS_KEY)!)).toEqual({ agent: false, manual: false });
    expect(loadChatFollowPrefs(s)).toEqual({ agent: false, manual: false });
  });
});

describe("keys", () => {
  it("maps a group member session to its group's shared key", () => {
    const groups = new Map([["g123abc", "agent:boss:groupchat-g123abc"]]);
    expect(chatKeyForSession("agent:research:gcmember-g123abc", groups)).toBe("agent:boss:groupchat-g123abc");
    expect(chatKeyForSession("agent:research:gcmember-zzz999")).toBe("agent:main:groupchat-zzz999");
    // Secure group members keep the secure lane.
    expect(chatKeyForSession("agent:a:gcmember-sec-k1x2y3")).toBe("agent:main:groupchat-sec-k1x2y3");
    expect(chatKeyForSession("agent:main:webchat-1")).toBe("agent:main:webchat-1");
  });

  it("reads the session from a /webchat/<key> path", () => {
    expect(sessionKeyFromChatPath("/webchat/agent%3Amain%3Awebchat-abc")).toBe("agent:main:webchat-abc");
    expect(sessionKeyFromChatPath("/ui/webchat/agent:main:secure-1")).toBe("agent:main:secure-1");
    expect(sessionKeyFromChatPath("/webchat")).toBeNull();
    expect(sessionKeyFromChatPath("/dashboard")).toBeNull();
    expect(sessionKeyFromChatPath(null)).toBeNull();
  });

  it("only treats same-origin page links / infinibot:// as in-app routes", () => {
    const o = "https://ib.local";
    expect(inAppRouteForHref("/dashboard", o)).toBe("/dashboard");
    expect(inAppRouteForHref("https://ib.local/projects/x?y=1", o)).toBe("/projects/x?y=1");
    expect(inAppRouteForHref("infinibot://projects/x", o)).toBe("infinibot://projects/x");
    expect(inAppRouteForHref("https://example.com/dashboard", o)).toBeNull();
    expect(inAppRouteForHref("/files/a.pdf", o)).toBeNull();
    expect(inAppRouteForHref("/api/x", o)).toBeNull();
    expect(inAppRouteForHref("", o)).toBeNull();
  });
});

describe("resolveFollowSession", () => {
  const now = 1_000_000;
  it("prefers the run that called ui_control", () => {
    expect(
      resolveFollowSession({
        now,
        agentDriven: true,
        sourceKey: "agent:main:webchat-src",
        signals: { tool: { key: "agent:main:webchat-run", at: now - 2000 }, activity: { key: "agent:x:y", at: now } },
      }),
    ).toBe("agent:main:webchat-run");
  });

  it("falls back to the source page, then recent activity; stale signals ignored", () => {
    const stale = { key: "agent:main:webchat-old", at: now - TOOL_SIGNAL_TTL_MS - 1 };
    expect(
      resolveFollowSession({ now, agentDriven: true, sourceKey: "agent:main:webchat-src", signals: { tool: stale } }),
    ).toBe("agent:main:webchat-src");
    expect(
      resolveFollowSession({
        now,
        agentDriven: true,
        signals: { tool: stale, activity: { key: "agent:main:voice-1", at: now - 1000 } },
      }),
    ).toBe("agent:main:voice-1");
    expect(resolveFollowSession({ now, agentDriven: true, signals: { tool: stale } })).toBeNull();
  });

  it("an explicit key (link clicked in a chat) wins", () => {
    expect(
      resolveFollowSession({
        now,
        agentDriven: true,
        explicitKey: "agent:main:groupchat-g1abc",
        signals: { tool: { key: "agent:main:webchat-run", at: now } },
      }),
    ).toBe("agent:main:groupchat-g1abc");
  });
});

describe("planFollow", () => {
  const base = { prefs: DEFAULT_CHAT_FOLLOW_PREFS, isPhone: false, key: "agent:main:webchat-1" };
  it("agent nav opens the sidebar on the same session", () => {
    expect(planFollow({ ...base, prevTab: "webchat", nextTab: "dashboard", agentDriven: true })).toEqual({
      kind: "sidebar",
      key: "agent:main:webchat-1",
    });
  });

  it("phones get the Back-to-chat pill (voice returns to voice)", () => {
    expect(planFollow({ ...base, isPhone: true, prevTab: "webchat", nextTab: "dashboard", agentDriven: true })).toEqual({
      kind: "pill",
      key: "agent:main:webchat-1",
      returnTab: "webchat",
    });
    expect(
      planFollow({ ...base, isPhone: true, prevTab: "voice", nextTab: "projects", agentDriven: true }),
    ).toMatchObject({ kind: "pill", returnTab: "voice" });
  });

  it("manual clicks do nothing unless the manual pref is on and you were chatting", () => {
    expect(planFollow({ ...base, prevTab: "webchat", nextTab: "dashboard", agentDriven: false }).kind).toBe("none");
    const manual = { agent: true, manual: true };
    expect(planFollow({ ...base, prefs: manual, prevTab: "webchat", nextTab: "dashboard", agentDriven: false }).kind).toBe(
      "sidebar",
    );
    expect(planFollow({ ...base, prefs: manual, prevTab: "projects", nextTab: "dashboard", agentDriven: false }).kind).toBe(
      "none",
    );
  });

  it("never opens when going TO the chat page, staying put, pref off, or no session", () => {
    expect(planFollow({ ...base, prevTab: "dashboard", nextTab: "webchat", agentDriven: true }).kind).toBe("none");
    expect(planFollow({ ...base, prevTab: "grid", nextTab: "grid", agentDriven: true }).kind).toBe("none");
    expect(
      planFollow({ ...base, prefs: { agent: false, manual: false }, prevTab: "webchat", nextTab: "x", agentDriven: true }).kind,
    ).toBe("none");
    expect(planFollow({ ...base, key: null, prevTab: "webchat", nextTab: "x", agentDriven: true }).kind).toBe("none");
  });
});

describe("runtime wiring", () => {
  const events: Array<{ type: string; detail: unknown }> = [];
  beforeEach(() => {
    __resetChatFollowForTests();
    events.length = 0;
    const store = memStorage();
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("window", {
      dispatchEvent: (e: { type: string; detail: unknown }) => void events.push({ type: e.type, detail: e.detail }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal(
      "CustomEvent",
      class {
        type: string;
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("agent intent window: active during dispatch + a short grace period", async () => {
    expect(isAgentNavActive()).toBe(false);
    await withAgentNav(() => expect(isAgentNavActive()).toBe(true));
    expect(isAgentNavActive()).toBe(true); // grace
    expect(isAgentNavActive(Date.now() + 5000)).toBe(false);
  });

  it("ui_control tool events mark the driving session; group keys are learned", () => {
    noteGatewayEvent({ event: "chat", payload: { sessionKey: "agent:boss:groupchat-g9abc", state: "delta" } });
    noteGatewayEvent({
      event: "agent",
      payload: { sessionKey: "agent:research:gcmember-g9abc", stream: "tool_status", data: { name: "ui_control", phase: "start" } },
    });
    const s = __chatFollowSignals();
    expect(s.tool?.key).toBe("agent:research:gcmember-g9abc");
    expect(s.groups?.get("g9abc")).toBe("agent:boss:groupchat-g9abc");
  });

  it("agent nav from a group chat opens the group in the sidebar", async () => {
    noteGatewayEvent({ event: "chat", payload: { sessionKey: "agent:boss:groupchat-g9abc", state: "delta" } });
    noteGatewayEvent({
      event: "agent",
      payload: { sessionKey: "agent:research:gcmember-g9abc", stream: "tool", data: { name: "ui_control", phase: "start" } },
    });
    beginAgentNav();
    const plan = onAppTabChanged({ prevTab: "webchat", nextTab: "dashboard", prevPath: "/webchat/agent%3Aboss%3Agroupchat-g9abc" });
    endAgentNav();
    expect(plan).toEqual({ kind: "sidebar", key: "agent:boss:groupchat-g9abc" });
    await Promise.resolve();
    expect(events).toContainEqual({
      type: "infinibot:agent-chat",
      detail: { action: "open", sessionKey: "agent:boss:groupchat-g9abc", follow: true },
    });
  });

  it("a secure session stays secure (the same secure key is opened)", () => {
    beginAgentNav();
    const plan = onAppTabChanged({ prevTab: "webchat", nextTab: "dashboard", prevPath: "/webchat/agent%3Amain%3Asecure-k1" });
    endAgentNav();
    expect(plan).toEqual({ kind: "sidebar", key: "agent:main:secure-k1" });
  });

  it("manual nav (no intent) does not open the sidebar by default", () => {
    const plan = onAppTabChanged({ prevTab: "webchat", nextTab: "dashboard", prevPath: "/webchat/agent%3Amain%3Awebchat-1" });
    expect(plan.kind).toBe("none");
  });

  it("on a phone an agent nav shows the pill", () => {
    vi.stubGlobal("window", {
      dispatchEvent: (e: { type: string; detail: unknown }) => void events.push({ type: e.type, detail: e.detail }),
      matchMedia: () => ({ matches: true }),
    });
    beginAgentNav();
    const plan = onAppTabChanged({ prevTab: "webchat", nextTab: "dashboard", prevPath: "/webchat/agent%3Amain%3Awebchat-1" });
    endAgentNav();
    expect(plan.kind).toBe("pill");
    expect(events).toContainEqual({
      type: CHAT_FOLLOW_PILL_EVENT,
      detail: { key: "agent:main:webchat-1", returnTab: "webchat" },
    });
  });
});
