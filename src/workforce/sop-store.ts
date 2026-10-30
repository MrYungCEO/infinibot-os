/**
 * Storage for first-class SOPs, their schedules and their runs.
 *
 * Follows `WorkforceOperatingStore`'s conventions exactly: same agency.db file,
 * plain `CREATE TABLE IF NOT EXISTS` (this family of tables predates the
 * numbered `schema_migrations` used by `AgencyOperationsStore`, so nothing here
 * moves `AGENCY_DATABASE_SCHEMA_VERSION`), `(agency_id, id)` primary keys, JSON
 * columns for list-shaped fields.
 *
 * Every table carries `agency_id`, so the federation replication snapshot picks
 * them up automatically without any change to the exporter.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { nextResponsibilityRun } from "./lifecycle.js";
import {
  SOP_CADENCES,
  SOP_RUN_STATUSES,
  SOP_STATUSES,
  SOP_TRIGGERS,
  type Sop,
  type SopCadence,
  type SopInput,
  type SopIo,
  type SopPatch,
  type SopRun,
  type SopRunStatus,
  type SopSchedule,
  type SopScheduleInput,
  type SopStatus,
  type SopStep,
  type SopTrigger,
} from "./sop-types.js";
import type { WorkItemPriority } from "./types.js";

type Row = Record<string, unknown>;

const PRIORITIES: WorkItemPriority[] = ["low", "normal", "high", "urgent"];

const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};

function requireAgency(agencyId: string): void {
  if (!agencyId?.trim()) throw new Error("agencyId required");
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,80}$/;

export function normalizeSopSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!SLUG.test(slug)) throw new Error("slug must be 2-81 lowercase alphanumeric/dash characters");
  return slug;
}

function normalizeSteps(raw: SopInput["steps"]): SopStep[] {
  const steps = (raw ?? []).map((step, index) => {
    const title = String(step.title ?? "").trim();
    const instruction = String(step.instruction ?? "").trim();
    if (!title) throw new Error(`step ${index + 1}: title required`);
    if (!instruction) throw new Error(`step ${index + 1}: instruction required`);
    return {
      order: index + 1,
      title: title.slice(0, 200),
      instruction: instruction.slice(0, 4_000),
      expectedOutput:
        typeof step.expectedOutput === "string" && step.expectedOutput.trim()
          ? step.expectedOutput.trim().slice(0, 1_000)
          : null,
      required: step.required !== false,
      toolHint:
        typeof step.toolHint === "string" && step.toolHint.trim()
          ? step.toolHint.trim().slice(0, 200)
          : null,
    } satisfies SopStep;
  });
  if (steps.length > 100) throw new Error("an SOP may not exceed 100 steps");
  return steps;
}

function normalizeIo(raw: SopInput["inputs"]): SopIo[] {
  return (raw ?? [])
    .map((entry) => ({
      name: String(entry.name ?? "")
        .trim()
        .slice(0, 120),
      description: String(entry.description ?? "")
        .trim()
        .slice(0, 1_000),
      required: entry.required !== false,
    }))
    .filter((entry) => entry.name.length > 0);
}

const strings = (raw: unknown, max: number): string[] =>
  (Array.isArray(raw) ? raw : [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, max);

function priority(raw: unknown, fallback: WorkItemPriority): WorkItemPriority {
  return typeof raw === "string" && PRIORITIES.includes(raw as WorkItemPriority)
    ? (raw as WorkItemPriority)
    : fallback;
}

/**
 * Structural fingerprint of the procedure body. `version` bumps only when this
 * changes, so renaming an SOP or re-running the seeder is a genuine no-op —
 * which matters: this database was once grown to 633 MB by writes that were
 * supposed to be idempotent and were not.
 */
function bodyFingerprint(sop: {
  steps: SopStep[];
  inputs: SopIo[];
  outputs: SopIo[];
  acceptanceCriteria: string[];
}): string {
  return JSON.stringify([sop.steps, sop.inputs, sop.outputs, sop.acceptanceCriteria]);
}

export class WorkforceSopStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.createTables();
  }

  close(): void {
    this.db.close();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wf_sops (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '', owner_worker_id TEXT, owner_role_id TEXT,
        category TEXT NOT NULL DEFAULT 'general', status TEXT NOT NULL DEFAULT 'active',
        version INTEGER NOT NULL DEFAULT 1, steps_json TEXT NOT NULL, inputs_json TEXT NOT NULL,
        outputs_json TEXT NOT NULL, acceptance_json TEXT NOT NULL, tags_json TEXT NOT NULL,
        default_priority TEXT NOT NULL DEFAULT 'normal', estimated_minutes INTEGER NOT NULL DEFAULT 30,
        source TEXT NOT NULL DEFAULT 'operator', seed_key TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(agency_id, id), UNIQUE(agency_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_wf_sops_owner ON wf_sops(agency_id, owner_worker_id);
      CREATE TABLE IF NOT EXISTS wf_sop_schedules (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, sop_id TEXT NOT NULL, worker_id TEXT NOT NULL,
        manager_worker_id TEXT, cadence TEXT NOT NULL, interval_value INTEGER NOT NULL DEFAULT 1,
        weekday INTEGER, month_day INTEGER, run_at TEXT NOT NULL DEFAULT '09:00',
        timezone TEXT NOT NULL DEFAULT 'UTC', sla_minutes INTEGER NOT NULL DEFAULT 1440,
        priority TEXT NOT NULL DEFAULT 'normal', enabled INTEGER NOT NULL DEFAULT 1,
        cron_job_name TEXT NOT NULL, cron_job_id TEXT, responsibility_id TEXT,
        next_run_at INTEGER NOT NULL, last_run_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(agency_id, id), UNIQUE(agency_id, sop_id, worker_id),
        FOREIGN KEY(agency_id, sop_id) REFERENCES wf_sops(agency_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_wf_sop_schedules_worker
        ON wf_sop_schedules(agency_id, worker_id, enabled);
      CREATE TABLE IF NOT EXISTS wf_sop_runs (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, sop_id TEXT NOT NULL, schedule_id TEXT,
        worker_id TEXT NOT NULL, work_item_id TEXT, trigger TEXT NOT NULL,
        sop_version INTEGER NOT NULL, status TEXT NOT NULL, note TEXT,
        scheduled_for INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(agency_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_wf_sop_runs_sop
        ON wf_sop_runs(agency_id, sop_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_wf_sop_runs_schedule
        ON wf_sop_runs(agency_id, schedule_id, created_at);
    `);
    // Additive columns are reconciled with an idempotent PRAGMA check, exactly
    // like WorkforceStore.ensureColumn — this family of tables predates (and
    // stays outside) AgencyOperationsStore's numbered schema_migrations, so
    // nothing here moves AGENCY_DATABASE_SCHEMA_VERSION.
    this.ensureColumn("wf_sops", "seed_version", "INTEGER NOT NULL DEFAULT 0");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((row) => String(row.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  // ── SOPs ──────────────────────────────────────────────────────────────────

  createSop(agencyId: string, input: SopInput): Sop {
    requireAgency(agencyId);
    const name = input.name?.trim();
    if (!name) throw new Error("SOP name required");
    const slug = normalizeSopSlug(input.slug || name);
    if (this.getSopBySlug(agencyId, slug)) throw new Error(`SOP slug already exists: ${slug}`);
    const now = Date.now();
    const sop: Sop = {
      id: input.id ?? randomUUID(),
      agencyId,
      slug,
      name: name.slice(0, 200),
      summary: (input.summary ?? "").trim().slice(0, 2_000),
      ownerWorkerId: input.ownerWorkerId ?? null,
      ownerRoleId: input.ownerRoleId ?? null,
      category: (input.category ?? "general").trim().slice(0, 80) || "general",
      status: (SOP_STATUSES as readonly string[]).includes(input.status ?? "")
        ? (input.status as SopStatus)
        : "active",
      version: 1,
      steps: normalizeSteps(input.steps),
      inputs: normalizeIo(input.inputs),
      outputs: normalizeIo(input.outputs),
      acceptanceCriteria: strings(input.acceptanceCriteria, 50),
      tags: strings(input.tags, 30),
      defaultPriority: priority(input.defaultPriority, "normal"),
      estimatedMinutes: Math.min(10_080, Math.max(1, Math.round(input.estimatedMinutes ?? 30))),
      source: input.source === "seed" ? "seed" : "operator",
      seedKey: input.seedKey ?? null,
      seedVersion: Math.max(0, Math.round(input.seedVersion ?? 0)),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO wf_sops
        (id,agency_id,slug,name,summary,owner_worker_id,owner_role_id,category,status,version,
         steps_json,inputs_json,outputs_json,acceptance_json,tags_json,default_priority,
         estimated_minutes,source,seed_key,seed_version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        sop.id,
        agencyId,
        sop.slug,
        sop.name,
        sop.summary,
        sop.ownerWorkerId,
        sop.ownerRoleId,
        sop.category,
        sop.status,
        sop.version,
        JSON.stringify(sop.steps),
        JSON.stringify(sop.inputs),
        JSON.stringify(sop.outputs),
        JSON.stringify(sop.acceptanceCriteria),
        JSON.stringify(sop.tags),
        sop.defaultPriority,
        sop.estimatedMinutes,
        sop.source,
        sop.seedKey,
        sop.seedVersion,
        now,
        now,
      );
    return sop;
  }

  getSop(agencyId: string, sopId: string): Sop | null {
    requireAgency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_sops WHERE agency_id=? AND id=?")
      .get(agencyId, sopId) as Row | undefined;
    return row ? this.sopFromRow(row) : null;
  }

  getSopBySlug(agencyId: string, slug: string): Sop | null {
    requireAgency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_sops WHERE agency_id=? AND slug=?")
      .get(agencyId, slug) as Row | undefined;
    return row ? this.sopFromRow(row) : null;
  }

  listSops(
    agencyId: string,
    filters: { ownerWorkerId?: string; status?: SopStatus; category?: string } = {},
  ): Sop[] {
    requireAgency(agencyId);
    let sql = "SELECT * FROM wf_sops WHERE agency_id=?";
    const params: unknown[] = [agencyId];
    if (filters.ownerWorkerId) {
      sql += " AND owner_worker_id=?";
      params.push(filters.ownerWorkerId);
    }
    if (filters.status) {
      sql += " AND status=?";
      params.push(filters.status);
    }
    if (filters.category) {
      sql += " AND category=?";
      params.push(filters.category);
    }
    sql += " ORDER BY category, name";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.sopFromRow(row));
  }

  /**
   * Patch an SOP. `version` bumps only when the procedure body actually
   * changed, so a no-op update writes the same version back and a UI that
   * re-saves an untouched form does not inflate history.
   */
  updateSop(agencyId: string, sopId: string, patch: SopPatch): Sop | null {
    const before = this.getSop(agencyId, sopId);
    if (!before) return null;
    const next: Sop = {
      ...before,
      name: patch.name?.trim() ? patch.name.trim().slice(0, 200) : before.name,
      slug: patch.slug ? normalizeSopSlug(patch.slug) : before.slug,
      summary: patch.summary !== undefined ? patch.summary.trim().slice(0, 2_000) : before.summary,
      ownerWorkerId: patch.ownerWorkerId !== undefined ? patch.ownerWorkerId : before.ownerWorkerId,
      ownerRoleId: patch.ownerRoleId !== undefined ? patch.ownerRoleId : before.ownerRoleId,
      category: patch.category?.trim() ? patch.category.trim().slice(0, 80) : before.category,
      status:
        patch.status && (SOP_STATUSES as readonly string[]).includes(patch.status)
          ? patch.status
          : before.status,
      steps: patch.steps !== undefined ? normalizeSteps(patch.steps) : before.steps,
      inputs: patch.inputs !== undefined ? normalizeIo(patch.inputs) : before.inputs,
      outputs: patch.outputs !== undefined ? normalizeIo(patch.outputs) : before.outputs,
      acceptanceCriteria:
        patch.acceptanceCriteria !== undefined
          ? strings(patch.acceptanceCriteria, 50)
          : before.acceptanceCriteria,
      tags: patch.tags !== undefined ? strings(patch.tags, 30) : before.tags,
      defaultPriority: priority(patch.defaultPriority, before.defaultPriority),
      estimatedMinutes:
        patch.estimatedMinutes !== undefined
          ? Math.min(10_080, Math.max(1, Math.round(patch.estimatedMinutes)))
          : before.estimatedMinutes,
      seedKey: patch.seedKey !== undefined ? patch.seedKey : before.seedKey,
      seedVersion:
        patch.seedVersion !== undefined
          ? Math.max(0, Math.round(patch.seedVersion))
          : before.seedVersion,
    };
    if (next.slug !== before.slug) {
      const clash = this.getSopBySlug(agencyId, next.slug);
      if (clash && clash.id !== sopId) throw new Error(`SOP slug already exists: ${next.slug}`);
    }
    const bodyChanged = bodyFingerprint(next) !== bodyFingerprint(before);
    next.version = bodyChanged ? before.version + 1 : before.version;
    const metadataChanged =
      next.name !== before.name ||
      next.slug !== before.slug ||
      next.summary !== before.summary ||
      next.ownerWorkerId !== before.ownerWorkerId ||
      next.ownerRoleId !== before.ownerRoleId ||
      next.category !== before.category ||
      next.status !== before.status ||
      next.defaultPriority !== before.defaultPriority ||
      next.estimatedMinutes !== before.estimatedMinutes ||
      next.seedKey !== before.seedKey ||
      next.seedVersion !== before.seedVersion ||
      JSON.stringify(next.tags) !== JSON.stringify(before.tags);
    // Genuine no-op: no write at all.
    if (!bodyChanged && !metadataChanged) return before;
    next.updatedAt = Date.now();
    this.db
      .prepare(`UPDATE wf_sops SET slug=?,name=?,summary=?,owner_worker_id=?,owner_role_id=?,
        category=?,status=?,version=?,steps_json=?,inputs_json=?,outputs_json=?,acceptance_json=?,
        tags_json=?,default_priority=?,estimated_minutes=?,seed_key=?,seed_version=?,updated_at=?
        WHERE agency_id=? AND id=?`)
      .run(
        next.slug,
        next.name,
        next.summary,
        next.ownerWorkerId,
        next.ownerRoleId,
        next.category,
        next.status,
        next.version,
        JSON.stringify(next.steps),
        JSON.stringify(next.inputs),
        JSON.stringify(next.outputs),
        JSON.stringify(next.acceptanceCriteria),
        JSON.stringify(next.tags),
        next.defaultPriority,
        next.estimatedMinutes,
        next.seedKey,
        next.seedVersion,
        next.updatedAt,
        agencyId,
        sopId,
      );
    return next;
  }

  /** Deletes the SOP and (by cascade) its schedules. Runs are kept as history. */
  deleteSop(agencyId: string, sopId: string): boolean {
    requireAgency(agencyId);
    return (
      this.db.prepare("DELETE FROM wf_sops WHERE agency_id=? AND id=?").run(agencyId, sopId)
        .changes > 0
    );
  }

  // ── Schedules ─────────────────────────────────────────────────────────────

  /**
   * Create or refresh the schedule binding one SOP to one worker. Returns the
   * row plus whether anything actually changed, so callers can skip cron work
   * (and audit rows) on a no-op.
   */
  upsertSchedule(
    agencyId: string,
    input: SopScheduleInput & { cronJobName: string },
    now = Date.now(),
  ): { schedule: SopSchedule; changed: boolean } {
    requireAgency(agencyId);
    const sop = this.getSop(agencyId, input.sopId);
    if (!sop) throw new Error("SOP not found");
    const cadence: SopCadence = (SOP_CADENCES as readonly string[]).includes(input.cadence ?? "")
      ? (input.cadence as SopCadence)
      : "weekly";
    const interval = Math.min(52, Math.max(1, Math.round(input.interval ?? 1)));
    const weekday =
      typeof input.weekday === "number" && input.weekday >= 0 && input.weekday <= 6
        ? Math.round(input.weekday)
        : null;
    const monthDay =
      typeof input.monthDay === "number" && input.monthDay >= 1 && input.monthDay <= 28
        ? Math.round(input.monthDay)
        : null;
    const runAt = /^([01]\d|2[0-3]):[0-5]\d$/.test(input.runAt ?? "") ? input.runAt! : "09:00";
    const existing = this.findSchedule(agencyId, input.sopId, input.workerId);

    const base: SopSchedule = {
      id: existing?.id ?? input.id ?? randomUUID(),
      agencyId,
      sopId: input.sopId,
      workerId: input.workerId,
      managerWorkerId: input.managerWorkerId ?? existing?.managerWorkerId ?? null,
      cadence,
      interval,
      weekday,
      monthDay,
      runAt,
      timezone: (input.timezone ?? existing?.timezone ?? "UTC").slice(0, 64),
      slaMinutes: Math.min(
        43_200,
        Math.max(1, Math.round(input.slaMinutes ?? existing?.slaMinutes ?? 1_440)),
      ),
      priority: priority(input.priority, existing?.priority ?? sop.defaultPriority),
      enabled: input.enabled !== undefined ? input.enabled : (existing?.enabled ?? true),
      cronJobName: input.cronJobName,
      cronJobId: existing?.cronJobId ?? null,
      responsibilityId: existing?.responsibilityId ?? null,
      nextRunAt:
        input.nextRunAt ??
        existing?.nextRunAt ??
        nextResponsibilityRun({ cadence, interval, weekday, monthDay, runAt }, now),
      lastRunAt: existing?.lastRunAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (!existing) {
      this.db
        .prepare(`INSERT INTO wf_sop_schedules
          (id,agency_id,sop_id,worker_id,manager_worker_id,cadence,interval_value,weekday,month_day,
           run_at,timezone,sla_minutes,priority,enabled,cron_job_name,cron_job_id,responsibility_id,
           next_run_at,last_run_at,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          base.id,
          agencyId,
          base.sopId,
          base.workerId,
          base.managerWorkerId,
          base.cadence,
          base.interval,
          base.weekday,
          base.monthDay,
          base.runAt,
          base.timezone,
          base.slaMinutes,
          base.priority,
          base.enabled ? 1 : 0,
          base.cronJobName,
          base.cronJobId,
          base.responsibilityId,
          base.nextRunAt,
          base.lastRunAt,
          base.createdAt,
          now,
        );
      return { schedule: base, changed: true };
    }

    const changed = (
      [
        "managerWorkerId",
        "cadence",
        "interval",
        "weekday",
        "monthDay",
        "runAt",
        "timezone",
        "slaMinutes",
        "priority",
        "enabled",
        "cronJobName",
        "nextRunAt",
      ] as const
    ).some((key) => base[key] !== existing[key]);
    if (!changed) return { schedule: existing, changed: false };

    this.db
      .prepare(`UPDATE wf_sop_schedules SET manager_worker_id=?,cadence=?,interval_value=?,weekday=?,
        month_day=?,run_at=?,timezone=?,sla_minutes=?,priority=?,enabled=?,cron_job_name=?,
        next_run_at=?,updated_at=? WHERE agency_id=? AND id=?`)
      .run(
        base.managerWorkerId,
        base.cadence,
        base.interval,
        base.weekday,
        base.monthDay,
        base.runAt,
        base.timezone,
        base.slaMinutes,
        base.priority,
        base.enabled ? 1 : 0,
        base.cronJobName,
        base.nextRunAt,
        now,
        agencyId,
        base.id,
      );
    return { schedule: base, changed: true };
  }

  findSchedule(agencyId: string, sopId: string, workerId: string): SopSchedule | null {
    requireAgency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_sop_schedules WHERE agency_id=? AND sop_id=? AND worker_id=?")
      .get(agencyId, sopId, workerId) as Row | undefined;
    return row ? this.scheduleFromRow(row) : null;
  }

  getSchedule(agencyId: string, scheduleId: string): SopSchedule | null {
    requireAgency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_sop_schedules WHERE agency_id=? AND id=?")
      .get(agencyId, scheduleId) as Row | undefined;
    return row ? this.scheduleFromRow(row) : null;
  }

  listSchedules(
    agencyId: string,
    filters: { sopId?: string; workerId?: string; enabled?: boolean } = {},
  ): SopSchedule[] {
    requireAgency(agencyId);
    let sql = "SELECT * FROM wf_sop_schedules WHERE agency_id=?";
    const params: unknown[] = [agencyId];
    if (filters.sopId) {
      sql += " AND sop_id=?";
      params.push(filters.sopId);
    }
    if (filters.workerId) {
      sql += " AND worker_id=?";
      params.push(filters.workerId);
    }
    if (filters.enabled !== undefined) {
      sql += " AND enabled=?";
      params.push(filters.enabled ? 1 : 0);
    }
    sql += " ORDER BY next_run_at";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.scheduleFromRow(row));
  }

  /**
   * The schedule that owns a given `wf_recurring_responsibilities` row. This is
   * the link the executor follows to discover that a generated work item came
   * from a STORED SOP rather than from a worker's `sopPath` on disk.
   */
  findScheduleByResponsibility(agencyId: string, responsibilityId: string): SopSchedule | null {
    requireAgency(agencyId);
    if (!responsibilityId) return null;
    const row = this.db
      .prepare("SELECT * FROM wf_sop_schedules WHERE agency_id=? AND responsibility_id=?")
      .get(agencyId, responsibilityId) as Row | undefined;
    return row ? this.scheduleFromRow(row) : null;
  }

  /** Every schedule on this node, used to reconcile cron jobs at boot. */
  listAllSchedules(): SopSchedule[] {
    return (
      this.db
        .prepare("SELECT * FROM wf_sop_schedules ORDER BY agency_id, next_run_at")
        .all() as Row[]
    ).map((row) => this.scheduleFromRow(row));
  }

  /** Link bookkeeping written after the cron job / responsibility row exists. */
  setScheduleLinks(
    agencyId: string,
    scheduleId: string,
    links: { cronJobId?: string | null; responsibilityId?: string | null; nextRunAt?: number },
  ): SopSchedule | null {
    const current = this.getSchedule(agencyId, scheduleId);
    if (!current) return null;
    const cronJobId = links.cronJobId !== undefined ? links.cronJobId : current.cronJobId;
    const responsibilityId =
      links.responsibilityId !== undefined ? links.responsibilityId : current.responsibilityId;
    const nextRunAt = links.nextRunAt !== undefined ? links.nextRunAt : current.nextRunAt;
    if (
      cronJobId === current.cronJobId &&
      responsibilityId === current.responsibilityId &&
      nextRunAt === current.nextRunAt
    ) {
      return current; // no-op: no write, no updated_at churn
    }
    // One timestamp for the row and the returned object (two Date.now() calls
    // could straddle a millisecond and disagree).
    const updatedAt = Date.now();
    this.db
      .prepare(`UPDATE wf_sop_schedules SET cron_job_id=?,responsibility_id=?,next_run_at=?,
        updated_at=? WHERE agency_id=? AND id=?`)
      .run(cronJobId, responsibilityId, nextRunAt, updatedAt, agencyId, scheduleId);
    return { ...current, cronJobId, responsibilityId, nextRunAt, updatedAt };
  }

  deleteSchedule(agencyId: string, scheduleId: string): SopSchedule | null {
    const existing = this.getSchedule(agencyId, scheduleId);
    if (!existing) return null;
    this.db
      .prepare("DELETE FROM wf_sop_schedules WHERE agency_id=? AND id=?")
      .run(agencyId, scheduleId);
    return existing;
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  recordRun(
    agencyId: string,
    input: {
      id?: string;
      sopId: string;
      scheduleId?: string | null;
      workerId: string;
      workItemId?: string | null;
      trigger: SopTrigger;
      sopVersion: number;
      status?: SopRunStatus;
      note?: string | null;
      scheduledFor?: number;
    },
  ): SopRun {
    requireAgency(agencyId);
    const now = Date.now();
    const run: SopRun = {
      id: input.id ?? randomUUID(),
      agencyId,
      sopId: input.sopId,
      scheduleId: input.scheduleId ?? null,
      workerId: input.workerId,
      workItemId: input.workItemId ?? null,
      trigger: (SOP_TRIGGERS as readonly string[]).includes(input.trigger)
        ? input.trigger
        : "manual",
      sopVersion: input.sopVersion,
      status: (SOP_RUN_STATUSES as readonly string[]).includes(input.status ?? "")
        ? (input.status as SopRunStatus)
        : "materialised",
      note: input.note ?? null,
      scheduledFor: input.scheduledFor ?? now,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO wf_sop_runs
        (id,agency_id,sop_id,schedule_id,worker_id,work_item_id,trigger,sop_version,status,note,
         scheduled_for,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        run.id,
        agencyId,
        run.sopId,
        run.scheduleId,
        run.workerId,
        run.workItemId,
        run.trigger,
        run.sopVersion,
        run.status,
        run.note,
        run.scheduledFor,
        now,
        now,
      );
    return run;
  }

  listRuns(
    agencyId: string,
    filters: { sopId?: string; scheduleId?: string; workerId?: string; limit?: number } = {},
  ): SopRun[] {
    requireAgency(agencyId);
    let sql = "SELECT * FROM wf_sop_runs WHERE agency_id=?";
    const params: unknown[] = [agencyId];
    if (filters.sopId) {
      sql += " AND sop_id=?";
      params.push(filters.sopId);
    }
    if (filters.scheduleId) {
      sql += " AND schedule_id=?";
      params.push(filters.scheduleId);
    }
    if (filters.workerId) {
      sql += " AND worker_id=?";
      params.push(filters.workerId);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(Math.max(1, Math.min(500, filters.limit ?? 100)));
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => ({
      id: String(row.id),
      agencyId: String(row.agency_id),
      sopId: String(row.sop_id),
      scheduleId: row.schedule_id ? String(row.schedule_id) : null,
      workerId: String(row.worker_id),
      workItemId: row.work_item_id ? String(row.work_item_id) : null,
      trigger: row.trigger as SopTrigger,
      sopVersion: Number(row.sop_version),
      status: row.status as SopRunStatus,
      note: row.note ? String(row.note) : null,
      scheduledFor: Number(row.scheduled_for),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  // ── row mapping ───────────────────────────────────────────────────────────

  private sopFromRow(row: Row): Sop {
    return {
      id: String(row.id),
      agencyId: String(row.agency_id),
      slug: String(row.slug),
      name: String(row.name),
      summary: String(row.summary ?? ""),
      ownerWorkerId: row.owner_worker_id ? String(row.owner_worker_id) : null,
      ownerRoleId: row.owner_role_id ? String(row.owner_role_id) : null,
      category: String(row.category ?? "general"),
      status: row.status as SopStatus,
      version: Number(row.version),
      steps: parse<SopStep[]>(row.steps_json, []),
      inputs: parse<SopIo[]>(row.inputs_json, []),
      outputs: parse<SopIo[]>(row.outputs_json, []),
      acceptanceCriteria: parse<string[]>(row.acceptance_json, []),
      tags: parse<string[]>(row.tags_json, []),
      defaultPriority: row.default_priority as WorkItemPriority,
      estimatedMinutes: Number(row.estimated_minutes),
      source: row.source === "seed" ? "seed" : "operator",
      seedKey: row.seed_key ? String(row.seed_key) : null,
      seedVersion: Number(row.seed_version ?? 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private scheduleFromRow(row: Row): SopSchedule {
    return {
      id: String(row.id),
      agencyId: String(row.agency_id),
      sopId: String(row.sop_id),
      workerId: String(row.worker_id),
      managerWorkerId: row.manager_worker_id ? String(row.manager_worker_id) : null,
      cadence: row.cadence as SopCadence,
      interval: Number(row.interval_value),
      weekday: row.weekday == null ? null : Number(row.weekday),
      monthDay: row.month_day == null ? null : Number(row.month_day),
      runAt: String(row.run_at),
      timezone: String(row.timezone),
      slaMinutes: Number(row.sla_minutes),
      priority: row.priority as WorkItemPriority,
      enabled: Boolean(row.enabled),
      cronJobName: String(row.cron_job_name),
      cronJobId: row.cron_job_id ? String(row.cron_job_id) : null,
      responsibilityId: row.responsibility_id ? String(row.responsibility_id) : null,
      nextRunAt: Number(row.next_run_at),
      lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

/**
 * The SOP as the executor injects it into an employee's prompt. Deterministic
 * so a prompt snapshot test is meaningful.
 */
export function renderSopMarkdown(sop: Sop): string {
  const sections: string[] = [`### ${sop.name} (v${sop.version})`];
  if (sop.summary) sections.push(sop.summary);
  if (sop.inputs.length) {
    sections.push(
      `**Inputs**\n${sop.inputs
        .map(
          (io) =>
            `- ${io.name}${io.required ? "" : " (optional)"}${io.description ? `: ${io.description}` : ""}`,
        )
        .join("\n")}`,
    );
  }
  if (sop.steps.length) {
    sections.push(
      `**Procedure**\n${sop.steps
        .map((step) => {
          const bits = [
            `${step.order}. ${step.title}${step.required ? "" : " (optional)"} — ${step.instruction}`,
          ];
          if (step.expectedOutput) bits.push(`   Expected output: ${step.expectedOutput}`);
          if (step.toolHint) bits.push(`   Use: ${step.toolHint}`);
          return bits.join("\n");
        })
        .join("\n")}`,
    );
  }
  if (sop.outputs.length) {
    sections.push(
      `**Deliverables**\n${sop.outputs
        .map((io) => `- ${io.name}${io.description ? `: ${io.description}` : ""}`)
        .join("\n")}`,
    );
  }
  if (sop.acceptanceCriteria.length) {
    sections.push(
      `**Acceptance criteria** (all must hold before this is done)\n${sop.acceptanceCriteria
        .map((criterion) => `- ${criterion}`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
