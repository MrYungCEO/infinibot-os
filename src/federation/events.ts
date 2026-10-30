type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

let broadcaster: BroadcastFn | null = null;

export type FederationEventName =
  | "federation.message.sent"
  | "federation.message.delivered"
  | "federation.message.failed"
  | "federation.delivery_failed"
  | "federation.peer.connected"
  | "federation.peer.disconnected";

export function setFederationEventBroadcaster(fn: BroadcastFn): void {
  broadcaster = fn;
}

export function broadcastFederationEvent(name: FederationEventName, payload: unknown): void {
  if (!broadcaster) return;
  try {
    broadcaster(name, payload, { dropIfSlow: true });
  } catch {
    /* best-effort UI telemetry */
  }
}
