/**
 * Discovery Docs — SQLite store.
 *
 * Two tables:
 *   discovery_templates — template definitions (JSON-encoded inputFields,
 *                         contextSources, ai, actions, etc.). Wide rows;
 *                         we read whole templates frequently and the JSON
 *                         blobs are small. No indexed columns inside the
 *                         blobs.
 *   discovery_runs      — one row per submission (manual test or Netlify).
 *                         Indexed by (templateId, createdAt) for the runs
 *                         viewer, and by netlifySubmissionId so the poller
 *                         can de-dupe.
 *
 * Lives at `${stateDir}/discovery.db` so it's siblings with notes.db,
 * loops.db etc — easy to find and back up.
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";

import type { DiscoveryDocTemplate, DiscoveryDocRun, DiscoverySettings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

let instance: DiscoveryStore | null = null;

export function getDiscoveryStore(stateDir: string): DiscoveryStore {
  if (instance) return instance;
  instance = new DiscoveryStore(join(stateDir, "discovery.db"));
  return instance;
}

export function resetDiscoveryStore(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS discovery_templates (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_biz   ON discovery_templates(business_id);
CREATE INDEX IF NOT EXISTS idx_templates_slug  ON discovery_templates(business_id, slug);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id                       TEXT PRIMARY KEY,
  template_id              TEXT NOT NULL,
  business_id              TEXT NOT NULL,
  source                   TEXT NOT NULL,
  netlify_submission_id    TEXT,
  qualify_category         TEXT,
  approval_state           TEXT NOT NULL,
  calendly_link_sent       INTEGER NOT NULL DEFAULT 0,
  payload_json             TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  FOREIGN KEY (template_id) REFERENCES discovery_templates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_template ON discovery_runs(template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_biz      ON discovery_runs(business_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_netlify
  ON discovery_runs(netlify_submission_id) WHERE netlify_submission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_approval ON discovery_runs(approval_state, created_at DESC);

CREATE TABLE IF NOT EXISTS discovery_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

export class DiscoveryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── Templates ────────────────────────────────────────────────

  listTemplates(businessId: string): DiscoveryDocTemplate[] {
    const rows = this.db
      .prepare(`SELECT * FROM discovery_templates WHERE business_id = ? ORDER BY updated_at DESC`)
      .all(businessId) as Array<{
      id: string;
      business_id: string;
      name: string;
      description: string;
      type: string;
      slug: string;
      payload_json: string;
      enabled: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map(rowToTemplate);
  }

  getTemplate(id: string): DiscoveryDocTemplate | null {
    const row = this.db.prepare(`SELECT * FROM discovery_templates WHERE id = ?`).get(id) as
      | undefined
      | {
          id: string;
          business_id: string;
          name: string;
          description: string;
          type: string;
          slug: string;
          payload_json: string;
          enabled: number;
          created_at: number;
          updated_at: number;
        };
    return row ? rowToTemplate(row) : null;
  }

  upsertTemplate(tpl: DiscoveryDocTemplate): DiscoveryDocTemplate {
    const now = Date.now();
    const next: DiscoveryDocTemplate = {
      ...tpl,
      createdAt: tpl.createdAt || now,
      updatedAt: now,
    };
    // Strip the top-level scalar columns from payload_json so we don't
    // duplicate data between rows and JSON blob (also keeps the JSON
    // smaller).
    const payload = {
      inputFields: next.inputFields,
      contextSources: next.contextSources,
      ai: next.ai,
      layout: next.layout,
      style: next.style,
      actions: next.actions,
      approval: next.approval,
      netlify: next.netlify,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO discovery_templates
           (id, business_id, name, description, type, slug, payload_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.id,
        next.businessId,
        next.name,
        next.description,
        next.type,
        next.slug,
        JSON.stringify(payload),
        next.enabled ? 1 : 0,
        next.createdAt,
        next.updatedAt,
      );
    return next;
  }

  deleteTemplate(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM discovery_templates WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  // ── Runs ─────────────────────────────────────────────────────

  listRuns(
    opts: {
      businessId?: string;
      templateId?: string;
      approvalState?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): DiscoveryDocRun[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.businessId) {
      where.push("business_id = ?");
      args.push(opts.businessId);
    }
    if (opts.templateId) {
      where.push("template_id = ?");
      args.push(opts.templateId);
    }
    if (opts.approvalState) {
      where.push("approval_state = ?");
      args.push(opts.approvalState);
    }
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const sql =
      `SELECT * FROM discovery_runs` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...args, limit, offset) as Array<{
      id: string;
      template_id: string;
      business_id: string;
      source: string;
      netlify_submission_id: string | null;
      qualify_category: string | null;
      approval_state: string;
      calendly_link_sent: number;
      payload_json: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map(rowToRun);
  }

  getRun(id: string): DiscoveryDocRun | null {
    const row = this.db.prepare(`SELECT * FROM discovery_runs WHERE id = ?`).get(id) as
      | undefined
      | {
          id: string;
          template_id: string;
          business_id: string;
          source: string;
          netlify_submission_id: string | null;
          qualify_category: string | null;
          approval_state: string;
          calendly_link_sent: number;
          payload_json: string;
          created_at: number;
          updated_at: number;
        };
    return row ? rowToRun(row) : null;
  }

  getRunByNetlifySubmissionId(submissionId: string): DiscoveryDocRun | null {
    const row = this.db
      .prepare(`SELECT * FROM discovery_runs WHERE netlify_submission_id = ?`)
      .get(submissionId) as
      | undefined
      | {
          id: string;
          template_id: string;
          business_id: string;
          source: string;
          netlify_submission_id: string | null;
          qualify_category: string | null;
          approval_state: string;
          calendly_link_sent: number;
          payload_json: string;
          created_at: number;
          updated_at: number;
        };
    return row ? rowToRun(row) : null;
  }

  upsertRun(run: DiscoveryDocRun): DiscoveryDocRun {
    const now = Date.now();
    const next: DiscoveryDocRun = {
      ...run,
      createdAt: run.createdAt || now,
      updatedAt: now,
    };
    const payload = {
      inputs: next.inputs,
      contextSnapshot: next.contextSnapshot,
      resolvedSystemPrompt: next.resolvedSystemPrompt,
      resolvedUserPrompt: next.resolvedUserPrompt,
      generatedMarkdown: next.generatedMarkdown,
      actions: next.actions,
      approvalNote: next.approvalNote,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO discovery_runs
           (id, template_id, business_id, source, netlify_submission_id, qualify_category,
            approval_state, calendly_link_sent, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.id,
        next.templateId,
        next.businessId,
        next.source,
        next.netlifySubmissionId,
        next.qualifyCategory,
        next.approvalState,
        next.calendlyLinkSent ? 1 : 0,
        JSON.stringify(payload),
        next.createdAt,
        next.updatedAt,
      );
    return next;
  }

  /** Set highwater mark on a template's Netlify binding. */
  setLastSeenSubmissionId(templateId: string, submissionId: string): void {
    const tpl = this.getTemplate(templateId);
    if (!tpl || !tpl.netlify) return;
    tpl.netlify = {
      ...tpl.netlify,
      lastSeenSubmissionId: submissionId,
      lastPolledAt: Date.now(),
    };
    this.upsertTemplate(tpl);
  }

  /** Count runs for a template within the last 24h — daily abuse limit. */
  countRunsLast24h(templateId: string): number {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM discovery_runs WHERE template_id = ? AND created_at >= ?`)
      .get(templateId, since) as { n: number };
    return row.n;
  }

  // ── Settings ────────────────────────────────────────────────

  getSettings(): DiscoverySettings {
    const rows = this.db.prepare(`SELECT k, v FROM discovery_settings`).all() as Array<{
      k: string;
      v: string;
    }>;
    const out = { ...DEFAULT_SETTINGS } as DiscoverySettings;
    const writable = out as unknown as Record<string, unknown>;
    for (const r of rows) {
      try {
        writable[r.k] = JSON.parse(r.v);
      } catch {
        /* corrupt row — leave default */
      }
    }
    return out;
  }

  updateSettings(patch: Partial<DiscoverySettings>): DiscoverySettings {
    const next = { ...this.getSettings(), ...patch };
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO discovery_settings (k, v) VALUES (?, ?)`);
    const tx = this.db.transaction((entries: Array<[string, unknown]>) => {
      for (const [k, v] of entries) stmt.run(k, JSON.stringify(v));
    });
    tx(Object.entries(next));
    return next;
  }
}

function rowToTemplate(row: {
  id: string;
  business_id: string;
  name: string;
  description: string;
  type: string;
  slug: string;
  payload_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}): DiscoveryDocTemplate {
  const payload = JSON.parse(row.payload_json) as Partial<DiscoveryDocTemplate>;
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    type: row.type as DiscoveryDocTemplate["type"],
    slug: row.slug,
    inputFields: payload.inputFields ?? [],
    contextSources: payload.contextSources ?? [],
    ai: payload.ai!,
    layout: payload.layout ?? "audit",
    style: payload.style!,
    actions: payload.actions ?? [],
    approval: payload.approval!,
    netlify: payload.netlify ?? null,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: {
  id: string;
  template_id: string;
  business_id: string;
  source: string;
  netlify_submission_id: string | null;
  qualify_category: string | null;
  approval_state: string;
  calendly_link_sent: number;
  payload_json: string;
  created_at: number;
  updated_at: number;
}): DiscoveryDocRun {
  const payload = JSON.parse(row.payload_json) as Partial<DiscoveryDocRun>;
  return {
    id: row.id,
    templateId: row.template_id,
    businessId: row.business_id,
    source: row.source as DiscoveryDocRun["source"],
    netlifySubmissionId: row.netlify_submission_id,
    qualifyCategory: row.qualify_category,
    approvalState: row.approval_state as DiscoveryDocRun["approvalState"],
    calendlyLinkSent: row.calendly_link_sent === 1,
    inputs: payload.inputs ?? {},
    contextSnapshot: payload.contextSnapshot ?? {},
    resolvedSystemPrompt: payload.resolvedSystemPrompt ?? "",
    resolvedUserPrompt: payload.resolvedUserPrompt ?? "",
    generatedMarkdown: payload.generatedMarkdown ?? "",
    actions: payload.actions ?? [],
    approvalNote: payload.approvalNote ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
