/**
 * Autonomous Tasks — gateway RPC handlers + SQLite store
 *
 * Provides a task queue that flows work to agents via the agency engine.
 * When a task moves to "ready" the handler spawns a claude_coder session
 * using the same pattern as subagents.respawn.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import Database from "better-sqlite3";
import { resolveStateDir } from "../../config/paths.js";
import { createClaudeCoderTool } from "../../agents/tools/claude-coder-tool.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AutonomousTaskStatus = "inbox" | "ready" | "in_progress" | "review" | "done";
export type AutonomousTaskPriority = "low" | "normal" | "high" | "critical";

export interface AutonomousTask {
  id: string;
  title: string;
  scope: string;
  workdir: string;
  agent_id: string | null;
  priority: AutonomousTaskPriority;
  status: AutonomousTaskStatus;
  project_id: string | null;
  session_key: string | null;
  created_at: number;
  updated_at: number;
}

// ── SQLite store ──────────────────────────────────────────────────────────────

let _store: AutonomousTasksStore | null = null;

export function getAutonomousTasksStore(): AutonomousTasksStore {
  if (!_store) {
    const stateDir = resolveStateDir();
    _store = new AutonomousTasksStore(pathJoin(stateDir, "autonomous-tasks.db"));
  }
  return _store;
}

class AutonomousTasksStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(pathJoin(dbPath, ".."), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomous_tasks_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const row = this.db
      .prepare("SELECT MAX(version) AS version FROM autonomous_tasks_migrations")
      .get() as { version: number | null };
    const version = row?.version ?? 0;

    if (version < 1) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE autonomous_tasks (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            scope       TEXT NOT NULL DEFAULT '',
            workdir     TEXT NOT NULL,
            agent_id    TEXT,
            priority    TEXT NOT NULL DEFAULT 'normal',
            status      TEXT NOT NULL DEFAULT 'inbox',
            project_id  TEXT,
            session_key TEXT,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
          );
          CREATE INDEX autonomous_tasks_status ON autonomous_tasks(status, updated_at DESC);
          CREATE INDEX autonomous_tasks_agent  ON autonomous_tasks(agent_id, status);
          INSERT INTO autonomous_tasks_migrations (version, applied_at) VALUES (1, ${Date.now()});
        `);
      })();
    }
  }

  create(input: {
    title: string;
    scope?: string;
    workdir: string;
    agent_id?: string | null;
    priority?: AutonomousTaskPriority;
    project_id?: string | null;
  }): AutonomousTask {
    if (!input.workdir?.trim()) throw new Error("workdir is required");
    const now = Date.now();
    const task: AutonomousTask = {
      id: randomUUID(),
      title: input.title,
      scope: input.scope ?? "",
      workdir: input.workdir,
      agent_id: input.agent_id ?? null,
      priority: input.priority ?? "normal",
      status: "inbox",
      project_id: input.project_id ?? null,
      session_key: null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO autonomous_tasks
         (id, title, scope, workdir, agent_id, priority, status, project_id, session_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        task.id,
        task.title,
        task.scope,
        task.workdir,
        task.agent_id,
        task.priority,
        task.status,
        task.project_id,
        task.session_key,
        task.created_at,
        task.updated_at,
      );
    return task;
  }

  list(filter?: { status?: AutonomousTaskStatus; agent_id?: string }): AutonomousTask[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter?.status) {
      clauses.push("status = ?");
      values.push(filter.status);
    }
    if (filter?.agent_id) {
      clauses.push("agent_id = ?");
      values.push(filter.agent_id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM autonomous_tasks ${where} ORDER BY updated_at DESC`)
      .all(...values) as AutonomousTask[];
  }

  get(id: string): AutonomousTask | null {
    return (
      (this.db
        .prepare("SELECT * FROM autonomous_tasks WHERE id = ?")
        .get(id) as AutonomousTask | undefined) ?? null
    );
  }

  update(id: string, patch: Partial<Omit<AutonomousTask, "id" | "created_at">>): AutonomousTask | null {
    const allowed = ["title", "scope", "workdir", "agent_id", "priority", "status", "project_id", "session_key"];
    const fields = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!fields.length) return this.get(id);
    const now = Date.now();
    const sets = [...fields.map((f) => `${f} = ?`), "updated_at = ?"].join(", ");
    const values = [...fields.map((f) => (patch as Record<string, unknown>)[f]), now, id];
    this.db.prepare(`UPDATE autonomous_tasks SET ${sets} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  assign(id: string, agentId: string): AutonomousTask | null {
    return this.update(id, { agent_id: agentId, status: "ready" });
  }
}

// ── Broadcaster reference (set during gateway init) ───────────────────────────

let _broadcast: ((event: string, payload: unknown) => void) | null = null;
export function setAutonomousTasksBroadcaster(fn: (event: string, payload: unknown) => void): void {
  _broadcast = fn;
}

function broadcastUpdate(task: AutonomousTask): void {
  _broadcast?.("autonomous:task:update", task);
}

// ── Agent spawn helper ────────────────────────────────────────────────────────

async function spawnAgentForTask(task: AutonomousTask): Promise<string | null> {
  const store = getAutonomousTasksStore();
  try {
    const coder = createClaudeCoderTool({ workspaceDir: task.workdir });
    const result = (await coder.execute(`autotask-${task.id}`, {
      task: task.title,
      systemPrompt: task.scope
        ? `Project scope:\n${task.scope}\n\nWork in the directory: ${task.workdir}`
        : `Work in the directory: ${task.workdir}`,
      workdir: task.workdir,
      mode: "detach",
      label: `Autonomous: ${task.title}`.slice(0, 120),
    })) as { content?: Array<{ text?: string }> } | undefined;

    let sessionKey: string | null = null;
    const raw = result?.content?.[0]?.text;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        sessionKey = typeof parsed.sessionKey === "string" ? parsed.sessionKey : null;
      } catch {
        // non-JSON receipt — not a problem
      }
    }

    const updated = store.update(task.id, {
      status: "in_progress",
      session_key: sessionKey ?? undefined,
    });
    if (updated) broadcastUpdate(updated);
    return sessionKey;
  } catch (err) {
    console.error("[autonomous-tasks] spawn failed", err);
    return null;
  }
}

// ── RPC Handlers ─────────────────────────────────────────────────────────────

export const autonomousTaskHandlers: GatewayRequestHandlers = {
  "autonomous.task.create": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!p.title || typeof p.title !== "string") {
        respond(false, undefined, { code: "BAD_REQUEST", message: "title is required" });
        return;
      }
      if (!p.workdir || typeof p.workdir !== "string" || !p.workdir.trim()) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "workdir is required" });
        return;
      }
      const VALID_PRIORITIES = new Set<AutonomousTaskPriority>(["low", "normal", "high", "critical"]);
      const priority: AutonomousTaskPriority = VALID_PRIORITIES.has(p.priority as AutonomousTaskPriority)
        ? (p.priority as AutonomousTaskPriority)
        : "normal";

      const store = getAutonomousTasksStore();
      const task = store.create({
        title: p.title.trim(),
        scope: typeof p.scope === "string" ? p.scope : "",
        workdir: p.workdir.trim(),
        agent_id: typeof p.agent_id === "string" ? p.agent_id : null,
        priority,
        project_id: typeof p.project_id === "string" ? p.project_id : null,
      });

      broadcastUpdate(task);
      respond(true, { task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomous.task.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const VALID_STATUSES = new Set<AutonomousTaskStatus>(["inbox", "ready", "in_progress", "review", "done"]);
      const filter: { status?: AutonomousTaskStatus; agent_id?: string } = {};
      if (typeof p.status === "string" && VALID_STATUSES.has(p.status as AutonomousTaskStatus)) {
        filter.status = p.status as AutonomousTaskStatus;
      }
      if (typeof p.agent_id === "string" && p.agent_id) {
        filter.agent_id = p.agent_id;
      }
      const store = getAutonomousTasksStore();
      const tasks = store.list(Object.keys(filter).length ? filter : undefined);
      respond(true, { tasks });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomous.task.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!p.id || typeof p.id !== "string") {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id is required" });
        return;
      }

      const store = getAutonomousTasksStore();
      const existing = store.get(p.id);
      if (!existing) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }

      const VALID_STATUSES = new Set<AutonomousTaskStatus>(["inbox", "ready", "in_progress", "review", "done"]);
      const VALID_PRIORITIES = new Set<AutonomousTaskPriority>(["low", "normal", "high", "critical"]);
      const patch: Partial<Omit<AutonomousTask, "id" | "created_at">> = {};
      if (typeof p.title === "string" && p.title.trim()) patch.title = p.title.trim();
      if (typeof p.scope === "string") patch.scope = p.scope;
      if (typeof p.workdir === "string" && p.workdir.trim()) patch.workdir = p.workdir.trim();
      if (typeof p.agent_id === "string") patch.agent_id = p.agent_id || null;
      if (typeof p.priority === "string" && VALID_PRIORITIES.has(p.priority as AutonomousTaskPriority)) {
        patch.priority = p.priority as AutonomousTaskPriority;
      }
      if (typeof p.status === "string" && VALID_STATUSES.has(p.status as AutonomousTaskStatus)) {
        patch.status = p.status as AutonomousTaskStatus;
      }
      if (typeof p.project_id === "string") patch.project_id = p.project_id || null;

      const updated = store.update(p.id, patch);
      if (!updated) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found after update" });
        return;
      }

      broadcastUpdate(updated);

      // Auto-spawn when transitioning to "ready"
      if (patch.status === "ready" && existing.status !== "ready") {
        void spawnAgentForTask(updated);
      }

      respond(true, { task: updated });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomous.task.assign": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!p.id || typeof p.id !== "string") {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id is required" });
        return;
      }
      if (!p.agentId || typeof p.agentId !== "string") {
        respond(false, undefined, { code: "BAD_REQUEST", message: "agentId is required" });
        return;
      }

      const store = getAutonomousTasksStore();
      const existing = store.get(p.id);
      if (!existing) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }

      const updated = store.assign(p.id, p.agentId);
      if (!updated) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found after assign" });
        return;
      }

      broadcastUpdate(updated);
      void spawnAgentForTask(updated);

      respond(true, { task: updated });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
