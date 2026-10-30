/**
 * /gmail/oauth/callback — landing endpoint for Google's OAuth redirect.
 *
 * Flow (replaces the deprecated urn:ietf:wg:oauth:2.0:oob "copy-the-code"
 * pattern Google retired in late 2022):
 *
 *   1. UI calls `gmail.oauth.startSession` and gets a fresh `state` id.
 *   2. UI opens https://accounts.google.com/o/oauth2/v2/auth?...
 *      &redirect_uri=<gateway>/gmail/oauth/callback&state=<id>
 *   3. Google redirects the user back here. We park `code` keyed by `state`
 *      in an in-memory map (5-min TTL) and render a small "you can close
 *      this tab" page so the user knows it worked.
 *   4. UI polls `gmail.oauth.pollCode { sessionId }` and, once it sees
 *      the code, exchanges it for tokens client-side and calls
 *      `gmail.accounts.add`.
 *
 * Why a server-side hop rather than reading the code from
 * window.location: Google never sends the user's browser to the UI's
 * origin — the redirect goes to whatever the OAuth client is configured
 * with. Plumbing the code through the gateway's HTTP server keeps the
 * loopback redirect "Desktop app" OAuth clients accept without
 * pre-registration.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/paths.js";

const ROUTE = "/gmail/oauth/callback";
const CALENDAR_ROUTE = "/calendar/oauth/callback";
const SESSION_TTL_MS = 5 * 60 * 1000;

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Canonical Gmail OAuth scopes — the SINGLE source of truth for both the
 * consent request (`gmail.oauth.authUrl` / `gmail.oauth.config`) and the UI.
 * Matches what the Gmail feature actually exercises:
 *   - gmail.modify → read + label/star/archive/trash/mark-read (everything
 *     except send and permanent delete)
 *   - gmail.send   → send / reply / draft
 *   - gmail.labels → create/delete labels
 *   - userinfo.email → resolve the connected account's address for the pill
 */
export const GMAIL_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

/**
 * Build the full Google consent URL server-side so the confidential-client
 * OAuth parameters (endpoint, scopes, offline access, forced consent) have one
 * authoritative definition instead of being hand-assembled in the browser.
 * `access_type=offline` + `prompt=consent` guarantee a refresh_token is issued;
 * `include_granted_scopes=true` makes incremental re-consent additive.
 */
export function buildGoogleAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const q = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: (params.scopes ?? GMAIL_OAUTH_SCOPES).join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: params.state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${q.toString()}`;
}

type PendingCode = { code: string; receivedAt: number };
const pending = new Map<string, PendingCode>();
const sessions = new Map<string, number>(); // sessionId -> createdAt

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, p] of pending.entries()) {
    if (now - p.receivedAt > SESSION_TTL_MS) pending.delete(id);
  }
  for (const [id, createdAt] of sessions.entries()) {
    if (now - createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function createGmailOauthSession(): string {
  sweepExpired();
  const id = randomBytes(16).toString("hex");
  sessions.set(id, Date.now());
  return id;
}

export function consumePendingGmailCode(sessionId: string): string | null {
  sweepExpired();
  const entry = pending.get(sessionId);
  if (!entry) return null;
  pending.delete(sessionId);
  return entry.code;
}

/**
 * Canonical redirect URL the user should register in Google Cloud Console
 * (for "Web application" OAuth clients). "Desktop app" clients on the
 * loopback host don't require it to be pre-registered, but showing it lets
 * the UI work for both client types.
 */
export function getGmailOauthRedirectUrl(opts?: { hostOverride?: string }): string {
  const cfg = loadConfig();
  const port = resolveGatewayPort(cfg);
  const host = opts?.hostOverride?.trim() || "127.0.0.1";
  return `http://${host}:${port}${ROUTE}`;
}

/**
 * Same loopback OAuth callback, but published under `/calendar/oauth/callback`
 * so the Schedule page can show a URL that reads as "calendar" to the
 * operator. Both paths land in the same session map, so the gateway code
 * doesn't need to know which subsystem requested the OAuth dance.
 */
export function getCalendarOauthRedirectUrl(opts?: { hostOverride?: string }): string {
  const cfg = loadConfig();
  const port = resolveGatewayPort(cfg);
  const host = opts?.hostOverride?.trim() || "127.0.0.1";
  return `http://${host}:${port}${CALENDAR_ROUTE}`;
}

export async function handleGmailOauthCallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);
  // Accept both /gmail/oauth/callback (historical) and
  // /calendar/oauth/callback (added so the Calendar integration page
  // can show a name-matched URL). The session store is shared, so it
  // doesn't matter which path Google bounces through.
  const isGmail = url.pathname === ROUTE;
  const isCalendar = url.pathname === CALENDAR_ROUTE;
  if (!isGmail && !isCalendar) return false;
  const surface = isCalendar ? "calendar" : "gmail";

  const code = url.searchParams.get("code")?.trim() ?? null;
  const state = url.searchParams.get("state")?.trim() ?? null;
  const error = url.searchParams.get("error")?.trim() ?? null;

  if (error) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderPage({
        title: "Authorization failed",
        message: `Google returned an error: ${escapeHtml(error)}.`,
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
        message:
          "The OAuth callback was missing the <code>code</code> or <code>state</code> parameter.",
        tone: "error",
      }),
    );
    return true;
  }

  sweepExpired();
  if (!sessions.has(state)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderPage({
        title: "Session expired",
        message:
          "This authorization session is no longer active. Return to the Emails page and try again.",
        tone: "error",
      }),
    );
    return true;
  }

  pending.set(state, { code, receivedAt: Date.now() });
  sessions.delete(state);

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    renderPage({
      title: "Account connected",
      message: `InfiniBot received the authorization code. You can close this tab — the ${surface === "calendar" ? "Schedule" : "Emails"} page will finish setup automatically.`,
      tone: "ok",
    }),
  );
  return true;
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
  html, body { margin: 0; height: 100%; background: #0a0a0e; color: #f4f4f5;
    font-family: 'Inter', system-ui, -apple-system, sans-serif; }
  body { display: flex; align-items: center; justify-content: center; }
  .card {
    max-width: 460px; padding: 36px 32px; border-radius: 18px;
    background: linear-gradient(155deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 60%, rgba(0,0,0,0.06) 100%);
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 32px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.1);
    backdrop-filter: blur(20px) saturate(180%);
    text-align: center;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: ${accent};
    box-shadow: 0 0 18px ${accent}; display: inline-block; margin-right: 8px; vertical-align: middle; }
  h1 { font-size: 18px; margin: 0 0 14px; font-weight: 600; }
  p  { color: rgba(245,245,244,0.7); font-size: 13.5px; line-height: 1.6; margin: 0; }
  code { background: rgba(255,255,255,0.08); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
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
