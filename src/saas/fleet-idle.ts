// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export interface FleetIdleHost {
  broadcast: (event: string, payload: unknown) => void;
  closeClients: (code: number, reason: string) => number;
}

export function noteFleetActivity(_kind: string): void {}

export function fleetWorkBegin(_key: string, _kind: string): void {}

export function fleetWorkEnd(_key: string, _kind: string): void {}

export function noteFleetRpc(
  _method: string,
  _clientId: string | undefined,
  _isReadOnly: () => boolean,
): void {}

export function startFleetIdle(
  _host: FleetIdleHost,
  _env: NodeJS.ProcessEnv = process.env,
  _log: (msg: string) => void = () => {},
): (() => void) | null {
  return null;
}
