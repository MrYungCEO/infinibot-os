import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import {
  assertWorkItemTransition,
  nextResponsibilityRun,
  responsibilityOccurrenceKey,
  reviewCycleState,
  workItemNeedsEscalation,
} from "./lifecycle.js";
import type {
  EmployeeSchedule,
  EmployeeWorkItem,
  JobMemoryRecord,
  ManagerReviewCycle,
  OperatingLoopTickResult,
  RecurringResponsibility,
  WorkItemPriority,
  WorkItemStatus,
} from "./types.js";

type Row = Record<string, unknown>;
const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};
const agency = (value: string) => {
  if (!value?.trim()) throw new Error("agencyId required");
};

export class WorkforceOperatingStore {
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
      CREATE TABLE IF NOT EXISTS wf_employee_schedules (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, timezone TEXT NOT NULL,
        weekdays_json TEXT NOT NULL, shift_start TEXT NOT NULL, shift_end TEXT NOT NULL,
        effective_from TEXT NOT NULL, effective_to TEXT, enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(agency_id,id),
        FOREIGN KEY(agency_id,worker_id) REFERENCES wf_workers(agency_id,id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS wf_recurring_responsibilities (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, manager_worker_id TEXT,
        title TEXT NOT NULL, instructions TEXT NOT NULL, cadence TEXT NOT NULL, interval_value INTEGER NOT NULL,
        weekday INTEGER, month_day INTEGER, run_at TEXT NOT NULL, sla_minutes INTEGER NOT NULL,
        priority TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at INTEGER NOT NULL, last_run_at INTEGER,
        context_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(agency_id,id),
        FOREIGN KEY(agency_id,worker_id) REFERENCES wf_workers(agency_id,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_wf_responsibility_due
        ON wf_recurring_responsibilities(agency_id,enabled,next_run_at);
      CREATE TABLE IF NOT EXISTS wf_employee_work_items (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, manager_worker_id TEXT,
        responsibility_id TEXT, title TEXT NOT NULL, instructions TEXT NOT NULL, status TEXT NOT NULL,
        priority TEXT NOT NULL, scheduled_for INTEGER NOT NULL, due_at INTEGER, accepted_at INTEGER,
        started_at INTEGER, completed_at INTEGER, escalation_level INTEGER NOT NULL, escalated_at INTEGER,
        waiting_reason TEXT, review_note TEXT, idempotency_key TEXT, context_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(agency_id,id),
        UNIQUE(agency_id,idempotency_key),
        FOREIGN KEY(agency_id,worker_id) REFERENCES wf_workers(agency_id,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_wf_inbox
        ON wf_employee_work_items(agency_id,worker_id,status,scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_wf_sla
        ON wf_employee_work_items(agency_id,status,due_at);
      CREATE TABLE IF NOT EXISTS wf_manager_review_cycles (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, manager_worker_id TEXT NOT NULL,
        cadence_days INTEGER NOT NULL, next_review_at INTEGER NOT NULL, last_review_at INTEGER,
        status TEXT NOT NULL, agenda_json TEXT NOT NULL, outcome TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(agency_id,id),
        FOREIGN KEY(agency_id,worker_id) REFERENCES wf_workers(agency_id,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_wf_review_due
        ON wf_manager_review_cycles(agency_id,status,next_review_at);
      CREATE TABLE IF NOT EXISTS wf_job_memory (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, work_item_id TEXT,
        namespace TEXT NOT NULL, key_name TEXT NOT NULL, value_json TEXT NOT NULL, source TEXT NOT NULL,
        expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(agency_id,id), UNIQUE(agency_id,worker_id,namespace,key_name),
        FOREIGN KEY(agency_id,worker_id) REFERENCES wf_workers(agency_id,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_wf_memory_context
        ON wf_job_memory(agency_id,worker_id,namespace,expires_at);
    `);
  }

  createSchedule(
    agencyId: string,
    input: Omit<EmployeeSchedule, "id" | "agencyId" | "createdAt" | "updatedAt"> & { id?: string },
  ): EmployeeSchedule {
    agency(agencyId);
    if (!input.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))
      throw new Error("weekdays must be between 0 and 6");
    if (!/^\d{2}:\d{2}$/.test(input.shiftStart) || !/^\d{2}:\d{2}$/.test(input.shiftEnd))
      throw new Error("shift times must be HH:MM");
    const now = Date.now();
    const value: EmployeeSchedule = {
      ...input,
      id: input.id ?? randomUUID(),
      agencyId,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO wf_employee_schedules
      (id,agency_id,worker_id,timezone,weekdays_json,shift_start,shift_end,effective_from,effective_to,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        value.id,
        agencyId,
        value.workerId,
        value.timezone,
        JSON.stringify(value.weekdays),
        value.shiftStart,
        value.shiftEnd,
        value.effectiveFrom,
        value.effectiveTo,
        value.enabled ? 1 : 0,
        now,
        now,
      );
    return value;
  }

  listSchedules(agencyId: string, workerId?: string): EmployeeSchedule[] {
    agency(agencyId);
    const rows = workerId
      ? this.db
          .prepare("SELECT * FROM wf_employee_schedules WHERE agency_id=? AND worker_id=?")
          .all(agencyId, workerId)
      : this.db.prepare("SELECT * FROM wf_employee_schedules WHERE agency_id=?").all(agencyId);
    return (rows as Row[]).map((row) => ({
      id: String(row.id),
      agencyId,
      workerId: String(row.worker_id),
      timezone: String(row.timezone),
      weekdays: parse(row.weekdays_json, []),
      shiftStart: String(row.shift_start),
      shiftEnd: String(row.shift_end),
      effectiveFrom: String(row.effective_from),
      effectiveTo: row.effective_to ? String(row.effective_to) : null,
      enabled: Boolean(row.enabled),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  createResponsibility(
    agencyId: string,
    input: Omit<
      RecurringResponsibility,
      "id" | "agencyId" | "lastRunAt" | "createdAt" | "updatedAt"
    > & { id?: string },
  ): RecurringResponsibility {
    agency(agencyId);
    if (input.interval < 1) throw new Error("interval must be positive");
    if (input.slaMinutes < 1) throw new Error("slaMinutes must be positive");
    const now = Date.now();
    // Callers that omit nextRunAt (the RPC defaults the param to 0) would
    // otherwise be scheduled at the Unix epoch, which renders as "next 20657d
    // ago" and makes the loop crawl forward one interval per tick without ever
    // reaching the present. Anchor only an ABSENT schedule to the next
    // occurrence — an explicitly supplied past timestamp is a legitimate way to
    // say "this is already due", and tick() catches stale rows up anyway.
    const nextRunAt = input.nextRunAt > 0 ? input.nextRunAt : nextResponsibilityRun(input, now);
    const value: RecurringResponsibility = {
      ...input,
      nextRunAt,
      id: input.id ?? randomUUID(),
      agencyId,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO wf_recurring_responsibilities
      (id,agency_id,worker_id,manager_worker_id,title,instructions,cadence,interval_value,weekday,
       month_day,run_at,sla_minutes,priority,enabled,next_run_at,last_run_at,context_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        value.id,
        agencyId,
        value.workerId,
        value.managerWorkerId,
        value.title,
        value.instructions,
        value.cadence,
        value.interval,
        value.weekday,
        value.monthDay,
        value.runAt,
        value.slaMinutes,
        value.priority,
        value.enabled ? 1 : 0,
        value.nextRunAt,
        null,
        JSON.stringify(value.context),
        now,
        now,
      );
    return value;
  }

  listResponsibilities(agencyId: string, workerId?: string): RecurringResponsibility[] {
    agency(agencyId);
    const rows = workerId
      ? this.db
          .prepare(
            "SELECT * FROM wf_recurring_responsibilities WHERE agency_id=? AND worker_id=? ORDER BY next_run_at",
          )
          .all(agencyId, workerId)
      : this.db
          .prepare(
            "SELECT * FROM wf_recurring_responsibilities WHERE agency_id=? ORDER BY next_run_at",
          )
          .all(agencyId);
    return (rows as Row[]).map((row) => this.responsibility(row));
  }

  getResponsibility(agencyId: string, id: string): RecurringResponsibility | null {
    agency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_recurring_responsibilities WHERE agency_id=? AND id=?")
      .get(agencyId, id) as Row | undefined;
    return row ? this.responsibility(row) : null;
  }

  /**
   * Patch a recurring responsibility. Returns the row unchanged (and writes
   * nothing) when the patch is a no-op — this table is refreshed on every SOP
   * schedule reconciliation, so a genuine no-op matters.
   */
  updateResponsibility(
    agencyId: string,
    id: string,
    patch: Partial<
      Pick<
        RecurringResponsibility,
        | "managerWorkerId"
        | "title"
        | "instructions"
        | "cadence"
        | "interval"
        | "weekday"
        | "monthDay"
        | "runAt"
        | "slaMinutes"
        | "priority"
        | "enabled"
        | "nextRunAt"
        | "context"
      >
    >,
  ): RecurringResponsibility | null {
    const before = this.getResponsibility(agencyId, id);
    if (!before) return null;
    const next: RecurringResponsibility = { ...before, ...patch };
    if (next.interval < 1) throw new Error("interval must be positive");
    if (next.slaMinutes < 1) throw new Error("slaMinutes must be positive");
    const same =
      JSON.stringify({ ...before, updatedAt: 0, lastRunAt: 0 }) ===
      JSON.stringify({ ...next, updatedAt: 0, lastRunAt: 0 });
    if (same) return before;
    const now = Date.now();
    this.db
      .prepare(`UPDATE wf_recurring_responsibilities SET manager_worker_id=?,title=?,instructions=?,
        cadence=?,interval_value=?,weekday=?,month_day=?,run_at=?,sla_minutes=?,priority=?,enabled=?,
        next_run_at=?,context_json=?,updated_at=? WHERE agency_id=? AND id=?`)
      .run(
        next.managerWorkerId,
        next.title,
        next.instructions,
        next.cadence,
        next.interval,
        next.weekday,
        next.monthDay,
        next.runAt,
        next.slaMinutes,
        next.priority,
        next.enabled ? 1 : 0,
        next.nextRunAt,
        JSON.stringify(next.context),
        now,
        agencyId,
        id,
      );
    return { ...next, updatedAt: now };
  }

  deleteResponsibility(agencyId: string, id: string): boolean {
    agency(agencyId);
    return (
      this.db
        .prepare("DELETE FROM wf_recurring_responsibilities WHERE agency_id=? AND id=?")
        .run(agencyId, id).changes > 0
    );
  }

  enqueueWorkItem(
    agencyId: string,
    input: {
      id?: string;
      workerId: string;
      managerWorkerId?: string | null;
      responsibilityId?: string | null;
      title: string;
      instructions?: string;
      priority?: WorkItemPriority;
      scheduledFor?: number;
      dueAt?: number | null;
      idempotencyKey?: string | null;
      context?: Record<string, unknown>;
    },
  ): EmployeeWorkItem {
    agency(agencyId);
    if (!input.title.trim()) throw new Error("title required");
    if (input.idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM wf_employee_work_items WHERE agency_id=? AND idempotency_key=?")
        .get(agencyId, input.idempotencyKey) as Row | undefined;
      if (existing) return this.workItem(existing);
    }
    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.db
      .prepare(`INSERT INTO wf_employee_work_items
      (id,agency_id,worker_id,manager_worker_id,responsibility_id,title,instructions,status,priority,
       scheduled_for,due_at,accepted_at,started_at,completed_at,escalation_level,escalated_at,
       waiting_reason,review_note,idempotency_key,context_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        agencyId,
        input.workerId,
        input.managerWorkerId ?? null,
        input.responsibilityId ?? null,
        input.title.trim(),
        input.instructions ?? "",
        "queued",
        input.priority ?? "normal",
        input.scheduledFor ?? now,
        input.dueAt ?? null,
        null,
        null,
        null,
        0,
        null,
        null,
        null,
        input.idempotencyKey ?? null,
        JSON.stringify(input.context ?? {}),
        now,
        now,
      );
    return this.getWorkItem(agencyId, id)!;
  }

  getWorkItem(agencyId: string, id: string): EmployeeWorkItem | null {
    agency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_employee_work_items WHERE agency_id=? AND id=?")
      .get(agencyId, id) as Row | undefined;
    return row ? this.workItem(row) : null;
  }

  listWorkItems(
    agencyId: string,
    filters: { workerId?: string; status?: WorkItemStatus; limit?: number } = {},
  ): EmployeeWorkItem[] {
    agency(agencyId);
    let sql = "SELECT * FROM wf_employee_work_items WHERE agency_id=?";
    const params: unknown[] = [agencyId];
    if (filters.workerId) {
      sql += " AND worker_id=?";
      params.push(filters.workerId);
    }
    if (filters.status) {
      sql += " AND status=?";
      params.push(filters.status);
    }
    sql += ` ORDER BY CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3
      WHEN 'normal' THEN 2 ELSE 1 END DESC, scheduled_for LIMIT ?`;
    params.push(Math.max(1, Math.min(500, filters.limit ?? 100)));
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.workItem(row));
  }

  transitionWorkItem(
    agencyId: string,
    id: string,
    status: WorkItemStatus,
    options: { waitingReason?: string | null; reviewNote?: string | null; now?: number } = {},
  ): EmployeeWorkItem {
    const current = this.getWorkItem(agencyId, id);
    if (!current) throw new Error("work item not found");
    assertWorkItemTransition(current.status, status);
    const now = options.now ?? Date.now();
    this.db
      .prepare(`UPDATE wf_employee_work_items SET status=?, accepted_at=COALESCE(accepted_at,?),
      started_at=CASE WHEN ?='in_progress' THEN COALESCE(started_at,?) ELSE started_at END,
      completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,
      escalated_at=CASE WHEN ?='escalated' THEN ? ELSE escalated_at END,
      escalation_level=CASE WHEN ?='escalated' THEN escalation_level+1 ELSE escalation_level END,
      waiting_reason=?,review_note=?,updated_at=? WHERE agency_id=? AND id=?`)
      .run(
        status,
        status === "accepted" ? now : null,
        status,
        now,
        status,
        now,
        status,
        now,
        status,
        options.waitingReason ?? current.waitingReason,
        options.reviewNote ?? current.reviewNote,
        now,
        agencyId,
        id,
      );
    return this.getWorkItem(agencyId, id)!;
  }

  createReviewCycle(
    agencyId: string,
    input: {
      id?: string;
      workerId: string;
      managerWorkerId: string;
      cadenceDays: number;
      nextReviewAt: number;
      agenda?: string[];
    },
  ): ManagerReviewCycle {
    agency(agencyId);
    if (input.cadenceDays < 1) throw new Error("cadenceDays must be positive");
    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.db
      .prepare(`INSERT INTO wf_manager_review_cycles
      (id,agency_id,worker_id,manager_worker_id,cadence_days,next_review_at,last_review_at,status,
       agenda_json,outcome,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        agencyId,
        input.workerId,
        input.managerWorkerId,
        input.cadenceDays,
        input.nextReviewAt,
        null,
        "scheduled",
        JSON.stringify(input.agenda ?? []),
        null,
        now,
        now,
      );
    return this.listReviewCycles(agencyId).find((item) => item.id === id)!;
  }

  listReviewCycles(agencyId: string, workerId?: string): ManagerReviewCycle[] {
    agency(agencyId);
    const rows = workerId
      ? this.db
          .prepare(
            "SELECT * FROM wf_manager_review_cycles WHERE agency_id=? AND worker_id=? ORDER BY next_review_at",
          )
          .all(agencyId, workerId)
      : this.db
          .prepare(
            "SELECT * FROM wf_manager_review_cycles WHERE agency_id=? ORDER BY next_review_at",
          )
          .all(agencyId);
    return (rows as Row[]).map((row) => ({
      id: String(row.id),
      agencyId,
      workerId: String(row.worker_id),
      managerWorkerId: String(row.manager_worker_id),
      cadenceDays: Number(row.cadence_days),
      nextReviewAt: Number(row.next_review_at),
      lastReviewAt: row.last_review_at == null ? null : Number(row.last_review_at),
      status: row.status as ManagerReviewCycle["status"],
      agenda: parse(row.agenda_json, []),
      outcome: row.outcome ? String(row.outcome) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  completeReviewCycle(
    agencyId: string,
    id: string,
    outcome: string,
    now = Date.now(),
  ): ManagerReviewCycle {
    const cycle = this.listReviewCycles(agencyId).find((item) => item.id === id);
    if (!cycle) throw new Error("review cycle not found");
    this.db
      .prepare(`UPDATE wf_manager_review_cycles SET status='scheduled',last_review_at=?,
      next_review_at=?,outcome=?,updated_at=? WHERE agency_id=? AND id=?`)
      .run(now, now + cycle.cadenceDays * 86_400_000, outcome, now, agencyId, id);
    return this.listReviewCycles(agencyId).find((item) => item.id === id)!;
  }

  upsertJobMemory(
    agencyId: string,
    input: {
      workerId: string;
      workItemId?: string | null;
      namespace: string;
      key: string;
      value: unknown;
      source?: string;
      expiresAt?: number | null;
    },
  ): JobMemoryRecord {
    agency(agencyId);
    const now = Date.now();
    const existing = this.db
      .prepare(`SELECT id,created_at FROM wf_job_memory
      WHERE agency_id=? AND worker_id=? AND namespace=? AND key_name=?`)
      .get(agencyId, input.workerId, input.namespace, input.key) as Row | undefined;
    const id = existing ? String(existing.id) : randomUUID();
    this.db
      .prepare(`INSERT INTO wf_job_memory
      (id,agency_id,worker_id,work_item_id,namespace,key_name,value_json,source,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agency_id,worker_id,namespace,key_name) DO UPDATE SET
      work_item_id=excluded.work_item_id,value_json=excluded.value_json,source=excluded.source,
      expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
      .run(
        id,
        agencyId,
        input.workerId,
        input.workItemId ?? null,
        input.namespace,
        input.key,
        JSON.stringify(input.value),
        input.source ?? "employee",
        input.expiresAt ?? null,
        existing ? Number(existing.created_at) : now,
        now,
      );
    return this.listJobMemory(agencyId, input.workerId, input.namespace).find(
      (item) => item.id === id,
    )!;
  }

  listJobMemory(
    agencyId: string,
    workerId: string,
    namespace?: string,
    now = Date.now(),
  ): JobMemoryRecord[] {
    agency(agencyId);
    let sql = `SELECT * FROM wf_job_memory WHERE agency_id=? AND worker_id=?
      AND (expires_at IS NULL OR expires_at>?)`;
    const params: unknown[] = [agencyId, workerId, now];
    if (namespace) {
      sql += " AND namespace=?";
      params.push(namespace);
    }
    sql += " ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => ({
      id: String(row.id),
      agencyId,
      workerId: String(row.worker_id),
      workItemId: row.work_item_id ? String(row.work_item_id) : null,
      namespace: String(row.namespace),
      key: String(row.key_name),
      value: parse(row.value_json, null),
      source: String(row.source),
      expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  tick(agencyId: string, now = Date.now()): OperatingLoopTickResult {
    agency(agencyId);
    return this.db.transaction(() => {
      const result: OperatingLoopTickResult = {
        generatedWorkItemIds: [],
        escalatedWorkItemIds: [],
        dueReviewCycleIds: [],
      };
      for (const responsibility of this.listResponsibilities(agencyId).filter(
        (item) => item.enabled && item.nextRunAt <= now,
      )) {
        const item = this.enqueueWorkItem(agencyId, {
          workerId: responsibility.workerId,
          managerWorkerId: responsibility.managerWorkerId,
          responsibilityId: responsibility.id,
          title: responsibility.title,
          instructions: responsibility.instructions,
          priority: responsibility.priority,
          scheduledFor: responsibility.nextRunAt,
          dueAt: responsibility.nextRunAt + responsibility.slaMinutes * 60_000,
          idempotencyKey: responsibilityOccurrenceKey(responsibility),
          context: responsibility.context,
        });
        result.generatedWorkItemIds.push(item.id);
        // Advance from whichever is later: the schedule we just fired, or now.
        // Advancing purely from the stored value means a responsibility that
        // fell behind (a stopped gateway, or a row created at the epoch) gains
        // exactly one interval per tick and can stay years in the past — it
        // would take ~20,000 ticks to catch up. Catching up to the present
        // also stops a backlog of duplicate work items being generated one per
        // pass forever.
        const next = nextResponsibilityRun(responsibility, Math.max(responsibility.nextRunAt, now));
        this.db
          .prepare(`UPDATE wf_recurring_responsibilities SET last_run_at=?,next_run_at=?,
          updated_at=? WHERE agency_id=? AND id=?`)
          .run(responsibility.nextRunAt, next, now, agencyId, responsibility.id);
      }
      for (const item of this.listWorkItems(agencyId, { limit: 500 })) {
        if (workItemNeedsEscalation(item, now)) {
          this.transitionWorkItem(agencyId, item.id, "escalated", { now });
          result.escalatedWorkItemIds.push(item.id);
        }
      }
      for (const cycle of this.listReviewCycles(agencyId)) {
        const state = reviewCycleState(cycle, now);
        if (state !== "scheduled") {
          this.db
            .prepare(
              "UPDATE wf_manager_review_cycles SET status=?,updated_at=? WHERE agency_id=? AND id=?",
            )
            .run(state, now, agencyId, cycle.id);
          result.dueReviewCycleIds.push(cycle.id);
        }
      }
      return result;
    })();
  }

  private workItem(row: Row): EmployeeWorkItem {
    return {
      id: String(row.id),
      agencyId: String(row.agency_id),
      workerId: String(row.worker_id),
      managerWorkerId: row.manager_worker_id ? String(row.manager_worker_id) : null,
      responsibilityId: row.responsibility_id ? String(row.responsibility_id) : null,
      title: String(row.title),
      instructions: String(row.instructions),
      status: row.status as WorkItemStatus,
      priority: row.priority as WorkItemPriority,
      scheduledFor: Number(row.scheduled_for),
      dueAt: row.due_at == null ? null : Number(row.due_at),
      acceptedAt: row.accepted_at == null ? null : Number(row.accepted_at),
      startedAt: row.started_at == null ? null : Number(row.started_at),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
      escalationLevel: Number(row.escalation_level),
      escalatedAt: row.escalated_at == null ? null : Number(row.escalated_at),
      waitingReason: row.waiting_reason ? String(row.waiting_reason) : null,
      reviewNote: row.review_note ? String(row.review_note) : null,
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
      context: parse(row.context_json, {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private responsibility(row: Row): RecurringResponsibility {
    return {
      id: String(row.id),
      agencyId: String(row.agency_id),
      workerId: String(row.worker_id),
      managerWorkerId: row.manager_worker_id ? String(row.manager_worker_id) : null,
      title: String(row.title),
      instructions: String(row.instructions),
      cadence: row.cadence as RecurringResponsibility["cadence"],
      interval: Number(row.interval_value),
      weekday: row.weekday == null ? null : Number(row.weekday),
      monthDay: row.month_day == null ? null : Number(row.month_day),
      runAt: String(row.run_at),
      slaMinutes: Number(row.sla_minutes),
      priority: row.priority as WorkItemPriority,
      enabled: Boolean(row.enabled),
      nextRunAt: Number(row.next_run_at),
      lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
      context: parse(row.context_json, {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
