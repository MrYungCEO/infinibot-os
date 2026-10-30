/**
 * Audit log — append-only record of significant AI-generated actions (§33).
 *
 * The spec requires that for significant AI actions the system retains: what
 * happened, when, the trigger, the agent/workflow, the information used, the
 * recommendation, any human approval, the final action, and the outcome. This
 * store is that ledger. It is deliberately append-only: entries are written
 * once and never updated or deleted, so the trail is trustworthy for enterprise
 * / sensitive use cases.
 *
 * Modeled on `src/issues/store.ts`: local SQLite under the resolved
 * `~/.infinibot` state dir, one typed-column table, a single shared store.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";

// ═══════════════════════════════════════════════════════════════════
// TYPES (§33)
// ═══════════════════════════════════════════════════════════════════

/** A materialized append-only audit entry. */
export interface AuditEntry {
  id: string;
  /** What happened (short human description of the action). */
  what: string;
  /** When it happened (Unix ms). */
  when: number;
  /** What triggered it (event, rule, user request, schedule, ...). */
  trigger: string;
  /** The agent id / workflow name that performed or proposed the action. */
  agent: string;
  /** The information used (free text or serialized JSON). */
  inputs: string;
  /** The recommendation the agent produced. */
  recommendation: string;
  /** Human approval where required (who + when, or "" / "not required"). */
  approval: string;
  /** The final action actually taken. */
  action: string;
  /** The outcome / result of the action. */
  outcome: string;
  /** Optional link to the business object this action concerned. */
  objectType?: string;
  objectId?: string;
  /** Free-form structured metadata. */
  meta: Record<string, unknown>;
}

/** Fields accepted when appending an entry. Only `what` is required. */
export interface AuditLogParams {
  what: string;
  trigger?: string;
  agent?: string;
  /** Accepts a string or any JSON-serializable object (stored as JSON text). */
  inputs?: string | Record<string, unknown>;
  recommendation?: string;
  approval?: string;
  action?: string;
  outcome?: string;
  objectType?: string;
  objectId?: string;
  meta?: Record<string, unknown>;
  /** Override the timestamp (Unix ms); defaults to now. */
  when?: number;
}

/** Filter for reading the ledger. */
export interface AuditQuery {
  objectType?: string;
  objectId?: string;
  agent?: string;
  /** Only entries after this Unix-ms timestamp. */
  since?: number;
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

let _db: Database.Database | null = null;
let _stateDir: string | null = null;

export function getAuditStore(stateDir?: string): AuditStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  if (!_db || _stateDir !== dir) {
    _stateDir = dir;
    _db = initDatabase(dir);
  }
  return new AuditStore(_db);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id             TEXT PRIMARY KEY,
  what           TEXT NOT NULL DEFAULT '',
  when_ms        INTEGER NOT NULL,
  trigger        TEXT NOT NULL DEFAULT '',
  agent          TEXT NOT NULL DEFAULT '',
  inputs         TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  approval       TEXT NOT NULL DEFAULT '',
  action         TEXT NOT NULL DEFAULT '',
  outcome        TEXT NOT NULL DEFAULT '',
  object_type    TEXT NOT NULL DEFAULT '',
  object_id      TEXT NOT NULL DEFAULT '',
  meta           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_when ON audit_log(when_ms);
CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_log(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const dbPath = resolve(stateDir, "audit.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> MODEL
// ═══════════════════════════════════════════════════════════════════

interface AuditRow {
  id: string;
  what: string;
  when_ms: number;
  trigger: string;
  agent: string;
  inputs: string;
  recommendation: string;
  approval: string;
  action: string;
  outcome: string;
  object_type: string;
  object_id: string;
  meta: string;
}

function rowToEntry(r: AuditRow): AuditEntry {
  let meta: Record<string, unknown> = {};
  try {
    meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  return {
    id: r.id,
    what: r.what,
    when: r.when_ms,
    trigger: r.trigger,
    agent: r.agent,
    inputs: r.inputs,
    recommendation: r.recommendation,
    approval: r.approval,
    action: r.action,
    outcome: r.outcome,
    objectType: r.object_type || undefined,
    objectId: r.object_id || undefined,
    meta,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STORE (append-only)
// ═══════════════════════════════════════════════════════════════════

export class AuditStore {
  constructor(private db: Database.Database) {}

  /** Append one entry. There is intentionally no update() or delete(). */
  log(params: AuditLogParams): AuditEntry {
    const inputs =
      typeof params.inputs === "string"
        ? params.inputs
        : params.inputs != null
          ? JSON.stringify(params.inputs)
          : "";
    const entry: AuditEntry = {
      id: randomUUID(),
      what: params.what ?? "",
      when: params.when ?? Date.now(),
      trigger: params.trigger ?? "",
      agent: params.agent ?? "",
      inputs,
      recommendation: params.recommendation ?? "",
      approval: params.approval ?? "",
      action: params.action ?? "",
      outcome: params.outcome ?? "",
      objectType: params.objectType,
      objectId: params.objectId,
      meta: params.meta ?? {},
    };
    this.db
      .prepare(
        `INSERT INTO audit_log
           (id, what, when_ms, trigger, agent, inputs, recommendation, approval,
            action, outcome, object_type, object_id, meta)
         VALUES (@id, @what, @when, @trigger, @agent, @inputs, @recommendation, @approval,
            @action, @outcome, @objectType, @objectId, @meta)`,
      )
      .run({
        id: entry.id,
        what: entry.what,
        when: entry.when,
        trigger: entry.trigger,
        agent: entry.agent,
        inputs: entry.inputs,
        recommendation: entry.recommendation,
        approval: entry.approval,
        action: entry.action,
        outcome: entry.outcome,
        objectType: entry.objectType ?? "",
        objectId: entry.objectId ?? "",
        meta: JSON.stringify(entry.meta ?? {}),
      });
    return entry;
  }

  get(id: string): AuditEntry | null {
    const row = this.db.prepare(`SELECT * FROM audit_log WHERE id = ?`).get(id) as
      | AuditRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** Read the ledger newest-first, narrowed by the optional filter. */
  list(q: AuditQuery = {}): AuditEntry[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (q.objectType != null) (clauses.push("object_type = ?"), args.push(q.objectType));
    if (q.objectId != null) (clauses.push("object_id = ?"), args.push(q.objectId));
    if (q.agent != null) (clauses.push("agent = ?"), args.push(q.agent));
    if (q.since != null) (clauses.push("when_ms > ?"), args.push(q.since));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY when_ms DESC`)
      .all(...args) as AuditRow[];
    let entries = rows.map(rowToEntry);
    if (q.limit != null) entries = entries.slice(0, q.limit);
    return entries;
  }
}
