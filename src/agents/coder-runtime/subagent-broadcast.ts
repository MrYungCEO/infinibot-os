/**
 * Backend-agnostic singleton bridge that lets background-spawned coder
 * sub-agents (Claude Code, OpenCode, Codex) emit gateway WS broadcasts from
 * outside any request context. Wired in src/gateway/server.impl.ts after the
 * gateway broadcaster is created.
 *
 * Without this, the Activity page can only see subagent tool calls via the
 * 5-second sessions.preview poll — the real-time WS subscription stays empty
 * because the child CLI's Read/Edit/Bash calls never hit agent.tools.invoke
 * (those are native CLI tools, not MCP tools).
 *
 * COORDINATION: opencode-parity — moved here from claude-code/ because nothing
 * in this file is Claude-specific; all three backends feed the same broadcasts.
 * The old path (claude-code/subagent-broadcast.ts) re-exports from here.
 */
type BroadcastFn = (event: string, payload: unknown) => void;

let broadcaster: BroadcastFn | null = null;

/** Callbacks invoked once when the broadcaster is first wired (or immediately if already set). */
const onReadyCallbacks: Array<(fn: BroadcastFn) => void> = [];

/**
 * Also published on globalThis so plugins loaded from source by jiti (their
 * own module instance of this file) and packaged installs (no src/ folder)
 * can reach the same broadcaster without importing this module.
 */
export const GATEWAY_BROADCASTER_KEY = Symbol.for("infinibot.gatewayBroadcaster");

export function setSubagentBroadcaster(fn: BroadcastFn): void {
  broadcaster = fn;
  (globalThis as Record<symbol, unknown>)[GATEWAY_BROADCASTER_KEY] = fn;
  // Flush any modules that queued work before the gateway was ready.
  for (const cb of onReadyCallbacks) {
    try {
      cb(fn);
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Register a callback that fires once the gateway broadcaster is wired. If the
 * broadcaster is already set, the callback is invoked synchronously. Safe to
 * call from any module without creating a circular dependency on server.impl.ts.
 */
export function onGatewayBroadcasterReady(cb: (fn: BroadcastFn) => void): void {
  if (broadcaster) {
    cb(broadcaster);
    return;
  }
  onReadyCallbacks.push(cb);
}

/**
 * Access the wired gateway broadcaster from any backend module that needs to
 * push a WS frame from outside a request context (e.g. the proactive overlay's
 * server-side agent-summary emit). Returns null before the gateway wires it.
 */
export function getGatewayBroadcaster(): BroadcastFn | null {
  return (
    broadcaster ??
    ((globalThis as Record<symbol, unknown>)[GATEWAY_BROADCASTER_KEY] as BroadcastFn | undefined) ??
    null
  );
}

export interface SubagentToolEvent {
  runId: string;
  sessionKey: string;
  toolCallId: string;
  name: string;
  phase: "start" | "end";
  ts: number;
  arguments?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  /**
   * Backend that produced this tool event. Lets the activity feed badge
   * the row with the right provider logo without grepping displayName.
   */
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
}

export function broadcastSubagentToolEvent(evt: SubagentToolEvent): void {
  if (!broadcaster) return;
  const data: Record<string, unknown> = {
    toolCallId: evt.toolCallId,
    name: evt.name,
    phase: evt.phase,
  };
  if (evt.phase === "start" && evt.arguments !== undefined) {
    data.arguments = evt.arguments;
  }
  if (evt.phase === "end") {
    if (evt.error !== undefined) data.error = evt.error;
    else if (evt.result !== undefined) data.result = evt.result;
    if (evt.durationMs !== undefined) data.durationMs = evt.durationMs;
  }
  try {
    broadcaster("agent", {
      runId: evt.runId,
      sessionKey: evt.sessionKey,
      source: "claude-coder",
      stream: "tool",
      ts: evt.ts,
      coderBackend: evt.coderBackend,
      data,
    });
  } catch {
    /* non-fatal — broadcast best-effort */
  }
}

/**
 * Lifecycle WS events for the Activity page's <subagent-activity-panel>
 * (live) and <subagent-history-feed> (archive). Both subscribe to these
 * exact event names; without these emits the panels only refresh on a
 * 30s idle poll or window focus, so freshly spawned/completed runs lag.
 *
 * Event names match the UI subscriptions:
 *   subagent.spawned   → registerSubagentRun
 *   subagent.complete  → finalizeSubagentCleanup (outcome.status === "ok")
 *   subagent.error     → finalizeSubagentCleanup (outcome.status === "error")
 *   subagent.timeout   → finalizeSubagentCleanup (outcome.error matches /timeout/i)
 */
export type SubagentLifecycleEvent =
  | "subagent.spawned"
  | "subagent.complete"
  | "subagent.error"
  | "subagent.timeout";

export interface SubagentLifecyclePayload {
  runId: string;
  sessionKey: string;
  label?: string;
  task?: string;
  requesterSessionKey?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: { status: string; error?: string };
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  ts: number;
}

export function broadcastSubagentLifecycle(
  event: SubagentLifecycleEvent,
  payload: SubagentLifecyclePayload,
): void {
  if (!broadcaster) return;
  try {
    broadcaster(event, payload);
  } catch {
    /* non-fatal — broadcast best-effort */
  }
}

/**
 * Mid-run check-in event. A NEW event KIND, distinct from regular progress
 * (`agent` stream:"tool") and from lifecycle events above. The focus modal's
 * "Check-ins" feed subscribes to `subagent.checkpoint` to render new check-ins
 * live and badge its tab. Emitted by recordCheckpoint() / decideCheckpoint() in
 * src/agents/subagent-progress.ts.
 *
 * The same event name carries both the initial check-in (pending=true when the
 * run is gated) and the post-decision update (pending=false + decision set), so
 * the UI can reconcile by checkpointId.
 */
export interface SubagentCheckpointPayload {
  runId: string;
  sessionKey: string;
  checkpointId: string;
  summary: string;
  next: string;
  deviations: string[];
  driftSuspected: boolean;
  driftReasons?: string[];
  /** True when this run requires explicit approval (strict drift gate). */
  gated: boolean;
  /** True while the agent is paused waiting for a decision on this check-in. */
  pending: boolean;
  /** Set on the post-decision update. */
  decision?: "approve" | "redirect" | "stop";
  ts: number;
}

export function broadcastSubagentCheckpoint(payload: SubagentCheckpointPayload): void {
  if (!broadcaster) return;
  try {
    broadcaster("subagent.checkpoint", payload);
  } catch {
    /* non-fatal — broadcast best-effort */
  }
}
