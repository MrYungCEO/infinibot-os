/**
 * Ideas change broadcaster — in-process → WS bridge (same shape as
 * src/notes/notes-events.ts). The gateway injects its broadcaster at startup;
 * the ideas.* RPCs, capture.save and the `ideas` agent tool all call
 * broadcastIdeasChanged so open web tabs and phones refresh their lists.
 */

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

export const IDEAS_CHANGED_EVENT = "ideas.changed";

export interface IdeasChange {
  op: "create" | "update" | "delete" | "promote" | "link";
  id: string;
  title?: string;
}

let broadcaster: BroadcastFn | null = null;

export function setIdeasEventBroadcaster(fn: BroadcastFn): void {
  broadcaster = fn;
}

export function broadcastIdeasChanged(change: IdeasChange): void {
  if (!broadcaster) return;
  try {
    broadcaster(IDEAS_CHANGED_EVENT, change, { dropIfSlow: true });
  } catch {
    /* best-effort UI telemetry */
  }
}
