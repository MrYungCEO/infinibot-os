/**
 * Multi-user workspaces — pre-login HTTP endpoints (all same-origin JSON):
 *
 *   GET  /api/access/status              → { enabled }
 *   POST /api/access/login               { login, password, code? } → { token, expiresAt, user }
 *                                         or 401 { error: "totp_required" } when 2FA is on
 *   GET  /api/access/invite?token=…      → { valid, status, role, workspaces, expiresAt, email }
 *   POST /api/access/signup              { invite, username, password, displayName?, email? } → { token, … }
 *   POST /api/access/logout              Authorization: Bearer <session token>
 *
 * The returned session token (`ibus_…`) is what the client passes as the
 * WebSocket connect `auth.token`. Nothing here issues the gateway password or
 * the owner's HTTP session cookie. Every route answers 404-equivalent
 * `{ error: "multi_user_disabled" }` while auth.multiUser.enabled is off.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { passwordProblem, verifyTotp } from "../access/crypto.js";
import {
  accessStore,
  audit,
  isMultiUserEnabled,
  publicUser,
  sessionTtlMs,
} from "../access/runtime.js";
import { inviteStatus } from "../access/store.js";
import {
  clientKey,
  createFailureLimiter,
  isSameOrigin,
  sendHttpForbidden,
  sendTooManyRequests,
  type HttpAuthContext,
} from "./http-auth.js";

export const ACCESS_PUBLIC_PATHS = [
  "/api/access/status",
  "/api/access/login",
  "/api/access/invite",
  "/api/access/signup",
  "/api/access/logout",
];

const MAX_BODY = 16 * 1024;

// Its own brute-force limiter: a workspace user guessing passwords (or invite
// tokens) must not lock the owner out of the gateway-password login, and vice versa.
export const accessFailureLimiter = createFailureLimiter({
  maxFailures: 10,
  windowMs: 5 * 60_000,
  lockoutMs: 5 * 60_000,
});

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        resolve(v && typeof v === "object" ? (v as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
  return true;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return null;
}

function ipOf(req: IncomingMessage): string | undefined {
  return req.socket?.remoteAddress ?? undefined;
}

export async function handleAccessHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authCtx?: HttpAuthContext,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return false;
  }
  const path = url.pathname;
  if (!ACCESS_PUBLIC_PATHS.includes(path)) return false;

  if (path === "/api/access/status" && req.method === "GET") {
    return json(res, 200, { enabled: isMultiUserEnabled() });
  }
  if (!isMultiUserEnabled()) return json(res, 404, { error: "multi_user_disabled" });

  if (req.method !== "GET" && !isSameOrigin(req)) {
    sendHttpForbidden(res, "cross_origin_request");
    return true;
  }

  const store = accessStore();
  const limiterKey = clientKey(req, authCtx?.trustedProxies);

  // ── Invite lookup (what the signup page shows) ─────────────────────
  if (path === "/api/access/invite" && req.method === "GET") {
    const retry = accessFailureLimiter.check(limiterKey);
    if (retry > 0) return (sendTooManyRequests(res, retry), true);
    const inv = store.findInviteByToken(url.searchParams.get("token") ?? "");
    if (!inv) {
      accessFailureLimiter.fail(limiterKey);
      return json(res, 404, { valid: false, status: "invalid" });
    }
    const status = inviteStatus(inv);
    return json(res, 200, {
      valid: status === "active",
      status,
      role: inv.role,
      email: inv.email,
      expiresAt: inv.expiresAt,
      workspaces: inv.workspaceIds.map((id) => store.getWorkspace(id)?.name).filter(Boolean),
    });
  }

  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  // ── Logout ─────────────────────────────────────────────────────────
  if (path === "/api/access/logout") {
    const token = bearer(req);
    const revoked = token ? store.revokeSessionByToken(token) : false;
    return json(res, 200, { ok: true, revoked });
  }

  const retry = accessFailureLimiter.check(limiterKey);
  if (retry > 0) return (sendTooManyRequests(res, retry), true);
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: "invalid_json" });

  // ── Login ──────────────────────────────────────────────────────────
  if (path === "/api/access/login") {
    const login = typeof body.login === "string" ? body.login.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!login || !password) return json(res, 400, { error: "login_and_password_required" });
    const user = store.getUserByLogin(login);
    const ok = !!user && !user.disabled && store.checkPassword(user.id, password);
    if (!ok) {
      accessFailureLimiter.fail(limiterKey);
      audit(
        store,
        login.slice(0, 64),
        "login",
        null,
        null,
        false,
        user?.disabled ? "disabled" : "bad credentials",
      );
      return json(res, 401, { error: user?.disabled ? "account_disabled" : "invalid_credentials" });
    }
    if (user.totpEnabled) {
      const secret = store.getTotpSecret(user.id);
      if (body.code === undefined || body.code === "")
        return json(res, 401, { error: "totp_required" });
      if (!secret || !verifyTotp(secret, body.code)) {
        accessFailureLimiter.fail(limiterKey);
        audit(store, user.username, "login", null, null, false, "bad 2fa code");
        return json(res, 401, { error: "totp_invalid" });
      }
    }
    accessFailureLimiter.succeed(limiterKey);
    store.pruneExpiredSessions();
    const { token, session } = store.createSession(user.id, sessionTtlMs(), {
      userAgent: req.headers["user-agent"],
      ip: ipOf(req),
    });
    audit(store, user.username, "login", null, null, true, null);
    return json(res, 200, { token, expiresAt: session.expiresAt, user: publicUser(user) });
  }

  // ── Signup from invite ─────────────────────────────────────────────
  if (path === "/api/access/signup") {
    const invite = typeof body.invite === "string" ? body.invite : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = body.password;
    const problem = passwordProblem(password);
    if (!invite) return json(res, 400, { error: "invite_required" });
    if (!username) return json(res, 400, { error: "username_required" });
    if (problem) return json(res, 400, { error: "weak_password", message: problem });
    try {
      const user = store.redeemInvite(invite, {
        username,
        password: password as string,
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        email: typeof body.email === "string" ? body.email : undefined,
      });
      accessFailureLimiter.succeed(limiterKey);
      const { token, session } = store.createSession(user.id, sessionTtlMs(), {
        userAgent: req.headers["user-agent"],
        ip: ipOf(req),
      });
      audit(store, user.username, "signup", null, null, true, `role=${user.role}`);
      return json(res, 200, { token, expiresAt: session.expiresAt, user: publicUser(user) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("invite_")) {
        accessFailureLimiter.fail(limiterKey);
        return json(res, 410, { error: msg });
      }
      return json(res, 400, { error: "signup_failed", message: msg });
    }
  }

  return json(res, 404, { error: "not_found" });
}
