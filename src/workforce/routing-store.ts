/**
 * Storage for automatic task routing: the decision made for each task, the
 * autostage policy that governs whether a routed card is handed to the
 * executor, and the first-run provisioning ledger.
 *
 * Follows `WorkforceOperatingStore` / `WorkforceSopStore` conventions exactly:
 * same agency.db file, plain `CREATE TABLE IF NOT EXISTS` (this family predates
 * the numbered `schema_migrations` owned by `AgencyOperationsStore`, so nothing
 * here moves `AGENCY_DATABASE_SCHEMA_VERSION`), `(agency_id, ...)` primary
 * keys, JSON columns for list-shaped fields.
 *
 * Every table carries `agency_id`, so federation replication picks them up
 * without any change to the exporter.
 *
 * ── IDEMPOTENCE IS A HARD REQUIREMENT ───────────────────────────────────────
 * This database was once grown to 633 MB by "idempotent" writes that were not.
 * `upsertDecision` compares every persisted field and returns `changed:false`
 * WITHOUT touching the row when nothing moved. A routing pass over an unchanged
 * agency must perform zero writes.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { TaskRoutingDecision, TaskRoutingOutcome } from "./task-routing.js";

type Row = Record<string, unknown>;

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

/**
 * How far the agency is willing to act without asking.
 *
 *  off       — route only. Nothing is ever staged; every card waits in Backlog.
 *  recommend — route and mark the card as recommended for staging, but leave it
 *              in Backlog. One click (or one batch call) stages it.
 *  auto      — route and stage. The employee's own `autonomyLevel` still
 *              governs the landing (0 never executes, 1 always lands in review,
 *              2 auto-completes under its approval threshold, 3 auto-completes).
 */
export type TaskAutostageMode = "off" | "recommend" | "auto";

export const TASK_AUTOSTAGE_MODES: TaskAutostageMode[] = ["off", "recommend", "auto"];

/**
 * The routing + autostage policy for one agency, plus any per-worker mode
 * overrides. Defaults are deliberately stated here rather than scattered:
 * `auto` is the default because an AI agency that needs a click per card is not
 * an AI agency — but every bound below is real and operator-editable.
 */
export type TaskRoutingPolicy = {
  agencyId: string;
  /** Master switch for the routing pass itself. */
  enabled: boolean;
  mode: TaskAutostageMode;
  /** Minimum blended confidence (0-1) required before a card may be staged. */
  minConfidence: number;
  /** Employees below this autonomy level are routed to but never auto-staged. */
  minAutonomyLevel: 0 | 1 | 2 | 3;
  /** Hard cap on cards moved into the execution stage in ONE pass. */
  maxAutoStagePerPass: number;
  /** Hard cap on cards auto-staged in any rolling 24 hours. */
  maxAutoStagePerDay: number;
  /** Minimum suitability score (0-100) before a worker may be assigned. */
  minScore: number;
  /** Minimum keyword evidence (0-1) before a task is considered understood. */
  minMatchStrength: number;
  /** Hard cap on assignments written in one pass. */
  maxAssignmentsPerPass: number;
  /** Hard cap on assignments given to a single worker in one pass. */
  maxTasksPerWorkerPerPass: number;
  /** Fraction of effective capacity deliberately left free (0-0.9). */
  capacityHeadroom: number;
  /** Hours charged against capacity for a task with no better estimate. */
  defaultEstimatedHours: number;
  /** Per-worker mode overrides, keyed by worker id. */
  workerModes: Record<string, TaskAutostageMode>;
  updatedAt: number;
};

export const DEFAULT_TASK_ROUTING_POLICY: Omit<TaskRoutingPolicy, "agencyId" | "updatedAt"> = {
  enabled: true,
  mode: "auto",
  minConfidence: 0.6,
  minAutonomyLevel: 2,
  maxAutoStagePerPass: 5,
  maxAutoStagePerDay: 25,
  minScore: 55,
  minMatchStrength: 0.25,
  // Bounds writes, not spend: an assignment is a row, not a coder run. Set high
  // enough that a 2,853-task backlog is triaged in ~12 ticks rather than ~57.
  // Spend is bounded separately by maxAutoStagePerPass/Day.
  maxAssignmentsPerPass: 250,
  maxTasksPerWorkerPerPass: 10,
  capacityHeadroom: 0.2,
  defaultEstimatedHours: 2,
  workerModes: {},
};

export type TaskRoutingPolicyPatch = Partial<
  Omit<TaskRoutingPolicy, "agencyId" | "updatedAt" | "workerModes">
> & { workerModes?: Record<string, TaskAutostageMode | null> };

/** A persisted routing decision, including everything needed to audit it. */
export type StoredRoutingDecision = TaskRoutingDecision & {
  /** `auto` = the router chose it. `operator` = a human overrode it. */
  decidedBy: "auto" | "operator";
  /** Operator decisions are pinned: the router never revisits them. */
  pinned: boolean;
  workItemId: string | null;
  stagedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;

const mode = (raw: unknown, fallback: TaskAutostageMode): TaskAutostageMode =>
  typeof raw === "string" && TASK_AUTOSTAGE_MODES.includes(raw as TaskAutostageMode)
    ? (raw as TaskAutostageMode)
    : fallback;

export class WorkforceRoutingStore {
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
      CREATE TABLE IF NOT EXISTS wf_task_routing_decisions (
        agency_id TEXT NOT NULL, task_id TEXT NOT NULL, project_id TEXT,
        task_title TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL,
        worker_id TEXT, worker_name TEXT, assignee_type TEXT,
        discipline TEXT, match_strength REAL NOT NULL DEFAULT 0,
        matched_terms_json TEXT NOT NULL DEFAULT '[]',
        score REAL NOT NULL DEFAULT 0, skill_coverage REAL NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0,
        matched_skills_json TEXT NOT NULL DEFAULT '[]',
        missing_skills_json TEXT NOT NULL DEFAULT '[]',
        estimated_hours REAL NOT NULL DEFAULT 0,
        runner_up_worker_id TEXT, runner_up_worker_name TEXT, runner_up_score REAL,
        rationale TEXT NOT NULL DEFAULT '',
        needs_human INTEGER NOT NULL DEFAULT 0,
        auto_staged INTEGER NOT NULL DEFAULT 0,
        stage_recommended INTEGER NOT NULL DEFAULT 0,
        stage_reason TEXT NOT NULL DEFAULT '',
        work_item_id TEXT, staged_at INTEGER,
        decided_by TEXT NOT NULL DEFAULT 'auto',
        pinned INTEGER NOT NULL DEFAULT 0,
        signature TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(agency_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wf_routing_worker
        ON wf_task_routing_decisions(agency_id, worker_id, outcome);
      CREATE INDEX IF NOT EXISTS idx_wf_routing_attention
        ON wf_task_routing_decisions(agency_id, needs_human, updated_at);
      CREATE INDEX IF NOT EXISTS idx_wf_routing_staged
        ON wf_task_routing_decisions(agency_id, auto_staged, staged_at);

      CREATE TABLE IF NOT EXISTS wf_routing_policy (
        agency_id TEXT NOT NULL, scope TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'auto',
        min_confidence REAL NOT NULL DEFAULT 0.6,
        min_autonomy_level INTEGER NOT NULL DEFAULT 2,
        max_auto_stage_per_pass INTEGER NOT NULL DEFAULT 5,
        max_auto_stage_per_day INTEGER NOT NULL DEFAULT 25,
        min_score REAL NOT NULL DEFAULT 55,
        min_match_strength REAL NOT NULL DEFAULT 0.25,
        max_assignments_per_pass INTEGER NOT NULL DEFAULT 50,
        max_tasks_per_worker_per_pass INTEGER NOT NULL DEFAULT 10,
        capacity_headroom REAL NOT NULL DEFAULT 0.2,
        default_estimated_hours REAL NOT NULL DEFAULT 2,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(agency_id, scope)
      );

      CREATE TABLE IF NOT EXISTS wf_agency_provisioning (
        agency_id TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}', applied_at INTEGER NOT NULL,
        PRIMARY KEY(agency_id, key)
      );
    `);
  }

  // ── Policy ────────────────────────────────────────────────────────────────

  /**
   * The effective policy for one agency. Reading never writes: an agency with
   * no row simply gets the defaults, so merely opening the UI cannot dirty
   * agency.db.
   */
  getPolicy(agencyId: string): TaskRoutingPolicy {
    requireAgency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_routing_policy WHERE agency_id=? AND scope='agency'")
      .get(agencyId) as Row | undefined;
    const workerModes: Record<string, TaskAutostageMode> = {};
    for (const override of this.db
      .prepare("SELECT scope, mode FROM wf_routing_policy WHERE agency_id=? AND scope<>'agency'")
      .all(agencyId) as Row[]) {
      workerModes[String(override.scope)] = mode(override.mode, DEFAULT_TASK_ROUTING_POLICY.mode);
    }
    if (!row) {
      return {
        agencyId,
        ...DEFAULT_TASK_ROUTING_POLICY,
        workerModes,
        updatedAt: 0,
      };
    }
    return {
      agencyId,
      enabled: Boolean(row.enabled),
      mode: mode(row.mode, DEFAULT_TASK_ROUTING_POLICY.mode),
      minConfidence: clamp(Number(row.min_confidence), 0, 1),
      minAutonomyLevel: clamp(Number(row.min_autonomy_level), 0, 3) as 0 | 1 | 2 | 3,
      maxAutoStagePerPass: clamp(Number(row.max_auto_stage_per_pass), 0, 50),
      maxAutoStagePerDay: clamp(Number(row.max_auto_stage_per_day), 0, 500),
      minScore: clamp(Number(row.min_score), 0, 100),
      minMatchStrength: clamp(Number(row.min_match_strength), 0, 1),
      maxAssignmentsPerPass: clamp(Number(row.max_assignments_per_pass), 1, 500),
      maxTasksPerWorkerPerPass: clamp(Number(row.max_tasks_per_worker_per_pass), 1, 200),
      capacityHeadroom: clamp(Number(row.capacity_headroom), 0, 0.9),
      defaultEstimatedHours: clamp(Number(row.default_estimated_hours), 0.25, 40),
      workerModes,
      updatedAt: Number(row.updated_at),
    };
  }

  /** Merge a patch into the agency policy. A no-op patch writes nothing. */
  setPolicy(agencyId: string, patch: TaskRoutingPolicyPatch, now = Date.now()): TaskRoutingPolicy {
    requireAgency(agencyId);
    const before = this.getPolicy(agencyId);
    const next: TaskRoutingPolicy = {
      ...before,
      enabled: patch.enabled ?? before.enabled,
      mode: patch.mode ? mode(patch.mode, before.mode) : before.mode,
      minConfidence: clamp(patch.minConfidence ?? before.minConfidence, 0, 1),
      minAutonomyLevel: clamp(patch.minAutonomyLevel ?? before.minAutonomyLevel, 0, 3) as
        | 0
        | 1
        | 2
        | 3,
      maxAutoStagePerPass: clamp(patch.maxAutoStagePerPass ?? before.maxAutoStagePerPass, 0, 50),
      maxAutoStagePerDay: clamp(patch.maxAutoStagePerDay ?? before.maxAutoStagePerDay, 0, 500),
      minScore: clamp(patch.minScore ?? before.minScore, 0, 100),
      minMatchStrength: clamp(patch.minMatchStrength ?? before.minMatchStrength, 0, 1),
      maxAssignmentsPerPass: clamp(
        patch.maxAssignmentsPerPass ?? before.maxAssignmentsPerPass,
        1,
        500,
      ),
      maxTasksPerWorkerPerPass: clamp(
        patch.maxTasksPerWorkerPerPass ?? before.maxTasksPerWorkerPerPass,
        1,
        200,
      ),
      capacityHeadroom: clamp(patch.capacityHeadroom ?? before.capacityHeadroom, 0, 0.9),
      defaultEstimatedHours: clamp(
        patch.defaultEstimatedHours ?? before.defaultEstimatedHours,
        0.25,
        40,
      ),
      updatedAt: now,
    };

    const agencyChanged =
      before.updatedAt === 0 ||
      JSON.stringify({ ...before, updatedAt: 0, workerModes: {} }) !==
        JSON.stringify({ ...next, updatedAt: 0, workerModes: {} });
    if (agencyChanged) {
      this.db
        .prepare(`INSERT INTO wf_routing_policy
          (agency_id,scope,enabled,mode,min_confidence,min_autonomy_level,max_auto_stage_per_pass,
           max_auto_stage_per_day,min_score,min_match_strength,max_assignments_per_pass,
           max_tasks_per_worker_per_pass,capacity_headroom,default_estimated_hours,created_at,updated_at)
          VALUES(?,'agency',?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(agency_id,scope) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode,
            min_confidence=excluded.min_confidence,min_autonomy_level=excluded.min_autonomy_level,
            max_auto_stage_per_pass=excluded.max_auto_stage_per_pass,
            max_auto_stage_per_day=excluded.max_auto_stage_per_day,min_score=excluded.min_score,
            min_match_strength=excluded.min_match_strength,
            max_assignments_per_pass=excluded.max_assignments_per_pass,
            max_tasks_per_worker_per_pass=excluded.max_tasks_per_worker_per_pass,
            capacity_headroom=excluded.capacity_headroom,
            default_estimated_hours=excluded.default_estimated_hours,updated_at=excluded.updated_at`)
        .run(
          agencyId,
          next.enabled ? 1 : 0,
          next.mode,
          next.minConfidence,
          next.minAutonomyLevel,
          next.maxAutoStagePerPass,
          next.maxAutoStagePerDay,
          next.minScore,
          next.minMatchStrength,
          next.maxAssignmentsPerPass,
          next.maxTasksPerWorkerPerPass,
          next.capacityHeadroom,
          next.defaultEstimatedHours,
          now,
          now,
        );
    }

    for (const [workerId, value] of Object.entries(patch.workerModes ?? {})) {
      if (value === null) {
        this.db
          .prepare("DELETE FROM wf_routing_policy WHERE agency_id=? AND scope=?")
          .run(agencyId, workerId);
        continue;
      }
      if (before.workerModes[workerId] === value) continue;
      this.db
        .prepare(`INSERT INTO wf_routing_policy (agency_id,scope,mode,created_at,updated_at)
          VALUES(?,?,?,?,?)
          ON CONFLICT(agency_id,scope) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at`)
        .run(agencyId, workerId, value, now, now);
    }

    return this.getPolicy(agencyId);
  }

  // ── Decisions ─────────────────────────────────────────────────────────────

  getDecision(agencyId: string, taskId: string): StoredRoutingDecision | null {
    requireAgency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM wf_task_routing_decisions WHERE agency_id=? AND task_id=?")
      .get(agencyId, taskId) as Row | undefined;
    return row ? this.decision(row) : null;
  }

  /** Every decision for the agency, keyed by task id. One query, one pass. */
  decisionIndex(agencyId: string): Map<string, StoredRoutingDecision> {
    requireAgency(agencyId);
    const rows = this.db
      .prepare("SELECT * FROM wf_task_routing_decisions WHERE agency_id=?")
      .all(agencyId) as Row[];
    return new Map(rows.map((row) => [String(row.task_id), this.decision(row)]));
  }

  listDecisions(
    agencyId: string,
    filters: {
      workerId?: string;
      outcome?: TaskRoutingOutcome;
      needsHuman?: boolean;
      stageRecommended?: boolean;
      autoStaged?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): StoredRoutingDecision[] {
    requireAgency(agencyId);
    let sql = "SELECT * FROM wf_task_routing_decisions WHERE agency_id=?";
    const params: unknown[] = [agencyId];
    if (filters.workerId) {
      sql += " AND worker_id=?";
      params.push(filters.workerId);
    }
    if (filters.outcome) {
      sql += " AND outcome=?";
      params.push(filters.outcome);
    }
    if (filters.needsHuman !== undefined) {
      sql += " AND needs_human=?";
      params.push(filters.needsHuman ? 1 : 0);
    }
    if (filters.stageRecommended !== undefined) {
      sql += " AND stage_recommended=?";
      params.push(filters.stageRecommended ? 1 : 0);
    }
    if (filters.autoStaged !== undefined) {
      sql += " AND auto_staged=?";
      params.push(filters.autoStaged ? 1 : 0);
    }
    sql += " ORDER BY updated_at DESC, task_id LIMIT ? OFFSET ?";
    params.push(Math.max(1, Math.min(500, filters.limit ?? 100)));
    params.push(Math.max(0, filters.offset ?? 0));
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.decision(row));
  }

  countDecisions(agencyId: string): {
    total: number;
    assigned: number;
    unmatched: number;
    unassigned: number;
    needsHuman: number;
    stageRecommended: number;
    autoStaged: number;
  } {
    requireAgency(agencyId);
    const row = this.db
      .prepare(`SELECT
          COUNT(*) total,
          SUM(CASE WHEN outcome='assigned' THEN 1 ELSE 0 END) assigned,
          SUM(CASE WHEN outcome='unmatched' THEN 1 ELSE 0 END) unmatched,
          SUM(CASE WHEN outcome='unassigned' THEN 1 ELSE 0 END) unassigned,
          SUM(CASE WHEN needs_human=1 THEN 1 ELSE 0 END) needs_human,
          SUM(CASE WHEN stage_recommended=1 THEN 1 ELSE 0 END) stage_recommended,
          SUM(CASE WHEN auto_staged=1 THEN 1 ELSE 0 END) auto_staged
        FROM wf_task_routing_decisions WHERE agency_id=?`)
      .get(agencyId) as Row;
    return {
      total: Number(row.total ?? 0),
      assigned: Number(row.assigned ?? 0),
      unmatched: Number(row.unmatched ?? 0),
      unassigned: Number(row.unassigned ?? 0),
      needsHuman: Number(row.needs_human ?? 0),
      stageRecommended: Number(row.stage_recommended ?? 0),
      autoStaged: Number(row.auto_staged ?? 0),
    };
  }

  /** Cards auto-staged since `since` — the rolling daily spend guard. */
  countAutoStagedSince(agencyId: string, since: number): number {
    requireAgency(agencyId);
    return this.db
      .prepare(
        `SELECT COUNT(*) FROM wf_task_routing_decisions
           WHERE agency_id=? AND auto_staged=1 AND staged_at IS NOT NULL AND staged_at>=?`,
      )
      .pluck()
      .get(agencyId, since) as number;
  }

  /**
   * Write a decision. Returns `changed:false` and touches nothing when the
   * stored row is already identical — the property the whole incremental
   * design rests on.
   */
  upsertDecision(
    agencyId: string,
    decision: TaskRoutingDecision,
    options: {
      decidedBy?: "auto" | "operator";
      pinned?: boolean;
      workItemId?: string | null;
      stagedAt?: number | null;
      autoStaged?: boolean;
      now?: number;
    } = {},
  ): { decision: StoredRoutingDecision; changed: boolean } {
    requireAgency(agencyId);
    const now = options.now ?? Date.now();
    const before = this.getDecision(agencyId, decision.taskId);
    const next: StoredRoutingDecision = {
      ...decision,
      agencyId,
      decidedBy: options.decidedBy ?? before?.decidedBy ?? "auto",
      pinned: options.pinned ?? before?.pinned ?? false,
      workItemId:
        options.workItemId === undefined ? (before?.workItemId ?? null) : options.workItemId,
      stagedAt: options.stagedAt === undefined ? (before?.stagedAt ?? null) : options.stagedAt,
      autoStaged: options.autoStaged ?? decision.autoStaged,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
    };
    if (before && this.fingerprint(before) === this.fingerprint(next)) {
      return { decision: before, changed: false };
    }
    this.db
      .prepare(`INSERT INTO wf_task_routing_decisions
        (agency_id,task_id,project_id,task_title,outcome,worker_id,worker_name,assignee_type,
         discipline,match_strength,matched_terms_json,score,skill_coverage,confidence,
         matched_skills_json,missing_skills_json,estimated_hours,runner_up_worker_id,
         runner_up_worker_name,runner_up_score,rationale,needs_human,auto_staged,stage_recommended,
         stage_reason,work_item_id,staged_at,decided_by,pinned,signature,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agency_id,task_id) DO UPDATE SET project_id=excluded.project_id,
          task_title=excluded.task_title,outcome=excluded.outcome,worker_id=excluded.worker_id,
          worker_name=excluded.worker_name,assignee_type=excluded.assignee_type,
          discipline=excluded.discipline,match_strength=excluded.match_strength,
          matched_terms_json=excluded.matched_terms_json,score=excluded.score,
          skill_coverage=excluded.skill_coverage,confidence=excluded.confidence,
          matched_skills_json=excluded.matched_skills_json,
          missing_skills_json=excluded.missing_skills_json,estimated_hours=excluded.estimated_hours,
          runner_up_worker_id=excluded.runner_up_worker_id,
          runner_up_worker_name=excluded.runner_up_worker_name,
          runner_up_score=excluded.runner_up_score,rationale=excluded.rationale,
          needs_human=excluded.needs_human,auto_staged=excluded.auto_staged,
          stage_recommended=excluded.stage_recommended,stage_reason=excluded.stage_reason,
          work_item_id=excluded.work_item_id,staged_at=excluded.staged_at,
          decided_by=excluded.decided_by,pinned=excluded.pinned,signature=excluded.signature,
          updated_at=excluded.updated_at`)
      .run(
        agencyId,
        next.taskId,
        next.projectId,
        next.taskTitle,
        next.outcome,
        next.workerId,
        next.workerName,
        next.assigneeType,
        next.discipline,
        next.matchStrength,
        JSON.stringify(next.matchedTerms),
        next.score,
        next.skillCoverage,
        next.confidence,
        JSON.stringify(next.matchedSkills),
        JSON.stringify(next.missingSkills),
        next.estimatedHours,
        next.runnerUp?.workerId ?? null,
        next.runnerUp?.workerName ?? null,
        next.runnerUp?.score ?? null,
        next.rationale,
        next.needsHuman ? 1 : 0,
        next.autoStaged ? 1 : 0,
        next.stageRecommended ? 1 : 0,
        next.stageReason,
        next.workItemId,
        next.stagedAt,
        next.decidedBy,
        next.pinned ? 1 : 0,
        next.signature,
        next.createdAt,
        next.updatedAt,
      );
    return { decision: next, changed: true };
  }

  deleteDecision(agencyId: string, taskId: string): boolean {
    requireAgency(agencyId);
    return (
      this.db
        .prepare("DELETE FROM wf_task_routing_decisions WHERE agency_id=? AND task_id=?")
        .run(agencyId, taskId).changes > 0
    );
  }

  // ── Provisioning ledger ───────────────────────────────────────────────────

  /** The applied version of one provisioning step, or 0 when never applied. */
  getProvisionedVersion(agencyId: string, key: string): number {
    requireAgency(agencyId);
    return (
      (this.db
        .prepare("SELECT version FROM wf_agency_provisioning WHERE agency_id=? AND key=?")
        .pluck()
        .get(agencyId, key) as number | undefined) ?? 0
    );
  }

  recordProvisioned(
    agencyId: string,
    key: string,
    version: number,
    detail: Record<string, unknown> = {},
    now = Date.now(),
  ): void {
    requireAgency(agencyId);
    this.db
      .prepare(`INSERT INTO wf_agency_provisioning (agency_id,key,version,detail_json,applied_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(agency_id,key) DO UPDATE SET version=excluded.version,
          detail_json=excluded.detail_json,applied_at=excluded.applied_at`)
      .run(agencyId, key, version, JSON.stringify(detail), now);
  }

  listProvisioning(agencyId: string): Array<{
    key: string;
    version: number;
    detail: Record<string, unknown>;
    appliedAt: number;
  }> {
    requireAgency(agencyId);
    return (
      this.db
        .prepare("SELECT * FROM wf_agency_provisioning WHERE agency_id=? ORDER BY key")
        .all(agencyId) as Row[]
    ).map((row) => ({
      key: String(row.key),
      version: Number(row.version),
      detail: parse(row.detail_json, {}),
      appliedAt: Number(row.applied_at),
    }));
  }

  /**
   * Everything that identifies a row's content, timestamps excluded.
   *
   * Key order is normalised deliberately: a decision built by the planner and
   * one read back from SQLite carry the same fields in a different declaration
   * order, and a naive `JSON.stringify` would call every identical row
   * "changed" — silently rewriting thousands of rows on every 15-minute tick.
   */
  private fingerprint(value: StoredRoutingDecision): string {
    const normalised = { ...value, updatedAt: 0, createdAt: 0 } as Record<string, unknown>;
    return JSON.stringify(
      Object.keys(normalised)
        .sort()
        .map((key) => [key, normalised[key]]),
    );
  }

  private decision(row: Row): StoredRoutingDecision {
    return {
      agencyId: String(row.agency_id),
      taskId: String(row.task_id),
      projectId: row.project_id ? String(row.project_id) : null,
      taskTitle: String(row.task_title),
      outcome: String(row.outcome) as TaskRoutingOutcome,
      workerId: row.worker_id ? String(row.worker_id) : null,
      workerName: row.worker_name ? String(row.worker_name) : null,
      assigneeType: row.assignee_type ? (String(row.assignee_type) as "ai" | "human") : null,
      discipline: row.discipline ? String(row.discipline) : null,
      matchStrength: Number(row.match_strength),
      matchedTerms: parse(row.matched_terms_json, [] as string[]),
      score: Number(row.score),
      skillCoverage: Number(row.skill_coverage),
      confidence: Number(row.confidence),
      matchedSkills: parse(row.matched_skills_json, [] as string[]),
      missingSkills: parse(row.missing_skills_json, [] as string[]),
      estimatedHours: Number(row.estimated_hours),
      runnerUp: row.runner_up_worker_id
        ? {
            workerId: String(row.runner_up_worker_id),
            workerName: row.runner_up_worker_name ? String(row.runner_up_worker_name) : null,
            score: Number(row.runner_up_score ?? 0),
          }
        : null,
      rationale: String(row.rationale),
      needsHuman: Boolean(row.needs_human),
      autoStaged: Boolean(row.auto_staged),
      stageRecommended: Boolean(row.stage_recommended),
      stageReason: String(row.stage_reason),
      signature: String(row.signature),
      decidedBy: String(row.decided_by) as "auto" | "operator",
      pinned: Boolean(row.pinned),
      workItemId: row.work_item_id ? String(row.work_item_id) : null,
      stagedAt: row.staged_at == null ? null : Number(row.staged_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
