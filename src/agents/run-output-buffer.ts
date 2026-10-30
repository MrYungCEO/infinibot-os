/**
 * In-memory run output buffer.
 *
 * Accumulates structured activity lines per runId so the SSE endpoint
 * (/api/runs/:runId/stream) can replay them to late subscribers and push
 * new lines in real time.
 *
 * Lines are sourced from the existing broadcast hooks in subagent-broadcast.ts
 * (tool events, checkpoints, lifecycle events, progress updates) — no changes
 * to the off-limits claude-coder-tool.ts are required.
 */

export type RunLineType = "tool" | "checkpoint" | "status" | "progress" | "lifecycle";

export interface RunOutputLine {
  type: RunLineType;
  text: string;
  ts: number;
}

type LineSubscriber = (line: RunOutputLine) => void;

const MAX_LINES_PER_RUN = 2000;
const MAX_RUN_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

const buffers = new Map<string, RunOutputLine[]>();
const subscribers = new Map<string, Set<LineSubscriber>>();
const runStartTs = new Map<string, number>();

/** Append a line to the buffer and push to SSE subscribers. */
export function appendRunLine(runId: string, line: RunOutputLine): void {
  if (!runId) return;

  let buf = buffers.get(runId);
  if (!buf) {
    buf = [];
    buffers.set(runId, buf);
    runStartTs.set(runId, Date.now());
  }
  buf.push(line);
  if (buf.length > MAX_LINES_PER_RUN) {
    buf.splice(0, buf.length - MAX_LINES_PER_RUN);
  }

  const subs = subscribers.get(runId);
  if (subs) {
    for (const sub of subs) {
      try {
        sub(line);
      } catch {
        /* non-fatal */
      }
    }
  }
}

/** Get all buffered lines for a run, newest-last (chronological order). */
export function getBufferedLines(runId: string): RunOutputLine[] {
  return buffers.get(runId) ?? [];
}

/**
 * Subscribe to new lines for a run.
 * Returns an unsubscribe function.
 */
export function subscribeRunLines(runId: string, cb: LineSubscriber): () => void {
  let subs = subscribers.get(runId);
  if (!subs) {
    subs = new Set();
    subscribers.set(runId, subs);
  }
  subs.add(cb);
  return () => {
    const s = subscribers.get(runId);
    if (s) {
      s.delete(cb);
      if (s.size === 0) subscribers.delete(runId);
    }
  };
}

/** Mark a run as ended — keeps buffer alive for late subscribers, schedules GC. */
export function markRunEnded(runId: string): void {
  // Buffer stays readable; sweep clears it after age limit.
  scheduleGc();
}

let gcTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleGc(): void {
  if (gcTimer) return;
  gcTimer = setTimeout(() => {
    gcTimer = null;
    const cutoff = Date.now() - MAX_RUN_AGE_MS;
    for (const [runId, ts] of runStartTs) {
      if (ts < cutoff) {
        buffers.delete(runId);
        subscribers.delete(runId);
        runStartTs.delete(runId);
      }
    }
  }, 5 * 60 * 1000);
}
