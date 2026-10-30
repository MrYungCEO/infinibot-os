/**
 * Risk store — SQLite-backed Risk Register (Object 7).
 *
 * Modeled on `src/issues/store.ts`: local SQLite is the source of truth, opened
 * under the resolved `~/.infinibot` state dir (`risk.db`). Every caller — the
 * gateway `risk.*` RPC handlers and the HQ views — goes through this single
 * store so the contract stays consistent.
 *
 * The store owns three cross-cutting rules from the foundation:
 *   • §27 single accountable owner — `assertSingleOwner` at every write.
 *   • Risk Score is *computed* (probability × impact, 1–25) — never trusted
 *     from the caller — and the named band is mirrored onto the common
 *     `riskLevel` field.
 *   • §33 audit — when a risk first reaches the critical score threshold, an
 *     append-only audit entry is written via the shared audit ledger.
 * Overdue-review surfacing (§29) is exposed via `overdueReviews()`, which
 * combines the score-driven stale cadence with the explicit Next Review Date.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import { assertSingleOwner, isStale } from "../business-objects/rules.js";
import { getAuditStore } from "../business-objects/audit.js";
import {
  clampMatrix,
  computeRiskScore,
  isCriticalScore,
  riskBand,
  staleKindForScore,
} from "./types.js";
import type { Risk, RiskCreateParams, RiskSearchParams, RiskUpdateParams } from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getRiskStore(stateDir?: string): RiskStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new RiskStore(db);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS risks (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL DEFAULT '',
  category             TEXT NOT NULL DEFAULT '',
  -- §25 ownership --
  owner                TEXT NOT NULL DEFAULT '',
  supporting_owner     TEXT NOT NULL DEFAULT '',
  ceo_required         INTEGER NOT NULL DEFAULT 0,
  -- §25 execution --
  status               TEXT NOT NULL DEFAULT 'Open',
  priority             TEXT NOT NULL DEFAULT 'P2',
  next_action          TEXT NOT NULL DEFAULT '',
  next_action_owner    TEXT NOT NULL DEFAULT '',
  next_action_date     TEXT NOT NULL DEFAULT '',
  -- §25 relationships (denormalized id cache; graph lives in object-relations) --
  client_id            TEXT NOT NULL DEFAULT '',
  opportunity_id       TEXT NOT NULL DEFAULT '',
  project_id           TEXT NOT NULL DEFAULT '',
  product_id           TEXT NOT NULL DEFAULT '',
  issue_id             TEXT NOT NULL DEFAULT '',
  decision_id          TEXT NOT NULL DEFAULT '',
  -- scoring --
  probability          INTEGER NOT NULL DEFAULT 1,
  impact               INTEGER NOT NULL DEFAULT 1,
  risk_score           INTEGER NOT NULL DEFAULT 1,
  mitigation           TEXT NOT NULL DEFAULT '',
  next_review_date     TEXT NOT NULL DEFAULT '',
  -- §25 management --
  risk_level           TEXT NOT NULL DEFAULT '',
  financial_value      REAL NOT NULL DEFAULT 0,
  blocked              INTEGER NOT NULL DEFAULT 0,
  blocker              TEXT NOT NULL DEFAULT '',
  escalation_required  INTEGER NOT NULL DEFAULT 0,
  last_updated         INTEGER NOT NULL DEFAULT 0,
  -- §35 / §32 --
  data_quality         TEXT NOT NULL DEFAULT 'Unknown',
  authority_level      TEXT NOT NULL DEFAULT 'L0',
  -- timestamps --
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risks_status ON risks(status);
CREATE INDEX IF NOT EXISTS idx_risks_score ON risks(risk_score);
CREATE INDEX IF NOT EXISTS idx_risks_client ON risks(client_id);
CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id);
CREATE INDEX IF NOT EXISTS idx_risks_updated ON risks(updated_at);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const dbPath = resolve(stateDir, "risk.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> MODEL
// ═══════════════════════════════════════════════════════════════════

interface RiskRow {
  id: string;
  title: string;
  category: string;
  owner: string;
  supporting_owner: string;
  ceo_required: number;
  status: string;
  priority: string;
  next_action: string;
  next_action_owner: string;
  next_action_date: string;
  client_id: string;
  opportunity_id: string;
  project_id: string;
  product_id: string;
  issue_id: string;
  decision_id: string;
  probability: number;
  impact: number;
  risk_score: number;
  mitigation: string;
  next_review_date: string;
  risk_level: string;
  financial_value: number;
  blocked: number;
  blocker: string;
  escalation_required: number;
  last_updated: number;
  data_quality: string;
  authority_level: string;
  created_at: number;
  updated_at: number;
}

function rowToRisk(r: RiskRow): Risk {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    owner: r.owner,
    supportingOwner: r.supporting_owner,
    ceoRequired: r.ceo_required === 1,
    status: r.status,
    priority: r.priority,
    nextAction: r.next_action,
    nextActionOwner: r.next_action_owner,
    nextActionDate: r.next_action_date,
    clientId: r.client_id || undefined,
    opportunityId: r.opportunity_id || undefined,
    projectId: r.project_id || undefined,
    productId: r.product_id || undefined,
    issueId: r.issue_id || undefined,
    decisionId: r.decision_id || undefined,
    probability: r.probability,
    impact: r.impact,
    riskScore: r.risk_score,
    mitigation: r.mitigation,
    nextReviewDate: r.next_review_date,
    riskLevel: r.risk_level,
    financialValue: r.financial_value,
    blocked: r.blocked === 1,
    blocker: r.blocker,
    escalationRequired: r.escalation_required === 1,
    lastUpdated: r.last_updated,
    dataQuality: r.data_quality,
    authorityLevel: r.authority_level,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class RiskStore {
  constructor(private db: Database.Database) {}

  list(params: RiskSearchParams = {}): Risk[] {
    const rows = this.db
      .prepare(`SELECT * FROM risks ORDER BY risk_score DESC, updated_at DESC`)
      .all() as RiskRow[];
    let risks = rows.map(rowToRisk);

    if (params.query) {
      const q = params.query.toLowerCase();
      risks = risks.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.mitigation.toLowerCase().includes(q) ||
          String(r.category).toLowerCase().includes(q),
      );
    }
    if (params.category) risks = risks.filter((r) => r.category === params.category);
    if (params.status) risks = risks.filter((r) => r.status === params.status);
    if (params.owner) risks = risks.filter((r) => r.owner === params.owner);
    if (params.clientId) risks = risks.filter((r) => r.clientId === params.clientId);
    if (params.projectId) risks = risks.filter((r) => r.projectId === params.projectId);
    if (params.opportunityId) risks = risks.filter((r) => r.opportunityId === params.opportunityId);
    if (params.productId) risks = risks.filter((r) => r.productId === params.productId);
    if (params.minScore != null) risks = risks.filter((r) => r.riskScore >= params.minScore!);
    if (params.criticalOnly) risks = risks.filter((r) => isCriticalScore(r.riskScore));
    if (params.since != null) risks = risks.filter((r) => r.updatedAt > params.since!);
    if (params.limit) risks = risks.slice(0, params.limit);
    return risks;
  }

  get(id: string): Risk | null {
    const row = this.db.prepare(`SELECT * FROM risks WHERE id = ?`).get(id) as RiskRow | undefined;
    return row ? rowToRisk(row) : null;
  }

  /**
   * Risks whose review is overdue (§29). A risk is overdue when either its
   * explicit Next Review Date has passed, OR — falling back to the record's
   * freshness — it is stale for its score-driven cadence (3 days for critical
   * risks, 14 days otherwise). Closed risks are never surfaced.
   */
  overdueReviews(now: number = Date.now()): Risk[] {
    const today = new Date(now).toISOString().slice(0, 10);
    return this.list().filter((r) => {
      if (String(r.status) === "Closed") return false;
      const reviewPast = !!r.nextReviewDate && r.nextReviewDate < today;
      const kind = staleKindForScore(r.riskScore);
      return reviewPast || isStale({ lastUpdated: r.lastUpdated }, kind, now);
    });
  }

  create(params: RiskCreateParams): Risk {
    const now = Date.now();
    const id = params.clientRequestId?.trim() || randomUUID();
    // Idempotency: a repeat create with the same id returns the existing row.
    const existing = this.get(id);
    if (existing) return existing;

    const owner = params.owner ?? "";
    // §27: a risk without a single accountable owner "is a wish".
    assertSingleOwner({ owner });

    const probability = clampMatrix(params.probability);
    const impact = clampMatrix(params.impact);
    const riskScore = computeRiskScore(probability, impact);

    const risk: Risk = {
      id,
      title: params.title ?? "",
      category: params.category ?? "",
      owner,
      supportingOwner: params.supportingOwner ?? "",
      ceoRequired: params.ceoRequired ?? false,
      status: params.status ?? "Open",
      priority: params.priority ?? "P2",
      nextAction: params.nextAction ?? "",
      nextActionOwner: params.nextActionOwner ?? "",
      nextActionDate: params.nextActionDate ?? "",
      clientId: params.clientId ?? "",
      opportunityId: params.opportunityId ?? "",
      projectId: params.projectId ?? "",
      productId: params.productId ?? "",
      issueId: params.issueId ?? "",
      decisionId: params.decisionId ?? "",
      probability,
      impact,
      riskScore,
      mitigation: params.mitigation ?? "",
      nextReviewDate: params.nextReviewDate ?? "",
      riskLevel: riskBand(riskScore),
      financialValue: params.financialValue ?? 0,
      blocked: params.blocked ?? false,
      blocker: params.blocker ?? "",
      escalationRequired: params.escalationRequired ?? false,
      lastUpdated: now,
      dataQuality: params.dataQuality ?? "Unknown",
      authorityLevel: params.authorityLevel ?? "L0",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO risks (
          id, title, category, owner, supporting_owner, ceo_required,
          status, priority, next_action, next_action_owner, next_action_date,
          client_id, opportunity_id, project_id, product_id, issue_id, decision_id,
          probability, impact, risk_score, mitigation, next_review_date,
          risk_level, financial_value, blocked, blocker, escalation_required, last_updated,
          data_quality, authority_level, created_at, updated_at
        ) VALUES (
          @id, @title, @category, @owner, @supportingOwner, @ceoRequired,
          @status, @priority, @nextAction, @nextActionOwner, @nextActionDate,
          @clientId, @opportunityId, @projectId, @productId, @issueId, @decisionId,
          @probability, @impact, @riskScore, @mitigation, @nextReviewDate,
          @riskLevel, @financialValue, @blocked, @blocker, @escalationRequired, @lastUpdated,
          @dataQuality, @authorityLevel, @createdAt, @updatedAt
        )`,
      )
      .run(this.bind(risk));

    // §33 audit: a risk that is born critical is a significant fact to record.
    if (isCriticalScore(riskScore)) {
      this.auditCritical(risk, "created");
    }
    return risk;
  }

  update(params: RiskUpdateParams): Risk | null {
    const current = this.get(params.id);
    if (!current) return null;

    const patch = stripUndefined(params);
    const next: Risk = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
    } as Risk;

    // Re-clamp + recompute the score whenever probability/impact change.
    next.probability = clampMatrix(next.probability);
    next.impact = clampMatrix(next.impact);
    next.riskScore = computeRiskScore(next.probability, next.impact);
    next.riskLevel = riskBand(next.riskScore);
    next.updatedAt = Date.now();
    next.lastUpdated = next.updatedAt;

    // §27: enforce the single-owner rule on the resulting record.
    assertSingleOwner({ owner: next.owner });

    this.db
      .prepare(
        `UPDATE risks SET
          title=@title, category=@category, owner=@owner,
          supporting_owner=@supportingOwner, ceo_required=@ceoRequired,
          status=@status, priority=@priority, next_action=@nextAction,
          next_action_owner=@nextActionOwner, next_action_date=@nextActionDate,
          client_id=@clientId, opportunity_id=@opportunityId, project_id=@projectId,
          product_id=@productId, issue_id=@issueId, decision_id=@decisionId,
          probability=@probability, impact=@impact, risk_score=@riskScore,
          mitigation=@mitigation, next_review_date=@nextReviewDate,
          risk_level=@riskLevel, financial_value=@financialValue, blocked=@blocked,
          blocker=@blocker, escalation_required=@escalationRequired, last_updated=@lastUpdated,
          data_quality=@dataQuality, authority_level=@authorityLevel, updated_at=@updatedAt
        WHERE id=@id`,
      )
      .run(this.bind(next));

    // §33 audit: only when the risk *crosses* into critical on this update.
    if (isCriticalScore(next.riskScore) && !isCriticalScore(current.riskScore)) {
      this.auditCritical(next, "escalated");
    }
    return next;
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM risks WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  /** Append a §33 audit entry noting a risk reached the critical threshold. */
  private auditCritical(risk: Risk, how: "created" | "escalated"): void {
    try {
      getAuditStore().log({
        what: `Risk "${risk.title}" ${how} at a critical score (${risk.riskScore}/25)`,
        trigger: how === "created" ? "risk.create" : "risk.update",
        agent: "risk-register",
        inputs: {
          probability: risk.probability,
          impact: risk.impact,
          category: risk.category,
        },
        recommendation:
          "Review mitigation and Next Review Date; escalate to CEO if unowned or unfunded.",
        approval: "not required",
        action: `Flagged as ${risk.riskLevel} risk (score ${risk.riskScore})`,
        outcome: `Owner: ${risk.owner || "UNASSIGNED"}; status: ${risk.status}`,
        objectType: "risk",
        objectId: risk.id,
        meta: { riskScore: risk.riskScore, riskLevel: risk.riskLevel },
      });
    } catch {
      /* audit is best-effort; never block a write on the ledger. */
    }
  }

  /** Map a Risk model onto the flat, SQLite-friendly bind object. */
  private bind(r: Risk): Record<string, string | number | null> {
    return {
      id: r.id,
      title: r.title,
      category: String(r.category ?? ""),
      owner: r.owner,
      supportingOwner: r.supportingOwner ?? "",
      ceoRequired: r.ceoRequired ? 1 : 0,
      status: String(r.status ?? "Open"),
      priority: String(r.priority ?? "P2"),
      nextAction: r.nextAction ?? "",
      nextActionOwner: r.nextActionOwner ?? "",
      nextActionDate: r.nextActionDate ?? "",
      clientId: r.clientId ?? "",
      opportunityId: r.opportunityId ?? "",
      projectId: r.projectId ?? "",
      productId: r.productId ?? "",
      issueId: r.issueId ?? "",
      decisionId: r.decisionId ?? "",
      probability: r.probability,
      impact: r.impact,
      riskScore: r.riskScore,
      mitigation: r.mitigation,
      nextReviewDate: r.nextReviewDate,
      riskLevel: String(r.riskLevel ?? ""),
      financialValue: r.financialValue ?? 0,
      blocked: r.blocked ? 1 : 0,
      blocker: r.blocker ?? "",
      escalationRequired: r.escalationRequired ? 1 : 0,
      lastUpdated: r.lastUpdated ?? r.updatedAt,
      dataQuality: String(r.dataQuality ?? "Unknown"),
      authorityLevel: String(r.authorityLevel ?? "L0"),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
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
