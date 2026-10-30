/**
 * Runs one group-chat agent turn through the same pipeline as `chat.send`:
 * the turn is registered as a chat run on the member session, so the agent's
 * text streams to the UI as ordinary `chat` delta/final events for that
 * session key, tools run as usual, and `chat.abort` / the group's Stop button
 * can cancel it. Resolves with the final reply text once the run is done.
 */
import { setSessionToolCwd } from "../../agents/session-tool-cwd.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { isLaunchPanelBrowserSession } from "../../launch-panel/runtime.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { loadConfig } from "../../config/config.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import { extractPanelRefsFromMessage } from "../../shared/chat-panels/panel-ref.js";
import type { ChatPanelRef } from "../../shared/group-chat/types.js";
import type { GroupRunSettings } from "../../shared/group-chat/settings.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveChatRunExpiresAtMs } from "../chat-abort.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { loadSessionEntry } from "../session-utils.js";
import { readSessionMessages } from "../session-utils.fs.js";
import { formatForLog } from "../ws-log.js";
import {
  extractToolActivity,
  type RawTranscriptMessage,
  type ToolActivity,
} from "../../shared/group-chat/activity.js";
import type { AgentTurnRunner } from "./service.js";

type Ctx = Pick<
  GatewayRequestContext,
  "chatAbortControllers" | "addChatRun" | "logGateway" | "loadGatewayModelCatalog"
>;

/**
 * Pin the member's effective model / thinking on its own session — the exact
 * sessions.patch path the 1:1 picker uses, so allowlist + catalog checks and
 * provider/model splitting are identical. Absent fields clear the override
 * (back to the agent default). Throws with the sessions.patch error message.
 */
export async function applyMemberRunSettings(params: {
  sessionKey: string;
  settings: GroupRunSettings;
  loadGatewayModelCatalog?: Ctx["loadGatewayModelCatalog"];
}): Promise<{ model?: string; thinkingLevel?: string }> {
  const cfg = loadConfig();
  const { storePath, canonicalKey, entry } = loadSessionEntry(params.sessionKey);
  const wantModel = params.settings.model ?? null;
  const wantThinking = params.settings.thinkingLevel ?? null;
  const currentModel = entry?.modelOverride
    ? entry.providerOverride
      ? `${entry.providerOverride}/${entry.modelOverride}`
      : entry.modelOverride
    : null;
  const patch: Record<string, unknown> = {};
  if (wantModel !== currentModel) patch.model = wantModel;
  if (wantThinking !== (entry?.thinkingLevel ?? null)) patch.thinkingLevel = wantThinking;
  if (Object.keys(patch).length === 0) {
    return { model: currentModel ?? undefined, thinkingLevel: entry?.thinkingLevel };
  }
  const applied = await updateSessionStore(storePath, (store) =>
    applySessionsPatchToStore({
      cfg,
      store,
      storeKey: canonicalKey,
      patch: { key: canonicalKey, ...patch } as never,
      loadGatewayModelCatalog: params.loadGatewayModelCatalog,
    }),
  );
  if (!applied.ok) throw new Error(applied.error?.message ?? "could not apply group settings");
  const e = applied.entry;
  return {
    model: e.modelOverride
      ? e.providerOverride
        ? `${e.providerOverride}/${e.modelOverride}`
        : e.modelOverride
      : undefined,
    thinkingLevel: e.thinkingLevel,
  };
}

/** Panels (show_panel / plugin cards) in the member session's messages since `sinceMs`. */
function panelsSince(sessionKey: string, sinceMs: number): ChatPanelRef[] {
  const out: ChatPanelRef[] = [];
  try {
    const { storePath, entry } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) return out;
    const msgs = readSessionMessages(entry.sessionId, storePath, entry.sessionFile) as Array<{
      timestamp?: number;
    }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (typeof m.timestamp === "number" && m.timestamp < sinceMs) break;
      for (const ref of extractPanelRefsFromMessage(m)) {
        if (!out.some((r) => r.panelId === ref.panelId)) out.unshift(ref);
      }
    }
  } catch {
    /* best effort */
  }
  return out;
}

/** The model the member's last reply used, read from the transcript ("provider/model"). */
function lastModelSince(sessionKey: string, sinceMs: number): string | undefined {
  try {
    const { storePath, entry } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) return undefined;
    const msgs = readSessionMessages(entry.sessionId, storePath, entry.sessionFile) as Array<{
      role?: string;
      timestamp?: number;
      provider?: string;
      model?: string;
    }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (typeof m.timestamp === "number" && m.timestamp < sinceMs) break;
      if (m.role === "assistant" && m.model)
        return m.provider ? `${m.provider}/${m.model}` : m.model;
    }
  } catch {
    /* best effort */
  }
  return undefined;
}

function lastAssistantTextSince(sessionKey: string, sinceMs: number): string {
  try {
    const { storePath, entry } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) return "";
    const msgs = readSessionMessages(entry.sessionId, storePath, entry.sessionFile) as Array<{
      role?: string;
      timestamp?: number;
      content?: unknown;
    }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "user") break;
      if (m.role !== "assistant" || (typeof m.timestamp === "number" && m.timestamp < sinceMs))
        continue;
      const parts = Array.isArray(m.content)
        ? (m.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
        : typeof m.content === "string"
          ? [m.content]
          : [];
      const text = parts.join("\n").trim();
      if (text) return text;
    }
  } catch {
    /* best effort */
  }
  return "";
}

const EVIDENCE_CHARS = 40_000;

/**
 * The member turn's tool calls + REAL results (shared activity ledger), read
 * back from the member session transcript after the run, plus the raw tool
 * output text as evidence for the truthfulness post-check.
 */
export function collectTurnActivity(
  sessionKey: string,
  sinceMs: number,
): { activity: ToolActivity[]; evidenceText: string } {
  try {
    const { storePath, entry } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || !storePath) return { activity: [], evidenceText: "" };
    const msgs = readSessionMessages(
      entry.sessionId,
      storePath,
      entry.sessionFile,
    ) as RawTranscriptMessage[];
    // Walk back to this turn's prompt (the last user message at/after sinceMs).
    let start = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (typeof m.timestamp === "number" && m.timestamp < sinceMs - 1000) break;
      start = i;
      if (m.role === "user") break;
    }
    const slice = msgs.slice(start);
    const evidence: string[] = [];
    let total = 0;
    for (const m of slice) {
      if (m.role !== "toolResult" || !Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{ type?: string; text?: string }>) {
        if (c?.type !== "text" || typeof c.text !== "string" || total > EVIDENCE_CHARS) continue;
        evidence.push(c.text);
        total += c.text.length;
      }
    }
    return { activity: extractToolActivity(slice), evidenceText: evidence.join("\n") };
  } catch {
    return { activity: [], evidenceText: "" };
  }
}

export function createGatewayAgentTurnRunner(getContext: () => Ctx | null): AgentTurnRunner {
  return async ({ sessionKey, message, runId, signal, systemPrompt, cwd, settings, images }) => {
    const context = getContext();
    if (!context) return { text: "", error: "gateway not ready" };
    try {
      await applyMemberRunSettings({
        sessionKey,
        settings,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    } catch (err) {
      return { text: "", error: err instanceof Error ? err.message : String(err) };
    }
    const cfg = loadConfig();
    const { entry } = loadSessionEntry(sessionKey);
    const configuredTimeoutMs = resolveAgentTimeoutMs({ cfg });
    const timeoutMs = isLaunchPanelBrowserSession(sessionKey)
      ? Math.max(configuredTimeoutMs, 20 * 60_000)
      : configuredTimeoutMs;
    const startedAt = Date.now();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (signal.aborted) return { text: "", error: "stopped" };
    signal.addEventListener("abort", onAbort, { once: true });

    context.chatAbortControllers.set(runId, {
      controller: abortController,
      sessionId: entry?.sessionId ?? runId,
      sessionKey,
      startedAtMs: startedAt,
      expiresAtMs: resolveChatRunExpiresAtMs({ now: startedAt, timeoutMs }),
    });
    context.addChatRun(runId, { sessionKey, clientRunId: runId });
    registerAgentRunContext(runId, { sessionKey });
    // Shared repo binding: this member session's tools run in the group's
    // workdir (identity files still load from the agent's own workspace).
    setSessionToolCwd(sessionKey, cwd ?? null);

    const ctx: MsgContext = {
      Body: message,
      BodyForAgent: message,
      BodyForCommands: message,
      RawBody: message,
      CommandBody: message,
      SessionKey: sessionKey,
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
      ChatType: "direct",
      CommandAuthorized: true,
      MessageSid: runId,
      SenderName: "Group chat",
      // Shared group context (purpose, members + roles, repo/branch/remote,
      // kanban project, date, truthfulness rules) → extraSystemPrompt.
      ...(systemPrompt ? { GroupSystemPrompt: systemPrompt } : {}),
    };

    const finalParts: string[] = [];
    let errorText: string | undefined;
    const dispatcher = createReplyDispatcher({
      onError: (err) => {
        context.logGateway.warn(`groupchat dispatch failed: ${formatForLog(err)}`);
      },
      deliver: async (payload, info) => {
        if (info.kind !== "final") return;
        const text = payload.text?.trim() ?? "";
        if (text) finalParts.push(text);
      },
    });

    try {
      await dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId,
          abortSignal: abortController.signal,
          disableBlockStreaming: true,
          ...(images?.length
            ? {
                images: images.map((i) => ({
                  type: "image" as const,
                  data: i.data,
                  mimeType: i.mimeType,
                })),
              }
            : {}),
        },
      });
      await dispatcher.waitForIdle();
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err);
    } finally {
      signal.removeEventListener("abort", onAbort);
      context.chatAbortControllers.delete(runId);
    }
    const { activity, evidenceText } = collectTurnActivity(sessionKey, startedAt);
    if (abortController.signal.aborted) return { text: "", error: "stopped", activity };
    let text = finalParts.join("\n\n").trim();
    if (!text && !errorText) text = lastAssistantTextSince(sessionKey, startedAt);
    const panels = panelsSince(sessionKey, startedAt);
    const model = lastModelSince(sessionKey, startedAt);
    return {
      text,
      ...(errorText ? { error: errorText } : {}),
      activity,
      evidenceText,
      ...(panels.length ? { panels } : {}),
      ...(model ? { model } : {}),
    };
  };
}
