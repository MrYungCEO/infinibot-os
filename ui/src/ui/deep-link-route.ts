/**
 * Web UI routing for notification deep links (docs/mobile/DEEP-LINKS.md).
 *
 * `infinibot://<path>` (and legacy forms: `mobile://chat?sessionKey=`,
 * relative web paths) → the web route from the spec's fallback table — the same
 * table the gateway's `/m/*` opener uses (src/notifications/links.ts). Plugin
 * pages resolve against the plugin host's last `plugins.list`.
 */

import {
  normalizeDeepLink,
  webRouteForDeepLink,
  type LinkPluginInfo,
} from "../../../src/notifications/links.js";
import { pluginLinkInfo } from "./plugin-host.js";

/** The web route (path + query, no base path) for a deep link; null when unusable. */
export function deepLinkToWebRoute(
  link: string | null | undefined,
  plugins: readonly LinkPluginInfo[] | null = pluginLinkInfo(),
): string | null {
  const normalized = normalizeDeepLink(link ?? null);
  if (!normalized) return null;
  return webRouteForDeepLink(normalized, { plugins: plugins ? [...plugins] : null });
}

/** Prefix the control-UI base path ("" or "/ui"). */
export function withBasePath(route: string, basePath = ""): string {
  let base = basePath.trim();
  if (!base || base === "/") return route;
  if (!base.startsWith("/")) base = `/${base}`;
  return `${base.replace(/\/+$/, "")}${route}`;
}

/**
 * Navigate the SPA to a deep link: push the route and let the app's popstate
 * handler switch tabs (it also picks up `?session=` for chat links).
 */
export function navigateToDeepLink(link: string | null | undefined, basePath = ""): boolean {
  const route = deepLinkToWebRoute(link);
  if (!route || typeof window === "undefined") return false;
  window.history.pushState({}, "", withBasePath(route, basePath));
  window.dispatchEvent(new PopStateEvent("popstate"));
  return true;
}

type DesktopBridge = { onDeepLink?: (cb: (url: string) => void) => (() => void) | void };

/**
 * Desktop app: the shell forwards `infinibot://…` links it was opened with
 * (apps/desktop preload → `gatewayBridge.onDeepLink`). Route them like any
 * other deep link, e.g. `infinibot://web/plugins?install=<id>` from the
 * marketplace site. Returns an unsubscribe function (a no-op in a browser).
 */
export function attachDesktopDeepLinks(
  getBasePath: () => string,
  onNavigate?: () => void,
  bridge: DesktopBridge | undefined = typeof window === "undefined"
    ? undefined
    : (window as unknown as { gatewayBridge?: DesktopBridge }).gatewayBridge,
): () => void {
  if (typeof bridge?.onDeepLink !== "function") return () => undefined;
  const off = bridge.onDeepLink((url) => {
    if (navigateToDeepLink(url, getBasePath())) onNavigate?.();
  });
  return typeof off === "function" ? off : () => undefined;
}
