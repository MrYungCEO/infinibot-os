/**
 * Queue change broadcaster — in-process → WS bridge.
 *
 * Identical pattern to `src/tasks/kanban-events.ts`: gateway injects the WS
 * broadcaster at startup via {@link setQueueEventBroadcaster}; the orchestrator
 * (and any other mutator) emits typed events via {@link broadcastQueueEvent}.
 *
 * Event families:
 *   queue.entry.{created,started,paused,resumed,blocked,done,failed,canceled,
 *                dead,retried,reordered,advanced}
 *   queue.phase.{started,settled,gate,completed,retrying,timeout}
 * Legacy names (queue.enqueued | queue.phase_started | queue.phase_completed |
 * queue.blocked | queue.done | queue.failed | queue.canceled) are still emitted
 * for existing consumers (queue-holding-zone, queue-activity-strip), and every
 * event is followed by a generic `queue.changed {id}` refetch trigger.
 */

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

let broadcaster: BroadcastFn | null = null;

export type QueueEntryEventKind =
  | "queue.entry.created"
  | "queue.entry.started"
  | "queue.entry.paused"
  | "queue.entry.resumed"
  | "queue.entry.blocked"
  | "queue.entry.done"
  | "queue.entry.failed"
  | "queue.entry.canceled"
  | "queue.entry.dead"
  | "queue.entry.retried"
  | "queue.entry.reordered"
  | "queue.entry.advanced";

export type QueuePhaseEventKind =
  | "queue.phase.started"
  | "queue.phase.settled"
  | "queue.phase.gate"
  | "queue.phase.completed"
  | "queue.phase.retrying"
  | "queue.phase.timeout";

export type LegacyQueueEventKind =
  | "queue.enqueued"
  | "queue.phase_started"
  | "queue.phase_completed"
  | "queue.blocked"
  | "queue.done"
  | "queue.failed"
  | "queue.canceled"
  | "queue.changed";

export type QueueEventKind = QueueEntryEventKind | QueuePhaseEventKind | LegacyQueueEventKind;

export interface QueueEventPayload {
  id: string;
  status?: string;
  phaseName?: string;
  phaseIdx?: number;
  totalPhases?: number;
  reason?: string;
  eta?: number | null;
  runId?: string | null;
  attemptId?: number;
  agent?: string;
  model?: string | null;
  verdict?: string | null;
}

const LEGACY: Partial<Record<QueueEventKind, LegacyQueueEventKind>> = {
  "queue.entry.created": "queue.enqueued",
  "queue.phase.started": "queue.phase_started",
  "queue.phase.completed": "queue.phase_completed",
  "queue.entry.blocked": "queue.blocked",
  "queue.entry.done": "queue.done",
  "queue.entry.failed": "queue.failed",
  "queue.entry.dead": "queue.failed",
  "queue.entry.canceled": "queue.canceled",
};

export function setQueueEventBroadcaster(fn: BroadcastFn): void {
  broadcaster = fn;
}

export function broadcastQueueEvent(event: QueueEventKind, payload: QueueEventPayload): void {
  try {
    broadcaster?.(event, payload);
    const legacy = LEGACY[event];
    if (legacy) broadcaster?.(legacy, payload);
    // Always emit a generic "queue.changed" alongside the specific event so a
    // lightweight subscriber can just refetch via `queue.list`.
    if (event !== "queue.changed") {
      broadcaster?.("queue.changed", { id: payload.id });
    }
  } catch {
    /* never throw into a write path */
  }
}

/**
 * Emit an arbitrary event through the same bridge (used by goal runs, which
 * share queue.db and the queue boot path). Never throws.
 */
export function broadcastQueueBridgeEvent(event: string, payload: unknown): void {
  try {
    broadcaster?.(event, payload, { dropIfSlow: true });
  } catch {
    /* never throw into a write path */
  }
}
