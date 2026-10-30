/**
 * Gateway HTTP security layer — one gate in front of every HTTP route.
 *
 * Every route requires the gateway credential except the reviewed public
 * allowlist in {@link classifyHttpRoute}. A request is authenticated by one of:
 *   - `Authorization: Bearer <token|password>` (or X-InfiniBot-Token /
 *     X-InfiniBot-Password), checked with the live gateway auth config;
 *   - `Authorization: Bearer <deviceToken>` + `X-InfiniBot-Device-Id` for
 *     paired devices that never learned the shared secret;
 *   - a Clerk session token in SaaS mode;
 *   - a verified Tailscale identity when `gateway.auth.allowTailscale` is on;
 *   - the httpOnly `SameSite=Strict` session cookie minted by
 *     `POST /api/auth/session` after one of the above.
 *
 * There is deliberately no loopback trust: cloudflared, `tailscale serve`,
 * nginx and friends make every remote caller look like 127.0.0.1.
 *
 * Cross-site defences:
 *   - Host allowlist (DNS rebinding): IP literals, localhost, *.ts.net, this
 *     machine's hostname, the bind host, the live tunnel host and
 *     INFINIBOT_HTTP_ALLOWED_HOSTS.
 *   - No `Access-Control-Allow-Origin: *` on authenticated routes; CORS is
 *     granted only to origins listed in INFINIBOT_HTTP_ALLOWED_ORIGINS or
 *     INFINIBOT_UI_ORIGINS (hosted control UI).
 *   - Cookie-authenticated state-changing requests must carry the
 *     `X-InfiniBot-Request` header and a non-"simple" content type, so a
 *     cross-site form or `fetch(..., {mode:"no-cors"})` can never use the
 *     ambient cookie. Header credentials cannot be sent cross-site at all.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { resolveSharedDir } from "../config/paths.js";
import {
  authorizeGatewayConnect,
  resolveLiveGatewayAuth,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import { resolveGatewayClientIp } from "./net.js";

export const CSRF_HEADER = "x-infinibot-request";
export const DEVICE_ID_HEADER = "x-infinibot-device-id";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_VERSION = "v1";

// ── Route classification ────────────────────────────────────────────────────

export type HttpRouteClass =
  /** No credential needed — own verification (webhooks, OAuth callbacks) or intentionally public. */
  | "public"
  /** Control-UI shell, static bundles and static pages: public GET/HEAD, Host-checked. */
  | "static"
  /** Everything else: gateway credential required. */
  | "protected";

/** Exact public paths (any method unless noted in the comment). */
const PUBLIC_EXACT = new Set<string>([
  // Install scripts (curl | sh bootstrap for satellites).
  "/install",
  "/install.sh",
  "/install.ps1",
  // Login + session bootstrap — these ARE the credential check (rate-limited).
  "/api/users/login",
  "/api/auth/session",
  // Multi-user workspaces: login / invite signup (inert unless auth.multiUser.enabled).
  "/api/access/status",
  "/api/access/login",
  "/api/access/invite",
  "/api/access/signup",
  "/api/access/logout",
  // OAuth provider redirects land here from the provider, not from our UI.
  "/gmail/oauth/callback",
  "/calendar/oauth/callback",
  "/oauth/canva/callback",
  // Signed/tokened webhooks (Loops verifies its own signature).
  "/loops/webhook",
  // Liveness probes (no secrets: running flag + model names only).
  "/api/ollama/health",
  "/api/kokoro/health",
]);

/** Public path prefixes. */
const PUBLIC_PREFIXES = [
  // Landing-page analytics + form submit — intentionally public, rate-limited,
  // CORS-permissive (server-pages-public.ts).
  "/api/pages/",
  "/install/",
];

/**
 * Static shells: the SPA itself (index + hashed assets), quickstart page,
 * mobile web export, glasses page, canvas-host/A2UI (loaded by native node
 * WebViews that have no cookie). They carry no secrets; every data call they
 * make goes through a protected route.
 */
const STATIC_PREFIXES = ["/mobile-web", "/quickstart", "/glasses/live", "/__infinibot__/"];

/** Paths that are never the control-UI SPA, even for GET. */
const NON_SPA_PREFIXES = [
  "/api/",
  "/tools/",
  "/v1/",
  "/backup/",
  "/media/",
  "/plugins/",
  "/canvas/",
  "/oauth/",
  "/hooks",
];

export function classifyHttpRoute(method: string, pathname: string): HttpRouteClass {
  if (PUBLIC_EXACT.has(pathname)) return "public";
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return "public";
  const isRead = method === "GET" || method === "HEAD";
  if (!isRead) return "protected";
  if (STATIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) return "static";
  if (NON_SPA_PREFIXES.some((p) => pathname.startsWith(p))) return "protected";
  // Anything else under GET is the control-UI shell / its static assets
  // (SPA fallback serves index.html for client-side routes).
  return "static";
}

// ── Host allowlist (DNS rebinding) ──────────────────────────────────────────

export type HostAllowlistOptions = {
  bindHost?: string;
  extraHosts?: string[];
  env?: NodeJS.ProcessEnv;
  hostname?: string;
};

function stripPort(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }
  const colons = host.split(":").length - 1;
  if (colons === 1) return host.slice(0, host.indexOf(":"));
  return host; // bare IPv6 or no port
}

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":") && /^[0-9a-f:.]+$/i.test(host);
}

function matchesHostPattern(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === "*") return true;
  if (p.startsWith("*.")) return host.endsWith(p.slice(1)) || host === p.slice(2);
  return host === stripPort(p);
}

export function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * DNS rebinding needs an attacker-controlled *name* in the Host header, so IP
 * literals are always safe; names must be ones this gateway is known by.
 */
export function isAllowedHostHeader(
  hostHeader: string | undefined,
  opts: HostAllowlistOptions = {},
): boolean {
  const env = opts.env ?? process.env;
  // HTTP/1.0 clients may omit Host; nothing to rebind.
  if (!hostHeader || !hostHeader.trim()) return true;
  const host = stripPort(hostHeader);
  if (!host) return false;
  if (isIpLiteral(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".ts.net")) return true;
  const machine = (opts.hostname ?? os.hostname()).trim().toLowerCase();
  if (machine && (host === machine || host === `${machine}.local` || host === `${machine}.lan`)) {
    return true;
  }
  const fly = env.FLY_APP_NAME?.trim().toLowerCase();
  if (fly && (host === `${fly}.fly.dev` || host.endsWith(".internal"))) return true;
  const patterns = [
    ...(opts.bindHost ? [opts.bindHost] : []),
    ...(opts.extraHosts ?? []),
    ...splitList(env.INFINIBOT_HTTP_ALLOWED_HOSTS),
  ];
  return patterns.some((p) => matchesHostPattern(host, p));
}

// ── Origin / CORS ───────────────────────────────────────────────────────────

/** True when an Origin header names the same host the request was sent to. */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = getHeader(req, "origin");
  if (!origin) return true;
  if (origin === "null") return false;
  try {
    const o = new URL(origin);
    const host = (getHeader(req, "x-forwarded-host") ?? getHeader(req, "host") ?? "").toLowerCase();
    return o.host.toLowerCase() === host.split(",")[0]!.trim();
  } catch {
    return false;
  }
}

export function isAllowedCorsOrigin(origin: string | undefined, env = process.env): boolean {
  if (!origin) return false;
  // INFINIBOT_UI_ORIGINS: the hosted control UI's static origin (fleet tenant
  // Machines get it from the orchestrator) — same trust as the explicit list.
  const allowed = [
    ...splitList(env.INFINIBOT_HTTP_ALLOWED_ORIGINS),
    ...splitList(env.INFINIBOT_UI_ORIGINS),
  ].map((o) => o.replace(/\/$/, ""));
  return allowed.includes(origin.replace(/\/$/, ""));
}

/**
 * Remove wildcard CORS that individual handlers still emit. Allowed origins
 * (INFINIBOT_HTTP_ALLOWED_ORIGINS) get their origin reflected instead.
 */
export function enforceNoWildcardCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = getHeader(req, "origin");
  const reflect = isAllowedCorsOrigin(origin) ? origin : undefined;
  const rewrite = (value: unknown) => (reflect ? reflect : value === "*" ? undefined : value);
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    if (name.toLowerCase() === "access-control-allow-origin") {
      const next = rewrite(value);
      if (next === undefined) return res;
      return origSetHeader(name, next as string);
    }
    return origSetHeader(name, value);
  }) as typeof res.setHeader;
  const origWriteHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  res.writeHead = ((...args: unknown[]) => {
    const headersIdx = typeof args[1] === "string" ? 2 : 1;
    const headers = args[headersIdx];
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        if (k.toLowerCase() === "access-control-allow-origin") {
          const next = rewrite(v);
          if (next !== undefined) copy[k] = next;
        } else {
          copy[k] = v;
        }
      }
      args[headersIdx] = copy;
    }
    if (reflect) {
      origSetHeader("Access-Control-Allow-Credentials", "true");
      origSetHeader("Vary", "Origin");
    }
    return origWriteHead(...args);
  }) as typeof res.writeHead;
  if (reflect) {
    origSetHeader("Access-Control-Allow-Origin", reflect);
    origSetHeader("Access-Control-Allow-Credentials", "true");
    origSetHeader("Vary", "Origin");
  }
}

/** Answer a CORS preflight for protected routes. Only allowlisted origins get a grant. */
export function handleProtectedPreflight(req: IncomingMessage, res: ServerResponse): void {
  const origin = getHeader(req, "origin");
  if (isAllowedCorsOrigin(origin)) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin!,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": `authorization, content-type, ${CSRF_HEADER}, ${DEVICE_ID_HEADER}, x-infinibot-session-key, x-infinibot-agent-id`,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
  } else {
    res.writeHead(204, { Vary: "Origin" });
  }
  res.end();
}

// ── Session cookie ──────────────────────────────────────────────────────────

let cachedSessionKey: Buffer | null = null;

function sessionKeyPath(env = process.env): string {
  return path.join(resolveSharedDir(env), "credentials", "http-session.key");
}

export function getSessionSigningKey(env = process.env): Buffer {
  if (cachedSessionKey) return cachedSessionKey;
  const file = sessionKeyPath(env);
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) {
      cachedSessionKey = existing;
      return existing;
    }
  } catch {
    // create below
  }
  const key = randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key, { mode: 0o600 });
  } catch {
    // Unwritable state dir: sessions just won't survive a restart.
  }
  cachedSessionKey = key;
  return key;
}

/** Test hook. */
export function resetSessionSigningKeyForTest(key?: Buffer): void {
  cachedSessionKey = key ?? null;
}

/**
 * Sessions are bound to the current shared secret, so rotating the gateway
 * token/password invalidates every outstanding cookie.
 */
function credentialFingerprint(auth: ResolvedGatewayAuth): string {
  const secret = auth.mode === "password" ? (auth.password ?? "") : (auth.token ?? "");
  return createHash("sha256").update(`${auth.mode}:${secret}`).digest("base64url").slice(0, 16);
}

function sign(payload: string, auth: ResolvedGatewayAuth): string {
  return createHmac("sha256", getSessionSigningKey())
    .update(`${payload}.${credentialFingerprint(auth)}`)
    .digest("base64url");
}

export function mintSessionValue(auth: ResolvedGatewayAuth, nowMs = Date.now()): string {
  const exp = Math.floor((nowMs + SESSION_TTL_MS) / 1000);
  const nonce = randomBytes(9).toString("base64url");
  const payload = `${SESSION_VERSION}.${exp}.${nonce}`;
  return `${payload}.${sign(payload, auth)}`;
}

export function verifySessionValue(
  value: string | undefined,
  auth: ResolvedGatewayAuth,
  nowMs = Date.now(),
): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  const payload = parts.slice(0, 3).join(".");
  const expected = Buffer.from(sign(payload, auth));
  const given = Buffer.from(parts[3] ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Cookies ignore ports, so each gateway port gets its own cookie name. */
export function sessionCookieName(port: number | undefined): string {
  return `infinibot_session_${port ?? 0}`;
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = getHeader(req, "cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted) return true;
  return (getHeader(req, "x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";
}

function buildSessionCookie(req: IncomingMessage, name: string, value: string, maxAgeSec: number) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecureRequest(req)) attrs.push("Secure");
  return attrs.join("; ");
}

// ── Failure rate limiting ───────────────────────────────────────────────────

export type FailureLimiter = {
  /** Returns retry-after seconds when the client is currently locked out. */
  check: (key: string, nowMs?: number) => number;
  fail: (key: string, nowMs?: number) => void;
  succeed: (key: string) => void;
};

export function createFailureLimiter(opts: {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
}): FailureLimiter {
  const entries = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();
  const prune = (now: number) => {
    if (entries.size < 1000) return;
    for (const [k, v] of entries) {
      if (v.lockedUntil < now && now - v.firstAt > opts.windowMs) entries.delete(k);
    }
  };
  return {
    check(key, nowMs = Date.now()) {
      const e = entries.get(key);
      if (!e || e.lockedUntil <= nowMs) return 0;
      return Math.ceil((e.lockedUntil - nowMs) / 1000);
    },
    fail(key, nowMs = Date.now()) {
      prune(nowMs);
      const e = entries.get(key);
      if (!e || nowMs - e.firstAt > opts.windowMs) {
        entries.set(key, { count: 1, firstAt: nowMs, lockedUntil: 0 });
        return;
      }
      e.count += 1;
      if (e.count >= opts.maxFailures) {
        e.lockedUntil = nowMs + opts.lockoutMs;
        e.count = 0;
        e.firstAt = nowMs;
      }
    },
    succeed(key) {
      entries.delete(key);
    },
  };
}

/** Shared by login, session bootstrap and bad Bearer attempts on any route. */
export const httpAuthFailureLimiter = createFailureLimiter({
  maxFailures: 10,
  windowMs: 5 * 60_000,
  lockoutMs: 5 * 60_000,
});

export function clientKey(req: IncomingMessage, trustedProxies?: string[]): string {
  return (
    resolveGatewayClientIp({
      remoteAddr: req.socket?.remoteAddress ?? "",
      forwardedFor: getHeader(req, "x-forwarded-for"),
      realIp: getHeader(req, "x-real-ip"),
      trustedProxies,
    }) ??
    req.socket?.remoteAddress ??
    "unknown"
  );
}

export function sendTooManyRequests(res: ServerResponse, retryAfterSec: number): void {
  res.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": String(retryAfterSec),
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error: "too_many_attempts", retryAfterSec }));
}

// ── Authentication ──────────────────────────────────────────────────────────

export type HttpAuthVia = "bearer" | "device" | "clerk" | "tailscale" | "cookie";

export type HttpAuthResult =
  | { ok: true; via: HttpAuthVia }
  | { ok: false; reason: string; presentedCredential: boolean };

export type HttpAuthDeps = {
  verifyDeviceToken?: (p: {
    deviceId: string;
    token: string;
    role: string;
    scopes: string[];
  }) => Promise<{ ok: boolean }>;
  isSaasMode?: () => boolean;
  verifyClerkToken?: (token: string) => Promise<unknown>;
  tailscaleWhois?: Parameters<typeof authorizeGatewayConnect>[0]["tailscaleWhois"];
};

export type HttpAuthContext = {
  /** Startup auth snapshot; the live on-disk value is re-read per request. */
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  port?: number;
  /** Disable the live re-read (tests). */
  staticAuth?: boolean;
  deps?: HttpAuthDeps;
};

export function resolveEffectiveAuth(ctx: HttpAuthContext): ResolvedGatewayAuth {
  return ctx.staticAuth ? ctx.auth : resolveLiveGatewayAuth(ctx.auth);
}

function headerCredential(req: IncomingMessage): string | undefined {
  return (
    (getBearerToken(req) ??
      getHeader(req, "x-infinibot-token")?.trim() ??
      getHeader(req, "x-infinibot-password")?.trim() ??
      getHeader(req, "x-gateway-token")?.trim() ??
      undefined) ||
    undefined
  );
}

async function loadDeviceVerifier(deps?: HttpAuthDeps) {
  if (deps?.verifyDeviceToken) return deps.verifyDeviceToken;
  const mod = await import("../infra/device-pairing.js");
  return mod.verifyDeviceToken;
}

async function loadSaas(deps?: HttpAuthDeps) {
  if (deps?.isSaasMode && deps.verifyClerkToken) {
    return { isSaasMode: deps.isSaasMode, verifyClerkToken: deps.verifyClerkToken };
  }
  const [cfg, fleet] = await Promise.all([
    import("../saas/config.js"),
    import("../saas/fleet-tenant.js"),
  ]);
  return {
    isSaasMode: deps?.isSaasMode ?? cfg.isSaasMode,
    // On a hosted fleet Machine only the pinned tenant's Clerk users pass.
    verifyClerkToken: deps?.verifyClerkToken ?? fleet.verifyClerkForThisGateway,
  };
}

/** Authenticate using header credentials / tailscale only (no cookie). */
export async function authenticateCredentials(
  req: IncomingMessage,
  ctx: HttpAuthContext,
  body?: { token?: string; password?: string; deviceId?: string; deviceToken?: string },
): Promise<HttpAuthResult> {
  const auth = resolveEffectiveAuth(ctx);
  const presented = headerCredential(req) ?? body?.token ?? body?.password;
  const deviceId = getHeader(req, DEVICE_ID_HEADER)?.trim() || body?.deviceId;
  const deviceToken = body?.deviceToken ?? (deviceId ? presented : undefined);

  const shared = await authorizeGatewayConnect({
    auth,
    connectAuth: presented ? { token: presented, password: presented } : null,
    req,
    trustedProxies: ctx.trustedProxies,
    tailscaleWhois: ctx.deps?.tailscaleWhois,
  });
  if (shared.ok) {
    return { ok: true, via: shared.method === "tailscale" ? "tailscale" : "bearer" };
  }

  if (deviceId && deviceToken) {
    try {
      const verify = await loadDeviceVerifier(ctx.deps);
      const check = await verify({ deviceId, token: deviceToken, role: "operator", scopes: [] });
      if (check.ok) return { ok: true, via: "device" };
    } catch {
      // fall through
    }
  }

  if (presented) {
    try {
      const saas = await loadSaas(ctx.deps);
      if (saas.isSaasMode() && (await saas.verifyClerkToken(presented))) {
        return { ok: true, via: "clerk" };
      }
    } catch {
      // fall through
    }
  }

  return {
    ok: false,
    reason: shared.reason ?? "unauthorized",
    presentedCredential: Boolean(presented || deviceToken),
  };
}

export async function authenticateHttpRequest(
  req: IncomingMessage,
  ctx: HttpAuthContext,
): Promise<HttpAuthResult> {
  const creds = await authenticateCredentials(req, ctx);
  if (creds.ok) return creds;
  const cookie = readCookie(req, sessionCookieName(ctx.port));
  if (cookie && verifySessionValue(cookie, resolveEffectiveAuth(ctx))) {
    return { ok: true, via: "cookie" };
  }
  return creds;
}

const SIMPLE_CONTENT_TYPES = [
  "text/plain",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
];

/**
 * CSRF rule for cookie-authenticated state-changing requests. Returns an
 * error string when the request must be rejected.
 */
export function checkCsrf(req: IncomingMessage, via: HttpAuthVia): string | null {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (!isSameOrigin(req) && !isAllowedCorsOrigin(getHeader(req, "origin"))) {
    return "cross_origin_request";
  }
  if (via !== "cookie") return null;
  if (!getHeader(req, CSRF_HEADER)) return "missing_csrf_header";
  const ct = (getHeader(req, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  // With the custom header present the browser has already preflighted any
  // cross-origin request, so multipart uploads are fine here; plain-text and
  // urlencoded bodies are never produced by first-party code.
  if (ct && SIMPLE_CONTENT_TYPES.slice(0, 2).includes(ct)) return "unsupported_content_type";
  return null;
}

export function sendHttpUnauthorized(res: ServerResponse, reason = "unauthorized"): void {
  res.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Bearer realm="infinibot"',
  });
  res.end(JSON.stringify({ error: { message: "Unauthorized", type: "unauthorized", reason } }));
}

export function sendHttpForbidden(res: ServerResponse, reason: string): void {
  res.writeHead(403, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error: { message: "Forbidden", type: "forbidden", reason } }));
}

// ── /api/auth/session ───────────────────────────────────────────────────────

async function readSmallJson(
  req: IncomingMessage,
  maxBytes = 16 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) throw new Error("payload too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function setSessionCookie(req: IncomingMessage, res: ServerResponse, ctx: HttpAuthContext) {
  const value = mintSessionValue(resolveEffectiveAuth(ctx));
  res.setHeader(
    "Set-Cookie",
    buildSessionCookie(req, sessionCookieName(ctx.port), value, Math.floor(SESSION_TTL_MS / 1000)),
  );
}

/**
 * `POST /api/auth/session` — exchange a credential (headers or JSON body
 * `{token|password|deviceId+deviceToken}`) for the httpOnly session cookie
 * that `<img>`, `<iframe>`, `<audio>`, EventSource and downloads need.
 * `GET` reports whether the current cookie/credential is valid.
 * `DELETE` clears the cookie.
 */
export async function handleAuthSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpAuthContext,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/auth/session") return false;
  const method = (req.method ?? "GET").toUpperCase();
  const json = (status: number, body: Record<string, unknown>) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };

  if (method === "OPTIONS") {
    handleProtectedPreflight(req, res);
    return true;
  }
  if (method === "GET") {
    const result = await authenticateHttpRequest(req, ctx);
    json(result.ok ? 200 : 401, { ok: result.ok, via: result.ok ? result.via : undefined });
    return true;
  }
  if (method === "DELETE") {
    res.setHeader("Set-Cookie", buildSessionCookie(req, sessionCookieName(ctx.port), "", 0));
    json(200, { ok: true });
    return true;
  }
  if (method !== "POST") {
    res.setHeader("Allow", "GET, POST, DELETE");
    json(405, { error: "method_not_allowed" });
    return true;
  }
  if (!isSameOrigin(req) && !isAllowedCorsOrigin(getHeader(req, "origin"))) {
    sendHttpForbidden(res, "cross_origin_request");
    return true;
  }

  const key = clientKey(req, ctx.trustedProxies);
  const retry = httpAuthFailureLimiter.check(key);
  if (retry > 0) {
    sendTooManyRequests(res, retry);
    return true;
  }

  let body: Record<string, unknown> = {};
  try {
    body = await readSmallJson(req);
  } catch {
    json(400, { error: "invalid_json" });
    return true;
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const result = await authenticateCredentials(req, ctx, {
    token: str(body.token),
    password: str(body.password),
    deviceId: str(body.deviceId),
    deviceToken: str(body.deviceToken),
  });
  if (!result.ok) {
    // A still-valid cookie refreshes itself.
    const cookie = readCookie(req, sessionCookieName(ctx.port));
    if (cookie && verifySessionValue(cookie, resolveEffectiveAuth(ctx))) {
      setSessionCookie(req, res, ctx);
      json(200, { ok: true, via: "cookie" });
      return true;
    }
    if (result.presentedCredential) httpAuthFailureLimiter.fail(key);
    sendHttpUnauthorized(res, result.reason);
    return true;
  }
  httpAuthFailureLimiter.succeed(key);
  setSessionCookie(req, res, ctx);
  json(200, { ok: true, via: result.via });
  return true;
}

/**
 * For handlers that used to carry their own loopback-or-bearer check. Inside
 * the gateway the central gate has already run (`preAuthorized`); direct
 * callers (tests, embedders) must present a credential — there is no
 * loopback shortcut. Writes the 401 itself and returns false on failure.
 */
export async function authorizeHandlerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth?: ResolvedGatewayAuth; trustedProxies?: string[]; preAuthorized?: boolean },
): Promise<boolean> {
  if (opts.preAuthorized) return true;
  if (!opts.auth) {
    sendHttpUnauthorized(res, "auth_not_configured");
    return false;
  }
  const result = await authenticateCredentials(req, {
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    staticAuth: true,
  });
  if (!result.ok) {
    sendHttpUnauthorized(res, result.reason);
    return false;
  }
  return true;
}

/**
 * Header for in-process callers that hit the gateway's own HTTP routes
 * (headless renders, self-tests). There is no loopback exemption, so they
 * present the configured shared secret like any other client.
 */
export async function resolveSelfCallAuthHeaders(): Promise<Record<string, string>> {
  try {
    const [{ loadConfig }, { resolveGatewayAuth }] = await Promise.all([
      import("../config/config.js"),
      import("./auth.js"),
    ]);
    const cfg = loadConfig();
    const auth = resolveGatewayAuth({
      authConfig: cfg.gateway?.auth,
      tailscaleMode: cfg.gateway?.tailscale?.mode,
    });
    const secret = auth.mode === "password" ? auth.password : auth.token;
    return secret ? { Authorization: `Bearer ${secret}` } : {};
  } catch {
    return {};
  }
}
