/**
 * Knowledge-graph embed mode — the SAME <infinibot-knowledge-graph> running
 * chromeless inside the mobile app's WebView (or any `?embed=1` host).
 *
 *   · Detection: `?embed=1` / `?embed=mobile` on the URL (read once at load —
 *     in-app navigation may drop the query later). `embed=1` is chrome-only
 *     (e.g. a Grid panel); `embed=mobile` also opts in to the native bridge.
 *   · Hosts: the RN WebView (`ReactNativeWebView.postMessage`), or — for the
 *     app's web export, served by the same gateway — a SAME-ORIGIN parent
 *     page holding the graph in an <iframe> (`parent.postMessage` with an
 *     exact target origin; a cross-origin parent never gets a host).
 *   · Chrome: hides the control-UI shell (topbar, nav rail, threads sidebar)
 *     and the Memory host's sub-tab strip, locks page zoom so pinch reaches
 *     the 3D camera, and kills the rubber-band overscroll.
 *   · Native bridge: `postNative()` sends `{ source: "infinibot-kg", type, … }`
 *     to the app (haptics, "open this node", "continue in chat", ready).
 *     The app drives the page back through `window.__kgEmbed` (focus a node,
 *     turn on a layer, switch the grouping).
 *   · Deep-link params: `?focus=<nodeId>&family=1&layer=<kind>&group=<mode>`.
 */

export const KG_BRIDGE_SOURCE = "infinibot-kg";

export type NativeHaptic = "selection" | "light" | "medium" | "heavy" | "success" | "warning" | "error";

export type NativeMessage =
  | { type: "ready"; nodes: number; mode: string }
  | { type: "haptic"; style: NativeHaptic }
  | { type: "open"; node: { id: string; kind: string; label: string; meta?: Record<string, unknown> }; path: string | null }
  | { type: "chat"; sessionKey: string }
  | { type: "ask"; nodeIds: string[]; prompt: string }
  /** Nothing left to close on the page: the app should navigate back. */
  | { type: "back" };

/** Commands the host sends the page (RN: `__kgEmbed.*`; iframe: postMessage). */
export const KG_HOST_SOURCE = "infinibot-kg-host";
export type HostCommand =
  | { cmd: "focus"; id: string; family: boolean }
  | { cmd: "apply"; link: KgDeepLink }
  | { cmd: "fit" }
  | { cmd: "back" };

export interface KgDeepLink {
  focus: string | null;
  family: boolean;
  layer: string | null;
  group: string | null;
}

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

/** The RN WebView bridge, only when the page was opened as the app's graph. */
function appHost(): RNWebView | null {
  return wantsHost() ? rnHost() : null;
}

/**
 * The same-origin parent window when the graph is iframed in embed mode (the
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

/** Pure: validate a host → page command (unknown / malformed → null). */
export function parseHostCommand(data: unknown): HostCommand | null {
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
  if (o.source !== KG_HOST_SOURCE) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 512) : null);
  switch (o.cmd) {
    case "focus": {
      const id = str(o.id);
      return id ? { cmd: "focus", id, family: o.family === true } : null;
    }
    case "apply":
      return {
        cmd: "apply",
        link: { focus: str(o.focus), family: o.family === true, layer: str(o.layer), group: str(o.group) },
      };
    case "fit":
      return { cmd: "fit" };
    case "back":
      return { cmd: "back" };
    default:
      return null;
  }
}

/**
 * Listen for host commands from a same-origin parent frame. Returns the
 * unsubscribe. (The RN host calls `window.__kgEmbed` directly instead.)
 */
export function listenHostCommands(handler: (c: HostCommand) => void): () => void {
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
}

/** Pure: the deep-link params of a URL search string. */
export function parseKgDeepLink(search: string): KgDeepLink {
  let sp: URLSearchParams;
  try {
    sp = new URLSearchParams(search);
  } catch {
    sp = new URLSearchParams();
  }
  const s = (k: string) => {
    const v = (sp.get(k) ?? "").trim();
    return v ? v : null;
  };
  const fam = sp.get("family");
  return { focus: s("focus"), family: fam === "1" || fam === "true", layer: s("layer"), group: s("group") };
}

let embedCache: boolean | null = null;
let linkCache: KgDeepLink | null = null;

/** True when the graph runs chromeless (mobile WebView / `?embed=1`). */
export function isKgEmbed(): boolean {
  if (embedCache != null) return embedCache;
  try {
    embedCache =
      searchWantsEmbed(location.search) || document.documentElement.getAttribute("data-kg-embed") === "1";
  } catch {
    embedCache = false;
  }
  return embedCache;
}

/** True inside the native app or its same-origin web export (a bridge to post to). */
export function hasNativeHost(): boolean {
  return appHost() != null || frameHost() != null;
}

/** The deep-link params the page was opened with (read once). */
export function initialKgDeepLink(): KgDeepLink {
  if (linkCache) return linkCache;
  try {
    linkCache = parseKgDeepLink(location.search);
  } catch {
    linkCache = { focus: null, family: false, layer: null, group: null };
  }
  return linkCache;
}

/** Send a message to the native app; false when there is no native host. */
export function postNative(msg: NativeMessage): boolean {
  const payload = JSON.stringify({ source: KG_BRIDGE_SOURCE, ...msg });
  try {
    const host = appHost();
    if (host) {
      host.postMessage(payload);
      return true;
    }
    const frame = frameHost();
    if (frame) {
      // Exact origin: node labels never leave the gateway's origin.
      frame.postMessage(payload, location.origin);
      return true;
    }
  } catch {
    /* host went away */
  }
  return false;
}

/** Haptic tick: native host first, else the Vibration API on Android browsers. */
export function haptic(style: NativeHaptic): void {
  if (postNative({ type: "haptic", style })) return;
  try {
    const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    if (matchMedia?.("(pointer: coarse)")?.matches) nav.vibrate?.(style === "heavy" || style === "error" ? 18 : 8);
  } catch {
    /* no haptics */
  }
}

const EMBED_STYLE_ID = "__kg_embed_chrome";

/** The page-level CSS for embed mode (exported for tests). */
export const KG_EMBED_CSS = [
  'html[data-embed="1"]{--shell-topbar-height:0px!important;overscroll-behavior:none}',
  'html[data-embed="1"] body{overscroll-behavior:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}',
  'html[data-embed="1"] .shell{grid-template-areas:"content"!important;grid-template-columns:1fr!important;grid-template-rows:1fr!important}',
  'html[data-embed="1"] .topbar,html[data-embed="1"] .nav,html[data-embed="1"] .threads-sidebar,html[data-embed="1"] .threads-sidebar-overlay{display:none!important}',
  'html[data-embed="1"] .content{grid-area:content!important;margin:0!important;padding:0!important;inset:0!important}',
  'html[data-embed="1"] .content>.host-subtabs{display:none!important}',
  'html[data-embed="1"] infinibot-knowledge-graph .kg-host{border-radius:0!important}',
  // The graph IS the page: no shell scroll, no text selection on long-press.
  'html[data-kg-embed="1"],html[data-kg-embed="1"] body{height:100%;overflow:hidden;background:#07060c}',
  'html[data-kg-embed="1"] body{-webkit-user-select:none;user-select:none}',
  // Shell-level popups (task toasts) belong to the desktop; the app has its own.
  'html[data-kg-embed="1"] proactive-toast{display:none!important}',
  'html[data-kg-embed="1"] input,html[data-kg-embed="1"] textarea,html[data-kg-embed="1"] [contenteditable]{-webkit-user-select:text;user-select:text}',
].join("");

/**
 * Put the page in embed mode (idempotent): `data-embed` on <html>, the chrome
 * stylesheet, and a no-zoom viewport so two-finger gestures reach the graph.
 */
export function applyKgEmbedChrome(): void {
  try {
    const root = document.documentElement;
    root.setAttribute("data-embed", "1");
    root.setAttribute("data-kg-embed", "1");
    if (!document.getElementById(EMBED_STYLE_ID)) {
      const s = document.createElement("style");
      s.id = EMBED_STYLE_ID;
      s.textContent = KG_EMBED_CSS;
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
export function resetKgEmbedCache(): void {
  embedCache = null;
  linkCache = null;
  hostCache = null;
}
