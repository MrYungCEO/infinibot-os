/**
 * Discipline Auto-Log
 *
 * Subscribes to the gateway agent-event stream and the core work-completion
 * events (both handed in by the host — api.runtime.host) and writes one
 * discipline_event row per interesting event, attributed to whichever
 * discipline block is currently active at event time.
 *
 * Started and stopped by the plugin's service (index.ts) — never at import.
 * Silently swallows all errors — it must never interrupt the event bus.
 */

import type { AgentEventPayload } from "../../../src/infra/agent-events.js";
import type { WorkCompletedEvent } from "../../../src/infra/work-completions.js";
import { getDisciplineStore } from "./store.js";

export type AutoLogDeps = {
  stateDir: () => string;
  onAgentEvent: (handler: (evt: AgentEventPayload) => void) => () => void;
  onWorkCompleted: (handler: (evt: WorkCompletedEvent) => void) => () => void;
  log: { info: (m: string) => void; warn: (m: string) => void };
};

let log: AutoLogDeps["log"] = { info: () => {}, warn: () => {} };

let started = false;
let unsubscribe: (() => void) | null = null;
let unsubCompletion: (() => void) | null = null;

/** Map agent stream name → discipline event kind prefix. */
const STREAM_KIND: Record<string, string> = {
  lifecycle: "agent:lifecycle",
  tool: "agent:tool",
  assistant: "agent:assistant",
  error: "agent:error",
};

/** Streams to skip (too noisy — assistant tokens fire for every chunk). */
const SKIP_STREAMS = new Set(["assistant"]);

export function startDisciplineAutoLog(deps: AutoLogDeps): () => void {
  if (started) return stopDisciplineAutoLog;
  started = true;
  log = deps.log;
  const stateDir = () => deps.stateDir();

  unsubscribe = deps.onAgentEvent((evt) => {
    if (SKIP_STREAMS.has(evt.stream)) return;
    try {
      const store = getDisciplineStore(stateDir());
      const nowMs = Date.now();
      maybeAutoStartDay(store, nowMs);
      const blockId = resolveActiveBlockId(store, nowMs);
      const kind = STREAM_KIND[evt.stream] ?? `agent:${evt.stream}`;
      const payload: Record<string, unknown> = {
        runId: evt.runId,
        seq: evt.seq,
      };
      if (evt.sessionKey) payload.sessionKey = evt.sessionKey;
      // For tool events include tool name (if present in data)
      if (evt.stream === "tool") {
        if (evt.data.tool_name) payload.toolName = evt.data.tool_name;
        if (evt.data.tool_use_id) payload.toolUseId = evt.data.tool_use_id;
      }
      // For lifecycle include agent status
      if (evt.stream === "lifecycle" && evt.data.status) {
        payload.status = evt.data.status;
      }
      store.createDisciplineEvent({ blockId, kind, payload });
    } catch (e) {
      log.warn(`discipline auto-log write failed: ${String(e)}`);
    }
  });

  unsubCompletion = deps.onWorkCompleted((evt) => {
    try {
      const store = getDisciplineStore(stateDir());
      maybeAutoStartDay(store, evt.completedAt);
      const blockId = resolveActiveBlockId(store, evt.completedAt);
      const kind = evt.source === "kanban" ? "kanban:task_done" : "agent:completed";
      store.createDisciplineEvent({
        blockId,
        kind,
        payload: { sourceId: evt.sourceId, title: evt.title, completedAt: evt.completedAt },
      });

      // Auto-mark the active block complete when real work landed inside it.
      // The user complained they had to manually log every block — this
      // closes the gap: any task completion (kanban or agent run) inside a
      // block window is strong evidence that the block actually happened, so
      // we mark it done idempotently. `markBlockComplete` already short-
      // circuits when a completion row exists for (blockId, today), so this
      // is safe to call on every completion.
      if (blockId) {
        const now = new Date(evt.completedAt);
        const todayIso = now.toISOString().slice(0, 10);
        const nowMinute = now.getHours() * 60 + now.getMinutes();
        try {
          const result = store.markBlockComplete(blockId, todayIso, nowMinute);
          // Only log "auto-marked" on the first transition (savedMinute > 0
          // is a fresh insert; existing rows are returned unchanged with the
          // original savedMinute). The cheapest "is this new?" signal is
          // whether we just created an override — `markBlockComplete` only
          // returns a non-null override on a fresh insert with time saved.
          if (result.override) {
            log.info(
              `discipline: auto-marked block ${blockId} complete (${evt.source} ${evt.sourceId}, saved ${result.completion.savedMinute}m)`,
            );
          }
        } catch (markErr) {
          log.warn(`discipline auto-mark block ${blockId} failed: ${String(markErr)}`);
        }
      }
    } catch (e) {
      log.warn(`discipline completion event write failed: ${String(e)}`);
    }
  });

  log.info("discipline auto-log started");
  return stopDisciplineAutoLog;
}

export function stopDisciplineAutoLog(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubCompletion) {
    unsubCompletion();
    unsubCompletion = null;
  }
  started = false;
}

/**
 * Auto-start the discipline day on the first real activity of the day.
 *
 * The user shouldn't have to press "Start day" — the first task completion or
 * agent interaction is proof the day began. `markDayStarted` is idempotent
 * (one row per local date), so this is a cheap no-op after the first call. On
 * the first transition we also emit a `day:started` discipline event so the UI
 * feed / alert overlay can react.
 */
function maybeAutoStartDay(store: ReturnType<typeof getDisciplineStore>, nowMs: number): void {
  try {
    const now = new Date(nowMs);
    const todayIso = now.toISOString().slice(0, 10);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const res = store.markDayStarted(todayIso, nowMin, "auto");
    if (res.started) {
      store.createDisciplineEvent({
        blockId: resolveActiveBlockId(store, nowMs),
        kind: "day:started",
        payload: { startMinute: nowMin, source: "auto" },
      });
      log.info(`discipline day auto-started ${todayIso} at minute ${nowMin}`);
    }
  } catch (e) {
    log.warn(`discipline auto-start day failed: ${String(e)}`);
  }
}

function resolveActiveBlockId(
  store: ReturnType<typeof getDisciplineStore>,
  nowMs: number,
): string | null {
  try {
    const now = new Date(nowMs);
    const todayIso = now.toISOString().slice(0, 10);
    const dow = now.getDay();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const blocks = store.getBlocks();
    const active = blocks.find((b) => {
      if (!b.enabled) return false;
      if (b.oneOffDate)
        return b.oneOffDate === todayIso && nowMin >= b.startMinute && nowMin < b.endMinute;
      return (b.days ?? []).includes(dow) && nowMin >= b.startMinute && nowMin < b.endMinute;
    });
    return active?.id ?? null;
  } catch {
    return null;
  }
}
