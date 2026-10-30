/**
 * Web opener for deep links — `GET /m/<path>` (docs/mobile/DEEP-LINKS.md).
 *
 * Telegram (and anything else that needs an https URL) links to
 * `<public-base>/m/<path>`. This page carries no data, so it is public (the
 * HTTP gate classifies a GET outside /api/ as "static": Host-checked, no
 * credential). A tiny inline script then:
 *   - Android: hands off to the app via `intent://<path>#Intent;scheme=infinibot;
 *     S.browser_fallback_url=<web route>;end` (Chrome opens the fallback when
 *     the app is not installed);
 *   - iOS: tries `infinibot://<path>` and, if the page is still visible after
 *     ~1.2 s, goes to the web route;
 *   - desktop: `location.replace(<web route>)` (behind the normal login).
 * Visible "Open in app" / "Open in browser" links cover no-JS and blocked
 * hand-offs.
 *
 * The web route comes from webRouteForDeepLink() with the live plugin registry
 * and always starts with a single "/" (never protocol-relative), so the page
 * cannot be used as an open redirect.
 *
 * Optionally serves `/.well-known/assetlinks.json` (Android App Links) when
 * INFINIBOT_ANDROID_APP_LINKS_JSON holds the JSON document.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  DEEP_LINK_SCHEME,
  deepLinkPath,
  webRouteForDeepLink,
  type LinkPluginInfo,
} from "../notifications/links.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";

export const DEEP_LINK_OPENER_PREFIX = "/m";

export type DeepLinkHttpOptions = {
  /** Control-UI base path ("" or "/ui"); prefixed onto the web route. */
  basePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests: plugin list override (default: the live registry). */
  plugins?: LinkPluginInfo[] | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON safe to inline in a <script> (no `</script>`, no U+2028/9 breakage). */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function normalizeBasePath(basePath: string | undefined): string {
  let b = (basePath ?? "").trim();
  if (!b || b === "/") return "";
  if (!b.startsWith("/")) b = `/${b}`;
  b = b.replace(/\/+$/, "");
  // Guard: never let a base path turn the route protocol-relative.
  return b.startsWith("//") ? "" : b;
}

function livePlugins(): LinkPluginInfo[] | null {
  const reg = getActivePluginRegistry();
  if (!reg) return null;
  return reg.plugins.map((p) => ({
    id: p.id,
    enabled: p.enabled,
    status: p.status,
    contributes: p.contributes
      ? {
          pages: p.contributes.pages,
          nav: p.contributes.nav,
          landing: p.contributes.landing,
        }
      : null,
  }));
}

export type DeepLinkOpenerTarget = {
  /** Canonical path after `infinibot://` / `/m/` (may be ""). */
  path: string;
  appLink: string;
  /** Same-origin web route incl. base path; starts with a single "/". */
  webRoute: string;
};

/** Resolve the opener target for the raw `/m/…` request URL (exported for tests). */
export function resolveOpenerTarget(
  rawUrl: string,
  opts: DeepLinkHttpOptions = {},
): DeepLinkOpenerTarget | null {
  let pathname: string;
  let search: string;
  try {
    const u = new URL(rawUrl, "http://opener.invalid");
    pathname = u.pathname;
    search = u.search;
  } catch {
    return null;
  }
  if (pathname !== DEEP_LINK_OPENER_PREFIX && !pathname.startsWith(`${DEEP_LINK_OPENER_PREFIX}/`)) {
    return null;
  }
  const rest = pathname.slice(DEEP_LINK_OPENER_PREFIX.length).replace(/^\/+/, "");
  const deepLink = `${DEEP_LINK_SCHEME}${rest}${search}`;
  const path = deepLinkPath(deepLink);
  const plugins = opts.plugins !== undefined ? opts.plugins : livePlugins();
  let route = webRouteForDeepLink(deepLink, { plugins });
  if (!route.startsWith("/") || route.startsWith("//") || route.startsWith("/\\")) {
    route = "/dashboard";
  }
  const webRoute = `${normalizeBasePath(opts.basePath)}${route}`;
  // `infinibot://` with an empty path is valid for the app; keep it explicit.
  const appLink = `${DEEP_LINK_SCHEME}${path}`;
  return { path, appLink, webRoute };
}

export function renderOpenerPage(target: DeepLinkOpenerTarget, nonce: string): string {
  const data = inlineJson({
    path: target.path || "home",
    app: target.appLink,
    web: target.webRoute,
  });
  const app = escapeHtml(target.appLink);
  const web = escapeHtml(target.webRoute);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Opening InfiniBot…</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0d; color: #e9e4d8;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { text-align: center; padding: 32px 24px; max-width: 420px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0 0 24px; color: #a9a397; }
  a { display: block; margin: 10px 0; padding: 12px 16px; border-radius: 10px; text-decoration: none; font-weight: 600; }
  a.primary { background: #d4af37; color: #111; }
  a.secondary { border: 1px solid #3a372f; color: #e9e4d8; }
</style>
</head>
<body>
<main>
  <h1>Opening InfiniBot…</h1>
  <p>If nothing happens, choose where to open it.</p>
  <a class="primary" id="open-app" href="${app}">Open in app</a>
  <a class="secondary" id="open-web" href="${web}">Open in browser</a>
</main>
<script nonce="${nonce}">
(function () {
  var d = ${data};
  var web = new URL(d.web, location.href).href;
  var ua = navigator.userAgent || "";
  var android = /Android/i.test(ua);
  var ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (android) {
    var intent = "intent://" + d.path + "#Intent;scheme=infinibot;S.browser_fallback_url=" +
      encodeURIComponent(web) + ";end";
    document.getElementById("open-app").setAttribute("href", intent);
    location.href = intent;
  } else if (ios) {
    location.href = d.app;
    setTimeout(function () {
      if (!document.hidden) location.replace(web);
    }, 1200);
  } else {
    location.replace(web);
  }
})();
</script>
</body>
</html>
`;
}

function sendAssetLinks(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv,
): boolean {
  const raw = env.INFINIBOT_ANDROID_APP_LINKS_JSON?.trim();
  if (!raw) return false;
  let body: string;
  try {
    body = JSON.stringify(JSON.parse(raw));
  } catch {
    return false;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

/** Handles GET/HEAD `/m[/…]` and (optionally) `/.well-known/assetlinks.json`. */
export async function handleDeepLinkOpenerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DeepLinkHttpOptions = {},
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const url = req.url ?? "/";
  const qi = url.indexOf("?");
  const pathname = qi >= 0 ? url.slice(0, qi) : url;
  if (pathname === "/.well-known/assetlinks.json") {
    return sendAssetLinks(req, res, opts.env ?? process.env);
  }
  if (pathname !== DEEP_LINK_OPENER_PREFIX && !pathname.startsWith(`${DEEP_LINK_OPENER_PREFIX}/`)) {
    return false;
  }
  const target = resolveOpenerTarget(url, opts);
  if (!target) return false;
  const nonce = randomBytes(16).toString("base64");
  const html = renderOpenerPage(target, nonce);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res.end(method === "HEAD" ? undefined : html);
  return true;
}
