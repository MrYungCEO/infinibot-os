/**
 * Gateway lifecycle signal for the verification pipeline. When the gateway is
 * shutting down (deploy / restart), attempts that die with it were
 * interrupted — not failed — and are rechecked after the next boot.
 */

let stoppingSince: number | null = null;

export function markGatewayStopping(at = Date.now()): void {
  stoppingSince ??= at;
}

export function isGatewayStopping(): boolean {
  return stoppingSince !== null;
}

export function resetGatewayLifecycleForTests(): void {
  stoppingSince = null;
}

/** Exit codes of a process killed by SIGKILL / SIGTERM (128 + signal). */
export function isSignalExit(code: number | null | undefined): boolean {
  return code === 137 || code === 143;
}
