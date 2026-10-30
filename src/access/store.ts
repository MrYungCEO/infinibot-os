/**
 * Multi-user access store — users, sessions, invites, workspaces, members,
 * resource→workspace assignments, the role matrix and the audit log.
 *
 * One SQLite file at <shared state dir>/access/access.db. Additive by design:
 * existing stores (kanban, documents, reports, …) are not touched; which
 * workspace a record belongs to lives here in `assignments`, so the owner's
 * existing data stays owner-only until an admin assigns it to a workspace.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  hashPassword,
  INVITE_TOKEN_PREFIX,
  newToken,
  SESSION_TOKEN_PREFIX,
  sha256,
  verifyPassword,
} from "./crypto.js";
import {
  type Allowance,
  isUserRole,
  type ResourceType,
  type RoleMatrix,
  sanitizeAllowance,
  sanitizeMatrix,
  type UserRole,
} from "./policy.js";
import { coerceString } from "../shared/text/coerce.js";

export type AccessUser = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: UserRole;
  allowance: Allowance;
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number | null;
  invitedBy: string | null;
};

export type AccessSession = {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  userAgent: string | null;
  ip: string | null;
};

export type AccessInvite = {
  id: string;
  role: UserRole;
  workspaceIds: string[];
  allowance: Allowance;
  maxUses: number | null;
  uses: number;
  expiresAt: number | null;
  revokedAt: number | null;
  email: string | null;
  note: string | null;
  createdBy: string;
  createdAt: number;
};

export type InviteStatus = "active" | "expired" | "revoked" | "used";

export type AccessWorkspace = {
  id: string;
  name: string;
  description: string;
  color: string | null;
  agencyId: string | null;
  roleOverrides: Partial<RoleMatrix>;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceMember = {
  workspaceId: string;
  userId: string;
  role: UserRole | null;
  allowance: Allowance;
  addedAt: number;
};

export type Assignment = { resourceType: ResourceType; resourceId: string; workspaceId: string };

export type AuditEntry = {
  id: number;
  ts: number;
  actor: string;
  action: string;
  method: string | null;
  target: string | null;
  allowed: boolean;
  detail: string | null;
};

const now = () => Date.now();

/** user_agent marker of admin "preview as user" sessions. */
export const PREVIEW_SESSION_TAG = "infinibot-preview";

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function inviteStatus(inv: AccessInvite, at = now()): InviteStatus {
  if (inv.revokedAt) return "revoked";
  if (inv.expiresAt !== null && inv.expiresAt <= at) return "expired";
  if (inv.maxUses !== null && inv.uses >= inv.maxUses) return "used";
  return "active";
}

export class AccessStore {
  readonly db: Database.Database;

  constructor(dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "access.db");
    this.db = new Database(file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL DEFAULT '',
        email TEXT,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        allowance TEXT NOT NULL DEFAULT '{}',
        disabled INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_active_at INTEGER,
        invited_by TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        workspace_ids TEXT NOT NULL DEFAULT '[]',
        allowance TEXT NOT NULL DEFAULT '{}',
        max_uses INTEGER,
        uses INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        revoked_at INTEGER,
        email TEXT,
        note TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT,
        agency_id TEXT,
        role_overrides TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT,
        allowance TEXT NOT NULL DEFAULT '{}',
        added_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS assignments (
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        PRIMARY KEY (resource_type, resource_id, workspace_id)
      );
      CREATE INDEX IF NOT EXISTS assignments_ws ON assignments(workspace_id);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        method TEXT,
        target TEXT,
        allowed INTEGER NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
    `);
  }

  close() {
    this.db.close();
  }

  // ── Users ──────────────────────────────────────────────────────────

  private rowToUser(r: Record<string, unknown>): AccessUser {
    return {
      id: String(r.id),
      username: String(r.username),
      displayName: String(r.display_name || r.username),
      email: (r.email as string) ?? null,
      role: isUserRole(r.role) ? r.role : "viewer",
      allowance: sanitizeAllowance(parseJson(r.allowance, {})),
      disabled: !!r.disabled,
      totpEnabled: !!r.totp_enabled,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      lastActiveAt: r.last_active_at == null ? null : Number(r.last_active_at),
      invitedBy: (r.invited_by as string) ?? null,
    };
  }

  countUsers(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  listUsers(): AccessUser[] {
    return (
      this.db.prepare("SELECT * FROM users ORDER BY created_at").all() as Record<string, unknown>[]
    ).map((r) => this.rowToUser(r));
  }

  getUser(id: string): AccessUser | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToUser(r) : null;
  }

  getUserByLogin(login: string): AccessUser | null {
    const r = this.db
      .prepare(
        "SELECT * FROM users WHERE username = ? COLLATE NOCASE OR (email IS NOT NULL AND email = ? COLLATE NOCASE)",
      )
      .get(login, login) as Record<string, unknown> | undefined;
    return r ? this.rowToUser(r) : null;
  }

  createUser(input: {
    username: string;
    password: string;
    role: UserRole;
    displayName?: string;
    email?: string | null;
    allowance?: Allowance;
    invitedBy?: string | null;
  }): AccessUser {
    const username = input.username.trim();
    if (!/^[a-zA-Z0-9._@-]{2,64}$/.test(username)) {
      throw new Error("Username must be 2-64 characters: letters, numbers, . _ @ -");
    }
    if (username.toLowerCase() === "owner") throw new Error("That username is reserved.");
    if (this.getUserByLogin(username)) throw new Error("That username is already taken.");
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, email, role, password_hash, allowance, created_at, updated_at, invited_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        username,
        (input.displayName ?? "").trim() || username,
        input.email?.trim() || null,
        input.role,
        hashPassword(input.password),
        JSON.stringify(sanitizeAllowance(input.allowance ?? {})),
        t,
        t,
        input.invitedBy ?? null,
      );
    return this.getUser(id)!;
  }

  updateUser(
    id: string,
    patch: Partial<{
      displayName: string;
      email: string | null;
      role: UserRole;
      allowance: Allowance;
      disabled: boolean;
      password: string;
    }>,
  ): AccessUser | null {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      vals.push(patch.displayName.trim());
    }
    if (patch.email !== undefined) {
      sets.push("email = ?");
      vals.push(patch.email?.trim() || null);
    }
    if (patch.role !== undefined && isUserRole(patch.role)) {
      sets.push("role = ?");
      vals.push(patch.role);
    }
    if (patch.allowance !== undefined) {
      sets.push("allowance = ?");
      vals.push(JSON.stringify(sanitizeAllowance(patch.allowance)));
    }
    if (patch.disabled !== undefined) {
      sets.push("disabled = ?");
      vals.push(patch.disabled ? 1 : 0);
    }
    if (patch.password !== undefined) {
      sets.push("password_hash = ?");
      vals.push(hashPassword(patch.password));
    }
    if (!sets.length) return this.getUser(id);
    sets.push("updated_at = ?");
    vals.push(now(), id);
    this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    // Disabling a user or resetting the password ends every live session.
    if (patch.disabled === true || patch.password !== undefined) this.revokeUserSessions(id);
    return this.getUser(id);
  }

  deleteUser(id: string): boolean {
    return this.db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
  }

  checkPassword(userId: string, password: string): boolean {
    const r = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
      | { password_hash: string }
      | undefined;
    return !!r && verifyPassword(password, r.password_hash);
  }

  getTotpSecret(userId: string): string | null {
    const r = this.db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(userId) as
      | { totp_secret: string | null }
      | undefined;
    return r?.totp_secret ?? null;
  }

  setTotp(userId: string, secret: string | null, enabled: boolean) {
    this.db
      .prepare("UPDATE users SET totp_secret = ?, totp_enabled = ?, updated_at = ? WHERE id = ?")
      .run(secret, enabled ? 1 : 0, now(), userId);
  }

  touchUser(userId: string, at = now()) {
    this.db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(at, userId);
  }

  // ── Sessions ───────────────────────────────────────────────────────

  createSession(userId: string, ttlMs: number, meta?: { userAgent?: string; ip?: string }) {
    const token = newToken(SESSION_TOKEN_PREFIX);
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sha256(token),
        userId,
        t,
        t + ttlMs,
        t,
        meta?.userAgent?.slice(0, 200) ?? null,
        meta?.ip ?? null,
      );
    if (meta?.userAgent !== PREVIEW_SESSION_TAG) this.touchUser(userId, t);
    return { token, session: { id, userId, createdAt: t, expiresAt: t + ttlMs, lastSeenAt: t } };
  }

  /** Resolve a raw session token to its live session + enabled user, or null. */
  resolveSession(token: string, at = now()): { session: AccessSession; user: AccessUser } | null {
    if (typeof token !== "string" || !token.startsWith(SESSION_TOKEN_PREFIX)) return null;
    const r = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sha256(token)) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    if (Number(r.expires_at) <= at) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(r.id);
      return null;
    }
    const user = this.getUser(String(r.user_id));
    if (!user || user.disabled) return null;
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(at, r.id);
    // An admin previewing as this user isn't the user being active.
    if (r.user_agent !== PREVIEW_SESSION_TAG) this.touchUser(user.id, at);
    return {
      user,
      session: {
        id: String(r.id),
        userId: user.id,
        createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at),
        lastSeenAt: at,
        userAgent: (r.user_agent as string) ?? null,
        ip: (r.ip as string) ?? null,
      },
    };
  }

  revokeSessionByToken(token: string): boolean {
    return (
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token)).changes > 0
    );
  }

  revokeUserSessions(userId: string): number {
    return this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes;
  }

  pruneExpiredSessions(at = now()): number {
    return this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(at).changes;
  }

  // ── Invites ────────────────────────────────────────────────────────

  private rowToInvite(r: Record<string, unknown>): AccessInvite {
    return {
      id: String(r.id),
      role: isUserRole(r.role) ? r.role : "viewer",
      workspaceIds: parseJson<string[]>(r.workspace_ids, []).filter((x) => typeof x === "string"),
      allowance: sanitizeAllowance(parseJson(r.allowance, {})),
      maxUses: r.max_uses == null ? null : Number(r.max_uses),
      uses: Number(r.uses),
      expiresAt: r.expires_at == null ? null : Number(r.expires_at),
      revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
      email: (r.email as string) ?? null,
      note: (r.note as string) ?? null,
      createdBy: String(r.created_by),
      createdAt: Number(r.created_at),
    };
  }

  createInvite(input: {
    role: UserRole;
    workspaceIds: string[];
    allowance?: Allowance;
    maxUses: number | null;
    expiresAt: number | null;
    email?: string | null;
    note?: string | null;
    createdBy: string;
  }): { token: string; invite: AccessInvite } {
    const token = newToken(INVITE_TOKEN_PREFIX);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO invites (id, token_hash, role, workspace_ids, allowance, max_uses, expires_at, email, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sha256(token),
        input.role,
        JSON.stringify(input.workspaceIds),
        JSON.stringify(sanitizeAllowance(input.allowance ?? {})),
        input.maxUses,
        input.expiresAt,
        input.email?.trim() || null,
        input.note?.trim() || null,
        input.createdBy,
        now(),
      );
    return { token, invite: this.getInvite(id)! };
  }

  getInvite(id: string): AccessInvite | null {
    const r = this.db.prepare("SELECT * FROM invites WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToInvite(r) : null;
  }

  findInviteByToken(token: string): AccessInvite | null {
    if (typeof token !== "string" || !token.startsWith(INVITE_TOKEN_PREFIX)) return null;
    const r = this.db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(token)) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToInvite(r) : null;
  }

  listInvites(): AccessInvite[] {
    return (
      this.db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as Record<
        string,
        unknown
      >[]
    ).map((r) => this.rowToInvite(r));
  }

  revokeInvite(id: string): boolean {
    return (
      this.db
        .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now(), id).changes > 0
    );
  }

  deleteInvite(id: string): boolean {
    return this.db.prepare("DELETE FROM invites WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Redeem an invite: create the user, add workspace memberships and bump the
   * use counter — atomically, so a single-use link can't be raced twice.
   */
  redeemInvite(
    token: string,
    input: { username: string; password: string; displayName?: string; email?: string | null },
  ): AccessUser {
    const tx = this.db.transaction(() => {
      const inv = this.findInviteByToken(token);
      if (!inv) throw new Error("invite_invalid");
      const status = inviteStatus(inv);
      if (status !== "active") throw new Error(`invite_${status}`);
      const user = this.createUser({
        username: input.username,
        password: input.password,
        role: inv.role,
        displayName: input.displayName,
        email: input.email ?? inv.email,
        allowance: inv.allowance,
        invitedBy: inv.createdBy,
      });
      for (const ws of inv.workspaceIds) {
        if (this.getWorkspace(ws)) this.setMember(ws, user.id, null, {});
      }
      this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE id = ?").run(inv.id);
      return user;
    });
    return tx();
  }

  // ── Workspaces + members ───────────────────────────────────────────

  private rowToWorkspace(r: Record<string, unknown>): AccessWorkspace {
    return {
      id: String(r.id),
      name: String(r.name),
      description: coerceString(r.description),
      color: (r.color as string) ?? null,
      agencyId: (r.agency_id as string) ?? null,
      roleOverrides: sanitizeMatrix(parseJson(r.role_overrides, {})),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  listWorkspaces(): AccessWorkspace[] {
    return (
      this.db.prepare("SELECT * FROM workspaces ORDER BY created_at").all() as Record<
        string,
        unknown
      >[]
    ).map((r) => this.rowToWorkspace(r));
  }

  getWorkspace(id: string): AccessWorkspace | null {
    const r = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToWorkspace(r) : null;
  }

  createWorkspace(input: {
    id?: string;
    name: string;
    description?: string;
    color?: string | null;
    agencyId?: string | null;
  }): AccessWorkspace {
    const name = input.name.trim();
    if (!name) throw new Error("Workspace name is required.");
    const id = input.id ?? randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, description, color, agency_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name.slice(0, 120),
        (input.description ?? "").slice(0, 500),
        input.color ?? null,
        input.agencyId ?? null,
        t,
        t,
      );
    return this.getWorkspace(id)!;
  }

  updateWorkspace(
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      color: string | null;
      roleOverrides: Partial<RoleMatrix>;
    }>,
  ): AccessWorkspace | null {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined && patch.name.trim()) {
      sets.push("name = ?");
      vals.push(patch.name.trim().slice(0, 120));
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      vals.push(patch.description.slice(0, 500));
    }
    if (patch.color !== undefined) {
      sets.push("color = ?");
      vals.push(patch.color);
    }
    if (patch.roleOverrides !== undefined) {
      sets.push("role_overrides = ?");
      vals.push(JSON.stringify(sanitizeMatrix(patch.roleOverrides)));
    }
    if (!sets.length) return this.getWorkspace(id);
    sets.push("updated_at = ?");
    vals.push(now(), id);
    this.db.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): boolean {
    return this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id).changes > 0;
  }

  private rowToMember(r: Record<string, unknown>): WorkspaceMember {
    return {
      workspaceId: String(r.workspace_id),
      userId: String(r.user_id),
      role: isUserRole(r.role) ? r.role : null,
      allowance: sanitizeAllowance(parseJson(r.allowance, {})),
      addedAt: Number(r.added_at),
    };
  }

  setMember(workspaceId: string, userId: string, role: UserRole | null, allowance: Allowance) {
    this.db
      .prepare(
        `INSERT INTO members (workspace_id, user_id, role, allowance, added_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role, allowance = excluded.allowance`,
      )
      .run(workspaceId, userId, role, JSON.stringify(sanitizeAllowance(allowance)), now());
  }

  removeMember(workspaceId: string, userId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM members WHERE workspace_id = ? AND user_id = ?")
        .run(workspaceId, userId).changes > 0
    );
  }

  listMembers(workspaceId?: string): WorkspaceMember[] {
    const rows = workspaceId
      ? this.db.prepare("SELECT * FROM members WHERE workspace_id = ?").all(workspaceId)
      : this.db.prepare("SELECT * FROM members").all();
    return (rows as Record<string, unknown>[]).map((r) => this.rowToMember(r));
  }

  membershipsForUser(userId: string): WorkspaceMember[] {
    return (
      this.db.prepare("SELECT * FROM members WHERE user_id = ?").all(userId) as Record<
        string,
        unknown
      >[]
    ).map((r) => this.rowToMember(r));
  }

  // ── Resource assignments ───────────────────────────────────────────

  assign(resourceType: ResourceType, resourceId: string, workspaceId: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO assignments (resource_type, resource_id, workspace_id) VALUES (?, ?, ?)",
      )
      .run(resourceType, resourceId, workspaceId);
  }

  unassign(resourceType: ResourceType, resourceId: string, workspaceId?: string): number {
    if (workspaceId) {
      return this.db
        .prepare(
          "DELETE FROM assignments WHERE resource_type = ? AND resource_id = ? AND workspace_id = ?",
        )
        .run(resourceType, resourceId, workspaceId).changes;
    }
    return this.db
      .prepare("DELETE FROM assignments WHERE resource_type = ? AND resource_id = ?")
      .run(resourceType, resourceId).changes;
  }

  workspacesForResource(resourceType: ResourceType, resourceId: string): string[] {
    return (
      this.db
        .prepare("SELECT workspace_id FROM assignments WHERE resource_type = ? AND resource_id = ?")
        .all(resourceType, resourceId) as { workspace_id: string }[]
    ).map((r) => r.workspace_id);
  }

  listAssignments(workspaceId?: string): Assignment[] {
    const rows = workspaceId
      ? this.db.prepare("SELECT * FROM assignments WHERE workspace_id = ?").all(workspaceId)
      : this.db.prepare("SELECT * FROM assignments").all();
    return (rows as Record<string, string>[]).map((r) => ({
      resourceType: r.resource_type as ResourceType,
      resourceId: r.resource_id,
      workspaceId: r.workspace_id,
    }));
  }

  // ── Settings (role matrix) ─────────────────────────────────────────

  getRoleMatrix(): Partial<RoleMatrix> {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = 'role_matrix'").get() as
      | { value: string }
      | undefined;
    return sanitizeMatrix(parseJson(r?.value, {}));
  }

  setRoleMatrix(matrix: Partial<RoleMatrix>) {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('role_matrix', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(sanitizeMatrix(matrix)));
  }

  // ── Audit ──────────────────────────────────────────────────────────

  audit(entry: Omit<AuditEntry, "id" | "ts"> & { ts?: number }) {
    this.db
      .prepare(
        "INSERT INTO audit (ts, actor, action, method, target, allowed, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.ts ?? now(),
        entry.actor,
        entry.action,
        entry.method,
        entry.target,
        entry.allowed ? 1 : 0,
        entry.detail,
      );
  }

  listAudit(opts: { limit?: number; actor?: string; deniedOnly?: boolean } = {}): AuditEntry[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts.actor) {
      where.push("actor = ?");
      vals.push(opts.actor);
    }
    if (opts.deniedOnly) where.push("allowed = 0");
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const rows = this.db
      .prepare(
        `SELECT * FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`,
      )
      .all(...vals) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      actor: String(r.actor),
      action: String(r.action),
      method: (r.method as string) ?? null,
      target: (r.target as string) ?? null,
      allowed: !!r.allowed,
      detail: (r.detail as string) ?? null,
    }));
  }

  pruneAudit(keep = 20_000) {
    this.db.prepare("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ?").run(keep);
  }
}

const stores = new Map<string, AccessStore>();

/** One store per directory (tests pass a temp dir; the gateway uses the shared state dir). */
export function getAccessStore(dir: string): AccessStore {
  let s = stores.get(dir);
  if (!s) {
    s = new AccessStore(dir);
    stores.set(dir, s);
  }
  return s;
}

export function closeAccessStores() {
  for (const s of stores.values()) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  stores.clear();
}
