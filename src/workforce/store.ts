import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  assertNoCredentials,
  parseChannelBindingDirection,
  parseChannelId,
  type ChannelBindingDirection,
  type WorkerChannelBinding,
  type WorkerChannelBindingInput,
} from "./channel-bindings.js";
import {
  normalizeCommunicationProfile,
  resolveCommunicationProfile,
  summarizeCommunicationProfile,
  type CommunicationProfile,
} from "./communication.js";
import {
  normalizeExecutionProfile,
  resolveExecutionProfile,
  type WorkerExecutionProfile,
} from "./execution-profile.js";
import type {
  Assignment,
  AssignmentInput,
  AssignmentMember,
  AssignmentStatus,
  AuditEntry,
  DailyRosterEntry,
  Department,
  DepartmentCapacity,
  OutcomeMetric,
  PerformanceReview,
  PerformanceScorecard,
  TimeEntry,
  Worker,
  WorkerCapacity,
  WorkerInput,
  WorkerSkill,
} from "./types.js";

type Row = Record<string, unknown>;

let instance: WorkforceStore | null = null;

/** Uses the agency operations database by default; callers may inject any canonical DB path. */
export function getWorkforceStore(
  dbPath = join(process.cwd(), "state", "agency-operations", "agency.db"),
): WorkforceStore {
  if (!instance) instance = new WorkforceStore(dbPath);
  return instance;
}

export function resetWorkforceStore(): void {
  instance?.close();
  instance = null;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function assertAgencyId(agencyId: string): void {
  if (!agencyId?.trim()) throw new Error("agencyId required");
}

function assertNumber(
  name: string,
  value: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
}

export class WorkforceStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
      CREATE TABLE IF NOT EXISTS wf_departments (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        manager_worker_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (agency_id, id), UNIQUE (agency_id, name)
      );
      CREATE TABLE IF NOT EXISTS wf_workers (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, type TEXT NOT NULL, display_name TEXT NOT NULL,
        email TEXT, title TEXT NOT NULL DEFAULT '', department_id TEXT, employment_status TEXT NOT NULL,
        employment_type TEXT NOT NULL, timezone TEXT NOT NULL, weekly_capacity_hours REAL NOT NULL,
        availability_percent REAL NOT NULL, cost_rate REAL NOT NULL, currency TEXT NOT NULL,
        agent_id TEXT, persona TEXT, manager_worker_id TEXT, permissions_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL, goals_json TEXT NOT NULL, kpis_json TEXT NOT NULL,
        autonomy_level INTEGER NOT NULL, approval_threshold REAL NOT NULL,
        communication_cadence TEXT NOT NULL, sop_path TEXT, workspace_path TEXT,
        current_status TEXT NOT NULL, last_heartbeat_at INTEGER, metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (agency_id, id),
        FOREIGN KEY (agency_id, department_id) REFERENCES wf_departments(agency_id, id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wf_worker_agent
        ON wf_workers(agency_id, agent_id) WHERE agent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_wf_workers_department ON wf_workers(agency_id, department_id);
      CREATE INDEX IF NOT EXISTS idx_wf_workers_status ON wf_workers(agency_id, employment_status);
      CREATE TABLE IF NOT EXISTS wf_worker_skills (
        agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, skill TEXT NOT NULL COLLATE NOCASE,
        level INTEGER NOT NULL, years_experience REAL NOT NULL, verified_at INTEGER,
        PRIMARY KEY (agency_id, worker_id, skill),
        FOREIGN KEY (agency_id, worker_id) REFERENCES wf_workers(agency_id, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS wf_assignments (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
        project_id TEXT, task_id TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL,
        starts_at INTEGER, due_at INTEGER, estimated_hours REAL NOT NULL,
        required_skills_json TEXT NOT NULL, required_capabilities_json TEXT NOT NULL,
        created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (agency_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_wf_assignments_status ON wf_assignments(agency_id, status);
      CREATE INDEX IF NOT EXISTS idx_wf_assignments_project ON wf_assignments(agency_id, project_id);
      CREATE TABLE IF NOT EXISTS wf_assignment_members (
        agency_id TEXT NOT NULL, assignment_id TEXT NOT NULL, worker_id TEXT NOT NULL,
        role TEXT NOT NULL, allocated_hours REAL NOT NULL,
        PRIMARY KEY (agency_id, assignment_id, worker_id),
        FOREIGN KEY (agency_id, assignment_id) REFERENCES wf_assignments(agency_id, id) ON DELETE CASCADE,
        FOREIGN KEY (agency_id, worker_id) REFERENCES wf_workers(agency_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS wf_time_entries (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
        hours REAL NOT NULL, billable INTEGER NOT NULL, note TEXT NOT NULL, occurred_on TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (agency_id, id),
        FOREIGN KEY (agency_id, worker_id) REFERENCES wf_workers(agency_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (agency_id, assignment_id) REFERENCES wf_assignments(agency_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_wf_time_worker_date ON wf_time_entries(agency_id, worker_id, occurred_on);
      CREATE TABLE IF NOT EXISTS wf_performance_reviews (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, reviewer_worker_id TEXT,
        period_start TEXT NOT NULL, period_end TEXT NOT NULL, quality_score REAL NOT NULL,
        reliability_score REAL NOT NULL, collaboration_score REAL NOT NULL,
        goals_json TEXT NOT NULL, feedback TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (agency_id, id),
        FOREIGN KEY (agency_id, worker_id) REFERENCES wf_workers(agency_id, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS wf_outcome_metrics (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, assignment_id TEXT,
        metric TEXT NOT NULL, value REAL NOT NULL, target REAL, unit TEXT NOT NULL, recorded_at INTEGER NOT NULL,
        PRIMARY KEY (agency_id, id),
        FOREIGN KEY (agency_id, worker_id) REFERENCES wf_workers(agency_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_wf_metrics_worker ON wf_outcome_metrics(agency_id, worker_id, recorded_at);
      CREATE TABLE IF NOT EXISTS wf_audit_entries (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY (agency_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_wf_audit_entity
        ON wf_audit_entries(agency_id, entity_type, entity_id, created_at);
      -- Per-worker chat channel routing. ROUTING ONLY: channel credentials stay
      -- in the gateway channel configuration and are rejected by
      -- assertNoCredentials before anything reaches this table.
      CREATE TABLE IF NOT EXISTS wf_worker_channel_bindings (
        id TEXT NOT NULL, agency_id TEXT NOT NULL, worker_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        target TEXT, handle TEXT, direction TEXT NOT NULL DEFAULT 'both',
        enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (agency_id, id),
        FOREIGN KEY (agency_id, worker_id) REFERENCES wf_workers(agency_id, id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wf_channel_binding_unique
        ON wf_worker_channel_bindings(agency_id, worker_id, channel_id, COALESCE(target, ''));
      CREATE INDEX IF NOT EXISTS idx_wf_channel_binding_channel
        ON wf_worker_channel_bindings(agency_id, channel_id, enabled);
    `);
    // This store predates numbered migrations (plain CREATE TABLE IF NOT EXISTS),
    // so additive columns are reconciled with an idempotent PRAGMA check rather
    // than by bumping AgencyOperationsStore's schema_migrations version.
    this.ensureColumn("wf_workers", "model_binding", "TEXT");
    // Structured communication profile. Nullable on purpose: existing rows keep
    // NULL and are migrated from `communication_cadence` lazily on read, so the
    // boot-time migration stays a pure ALTER TABLE with no row rewrite.
    this.ensureColumn("wf_workers", "communication_profile_json", "TEXT");
    // Per-worker execution knobs (backend fallback, tool allowlist, timeout,
    // max concurrency). Also nullable: NULL means "inherit every gateway
    // default", so this ALTER never rewrites a row.
    this.ensureColumn("wf_workers", "execution_profile_json", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((row) => String(row.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createDepartment(
    agencyId: string,
    input: { id?: string; name: string; description?: string; managerWorkerId?: string | null },
    actorId?: string,
  ): Department {
    assertAgencyId(agencyId);
    if (!input.name.trim()) throw new Error("department name required");
    const now = Date.now();
    const department: Department = {
      id: input.id ?? randomUUID(),
      agencyId,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      managerWorkerId: input.managerWorkerId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO wf_departments
        (id, agency_id, name, description, manager_worker_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        department.id,
        agencyId,
        department.name,
        department.description,
        department.managerWorkerId,
        now,
        now,
      );
    this.audit(
      agencyId,
      actorId,
      "department.created",
      "department",
      department.id,
      null,
      department,
    );
    return department;
  }

  listDepartments(agencyId: string): Department[] {
    assertAgencyId(agencyId);
    return (
      this.db
        .prepare("SELECT * FROM wf_departments WHERE agency_id = ? ORDER BY name")
        .all(agencyId) as Row[]
    ).map((row) => this.departmentFromRow(row));
  }

  createWorker(input: WorkerInput, actorId?: string): Worker {
    assertAgencyId(input.agencyId);
    if (!input.displayName.trim()) throw new Error("displayName required");
    const weeklyCapacityHours = input.weeklyCapacityHours ?? (input.type === "ai" ? 168 : 40);
    const availabilityPercent = input.availabilityPercent ?? 100;
    const costRate = input.costRate ?? 0;
    assertNumber("weeklyCapacityHours", weeklyCapacityHours, 0, 168);
    assertNumber("availabilityPercent", availabilityPercent, 0, 100);
    assertNumber("costRate", costRate, 0);
    const now = Date.now();
    const worker: Worker = {
      id: input.id ?? randomUUID(),
      agencyId: input.agencyId,
      type: input.type,
      displayName: input.displayName.trim(),
      email: input.email ?? null,
      title: input.title?.trim() ?? "",
      departmentId: input.departmentId ?? null,
      employmentStatus: input.employmentStatus ?? "active",
      employmentType: input.employmentType ?? (input.type === "ai" ? "agent" : "employee"),
      timezone: input.timezone ?? "UTC",
      weeklyCapacityHours,
      availabilityPercent,
      costRate,
      currency: input.currency ?? "USD",
      agentId: input.agentId ?? null,
      modelBinding: input.modelBinding ?? null,
      persona: input.persona ?? null,
      managerWorkerId: input.managerWorkerId ?? null,
      permissions: input.permissions ?? [],
      capabilities: input.capabilities ?? [],
      goals: input.goals ?? [],
      kpis: input.kpis ?? [],
      autonomyLevel: input.autonomyLevel ?? (input.type === "ai" ? 1 : 0),
      approvalThreshold: input.approvalThreshold ?? 0,
      communicationCadence: input.communicationCadence ?? "daily",
      communicationProfile: input.communicationProfile ?? null,
      executionProfile: input.executionProfile ?? null,
      sopPath: input.sopPath ?? null,
      workspacePath: input.workspacePath ?? null,
      currentStatus: input.currentStatus ?? "available",
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
      metadata: input.metadata ?? {},
      skills: input.skills ?? [],
      createdAt: now,
      updatedAt: now,
    };
    const insert = this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO wf_workers (
        id, agency_id, type, display_name, email, title, department_id, employment_status,
        employment_type, timezone, weekly_capacity_hours, availability_percent, cost_rate,
        currency, agent_id, persona, manager_worker_id, permissions_json, capabilities_json,
        goals_json, kpis_json, autonomy_level, approval_threshold, communication_cadence,
        sop_path, workspace_path, current_status, last_heartbeat_at, metadata_json, created_at, updated_at,
        model_binding, communication_profile_json, execution_profile_json
      ) VALUES (${Array.from({ length: 34 }, () => "?").join(",")})`)
        .run(
          worker.id,
          worker.agencyId,
          worker.type,
          worker.displayName,
          worker.email,
          worker.title,
          worker.departmentId,
          worker.employmentStatus,
          worker.employmentType,
          worker.timezone,
          worker.weeklyCapacityHours,
          worker.availabilityPercent,
          worker.costRate,
          worker.currency,
          worker.agentId,
          worker.persona,
          worker.managerWorkerId,
          JSON.stringify(worker.permissions),
          JSON.stringify(worker.capabilities),
          JSON.stringify(worker.goals),
          JSON.stringify(worker.kpis),
          worker.autonomyLevel,
          worker.approvalThreshold,
          worker.communicationCadence,
          worker.sopPath,
          worker.workspacePath,
          worker.currentStatus,
          worker.lastHeartbeatAt,
          JSON.stringify(worker.metadata),
          now,
          now,
          worker.modelBinding,
          worker.communicationProfile ? JSON.stringify(worker.communicationProfile) : null,
          worker.executionProfile ? JSON.stringify(worker.executionProfile) : null,
        );
      this.replaceSkills(worker.agencyId, worker.id, worker.skills);
      this.audit(worker.agencyId, actorId, "worker.created", "worker", worker.id, null, worker);
    });
    insert();
    return worker;
  }

  getWorker(agencyId: string, workerId: string): Worker | null {
    assertAgencyId(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_workers WHERE agency_id = ? AND id = ?")
      .get(agencyId, workerId) as Row | undefined;
    return row ? this.workerFromRow(row) : null;
  }

  listWorkers(
    agencyId: string,
    filters?: { type?: "human" | "ai"; departmentId?: string; status?: string },
  ): Worker[] {
    assertAgencyId(agencyId);
    let sql = "SELECT * FROM wf_workers WHERE agency_id = ?";
    const params: unknown[] = [agencyId];
    if (filters?.type) {
      sql += " AND type = ?";
      params.push(filters.type);
    }
    if (filters?.departmentId) {
      sql += " AND department_id = ?";
      params.push(filters.departmentId);
    }
    if (filters?.status) {
      sql += " AND employment_status = ?";
      params.push(filters.status);
    }
    sql += " ORDER BY display_name";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.workerFromRow(row));
  }

  updateWorker(
    agencyId: string,
    workerId: string,
    patch: Partial<Omit<WorkerInput, "agencyId" | "id" | "type">> & { type?: "human" | "ai" },
    actorId?: string,
  ): Worker | null {
    const before = this.getWorker(agencyId, workerId);
    if (!before) return null;
    const merged: WorkerInput = { ...before, ...patch, agencyId, id: workerId };
    assertNumber("weeklyCapacityHours", merged.weeklyCapacityHours!, 0, 168);
    assertNumber("availabilityPercent", merged.availabilityPercent!, 0, 100);
    assertNumber("costRate", merged.costRate!, 0);
    const now = Date.now();
    const update = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE wf_workers SET
        type=?, display_name=?, email=?, title=?, department_id=?, employment_status=?, employment_type=?,
        timezone=?, weekly_capacity_hours=?, availability_percent=?, cost_rate=?, currency=?, agent_id=?,
        persona=?, manager_worker_id=?, permissions_json=?, capabilities_json=?, goals_json=?, kpis_json=?,
        autonomy_level=?, approval_threshold=?, communication_cadence=?, sop_path=?, workspace_path=?,
        current_status=?, last_heartbeat_at=?, metadata_json=?, updated_at=?, model_binding=?,
        communication_profile_json=?, execution_profile_json=?
        WHERE agency_id=? AND id=?`)
        .run(
          merged.type,
          merged.displayName.trim(),
          merged.email ?? null,
          merged.title ?? "",
          merged.departmentId ?? null,
          merged.employmentStatus,
          merged.employmentType,
          merged.timezone,
          merged.weeklyCapacityHours,
          merged.availabilityPercent,
          merged.costRate,
          merged.currency,
          merged.agentId ?? null,
          merged.persona ?? null,
          merged.managerWorkerId ?? null,
          JSON.stringify(merged.permissions ?? []),
          JSON.stringify(merged.capabilities ?? []),
          JSON.stringify(merged.goals ?? []),
          JSON.stringify(merged.kpis ?? []),
          merged.autonomyLevel,
          merged.approvalThreshold,
          merged.communicationCadence,
          merged.sopPath ?? null,
          merged.workspacePath ?? null,
          merged.currentStatus,
          merged.lastHeartbeatAt ?? null,
          JSON.stringify(merged.metadata ?? {}),
          now,
          merged.modelBinding ?? null,
          merged.communicationProfile ? JSON.stringify(merged.communicationProfile) : null,
          merged.executionProfile ? JSON.stringify(merged.executionProfile) : null,
          agencyId,
          workerId,
        );
      if (patch.skills) this.replaceSkills(agencyId, workerId, patch.skills);
    });
    update();
    const after = this.getWorker(agencyId, workerId)!;
    this.audit(agencyId, actorId, "worker.updated", "worker", workerId, before, after);
    return after;
  }

  // ── Communication profile ─────────────────────────────────────────────────

  /**
   * The worker's profile. Rows that predate the feature return one migrated
   * from the legacy `communicationCadence` string — read-only, no write, so
   * merely listing employees never touches the database.
   */
  getCommunicationProfile(agencyId: string, workerId: string): CommunicationProfile | null {
    const worker = this.getWorker(agencyId, workerId);
    return worker ? resolveCommunicationProfile(worker) : null;
  }

  /**
   * Persist a profile patch. The patch is merged over the worker's current
   * (or migrated) profile and normalised — unknown channel ids in overrides
   * are dropped, numbers clamped. The legacy `communicationCadence` column is
   * refreshed with a readable one-line summary, while the operator's original
   * text is preserved verbatim in `legacyCadence`.
   *
   * Returns null when the worker does not exist. A patch that changes nothing
   * performs no write.
   */
  setCommunicationProfile(
    agencyId: string,
    workerId: string,
    patch: unknown,
    actorId?: string,
  ): { worker: Worker; profile: CommunicationProfile; changed: boolean } | null {
    const before = this.getWorker(agencyId, workerId);
    if (!before) return null;
    const base = resolveCommunicationProfile(before);
    const next = normalizeCommunicationProfile(patch, base);
    const comparable = (profile: CommunicationProfile) =>
      JSON.stringify({ ...profile, updatedAt: 0 });
    if (before.communicationProfile && comparable(next) === comparable(base)) {
      return { worker: before, profile: base, changed: false };
    }
    const cadence = summarizeCommunicationProfile(next);
    const now = Date.now();
    this.db
      .prepare(`UPDATE wf_workers SET communication_profile_json=?, communication_cadence=?,
        updated_at=? WHERE agency_id=? AND id=?`)
      .run(JSON.stringify(next), cadence, now, agencyId, workerId);
    const worker = this.getWorker(agencyId, workerId)!;
    this.audit(
      agencyId,
      actorId,
      "worker.communication_profile.updated",
      "worker",
      workerId,
      {
        communicationProfile: before.communicationProfile,
        communicationCadence: before.communicationCadence,
      },
      { communicationProfile: next, communicationCadence: cadence },
    );
    return { worker, profile: next, changed: true };
  }

  // ── Execution profile ─────────────────────────────────────────────────────

  /** The worker's runtime knobs, or the all-inherit default. */
  getExecutionProfile(agencyId: string, workerId: string): WorkerExecutionProfile | null {
    const worker = this.getWorker(agencyId, workerId);
    return worker ? resolveExecutionProfile(worker) : null;
  }

  /**
   * Persist an execution-profile patch, merged over the worker's current (or
   * default) profile and normalised. Returns null when the worker does not
   * exist. A patch that changes nothing performs no write and emits no audit
   * row — re-running an importer must never grow this database.
   */
  setExecutionProfile(
    agencyId: string,
    workerId: string,
    patch: unknown,
    actorId?: string,
  ): { worker: Worker; profile: WorkerExecutionProfile; changed: boolean } | null {
    const before = this.getWorker(agencyId, workerId);
    if (!before) return null;
    const base = resolveExecutionProfile(before);
    const next = normalizeExecutionProfile(patch, base);
    const comparable = (profile: WorkerExecutionProfile) =>
      JSON.stringify({ ...profile, updatedAt: 0 });
    if (before.executionProfile && comparable(next) === comparable(base)) {
      return { worker: before, profile: base, changed: false };
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE wf_workers SET execution_profile_json=?, updated_at=? WHERE agency_id=? AND id=?`,
      )
      .run(JSON.stringify(next), now, agencyId, workerId);
    const worker = this.getWorker(agencyId, workerId)!;
    this.audit(
      agencyId,
      actorId,
      "worker.execution_profile.updated",
      "worker",
      workerId,
      before.executionProfile,
      next,
    );
    return { worker, profile: next, changed: true };
  }

  // ── Channel bindings ──────────────────────────────────────────────────────

  listChannelBindings(
    agencyId: string,
    filters: { workerId?: string; channelId?: string; enabled?: boolean } = {},
  ): WorkerChannelBinding[] {
    assertAgencyId(agencyId);
    let sql = "SELECT * FROM wf_worker_channel_bindings WHERE agency_id=?";
    const params: unknown[] = [agencyId];
    if (filters.workerId) {
      sql += " AND worker_id=?";
      params.push(filters.workerId);
    }
    if (filters.channelId) {
      sql += " AND channel_id=?";
      params.push(parseChannelId(filters.channelId));
    }
    if (filters.enabled !== undefined) {
      sql += " AND enabled=?";
      params.push(filters.enabled ? 1 : 0);
    }
    sql += " ORDER BY channel_id, target";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) =>
      this.channelBindingFromRow(row),
    );
  }

  getChannelBinding(agencyId: string, bindingId: string): WorkerChannelBinding | null {
    assertAgencyId(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_worker_channel_bindings WHERE agency_id=? AND id=?")
      .get(agencyId, bindingId) as Row | undefined;
    return row ? this.channelBindingFromRow(row) : null;
  }

  /**
   * Bind a worker to a chat channel, or update the existing binding for the
   * same (worker, channel, target) triple. The channel id is validated against
   * `src/channels/registry.ts`; the `config` bag is rejected if it looks like
   * it carries credentials.
   */
  upsertChannelBinding(
    agencyId: string,
    input: WorkerChannelBindingInput,
    actorId?: string,
  ): WorkerChannelBinding {
    assertAgencyId(agencyId);
    if (!this.getWorker(agencyId, input.workerId)) throw new Error("worker not found in agency");
    const channelId = parseChannelId(input.channelId);
    const direction: ChannelBindingDirection = parseChannelBindingDirection(input.direction);
    const target = input.target?.trim() ? input.target.trim().slice(0, 400) : null;
    const handle = input.handle?.trim() ? input.handle.trim().slice(0, 200) : null;
    const config = input.config ?? {};
    assertNoCredentials(config);
    const now = Date.now();
    const existing = this.db
      .prepare(
        `SELECT * FROM wf_worker_channel_bindings
           WHERE agency_id=? AND worker_id=? AND channel_id=? AND COALESCE(target,'')=?`,
      )
      .get(agencyId, input.workerId, channelId, target ?? "") as Row | undefined;
    const binding: WorkerChannelBinding = {
      id: existing ? String(existing.id) : (input.id ?? randomUUID()),
      agencyId,
      workerId: input.workerId,
      channelId,
      target,
      handle,
      direction,
      enabled: input.enabled !== false,
      config,
      createdAt: existing ? Number(existing.created_at) : now,
      updatedAt: now,
    };
    if (existing) {
      const before = this.channelBindingFromRow(existing);
      const unchanged =
        before.handle === binding.handle &&
        before.direction === binding.direction &&
        before.enabled === binding.enabled &&
        JSON.stringify(before.config) === JSON.stringify(binding.config);
      if (unchanged) return before;
      this.db
        .prepare(`UPDATE wf_worker_channel_bindings SET handle=?, direction=?, enabled=?,
          config_json=?, updated_at=? WHERE agency_id=? AND id=?`)
        .run(
          binding.handle,
          binding.direction,
          binding.enabled ? 1 : 0,
          JSON.stringify(binding.config),
          now,
          agencyId,
          binding.id,
        );
      this.audit(
        agencyId,
        actorId,
        "worker.channel_binding.updated",
        "worker",
        input.workerId,
        before,
        binding,
      );
      return binding;
    }
    this.db
      .prepare(`INSERT INTO wf_worker_channel_bindings
        (id,agency_id,worker_id,channel_id,target,handle,direction,enabled,config_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        binding.id,
        agencyId,
        binding.workerId,
        binding.channelId,
        binding.target,
        binding.handle,
        binding.direction,
        binding.enabled ? 1 : 0,
        JSON.stringify(binding.config),
        now,
        now,
      );
    this.audit(
      agencyId,
      actorId,
      "worker.channel_binding.created",
      "worker",
      input.workerId,
      null,
      binding,
    );
    return binding;
  }

  removeChannelBinding(agencyId: string, bindingId: string, actorId?: string): boolean {
    const before = this.getChannelBinding(agencyId, bindingId);
    if (!before) return false;
    this.db
      .prepare("DELETE FROM wf_worker_channel_bindings WHERE agency_id=? AND id=?")
      .run(agencyId, bindingId);
    this.audit(
      agencyId,
      actorId,
      "worker.channel_binding.removed",
      "worker",
      before.workerId,
      before,
      null,
    );
    return true;
  }

  private channelBindingFromRow(row: Row): WorkerChannelBinding {
    return {
      id: String(row.id),
      agencyId: String(row.agency_id),
      workerId: String(row.worker_id),
      channelId: parseChannelId(row.channel_id),
      target: row.target ? String(row.target) : null,
      handle: row.handle ? String(row.handle) : null,
      direction: row.direction as ChannelBindingDirection,
      enabled: Boolean(row.enabled),
      config: json<Record<string, unknown>>(row.config_json, {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  heartbeat(agencyId: string, workerId: string, status = "available", at = Date.now()): boolean {
    assertAgencyId(agencyId);
    return (
      this.db
        .prepare(
          "UPDATE wf_workers SET last_heartbeat_at=?, current_status=?, updated_at=? WHERE agency_id=? AND id=?",
        )
        .run(at, status, at, agencyId, workerId).changes > 0
    );
  }

  createAssignment(input: AssignmentInput, actorId?: string): Assignment {
    assertAgencyId(input.agencyId);
    if (!input.title.trim()) throw new Error("assignment title required");
    assertNumber("estimatedHours", input.estimatedHours ?? 0, 0);
    for (const member of input.members ?? []) {
      if (!this.getWorker(input.agencyId, member.workerId))
        throw new Error(`worker ${member.workerId} not found in agency`);
      assertNumber("allocatedHours", member.allocatedHours, 0);
    }
    const now = Date.now();
    const assignment: Assignment = {
      id: input.id ?? randomUUID(),
      agencyId: input.agencyId,
      title: input.title.trim(),
      description: input.description ?? "",
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      status: input.status ?? "planned",
      priority: input.priority ?? 3,
      startsAt: input.startsAt ?? null,
      dueAt: input.dueAt ?? null,
      estimatedHours: input.estimatedHours ?? 0,
      requiredSkills: input.requiredSkills ?? [],
      requiredCapabilities: input.requiredCapabilities ?? [],
      members: input.members ?? [],
      createdBy: input.createdBy ?? actorId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO wf_assignments
        (id, agency_id, title, description, project_id, task_id, status, priority, starts_at, due_at,
         estimated_hours, required_skills_json, required_capabilities_json, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          assignment.id,
          assignment.agencyId,
          assignment.title,
          assignment.description,
          assignment.projectId,
          assignment.taskId,
          assignment.status,
          assignment.priority,
          assignment.startsAt,
          assignment.dueAt,
          assignment.estimatedHours,
          JSON.stringify(assignment.requiredSkills),
          JSON.stringify(assignment.requiredCapabilities),
          assignment.createdBy,
          now,
          now,
        );
      for (const member of assignment.members)
        this.insertAssignmentMember(input.agencyId, assignment.id, member);
      this.audit(
        input.agencyId,
        actorId,
        "assignment.created",
        "assignment",
        assignment.id,
        null,
        assignment,
      );
    })();
    return assignment;
  }

  getAssignment(agencyId: string, assignmentId: string): Assignment | null {
    assertAgencyId(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_assignments WHERE agency_id=? AND id=?")
      .get(agencyId, assignmentId) as Row | undefined;
    return row ? this.assignmentFromRow(row) : null;
  }

  listAssignments(agencyId: string, status?: AssignmentStatus): Assignment[] {
    assertAgencyId(agencyId);
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM wf_assignments WHERE agency_id=? AND status=? ORDER BY priority, due_at",
          )
          .all(agencyId, status)
      : this.db
          .prepare("SELECT * FROM wf_assignments WHERE agency_id=? ORDER BY priority, due_at")
          .all(agencyId);
    return (rows as Row[]).map((row) => this.assignmentFromRow(row));
  }

  setAssignmentStatus(
    agencyId: string,
    assignmentId: string,
    status: AssignmentStatus,
    actorId?: string,
  ): Assignment | null {
    const before = this.getAssignment(agencyId, assignmentId);
    if (!before) return null;
    this.db
      .prepare("UPDATE wf_assignments SET status=?, updated_at=? WHERE agency_id=? AND id=?")
      .run(status, Date.now(), agencyId, assignmentId);
    const after = this.getAssignment(agencyId, assignmentId)!;
    this.audit(
      agencyId,
      actorId,
      "assignment.status_changed",
      "assignment",
      assignmentId,
      before,
      after,
    );
    return after;
  }

  addTimeEntry(
    agencyId: string,
    input: Omit<TimeEntry, "id" | "agencyId" | "createdAt"> & { id?: string },
    actorId?: string,
  ): TimeEntry {
    assertAgencyId(agencyId);
    assertNumber("hours", input.hours, 0.01, 24);
    if (!this.getWorker(agencyId, input.workerId)) throw new Error("worker not found in agency");
    if (!this.getAssignment(agencyId, input.assignmentId))
      throw new Error("assignment not found in agency");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn))
      throw new Error("occurredOn must be YYYY-MM-DD");
    const entry: TimeEntry = {
      ...input,
      id: input.id ?? randomUUID(),
      agencyId,
      createdAt: Date.now(),
    };
    this.db
      .prepare(`INSERT INTO wf_time_entries
      (id, agency_id, worker_id, assignment_id, hours, billable, note, occurred_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.id,
        agencyId,
        entry.workerId,
        entry.assignmentId,
        entry.hours,
        entry.billable ? 1 : 0,
        entry.note,
        entry.occurredOn,
        entry.createdAt,
      );
    this.audit(agencyId, actorId, "time.created", "time_entry", entry.id, null, entry);
    return entry;
  }

  addPerformanceReview(
    agencyId: string,
    input: Omit<PerformanceReview, "id" | "agencyId" | "createdAt"> & { id?: string },
    actorId?: string,
  ): PerformanceReview {
    assertAgencyId(agencyId);
    for (const [name, value] of [
      ["qualityScore", input.qualityScore],
      ["reliabilityScore", input.reliabilityScore],
      ["collaborationScore", input.collaborationScore],
    ] as const)
      assertNumber(name, value, 0, 100);
    if (!this.getWorker(agencyId, input.workerId)) throw new Error("worker not found in agency");
    const review: PerformanceReview = {
      ...input,
      id: input.id ?? randomUUID(),
      agencyId,
      createdAt: Date.now(),
    };
    this.db
      .prepare(`INSERT INTO wf_performance_reviews
      (id, agency_id, worker_id, reviewer_worker_id, period_start, period_end, quality_score,
       reliability_score, collaboration_score, goals_json, feedback, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        review.id,
        agencyId,
        review.workerId,
        review.reviewerWorkerId,
        review.periodStart,
        review.periodEnd,
        review.qualityScore,
        review.reliabilityScore,
        review.collaborationScore,
        JSON.stringify(review.goals),
        review.feedback,
        review.createdAt,
      );
    this.audit(agencyId, actorId, "performance.reviewed", "worker", review.workerId, null, review);
    return review;
  }

  addOutcomeMetric(
    agencyId: string,
    input: Omit<OutcomeMetric, "id" | "agencyId"> & { id?: string },
  ): OutcomeMetric {
    assertAgencyId(agencyId);
    if (!this.getWorker(agencyId, input.workerId)) throw new Error("worker not found in agency");
    const metric: OutcomeMetric = { ...input, id: input.id ?? randomUUID(), agencyId };
    this.db
      .prepare(`INSERT INTO wf_outcome_metrics
      (id, agency_id, worker_id, assignment_id, metric, value, target, unit, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        metric.id,
        agencyId,
        metric.workerId,
        metric.assignmentId,
        metric.metric,
        metric.value,
        metric.target,
        metric.unit,
        metric.recordedAt,
      );
    return metric;
  }

  getWorkerCapacity(
    agencyId: string,
    workerId: string,
    weekStart = this.currentWeekStart(),
  ): WorkerCapacity | null {
    const worker = this.getWorker(agencyId, workerId);
    if (!worker) return null;
    const allocated = this.db
      .prepare(`SELECT COALESCE(SUM(am.allocated_hours), 0) value
      FROM wf_assignment_members am JOIN wf_assignments a
        ON a.agency_id=am.agency_id AND a.id=am.assignment_id
      WHERE am.agency_id=? AND am.worker_id=? AND a.status IN ('planned','active','blocked','review')`)
      .get(agencyId, workerId) as { value: number };
    const weekEnd = this.addDays(weekStart, 7);
    const logged = this.db
      .prepare(`SELECT COALESCE(SUM(hours), 0) value FROM wf_time_entries
      WHERE agency_id=? AND worker_id=? AND occurred_on>=? AND occurred_on<?`)
      .get(agencyId, workerId, weekStart, weekEnd) as { value: number };
    const effective = (worker.weeklyCapacityHours * worker.availabilityPercent) / 100;
    const remaining = Math.max(0, effective - allocated.value);
    return {
      workerId,
      displayName: worker.displayName,
      type: worker.type,
      weeklyCapacityHours: worker.weeklyCapacityHours,
      effectiveCapacityHours: effective,
      allocatedHours: allocated.value,
      loggedHours: logged.value,
      remainingHours: remaining,
      utilizationPercent: effective ? Math.round((allocated.value / effective) * 1000) / 10 : 0,
      overAllocated: allocated.value > effective,
    };
  }

  getWorkloadSummary(agencyId: string, weekStart = this.currentWeekStart()): WorkerCapacity[] {
    return this.listWorkers(agencyId, { status: "active" }).map(
      (worker) => this.getWorkerCapacity(agencyId, worker.id, weekStart)!,
    );
  }

  getDepartmentCapacity(agencyId: string): DepartmentCapacity[] {
    const departments = new Map(this.listDepartments(agencyId).map((item) => [item.id, item.name]));
    const grouped = new Map<string | null, DepartmentCapacity>();
    for (const worker of this.listWorkers(agencyId, { status: "active" })) {
      const capacity = this.getWorkerCapacity(agencyId, worker.id)!;
      const current = grouped.get(worker.departmentId) ?? {
        departmentId: worker.departmentId,
        departmentName: worker.departmentId
          ? (departments.get(worker.departmentId) ?? "Unknown")
          : "Unassigned",
        headcount: 0,
        humanCount: 0,
        aiCount: 0,
        effectiveCapacityHours: 0,
        allocatedHours: 0,
        remainingHours: 0,
      };
      current.headcount += 1;
      current[worker.type === "human" ? "humanCount" : "aiCount"] += 1;
      current.effectiveCapacityHours += capacity.effectiveCapacityHours;
      current.allocatedHours += capacity.allocatedHours;
      current.remainingHours += capacity.remainingHours;
      grouped.set(worker.departmentId, current);
    }
    return [...grouped.values()];
  }

  getDailyRoster(agencyId: string, weekStart = this.currentWeekStart()): DailyRosterEntry[] {
    return this.listWorkers(agencyId, { status: "active" }).map((worker) => {
      const capacity = this.getWorkerCapacity(agencyId, worker.id, weekStart)!;
      const count = this.db
        .prepare(`SELECT COUNT(*) value FROM wf_assignment_members am
        JOIN wf_assignments a ON a.agency_id=am.agency_id AND a.id=am.assignment_id
        WHERE am.agency_id=? AND am.worker_id=? AND a.status IN ('active','blocked','review')`)
        .get(agencyId, worker.id) as { value: number };
      return {
        ...capacity,
        title: worker.title,
        timezone: worker.timezone,
        currentStatus: worker.currentStatus,
        lastHeartbeatAt: worker.lastHeartbeatAt,
        activeAssignments: count.value,
      };
    });
  }

  getPerformanceScorecards(agencyId: string): PerformanceScorecard[] {
    return this.listWorkers(agencyId).map((worker) => {
      const reviews = this.db
        .prepare(`SELECT COUNT(*) review_count, AVG(quality_score) quality,
        AVG(reliability_score) reliability, AVG(collaboration_score) collaboration
        FROM wf_performance_reviews WHERE agency_id=? AND worker_id=?`)
        .get(agencyId, worker.id) as Row;
      const metrics = this.db
        .prepare(`SELECT AVG(CASE WHEN target IS NOT NULL AND target != 0
        THEN value / target * 100 END) attainment FROM wf_outcome_metrics
        WHERE agency_id=? AND worker_id=?`)
        .get(agencyId, worker.id) as Row;
      const time = this.db
        .prepare(
          "SELECT COALESCE(SUM(hours),0) value FROM wf_time_entries WHERE agency_id=? AND worker_id=?",
        )
        .get(agencyId, worker.id) as { value: number };
      const completed = this.db
        .prepare(`SELECT COUNT(*) value FROM wf_assignment_members am
        JOIN wf_assignments a ON a.agency_id=am.agency_id AND a.id=am.assignment_id
        WHERE am.agency_id=? AND am.worker_id=? AND a.status='completed'`)
        .get(agencyId, worker.id) as { value: number };
      return {
        workerId: worker.id,
        displayName: worker.displayName,
        reviewCount: Number(reviews.review_count),
        qualityScore: reviews.quality == null ? null : Number(reviews.quality),
        reliabilityScore: reviews.reliability == null ? null : Number(reviews.reliability),
        collaborationScore: reviews.collaboration == null ? null : Number(reviews.collaboration),
        outcomeAttainmentPercent: metrics.attainment == null ? null : Number(metrics.attainment),
        loggedHours: time.value,
        completedAssignments: completed.value,
      };
    });
  }

  listAuditEntries(agencyId: string, limit = 100): AuditEntry[] {
    assertAgencyId(agencyId);
    return (
      this.db
        .prepare(
          "SELECT * FROM wf_audit_entries WHERE agency_id=? ORDER BY created_at DESC LIMIT ?",
        )
        .all(agencyId, limit) as Row[]
    ).map((row) => ({
      id: String(row.id),
      agencyId: String(row.agency_id),
      actorId: row.actor_id ? String(row.actor_id) : null,
      action: String(row.action),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      before: json(row.before_json, null),
      after: json(row.after_json, null),
      createdAt: Number(row.created_at),
    }));
  }

  /**
   * Append one audit entry from outside this store — used by the SOP layer,
   * whose rows live in `WorkforceSopStore` but belong on the same agency audit
   * trail as workers and work items.
   *
   * Callers MUST only call this for a genuine mutation. A past bug wrote an
   * audit row per entity per run and grew this database to 633 MB; nothing
   * here is written on a read or on a no-op write.
   */
  recordAudit(
    agencyId: string,
    actorId: string | undefined,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): void {
    assertAgencyId(agencyId);
    this.audit(agencyId, actorId, action, entityType, entityId, before, after);
  }

  private replaceSkills(agencyId: string, workerId: string, skills: WorkerSkill[]): void {
    this.db
      .prepare("DELETE FROM wf_worker_skills WHERE agency_id=? AND worker_id=?")
      .run(agencyId, workerId);
    const statement = this.db.prepare(`INSERT INTO wf_worker_skills
      (agency_id, worker_id, skill, level, years_experience, verified_at) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const skill of skills) {
      assertNumber("skill level", skill.level, 1, 5);
      statement.run(
        agencyId,
        workerId,
        skill.skill.trim(),
        skill.level,
        skill.yearsExperience,
        skill.verifiedAt,
      );
    }
  }

  private insertAssignmentMember(
    agencyId: string,
    assignmentId: string,
    member: AssignmentMember,
  ): void {
    this.db
      .prepare(`INSERT INTO wf_assignment_members
      (agency_id, assignment_id, worker_id, role, allocated_hours) VALUES (?, ?, ?, ?, ?)`)
      .run(agencyId, assignmentId, member.workerId, member.role, member.allocatedHours);
  }

  private audit(
    agencyId: string,
    actorId: string | undefined,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): void {
    this.db
      .prepare(`INSERT INTO wf_audit_entries
      (id, agency_id, actor_id, action, entity_type, entity_id, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        randomUUID(),
        agencyId,
        actorId ?? null,
        action,
        entityType,
        entityId,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        Date.now(),
      );
  }

  private departmentFromRow(row: Row): Department {
    return {
      id: String(row.id),
      agencyId: String(row.agency_id),
      name: String(row.name),
      description: String(row.description),
      managerWorkerId: row.manager_worker_id ? String(row.manager_worker_id) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private workerFromRow(row: Row): Worker {
    const agencyId = String(row.agency_id);
    const id = String(row.id);
    const skills = this.db
      .prepare("SELECT * FROM wf_worker_skills WHERE agency_id=? AND worker_id=? ORDER BY skill")
      .all(agencyId, id) as Row[];
    return {
      id,
      agencyId,
      type: row.type as Worker["type"],
      displayName: String(row.display_name),
      email: row.email ? String(row.email) : null,
      title: String(row.title),
      departmentId: row.department_id ? String(row.department_id) : null,
      employmentStatus: row.employment_status as Worker["employmentStatus"],
      employmentType: row.employment_type as Worker["employmentType"],
      timezone: String(row.timezone),
      weeklyCapacityHours: Number(row.weekly_capacity_hours),
      availabilityPercent: Number(row.availability_percent),
      costRate: Number(row.cost_rate),
      currency: String(row.currency),
      agentId: row.agent_id ? String(row.agent_id) : null,
      modelBinding: row.model_binding ? String(row.model_binding) : null,
      persona: row.persona ? String(row.persona) : null,
      managerWorkerId: row.manager_worker_id ? String(row.manager_worker_id) : null,
      permissions: json(row.permissions_json, []),
      capabilities: json(row.capabilities_json, []),
      goals: json(row.goals_json, []),
      kpis: json(row.kpis_json, []),
      autonomyLevel: Number(row.autonomy_level) as Worker["autonomyLevel"],
      approvalThreshold: Number(row.approval_threshold),
      communicationCadence: String(row.communication_cadence),
      communicationProfile: json<CommunicationProfile | null>(row.communication_profile_json, null),
      executionProfile: json<WorkerExecutionProfile | null>(row.execution_profile_json, null),
      sopPath: row.sop_path ? String(row.sop_path) : null,
      workspacePath: row.workspace_path ? String(row.workspace_path) : null,
      currentStatus: String(row.current_status),
      lastHeartbeatAt: row.last_heartbeat_at == null ? null : Number(row.last_heartbeat_at),
      metadata: json(row.metadata_json, {}),
      skills: skills.map((skill) => ({
        skill: String(skill.skill),
        level: Number(skill.level) as WorkerSkill["level"],
        yearsExperience: Number(skill.years_experience),
        verifiedAt: skill.verified_at == null ? null : Number(skill.verified_at),
      })),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private assignmentFromRow(row: Row): Assignment {
    const agencyId = String(row.agency_id);
    const id = String(row.id);
    const members = this.db
      .prepare(
        "SELECT * FROM wf_assignment_members WHERE agency_id=? AND assignment_id=? ORDER BY role",
      )
      .all(agencyId, id) as Row[];
    return {
      id,
      agencyId,
      title: String(row.title),
      description: String(row.description),
      projectId: row.project_id ? String(row.project_id) : null,
      taskId: row.task_id ? String(row.task_id) : null,
      status: row.status as AssignmentStatus,
      priority: Number(row.priority),
      startsAt: row.starts_at == null ? null : Number(row.starts_at),
      dueAt: row.due_at == null ? null : Number(row.due_at),
      estimatedHours: Number(row.estimated_hours),
      requiredSkills: json(row.required_skills_json, []),
      requiredCapabilities: json(row.required_capabilities_json, []),
      members: members.map((member) => ({
        workerId: String(member.worker_id),
        role: member.role as AssignmentMember["role"],
        allocatedHours: Number(member.allocated_hours),
      })),
      createdBy: row.created_by ? String(row.created_by) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private currentWeekStart(): string {
    const date = new Date();
    const day = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
    return date.toISOString().slice(0, 10);
  }

  private addDays(isoDate: string, days: number): string {
    const date = new Date(`${isoDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
}
