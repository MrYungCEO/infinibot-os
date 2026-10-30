/**
 * Chat "CLI" mode RPCs — the chat composer's Agent | CLI switch.
 *
 *   chat.cli.send   { sessionKey, idempotencyKey, message, backend, cwd?, model? }
 *                   Runs one turn through the chosen coding CLI (runner.ts) in the
 *                   thread's folder, resuming that thread's CLI session. Streams as
 *                   ordinary `chat` events (delta → final) so every chat surface
 *                   renders it with the code it already has, and appends both turns
 *                   to the session transcript so the thread (and chat.history)
 *                   keeps them. Messages carry `cli: { backend, cwd, model }` (the
 *                   UI's backend badge / "Switched to …" divider) and the reply
 *                   carries `cliTools` (tool calls, shown collapsed).
 *   chat.cli.abort  { sessionKey }           stop the running CLI turn
 *   chat.cli.state  { sessionKey }           saved mode + the running turn, if any
 *   chat.cli.mode   { sessionKey, mode, backend?, cwd?, model? }
 *                   remember the thread's Agent/CLI choice on the gateway so it
 *                   follows the thread to other devices
 *
 * Runs a local CLI with full permissions, so these are operator.admin methods
 * (not in READ/WRITE_METHODS) and have no multi-user authz rule (deny).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";

import { updateSessionStore } from "../../config/sessions.js";
import type { CliChatState, SessionEntry } from "../../config/sessions/types.js";
import {
  CLI_CHAT_LABELS,
  normalizeCliChatBackend,
  runCliChatTurn,
  type CliChatBackend,
  type CliChatTool,
  type CliTurnHandle,
} from "../cli-chat/runner.js";
import type { CliFailureKind } from "../../agents/cli-runner/stream.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

export const CHAT_CLI_METHODS = [
  "chat.cli.send",
  "chat.cli.abort",
  "chat.cli.state",
  "chat.cli.mode",
] as const;

type ActiveTurn = {
  runId: string;
  backend: CliChatBackend;
  startedAt: number;
  handle: CliTurnHandle;
};

/** One running CLI turn per chat thread. */
const activeTurns = new Map<string, ActiveTurn>();

export function resolveCliChatCwd(raw: unknown): { cwd?: string; error?: string } {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return { cwd: os.homedir() };
  const expanded =
    input === "~"
      ? os.homedir()
      : input.startsWith("~/")
        ? path.join(os.homedir(), input.slice(2))
        : input;
  const resolved = path.resolve(expanded);
  try {
    if (fs.statSync(resolved).isDirectory()) return { cwd: resolved };
  } catch {
    /* fall through */
  }
  return { error: `Folder not found: ${resolved}` };
}

function transcriptPathFor(storePath: string, entry: SessionEntry): string {
  return entry.sessionFile || path.join(path.dirname(storePath), `${entry.sessionId}.jsonl`);
}

function appendTranscript(
  transcriptPath: string,
  sessionId: string,
  message: Record<string, unknown>,
): string {
  if (!fs.existsSync(transcriptPath)) {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
  }
  const entry = {
    type: "message",
    id: randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    message,
  };
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(transcriptPath, line, "utf-8");
  return line;
}

/** Drop `line` from the end of the transcript (only if it is still the last line). */
function removeTrailingTranscriptLine(transcriptPath: string, line: string): boolean {
  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    if (!raw.endsWith(line)) return false;
    fs.writeFileSync(transcriptPath, raw.slice(0, raw.length - line.length), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * CLI failures where answering with the built-in model is the right move.
 * Every failure that left no reply qualifies, except the ones only the user
 * can resolve by editing the message (too long for the CLI's argv).
 */
export function shouldFallBackToAgent(res: {
  text: string;
  error: string | null;
  aborted: boolean;
  errorKind?: CliFailureKind;
}): boolean {
  if (res.aborted || !res.error || res.text.trim()) return false;
  if (/^Message is too long for /.test(res.error)) return false;
  return process.env.INFINIBOT_CHAT_CLI_FALLBACK !== "0";
}

/** "told once": (thread, backend, failure kind) we've already explained. */
const fallbackNoticed = new Set<string>();

export function cliFallbackNoticeText(label: string, error: string): string {
  return `${error.replace(/\s+$/, "")} Answering with the built-in model instead — ${label} will be tried again on your next message.`;
}

/** Test-only. */
export function resetCliFallbackNoticesForTest(): void {
  fallbackNoticed.clear();
}

/** Load (creating if new) the thread's session entry and apply `patch` to its cliChat state. */
async function upsertCliState(
  sessionKey: string,
  patch: (prev: CliChatState | undefined) => CliChatState,
): Promise<{ storePath: string; entry: SessionEntry }> {
  const { storePath, canonicalKey } = loadSessionEntry(sessionKey);
  let saved: SessionEntry | undefined;
  await updateSessionStore(storePath, (store) => {
    const prev = store[canonicalKey];
    const now = Date.now();
    const next: SessionEntry = prev
      ? { ...prev, updatedAt: now }
      : { sessionId: randomUUID(), updatedAt: now, channel: "webchat" };
    next.cliChat = patch(prev?.cliChat);
    store[canonicalKey] = next;
    saved = next;
  });
  return { storePath, entry: saved! };
}

function nextSeq(context: Pick<GatewayRequestContext, "agentRunSeq">, runId: string): number {
  const n = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, n);
  return n;
}

function emitChat(
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">,
  sessionKey: string,
  runId: string,
  payload: Record<string, unknown>,
) {
  const full = { runId, sessionKey, seq: nextSeq(context, runId), ...payload };
  context.broadcast("chat", full);
  context.nodeSendToSession(sessionKey, "chat", full);
}

function assistantMessage(params: {
  text: string;
  tools: CliChatTool[];
  meta: Record<string, unknown>;
  timestamp: number;
  stopReason: string;
}): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    timestamp: params.timestamp,
    stopReason: params.stopReason,
    usage: { input: 0, output: 0, totalTokens: 0 },
    cli: params.meta,
    ...(params.tools.length ? { cliTools: params.tools } : {}),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Run `message` through the ordinary agent chat (chat.send) for this thread.
 * Resolves true once chat.send accepted it; false (nothing started) otherwise.
 */
async function runAgentFallback(params: {
  opts: GatewayRequestHandlerOptions;
  sessionKey: string;
  runId: string;
  message: string;
  onStart: () => void;
}): Promise<boolean> {
  try {
    const { chatHandlers } = await import("./chat.js");
    const send = chatHandlers["chat.send"];
    if (!send) return false;
    params.onStart();
    const sendParams = {
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: false,
      idempotencyKey: params.runId,
    };
    let accepted = false;
    await send({
      ...params.opts,
      params: sendParams,
      req: { ...params.opts.req, method: "chat.send", params: sendParams },
      respond: (ok) => {
        accepted = ok;
      },
    });
    return accepted;
  } catch (err) {
    params.opts.context.logGateway.warn(`chat.cli: agent fallback failed: ${String(err)}`);
    return false;
  }
}

export const chatCliHandlers: GatewayRequestHandlers = {
  "chat.cli.send": async (handlerOpts) => {
    const { params, respond, context } = handlerOpts;
    const p = (params ?? {}) as Record<string, unknown>;
    const sessionKey = str(p.sessionKey);
    const runId = str(p.idempotencyKey) || randomUUID();
    const message = typeof p.message === "string" ? p.message.trim() : "";
    const backend = normalizeCliChatBackend(p.backend);
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }
    if (!backend) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Unknown CLI: ${String(p.backend)}`),
      );
      return;
    }
    if (!message) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "message is required"));
      return;
    }
    const running = activeTurns.get(sessionKey);
    if (running) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `${CLI_CHAT_LABELS[running.backend]} is still answering — stop it first.`,
        ),
      );
      return;
    }
    const cwdResult = resolveCliChatCwd(p.cwd);
    if (!cwdResult.cwd) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, cwdResult.error ?? "bad folder"),
      );
      return;
    }
    const cwd = cwdResult.cwd;
    const model = str(p.model) || null;

    let storePath: string;
    let entry: SessionEntry;
    try {
      ({ storePath, entry } = await upsertCliState(sessionKey, (prev) => ({
        ...prev,
        mode: "cli",
        backend,
        cwd,
        models: { ...prev?.models, ...(model ? { [backend]: model } : {}) },
        updatedAt: Date.now(),
      })));
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Could not save the chat: ${String(err)}`),
      );
      return;
    }
    const resumeId = entry.cliChat?.sessions?.[backend] ?? null;
    const meta = { backend, cwd, ...(model ? { model } : {}) };
    const transcriptPath = transcriptPathFor(storePath, entry);
    let userLine: string | null = null;
    try {
      userLine = appendTranscript(transcriptPath, entry.sessionId, {
        role: "user",
        content: [{ type: "text", text: message }],
        timestamp: Date.now(),
        cli: meta,
      });
    } catch (err) {
      context.logGateway.warn(`chat.cli: transcript append failed: ${String(err)}`);
    }

    // Deltas: coalesced to ~8/s so a fast stream doesn't flood every client.
    let pending: { text: string; tools: CliChatTool[] } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSent = "";
    let lastToolSig = "";
    const flush = () => {
      timer = null;
      if (!pending) return;
      const { text, tools } = pending;
      pending = null;
      const toolSig = tools.map((t) => `${t.id}:${t.status}`).join("|");
      if (text === lastSent && toolSig === lastToolSig) return;
      lastSent = text;
      lastToolSig = toolSig;
      emitChat(context, sessionKey, runId, {
        state: "delta",
        message: assistantMessage({
          text,
          tools,
          meta,
          timestamp: Date.now(),
          stopReason: "streaming",
        }),
      });
    };
    const scheduleDelta = (text: string, tools: CliChatTool[]) => {
      pending = { text, tools: tools.map((t) => ({ ...t })) };
      if (!timer) timer = setTimeout(flush, 120);
    };

    // (the .then below declares its own `message` for the reply)
    const userMessage = message;
    const handle = runCliChatTurn({
      backend,
      prompt: message,
      cwd,
      model,
      resumeId,
      onProgress: (acc) => scheduleDelta(acc.reply, acc.tools),
    });
    const turn: ActiveTurn = { runId, backend, startedAt: Date.now(), handle };
    activeTurns.set(sessionKey, turn);
    respond(true, { runId, status: "started", backend, cwd, resumed: Boolean(resumeId) });

    void handle.result
      .then(async (res) => {
        if (timer) clearTimeout(timer);
        timer = null;
        pending = null;
        if (res.sessionId) {
          await upsertCliState(sessionKey, (prev) => ({
            ...(prev ?? { mode: "cli" }),
            sessions: { ...prev?.sessions, [backend]: res.sessionId! },
            updatedAt: Date.now(),
          })).catch((err) =>
            context.logGateway.warn(`chat.cli: session save failed: ${String(err)}`),
          );
        }
        const label = CLI_CHAT_LABELS[backend];
        let removedUserLine = false;
        if (shouldFallBackToAgent(res)) {
          // Don't dead-end the chat: answer this message with the thread's
          // built-in agent model under the SAME runId, so the UI that is
          // waiting on it just keeps streaming. The thread stays in CLI mode.
          const fallbackRan = await runAgentFallback({
            opts: handlerOpts,
            sessionKey,
            runId,
            message: userMessage,
            onStart: () => {
              // chat.send writes the user turn itself; drop ours so it isn't doubled.
              if (userLine)
                removedUserLine = removeTrailingTranscriptLine(transcriptPath, userLine);
              const key = `${sessionKey}|${backend}|${res.errorKind ?? "unknown"}`;
              if (fallbackNoticed.has(key)) return;
              fallbackNoticed.add(key);
              emitAgentEvent({
                runId,
                stream: "notice",
                sessionKey,
                data: {
                  kind: "cli_fallback",
                  level: "warning",
                  from: label,
                  to: "built-in model",
                  backend,
                  errorKind: res.errorKind ?? "unknown",
                  message: cliFallbackNoticeText(label, res.error ?? ""),
                },
              });
            },
          });
          if (fallbackRan) {
            context.logGateway.warn(
              `chat.cli: ${backend} failed (${res.errorKind ?? "unknown"}); answered with the agent model`,
            );
            return;
          }
          // chat.send refused it: put the user turn back and show the error.
          if (userLine && removedUserLine) {
            try {
              appendTranscript(transcriptPath, entry.sessionId, JSON.parse(userLine).message);
            } catch {
              /* best effort */
            }
          }
        }
        let text = res.text;
        // res.error is already a plain-English sentence (runner humanizes it).
        if (res.error) text = `${text ? `${text}\n\n` : ""}⚠️ ${res.error}`;
        if (res.aborted) text = `${text ? `${text}\n\n` : ""}_Stopped._`;
        if (!text) text = `_${label} finished with no text reply._`;
        if (res.restarted)
          text = `_The previous ${label} session was gone, so this started a new one._\n\n${text}`;
        const message = assistantMessage({
          text,
          tools: res.tools,
          meta: { ...meta, ...(res.error ? { error: true } : {}) },
          timestamp: Date.now(),
          stopReason: res.aborted ? "aborted" : res.error ? "error" : "stop",
        });
        try {
          appendTranscript(transcriptPath, entry.sessionId, message);
        } catch (err) {
          context.logGateway.warn(`chat.cli: transcript append failed: ${String(err)}`);
        }
        emitChat(context, sessionKey, runId, { state: "final", message });
      })
      .catch((err) => {
        emitChat(context, sessionKey, runId, { state: "error", errorMessage: String(err) });
      })
      .finally(() => {
        if (activeTurns.get(sessionKey) === turn) activeTurns.delete(sessionKey);
      });
  },

  "chat.cli.abort": ({ params, respond }) => {
    const sessionKey = str((params as Record<string, unknown> | undefined)?.sessionKey);
    const turn = sessionKey ? activeTurns.get(sessionKey) : undefined;
    if (!turn) {
      respond(true, { aborted: false });
      return;
    }
    turn.handle.abort();
    respond(true, { aborted: true, runId: turn.runId });
  },

  "chat.cli.state": ({ params, respond }) => {
    const sessionKey = str((params as Record<string, unknown> | undefined)?.sessionKey);
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }
    const { entry } = loadSessionEntry(sessionKey);
    const turn = activeTurns.get(sessionKey);
    respond(true, {
      state: entry?.cliChat ?? null,
      active: turn ? { runId: turn.runId, backend: turn.backend, startedAt: turn.startedAt } : null,
    });
  },

  "chat.cli.mode": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const sessionKey = str(p.sessionKey);
    const mode = p.mode === "cli" ? "cli" : p.mode === "agent" ? "agent" : null;
    if (!sessionKey || !mode) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey and mode (agent|cli) are required"),
      );
      return;
    }
    const backend = p.backend === undefined ? undefined : normalizeCliChatBackend(p.backend);
    if (p.backend !== undefined && !backend) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Unknown CLI: ${String(p.backend)}`),
      );
      return;
    }
    let cwd: string | undefined;
    if (p.cwd !== undefined) {
      const r = resolveCliChatCwd(p.cwd);
      if (!r.cwd) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, r.error ?? "bad folder"));
        return;
      }
      cwd = r.cwd;
    }
    const model = str(p.model);
    try {
      const { entry } = await upsertCliState(sessionKey, (prev) => ({
        ...prev,
        mode,
        ...(backend ? { backend } : {}),
        ...(cwd ? { cwd } : {}),
        models: { ...prev?.models, ...(backend && model ? { [backend]: model } : {}) },
        updatedAt: Date.now(),
      }));
      respond(true, { state: entry.cliChat });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};

/** Test seam. */
export function __activeCliTurnsForTest(): Map<string, ActiveTurn> {
  return activeTurns;
}
