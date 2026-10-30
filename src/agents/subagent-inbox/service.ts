/**
 * In-flight messaging for coder sub-agents (claude_coder / opencode_coder /
 * codex_coder / gemini) — gateway-side service.
 *
 * `sendSubagentMessage` resolves a runId / childSessionKey to a LIVE coder run,
 * appends the message to that run's durable inbox (store.ts) and returns
 * immediately with a messageId and an honest status. It never routes a coder
 * key to a gateway LLM (the bug this replaces: `sessions_send` to a coder child
 * started an unrelated gateway agent turn and reported "ok").
 *
 * Delivery happens at the agent's next tool boundary, by whichever consumer
 * claims the message first:
 *   • claude-code — PostToolUse / Stop hook inside the CLI (mid-turn)
 *   • opencode    — tool.execute.after plugin inside the CLI (mid-turn)
 *   • every backend (incl. codex / gemini) — MCP piggyback: any `infinibot`
 *     MCP tool call the child makes returns the pending messages appended to
 *     its result; plus the explicit `subagent_inbox` tool.
 *
 * A 1 Hz watcher turns the on-disk trail into live signals: `subagent.message`
 * WS broadcasts (focus modal Check-ins tab), progress updates
 * (subagent_progress / subagents_list) and child-transcript entries. Because
 * the trail lives on disk, the watcher resumes after a gateway restart.
 */

import { loadConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getGatewayBroadcaster } from "../coder-runtime/subagent-broadcast.js";
import { recordActivity, reportProgress } from "../subagent-progress.js";
import {
  getSubagentRun,
  getSubagentRunBySessionKey,
  listAllSubagentRuns,
  type SubagentRunRecord,
} from "../subagent-registry.js";
import {
  ackInboxMessages,
  claimPendingInboxMessages,
  enqueueInboxMessage,
  expireQueuedInboxMessages,
  extractInboxAckIds,
  formatInboxMessages,
  listInboxRunIds,
  readInbox,
  type InboxDeliveryVia,
  type InboxMessage,
} from "./store.js";

const log = createSubsystemLogger("subagent-inbox");

export type SubagentMessageSendStatus =
  | "delivered"
  | "acknowledged"
  | "queued"
  | "not_running"
  | "not_found"
  | "unsupported_backend";

export type CoderBackendName = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

export interface SubagentMessageResult {
  ok: boolean;
  status: SubagentMessageSendStatus;
  messageId?: string;
  runId?: string;
  childSessionKey?: string;
  backend?: CoderBackendName;
  /** Mechanism expected to carry the message into the agent's context. */
  deliveryMode?: "claude-hook" | "opencode-plugin" | "mcp-piggyback";
  /** Human-readable promise about WHEN the agent will see it. */
  expectedDelivery?: string;
  queuedAt?: number;
  deliveredAt?: number;
  deliveredVia?: string;
  acknowledgedAt?: number;
  error?: string;
  hint?: string;
}

const DELIVERY_SEMANTICS: Record<
  CoderBackendName,
  { mode: NonNullable<SubagentMessageResult["deliveryMode"]>; expected: string }
> = {
  "claude-code": {
    mode: "claude-hook",
    expected:
      "mid-turn: injected right after the agent's next tool call (PostToolUse hook), or before it stops (Stop hook)",
  },
  opencode: {
    mode: "opencode-plugin",
    expected: "mid-turn: appended to the result of the agent's next tool call (OpenCode plugin)",
  },
  codex: {
    mode: "mcp-piggyback",
    expected:
      "next infinibot MCP tool call the agent makes (any tool, e.g. report_checkpoint / subagent_inbox); Codex exposes no in-CLI hook in exec mode",
  },
  gemini: {
    mode: "mcp-piggyback",
    expected:
      "next infinibot MCP tool call the agent makes (any tool, e.g. report_checkpoint / subagent_inbox)",
  },
  grok: {
    mode: "mcp-piggyback",
    expected:
      "next infinibot MCP tool call the agent makes (any tool, e.g. report_checkpoint / subagent_inbox); Grok Build exposes no in-CLI hook in headless mode",
  },
};

/**
 * Can this run still receive messages? Deliberately NOT isSubagentRunActive:
 * `interruptedAt` only records that the GATEWAY restarted — a tmux-durable
 * child keeps working (and its hook keeps draining the inbox) straight through
 * that window, and a resumed legacy run carries the flag too. A run stops
 * accepting messages only once it has really ended.
 */
export function isRunAcceptingMessages(run: SubagentRunRecord): boolean {
  return run.endedAt == null && run.outcome == null;
}

/** Is this run a CLI coder run (vs an embedded gateway-LLM sub-agent)? */
export function isCoderRun(run: SubagentRunRecord): boolean {
  return Boolean(run.coderBackend || run.durableSpawn === "tmux-coder");
}

export type ResolvedTarget =
  | { kind: "coder"; run: SubagentRunRecord }
  | { kind: "not_coder"; run: SubagentRunRecord }
  | { kind: "none" };

/**
 * Resolve a runId or child session key to a registry run. When several runs
 * share a session key (respawns), prefer an active one, then the newest.
 */
export function resolveSubagentTarget(params: {
  runId?: string;
  sessionKey?: string;
}): ResolvedTarget {
  let run: SubagentRunRecord | undefined;
  if (params.runId) run = getSubagentRun(params.runId.trim());
  if (!run && params.sessionKey) {
    const key = params.sessionKey.trim();
    const candidates = listAllSubagentRuns().filter((r) => r.childSessionKey === key);
    run =
      candidates.find((r) => isRunAcceptingMessages(r)) ??
      candidates.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ??
      getSubagentRunBySessionKey(key);
  }
  if (!run) return { kind: "none" };
  return isCoderRun(run) ? { kind: "coder", run } : { kind: "not_coder", run };
}

function backendOf(run: SubagentRunRecord): CoderBackendName {
  return run.coderBackend ?? "claude-code";
}

function toResult(run: SubagentRunRecord, m: InboxMessage): SubagentMessageResult {
  const backend = backendOf(run);
  const sem = DELIVERY_SEMANTICS[backend];
  const status: SubagentMessageSendStatus =
    m.status === "acknowledged"
      ? "acknowledged"
      : m.status === "delivered"
        ? "delivered"
        : m.status === "expired"
          ? "not_running"
          : "queued";
  return {
    ok: status !== "not_running",
    status,
    messageId: m.id,
    runId: run.runId,
    childSessionKey: run.childSessionKey,
    backend,
    deliveryMode: sem.mode,
    expectedDelivery: sem.expected,
    queuedAt: m.createdAt,
    deliveredAt: m.deliveredAt,
    deliveredVia: m.deliveredVia,
    acknowledgedAt: m.ackedAt,
    ...(m.status === "expired"
      ? { error: m.expiredNote ?? "run ended before the message was delivered" }
      : {}),
  };
}

/**
 * Queue an operator message for a running coder sub-agent.
 *
 * Returns fast (no gateway round-trip, no LLM). Pass `waitMs` (capped at 8s so
 * callers stay under the 10s gateway RPC timeout) to wait for the agent's next
 * tool boundary and report `delivered` instead of `queued`.
 */
export async function sendSubagentMessage(params: {
  runId?: string;
  sessionKey?: string;
  message: string;
  from?: string;
  waitMs?: number;
}): Promise<SubagentMessageResult> {
  const text = params.message?.trim();
  if (!text) return { ok: false, status: "not_found", error: "message is required" };
  const target = resolveSubagentTarget(params);
  if (target.kind === "none") {
    return {
      ok: false,
      status: "not_found",
      runId: params.runId,
      childSessionKey: params.sessionKey,
      error: "No sub-agent run found for that runId / childSessionKey on this gateway.",
    };
  }
  const run = target.run;
  if (target.kind === "not_coder") {
    return {
      ok: false,
      status: "unsupported_backend",
      runId: run.runId,
      childSessionKey: run.childSessionKey,
      error:
        "Target is an embedded (gateway-LLM) sub-agent, not a CLI coder run — use sessions_send for it.",
    };
  }
  if (!isRunAcceptingMessages(run)) {
    return {
      ok: false,
      status: "not_running",
      runId: run.runId,
      childSessionKey: run.childSessionKey,
      backend: backendOf(run),
      error: run.endedAt
        ? `Run already ended at ${new Date(run.endedAt).toISOString()} (${run.outcome?.status ?? "unknown"}); nothing is listening.`
        : "Run is not running (interrupted or never started).",
      hint: "Spawn a follow-up with claude_coder (respawnOfRunId) carrying the new requirement.",
    };
  }

  const queued = enqueueInboxMessage({
    runId: run.runId,
    text,
    from: params.from?.trim() || "operator",
    childSessionKey: run.childSessionKey,
  });
  trackRun(run.runId);
  emitMessageEvent(run, queued, "queued");

  const waitMs = Math.max(0, Math.min(8_000, params.waitMs ?? 0));
  let current: InboxMessage = queued;
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const m = readInbox(run.runId).find((x) => x.id === queued.id);
      if (m) current = m;
      if (current.status !== "queued") break;
    }
  }
  return toResult(run, current);
}

/**
 * Does the session store remember `sessionKey` as a CLI coder session? Catches
 * coder children the registry no longer holds (swept / pre-restart), so they
 * get an honest `not_running` instead of a gateway LLM turn.
 */
function isCoderSessionInStore(sessionKey: string): boolean {
  try {
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const store = loadSessionStore(resolveStorePath(cfg.session?.store, { agentId }));
    return Boolean((store[sessionKey] as { coderBackend?: string } | undefined)?.coderBackend);
  } catch {
    return false;
  }
}

/**
 * `sessions_send` hook: when `sessionKey` belongs to a CLI coder sub-agent,
 * deliver through the run inbox and return the result; otherwise return null so
 * sessions_send keeps its normal (gateway agent turn) path for embedded agents.
 */
export async function routeSessionsSendToCoder(params: {
  sessionKey: string;
  message: string;
  from?: string;
  waitMs?: number;
}): Promise<SubagentMessageResult | null> {
  const key = params.sessionKey.trim();
  if (!isSubagentSessionKey(key)) return null;
  const target = resolveSubagentTarget({ sessionKey: key });
  if (target.kind === "coder") {
    return sendSubagentMessage({
      sessionKey: key,
      message: params.message,
      from: params.from,
      waitMs: params.waitMs,
    });
  }
  if (target.kind === "none" && isCoderSessionInStore(key)) {
    return {
      ok: false,
      status: "not_running",
      childSessionKey: key,
      error:
        "This is a CLI coder sub-agent session with no live run on this gateway (it ended or was lost); the message was NOT delivered.",
      hint: "Spawn a follow-up coder run carrying the new requirement.",
    };
  }
  return null;
}

/** Current state of one message (or every message) for a run. */
export function getSubagentMessageStatus(params: {
  runId?: string;
  sessionKey?: string;
  messageId?: string;
}): { ok: boolean; error?: string; runId?: string; messages?: SubagentMessageResult[] } {
  const target = resolveSubagentTarget(params);
  if (target.kind === "none") {
    // The run may have been swept from the registry but its inbox is on disk.
    if (params.runId) {
      const msgs = readInbox(params.runId);
      if (msgs.length > 0) {
        return {
          ok: true,
          runId: params.runId,
          messages: msgs
            .filter((m) => !params.messageId || m.id === params.messageId)
            .map((m) => ({
              ok: true,
              status:
                m.status === "expired"
                  ? ("not_running" as const)
                  : m.status === "acknowledged"
                    ? ("acknowledged" as const)
                    : m.status === "delivered"
                      ? ("delivered" as const)
                      : ("queued" as const),
              messageId: m.id,
              runId: m.runId,
              queuedAt: m.createdAt,
              deliveredAt: m.deliveredAt,
              deliveredVia: m.deliveredVia,
              acknowledgedAt: m.ackedAt,
            })),
        };
      }
    }
    return { ok: false, error: "No sub-agent run found for that runId / childSessionKey." };
  }
  const run = target.run;
  const msgs = readInbox(run.runId).filter((m) => !params.messageId || m.id === params.messageId);
  if (params.messageId && msgs.length === 0) {
    return { ok: false, runId: run.runId, error: `Unknown messageId ${params.messageId}` };
  }
  return { ok: true, runId: run.runId, messages: msgs.map((m) => toResult(run, m)) };
}

/** Raw inbox (UI timeline). */
export function listSubagentMessages(runId: string): InboxMessage[] {
  return readInbox(runId);
}

// ── Child-side consumption (MCP piggyback + subagent_inbox tool) ────────────

/**
 * Session keys a coder child's tool calls arrive under: its MCP bridge entry
 * pins `claude-coder:<runId>` (every backend reuses that entry), while
 * in-process paths use the child session key `agent:…:subagent:…`.
 */
export function isCoderCallerSessionKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  return sessionKey.startsWith("claude-coder:") || isSubagentSessionKey(sessionKey);
}

/** Active coder run owning `sessionKey`, if any. */
function activeCoderRunForSession(sessionKey: string | undefined): SubagentRunRecord | undefined {
  if (!sessionKey || !isCoderCallerSessionKey(sessionKey)) return undefined;
  const bridged = /^claude-coder:(.+)$/.exec(sessionKey);
  const t = bridged
    ? resolveSubagentTarget({ runId: bridged[1] })
    : resolveSubagentTarget({ sessionKey });
  if (t.kind !== "coder" || !isRunAcceptingMessages(t.run)) return undefined;
  return t.run;
}

/**
 * Claim pending messages for the coder run behind `sessionKey`. Used by the
 * MCP tool-invoke path (piggyback) and the subagent_inbox tool.
 */
export function drainInboxForSession(
  sessionKey: string | undefined,
  via: InboxDeliveryVia,
): { run?: SubagentRunRecord; messages: InboxMessage[]; text: string } {
  const run = activeCoderRunForSession(sessionKey);
  if (!run) return { messages: [], text: "" };
  const messages = claimPendingInboxMessages(run.runId, via);
  if (messages.length > 0) pollRun(run.runId);
  return { run, messages, text: formatInboxMessages(messages) };
}

/** Acknowledge message ids for the run behind `sessionKey` (subagent_inbox ack). */
export function ackInboxForSession(
  sessionKey: string | undefined,
  ids: readonly string[],
): { runId?: string; acked: string[] } {
  const run = activeCoderRunForSession(sessionKey);
  if (!run) return { acked: [] };
  const acked = ackInboxMessages(run.runId, ids, "inbox-tool");
  if (acked.length > 0) pollRun(run.runId);
  return { runId: run.runId, acked };
}

/**
 * Append pending operator messages to an agent tool result (MCP piggyback).
 * Mutates nothing when there is nothing to deliver.
 */
export function piggybackInboxOnToolResult(
  sessionKey: string | undefined,
  result: unknown,
): unknown {
  if (!isCoderCallerSessionKey(sessionKey)) return result;
  let drained: ReturnType<typeof drainInboxForSession>;
  try {
    drained = drainInboxForSession(sessionKey, "mcp-piggyback");
  } catch {
    return result;
  }
  if (!drained.text) return result;
  const extra = { type: "text", text: `\n\n${drained.text}` };
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const r = result as { content: unknown[] };
    return { ...r, content: [...r.content, extra] };
  }
  if (typeof result === "string") return `${result}${extra.text}`;
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? null) }, extra],
    details: result,
  };
}

/**
 * Scan a chunk of the child's output for `ACK im_…` tokens and record acks.
 * Cheap no-op unless the run has messages awaiting acknowledgement.
 */
export function scanChildOutputForAcks(runId: string, chunk: string): void {
  if (!chunk || !tracked.has(runId)) return;
  const ids = extractInboxAckIds(chunk);
  if (ids.length === 0) return;
  try {
    if (ackInboxMessages(runId, ids, "agent-output").length > 0) pollRun(runId);
  } catch {
    /* never break the stream */
  }
}

// ── Watcher: on-disk trail → live signals ───────────────────────────────────

/** runId → last observed status per message id. */
const tracked = new Map<string, Map<string, InboxMessage["status"]>>();
let watchTimer: ReturnType<typeof setInterval> | null = null;
const WATCH_INTERVAL_MS = 1000;

function trackRun(runId: string): void {
  if (!tracked.has(runId)) {
    const seen = new Map<string, InboxMessage["status"]>();
    for (const m of readInbox(runId)) seen.set(m.id, m.status);
    tracked.set(runId, seen);
  }
  ensureWatcher();
}

function ensureWatcher(): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    for (const runId of tracked.keys()) pollRun(runId);
  }, WATCH_INTERVAL_MS);
  watchTimer.unref?.();
}

function pollRun(runId: string): void {
  const seen = tracked.get(runId) ?? new Map<string, InboxMessage["status"]>();
  if (!tracked.has(runId)) tracked.set(runId, seen);
  const run = getSubagentRun(runId);
  if (!run) {
    // Not in the registry (swept, or not restored yet) — we cannot tell whether
    // it is still running, so never expire on absence; just stop watching.
    tracked.delete(runId);
    stopWatcherIfIdle();
    return;
  }
  const active = isRunAcceptingMessages(run);
  if (!active) {
    const expired = expireQueuedInboxMessages(runId, "run ended before the message was delivered");
    if (expired.length > 0) log.info("expired undelivered operator messages", { runId, expired });
  }
  let open = false;
  for (const m of readInbox(runId)) {
    const prev = seen.get(m.id);
    if (prev !== m.status) {
      seen.set(m.id, m.status);
      if (prev !== undefined) emitMessageEvent(run, m, m.status);
    }
    if (m.status === "queued" || m.status === "delivered") open = true;
  }
  // Keep watching while something is still in flight on a live run.
  if (!active || !open) tracked.delete(runId);
  stopWatcherIfIdle();
}

function stopWatcherIfIdle(): void {
  if (tracked.size === 0 && watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

function emitMessageEvent(
  run: SubagentRunRecord,
  m: InboxMessage,
  phase: InboxMessage["status"],
): void {
  const payload = {
    runId: run.runId,
    sessionKey: run.childSessionKey,
    messageId: m.id,
    text: m.text,
    from: m.from,
    status: phase,
    queuedAt: m.createdAt,
    deliveredAt: m.deliveredAt,
    deliveredVia: m.deliveredVia,
    acknowledgedAt: m.ackedAt,
    ts: Date.now(),
  };
  try {
    getGatewayBroadcaster()?.("subagent.message", payload);
  } catch {
    /* best effort */
  }
  const preview = m.text.length > 140 ? `${m.text.slice(0, 137)}…` : m.text;
  const line =
    phase === "queued"
      ? `📨 Operator message ${m.id} queued: "${preview}"`
      : phase === "delivered"
        ? `📬 Operator message ${m.id} delivered via ${m.deliveredVia ?? "?"}`
        : phase === "acknowledged"
          ? `✅ Operator message ${m.id} acknowledged by the agent`
          : `⚠️ Operator message ${m.id} expired: ${m.expiredNote ?? "run ended before delivery"}`;
  try {
    recordActivity({
      runId: run.runId,
      sessionKey: run.childSessionKey,
      kind: "operator_message",
      label: line,
      coderBackend: run.coderBackend,
    });
    void reportProgress({
      runId: run.runId,
      sessionKey: run.childSessionKey,
      status: "working",
      message: line,
      details: { operatorMessage: payload },
      notifyRequester: false,
    }).catch(() => {});
  } catch {
    /* best effort */
  }
  void appendAssistantMessageToSessionTranscript({
    sessionKey: run.childSessionKey,
    text: line,
  }).catch(() => {});
}

/**
 * Boot hook: resume watching inboxes that still had messages in flight when
 * the gateway went down (their hooks may have delivered/acked meanwhile).
 */
export function resumeInboxWatching(): void {
  for (const runId of listInboxRunIds()) {
    const msgs = readInbox(runId);
    if (msgs.some((m) => m.status === "queued" || m.status === "delivered")) {
      // Seed with the persisted status so we only broadcast NEW transitions.
      const seen = new Map<string, InboxMessage["status"]>();
      for (const m of msgs) seen.set(m.id, m.status);
      tracked.set(runId, seen);
    }
  }
  if (tracked.size > 0) ensureWatcher();
}

export function resetSubagentInboxForTests(): void {
  tracked.clear();
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}
