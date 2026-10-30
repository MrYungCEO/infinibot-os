import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { clean } from "../util.js";

export interface KanbanTaskEvent {
  id: string;
  title: string;
  projectId: string;
  ts: number;
}

export interface KanbanData {
  projectName(id: string | undefined | null): string | null;
  task(id: string | undefined | null): { title: string; projectId: string; status: string } | null;
  completed: KanbanTaskEvent[];
  created: KanbanTaskEvent[];
  /** Tasks updated in range that were neither created nor completed then. */
  moved: KanbanTaskEvent[];
  inProgress: Array<KanbanTaskEvent & { status: string }>;
}

const EMPTY: KanbanData = {
  projectName: () => null,
  task: () => null,
  completed: [],
  created: [],
  moved: [],
  inProgress: [],
};

/** Read-only view of kanban.db for [fromMs, toMs). Closes the handle before returning. */
export function loadKanban(stateDir: string, fromMs: number, toMs: number): KanbanData {
  const file = path.join(stateDir, "kanban.db");
  if (!fs.existsSync(file)) return EMPTY;
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    const projects = new Map<string, string>();
    for (const r of db.prepare("SELECT id, name FROM projects").all() as Array<{
      id: string;
      name: string;
    }>) {
      projects.set(r.id, clean(r.name, 60));
    }
    const tasks = new Map<string, { title: string; projectId: string; status: string }>();
    const rows = db
      .prepare(
        `SELECT id, projectId, title, status, createdAt, updatedAt, completedAt FROM tasks
         WHERE (createdAt >= @f AND createdAt < @t) OR (updatedAt >= @f AND updatedAt < @t)
            OR (completedAt >= @f AND completedAt < @t) OR status IN ('in_progress','review')`,
      )
      .all({ f: fromMs, t: toMs }) as Array<{
      id: string;
      projectId: string;
      title: string;
      status: string;
      createdAt: number;
      updatedAt: number;
      completedAt: number | null;
    }>;
    const out: KanbanData = { ...EMPTY, completed: [], created: [], moved: [], inProgress: [] };
    const inRange = (ts: number | null | undefined) =>
      typeof ts === "number" && ts >= fromMs && ts < toMs;
    for (const r of rows) {
      const title = clean(r.title, 140);
      tasks.set(r.id, { title, projectId: r.projectId, status: r.status });
      const base = { id: r.id, title, projectId: r.projectId };
      const created = inRange(r.createdAt);
      const completed = inRange(r.completedAt);
      if (created) out.created.push({ ...base, ts: r.createdAt });
      if (completed) out.completed.push({ ...base, ts: r.completedAt! });
      if (!created && !completed && inRange(r.updatedAt))
        out.moved.push({ ...base, ts: r.updatedAt });
      if (r.status === "in_progress" && inRange(r.updatedAt))
        out.inProgress.push({ ...base, ts: r.updatedAt, status: r.status });
    }
    out.projectName = (id) => (id ? (projects.get(id) ?? null) : null);
    // Runs reference older tasks too; a few thousand short rows is cheap, and
    // loading them now lets the handle close before we return.
    const all = db.prepare("SELECT id, title, projectId, status FROM tasks").all() as Array<{
      id: string;
      title: string;
      projectId: string;
      status: string;
    }>;
    for (const r of all) {
      if (!tasks.has(r.id))
        tasks.set(r.id, { title: clean(r.title, 140), projectId: r.projectId, status: r.status });
    }
    out.task = (id) => (id ? (tasks.get(id) ?? null) : null);
    return out;
  } catch {
    return EMPTY;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
