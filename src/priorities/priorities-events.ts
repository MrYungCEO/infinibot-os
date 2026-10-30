/**
 * Today's-Priorities change broadcaster — in-process → WS bridge.
 *
 * Mirrors `src/notes/notes-events.ts`: the gateway injects its broadcaster at
 * startup via `setPrioritiesEventBroadcaster` (see
 * `src/gateway/server-runtime-state.ts`), and every priorities write path calls
 * `broadcastPrioritiesChanged`. Both the web `<todays-priorities>` component and
 * the mobile `TodaysPriorities` screen subscribe to `priorities:changed` so the
 * two surfaces stay live-synced off the single shared store.
 */

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

let broadcaster: BroadcastFn | null = null;

export interface PrioritiesChange {
  op: "create" | "update" | "delete" | "reorder" | "toggle";
  /** The affected item id (when applicable). */
  id?: string;
  /** The day (YYYY-MM-DD) whose list changed — lets clients refetch narrowly. */
  date?: string;
}

export function setPrioritiesEventBroadcaster(fn: BroadcastFn): void {
  broadcaster = fn;
}

export function broadcastPrioritiesChanged(change: PrioritiesChange): void {
  if (!broadcaster) return;
  try {
    broadcaster("priorities:changed", change, { dropIfSlow: true });
  } catch {
    /* best-effort UI telemetry */
  }
}
