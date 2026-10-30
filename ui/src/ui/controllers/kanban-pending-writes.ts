/**
 * Confirmed task writes that the next board load must not undo.
 *
 * The dashboard applies a write optimistically, the gateway confirms it, and
 * `kanban:changed` reloads the board. That reload (or a poll, or the
 * localStorage cache a page reload renders first) can still carry the row as
 * it was before the write — the gateway's Notion-backed list is a slow,
 * stale-while-revalidate read. Without this, a task marked done vanished and
 * then came back a few seconds later.
 *
 * Every confirmed task patch is recorded here (persisted, so a page reload
 * keeps it) and re-applied to each list the board loads, until the server's
 * own row agrees with it (then it is dropped) or it expires.
 */
import type { KanbanTask } from "../types";

const STORAGE_KEY = "kanban-pending-writes-v1";
/** Long enough to outlast a slow / wedged gateway list refresh. */
export const PENDING_WRITE_TTL_MS = 2 * 60 * 60 * 1000;

export interface PendingTaskWrite {
  id: string;
  patch: Record<string, unknown>;
  at: number;
}

let memory: PendingTaskWrite[] | null = null;

const norm = (v: unknown): string => (typeof v === "string" ? v.replace(/-/g, "").toLowerCase() : "");

function load(): PendingTaskWrite[] {
  if (memory) return memory;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as PendingTaskWrite[]) : [];
    memory = Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.id === "string" && p.patch) : [];
  } catch {
    memory = [];
  }
  return memory;
}

function save(list: PendingTaskWrite[]): void {
  memory = list;
  try {
    if (typeof localStorage === "undefined") return;
    if (list.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage full / unavailable — the in-memory list still applies */
  }
}

/** Record a write the gateway confirmed. A later write to the same task merges over it. */
export function recordPendingTaskWrite(id: string, patch: Record<string, unknown>, now = Date.now()): void {
  if (!id || !patch || Object.keys(patch).length === 0) return;
  const list = load().filter((p) => now - p.at < PENDING_WRITE_TTL_MS);
  const prev = list.find((p) => norm(p.id) === norm(id));
  const next = list.filter((p) => p !== prev);
  next.push({ id, patch: { ...(prev?.patch ?? {}), ...patch }, at: now });
  save(next);
}

/**
 * Record a write BEFORE its request goes out, so a board reload that lands
 * while it is in flight (another write's `kanban:changed`, a poll, the
 * Refresh button) can't drop the optimistic row. Returns an undo for the
 * failure path that restores whatever was pending for the task before.
 */
export function beginPendingTaskWrite(
  id: string,
  patch: Record<string, unknown>,
  now = Date.now(),
): () => void {
  const prev = load().find((p) => norm(p.id) === norm(id));
  const prevCopy = prev ? { ...prev, patch: { ...prev.patch } } : null;
  recordPendingTaskWrite(id, patch, now);
  return () => {
    const rest = load().filter((p) => norm(p.id) !== norm(id));
    save(prevCopy ? [...rest, prevCopy] : rest);
  };
}

/**
 * A server answer for one task (e.g. the `kanban.task.updated` event): retire
 * the pending write once the server reports the written state.
 */
export function confirmPendingTaskWrite(id: string, fields: Record<string, unknown>): void {
  const list = load();
  const p = list.find((x) => norm(x.id) === norm(id));
  if (!p) return;
  // Only fields the server actually reported can confirm the write.
  const covered = Object.keys(p.patch).every((k) => k in fields);
  if (covered && agrees(fields as unknown as KanbanTask, p.patch)) save(list.filter((x) => x !== p));
}

/** Is a write for this task still waiting for the server to agree? */
export function hasPendingTaskWrite(id: string): boolean {
  return load().some((p) => norm(p.id) === norm(id));
}

function agrees(row: KanbanTask, patch: Record<string, unknown>): boolean {
  const r = row as unknown as Record<string, unknown>;
  return Object.entries(patch).every(([k, v]) => {
    // done is the boolean twin of status — a missing flag reads as false.
    if (k === "done") return (r.done === true) === (v === true);
    return r[k] === v;
  });
}

/**
 * Re-apply pending writes to a freshly loaded task list. Rows the server
 * already reports in the written state retire their entry; others are
 * patched. Returns the same array when nothing changed.
 *
 * `fromServer: false` for lists that are not a server answer (the board's own
 * localStorage cache, which already holds the patched rows): those must never
 * retire an entry, or the next stale server list would bring the row back.
 */
export function applyPendingTaskWrites(
  tasks: KanbanTask[],
  now = Date.now(),
  opts: { fromServer?: boolean } = {},
): KanbanTask[] {
  const fromServer = opts.fromServer !== false;
  const list = load();
  if (!list.length || !Array.isArray(tasks)) return tasks;
  const live = list.filter((p) => now - p.at < PENDING_WRITE_TTL_MS);
  const byId = new Map(live.map((p) => [norm(p.id), p]));
  const confirmed = new Set<PendingTaskWrite>();
  let changed = false;
  const out = tasks.map((t) => {
    const p = byId.get(norm(t.id)) ?? byId.get(norm((t as { notionId?: string }).notionId));
    if (!p) return t;
    if (agrees(t, p.patch)) {
      if (fromServer) confirmed.add(p);
      return t;
    }
    changed = true;
    return { ...t, ...p.patch } as KanbanTask;
  });
  const remaining = live.filter((p) => !confirmed.has(p));
  if (remaining.length !== list.length) save(remaining);
  return changed ? out : tasks;
}

/** Test hook. */
export function resetPendingTaskWrites(): void {
  memory = null;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
