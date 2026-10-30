/**
 * POST /api/users/login
 *
 * Validates the submitted password against the gateway password, then
 * finds or creates a profile for the given username. On success it sets the
 * httpOnly HTTP session cookie; it never echoes the gateway password back
 * (the client already typed it and reconnects the WebSocket with it). Also
 * switches the active profile so the reloaded session lands in the correct
 * per-user data namespace. Failed attempts are rate-limited per client IP.
 *
 * Auth model:
 *   - Any username is valid as long as the password matches the gateway
 *     password (universal credential).
 *   - First login auto-creates the user's profile; subsequent logins
 *     reuse the existing profile (matched by lowercased name).
 *   - No registration step — just log in.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import { resolveGatewayAuth } from "./auth.js";
import {
  clientKey,
  httpAuthFailureLimiter,
  isSameOrigin,
  sendHttpForbidden,
  sendTooManyRequests,
  setSessionCookie,
  type HttpAuthContext,
} from "./http-auth.js";
import { isSaasMode } from "../saas/config.js";
import { resolveStateDir } from "../config/paths.js";
import { getUserStore } from "../users/store.js";
import {
  listProfiles,
  createProfile,
  switchProfile,
  stampProfileCreatedAt,
} from "../users/profiles.js";

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * True when this install has multi-user accounts: more than the implicit
 * default profile, or any row in the user-account store. Failures read as
 * "no accounts" — the login screen then falls back to the gateway password,
 * which always works.
 */
export function userAccountsExist(): boolean {
  try {
    if (listProfiles().profiles.length > 1) return true;
  } catch {
    /* fall through */
  }
  try {
    return getUserStore(resolveStateDir()).count() > 0;
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function handleUsersLoginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authCtx?: HttpAuthContext,
): Promise<boolean> {
  let pathname: string;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    pathname = url.pathname;
  } catch {
    return false;
  }

  if (pathname !== "/api/users/login") return false;

  // No CORS: login is same-origin only (a cross-site page must not be able
  // to use this as a password oracle).
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // SaaS mode: password login is retired — authentication is via Clerk. Reject
  // so nothing falls back to the local gateway-password flow.
  if (isSaasMode()) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "clerk_auth_required", message: "Sign in with Clerk." }));
    return true;
  }

  // GET — pre-auth probe for the login screen: do any user accounts exist?
  // Only a boolean leaves the box (no names/counts). When false the UI shows
  // just the gateway-password field and skips the "Sign in as a user" mode.
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ accountsExist: userAccountsExist() }));
    return true;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET, POST" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  if (!isSameOrigin(req)) {
    sendHttpForbidden(res, "cross_origin_request");
    return true;
  }

  const limiterKey = clientKey(req, authCtx?.trustedProxies);
  const retryAfter = httpAuthFailureLimiter.check(limiterKey);
  if (retryAfter > 0) {
    sendTooManyRequests(res, retryAfter);
    return true;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };

  function json(status: number, body: Record<string, unknown>): true {
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
    return true;
  }

  // Parse body
  let login: string;
  let password: string;
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    login = (typeof parsed.login === "string" ? parsed.login : "").trim();
    password = typeof parsed.password === "string" ? parsed.password : "";
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!login) return json(400, { error: "login_required" });
  if (!password) return json(400, { error: "password_required" });

  // Read the gateway password from live config (not the startup snapshot)
  const cfg = loadConfig();
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth });
  const gatewayPassword = auth.password;

  if (!gatewayPassword) {
    return json(503, { error: "gateway_password_not_configured" });
  }

  // Validate password against gateway password
  if (!safeEqual(password, gatewayPassword)) {
    httpAuthFailureLimiter.fail(limiterKey);
    return json(401, { error: "invalid_credentials" });
  }
  httpAuthFailureLimiter.succeed(limiterKey);

  // Find or create a profile for this username (matched case-insensitively)
  const { profiles } = listProfiles();
  let profile = profiles.find((p) => p.name.toLowerCase() === login.toLowerCase());

  if (!profile) {
    try {
      profile = createProfile({
        name: login,
        avatar: "👤",
        theme: "dark",
      });
      stampProfileCreatedAt(profile.id, Date.now());
    } catch (err) {
      // createProfile throws if name already exists (race condition) — retry lookup
      const { profiles: updated } = listProfiles();
      profile = updated.find((p) => p.name.toLowerCase() === login.toLowerCase());
      if (!profile) {
        return json(500, { error: "profile_create_failed", message: String(err) });
      }
    }
  }

  // Switch the active profile to this user's profile
  try {
    switchProfile(profile.id);
  } catch (err) {
    return json(500, { error: "profile_switch_failed", message: String(err) });
  }

  if (authCtx) setSessionCookie(req, res, authCtx);
  return json(200, {
    ok: true,
    profileId: profile.id,
    username: login,
  });
}
