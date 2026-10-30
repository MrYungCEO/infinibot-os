/**
 * Multi-user workspaces — access-management RPCs (`access.*`).
 *
 * Callers:
 *   - the owner (gateway password / token / device): full control;
 *   - a workspace user with role `admin`: manages members/viewers, invites,
 *     workspaces and the matrix, but cannot create or edit admins and cannot
 *     grant Secure Mode (both owner-only);
 *   - any workspace user: the self-service methods (me, select workspace,
 *     password, 2FA, logout) — gated in src/access/authz.ts SELF_METHODS.
 *
 * Authorization for non-owner callers already happened in the central check
 * (handleGatewayRequest → checkUserRequest); the extra owner-only rules here
 * are about WHAT an admin may change, not whether they may call.
 */

import { randomBytes } from "node:crypto";
import { loadConfig } from "../../config/config.js";
import {
  type AccessContext,
  allowedIds,
  buildAccessContext,
  hasFeature,
  isOwnSessionKey,
  workspacesWith,
} from "../../access/authz.js";
import { newTotpSecret, passwordProblem, totpUri, verifyTotp } from "../../access/crypto.js";
import {
  type Allowance,
  FEATURES,
  isUserRole,
  RESOURCE_ACTIONS,
  RESOURCE_TYPES,
  ROLE_DEFAULTS,
  type ResourceType,
  sanitizeAllowance,
  sanitizeMatrix,
  type UserRole,
} from "../../access/policy.js";
import {
  accessStore,
  audit,
  contextForClient,
  isMultiUserEnabled,
  PREVIEW_SESSION_TTL_MS,
  PREVIEW_UA_TAG,
  publicUser,
} from "../../access/runtime.js";
import { type AccessInvite, type AccessStore, inviteStatus } from "../../access/store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { coerceString } from "../../shared/text/coerce.js";

type Caller =
  | { kind: "owner"; label: string }
  | { kind: "user"; label: string; ctx: AccessContext };

function caller(opts: GatewayRequestHandlerOptions): Caller | null {
  const access = opts.client?.access;
  if (!access) return { kind: "owner", label: "owner" };
  const ctx = contextForClient(access);
  if (!ctx) return null;
  return { kind: "user", label: ctx.user.username, ctx };
}

function fail(opts: GatewayRequestHandlerOptions, message: string) {
  opts.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function s(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
}

/** Admin callers can't hand out Secure Mode; only the owner can. */
function clampAllowance(c: Caller, raw: unknown): Allowance {
  const a = sanitizeAllowance(raw);
  if (c.kind !== "owner" && a.features && "secure" in a.features) delete a.features.secure;
  return a;
}

function canManageRole(c: Caller, role: UserRole): boolean {
  return c.kind === "owner" || role !== "admin";
}

function permsMatrixShape() {
  return {
    resourceTypes: RESOURCE_TYPES,
    actions: RESOURCE_ACTIONS,
    features: FEATURES,
    roles: ["admin", "member", "viewer"],
    defaults: ROLE_DEFAULTS,
  };
}

export function inviteUrl(token: string, origin?: string): string {
  let base = "";
  try {
    base = loadConfig().auth?.multiUser?.publicBaseUrl?.trim() ?? "";
  } catch {
    /* fall back */
  }
  if (!base && origin && /^https?:\/\/[^\s]+$/.test(origin)) base = origin;
  base = base.replace(/\/+$/, "");
  return `${base}/?signup=${encodeURIComponent(token)}`;
}

function wireInvite(inv: AccessInvite, store: AccessStore) {
  return {
    ...inv,
    status: inviteStatus(inv),
    workspaces: inv.workspaceIds.map((id) => ({
      id,
      name: store.getWorkspace(id)?.name ?? "(deleted)",
    })),
  };
}

function overview(store: AccessStore) {
  const members = store.listMembers();
  const assignments = store.listAssignments();
  return {
    enabled: isMultiUserEnabled(),
    users: store.listUsers().map((u) => ({
      ...publicUser(u),
      workspaces: members
        .filter((m) => m.userId === u.id)
        .map((m) => ({ id: m.workspaceId, role: m.role, allowance: m.allowance })),
    })),
    invites: store.listInvites().map((i) => wireInvite(i, store)),
    workspaces: store.listWorkspaces().map((w) => ({
      ...w,
      members: members
        .filter((m) => m.workspaceId === w.id)
        .map((m) => ({ userId: m.userId, role: m.role, allowance: m.allowance })),
      assignments: assignments
        .filter((a) => a.workspaceId === w.id)
        .map((a) => ({ resourceType: a.resourceType, resourceId: a.resourceId })),
    })),
    matrix: store.getRoleMatrix(),
    shape: permsMatrixShape(),
  };
}

function broadcastChanged(opts: GatewayRequestHandlerOptions) {
  try {
    opts.context.broadcast("access.changed", { ts: Date.now() }, { dropIfSlow: true });
  } catch {
    /* best effort */
  }
}

/** Calls a core RPC as the owner and returns its payload (for resource pickers). */
async function callOwnerRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const { coreGatewayHandlers } = await import("../server-methods.js");
  const handler = coreGatewayHandlers[method];
  if (!handler) return null;
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v: unknown) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    setTimeout(() => finish(null), 15_000).unref?.();
    void Promise.resolve(
      handler({
        req: { type: "req", id: `access-${method}`, method, params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond: (ok: boolean, payload?: unknown) => finish(ok ? payload : null),
        context: undefined as never,
      } as unknown as GatewayRequestHandlerOptions),
    ).catch(() => finish(null));
  });
}

type ResourceItem = { id: string; title: string; kind?: string; parentId?: string | null };

function arrayIn(payload: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    for (const k of keys) {
      const v = (payload as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

async function listResourceCandidates(type: ResourceType): Promise<ResourceItem[]> {
  const t = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : fallback);
  switch (type) {
    case "projects":
      return arrayIn(await callOwnerRpc("kanban.projects.list", {}), ["projects"]).map((p) => ({
        id: String(p.id),
        title: t(p.name ?? p.title, String(p.id)),
      }));
    case "documents":
      return arrayIn(await callOwnerRpc("documents.tree", {}), ["nodes"]).map((n) => ({
        id: String(n.id),
        title: t(n.title, "Untitled"),
        kind: coerceString(n.kind, "doc"),
        parentId: (n.parentId as string | null) ?? null,
      }));
    case "reports":
      return arrayIn(await callOwnerRpc("reports.list", { limit: 500 }), ["reports"]).map((r) => ({
        id: String(r.id),
        title: t(r.title, String(r.id)),
        kind: typeof r.kind === "string" ? r.kind : undefined,
      }));
    case "agents":
      return arrayIn(await callOwnerRpc("agents.list", {}), ["agents"]).map((a) => ({
        id: String(a.id),
        title: t(a.name ?? (a.identity as Record<string, unknown> | undefined)?.name, String(a.id)),
      }));
    default:
      return [];
  }
}

/** What a user would see — permissions per workspace + the visible records. */
async function previewFor(store: AccessStore, userId: string) {
  const user = store.getUser(userId);
  if (!user) return null;
  const ctx = buildAccessContext(store, user);
  const visible: Partial<Record<ResourceType, ResourceItem[]>> = {};
  for (const type of ["projects", "documents", "reports", "agents"] as ResourceType[]) {
    if (!workspacesWith(ctx, type, "view").length) {
      visible[type] = [];
      continue;
    }
    const ids = allowedIds(store, ctx, type, "view");
    const all = await listResourceCandidates(type);
    if (type === "documents") {
      const parent = new Map(all.map((d) => [d.id, d.parentId ?? null]));
      visible[type] = all.filter((d) => {
        let cur: string | null | undefined = d.id;
        const seen = new Set<string>();
        while (cur && !seen.has(cur)) {
          if (ids.has(cur)) return true;
          seen.add(cur);
          cur = parent.get(cur);
        }
        return false;
      });
    } else {
      visible[type] = all.filter((r) => ids.has(r.id));
    }
  }
  return {
    user: publicUser(user),
    base: ctx.base,
    workspaces: ctx.workspaces.map((w) => ({
      id: w.workspace.id,
      name: w.workspace.name,
      role: w.role,
      perms: w.perms,
    })),
    features: Object.fromEntries(FEATURES.map((f) => [f, hasFeature(ctx, f)])),
    visible,
  };
}

function requireUserSelf(opts: GatewayRequestHandlerOptions) {
  const c = caller(opts);
  if (!c) {
    fail(opts, "session expired — sign in again");
    return null;
  }
  if (c.kind !== "user") {
    fail(
      opts,
      "only workspace users have an account here (the owner signs in with the gateway password)",
    );
    return null;
  }
  return c;
}

export const accessHandlers: GatewayRequestHandlers = {
  // ── Self-service ────────────────────────────────────────────────────

  "access.me": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired — sign in again");
    if (c.kind === "owner") {
      opts.respond(true, {
        enabled: isMultiUserEnabled(),
        owner: true,
        isAdmin: true,
        role: "owner",
      });
      return;
    }
    const { ctx } = c;
    opts.respond(true, {
      enabled: true,
      owner: false,
      isAdmin: ctx.user.role === "admin" && !ctx.preview,
      preview: ctx.preview,
      role: ctx.user.role,
      user: publicUser(ctx.user),
      base: ctx.base,
      features: Object.fromEntries(FEATURES.map((f) => [f, hasFeature(ctx, f)])),
      workspaces: ctx.workspaces.map((w) => ({
        id: w.workspace.id,
        name: w.workspace.name,
        color: w.workspace.color,
        agencyId: w.workspace.agencyId,
        role: w.role,
        perms: w.perms,
      })),
      activeWorkspaceId: ctx.activeWorkspaceId,
      sessionPrefix: `mu-${ctx.user.id}`,
    });
  },

  "access.workspace.select": (opts) => {
    const c = requireUserSelf(opts);
    if (!c) return;
    const id = s(opts.params, "workspaceId") ?? null;
    if (id && !c.ctx.workspaces.some((w) => w.workspace.id === id)) {
      return fail(opts, "not a member of that workspace");
    }
    if (opts.client?.access) opts.client.access.workspaceId = id;
    opts.respond(true, { activeWorkspaceId: id });
  },

  "access.logout": (opts) => {
    const access = opts.client?.access;
    if (!access) return fail(opts, "the owner session has no user login to end");
    accessStore().revokeSessionByToken(access.sessionToken);
    audit(accessStore(), access.username, "logout", "access.logout", null, true, null);
    opts.respond(true, { ok: true });
  },

  "access.password.change": (opts) => {
    const c = requireUserSelf(opts);
    if (!c) return;
    const store = accessStore();
    const current = typeof opts.params.current === "string" ? opts.params.current : "";
    const next = opts.params.next;
    if (!store.checkPassword(c.ctx.user.id, current))
      return fail(opts, "current password is incorrect");
    const problem = passwordProblem(next);
    if (problem) return fail(opts, problem);
    store.updateUser(c.ctx.user.id, { password: next as string });
    audit(store, c.label, "password.change", "access.password.change", null, true, null);
    // Password change ends all sessions (including this one) — the UI signs in again.
    opts.respond(true, { ok: true, signedOut: true });
  },

  "access.totp.setup": (opts) => {
    const c = requireUserSelf(opts);
    if (!c) return;
    if (c.ctx.user.totpEnabled) return fail(opts, "two-factor is already on");
    const secret = newTotpSecret();
    accessStore().setTotp(c.ctx.user.id, secret, false);
    opts.respond(true, { secret, uri: totpUri(secret, c.ctx.user.username) });
  },

  "access.totp.enable": (opts) => {
    const c = requireUserSelf(opts);
    if (!c) return;
    const store = accessStore();
    const secret = store.getTotpSecret(c.ctx.user.id);
    if (!secret) return fail(opts, "start two-factor setup first");
    if (!verifyTotp(secret, opts.params.code))
      return fail(opts, "that code didn't match — try the next one");
    store.setTotp(c.ctx.user.id, secret, true);
    audit(store, c.label, "totp.enable", "access.totp.enable", null, true, null);
    opts.respond(true, { totpEnabled: true });
  },

  "access.totp.disable": (opts) => {
    const c = requireUserSelf(opts);
    if (!c) return;
    const store = accessStore();
    const secret = store.getTotpSecret(c.ctx.user.id);
    if (c.ctx.user.totpEnabled && (!secret || !verifyTotp(secret, opts.params.code))) {
      return fail(opts, "enter a current code from your authenticator to turn two-factor off");
    }
    store.setTotp(c.ctx.user.id, null, false);
    audit(store, c.label, "totp.disable", "access.totp.disable", null, true, null);
    opts.respond(true, { totpEnabled: false });
  },

  // ── Admin: overview ─────────────────────────────────────────────────

  "access.overview": (opts) => {
    opts.respond(true, overview(accessStore()));
  },

  "access.audit.list": (opts) => {
    const p = opts.params;
    opts.respond(true, {
      entries: accessStore().listAudit({
        limit: typeof p.limit === "number" ? p.limit : 200,
        actor: s(p, "actor"),
        deniedOnly: p.deniedOnly === true,
      }),
    });
  },

  // ── Admin: users ────────────────────────────────────────────────────

  "access.users.create": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const p = opts.params;
    const role = isUserRole(p.role) ? p.role : "viewer";
    if (!canManageRole(c, role)) return fail(opts, "only the owner can create admins");
    const username = s(p, "username");
    if (!username) return fail(opts, "username is required");
    const generated = typeof p.password !== "string" || !p.password;
    const password = generated ? randomBytes(9).toString("base64url") : (p.password as string);
    const problem = passwordProblem(password);
    if (problem) return fail(opts, problem);
    const store = accessStore();
    try {
      const user = store.createUser({
        username,
        password,
        role,
        displayName: s(p, "displayName"),
        email: s(p, "email") ?? null,
        allowance: clampAllowance(c, p.allowance),
        invitedBy: c.label,
      });
      for (const ws of strArr(p.workspaceIds))
        if (store.getWorkspace(ws)) store.setMember(ws, user.id, null, {});
      audit(
        store,
        c.label,
        "user.create",
        "access.users.create",
        `user=${user.username}`,
        true,
        `role=${role}`,
      );
      broadcastChanged(opts);
      opts.respond(true, {
        user: publicUser(user),
        temporaryPassword: generated ? password : undefined,
      });
    } catch (err) {
      fail(opts, err instanceof Error ? err.message : String(err));
    }
  },

  "access.users.update": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const id = s(opts.params, "id");
    const user = id ? store.getUser(id) : null;
    if (!user) return fail(opts, "user not found");
    if (!canManageRole(c, user.role)) return fail(opts, "only the owner can change an admin");
    const p = opts.params;
    if (isUserRole(p.role) && !canManageRole(c, p.role))
      return fail(opts, "only the owner can make admins");
    if (
      c.kind === "user" &&
      c.ctx.user.id === user.id &&
      (p.role !== undefined || p.disabled !== undefined)
    ) {
      return fail(opts, "you can't change your own role or disable yourself");
    }
    const updated = store.updateUser(user.id, {
      displayName: typeof p.displayName === "string" ? p.displayName : undefined,
      email: p.email === null ? null : typeof p.email === "string" ? p.email : undefined,
      role: isUserRole(p.role) ? p.role : undefined,
      allowance: p.allowance !== undefined ? clampAllowance(c, p.allowance) : undefined,
      disabled: typeof p.disabled === "boolean" ? p.disabled : undefined,
    });
    audit(
      store,
      c.label,
      "user.update",
      "access.users.update",
      `user=${user.username}`,
      true,
      JSON.stringify(Object.keys(p)),
    );
    broadcastChanged(opts);
    opts.respond(true, { user: updated ? publicUser(updated) : null });
  },

  "access.users.resetPassword": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const id = s(opts.params, "id");
    const user = id ? store.getUser(id) : null;
    if (!user) return fail(opts, "user not found");
    if (!canManageRole(c, user.role))
      return fail(opts, "only the owner can reset an admin's password");
    const supplied =
      typeof opts.params.password === "string" && opts.params.password
        ? opts.params.password
        : null;
    const password = supplied ?? randomBytes(9).toString("base64url");
    const problem = passwordProblem(password);
    if (problem) return fail(opts, problem);
    store.updateUser(user.id, { password });
    audit(
      store,
      c.label,
      "user.resetPassword",
      "access.users.resetPassword",
      `user=${user.username}`,
      true,
      null,
    );
    opts.respond(true, { ok: true, temporaryPassword: supplied ? undefined : password });
  },

  "access.users.resetTotp": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const id = s(opts.params, "id");
    const user = id ? store.getUser(id) : null;
    if (!user) return fail(opts, "user not found");
    if (!canManageRole(c, user.role))
      return fail(opts, "only the owner can reset an admin's two-factor");
    store.setTotp(user.id, null, false);
    audit(
      store,
      c.label,
      "user.resetTotp",
      "access.users.resetTotp",
      `user=${user.username}`,
      true,
      null,
    );
    opts.respond(true, { ok: true });
  },

  "access.users.remove": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const id = s(opts.params, "id");
    const user = id ? store.getUser(id) : null;
    if (!user) return fail(opts, "user not found");
    if (!canManageRole(c, user.role)) return fail(opts, "only the owner can remove an admin");
    if (c.kind === "user" && c.ctx.user.id === user.id)
      return fail(opts, "you can't remove yourself");
    store.deleteUser(user.id);
    audit(
      store,
      c.label,
      "user.remove",
      "access.users.remove",
      `user=${user.username}`,
      true,
      null,
    );
    broadcastChanged(opts);
    opts.respond(true, { ok: true });
  },

  // ── Admin: invites ──────────────────────────────────────────────────

  "access.invites.create": async (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const p = opts.params;
    const role = isUserRole(p.role) ? p.role : "viewer";
    if (!canManageRole(c, role)) return fail(opts, "only the owner can invite admins");
    const store = accessStore();
    const workspaceIds = strArr(p.workspaceIds).filter((id) => store.getWorkspace(id));
    // Single-use by default; multi-use takes an optional cap (null = unlimited).
    const cap = typeof p.maxUses === "number" && p.maxUses > 0 ? Math.floor(p.maxUses) : null;
    const maxUses = p.multiUse === true ? cap : 1;
    const hours = typeof p.expiresInHours === "number" ? p.expiresInHours : 72;
    const expiresAt = hours > 0 ? Date.now() + Math.min(hours, 24 * 365) * 3600_000 : null;
    const { token, invite } = store.createInvite({
      role,
      workspaceIds,
      allowance: clampAllowance(c, p.allowance),
      maxUses,
      expiresAt,
      email: s(p, "email") ?? null,
      note: s(p, "note") ?? null,
      createdBy: c.label,
    });
    const url = inviteUrl(token, s(p, "origin"));
    audit(
      store,
      c.label,
      "invite.create",
      "access.invites.create",
      `invite=${invite.id}`,
      true,
      `role=${role} ws=${workspaceIds.join(",")}`,
    );
    let emailed: { ok: boolean; message?: string } | undefined;
    if (p.sendEmail === true && invite.email) {
      try {
        const { sendEmail } = await import("../../services/email/dispatcher.js");
        const wsNames = workspaceIds
          .map((id) => store.getWorkspace(id)?.name)
          .filter(Boolean)
          .join(", ");
        const r = await sendEmail({
          to: invite.email,
          subject: "You're invited to InfiniBot",
          body: `${c.label} invited you to InfiniBot${wsNames ? ` (${wsNames})` : ""} as ${role}.\n\nCreate your account: ${url}\n\nThis link ${expiresAt ? `expires ${new Date(expiresAt).toUTCString()}` : "does not expire"}.`,
        });
        emailed = r.ok ? { ok: true } : { ok: false, message: r.message };
      } catch (err) {
        emailed = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
    broadcastChanged(opts);
    opts.respond(true, { invite: wireInvite(invite, store), token, url, emailed });
  },

  "access.invites.revoke": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const id = s(opts.params, "id");
    if (!id || !store.revokeInvite(id)) return fail(opts, "invite not found or already revoked");
    audit(store, c.label, "invite.revoke", "access.invites.revoke", `invite=${id}`, true, null);
    broadcastChanged(opts);
    opts.respond(true, { ok: true });
  },

  "access.invites.delete": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const id = s(opts.params, "id");
    if (!id || !store.deleteInvite(id)) return fail(opts, "invite not found");
    audit(store, c.label, "invite.delete", "access.invites.delete", `invite=${id}`, true, null);
    opts.respond(true, { ok: true });
  },

  // ── Admin: workspaces, members, assignments ─────────────────────────

  "access.workspaces.create": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const name = s(opts.params, "name");
    if (!name) return fail(opts, "name is required");
    const store = accessStore();
    const ws = store.createWorkspace({
      name,
      description: s(opts.params, "description"),
      color: s(opts.params, "color") ?? null,
    });
    // An admin who creates a workspace is a member of it.
    if (c.kind === "user") store.setMember(ws.id, c.ctx.user.id, null, {});
    audit(
      store,
      c.label,
      "workspace.create",
      "access.workspaces.create",
      `ws=${ws.id}`,
      true,
      name,
    );
    broadcastChanged(opts);
    opts.respond(true, { workspace: ws });
  },

  "access.workspaces.update": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const id = s(opts.params, "id");
    if (!id || !store.getWorkspace(id)) return fail(opts, "workspace not found");
    const p = opts.params;
    let roleOverrides = p.roleOverrides !== undefined ? sanitizeMatrix(p.roleOverrides) : undefined;
    if (roleOverrides && c.kind !== "owner") {
      for (const layer of Object.values(roleOverrides)) {
        if (layer?.features) delete layer.features.secure;
      }
    }
    const ws = store.updateWorkspace(id, {
      name: typeof p.name === "string" ? p.name : undefined,
      description: typeof p.description === "string" ? p.description : undefined,
      color: typeof p.color === "string" ? p.color : undefined,
      roleOverrides,
    });
    audit(
      store,
      c.label,
      "workspace.update",
      "access.workspaces.update",
      `ws=${id}`,
      true,
      JSON.stringify(Object.keys(p)),
    );
    broadcastChanged(opts);
    opts.respond(true, { workspace: ws });
  },

  "access.workspaces.delete": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const id = s(opts.params, "id");
    if (!id || !store.deleteWorkspace(id)) return fail(opts, "workspace not found");
    audit(store, c.label, "workspace.delete", "access.workspaces.delete", `ws=${id}`, true, null);
    broadcastChanged(opts);
    opts.respond(true, { ok: true });
  },

  "access.workspaces.importAgencies": async (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const payload = await callOwnerRpc("agency.ops.agencies.list", {});
    const agencies = arrayIn(payload, ["agencies"]);
    const store = accessStore();
    const existing = new Set(store.listWorkspaces().flatMap((w) => [w.id, w.agencyId ?? ""]));
    let created = 0;
    for (const a of agencies) {
      const id = coerceString(a.id);
      if (!id || existing.has(id)) continue;
      store.createWorkspace({ id, name: coerceString(a.name, id), agencyId: id });
      created++;
    }
    audit(
      store,
      c.label,
      "workspace.importAgencies",
      "access.workspaces.importAgencies",
      null,
      true,
      `created=${created}`,
    );
    if (created) broadcastChanged(opts);
    opts.respond(true, { created, found: agencies.length });
  },

  "access.members.set": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const wsId = s(opts.params, "workspaceId");
    const userId = s(opts.params, "userId");
    const user = userId ? store.getUser(userId) : null;
    if (!wsId || !store.getWorkspace(wsId)) return fail(opts, "workspace not found");
    if (!user) return fail(opts, "user not found");
    const role = isUserRole(opts.params.role) ? opts.params.role : null;
    if (!canManageRole(c, user.role) || (role && !canManageRole(c, role))) {
      return fail(opts, "only the owner can manage admins");
    }
    store.setMember(wsId, user.id, role, clampAllowance(c, opts.params.allowance));
    audit(
      store,
      c.label,
      "member.set",
      "access.members.set",
      `ws=${wsId} user=${user.username}`,
      true,
      role ?? "inherit",
    );
    broadcastChanged(opts);
    opts.respond(true, { ok: true });
  },

  "access.members.remove": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const wsId = s(opts.params, "workspaceId");
    const userId = s(opts.params, "userId");
    const user = userId ? store.getUser(userId) : null;
    if (!wsId || !user) return fail(opts, "workspaceId and userId are required");
    if (!canManageRole(c, user.role)) return fail(opts, "only the owner can manage admins");
    store.removeMember(wsId, user.id);
    audit(
      store,
      c.label,
      "member.remove",
      "access.members.remove",
      `ws=${wsId} user=${user.username}`,
      true,
      null,
    );
    broadcastChanged(opts);
    opts.respond(true, { ok: true });
  },

  "access.resources.list": async (opts) => {
    const type = s(opts.params, "resourceType") as ResourceType | undefined;
    if (!type || !(RESOURCE_TYPES as readonly string[]).includes(type))
      return fail(opts, "unknown resourceType");
    const store = accessStore();
    const items = await listResourceCandidates(type);
    const byRes = new Map<string, string[]>();
    for (const a of store.listAssignments()) {
      if (a.resourceType !== type) continue;
      byRes.set(a.resourceId, [...(byRes.get(a.resourceId) ?? []), a.workspaceId]);
    }
    opts.respond(true, {
      items: items.map((i) => ({ ...i, workspaceIds: byRes.get(i.id) ?? [] })),
    });
  },

  "access.assign": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const type = s(opts.params, "resourceType") as ResourceType | undefined;
    const resourceId = s(opts.params, "resourceId");
    const wsId = s(opts.params, "workspaceId");
    if (!type || !(RESOURCE_TYPES as readonly string[]).includes(type))
      return fail(opts, "unknown resourceType");
    if (!resourceId || !wsId || !store.getWorkspace(wsId))
      return fail(opts, "resourceId and a valid workspaceId are required");
    if (opts.params.assigned === false) store.unassign(type, resourceId, wsId);
    else store.assign(type, resourceId, wsId);
    audit(
      store,
      c.label,
      opts.params.assigned === false ? "unassign" : "assign",
      "access.assign",
      `${type}=${resourceId} ws=${wsId}`,
      true,
      null,
    );
    broadcastChanged(opts);
    opts.respond(true, { ok: true });
  },

  // ── Admin: role matrix + preview ────────────────────────────────────

  "access.matrix.set": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const matrix = sanitizeMatrix(opts.params.matrix);
    if (c.kind !== "owner") {
      for (const layer of Object.values(matrix)) if (layer?.features) delete layer.features.secure;
    }
    const store = accessStore();
    store.setRoleMatrix(matrix);
    audit(store, c.label, "matrix.set", "access.matrix.set", null, true, null);
    broadcastChanged(opts);
    opts.respond(true, { matrix: store.getRoleMatrix() });
  },

  "access.preview": async (opts) => {
    const id = s(opts.params, "userId");
    if (!id) return fail(opts, "userId is required");
    const result = await previewFor(accessStore(), id);
    if (!result) return fail(opts, "user not found");
    opts.respond(true, result);
  },

  /** Mint a short-lived, read-only session for "open as this user" previews. */
  "access.preview.session": (opts) => {
    const c = caller(opts);
    if (!c) return fail(opts, "session expired");
    const store = accessStore();
    const id = s(opts.params, "userId");
    const user = id ? store.getUser(id) : null;
    if (!user || user.disabled) return fail(opts, "user not found or disabled");
    if (!canManageRole(c, user.role)) return fail(opts, "only the owner can preview an admin");
    const { token, session } = store.createSession(user.id, PREVIEW_SESSION_TTL_MS, {
      userAgent: PREVIEW_UA_TAG,
    });
    audit(
      store,
      c.label,
      "preview.session",
      "access.preview.session",
      `user=${user.username}`,
      true,
      null,
    );
    opts.respond(true, { token, expiresAt: session.expiresAt });
  },
};

/** Exposed for tests. */
export const __test = { isOwnSessionKey, inviteUrl };
