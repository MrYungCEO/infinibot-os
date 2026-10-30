/**
 * Continuous workflow runner — autonomous-control daemon.
 *
 * Static workflows are one-shot: spawn an agent, return a runId, done.
 * Continuous workflows run indefinitely as a daemon, spawning one
 * iteration session at a time and advancing when an iteration ends.
 *
 * v1 contract (intentionally simple — see TODOs for v2 upgrades):
 *   - Each tick spawns a fresh agent session with the interpolated body.
 *   - The daemon waits `iterationIntervalSeconds` between iteration starts
 *     (interval acts as pacing AND as a coarse completion margin until we
 *     wire proper end-of-session detection via sessions.preview polling).
 *   - Stop conditions checked between iterations: manual stop, iteration
 *     limit, consecutive-failure streak.
 *   - Pause is honored: the daemon idles in 1s chunks until resumed.
 *   - Daemons live in-process under `daemons` (a Map keyed by parent runId).
 *     They DO NOT survive a gateway restart — restart-resume is v2 work.
 *
 * The parent WorkflowRun row tracks: iterationCount, errorStreak, stopReason,
 * stopRequestedBy, and an iterations[] tail (most recent 200) so the UI can
 * stream a live history.
 */

import { randomUUID } from "node:crypto";

import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

import { WorkflowStore } from "./store.js";
import { WorkflowRunStore, preflightWorkflow } from "./runner.js";
import type {
  ContinuousConfig,
  ContinuousStopReason,
  Workflow,
  WorkflowCliKind,
  WorkflowExecutionMode,
  WorkflowIteration,
  WorkflowRun,
} from "./types.js";

// Audit hook — best-effort. We don't take a hard dep on autonomy being
// initialized; if logAudit throws (e.g. tests, headless contexts), the
// daemon keeps going. The hash chain in audit.ts is internally
// idempotent so missing audit calls won't corrupt subsequent ones.
function safeAudit(
  actionType: string,
  description: string,
  details?: Record<string, unknown>,
): void {
  void import("../autonomy/audit.js")
    .then((mod) => {
      try {
        mod.logAudit(actionType as Parameters<typeof mod.logAudit>[0], description, { details });
      } catch {
        /* swallow — audit is best-effort */
      }
    })
    .catch(() => {
      /* autonomy not available — skip */
    });
}

const log = createSubsystemLogger("workflow").child("continuous");

// ── Native-tick registry ─────────────────────────────────────────────
//
// By default every continuous iteration spawns a fresh agent session with the
// interpolated markdown body as its task. Some workflows are pure code, not
// prose — they want to run a deterministic TypeScript function each tick
// (list subagents, shell out to git/npm, etc.) instead of paying for an agent
// spawn. Such workflows register a native tick keyed by workflow id; when the
// daemon sees one it calls the function in-process and skips the spawn.

export interface NativeTickContext {
  workflowId: string;
  iteration: number;
  inputs: Record<string, unknown>;
  config: ContinuousConfig;
  /** Append a line to the iteration log (also mirrored to the subsystem log). */
  log: (line: string) => void;
  /** Aborts when the daemon is stopped/paused so long shell-outs bail early. */
  signal: AbortSignal;
}

export interface NativeTickResult {
  ok: boolean;
  /** Short human summary surfaced as the iteration result. */
  summary?: string;
  /** Error message when ok === false; drives the error-streak counter. */
  error?: string;
}

export type NativeContinuousTick = (ctx: NativeTickContext) => Promise<NativeTickResult>;

const nativeTicks = new Map<string, NativeContinuousTick>();

/**
 * Register a native (code) tick for a continuous workflow. When the daemon for
 * `workflowId` runs an iteration it invokes `fn` in-process instead of spawning
 * an agent. Idempotent — re-registering replaces the prior function.
 */
export function registerNativeContinuousTick(workflowId: string, fn: NativeContinuousTick): void {
  nativeTicks.set(workflowId, fn);
  log.info(`registered native tick for workflow '${workflowId}'`);
}

export function hasNativeContinuousTick(workflowId: string): boolean {
  return nativeTicks.has(workflowId);
}

const ITERATION_HISTORY_TAIL = 200;
const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_ITERATION_TIMEOUT_SECONDS = 600;
const PAUSE_POLL_MS = 1_000;

/** Default config applied when a continuous workflow doesn't declare its own. */
export const DEFAULT_CONTINUOUS_CONFIG: ContinuousConfig = {
  iterationIntervalSeconds: DEFAULT_INTERVAL_SECONDS,
  maxIterations: null,
  iterationTimeoutSeconds: DEFAULT_ITERATION_TIMEOUT_SECONDS,
  errorStreakThreshold: 5,
  stopOn: ["manual", "iteration_limit", "error_streak"],
};

interface DaemonHandle {
  runId: string;
  workflowId: string;
  stop: (reason: ContinuousStopReason, requestedBy: string) => void;
  pause: (requestedBy: string) => void;
  resume: (requestedBy: string) => void;
  status: () => DaemonStatus;
}

interface DaemonStatus {
  runId: string;
  workflowId: string;
  paused: boolean;
  stopped: boolean;
  stopReason?: ContinuousStopReason;
  stopRequestedBy?: string;
  iterationCount: number;
  errorStreak: number;
}

const daemons = new Map<string, DaemonHandle>();

/** Returns the live daemon handle for a parent run, or null if not running. */
export function getDaemon(runId: string): DaemonHandle | null {
  return daemons.get(runId) ?? null;
}

/** Snapshot of every active continuous daemon (for the Autonomy UI). */
export function listDaemons(): DaemonStatus[] {
  return Array.from(daemons.values()).map((d) => d.status());
}

export interface StartContinuousOpts {
  inputs?: Record<string, unknown>;
  agentId?: string;
  model?: string;
  /** Override the workflow's configured continuous config (rare; mostly for tests). */
  continuous?: Partial<ContinuousConfig>;
  /** Spawn each iteration as a native gateway agent ("gateway", default) or
   *  inside a long-lived PTY running the chosen CLI ("terminal"). */
  executionMode?: WorkflowExecutionMode;
  /** CLI to launch when executionMode === "terminal". Defaults to "claude". */
  cli?: WorkflowCliKind;
  /** Working directory for terminal-mode iterations. Defaults to ".". */
  cwd?: string;
}

export async function startContinuousWorkflow(params: {
  stateDir: string;
  workflowId: string;
  opts?: StartContinuousOpts;
}): Promise<{ run: WorkflowRun }> {
  const { stateDir, workflowId } = params;
  const opts = params.opts ?? {};
  const store = new WorkflowStore(stateDir);
  const runStore = new WorkflowRunStore(stateDir);
  const wf = store.get(workflowId);
  if (!wf) throw new Error(`workflow '${workflowId}' not found`);
  if (wf.kind !== "continuous") {
    throw new Error(`workflow '${workflowId}' is kind=${wf.kind ?? "static"}, not 'continuous'`);
  }

  const preflight = await preflightWorkflow(wf, { inputs: opts.inputs });
  const runId = `wfr_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const agent = opts.agentId ?? wf.agent ?? "main";
  const executionMode: WorkflowExecutionMode = opts.executionMode ?? "gateway";
  const cli: WorkflowCliKind = opts.cli ?? "claude";
  const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : ".";

  if (!preflight.ok) {
    const summary = preflight.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.detail)
      .join("; ");
    const failed: WorkflowRun = {
      id: runId,
      workflowId: wf.id,
      workflowName: wf.name,
      kind: "continuous",
      status: "failed",
      inputs: preflight.resolvedInputs,
      agent,
      startedAt,
      finishedAt: startedAt,
      error: `preflight failed: ${summary}`,
      preflight,
      iterationCount: 0,
      errorStreak: 0,
    };
    runStore.insert(failed);
    return { run: failed };
  }

  const config: ContinuousConfig = {
    ...DEFAULT_CONTINUOUS_CONFIG,
    ...wf.continuous,
    ...opts.continuous,
  };

  const parentRun: WorkflowRun = {
    id: runId,
    workflowId: wf.id,
    workflowName: wf.name,
    kind: "continuous",
    status: "running",
    inputs: preflight.resolvedInputs,
    agent,
    startedAt,
    preflight,
    iterations: [],
    iterationCount: 0,
    errorStreak: 0,
    executionMode,
    cli: executionMode === "terminal" ? cli : undefined,
  };
  runStore.insert(parentRun);

  // ── Spin up the daemon ────────────────────────────────────
  const state: {
    stopped: boolean;
    paused: boolean;
    stopReason?: ContinuousStopReason;
    stopRequestedBy?: string;
    iterationCount: number;
    errorStreak: number;
    /** Aborts the in-flight native tick (if any) when the daemon is stopped. */
    abort?: () => void;
  } = {
    stopped: false,
    paused: false,
    iterationCount: 0,
    errorStreak: 0,
  };

  const handle: DaemonHandle = {
    runId,
    workflowId: wf.id,
    stop(reason, requestedBy) {
      if (state.stopped) return;
      state.stopped = true;
      state.stopReason = reason;
      state.stopRequestedBy = requestedBy;
      state.abort?.();
      log.info(`daemon ${runId} stop requested: ${reason} (${requestedBy})`);
    },
    pause(requestedBy) {
      if (state.paused) return;
      state.paused = true;
      log.info(`daemon ${runId} paused (${requestedBy})`);
    },
    resume(requestedBy) {
      if (!state.paused) return;
      state.paused = false;
      log.info(`daemon ${runId} resumed (${requestedBy})`);
    },
    status: () => ({
      runId,
      workflowId: wf.id,
      paused: state.paused,
      stopped: state.stopped,
      stopReason: state.stopReason,
      stopRequestedBy: state.stopRequestedBy,
      iterationCount: state.iterationCount,
      errorStreak: state.errorStreak,
    }),
  };
  daemons.set(runId, handle);

  safeAudit("task_started", `continuous workflow '${wf.name}' started`, {
    runId,
    workflowId: wf.id,
    config,
  });

  // Run the loop in the background. We deliberately do not await it —
  // the caller gets the parent run back immediately and the daemon
  // emits updates via runStore.update.
  void daemonLoop({
    parentRunId: runId,
    workflow: wf,
    config,
    agent,
    inputs: preflight.resolvedInputs ?? {},
    interpolatedBody: preflight.interpolatedBody ?? wf.body,
    state,
    runStore,
    executionMode,
    cli,
    cwd,
  }).catch((err) => {
    log.error(`daemon ${runId} crashed: ${err instanceof Error ? err.message : String(err)}`);
    runStore.update(runId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: `daemon crashed: ${err instanceof Error ? err.message : String(err)}`,
      iterationCount: state.iterationCount,
      errorStreak: state.errorStreak,
    });
    daemons.delete(runId);
  });

  return { run: parentRun };
}

interface LoopParams {
  parentRunId: string;
  workflow: Workflow;
  config: ContinuousConfig;
  agent: string;
  inputs: Record<string, unknown>;
  interpolatedBody: string;
  state: {
    stopped: boolean;
    paused: boolean;
    stopReason?: ContinuousStopReason;
    stopRequestedBy?: string;
    iterationCount: number;
    errorStreak: number;
    abort?: () => void;
  };
  runStore: WorkflowRunStore;
  /** Inherited from the parent run; controls how each iteration is spawned. */
  executionMode: WorkflowExecutionMode;
  cli: WorkflowCliKind;
  cwd: string;
}

async function daemonLoop(p: LoopParams): Promise<void> {
  const {
    parentRunId,
    workflow,
    config,
    agent,
    inputs,
    interpolatedBody,
    state,
    runStore,
    executionMode,
    cli,
    cwd,
  } = p;

  const iterationTimeoutSeconds =
    config.iterationTimeoutSeconds ?? workflow.timeoutSeconds ?? DEFAULT_ITERATION_TIMEOUT_SECONDS;

  while (!state.stopped) {
    // Honor pause: idle in short chunks so resume is responsive.
    if (state.paused) {
      runStore.update(parentRunId, {
        status: "paused",
        iterationCount: state.iterationCount,
        errorStreak: state.errorStreak,
      });
      await sleep(PAUSE_POLL_MS);
      continue;
    }

    // Bring status back to running if we just resumed from pause.
    const current = runStore.get(parentRunId);
    if (current && current.status === "paused") {
      runStore.update(parentRunId, { status: "running" });
    }

    // Check non-manual stop conditions.
    if (
      config.maxIterations !== null &&
      state.iterationCount >= config.maxIterations &&
      config.stopOn.includes("iteration_limit")
    ) {
      state.stopped = true;
      state.stopReason = "iteration_limit";
      state.stopRequestedBy = "system";
      break;
    }
    if (
      config.errorStreakThreshold > 0 &&
      state.errorStreak >= config.errorStreakThreshold &&
      config.stopOn.includes("error_streak")
    ) {
      state.stopped = true;
      state.stopReason = "error_streak";
      state.stopRequestedBy = "system";
      break;
    }

    state.iterationCount += 1;
    const iteration: WorkflowIteration = {
      number: state.iterationCount,
      startedAt: new Date().toISOString(),
      status: "pending",
    };
    appendIteration(runStore, parentRunId, iteration);
    safeAudit(
      "iteration_started",
      `continuous workflow '${workflow.name}' iteration ${state.iterationCount}`,
      { runId: parentRunId, workflowId: workflow.id, iteration: state.iterationCount },
    );

    const iterationLabel = `workflow:${workflow.id}#${state.iterationCount}`;
    let outcome: Pick<
      WorkflowIteration,
      "status" | "result" | "error" | "sessionKey" | "spawnRunId" | "terminalId"
    >;
    const iterStart = Date.now();
    const nativeTick = nativeTicks.get(workflow.id);
    try {
      if (nativeTick) {
        // Native code tick: run in-process, abortable when the daemon stops.
        const ac = new AbortController();
        state.abort = () => ac.abort();
        const lines: string[] = [];
        const tickLog = (line: string) => {
          lines.push(line);
          log.info(`[${workflow.id}#${state.iterationCount}] ${line}`);
        };
        try {
          const res = await nativeTick({
            workflowId: workflow.id,
            iteration: state.iterationCount,
            inputs,
            config,
            log: tickLog,
            signal: ac.signal,
          });
          outcome = res.ok
            ? { status: "completed", result: res.summary ?? lines.slice(-1)[0] }
            : { status: "failed", error: res.error ?? "native tick failed" };
        } finally {
          state.abort = undefined;
        }
      } else if (executionMode === "terminal") {
        // Per-iteration runId so each PTY is independently addressable from
        // the iteration list — clicking iteration #3 should resolve to that
        // specific terminal, not the parent run's last terminal.
        const iterRunId = `${parentRunId}#${state.iterationCount}`;
        const iterSessionKey = `${iterationLabel}:${state.iterationCount}`;
        const termRes = (await callGateway({
          method: "terminal.spawnAgent",
          params: {
            cli,
            cwd,
            task: interpolatedBody,
            label: iterationLabel,
            runId: iterRunId,
            sessionKey: iterSessionKey,
            agentId: agent,
            autoClose: false,
          },
          timeoutMs: 30_000,
        })) as { success?: boolean; terminalId?: string; error?: string };
        if (!termRes?.success || !termRes.terminalId) {
          outcome = {
            status: "failed",
            error: `terminal.spawnAgent failed: ${termRes?.error ?? "unknown"}`,
          };
        } else {
          outcome = {
            status: "completed",
            sessionKey: iterSessionKey,
            spawnRunId: iterRunId,
            terminalId: termRes.terminalId,
          };
        }
      } else {
        const spawnRes = (await callGateway({
          method: "sessions.spawn",
          params: {
            task: interpolatedBody,
            agentId: agent,
            label: iterationLabel,
            model: workflow.model,
            runTimeoutSeconds: iterationTimeoutSeconds,
          },
          timeoutMs: Math.min(iterationTimeoutSeconds * 1000, 30 * 60_000),
        })) as
          | {
              childSessionKey?: string;
              sessionKey?: string;
              runId?: string;
              status?: string;
              error?: string;
            }
          | undefined;
        if (spawnRes?.status === "error") {
          outcome = {
            status: "failed",
            error: spawnRes.error ?? "sessions.spawn returned error",
          };
        } else {
          outcome = {
            status: "completed",
            sessionKey: spawnRes?.childSessionKey ?? spawnRes?.sessionKey,
            spawnRunId: spawnRes?.runId,
          };
        }
      }
    } catch (err) {
      outcome = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const durationMs = Date.now() - iterStart;
    const finished: WorkflowIteration = {
      ...iteration,
      ...outcome,
      finishedAt: new Date().toISOString(),
      durationMs,
    };
    updateLastIteration(runStore, parentRunId, finished);

    if (finished.status === "failed") {
      state.errorStreak += 1;
    } else {
      state.errorStreak = 0;
    }
    runStore.update(parentRunId, {
      iterationCount: state.iterationCount,
      errorStreak: state.errorStreak,
      result: finished.result,
      // Surface the latest iteration's PTY id as the parent run's primary
      // terminalId so the workflow card always opens the most recent live
      // session by default. Falsy iteration terminalIds are ignored.
      ...(finished.terminalId ? { terminalId: finished.terminalId } : {}),
    });
    safeAudit(
      "iteration_assess",
      `iteration ${state.iterationCount} ${finished.status}${
        finished.error ? `: ${finished.error}` : ""
      }`,
      {
        runId: parentRunId,
        workflowId: workflow.id,
        iteration: state.iterationCount,
        outcome: finished.status,
        durationMs,
        errorStreak: state.errorStreak,
      },
    );

    if (state.stopped) break;

    // Sleep between iterations. Bounded by 60s slices so a long interval
    // still notices stop/pause promptly.
    if (config.iterationIntervalSeconds > 0) {
      const totalMs = config.iterationIntervalSeconds * 1000;
      let waited = 0;
      while (waited < totalMs && !state.stopped) {
        if (state.paused) break;
        const chunk = Math.min(60_000, totalMs - waited);
        await sleep(chunk);
        waited += chunk;
      }
    }
  }

  const finalStatus = state.stopReason === "error_streak" ? "failed" : "completed";
  runStore.update(parentRunId, {
    status: finalStatus,
    finishedAt: new Date().toISOString(),
    iterationCount: state.iterationCount,
    errorStreak: state.errorStreak,
    stopReason: state.stopReason ?? "manual",
    stopRequestedBy: state.stopRequestedBy ?? "user",
  });
  daemons.delete(parentRunId);
  safeAudit(
    finalStatus === "failed" ? "task_failed" : "task_completed",
    `continuous workflow '${workflow.name}' ended (${state.stopReason ?? "manual"})`,
    {
      runId: parentRunId,
      workflowId: workflow.id,
      iterations: state.iterationCount,
      stopReason: state.stopReason ?? "manual",
      stopRequestedBy: state.stopRequestedBy ?? "user",
    },
  );
  log.info(
    `daemon ${parentRunId} ended: reason=${state.stopReason ?? "manual"}, iterations=${state.iterationCount}`,
  );
}

function appendIteration(
  runStore: WorkflowRunStore,
  parentRunId: string,
  iteration: WorkflowIteration,
): void {
  const parent = runStore.get(parentRunId);
  if (!parent) return;
  const iterations = [...(parent.iterations ?? []), iteration];
  if (iterations.length > ITERATION_HISTORY_TAIL) {
    iterations.splice(0, iterations.length - ITERATION_HISTORY_TAIL);
  }
  runStore.update(parentRunId, { iterations });
}

function updateLastIteration(
  runStore: WorkflowRunStore,
  parentRunId: string,
  finished: WorkflowIteration,
): void {
  const parent = runStore.get(parentRunId);
  if (!parent) return;
  const iterations = parent.iterations ?? [];
  const idx = iterations.findIndex((i) => i.number === finished.number);
  if (idx < 0) {
    iterations.push(finished);
  } else {
    iterations[idx] = finished;
  }
  if (iterations.length > ITERATION_HISTORY_TAIL) {
    iterations.splice(0, iterations.length - ITERATION_HISTORY_TAIL);
  }
  runStore.update(parentRunId, { iterations });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Control surface ──────────────────────────────────────────────────

export function stopContinuousRun(
  runId: string,
  requestedBy: string = "user",
  reason: ContinuousStopReason = "manual",
): boolean {
  const handle = daemons.get(runId);
  if (!handle) return false;
  handle.stop(reason, requestedBy);
  return true;
}

export function pauseContinuousRun(runId: string, requestedBy: string = "user"): boolean {
  const handle = daemons.get(runId);
  if (!handle) return false;
  handle.pause(requestedBy);
  return true;
}

export function resumeContinuousRun(runId: string, requestedBy: string = "user"): boolean {
  const handle = daemons.get(runId);
  if (!handle) return false;
  handle.resume(requestedBy);
  return true;
}

/**
 * Reconcile run records left in a "running" or "paused" state with no live
 * daemon — which happens when the gateway process was killed while a
 * continuous workflow was active. Call once on gateway startup (or lazily on
 * first use) so the UI never shows a permanently-stuck "running" card.
 *
 * Returns the number of runs that were updated.
 */
export function reconcileStaleContinuousRuns(stateDir: string): number {
  const runStore = new WorkflowRunStore(stateDir);
  const runs = runStore.list();
  const now = new Date().toISOString();
  let fixed = 0;
  for (const run of runs) {
    if (run.kind !== "continuous") continue;
    if (run.status !== "running" && run.status !== "paused") continue;
    if (daemons.has(run.id)) continue; // live daemon — leave it alone
    runStore.update(run.id, {
      status: "failed",
      finishedAt: now,
      stopReason: "manual",
      stopRequestedBy: "gateway_restart",
      error: "Interrupted: gateway restarted while daemon was active",
    });
    log.info(`reconciled stale continuous run ${run.id} (was ${run.status})`);
    fixed++;
  }
  return fixed;
}
