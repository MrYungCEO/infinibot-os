/**
 * Directory Registry Store — SQLite-backed
 *
 * Maps local filesystem directories to projects, Notion databases,
 * agents, and metadata so the model always has context about
 * what directory = what project = what database = what agent's workspace.
 */

import { mkdirSync } from "fs";
import { join, normalize, sep } from "path";
import { resolveStateDir } from "../config/paths.js";
import Database from "better-sqlite3";

// Normalize a filesystem path using the OS-native separator and strip any
// trailing separator. The previous implementation force-converted "/" → "\"
// which corrupted every absolute path on POSIX hosts.
function normalizePath(p: string): string {
  const n = normalize(p);
  if (n.length > 1 && (n.endsWith(sep) || n.endsWith("/"))) return n.slice(0, -1);
  return n;
}
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("directories");

export interface DirectoryEntry {
  id: string;
  /** Absolute local path */
  path: string;
  /** Human-readable name */
  name: string;
  /** Federation peer this directory lives on. NULL/undefined = local peer. */
  peerId?: string;
  /** Human-readable label for the peer (e.g. device name). */
  peerLabel?: string;
  /** Optional description / purpose */
  description?: string;
  /** Associated Notion database ID */
  notionDatabaseId?: string;
  /** Associated Notion page ID (if it's a page, not a DB) */
  notionPageId?: string;
  /** Associated kanban project ID */
  projectId?: string;
  /** Associated agent ID (e.g. "main", "coder", "webdev") */
  agentId?: string;
  /** Tags for categorization (JSON array) */
  tags?: string[];
  /** Federation device IDs associated with this directory (JSON array) */
  nodeIds?: string[];
  /** Icon/emoji for UI */
  icon?: string;
  /** Git remote URL if applicable */
  gitRemote?: string;
  /** Whether this directory is actively used */
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export type DirectoryEntryCreate = Omit<DirectoryEntry, "id" | "createdAt" | "updatedAt">;
export type DirectoryEntryPatch = Partial<Omit<DirectoryEntry, "id" | "createdAt" | "updatedAt">>;

export class DirectoryStore {
  private db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "directories.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();
    const count = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM directories").get() as { cnt: number }
    ).cnt;
    log.info("Directory store loaded (SQLite)", { entries: count });
  }

  private createTables() {
    this.db.exec(`
            CREATE TABLE IF NOT EXISTS directories (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                notionDatabaseId TEXT,
                notionPageId TEXT,
                projectId TEXT,
                agentId TEXT,
                tags TEXT,
                nodeIds TEXT,
                icon TEXT,
                gitRemote TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_directories_path ON directories(path);
            CREATE INDEX IF NOT EXISTS idx_directories_projectId ON directories(projectId);
            CREATE INDEX IF NOT EXISTS idx_directories_agentId ON directories(agentId);
        `);
    // Idempotent migrations for existing installs missing newer columns.
    // Guard with PRAGMA table_info so we only ALTER when the column is absent.
    const existingCols = new Set(
      (this.db.prepare("PRAGMA table_info(directories)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    const addColumn = (name: string, type: string) => {
      if (!existingCols.has(name)) {
        try {
          this.db.exec(`ALTER TABLE directories ADD COLUMN ${name} ${type}`);
        } catch {
          /* already exists / race */
        }
      }
    };
    addColumn("nodeIds", "TEXT");
    // Federation peer awareness — NULL peer_id means "local peer".
    addColumn("peer_id", "TEXT");
    addColumn("peer_label", "TEXT");
  }

  private rowToEntry(row: any): DirectoryEntry {
    return {
      id: row.id,
      path: row.path,
      name: row.name,
      peerId: row.peer_id ?? undefined,
      peerLabel: row.peer_label ?? undefined,
      description: row.description ?? undefined,
      notionDatabaseId: row.notionDatabaseId ?? undefined,
      notionPageId: row.notionPageId ?? undefined,
      projectId: row.projectId ?? undefined,
      agentId: row.agentId ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      nodeIds: row.nodeIds ? JSON.parse(row.nodeIds) : undefined,
      icon: row.icon ?? undefined,
      gitRemote: row.gitRemote ?? undefined,
      active: row.active ? true : false,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** List all directory entries */
  list(opts?: {
    active?: boolean;
    agentId?: string;
    projectId?: string;
    peerId?: string;
  }): DirectoryEntry[] {
    let sql = "SELECT * FROM directories WHERE 1=1";
    const params: any[] = [];
    if (opts?.active !== undefined) {
      sql += " AND active = ?";
      params.push(opts.active ? 1 : 0);
    }
    if (opts?.agentId) {
      sql += " AND agentId = ?";
      params.push(opts.agentId);
    }
    if (opts?.projectId) {
      sql += " AND projectId = ?";
      params.push(opts.projectId);
    }
    if (opts?.peerId) {
      sql += " AND peer_id = ?";
      params.push(opts.peerId);
    }
    sql += " ORDER BY name ASC";
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => this.rowToEntry(r));
  }

  /** Get a single entry by ID */
  get(id: string): DirectoryEntry | null {
    const row = this.db.prepare("SELECT * FROM directories WHERE id = ?").get(id);
    return row ? this.rowToEntry(row) : null;
  }

  /**
   * Resolve directory by path — find the entry whose path matches or is a
   * parent. When `peerId` is supplied, only rows on that same peer match;
   * otherwise rows are matched regardless of peer.
   */
  resolve(dirPath: string, peerId?: string): DirectoryEntry | null {
    const normalized = normalizePath(dirPath);
    // Optional peer scoping appended to every probe.
    const peerClause = peerId ? " AND peer_id = ?" : "";
    const peerArgs = peerId ? [peerId] : [];
    // Try exact match first
    const exact = this.db
      .prepare(`SELECT * FROM directories WHERE path = ? AND active = 1${peerClause}`)
      .get(normalized, ...peerArgs);
    if (exact) return this.rowToEntry(exact);
    // Try case-insensitive match
    const ci = this.db
      .prepare(`SELECT * FROM directories WHERE LOWER(path) = LOWER(?) AND active = 1${peerClause}`)
      .get(normalized, ...peerArgs);
    if (ci) return this.rowToEntry(ci);
    // Walk up to find parent directory match
    const parts = normalized.split(sep);
    for (let i = parts.length - 1; i > 0; i--) {
      const parentPath = parts.slice(0, i).join(sep);
      const parent = this.db
        .prepare(
          `SELECT * FROM directories WHERE LOWER(path) = LOWER(?) AND active = 1${peerClause}`,
        )
        .get(parentPath, ...peerArgs);
      if (parent) return this.rowToEntry(parent);
    }
    return null;
  }

  /** Create a new directory entry */
  create(entry: DirectoryEntryCreate): DirectoryEntry {
    const now = Date.now();
    const id = crypto.randomUUID();
    const normalized = normalizePath(entry.path);
    this.db
      .prepare(
        `INSERT INTO directories (id, path, name, peer_id, peer_label, description, notionDatabaseId, notionPageId, projectId, agentId, tags, nodeIds, icon, gitRemote, active, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        normalized,
        entry.name,
        entry.peerId ?? null,
        entry.peerLabel ?? null,
        entry.description ?? null,
        entry.notionDatabaseId ?? null,
        entry.notionPageId ?? null,
        entry.projectId ?? null,
        entry.agentId ?? null,
        entry.tags ? JSON.stringify(entry.tags) : null,
        entry.nodeIds ? JSON.stringify(entry.nodeIds) : null,
        entry.icon ?? null,
        entry.gitRemote ?? null,
        entry.active ? 1 : 0,
        now,
        now,
      );
    log.info("Directory entry created", { id, path: normalized, name: entry.name });
    return this.get(id)!;
  }

  /** Update an existing entry */
  update(id: string, patch: DirectoryEntryPatch): DirectoryEntry | null {
    const existing = this.get(id);
    if (!existing) return null;
    const now = Date.now();
    const updated = { ...existing, ...patch, updatedAt: now };
    if (patch.path) updated.path = normalizePath(patch.path);
    this.db
      .prepare(
        `UPDATE directories SET path = ?, name = ?, peer_id = ?, peer_label = ?, description = ?, notionDatabaseId = ?, notionPageId = ?,
             projectId = ?, agentId = ?, tags = ?, nodeIds = ?, icon = ?, gitRemote = ?, active = ?, updatedAt = ?
             WHERE id = ?`,
      )
      .run(
        updated.path,
        updated.name,
        updated.peerId ?? null,
        updated.peerLabel ?? null,
        updated.description ?? null,
        updated.notionDatabaseId ?? null,
        updated.notionPageId ?? null,
        updated.projectId ?? null,
        updated.agentId ?? null,
        updated.tags ? JSON.stringify(updated.tags) : null,
        updated.nodeIds ? JSON.stringify(updated.nodeIds) : null,
        updated.icon ?? null,
        updated.gitRemote ?? null,
        updated.active ? 1 : 0,
        now,
        id,
      );
    log.info("Directory entry updated", { id, name: updated.name });
    return this.get(id);
  }

  /** Delete an entry */
  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM directories WHERE id = ?").run(id);
    if (result.changes > 0) log.info("Directory entry deleted", { id });
    return result.changes > 0;
  }

  /** Get context string for an agent — returns all directories mapped to that agent */
  getAgentContext(agentId: string): string {
    const entries = this.list({ active: true, agentId });
    if (entries.length === 0) return "";
    const lines = entries.map((e) => {
      let line = `- **${e.name}** → \`${e.path}\``;
      if (e.description) line += ` — ${e.description}`;
      if (e.projectId) line += ` [project: ${e.projectId}]`;
      if (e.notionDatabaseId) line += ` [notion: ${e.notionDatabaseId}]`;
      return line;
    });
    return `## Directory Mappings\n${lines.join("\n")}`;
  }

  /** Get context string for a specific working directory */
  getDirectoryContext(dirPath: string): string {
    const entry = this.resolve(dirPath);
    if (!entry) return "";
    let ctx = `Working in: **${entry.name}** (\`${entry.path}\`)`;
    if (entry.description) ctx += `\n${entry.description}`;
    if (entry.projectId) ctx += `\nProject ID: ${entry.projectId}`;
    if (entry.notionDatabaseId) ctx += `\nNotion DB: ${entry.notionDatabaseId}`;
    if (entry.agentId) ctx += `\nAssigned agent: ${entry.agentId}`;
    if (entry.tags?.length) ctx += `\nTags: ${entry.tags.join(", ")}`;
    return ctx;
  }
}

// ── Singleton ────────────────────────────────────────

// Per-state-dir instances so concurrent tenants (SaaS mode) each get their own
// directories.db. Defaults to the active (possibly tenant) state dir when no
// explicit dir is passed. Single-user local mode holds one entry.
const instances = new Map<string, DirectoryStore>();

export function getDirectoryStore(stateDir?: string): DirectoryStore {
  const dir = stateDir ?? resolveStateDir();
  let instance = instances.get(dir);
  if (!instance) {
    instance = new DirectoryStore(dir);
    instances.set(dir, instance);
  }
  return instance;
}
