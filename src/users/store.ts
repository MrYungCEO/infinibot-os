/**
 * User Store — SQLite-backed multi-user system.
 *
 * Each user gets:
 *   • a unique username + email
 *   • a user password (the one they type at the login screen)
 *   • a gateway password (the one used to authenticate the WebSocket)
 *     — the gateway already validates this; the store keeps it so a
 *     successful user-login can hand it off to the WebSocket layer
 *   • a per-user home directory under <stateDir>/users/<username>/ —
 *     the equivalent of admin's `.clawd` workspace, where subagents
 *     read/write/create projects by default
 *   • language + free-form context that the agent prepends to every
 *     session's system prompt
 *   • a page allowlist for nav gating (empty = full access)
 *   • optional agent-directory locking — when enabled the agent's
 *     cwd is pinned to homeDir and tools that touch the filesystem
 *     refuse paths outside the allowed dir set
 *
 * Storage: a single SQLite table next to the rest of the gateway state.
 * Passwords are hashed with Node's built-in scrypt.
 */

import Database from "better-sqlite3";
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export type UserRole = "admin" | "user";

export interface User {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  /** Free-form language label, e.g. "en", "th", "Spanish — formal register". */
  language: string;
  /** Free-form text prepended to the agent's system prompt for this user. */
  context: string;
  /** Absolute path to the user's per-user workspace directory. */
  homeDir: string;
  /** When true, agents are confined to homeDir + allowedDirs. */
  agentGatingEnabled: boolean;
  /**
   * Extra directories the agent can read/write when gating is on.
   * Empty array = only homeDir. Admin role bypasses gating entirely.
   */
  allowedDirs: string[];
  /**
   * Page-route allowlist for nav gating. Empty array = unrestricted.
   * Admin role bypasses this entirely.
   */
  allowedPages: string[];
  createdAt: number;
  updatedAt: number;
}

export interface UserCreateInput {
  username: string;
  email?: string | null;
  /** Plain-text password the user types at login; hashed before storage. */
  password: string;
  /** Plain-text gateway password used by the WebSocket layer. */
  gatewayPassword: string;
  role?: UserRole;
  language?: string;
  context?: string;
  homeDir?: string;
  agentGatingEnabled?: boolean;
  allowedDirs?: string[];
  allowedPages?: string[];
}

export type UserPatch = Partial<{
  username: string;
  email: string | null;
  password: string; // plain-text; hashed before storage
  gatewayPassword: string; // plain-text
  role: UserRole;
  language: string;
  context: string;
  homeDir: string;
  agentGatingEnabled: boolean;
  allowedDirs: string[];
  allowedPages: string[];
}>;

// ── Password hashing ─────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;

function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(plain, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString("hex")}`;
}

function verifyHash(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expected = Buffer.from(parts[5], "hex");
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const derived = scryptSync(plain, salt, expected.length, { N, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ── Helpers ──────────────────────────────────────────────────────

function defaultHomeDir(stateDir: string, username: string): string {
  const safe = username.replace(/[^a-zA-Z0-9._-]/g, "_");
  return resolve(stateDir, "users", safe);
}

function ensureHomeDir(homeDir: string): void {
  if (!existsSync(homeDir)) {
    mkdirSync(homeDir, { recursive: true });
  }
}

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  passwordHash: string;
  gatewayPassword: string;
  role: string;
  language: string;
  context: string;
  homeDir: string;
  agentGatingEnabled: 0 | 1;
  allowedDirs: string;
  allowedPages: string;
  createdAt: number;
  updatedAt: number;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role === "admin" ? "admin" : "user",
    language: row.language,
    context: row.context,
    homeDir: row.homeDir,
    agentGatingEnabled: !!row.agentGatingEnabled,
    allowedDirs: parseJsonArray(row.allowedDirs),
    allowedPages: parseJsonArray(row.allowedPages),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJsonArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// ── Store ────────────────────────────────────────────────────────

export class UserStore {
  private db: Database.Database;
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    const dbDir = resolve(stateDir);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    this.db = new Database(join(dbDir, "users.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT,
        passwordHash TEXT NOT NULL,
        gatewayPassword TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        language TEXT NOT NULL DEFAULT '',
        context TEXT NOT NULL DEFAULT '',
        homeDir TEXT NOT NULL,
        agentGatingEnabled INTEGER NOT NULL DEFAULT 0,
        allowedDirs TEXT NOT NULL DEFAULT '[]',
        allowedPages TEXT NOT NULL DEFAULT '[]',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
    `);
  }

  list(): User[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY createdAt ASC").all() as UserRow[];
    return rows.map(rowToUser);
  }

  count(): number {
    const r = this.db.prepare("SELECT COUNT(*) as n FROM users").get() as { n: number };
    return r.n;
  }

  get(id: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  getByUsername(username: string): User | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE lower(username) = lower(?)")
      .get(username) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  /**
   * Find a user by username OR email. Used at login since the user can
   * type either. Case-insensitive.
   */
  getByLogin(login: string): User | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)")
      .get(login, login) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  create(input: UserCreateInput): User {
    if (!input.username.trim()) throw new Error("username required");
    if (!input.password) throw new Error("password required");
    if (!input.gatewayPassword) throw new Error("gatewayPassword required");
    if (this.getByUsername(input.username)) {
      throw new Error(`username "${input.username}" already exists`);
    }
    const id = `user_${randomUUID()}`;
    const now = Date.now();
    const homeDir = input.homeDir || defaultHomeDir(this.stateDir, input.username);
    ensureHomeDir(homeDir);

    const role: UserRole = input.role === "admin" ? "admin" : "user";
    this.db
      .prepare(
        `INSERT INTO users
          (id, username, email, passwordHash, gatewayPassword, role, language, context,
           homeDir, agentGatingEnabled, allowedDirs, allowedPages, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.username.trim(),
        input.email?.trim() || null,
        hashPassword(input.password),
        input.gatewayPassword,
        role,
        input.language ?? "en",
        input.context ?? "",
        homeDir,
        input.agentGatingEnabled ? 1 : 0,
        JSON.stringify(input.allowedDirs ?? []),
        JSON.stringify(input.allowedPages ?? []),
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, patch: UserPatch): User | null {
    const current = this.get(id);
    if (!current) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (patch.username !== undefined) {
      const trimmed = patch.username.trim();
      if (!trimmed) throw new Error("username cannot be empty");
      const collision = this.getByUsername(trimmed);
      if (collision && collision.id !== id) {
        throw new Error(`username "${trimmed}" already taken`);
      }
      fields.push("username = ?");
      values.push(trimmed);
    }
    if (patch.email !== undefined) {
      fields.push("email = ?");
      values.push(patch.email ? patch.email.trim() : null);
    }
    if (patch.password !== undefined && patch.password.length > 0) {
      fields.push("passwordHash = ?");
      values.push(hashPassword(patch.password));
    }
    if (patch.gatewayPassword !== undefined && patch.gatewayPassword.length > 0) {
      fields.push("gatewayPassword = ?");
      values.push(patch.gatewayPassword);
    }
    if (patch.role !== undefined) {
      fields.push("role = ?");
      values.push(patch.role === "admin" ? "admin" : "user");
    }
    if (patch.language !== undefined) {
      fields.push("language = ?");
      values.push(patch.language);
    }
    if (patch.context !== undefined) {
      fields.push("context = ?");
      values.push(patch.context);
    }
    if (patch.homeDir !== undefined) {
      const dir = patch.homeDir.trim() || defaultHomeDir(this.stateDir, current.username);
      ensureHomeDir(dir);
      fields.push("homeDir = ?");
      values.push(dir);
    }
    if (patch.agentGatingEnabled !== undefined) {
      fields.push("agentGatingEnabled = ?");
      values.push(patch.agentGatingEnabled ? 1 : 0);
    }
    if (patch.allowedDirs !== undefined) {
      fields.push("allowedDirs = ?");
      values.push(JSON.stringify(patch.allowedDirs));
    }
    if (patch.allowedPages !== undefined) {
      fields.push("allowedPages = ?");
      values.push(JSON.stringify(patch.allowedPages));
    }

    if (fields.length === 0) return current;

    fields.push("updatedAt = ?");
    values.push(Date.now());
    values.push(id);

    this.db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  delete(id: string): boolean {
    const r = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return r.changes > 0;
  }

  /**
   * Authenticate by username|email + plaintext password. Returns the
   * full user (including gatewayPassword so the caller can hand it to
   * the WebSocket connect step) or null on failure. Constant-time
   * comparison via scrypt + timingSafeEqual.
   */
  authenticate(login: string, password: string): { user: User; gatewayPassword: string } | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)")
      .get(login, login) as UserRow | undefined;
    if (!row) return null;
    if (!verifyHash(password, row.passwordHash)) return null;
    return { user: rowToUser(row), gatewayPassword: row.gatewayPassword };
  }

  /**
   * Look up a user by gateway password — used after the WebSocket
   * handshake to map an authenticated connection back to its owning
   * user account so subsequent calls can apply that user's gating
   * rules. Returns null when no user uses the password (e.g. legacy
   * single-tenant gateways where the password is the bare admin one).
   */
  findByGatewayPassword(password: string): User | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE gatewayPassword = ?")
      .get(password) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }
}

// ── Singleton ────────────────────────────────────────────────────

let _store: UserStore | null = null;

export function getUserStore(stateDir: string): UserStore {
  if (!_store) _store = new UserStore(stateDir);
  return _store;
}

export function resetUserStoreForTests(): void {
  _store = null;
}
