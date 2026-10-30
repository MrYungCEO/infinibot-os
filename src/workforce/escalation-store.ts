/**
 * Durable storage for the escalation protocol.
 *
 * Lives in the same `agency.db` as the rest of the workforce and follows the
 * `WorkforceStore` convention (`CREATE TABLE IF NOT EXISTS` + additive columns)
 * rather than the numbered `schema_migrations` used by `AgencyOperationsStore`
 * — no migration number moves, so gateway boot is untouched.
 *
 * ── Persist first, deliver second ───────────────────────────────────────────
 * `create()` is called before any channel is touched. A delivery failure
 * therefore leaves a readable row with `status: "failed"` and the composed
 * message intact, so the UI can show an escalation that no channel accepted.
 * Nothing about delivery is on the write path of raising.
 *
 * ── Write amplification ─────────────────────────────────────────────────────
 * This database has been grown to 633 MB by a loop that wrote per pass. Every
 * method here either writes exactly one row for one genuine event, or collapses
 * into an `occurrences` bump on an existing row. `update()` writes nothing when
 * the patch is empty.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import {
  defaultEscalationPolicy,
  normalizeEscalationPolicy,
  OPEN_ESCALATION_STATUSES,
  type AgencyEscalationPolicy,
  type ApprovalState,
  type Escalation,
  type EscalationKind,
  type EscalationRecipientKind,
  type EscalationStatus,
  type EscalationUrgency,
} from "./escalation-types.js";
import type { ChatChannelId } from "../channels/registry.js";

type Row = Record<string, unknown>;

const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};

const requireAgency = (value: string) => {
  if (!value?.trim()) throw new Error("agencyId required");
};

/** Unambiguous alphabet: no O/0, no I/1, no S/5 — humans retype these. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";

function randomCode(): string {
  let out = "";
  for (let index = 0; index < 6; index += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `ESC-${out}`;
}

export type EscalationRecordInput = {
  id?: string;
  workerId: string;
  workItemId: string | null;
  kind: EscalationKind;
  urgency: EscalationUrgency;
  status: EscalationStatus;
  title: string;
  summary: string;
  question: string | null;
  options: string[];
  reference: string | null;
  recipientKind?: EscalationRecipientKind;
  recipientLabel?: string | null;
  channelId: ChatChannelId | null;
  target: string | null;
  bindingId: string | null;
  requiresApproval?: boolean;
  approvalState?: ApprovalState;
  approvalChannelId?: ChatChannelId | null;
  approvalTarget?: string | null;
  draftMessage?: string | null;
  dedupeKey: string;
  /** Reserve one with `nextCorrelationCode()` so the composed message can
   *  carry the tag it will actually be answered with. */
  correlationCode?: string;
  digestDueAt?: number | null;
  deliverAfter: number;
  composedMessage?: string | null;
  reason?: string;
  context: Record<string, unknown>;
  now?: number;
};

export type EscalationPatch = Partial<
  Pick<
    Escalation,
    | "status"
    | "urgency"
    | "channelId"
    | "target"
    | "bindingId"
    | "digestId"
    | "digestDueAt"
    | "deliverAfter"
    | "attempts"
    | "lastAttemptAt"
    | "lastError"
    | "deliveredAt"
    | "composedMessage"
    | "reason"
    | "answer"
    | "answeredAt"
    | "answeredBy"
    | "resolvedAt"
    | "resolutionNote"
    | "occurrences"
    | "recipientKind"
    | "recipientLabel"
    | "requiresApproval"
    | "approvalState"
    | "approvalChannelId"
    | "approvalTarget"
    | "approvalRequestedAt"
    | "approvedAt"
    | "approvedBy"
    | "rejectedAt"
    | "rejectionReason"
    | "draftMessage"
  >
>;

export type EscalationListFilters = {
  workerId?: string;
  workItemId?: string;
  kind?: EscalationKind;
  status?: EscalationStatus;
  /** Convenience: everything not resolved/cancelled/suppressed. */
  openOnly?: boolean;
  since?: number;
  limit?: number;
  offset?: number;
};

export type EscalationDeliveryAttempt = {
  id: string;
  agencyId: string;
  escalationId: string;
  attempt: number;
  channelId: string | null;
  target: string | null;
  ok: boolean;
  messageId: string | null;
  error: string | null;
  at: number;
};

export class WorkforceEscalationStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.createTables();
  }

  close(): void {
    this.db.close();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wf_escalations (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, work_item_id TEXT,
        kind TEXT NOT NULL, urgency TEXT NOT NULL, status TEXT NOT NULL,
        title TEXT NOT NULL, summary TEXT NOT NULL, question TEXT, options_json TEXT NOT NULL,
        reference TEXT, channel_id TEXT, target TEXT, binding_id TEXT,
        recipient_kind TEXT NOT NULL DEFAULT 'operator', recipient_label TEXT,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        approval_state TEXT NOT NULL DEFAULT 'not_required',
        approval_channel_id TEXT, approval_target TEXT, approval_requested_at INTEGER,
        approved_at INTEGER, approved_by TEXT, rejected_at INTEGER, rejection_reason TEXT,
        draft_message TEXT,
        correlation_code TEXT NOT NULL, dedupe_key TEXT NOT NULL, occurrences INTEGER NOT NULL,
        digest_id TEXT, digest_due_at INTEGER, deliver_after INTEGER NOT NULL,
        attempts INTEGER NOT NULL, last_attempt_at INTEGER, last_error TEXT, delivered_at INTEGER,
        composed_message TEXT, reason TEXT NOT NULL,
        answer TEXT, answered_at INTEGER, answered_by TEXT, resolved_at INTEGER, resolution_note TEXT,
        context_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(agency_id, id),
        UNIQUE(agency_id, correlation_code)
      );
      CREATE INDEX IF NOT EXISTS idx_wf_escalation_status
        ON wf_escalations(agency_id, status, deliver_after);
      CREATE INDEX IF NOT EXISTS idx_wf_escalation_worker
        ON wf_escalations(agency_id, worker_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_wf_escalation_dedupe
        ON wf_escalations(agency_id, worker_id, dedupe_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_wf_escalation_work_item
        ON wf_escalations(agency_id, work_item_id, status);
      CREATE INDEX IF NOT EXISTS idx_wf_escalation_digest
        ON wf_escalations(agency_id, status, digest_due_at);
      CREATE TABLE IF NOT EXISTS wf_escalation_deliveries (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, escalation_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, channel_id TEXT, target TEXT, ok INTEGER NOT NULL,
        message_id TEXT, error TEXT, at INTEGER NOT NULL,
        PRIMARY KEY(agency_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_wf_escalation_delivery
        ON wf_escalation_deliveries(agency_id, escalation_id, at);
      CREATE INDEX IF NOT EXISTS idx_wf_escalation_approval
        ON wf_escalations(agency_id, approval_state, approval_requested_at);
      CREATE TABLE IF NOT EXISTS wf_escalation_policies (
        agency_id TEXT NOT NULL, scope_key TEXT NOT NULL, policy_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(agency_id, scope_key)
      );
    `);
    // Additive columns, `WorkforceStore` style: a database written by an
    // earlier build of this branch is upgraded in place, never rebuilt.
    this.ensureColumn("wf_escalations", "recipient_kind", "TEXT NOT NULL DEFAULT 'operator'");
    this.ensureColumn("wf_escalations", "recipient_label", "TEXT");
    this.ensureColumn("wf_escalations", "requires_approval", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("wf_escalations", "approval_state", "TEXT NOT NULL DEFAULT 'not_required'");
    this.ensureColumn("wf_escalations", "approval_channel_id", "TEXT");
    this.ensureColumn("wf_escalations", "approval_target", "TEXT");
    this.ensureColumn("wf_escalations", "approval_requested_at", "INTEGER");
    this.ensureColumn("wf_escalations", "approved_at", "INTEGER");
    this.ensureColumn("wf_escalations", "approved_by", "TEXT");
    this.ensureColumn("wf_escalations", "rejected_at", "INTEGER");
    this.ensureColumn("wf_escalations", "rejection_reason", "TEXT");
    this.ensureColumn("wf_escalations", "draft_message", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((row) => String(row.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  // ── Escalations ───────────────────────────────────────────────────────────

  /**
   * Reserve a correlation code before composing, so the message the human
   * receives carries the same tag the reply is matched on. Codes are 6 chars
   * from a 30-symbol alphabet; a collision inside one agency is vanishingly
   * unlikely but must not throw when it happens.
   */
  nextCorrelationCode(agencyId: string): string {
    requireAgency(agencyId);
    let code = randomCode();
    for (let attempt = 0; attempt < 8 && this.getByCode(agencyId, code); attempt += 1) {
      code = randomCode();
    }
    return code;
  }

  /** Persist a new escalation. Called BEFORE any channel is touched. */
  create(agencyId: string, input: EscalationRecordInput): Escalation {
    requireAgency(agencyId);
    const now = input.now ?? Date.now();
    const id = input.id ?? randomUUID();
    const code = input.correlationCode ?? this.nextCorrelationCode(agencyId);
    this.db
      .prepare(`INSERT INTO wf_escalations
        (id, agency_id, worker_id, work_item_id, kind, urgency, status, title, summary, question,
         options_json, reference, channel_id, target, binding_id,
         recipient_kind, recipient_label, requires_approval, approval_state,
         approval_channel_id, approval_target, approval_requested_at,
         approved_at, approved_by, rejected_at, rejection_reason, draft_message,
         correlation_code, dedupe_key,
         occurrences, digest_id, digest_due_at, deliver_after, attempts, last_attempt_at, last_error,
         delivered_at, composed_message, reason, answer, answered_at, answered_by, resolved_at,
         resolution_note, context_json, created_at, updated_at)
        VALUES (@id, @agencyId, @workerId, @workItemId, @kind, @urgency, @status, @title, @summary,
         @question, @options, @reference, @channelId, @target, @bindingId,
         @recipientKind, @recipientLabel, @requiresApproval, @approvalState,
         @approvalChannelId, @approvalTarget, NULL,
         NULL, NULL, NULL, NULL, @draftMessage,
         @code, @dedupeKey,
         1, NULL, @digestDueAt, @deliverAfter, 0, NULL, NULL, NULL, @composedMessage, @reason,
         NULL, NULL, NULL, NULL, NULL, @context, @now, @now)`)
      .run({
        id,
        agencyId,
        workerId: input.workerId,
        workItemId: input.workItemId,
        kind: input.kind,
        urgency: input.urgency,
        status: input.status,
        title: input.title,
        summary: input.summary,
        question: input.question,
        options: JSON.stringify(input.options),
        reference: input.reference,
        channelId: input.channelId,
        target: input.target,
        bindingId: input.bindingId,
        recipientKind: input.recipientKind ?? "operator",
        recipientLabel: input.recipientLabel ?? null,
        requiresApproval: input.requiresApproval ? 1 : 0,
        approvalState: input.approvalState ?? (input.requiresApproval ? "pending" : "not_required"),
        approvalChannelId: input.approvalChannelId ?? null,
        approvalTarget: input.approvalTarget ?? null,
        draftMessage: input.draftMessage ?? null,
        code,
        dedupeKey: input.dedupeKey,
        digestDueAt: input.digestDueAt ?? null,
        deliverAfter: input.deliverAfter,
        composedMessage: input.composedMessage ?? null,
        reason: input.reason ?? "",
        context: JSON.stringify(input.context ?? {}),
        now,
      });
    return this.get(agencyId, id)!;
  }

  get(agencyId: string, id: string): Escalation | null {
    requireAgency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_escalations WHERE agency_id=? AND id=?")
      .get(agencyId, id) as Row | undefined;
    return row ? this.hydrate(row) : null;
  }

  getByCode(agencyId: string, correlationCode: string): Escalation | null {
    requireAgency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_escalations WHERE agency_id=? AND correlation_code=?")
      .get(agencyId, correlationCode.toUpperCase()) as Row | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** Code lookup across every agency — inbound replies carry no agency id. */
  findByCodeAnyAgency(correlationCode: string): Escalation | null {
    const row = this.db
      .prepare(
        "SELECT * FROM wf_escalations WHERE correlation_code=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(correlationCode.toUpperCase()) as Row | undefined;
    return row ? this.hydrate(row) : null;
  }

  list(agencyId: string, filters: EscalationListFilters = {}): Escalation[] {
    requireAgency(agencyId);
    let sql = "SELECT * FROM wf_escalations WHERE agency_id=?";
    const params: unknown[] = [agencyId];
    if (filters.workerId) {
      sql += " AND worker_id=?";
      params.push(filters.workerId);
    }
    if (filters.workItemId) {
      sql += " AND work_item_id=?";
      params.push(filters.workItemId);
    }
    if (filters.kind) {
      sql += " AND kind=?";
      params.push(filters.kind);
    }
    if (filters.status) {
      sql += " AND status=?";
      params.push(filters.status);
    }
    if (filters.openOnly) {
      sql += ` AND status IN (${OPEN_ESCALATION_STATUSES.map(() => "?").join(",")})`;
      params.push(...OPEN_ESCALATION_STATUSES);
    }
    if (filters.since !== undefined) {
      sql += " AND created_at>=?";
      params.push(filters.since);
    }
    sql += ` ORDER BY CASE urgency WHEN 'critical' THEN 4 WHEN 'high' THEN 3
      WHEN 'normal' THEN 2 ELSE 1 END DESC, created_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.max(1, Math.min(500, filters.limit ?? 100)), Math.max(0, filters.offset ?? 0));
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.hydrate(row));
  }

  count(agencyId: string, filters: Omit<EscalationListFilters, "limit" | "offset"> = {}): number {
    const rows = this.list(agencyId, { ...filters, limit: 500 });
    return rows.length;
  }

  /**
   * The still-open escalation this one would duplicate, if any. `since` is the
   * dedupe window: an identical blocker a week later is genuinely new.
   */
  findOpenDuplicate(
    agencyId: string,
    workerId: string,
    dedupeKey: string,
    since: number,
  ): Escalation | null {
    requireAgency(agencyId);
    const row = this.db
      .prepare(
        `SELECT * FROM wf_escalations
         WHERE agency_id=? AND worker_id=? AND dedupe_key=? AND created_at>=?
           AND status IN (${OPEN_ESCALATION_STATUSES.map(() => "?").join(",")})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(agencyId, workerId, dedupeKey, since, ...OPEN_ESCALATION_STATUSES) as Row | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** Collapse a repeat into the existing row. One UPDATE, no new row, no send. */
  bumpOccurrence(agencyId: string, id: string, now = Date.now()): Escalation | null {
    requireAgency(agencyId);
    const changed = this.db
      .prepare(
        "UPDATE wf_escalations SET occurrences=occurrences+1, updated_at=? WHERE agency_id=? AND id=?",
      )
      .run(now, agencyId, id).changes;
    return changed ? this.get(agencyId, id) : null;
  }

  /** Named-column partial update. Writes nothing for an empty patch. */
  update(
    agencyId: string,
    id: string,
    patch: EscalationPatch,
    now = Date.now(),
  ): Escalation | null {
    requireAgency(agencyId);
    const columns: Record<keyof EscalationPatch, string> = {
      status: "status",
      urgency: "urgency",
      channelId: "channel_id",
      target: "target",
      bindingId: "binding_id",
      digestId: "digest_id",
      digestDueAt: "digest_due_at",
      deliverAfter: "deliver_after",
      attempts: "attempts",
      lastAttemptAt: "last_attempt_at",
      lastError: "last_error",
      deliveredAt: "delivered_at",
      composedMessage: "composed_message",
      reason: "reason",
      answer: "answer",
      answeredAt: "answered_at",
      answeredBy: "answered_by",
      resolvedAt: "resolved_at",
      resolutionNote: "resolution_note",
      occurrences: "occurrences",
      recipientKind: "recipient_kind",
      recipientLabel: "recipient_label",
      requiresApproval: "requires_approval",
      approvalState: "approval_state",
      approvalChannelId: "approval_channel_id",
      approvalTarget: "approval_target",
      approvalRequestedAt: "approval_requested_at",
      approvedAt: "approved_at",
      approvedBy: "approved_by",
      rejectedAt: "rejected_at",
      rejectionReason: "rejection_reason",
      draftMessage: "draft_message",
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(columns) as Array<[keyof EscalationPatch, string]>) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      params.push(typeof value === "boolean" ? (value ? 1 : 0) : (value ?? null));
    }
    if (!sets.length) return this.get(agencyId, id);
    sets.push("updated_at=?");
    params.push(now, agencyId, id);
    const changed = this.db
      .prepare(`UPDATE wf_escalations SET ${sets.join(", ")} WHERE agency_id=? AND id=?`)
      .run(...params).changes;
    return changed ? this.get(agencyId, id) : null;
  }

  /**
   * What the delivery queue should attempt right now. Deliberately excludes
   * `delivered` and anything with a `delivered_at`, which is what makes a
   * repeated loop pass idempotent.
   */
  listDeliverable(agencyId: string, now: number, limit = 50): Escalation[] {
    requireAgency(agencyId);
    const rows = this.db
      .prepare(
        `SELECT * FROM wf_escalations
         WHERE agency_id=? AND delivered_at IS NULL AND deliver_after<=?
           AND status IN ('pending','scheduled','failed')
         ORDER BY CASE urgency WHEN 'critical' THEN 4 WHEN 'high' THEN 3
           WHEN 'normal' THEN 2 ELSE 1 END DESC, deliver_after ASC LIMIT ?`,
      )
      .all(agencyId, now, Math.max(1, Math.min(200, limit))) as Row[];
    return rows.map((row) => this.hydrate(row));
  }

  /**
   * Drafts waiting on a human, whose approval request has not yet been sent.
   * Keyed on `approval_requested_at IS NULL`, so asking twice is impossible
   * however many times the loop runs.
   */
  listAwaitingApprovalRequest(agencyId: string, now: number, limit = 25): Escalation[] {
    requireAgency(agencyId);
    const rows = this.db
      .prepare(
        `SELECT * FROM wf_escalations
         WHERE agency_id=? AND status='awaiting_approval' AND approval_state='pending'
           AND approval_requested_at IS NULL AND deliver_after<=?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(agencyId, now, Math.max(1, Math.min(200, limit))) as Row[];
    return rows.map((row) => this.hydrate(row));
  }

  /** Batched insights whose digest window has closed. */
  listBatchedDue(agencyId: string, now: number, limit = 200): Escalation[] {
    requireAgency(agencyId);
    const rows = this.db
      .prepare(
        `SELECT * FROM wf_escalations
         WHERE agency_id=? AND status='batched' AND delivered_at IS NULL
           AND digest_due_at IS NOT NULL AND digest_due_at<=?
         ORDER BY worker_id, created_at ASC LIMIT ?`,
      )
      .all(agencyId, now, Math.max(1, Math.min(500, limit))) as Row[];
    return rows.map((row) => this.hydrate(row));
  }

  /** How many messages this worker (or the whole agency) has put on a channel. */
  countDeliveredSince(agencyId: string, since: number, workerId?: string): number {
    requireAgency(agencyId);
    const row = workerId
      ? this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM wf_escalations WHERE agency_id=? AND worker_id=? AND delivered_at>=?",
          )
          .get(agencyId, workerId, since)
      : this.db
          .prepare("SELECT COUNT(*) AS n FROM wf_escalations WHERE agency_id=? AND delivered_at>=?")
          .get(agencyId, since);
    return Number((row as Row | undefined)?.n ?? 0);
  }

  lastDeliveredAt(agencyId: string, workerId: string): number | null {
    requireAgency(agencyId);
    const row = this.db
      .prepare(
        "SELECT MAX(delivered_at) AS at FROM wf_escalations WHERE agency_id=? AND worker_id=?",
      )
      .get(agencyId, workerId) as Row | undefined;
    return row?.at == null ? null : Number(row.at);
  }

  /**
   * The escalation an untagged reply most plausibly answers: the most recent
   * delivered-but-unanswered one on that channel/target. Best effort by
   * construction — see `escalation-inbound.ts` for when this is trusted.
   */
  findLatestAwaitingReply(
    agencyId: string,
    filters: { channelId?: string | null; target?: string | null; workerId?: string | null } = {},
  ): Escalation | null {
    requireAgency(agencyId);
    let sql =
      "SELECT * FROM wf_escalations WHERE agency_id=? AND status='delivered' AND answered_at IS NULL";
    const params: unknown[] = [agencyId];
    if (filters.channelId) {
      sql += " AND channel_id=?";
      params.push(filters.channelId);
    }
    if (filters.target) {
      sql += " AND target=?";
      params.push(filters.target);
    }
    if (filters.workerId) {
      sql += " AND worker_id=?";
      params.push(filters.workerId);
    }
    sql += " ORDER BY delivered_at DESC LIMIT 1";
    const row = this.db.prepare(sql).get(...params) as Row | undefined;
    return row ? this.hydrate(row) : null;
  }

  // ── Delivery attempts ─────────────────────────────────────────────────────

  recordDelivery(
    agencyId: string,
    input: Omit<EscalationDeliveryAttempt, "id" | "agencyId">,
  ): EscalationDeliveryAttempt {
    requireAgency(agencyId);
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO wf_escalation_deliveries
        (id, agency_id, escalation_id, attempt, channel_id, target, ok, message_id, error, at)
        VALUES (@id, @agencyId, @escalationId, @attempt, @channelId, @target, @ok, @messageId, @error, @at)`)
      .run({
        id,
        agencyId,
        escalationId: input.escalationId,
        attempt: input.attempt,
        channelId: input.channelId,
        target: input.target,
        ok: input.ok ? 1 : 0,
        messageId: input.messageId,
        error: input.error,
        at: input.at,
      });
    return { id, agencyId, ...input };
  }

  listDeliveries(agencyId: string, escalationId: string): EscalationDeliveryAttempt[] {
    requireAgency(agencyId);
    const rows = this.db
      .prepare(
        "SELECT * FROM wf_escalation_deliveries WHERE agency_id=? AND escalation_id=? ORDER BY at ASC",
      )
      .all(agencyId, escalationId) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      agencyId,
      escalationId: String(row.escalation_id),
      attempt: Number(row.attempt),
      channelId: row.channel_id ? String(row.channel_id) : null,
      target: row.target ? String(row.target) : null,
      ok: Boolean(row.ok),
      messageId: row.message_id ? String(row.message_id) : null,
      error: row.error ? String(row.error) : null,
      at: Number(row.at),
    }));
  }

  // ── Policy ────────────────────────────────────────────────────────────────

  /**
   * Effective policy: the agency default, with the worker's overrides merged
   * on top. Reading never writes — an agency with no stored row resolves to
   * `defaultEscalationPolicy()`.
   */
  getPolicy(agencyId: string, workerId?: string | null): AgencyEscalationPolicy {
    requireAgency(agencyId);
    const base = normalizeEscalationPolicy(
      this.rawPolicy(agencyId, ""),
      defaultEscalationPolicy(),
      // Preserve the stored `updatedAt` rather than stamping "now" on a read.
      this.policyUpdatedAt(agencyId, "") ?? defaultEscalationPolicy().updatedAt,
    );
    if (!workerId) return base;
    const override = this.rawPolicy(agencyId, workerId);
    if (!override) return base;
    return normalizeEscalationPolicy(
      override,
      base,
      this.policyUpdatedAt(agencyId, workerId) ?? base.updatedAt,
    );
  }

  /** The stored override for one scope, without agency-default merging. */
  getStoredPolicy(agencyId: string, workerId?: string | null): AgencyEscalationPolicy | null {
    const raw = this.rawPolicy(agencyId, workerId ?? "");
    if (!raw) return null;
    return normalizeEscalationPolicy(
      raw,
      defaultEscalationPolicy(),
      this.policyUpdatedAt(agencyId, workerId ?? "") ?? Date.now(),
    );
  }

  /**
   * Merge a patch into the policy for a scope. Returns `changed: false` and
   * writes nothing on a no-op, so opening a settings panel never dirties the
   * replicated database.
   */
  setPolicy(
    agencyId: string,
    workerId: string | null,
    patch: unknown,
    now = Date.now(),
  ): { policy: AgencyEscalationPolicy; changed: boolean } {
    requireAgency(agencyId);
    const scope = workerId ?? "";
    const base = scope
      ? (this.getStoredPolicy(agencyId, scope) ?? this.getPolicy(agencyId))
      : this.getPolicy(agencyId);
    const next = normalizeEscalationPolicy(patch, base, now);
    const same =
      JSON.stringify({ ...base, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 });
    if (same && this.rawPolicy(agencyId, scope)) return { policy: base, changed: false };
    this.db
      .prepare(`INSERT INTO wf_escalation_policies (agency_id, scope_key, policy_json, updated_at)
        VALUES (@agencyId, @scope, @policy, @now)
        ON CONFLICT(agency_id, scope_key) DO UPDATE SET
          policy_json=excluded.policy_json, updated_at=excluded.updated_at`)
      .run({ agencyId, scope, policy: JSON.stringify(next), now });
    return { policy: next, changed: true };
  }

  private rawPolicy(agencyId: string, scope: string): unknown {
    const row = this.db
      .prepare("SELECT policy_json FROM wf_escalation_policies WHERE agency_id=? AND scope_key=?")
      .get(agencyId, scope) as Row | undefined;
    return row ? parse<unknown>(row.policy_json, null) : null;
  }

  private policyUpdatedAt(agencyId: string, scope: string): number | null {
    const row = this.db
      .prepare("SELECT updated_at FROM wf_escalation_policies WHERE agency_id=? AND scope_key=?")
      .get(agencyId, scope) as Row | undefined;
    return row?.updated_at == null ? null : Number(row.updated_at);
  }

  private hydrate(row: Row): Escalation {
    return {
      id: String(row.id),
      agencyId: String(row.agency_id),
      workerId: String(row.worker_id),
      workItemId: row.work_item_id ? String(row.work_item_id) : null,
      kind: row.kind as EscalationKind,
      urgency: row.urgency as EscalationUrgency,
      status: row.status as EscalationStatus,
      title: String(row.title),
      summary: String(row.summary ?? ""),
      question: row.question ? String(row.question) : null,
      options: parse<string[]>(row.options_json, []),
      reference: row.reference ? String(row.reference) : null,
      recipientKind: (row.recipient_kind
        ? String(row.recipient_kind)
        : "operator") as EscalationRecipientKind,
      recipientLabel: row.recipient_label ? String(row.recipient_label) : null,
      channelId: (row.channel_id ? String(row.channel_id) : null) as ChatChannelId | null,
      target: row.target ? String(row.target) : null,
      bindingId: row.binding_id ? String(row.binding_id) : null,
      requiresApproval: Boolean(row.requires_approval),
      approvalState: (row.approval_state
        ? String(row.approval_state)
        : "not_required") as ApprovalState,
      approvalChannelId: (row.approval_channel_id
        ? String(row.approval_channel_id)
        : null) as ChatChannelId | null,
      approvalTarget: row.approval_target ? String(row.approval_target) : null,
      approvalRequestedAt:
        row.approval_requested_at == null ? null : Number(row.approval_requested_at),
      approvedAt: row.approved_at == null ? null : Number(row.approved_at),
      approvedBy: row.approved_by ? String(row.approved_by) : null,
      rejectedAt: row.rejected_at == null ? null : Number(row.rejected_at),
      rejectionReason: row.rejection_reason ? String(row.rejection_reason) : null,
      draftMessage: row.draft_message ? String(row.draft_message) : null,
      correlationCode: String(row.correlation_code),
      dedupeKey: String(row.dedupe_key),
      occurrences: Number(row.occurrences ?? 1),
      digestId: row.digest_id ? String(row.digest_id) : null,
      digestDueAt: row.digest_due_at == null ? null : Number(row.digest_due_at),
      deliverAfter: Number(row.deliver_after),
      attempts: Number(row.attempts ?? 0),
      lastAttemptAt: row.last_attempt_at == null ? null : Number(row.last_attempt_at),
      lastError: row.last_error ? String(row.last_error) : null,
      deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at),
      composedMessage: row.composed_message ? String(row.composed_message) : null,
      reason: String(row.reason ?? ""),
      answer: row.answer ? String(row.answer) : null,
      answeredAt: row.answered_at == null ? null : Number(row.answered_at),
      answeredBy: row.answered_by ? String(row.answered_by) : null,
      resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
      resolutionNote: row.resolution_note ? String(row.resolution_note) : null,
      context: parse<Record<string, unknown>>(row.context_json, {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
