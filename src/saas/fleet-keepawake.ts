// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export interface KeepAwake {
  acquire(): () => void;
  stop(): void;
}

export function fleetKeepAwake(): KeepAwake | null {
  return null;
}

export function startFleetKeepAwake(
  _env: NodeJS.ProcessEnv = process.env,
  _log: (msg: string) => void = () => {},
): (() => void) | null {
  return null;
}
