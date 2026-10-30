/**
 * Goal-run store — lives in the persistent queue database
 * (`<stateDir>/queue.db`, see src/queue/store.ts) so goal runs and queue
 * entries share one durable file and survive gateway restarts together.
 *
 * Tables:
 *   goal_runs           one row per run; iterations + lastResults are JSON
 *   goal_check_results  append-only pass/fail history per check
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { resolveStateDir } from "../../config/paths.js";
import {
  DEFAULT_GOAL_LIMITS,
  type CreateGoalInput,
  type GoalAgentTarget,
  type GoalCheck,
  type GoalCheckResult,
  type GoalIteration,
  type GoalLimits,
  type GoalRun,
  type GoalRunStatus,
} from "./types.js";

interface GoalRow {
  id: string;
  title: string;
  goal: string;
  checks: string;
  target: string;
  workdir: string | null;
  project_id: string | null;
  limits: string;
  status: string;
  reason: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
  elapsed_ms: number;
  active_since: number | null;
  iterations: string;
  last_results: string;
  pending_instruction: string | null;
  session_id: string | null;
  last_check_at: number | null;
  created_by: string | null;
  notify: number;
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToRun(r: GoalRow): GoalRun {
  return {
    id: r.id,
    title: r.title,
    goal: r.goal,
    checks: parseJson<GoalCheck[]>(r.checks, []),
    target: parseJson<GoalAgentTarget>(r.target, { kind: "cli", backend: "claude-code" }),
    workdir: r.workdir,
    projectId: r.project_id,
    limits: { ...DEFAULT_GOAL_LIMITS, ...parseJson<Partial<GoalLimits>>(r.limits, {}) },
    status: r.status as GoalRunStatus,
    reason: r.reason,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
    elapsedMs: r.elapsed_ms,
    activeSince: r.active_since,
    iterations: parseJson<GoalIteration[]>(r.iterations, []),
    lastResults: parseJson<Record<string, GoalCheckResult>>(r.last_results, {}),
    pendingInstruction: r.pending_instruction,
    sessionId: r.session_id,
    lastCheckAt: r.last_check_at,
    createdBy: r.created_by,
    notify: r.notify !== 0,
  };
}

export function clampLimits(input: Partial<GoalLimits> | undefined): GoalLimits {
  const num = (v: unknown, def: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def;
  const l = input ?? {};
  return {
    maxIterations: num(l.maxIterations, DEFAULT_GOAL_LIMITS.maxIterations, 1, 100),
    maxWallClockSec: num(l.maxWallClockSec, DEFAULT_GOAL_LIMITS.maxWallClockSec, 10, 7 * 86_400),
    iterationTimeoutSec: num(
      l.iterationTimeoutSec,
      DEFAULT_GOAL_LIMITS.iterationTimeoutSec,
      5,
      24 * 3600,
    ),
    checkIntervalSec: num(l.checkIntervalSec, DEFAULT_GOAL_LIMITS.checkIntervalSec, 0, 24 * 3600),
    hangSec: num(l.hangSec, DEFAULT_GOAL_LIMITS.hangSec, 0, 24 * 3600),
  };
}

export class GoalStore {
  readonly db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "queue.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_runs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        checks TEXT NOT NULL,
        target TEXT NOT NULL,
        workdir TEXT,
        project_id TEXT,
        limits TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        active_since INTEGER,
        iterations TEXT NOT NULL DEFAULT '[]',
        last_results TEXT NOT NULL DEFAULT '{}',
        pending_instruction TEXT,
        session_id TEXT,
        last_check_at INTEGER,
        created_by TEXT,
        notify INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_goal_runs_status ON goal_runs(status);
      CREATE TABLE IF NOT EXISTS goal_check_results (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        pass INTEGER NOT NULL,
        output TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_checks_goal ON goal_check_results(goal_id, at);
    `);
  }

  create(input: CreateGoalInput & { checks: GoalCheck[] }): GoalRun {
    const id = `goal_${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const goal = input.goal.trim();
    const title = (input.title?.trim() || goal.split("\n")[0]).slice(0, 120);
    this.db
      .prepare(
        `INSERT INTO goal_runs (id, title, goal, checks, target, workdir, project_id, limits,
          status, created_at, updated_at, created_by, notify)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        goal,
        JSON.stringify(input.checks),
        JSON.stringify(input.target),
        input.workdir ?? null,
        input.projectId ?? null,
        JSON.stringify(clampLimits(input.limits)),
        input.start === false ? "paused" : "queued",
        now,
        now,
        input.createdBy ?? null,
        input.notify === false ? 0 : 1,
      );
    return this.get(id)!;
  }

  get(id: string): GoalRun | null {
    const row = this.db.prepare("SELECT * FROM goal_runs WHERE id = ?").get(id) as
      | GoalRow
      | undefined;
    return row ? rowToRun(row) : null;
  }

  list(filter?: { status?: GoalRunStatus[]; limit?: number }): GoalRun[] {
    const limit = Math.max(1, Math.min(500, filter?.limit ?? 200));
    if (filter?.status?.length) {
      const qs = filter.status.map(() => "?").join(",");
      return (
        this.db
          .prepare(
            `SELECT * FROM goal_runs WHERE status IN (${qs}) ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...filter.status, limit) as GoalRow[]
      ).map(rowToRun);
    }
    return (
      this.db
        .prepare("SELECT * FROM goal_runs ORDER BY created_at DESC LIMIT ?")
        .all(limit) as GoalRow[]
    ).map(rowToRun);
  }

  /** Persist the mutable fields of a run (whole-row write; runs are small). */
  save(run: GoalRun): GoalRun {
    run.updatedAt = Date.now();
    this.db
      .prepare(
        `UPDATE goal_runs SET title=?, goal=?, checks=?, target=?, workdir=?, limits=?, status=?,
          reason=?, started_at=?, finished_at=?, updated_at=?, elapsed_ms=?, active_since=?, iterations=?,
          last_results=?, pending_instruction=?, session_id=?, last_check_at=?, notify=?
         WHERE id=?`,
      )
      .run(
        run.title,
        run.goal,
        JSON.stringify(run.checks),
        JSON.stringify(run.target),
        run.workdir,
        JSON.stringify(run.limits),
        run.status,
        run.reason,
        run.startedAt,
        run.finishedAt,
        run.updatedAt,
        run.elapsedMs,
        run.activeSince,
        JSON.stringify(run.iterations),
        JSON.stringify(run.lastResults),
        run.pendingInstruction,
        run.sessionId,
        run.lastCheckAt,
        run.notify ? 1 : 0,
        run.id,
      );
    return run;
  }

  recordResults(goalId: string, results: GoalCheckResult[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO goal_check_results (goal_id, check_id, iteration, trigger, pass, output, duration_ms, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: GoalCheckResult[]) => {
      for (const r of rows) {
        stmt.run(
          goalId,
          r.checkId,
          r.iteration,
          r.trigger,
          r.pass ? 1 : 0,
          r.output,
          r.durationMs,
          r.at,
        );
      }
    });
    tx(results);
  }

  checkHistory(goalId: string, limit = 300): GoalCheckResult[] {
    const rows = this.db
      .prepare("SELECT * FROM goal_check_results WHERE goal_id = ? ORDER BY seq DESC LIMIT ?")
      .all(goalId, limit) as Array<{
      check_id: string;
      iteration: number;
      trigger: string;
      pass: number;
      output: string;
      duration_ms: number;
      at: number;
    }>;
    return rows.reverse().map((r) => ({
      checkId: r.check_id,
      iteration: r.iteration,
      trigger: r.trigger as GoalCheckResult["trigger"],
      pass: r.pass !== 0,
      output: r.output,
      durationMs: r.duration_ms,
      at: r.at,
    }));
  }

  delete(id: string): boolean {
    this.db.prepare("DELETE FROM goal_check_results WHERE goal_id = ?").run(id);
    return this.db.prepare("DELETE FROM goal_runs WHERE id = ?").run(id).changes > 0;
  }
}

let _instance: GoalStore | null = null;

export function getGoalStore(stateDir: string = resolveStateDir()): GoalStore {
  if (!_instance) _instance = new GoalStore(stateDir);
  return _instance;
}

export function resetGoalStoreForTests(): void {
  _instance = null;
}
