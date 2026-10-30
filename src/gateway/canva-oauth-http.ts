/**
 * Canva Connect API — OAuth 2.0 PKCE token flow.
 *
 * Endpoints:
 *   GET  /oauth/canva/start    — generate PKCE verifier/challenge, redirect to Canva auth page
 *   GET  /oauth/canva/callback — receive code, exchange for tokens, persist, send postMessage
 *   POST /api/canva/refresh    — refresh access token using stored refresh token
 *
 * Tokens are stored in the auth-profiles store under profileId "canva:default"
 * as a `token` credential with extra fields (refreshToken, displayName) that
 * survive JSON round-trips even though the TypeScript type doesn't declare them.
 *
 * Security notes:
 *   - state is a 24-char random base64url; validated on callback; rejected after 10 min.
 *   - code_verifier uses S256; stored only in the in-memory map (never on disk).
 *   - Tokens are NEVER logged. Masks applied in any UI display.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../agents/auth-profiles.js";

const log = createSubsystemLogger("canva-oauth");

const START_ROUTE = "/oauth/canva/start";
const CALLBACK_ROUTE = "/oauth/canva/callback";
const REFRESH_ROUTE = "/api/canva/refresh";

// Default scopes for Canva Connect API
const DEFAULT_SCOPES = [
  "design:content:read",
  "design:content:write",
  "design:meta:read",
  "asset:read",
  "asset:write",
  "brandtemplate:content:read",
  "brandtemplate:meta:read",
  "profile:read",
].join(" ");

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type PkceState = {
  codeVerifier: string;
  expiresAt: number;
};

// In-memory store: state → PKCE data. Never written to disk.
const pkceStore = new Map<string, PkceState>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, val] of pkceStore.entries()) {
    if (now >= val.expiresAt) pkceStore.delete(key);
  }
}

function generateCodeVerifier(): string {
  // 64 bytes → 86-char base64url string, well within 43–128 char requirement
  return randomBytes(64).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(18).toString("base64url"); // ~24 chars URL-safe
}

function getEnv() {
  const cfg = loadConfig();
  const port = resolveGatewayPort(cfg);
  const clientId = process.env.CANVA_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.CANVA_OAUTH_CLIENT_SECRET ?? "";
  const redirectUri =
    process.env.CANVA_OAUTH_REDIRECT_URI ?? `http://127.0.0.1:${port}${CALLBACK_ROUTE}`;
  const scopes = process.env.CANVA_OAUTH_SCOPES ?? DEFAULT_SCOPES;
  return { clientId, clientSecret, redirectUri, scopes, port };
}

// ── HTTP handler ─────────────────────────────────────────────

export async function handleCanvaOauthRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (url.pathname === START_ROUTE && req.method === "GET") {
    return handleStart(url, res);
  }
  if (url.pathname === CALLBACK_ROUTE && req.method === "GET") {
    return handleCallback(url, res);
  }
  if (url.pathname === REFRESH_ROUTE && req.method === "POST") {
    return handleRefresh(res);
  }
  return false;
}

// ── /oauth/canva/start ───────────────────────────────────────

function handleStart(_url: URL, res: ServerResponse): boolean {
  sweepExpired();
  const { clientId, redirectUri, scopes } = getEnv();

  if (!clientId) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderPage({
        title: "Canva OAuth not configured",
        message:
          "Set <code>CANVA_OAUTH_CLIENT_ID</code> in your <code>.env</code> to enable OAuth sign-in. " +
          "You can still use a personal access token from the Canva Developer settings.",
        tone: "error",
      }),
    );
    return true;
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pkceStore.set(state, { codeVerifier, expiresAt: Date.now() + STATE_TTL_MS });

  const authUrl = new URL("https://www.canva.com/api/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);

  res.statusCode = 302;
  res.setHeader("Location", authUrl.toString());
  res.end();
  return true;
}

// ── /oauth/canva/callback ────────────────────────────────────

async function handleCallback(url: URL, res: ServerResponse): Promise<boolean> {
  sweepExpired();

  const code = url.searchParams.get("code")?.trim() ?? null;
  const state = url.searchParams.get("state")?.trim() ?? null;
  const error = url.searchParams.get("error")?.trim() ?? null;
  const errorDescription = url.searchParams.get("error_description")?.trim() ?? null;

  if (error) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderPage({
        title: "Authorization failed",
        message: `Canva returned an error: <code>${escapeHtml(error)}</code>${errorDescription ? ` — ${escapeHtml(errorDescription)}` : ""}.`,
        tone: "error",
      }),
    );
    return true;
  }

  if (!code || !state) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderPage({
        title: "Missing parameters",
        message: "The OAuth callback was missing required parameters.",
        tone: "error",
      }),
    );
    return true;
  }

  const pkce = pkceStore.get(state);
  if (!pkce || Date.now() >= pkce.expiresAt) {
    log.warn("canva oauth: unknown or expired state", { state: state.slice(0, 6) + "…" });
    pkceStore.delete(state);
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderPage({
        title: "Session expired",
        message:
          "This authorization session is no longer valid (expired or already used). Return to InfiniBot and try again.",
        tone: "error",
      }),
    );
    return true;
  }

  pkceStore.delete(state);
  const { codeVerifier } = pkce;
  const { clientId, clientSecret, redirectUri } = getEnv();

  // Exchange code for tokens
  let tokenData: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });
    if (clientSecret) {
      body.set("client_secret", clientSecret);
    }

    const tokenRes = await fetch("https://api.canva.com/rest/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => "(unreadable)");
      log.error("canva token exchange failed", { status: tokenRes.status });
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        renderPage({
          title: "Token exchange failed",
          message: `Canva returned HTTP ${tokenRes.status}. Check that your <code>CANVA_OAUTH_CLIENT_ID</code> and redirect URI match what is registered in the Canva developer console. Details: <code>${escapeHtml(text.slice(0, 200))}</code>`,
          tone: "error",
        }),
      );
      return true;
    }

    tokenData = await tokenRes.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("canva token exchange error", { error: msg });
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderPage({
        title: "Token exchange error",
        message: `Network error contacting Canva: ${escapeHtml(msg)}`,
        tone: "error",
      }),
    );
    return true;
  }

  // Fetch user profile
  let userEmail: string | undefined;
  let userDisplayName: string | undefined;
  let userId: string | undefined;
  try {
    const meRes = await fetch("https://api.canva.com/rest/v1/users/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (meRes.ok) {
      const meData = (await meRes.json()) as {
        user?: { email?: string; display_name?: string; id?: string };
      };
      userEmail = meData?.user?.email;
      userDisplayName = meData?.user?.display_name;
      userId = meData?.user?.id;
    }
  } catch {
    // Non-fatal; proceed without user info
  }

  // Persist tokens
  const expiresAt = Date.now() + tokenData.expires_in * 1000;
  persistCanvaTokens({
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt,
    scope: tokenData.scope,
    email: userEmail,
    displayName: userDisplayName,
    userId,
  });

  log.info("canva oauth: tokens persisted", {
    email: userEmail ?? "(unknown)",
    expiresAt: new Date(expiresAt).toISOString(),
  });

  // Return a page that notifies the opener and closes itself
  const displayNameSafe = escapeHtml(userDisplayName ?? userEmail ?? "your Canva account");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(renderSuccessPage({ displayName: displayNameSafe, email: userEmail }));
  return true;
}

// ── /api/canva/refresh ───────────────────────────────────────

async function handleRefresh(res: ServerResponse): Promise<boolean> {
  const store = ensureAuthProfileStore();
  const profile = store.profiles["canva:default"] as any;

  if (!profile || !profile.refreshToken) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: false,
        error: "No refresh token stored. Please re-authenticate via OAuth.",
      }),
    );
    return true;
  }

  const { clientId, clientSecret } = getEnv();

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: profile.refreshToken,
    });
    if (clientSecret) body.set("client_secret", clientSecret);

    const tokenRes = await fetch("https://api.canva.com/rest/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      log.error("canva refresh failed", { status: tokenRes.status });
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: `Canva returned HTTP ${tokenRes.status}` }));
      return true;
    }

    const data = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const expiresAt = Date.now() + data.expires_in * 1000;
    persistCanvaTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? profile.refreshToken,
      expiresAt,
      scope: profile.scope,
      email: profile.email,
      displayName: profile.displayName,
      userId: profile.userId,
    });

    log.info("canva oauth: token refreshed", { expiresAt: new Date(expiresAt).toISOString() });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, expiresAt }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("canva refresh error", { error: msg });
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: msg }));
  }
  return true;
}

// ── Persistence ───────────────────────────────────────────────

function persistCanvaTokens(opts: {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  email?: string;
  displayName?: string;
  userId?: string;
}): void {
  const store = ensureAuthProfileStore();
  // Store as `token` type; extra fields survive JSON round-trips.
  (store.profiles["canva:default"] as any) = {
    type: "token",
    provider: "canva",
    token: opts.accessToken,
    expires: opts.expiresAt,
    ...(opts.email ? { email: opts.email } : {}),
    // Extra fields preserved in JSON, used by getCanvaAccessToken()
    ...(opts.refreshToken ? { refreshToken: opts.refreshToken } : {}),
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
  saveAuthProfileStore(store);
}

// ── Public helper ─────────────────────────────────────────────

/**
 * Returns a valid Canva access token, refreshing proactively if within 5 min of expiry.
 * Returns null if no token is stored.
 */
export async function getCanvaAccessToken(): Promise<string | null> {
  const store = ensureAuthProfileStore();
  const profile = store.profiles["canva:default"] as any;
  if (!profile) return null;

  const token: string | undefined = profile.type === "token" ? profile.token : profile.key;
  if (!token) return null;

  const expires: number | undefined = profile.expires;
  const refreshBuffer = 5 * 60 * 1000; // refresh 5 min before expiry

  if (!expires || Date.now() < expires - refreshBuffer) {
    return token;
  }

  // Token expired or about to expire — try refresh
  if (!profile.refreshToken) {
    return token; // return what we have if no refresh token (PAT / manual token)
  }

  try {
    const { clientId, clientSecret } = getEnv();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: profile.refreshToken,
    });
    if (clientSecret) body.set("client_secret", clientSecret);

    const tokenRes = await fetch("https://api.canva.com/rest/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!tokenRes.ok) return token;

    const data = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    persistCanvaTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? profile.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: profile.scope,
      email: profile.email,
      displayName: profile.displayName,
      userId: profile.userId,
    });

    log.info("canva oauth: proactive token refresh succeeded");
    return data.access_token;
  } catch {
    return token; // fall back to current token on error
  }
}

// ── Utility ───────────────────────────────────────────────────

/** Canonical redirect URI that must be registered in the Canva developer console. */
export function getCanvaOauthRedirectUri(): string {
  return getEnv().redirectUri;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(opts: { title: string; message: string; tone: "ok" | "error" }): string {
  const accent = opts.tone === "ok" ? "#fbbf24" : "#fca5a5";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(opts.title)} · InfiniBot</title>
<style>
  html,body{margin:0;height:100%;background:#0a0a0e;color:#f4f4f5;
    font-family:'Inter',system-ui,-apple-system,sans-serif;}
  body{display:flex;align-items:center;justify-content:center;}
  .card{max-width:460px;padding:36px 32px;border-radius:18px;
    background:linear-gradient(155deg,rgba(255,255,255,.06) 0%,rgba(255,255,255,.02) 60%,rgba(0,0,0,.06) 100%);
    border:1px solid rgba(255,255,255,.08);
    box-shadow:0 32px 80px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.1);
    backdrop-filter:blur(20px) saturate(180%);text-align:center;}
  .dot{width:10px;height:10px;border-radius:50%;background:${accent};
    box-shadow:0 0 18px ${accent};display:inline-block;margin-right:8px;vertical-align:middle;}
  h1{font-size:18px;margin:0 0 14px;font-weight:600;}
  p{color:rgba(245,245,244,.7);font-size:13.5px;line-height:1.6;margin:0;}
  code{background:rgba(255,255,255,.08);padding:1px 6px;border-radius:4px;font-size:12px;}
</style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>${escapeHtml(opts.title)}</h1>
    <p>${opts.message}</p>
  </div>
</body>
</html>`;
}

function renderSuccessPage(opts: { displayName: string; email?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Connected · InfiniBot</title>
<style>
  html,body{margin:0;height:100%;background:#0a0a0e;color:#f4f4f5;
    font-family:'Inter',system-ui,-apple-system,sans-serif;}
  body{display:flex;align-items:center;justify-content:center;}
  .card{max-width:460px;padding:36px 32px;border-radius:18px;
    background:linear-gradient(155deg,rgba(255,255,255,.06) 0%,rgba(255,255,255,.02) 60%,rgba(0,0,0,.06) 100%);
    border:1px solid rgba(255,255,255,.08);
    box-shadow:0 32px 80px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.1);
    backdrop-filter:blur(20px) saturate(180%);text-align:center;}
  .dot{width:10px;height:10px;border-radius:50%;background:#fbbf24;
    box-shadow:0 0 18px #fbbf24;display:inline-block;margin-right:8px;vertical-align:middle;}
  h1{font-size:18px;margin:0 0 14px;font-weight:600;}
  p{color:rgba(245,245,244,.7);font-size:13.5px;line-height:1.6;margin:0;}
</style>
<script>
  // Notify the opener and close this popup.
  (function () {
    try {
      window.opener?.postMessage(
        { type: 'canva:oauth:done', email: ${JSON.stringify(opts.email ?? null)}, displayName: ${JSON.stringify(opts.displayName)} },
        '*'
      );
    } catch (_) {}
    // Close after a brief moment so the user sees the success message.
    setTimeout(function () { window.close(); }, 1800);
  })();
</script>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>Connected</h1>
    <p>InfiniBot is now connected to ${opts.displayName}. You can close this tab.</p>
  </div>
</body>
</html>`;
}
