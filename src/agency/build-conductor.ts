// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export type ConductorLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type BuildConductorScheduler = {
  runOnce: () => Promise<null>;
  stop: () => void;
  intervalMs: number;
};

export type BuildConductorSchedulerOptions = {
  projectDir: string;
  intervalMs: number;
  isEnabled: () => boolean | Promise<boolean>;
  runOnStart?: boolean;
  log?: ConductorLogger;
};

export function startBuildConductorScheduler(
  options: BuildConductorSchedulerOptions,
): BuildConductorScheduler {
  return { runOnce: async () => null, stop: () => {}, intervalMs: options.intervalMs };
}
