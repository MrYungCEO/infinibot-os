/**
 * Central RPC authorization for multi-user (non-owner) connections.
 *
 * Deny by default: a method a user may call must have a rule in METHOD_RULES.
 * Each rule names the resource type + action (or the feature) it needs, how to
 * find the record id in the params, and how to filter list results down to the
 * records assigned to the caller's workspaces. Owner / token / device / agent
 * connections never reach this module (see server-methods.ts).
 */

import type { AccessStore, AccessUser, AccessWorkspace } from "./store.js";
import { pruneToComponent } from "../gateway/server-methods/graph-project-scope.js";
import {
  type Feature,
  type Permissions,
  RESOURCE_TYPES,
  type ResourceAction,
  type ResourceType,
  resolvePermissions,
  type UserRole,
} from "./policy.js";
import { coerceString } from "../shared/text/coerce.js";

// ── Context ──────────────────────────────────────────────────────────

export type WorkspaceAccess = {
  workspace: AccessWorkspace;
  role: UserRole;
  perms: Permissions;
};

export type AccessContext = {
  user: AccessUser;
  /** Permissions outside any workspace (feature switches, own sessions). */
  base: Permissions;
  workspaces: WorkspaceAccess[];
  activeWorkspaceId: string | null;
  /** Read-only preview session minted by an admin ("preview as user"). */
  preview: boolean;
};

export function buildAccessContext(
  store: AccessStore,
  user: AccessUser,
  opts: { activeWorkspaceId?: string | null; preview?: boolean } = {},
): AccessContext {
  const matrix = store.getRoleMatrix();
  const base = resolvePermissions({ role: user.role, matrix, userAllowance: user.allowance });
  const workspaces: WorkspaceAccess[] = [];
  for (const m of store.membershipsForUser(user.id)) {
    const ws = store.getWorkspace(m.workspaceId);
    if (!ws) continue;
    const role = m.role ?? user.role;
    workspaces.push({
      workspace: ws,
      role,
      perms: resolvePermissions({
        role,
        matrix,
        workspaceRoleOverride: ws.roleOverrides[role],
        userAllowance: user.allowance,
        memberAllowance: m.allowance,
      }),
    });
  }
  const ctx: AccessContext = {
    user,
    base,
    workspaces,
    activeWorkspaceId: null,
    preview: opts.preview === true,
  };
  const wanted = opts.activeWorkspaceId;
  ctx.activeWorkspaceId =
    (wanted && workspaces.some((w) => w.workspace.id === wanted)
      ? wanted
      : workspaces[0]?.workspace.id) ?? null;
  if (ctx.preview) {
    for (const p of [ctx.base, ...ctx.workspaces.map((w) => w.perms)]) {
      for (const r of RESOURCE_TYPES) p.resources[r].edit = false;
      p.features.chat = false;
      p.features.coders = false;
    }
  }
  return ctx;
}

export function isAccessAdmin(ctx: AccessContext): boolean {
  return ctx.user.role === "admin" && !ctx.preview;
}

export function hasFeature(ctx: AccessContext, feature: Feature): boolean {
  if (ctx.base.features[feature]) return true;
  return ctx.workspaces.some((w) => w.perms.features[feature]);
}

/** Workspace ids where the caller has `action` on `type`. */
export function workspacesWith(
  ctx: AccessContext,
  type: ResourceType,
  action: ResourceAction,
): string[] {
  return ctx.workspaces.filter((w) => w.perms.resources[type][action]).map((w) => w.workspace.id);
}

export function canInWorkspace(
  ctx: AccessContext,
  workspaceId: string,
  type: ResourceType,
  action: ResourceAction,
): boolean {
  const w = ctx.workspaces.find((x) => x.workspace.id === workspaceId);
  return !!w && w.perms.resources[type][action];
}

/** Resource ids of `type` the caller may `action`, via workspace assignments. */
export function allowedIds(
  store: AccessStore,
  ctx: AccessContext,
  type: ResourceType,
  action: ResourceAction,
): Set<string> {
  const ws = new Set(workspacesWith(ctx, type, action));
  const out = new Set<string>();
  if (!ws.size) return out;
  for (const a of store.listAssignments()) {
    if (a.resourceType === type && ws.has(a.workspaceId)) out.add(a.resourceId);
  }
  return out;
}

export function canResource(
  store: AccessStore,
  ctx: AccessContext,
  type: ResourceType,
  id: string,
  action: ResourceAction,
): boolean {
  const owners = store.workspacesForResource(type, id);
  return owners.some((ws) => canInWorkspace(ctx, ws, type, action));
}

// ── User-owned chat sessions ─────────────────────────────────────────

/** Session keys a user owns: agent:<agentId>:mu-<userId>[:...] */
export function userSessionPrefix(userId: string): string {
  return `mu-${userId}`;
}

export function isOwnSessionKey(userId: string, key: unknown): boolean {
  if (typeof key !== "string") return false;
  const parts = key.trim().split(":");
  return parts.length >= 3 && parts[0] === "agent" && parts[2] === userSessionPrefix(userId);
}

export function sessionAgentId(key: string): string | null {
  const parts = key.trim().split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : null;
}

// ── Rules ────────────────────────────────────────────────────────────

export type AuthzDecision =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** Rewrites the success payload before it reaches the client. */
      transform?: (payload: unknown) => unknown;
      /** Runs after a successful response (e.g. assign a created record). */
      after?: (payload: unknown) => void;
    };

export type Lookups = {
  /** kanban task id → project id (null when unknown). */
  taskProjectId?: (taskId: string) => Promise<string | null>;
  /** Every document id → its parent id (the whole tree, owner's view). */
  documentParents?: () => Promise<Map<string, string | null>>;
  /** note id → its project id (or null). */
  noteProjectId?: (noteId: string) => Promise<string | null>;
};

type Req = {
  method: string;
  params: Record<string, unknown>;
  store: AccessStore;
  ctx: AccessContext;
  lookups: Lookups;
};

type Rule = (r: Req) => Promise<AuthzDecision> | AuthzDecision;

const ALLOW: AuthzDecision = { ok: true };
const deny = (reason: string): AuthzDecision => ({ ok: false, reason });

function str(p: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function nested(payload: unknown, keys: string[]): unknown {
  let cur = payload;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Filter an array either at the payload root or under one of `keys`. */
export function filterListPayload(
  payload: unknown,
  keys: string[],
  keep: (item: Record<string, unknown>) => boolean,
): unknown {
  const f = (arr: unknown[]) =>
    arr.filter((x) => x && typeof x === "object" && keep(x as Record<string, unknown>));
  if (Array.isArray(payload)) return f(payload);
  if (!payload || typeof payload !== "object") return payload;
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const k of keys) {
    if (Array.isArray(out[k])) {
      const before = (out[k] as unknown[]).length;
      out[k] = f(out[k] as unknown[]);
      if (typeof out.count === "number") out.count = (out[k] as unknown[]).length;
      if (typeof out.total === "number" && before !== (out[k] as unknown[]).length) {
        out.total = (out[k] as unknown[]).length;
      }
    }
  }
  return out;
}

/** Pick (and remove) the target workspace for a create call. */
function createTarget(r: Req, type: ResourceType): string | null {
  const requested = str(r.params, "workspaceId");
  delete r.params.workspaceId;
  const candidates = requested
    ? [requested]
    : [r.ctx.activeWorkspaceId, ...workspacesWith(r.ctx, type, "edit")];
  for (const ws of candidates) {
    if (ws && canInWorkspace(r.ctx, ws, type, "edit")) return ws;
  }
  return null;
}

function assignAfter(r: Req, type: ResourceType, ws: string, idPaths: string[][]) {
  return (payload: unknown) => {
    for (const path of idPaths) {
      const id = nested(payload, path);
      if (typeof id === "string" && id) {
        r.store.assign(type, id, ws);
        return;
      }
    }
  };
}

const feature =
  (f: Feature): Rule =>
  ({ ctx }) =>
    hasFeature(ctx, f) ? ALLOW : deny(`feature not allowed: ${f}`);

/** List: needs view somewhere; rows filtered to assigned ids. */
const listOf =
  (type: ResourceType, keys: string[], idField = "id"): Rule =>
  ({ store, ctx }) => {
    if (!workspacesWith(ctx, type, "view").length) return deny(`no ${type} access`);
    const ids = allowedIds(store, ctx, type, "view");
    return {
      ok: true,
      transform: (p) => filterListPayload(p, keys, (it) => ids.has(String(it[idField]))),
    };
  };

/** Single record by id param. */
const byId =
  (type: ResourceType, action: ResourceAction, idKeys: string[] = ["id"]): Rule =>
  ({ store, ctx, params }) => {
    const id = str(params, ...idKeys);
    if (!id) return deny("missing id");
    return canResource(store, ctx, type, id, action)
      ? ALLOW
      : deny(`${type} ${action} not allowed`);
  };

const createOf =
  (type: ResourceType, idPaths: string[][]): Rule =>
  (r) => {
    const ws = createTarget(r, type);
    if (!ws) return deny(`no workspace where you can edit ${type}`);
    return { ok: true, after: assignAfter(r, type, ws, idPaths) };
  };

// Kanban tasks inherit visibility from their project (type "kanban").
async function taskAllowed(r: Req, taskId: string, action: ResourceAction): Promise<boolean> {
  if (canResource(r.store, r.ctx, "kanban", taskId, action)) return true;
  const pid = await r.lookups.taskProjectId?.(taskId).catch(() => null);
  return (
    !!pid &&
    canResource(r.store, r.ctx, "projects", pid, "view") &&
    projectGrants(r, pid, "kanban", action)
  );
}

/** True when a workspace that owns project `pid` grants `action` on `type`. */
function projectGrants(r: Req, pid: string, type: ResourceType, action: ResourceAction): boolean {
  return r.store
    .workspacesForResource("projects", pid)
    .some((ws) => canInWorkspace(r.ctx, ws, type, action));
}

async function docParents(r: Req): Promise<Map<string, string | null>> {
  try {
    return (await r.lookups.documentParents?.()) ?? new Map();
  } catch {
    return new Map();
  }
}

/** A document is visible when it, or any folder above it, is assigned. */
function lineageOf(parents: Map<string, string | null>, id: string): string[] {
  const out: string[] = [];
  let cur: string | null | undefined = id;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = parents.get(cur);
  }
  return out;
}

async function docAllowed(r: Req, id: string, action: ResourceAction): Promise<boolean> {
  const parents = await docParents(r);
  return lineageOf(parents, id).some((x) => canResource(r.store, r.ctx, "documents", x, action));
}

async function visibleDocIds(r: Req, action: ResourceAction): Promise<Set<string>> {
  const ids = allowedIds(r.store, r.ctx, "documents", action);
  const out = new Set<string>(ids);
  const parents = await docParents(r);
  for (const id of parents.keys()) {
    if (lineageOf(parents, id).some((x) => ids.has(x))) out.add(id);
  }
  return out;
}

async function noteAllowed(r: Req, id: string, action: ResourceAction): Promise<boolean> {
  if (canResource(r.store, r.ctx, "documents", id, action)) return true;
  const pid = await r.lookups.noteProjectId?.(id).catch(() => null);
  return !!pid && projectGrants(r, pid, "documents", action);
}

/** Workspace id for an agency id (workspaces imported from Agencies keep the link). */
function workspaceForAgency(store: AccessStore, agencyId: string): string | null {
  for (const w of store.listWorkspaces())
    if (w.id === agencyId || w.agencyId === agencyId) return w.id;
  return null;
}

function agencyRule(type: ResourceType, action: ResourceAction): Rule {
  return ({ store, ctx, params }) => {
    const agencyId = str(params, "agencyId");
    if (!agencyId) return deny("agencyId required");
    const ws = workspaceForAgency(store, agencyId);
    return ws && canInWorkspace(ctx, ws, type, action)
      ? ALLOW
      : deny(`${type} ${action} not allowed`);
  };
}

function documentsTreeFilter(allowed: (id: string) => boolean) {
  return (payload: unknown) => {
    const nodes = (payload as { nodes?: Record<string, unknown>[] })?.nodes;
    if (!Array.isArray(nodes)) return payload;
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    const visible = new Set<string>();
    for (const n of nodes) {
      let cur: Record<string, unknown> | undefined = n;
      const seen = new Set<string>();
      while (cur && !seen.has(String(cur.id))) {
        seen.add(String(cur.id));
        if (allowed(String(cur.id))) {
          visible.add(String(n.id));
          break;
        }
        cur = cur.parentId ? byId.get(coerceString(cur.parentId)) : undefined;
      }
    }
    const kept = nodes
      .filter((n) => visible.has(String(n.id)))
      // Re-root nodes whose parent folder isn't visible to this user.
      .map((n) =>
        n.parentId && !visible.has(coerceString(n.parentId)) ? { ...n, parentId: null } : n,
      );
    return { ...(payload as object), nodes: kept, count: kept.length };
  };
}

const KG_KIND_TO_TYPE: Record<string, ResourceType> = {
  project: "projects",
  note: "documents",
  report: "reports",
  agent: "agents",
};

export const METHOD_RULES: Record<string, Rule> = {
  // Kanban projects (the Projects page).
  "kanban.projects.list": listOf("projects", ["projects"]),
  "kanban.projects.create": createOf("projects", [["id"], ["project", "id"]]),
  "kanban.projects.update": byId("projects", "edit", ["id", "project_id"]),
  "kanban.projects.delete": byId("projects", "edit", ["id"]),
  "projects.list": listOf("projects", ["projects"]),
  "projects.get": byId("projects", "view", ["id", "projectId"]),

  // Kanban tasks — visible through their project.
  "kanban.tasks.list": async (r) => {
    const pid = str(r.params, "projectId");
    if (pid) {
      return projectGrants(r, pid, "kanban", "view") ? ALLOW : deny("kanban view not allowed");
    }
    const projects = allowedIds(r.store, r.ctx, "projects", "view");
    const viaTasks = allowedIds(r.store, r.ctx, "kanban", "view");
    if (!projects.size && !viaTasks.size) return deny("no kanban access");
    return {
      ok: true,
      transform: (p) =>
        filterListPayload(
          p,
          ["tasks"],
          (t) =>
            viaTasks.has(String(t.id)) ||
            (typeof t.projectId === "string" && projectGrants(r, t.projectId, "kanban", "view")),
        ),
    };
  },
  "kanban.tasks.create": (r) => {
    const pid = str(r.params, "projectId", "project_id");
    delete r.params.workspaceId;
    if (!pid) return deny("projectId required");
    return projectGrants(r, pid, "kanban", "edit") ? ALLOW : deny("kanban edit not allowed");
  },
  "kanban.tasks.update": async (r) => {
    const id = str(r.params, "id");
    if (!id) return deny("missing id");
    return (await taskAllowed(r, id, "edit")) ? ALLOW : deny("kanban edit not allowed");
  },
  "kanban.tasks.delete": async (r) => {
    const id = str(r.params, "id");
    if (!id) return deny("missing id");
    return (await taskAllowed(r, id, "edit")) ? ALLOW : deny("kanban edit not allowed");
  },

  // Documents (tree) + legacy notes.
  "documents.tree": (r) => {
    if (!workspacesWith(r.ctx, "documents", "view").length) return deny("no documents access");
    const ids = allowedIds(r.store, r.ctx, "documents", "view");
    return { ok: true, transform: documentsTreeFilter((id) => ids.has(id)) };
  },
  "documents.recent": (r) => {
    if (!workspacesWith(r.ctx, "documents", "view").length) return deny("no documents access");
    const ids = allowedIds(r.store, r.ctx, "documents", "view");
    return { ok: true, transform: documentsTreeFilter((id) => ids.has(id)) };
  },
  "documents.search": async (r) => {
    if (!workspacesWith(r.ctx, "documents", "view").length) return deny("no documents access");
    const visible = await visibleDocIds(r, "view");
    return {
      ok: true,
      transform: (payload) =>
        filterListPayload(payload, ["hits"], (h) =>
          visible.has(coerceString(h.id ?? (h.node as Record<string, unknown> | undefined)?.id)),
        ),
    };
  },
  "documents.get": async (r) => {
    const id = str(r.params, "id");
    if (!id) return deny("missing id");
    return (await docAllowed(r, id, "view")) ? ALLOW : deny("documents view not allowed");
  },
  "documents.history": async (r) => {
    const id = str(r.params, "id");
    return id && (await docAllowed(r, id, "view")) ? ALLOW : deny("documents view not allowed");
  },
  "documents.create": async (r) => {
    const parentId = str(r.params, "parentId");
    if (parentId) {
      delete r.params.workspaceId;
      return (await docAllowed(r, parentId, "edit")) ? ALLOW : deny("documents edit not allowed");
    }
    return createOf("documents", [["node", "id"], ["id"]])(r);
  },
  "documents.update": async (r) => {
    const id = str(r.params, "id");
    return id && (await docAllowed(r, id, "edit")) ? ALLOW : deny("documents edit not allowed");
  },
  "documents.append": async (r) => {
    const id = str(r.params, "id");
    return id && (await docAllowed(r, id, "edit")) ? ALLOW : deny("documents edit not allowed");
  },
  "documents.delete": async (r) => {
    const id = str(r.params, "id");
    return id && (await docAllowed(r, id, "edit")) ? ALLOW : deny("documents edit not allowed");
  },
  "notes.list": (r) => {
    if (!workspacesWith(r.ctx, "documents", "view").length) return deny("no documents access");
    const ids = allowedIds(r.store, r.ctx, "documents", "view");
    return {
      ok: true,
      transform: (p) =>
        filterListPayload(
          p,
          ["notes"],
          (n) =>
            ids.has(String(n.id)) ||
            (typeof n.projectId === "string" && projectGrants(r, n.projectId, "documents", "view")),
        ),
    };
  },
  "notes.get": async (r) => {
    const id = str(r.params, "id");
    return id && (await noteAllowed(r, id, "view")) ? ALLOW : deny("documents view not allowed");
  },
  "notes.create": (r) => {
    const pid = str(r.params, "projectId");
    if (pid) {
      delete r.params.workspaceId;
      return projectGrants(r, pid, "documents", "edit")
        ? ALLOW
        : deny("documents edit not allowed");
    }
    return createOf("documents", [["id"], ["note", "id"]])(r);
  },
  "notes.update": async (r) => {
    const id = str(r.params, "id");
    return id && (await noteAllowed(r, id, "edit")) ? ALLOW : deny("documents edit not allowed");
  },
  "notes.delete": async (r) => {
    const id = str(r.params, "id");
    return id && (await noteAllowed(r, id, "edit")) ? ALLOW : deny("documents edit not allowed");
  },

  // Reports.
  "reports.list": listOf("reports", ["reports"]),
  "reports.get": byId("reports", "view"),
  "reports.preview": byId("reports", "view"),
  "reports.delete": byId("reports", "edit"),

  // Agents: list filtered to assigned agents.
  "agents.list": listOf("agents", ["agents"]),

  // Chat: own sessions only (agent:<id>:mu-<userId>), with an assigned agent.
  "sessions.list": (r) => {
    const own = (k: unknown) => isOwnSessionKey(r.ctx.user.id, k);
    const assigned = allowedIds(r.store, r.ctx, "sessions", "view");
    return {
      ok: true,
      transform: (p) =>
        filterListPayload(p, ["sessions"], (s) => own(s.key) || assigned.has(String(s.key))),
    };
  },
  "chat.history": (r) => {
    const key = str(r.params, "sessionKey");
    if (!key) return deny("sessionKey required");
    if (isOwnSessionKey(r.ctx.user.id, key)) return ALLOW;
    return canResource(r.store, r.ctx, "sessions", key, "view")
      ? ALLOW
      : deny("session not visible");
  },
  "chat.send": (r) => chatWrite(r),
  "chat.abort": (r) => chatWrite(r),

  // Knowledge graph: only nodes backed by visible records.
  "graph.global.snapshot": (r) => {
    if (!workspacesWith(r.ctx, "knowledge", "view").length) return deny("no knowledge access");
    const visible: Partial<Record<ResourceType, Set<string>>> = {};
    for (const t of Object.values(KG_KIND_TO_TYPE))
      visible[t] = allowedIds(r.store, r.ctx, t, "view");
    return {
      ok: true,
      transform: (payload) => {
        const snap = payload as {
          nodes?: Record<string, unknown>[];
          edges?: Record<string, unknown>[];
        };
        if (!snap || !Array.isArray(snap.nodes)) return payload;
        const keep = new Set<string>();
        for (const n of snap.nodes) {
          const id = String(n.id);
          const kind = String(n.kind);
          const raw = id.slice(kind.length + 1);
          const meta = (n.meta ?? {}) as Record<string, unknown>;
          if (kind === "task") {
            const pid = typeof meta.projectId === "string" ? meta.projectId : null;
            if (pid && projectGrants(r, pid, "kanban", "view")) keep.add(id);
            continue;
          }
          const type = KG_KIND_TO_TYPE[kind];
          if (type && visible[type]?.has(raw)) keep.add(id);
        }
        let nodes = snap.nodes.filter((n) => keep.has(String(n.id)));
        let edges = (snap.edges ?? []).filter(
          (e) => keep.has(String(e.source)) && keep.has(String(e.target)),
        );
        // Project-scoped graph: hiding a record can cut a path, so re-prune to
        // the project's component (no orphan islands of visible records).
        const scope = (snap as { scope?: { projectNodeId?: unknown } }).scope;
        if (scope && typeof scope.projectNodeId === "string") {
          const cut = pruneToComponent(
            nodes.map((n) => ({ ...n, id: String(n.id) })),
            edges.map((e) => ({ ...e, source: String(e.source), target: String(e.target) })),
            scope.projectNodeId,
          );
          nodes = cut.nodes;
          edges = cut.edges;
        }
        const typeStats: Record<string, number> = {};
        for (const n of nodes) typeStats[String(n.kind)] = (typeStats[String(n.kind)] ?? 0) + 1;
        return { ...snap, nodes, edges, typeStats, insights: [], hidden: {} };
      },
    };
  },

  // Agencies (the workspace switcher in Business & Agency).
  "agency.ops.agencies.list": (r) => {
    const mine = new Set<string>();
    for (const w of r.ctx.workspaces) {
      mine.add(w.workspace.id);
      if (w.workspace.agencyId) mine.add(w.workspace.agencyId);
    }
    return {
      ok: true,
      transform: (p) => filterListPayload(p, ["agencies"], (a) => mine.has(String(a.id))),
    };
  },
  "agency.ops.dashboard": agencyRule("dashboards", "view"),
  "agency.ops.projects.list": agencyRule("projects", "view"),
  "agency.ops.projects.create": agencyRule("projects", "edit"),
  "agency.ops.projects.update": agencyRule("projects", "edit"),
  "agency.ops.tasks.list": agencyRule("kanban", "view"),
  "agency.ops.tasks.create": agencyRule("kanban", "edit"),

  // Feature-gated surfaces (whole-feature switches).
  "secure.status": feature("secure"),
  "secure.chat.send": feature("secure"),
  "subagents.list": feature("coders"),
  "business.income.stats": feature("finance"),
  "business.income.daily": feature("finance"),
};

function chatWrite(r: Req): AuthzDecision {
  if (!hasFeature(r.ctx, "chat")) return deny("feature not allowed: chat");
  const key = str(r.params, "sessionKey");
  if (!key || !isOwnSessionKey(r.ctx.user.id, key))
    return deny("you can only chat in your own sessions");
  const agentId = sessionAgentId(key);
  if (!agentId) return deny("invalid sessionKey");
  return canResource(r.store, r.ctx, "agents", agentId, "view")
    ? ALLOW
    : deny("agent not available to you");
}

/**
 * Methods every signed-in user may call regardless of allowance: their own
 * identity/session/2FA and harmless UI plumbing. Everything else is either in
 * METHOD_RULES or denied.
 */
export const SELF_METHODS = new Set<string>([
  "access.me",
  "access.logout",
  "access.workspace.select",
  "access.password.change",
  "access.totp.setup",
  "access.totp.enable",
  "access.totp.disable",
]);

const PREVIEW_SELF_METHODS = new Set(["access.me", "access.workspace.select", "access.logout"]);

/** Admin-only access-management RPCs (also open to the owner). */
export const ADMIN_METHOD_PREFIX = "access.";

export async function authorizeUserMethod(
  method: string,
  params: Record<string, unknown>,
  store: AccessStore,
  ctx: AccessContext,
  lookups: Lookups = {},
): Promise<AuthzDecision> {
  if (SELF_METHODS.has(method)) {
    // An admin's "preview as user" session can look, never change the user's account.
    if (ctx.preview && !PREVIEW_SELF_METHODS.has(method))
      return deny("preview sessions are read-only");
    return ALLOW;
  }
  if (method.startsWith(ADMIN_METHOD_PREFIX)) {
    return isAccessAdmin(ctx) ? ALLOW : deny("admin only");
  }
  const rule = METHOD_RULES[method];
  if (!rule) return deny("not permitted for workspace users");
  return rule({ method, params, store, ctx, lookups });
}
