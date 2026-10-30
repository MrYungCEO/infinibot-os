/**
 * Opportunities store — SQLite-backed Object 2 of the Business Control Layer.
 *
 * Modeled on `src/issues/store.ts`: local SQLite is the source of truth, opened
 * under the resolved `~/.infinibot` state dir in its own `opportunity.db`. Every
 * caller — the gateway `opportunity.*` RPC handlers and the UI — goes through
 * this single store so the contract stays consistent.
 *
 * The store owns the record; cross-object links (client → opportunity, product
 * → opportunity, opportunity → project) live in the shared typed-edge relations
 * store and are wired by the gateway handlers, per the foundation contract.
 *
 * Rule enforcement that belongs at the write boundary lives here: §27 single
 * accountable owner (`assertSingleOwner`) and §26 P0–P3 priority clamping. The
 * §28 next-action + §29 staleness flags are computed (pure) on read.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import { PRIORITIES } from "../business-objects/common.js";
import type { Priority } from "../business-objects/common.js";
import {
  assertSingleOwner,
  isStale,
  needsNextAction,
  priorityRank,
} from "../business-objects/rules.js";
import { TERMINAL_STAGES } from "./types.js";
import type {
  Opportunity,
  OpportunityCreateParams,
  OpportunitySearchParams,
  OpportunityUpdateParams,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getOpportunityStore(stateDir?: string): OpportunityStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new OpportunityStore(db);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS opportunities (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL DEFAULT '',
  owner              TEXT NOT NULL DEFAULT '',
  supporting_owner   TEXT NOT NULL DEFAULT '',
  ceo_required       INTEGER NOT NULL DEFAULT 0,
  opportunity_type   TEXT NOT NULL DEFAULT '',
  stage              TEXT NOT NULL DEFAULT 'New',
  status             TEXT NOT NULL DEFAULT '',
  priority           TEXT NOT NULL DEFAULT 'P2',
  problem_need       TEXT NOT NULL DEFAULT '',
  proposed_solution  TEXT NOT NULL DEFAULT '',
  estimated_value    REAL NOT NULL DEFAULT 0,
  revenue_type       TEXT NOT NULL DEFAULT '',
  opportunity_score  REAL NOT NULL DEFAULT 0,
  expected_close_date TEXT NOT NULL DEFAULT '',
  next_action        TEXT NOT NULL DEFAULT '',
  next_action_owner  TEXT NOT NULL DEFAULT '',
  next_action_date   TEXT NOT NULL DEFAULT '',
  waiting_for        TEXT NOT NULL DEFAULT '',
  review_date        TEXT NOT NULL DEFAULT '',
  client_id          TEXT NOT NULL DEFAULT '',
  product_id         TEXT NOT NULL DEFAULT '',
  project_id         TEXT NOT NULL DEFAULT '',
  proposal_link      TEXT NOT NULL DEFAULT '',
  notes              TEXT NOT NULL DEFAULT '',
  risk_level         TEXT NOT NULL DEFAULT '',
  blocked            INTEGER NOT NULL DEFAULT 0,
  blocker            TEXT NOT NULL DEFAULT '',
  escalation_required INTEGER NOT NULL DEFAULT 0,
  data_quality       TEXT NOT NULL DEFAULT 'Unknown',
  authority_level    TEXT NOT NULL DEFAULT 'L1',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_stage ON opportunities(stage);
CREATE INDEX IF NOT EXISTS idx_opp_client ON opportunities(client_id);
CREATE INDEX IF NOT EXISTS idx_opp_product ON opportunities(product_id);
CREATE INDEX IF NOT EXISTS idx_opp_updated ON opportunities(updated_at);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const dbPath = resolve(stateDir, "opportunity.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> MODEL
// ═══════════════════════════════════════════════════════════════════

interface OpportunityRow {
  id: string;
  name: string;
  owner: string;
  supporting_owner: string;
  ceo_required: number;
  opportunity_type: string;
  stage: string;
  status: string;
  priority: string;
  problem_need: string;
  proposed_solution: string;
  estimated_value: number;
  revenue_type: string;
  opportunity_score: number;
  expected_close_date: string;
  next_action: string;
  next_action_owner: string;
  next_action_date: string;
  waiting_for: string;
  review_date: string;
  client_id: string;
  product_id: string;
  project_id: string;
  proposal_link: string;
  notes: string;
  risk_level: string;
  blocked: number;
  blocker: string;
  escalation_required: number;
  data_quality: string;
  authority_level: string;
  created_at: number;
  updated_at: number;
}

function rowToOpportunity(r: OpportunityRow): Opportunity {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    supportingOwner: r.supporting_owner,
    ceoRequired: r.ceo_required === 1,
    opportunityType: r.opportunity_type,
    stage: r.stage,
    status: r.status,
    priority: r.priority,
    problemNeed: r.problem_need,
    proposedSolution: r.proposed_solution,
    estimatedValue: r.estimated_value,
    revenueType: r.revenue_type,
    opportunityScore: r.opportunity_score,
    expectedCloseDate: r.expected_close_date,
    nextAction: r.next_action,
    nextActionOwner: r.next_action_owner,
    nextActionDate: r.next_action_date,
    waitingFor: r.waiting_for,
    reviewDate: r.review_date,
    clientId: r.client_id,
    productId: r.product_id,
    projectId: r.project_id,
    proposalLink: r.proposal_link,
    notes: r.notes,
    riskLevel: r.risk_level,
    // Estimated Value is the opportunity's money; expose it through the common
    // Management.financialValue so cross-object money queries pick it up (§25).
    financialValue: r.estimated_value,
    blocked: r.blocked === 1,
    blocker: r.blocker,
    escalationRequired: r.escalation_required === 1,
    dataQuality: r.data_quality,
    authorityLevel: r.authority_level,
    lastUpdated: r.updated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** §26: keep priority within P0–P3; anything else falls back to P2 (Normal). */
function clampPriority(p: string | undefined | null): Priority {
  const up = String(p ?? "").toUpperCase();
  return (PRIORITIES as readonly string[]).includes(up) ? (up as Priority) : "P2";
}

/** Attach the pure §28 / §29 derived flags. Only active (non-terminal) records
 *  are flagged — a Won/Lost/Hold opportunity needs neither a next action nor a
 *  freshness nag. */
function withDerived(o: Opportunity, now: number): Opportunity {
  const active = !(TERMINAL_STAGES as readonly string[]).includes(String(o.stage));
  o.needsAction = active && needsNextAction(o);
  o.stale = active && isStale({ lastUpdated: o.lastUpdated }, "opportunity", now);
  return o;
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class OpportunityStore {
  constructor(private db: Database.Database) {}

  list(params: OpportunitySearchParams = {}): Opportunity[] {
    const rows = this.db
      .prepare(`SELECT * FROM opportunities ORDER BY updated_at DESC`)
      .all() as OpportunityRow[];
    let opps = rows.map(rowToOpportunity);

    if (params.query) {
      const q = params.query.toLowerCase();
      opps = opps.filter(
        (o) =>
          o.name.toLowerCase().includes(q) ||
          o.problemNeed.toLowerCase().includes(q) ||
          o.proposedSolution.toLowerCase().includes(q) ||
          o.notes.toLowerCase().includes(q),
      );
    }
    if (params.stage) opps = opps.filter((o) => o.stage === params.stage);
    if (params.opportunityType)
      opps = opps.filter((o) => o.opportunityType === params.opportunityType);
    if (params.priority) opps = opps.filter((o) => o.priority === params.priority);
    if (params.owner) opps = opps.filter((o) => o.owner === params.owner);
    if (params.clientId) opps = opps.filter((o) => o.clientId === params.clientId);
    if (params.productId) opps = opps.filter((o) => o.productId === params.productId);
    if (params.since != null) opps = opps.filter((o) => o.updatedAt > params.since!);

    // Most-urgent-first (§26), then most-recently-updated as a tiebreaker.
    opps.sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.updatedAt - a.updatedAt,
    );

    if (params.limit) opps = opps.slice(0, params.limit);
    const now = Date.now();
    for (const o of opps) withDerived(o, now);
    return opps;
  }

  get(id: string): Opportunity | null {
    const row = this.db.prepare(`SELECT * FROM opportunities WHERE id = ?`).get(id) as
      | OpportunityRow
      | undefined;
    if (!row) return null;
    return withDerived(rowToOpportunity(row), Date.now());
  }

  create(params: OpportunityCreateParams): Opportunity {
    const now = Date.now();
    const id = params.clientRequestId?.trim() || randomUUID();
    // Idempotency: a repeat create with the same id returns the existing row.
    const existing = this.get(id);
    if (existing) return existing;

    // §27 — exactly one accountable owner. A record without one "is a wish".
    assertSingleOwner({ owner: params.owner });

    // §35 — a migrated record is at best "FounderReported" unless verified.
    const dataQuality = params.dataQuality ?? (params.migrated ? "FounderReported" : "Unknown");

    const opp: Opportunity = {
      id,
      name: params.name ?? "",
      owner: params.owner ?? "",
      supportingOwner: params.supportingOwner ?? "",
      ceoRequired: params.ceoRequired ?? false,
      opportunityType: params.opportunityType ?? "New Client",
      stage: params.stage ?? "New",
      status: params.status ?? params.stage ?? "New",
      priority: clampPriority(params.priority),
      problemNeed: params.problemNeed ?? "",
      proposedSolution: params.proposedSolution ?? "",
      estimatedValue: Number(params.estimatedValue ?? 0) || 0,
      revenueType: params.revenueType ?? "",
      opportunityScore: Number(params.opportunityScore ?? 0) || 0,
      expectedCloseDate: params.expectedCloseDate ?? "",
      nextAction: params.nextAction ?? "",
      nextActionOwner: params.nextActionOwner ?? "",
      nextActionDate: params.nextActionDate ?? "",
      waitingFor: params.waitingFor ?? "",
      reviewDate: params.reviewDate ?? "",
      clientId: params.clientId ?? "",
      productId: params.productId ?? "",
      projectId: params.projectId ?? "",
      proposalLink: params.proposalLink ?? "",
      notes: params.notes ?? "",
      riskLevel: "",
      financialValue: Number(params.estimatedValue ?? 0) || 0,
      blocked: params.blocked ?? false,
      blocker: params.blocker ?? "",
      escalationRequired: params.escalationRequired ?? false,
      dataQuality,
      // §32 — Phase 1 opportunity agent recommends (L1); never autonomously
      // accepts/prices/signs (§24). Callers may raise to L2/L3 explicitly.
      authorityLevel: params.authorityLevel ?? "L1",
      lastUpdated: now,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(INSERT_SQL).run(this.bind(opp));
    return withDerived(opp, now);
  }

  update(params: OpportunityUpdateParams): Opportunity | null {
    const current = this.get(params.id);
    if (!current) return null;
    const patch = stripUndefined(params) as Partial<Opportunity>;
    const now = Date.now();
    const next: Opportunity = {
      ...current,
      ...patch,
      id: current.id,
      priority: clampPriority((patch.priority as string) ?? current.priority),
      createdAt: current.createdAt,
      updatedAt: now,
      lastUpdated: now,
    };
    // Estimated Value stays mirrored onto the common financialValue.
    if (patch.estimatedValue != null) {
      next.estimatedValue = Number(patch.estimatedValue) || 0;
      next.financialValue = next.estimatedValue;
    }
    // §27 — re-assert exactly one accountable owner after the patch.
    assertSingleOwner({ owner: next.owner });

    this.db.prepare(UPDATE_SQL).run(this.bind(next));
    return withDerived(next, now);
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM opportunities WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  /** Map an Opportunity model onto the flat, SQLite-friendly bind object. */
  private bind(o: Opportunity): Record<string, string | number | null> {
    return {
      id: o.id,
      name: o.name,
      owner: o.owner,
      supportingOwner: o.supportingOwner ?? "",
      ceoRequired: o.ceoRequired ? 1 : 0,
      opportunityType: o.opportunityType,
      stage: o.stage,
      status: o.status,
      priority: o.priority,
      problemNeed: o.problemNeed,
      proposedSolution: o.proposedSolution,
      estimatedValue: o.estimatedValue,
      revenueType: o.revenueType,
      opportunityScore: o.opportunityScore,
      expectedCloseDate: o.expectedCloseDate,
      nextAction: o.nextAction ?? "",
      nextActionOwner: o.nextActionOwner ?? "",
      nextActionDate: o.nextActionDate ?? "",
      waitingFor: o.waitingFor,
      reviewDate: o.reviewDate,
      clientId: o.clientId ?? "",
      productId: o.productId ?? "",
      projectId: o.projectId ?? "",
      proposalLink: o.proposalLink,
      notes: o.notes,
      riskLevel: o.riskLevel ?? "",
      blocked: o.blocked ? 1 : 0,
      blocker: o.blocker ?? "",
      escalationRequired: o.escalationRequired ? 1 : 0,
      dataQuality: String(o.dataQuality ?? "Unknown"),
      authorityLevel: String(o.authorityLevel ?? "L1"),
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    };
  }
}

const INSERT_SQL = `
  INSERT INTO opportunities (
    id, name, owner, supporting_owner, ceo_required, opportunity_type, stage,
    status, priority, problem_need, proposed_solution, estimated_value,
    revenue_type, opportunity_score, expected_close_date, next_action,
    next_action_owner, next_action_date, waiting_for, review_date, client_id,
    product_id, project_id, proposal_link, notes, risk_level, blocked, blocker,
    escalation_required, data_quality, authority_level, created_at, updated_at
  ) VALUES (
    @id, @name, @owner, @supportingOwner, @ceoRequired, @opportunityType, @stage,
    @status, @priority, @problemNeed, @proposedSolution, @estimatedValue,
    @revenueType, @opportunityScore, @expectedCloseDate, @nextAction,
    @nextActionOwner, @nextActionDate, @waitingFor, @reviewDate, @clientId,
    @productId, @projectId, @proposalLink, @notes, @riskLevel, @blocked, @blocker,
    @escalationRequired, @dataQuality, @authorityLevel, @createdAt, @updatedAt
  )`;

const UPDATE_SQL = `
  UPDATE opportunities SET
    name=@name, owner=@owner, supporting_owner=@supportingOwner,
    ceo_required=@ceoRequired, opportunity_type=@opportunityType, stage=@stage,
    status=@status, priority=@priority, problem_need=@problemNeed,
    proposed_solution=@proposedSolution, estimated_value=@estimatedValue,
    revenue_type=@revenueType, opportunity_score=@opportunityScore,
    expected_close_date=@expectedCloseDate, next_action=@nextAction,
    next_action_owner=@nextActionOwner, next_action_date=@nextActionDate,
    waiting_for=@waitingFor, review_date=@reviewDate, client_id=@clientId,
    product_id=@productId, project_id=@projectId, proposal_link=@proposalLink,
    notes=@notes, risk_level=@riskLevel, blocked=@blocked, blocker=@blocker,
    escalation_required=@escalationRequired, data_quality=@dataQuality,
    authority_level=@authorityLevel, updated_at=@updatedAt
  WHERE id=@id`;

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
