/**
 * Today's-Priorities persistent store.
 *
 * A per-user, per-day, hierarchical, orderable checklist backed by SQLite under
 * the InfiniBot state dir (`{resolveStateDir()}/priorities.db`). Because
 * `resolveStateDir()` already namespaces non-default users into
 * `.../users/<id>`, each profile gets its own priorities DB → multi-user
 * isolation is automatic (priorities are per-user data).
 *
 * Items are stored flat with a nullable `parentId` self-reference and an
 * `ordinal` sort key; the frontend nests them into a tree. Items may optionally
 * link to a real kanban `taskId` / `projectId` (the source of truth stays the
 * kanban store — we only hold the link + a denormalized title snapshot).
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../config/paths.js";

export interface PriorityItem {
  id: string;
  userId: string;
  /** Day this priority belongs to, YYYY-MM-DD. */
  date: string;
  title: string;
  /** Parent item id for hierarchy, or null for a top-level item. */
  parentId: string | null;
  /** Sort order within its sibling group. */
  ordinal: number;
  completed: boolean;
  /** Linked kanban task id (source of truth lives in the kanban store). */
  taskId: string | null;
  /** Linked kanban project id. */
  projectId: string | null;
  /** Denormalized project name snapshot for display without a join. */
  projectName: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface Row {
  id: string;
  userId: string;
  date: string;
  title: string;
  parentId: string | null;
  ordinal: number;
  completed: number;
  taskId: string | null;
  projectId: string | null;
  projectName: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

function rowToItem(r: Row): PriorityItem {
  return {
    id: r.id,
    userId: r.userId,
    date: r.date,
    title: r.title,
    parentId: r.parentId ?? null,
    ordinal: r.ordinal,
    completed: r.completed === 1,
    taskId: r.taskId ?? null,
    projectId: r.projectId ?? null,
    projectName: r.projectName ?? null,
    note: r.note ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    completedAt: r.completedAt ?? null,
  };
}

export interface CreateItemInput {
  userId: string;
  date: string;
  title: string;
  parentId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  note?: string | null;
}

export class PrioritiesStore {
  private db: Database.Database;
  readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "priorities.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS priorities (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        date TEXT NOT NULL,
        title TEXT NOT NULL,
        parentId TEXT,
        ordinal INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        taskId TEXT,
        projectId TEXT,
        projectName TEXT,
        note TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        completedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_priorities_user_date
        ON priorities(userId, date, ordinal);
      CREATE INDEX IF NOT EXISTS idx_priorities_user_title
        ON priorities(userId, title);
    `);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /** All items for a user on a given day, ordered for tree assembly. */
  listByDate(userId: string, date: string): PriorityItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM priorities WHERE userId = ? AND date = ?
         ORDER BY ordinal ASC, createdAt ASC`,
      )
      .all(userId, date) as Row[];
    return rows.map(rowToItem);
  }

  getById(userId: string, id: string): PriorityItem | null {
    const row = this.db
      .prepare(`SELECT * FROM priorities WHERE userId = ? AND id = ?`)
      .get(userId, id) as Row | undefined;
    return row ? rowToItem(row) : null;
  }

  /** Distinct days that have at least one item, newest-first, with counts. */
  listDates(userId: string): Array<{ date: string; total: number; done: number }> {
    const rows = this.db
      .prepare(
        `SELECT date,
                COUNT(*) AS total,
                SUM(completed) AS done
         FROM priorities WHERE userId = ?
         GROUP BY date ORDER BY date DESC`,
      )
      .all(userId) as Array<{ date: string; total: number; done: number }>;
    return rows.map((r) => ({ date: r.date, total: r.total, done: r.done ?? 0 }));
  }

  private nextOrdinal(userId: string, date: string, parentId: string | null): number {
    const row = this.db
      .prepare(
        `SELECT MAX(ordinal) AS m FROM priorities
         WHERE userId = ? AND date = ? AND IFNULL(parentId,'') = IFNULL(?, '')`,
      )
      .get(userId, date, parentId) as { m: number | null };
    return (row?.m ?? -1) + 1;
  }

  create(input: CreateItemInput): PriorityItem {
    const now = Date.now();
    const id = `pri_${randomUUID()}`;
    const parentId = input.parentId ?? null;
    const ordinal = this.nextOrdinal(input.userId, input.date, parentId);
    this.db
      .prepare(
        `INSERT INTO priorities
         (id, userId, date, title, parentId, ordinal, completed, taskId, projectId, projectName, note, createdAt, updatedAt, completedAt)
         VALUES (@id,@userId,@date,@title,@parentId,@ordinal,0,@taskId,@projectId,@projectName,@note,@now,@now,NULL)`,
      )
      .run({
        id,
        userId: input.userId,
        date: input.date,
        title: input.title,
        parentId,
        ordinal,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        projectName: input.projectName ?? null,
        note: input.note ?? null,
        now,
      });
    return this.getById(input.userId, id)!;
  }

  /** Toggle (or set) the completed flag. Returns the updated item. */
  toggle(userId: string, id: string, completed?: boolean): PriorityItem | null {
    const item = this.getById(userId, id);
    if (!item) return null;
    const next = typeof completed === "boolean" ? completed : !item.completed;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE priorities SET completed = ?, completedAt = ?, updatedAt = ?
         WHERE userId = ? AND id = ?`,
      )
      .run(next ? 1 : 0, next ? now : null, now, userId, id);
    return this.getById(userId, id);
  }

  update(
    userId: string,
    id: string,
    patch: Partial<Pick<PriorityItem, "title" | "note">>,
  ): PriorityItem | null {
    const item = this.getById(userId, id);
    if (!item) return null;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE priorities SET title = ?, note = ?, updatedAt = ? WHERE userId = ? AND id = ?`,
      )
      .run(patch.title ?? item.title, patch.note ?? item.note, now, userId, id);
    return this.getById(userId, id);
  }

  /**
   * Apply a full ordered hierarchy for a day in one transaction. Each entry
   * carries the item id, its parentId (null = top level) and ordinal. Only
   * items owned by the user on that date are touched.
   */
  reorder(
    userId: string,
    date: string,
    order: Array<{ id: string; parentId: string | null; ordinal: number }>,
  ): PriorityItem[] {
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE priorities SET parentId = ?, ordinal = ?, updatedAt = ?
       WHERE userId = ? AND date = ? AND id = ?`,
    );
    const tx = this.db.transaction(
      (entries: Array<{ id: string; parentId: string | null; ordinal: number }>) => {
        for (const e of entries) {
          stmt.run(e.parentId ?? null, e.ordinal, now, userId, date, e.id);
        }
      },
    );
    tx(order);
    return this.listByDate(userId, date);
  }

  /** Delete an item and all of its descendants. Returns deleted ids. */
  remove(userId: string, id: string): string[] {
    const item = this.getById(userId, id);
    if (!item) return [];
    // Gather the subtree (flat listing of the day, walk children).
    const dayItems = this.listByDate(userId, item.date);
    const toDelete = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const it of dayItems) {
        if (it.parentId && toDelete.has(it.parentId) && !toDelete.has(it.id)) {
          toDelete.add(it.id);
          grew = true;
        }
      }
    }
    const del = this.db.prepare(`DELETE FROM priorities WHERE userId = ? AND id = ?`);
    const tx = this.db.transaction((ids: string[]) => {
      for (const d of ids) del.run(userId, d);
    });
    tx([...toDelete]);
    return [...toDelete];
  }

  /**
   * Full-text-ish history search across a user's priorities (title + note),
   * optionally bounded to a date range (inclusive YYYY-MM-DD strings).
   */
  search(
    userId: string,
    query: string,
    range?: { from?: string; to?: string },
    limit = 100,
  ): PriorityItem[] {
    const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const clauses = [
      `userId = ?`,
      `(title LIKE ? ESCAPE '\\' OR IFNULL(note,'') LIKE ? ESCAPE '\\')`,
    ];
    const args: unknown[] = [userId, like, like];
    if (range?.from) {
      clauses.push(`date >= ?`);
      args.push(range.from);
    }
    if (range?.to) {
      clauses.push(`date <= ?`);
      args.push(range.to);
    }
    args.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM priorities WHERE ${clauses.join(" AND ")}
         ORDER BY date DESC, ordinal ASC LIMIT ?`,
      )
      .all(...args) as Row[];
    return rows.map(rowToItem);
  }
}

// Per-state-dir instances so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const storeInstances = new Map<string, PrioritiesStore>();

/** Store resolved against the current (possibly per-user/tenant) state dir. */
export function getPrioritiesStore(stateDir?: string): PrioritiesStore {
  const targetDir = stateDir ?? resolveStateDir();
  let inst = storeInstances.get(targetDir);
  if (!inst) {
    inst = new PrioritiesStore(targetDir);
    storeInstances.set(targetDir, inst);
  }
  return inst;
}
