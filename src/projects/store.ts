/**
 * Deep Memory Architecture — SQLite Persistence Layer
 *
 * Crash-safe storage for project sessions, checkpoints, and audit logs.
 * Uses write-ahead logging for durability.
 */

import Database from "better-sqlite3";
import { resolve, join } from "path";
import { mkdirSync, existsSync } from "fs";
import { resolveStateDir } from "../config/paths.js";
import type {
  ProjectSession,
  ProjectStatus,
  ProjectProgress,
  Checkpoint,
  CheckpointReason,
  AuditEntry,
  AuditEvent,
  ProjectSummary,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// STORE SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getProjectStore(stateDir?: string): ProjectStore {
  // resolveStateDir() already honors INFINIBOT_STATE_DIR AND layers per-user
  // namespacing on top, so a profile switch re-points the dir and the
  // dir-keyed open below opens the active profile's projects.db.
  const dir = stateDir || resolveStateDir();

  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }

  return new ProjectStore(db, dir);
}

function initDatabase(stateDir: string): Database.Database {
  const dbPath = resolve(stateDir, "projects.db");

  // Ensure directory exists
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent access and crash safety
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  db.exec(SCHEMA);
  ensureRichContentColumn(db);

  return db;
}

// Adds the `content_json` column on legacy databases that predate rich docs.
function ensureRichContentColumn(db: Database.Database) {
  try {
    db.exec(`ALTER TABLE project_sessions ADD COLUMN content_json TEXT`);
  } catch {
    // already exists
  }
}

// ═══════════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════════

const SCHEMA = `
-- Project sessions (the main unit of work)
CREATE TABLE IF NOT EXISTS project_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  
  agent_id TEXT NOT NULL,
  session_key TEXT,
  
  status TEXT NOT NULL DEFAULT 'pending',
  progress_json TEXT NOT NULL DEFAULT '{}',
  
  workspace_path TEXT,
  checkpoint_id TEXT,
  
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  paused_at INTEGER,
  completed_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  
  heartbeat_at INTEGER,
  stale_timeout_ms INTEGER NOT NULL DEFAULT 300000,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  max_recovery_attempts INTEGER NOT NULL DEFAULT 3,

  -- Rich documentation: JSON blob for richDescription, techStack, notes, attachments
  content_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON project_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON project_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON project_sessions(last_activity_at DESC);

-- Checkpoints (point-in-time snapshots)
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  project_session_id TEXT NOT NULL,
  
  progress_json TEXT NOT NULL,
  context_snapshot_json TEXT,
  working_state_json TEXT,
  
  created_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT,
  file_path TEXT,
  
  FOREIGN KEY (project_session_id) REFERENCES project_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(project_session_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_time ON checkpoints(created_at DESC);

-- Audit log (append-only history)
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  project_session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  event TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  details_json TEXT,
  
  FOREIGN KEY (project_session_id) REFERENCES project_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(project_session_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);
`;

// ═══════════════════════════════════════════════════════════════════
// PROJECT STORE CLASS
// ═══════════════════════════════════════════════════════════════════

export class ProjectStore {
  constructor(
    private db: Database.Database,
    private stateDir: string,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // PROJECT SESSIONS
  // ─────────────────────────────────────────────────────────────────

  createSession(
    session: Omit<ProjectSession, "createdAt" | "lastActivityAt" | "recoveryAttempts">,
  ): ProjectSession {
    const now = Date.now();
    const id = session.id || generateId();

    const full: ProjectSession = {
      ...session,
      id,
      createdAt: now,
      lastActivityAt: now,
      recoveryAttempts: 0,
      staleTimeoutMs: session.staleTimeoutMs ?? 300000, // 5 minutes default
      maxRecoveryAttempts: session.maxRecoveryAttempts ?? 3,
    };

    this.db
      .prepare(`
      INSERT INTO project_sessions (
        id, project_id, name, description,
        agent_id, session_key,
        status, progress_json,
        workspace_path, checkpoint_id,
        created_at, started_at, paused_at, completed_at, last_activity_at,
        heartbeat_at, stale_timeout_ms, recovery_attempts, max_recovery_attempts,
        content_json
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?
      )
    `)
      .run(
        full.id,
        full.projectId,
        full.name,
        full.description ?? null,
        full.agentId,
        full.sessionKey ?? null,
        full.status,
        JSON.stringify(full.progress),
        full.workspacePath ?? null,
        full.checkpointId ?? null,
        full.createdAt,
        full.startedAt ?? null,
        full.pausedAt ?? null,
        full.completedAt ?? null,
        full.lastActivityAt,
        full.heartbeatAt ?? null,
        full.staleTimeoutMs,
        full.recoveryAttempts,
        full.maxRecoveryAttempts,
        serializeContent(full),
      );

    this.appendAudit(full.id, "session_created", full.agentId, {
      name: full.name,
      projectId: full.projectId,
    });

    return full;
  }

  getSession(id: string): ProjectSession | null {
    const row = this.db.prepare(`SELECT * FROM project_sessions WHERE id = ?`).get(id) as any;
    return row ? rowToSession(row) : null;
  }

  getSessionByProjectId(projectId: string): ProjectSession | null {
    const row = this.db
      .prepare(`SELECT * FROM project_sessions WHERE project_id = ?`)
      .get(projectId) as any;
    return row ? rowToSession(row) : null;
  }

  listSessions(opts?: {
    status?: ProjectStatus | ProjectStatus[];
    agentId?: string;
    limit?: number;
    offset?: number;
  }): ProjectSession[] {
    let sql = `SELECT * FROM project_sessions WHERE 1=1`;
    const params: any[] = [];

    if (opts?.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      sql += ` AND status IN (${statuses.map(() => "?").join(",")})`;
      params.push(...statuses);
    }

    if (opts?.agentId) {
      sql += ` AND agent_id = ?`;
      params.push(opts.agentId);
    }

    sql += ` ORDER BY last_activity_at DESC`;

    if (opts?.limit) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    if (opts?.offset) {
      sql += ` OFFSET ?`;
      params.push(opts.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(rowToSession);
  }

  updateSession(id: string, updates: Partial<ProjectSession>): ProjectSession | null {
    const current = this.getSession(id);
    if (!current) return null;

    const updated = { ...current, ...updates, lastActivityAt: Date.now() };

    this.db
      .prepare(`
      UPDATE project_sessions SET
        name = ?, description = ?,
        agent_id = ?, session_key = ?,
        status = ?, progress_json = ?,
        workspace_path = ?, checkpoint_id = ?,
        started_at = ?, paused_at = ?, completed_at = ?, last_activity_at = ?,
        heartbeat_at = ?, stale_timeout_ms = ?, recovery_attempts = ?, max_recovery_attempts = ?,
        content_json = ?
      WHERE id = ?
    `)
      .run(
        updated.name,
        updated.description ?? null,
        updated.agentId,
        updated.sessionKey ?? null,
        updated.status,
        JSON.stringify(updated.progress),
        updated.workspacePath ?? null,
        updated.checkpointId ?? null,
        updated.startedAt ?? null,
        updated.pausedAt ?? null,
        updated.completedAt ?? null,
        updated.lastActivityAt,
        updated.heartbeatAt ?? null,
        updated.staleTimeoutMs,
        updated.recoveryAttempts,
        updated.maxRecoveryAttempts,
        serializeContent(updated),
        id,
      );

    return updated;
  }

  updateProgress(id: string, progress: Partial<ProjectProgress>): ProjectSession | null {
    const current = this.getSession(id);
    if (!current) return null;

    const updatedProgress = { ...current.progress, ...progress };

    // Recalculate percent from subtasks if not explicitly set
    if (progress.subtasks && !("percent" in progress)) {
      const completed = updatedProgress.subtasks.filter((s) => s.status === "completed").length;
      const total = updatedProgress.subtasks.length;
      updatedProgress.percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    }

    // Update context percent
    if (updatedProgress.maxContextTokens > 0) {
      updatedProgress.contextPercent = Math.round(
        (updatedProgress.contextTokens / updatedProgress.maxContextTokens) * 100,
      );
    }

    return this.updateSession(id, { progress: updatedProgress });
  }

  heartbeat(id: string): ProjectSession | null {
    const now = Date.now();
    const result = this.db
      .prepare(`
      UPDATE project_sessions SET heartbeat_at = ?, last_activity_at = ? WHERE id = ?
    `)
      .run(now, now, id);

    return result.changes > 0 ? this.getSession(id) : null;
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM project_sessions WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  // ─────────────────────────────────────────────────────────────────
  // CHECKPOINTS
  // ─────────────────────────────────────────────────────────────────

  createCheckpoint(checkpoint: Omit<Checkpoint, "id" | "createdAt">): Checkpoint {
    const id = generateId();
    const now = Date.now();

    const full: Checkpoint = {
      ...checkpoint,
      id,
      createdAt: now,
    };

    this.db
      .prepare(`
      INSERT INTO checkpoints (
        id, project_session_id,
        progress_json, context_snapshot_json, working_state_json,
        created_at, reason, notes, file_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        full.id,
        full.projectSessionId,
        JSON.stringify(full.progress),
        full.contextSnapshot ? JSON.stringify(full.contextSnapshot) : null,
        full.workingState ? JSON.stringify(full.workingState) : null,
        full.createdAt,
        full.reason,
        full.notes ?? null,
        full.filePath ?? null,
      );

    // Update session's checkpoint reference
    this.db
      .prepare(`UPDATE project_sessions SET checkpoint_id = ? WHERE id = ?`)
      .run(full.id, full.projectSessionId);

    this.appendAudit(full.projectSessionId, "checkpoint_created", "system", {
      checkpointId: full.id,
      reason: full.reason,
    });

    return full;
  }

  getCheckpoint(id: string): Checkpoint | null {
    const row = this.db.prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(id) as any;
    return row ? rowToCheckpoint(row) : null;
  }

  getLatestCheckpoint(projectSessionId: string): Checkpoint | null {
    const row = this.db
      .prepare(`
      SELECT * FROM checkpoints WHERE project_session_id = ? ORDER BY created_at DESC LIMIT 1
    `)
      .get(projectSessionId) as any;
    return row ? rowToCheckpoint(row) : null;
  }

  listCheckpoints(projectSessionId: string, limit = 10): Checkpoint[] {
    const rows = this.db
      .prepare(`
      SELECT * FROM checkpoints WHERE project_session_id = ? ORDER BY created_at DESC LIMIT ?
    `)
      .all(projectSessionId, limit) as any[];
    return rows.map(rowToCheckpoint);
  }

  // ─────────────────────────────────────────────────────────────────
  // AUDIT LOG
  // ─────────────────────────────────────────────────────────────────

  appendAudit(
    projectSessionId: string,
    event: AuditEvent,
    agentId: string,
    details?: Record<string, unknown>,
  ): AuditEntry {
    const id = generateId();
    const now = Date.now();

    const entry: AuditEntry = {
      id,
      projectSessionId,
      timestamp: now,
      event,
      agentId,
      details,
    };

    this.db
      .prepare(`
      INSERT INTO audit_log (id, project_session_id, timestamp, event, agent_id, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(id, projectSessionId, now, event, agentId, details ? JSON.stringify(details) : null);

    return entry;
  }

  getAuditLog(projectSessionId: string, limit = 50): AuditEntry[] {
    const rows = this.db
      .prepare(`
      SELECT * FROM audit_log WHERE project_session_id = ? ORDER BY timestamp DESC LIMIT ?
    `)
      .all(projectSessionId, limit) as any[];

    return rows.map((row: any) => ({
      id: row.id,
      projectSessionId: row.project_session_id,
      timestamp: row.timestamp,
      event: row.event as AuditEvent,
      agentId: row.agent_id,
      details: row.details_json ? JSON.parse(row.details_json) : undefined,
    }));
  }

  // ─────────────────────────────────────────────────────────────────
  // STALE DETECTION
  // ─────────────────────────────────────────────────────────────────

  findStaleSessions(): ProjectSession[] {
    const now = Date.now();

    const rows = this.db
      .prepare(`
      SELECT * FROM project_sessions 
      WHERE status = 'running' 
        AND heartbeat_at IS NOT NULL
        AND (? - heartbeat_at) > stale_timeout_ms
    `)
      .all(now) as any[];

    return rows.map(rowToSession);
  }

  markStale(id: string): ProjectSession | null {
    return this.updateSession(id, { status: "stale" });
  }

  incrementRecoveryAttempts(id: string): ProjectSession | null {
    const current = this.getSession(id);
    if (!current) return null;

    return this.updateSession(id, {
      recoveryAttempts: current.recoveryAttempts + 1,
      status: "recovering",
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // SUMMARIES
  // ─────────────────────────────────────────────────────────────────

  getSummaries(): ProjectSummary[] {
    const rows = this.db
      .prepare(`
      SELECT id, project_id, name, status, agent_id, progress_json, last_activity_at
      FROM project_sessions
      ORDER BY last_activity_at DESC
    `)
      .all() as any[];

    return rows.map((row: any) => {
      const progress = JSON.parse(row.progress_json || "{}");
      return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        status: row.status as ProjectStatus,
        agentId: row.agent_id,
        percent: progress.percent ?? 0,
        lastActivityAt: row.last_activity_at,
      };
    });
  }

  getStats(): {
    total: number;
    running: number;
    paused: number;
    completed: number;
    failed: number;
    stale: number;
  } {
    const row = this.db
      .prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) as stale
      FROM project_sessions
    `)
      .get() as any;

    return {
      total: row.total || 0,
      running: row.running || 0,
      paused: row.paused || 0,
      completed: row.completed || 0,
      failed: row.failed || 0,
      stale: row.stale || 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // WORKSPACE
  // ─────────────────────────────────────────────────────────────────

  getProjectsDir(): string {
    return join(this.stateDir, "projects");
  }

  getProjectDir(projectId: string): string {
    return join(this.getProjectsDir(), projectId);
  }

  ensureProjectDir(projectId: string): string {
    const dir = this.getProjectDir(projectId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function rowToSession(row: any): ProjectSession {
  const content = parseContent(row.content_json);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? undefined,
    richDescription: content.richDescription,
    techStack: content.techStack,
    notes: content.notes,
    attachments: content.attachments,
    agentId: row.agent_id,
    sessionKey: row.session_key ?? undefined,
    status: row.status as ProjectStatus,
    progress: JSON.parse(row.progress_json || "{}"),
    workspacePath: row.workspace_path ?? undefined,
    checkpointId: row.checkpoint_id ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    pausedAt: row.paused_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    lastActivityAt: row.last_activity_at,
    heartbeatAt: row.heartbeat_at ?? undefined,
    staleTimeoutMs: row.stale_timeout_ms,
    recoveryAttempts: row.recovery_attempts,
    maxRecoveryAttempts: row.max_recovery_attempts,
  };
}

interface SerializedContent {
  richDescription?: string;
  techStack?: string[];
  notes?: ProjectSession["notes"];
  attachments?: ProjectSession["attachments"];
}

function serializeContent(session: ProjectSession): string | null {
  const payload: SerializedContent = {};
  if (session.richDescription) payload.richDescription = session.richDescription;
  if (session.techStack && session.techStack.length) payload.techStack = session.techStack;
  if (session.notes && session.notes.length) payload.notes = session.notes;
  if (session.attachments && session.attachments.length) payload.attachments = session.attachments;
  return Object.keys(payload).length === 0 ? null : JSON.stringify(payload);
}

function parseContent(json: string | null | undefined): SerializedContent {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rowToCheckpoint(row: any): Checkpoint {
  return {
    id: row.id,
    projectSessionId: row.project_session_id,
    progress: JSON.parse(row.progress_json || "{}"),
    contextSnapshot: row.context_snapshot_json ? JSON.parse(row.context_snapshot_json) : undefined,
    workingState: row.working_state_json ? JSON.parse(row.working_state_json) : undefined,
    createdAt: row.created_at,
    reason: row.reason as CheckpointReason,
    notes: row.notes ?? undefined,
    filePath: row.file_path ?? undefined,
  };
}
