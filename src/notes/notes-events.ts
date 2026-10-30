/**
 * Notes change broadcaster — in-process → WS bridge.
 *
 * The notes RPC handlers (`notes.create/update/delete`) and the agent MCP tool
 * (`src/agents/tools/notes-tool.ts`) both resolve the same store via
 * `getRoleMode("notes")` (database-role rows when a DB is mapped, the
 * file-based NoteStore otherwise), so they are already a single source of
 * truth. What was missing is any signal to open UI tabs that the list changed.
 *
 * Mirrors `src/ssh-devices/events.ts`: the gateway injects its broadcaster at
 * startup via `setNotesEventBroadcaster`, and any write path calls
 * `broadcastNotesChanged`.
 */

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

let broadcaster: BroadcastFn | null = null;

export interface NotesChange {
  op: "create" | "update" | "delete" | "move" | "restore" | "import";
  id?: string;
  name?: string;
  /** Set when the change came from the Documents workspace (documents.* / notes tool doc actions). */
  documents?: boolean;
  parentId?: string | null;
}

type NotesListener = (change: NotesChange) => void;
const listeners = new Set<NotesListener>();

/**
 * In-process subscription to legacy note writes (the Documents workspace
 * mirrors notes into documents through this). Listeners run synchronously in
 * the writer's async scope, so per-user state resolution stays correct.
 */
export function onNotesChanged(fn: NotesListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setNotesEventBroadcaster(fn: BroadcastFn): void {
  broadcaster = fn;
}

export function broadcastNotesChanged(change: NotesChange): void {
  for (const fn of listeners) {
    try {
      fn(change);
    } catch {
      /* a listener must never break the write path */
    }
  }
  if (!broadcaster) return;
  try {
    broadcaster("notes:changed", change, { dropIfSlow: true });
  } catch {
    /* best-effort UI telemetry */
  }
}

/**
 * Documents workspace change → same `notes:changed` WS event (flagged
 * `documents: true`) so open Documents/Notes tabs refresh live. Does NOT run
 * the in-process note listeners (that would echo back into the mirror).
 */
export function broadcastDocumentsChanged(change: Omit<NotesChange, "documents">): void {
  if (!broadcaster) return;
  try {
    broadcaster("notes:changed", { ...change, documents: true }, { dropIfSlow: true });
  } catch {
    /* best-effort UI telemetry */
  }
}

/** Other Documents workspace events (e.g. `documents.import.progress`). */
export function broadcastDocumentsEvent(event: string, payload: unknown): void {
  if (!broadcaster) return;
  try {
    broadcaster(event, payload, { dropIfSlow: true });
  } catch {
    /* best-effort UI telemetry */
  }
}
