import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEmbedHostCache } from "./embed-host";
import {
  MESH_BRIDGE_SOURCE,
  MESH_EMBED_CSS,
  MESH_HOST_SOURCE,
  isMeshEmbed,
  listenMeshHostCommands,
  meshHasNativeHost,
  parseMeshDeepLink,
  parseMeshHostCommand,
  postMeshNative,
  resolveMeshFocus,
} from "./mesh-embed";

const ORIGIN = "http://gw.local:18789";

function fakeWindow(search: string, opts: { rn?: boolean; parentOrigin?: string } = {}) {
  const sent: Array<{ data: string; target?: string }> = [];
  const listeners = new Set<(e: MessageEvent) => void>();
  const win: Record<string, unknown> = {
    addEventListener: (t: string, fn: (e: MessageEvent) => void) => t === "message" && listeners.add(fn),
    removeEventListener: (t: string, fn: (e: MessageEvent) => void) => t === "message" && listeners.delete(fn),
  };
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
  const dispatch = (e: Partial<MessageEvent>) => {
    for (const fn of listeners) fn(e as MessageEvent);
  };
  return { win, sent, dispatch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetEmbedHostCache();
});

describe("mesh embed mode", () => {
  it("?embed=mobile turns the mesh chromeless and opens the bridge in the app", () => {
    const { sent } = fakeWindow("?embed=mobile&focus=s1", { rn: true });
    expect(isMeshEmbed()).toBe(true);
    expect(meshHasNativeHost()).toBe(true);
    expect(postMeshNative({ type: "ready", agents: 3, nodes: 1 })).toBe(true);
    expect(JSON.parse(sent[0].data)).toEqual({ source: MESH_BRIDGE_SOURCE, type: "ready", agents: 3, nodes: 1 });
    postMeshNative({ type: "run", runId: "r1", sessionKey: "s1", label: "Build" });
    expect(JSON.parse(sent[1].data)).toMatchObject({ type: "run", runId: "r1" });
  });

  it("a plain browser /mesh is not an embed and has no host", () => {
    fakeWindow("");
    expect(isMeshEmbed()).toBe(false);
    expect(meshHasNativeHost()).toBe(false);
    expect(postMeshNative({ type: "back" })).toBe(false);
  });

  it("the web export's same-origin iframe gets messages; host commands only from that parent", () => {
    const { win, sent, dispatch } = fakeWindow("?embed=mobile", { parentOrigin: ORIGIN });
    postMeshNative({ type: "task", taskId: "t1" });
    expect(sent[0].target).toBe(ORIGIN);
    const got: unknown[] = [];
    const off = listenMeshHostCommands((c) => got.push(c));
    const data = JSON.stringify({ source: MESH_HOST_SOURCE, cmd: "review", runId: "r9" });
    dispatch({ origin: "https://evil.example", source: win.parent as MessageEventSource, data });
    dispatch({ origin: ORIGIN, source: null, data });
    dispatch({ origin: ORIGIN, source: win.parent as MessageEventSource, data });
    // A KG host command is not a mesh command.
    dispatch({ origin: ORIGIN, source: win.parent as MessageEventSource, data: JSON.stringify({ source: "infinibot-kg-host", cmd: "fit" }) });
    expect(got).toEqual([{ cmd: "review", runId: "r9" }]);
    off();
  });

  it("validates host commands", () => {
    expect(parseMeshHostCommand({ source: MESH_HOST_SOURCE, cmd: "focus", id: " s1 " })).toEqual({ cmd: "focus", id: "s1" });
    expect(parseMeshHostCommand({ source: MESH_HOST_SOURCE, cmd: "focus", id: "" })).toBeNull();
    expect(parseMeshHostCommand({ source: MESH_HOST_SOURCE, cmd: "review" })).toBeNull();
    expect(parseMeshHostCommand({ source: MESH_HOST_SOURCE, cmd: "fit" })).toEqual({ cmd: "fit" });
    expect(parseMeshHostCommand({ source: MESH_HOST_SOURCE, cmd: "back" })).toEqual({ cmd: "back" });
    expect(parseMeshHostCommand({ source: MESH_HOST_SOURCE, cmd: "eval", code: "x" })).toBeNull();
    expect(parseMeshHostCommand("nope")).toBeNull();
  });

  it("parses deep links and resolves a focus id (sessionKey first, then runId)", () => {
    expect(parseMeshDeepLink("?embed=mobile&focus=agent%3Amain%3Amain&review=r1")).toEqual({ focus: "agent:main:main", review: "r1" });
    expect(parseMeshDeepLink("?focus=%20")).toEqual({ focus: null, review: null });
    const agents = [
      { sessionKey: "agent:main:subagent:a", runId: "r-a" },
      { sessionKey: "r-b", runId: null },
      { sessionKey: "agent:main:subagent:b", runId: "r-b" },
    ];
    expect(resolveMeshFocus("agent:main:subagent:a", agents)).toBe("agent:main:subagent:a");
    expect(resolveMeshFocus("r-a", agents)).toBe("agent:main:subagent:a");
    expect(resolveMeshFocus("r-b", agents)).toBe("r-b");
    expect(resolveMeshFocus("missing", agents)).toBeNull();
    expect(resolveMeshFocus("", agents)).toBeNull();
  });

  it("CSS hides the shell, locks the page and keeps body sheets above the dock", () => {
    expect(MESH_EMBED_CSS).toContain(".topbar");
    expect(MESH_EMBED_CSS).toContain('html[data-mesh-embed="1"]');
    expect(MESH_EMBED_CSS).toContain("--mesh-host-bottom");
  });
});
