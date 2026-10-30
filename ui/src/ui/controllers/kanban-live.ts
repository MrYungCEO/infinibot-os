/**
 * Real-time task updates for every board surface.
 *
 * The gateway broadcasts `kanban.task.updated` { id, fields, version, source,
 * syncPending } on every task write from any source (this or another tab /
 * device, agents, the verifier, a newer Notion edit). Applying it patches the
 * row in place within a frame — no board reload — and the per-task version
 * guarantees an older event (or an older list) never overwrites a newer one.
 */
import type { KanbanTask } from "../types";
import { confirmPendingTaskWrite } from "./kanban-pending-writes";

export interface KanbanTaskUpdatedPayload {
  id: string;
  fields: Record<string, unknown>;
  version: number;
  source?: string;
  syncPending?: boolean;
  syncError?: string;
  projectId?: string | null;
}

/** Window event other surfaces (embedded overlays, agency ops) listen to. */
export const KANBAN_TASK_UPDATED_EVENT = "kanban-task-updated";

const norm = (v: unknown): string => (typeof v === "string" ? v.replace(/-/g, "").toLowerCase() : "");

/** Highest version seen per task (normalised id). */
const versions = new Map<string, number>();
/** When each task's latest version was seen (bounds how long lists are overridden). */
const versionAt = new Map<string, number>();
/**
 * How long an applied event beats lists that don't carry its version. The
 * gateway's write ledger guards its own lists; this only covers a list that
 * was already in flight when the event arrived.
 */
export const EVENT_GUARD_MS = 60_000;
/** Tasks deleted recently (this tab or any other source) → when. */
const deletedAt = new Map<string, number>();

/** Mark a task deleted locally (before the request); returns an undo for failures. */
export function markTaskDeleted(id: string, now = Date.now()): () => void {
  const key = norm(id);
  const prev = deletedAt.get(key);
  deletedAt.set(key, now);
  return () => {
    if (prev === undefined) deletedAt.delete(key);
    else deletedAt.set(key, prev);
  };
}

function isRecentlyDeleted(key: string, now: number): boolean {
  const t = deletedAt.get(key);
  return t !== undefined && now - t <= EVENT_GUARD_MS;
}

/** When a versioned event was last applied per task (to skip redundant reloads). */
const appliedAt = new Map<string, number>();

export function isKanbanTaskUpdatedPayload(p: unknown): p is KanbanTaskUpdatedPayload {
  const x = p as KanbanTaskUpdatedPayload | null;
  return !!x && typeof x.id === "string" && typeof x.version === "number" && !!x.fields && typeof x.fields === "object";
}

/**
 * Patch one task in a list from an update event. Returns the same array when
 * the event is older than what was already applied or the task isn't there.
 */
export function applyKanbanTaskUpdate<T extends { id: string }>(
  tasks: T[],
  u: KanbanTaskUpdatedPayload,
  now = Date.now(),
): T[] {
  const key = norm(u.id);
  const seen = versions.get(key) ?? 0;
  // Equal version = same write (e.g. the "synced" follow-up): refresh flags only.
  if (u.version < seen) return tasks;
  versions.set(key, u.version);
  versionAt.set(key, now);
  if (u.fields.deleted === true) {
    deletedAt.set(key, now);
    if (!Array.isArray(tasks)) return tasks;
    const kept = tasks.filter((t) => {
      const r = t as unknown as Record<string, unknown>;
      return norm(r.id) !== key && norm(r.notionId) !== key;
    });
    return kept.length === tasks.length ? tasks : kept;
  }
  confirmPendingTaskWrite(u.id, u.fields);
  if (!Array.isArray(tasks)) return tasks;
  let hit = false;
  const out = tasks.map((t) => {
    const r = t as unknown as Record<string, unknown>;
    if (norm(r.id) !== key && norm(r.notionId) !== key) return t;
    hit = true;
    return {
      ...t,
      ...u.fields,
      version: u.version,
      syncPending: u.syncPending === true,
      ...(u.syncError ? { syncError: u.syncError } : { syncError: undefined }),
    } as T;
  });
  // A project move changes which project-scoped lists hold the task: those
  // still need the reload `kanban:changed` triggers.
  if (hit && !("projectId" in u.fields)) appliedAt.set(key, now);
  return hit ? out : tasks;
}

/**
 * Drop rows of a freshly loaded list that are older than an event already
 * applied (the list was read before that write): keep the event's fields.
 */
export function applyKnownVersions<T extends { id: string }>(
  tasks: T[],
  current: T[],
  now = Date.now(),
): T[] {
  if (!Array.isArray(tasks)) return tasks;
  // A list read before a delete landed must not bring the card back.
  if (deletedAt.size) {
    const kept = tasks.filter((t) => !isRecentlyDeleted(norm(t.id), now));
    if (kept.length !== tasks.length) tasks = kept;
  }
  if (!versions.size) return tasks;
  const byKey = new Map<string, T>();
  for (const c of current ?? []) byKey.set(norm(c.id), c);
  let changed = false;
  const out = tasks.map((t) => {
    const key = norm(t.id);
    const seen = versions.get(key);
    if (!seen || now - (versionAt.get(key) ?? 0) > EVENT_GUARD_MS) return t;
    const rowVersion = Number((t as unknown as { version?: number }).version) || 0;
    if (rowVersion >= seen) return t;
    const cur = byKey.get(key);
    if (!cur || (Number((cur as unknown as { version?: number }).version) || 0) < seen) return t;
    changed = true;
    return cur;
  });
  return changed ? out : tasks;
}

/** True when a versioned event for this task was applied in the last `withinMs`. */
export function recentlyAppliedTaskUpdate(id: string | undefined, withinMs = 3_000, now = Date.now()): boolean {
  if (!id) return false;
  const t = appliedAt.get(norm(id));
  return t !== undefined && now - t < withinMs;
}

/** Test hook. */
export function resetKanbanLive(): void {
  versions.clear();
  versionAt.clear();
  appliedAt.clear();
  deletedAt.clear();
}

export type { KanbanTask };
