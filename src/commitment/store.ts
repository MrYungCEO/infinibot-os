/**
 * Financial Commitments store — SQLite-backed money-in / money-out ledger (§8).
 *
 * Modeled on `src/issues/store.ts`: local SQLite is the source of truth, opened
 * under the resolved `~/.infinibot` state dir (`commitment.db`). Every caller —
 * the gateway `commitment.*` RPC handlers and the UI — goes through this single
 * store so the contract stays consistent.
 *
 * On top of raw persistence this store owns three foundation integrations:
 *   - `assertSingleOwner` (§27) at every write boundary,
 *   - typed cross-object links via the `objrel` store (commitment_funds_project
 *     to a project; relates_to for client / opportunity / product),
 *   - append-only `audit.log` (§33) for significant money actions — creating or
 *     settling a commitment touches the §24 "no autonomous spend" boundary.
 *
 * `remainingBalance` and `overdue` are always COMPUTED on read — never stored —
 * so they can never drift from `amount`, `amountPaid`, `dueDate` and `status`.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import { defaultCommonFields } from "../business-objects/common.js";
import { assertSingleOwner } from "../business-objects/rules.js";
import { getRelationsStore } from "../relations/store.js";
import { getAuditStore } from "../business-objects/audit.js";
import type {
  Commitment,
  CommitmentAggregates,
  CommitmentCreateParams,
  CommitmentSearchParams,
  CommitmentUpdateParams,
} from "./types.js";
import { MONEY_IN_TYPES } from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getCommitmentStore(stateDir?: string): CommitmentStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new CommitmentStore(db, dir);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commitments (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL DEFAULT '',
  commitment_type      TEXT NOT NULL DEFAULT '',
  direction            TEXT NOT NULL DEFAULT 'Money In',
  status               TEXT NOT NULL DEFAULT 'Expected',
  amount               REAL NOT NULL DEFAULT 0,
  due_date             TEXT NOT NULL DEFAULT '',
  amount_paid          REAL NOT NULL DEFAULT 0,
  source_document_link TEXT NOT NULL DEFAULT '',
  -- common fields (§25) --
  owner                TEXT NOT NULL DEFAULT '',
  supporting_owner     TEXT NOT NULL DEFAULT '',
  ceo_required         INTEGER NOT NULL DEFAULT 0,
  priority             TEXT NOT NULL DEFAULT 'P2',
  next_action          TEXT NOT NULL DEFAULT '',
  next_action_owner    TEXT NOT NULL DEFAULT '',
  next_action_date     TEXT NOT NULL DEFAULT '',
  client_id            TEXT NOT NULL DEFAULT '',
  opportunity_id       TEXT NOT NULL DEFAULT '',
  project_id           TEXT NOT NULL DEFAULT '',
  product_id           TEXT NOT NULL DEFAULT '',
  data_quality         TEXT NOT NULL DEFAULT 'Unknown',
  authority_level      TEXT NOT NULL DEFAULT 'L0',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status);
CREATE INDEX IF NOT EXISTS idx_commitments_direction ON commitments(direction);
CREATE INDEX IF NOT EXISTS idx_commitments_project ON commitments(project_id);
CREATE INDEX IF NOT EXISTS idx_commitments_client ON commitments(client_id);
CREATE INDEX IF NOT EXISTS idx_commitments_due ON commitments(due_date);
CREATE INDEX IF NOT EXISTS idx_commitments_updated ON commitments(updated_at);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const dbPath = resolve(stateDir, "commitment.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// COMPUTED FIELDS (§8 remaining balance + overdue)
// ═══════════════════════════════════════════════════════════════════

const SETTLED_STATUSES = new Set(["Paid", "Cancelled"]);

/** Start-of-day (local) for `now`, so "due today" is never counted overdue. */
function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function computeRemaining(amount: number, amountPaid: number): number {
  const r = Number(amount || 0) - Number(amountPaid || 0);
  // A tiny epsilon guard keeps floating money noise from showing as "remaining".
  return Math.abs(r) < 0.005 ? 0 : r;
}

/**
 * A commitment is overdue when it is unsettled, still has a positive remaining
 * balance, and its due date has passed. `Cancelled` / `Paid` are never overdue;
 * an explicit `Overdue` status is honored even without a valid date.
 */
function computeOverdue(
  c: {
    status: string;
    dueDate: string;
    remainingBalance: number;
  },
  now: number,
): boolean {
  if (SETTLED_STATUSES.has(c.status)) return false;
  if (c.remainingBalance <= 0) return false;
  if (c.status === "Overdue") return true;
  const t = c.dueDate ? Date.parse(c.dueDate) : NaN;
  if (Number.isNaN(t)) return false;
  return t < startOfToday(now);
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> MODEL
// ═══════════════════════════════════════════════════════════════════

interface CommitmentRow {
  id: string;
  name: string;
  commitment_type: string;
  direction: string;
  status: string;
  amount: number;
  due_date: string;
  amount_paid: number;
  source_document_link: string;
  owner: string;
  supporting_owner: string;
  ceo_required: number;
  priority: string;
  next_action: string;
  next_action_owner: string;
  next_action_date: string;
  client_id: string;
  opportunity_id: string;
  project_id: string;
  product_id: string;
  data_quality: string;
  authority_level: string;
  created_at: number;
  updated_at: number;
}

function rowToCommitment(r: CommitmentRow, now: number): Commitment {
  const remainingBalance = computeRemaining(r.amount, r.amount_paid);
  const overdue = computeOverdue({ status: r.status, dueDate: r.due_date, remainingBalance }, now);
  // Start from a fully-defaulted common-fields base so every standardized field
  // is present, then override with what we persist.
  return {
    ...defaultCommonFields(r.id, r.owner),
    id: r.id,
    name: r.name,
    commitmentType: r.commitment_type,
    direction: r.direction,
    status: r.status,
    amount: r.amount,
    dueDate: r.due_date,
    amountPaid: r.amount_paid,
    remainingBalance,
    overdue,
    sourceDocumentLink: r.source_document_link,
    owner: r.owner,
    supportingOwner: r.supporting_owner,
    ceoRequired: r.ceo_required === 1,
    priority: r.priority,
    nextAction: r.next_action,
    nextActionOwner: r.next_action_owner,
    nextActionDate: r.next_action_date,
    clientId: r.client_id || undefined,
    opportunityId: r.opportunity_id || undefined,
    projectId: r.project_id || undefined,
    productId: r.product_id || undefined,
    // Mirror amount into the shared money field so cross-object rollups see it.
    financialValue: r.amount,
    lastUpdated: r.updated_at,
    dataQuality: r.data_quality,
    authorityLevel: r.authority_level,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class CommitmentStore {
  /**
   * `stateDir` is threaded into the objrel + audit stores so all three resolve
   * to the same state dir (matters under a custom/per-user dir; a no-op for the
   * default). Defaults to the resolved default when constructed directly.
   */
  constructor(
    private db: Database.Database,
    private stateDir: string = resolveStateDirWithLegacyEnv(),
  ) {}

  list(params: CommitmentSearchParams = {}): Commitment[] {
    const now = Date.now();
    const rows = this.db
      .prepare(`SELECT * FROM commitments ORDER BY updated_at DESC`)
      .all() as CommitmentRow[];
    let items = rows.map((r) => rowToCommitment(r, now));

    if (params.query) {
      const q = params.query.toLowerCase();
      items = items.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          String(c.commitmentType).toLowerCase().includes(q) ||
          c.sourceDocumentLink.toLowerCase().includes(q),
      );
    }
    if (params.commitmentType)
      items = items.filter((c) => c.commitmentType === params.commitmentType);
    if (params.direction) items = items.filter((c) => c.direction === params.direction);
    if (params.status) items = items.filter((c) => c.status === params.status);
    if (params.owner) items = items.filter((c) => c.owner === params.owner);
    if (params.clientId) items = items.filter((c) => c.clientId === params.clientId);
    if (params.projectId) items = items.filter((c) => c.projectId === params.projectId);
    if (params.opportunityId) items = items.filter((c) => c.opportunityId === params.opportunityId);
    if (params.productId) items = items.filter((c) => c.productId === params.productId);
    if (params.overdueOnly) items = items.filter((c) => c.overdue);
    if (params.since != null) items = items.filter((c) => c.updatedAt > params.since!);
    if (params.limit) items = items.slice(0, params.limit);
    return items;
  }

  get(id: string): Commitment | null {
    const row = this.db.prepare(`SELECT * FROM commitments WHERE id = ?`).get(id) as
      | CommitmentRow
      | undefined;
    return row ? rowToCommitment(row, Date.now()) : null;
  }

  create(params: CommitmentCreateParams): Commitment {
    const now = Date.now();
    const id = params.clientRequestId?.trim() || randomUUID();
    // Idempotency: a repeat create with the same id returns the existing row.
    const existing = this.get(id);
    if (existing) return existing;

    // §27 — a commitment is an accountable financial obligation; it needs one
    // (and only one) accountable owner.
    assertSingleOwner({ owner: params.owner ?? "" });

    const bind = {
      id,
      name: params.name ?? "",
      commitment_type: params.commitmentType ?? "",
      direction: params.direction ?? "Money In",
      status: params.status ?? "Expected",
      amount: Number(params.amount ?? 0),
      due_date: params.dueDate ?? "",
      amount_paid: Number(params.amountPaid ?? 0),
      source_document_link: params.sourceDocumentLink ?? "",
      owner: params.owner ?? "",
      supporting_owner: params.supportingOwner ?? "",
      ceo_required: params.ceoRequired ? 1 : 0,
      priority: params.priority ?? "P2",
      next_action: params.nextAction ?? "",
      next_action_owner: params.nextActionOwner ?? "",
      next_action_date: params.nextActionDate ?? "",
      client_id: params.clientId ?? "",
      opportunity_id: params.opportunityId ?? "",
      project_id: params.projectId ?? "",
      product_id: params.productId ?? "",
      data_quality: params.dataQuality ?? "Unknown",
      authority_level: params.authorityLevel ?? "L0",
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO commitments (
          id, name, commitment_type, direction, status, amount, due_date,
          amount_paid, source_document_link, owner, supporting_owner, ceo_required,
          priority, next_action, next_action_owner, next_action_date,
          client_id, opportunity_id, project_id, product_id,
          data_quality, authority_level, created_at, updated_at
        ) VALUES (
          @id, @name, @commitment_type, @direction, @status, @amount, @due_date,
          @amount_paid, @source_document_link, @owner, @supporting_owner, @ceo_required,
          @priority, @next_action, @next_action_owner, @next_action_date,
          @client_id, @opportunity_id, @project_id, @product_id,
          @data_quality, @authority_level, @created_at, @updated_at
        )`,
      )
      .run(bind);

    const created = this.get(id)!;
    this.syncRelations(created, params.createdBy ?? "commitment-agent");
    this.auditWrite(created, "created", params.createdBy ?? "commitment-agent");
    return created;
  }

  update(params: CommitmentUpdateParams): Commitment | null {
    const current = this.get(params.id);
    if (!current) return null;

    const patch = stripUndefined(params);
    // §27 — re-assert single ownership using the post-patch owner value.
    const nextOwner = patch.owner != null ? String(patch.owner) : current.owner;
    assertSingleOwner({ owner: nextOwner });

    const next = { ...current, ...patch } as Commitment;
    const now = Date.now();
    const bind = {
      id: current.id,
      name: next.name ?? "",
      commitment_type: next.commitmentType ?? "",
      direction: next.direction ?? "Money In",
      status: next.status ?? "Expected",
      amount: Number(next.amount ?? 0),
      due_date: next.dueDate ?? "",
      amount_paid: Number(next.amountPaid ?? 0),
      source_document_link: next.sourceDocumentLink ?? "",
      owner: nextOwner,
      supporting_owner: next.supportingOwner ?? "",
      ceo_required: next.ceoRequired ? 1 : 0,
      priority: next.priority ?? "P2",
      next_action: next.nextAction ?? "",
      next_action_owner: next.nextActionOwner ?? "",
      next_action_date: next.nextActionDate ?? "",
      client_id: next.clientId ?? "",
      opportunity_id: next.opportunityId ?? "",
      project_id: next.projectId ?? "",
      product_id: next.productId ?? "",
      data_quality: next.dataQuality ?? "Unknown",
      authority_level: next.authorityLevel ?? "L0",
      updated_at: now,
    };
    this.db
      .prepare(
        `UPDATE commitments SET
          name=@name, commitment_type=@commitment_type, direction=@direction,
          status=@status, amount=@amount, due_date=@due_date, amount_paid=@amount_paid,
          source_document_link=@source_document_link, owner=@owner,
          supporting_owner=@supporting_owner, ceo_required=@ceo_required,
          priority=@priority, next_action=@next_action, next_action_owner=@next_action_owner,
          next_action_date=@next_action_date, client_id=@client_id,
          opportunity_id=@opportunity_id, project_id=@project_id, product_id=@product_id,
          data_quality=@data_quality, authority_level=@authority_level, updated_at=@updated_at
        WHERE id=@id`,
      )
      .run(bind);

    const updated = this.get(current.id)!;
    this.syncRelations(updated, (params.createdBy as string) ?? "commitment-agent");
    // Only audit a settlement transition (money actually moved / obligation closed).
    if (patch.status != null && patch.status !== current.status) {
      this.auditWrite(
        updated,
        `status → ${updated.status}`,
        params.createdBy ?? "commitment-agent",
      );
    }
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    const res = this.db.prepare(`DELETE FROM commitments WHERE id = ?`).run(id);
    if (res.changes > 0) {
      try {
        getRelationsStore(this.stateDir).deleteMatch({ fromType: "commitment", fromId: id });
      } catch {
        /* relations best-effort */
      }
      if (existing) this.auditWrite(existing, "deleted", "commitment-agent");
    }
    return res.changes > 0;
  }

  /**
   * §8 money surfaces. Amounts are in the same units as `Commitment.amount`.
   * `params` narrows the population first (e.g. by client or project).
   */
  computeAggregates(params: CommitmentSearchParams = {}): CommitmentAggregates {
    const items = this.list(params);
    const isActive = (c: Commitment) => !SETTLED_STATUSES.has(String(c.status));
    const isMoneyIn = (c: Commitment) =>
      c.direction === "Money In" || MONEY_IN_TYPES.includes(c.commitmentType as never);

    let moneyExpected = 0;
    let moneyOwed = 0;
    let moneyOverdue = 0;
    let depositsNotReceived = 0;
    let overdueCount = 0;
    const wpwpIds: string[] = [];
    const wpwpProjects = new Set<string>();
    let wpwpAmount = 0;

    for (const c of items) {
      const remaining = Math.max(0, c.remainingBalance);
      if (c.overdue) {
        moneyOverdue += remaining;
        overdueCount += 1;
      }
      if (isActive(c)) {
        if (isMoneyIn(c)) {
          moneyExpected += remaining;
          if (c.commitmentType === "Deposit") depositsNotReceived += remaining;
          // Work proceeding without payment: money owed to us on a live project.
          if (c.projectId && remaining > 0) {
            wpwpIds.push(c.id);
            wpwpProjects.add(c.projectId);
            wpwpAmount += remaining;
          }
        } else {
          moneyOwed += remaining;
        }
      }
    }

    return {
      moneyExpected,
      moneyOwed,
      moneyOverdue,
      depositsNotReceived,
      workProceedingWithoutPayment: {
        count: wpwpIds.length,
        amount: wpwpAmount,
        projectIds: [...wpwpProjects],
        commitmentIds: wpwpIds,
      },
      overdueCount,
      total: items.length,
    };
  }

  // ── Foundation integrations ──────────────────────────────────────

  /**
   * Reconcile this commitment's typed cross-object links: exactly one
   * `commitment_funds_project` edge (if a project is set) and one `relates_to`
   * edge each to client / opportunity / product. Reconciling (delete-then-link)
   * keeps links correct when a parent id is changed on update. Best-effort: a
   * relations failure never breaks the core write.
   */
  private syncRelations(c: Commitment, createdBy: string): void {
    try {
      const rel = getRelationsStore(this.stateDir);
      const reconcile = (edge: string, toType: string, toId: string | undefined) => {
        rel.deleteMatch({ fromType: "commitment", fromId: c.id, edge, toType });
        if (toId) {
          rel.create({
            fromType: "commitment",
            fromId: c.id,
            edge,
            toType,
            toId,
            createdBy,
          });
        }
      };
      reconcile("commitment_funds_project", "project", c.projectId);
      reconcile("relates_to", "client", c.clientId);
      reconcile("relates_to", "opportunity", c.opportunityId);
      reconcile("relates_to", "product", c.productId);
    } catch {
      /* relations best-effort */
    }
  }

  /**
   * §33 / §24 — append an audit entry for a significant money action. Creating
   * or settling a commitment is a financial obligation the system must never
   * execute autonomously (no autonomous spend), so we record who did it and note
   * that human approval is required for the actual money movement.
   */
  private auditWrite(c: Commitment, what: string, agent: string): void {
    try {
      const moneyOut = c.direction === "Money Out";
      getAuditStore(this.stateDir).log({
        what: `Commitment ${what}: "${c.name}" (${c.direction}, ${c.commitmentType})`,
        trigger: "commitment.write",
        agent,
        inputs: {
          amount: c.amount,
          amountPaid: c.amountPaid,
          remainingBalance: c.remainingBalance,
          status: c.status,
          dueDate: c.dueDate,
        },
        recommendation: "",
        // §24: no autonomous spend — money movement stays human-approved.
        approval: moneyOut
          ? "Human approval required (no autonomous spend, §24)"
          : "Recorded by human/operator",
        action: what,
        outcome: `remaining ${c.remainingBalance}`,
        objectType: "commitment",
        objectId: c.id,
        meta: { direction: c.direction, ceoRequired: c.ceoRequired },
      });
    } catch {
      /* audit best-effort */
    }
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
