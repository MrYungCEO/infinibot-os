import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KG_BRIDGE_SOURCE,
  KG_EMBED_CSS,
  KG_HOST_SOURCE,
  hasNativeHost,
  isKgEmbed,
  listenHostCommands,
  parseHostCommand,
  parseKgDeepLink,
  postNative,
  resetKgEmbedCache,
  searchWantsEmbed,
  searchWantsHost,
} from "./knowledge-graph-embed";

const ORIGIN = "http://gw.local:18789";

/** A minimal window/location/document for the node test environment. */
function fakeWindow(search: string, opts: { rn?: boolean; parentOrigin?: string | null } = {}) {
  const sent: Array<{ data: string; target?: string }> = [];
  const listeners = new Set<(e: MessageEvent) => void>();
  const win: Record<string, unknown> = {
    addEventListener: (t: string, fn: (e: MessageEvent) => void) => t === "message" && listeners.add(fn),
    removeEventListener: (t: string, fn: (e: MessageEvent) => void) => t === "message" && listeners.delete(fn),
  };
  win.parent = win;
  if (opts.parentOrigin !== undefined && opts.parentOrigin !== null) {
    const po = opts.parentOrigin;
    win.parent = {
      get location() {
        if (po !== ORIGIN) throw new Error("SecurityError: cross-origin");
        return { origin: po };
      },
      postMessage: (data: string, target: string) => sent.push({ data, target }),
    };
  }
  if (opts.rn) win.ReactNativeWebView = { postMessage: (data: string) => sent.push({ data }) };
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", { search, origin: ORIGIN });
  vi.stubGlobal("document", { documentElement: { getAttribute: () => null } });
  vi.stubGlobal("ReactNativeWebView", win.ReactNativeWebView);
  resetKgEmbedCache();
  const dispatch = (e: Partial<MessageEvent>) => {
    for (const fn of listeners) fn(e as MessageEvent);
  };
  return { win, sent, listeners, dispatch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetKgEmbedCache();
});

describe("embed URL params", () => {
  it("embed=1|true|mobile turns the chrome off; only embed=mobile asks for the bridge", () => {
    expect(searchWantsEmbed("?embed=1")).toBe(true);
    expect(searchWantsEmbed("?embed=true")).toBe(true);
    expect(searchWantsEmbed("?embed=MOBILE")).toBe(true);
    expect(searchWantsEmbed("?embed=0")).toBe(false);
    expect(searchWantsEmbed("")).toBe(false);
    expect(searchWantsHost("?embed=mobile")).toBe(true);
    expect(searchWantsHost("?embed=1")).toBe(false);
  });

  it("parses the deep-link params", () => {
    expect(parseKgDeepLink("?embed=mobile&focus=project%3Aabc&family=1&layer=research&group=brain")).toEqual({
      focus: "project:abc",
      family: true,
      layer: "research",
      group: "brain",
    });
    expect(parseKgDeepLink("?focus=%20%20")).toEqual({ focus: null, family: false, layer: null, group: null });
  });

  it("CSS hides the shell chrome and locks the page", () => {
    expect(KG_EMBED_CSS).toContain(".topbar");
    expect(KG_EMBED_CSS).toContain(".host-subtabs");
    expect(KG_EMBED_CSS).toContain("overflow:hidden");
  });
});

describe("native bridge (React Native WebView)", () => {
  it("posts JSON tagged with the bridge source when opened as the app graph", () => {
    const { sent } = fakeWindow("?embed=mobile", { rn: true });
    expect(isKgEmbed()).toBe(true);
    expect(hasNativeHost()).toBe(true);
    expect(postNative({ type: "ready", nodes: 3, mode: "3d" })).toBe(true);
    expect(JSON.parse(sent[0].data)).toEqual({ source: KG_BRIDGE_SOURCE, type: "ready", nodes: 3, mode: "3d" });
  });

  it("a plain RN WebView (Grid panel, embed=1) gets no bridge — links keep working in-page", () => {
    const { sent } = fakeWindow("?embed=1", { rn: true });
    expect(isKgEmbed()).toBe(true);
    expect(hasNativeHost()).toBe(false);
    expect(postNative({ type: "back" })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("no host at top level in a browser", () => {
    fakeWindow("?embed=mobile");
    expect(hasNativeHost()).toBe(false);
    expect(postNative({ type: "back" })).toBe(false);
  });
});

describe("web-export host (same-origin iframe)", () => {
  it("posts to a same-origin parent with an exact target origin", () => {
    const { sent } = fakeWindow("?embed=mobile", { parentOrigin: ORIGIN });
    expect(hasNativeHost()).toBe(true);
    postNative({ type: "open", node: { id: "project:a", kind: "project", label: "A" }, path: "/projects/a" });
    expect(sent[0].target).toBe(ORIGIN);
    expect(JSON.parse(sent[0].data)).toMatchObject({ source: KG_BRIDGE_SOURCE, type: "open", node: { id: "project:a" } });
  });

  it("never talks to a cross-origin parent", () => {
    const { sent } = fakeWindow("?embed=mobile", { parentOrigin: "https://evil.example" });
    expect(hasNativeHost()).toBe(false);
    expect(postNative({ type: "back" })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("accepts host commands only from the same-origin parent", () => {
    const { win, dispatch } = fakeWindow("?embed=mobile", { parentOrigin: ORIGIN });
    const got: unknown[] = [];
    const off = listenHostCommands((c) => got.push(c));
    const data = JSON.stringify({ source: KG_HOST_SOURCE, cmd: "focus", id: "note:1", family: true });
    dispatch({ origin: "https://evil.example", source: win.parent as MessageEventSource, data });
    dispatch({ origin: ORIGIN, source: null, data });
    dispatch({ origin: ORIGIN, source: win.parent as MessageEventSource, data });
    expect(got).toEqual([{ cmd: "focus", id: "note:1", family: true }]);
    off();
    dispatch({ origin: ORIGIN, source: win.parent as MessageEventSource, data });
    expect(got).toHaveLength(1);
  });
});

describe("parseHostCommand", () => {
  it("validates commands", () => {
    expect(parseHostCommand({ source: KG_HOST_SOURCE, cmd: "fit" })).toEqual({ cmd: "fit" });
    expect(parseHostCommand({ source: KG_HOST_SOURCE, cmd: "back" })).toEqual({ cmd: "back" });
    expect(parseHostCommand({ source: KG_HOST_SOURCE, cmd: "focus", id: "  " })).toBeNull();
    expect(parseHostCommand({ source: "other", cmd: "fit" })).toBeNull();
    expect(parseHostCommand("not json")).toBeNull();
    expect(parseHostCommand({ source: KG_HOST_SOURCE, cmd: "eval", code: "x" })).toBeNull();
    expect(parseHostCommand({ source: KG_HOST_SOURCE, cmd: "apply", layer: "research", group: "type" })).toEqual({
      cmd: "apply",
      link: { focus: null, family: false, layer: "research", group: "type" },
    });
  });
});
