import { randomUUID } from "node:crypto";
import { secureChatSendBlockReason } from "../../secure-mode/gateway-guards.js";
import { secureOnlyBlockReason } from "../../secure-mode/agent-policy.js";
import { isSecureSessionKey } from "../../secure-mode/session-key.js";
import { getSecureModeRuntime } from "../../secure-mode/runtime.js";
import { secureReplyTruthNote } from "../../secure-mode/truth-check.js";
import { collectTurnActivity } from "../group-chat/agent-turn.js";
import fs from "node:fs";
import path from "node:path";

import { consumeChatSend } from "../../license/chat-counter.js";
import { gatedError } from "../../license/middleware.js";

import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../../agents/identity.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { isLocalModelTurn } from "../../agents/local-model-turn.js";
import { resolveAgentTimeoutMs, resolveTurnTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../auto-reply/reply/response-prefix-template.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { loadConfig } from "../../config/config.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import { type ChatImageContent, parseMessageWithAttachments } from "../chat-attachments.js";
import { buildAttachmentOcrContext } from "../../ocr/runtime.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { humanizeChatError, humanizeHistoryErrors } from "../chat-error-humanize.js";
import { stripEnvelopeFromMessages } from "../chat-sanitize.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { forwardGatewayCall } from "../../federation/hub-forward.js";
import { getConnectedSatellite, proxyMethodsToMaster } from "../../federation/satellite-context.js";
import { registerRemoteSession } from "../../federation/remote-session-registry.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { isGroupChatKey } from "../../shared/group-chat/keys.js";
import { handleGroupChatSend } from "./group-chat.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

function getRequestedNodeId(params: { nodeId?: unknown; node?: unknown }): string {
  return (
    (typeof params.nodeId === "string" ? params.nodeId.trim() : "") ||
    (typeof params.node === "string" ? params.node.trim() : "")
  );
}

function wantsRemoteNode(nodeId: string): boolean {
  if (!nodeId || nodeId === "local") return false;
  const cfg = loadConfig();
  const localNodeId = cfg.federation?.nodeId;
  if (localNodeId && nodeId === localNodeId) return false;
  if (cfg.federation?.mode === "master" && nodeId === "master") return false;
  return true;
}

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
}): string | null {
  const { sessionId, storePath, sessionFile } = params;
  if (sessionFile) return sessionFile;
  if (!storePath) return null;
  return path.join(path.dirname(storePath), `${sessionId}.jsonl`);
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) return { ok: true };
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  createIfMissing?: boolean;
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  const now = Date.now();
  const messageId = randomUUID().slice(0, 8);
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  const messageBody: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: `${labelPrefix}${params.message}` }],
    timestamp: now,
    stopReason: "injected",
    usage: { input: 0, output: 0, totalTokens: 0 },
  };
  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  };

  try {
    fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, messageId, message: transcriptEntry.message };
}

/**
 * Append a passive user message (e.g., video frame) to transcript without triggering agent.
 * Used for video mode where frames are added to context for the agent to see on next real message.
 */
function appendUserTranscriptMessage(params: {
  message: string;
  images?: Array<{ mimeType: string; content: string }>;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  createIfMissing?: boolean;
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  const now = Date.now();
  const messageId = randomUUID().slice(0, 8);

  // Build content blocks
  const contentBlocks: Array<Record<string, unknown>> = [];
  if (params.message.trim()) {
    contentBlocks.push({ type: "text", text: params.message });
  }
  // Add images
  if (params.images && params.images.length > 0) {
    for (const img of params.images) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType,
          data: img.content,
        },
      });
    }
  }

  // If no content, add placeholder
  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: "text", text: "[video frame]" });
  }

  const messageBody: Record<string, unknown> = {
    role: "user",
    content: contentBlocks,
    timestamp: now,
  };
  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  };

  try {
    fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, messageId, message: transcriptEntry.message };
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: params.message,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    ...humanizeChatError(params.errorMessage),
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

/**
 * Window of a transcript for chat.history: the `limit` newest messages, or with
 * `beforeIndex` the `limit` messages ending just before that absolute index.
 */
export function sliceHistoryPage(
  total: number,
  limit: number,
  beforeIndex?: number,
): { start: number; end: number } {
  const end =
    typeof beforeIndex === "number" ? Math.max(0, Math.min(total, Math.floor(beforeIndex))) : total;
  return { start: Math.max(0, end - Math.max(1, limit)), end };
}

const _rawChatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit, beforeIndex } = params as {
      sessionKey: string;
      limit?: number;
      beforeIndex?: number;
    };
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const rawMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    // Message-count caps are not the safety mechanism here — the 6MB byte cap
    // below is, and it bounds the response whatever the count. A self-hosted
    // user asking for their own history should get it, so the count cap is
    // loose enough not to be what truncates a real conversation.
    const hardMax = 10_000;
    const defaultLimit = 1000;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const page = sliceHistoryPage(rawMessages.length, max, beforeIndex);
    const sliced = rawMessages.slice(page.start, page.end);
    const sanitized = humanizeHistoryErrors(stripEnvelopeFromMessages(sliced));
    const capped = capArrayByJsonBytes(sanitized, getMaxChatHistoryMessagesBytes()).items;
    // The byte cap drops the oldest messages; the page then starts later.
    const startIndex = page.start + (sliced.length - capped.length);
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const configured = cfg.agents?.defaults?.thinkingDefault;
      if (configured) {
        thinkingLevel = configured;
      } else {
        const { provider, model } = resolveSessionModelRef(cfg, entry);
        const catalog = await context.loadGatewayModelCatalog();
        thinkingLevel = resolveThinkingDefault({
          cfg,
          provider,
          model,
          catalog,
        });
      }
    }
    respond(true, {
      sessionKey,
      sessionId,
      messages: capped,
      thinkingLevel,
      startIndex,
      total: rawMessages.length,
      hasMore: startIndex > 0,
    });
  },
  "chat.abort": async ({ params, respond, context }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
      nodeId?: string;
      node?: string;
    };

    const rawNodeId = getRequestedNodeId(params as { nodeId?: unknown; node?: unknown });
    const wantsRemote = wantsRemoteNode(rawNodeId);
    if (wantsRemote) {
      const {
        nodeId: _dropNodeId,
        node: _dropNode,
        ...forwardParams
      } = params as Record<string, unknown>;
      const fwd = await forwardGatewayCall<{
        ok?: boolean;
        aborted?: boolean;
        runIds?: string[];
        error?: string;
      }>(rawNodeId, "chat.abort", forwardParams);
      if (fwd.success) {
        respond(true, { ...fwd.payload, remote: true, nodeId: rawNodeId }, undefined);
        return;
      }
      // forwardGatewayCall now routes every direction (incl. sat→sat via the
      // master). Surface real failures; only a standalone install
      // (NOT_FEDERATED) falls through to a local attempt.
      if (fwd.code !== "NOT_FEDERATED") {
        respond(
          false,
          undefined,
          errorShape(
            (fwd.code ?? "FORWARD_FAILED") as never,
            fwd.error ?? `Failed to forward chat.abort to node ${rawNodeId}`,
          ),
        );
        return;
      }
    }

    const ops = {
      chatAbortControllers: context.chatAbortControllers,
      chatRunBuffers: context.chatRunBuffers,
      chatDeltaSentAt: context.chatDeltaSentAt,
      chatAbortedRuns: context.chatAbortedRuns,
      removeChatRun: context.removeChatRun,
      agentRunSeq: context.agentRunSeq,
      broadcast: context.broadcast,
      nodeSendToSession: context.nodeSendToSession,
    };

    if (!runId) {
      const res = abortChatRunsForSessionKey(ops, {
        sessionKey,
        stopReason: "rpc",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }

    const res = abortChatRunById(ops, {
      runId,
      sessionKey,
      stopReason: "rpc",
    });
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
        ocrId?: string;
        filePath?: string;
      }>;
      timeoutMs?: number;
      idempotencyKey: string;
      /** Passive mode: add to transcript without triggering agent (for video frames) */
      passive?: boolean;
      nodeId?: string;
      node?: string;
    };

    const rawNodeId = getRequestedNodeId(p);
    const wantsRemote = wantsRemoteNode(rawNodeId);
    // Secure Mode per-agent policy: a secureOnly agent refuses normal sessions.
    {
      const secureOnly = secureOnlyBlockReason(loadConfig(), p.sessionKey);
      if (secureOnly) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Blocked by Secure Mode: ${secureOnly}`),
        );
        return;
      }
    }
    // Secure Mode lane: only runs on this host, only while unlocked.
    if (isSecureSessionKey(p.sessionKey)) {
      const blocked = secureChatSendBlockReason({ remote: wantsRemote });
      if (blocked) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, blocked));
        return;
      }
    }
    if (wantsRemote) {
      const { nodeId: _dropNodeId, node: _dropNode, ...forwardParams } = p;
      const fwd = await forwardGatewayCall<{
        status?: string;
        runId?: string;
        sessionKey?: string;
        error?: string;
      }>(rawNodeId, "chat.send", forwardParams);
      if (fwd.success) {
        const remoteRunId = fwd.payload?.runId ?? "";
        const remoteSessionKey = fwd.payload?.sessionKey ?? "";
        if (remoteRunId && remoteSessionKey) {
          try {
            const cfg = loadConfig();
            registerRemoteSession({
              runId: remoteRunId,
              sessionKey: remoteSessionKey,
              nodeId: rawNodeId,
              agentId: resolveSessionAgentId({ sessionKey: remoteSessionKey, config: cfg }),
              task: p.message.trim() || "Chat message",
              label: "Chat message",
              cleanup: "keep",
            });
          } catch {
            // Best-effort: registry tagging failure shouldn't block chat send.
          }
        }
        respond(true, { ...fwd.payload, remote: true, nodeId: rawNodeId }, undefined, {
          runId: remoteRunId || p.idempotencyKey,
        });
        return;
      }
      // forwardGatewayCall now routes every direction (incl. sat→sat via the
      // master). Surface real failures; only a standalone install
      // (NOT_FEDERATED) falls through to a local attempt.
      if (fwd.code !== "NOT_FEDERATED") {
        respond(
          false,
          undefined,
          errorShape(
            (fwd.code ?? "FORWARD_FAILED") as never,
            fwd.error ?? `Failed to forward chat.send to node ${rawNodeId}`,
          ),
        );
        return;
      }
    }

    const stopCommand = isChatStopCommandText(p.message);

    // Free-tier AI-chat daily cap. Only count sends that actually trigger the
    // agent — skip passive (transcript-only) sends and stop commands. Paid
    // plans (ai_chat_unlimited) bypass entirely inside consumeChatSend().
    if (!p.passive && !stopCommand) {
      const gate = consumeChatSend();
      if (!gate.allowed) {
        const err = gatedError(gate.feature ?? "ai_chat_unlimited");
        respond(false, undefined, {
          ...err,
          message: `Free plan is limited to ${gate.cap} AI chat messages per day. Upgrade to ${gate.requiredPlan ?? "starter"} for unlimited chat.`,
        });
        return;
      }
    }

    // Agent group chats: the group's session is a shared transcript, not an
    // agent session — hand the message to the group orchestrator, which runs
    // the member agents' turns (see server-methods/group-chat.ts).
    if (isGroupChatKey(p.sessionKey) && !p.passive) {
      try {
        const res = await handleGroupChatSend({
          context,
          sessionKey: p.sessionKey,
          message: p.message,
          stop: stopCommand,
          attachments: p.attachments,
        });
        respond(
          true,
          { runId: p.idempotencyKey, status: stopCommand ? "ok" : "started", ...res },
          undefined,
          { runId: p.idempotencyKey },
        );
        // Plain chat surfaces wait for a final on this runId; agent replies
        // arrive as their own finals, so close this one straight away.
        if (!stopCommand) {
          broadcastChatFinal({ context, runId: p.idempotencyKey, sessionKey: p.sessionKey });
        }
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
        );
      }
      return;
    }

    const normalizedAttachments =
      p.attachments
        ?.map((a) => ({
          type: typeof a?.type === "string" ? a.type : undefined,
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
          fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
          ocrId: typeof a?.ocrId === "string" ? a.ocrId : undefined,
          filePath: typeof a?.filePath === "string" ? a.filePath : undefined,
          content:
            typeof a?.content === "string"
              ? a.content
              : ArrayBuffer.isView(a?.content)
                ? Buffer.from(
                    a.content.buffer,
                    a.content.byteOffset,
                    a.content.byteLength,
                  ).toString("base64")
                : undefined,
        }))
        .filter((a) => a.content || a.ocrId) ?? [];
    const rawMessage = p.message.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    let parsedMessage = p.message;
    let parsedImages: ChatImageContent[] = [];
    if (normalizedAttachments.length > 0) {
      try {
        // Videos never go to the model as content blocks (and can exceed the
        // 5 MB image cap); they are persisted + processed by the local video
        // pipeline through buildAttachmentOcrContext below.
        const imageLike = normalizedAttachments.filter(
          (a) => Boolean(a.content) && (a.mimeType ?? "").toLowerCase().startsWith("image/"),
        );
        const parsed = await parseMessageWithAttachments(p.message, imageLike, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const { cfg, entry } = loadSessionEntry(p.sessionKey);
    // Local-model / Secure Mode sessions run longer turns (agents.defaults.
    // localTimeoutSeconds) — keep the chat run alive at least that long.
    const timeoutMs = resolveTurnTimeoutMs({
      cfg,
      timeoutMs: resolveAgentTimeoutMs({ cfg, overrideMs: p.timeoutMs }),
      local: isLocalModelTurn({
        cfg,
        provider: resolveSessionModelRef(
          cfg,
          entry,
          resolveSessionAgentId({ sessionKey: p.sessionKey, config: cfg }),
        ).provider,
        sessionKey: p.sessionKey,
      }),
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey: p.sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKey(
        {
          chatAbortControllers: context.chatAbortControllers,
          chatRunBuffers: context.chatRunBuffers,
          chatDeltaSentAt: context.chatDeltaSentAt,
          chatAbortedRuns: context.chatAbortedRuns,
          removeChatRun: context.removeChatRun,
          agentRunSeq: context.agentRunSeq,
          broadcast: context.broadcast,
          nodeSendToSession: context.nodeSendToSession,
        },
        { sessionKey: p.sessionKey, stopReason: "stop" },
      );
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    // Passive mode: append to transcript but don't trigger agent (for video frames)
    if (p.passive) {
      const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(p.sessionKey);
      const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;

      // Convert parsed images to the format needed for transcript
      const transcriptImages = parsedImages.map((img) => ({
        mimeType: img.mimeType,
        content: img.data,
      }));

      const appended = appendUserTranscriptMessage({
        message: parsedMessage,
        images: transcriptImages.length > 0 ? transcriptImages : undefined,
        sessionId,
        storePath: latestStorePath,
        sessionFile: latestEntry?.sessionFile,
        createIfMissing: true,
      });

      if (!appended.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, appended.error ?? "failed to append passive message"),
        );
        return;
      }

      // Broadcast to UI so the frame appears in chat
      const chatPayload = {
        runId: `passive-${appended.messageId}`,
        sessionKey: p.sessionKey,
        seq: 0,
        state: "final" as const,
        message: appended.message,
      };
      context.broadcast("chat", chatPayload);
      context.nodeSendToSession(p.sessionKey, "chat", chatPayload);

      // In satellite mode: relay the passive transcript entry to master so
      // voice session transcripts persist on the master node.
      const satPassive = getConnectedSatellite();
      if (satPassive && appended.message) {
        const relayEntry = {
          type: "message",
          id: appended.messageId ?? randomUUID().slice(0, 8),
          timestamp: new Date().toISOString(),
          message: appended.message,
        };
        satPassive
          .invokeOnMaster("chat.transcript.relay", {
            sessionKey: p.sessionKey,
            entry: relayEntry,
            "x-federation-relay": true,
          })
          .catch(() => {
            // Fire-and-forget — local write already succeeded.
          });
      }

      respond(true, {
        ok: true,
        passive: true,
        messageId: appended.messageId,
      });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: p.sessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
      });

      context.addChatRun(clientRunId, {
        sessionKey: p.sessionKey,
        clientRunId,
      });
      registerAgentRunContext(clientRunId, { sessionKey: p.sessionKey });

      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      // Local auto-OCR: persist attachments (secure sessions → vault) and give
      // the agent their text inline. Bounded wait; the ack already went out.
      let bodyForAgent = parsedMessage;
      if (normalizedAttachments.length > 0) {
        try {
          const { block } = await buildAttachmentOcrContext({
            sessionKey: p.sessionKey,
            attachments: normalizedAttachments,
            kind: "chat",
            waitMs: 10_000,
          });
          if (block) bodyForAgent = `${parsedMessage}\n\n${block}`.trim();
        } catch (err) {
          context.logGateway.warn(`attachment OCR context failed: ${formatForLog(err)}`);
        }
      }

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const clientInfo = client?.connect?.client;
      const ctx: MsgContext = {
        Body: parsedMessage,
        BodyForAgent: bodyForAgent,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        SessionKey: p.sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
      };

      const agentId = resolveSessionAgentId({
        sessionKey: p.sessionKey,
        config: cfg,
      });
      let prefixContext: ResponsePrefixContext = {
        identityName: resolveIdentityName(cfg, agentId),
      };
      const finalReplyParts: string[] = [];
      const dispatcher = createReplyDispatcher({
        responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix,
        responsePrefixContextProvider: () => prefixContext,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (info.kind !== "final") return;
          const text = payload.text?.trim() ?? "";
          if (!text) return;
          finalReplyParts.push(text);
        },
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          disableBlockStreaming: true,
          onAgentRunStart: () => {
            agentRunStarted = true;
          },
          onModelSelected: (ctx) => {
            prefixContext.provider = ctx.provider;
            prefixContext.model = extractShortModelName(ctx.model);
            prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
            prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
          },
        },
      })
        .then(() => {
          if (agentRunStarted && isSecureSessionKey(p.sessionKey)) {
            // Secure chat truth guard: a claim with no successful tool result
            // behind it gets a visible gateway note in the same secure session.
            try {
              const reply = finalReplyParts.join("\n\n").trim();
              const { activity, evidenceText } = collectTurnActivity(p.sessionKey, now);
              const verdict = reply
                ? secureReplyTruthNote({ reply, activity, evidenceText })
                : null;
              if (verdict) {
                const { storePath: sp, entry: se } = loadSessionEntry(p.sessionKey);
                const sessionId = se?.sessionId ?? entry?.sessionId;
                // Only ever into the RAM (vault-sealed) transcript, never a disk path.
                const appended =
                  sessionId && getSecureModeRuntime().isRamTranscriptPath(se?.sessionFile)
                    ? appendAssistantTranscriptMessage({
                        message: verdict.note,
                        sessionId,
                        storePath: sp,
                        sessionFile: se?.sessionFile,
                      })
                    : null;
                if (appended?.ok) {
                  broadcastChatFinal({
                    context,
                    runId: `truth-${clientRunId}`,
                    sessionKey: p.sessionKey,
                    message: appended.message,
                  });
                }
                context.logGateway.warn(
                  `secure chat: ${verdict.flags.length} unverified claim(s) flagged (${verdict.flags.map((f) => f.kind).join(", ")})`,
                );
              }
            } catch (err) {
              context.logGateway.warn(`secure chat truth check failed: ${formatForLog(err)}`);
            }
          }
          if (!agentRunStarted) {
            const combinedReply = finalReplyParts
              .map((part) => part.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            let message: Record<string, unknown> | undefined;
            if (combinedReply) {
              const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                p.sessionKey,
              );
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const appended = appendAssistantTranscriptMessage({
                message: combinedReply,
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile,
                createIfMissing: true,
              });
              if (appended.ok) {
                message = appended.message;
              } else {
                context.logGateway.warn(
                  `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                );
                const now = Date.now();
                message = {
                  role: "assistant",
                  content: [{ type: "text", text: combinedReply }],
                  timestamp: now,
                  stopReason: "injected",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
              }
            }
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: p.sessionKey,
              message,
            });
          }

          // In satellite mode: relay the user message transcript entry to
          // master so voice session transcripts persist on the master node.
          const satSend = getConnectedSatellite();
          if (satSend) {
            const relayEntry = {
              type: "message",
              id: `${clientRunId}-user`,
              timestamp: new Date().toISOString(),
              message: {
                role: "user" as const,
                content: [{ type: "text" as const, text: p.message }],
                timestamp: now,
              },
            };
            satSend
              .invokeOnMaster("chat.transcript.relay", {
                sessionKey: p.sessionKey,
                entry: relayEntry,
                "x-federation-relay": true,
              })
              .catch(() => {
                // Fire-and-forget — local write already succeeded.
              });
          }

          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: true,
            payload: { runId: clientRunId, status: "ok" as const },
          });
        })
        .catch((err) => {
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: false,
            payload: {
              runId: clientRunId,
              status: "error" as const,
              summary: String(err),
            },
            error,
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey: p.sessionKey,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      context.dedupe.set(`chat:${clientRunId}`, {
        ts: Date.now(),
        ok: false,
        payload,
        error,
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const { storePath, entry } = loadSessionEntry(p.sessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    // Resolve transcript path
    const transcriptPath = entry?.sessionFile
      ? entry.sessionFile
      : path.join(path.dirname(storePath), `${sessionId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "transcript file not found"),
      );
      return;
    }

    // Build transcript entry
    const now = Date.now();
    const messageId = randomUUID().slice(0, 8);
    const labelPrefix = p.label ? `[${p.label}]\n\n` : "";
    const messageBody: Record<string, unknown> = {
      role: "assistant",
      content: [{ type: "text", text: `${labelPrefix}${p.message}` }],
      timestamp: now,
      stopReason: "injected",
      usage: { input: 0, output: 0, totalTokens: 0 },
    };
    const transcriptEntry = {
      type: "message",
      id: messageId,
      timestamp: new Date(now).toISOString(),
      message: messageBody,
    };

    // Append to transcript file
    try {
      fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to write transcript: ${errMessage}`),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      runId: `inject-${messageId}`,
      sessionKey: p.sessionKey,
      seq: 0,
      state: "final" as const,
      message: transcriptEntry.message,
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(p.sessionKey, "chat", chatPayload);

    // In satellite mode: mirror the transcript entry to master so voice
    // session transcripts persist on the master node, not just satellite-local.
    const sat = getConnectedSatellite();
    if (sat) {
      sat
        .invokeOnMaster("chat.transcript.relay", {
          sessionKey: p.sessionKey,
          entry: transcriptEntry,
        })
        .catch(() => {
          // Fire-and-forget — local write already succeeded; relay failure is non-fatal.
        });
    }

    respond(true, { ok: true, messageId });
  },

  /**
   * Relay a transcript entry from a satellite to this (master) node.
   * Appends the entry to a relay transcript file in the master's state dir.
   * Called by chat.inject on satellite nodes after a successful local write.
   */
  "chat.transcript.relay": async ({ params, respond }) => {
    const { sessionKey, entry } = params as {
      sessionKey?: string;
      entry?: Record<string, unknown>;
    };
    if (!sessionKey || !entry || typeof entry !== "object") {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "sessionKey and entry are required",
      });
      return;
    }

    try {
      // Store relay transcripts under a dedicated subdir so they don't
      // conflict with master-owned session files.
      const { STATE_DIR } = await import("../../config/paths.js");
      const relayDir = path.join(STATE_DIR, "sessions", "relay");
      fs.mkdirSync(relayDir, { recursive: true });

      // Sanitise sessionKey to a safe filename.
      const safeName = sessionKey.replace(/[^a-zA-Z0-9_\-:.]/g, "_");
      const relayFile = path.join(relayDir, `${safeName}.jsonl`);

      fs.appendFileSync(relayFile, `${JSON.stringify(entry)}\n`, "utf-8");
      respond(true, { ok: true });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

// Proxy selective chat methods to master in satellite mode.
// chat.history and chat.abort delegate to master so the satellite user
// sees the master's conversation state. chat.send, chat.inject, and
// chat.transcript.relay are excluded: chat.send runs locally with its
// own relay logic (see Task 2), chat.inject already relays entries,
// and chat.transcript.relay is the master-side receiver.
export const chatHandlers: GatewayRequestHandlers = proxyMethodsToMaster(_rawChatHandlers, [
  "chat.history",
  "chat.abort",
]);

// session.send — singular alias for chat.send.
//
// The federation layer's message-type registry, security allowlists, and
// hub-forward path all use "session.send" as the canonical name for
// "deliver a user message into an existing session." Several callsites
// land here directly against the local gateway registry: useFederation
// short-circuits to the local gateway when the selected node is local,
// the satellite-mode `session:send:request` listener invokes the local
// gateway, and ad-hoc UI surfaces sometimes call the singular name. None
// of them want to know about the chat.send/sessions.send naming split.
// Without this alias every such call falls through to the unknown-method
// handler in server-methods.ts.
//
// Behavior mirrors chat.send exactly: auto-fill idempotencyKey when the
// caller omits it (federation tunneling passes a correlationId we don't
// surface here, and validateChatSendParams requires the field).
chatHandlers["session.send"] = async (opts) => {
  const params = (opts.params ?? {}) as Record<string, unknown>;
  const idempotencyKey =
    typeof params.idempotencyKey === "string" && params.idempotencyKey.trim()
      ? params.idempotencyKey
      : `session-send-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const next = {
    ...opts,
    params: { ...params, idempotencyKey },
    req: { ...opts.req, params: { ...params, idempotencyKey } },
  };
  await chatHandlers["chat.send"](next);
};
