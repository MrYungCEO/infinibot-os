/**
 * Gateway glue for multi-user workspaces: the feature flag, the shared store,
 * session-token resolution at connect time and the per-request access check
 * used by handleGatewayRequest.
 *
 * Everything is inert while `auth.multiUser.enabled` is not true — connect
 * ignores `ibus_` tokens and no client ever carries `access`, so the gateway
 * behaves exactly as the single-owner build.
 */

import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { resolveSharedDir } from "../config/paths.js";
import {
  type AccessContext,
  authorizeUserMethod,
  buildAccessContext,
  type Lookups,
} from "./authz.js";
import { SESSION_TOKEN_PREFIX } from "./crypto.js";
import { type AccessStore, type AccessUser, getAccessStore, PREVIEW_SESSION_TAG } from "./store.js";

export type ClientAccess = {
  userId: string;
  username: string;
  /** Raw session token — re-validated on every request so expiry/revocation bite immediately. */
  sessionToken: string;
  /** Workspace the client is working in (access.workspace.select). */
  workspaceId: string | null;
  /** Admin "preview as user" session: everything read-only. */
  preview: boolean;
};

export const DEFAULT_SESSION_TTL_HOURS = 24 * 7;
export const PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;

export function isMultiUserEnabled(): boolean {
  try {
    return loadConfig().auth?.multiUser?.enabled === true;
  } catch {
    return false;
  }
}

export function sessionTtlMs(): number {
  try {
    const h = loadConfig().auth?.multiUser?.sessionTtlHours;
    if (typeof h === "number" && h > 0) return h * 3600_000;
  } catch {
    /* default */
  }
  return DEFAULT_SESSION_TTL_HOURS * 3600_000;
}

export function accessStoreDir(): string {
  return join(resolveSharedDir(), "access");
}

export function accessStore(): AccessStore {
  return getAccessStore(accessStoreDir());
}

export function looksLikeUserSessionToken(token: unknown): token is string {
  return typeof token === "string" && token.startsWith(SESSION_TOKEN_PREFIX);
}

/** Preview sessions are ordinary sessions whose user_agent is tagged. */
export const PREVIEW_UA_TAG = PREVIEW_SESSION_TAG;

/**
 * Connect-time: turn a user session token into the client's access record.
 * Returns null when multi-user is off, or the token is unknown/expired/disabled.
 */
export function resolveConnectAccess(token: unknown): ClientAccess | null {
  if (!isMultiUserEnabled() || !looksLikeUserSessionToken(token)) return null;
  const hit = accessStore().resolveSession(token);
  if (!hit) return null;
  return {
    userId: hit.user.id,
    username: hit.user.username,
    sessionToken: token,
    workspaceId: null,
    preview: hit.session.userAgent === PREVIEW_UA_TAG,
  };
}

/** Per-request: re-validate the session and build the permission context. */
export function contextForClient(access: ClientAccess): AccessContext | null {
  const store = accessStore();
  const hit = store.resolveSession(access.sessionToken);
  if (!hit || hit.user.id !== access.userId) return null;
  return buildAccessContext(store, hit.user, {
    activeWorkspaceId: access.workspaceId,
    preview: access.preview,
  });
}

/** Read-only lookups the authz rules need, against the owner's stores. */
export const gatewayLookups: Lookups = {
  taskProjectId: async (taskId) => {
    const { getTask } = await import("../databases/kanban-store-ops.js");
    const t = getTask(taskId) as { projectId?: string | null } | null;
    return t?.projectId ?? null;
  },
  documentParents: async () => {
    const { documentsStore } = await import("../documents/service.js");
    const out = new Map<string, string | null>();
    for (const n of documentsStore().tree({ includeDeleted: false })) {
      out.set(n.id, n.parentId ?? null);
    }
    return out;
  },
};

export type RequestAccessResult =
  | { ok: false; message: string }
  | {
      ok: true;
      ctx: AccessContext;
      transform?: (payload: unknown) => unknown;
      after?: (payload: unknown) => void;
    };

/** Central check for one RPC from a workspace user. Audits every decision. */
export async function checkUserRequest(
  access: ClientAccess,
  method: string,
  params: Record<string, unknown>,
): Promise<RequestAccessResult> {
  const store = accessStore();
  const ctx = contextForClient(access);
  if (!ctx) {
    audit(store, access.username, "rpc", method, null, false, "session expired");
    return { ok: false, message: "session expired — sign in again" };
  }
  let decision;
  try {
    decision = await authorizeUserMethod(method, params, store, ctx, gatewayLookups);
  } catch (err) {
    decision = { ok: false as const, reason: `access check failed: ${String(err)}` };
  }
  if (!decision.ok) {
    audit(store, access.username, "rpc", method, targetOf(params), false, decision.reason);
    return { ok: false, message: `forbidden: ${decision.reason}` };
  }
  if (!READ_ONLY_AUDIT_SKIP.test(method)) {
    audit(store, access.username, "rpc", method, targetOf(params), true, null);
  }
  return { ok: true, ctx, transform: decision.transform, after: decision.after };
}

// Allowed reads are frequent and low-value in the log; denials and writes are kept.
const READ_ONLY_AUDIT_SKIP = /\.(list|get|tree|recent|search|history|snapshot|me|status|preview)$/;

function targetOf(params: Record<string, unknown>): string | null {
  for (const k of ["id", "projectId", "sessionKey", "agencyId", "workspaceId", "userId"]) {
    const v = params[k];
    if (typeof v === "string" && v) return `${k}=${v.slice(0, 120)}`;
  }
  return null;
}

let auditCount = 0;
export function audit(
  store: AccessStore,
  actor: string,
  action: string,
  method: string | null,
  target: string | null,
  allowed: boolean,
  detail: string | null,
) {
  try {
    store.audit({ actor, action, method, target, allowed, detail });
    if (++auditCount % 500 === 0) store.pruneAudit();
  } catch {
    /* audit must never break a request */
  }
}

export function publicUser(u: AccessUser) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    allowance: u.allowance,
    disabled: u.disabled,
    totpEnabled: u.totpEnabled,
    createdAt: u.createdAt,
    lastActiveAt: u.lastActiveAt,
    invitedBy: u.invitedBy,
  };
}
