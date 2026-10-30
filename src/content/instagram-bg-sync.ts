// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export interface InstagramBgSyncOptions {
  intervalMs?: number;
  perPageDelayMs?: number;
  runOnStart?: boolean;
}

export function startInstagramBgSync(
  _stateDir: string,
  _opts?: InstagramBgSyncOptions,
): { stop: () => void; counters: () => Record<string, number>; running: () => boolean } {
  return { stop: () => {}, counters: () => ({}), running: () => false };
}
