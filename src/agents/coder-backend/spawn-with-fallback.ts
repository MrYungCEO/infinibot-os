/**
 * Launch-failure detection + automatic fallback for coder-backend spawns.
 *
 * "Launch failure" means the backend never really got going: the binary is
 * missing, auth failed, or the process exited non-zero before producing any
 * output (i.e. before the first turn). It does NOT mean a task that started
 * fine and later failed — that is a normal run outcome, not a launch failure.
 *
 * Both helpers here are pure orchestration and take their effects as
 * parameters, so they can be unit-tested without spawning real processes.
 */

import type { CoderBackendId } from "./types.js";

/** One launch attempt's outcome, recorded on the run record for visibility. */
export type CoderLaunchAttempt = {
  backend: CoderBackendId;
  ok: boolean;
  error?: string;
  exitCode?: number | null;
};

/** Result of a single backend launch attempt. */
export type SpawnAttemptOutcome<T> =
  | { ok: true; session: T; exitCode?: number | null }
  | { ok: false; error: string; exitCode?: number | null };

export type SpawnWithFallbackResult<T> =
  | { ok: true; session: T; backendUsed: CoderBackendId; attempts: CoderLaunchAttempt[] }
  | { ok: false; error: string; backendUsed: null; attempts: CoderLaunchAttempt[] };

/**
 * Try the primary backend; if it fails to launch, retry once with the fallback
 * (when provided and distinct). Records every attempt so the run record can
 * show both. Never retries more than once.
 */
export async function spawnCoderWithFallback<T>(opts: {
  primary: CoderBackendId;
  fallback?: CoderBackendId;
  attempt: (backend: CoderBackendId, isFallback: boolean) => Promise<SpawnAttemptOutcome<T>>;
  onAttempt?: (attempt: CoderLaunchAttempt) => void;
}): Promise<SpawnWithFallbackResult<T>> {
  const attempts: CoderLaunchAttempt[] = [];

  const record = (backend: CoderBackendId, outcome: SpawnAttemptOutcome<T>): CoderLaunchAttempt => {
    const attempt: CoderLaunchAttempt = outcome.ok
      ? { backend, ok: true, exitCode: outcome.exitCode }
      : { backend, ok: false, error: outcome.error, exitCode: outcome.exitCode };
    attempts.push(attempt);
    opts.onAttempt?.(attempt);
    return attempt;
  };

  const primaryOutcome = await opts.attempt(opts.primary, false);
  record(opts.primary, primaryOutcome);
  if (primaryOutcome.ok) {
    return { ok: true, session: primaryOutcome.session, backendUsed: opts.primary, attempts };
  }

  if (opts.fallback && opts.fallback !== opts.primary) {
    const fallbackOutcome = await opts.attempt(opts.fallback, true);
    record(opts.fallback, fallbackOutcome);
    if (fallbackOutcome.ok) {
      return { ok: true, session: fallbackOutcome.session, backendUsed: opts.fallback, attempts };
    }
    return {
      ok: false,
      error: fallbackOutcome.error,
      backendUsed: null,
      attempts,
    };
  }

  return { ok: false, error: primaryOutcome.error, backendUsed: null, attempts };
}

/** Minimal shape of a background session we need to probe. */
export type ProbeableBackgroundSession = {
  pid?: number;
  finalPromise: Promise<{ exitCode: number | null; output?: string }>;
};

export type ProbeResult = {
  /** True when the backend appears to have launched successfully. */
  started: boolean;
  exitCode?: number | null;
  error?: string;
};

/**
 * Decide whether a background coder launched successfully.
 *
 * Resolves as soon as one of these wins the race:
 *  - first stdout chunk arrives  → started (it's producing output)
 *  - the grace window elapses with the process still alive → started
 *  - the process exits within the grace window:
 *      exitCode === 0 → started (a trivially fast, successful run)
 *      otherwise      → NOT started (launch failure)
 *
 * A missing pid is treated as an immediate launch failure (the OS never
 * spawned the child).
 */
export async function probeBackgroundStart(
  bg: ProbeableBackgroundSession,
  opts: { graceMs: number; firstOutput: Promise<void> },
): Promise<ProbeResult> {
  if (bg.pid === undefined || bg.pid === null) {
    // Give finalPromise a brief chance to surface the underlying error message.
    const info = await Promise.race([
      bg.finalPromise.then((i) => ({ kind: "exit" as const, info: i })),
      delay(Math.min(opts.graceMs, 1000)).then(() => ({ kind: "timeout" as const })),
    ]);
    if (info.kind === "exit") {
      return {
        started: false,
        exitCode: info.info.exitCode,
        error: launchError(info.info.exitCode),
      };
    }
    return { started: false, error: "backend process did not start (no pid)" };
  }

  const outcome = await Promise.race([
    opts.firstOutput.then(() => ({ kind: "output" as const })),
    bg.finalPromise.then((info) => ({ kind: "exit" as const, info })),
    delay(opts.graceMs).then(() => ({ kind: "grace" as const })),
  ]);

  if (outcome.kind === "output" || outcome.kind === "grace") {
    return { started: true };
  }

  // Exited within the grace window before any output.
  const { exitCode } = outcome.info;
  if (exitCode === 0) return { started: true, exitCode };
  return { started: false, exitCode, error: launchError(exitCode) };
}

function launchError(exitCode: number | null): string {
  return exitCode === null
    ? "backend exited before producing output (no exit code)"
    : `backend exited with code ${exitCode} before producing output`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
