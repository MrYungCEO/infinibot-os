/**
 * Secure Mode WS events. Payloads never carry secure content: status events
 * carry the toggle state and counts, lane events carry only which store
 * changed so open views refetch over the authenticated RPC.
 */

export const SECURE_MODE_CHANGED_EVENT = "secure.mode.changed";
export const SECURE_LANE_CHANGED_EVENT = "secure.lane.changed";

export type SecureLaneKind = "kanban" | "docs" | "graph" | "sessions" | "files";

type Broadcaster = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

let broadcaster: Broadcaster | null = null;

export function setSecureModeBroadcaster(fn: Broadcaster | null): void {
  broadcaster = fn;
}

export function broadcastSecureModeChanged(status: unknown): void {
  broadcaster?.(SECURE_MODE_CHANGED_EVENT, status);
}

export function broadcastSecureLaneChanged(kind: SecureLaneKind): void {
  broadcaster?.(SECURE_LANE_CHANGED_EVENT, { kind, at: Date.now() }, { dropIfSlow: true });
}
