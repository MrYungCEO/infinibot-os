/**
 * Multi-user access policy — roles × resource types × actions, plus feature
 * switches. Pure functions only (no I/O) so the authorization matrix is
 * trivially testable.
 *
 * Resolution order for a user inside one workspace (later wins):
 *   1. global role matrix (owner-editable, falls back to ROLE_DEFAULTS)
 *   2. the workspace's per-role override
 *   3. the user's own allowance
 *   4. the user's per-workspace member allowance
 *
 * Secure Mode is special: it is only ever granted by an explicit `true`
 * somewhere in that chain — never by a role default.
 */

export const RESOURCE_TYPES = [
  "projects",
  "kanban",
  "documents",
  "files",
  "sessions",
  "agents",
  "knowledge",
  "reports",
  "dashboards",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_ACTIONS = ["view", "edit"] as const;
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];

export const FEATURES = ["chat", "coders", "finance", "secure"] as const;
export type Feature = (typeof FEATURES)[number];

export const USER_ROLES = ["admin", "member", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];
/** `owner` is the gateway-password / token super-admin; never stored as a row. */
export type PrincipalRole = UserRole | "owner";

export type ResourceGrant = Partial<Record<ResourceAction, boolean>>;

/** A partial permission set. Missing keys inherit from the layer below. */
export type Allowance = {
  resources?: Partial<Record<ResourceType, ResourceGrant>>;
  features?: Partial<Record<Feature, boolean>>;
};

/** A fully resolved permission set. */
export type Permissions = {
  resources: Record<ResourceType, Record<ResourceAction, boolean>>;
  features: Record<Feature, boolean>;
};

export type RoleMatrix = Record<UserRole, Allowance>;

function grantAll(view: boolean, edit: boolean): Allowance["resources"] {
  const out: Partial<Record<ResourceType, ResourceGrant>> = {};
  for (const r of RESOURCE_TYPES) out[r] = { view, edit };
  return out;
}

export const ROLE_DEFAULTS: RoleMatrix = {
  admin: {
    resources: grantAll(true, true),
    features: { chat: true, coders: true, finance: true, secure: false },
  },
  // Chat runs the agent with the AGENT's tool policy (not the user's), so it is
  // a deliberate grant: admins have it, members/viewers get it per allowance.
  member: {
    resources: grantAll(true, true),
    features: { chat: false, coders: false, finance: false, secure: false },
  },
  viewer: {
    resources: grantAll(true, false),
    features: { chat: false, coders: false, finance: false, secure: false },
  },
};

export function isUserRole(v: unknown): v is UserRole {
  return typeof v === "string" && (USER_ROLES as readonly string[]).includes(v);
}

export function emptyPermissions(): Permissions {
  const resources = {} as Permissions["resources"];
  for (const r of RESOURCE_TYPES) resources[r] = { view: false, edit: false };
  const features = {} as Permissions["features"];
  for (const f of FEATURES) features[f] = false;
  return { resources, features };
}

export function fullPermissions(): Permissions {
  const p = emptyPermissions();
  for (const r of RESOURCE_TYPES) p.resources[r] = { view: true, edit: true };
  for (const f of FEATURES) p.features[f] = true;
  return p;
}

function applyLayer(
  target: Permissions,
  layer: Allowance | undefined | null,
  allowSecure: boolean,
) {
  if (!layer) return;
  for (const r of RESOURCE_TYPES) {
    const g = layer.resources?.[r];
    if (!g) continue;
    for (const a of RESOURCE_ACTIONS) {
      if (typeof g[a] === "boolean") target.resources[r][a] = g[a];
    }
  }
  for (const f of FEATURES) {
    const v = layer.features?.[f];
    if (typeof v !== "boolean") continue;
    // Role layers can switch Secure Mode OFF but never ON.
    if (f === "secure" && v && !allowSecure) continue;
    target.features[f] = v;
  }
}

export function resolvePermissions(params: {
  role: PrincipalRole;
  matrix?: Partial<RoleMatrix> | null;
  workspaceRoleOverride?: Allowance | null;
  userAllowance?: Allowance | null;
  memberAllowance?: Allowance | null;
}): Permissions {
  if (params.role === "owner") return fullPermissions();
  const out = emptyPermissions();
  applyLayer(out, ROLE_DEFAULTS[params.role], false);
  applyLayer(out, params.matrix?.[params.role], false);
  applyLayer(out, params.workspaceRoleOverride, false);
  applyLayer(out, params.userAllowance, true);
  applyLayer(out, params.memberAllowance, true);
  // Edit without view is meaningless; normalise so the UI never shows it.
  for (const r of RESOURCE_TYPES) {
    if (out.resources[r].edit) out.resources[r].view = true;
  }
  return out;
}

/** Strip unknown keys / non-boolean values from untrusted allowance JSON. */
export function sanitizeAllowance(raw: unknown): Allowance {
  const out: Allowance = {};
  if (!raw || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  const res = src.resources as Record<string, unknown> | undefined;
  if (res && typeof res === "object") {
    for (const r of RESOURCE_TYPES) {
      const g = res[r] as Record<string, unknown> | undefined;
      if (!g || typeof g !== "object") continue;
      const grant: ResourceGrant = {};
      for (const a of RESOURCE_ACTIONS) if (typeof g[a] === "boolean") grant[a] = g[a] as boolean;
      if (Object.keys(grant).length) (out.resources ??= {})[r] = grant;
    }
  }
  const feats = src.features as Record<string, unknown> | undefined;
  if (feats && typeof feats === "object") {
    for (const f of FEATURES) {
      if (typeof feats[f] === "boolean") (out.features ??= {})[f] = feats[f] as boolean;
    }
  }
  return out;
}

export function sanitizeMatrix(raw: unknown): Partial<RoleMatrix> {
  const out: Partial<RoleMatrix> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const role of USER_ROLES) {
    const layer = (raw as Record<string, unknown>)[role];
    if (layer) out[role] = sanitizeAllowance(layer);
  }
  return out;
}
