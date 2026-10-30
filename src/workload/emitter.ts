import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { appendWorkEvent } from "./store.js";
import type { WorkEvent, WorkEventKind, WorkEventSource } from "./types.js";

const log = createSubsystemLogger("workload-emitter");

type PendingEvent = WorkEvent;

let queue: PendingEvent[] = [];
let drainScheduled = false;
let warnedDisabled = false;

function isEnabled(): boolean {
  try {
    const cfg = loadConfig();
    return (cfg as any).workloadTracking?.enabled !== false;
  } catch {
    return true;
  }
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(drain);
}

function drain(): void {
  drainScheduled = false;
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  for (const event of batch) {
    try {
      appendWorkEvent(resolveStateDir(), event);
    } catch (err) {
      log.warn("workload emit failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function emitWorkEvent(partial: Omit<WorkEvent, "ts"> & { ts?: number }): void {
  try {
    if (!isEnabled()) {
      if (!warnedDisabled) {
        warnedDisabled = true;
        log.warn("workload tracking is disabled — events suppressed");
      }
      return;
    }
    warnedDisabled = false;

    const event: WorkEvent = {
      ts: partial.ts ?? Date.now(),
      kind: partial.kind,
      source: partial.source,
      durationMs: partial.durationMs,
      label: (partial.label ?? "").slice(0, 200),
      projectId: partial.projectId,
      taskId: partial.taskId,
      runId: partial.runId,
      metadata: partial.metadata,
    };

    queue.push(event);
    scheduleDrain();
  } catch (err) {
    /* fire-and-forget: swallow all errors */
    log.warn("emitWorkEvent threw unexpectedly", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function emitSubagentStarted(opts: {
  runId: string;
  label?: string;
  task: string;
  projectId?: string;
  taskId?: string;
}): void {
  emitWorkEvent({
    kind: "subagent_started" as WorkEventKind,
    source: "subagent_registry" as WorkEventSource,
    label: opts.label || opts.task.slice(0, 120),
    runId: opts.runId,
    projectId: opts.projectId,
    taskId: opts.taskId,
  });
}

export function emitSubagentCompleted(opts: {
  runId: string;
  label?: string;
  task: string;
  startedAt?: number;
  endedAt?: number;
  projectId?: string;
  taskId?: string;
}): void {
  const durationMs = opts.startedAt && opts.endedAt ? opts.endedAt - opts.startedAt : undefined;
  emitWorkEvent({
    kind: "subagent_completed" as WorkEventKind,
    source: "subagent_registry" as WorkEventSource,
    label: opts.label || opts.task.slice(0, 120),
    runId: opts.runId,
    durationMs,
    projectId: opts.projectId,
    taskId: opts.taskId,
  });
}

export function emitSubagentFailed(opts: {
  runId: string;
  label?: string;
  task: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  projectId?: string;
  taskId?: string;
}): void {
  const durationMs = opts.startedAt && opts.endedAt ? opts.endedAt - opts.startedAt : undefined;
  emitWorkEvent({
    kind: "subagent_failed" as WorkEventKind,
    source: "subagent_registry" as WorkEventSource,
    label: opts.label || opts.task.slice(0, 120),
    runId: opts.runId,
    durationMs,
    projectId: opts.projectId,
    taskId: opts.taskId,
    metadata: opts.error ? { error: opts.error.slice(0, 200) } : undefined,
  });
}
