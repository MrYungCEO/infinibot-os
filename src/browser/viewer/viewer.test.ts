/**
 * Live browser viewer: access, input mapping, address bar, session counting
 * and the stream's subscription / follow-the-popup behaviour (fake CDP).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertBrowserSessionAvailable,
  BrowserSessionLimitError,
  countBrowserSessions,
  hostedBrowserSessionCap,
  hostedBrowserUserAgent,
  hostedChromeArgs,
} from "../hosted.js";
import { browserViewerAccess } from "./access.js";
import type { CdpConnection, CdpEvent } from "./cdp-connection.js";
import { normalizeViewerUrl, viewerInputToCdp } from "./input.js";
import { BrowserViewer, VIEWER_FRAME_EVENT, VIEWER_STATE_EVENT } from "./session.js";

const fleet = { FLEET_TENANT_ID: "t-1" } as NodeJS.ProcessEnv;

describe("browserViewerAccess", () => {
  it("hosted tenant Machine: owner and admin only", () => {
    const base = { saasMode: true, env: fleet, hasTenant: true };
    expect(browserViewerAccess({ ...base, role: "owner" }).allowed).toBe(true);
    expect(browserViewerAccess({ ...base, role: "Admin" }).allowed).toBe(true);
    expect(browserViewerAccess({ ...base, role: "member" }).allowed).toBe(false);
    expect(browserViewerAccess({ ...base, role: undefined }).allowed).toBe(false);
    expect(browserViewerAccess({ ...base, role: "owner", hasTenant: false }).allowed).toBe(false);
  });
  it("shared SaaS gateway: nobody, whatever the role or scopes", () => {
    expect(
      browserViewerAccess({
        saasMode: true,
        env: {},
        role: "owner",
        hasTenant: true,
        scopes: ["operator.admin"],
      }).allowed,
    ).toBe(false);
  });
  it("self-hosted: admin scope", () => {
    const base = { saasMode: false, env: {}, hasTenant: false };
    expect(browserViewerAccess({ ...base, scopes: ["operator.admin"] }).allowed).toBe(true);
    expect(browserViewerAccess({ ...base, scopes: ["operator.read"] }).allowed).toBe(false);
  });
});

describe("viewerInputToCdp", () => {
  const vp = { width: 1280, height: 800 };
  const one = (ev: unknown) => {
    const res = viewerInputToCdp(ev, vp);
    if (!res.ok) throw new Error(res.error);
    return res.commands[0];
  };
  it("scales normalized pointer positions to the page and clamps them", () => {
    expect(one({ kind: "mouse", type: "down", x: 0.5, y: 0.25, button: 0 })).toEqual({
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 640,
        y: 200,
        modifiers: 0,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
    });
    expect(one({ kind: "mouse", type: "move", x: 7, y: -3 }).params).toMatchObject({
      type: "mouseMoved",
      x: 1280,
      y: 0,
      button: "none",
      buttons: 0,
    });
    expect(one({ kind: "mouse", type: "up", x: 0, y: 0, button: 2 }).params).toMatchObject({
      type: "mouseReleased",
      button: "right",
      buttons: 0,
    });
  });
  it("wheel deltas are bounded", () => {
    expect(one({ kind: "wheel", x: 0.5, y: 0.5, deltaY: 1e9 }).params).toMatchObject({
      type: "mouseWheel",
      deltaY: 4000,
      deltaX: 0,
    });
  });
  it("printable keys carry text; shortcuts and navigation keys do not", () => {
    expect(one({ kind: "key", type: "down", key: "a", code: "KeyA", keyCode: 65 }).params).toMatchObject(
      { type: "keyDown", text: "a", windowsVirtualKeyCode: 65 },
    );
    expect(one({ kind: "key", type: "down", key: "Enter", code: "Enter", keyCode: 13 }).params.text).toBe("\r");
    const selectAll = one({ kind: "key", type: "down", key: "a", code: "KeyA", keyCode: 65, modifiers: 2 });
    expect(selectAll.params).toMatchObject({ type: "rawKeyDown", modifiers: 2 });
    expect(selectAll.params.text).toBeUndefined();
    expect(one({ kind: "key", type: "down", key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }).params.type).toBe("rawKeyDown");
    expect(one({ kind: "key", type: "up", key: "a", code: "KeyA", keyCode: 65 }).params.type).toBe("keyUp");
  });
  it("text (paste, phone keyboards) is inserted as-is", () => {
    expect(one({ kind: "text", text: "p@ss wörd" })).toEqual({
      method: "Input.insertText",
      params: { text: "p@ss wörd" },
    });
  });
  it("rejects malformed events", () => {
    for (const bad of [null, {}, { kind: "mouse" }, { kind: "key" }, { kind: "text" }, { kind: "x" }]) {
      expect(viewerInputToCdp(bad, vp).ok).toBe(false);
    }
  });
});

describe("normalizeViewerUrl", () => {
  it("accepts http(s) URLs and bare hosts, searches for anything else", () => {
    expect(normalizeViewerUrl("https://github.com/login")).toEqual({ ok: true, url: "https://github.com/login" });
    expect(normalizeViewerUrl("github.com")).toEqual({ ok: true, url: "https://github.com/" });
    expect(normalizeViewerUrl("localhost:3000/x")).toEqual({ ok: true, url: "http://localhost:3000/x" });
    const search = normalizeViewerUrl("how to bake bread");
    expect(search.ok && search.url).toContain("duckduckgo.com/?q=how%20to%20bake%20bread");
  });
  it("refuses local-file and script schemes", () => {
    for (const bad of ["file:///data/infinibot.json", "javascript:alert(1)", "chrome://settings", "data:text/html,x", ""]) {
      expect(normalizeViewerUrl(bad).ok).toBe(false);
    }
  });
});

describe("hosted browser sessions", () => {
  const hosted = (plan: string) =>
    ({ FLEET_TENANT_ID: "t-1", FLEET_HOSTED_BROWSER: "1", FLEET_TENANT_PLAN: plan }) as NodeJS.ProcessEnv;
  it("counts real pages only — the viewer adds nothing of its own", () => {
    expect(
      countBrowserSessions([
        { url: "about:blank", type: "page" },
        { url: "https://mail.google.com/", type: "page" },
        { url: "https://accounts.google.com/o/oauth2", type: "page" },
        { url: "https://x.test/sw.js", type: "service_worker" },
      ]),
    ).toBe(2);
  });
  it("the plan cap applies to a tab opened from the panel like any other", () => {
    expect(hostedBrowserSessionCap(hosted("pro"))).toBe(1);
    expect(hostedBrowserSessionCap(hosted("business"))).toBe(4);
    expect(hostedBrowserSessionCap({} as NodeJS.ProcessEnv)).toBeNull();
    const one = [{ url: "https://github.com/", type: "page" }];
    expect(() => assertBrowserSessionAvailable(one, hosted("pro"))).toThrow(BrowserSessionLimitError);
    expect(() => assertBrowserSessionAvailable(one, hosted("business"))).not.toThrow();
    expect(() => assertBrowserSessionAvailable([{ url: "about:blank" }], hosted("starter"))).not.toThrow();
  });
  it("hosted Chromium gets a window size and a desktop user agent", () => {
    expect(hostedBrowserUserAgent("Chromium 141.0.7390.37 ")).toContain("Chrome/141.0.0.0 Safari");
    expect(hostedBrowserUserAgent("nope")).toBeNull();
    const args = hostedChromeArgs("Chromium 141.0.7390.37", hosted("pro"));
    expect(args).toContain("--window-size=1280,800");
    expect(args.some((a) => a.startsWith("--user-agent=") && !a.includes("Headless"))).toBe(true);
    expect(hostedChromeArgs("Chromium 141.0.7390.37", {} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

// ── stream behaviour against a fake browser ─────────────────────────────────

class FakeCdp {
  sent: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  isClosed = false;
  private listener: ((evt: CdpEvent) => void) | null = null;
  private closeFn: (() => void) | null = null;
  targets = [{ targetId: "T1", type: "page", title: "One", url: "https://one.test/" }];
  onEvent(fn: (evt: CdpEvent) => void) {
    this.listener = fn;
  }
  onceClosed(fn: () => void) {
    this.closeFn = fn;
  }
  emit(method: string, params: Record<string, unknown>, sessionId?: string) {
    this.listener?.({ method, params, sessionId });
  }
  async send(method: string, params?: Record<string, unknown>, sessionId?: string) {
    this.sent.push({ method, params, sessionId });
    if (method === "Target.setDiscoverTargets") {
      for (const t of this.targets) this.emit("Target.targetCreated", { targetInfo: t });
    }
    if (method === "Target.attachToTarget") return { sessionId: `S-${String(params?.targetId)}` };
    return {};
  }
  close() {
    this.isClosed = true;
    this.closeFn?.();
  }
  methods() {
    return this.sent.map((s) => s.method);
  }
}

describe("BrowserViewer", () => {
  let cdp: FakeCdp;
  let emitted: Array<{ connIds: string[]; event: string; payload: Record<string, unknown> }>;
  let viewer: BrowserViewer;
  beforeEach(() => {
    vi.useFakeTimers();
    cdp = new FakeCdp();
    emitted = [];
    viewer = new BrowserViewer({
      resolveBrowserWsUrl: async () => "ws://127.0.0.1:1/devtools/browser/x",
      connect: async () => cdp as unknown as CdpConnection,
      emit: (connIds, event, payload) =>
        emitted.push({ connIds: [...connIds], event, payload: payload as Record<string, unknown> }),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const frame = (sessionId: string, ackId: number) =>
    cdp.emit(
      "Page.screencastFrame",
      { data: "AAAA", sessionId: ackId, metadata: { deviceWidth: 1280, deviceHeight: 800 } },
      sessionId,
    );
  const frames = () => emitted.filter((e) => e.event === VIEWER_FRAME_EVENT);

  it("subscribing attaches to the open tab and starts the screencast", async () => {
    const state = await viewer.subscribe("c1");
    expect(state.activeTargetId).toBe("T1");
    expect(state.tabs).toHaveLength(1);
    expect(cdp.methods()).toEqual(
      expect.arrayContaining(["Target.attachToTarget", "Page.enable", "Page.startScreencast"]),
    );
  });

  it("frames go only to subscribed connections, and stop when a subscriber stops acking", async () => {
    await viewer.subscribe("c1");
    frame("S-T1", 1);
    expect(frames()).toHaveLength(1);
    expect(frames()[0].connIds).toEqual(["c1"]);
    expect(frames()[0].payload).toMatchObject({ targetId: "T1", data: "AAAA", width: 1280 });
    await vi.advanceTimersByTimeAsync(100);
    expect(cdp.methods()).toContain("Page.screencastFrameAck");
    frame("S-T1", 2);
    frame("S-T1", 3); // c1 has two un-acked frames: not sent a third
    expect(frames()).toHaveLength(2);
    viewer.ack("c1");
    frame("S-T1", 4);
    expect(frames()).toHaveLength(3);
    // A frame from a session that is not the active one is ignored.
    frame("S-other", 9);
    expect(frames()).toHaveLength(3);
  });

  it("follows a popup the page opens (OAuth) and returns to the opener when it closes", async () => {
    await viewer.subscribe("c1");
    cdp.emit("Target.targetCreated", {
      targetInfo: { targetId: "T2", type: "page", title: "Sign in", url: "https://accounts.test/", openerId: "T1" },
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(viewer.state().activeTargetId).toBe("T2");
    expect(emitted.some((e) => e.event === VIEWER_STATE_EVENT)).toBe(true);
    cdp.emit("Target.targetDestroyed", { targetId: "T2" });
    await vi.advanceTimersByTimeAsync(60);
    expect(viewer.state().activeTargetId).toBe("T1");
    expect(viewer.state().tabs.map((t) => t.targetId)).toEqual(["T1"]);
  });

  it("input needs a subscription and is sent to the active tab's session", async () => {
    await expect(viewer.input("nobody", { kind: "text", text: "x" })).rejects.toThrow(/Open the live browser/);
    await viewer.subscribe("c1");
    await viewer.input("c1", { kind: "text", text: "hunter2" });
    expect(cdp.sent.at(-1)).toEqual({
      method: "Input.insertText",
      params: { text: "hunter2" },
      sessionId: "S-T1",
    });
  });

  it("the last subscriber leaving stops the screencast and closes the connection", async () => {
    await viewer.subscribe("c1");
    await viewer.subscribe("c2");
    viewer.unsubscribe("c1");
    expect(cdp.isClosed).toBe(false);
    viewer.unsubscribe("c2");
    await vi.advanceTimersByTimeAsync(1);
    expect(cdp.methods()).toContain("Page.stopScreencast");
    expect(cdp.isClosed).toBe(true);
    expect(viewer.subscriberCount).toBe(0);
  });

  it("a connection that goes silent is dropped", async () => {
    await viewer.subscribe("c1");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(viewer.subscriberCount).toBe(0);
  });
});
