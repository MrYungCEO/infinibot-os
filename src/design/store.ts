/**
 * Design page — SQLite store. Lives at `${stateDir}/design.db`.
 *
 * Three tables:
 *   design_projects   — brief, active skill/system, workspace path
 *   design_messages   — chat history per project (role + content + tool meta)
 *   design_artifacts  — files produced in the workspace (indexed by relative path)
 *
 * The project's workspace itself is on the filesystem under
 *   `${stateDir}/design-projects/<id>/`
 * — sqlite only holds metadata, the files are the source of truth for content.
 */

import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import Database from "better-sqlite3";

import type {
  DesignProject,
  DesignMessage,
  DesignArtifact,
  DesignBrief,
  ProjectKind,
} from "./types.js";

let instance: DesignStore | null = null;

export function getDesignStore(stateDir: string): DesignStore {
  if (instance) return instance;
  instance = new DesignStore(join(stateDir, "design.db"));
  return instance;
}

export function resetDesignStore(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS design_projects (
  id                       TEXT PRIMARY KEY,
  business_id              TEXT NOT NULL,
  name                     TEXT NOT NULL,
  kind                     TEXT NOT NULL,
  brief_json               TEXT,
  active_skill_id          TEXT,
  active_design_system_id  TEXT,
  model_id                 TEXT NOT NULL,
  workspace_dir            TEXT NOT NULL,
  last_active_at           INTEGER NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_projects_biz ON design_projects(business_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS design_messages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  meta_json   TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES design_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_design_messages_project ON design_messages(project_id, created_at);

CREATE TABLE IF NOT EXISTS design_artifacts (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  relative_path   TEXT NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  mime            TEXT NOT NULL,
  is_preview      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES design_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_design_artifacts_project ON design_artifacts(project_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_design_artifacts_path ON design_artifacts(project_id, relative_path);
`;

export class DesignStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── Projects ────────────────────────────────────────────────

  listProjects(businessId: string, limit = 100): DesignProject[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM design_projects WHERE business_id = ? ORDER BY last_active_at DESC LIMIT ?`,
      )
      .all(businessId, limit) as ProjectRow[];
    return rows.map(rowToProject);
  }

  getProject(id: string): DesignProject | null {
    const row = this.db.prepare(`SELECT * FROM design_projects WHERE id = ?`).get(id) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : null;
  }

  upsertProject(project: DesignProject): DesignProject {
    const now = Date.now();
    const next: DesignProject = {
      ...project,
      createdAt: project.createdAt || now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO design_projects
           (id, business_id, name, kind, brief_json, active_skill_id, active_design_system_id, model_id, workspace_dir, last_active_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.id,
        next.businessId,
        next.name,
        next.kind,
        next.brief ? JSON.stringify(next.brief) : null,
        next.activeSkillId,
        next.activeDesignSystemId,
        next.modelId,
        next.workspaceDir,
        next.lastActiveAt || now,
        next.createdAt,
        next.updatedAt,
      );
    return next;
  }

  deleteProject(id: string): boolean {
    return this.db.prepare(`DELETE FROM design_projects WHERE id = ?`).run(id).changes > 0;
  }

  // ── Messages ────────────────────────────────────────────────

  listMessages(projectId: string, limit = 500): DesignMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM design_messages WHERE project_id = ? ORDER BY created_at ASC LIMIT ?`)
      .all(projectId, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  appendMessage(msg: DesignMessage): DesignMessage {
    const now = msg.createdAt || Date.now();
    this.db
      .prepare(
        `INSERT INTO design_messages (id, project_id, role, content, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.projectId,
        msg.role,
        msg.content,
        msg.meta ? JSON.stringify(msg.meta) : null,
        now,
      );
    // Bump the project's lastActiveAt.
    this.db
      .prepare(`UPDATE design_projects SET last_active_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, msg.projectId);
    return { ...msg, createdAt: now };
  }

  // ── Artifacts ───────────────────────────────────────────────

  listArtifacts(projectId: string): DesignArtifact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM design_artifacts WHERE project_id = ? ORDER BY is_preview DESC, updated_at DESC`,
      )
      .all(projectId) as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  upsertArtifact(artifact: DesignArtifact): DesignArtifact {
    const now = Date.now();
    const next: DesignArtifact = {
      ...artifact,
      createdAt: artifact.createdAt || now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO design_artifacts
           (id, project_id, relative_path, name, kind, size, mime, is_preview, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.id,
        next.projectId,
        next.relativePath,
        next.name,
        next.kind,
        next.size,
        next.mime,
        next.isPreview ? 1 : 0,
        next.createdAt,
        next.updatedAt,
      );
    return next;
  }

  setPreviewArtifact(projectId: string, artifactId: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE design_artifacts SET is_preview = 0 WHERE project_id = ?`)
        .run(projectId);
      this.db
        .prepare(`UPDATE design_artifacts SET is_preview = 1 WHERE id = ? AND project_id = ?`)
        .run(artifactId, projectId);
    });
    tx();
  }

  dropArtifactByPath(projectId: string, relativePath: string): void {
    this.db
      .prepare(`DELETE FROM design_artifacts WHERE project_id = ? AND relative_path = ?`)
      .run(projectId, relativePath);
  }
}

// ── Row helpers ──────────────────────────────────────────────

interface ProjectRow {
  id: string;
  business_id: string;
  name: string;
  kind: string;
  brief_json: string | null;
  active_skill_id: string | null;
  active_design_system_id: string | null;
  model_id: string;
  workspace_dir: string;
  last_active_at: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  project_id: string;
  role: string;
  content: string;
  meta_json: string | null;
  created_at: number;
}

interface ArtifactRow {
  id: string;
  project_id: string;
  relative_path: string;
  name: string;
  kind: string;
  size: number;
  mime: string;
  is_preview: number;
  created_at: number;
  updated_at: number;
}

function rowToProject(r: ProjectRow): DesignProject {
  return {
    id: r.id,
    businessId: r.business_id,
    name: r.name,
    kind: r.kind as ProjectKind,
    brief: r.brief_json ? (JSON.parse(r.brief_json) as DesignBrief) : null,
    activeSkillId: r.active_skill_id,
    activeDesignSystemId: r.active_design_system_id,
    modelId: r.model_id,
    workspaceDir: r.workspace_dir,
    lastActiveAt: r.last_active_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMessage(r: MessageRow): DesignMessage {
  return {
    id: r.id,
    projectId: r.project_id,
    role: r.role as DesignMessage["role"],
    content: r.content,
    meta: r.meta_json ? (JSON.parse(r.meta_json) as Record<string, unknown>) : null,
    createdAt: r.created_at,
  };
}

function rowToArtifact(r: ArtifactRow): DesignArtifact {
  return {
    id: r.id,
    projectId: r.project_id,
    relativePath: r.relative_path,
    name: r.name,
    kind: r.kind as DesignArtifact["kind"],
    size: r.size,
    mime: r.mime,
    isPreview: r.is_preview === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
