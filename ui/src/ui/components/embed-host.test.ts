import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBED_CHROME_CSS,
  cleanStr,
  createEmbedBridge,
  decodeHostPayload,
  hasNativeHost,
  isEmbedRequest,
  postToHost,
  resetEmbedHostCache,
  surfaceLockCss,
} from "./embed-host";

const ORIGIN = "http://gw.local:18789";

function stub(search: string, opts: { rn?: boolean; parentOrigin?: string } = {}) {
  const sent: Array<{ data: string; target?: string }> = [];
  const win: Record<string, unknown> = { addEventListener: () => {}, removeEventListener: () => {} };
  win.parent = win;
  if (opts.parentOrigin) {
    const po = opts.parentOrigin;
    win.parent = {
      get location() {
        if (po !== ORIGIN) throw new Error("SecurityError");
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
  resetEmbedHostCache();
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetEmbedHostCache();
});

describe("embed-host", () => {
  it("detects embed requests once (the router may rewrite the URL later)", () => {
    stub("?embed=mobile");
    expect(isEmbedRequest()).toBe(true);
    vi.stubGlobal("location", { search: "", origin: ORIGIN });
    expect(isEmbedRequest()).toBe(true);
  });

  it("tags payloads with the surface source; RN host only for embed=mobile", () => {
    let sent = stub("?embed=mobile", { rn: true });
    expect(hasNativeHost()).toBe(true);
    expect(postToHost("infinibot-x", { type: "ready" })).toBe(true);
    expect(JSON.parse(sent[0].data)).toEqual({ source: "infinibot-x", type: "ready" });
    sent = stub("?embed=1", { rn: true });
    expect(postToHost("infinibot-x", { type: "ready" })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("same-origin parent frames only, with an exact target origin", () => {
    let sent = stub("?embed=mobile", { parentOrigin: ORIGIN });
    expect(postToHost("s", { type: "back" })).toBe(true);
    expect(sent[0].target).toBe(ORIGIN);
    sent = stub("?embed=mobile", { parentOrigin: "https://evil.example" });
    expect(postToHost("s", { type: "back" })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("bridges validate their own host commands", () => {
    const b = createEmbedBridge<{ type: "x" }, { cmd: "go"; to: string }>({
      source: "a",
      hostSource: "a-host",
      parseCommand: (o) => (o.cmd === "go" && cleanStr(o.to) ? { cmd: "go", to: cleanStr(o.to)! } : null),
    });
    expect(b.parseHostCommand(JSON.stringify({ source: "a-host", cmd: "go", to: " home " }))).toEqual({ cmd: "go", to: "home" });
    expect(b.parseHostCommand({ source: "b-host", cmd: "go", to: "x" })).toBeNull();
    expect(b.parseHostCommand("{bad")).toBeNull();
    expect(decodeHostPayload(null, "a-host")).toBeNull();
  });

  it("chrome CSS hides the shell; the surface lock hides desktop popups", () => {
    expect(EMBED_CHROME_CSS).toContain(".topbar");
    expect(EMBED_CHROME_CSS).toContain(".threads-sidebar");
    const lock = surfaceLockCss("data-mesh-embed", "#000");
    expect(lock).toContain('html[data-mesh-embed="1"]');
    expect(lock).toContain("proactive-overlay-host");
    expect(lock).toContain("overflow:hidden");
  });
});
