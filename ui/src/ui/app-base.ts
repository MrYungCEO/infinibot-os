/**
 * App base path — one place that makes root-absolute app URLs work when the
 * control UI is not served at "/" (hosted cloud: infinibotos.com/app; a
 * gateway with controlUi.basePath). Self-hosted root installs have base "" and
 * every function here is the identity.
 *
 * Many call sites (and gateway-provided data: setup-status actions, UI target
 * routes, panel "Open" links) write app routes as "/setup?view=coders",
 * "/oversight#review-…", "/chat/<id>". Rather than threading the base through
 * each one, `installAppBaseGuard()` rewrites them at the three places a URL
 * becomes navigation: history.pushState/replaceState, <a href> activation
 * (incl. inside shadow roots) and window.open. Only paths whose first segment
 * is a known app route (navigation.ts appRouteRoots) are touched, so /api/*,
 * gateway HTTP routes and asset URLs pass through unchanged.
 */
import { appRouteRoots, inferBasePathFromPathname, normalizeBasePath } from "./navigation";

/** The router's base ("" at root, "/app" on the cloud). Same rule as app-settings.ts. */
export function appBasePath(): string {
  if (typeof window === "undefined") return "";
  const configured = window.__INFINIBOT_CONTROL_UI_BASE_PATH__;
  if (typeof configured === "string" && configured.trim()) return normalizeBasePath(configured);
  return normalizeBasePath(inferBasePathFromPathname(window.location?.pathname ?? "/"));
}

/**
 * Prefix a root-absolute app route with the base: withAppBase("/setup?view=x")
 * → "/app/setup?view=x" under /app. Anything else (relative, absolute URLs,
 * protocol-relative, already-based, /api/…, unknown roots) is returned as-is.
 * `includeRoot` also maps "/" (history navigation to the app home).
 */
export function withAppBase(url: string, base = appBasePath(), includeRoot = false): string {
  if (!base || typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return url;
  if (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`) || url.startsWith(`${base}#`)) {
    return url;
  }
  const seg = url.slice(1).split(/[/?#]/, 1)[0]!.toLowerCase();
  if (!seg) return includeRoot ? `${base}/${url.slice(1)}` : url;
  return appRouteRoots().has(seg) ? `${base}${url}` : url;
}

/**
 * Anchor a "./x.png" public-asset URL to the app base. A relative URL resolves
 * against the document, which breaks on nested routes (/app/solatrix/discovery
 * → /app/solatrix/x.png). file:// (Electron) and non-relative URLs pass through.
 */
export function appAssetUrl(url: string): string {
  if (!url.startsWith("./") || typeof window === "undefined") return url;
  if (window.location?.protocol === "file:") return url;
  return `${appBasePath()}/${url.slice(2)}`;
}

let installed = false;

/** Install the pushState / <a href> / window.open rewrites. No-op at root. */
export function installAppBaseGuard(base = appBasePath()): void {
  if (installed || !base || typeof window === "undefined") return;
  installed = true;

  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
      const next = typeof url === "string" ? withAppBase(url, base, true) : url;
      return original.call(this, data, unused, next);
    } as History[typeof method];
  }

  const fixAnchor = (ev: Event) => {
    for (const node of ev.composedPath()) {
      if (!(node instanceof Element)) continue;
      if (node.tagName !== "A" && node.tagName !== "AREA") continue;
      const href = node.getAttribute("href");
      if (href) {
        const next = withAppBase(href, base);
        if (next !== href) node.setAttribute("href", next);
      }
      return;
    }
  };
  // Capture phase runs before the default action reads the href.
  document.addEventListener("click", fixAnchor, true);
  document.addEventListener("auxclick", fixAnchor, true);

  const open = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) =>
    open(typeof url === "string" ? withAppBase(url, base) : url, target, features)) as typeof window.open;
}
