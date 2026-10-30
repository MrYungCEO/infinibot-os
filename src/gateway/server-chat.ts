import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { loadConfig } from "../config/config.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { loadSessionEntryReadonly } from "./session-utils.js";
import { humanizeChatError } from "./chat-error-humanize.js";
import { formatForLog } from "./ws-log.js";
import { emitNotification } from "../notifications/emit.js";

/** Finished runs whose agent seq counter is kept (late events stay gap-free). */
export const MAX_FINISHED_SEQ_RUNS = 1000;

/**
 * Check if webchat broadcasts should be suppressed for heartbeat runs.
 * Returns true if the run is a heartbeat and showOk is false.
 */
function shouldSuppressHeartbeatBroadcast(runId: string): boolean {
  const runContext = getAgentRunContext(runId);
  if (!runContext?.isHeartbeat) return false;

  try {
    const cfg = loadConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift();
    if (!queue.length) chatRunSessions.delete(sessionId);
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) return undefined;
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) chatRunSessions.delete(sessionId);
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>;
  abortedRuns: Map<string, number>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    deltaSentAt.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    buffers,
    deltaSentAt,
    abortedRuns,
    clear,
  };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
};

export function createAgentEventHandler({
  broadcast,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
}: AgentEventHandlerOptions) {
  const emitChatDelta = (sessionKey: string, clientRunId: string, seq: number, text: string) => {
    chatRunState.buffers.set(clientRunId, text);
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (now - last < 150) return;
    chatRunState.deltaSentAt.set(clientRunId, now);
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: now,
      },
    };
    // Suppress webchat broadcast for heartbeat runs when showOk is false
    if (!shouldSuppressHeartbeatBroadcast(clientRunId)) {
      broadcast("chat", payload, { dropIfSlow: true });
    }
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
    errorDetail?: { errorCode?: string; errorHint?: string },
  ) => {
    const text = chatRunState.buffers.get(clientRunId)?.trim() ?? "";
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        message: text
          ? {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            }
          : undefined,
      };
      // Suppress webchat broadcast for heartbeat runs when showOk is false
      if (!shouldSuppressHeartbeatBroadcast(clientRunId)) {
        broadcast("chat", payload);

        // Send push notification to mobile devices for non-heartbeat messages
        if (text) {
          const previewText = text.length > 150 ? text.slice(0, 147) + "..." : text;
          emitNotification({
            category: "chat.mentions",
            severity: "info",
            title: "✦ Infinibot",
            body: previewText,
            source: "agent",
            sourceId: sessionKey,
            deepLink: sessionKey
              ? `infinibot://chat/${encodeURIComponent(sessionKey)}`
              : "infinibot://chat",
            data: { type: "chat", sessionKey, runId: clientRunId },
          }).catch(() => {});
        }
      }
      nodeSendToSession(sessionKey, "chat", payload);
      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "error" as const,
      ...(() => {
        const friendly = humanizeChatError(error ? formatForLog(error) : undefined, errorDetail);
        return {
          errorMessage: friendly.errorMessage,
          ...(friendly.errorHint ? { errorHint: friendly.errorHint } : {}),
        };
      })(),
      ...(errorDetail?.errorCode ? { errorCode: errorDetail.errorCode } : {}),
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const lifecycleErrorDetail = (data: Record<string, unknown> | undefined) => {
    const errorCode = typeof data?.errorCode === "string" ? data.errorCode : undefined;
    const errorHint = typeof data?.errorHint === "string" ? data.errorHint : undefined;
    return errorCode || errorHint ? { errorCode, errorHint } : undefined;
  };

  const shouldEmitToolEvents = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) return runVerbose === "on";
    if (!sessionKey) return false;
    try {
      const { cfg, entry } = loadSessionEntryReadonly(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) return sessionVerbose === "on";
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose === "on";
    } catch {
      return false;
    }
  };

  const finishedSeqRuns = new Set<string>();

  return (evt: AgentEventPayload) => {
    const chatLink = chatRunState.registry.peek(evt.runId);
    const sessionKey = chatLink?.sessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const agentPayload = sessionKey ? { ...evt, sessionKey } : evt;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    if (evt.stream === "tool" && !shouldEmitToolEvents(evt.runId, sessionKey)) {
      agentRunSeq.set(evt.runId, evt.seq);
      // Non-verbose sessions still get a name-only activity ping (no args or
      // results) so chat surfaces can show a tool as in flight. Separate
      // stream: consumers of full "tool" events never see it.
      const phase = evt.data?.phase;
      if (sessionKey && (phase === "start" || phase === "result")) {
        broadcast("agent", {
          runId: evt.runId,
          seq: evt.seq,
          stream: "tool_status",
          ts: evt.ts,
          sessionKey,
          data: {
            phase,
            name: typeof evt.data?.name === "string" ? evt.data.name : "tool",
            toolCallId: typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : undefined,
            ...(phase === "result" ? { isError: evt.data?.isError === true } : {}),
          },
        });
      }
      return;
    }
    if (evt.seq !== last + 1) {
      broadcast("agent", {
        runId: evt.runId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    broadcast("agent", agentPayload);
    if (evt.stream === "lifecycle" && (evt.data?.phase === "end" || evt.data?.phase === "error")) {
      // Bound agentRunSeq: forget a run's counter once it is
      // MAX_FINISHED_SEQ_RUNS finished runs old (it used to grow per run forever).
      finishedSeqRuns.delete(evt.runId);
      finishedSeqRuns.add(evt.runId);
      if (finishedSeqRuns.size > MAX_FINISHED_SEQ_RUNS) {
        const oldest = finishedSeqRuns.values().next().value;
        if (oldest !== undefined) {
          finishedSeqRuns.delete(oldest);
          agentRunSeq.delete(oldest);
        }
      }
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;

    // Sub-runs that share a sessionKey for tool-stream routing (e.g. the
    // pre-compaction memory flush) must not surface as chat deltas/finals.
    // The chat path is the user-conversation channel; emitting a `final`
    // here causes the UI to treat the sub-run's end as the user turn ending.
    const runContext = getAgentRunContext(evt.runId);
    const suppressChat = !chatLink && Boolean(runContext?.suppressChatBroadcast);

    if (sessionKey) {
      nodeSendToSession(sessionKey, "agent", agentPayload);
      if (
        !suppressChat &&
        !isAborted &&
        evt.stream === "assistant" &&
        typeof evt.data?.text === "string"
      ) {
        emitChatDelta(sessionKey, clientRunId, evt.seq, evt.data.text);
      } else if (
        !suppressChat &&
        !isAborted &&
        (lifecyclePhase === "end" || lifecyclePhase === "error")
      ) {
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            lifecycleErrorDetail(evt.data),
          );
        } else {
          emitChatFinal(
            sessionKey,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            lifecycleErrorDetail(evt.data),
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        chatRunState.deltaSentAt.delete(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      clearAgentRunContext(evt.runId);
    }
  };
}
