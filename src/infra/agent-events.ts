import type { VerboseLevel } from "../auto-reply/thinking.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /**
   * Internal sub-run (e.g. pre-compaction memory flush) whose lifecycle should
   * NOT surface to webchat as a `chat:final`. Without this guard the flush's
   * end emission masquerades as the user turn finishing — the UI runs its
   * destructive reset path (tool stream wipe, history reload) while the real
   * run is still going, leaving the chat stuck.
   */
  suppressChatBroadcast?: boolean;
};

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext>();
// Runs that already emitted a terminal lifecycle event (end/error). Lets a
// caller that catches a failure decide whether it still owes the UI a terminal
// event. Bounded FIFO — only recent runs matter.
const terminalLifecycleRuns = new Set<string>();
const MAX_TERMINAL_LIFECYCLE_RUNS = 1000;

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) return;
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
  if (
    context.suppressChatBroadcast !== undefined &&
    existing.suppressChatBroadcast !== context.suppressChatBroadcast
  ) {
    existing.suppressChatBroadcast = context.suppressChatBroadcast;
  }
}

export function getAgentRunContext(runId: string) {
  return runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
}

/** Test hook: number of runs with a live sequence counter. */
export function getAgentEventSeqRunCountForTest(): number {
  return seqByRun.size;
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const sessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : context?.sessionKey;
  if (
    event.stream === "lifecycle" &&
    (event.data?.phase === "end" || event.data?.phase === "error")
  ) {
    terminalLifecycleRuns.add(event.runId);
    if (terminalLifecycleRuns.size > MAX_TERMINAL_LIFECYCLE_RUNS) {
      const oldest = terminalLifecycleRuns.values().next().value;
      if (oldest !== undefined) {
        terminalLifecycleRuns.delete(oldest);
        // The per-run counter would otherwise live forever (one entry per run
        // ever emitted). Runs this old are long finished.
        if (oldest !== event.runId) seqByRun.delete(oldest);
      }
    }
  }
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
}

/** True once `runId` emitted a lifecycle `end` or `error` event. */
export function hasTerminalLifecycle(runId: string): boolean {
  return terminalLifecycleRuns.has(runId);
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
