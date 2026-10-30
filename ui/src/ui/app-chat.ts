import { abortChatRun, loadChatHistory, sendChatMessage } from "./controllers/chat";
import { loadSessions } from "./controllers/sessions";
import { generateUUID } from "./uuid";
import { resetToolStream } from "./app-tool-stream";
import { scheduleChatScroll } from "./app-scroll";
import { setLastActiveSessionKey } from "./app-settings";
import { normalizeBasePath } from "./navigation";
import type { GatewayHelloOk } from "./gateway";
import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import type { InfiniBotApp } from "./app";
import type { ChatAttachment, ChatQueueItem } from "./ui-types";

type ChatHost = {
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
};

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase();
  if (normalized === "/stop") return true;
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) return;
  host.chatMessage = "";
  await abortChatRun(host as unknown as InfiniBotApp);
}

function enqueueChatMessage(host: ChatHost, text: string, attachments?: ChatAttachment[]) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) return;
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
    },
  ];
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  const ok = await sendChatMessage(host as unknown as InfiniBotApp, message, opts?.attachments);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    setLastActiveSessionKey(host as unknown as Parameters<typeof setLastActiveSessionKey>[0], host.sessionKey);
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  return ok;
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) return;
  const [next, ...rest] = host.chatQueue;
  if (!next) return;
  host.chatQueue = rest;
  const ok = await sendChatMessageNow(host, next.text, { attachments: next.attachments });
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
) {
  if (!host.connected) return;
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // Allow sending with just attachments (no message text required)
  if (!message && !hasAttachments) return;

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  // Intercept /new — create new session tab without destroying current
  if (message === "/new" || message === "/reset") {
    const newKey = `agent:main:webchat-${Date.now().toString(36)}`;
    host.chatMessage = "";
    host.chatAttachments = [];
    // Use the app's onNewSession-style switch
    const app = host as unknown as InfiniBotApp;
    app.sessionKey = newKey;
    app.chatStream = null;
    (app as any).chatStreamStartedAt = null;
    app.chatRunId = null;
    (app as any).chatQueue = [];
    (app as any).chatMessages = [];
    (app as any).chatToolMessages = [];
    app.resetToolStream();
    app.resetChatScroll();
    app.applySettings({
      ...app.settings,
      sessionKey: newKey,
      lastActiveSessionKey: newKey,
    });
    void app.loadAssistantIdentity();
    void loadChatHistory(app);
    void refreshChatAvatar(host);
    return;
  }

  if (messageOverride == null) {
    host.chatMessage = "";
    // Clear attachments when sending
    host.chatAttachments = [];
  }

  if (isChatBusy(host)) {
    enqueueChatMessage(host, message, attachmentsToSend);
    return;
  }

  await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
  });
}

export async function refreshChat(host: ChatHost) {
  const app = host as unknown as InfiniBotApp;
  // Skip loading chat history if it was already loaded on connect (prevents double-load flicker)
  const skipChatHistory = (app as any)._chatLoadedOnConnect === true;
  if (skipChatHistory) {
    console.log("[Chat] refreshChat: Skipping loadChatHistory (already loaded on connect)");
  }
  await Promise.all([
    skipChatHistory ? Promise.resolve() : loadChatHistory(app),
    loadSessions(app),
    refreshChatAvatar(host),
  ]);
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true);
}

export const flushChatQueueForEvent = flushChatQueue;

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) return parsed.agentId;
  const snapshot = host.hello?.snapshot as { sessionDefaults?: SessionDefaultsSnapshot } | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    host.chatAvatarUrl = null;
    return;
  }
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    host.chatAvatarUrl = null;
    return;
  }
  host.chatAvatarUrl = null;
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      host.chatAvatarUrl = null;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
  } catch {
    host.chatAvatarUrl = null;
  }
}
