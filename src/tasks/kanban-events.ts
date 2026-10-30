/**
 * Kanban change broadcaster — in-process → WS bridge.
 *
 * Both the gateway RPC handlers (`kanban.tasks.*`) AND the agent MCP tool
 * (`src/agents/tools/kanban-tool.ts`) mutate the board, but they run in the
 * SAME process and write straight to Notion / the local store — they never go
 * through each other. So a generic "the board changed" WS event has to be
 * emitted from a shared module both can import, exactly like
 * `src/ssh-devices/events.ts` and `src/federation/events.ts`.
 *
 * The gateway injects its broadcaster at startup via
 * `setKanbanEventBroadcaster`. A second hook, `setKanbanCacheInvalidator`,
 * lets the RPC layer (which owns the `kanban.tasks.list` / `projects.list`
 * cache) drop stale entries whenever ANY write happens — including writes that
 * came through the MCP tool and would otherwise leave the list cache stale, so
 * a UI reload triggered by the broadcast would still show old data.
 */
import { join } from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createWriteLedger, type LedgerEntry, type WriteLedger } from "./kanban-write-ledger.js";

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
type CacheInvalidator = (entity: "task" | "project") => void;

let broadcaster: BroadcastFn | null = null;
let invalidator: CacheInvalidator | null = null;

export interface KanbanChange {
  entity: "task" | "project";
  op: "create" | "update" | "delete";
  id?: string;
  /** For tasks: the owning project so the UI can refresh only the open board. */
  projectId?: string | null;
  /** Lightweight hint for logging / optimistic display. */
  title?: string;
}

export function setKanbanEventBroadcaster(fn: BroadcastFn): void {
  broadcaster = fn;
}

export function setKanbanCacheInvalidator(fn: CacheInvalidator): void {
  invalidator = fn;
}

/**
 * Announce a kanban mutation. Invalidates the server-side list cache first
 * (so the reload the UI does in response returns fresh data), then emits the
 * `kanban:changed` WS event. Best-effort: never throws into a write path.
 */
export function broadcastKanbanChanged(
  change: KanbanChange,
  opts: { invalidate?: boolean } = {},
): void {
  if (opts.invalidate !== false) {
    try {
      invalidator?.(change.entity);
    } catch {
      /* best-effort */
    }
  }
  if (!broadcaster) return;
  try {
    broadcaster("kanban:changed", change, { dropIfSlow: true });
  } catch {
    /* best-effort UI telemetry */
  }
}

// ── Per-task realtime updates (versioned) ────────────────────────────────
// `kanban:changed` makes every surface reload the (slow, Notion-backed) board.
// `kanban.task.updated` carries the new field values + a monotonically
// increasing version so open tabs/devices patch the row in place within a
// frame and can ignore anything older than what they already show.

export interface KanbanTaskUpdate {
  id: string;
  /** New field values (status/done/title/priority/…). */
  fields: Record<string, unknown>;
  /** Ledger version — higher always wins on the client. */
  version: number;
  /** Who wrote it: "ui" | "agent" | "verifier" | "notion" | … */
  source?: string;
  /** True until the write reached Notion. */
  syncPending?: boolean;
  /** Last push error while syncPending (retrying). */
  syncError?: string;
  projectId?: string | null;
}

let ledger: WriteLedger | null = null;

/** The process-wide task write ledger (persisted under the state dir). */
export function getKanbanWriteLedger(): WriteLedger {
  if (!ledger) {
    ledger = createWriteLedger({
      persistPath: join(resolveStateDir(), "kanban", "write-ledger.json"),
    });
  }
  return ledger;
}

/** Test hook. */
export function resetKanbanWriteLedgerForTests(next: WriteLedger | null = null): void {
  ledger = next;
}

export function broadcastKanbanTaskUpdated(update: KanbanTaskUpdate): void {
  if (!broadcaster) return;
  try {
    broadcaster("kanban.task.updated", update);
  } catch {
    /* best-effort */
  }
}

/**
 * Record a task write from ANY source (RPC, agent tool, verifier) in the
 * ledger and announce it: the versioned per-task event first (instant in-place
 * patch on every open tab), then `kanban:changed` (cache invalidation +
 * debounced reload for surfaces that derive more from the board).
 * `pushed: true` when the caller already wrote the source synchronously.
 */
export function noteKanbanTaskWrite(
  id: string,
  fields: Record<string, unknown>,
  meta: { source?: string; pushed?: boolean; projectId?: string | null; title?: string } = {},
): LedgerEntry | null {
  let entry: LedgerEntry | null = null;
  try {
    entry = getKanbanWriteLedger().record(id, fields, {
      pushed: meta.pushed,
      source: meta.source,
    });
  } catch {
    /* ledger is best-effort — never break the write path */
  }
  if (entry) {
    broadcastKanbanTaskUpdated({
      id,
      fields: entry.fields,
      version: entry.version,
      ...(meta.source ? { source: meta.source } : {}),
      syncPending: entry.pushedVersion !== entry.version,
      ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
    });
  }
  // List reads are merged through the ledger, so cached lists stay correct
  // without a (slow) refetch — unless the write moved the task to another
  // project (project-scoped lists are filtered at the source) or the ledger
  // couldn't record it.
  broadcastKanbanChanged(
    {
      entity: "task",
      op: "update",
      id,
      projectId: meta.projectId ?? null,
      ...(meta.title ? { title: meta.title } : {}),
    },
    { invalidate: !entry || fields.projectId !== undefined },
  );
  return entry;
}

/**
 * Board fields of a task patch written straight to the source (agent tool /
 * verifier), with status and done kept as one fact.
 */
export function agentTaskWriteFields(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["status", "done", "title", "priority", "projectId"]) {
    if (patch[k] !== undefined && patch[k] !== "") out[k] = patch[k];
  }
  if (typeof out.status === "string") out.done = out.status === "done";
  return out;
}

/**
 * A task was deleted (already archived at the source / removed locally).
 * Every list drops it at once — cached lists and Notion reads still lagging
 * behind the delete included — and open tabs remove the card.
 */
export function noteKanbanTaskDeleted(
  id: string,
  meta: { source?: string; projectId?: string | null } = {},
): LedgerEntry | null {
  let entry: LedgerEntry | null = null;
  try {
    entry = getKanbanWriteLedger().tombstone(id, { source: meta.source });
  } catch {
    /* best-effort */
  }
  if (entry) {
    broadcastKanbanTaskUpdated({
      id,
      fields: { deleted: true },
      version: entry.version,
      ...(meta.source ? { source: meta.source } : {}),
      syncPending: false,
      ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
    });
  }
  broadcastKanbanChanged(
    { entity: "task", op: "delete", id, projectId: meta.projectId ?? null },
    { invalidate: !entry },
  );
  return entry;
}
