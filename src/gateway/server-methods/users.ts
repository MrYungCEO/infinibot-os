/**
 * Gateway Methods — User Management
 *
 * RPC surface for the multi-user system. The dashboard uses these to
 * list/create/edit/delete users, switch language + context preferences,
 * toggle agent gating, and gate page access.
 *
 * Auth model:
 *   • The gateway's main auth check (token/password) still runs at the
 *     WebSocket layer — this module just maps the *authenticated*
 *     connection back to its owning user account using the gateway
 *     password it presented at connect.
 *   • Admin-only mutations (create/delete users, change other users'
 *     credentials) are gated by the `requireAdmin()` helper.
 *   • Self-mutations (a user changing their own language/context/
 *     password) succeed even when the connecting user isn't admin.
 */

import { resolveStateDir } from "../../config/paths.js";
import { getUserStore, type User } from "../../users/store.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────

function store() {
  return getUserStore(resolveStateDir());
}

/** Pull the gateway password the current connection authenticated with. */
function callerPassword(opts: GatewayRequestHandlerOptions): string | null {
  const pw = opts.client?.connect.auth?.password;
  return typeof pw === "string" && pw.length > 0 ? pw : null;
}

/**
 * Resolve the user behind the current connection. Returns null when the
 * gateway is running in legacy single-tenant mode (no users created yet)
 * or when the connecting password doesn't match any user — in that case
 * we treat the caller as the implicit admin.
 */
function callerUser(opts: GatewayRequestHandlerOptions): User | null {
  const pw = callerPassword(opts);
  if (!pw) return null;
  return store().findByGatewayPassword(pw);
}

/**
 * The gateway's "implicit admin" rule: when no users exist, every
 * connection is admin. As soon as the first user is created, the
 * implicit-admin path closes and only users with role="admin" can do
 * admin things.
 */
function isAdmin(opts: GatewayRequestHandlerOptions): boolean {
  if (store().count() === 0) return true;
  const u = callerUser(opts);
  return u?.role === "admin";
}

function requireAdmin(opts: GatewayRequestHandlerOptions): boolean {
  if (isAdmin(opts)) return true;
  opts.respond(false, undefined, {
    code: "FORBIDDEN",
    message: "admin role required",
  });
  return false;
}

/** Strip secrets so the wire never carries hashes or gateway passwords. */
function sanitize(user: User): Omit<User, never> & { gatewayPasswordSet: boolean } {
  return { ...user, gatewayPasswordSet: !!user };
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function asStrArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

// ── Handlers ────────────────────────────────────────────────────

export const usersHandlers: GatewayRequestHandlers = {
  /** List all users. Admin only. */
  "users.list": async (opts) => {
    if (!requireAdmin(opts)) return;
    try {
      const users = store().list().map(sanitize);
      opts.respond(true, { users });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Get a specific user. Admin can read anyone; non-admin can only
   * read themselves. Without explicit `id` returns the caller.
   */
  "users.get": async (opts) => {
    try {
      const id = asStr(opts.params?.id);
      const me = callerUser(opts);
      if (!id) {
        if (!me) {
          opts.respond(false, undefined, { code: "NOT_FOUND", message: "no user bound to this connection" });
          return;
        }
        opts.respond(true, { user: sanitize(me) });
        return;
      }
      if (!isAdmin(opts) && me?.id !== id) {
        opts.respond(false, undefined, { code: "FORBIDDEN", message: "cannot read other users" });
        return;
      }
      const user = store().get(id);
      if (!user) {
        opts.respond(false, undefined, { code: "NOT_FOUND", message: "user not found" });
        return;
      }
      opts.respond(true, { user: sanitize(user) });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Return the user behind this connection (or null when none). */
  "users.me": async (opts) => {
    try {
      const me = callerUser(opts);
      const adminCount = store().list().filter((u) => u.role === "admin").length;
      opts.respond(true, {
        user: me ? sanitize(me) : null,
        // The dashboard uses these to show first-run / single-tenant UI.
        userCount: store().count(),
        adminCount,
        implicitAdmin: store().count() === 0,
      });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Login by username/email + password. Returns the user record AND
   * the gateway password to feed into the WebSocket reconnect — that's
   * the password the connection layer will validate.
   */
  "users.authenticate": async (opts) => {
    try {
      const login = asStr(opts.params?.login)?.trim();
      const password = asStr(opts.params?.password);
      if (!login || !password) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "login and password required" });
        return;
      }
      const result = store().authenticate(login, password);
      if (!result) {
        opts.respond(false, undefined, { code: "UNAUTHORIZED", message: "invalid credentials" });
        return;
      }
      opts.respond(true, {
        user: sanitize(result.user),
        gatewayPassword: result.gatewayPassword,
      });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Admin-only — create a user. Auto-creates the user's home directory. */
  "users.create": async (opts) => {
    if (!requireAdmin(opts)) return;
    try {
      const username = asStr(opts.params?.username)?.trim();
      const email = asStr(opts.params?.email);
      const password = asStr(opts.params?.password);
      const gatewayPassword = asStr(opts.params?.gatewayPassword);
      const role = asStr(opts.params?.role) === "admin" ? "admin" : "user";

      if (!username) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "username required" });
        return;
      }
      if (!password) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "password required" });
        return;
      }
      if (!gatewayPassword) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "gatewayPassword required" });
        return;
      }

      const user = store().create({
        username,
        email: email ?? null,
        password,
        gatewayPassword,
        role,
        language: asStr(opts.params?.language) ?? "en",
        context: asStr(opts.params?.context) ?? "",
        homeDir: asStr(opts.params?.homeDir),
        agentGatingEnabled: asBool(opts.params?.agentGatingEnabled) ?? false,
        allowedDirs: asStrArr(opts.params?.allowedDirs) ?? [],
        allowedPages: asStrArr(opts.params?.allowedPages) ?? [],
      });
      // Auto-enroll the new user in every walkthrough flagged
      // `defaultForNewUsers: true`. The Welcome walkthrough is one of
      // those — every fresh account lands on /learn with a guided tour
      // already assigned. Failures are non-fatal; the admin can run
      // `learn.admin.autoEnroll` later to back-fill.
      try {
        const { autoEnrollUser } = await import("../../learn/store.js");
        const { resolveStateDir } = await import("../../config/paths.js");
        autoEnrollUser(resolveStateDir(), user.id);
      } catch (err) {
        console.warn(`[users.create] auto-enroll failed for ${user.username}:`, err instanceof Error ? err.message : String(err));
      }
      opts.respond(true, { user: sanitize(user) });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Update a user. Admins can update anyone. Non-admins can only update
   * themselves AND only the safe fields (language, context, password).
   */
  "users.update": async (opts) => {
    try {
      const id = asStr(opts.params?.id);
      if (!id) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const me = callerUser(opts);
      const targetIsSelf = me?.id === id;
      const admin = isAdmin(opts);
      if (!admin && !targetIsSelf) {
        opts.respond(false, undefined, { code: "FORBIDDEN", message: "cannot edit other users" });
        return;
      }

      const patch: Parameters<ReturnType<typeof store>["update"]>[1] = {};

      if (admin) {
        if (opts.params?.username !== undefined) patch.username = asStr(opts.params.username);
        if (opts.params?.email !== undefined) patch.email = asStr(opts.params.email) ?? null;
        if (opts.params?.role !== undefined) patch.role = asStr(opts.params.role) === "admin" ? "admin" : "user";
        if (opts.params?.gatewayPassword !== undefined) patch.gatewayPassword = asStr(opts.params.gatewayPassword);
        if (opts.params?.homeDir !== undefined) patch.homeDir = asStr(opts.params.homeDir);
        if (opts.params?.agentGatingEnabled !== undefined) patch.agentGatingEnabled = asBool(opts.params.agentGatingEnabled);
        if (opts.params?.allowedDirs !== undefined) patch.allowedDirs = asStrArr(opts.params.allowedDirs);
        if (opts.params?.allowedPages !== undefined) patch.allowedPages = asStrArr(opts.params.allowedPages);
      }
      // Self-editable fields:
      if (opts.params?.password !== undefined) patch.password = asStr(opts.params.password);
      if (opts.params?.language !== undefined) patch.language = asStr(opts.params.language);
      if (opts.params?.context !== undefined) patch.context = asStr(opts.params.context);

      const user = store().update(id, patch);
      if (!user) {
        opts.respond(false, undefined, { code: "NOT_FOUND", message: "user not found" });
        return;
      }
      opts.respond(true, { user: sanitize(user) });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Admin-only — delete a user. */
  "users.delete": async (opts) => {
    if (!requireAdmin(opts)) return;
    try {
      const id = asStr(opts.params?.id);
      if (!id) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const deleted = store().delete(id);
      // Best-effort cleanup of learn progress so a re-created user with
      // the same id (rare, but possible via testing) doesn't inherit
      // stale completions.
      try {
        const { getLearnStore } = await import("../../learn/store.js");
        const { resolveStateDir } = await import("../../config/paths.js");
        getLearnStore(resolveStateDir()).clearForUser(id);
      } catch { /* swallow — never block delete on cleanup */ }
      opts.respond(true, { deleted });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export default usersHandlers;

/**
 * Re-export so other server-methods modules can resolve the active
 * user without re-implementing the password lookup. Keeps user-context
 * injection (cwd, language, system-prompt prefix) out of every handler.
 */
export function resolveCallerUser(opts: GatewayRequestHandlerOptions): User | null {
  return callerUser(opts);
}
