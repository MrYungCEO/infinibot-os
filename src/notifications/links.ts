/**
 * Deep links for every alert InfiniBot sends — spec: docs/mobile/DEEP-LINKS.md.
 *
 * One path, two forms:
 *   app scheme  infinibot://<path>            (push data, notification.created, in-app)
 *   web opener  https://<public-base>/m/<path> (Telegram and anything that must be https)
 *
 * This module is PURE (no node imports) so the web UI can share the path →
 * web-route table (ui/src/ui/deep-link-route.ts). Resolving the public base
 * with the live config + Tailscale host lives in ./public-base.ts.
 */

import type { InfinibotConfig } from "../config/config.js";
import { resolveTailscaleMode } from "../gateway/tailscale-config.js";

export const DEEP_LINK_SCHEME = "infinibot://";

export type DeepLinkQuery = Record<string, string | number | boolean | null | undefined>;

export type DeepLinkTarget = (
  | { kind: "home" }
  | { kind: "run"; runId?: string | null }
  | { kind: "approval"; id?: string | null }
  | { kind: "goal"; id?: string | null }
  | { kind: "phase"; id?: string | null }
  | { kind: "scheduled"; taskId?: string | null }
  | { kind: "document"; id?: string | null }
  | { kind: "session"; sessionKey?: string | null }
  | { kind: "task"; taskId?: string | null }
  | { kind: "plugin"; pluginId: string; page?: string | null }
  | { kind: "plugins"; pluginId?: string | null }
  | { kind: "web"; path: string }
  | { kind: "screen"; screen: string }
) & { query?: DeepLinkQuery | string | null };

export type LinkPair = { deepLink: string; webUrl: string | null };

// ── helpers ─────────────────────────────────────────────────────────────────

const enc = (s: string) => encodeURIComponent(s);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function queryString(q: DeepLinkQuery | string | null | undefined): string {
  if (!q) return "";
  if (typeof q === "string") {
    const s = q.replace(/^\?/, "");
    return s ? new URLSearchParams(s).toString() : "";
  }
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

function withQuery(path: string, q: string): string {
  return q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;
}

function idPath(base: string, id: string | null | undefined): string {
  const v = typeof id === "string" ? id.trim() : "";
  return v ? `${base}/${enc(v)}` : base;
}

// ── build ───────────────────────────────────────────────────────────────────

/** `infinibot://<path>` for a typed target. */
export function buildDeepLink(target: DeepLinkTarget): string {
  let path: string;
  let q = queryString(target.query);
  switch (target.kind) {
    case "home":
      path = "";
      break;
    case "run":
      path = idPath("runs", target.runId);
      break;
    case "approval":
      path = idPath("approvals", target.id);
      break;
    case "goal":
      path = idPath("goals", target.id);
      break;
    case "phase":
      path = idPath("phases", target.id);
      break;
    case "scheduled":
      path = idPath("scheduled", target.taskId);
      break;
    case "document":
      path = idPath("documents", target.id);
      break;
    case "session":
      path = idPath("chat", target.sessionKey);
      break;
    case "task":
      path = target.taskId?.trim() ? `board/task/${enc(target.taskId.trim())}` : "board";
      break;
    case "plugin": {
      path = `plugin/${enc(target.pluginId.trim())}`;
      const page = target.page?.trim();
      if (page) path += `/${enc(page)}`;
      break;
    }
    case "plugins":
      path = idPath("plugins", target.pluginId);
      break;
    case "web": {
      const raw = target.path.trim();
      const qi = raw.indexOf("?");
      const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
      const inline = qi >= 0 ? queryString(raw.slice(qi + 1)) : "";
      const segs = pathPart
        .split("/")
        .filter(Boolean)
        .map((s) => enc(safeDecode(s)));
      path = segs.length ? `web/${segs.join("/")}` : "web";
      q = [inline, q].filter(Boolean).join("&");
      break;
    }
    case "screen":
      path = enc(target.screen.trim());
      break;
  }
  return withQuery(`${DEEP_LINK_SCHEME}${path}`, q);
}

// ── normalize + parse ───────────────────────────────────────────────────────

/**
 * Canonicalize any link an emitter hands us into `infinibot://<path>`.
 *   mobile://chat?sessionKey=X → infinibot://chat/X
 *   /solatrix/alerts?x=1       → infinibot://web/solatrix/alerts?x=1
 *   https://host/m/<path>      → infinibot://<path>
 *   infinibot://…              → unchanged (legacy activity/session/X stays valid)
 * Returns null for empty or unsupported input (javascript:, other schemes…).
 */
export function normalizeDeepLink(link: string | null | undefined): string | null {
  if (typeof link !== "string") return null;
  const raw = link.trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith(DEEP_LINK_SCHEME)) {
    return `${DEEP_LINK_SCHEME}${raw.slice(DEEP_LINK_SCHEME.length)}`;
  }
  if (raw.toLowerCase().startsWith("mobile://")) {
    const rest = raw.slice("mobile://".length);
    const qi = rest.indexOf("?");
    const head = (qi >= 0 ? rest.slice(0, qi) : rest).replace(/\/+$/, "");
    const params = new URLSearchParams(qi >= 0 ? rest.slice(qi + 1) : "");
    if (head === "chat") {
      const sk = params.get("sessionKey") ?? params.get("session");
      params.delete("sessionKey");
      params.delete("session");
      const q = params.toString();
      return withQuery(`${DEEP_LINK_SCHEME}${idPath("chat", sk)}`, q);
    }
    return `${DEEP_LINK_SCHEME}${rest}`;
  }
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) {
    return buildDeepLink({ kind: "web", path: raw });
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const m = /^(?:.*?)\/m(?:\/(.*))?$/.exec(u.pathname);
      if (m) return `${DEEP_LINK_SCHEME}${m[1] ?? ""}${u.search}`;
    } catch {
      /* fall through */
    }
    return null;
  }
  if (/^[a-z][a-z0-9_-]*(?:[/?]|$)/i.test(raw) && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return `${DEEP_LINK_SCHEME}${raw}`;
  }
  return null;
}

export type ParsedDeepLink = {
  /** Decoded, non-empty path segments. */
  segments: string[];
  /** Query string without the leading `?` (re-serialized). */
  query: string;
};

/** Split a deep link (any accepted form) or a bare path into segments + query. */
export function parseDeepLink(linkOrPath: string): ParsedDeepLink {
  const normalized =
    normalizeDeepLink(linkOrPath) ??
    (linkOrPath.startsWith(DEEP_LINK_SCHEME) ? linkOrPath : `${DEEP_LINK_SCHEME}`);
  let rest = normalized.slice(DEEP_LINK_SCHEME.length);
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const qi = rest.indexOf("?");
  const pathPart = qi >= 0 ? rest.slice(0, qi) : rest;
  const query = qi >= 0 ? queryString(rest.slice(qi + 1)) : "";
  const segments = pathPart
    .split("/")
    .map((s) => safeDecode(s).trim())
    .filter(Boolean);
  return { segments, query };
}

/** The path part (`<path>[?query]`) of a deep link, as used after `/m/`. */
export function deepLinkPath(link: string): string {
  const { segments, query } = parseDeepLink(link);
  return withQuery(segments.map(enc).join("/"), query);
}

// ── web fallback table ──────────────────────────────────────────────────────

export type LinkPluginPage = { tab: string; route: string };
export type LinkPluginInfo = {
  id: string;
  enabled?: boolean;
  status?: string;
  contributes?: {
    pages?: LinkPluginPage[];
    nav?: Array<{ tab: string }>;
    landing?: string;
  } | null;
};

export type WebRouteOpts = { plugins?: LinkPluginInfo[] | null };

const SCREEN_ROUTES: Record<string, string> = {
  "": "/dashboard",
  home: "/dashboard",
  dashboard: "/dashboard",
  more: "/dashboard",
  business: "/business-hq",
  knowledge: "/notes",
  settings: "/setup",
  notifications: "/activity",
  terminals: "/terminals",
  agents: "/agents",
  autonomy: "/autonomy",
  reports: "/reports",
  oversight: "/oversight",
  grid: "/grid",
  call: "/voice",
  discipline: "/discipline",
  connect: "/dashboard",
};

function mainPluginRoute(p: LinkPluginInfo): string | null {
  const pages = p.contributes?.pages ?? [];
  if (!pages.length) return null;
  const byTab = (tab: string | undefined) => (tab ? pages.find((pg) => pg.tab === tab) : undefined);
  const page =
    byTab(p.id) ?? byTab(p.contributes?.landing) ?? byTab(p.contributes?.nav?.[0]?.tab) ?? pages[0];
  return page?.route ?? null;
}

/** Route of `plugin/<id>[/<page>]` per the spec's page resolution rule. */
export function pluginPageRoute(
  pluginId: string,
  page: string | null | undefined,
  plugins: LinkPluginInfo[] | null | undefined,
): { route: string; query: string } {
  const pg = page?.trim() || "";
  if (!plugins) {
    // No registry at hand (e.g. UI before plugins.list): best-effort guess.
    return { route: pg ? `/${enc(pluginId)}/${enc(pg)}` : `/${enc(pluginId)}`, query: "" };
  }
  const plugin = plugins.find((p) => p.id === pluginId);
  const loaded =
    plugin &&
    plugin.enabled !== false &&
    (plugin.status === undefined || plugin.status === "loaded");
  const main = plugin ? mainPluginRoute(plugin) : null;
  if (!plugin || !loaded || !main) {
    return { route: "/plugins", query: queryString({ plugin: pluginId }) };
  }
  if (!pg) return { route: main, query: "" };
  const pages = plugin.contributes?.pages ?? [];
  const hit = pages.find(
    (p) => p.tab === pg || p.tab === `${pluginId}-${pg}` || p.route.endsWith(`/${pg}`),
  );
  if (hit) return { route: hit.route, query: "" };
  return { route: main, query: queryString({ section: pg }) };
}

/** Merge query strings; keys already set by `primary` win. */
function mergeQuery(primary: string, extra: string): string {
  if (!extra) return primary;
  if (!primary) return extra;
  const out = new URLSearchParams(primary);
  for (const [k, v] of new URLSearchParams(extra)) if (!out.has(k)) out.append(k, v);
  return out.toString();
}

function safeRoute(route: string): string {
  if (!route.startsWith("/") || route.startsWith("//") || route.startsWith("/\\")) {
    return "/dashboard";
  }
  return route;
}

/**
 * Web UI route (path + query, always starting with a single `/`) for a deep
 * link — the "Web fallback route" column of DEEP-LINKS.md. Does not include the
 * control-UI base path.
 */
export function webRouteForDeepLink(link: string, opts: WebRouteOpts = {}): string {
  const { segments, query } = parseDeepLink(link);
  const [head = "", a, b] = segments;
  let route: string;
  let q = "";
  const idQ = (key: string, v: string | undefined) => (v ? queryString({ [key]: v }) : "");
  switch (head) {
    case "chat":
      route = "/webchat";
      q = idQ("session", a);
      break;
    case "activity":
      if (a === "session" && b) {
        route = "/webchat";
        q = idQ("session", b);
      } else route = "/activity";
      break;
    case "board":
      route = "/projects";
      q = a === "task" ? idQ("task", b) : "";
      break;
    case "documents":
      route = a ? `/documents/${enc(a)}` : "/documents";
      break;
    case "runs":
      route = "/reviews";
      q = idQ("run", a);
      break;
    case "approvals":
      route = "/autonomy";
      q = mergeQuery(queryString({ view: "approvals" }), idQ("approval", a));
      break;
    case "goals":
      route = "/autonomy";
      q = mergeQuery(queryString({ view: "goals" }), idQ("goal", a));
      break;
    case "phases":
      route = "/autonomy";
      q = mergeQuery(queryString({ view: "phases" }), idQ("phase", a));
      break;
    case "scheduled":
      route = "/autonomy";
      q = mergeQuery(queryString({ view: "scheduled" }), idQ("task", a));
      break;
    case "plugin": {
      if (!a) {
        route = "/plugins";
        break;
      }
      const r = pluginPageRoute(a, b, opts.plugins);
      route = r.route;
      q = r.query;
      break;
    }
    case "plugins":
      route = "/plugins";
      q = idQ("plugin", a);
      break;
    case "learn":
      // infinibot://learn/<trackId>[/<walkthroughId>] — the walkthrough auto-starts.
      route = a ? `/learn/${enc(a)}` : "/learn";
      q = idQ("walkthrough", b);
      break;
    case "web":
      route = `/${segments.slice(1).map(enc).join("/")}`;
      if (route === "/") route = "/dashboard";
      break;
    default:
      route = SCREEN_ROUTES[head] ?? `/${segments.map(enc).join("/")}`;
  }
  // `route` may already carry a query (plugin main routes rarely do).
  const qi = route.indexOf("?");
  if (qi >= 0) {
    q = mergeQuery(route.slice(qi + 1), q);
    route = route.slice(0, qi);
  }
  return withQuery(safeRoute(route), mergeQuery(q, query));
}

// ── public base + opener URLs ───────────────────────────────────────────────

function normalizeBase(raw: string | undefined | null): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v.replace(/^ws(s?):\/\//i, "http$1://"));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = u.pathname.replace(/\/+$/, "").replace(/\/federation$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

export type PublicBaseOpts = {
  env?: Record<string, string | undefined>;
  /** Tailscale MagicDNS host (resolved asynchronously by the gateway). */
  tailnetHost?: string | null;
  /** Gateway HTTP port (for the plain tailnet form). */
  port?: number;
};

/**
 * `<public-base>` per the spec: INFINIBOT_PUBLIC_URL → federation.publicUrl →
 * Tailscale host (https when serve/funnel, else http(s)://host:port) → null.
 */
export function resolvePublicBaseUrl(
  cfg: InfinibotConfig | null | undefined,
  opts: PublicBaseOpts = {},
): string | null {
  const env =
    opts.env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  const fromEnv = normalizeBase(env.INFINIBOT_PUBLIC_URL);
  if (fromEnv) return fromEnv;
  const fromFed = normalizeBase(cfg?.federation?.publicUrl);
  if (fromFed) return fromFed;
  const host = opts.tailnetHost?.trim().replace(/\.$/, "");
  if (!host) return null;
  const mode = resolveTailscaleMode(cfg?.gateway?.tailscale);
  if (mode === "serve" || mode === "funnel") return `https://${host}`;
  // Plain tailnet access only works when the gateway listens beyond loopback.
  if (cfg?.gateway?.bind === "loopback") return null;
  const scheme = cfg?.gateway?.tls?.enabled ? "https" : "http";
  const port = opts.port ?? cfg?.gateway?.port ?? 18789;
  return `${scheme}://${host}:${port}`;
}

/** `${base}/m/<path>` for a deep link. */
export function webOpenerUrl(deepLink: string, base: string): string {
  return `${base.replace(/\/+$/, "")}/m/${deepLinkPath(deepLink)}`;
}

/** Deep link + https opener (null without a public base) for a target or link. */
export function linkPair(
  targetOrLink: DeepLinkTarget | string,
  cfg: InfinibotConfig | null | undefined,
  opts: PublicBaseOpts & { base?: string | null } = {},
): LinkPair {
  const deepLink =
    typeof targetOrLink === "string"
      ? (normalizeDeepLink(targetOrLink) ?? `${DEEP_LINK_SCHEME}`)
      : buildDeepLink(targetOrLink);
  const base = opts.base !== undefined ? opts.base : resolvePublicBaseUrl(cfg, opts);
  return { deepLink, webUrl: base ? webOpenerUrl(deepLink, base) : null };
}

/**
 * Whether Telegram will accept `url` in an inline URL button (it refuses
 * localhost / bare IPs / non-http schemes with BUTTON_URL_INVALID). Callers
 * fall back to a plain "Open: <url>" text line otherwise.
 */
export function isTelegramButtonUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname;
  if (!h.includes(".") || h === "localhost" || /^[\d.]+$/.test(h) || h.includes(":")) return false;
  return true;
}
