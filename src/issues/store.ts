/**
 * Issues store — SQLite-backed System Issues / Improvement Log (K.I.S.).
 *
 * Modeled on `src/databases/store.ts`: local SQLite is the source of truth,
 * opened under the resolved `~/.infinibot` state dir. Every caller — the
 * gateway `issues.*` RPC handlers, the MCP `issues` agent tool, and the UI —
 * goes through this single store so the contract stays consistent.
 *
 * One dedicated table with one column per field (the field set is fixed by the
 * product spec, so a typed-column table reads cleaner than a JSON blob).
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import type {
  Issue,
  IssueAttachment,
  IssueAttachmentCreateParams,
  IssueCreateParams,
  IssueSearchParams,
  IssueUpdateParams,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getIssuesStore(stateDir?: string): IssuesStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new IssuesStore(db);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL DEFAULT '',
  issue_type            TEXT NOT NULL DEFAULT '',
  description           TEXT NOT NULL DEFAULT '',
  reported_by           TEXT NOT NULL DEFAULT '',
  date_reported         TEXT NOT NULL DEFAULT '',
  related_object        TEXT NOT NULL DEFAULT '',
  related_project       TEXT NOT NULL DEFAULT '',
  related_workflow      TEXT NOT NULL DEFAULT '',
  project_id            TEXT,
  frequency             TEXT NOT NULL DEFAULT '',
  business_impact       TEXT NOT NULL DEFAULT '',
  time_wasted           TEXT NOT NULL DEFAULT '',
  severity              TEXT NOT NULL DEFAULT 'medium',
  priority              TEXT NOT NULL DEFAULT 'medium',
  temporary_workaround  TEXT NOT NULL DEFAULT '',
  root_cause            TEXT NOT NULL DEFAULT '',
  assigned_owner        TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'open',
  proposed_fix          TEXT NOT NULL DEFAULT '',
  target_fix_date       TEXT NOT NULL DEFAULT '',
  date_fixed            TEXT NOT NULL DEFAULT '',
  tested_by             TEXT NOT NULL DEFAULT '',
  resolution_notes      TEXT NOT NULL DEFAULT '',
  recurring             INTEGER NOT NULL DEFAULT 0,
  automation_candidate  INTEGER NOT NULL DEFAULT 0,
  ceo_input_required    INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated_at);

CREATE TABLE IF NOT EXISTS issue_attachments (
  id          TEXT PRIMARY KEY,
  issue_id    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL DEFAULT '',
  mime_type   TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issue_att_issue ON issue_attachments(issue_id);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const dbPath = resolve(stateDir, "issues.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> MODEL
// ═══════════════════════════════════════════════════════════════════

interface IssueRow {
  id: string;
  title: string;
  issue_type: string;
  description: string;
  reported_by: string;
  date_reported: string;
  related_object: string;
  related_project: string;
  related_workflow: string;
  project_id: string | null;
  frequency: string;
  business_impact: string;
  time_wasted: string;
  severity: string;
  priority: string;
  temporary_workaround: string;
  root_cause: string;
  assigned_owner: string;
  status: string;
  proposed_fix: string;
  target_fix_date: string;
  date_fixed: string;
  tested_by: string;
  resolution_notes: string;
  recurring: number;
  automation_candidate: number;
  ceo_input_required: number;
  created_at: number;
  updated_at: number;
}

function rowToIssue(r: IssueRow): Issue {
  return {
    id: r.id,
    title: r.title,
    issueType: r.issue_type,
    description: r.description,
    reportedBy: r.reported_by,
    dateReported: r.date_reported,
    relatedObject: r.related_object,
    relatedProject: r.related_project,
    relatedWorkflow: r.related_workflow,
    projectId: r.project_id ?? undefined,
    frequency: r.frequency,
    businessImpact: r.business_impact,
    timeWasted: r.time_wasted,
    severity: r.severity,
    priority: r.priority,
    temporaryWorkaround: r.temporary_workaround,
    rootCause: r.root_cause,
    assignedOwner: r.assigned_owner,
    status: r.status,
    proposedFix: r.proposed_fix,
    targetFixDate: r.target_fix_date,
    dateFixed: r.date_fixed,
    testedBy: r.tested_by,
    resolutionNotes: r.resolution_notes,
    recurring: r.recurring === 1,
    automationCandidate: r.automation_candidate === 1,
    ceoInputRequired: r.ceo_input_required === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface IssueAttachmentRow {
  id: string;
  issue_id: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
  sha256: string;
  created_at: number;
}

function rowToAttachment(r: IssueAttachmentRow): IssueAttachment {
  return {
    id: r.id,
    issueId: r.issue_id,
    name: r.name,
    path: r.path,
    mimeType: r.mime_type,
    size: r.size,
    sha256: r.sha256,
    createdAt: r.created_at,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class IssuesStore {
  constructor(private db: Database.Database) {}

  list(params: IssueSearchParams = {}): Issue[] {
    const rows = this.db
      .prepare(`SELECT * FROM issues ORDER BY updated_at DESC`)
      .all() as IssueRow[];
    let issues = rows.map(rowToIssue);

    if (params.query) {
      const q = params.query.toLowerCase();
      issues = issues.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.rootCause.toLowerCase().includes(q) ||
          i.resolutionNotes.toLowerCase().includes(q),
      );
    }
    if (params.issueType) issues = issues.filter((i) => i.issueType === params.issueType);
    if (params.severity) issues = issues.filter((i) => i.severity === params.severity);
    if (params.priority) issues = issues.filter((i) => i.priority === params.priority);
    if (params.status) issues = issues.filter((i) => i.status === params.status);
    if (params.assignedOwner)
      issues = issues.filter((i) => i.assignedOwner === params.assignedOwner);
    if (params.projectId) issues = issues.filter((i) => i.projectId === params.projectId);
    if (params.since != null) issues = issues.filter((i) => i.updatedAt > params.since!);
    if (params.limit) issues = issues.slice(0, params.limit);
    this.hydrateAttachments(issues);
    return issues;
  }

  get(id: string): Issue | null {
    const row = this.db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id) as
      | IssueRow
      | undefined;
    if (!row) return null;
    const issue = rowToIssue(row);
    issue.attachments = this.listAttachments(id);
    return issue;
  }

  /** Attach the (usually small) image set to each issue in a single query. */
  private hydrateAttachments(issues: Issue[]): void {
    if (issues.length === 0) return;
    const byIssue = new Map<string, IssueAttachment[]>();
    const rows = this.db
      .prepare(`SELECT * FROM issue_attachments ORDER BY created_at ASC`)
      .all() as IssueAttachmentRow[];
    for (const r of rows) {
      const att = rowToAttachment(r);
      const list = byIssue.get(att.issueId) ?? [];
      list.push(att);
      byIssue.set(att.issueId, list);
    }
    for (const i of issues) i.attachments = byIssue.get(i.id) ?? [];
  }

  // ── Attachments ──

  listAttachments(issueId: string): IssueAttachment[] {
    const rows = this.db
      .prepare(`SELECT * FROM issue_attachments WHERE issue_id = ? ORDER BY created_at ASC`)
      .all(issueId) as IssueAttachmentRow[];
    return rows.map(rowToAttachment);
  }

  findAttachmentBySha256(issueId: string, sha256: string): IssueAttachment | null {
    const row = this.db
      .prepare(`SELECT * FROM issue_attachments WHERE issue_id = ? AND sha256 = ?`)
      .get(issueId, sha256) as IssueAttachmentRow | undefined;
    return row ? rowToAttachment(row) : null;
  }

  createAttachment(params: IssueAttachmentCreateParams): IssueAttachment {
    const att: IssueAttachment = {
      id: randomUUID(),
      issueId: params.issueId,
      name: params.name,
      path: params.path,
      mimeType: params.mimeType,
      size: params.size,
      sha256: params.sha256,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO issue_attachments (id, issue_id, name, path, mime_type, size, sha256, created_at)
         VALUES (@id, @issueId, @name, @path, @mimeType, @size, @sha256, @createdAt)`,
      )
      .run({
        id: att.id,
        issueId: att.issueId,
        name: att.name,
        path: att.path,
        mimeType: att.mimeType,
        size: att.size,
        sha256: att.sha256,
        createdAt: att.createdAt,
      });
    return att;
  }

  deleteAttachment(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM issue_attachments WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  create(params: IssueCreateParams): Issue {
    const now = Date.now();
    const id = params.clientRequestId?.trim() || randomUUID();
    // Idempotency: a repeat create with the same id returns the existing row.
    const existing = this.get(id);
    if (existing) return existing;

    const issue: Issue = {
      id,
      title: params.title ?? "",
      issueType: params.issueType ?? "",
      description: params.description ?? "",
      reportedBy: params.reportedBy ?? "",
      dateReported: params.dateReported ?? new Date(now).toISOString().slice(0, 10),
      relatedObject: params.relatedObject ?? "",
      relatedProject: params.relatedProject ?? "",
      relatedWorkflow: params.relatedWorkflow ?? "",
      projectId: params.projectId,
      frequency: params.frequency ?? "",
      businessImpact: params.businessImpact ?? "",
      timeWasted: params.timeWasted ?? "",
      severity: params.severity ?? "medium",
      priority: params.priority ?? "medium",
      temporaryWorkaround: params.temporaryWorkaround ?? "",
      rootCause: params.rootCause ?? "",
      assignedOwner: params.assignedOwner ?? "",
      status: params.status ?? "open",
      proposedFix: params.proposedFix ?? "",
      targetFixDate: params.targetFixDate ?? "",
      dateFixed: params.dateFixed ?? "",
      testedBy: params.testedBy ?? "",
      resolutionNotes: params.resolutionNotes ?? "",
      recurring: params.recurring ?? false,
      automationCandidate: params.automationCandidate ?? false,
      ceoInputRequired: params.ceoInputRequired ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO issues (
          id, title, issue_type, description, reported_by, date_reported,
          related_object, related_project, related_workflow, project_id,
          frequency, business_impact, time_wasted, severity, priority,
          temporary_workaround, root_cause, assigned_owner, status, proposed_fix,
          target_fix_date, date_fixed, tested_by, resolution_notes,
          recurring, automation_candidate, ceo_input_required, created_at, updated_at
        ) VALUES (
          @id, @title, @issueType, @description, @reportedBy, @dateReported,
          @relatedObject, @relatedProject, @relatedWorkflow, @projectId,
          @frequency, @businessImpact, @timeWasted, @severity, @priority,
          @temporaryWorkaround, @rootCause, @assignedOwner, @status, @proposedFix,
          @targetFixDate, @dateFixed, @testedBy, @resolutionNotes,
          @recurring, @automationCandidate, @ceoInputRequired, @createdAt, @updatedAt
        )`,
      )
      .run(this.bind(issue));
    return issue;
  }

  update(params: IssueUpdateParams): Issue | null {
    const current = this.get(params.id);
    if (!current) return null;
    const next: Issue = {
      ...current,
      ...stripUndefined(params),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE issues SET
          title=@title, issue_type=@issueType, description=@description,
          reported_by=@reportedBy, date_reported=@dateReported,
          related_object=@relatedObject, related_project=@relatedProject,
          related_workflow=@relatedWorkflow, project_id=@projectId,
          frequency=@frequency, business_impact=@businessImpact, time_wasted=@timeWasted,
          severity=@severity, priority=@priority,
          temporary_workaround=@temporaryWorkaround, root_cause=@rootCause,
          assigned_owner=@assignedOwner, status=@status, proposed_fix=@proposedFix,
          target_fix_date=@targetFixDate, date_fixed=@dateFixed, tested_by=@testedBy,
          resolution_notes=@resolutionNotes, recurring=@recurring,
          automation_candidate=@automationCandidate, ceo_input_required=@ceoInputRequired,
          updated_at=@updatedAt
        WHERE id=@id`,
      )
      .run(this.bind(next));
    return next;
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM issues WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  /** Map an Issue model onto the flat, SQLite-friendly bind object. */
  private bind(i: Issue): Record<string, string | number | null> {
    return {
      id: i.id,
      title: i.title,
      issueType: i.issueType,
      description: i.description,
      reportedBy: i.reportedBy,
      dateReported: i.dateReported,
      relatedObject: i.relatedObject,
      relatedProject: i.relatedProject,
      relatedWorkflow: i.relatedWorkflow,
      projectId: i.projectId ?? null,
      frequency: i.frequency,
      businessImpact: i.businessImpact,
      timeWasted: i.timeWasted,
      severity: i.severity,
      priority: i.priority,
      temporaryWorkaround: i.temporaryWorkaround,
      rootCause: i.rootCause,
      assignedOwner: i.assignedOwner,
      status: i.status,
      proposedFix: i.proposedFix,
      targetFixDate: i.targetFixDate,
      dateFixed: i.dateFixed,
      testedBy: i.testedBy,
      resolutionNotes: i.resolutionNotes,
      recurring: i.recurring ? 1 : 0,
      automationCandidate: i.automationCandidate ? 1 : 0,
      ceoInputRequired: i.ceoInputRequired ? 1 : 0,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    };
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
