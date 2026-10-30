import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { mkdirSync } from "fs";
import Database from "better-sqlite3";
import { KanbanState, KanbanProject, KanbanTask, ProjectPhase, TaskStatus } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getStateSyncManager } from "../federation/state-sync.js";
import { resolveStateDir } from "../config/paths.js";

const log = createSubsystemLogger("kanban");
/** Warn once per store+table about un-enforceable Notion identity. */
const notionIdentityWarned = new Set<string>();

export interface ProjectNote {
  id: string;
  projectId: string;
  title: string;
  content: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectAttachment {
  id: string;
  projectId: string;
  name: string;
  path: string;
  size: number;
  mimeType?: string;
  sha256?: string;
  markdownPath?: string;
  createdAt: number;
}

export interface ProjectBadge {
  id: string;
  projectId: string;
  label: string;
  color?: string;
  icon?: string;
  createdAt: number;
}

export type GitHubSyncStatus = "clean" | "behind" | "ahead" | "diverged" | "conflict" | "unknown";

export interface ProjectMeta {
  projectId: string;
  businessId?: string;
  mediaProjectId?: string;
  githubRepoUrl?: string;
  githubRepoOwner?: string;
  githubRepoName?: string;
  githubDefaultBranch?: string;
  githubLocalPath?: string;
  githubLastSyncAt?: number;
  githubSyncStatus?: GitHubSyncStatus;
  /** Invoice IDs from the agency-operations store that are linked to this project. */
  linkedInvoiceIds?: string[];
  updatedAt: number;
}

export interface ProjectTaskRollup {
  total: number;
  done: number;
  inProgress: number;
  review: number;
  blocked: number;
  overdue: number;
  /** In-progress tasks touched since the caller's `hotSince` cutoff. */
  hot: number;
  lastActivityAt: number;
}

export interface ProjectMetaPatch {
  businessId?: string | null;
  mediaProjectId?: string | null;
  githubRepoUrl?: string | null;
  githubRepoOwner?: string | null;
  githubRepoName?: string | null;
  githubDefaultBranch?: string | null;
  githubLocalPath?: string | null;
  githubLastSyncAt?: number | null;
  githubSyncStatus?: GitHubSyncStatus | null;
  linkedInvoiceIds?: string[] | null;
}

function rowToProjectMeta(row: any): ProjectMeta {
  let linkedInvoiceIds: string[] | undefined;
  if (row.linkedInvoiceIds) {
    try {
      linkedInvoiceIds = JSON.parse(row.linkedInvoiceIds);
    } catch {
      /* ignore */
    }
  }
  return {
    projectId: row.projectId,
    businessId: row.businessId ?? undefined,
    mediaProjectId: row.mediaProjectId ?? undefined,
    githubRepoUrl: row.githubRepoUrl ?? undefined,
    githubRepoOwner: row.githubRepoOwner ?? undefined,
    githubRepoName: row.githubRepoName ?? undefined,
    githubDefaultBranch: row.githubDefaultBranch ?? undefined,
    githubLocalPath: row.githubLocalPath ?? undefined,
    githubLastSyncAt: row.githubLastSyncAt ?? undefined,
    githubSyncStatus: row.githubSyncStatus ?? undefined,
    linkedInvoiceIds: Array.isArray(linkedInvoiceIds) ? linkedInvoiceIds : undefined,
    updatedAt: row.updatedAt,
  };
}

function rowToProjectNote(row: any): ProjectNote {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title ?? "",
    content: row.content ?? "",
    pinned: row.pinned ? true : false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToProjectAttachment(row: any): ProjectAttachment {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    path: row.path,
    size: row.size ?? 0,
    mimeType: row.mimeType ?? undefined,
    sha256: row.sha256 ?? undefined,
    markdownPath: row.markdownPath ?? undefined,
    createdAt: row.createdAt,
  };
}

function rowToProjectBadge(row: any): ProjectBadge {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    createdAt: row.createdAt,
  };
}

function rowToProjectPhase(row: any): ProjectPhase {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    ordinal: row.ordinal ?? 0,
    dueDate: row.dueDate ?? undefined,
    status: row.status ?? "planned",
    description: row.description ?? undefined,
    notionId: row.notionId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class KanbanStore {
  private db: Database.Database;
  private initialized = false;
  /** The state dir this store was opened against — used to detect profile switches. */
  readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, "kanban.db");
    const jsonPath = join(stateDir, "kanban.json");
    const needsMigration = !existsSync(dbPath) && existsSync(jsonPath);

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    // Enforce FK constraints so ON DELETE CASCADE works for newly-created tables.
    // Existing tables without REFERENCES clauses are unaffected by this pragma.
    this.db.pragma("foreign_keys = ON");

    this.createTables();
    this.addNotionColumns();
    this.createContentTables();

    if (needsMigration) {
      this.migrateFromJson(jsonPath);
    }

    // Ensure default project exists
    const projects = this.db.prepare("SELECT COUNT(*) as cnt FROM projects").get() as {
      cnt: number;
    };
    if (projects.cnt === 0) {
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO projects (id, name, description, color, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("default", "Main Project", "Default project", "#FFD700", now, now);
    }

    this.initialized = true;
    const taskCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM tasks").get() as { cnt: number }
    ).cnt;
    log.info("Kanban store loaded (SQLite)", { tasks: taskCount });
  }

  /** Close the underlying DB handle. Used when re-opening under a new profile. */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* best effort */
    }
  }

  private createTables() {
    this.db.exec(`
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                color TEXT,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                projectId TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'backlog',
                assignee TEXT,
                priority TEXT,
                tags TEXT,
                assignedAgent TEXT,
                requiredSpecialties TEXT,
                requiredTools TEXT,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_projectId ON tasks(projectId);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        `);
  }

  private createContentTables() {
    this.db.exec(`
            CREATE TABLE IF NOT EXISTS project_notes (
                id TEXT PRIMARY KEY,
                projectId TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                pinned INTEGER NOT NULL DEFAULT 0,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_project_notes_projectId ON project_notes(projectId);
            CREATE INDEX IF NOT EXISTS idx_project_notes_pinned ON project_notes(pinned);

            CREATE TABLE IF NOT EXISTS project_attachments (
                id TEXT PRIMARY KEY,
                projectId TEXT NOT NULL,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                mimeType TEXT,
                createdAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_project_attachments_projectId ON project_attachments(projectId);

            CREATE TABLE IF NOT EXISTS project_badges (
                id TEXT PRIMARY KEY,
                projectId TEXT NOT NULL,
                label TEXT NOT NULL,
                color TEXT,
                icon TEXT,
                createdAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_project_badges_projectId ON project_badges(projectId);

            CREATE TABLE IF NOT EXISTS project_meta (
                projectId TEXT PRIMARY KEY,
                businessId TEXT,
                mediaProjectId TEXT,
                githubRepoUrl TEXT,
                githubRepoOwner TEXT,
                githubRepoName TEXT,
                githubDefaultBranch TEXT,
                githubLocalPath TEXT,
                githubLastSyncAt INTEGER,
                githubSyncStatus TEXT,
                updatedAt INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_content_blocks (
                projectId TEXT PRIMARY KEY,
                blocks TEXT NOT NULL DEFAULT '[]',
                updatedAt INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS task_content_blocks (
                taskId TEXT PRIMARY KEY,
                blocks TEXT NOT NULL DEFAULT '[]',
                updatedAt INTEGER NOT NULL
            );
        `);
    // Idempotent migrations for pre-existing installs.
    const cols = this.db.prepare("PRAGMA table_info(project_meta)").all() as any[];
    const hasCol = (name: string) => cols.some((c: any) => c.name === name);
    if (!hasCol("mediaProjectId")) {
      this.db.exec("ALTER TABLE project_meta ADD COLUMN mediaProjectId TEXT");
      // One-way compatibility migration for installs that predate the generic
      // media-provider registry. New code never exposes the provider-specific
      // legacy field.
      if (hasCol("flypicProjectId")) {
        this.db.exec(
          "UPDATE project_meta SET mediaProjectId = flypicProjectId WHERE mediaProjectId IS NULL",
        );
      }
    }
    if (!hasCol("githubRepoUrl")) {
      this.db.exec("ALTER TABLE project_meta ADD COLUMN githubRepoUrl TEXT");
    }
    if (!hasCol("githubRepoOwner")) {
      this.db.exec("ALTER TABLE project_meta ADD COLUMN githubRepoOwner TEXT");
    }
    if (!hasCol("githubRepoName")) {
      this.db.exec("ALTER TABLE project_meta ADD COLUMN githubRepoName TEXT");
    }
    if (!hasCol("githubDefaultBranch")) {
      this.db.exec("ALTER TABLE project_meta ADD COLUMN githubDefaultBranch TEXT");
    }
    if (!hasCol("githubLocalPath")) {
      this.db.exec("ALTER TABLE project_meta ADD COLUMN githubLocalPath TEXT");
    }
    if (!hasCol("githubLastSyncAt")) {
      this.db.exec("ALTER TABLE project_meta ADD COLUMN githubLastSyncAt INTEGER");
    }
    if (!hasCol("githubSyncStatus")) {
      this.db.exec("ALTER TABLE project_meta ADD COLUMN githubSyncStatus TEXT");
    }
    if (!hasCol("linkedInvoiceIds")) {
      this.db.exec("ALTER TABLE project_meta ADD COLUMN linkedInvoiceIds TEXT");
    }
    // Idempotent migrations for project_attachments new fields.
    const attCols = this.db.prepare("PRAGMA table_info(project_attachments)").all() as any[];
    const hasAttCol = (name: string) => attCols.some((c: any) => c.name === name);
    if (!hasAttCol("sha256")) {
      this.db.exec("ALTER TABLE project_attachments ADD COLUMN sha256 TEXT");
    }
    if (!hasAttCol("markdownPath")) {
      this.db.exec("ALTER TABLE project_attachments ADD COLUMN markdownPath TEXT");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_project_attachments_sha256 ON project_attachments(projectId, sha256)",
    );
  }

  // ── Project Meta: Local-only fields (business, media, GitHub, etc.) ──
  getProjectMeta(projectId: string): ProjectMeta | null {
    const row = this.db
      .prepare("SELECT * FROM project_meta WHERE projectId = ?")
      .get(projectId) as any;
    if (!row) return null;
    return rowToProjectMeta(row);
  }

  getAllProjectMeta(): Record<string, ProjectMeta> {
    const rows = this.db.prepare("SELECT * FROM project_meta").all() as any[];
    const out: Record<string, ProjectMeta> = {};
    for (const r of rows) {
      out[r.projectId] = rowToProjectMeta(r);
    }
    return out;
  }

  setProjectMeta(projectId: string, patch: ProjectMetaPatch): void {
    const now = Date.now();
    const existing = this.getProjectMeta(projectId);
    const col = <T>(key: keyof ProjectMetaPatch, cur: T | undefined): T | null => {
      const v = patch[key];
      if (v === undefined) return cur ?? (null as any);
      return v === null || v === "" ? null : (v as any);
    };
    const githubRepoOwner = col("githubRepoOwner", existing?.githubRepoOwner);
    const githubRepoName = col("githubRepoName", existing?.githubRepoName);
    const linkedInvoiceIds =
      patch.linkedInvoiceIds === undefined
        ? existing?.linkedInvoiceIds
          ? JSON.stringify(existing.linkedInvoiceIds)
          : null
        : patch.linkedInvoiceIds === null
          ? null
          : JSON.stringify(patch.linkedInvoiceIds);
    this.db
      .prepare(
        `INSERT INTO project_meta
               (projectId, businessId, mediaProjectId, githubRepoUrl,
                githubRepoOwner, githubRepoName, githubDefaultBranch,
                githubLocalPath, githubLastSyncAt, githubSyncStatus, linkedInvoiceIds, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(projectId) DO UPDATE SET
               businessId = excluded.businessId,
               mediaProjectId = excluded.mediaProjectId,
               githubRepoUrl = excluded.githubRepoUrl,
               githubRepoOwner = excluded.githubRepoOwner,
               githubRepoName = excluded.githubRepoName,
               githubDefaultBranch = excluded.githubDefaultBranch,
               githubLocalPath = excluded.githubLocalPath,
               githubLastSyncAt = excluded.githubLastSyncAt,
               githubSyncStatus = excluded.githubSyncStatus,
               linkedInvoiceIds = excluded.linkedInvoiceIds,
               updatedAt = excluded.updatedAt`,
      )
      .run(
        projectId,
        col("businessId", existing?.businessId),
        col("mediaProjectId", existing?.mediaProjectId),
        col("githubRepoUrl", existing?.githubRepoUrl),
        githubRepoOwner,
        githubRepoName,
        col("githubDefaultBranch", existing?.githubDefaultBranch),
        col("githubLocalPath", existing?.githubLocalPath),
        patch.githubLastSyncAt === undefined
          ? (existing?.githubLastSyncAt ?? null)
          : (patch.githubLastSyncAt ?? null),
        col("githubSyncStatus", existing?.githubSyncStatus),
        linkedInvoiceIds,
        now,
      );
  }

  // ── Project Content: Notes ──────────────────────────────
  getProjectNotes(projectId: string): ProjectNote[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM project_notes WHERE projectId = ? ORDER BY pinned DESC, updatedAt DESC",
      )
      .all(projectId) as any[];
    return rows.map(rowToProjectNote);
  }

  getProjectNote(noteId: string): ProjectNote | null {
    const row = this.db.prepare("SELECT * FROM project_notes WHERE id = ?").get(noteId) as any;
    return row ? rowToProjectNote(row) : null;
  }

  createProjectNote(input: {
    projectId: string;
    title?: string;
    content?: string;
    pinned?: boolean;
  }): ProjectNote {
    const now = Date.now();
    const id = `note_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const note: ProjectNote = {
      id,
      projectId: input.projectId,
      title: input.title ?? "",
      content: input.content ?? "",
      pinned: Boolean(input.pinned),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO project_notes (id, projectId, title, content, pinned, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        note.id,
        note.projectId,
        note.title,
        note.content,
        note.pinned ? 1 : 0,
        note.createdAt,
        note.updatedAt,
      );
    return note;
  }

  updateProjectNote(
    noteId: string,
    patch: { title?: string; content?: string; pinned?: boolean },
  ): ProjectNote | null {
    const existing = this.getProjectNote(noteId);
    if (!existing) return null;
    const updated: ProjectNote = {
      ...existing,
      title: patch.title ?? existing.title,
      content: patch.content ?? existing.content,
      pinned: patch.pinned ?? existing.pinned,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        "UPDATE project_notes SET title = ?, content = ?, pinned = ?, updatedAt = ? WHERE id = ?",
      )
      .run(updated.title, updated.content, updated.pinned ? 1 : 0, updated.updatedAt, noteId);
    return updated;
  }

  deleteProjectNote(noteId: string): boolean {
    const res = this.db.prepare("DELETE FROM project_notes WHERE id = ?").run(noteId);
    return res.changes > 0;
  }

  // ── Project Content: Attachments ────────────────────────
  getProjectAttachments(projectId: string): ProjectAttachment[] {
    const rows = this.db
      .prepare("SELECT * FROM project_attachments WHERE projectId = ? ORDER BY createdAt DESC")
      .all(projectId) as any[];
    return rows.map(rowToProjectAttachment);
  }

  createProjectAttachment(input: {
    projectId: string;
    name: string;
    path: string;
    size?: number;
    mimeType?: string;
    sha256?: string;
    markdownPath?: string;
  }): ProjectAttachment {
    const now = Date.now();
    const id = `att_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const att: ProjectAttachment = {
      id,
      projectId: input.projectId,
      name: input.name,
      path: input.path,
      size: input.size ?? 0,
      mimeType: input.mimeType,
      sha256: input.sha256,
      markdownPath: input.markdownPath,
      createdAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO project_attachments (id, projectId, name, path, size, mimeType, sha256, markdownPath, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        att.id,
        att.projectId,
        att.name,
        att.path,
        att.size,
        att.mimeType ?? null,
        att.sha256 ?? null,
        att.markdownPath ?? null,
        att.createdAt,
      );
    return att;
  }

  findAttachmentBySha256(projectId: string, sha256: string): ProjectAttachment | null {
    const row = this.db
      .prepare("SELECT * FROM project_attachments WHERE projectId = ? AND sha256 = ? LIMIT 1")
      .get(projectId, sha256) as any;
    return row ? rowToProjectAttachment(row) : null;
  }

  deleteProjectAttachment(attachmentId: string): boolean {
    const res = this.db.prepare("DELETE FROM project_attachments WHERE id = ?").run(attachmentId);
    return res.changes > 0;
  }

  getProjectAttachmentById(id: string): ProjectAttachment | null {
    const row = this.db.prepare("SELECT * FROM project_attachments WHERE id = ?").get(id) as any;
    return row ? rowToProjectAttachment(row) : null;
  }

  /**
   * Persist the relative markdown path for an attachment after an on-demand
   * conversion (older uploads or a failed initial conversion). Returns true
   * when a row was updated.
   */
  updateProjectAttachmentMarkdownPath(id: string, markdownPath: string): boolean {
    const res = this.db
      .prepare("UPDATE project_attachments SET markdownPath = ? WHERE id = ?")
      .run(markdownPath, id);
    return res.changes > 0;
  }

  listAttachmentsSince(projectId: string | undefined, since: number): ProjectAttachment[] {
    const rows = projectId
      ? (this.db
          .prepare(
            "SELECT * FROM project_attachments WHERE projectId = ? AND createdAt > ? ORDER BY createdAt ASC",
          )
          .all(projectId, since) as any[])
      : (this.db
          .prepare("SELECT * FROM project_attachments WHERE createdAt > ? ORDER BY createdAt ASC")
          .all(since) as any[]);
    return rows.map(rowToProjectAttachment);
  }

  /**
   * Delete a project and all its related content rows in a single transaction.
   * Returns false if the project row did not exist.
   */
  deleteProjectCascade(projectId: string): boolean {
    const projectRow = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!projectRow) return false;

    this.db.transaction(() => {
      this.db.prepare("DELETE FROM project_notes WHERE projectId = ?").run(projectId);
      this.db.prepare("DELETE FROM project_attachments WHERE projectId = ?").run(projectId);
      this.db.prepare("DELETE FROM project_badges WHERE projectId = ?").run(projectId);
      this.db.prepare("DELETE FROM project_meta WHERE projectId = ?").run(projectId);
      this.db.prepare("DELETE FROM project_content_blocks WHERE projectId = ?").run(projectId);
      this.db.prepare("DELETE FROM project_phases WHERE projectId = ?").run(projectId);
      this.db.prepare("DELETE FROM tasks WHERE projectId = ?").run(projectId);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    })();

    return true;
  }

  // ── Project Content: Badges ─────────────────────────────
  getProjectBadges(projectId: string): ProjectBadge[] {
    const rows = this.db
      .prepare("SELECT * FROM project_badges WHERE projectId = ? ORDER BY createdAt ASC")
      .all(projectId) as any[];
    return rows.map(rowToProjectBadge);
  }

  createProjectBadge(input: {
    projectId: string;
    label: string;
    color?: string;
    icon?: string;
  }): ProjectBadge {
    const now = Date.now();
    const id = `badge_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const badge: ProjectBadge = {
      id,
      projectId: input.projectId,
      label: input.label,
      color: input.color,
      icon: input.icon,
      createdAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO project_badges (id, projectId, label, color, icon, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        badge.id,
        badge.projectId,
        badge.label,
        badge.color ?? null,
        badge.icon ?? null,
        badge.createdAt,
      );
    return badge;
  }

  deleteProjectBadge(badgeId: string): boolean {
    const res = this.db.prepare("DELETE FROM project_badges WHERE id = ?").run(badgeId);
    return res.changes > 0;
  }

  getProjectContent(projectId: string): {
    notes: ProjectNote[];
    attachments: ProjectAttachment[];
    badges: ProjectBadge[];
  } {
    return {
      notes: this.getProjectNotes(projectId),
      attachments: this.getProjectAttachments(projectId),
      badges: this.getProjectBadges(projectId),
    };
  }

  // ── Project Content: Block Editor (Notion-style) ────────
  getProjectContentBlocks(projectId: string): { blocks: any[]; updatedAt: number } {
    const row = this.db
      .prepare("SELECT blocks, updatedAt FROM project_content_blocks WHERE projectId = ?")
      .get(projectId) as any;
    if (!row) return { blocks: [], updatedAt: 0 };
    let blocks: any[] = [];
    try {
      blocks = JSON.parse(row.blocks);
    } catch {
      blocks = [];
    }
    return { blocks: Array.isArray(blocks) ? blocks : [], updatedAt: row.updatedAt };
  }

  saveProjectContentBlocks(projectId: string, blocks: any[]): { updatedAt: number } {
    const now = Date.now();
    const json = JSON.stringify(Array.isArray(blocks) ? blocks : []);
    this.db
      .prepare(
        `INSERT INTO project_content_blocks (projectId, blocks, updatedAt) VALUES (?, ?, ?)
             ON CONFLICT(projectId) DO UPDATE SET blocks = excluded.blocks, updatedAt = excluded.updatedAt`,
      )
      .run(projectId, json, now);
    return { updatedAt: now };
  }

  // ── Task Content: Block Editor (Notion-style, mirrors project content) ────
  // Every task carries its own full rich-document body, persisted as the same
  // canonical Block[] shape the project content editor uses. This powers the
  // full task detail "document page" in the UI.
  getTaskContentBlocks(taskId: string): { blocks: any[]; updatedAt: number } {
    const row = this.db
      .prepare("SELECT blocks, updatedAt FROM task_content_blocks WHERE taskId = ?")
      .get(taskId) as any;
    if (!row) return { blocks: [], updatedAt: 0 };
    let blocks: any[] = [];
    try {
      blocks = JSON.parse(row.blocks);
    } catch {
      blocks = [];
    }
    return { blocks: Array.isArray(blocks) ? blocks : [], updatedAt: row.updatedAt };
  }

  saveTaskContentBlocks(taskId: string, blocks: any[]): { updatedAt: number } {
    const now = Date.now();
    const json = JSON.stringify(Array.isArray(blocks) ? blocks : []);
    this.db
      .prepare(
        `INSERT INTO task_content_blocks (taskId, blocks, updatedAt) VALUES (?, ?, ?)
             ON CONFLICT(taskId) DO UPDATE SET blocks = excluded.blocks, updatedAt = excluded.updatedAt`,
      )
      .run(taskId, json, now);
    return { updatedAt: now };
  }

  private addNotionColumns() {
    const addCol = (table: string, col: string, type: string = "TEXT") => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      } catch {
        /* exists */
      }
    };
    // Projects
    addCol("projects", "notionPageId");
    addCol("projects", "type");
    addCol("projects", "status");
    addCol("projects", "priorityLevel");
    addCol("projects", "progress", "REAL");
    addCol("projects", "taskCount", "INTEGER");
    addCol("projects", "coverUrl");
    addCol("projects", "productUrl");
    addCol("projects", "dueDate");
    addCol("projects", "notionId");
    // Tasks
    addCol("tasks", "notionPageId");
    addCol("tasks", "phaseId");
    addCol("tasks", "done", "INTEGER");
    addCol("tasks", "dueDate");
    addCol("tasks", "department");
    addCol("tasks", "priorityLevel");
    addCol("tasks", "projectType");
    addCol("tasks", "classification");
    addCol("tasks", "funnelStage");
    addCol("tasks", "notionId");
    // Autonomous agent assignment
    addCol("tasks", "autonomous", "INTEGER"); // 0 or 1
    addCol("tasks", "autonomousStatus");
    // Style customization
    addCol("projects", "customIcon");
    addCol("projects", "iconColor");
    addCol("projects", "textColor");
    addCol("projects", "bgColor");
    addCol("projects", "borderColor");
    addCol("projects", "borderWidth", "REAL");
    addCol("projects", "borderStyle");
    addCol("tasks", "customIcon");
    addCol("tasks", "iconColor");
    addCol("tasks", "textColor");
    addCol("tasks", "bgColor");
    addCol("tasks", "effectPreset"); // UI animation effect
    // Federation properties - Tasks
    addCol("tasks", "node");
    addCol("tasks", "directory");
    addCol("tasks", "computeRequirements"); // JSON array
    addCol("tasks", "delegatedTo");
    addCol("tasks", "sourceNode");
    addCol("tasks", "nodeIds"); // JSON array of federation device IDs
    // Federation properties - Projects
    addCol("projects", "primaryNode");
    addCol("projects", "nodes"); // JSON array of node names
    addCol("projects", "nodeIds"); // JSON array of federation device IDs
    addCol("projects", "projectDirectory");
    addCol("projects", "shared", "INTEGER"); // 0 or 1
    // Cash-flow tracking for /projects.
    addCol("projects", "paidAmount", "REAL");
    addCol("projects", "pendingPay", "REAL");
    addCol("projects", "paidAmountDate");
    addCol("projects", "pendingPayDate");
    // Ordering - rank for vertical positioning
    addCol("projects", "rank", "REAL"); // Using REAL for fractional ranks (LexoRank style)
    addCol("tasks", "rank", "REAL");
    // Slug for project-level URLs.
    addCol("projects", "slug");
    // Database / page association — tasks can point at any database row.
    addCol("tasks", "associatedDatabaseId");
    addCol("tasks", "associatedRowId");
    addCol("tasks", "associatedSlug");
    addCol("tasks", "associatedUrl");
    // Completion timestamp — set when a task transitions to status "done".
    addCol("tasks", "completedAt", "INTEGER");
    // Parent-child project hierarchy — null = top-level project
    addCol("projects", "parentProjectId");
    // Idempotent backfill: populate completedAt for rows that were marked done
    // before this column existed (uses updatedAt as the best available proxy).
    this.db.exec(
      `UPDATE tasks SET completedAt = updatedAt
       WHERE (status = 'done' OR done = 1) AND completedAt IS NULL`,
    );
    // Slug uniqueness — partial index so legacy null rows don't conflict.
    try {
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug) WHERE slug IS NOT NULL",
      );
    } catch {
      /* index already exists */
    }
    this.ensureNotionIdentityIndexes();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_phases (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        name TEXT NOT NULL,
        ordinal INTEGER NOT NULL DEFAULT 0,
        dueDate TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        description TEXT,
        notionId TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_phases_projectId ON project_phases(projectId);
      CREATE INDEX IF NOT EXISTS idx_project_phases_ordinal ON project_phases(projectId, ordinal);
      CREATE INDEX IF NOT EXISTS idx_tasks_phaseId ON tasks(phaseId);
    `);
  }

  // ── Notion sync helpers ──────────────────────────────

  /**
   * One local row per Notion page: a partial UNIQUE index on `notionId`.
   * Installs that already hold duplicates (the pre-fix poller created a new
   * task every pull) can't take the unique index yet — they get a plain
   * index and `notionIdentityEnforced` stays false until the dedupe repair
   * (src/tasks/notion-dedupe-repair.ts) merges them and calls this again.
   */
  notionIdentityEnforced: Record<"projects" | "tasks", boolean> = { projects: false, tasks: false };

  ensureNotionIdentityIndexes(): void {
    for (const table of ["projects", "tasks"] as const) {
      try {
        this.db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_notion_unique ON ${table}(notionId) WHERE notionId IS NOT NULL AND notionId != ''`,
        );
        this.notionIdentityEnforced[table] = true;
      } catch {
        this.notionIdentityEnforced[table] = false;
        try {
          this.db.exec(
            `CREATE INDEX IF NOT EXISTS idx_${table}_notion_lookup ON ${table}(notionId)`,
          );
        } catch {
          /* best effort */
        }
        if (!notionIdentityWarned.has(`${this.stateDir}:${table}`)) {
          notionIdentityWarned.add(`${this.stateDir}:${table}`);
          log.warn(
            "kanban: duplicate Notion-linked rows present; unique Notion identity not enforced until the dedupe repair runs",
            { table },
          );
        }
      }
      try {
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS idx_${table}_notion_page ON ${table}(notionPageId)`,
        );
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Find the local row for a Notion page, whichever column recorded the
   * link (notionId — current; notionPageId — legacy; id — rows created with
   * the page id as their local id). Matches hyphenated and bare ids.
   * Returns the oldest match so a stray duplicate never wins.
   */
  findByNotionId(table: "projects" | "tasks", notionPageId: string): any {
    if (!notionPageId) return null;
    const bare = notionPageId.replace(/-/g, "").toLowerCase();
    const hyph =
      bare.length === 32
        ? `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`
        : notionPageId;
    const forms = Array.from(new Set([notionPageId, bare, hyph]));
    const ph = forms.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT * FROM ${table} WHERE notionId IN (${ph}) OR notionPageId IN (${ph}) OR id IN (${ph})
         ORDER BY createdAt ASC LIMIT 1`,
      )
      .get(...forms, ...forms, ...forms);
    return row ?? null;
  }

  setNotionPageId(table: "projects" | "tasks", localId: string, notionPageId: string): void {
    this.db.prepare(`UPDATE ${table} SET notionPageId = ? WHERE id = ?`).run(notionPageId, localId);
  }

  getNotionPageId(table: "projects" | "tasks", localId: string): string | null {
    const row = this.db
      .prepare(`SELECT notionPageId FROM ${table} WHERE id = ?`)
      .get(localId) as any;
    return row?.notionPageId ?? null;
  }

  getByNotionPageId(table: "projects" | "tasks", notionPageId: string): any {
    return this.findByNotionId(table, notionPageId);
  }

  private migrateFromJson(jsonPath: string) {
    try {
      const raw = readFileSync(jsonPath, "utf-8");
      const state: KanbanState = JSON.parse(raw);
      log.info("Migrating kanban data from JSON to SQLite", {
        projects: state.projects?.length ?? 0,
        tasks: state.tasks?.length ?? 0,
      });

      const insertProject = this.db.prepare(
        "INSERT OR IGNORE INTO projects (id, name, description, color, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertTask = this.db.prepare(
        "INSERT OR IGNORE INTO tasks (id, projectId, title, description, status, assignee, priority, tags, assignedAgent, requiredSpecialties, requiredTools, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );

      const migrate = this.db.transaction(() => {
        for (const p of state.projects || []) {
          insertProject.run(
            p.id,
            p.name,
            p.description ?? null,
            p.color ?? null,
            p.createdAt,
            p.updatedAt,
          );
        }
        for (const t of state.tasks || []) {
          const task = t as any;
          insertTask.run(
            task.id,
            task.projectId,
            task.title,
            task.description ?? null,
            task.status ?? "backlog",
            task.assignee ?? null,
            task.priority ?? null,
            task.tags ? JSON.stringify(task.tags) : null,
            task.assignedAgent ?? null,
            task.requiredSpecialties ? JSON.stringify(task.requiredSpecialties) : null,
            task.requiredTools ? JSON.stringify(task.requiredTools) : null,
            task.createdAt,
            task.updatedAt,
          );
        }
      });
      migrate();
      log.info("JSON → SQLite migration complete");
    } catch (err) {
      log.error("Failed to migrate from JSON", { err });
    }
  }

  private rowToProject(row: any): KanbanProject {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      color: row.color ?? undefined,
      type: row.type ? JSON.parse(row.type) : undefined,
      status: row.status ?? undefined,
      priority: row.priorityLevel ?? undefined,
      progress: row.progress ?? undefined,
      taskCount: row.taskCount ?? undefined,
      coverUrl: row.coverUrl ?? undefined,
      productUrl: row.productUrl ?? undefined,
      dueDate: row.dueDate ?? undefined,
      notionId: row.notionId ?? row.notionPageId ?? undefined,
      // Style customization
      customIcon: row.customIcon ?? undefined,
      iconColor: row.iconColor ?? undefined,
      textColor: row.textColor ?? undefined,
      bgColor: row.bgColor ?? undefined,
      borderColor: row.borderColor ?? undefined,
      borderWidth: typeof row.borderWidth === "number" ? row.borderWidth : undefined,
      borderStyle: (row.borderStyle as KanbanProject["borderStyle"]) ?? undefined,
      // Federation properties
      primaryNode: row.primaryNode ?? undefined,
      nodeIds: row.nodeIds ? JSON.parse(row.nodeIds) : undefined,
      projectDirectory: row.projectDirectory ?? undefined,
      shared: row.shared ? true : false,
      // Cash-flow tracking
      paidAmount: typeof row.paidAmount === "number" ? row.paidAmount : undefined,
      pendingPay: typeof row.pendingPay === "number" ? row.pendingPay : undefined,
      paidAmountDate: row.paidAmountDate ?? undefined,
      pendingPayDate: row.pendingPayDate ?? undefined,
      // Parent-child hierarchy
      parentProjectId: row.parentProjectId ?? null,
      // Ordering
      rank: row.rank ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToTask(row: any): KanbanTask {
    return {
      id: row.id,
      projectId: row.projectId,
      phaseId: row.phaseId ?? undefined,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status as TaskStatus,
      assignee: row.assignee ?? undefined,
      priority: row.priority ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      assignedAgent: row.assignedAgent ?? undefined,
      requiredSpecialties: row.requiredSpecialties
        ? JSON.parse(row.requiredSpecialties)
        : undefined,
      requiredTools: row.requiredTools ? JSON.parse(row.requiredTools) : undefined,
      autonomous: row.autonomous ? true : false,
      autonomousStatus: row.autonomousStatus ?? undefined,
      notionId: row.notionId ?? row.notionPageId ?? undefined,
      done: row.done ? true : false,
      dueDate: row.dueDate ?? undefined,
      department: row.department ? JSON.parse(row.department) : undefined,
      priorityLevel: row.priorityLevel ?? undefined,
      projectType: row.projectType ?? undefined,
      classification: row.classification ?? undefined,
      funnelStage: row.funnelStage ?? undefined,
      // Style customization
      customIcon: row.customIcon ?? undefined,
      iconColor: row.iconColor ?? undefined,
      textColor: row.textColor ?? undefined,
      bgColor: row.bgColor ?? undefined,
      // Federation properties
      node: row.node ?? undefined,
      nodeIds: row.nodeIds ? JSON.parse(row.nodeIds) : undefined,
      directory: row.directory ?? undefined,
      computeRequirements: row.computeRequirements
        ? JSON.parse(row.computeRequirements)
        : undefined,
      delegatedTo: row.delegatedTo ?? undefined,
      sourceNode: row.sourceNode ?? undefined,
      // Database / page association
      associatedDatabaseId: row.associatedDatabaseId ?? undefined,
      associatedRowId: row.associatedRowId ?? undefined,
      associatedSlug: row.associatedSlug ?? undefined,
      associatedUrl: row.associatedUrl ?? undefined,
      // Ordering
      rank: row.rank ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt ?? undefined,
    };
  }

  // Project phases
  listPhases(projectId: string): ProjectPhase[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM project_phases WHERE projectId = ? ORDER BY ordinal ASC, createdAt ASC",
      )
      .all(projectId) as any[];
    return rows.map(rowToProjectPhase);
  }

  createPhase(input: {
    projectId: string;
    name: string;
    dueDate?: string | null;
    description?: string | null;
    ordinal?: number;
  }): ProjectPhase {
    const now = Date.now();
    const maxOrdinal = (
      this.db
        .prepare("SELECT MAX(ordinal) as maxOrdinal FROM project_phases WHERE projectId = ?")
        .get(input.projectId) as any
    )?.maxOrdinal;
    const phase: ProjectPhase = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      name: input.name,
      ordinal: input.ordinal ?? (maxOrdinal ?? -1) + 1,
      dueDate: input.dueDate ?? undefined,
      status: "planned",
      description: input.description ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO project_phases
             (id, projectId, name, ordinal, dueDate, status, description, notionId, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        phase.id,
        phase.projectId,
        phase.name,
        phase.ordinal,
        phase.dueDate ?? null,
        phase.status,
        phase.description ?? null,
        phase.notionId ?? null,
        phase.createdAt,
        phase.updatedAt,
      );
    return phase;
  }

  updatePhase(
    id: string,
    patch: Partial<Pick<ProjectPhase, "name" | "status" | "ordinal">> & {
      dueDate?: string | null;
      description?: string | null;
      notionId?: string | null;
    },
  ): ProjectPhase | null {
    const row = this.db.prepare("SELECT * FROM project_phases WHERE id = ?").get(id) as any;
    if (!row) return null;
    const current = rowToProjectPhase(row);
    const now = Date.now();
    const updated: ProjectPhase = {
      ...current,
      ...patch,
      dueDate: Object.prototype.hasOwnProperty.call(patch, "dueDate")
        ? (patch.dueDate ?? undefined)
        : current.dueDate,
      description: Object.prototype.hasOwnProperty.call(patch, "description")
        ? (patch.description ?? undefined)
        : current.description,
      notionId: Object.prototype.hasOwnProperty.call(patch, "notionId")
        ? (patch.notionId ?? undefined)
        : current.notionId,
      updatedAt: now,
    };
    this.db
      .prepare(
        `UPDATE project_phases
             SET name = ?, ordinal = ?, dueDate = ?, status = ?, description = ?, notionId = ?, updatedAt = ?
             WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.ordinal,
        updated.dueDate ?? null,
        updated.status,
        updated.description ?? null,
        updated.notionId ?? null,
        updated.updatedAt,
        id,
      );
    return updated;
  }

  deletePhase(id: string): boolean {
    const existing = this.db.prepare("SELECT id FROM project_phases WHERE id = ?").get(id);
    if (!existing) return false;
    const remove = this.db.transaction(() => {
      this.db
        .prepare("UPDATE tasks SET phaseId = NULL, updatedAt = ? WHERE phaseId = ?")
        .run(Date.now(), id);
      this.db.prepare("DELETE FROM project_phases WHERE id = ?").run(id);
    });
    remove();
    return true;
  }

  reorderPhases(projectId: string, orderedIds: string[]): ProjectPhase[] {
    const now = Date.now();
    const stmt = this.db.prepare(
      "UPDATE project_phases SET ordinal = ?, updatedAt = ? WHERE id = ? AND projectId = ?",
    );
    const reorder = this.db.transaction(() => {
      orderedIds.forEach((id, index) => {
        stmt.run(index, now, id, projectId);
      });
    });
    reorder();
    return this.listPhases(projectId);
  }

  // Projects
  async getProjects(): Promise<KanbanProject[]> {
    // Order by rank first (nulls last), then by createdAt for unranked items
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY COALESCE(rank, 999999999) ASC, createdAt ASC")
      .all();
    return rows.map((r) => this.rowToProject(r));
  }

  async createProject(
    project: Omit<KanbanProject, "createdAt" | "updatedAt">,
  ): Promise<KanbanProject> {
    const now = Date.now();
    // Get max rank and add 1000 for new item (leaves room for insertions)
    const maxRank =
      (this.db.prepare("SELECT MAX(rank) as maxRank FROM projects").get() as any)?.maxRank ?? 0;
    const newRank = project.rank ?? maxRank + 1000;
    const newProject: KanbanProject = {
      ...project,
      rank: newRank,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, color, type, status, priorityLevel, progress, taskCount, coverUrl, productUrl, dueDate, notionId, primaryNode, nodeIds, projectDirectory, shared, paidAmount, pendingPay, paidAmountDate, pendingPayDate, parentProjectId, rank, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newProject.id,
        newProject.name,
        newProject.description ?? null,
        newProject.color ?? null,
        newProject.type ? JSON.stringify(newProject.type) : null,
        newProject.status ?? null,
        newProject.priority ?? null,
        newProject.progress ?? null,
        newProject.taskCount ?? null,
        newProject.coverUrl ?? null,
        newProject.productUrl ?? null,
        newProject.dueDate ?? null,
        newProject.notionId ?? null,
        newProject.primaryNode ?? null,
        newProject.nodeIds ? JSON.stringify(newProject.nodeIds) : null,
        newProject.projectDirectory ?? null,
        newProject.shared ? 1 : 0,
        typeof newProject.paidAmount === "number" ? newProject.paidAmount : null,
        typeof newProject.pendingPay === "number" ? newProject.pendingPay : null,
        newProject.paidAmountDate ?? null,
        newProject.pendingPayDate ?? null,
        newProject.parentProjectId ?? null,
        newRank,
        now,
        now,
      );

    // Sync to federation
    await this.syncProjectToFederation(newProject);

    return newProject;
  }

  // ── Project Status → Task Status Cascade Mapping ──────────
  private static PROJECT_TO_TASK_STATUS: Record<string, TaskStatus> = {
    "Not started": "todo",
    "In progress": "in_progress",
    Completed: "done",
    Paused: "backlog",
    Updating: "in_progress",
    "Awaiting Client": "review",
    Reviewing: "review",
    Cancelled: "done",
  };

  /**
   * Persist style customization (icon/colors/border) for a project that may not
   * yet have a local SQLite row — e.g. a Notion-only project the user just
   * customized for the first time. Inserts a minimal stub row when needed so
   * subsequent reads/merges include the style.
   */
  setProjectStyle(
    id: string,
    stylePatch: Partial<
      Pick<
        KanbanProject,
        | "customIcon"
        | "iconColor"
        | "textColor"
        | "bgColor"
        | "borderColor"
        | "borderWidth"
        | "borderStyle"
      >
    >,
  ): void {
    const existing = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
    const now = Date.now();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO projects (id, name, customIcon, iconColor, textColor, bgColor, borderColor, borderWidth, borderStyle, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          "",
          stylePatch.customIcon ?? null,
          stylePatch.iconColor ?? null,
          stylePatch.textColor ?? null,
          stylePatch.bgColor ?? null,
          stylePatch.borderColor ?? null,
          typeof stylePatch.borderWidth === "number" ? stylePatch.borderWidth : null,
          stylePatch.borderStyle ?? null,
          now,
          now,
        );
      return;
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    const setIfPresent = (key: keyof typeof stylePatch, val: unknown) => {
      if (Object.prototype.hasOwnProperty.call(stylePatch, key)) {
        sets.push(`${key} = ?`);
        values.push(val);
      }
    };
    setIfPresent("customIcon", stylePatch.customIcon ?? null);
    setIfPresent("iconColor", stylePatch.iconColor ?? null);
    setIfPresent("textColor", stylePatch.textColor ?? null);
    setIfPresent("bgColor", stylePatch.bgColor ?? null);
    setIfPresent("borderColor", stylePatch.borderColor ?? null);
    setIfPresent(
      "borderWidth",
      typeof stylePatch.borderWidth === "number" ? stylePatch.borderWidth : null,
    );
    setIfPresent("borderStyle", stylePatch.borderStyle ?? null);
    if (sets.length === 0) return;
    sets.push("updatedAt = ?");
    values.push(now);
    values.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  async updateProject(
    id: string,
    patch: Partial<KanbanProject>,
    options?: { cascadeStatus?: boolean },
  ): Promise<KanbanProject | null> {
    const existing = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    if (!existing) return null;

    const now = Date.now();
    const previousProject = this.rowToProject(existing);
    const updated = { ...previousProject, ...patch, updatedAt: now };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, color = ?, type = ?, status = ?, priorityLevel = ?,
             progress = ?, taskCount = ?, coverUrl = ?, productUrl = ?, dueDate = ?, notionId = ?,
             customIcon = ?, iconColor = ?, textColor = ?, bgColor = ?,
             borderColor = ?, borderWidth = ?, borderStyle = ?,
             primaryNode = ?, nodeIds = ?, projectDirectory = ?, shared = ?,
             paidAmount = ?, pendingPay = ?, paidAmountDate = ?, pendingPayDate = ?,
             parentProjectId = ?, rank = ?, updatedAt = ?
             WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.description ?? null,
        updated.color ?? null,
        updated.type ? JSON.stringify(updated.type) : null,
        updated.status ?? null,
        updated.priority ?? null,
        updated.progress ?? null,
        updated.taskCount ?? null,
        updated.coverUrl ?? null,
        updated.productUrl ?? null,
        updated.dueDate ?? null,
        updated.notionId ?? null,
        updated.customIcon ?? null,
        updated.iconColor ?? null,
        updated.textColor ?? null,
        updated.bgColor ?? null,
        updated.borderColor ?? null,
        typeof updated.borderWidth === "number" ? updated.borderWidth : null,
        updated.borderStyle ?? null,
        updated.primaryNode ?? null,
        updated.nodeIds ? JSON.stringify(updated.nodeIds) : null,
        updated.projectDirectory ?? null,
        updated.shared ? 1 : 0,
        typeof updated.paidAmount === "number" ? updated.paidAmount : null,
        typeof updated.pendingPay === "number" ? updated.pendingPay : null,
        updated.paidAmountDate ?? null,
        updated.pendingPayDate ?? null,
        (updated as any).parentProjectId ?? null,
        updated.rank ?? null,
        now,
        id,
      );

    // ── Cascade status to all tasks when project status changes ──
    const shouldCascade = options?.cascadeStatus !== false; // Default true
    if (shouldCascade && patch.status && patch.status !== previousProject.status) {
      const targetTaskStatus = KanbanStore.PROJECT_TO_TASK_STATUS[patch.status];
      if (targetTaskStatus) {
        const cascadeResult = this.db
          .prepare(`UPDATE tasks SET status = ?, done = ?, updatedAt = ? WHERE projectId = ?`)
          .run(targetTaskStatus, targetTaskStatus === "done" ? 1 : 0, now, id);
        log.info("Cascaded project status to tasks", {
          projectId: id,
          projectStatus: patch.status,
          taskStatus: targetTaskStatus,
          tasksUpdated: cascadeResult.changes,
        });
      }
    }

    // Sync to federation
    await this.syncProjectToFederation(updated);

    return updated;
  }

  async deleteProject(id: string): Promise<boolean> {
    const existing = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    if (!existing) return false;

    const deleteAll = this.db.transaction(() => {
      this.db.prepare("DELETE FROM tasks WHERE projectId = ?").run(id);
      this.db.prepare("DELETE FROM project_phases WHERE projectId = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
    deleteAll();
    return true;
  }

  /**
   * Per-project task rollups in ONE aggregate query — lets callers (the
   * knowledge graph) show progress/health without hydrating every task row.
   * `today` is an ISO date (YYYY-MM-DD) used for the overdue check; `hotSince`
   * is a unix-ms cutoff for "recently touched in-progress" work.
   */
  getProjectTaskRollups(today: string, hotSince: number): Map<string, ProjectTaskRollup> {
    const rows = this.db
      .prepare(
        `SELECT projectId,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'done' OR done = 1 THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS inProgress,
                SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review,
                SUM(CASE WHEN autonomousStatus IN ('blocked','failed') THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN dueDate IS NOT NULL AND dueDate != '' AND substr(dueDate, 1, 10) < ?
                          AND status != 'done' AND COALESCE(done, 0) = 0 THEN 1 ELSE 0 END) AS overdue,
                SUM(CASE WHEN status = 'in_progress' AND updatedAt >= ? THEN 1 ELSE 0 END) AS hot,
                MAX(updatedAt) AS lastActivityAt
           FROM tasks
          GROUP BY projectId`,
      )
      .all(today, hotSince) as Array<Record<string, unknown>>;
    const out = new Map<string, ProjectTaskRollup>();
    for (const r of rows) {
      if (typeof r.projectId !== "string") continue;
      out.set(r.projectId, {
        total: Number(r.total) || 0,
        done: Number(r.done) || 0,
        inProgress: Number(r.inProgress) || 0,
        review: Number(r.review) || 0,
        blocked: Number(r.blocked) || 0,
        overdue: Number(r.overdue) || 0,
        hot: Number(r.hot) || 0,
        lastActivityAt: Number(r.lastActivityAt) || 0,
      });
    }
    return out;
  }

  /** Newest-first tasks (optionally for one project), capped — cheap lazy expansion. */
  getRecentTasks(limit: number, projectId?: string): KanbanTask[] {
    const n = Math.max(1, Math.floor(limit));
    const rows = projectId
      ? this.db
          .prepare("SELECT * FROM tasks WHERE projectId = ? ORDER BY updatedAt DESC LIMIT ?")
          .all(projectId, n)
      : this.db.prepare("SELECT * FROM tasks ORDER BY updatedAt DESC LIMIT ?").all(n);
    return rows.map((r) => this.rowToTask(r));
  }

  // Tasks
  async getTasks(projectId?: string): Promise<KanbanTask[]> {
    // Order by rank first (nulls last), then by createdAt for unranked items
    if (projectId) {
      const rows = this.db
        .prepare(
          "SELECT * FROM tasks WHERE projectId = ? ORDER BY COALESCE(rank, 999999999) ASC, createdAt ASC",
        )
        .all(projectId);
      return rows.map((r) => this.rowToTask(r));
    }
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY COALESCE(rank, 999999999) ASC, createdAt ASC")
      .all();
    return rows.map((r) => this.rowToTask(r));
  }

  getTaskById(id: string): KanbanTask | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!row) return null;
    return this.rowToTask(row);
  }

  listTasksSince(since: number, projectId?: string): KanbanTask[] {
    const rows = projectId
      ? (this.db
          .prepare(
            "SELECT * FROM tasks WHERE projectId = ? AND updatedAt > ? ORDER BY updatedAt ASC",
          )
          .all(projectId, since) as any[])
      : (this.db
          .prepare("SELECT * FROM tasks WHERE updatedAt > ? ORDER BY updatedAt ASC")
          .all(since) as any[]);
    return rows.map((r) => this.rowToTask(r));
  }

  async createTask(
    task: Omit<KanbanTask, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<KanbanTask> {
    const now = Date.now();
    // Honour a caller-supplied id (the Notion pull passes the page id so the
    // row is addressable by it); otherwise mint one.
    const id = typeof task.id === "string" && task.id ? task.id : crypto.randomUUID();
    // Get max rank for this status column and add 1000 for new item
    const maxRank =
      (
        this.db
          .prepare("SELECT MAX(rank) as maxRank FROM tasks WHERE status = ?")
          .get(task.status) as any
      )?.maxRank ?? 0;
    const newRank = task.rank ?? maxRank + 1000;
    const isDone = task.status === "done" || task.done === true;
    const newTask: KanbanTask = {
      ...task,
      id,
      rank: newRank,
      createdAt: now,
      updatedAt: now,
      completedAt: isDone ? now : undefined,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, projectId, phaseId, title, description, status, assignee, priority, tags, assignedAgent, requiredSpecialties, requiredTools, done, dueDate, department, priorityLevel, projectType, classification, funnelStage, notionId, node, nodeIds, directory, computeRequirements, delegatedTo, sourceNode, associatedDatabaseId, associatedRowId, associatedSlug, associatedUrl, rank, createdAt, updatedAt, completedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        newTask.projectId,
        newTask.phaseId ?? null,
        newTask.title,
        newTask.description ?? null,
        newTask.status,
        newTask.assignee ?? null,
        (newTask as any).priority ?? null,
        newTask.tags ? JSON.stringify(newTask.tags) : null,
        newTask.assignedAgent ?? null,
        newTask.requiredSpecialties ? JSON.stringify(newTask.requiredSpecialties) : null,
        newTask.requiredTools ? JSON.stringify(newTask.requiredTools) : null,
        newTask.done ? 1 : 0,
        newTask.dueDate ?? null,
        newTask.department ? JSON.stringify(newTask.department) : null,
        newTask.priorityLevel ?? null,
        newTask.projectType ?? null,
        newTask.classification ?? null,
        newTask.funnelStage ?? null,
        newTask.notionId ?? null,
        newTask.node ?? null,
        newTask.nodeIds ? JSON.stringify(newTask.nodeIds) : null,
        newTask.directory ?? null,
        newTask.computeRequirements ? JSON.stringify(newTask.computeRequirements) : null,
        newTask.delegatedTo ?? null,
        newTask.sourceNode ?? null,
        newTask.associatedDatabaseId ?? null,
        newTask.associatedRowId ?? null,
        newTask.associatedSlug ?? null,
        newTask.associatedUrl ?? null,
        newRank,
        now,
        now,
        newTask.completedAt ?? null,
      );

    // Sync to federation
    await this.syncTaskToFederation(newTask);

    return newTask;
  }

  async updateTask(id: string, patch: Partial<KanbanTask>): Promise<KanbanTask | null> {
    const existing = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!existing) return null;

    const now = Date.now();
    const current = this.rowToTask(existing);

    // ── Bidirectional sync: done checkbox ↔ status ──
    // If done is being set to true, also set status to "done"
    if (patch.done === true && patch.status === undefined) {
      patch.status = "done";
    }
    // If done is being set to false and status was "done", reset to "todo"
    if (patch.done === false && current.status === "done" && patch.status === undefined) {
      patch.status = "todo";
    }
    // If status is being set to "done", also set done to true
    if (patch.status === "done" && patch.done === undefined) {
      patch.done = true;
    }
    // If status is being changed from "done" to something else, set done to false
    if (
      patch.status &&
      patch.status !== "done" &&
      current.status === "done" &&
      patch.done === undefined
    ) {
      patch.done = false;
    }

    // Set completedAt on the first transition to "done"; never clear it once set.
    const transitioningToDone =
      (patch.status === "done" || patch.done === true) && !current.completedAt;
    const updatedCompletedAt = transitioningToDone ? now : (current.completedAt ?? undefined);
    const updated = { ...current, ...patch, updatedAt: now, completedAt: updatedCompletedAt };

    this.db
      .prepare(
        `UPDATE tasks SET projectId = ?, title = ?, description = ?, status = ?, assignee = ?,
             priority = ?, tags = ?, assignedAgent = ?, requiredSpecialties = ?, requiredTools = ?,
             autonomous = ?, autonomousStatus = ?,
             done = ?, dueDate = ?, department = ?, priorityLevel = ?, projectType = ?, classification = ?, funnelStage = ?, notionId = ?,
             customIcon = ?, iconColor = ?, textColor = ?, bgColor = ?,
             node = ?, nodeIds = ?, directory = ?, computeRequirements = ?, delegatedTo = ?, sourceNode = ?,
             associatedDatabaseId = ?, associatedRowId = ?, associatedSlug = ?, associatedUrl = ?,
             phaseId = ?, rank = ?, updatedAt = ?, completedAt = ?
             WHERE id = ?`,
      )
      .run(
        updated.projectId,
        updated.title,
        updated.description ?? null,
        updated.status,
        updated.assignee ?? null,
        (updated as any).priority ?? null,
        updated.tags ? JSON.stringify(updated.tags) : null,
        updated.assignedAgent ?? null,
        updated.requiredSpecialties ? JSON.stringify(updated.requiredSpecialties) : null,
        updated.requiredTools ? JSON.stringify(updated.requiredTools) : null,
        updated.autonomous ? 1 : 0,
        updated.autonomousStatus ?? null,
        updated.done ? 1 : 0,
        updated.dueDate ?? null,
        updated.department ? JSON.stringify(updated.department) : null,
        updated.priorityLevel ?? null,
        updated.projectType ?? null,
        updated.classification ?? null,
        updated.funnelStage ?? null,
        updated.notionId ?? null,
        updated.customIcon ?? null,
        updated.iconColor ?? null,
        updated.textColor ?? null,
        updated.bgColor ?? null,
        updated.node ?? null,
        updated.nodeIds ? JSON.stringify(updated.nodeIds) : null,
        updated.directory ?? null,
        updated.computeRequirements ? JSON.stringify(updated.computeRequirements) : null,
        updated.delegatedTo ?? null,
        updated.sourceNode ?? null,
        updated.associatedDatabaseId ?? null,
        updated.associatedRowId ?? null,
        updated.associatedSlug ?? null,
        updated.associatedUrl ?? null,
        updated.phaseId ?? null,
        updated.rank ?? null,
        now,
        updated.completedAt ?? null,
        id,
      );

    // Sync to federation
    await this.syncTaskToFederation(updated);

    // Oversight rule #16: a P1 (Immediate/High) task transitioning INTO a blocked
    // state fires an immediate on-event notification. Best-effort + dynamic import
    // so it never affects the write path.
    const wasBlocked = current.autonomousStatus === "blocked";
    const isBlocked = updated.autonomousStatus === "blocked";
    const isP1 = updated.priorityLevel === "Immediate" || updated.priorityLevel === "High";
    if (isP1 && isBlocked && !wasBlocked) {
      void import("../reports/trigger.js")
        .then(({ fireEventTriggers }) => {
          fireEventTriggers("kanban_p1_blocked", {
            eventType: "kanban_p1_blocked",
            title: `P1 blocked — ${updated.title}`,
            summary: `Priority ${updated.priorityLevel} task "${updated.title}" moved to BLOCKED.`,
            taskId: updated.id,
            actions: ["Unblock or reassign this critical task now."],
          });
        })
        .catch(() => {
          /* triggers unavailable — non-fatal */
        });
    }

    return updated;
  }

  async deleteTask(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    try {
      this.db.prepare("DELETE FROM task_content_blocks WHERE taskId = ?").run(id);
    } catch {
      /* content table may not exist on very old installs */
    }
    return result.changes > 0;
  }

  // ── Reorder methods for drag-and-drop ──────────────────────────────

  /**
   * Reorder a task within its status column.
   * Calculates a new rank between the items above and below.
   * @param taskId - The task to move
   * @param beforeTaskId - The task that will be AFTER this one (or null if moving to end)
   * @param afterTaskId - The task that will be BEFORE this one (or null if moving to start)
   */
  async reorderTask(
    taskId: string,
    beforeTaskId: string | null,
    afterTaskId: string | null,
  ): Promise<KanbanTask | null> {
    const task = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    if (!task) return null;

    let newRank: number;

    if (!afterTaskId && !beforeTaskId) {
      // Only item, or moving to empty position
      newRank = 1000;
    } else if (!afterTaskId) {
      // Moving to start
      const beforeTask = this.db
        .prepare("SELECT rank FROM tasks WHERE id = ?")
        .get(beforeTaskId) as any;
      newRank = (beforeTask?.rank ?? 1000) / 2;
    } else if (!beforeTaskId) {
      // Moving to end
      const afterTask = this.db
        .prepare("SELECT rank FROM tasks WHERE id = ?")
        .get(afterTaskId) as any;
      newRank = (afterTask?.rank ?? 0) + 1000;
    } else {
      // Moving between two items
      const afterTask = this.db
        .prepare("SELECT rank FROM tasks WHERE id = ?")
        .get(afterTaskId) as any;
      const beforeTask = this.db
        .prepare("SELECT rank FROM tasks WHERE id = ?")
        .get(beforeTaskId) as any;
      newRank = ((afterTask?.rank ?? 0) + (beforeTask?.rank ?? 2000)) / 2;
    }

    return this.updateTask(taskId, { rank: newRank });
  }

  /**
   * Reorder a project in the project list.
   */
  async reorderProject(
    projectId: string,
    beforeProjectId: string | null,
    afterProjectId: string | null,
  ): Promise<KanbanProject | null> {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return null;

    let newRank: number;

    if (!afterProjectId && !beforeProjectId) {
      newRank = 1000;
    } else if (!afterProjectId) {
      const beforeProject = this.db
        .prepare("SELECT rank FROM projects WHERE id = ?")
        .get(beforeProjectId) as any;
      newRank = (beforeProject?.rank ?? 1000) / 2;
    } else if (!beforeProjectId) {
      const afterProject = this.db
        .prepare("SELECT rank FROM projects WHERE id = ?")
        .get(afterProjectId) as any;
      newRank = (afterProject?.rank ?? 0) + 1000;
    } else {
      const afterProject = this.db
        .prepare("SELECT rank FROM projects WHERE id = ?")
        .get(afterProjectId) as any;
      const beforeProject = this.db
        .prepare("SELECT rank FROM projects WHERE id = ?")
        .get(beforeProjectId) as any;
      newRank = ((afterProject?.rank ?? 0) + (beforeProject?.rank ?? 2000)) / 2;
    }

    return this.updateProject(projectId, { rank: newRank });
  }

  /**
   * Bulk set ranks for a list of task IDs (in order).
   * Useful for full column reorder.
   */
  async setTaskRanks(taskIds: string[]): Promise<void> {
    const stmt = this.db.prepare("UPDATE tasks SET rank = ?, updatedAt = ? WHERE id = ?");
    const now = Date.now();
    const bulkUpdate = this.db.transaction(() => {
      taskIds.forEach((id, index) => {
        stmt.run((index + 1) * 1000, now, id);
      });
    });
    bulkUpdate();
  }

  /**
   * Bulk set ranks for a list of project IDs (in order).
   */
  async setProjectRanks(projectIds: string[]): Promise<void> {
    const stmt = this.db.prepare("UPDATE projects SET rank = ?, updatedAt = ? WHERE id = ?");
    const now = Date.now();
    const bulkUpdate = this.db.transaction(() => {
      projectIds.forEach((id, index) => {
        stmt.run((index + 1) * 1000, now, id);
      });
    });
    bulkUpdate();
  }

  /**
   * Normalize all ranks in a status column (fix gaps/conflicts).
   */
  async normalizeTaskRanks(status: string): Promise<void> {
    const tasks = this.db
      .prepare(
        "SELECT id FROM tasks WHERE status = ? ORDER BY COALESCE(rank, 999999999) ASC, createdAt ASC",
      )
      .all(status) as any[];
    await this.setTaskRanks(tasks.map((t) => t.id));
  }

  // ── Federation Sync Methods ──────────────────────────────────────────

  /**
   * Sync a task to the federation network via the StateSyncManager.
   */
  private async syncTaskToFederation(task: KanbanTask): Promise<void> {
    try {
      const syncManager = getStateSyncManager();
      if (!syncManager) {
        log.debug("StateSyncManager not available, skipping task sync");
        return;
      }

      // Use task ID as the path for unique identification across nodes
      await syncManager.pushChange("kanban", `task/${task.id}`, task);
      log.debug("Synced task to federation", { taskId: task.id, title: task.title });
    } catch (err) {
      log.error("Failed to sync task to federation", { taskId: task.id, error: err });
    }
  }

  /**
   * Sync a project to the federation network via the StateSyncManager.
   */
  private async syncProjectToFederation(project: KanbanProject): Promise<void> {
    try {
      const syncManager = getStateSyncManager();
      if (!syncManager) {
        log.debug("StateSyncManager not available, skipping project sync");
        return;
      }

      // Use project ID as the path for unique identification across nodes
      await syncManager.pushChange("kanban", `project/${project.id}`, project);
      log.debug("Synced project to federation", { projectId: project.id, name: project.name });
    } catch (err) {
      log.error("Failed to sync project to federation", { projectId: project.id, error: err });
    }
  }

  /**
   * Handle incoming sync data from the federation.
   * This method should be called by the StateSyncManager when it receives kanban updates.
   */
  async handleFederationSync(path: string, data: KanbanTask | KanbanProject): Promise<void> {
    try {
      if (path.startsWith("task/")) {
        const task = data as KanbanTask;
        const existing = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);

        if (existing) {
          // Update existing task (without triggering another sync)
          await this.updateTaskDirect(task.id, task);
          log.debug("Updated task from federation", { taskId: task.id });
        } else {
          // Create new task (without triggering another sync)
          await this.createTaskDirect(task);
          log.debug("Created task from federation", { taskId: task.id });
        }
      } else if (path.startsWith("project/")) {
        const project = data as KanbanProject;
        const existing = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id);

        if (existing) {
          // Update existing project (without triggering another sync)
          await this.updateProjectDirect(project.id, project);
          log.debug("Updated project from federation", { projectId: project.id });
        } else {
          // Create new project (without triggering another sync)
          await this.createProjectDirect(project);
          log.debug("Created project from federation", { projectId: project.id });
        }
      }
    } catch (err) {
      log.error("Failed to handle federation sync", { path, error: err });
    }
  }

  /**
   * Create a task directly without triggering federation sync.
   * Used when receiving updates from other nodes.
   */
  private async createTaskDirect(task: KanbanTask): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks (id, projectId, phaseId, title, description, status, assignee, priority, tags, assignedAgent, requiredSpecialties, requiredTools, done, dueDate, department, priorityLevel, projectType, classification, funnelStage, notionId, node, directory, computeRequirements, delegatedTo, sourceNode, associatedDatabaseId, associatedRowId, associatedSlug, associatedUrl, rank, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectId,
        task.phaseId ?? null,
        task.title,
        task.description ?? null,
        task.status,
        task.assignee ?? null,
        (task as any).priority ?? null,
        task.tags ? JSON.stringify(task.tags) : null,
        task.assignedAgent ?? null,
        task.requiredSpecialties ? JSON.stringify(task.requiredSpecialties) : null,
        task.requiredTools ? JSON.stringify(task.requiredTools) : null,
        task.done ? 1 : 0,
        task.dueDate ?? null,
        task.department ? JSON.stringify(task.department) : null,
        task.priorityLevel ?? null,
        task.projectType ?? null,
        task.classification ?? null,
        task.funnelStage ?? null,
        task.notionId ?? null,
        task.node ?? null,
        task.directory ?? null,
        task.computeRequirements ? JSON.stringify(task.computeRequirements) : null,
        task.delegatedTo ?? null,
        task.sourceNode ?? null,
        task.associatedDatabaseId ?? null,
        task.associatedRowId ?? null,
        task.associatedSlug ?? null,
        task.associatedUrl ?? null,
        task.rank ?? null,
        task.createdAt,
        task.updatedAt,
      );
  }

  /**
   * Update a task directly without triggering federation sync.
   * Used when receiving updates from other nodes.
   */
  private async updateTaskDirect(id: string, task: KanbanTask): Promise<void> {
    this.db
      .prepare(
        `UPDATE tasks SET projectId = ?, title = ?, description = ?, status = ?, assignee = ?,
             priority = ?, tags = ?, assignedAgent = ?, requiredSpecialties = ?, requiredTools = ?,
             autonomous = ?, autonomousStatus = ?,
             done = ?, dueDate = ?, department = ?, priorityLevel = ?, projectType = ?, classification = ?, funnelStage = ?, notionId = ?,
             customIcon = ?, iconColor = ?, textColor = ?, bgColor = ?,
             node = ?, directory = ?, computeRequirements = ?, delegatedTo = ?, sourceNode = ?,
             associatedDatabaseId = ?, associatedRowId = ?, associatedSlug = ?, associatedUrl = ?,
             phaseId = ?, rank = ?, updatedAt = ?
             WHERE id = ?`,
      )
      .run(
        task.projectId,
        task.title,
        task.description ?? null,
        task.status,
        task.assignee ?? null,
        (task as any).priority ?? null,
        task.tags ? JSON.stringify(task.tags) : null,
        task.assignedAgent ?? null,
        task.requiredSpecialties ? JSON.stringify(task.requiredSpecialties) : null,
        task.requiredTools ? JSON.stringify(task.requiredTools) : null,
        task.autonomous ? 1 : 0,
        task.autonomousStatus ?? null,
        task.done ? 1 : 0,
        task.dueDate ?? null,
        task.department ? JSON.stringify(task.department) : null,
        task.priorityLevel ?? null,
        task.projectType ?? null,
        task.classification ?? null,
        task.funnelStage ?? null,
        task.notionId ?? null,
        task.customIcon ?? null,
        task.iconColor ?? null,
        task.textColor ?? null,
        task.bgColor ?? null,
        task.node ?? null,
        task.directory ?? null,
        task.computeRequirements ? JSON.stringify(task.computeRequirements) : null,
        task.delegatedTo ?? null,
        task.sourceNode ?? null,
        task.associatedDatabaseId ?? null,
        task.associatedRowId ?? null,
        task.associatedSlug ?? null,
        task.associatedUrl ?? null,
        task.phaseId ?? null,
        task.rank ?? null,
        task.updatedAt,
        id,
      );
  }

  /**
   * Create a project directly without triggering federation sync.
   * Used when receiving updates from other nodes.
   */
  private async createProjectDirect(project: KanbanProject): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO projects (id, name, description, color, type, status, priorityLevel, progress, taskCount, coverUrl, productUrl, dueDate, notionId, primaryNode, projectDirectory, shared, paidAmount, pendingPay, paidAmountDate, pendingPayDate, parentProjectId, rank, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.description ?? null,
        project.color ?? null,
        project.type ? JSON.stringify(project.type) : null,
        project.status ?? null,
        project.priority ?? null,
        project.progress ?? null,
        project.taskCount ?? null,
        project.coverUrl ?? null,
        project.productUrl ?? null,
        project.dueDate ?? null,
        project.notionId ?? null,
        project.primaryNode ?? null,
        project.projectDirectory ?? null,
        project.shared ? 1 : 0,
        typeof project.paidAmount === "number" ? project.paidAmount : null,
        typeof project.pendingPay === "number" ? project.pendingPay : null,
        project.paidAmountDate ?? null,
        project.pendingPayDate ?? null,
        (project as any).parentProjectId ?? null,
        project.rank ?? null,
        project.createdAt,
        project.updatedAt,
      );
  }

  /**
   * Update a project directly without triggering federation sync.
   * Used when receiving updates from other nodes.
   */
  private async updateProjectDirect(id: string, project: KanbanProject): Promise<void> {
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, color = ?, type = ?, status = ?, priorityLevel = ?,
             progress = ?, taskCount = ?, coverUrl = ?, productUrl = ?, dueDate = ?, notionId = ?,
             customIcon = ?, iconColor = ?, textColor = ?, bgColor = ?,
             borderColor = ?, borderWidth = ?, borderStyle = ?,
             primaryNode = ?, projectDirectory = ?, shared = ?,
             paidAmount = ?, pendingPay = ?, paidAmountDate = ?, pendingPayDate = ?,
             parentProjectId = ?, rank = ?, updatedAt = ?
             WHERE id = ?`,
      )
      .run(
        project.name,
        project.description ?? null,
        project.color ?? null,
        project.type ? JSON.stringify(project.type) : null,
        project.status ?? null,
        project.priority ?? null,
        project.progress ?? null,
        project.taskCount ?? null,
        project.coverUrl ?? null,
        project.productUrl ?? null,
        project.dueDate ?? null,
        project.notionId ?? null,
        project.customIcon ?? null,
        project.iconColor ?? null,
        project.textColor ?? null,
        project.bgColor ?? null,
        project.borderColor ?? null,
        typeof project.borderWidth === "number" ? project.borderWidth : null,
        project.borderStyle ?? null,
        project.primaryNode ?? null,
        project.projectDirectory ?? null,
        project.shared ? 1 : 0,
        typeof project.paidAmount === "number" ? project.paidAmount : null,
        typeof project.pendingPay === "number" ? project.pendingPay : null,
        project.paidAmountDate ?? null,
        project.pendingPayDate ?? null,
        (project as any).parentProjectId ?? null,
        project.rank ?? null,
        project.updatedAt,
        id,
      );
  }
}

// Per-state-dir instances. Keyed by the resolved state dir so that in
// multi-tenant SaaS mode, concurrent requests from different tenants each get
// their own open kanban.db — a single re-opening slot would race (close one
// tenant's handle mid-flight while another awaits). For single-user local mode
// this holds exactly one entry (the active profile's dir).
const storeInstances = new Map<string, KanbanStore>();

export function getKanbanStore(stateDir?: string): KanbanStore {
  const targetDir = stateDir ?? resolveStateDir();
  let inst = storeInstances.get(targetDir);
  if (!inst) {
    inst = new KanbanStore(targetDir);
    storeInstances.set(targetDir, inst);
  }
  return inst;
}
