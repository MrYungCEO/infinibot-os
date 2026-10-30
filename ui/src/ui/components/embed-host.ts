/**
 * Embed host — shared plumbing for control-UI pages that run chromeless
 * inside the mobile app (Knowledge Graph, Agent Mesh, …).
 *
 *   · Detection: `?embed=1` / `?embed=mobile` on the URL (read once at load —
 *     in-app navigation may drop the query later). `embed=1` is chrome-only
 *     (e.g. a Grid panel); `embed=mobile` also opts in to the native bridge.
 *   · Hosts: the RN WebView (`ReactNativeWebView.postMessage`), or — for the
 *     app's web export, served by the same gateway — a SAME-ORIGIN parent
 *     page holding the page in an <iframe> (`parent.postMessage` with an
 *     exact target origin; a cross-origin parent never gets a host).
 *   · Chrome: hides the control-UI shell (topbar, nav rail, threads sidebar,
 *     host sub-tabs, desktop toasts), locks page zoom so pinch reaches the
 *     surface, and kills the rubber-band overscroll.
 *   · Bridge: each surface makes its own with `createEmbedBridge({ source,
 *     hostSource, parseCommand })` — page → app messages are JSON tagged
 *     `{ source, type, … }`; app → page commands are `{ source: hostSource,
 *     cmd, … }` (iframe) or a direct call on a `window.__<surface>Embed` API.
 */

export type NativeHaptic = "selection" | "light" | "medium" | "heavy" | "success" | "warning" | "error";

type RNWebView = { postMessage: (data: string) => void };

function rnHost(): RNWebView | null {
  const w = globalThis as unknown as { ReactNativeWebView?: RNWebView };
  return w.ReactNativeWebView && typeof w.ReactNativeWebView.postMessage === "function" ? w.ReactNativeWebView : null;
}

/** Pure: is this URL search string an embed request? */
export function searchWantsEmbed(search: string): boolean {
  try {
    const v = (new URLSearchParams(search).get("embed") ?? "").toLowerCase();
    return v === "1" || v === "true" || v === "mobile";
  } catch {
    return false;
  }
}

/** Pure: does this URL search string ask for the native bridge (`embed=mobile`)? */
export function searchWantsHost(search: string): boolean {
  try {
    return (new URLSearchParams(search).get("embed") ?? "").toLowerCase() === "mobile";
  } catch {
    return false;
  }
}

let hostCache: boolean | null = null;
let embedCache: boolean | null = null;

/** `embed=mobile` at load (cached: the router may rewrite the URL later). */
function wantsHost(): boolean {
  if (hostCache == null) {
    try {
      hostCache = searchWantsHost(location.search);
    } catch {
      hostCache = false;
    }
  }
  return hostCache;
}

/** True when the page was opened chromeless (`?embed=1|mobile`, read once). */
export function isEmbedRequest(): boolean {
  if (embedCache == null) {
    try {
      embedCache = searchWantsEmbed(location.search) || document.documentElement.getAttribute("data-embed") === "1";
    } catch {
      embedCache = false;
    }
  }
  return embedCache;
}

/** The RN WebView bridge, only when the page was opened as an app surface. */
function appHost(): RNWebView | null {
  return wantsHost() ? rnHost() : null;
}

/**
 * The same-origin parent window when the page is iframed in embed mode (the
 * app's web export). Null at top level, cross-origin, or without `?embed`.
 */
function frameHost(): Window | null {
  try {
    if (window.parent === window || !wantsHost()) return null;
    // Reading a cross-origin parent's origin throws → no host.
    return window.parent.location.origin === location.origin ? window.parent : null;
  } catch {
    return null;
  }
}

/** True inside the native app or its same-origin web export (a bridge to post to). */
export function hasNativeHost(): boolean {
  return appHost() != null || frameHost() != null;
}

/** Send a raw tagged payload to the app; false when there is no native host. */
export function postToHost(source: string, msg: { type: string }): boolean {
  const payload = JSON.stringify({ source, ...msg });
  try {
    const host = appHost();
    if (host) {
      host.postMessage(payload);
      return true;
    }
    const frame = frameHost();
    if (frame) {
      // Exact origin: page data never leaves the gateway's origin.
      frame.postMessage(payload, location.origin);
      return true;
    }
  } catch {
    /* host went away */
  }
  return false;
}

/** Pure: decode a host → page payload tagged with `hostSource` (else null). */
export function decodeHostPayload(data: unknown, hostSource: string): Record<string, unknown> | null {
  let d = data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  return o.source === hostSource ? o : null;
}

/** Pure: a trimmed, length-capped non-empty string, else null. */
export function cleanStr(v: unknown, max = 512): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

export interface EmbedBridge<Msg extends { type: string }, Cmd> {
  readonly source: string;
  readonly hostSource: string;
  /** Send a message to the native app; false when there is no native host. */
  postNative(msg: Msg | { type: "haptic"; style: NativeHaptic }): boolean;
  /** Haptic tick: native host first, else the Vibration API on Android browsers. */
  haptic(style: NativeHaptic): void;
  /** Validate a host → page command (unknown / malformed → null). */
  parseHostCommand(data: unknown): Cmd | null;
  /** Listen for commands from a same-origin parent frame. Returns the unsubscribe. */
  listenHostCommands(handler: (c: Cmd) => void): () => void;
}

/** A surface's bridge: its message tag, its host-command tag and validator. */
export function createEmbedBridge<Msg extends { type: string }, Cmd>(opts: {
  source: string;
  hostSource: string;
  /** Validate a decoded `{ source: hostSource, cmd, … }` object. */
  parseCommand: (o: Record<string, unknown>) => Cmd | null;
}): EmbedBridge<Msg, Cmd> {
  const { source, hostSource, parseCommand } = opts;
  const postNative = (msg: { type: string }) => postToHost(source, msg);
  const parseHostCommand = (data: unknown): Cmd | null => {
    const o = decodeHostPayload(data, hostSource);
    return o ? parseCommand(o) : null;
  };
  return {
    source,
    hostSource,
    postNative,
    haptic(style) {
      if (postNative({ type: "haptic", style } as { type: string })) return;
      try {
        const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
        if (matchMedia?.("(pointer: coarse)")?.matches) nav.vibrate?.(style === "heavy" || style === "error" ? 18 : 8);
      } catch {
        /* no haptics */
      }
    },
    parseHostCommand,
    listenHostCommands(handler) {
      const on = (e: MessageEvent) => {
        if (e.origin !== location.origin || e.source !== window.parent) return;
        const c = parseHostCommand(e.data);
        if (c) handler(c);
      };
      try {
        window.addEventListener("message", on);
      } catch {
        return () => {};
      }
      return () => window.removeEventListener("message", on);
    },
  };
}

/** Page-level CSS shared by every embedded surface (exported for tests). */
export const EMBED_CHROME_CSS = [
  'html[data-embed="1"]{--shell-topbar-height:0px!important;overscroll-behavior:none}',
  'html[data-embed="1"] body{overscroll-behavior:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}',
  'html[data-embed="1"] .shell{grid-template-areas:"content"!important;grid-template-columns:1fr!important;grid-template-rows:1fr!important}',
  'html[data-embed="1"] .topbar,html[data-embed="1"] .nav,html[data-embed="1"] .threads-sidebar,html[data-embed="1"] .threads-sidebar-overlay{display:none!important}',
  'html[data-embed="1"] .content{grid-area:content!important;margin:0!important;padding:0!important;inset:0!important}',
  'html[data-embed="1"] .content>.host-subtabs{display:none!important}',
].join("");

/** The page IS the surface: no shell scroll, no long-press selection, no desktop toasts. */
export function surfaceLockCss(attr: string, bg: string): string {
  const s = `html[${attr}="1"]`;
  return [
    `${s},${s} body{height:100%;overflow:hidden;background:${bg}}`,
    `${s} body{-webkit-user-select:none;user-select:none}`,
    // Shell-level popups (task toasts) belong to the desktop; the app has its own.
    `${s} proactive-toast,${s} proactive-overlay-host{display:none!important}`,
    `${s} input,${s} textarea,${s} [contenteditable]{-webkit-user-select:text;user-select:text}`,
  ].join("");
}

/**
 * Put the page in embed mode (idempotent): `data-embed` + the surface's own
 * attribute on <html>, the chrome stylesheet, and a no-zoom viewport so
 * two-finger gestures reach the surface instead of zooming the page.
 */
export function applyEmbedChrome(opts: { attr: string; styleId: string; css: string }): void {
  try {
    const root = document.documentElement;
    root.setAttribute("data-embed", "1");
    root.setAttribute(opts.attr, "1");
    if (!document.getElementById(opts.styleId)) {
      const s = document.createElement("style");
      s.id = opts.styleId;
      s.textContent = opts.css;
      document.head.appendChild(s);
    }
    let vp = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!vp) {
      vp = document.createElement("meta");
      vp.name = "viewport";
      document.head.appendChild(vp);
    }
    vp.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
  } catch {
    /* best effort */
  }
}

/** Test hook: forget the cached detection. */
export function resetEmbedHostCache(): void {
  hostCache = null;
  embedCache = null;
}
