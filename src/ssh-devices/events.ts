type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

let broadcaster: BroadcastFn | null = null;

export type SSHEventName =
  | "ssh.connection.opened"
  | "ssh.connection.closed"
  | "ssh.command.executed"
  | "ssh.connection.error";

export interface SSHEventContext {
  deviceId?: string;
  host: string;
}

export function setSSHEventBroadcaster(fn: BroadcastFn): void {
  broadcaster = fn;
}

export function broadcastSSHEvent(name: SSHEventName, payload: unknown): void {
  if (!broadcaster) return;
  try {
    broadcaster(name, payload, { dropIfSlow: true });
  } catch {
    /* best-effort UI telemetry */
  }
}
