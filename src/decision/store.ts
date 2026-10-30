/**
 * Decisions store — SQLite-backed CEO-decision queue (Phase 1 Object 6).
 *
 * Modeled on `src/issues/store.ts`: local SQLite is the source of truth, opened
 * under the resolved `~/.infinibot` state dir (own file `decision.db`). Every
 * caller — the gateway `decision.*` RPC handlers, agent tools, and the UI — goes
 * through this single store so the contract stays consistent.
 *
 * Beyond CRUD it owns three pieces of Phase-1 policy:
 *   • `ceoQueue()` — the CEO Queue surface: decisions awaiting the founder,
 *     sorted most-urgent-first (priority then deadline).
 *   • cross-object links via the typed-edge store (`src/relations`): a decision
 *     `relates_to` its client/opportunity/project/product/issue, and
 *     `decision_guides_task` when it drives a task.
 *   • an append-only audit entry (§33) whenever a decision reaches `Decided`,
 *     because a human retains final authority (§24) and that call must be logged.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import { assertSingleOwner, priorityRank } from "../business-objects/rules.js";
import { getRelationsStore } from "../relations/store.js";
import { getAuditStore } from "../business-objects/audit.js";
import { CEO_QUEUE_STATUSES } from "./types.js";
import { isCeoDecision, evaluateCeoTriggers } from "../business-objects/ceo-triggers.js";
import type {
  Decision,
  DecisionCreateParams,
  DecisionSearchParams,
  DecisionUpdateParams,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getDecisionStore(stateDir?: string): DecisionStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new DecisionStore(db);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL DEFAULT '',
  decision_type      TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'Preparing',
  owner              TEXT NOT NULL DEFAULT '',
  supporting_owner   TEXT NOT NULL DEFAULT '',
  ceo_required       INTEGER NOT NULL DEFAULT 0,
  requested_by       TEXT NOT NULL DEFAULT '',
  client_id          TEXT,
  opportunity_id     TEXT,
  project_id         TEXT,
  product_id         TEXT,
  issue_id           TEXT,
  decision_required  TEXT NOT NULL DEFAULT '',
  why_now            TEXT NOT NULL DEFAULT '',
  options            TEXT NOT NULL DEFAULT '',
  recommendation     TEXT NOT NULL DEFAULT '',
  decision_deadline  TEXT NOT NULL DEFAULT '',
  impact_if_delayed  TEXT NOT NULL DEFAULT '',
  ceo_triggers       TEXT NOT NULL DEFAULT '[]',
  financial_impact   REAL NOT NULL DEFAULT 0,
  priority           TEXT NOT NULL DEFAULT 'P2',
  final_decision     TEXT NOT NULL DEFAULT '',
  decision_date      TEXT NOT NULL DEFAULT '',
  rationale          TEXT NOT NULL DEFAULT '',
  data_quality       TEXT NOT NULL DEFAULT 'Unknown',
  authority_level    TEXT NOT NULL DEFAULT 'L0',
  last_updated       INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_priority ON decisions(priority);
CREATE INDEX IF NOT EXISTS idx_decisions_deadline ON decisions(decision_deadline);
CREATE INDEX IF NOT EXISTS idx_decisions_updated ON decisions(updated_at);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const dbPath = resolve(stateDir, "decision.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}

/**
 * Additive column migration (§17 CEO request-format fields + §16 triggers) for
 * decision DBs created before those columns existed. SQLite `ADD COLUMN` cannot
 * be guarded with IF NOT EXISTS, so we probe `table_info` first. Idempotent.
 */
function migrateSchema(db: Database.Database): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  const add: Array<[string, string]> = [
    ["why_now", "TEXT NOT NULL DEFAULT ''"],
    ["impact_if_delayed", "TEXT NOT NULL DEFAULT ''"],
    ["ceo_triggers", "TEXT NOT NULL DEFAULT '[]'"],
    ["financial_impact", "REAL NOT NULL DEFAULT 0"],
  ];
  for (const [name, decl] of add) {
    if (!cols.has(name)) db.exec(`ALTER TABLE decisions ADD COLUMN ${name} ${decl}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> MODEL
// ═══════════════════════════════════════════════════════════════════

interface DecisionRow {
  id: string;
  title: string;
  decision_type: string;
  status: string;
  owner: string;
  supporting_owner: string;
  ceo_required: number;
  requested_by: string;
  client_id: string | null;
  opportunity_id: string | null;
  project_id: string | null;
  product_id: string | null;
  issue_id: string | null;
  decision_required: string;
  why_now: string;
  options: string;
  recommendation: string;
  decision_deadline: string;
  impact_if_delayed: string;
  ceo_triggers: string;
  financial_impact: number;
  priority: string;
  final_decision: string;
  decision_date: string;
  rationale: string;
  data_quality: string;
  authority_level: string;
  last_updated: number;
  created_at: number;
  updated_at: number;
}

function rowToDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    title: r.title,
    decisionType: r.decision_type,
    status: r.status,
    owner: r.owner,
    supportingOwner: r.supporting_owner,
    ceoRequired: r.ceo_required === 1,
    requestedBy: r.requested_by,
    clientId: r.client_id ?? undefined,
    opportunityId: r.opportunity_id ?? undefined,
    projectId: r.project_id ?? undefined,
    productId: r.product_id ?? undefined,
    issueId: r.issue_id ?? undefined,
    decisionRequired: r.decision_required,
    whyNow: r.why_now,
    options: r.options,
    recommendation: r.recommendation,
    decisionDeadline: r.decision_deadline,
    impactIfDelayed: r.impact_if_delayed,
    ceoTriggers: parseTriggers(r.ceo_triggers),
    financialImpact: Number(r.financial_impact) || 0,
    priority: r.priority,
    finalDecision: r.final_decision,
    decisionDate: r.decision_date,
    rationale: r.rationale,
    dataQuality: r.data_quality,
    authorityLevel: r.authority_level,
    lastUpdated: r.last_updated,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

/** Statuses whose decisions demand an accountable owner (§27). */
const OWNER_REQUIRED_STATUSES = new Set(["Ready for Decision", "CEO Review", "Decided"]);

export class DecisionStore {
  constructor(private db: Database.Database) {}

  list(params: DecisionSearchParams = {}): Decision[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions ORDER BY updated_at DESC`)
      .all() as DecisionRow[];
    let out = rows.map(rowToDecision);

    if (params.query) {
      const q = params.query.toLowerCase();
      out = out.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.decisionRequired.toLowerCase().includes(q) ||
          d.recommendation.toLowerCase().includes(q) ||
          d.rationale.toLowerCase().includes(q),
      );
    }
    if (params.decisionType) out = out.filter((d) => d.decisionType === params.decisionType);
    if (params.status) out = out.filter((d) => d.status === params.status);
    if (params.priority) out = out.filter((d) => d.priority === params.priority);
    if (params.owner) out = out.filter((d) => d.owner === params.owner);
    if (params.clientId) out = out.filter((d) => d.clientId === params.clientId);
    if (params.opportunityId) out = out.filter((d) => d.opportunityId === params.opportunityId);
    if (params.projectId) out = out.filter((d) => d.projectId === params.projectId);
    if (params.productId) out = out.filter((d) => d.productId === params.productId);
    if (params.issueId) out = out.filter((d) => d.issueId === params.issueId);
    if (params.since != null) out = out.filter((d) => d.updatedAt > params.since!);
    if (params.limit) out = out.slice(0, params.limit);
    return out;
  }

  get(id: string): Decision | null {
    const row = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as
      | DecisionRow
      | undefined;
    return row ? rowToDecision(row) : null;
  }

  /**
   * The CEO Queue surface: decisions with status in
   * (Ready for Decision, CEO Review), sorted most-urgent-first — by priority
   * rank (P0→P3), then by nearest deadline (empty deadlines sort last).
   */
  ceoQueue(): Decision[] {
    const placeholders = CEO_QUEUE_STATUSES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM decisions WHERE status IN (${placeholders})`)
      .all(...CEO_QUEUE_STATUSES) as DecisionRow[];
    return rows.map(rowToDecision).sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return deadlineKey(a.decisionDeadline) - deadlineKey(b.decisionDeadline);
    });
  }

  /**
   * §16 CEO Queue with the *trigger* gate applied: from the status-eligible
   * decisions, keep only those where at least one CEO Decision Trigger fires
   * (`isCeoDecision`) — operational work stays out. Same most-urgent-first order
   * as `ceoQueue()`. Each returned decision carries its inferred `ceoTriggers`
   * so callers can render "why this reached you" without re-deriving.
   */
  ceoQueueFiltered(): Decision[] {
    return this.ceoQueue()
      .filter((d) => isCeoDecision(d))
      .map((d) => ({ ...d, ceoTriggers: evaluateCeoTriggers(d) }));
  }

  create(params: DecisionCreateParams): Decision {
    const now = Date.now();
    const id = params.clientRequestId?.trim() || randomUUID();
    const existing = this.get(id);
    if (existing) return existing;

    const status = params.status ?? "Preparing";
    const owner = params.owner ?? "";
    // §27: one accountable owner. Enforced strictly once a decision is actionable
    // (queued/decided); drafts in "Preparing" may still be ownerless, but if an
    // owner is supplied it must be a single one.
    if (OWNER_REQUIRED_STATUSES.has(status) || owner.trim()) {
      assertSingleOwner({ owner });
    }

    const decision: Decision = {
      id,
      title: params.title ?? "",
      decisionType: params.decisionType ?? "",
      status,
      owner,
      supportingOwner: params.supportingOwner ?? "",
      // ceoRequired is derived-or-explicit: a CEO Review is always CEO-required.
      ceoRequired: params.ceoRequired ?? status === "CEO Review",
      requestedBy: params.requestedBy ?? "",
      clientId: params.clientId,
      opportunityId: params.opportunityId,
      projectId: params.projectId,
      productId: params.productId,
      issueId: params.issueId,
      decisionRequired: params.decisionRequired ?? "",
      whyNow: params.whyNow ?? "",
      options: params.options ?? "",
      recommendation: params.recommendation ?? "",
      decisionDeadline: params.decisionDeadline ?? "",
      impactIfDelayed: params.impactIfDelayed ?? "",
      ceoTriggers: Array.isArray(params.ceoTriggers) ? params.ceoTriggers : [],
      financialImpact: Number(params.financialImpact) || 0,
      priority: params.priority ?? "P2",
      finalDecision: params.finalDecision ?? "",
      decisionDate: params.decisionDate ?? "",
      rationale: params.rationale ?? "",
      dataQuality: params.dataQuality ?? "Unknown",
      authorityLevel: params.authorityLevel ?? "L0",
      lastUpdated: now,
      createdAt: now,
      updatedAt: now,
    };
    if (status === "CEO Review") decision.ceoRequired = true;

    this.db
      .prepare(
        `INSERT INTO decisions (
          id, title, decision_type, status, owner, supporting_owner, ceo_required,
          requested_by, client_id, opportunity_id, project_id, product_id, issue_id,
          decision_required, why_now, options, recommendation, decision_deadline,
          impact_if_delayed, ceo_triggers, financial_impact, priority,
          final_decision, decision_date, rationale, data_quality, authority_level,
          last_updated, created_at, updated_at
        ) VALUES (
          @id, @title, @decisionType, @status, @owner, @supportingOwner, @ceoRequired,
          @requestedBy, @clientId, @opportunityId, @projectId, @productId, @issueId,
          @decisionRequired, @whyNow, @options, @recommendation, @decisionDeadline,
          @impactIfDelayed, @ceoTriggers, @financialImpact, @priority,
          @finalDecision, @decisionDate, @rationale, @dataQuality, @authorityLevel,
          @lastUpdated, @createdAt, @updatedAt
        )`,
      )
      .run(this.bind(decision));

    this.syncRelations(decision);
    if (decision.status === "Decided") this.auditDecided(decision, "created-as-decided");
    return decision;
  }

  update(params: DecisionUpdateParams): Decision | null {
    const current = this.get(params.id);
    if (!current) return null;
    const next: Decision = {
      ...current,
      ...stripUndefined(params),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      lastUpdated: Date.now(),
    };
    if (OWNER_REQUIRED_STATUSES.has(String(next.status)) || String(next.owner).trim()) {
      assertSingleOwner({ owner: next.owner });
    }
    if (String(next.status) === "CEO Review") next.ceoRequired = true;

    this.db
      .prepare(
        `UPDATE decisions SET
          title=@title, decision_type=@decisionType, status=@status, owner=@owner,
          supporting_owner=@supportingOwner, ceo_required=@ceoRequired,
          requested_by=@requestedBy, client_id=@clientId, opportunity_id=@opportunityId,
          project_id=@projectId, product_id=@productId, issue_id=@issueId,
          decision_required=@decisionRequired, why_now=@whyNow, options=@options,
          recommendation=@recommendation, decision_deadline=@decisionDeadline,
          impact_if_delayed=@impactIfDelayed, ceo_triggers=@ceoTriggers,
          financial_impact=@financialImpact, priority=@priority, final_decision=@finalDecision,
          decision_date=@decisionDate, rationale=@rationale, data_quality=@dataQuality,
          authority_level=@authorityLevel, last_updated=@lastUpdated, updated_at=@updatedAt
        WHERE id=@id`,
      )
      .run(this.bind(next));

    this.syncRelations(next);
    // §33: log the moment a decision is Decided — a human made this call.
    if (current.status !== "Decided" && next.status === "Decided") {
      this.auditDecided(next, "status-transition");
    }
    return next;
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM decisions WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  // ── Relations (typed-edge store) ──

  /**
   * `decision_guides_task`: record that this decision drives a task. Returns the
   * created relation id (idempotent on the from/edge/to triple).
   */
  guideTask(decisionId: string, taskId: string, createdBy = "decision-agent"): string {
    const rel = getRelationsStore().create({
      fromType: "decision",
      fromId: decisionId,
      edge: "decision_guides_task",
      toType: "task",
      toId: taskId,
      createdBy,
    });
    return rel.id;
  }

  /**
   * Mirror the decision's denormalized parent ids into typed `relates_to` edges
   * so the decision shows up in each linked object's neighborhood graph. Best
   * effort: a relations failure never blocks the write.
   */
  private syncRelations(d: Decision): void {
    try {
      const store = getRelationsStore();
      const links: Array<[string, string | undefined]> = [
        ["client", d.clientId],
        ["opportunity", d.opportunityId],
        ["project", d.projectId],
        ["product", d.productId],
        ["issue", d.issueId],
      ];
      for (const [toType, toId] of links) {
        if (toId && String(toId).trim()) {
          store.create({
            fromType: "decision",
            fromId: d.id,
            edge: "relates_to",
            toType,
            toId,
            createdBy: "decision-agent",
          });
        }
      }
    } catch {
      /* relations are a convenience index; never fail the primary write */
    }
  }

  // ── Audit (§33) ──

  private auditDecided(d: Decision, trigger: string): void {
    try {
      getAuditStore().log({
        what: `Decision decided: ${d.title || d.id}`,
        trigger,
        agent: d.owner || "decision-agent",
        objectType: "decision",
        objectId: d.id,
        inputs: {
          decisionRequired: d.decisionRequired,
          options: d.options,
          decisionType: d.decisionType,
          priority: d.priority,
        },
        recommendation: d.recommendation,
        approval: d.owner ? `Decided by ${d.owner}` : "Human decision recorded",
        action: d.finalDecision || "(final decision recorded)",
        outcome: d.rationale || "",
        meta: { decisionDate: d.decisionDate, ceoRequired: d.ceoRequired },
      });
    } catch {
      /* audit is best-effort; never block the decision write */
    }
  }

  /** Map a Decision model onto the flat, SQLite-friendly bind object. */
  private bind(d: Decision): Record<string, string | number | null> {
    return {
      id: d.id,
      title: d.title,
      decisionType: d.decisionType,
      status: d.status,
      owner: d.owner,
      supportingOwner: d.supportingOwner ?? "",
      ceoRequired: d.ceoRequired ? 1 : 0,
      requestedBy: d.requestedBy,
      clientId: d.clientId ?? null,
      opportunityId: d.opportunityId ?? null,
      projectId: d.projectId ?? null,
      productId: d.productId ?? null,
      issueId: d.issueId ?? null,
      decisionRequired: d.decisionRequired,
      whyNow: d.whyNow ?? "",
      options: d.options,
      recommendation: d.recommendation,
      decisionDeadline: d.decisionDeadline,
      impactIfDelayed: d.impactIfDelayed ?? "",
      ceoTriggers: JSON.stringify(Array.isArray(d.ceoTriggers) ? d.ceoTriggers : []),
      financialImpact: Number(d.financialImpact) || 0,
      priority: String(d.priority),
      finalDecision: d.finalDecision,
      decisionDate: d.decisionDate,
      rationale: d.rationale,
      dataQuality: String(d.dataQuality ?? "Unknown"),
      authorityLevel: String(d.authorityLevel ?? "L0"),
      lastUpdated: d.lastUpdated ?? Date.now(),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }
}

/** Parse the JSON-encoded `ceo_triggers` column into a string[] (never throws). */
function parseTriggers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Sort key for an ISO date: empty/missing deadlines sort last. */
function deadlineKey(iso: string): number {
  if (!iso || !iso.trim()) return Number.MAX_SAFE_INTEGER;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
