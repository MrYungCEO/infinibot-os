/**
 * Scheduled-task store — tables in the persistent queue database
 * (`<stateDir>/queue.db`), next to `goal_runs`, so a task, its runs, the
 * pipeline items and the goal runs driving them survive restarts together.
 *
 *   sched_tasks   task definitions (+ nextRunAt bookkeeping)
 *   sched_runs    one row per fired run (report JSON, delivery state)
 *   sched_items   one row per suggested work item (pipeline stage)
 *   sched_events  append-only stage-transition log
 *   sched_meta    key/value (seed markers)
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { resolveStateDir } from "../../config/paths.js";
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_TASK_LIMITS,
  type ItemStage,
  type PipelineEvent,
  type PipelineItem,
  type ScheduledTask,
  type SuggestedWorkItem,
  type TaskRun,
} from "./types.js";

function j<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

type Row = Record<string, unknown>;

const TASK_COLS = `id, name, cron, timezone, assignee, repos, instructions, report_template, delivery,
  approval, limits, deploy_command, enabled, next_run_at, last_run_at, last_run_id, created_at,
  updated_at, created_by, seed_key`;

function rowToTask(r: Row): ScheduledTask {
  return {
    id: String(r.id),
    name: String(r.name),
    cron: String(r.cron),
    timezone: String(r.timezone),
    assignee: j(r.assignee as string, { kind: "cli", backend: "claude-code" }),
    repos: j(r.repos as string, []),
    instructions: String(r.instructions ?? ""),
    reportTemplate: String(r.report_template),
    delivery: j(r.delivery as string, ["ui"]),
    approval: { ...DEFAULT_APPROVAL_POLICY, ...j(r.approval as string, {}) },
    limits: { ...DEFAULT_TASK_LIMITS, ...j(r.limits as string, {}) },
    deployCommand: (r.deploy_command as string | null) ?? null,
    enabled: Number(r.enabled) !== 0,
    nextRunAt: (r.next_run_at as number | null) ?? null,
    lastRunAt: (r.last_run_at as number | null) ?? null,
    lastRunId: (r.last_run_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    createdBy: (r.created_by as string | null) ?? null,
    seedKey: (r.seed_key as string | null) ?? null,
  };
}

function rowToRun(r: Row): TaskRun {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    status: r.status as TaskRun["status"],
    trigger: r.trigger as TaskRun["trigger"],
    goalId: (r.goal_id as string | null) ?? null,
    artifactDir: String(r.artifact_dir),
    report: j(r.report as string, null),
    reportPdfPath: (r.report_pdf_path as string | null) ?? null,
    reportId: (r.report_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    readOnlyViolations: j(r.read_only_violations as string, []),
    refsBefore: j(r.refs_before as string, {}),
    deliveredAt: (r.delivered_at as number | null) ?? null,
    deliveryError: (r.delivery_error as string | null) ?? null,
    deliveryAttempts: Number(r.delivery_attempts ?? 0),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    finishedAt: (r.finished_at as number | null) ?? null,
  };
}

function rowToItem(r: Row): PipelineItem {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    taskId: String(r.task_id),
    reportItemId: String(r.report_item_id),
    item: j(r.item as string, {} as SuggestedWorkItem),
    stage: r.stage as ItemStage,
    instructions: j(r.instructions as string, []),
    snoozeUntil: (r.snooze_until as number | null) ?? null,
    devGoalId: (r.dev_goal_id as string | null) ?? null,
    deployGoalId: (r.deploy_goal_id as string | null) ?? null,
    worktreePath: (r.worktree_path as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    baseSha: (r.base_sha as string | null) ?? null,
    diffSummary: (r.diff_summary as string | null) ?? null,
    testEvidence: (r.test_evidence as string | null) ?? null,
    deployOutput: (r.deploy_output as string | null) ?? null,
    deployPid: (r.deploy_pid as number | null) ?? null,
    deployDir: (r.deploy_dir as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    tgChatId: (r.tg_chat_id as string | null) ?? null,
    tgMessageId: (r.tg_message_id as number | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export type NewTask = Omit<
  ScheduledTask,
  "id" | "createdAt" | "updatedAt" | "lastRunAt" | "lastRunId" | "nextRunAt"
> & { nextRunAt?: number | null };

export class ScheduledTaskStore {
  readonly db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "queue.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sched_tasks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL,
        assignee TEXT NOT NULL, repos TEXT NOT NULL DEFAULT '[]', instructions TEXT NOT NULL DEFAULT '',
        report_template TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT '["ui"]',
        approval TEXT NOT NULL DEFAULT '{}', limits TEXT NOT NULL DEFAULT '{}', deploy_command TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, next_run_at INTEGER, last_run_at INTEGER, last_run_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT, seed_key TEXT
      );
      CREATE TABLE IF NOT EXISTS sched_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
        goal_id TEXT, artifact_dir TEXT NOT NULL, report TEXT, report_pdf_path TEXT, report_id TEXT,
        error TEXT, read_only_violations TEXT NOT NULL DEFAULT '[]', refs_before TEXT NOT NULL DEFAULT '{}',
        delivered_at INTEGER, delivery_error TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sched_runs_task ON sched_runs(task_id, created_at);
      CREATE TABLE IF NOT EXISTS sched_items (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, report_item_id TEXT NOT NULL,
        item TEXT NOT NULL, stage TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '[]',
        snooze_until INTEGER, dev_goal_id TEXT, deploy_goal_id TEXT, worktree_path TEXT, branch TEXT,
        base_sha TEXT, diff_summary TEXT, test_evidence TEXT, deploy_output TEXT, deploy_pid INTEGER,
        deploy_dir TEXT, last_error TEXT, tg_chat_id TEXT, tg_message_id INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sched_items_run ON sched_items(run_id);
      CREATE INDEX IF NOT EXISTS idx_sched_items_stage ON sched_items(stage);
      CREATE TABLE IF NOT EXISTS sched_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, run_id TEXT, task_id TEXT NOT NULL,
        from_stage TEXT, to_stage TEXT NOT NULL, actor TEXT NOT NULL, note TEXT, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sched_events_item ON sched_events(item_id, seq);
      CREATE INDEX IF NOT EXISTS idx_sched_events_task ON sched_events(task_id, seq);
      CREATE TABLE IF NOT EXISTS sched_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  createTask(t: NewTask): ScheduledTask {
    const id = `st_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sched_tasks (${TASK_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.name,
        t.cron,
        t.timezone,
        JSON.stringify(t.assignee),
        JSON.stringify(t.repos),
        t.instructions,
        t.reportTemplate,
        JSON.stringify(t.delivery),
        JSON.stringify(t.approval),
        JSON.stringify(t.limits),
        t.deployCommand,
        t.enabled ? 1 : 0,
        t.nextRunAt ?? null,
        now,
        now,
        t.createdBy,
        t.seedKey,
      );
    return this.getTask(id)!;
  }

  getTask(id: string): ScheduledTask | null {
    const r = this.db.prepare("SELECT * FROM sched_tasks WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToTask(r) : null;
  }

  findTaskBySeedKey(key: string): ScheduledTask | null {
    const r = this.db.prepare("SELECT * FROM sched_tasks WHERE seed_key = ?").get(key) as
      | Row
      | undefined;
    return r ? rowToTask(r) : null;
  }

  listTasks(): ScheduledTask[] {
    return (this.db.prepare("SELECT * FROM sched_tasks ORDER BY created_at").all() as Row[]).map(
      rowToTask,
    );
  }

  saveTask(t: ScheduledTask): ScheduledTask {
    t.updatedAt = Date.now();
    this.db
      .prepare(
        `UPDATE sched_tasks SET name=?, cron=?, timezone=?, assignee=?, repos=?, instructions=?,
          report_template=?, delivery=?, approval=?, limits=?, deploy_command=?, enabled=?,
          next_run_at=?, last_run_at=?, last_run_id=?, updated_at=? WHERE id=?`,
      )
      .run(
        t.name,
        t.cron,
        t.timezone,
        JSON.stringify(t.assignee),
        JSON.stringify(t.repos),
        t.instructions,
        t.reportTemplate,
        JSON.stringify(t.delivery),
        JSON.stringify(t.approval),
        JSON.stringify(t.limits),
        t.deployCommand,
        t.enabled ? 1 : 0,
        t.nextRunAt,
        t.lastRunAt,
        t.lastRunId,
        t.updatedAt,
        t.id,
      );
    return t;
  }

  deleteTask(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM sched_events WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM sched_items WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM sched_runs WHERE task_id = ?").run(id);
      return this.db.prepare("DELETE FROM sched_tasks WHERE id = ?").run(id).changes > 0;
    });
    return tx();
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  createRun(input: {
    taskId: string;
    trigger: TaskRun["trigger"];
    artifactDir: string;
    id?: string;
  }): TaskRun {
    const id = input.id ?? `sr_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sched_runs (id, task_id, status, trigger, artifact_dir, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(id, input.taskId, input.trigger, input.artifactDir, now, now);
    return this.getRun(id)!;
  }

  getRun(id: string): TaskRun | null {
    const r = this.db.prepare("SELECT * FROM sched_runs WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToRun(r) : null;
  }

  listRuns(filter: { taskId?: string; status?: TaskRun["status"][]; limit?: number } = {}) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.taskId) {
      where.push("task_id = ?");
      args.push(filter.taskId);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      args.push(...filter.status);
    }
    const sql = `SELECT * FROM sched_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, filter.limit ?? 50) as Row[]).map(rowToRun);
  }

  saveRun(r: TaskRun): TaskRun {
    r.updatedAt = Date.now();
    this.db
      .prepare(
        `UPDATE sched_runs SET status=?, goal_id=?, report=?, report_pdf_path=?, report_id=?, error=?,
          read_only_violations=?, refs_before=?, delivered_at=?, delivery_error=?, delivery_attempts=?,
          updated_at=?, finished_at=? WHERE id=?`,
      )
      .run(
        r.status,
        r.goalId,
        r.report ? JSON.stringify(r.report) : null,
        r.reportPdfPath,
        r.reportId,
        r.error,
        JSON.stringify(r.readOnlyViolations),
        JSON.stringify(r.refsBefore),
        r.deliveredAt,
        r.deliveryError,
        r.deliveryAttempts,
        r.updatedAt,
        r.finishedAt,
        r.id,
      );
    return r;
  }

  // ── items ────────────────────────────────────────────────────────────────

  createItem(input: { runId: string; taskId: string; item: SuggestedWorkItem }): PipelineItem {
    const id = `si_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sched_items (id, run_id, task_id, report_item_id, item, stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'suggested', ?, ?)`,
      )
      .run(id, input.runId, input.taskId, input.item.id, JSON.stringify(input.item), now, now);
    return this.getItem(id)!;
  }

  getItem(id: string): PipelineItem | null {
    const r = this.db.prepare("SELECT * FROM sched_items WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToItem(r) : null;
  }

  listItems(
    filter: { runId?: string; taskId?: string; stages?: ItemStage[]; limit?: number } = {},
  ) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.runId) {
      where.push("run_id = ?");
      args.push(filter.runId);
    }
    if (filter.taskId) {
      where.push("task_id = ?");
      args.push(filter.taskId);
    }
    if (filter.stages?.length) {
      where.push(`stage IN (${filter.stages.map(() => "?").join(",")})`);
      args.push(...filter.stages);
    }
    const sql = `SELECT * FROM sched_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY (SELECT r.created_at FROM sched_runs r WHERE r.id = sched_items.run_id) DESC,
        rowid ASC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, filter.limit ?? 500) as Row[]).map(rowToItem);
  }

  saveItem(i: PipelineItem): PipelineItem {
    i.updatedAt = Date.now();
    this.db
      .prepare(
        `UPDATE sched_items SET item=?, stage=?, instructions=?, snooze_until=?, dev_goal_id=?,
          deploy_goal_id=?, worktree_path=?, branch=?, base_sha=?, diff_summary=?, test_evidence=?,
          deploy_output=?, deploy_pid=?, deploy_dir=?, last_error=?, tg_chat_id=?, tg_message_id=?,
          updated_at=? WHERE id=?`,
      )
      .run(
        JSON.stringify(i.item),
        i.stage,
        JSON.stringify(i.instructions),
        i.snoozeUntil,
        i.devGoalId,
        i.deployGoalId,
        i.worktreePath,
        i.branch,
        i.baseSha,
        i.diffSummary,
        i.testEvidence,
        i.deployOutput,
        i.deployPid,
        i.deployDir,
        i.lastError,
        i.tgChatId,
        i.tgMessageId,
        i.updatedAt,
        i.id,
      );
    return i;
  }

  // ── events ───────────────────────────────────────────────────────────────

  logEvent(e: Omit<PipelineEvent, "seq" | "at"> & { at?: number }): void {
    this.db
      .prepare(
        `INSERT INTO sched_events (item_id, run_id, task_id, from_stage, to_stage, actor, note, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.itemId, e.runId, e.taskId, e.from, e.to, e.actor, e.note, e.at ?? Date.now());
  }

  events(filter: { itemId?: string; runId?: string; taskId?: string; limit?: number }) {
    const [col, val] = filter.itemId
      ? ["item_id", filter.itemId]
      : filter.runId
        ? ["run_id", filter.runId]
        : ["task_id", filter.taskId ?? ""];
    const rows = this.db
      .prepare(`SELECT * FROM sched_events WHERE ${col} = ? ORDER BY seq DESC LIMIT ?`)
      .all(val, filter.limit ?? 200) as Row[];
    return rows.reverse().map(
      (r): PipelineEvent => ({
        seq: Number(r.seq),
        itemId: (r.item_id as string | null) ?? null,
        runId: (r.run_id as string | null) ?? null,
        taskId: String(r.task_id),
        from: (r.from_stage as string | null) ?? null,
        to: String(r.to_stage),
        actor: String(r.actor),
        note: (r.note as string | null) ?? null,
        at: Number(r.at),
      }),
    );
  }

  // ── meta ─────────────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM sched_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO sched_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}

let _instance: ScheduledTaskStore | null = null;

export function getScheduledTaskStore(stateDir: string = resolveStateDir()): ScheduledTaskStore {
  if (!_instance) _instance = new ScheduledTaskStore(stateDir);
  return _instance;
}

export function resetScheduledTaskStoreForTests(): void {
  _instance = null;
}
