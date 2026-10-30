/**
 * Business hub — public HTTP surface for the business-agency plugin:
 *   GET  /plugins/business-agency/t/s.js                 tracking snippet
 *   POST /plugins/business-agency/t/c                    event collector (CORS)
 *   GET  /plugins/business-agency/t/o?t=<token>          open pixel (GIF)
 *   GET  /plugins/business-agency/t/k?t=<token>          click redirect
 *   GET|POST /plugins/business-agency/u?t=<token>        unsubscribe (RFC 8058 one-click POST)
 *   POST /plugins/business-agency/webhooks/email?provider=<resend|postmark|ses>&s=<secret>
 *
 * The gateway's plugin router matches exact pathnames, so every route is a
 * fixed path and tokens / secrets travel in the query string. Every route is
 * public (`selfAuthHttp`) and authenticates itself: site key + origin
 * allowlist, HMAC-signed tokens, or the webhook secret.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getHubDb, type HubDb } from "./db.js";
import { HUB_HTTP_BASE, type BusinessHubHooks } from "./email/config.js";
import { handleClickToken, handleEmailWebhook, handleOpenToken } from "./email/feedback.js";
import { applyUnsubscribe } from "./email/suppression.js";
import { verifyToken } from "./email/tokens.js";
import { escapeHtml } from "./email/templates.js";
import { ingestEvents } from "./tracking.js";
import { SNIPPET_JS } from "./tracking-snippet.js";
import { coerceString } from "../shared/text/coerce.js";

export type HubHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export type BusinessHubHttpDeps = {
  getDb?: () => HubDb;
  hooks?: BusinessHubHooks;
  now?: () => number;
  /** Collector requests per minute per client IP + site key (default 120). */
  collectPerMinute?: number;
};

export const BUSINESS_HUB_PATHS = {
  snippet: `${HUB_HTTP_BASE}/t/s.js`,
  collect: `${HUB_HTTP_BASE}/t/c`,
  open: `${HUB_HTTP_BASE}/t/o`,
  click: `${HUB_HTTP_BASE}/t/k`,
  unsubscribe: `${HUB_HTTP_BASE}/u`,
  webhooks: `${HUB_HTTP_BASE}/webhooks/email`,
} as const;

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const COLLECT_MAX = 64 * 1024;
const WEBHOOK_MAX = 1024 * 1024;
const FORM_MAX = 8 * 1024;
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const len = Number(req.headers["content-length"] ?? 0);
  if (len > max) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string>,
): void {
  if (res.headersSent) return;
  res.writeHead(status, { ...headers, "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

function html(res: ServerResponse, status: number, title: string, inner: string): void {
  send(
    res,
    status,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#f6f6f4;color:#222;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{background:#fff;padding:32px 36px;border-radius:12px;max-width:440px;box-shadow:0 1px 4px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 12px}button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#222;color:#fff;cursor:pointer}p{margin:0 0 16px}</style></head><body><main>${inner}</main></body></html>`,
    {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": PAGE_CSP,
      "Referrer-Policy": "no-referrer",
    },
  );
}

function clientIp(req: IncomingMessage): string {
  const xff = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")[0]
    ?.trim();
  return xff || req.socket?.remoteAddress || "unknown";
}

function requestOrigin(req: IncomingMessage): string | null {
  const o = req.headers.origin;
  if (typeof o === "string" && o && o !== "null") return o;
  const ref = req.headers.referer;
  if (typeof ref === "string" && ref) {
    try {
      return new URL(ref).origin;
    } catch {
      return null;
    }
  }
  return null;
}

const COUNTRY_HEADERS = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "cloudfront-viewer-country",
  "x-appengine-country",
  "x-country-code",
  "fastly-geo-country-code",
];

function edgeCountry(req: IncomingMessage): string | null {
  for (const h of COUNTRY_HEADERS) {
    const v = req.headers[h];
    if (typeof v === "string" && /^[A-Za-z]{2}$/.test(v.trim())) return v.trim().toUpperCase();
  }
  return null;
}

/** Signed token from `?t=`. */
function tokenFrom(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://hub.local").searchParams.get("t") ?? "";
}

function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers))
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

function maskEmail(e: string): string {
  const [local, domain] = e.split("@");
  if (!domain) return "your address";
  return `${local.slice(0, 1)}${"•".repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
}

/** Simple fixed-window limiter (in memory, keyed by IP + site key). */
function createLimiter(perMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string, now: number): boolean => {
    if (hits.size > 20_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    const cur = hits.get(key);
    if (!cur || cur.reset <= now) {
      hits.set(key, { n: 1, reset: now + 60_000 });
      return true;
    }
    cur.n++;
    return cur.n <= perMinute;
  };
}

/**
 * Handlers keyed by exact pathname — register each with
 * `api.registerHttpRoute({ path, handler })` and list the paths in the
 * manifest's `contributes.http` and `contributes.selfAuthHttp`.
 */
export function createBusinessHubHttpHandlers(
  deps: BusinessHubHttpDeps = {},
): Record<string, HubHttpHandler> {
  const db = () => (deps.getDb ?? (() => getHubDb()))();
  const now = () => deps.now?.() ?? Date.now();
  const limit = createLimiter(deps.collectPerMinute ?? 120);
  const P = BUSINESS_HUB_PATHS;

  const snippet: HubHttpHandler = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD")
      return send(res, 405, "", { Allow: "GET, HEAD" });
    send(res, 200, req.method === "HEAD" ? "" : SNIPPET_JS, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
  };

  const collect: HubHttpHandler = async (req, res) => {
    const origin = requestOrigin(req);
    if (req.method === "OPTIONS") {
      return send(res, 204, "", {
        "Access-Control-Allow-Origin":
          typeof req.headers.origin === "string" ? req.headers.origin : "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      });
    }
    if (req.method !== "POST") return send(res, 405, "", { Allow: "POST, OPTIONS" });
    const body = await readBody(req, COLLECT_MAX);
    if (!body) return send(res, 413, "payload too large", { "Content-Type": "text/plain" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return send(res, 400, "invalid json", { "Content-Type": "text/plain" });
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { events?: unknown }).events)
        ? (parsed as { events: unknown[] }).events
        : [parsed];
    const keys = new Set(
      list.map((e) => (e && typeof e === "object" ? coerceString((e as { k?: unknown }).k) : "")),
    );
    const ip = clientIp(req);
    const t = now();
    for (const k of keys)
      if (!limit(`${ip}|${k.slice(0, 80)}`, t))
        return send(res, 429, "rate limited", {
          "Content-Type": "text/plain",
          "Retry-After": "60",
        });
    const result = ingestEvents(db(), origin, parsed, {
      country: edgeCountry(req),
      now: t,
      hooks: deps.hooks,
    });
    const cors: Record<string, string> = { Vary: "Origin" };
    if (result.allowedOrigin && req.headers.origin)
      cors["Access-Control-Allow-Origin"] = result.allowedOrigin;
    if (result.accepted > 0) return send(res, 204, "", cors);
    send(res, 400, JSON.stringify({ errors: result.errors.slice(0, 5) }), {
      ...cors,
      "Content-Type": "application/json",
    });
  };

  const open: HubHttpHandler = async (req, res) => {
    if (req.method === "GET") {
      try {
        handleOpenToken(db(), tokenFrom(req), now());
      } catch {
        /* the pixel is always served */
      }
    }
    send(res, 200, req.method === "HEAD" ? "" : GIF, {
      "Content-Type": "image/gif",
      "Content-Length": String(GIF.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      Expires: "0",
    });
  };

  const click: HubHttpHandler = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD")
      return send(res, 405, "", { Allow: "GET, HEAD" });
    const token = tokenFrom(req);
    const d = db();
    // HEAD (link scanners) redirects without counting.
    const target =
      req.method === "HEAD"
        ? (() => {
            const t = verifyToken(d, token, "k", now());
            return t ? { location: t.u } : null;
          })()
        : handleClickToken(d, token, now(), deps.hooks);
    if (!target)
      return html(
        res,
        404,
        "Link not found",
        "<h1>Link not found</h1><p>This link is invalid or has expired.</p>",
      );
    send(res, 302, "", {
      Location: target.location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
  };

  const unsubscribe: HubHttpHandler = async (req, res) => {
    const d = db();
    const t = verifyToken(d, tokenFrom(req), "u", now());
    if (!t)
      return html(
        res,
        400,
        "Invalid link",
        "<h1>Invalid unsubscribe link</h1><p>This link is invalid. Reply to the email and ask to be removed.</p>",
      );
    if (req.method === "POST") {
      // RFC 8058 one-click ("List-Unsubscribe=One-Click") or the confirm form below.
      await readBody(req, FORM_MAX);
      applyUnsubscribe(d, {
        email: t.e,
        sendId: t.s ?? null,
        contactId: t.c ?? null,
        source: "link",
      });
      return html(
        res,
        200,
        "Unsubscribed",
        `<h1>You're unsubscribed</h1><p>${escapeHtml(maskEmail(t.e))} will not receive further emails from us.</p>`,
      );
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return send(res, 405, "", { Allow: "GET, POST" });
    // GET never unsubscribes by itself: mail scanners prefetch links.
    html(
      res,
      200,
      "Unsubscribe",
      `<h1>Unsubscribe?</h1><p>Stop emails to ${escapeHtml(maskEmail(t.e))}.</p><form method="post"><input type="hidden" name="confirm" value="1"><button type="submit">Unsubscribe</button></form>`,
    );
  };

  const webhooks: HubHttpHandler = async (req, res) => {
    if (req.method !== "POST") return send(res, 405, "", { Allow: "POST" });
    const url = new URL(req.url ?? "/", "http://hub.local");
    const provider = url.searchParams.get("provider") ?? "";
    const secret = url.searchParams.get("s") ?? "";
    const body = await readBody(req, WEBHOOK_MAX);
    if (!body) return send(res, 413, "payload too large", { "Content-Type": "text/plain" });
    const out = await handleEmailWebhook(
      db(),
      provider,
      secret,
      headerMap(req),
      body.toString("utf8"),
      now(),
    );
    send(res, out.status, JSON.stringify(out.body), {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
  };

  return {
    [P.snippet]: snippet,
    [P.collect]: collect,
    [P.open]: open,
    [P.click]: click,
    [P.unsubscribe]: unsubscribe,
    [P.webhooks]: webhooks,
  };
}

/** Convenience dispatcher: `(req,res) => handled?` over the whole map. */
export function createBusinessHubDispatcher(deps: BusinessHubHttpDeps = {}) {
  const handlers = createBusinessHubHttpHandlers(deps);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = new URL(req.url ?? "/", "http://hub.local").pathname;
    const h = Object.hasOwn(handlers, pathname) ? handlers[pathname] : null;
    if (!h) return false;
    await h(req, res);
    return true;
  };
}
