import { isSecureSessionKey } from "../secure-mode/session-key";
import {
  formatChatErrorText,
  formatModelFallbackNotice,
  parseModelFallbackNotice,
} from "../chat-error-format";
import { extractText } from "../chat/message-extract";
import type { GatewayBrowserClient } from "../gateway";
import { generateUUID } from "../uuid";
import type { ChatAttachment } from "../ui-types";

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
  /** e.g. "model_unavailable" — see src/agents/turn-failure.ts */
  errorCode?: string;
  errorHint?: string;
};

/**
 * Stable identity for a chat message. We try a couple of common shapes —
 * a top-level `id` / `messageId`, then the run id, then the timestamp —
 * so the "did the response actually change?" check after loadChatHistory
 * doesn't false-positive on every re-fetch.
 */
function getMessageId(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  // `clientMsgId` is a locally-stamped uuid (see stampClientMsgId) that gives
  // optimistic/in-flight messages a stable identity BEFORE the store knows
  // about them — this is what lets the reconcile merge match a streaming
  // placeholder to its persisted copy instead of dropping or duplicating it.
  const id = m.id ?? m.clientMsgId ?? m.messageId ?? m.runId ?? m.timestamp;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

/**
 * Stamp a stable client-side id on a message that lacks one, so the reconcile
 * merge can track it by identity. Returns the (possibly mutated) message.
 */
function stampClientMsgId<T>(msg: T): T {
  if (!msg || typeof msg !== "object") return msg;
  const m = msg as Record<string, unknown>;
  if (m.id == null && m.clientMsgId == null && m.messageId == null) {
    m.clientMsgId = generateUUID();
  }
  return msg;
}

/**
 * Content-level dedupe key (role + extracted text). Used as a fallback when a
 * locally-committed message has since been persisted under a DIFFERENT id
 * (e.g. an optimistic user turn or a just-streamed assistant reply that the
 * store now returns with its own server id) — matching on text prevents the
 * merge from showing the same turn twice.
 */
function contentDedupeKey(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  const cached = (m as { _extractedText?: unknown })._extractedText;
  const text =
    typeof cached === "string" ? cached : (extractText(msg) ?? "");
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `${role}::${trimmed}`;
}

function timestampOf(msg: unknown): number {
  if (!msg || typeof msg !== "object") return 0;
  const t = (msg as Record<string, unknown>).timestamp;
  return typeof t === "number" ? t : 0;
}

/**
 * Reconcile the persisted store snapshot with the current local transcript by
 * MERGING (never replacing). The store is authoritative for anything it knows
 * about (so streaming placeholders resolve to their final persisted form by
 * id), but any LOCAL message the store hasn't caught up to yet — an optimistic
 * user turn, an in-flight stream, or a just-completed reply that hasn't been
 * persisted — is PRESERVED. This is the fix for the "message/response gets
 * deleted, agent looks unresponsive" bug where a reconnect/forced reconcile
 * fired mid-turn and the older store snapshot overwrote live local state.
 */
function mergeChatMessages(
  storeMessages: unknown[],
  localMessages: unknown[],
): unknown[] {
  const storeIds = new Set<string>();
  const storeKeys = new Set<string>();
  for (const m of storeMessages) {
    const id = getMessageId(m);
    if (id) storeIds.add(id);
    const key = contentDedupeKey(m);
    if (key) storeKeys.add(key);
  }
  // Keep local messages the store doesn't yet represent — by id first, then by
  // content so a persisted-under-a-new-id copy doesn't produce a duplicate.
  const preserved: unknown[] = [];
  for (const m of localMessages) {
    const id = getMessageId(m);
    if (id && storeIds.has(id)) continue;
    const key = contentDedupeKey(m);
    if (key && storeKeys.has(key)) continue;
    preserved.push(m);
  }
  if (preserved.length === 0) return storeMessages;
  // Store rows are already time-ordered; appended local rows are newer. A
  // stable sort (Array.sort is stable in ES2019+) keeps store order for equal
  // timestamps while interleaving anything with an older local timestamp.
  const merged = [...storeMessages, ...preserved];
  merged.sort((a, b) => timestampOf(a) - timestampOf(b));
  return merged;
}

/**
 * True when two message lists are equivalent — same ids AND same text in the
 * same order. Text is compared too so a store row that keeps its id but
 * resolves a streaming placeholder's content (partial → final) still triggers
 * the reassignment instead of being suppressed by the re-render optimization.
 */
function sameMessageSequence(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (getMessageId(a[i]) !== getMessageId(b[i])) return false;
    if (contentDedupeKey(a[i]) !== contentDedupeKey(b[i])) return false;
  }
  return true;
}

/**
 * Normalize a raw message into a simple format with text extracted.
 * This follows the masonry-grid pattern that works reliably.
 */
function normalizeMessageForRender(msg: unknown): unknown {
  const m = msg as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "unknown";
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.now();
  
  // Extract text content using the same logic as masonry-grid
  const content = m.content;
  let textContent: string | null = null;
  
  if (typeof content === "string") {
    textContent = content;
  } else if (Array.isArray(content)) {
    const parts = content
      .map((p: any) => {
        if (p?.type === "text" && typeof p?.text === "string") return p.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) textContent = parts.join("\n");
  } else if (typeof m.text === "string") {
    textContent = m.text;
  }
  
  // Return normalized message with pre-extracted text
  // We keep the original content structure for images/tools but add _extractedText for rendering
  return {
    ...m,
    role,
    timestamp,
    _extractedText: textContent,
  };
}

/**
 * One-shot session-switch helper that mirrors how the grid chat panel
 * handles thread changes — clears the in-flight render state for the old
 * session synchronously (so the next paint never shows old messages under
 * a new session header), bumps `chatLoadedSessionKey` to null so the
 * empty-state gate knows the new key hasn't been loaded yet, and kicks off
 * `loadChatHistory` for the new key. All session-picker handlers
 * (top tab bar, threads sidebar, model dropdown) should call this so the
 * UX stays uniform.
 */
export function switchChatSession(state: ChatState, nextSessionKey: string): void {
  if (!nextSessionKey) return;
  if (state.sessionKey === nextSessionKey) {
    // Re-clicking the active session is a no-op — don't blow away in-flight
    // streams or scroll position.
    return;
  }
  clearChatWatchdog(state);
  state.sessionKey = nextSessionKey;
  state.chatMessages = [];
  state.chatStream = null;
  state.chatStreamStartedAt = null;
  state.chatRunId = null;
  state.lastError = null;
  (state as any).chatToolMessages = [];
  (state as any).chatLoadedSessionKey = null;
  // chatLoading flips true synchronously inside loadChatHistory before it
  // awaits, so the very next render already shows the loading skeleton
  // instead of an empty thread.
  if (state.client && state.connected) {
    void loadChatHistory(state);
  }
}

// Dedupe concurrent loadChatHistory calls so that two paths firing in the
// same tick (gateway onHello + setTabFromRoute → refreshActiveTab is the
// usual culprit on first connect) don't re-mount the chat tree, which
// observably re-runs chat-mic-button + wake-word init and "glitches" the UI.
// We key on the session being loaded so a genuinely different session can
// preempt an in-flight load.
const inflightChatHistory = new Map<string, Promise<void>>();

export interface LoadChatHistoryOptions {
  /**
   * Bypass the "already-loaded for this session" guard. Use this for the
   * Refresh button and event-driven refreshes that explicitly want fresh
   * data. Default callers (initial connect, session switch) should leave
   * this false so a stale second call from a racing path can't overwrite
   * a freshly-loaded transcript with a 0-message response.
   */
  force?: boolean;
}

export async function loadChatHistory(
  state: ChatState,
  opts?: LoadChatHistoryOptions,
) {
  if (!state.client || !state.connected) {
    console.log('[Chat] loadChatHistory: Not connected, skipping');
    return;
  }
  const sessionKey = state.sessionKey;
  // Skip when a successful load for this session already landed and the
  // caller didn't ask for a refresh. Prevents a sequential second call —
  // e.g. refreshActiveTab firing after onHello finished — from clobbering
  // populated chatMessages with an empty response, which presented as
  // "history shows then instantly disappears".
  if (
    !opts?.force &&
    (state as any).chatLoadedSessionKey === sessionKey
  ) {
    console.log(`[Chat] loadChatHistory: already loaded for "${sessionKey}", skipping`);
    return;
  }
  const existing = inflightChatHistory.get(sessionKey);
  if (existing) {
    console.log(`[Chat] loadChatHistory: deduping in-flight load for "${sessionKey}"`);
    return existing;
  }
  const task = (async () => {
    state.chatLoading = true;
    state.lastError = null;
    console.log(`[Chat] loadChatHistory: Loading for session "${sessionKey}"...`);
    try {
      type HistoryRes = { messages?: unknown[]; thinkingLevel?: string | null };
      let res: HistoryRes;
      try {
        res = (await state.client!.request("chat.history", {
          // Ask for the whole conversation. The server's byte cap is what
          // actually bounds the response; a count of 200 here was silently
          // cutting long sessions off before they ever reached the client.
          sessionKey,
          limit: 10_000,
        })) as HistoryRes;
      } catch (err) {
        // Gateways built before the schema max was raised reject limit > 1000
        // at validation — retry at their ceiling rather than showing nothing.
        if (!/must be <= 1000/.test(String(err))) throw err;
        res = (await state.client!.request("chat.history", {
          sessionKey,
          limit: 1000,
        })) as HistoryRes;
      }
      // If the user changed sessions while we were in flight, drop the response
      // — a fresher loadChatHistory call is already on its way for the new key.
      if (state.sessionKey !== sessionKey) {
        console.log(`[Chat] loadChatHistory: session changed during load (${sessionKey} → ${state.sessionKey}), discarding`);
        return;
      }
      const rawMessages = Array.isArray(res.messages) ? res.messages : [];
      console.log(`[Chat] loadChatHistory: Received ${rawMessages.length} messages for "${sessionKey}"`);

      // Normalize messages at load time (like masonry-grid approach)
      // This extracts text content upfront for reliable rendering
      const normalizedMessages = rawMessages.map(normalizeMessageForRender);

      // MERGE (never replace) the store snapshot into local state. A plain
      // reassignment here — the old behaviour — deleted any local message the
      // store hadn't persisted yet (optimistic user turn, in-flight stream,
      // just-completed reply), which is exactly the "agent isn't responding /
      // messages disappear" gap. mergeChatMessages preserves those local rows
      // while letting the store resolve streaming placeholders by id.
      const existing = state.chatMessages ?? [];
      const merged = mergeChatMessages(normalizedMessages, existing);
      // Skip the reassignment when the merge result is identical to what we
      // already have. Reassigning a fresh array is itself a Lit re-render
      // trigger, which during the chatLoading=true window causes the skeleton
      // to briefly take over and "flash" the live thread on a reconnect.
      if (!sameMessageSequence(existing, merged)) {
        state.chatMessages = merged;
      }
      state.chatThinkingLevel = res.thinkingLevel ?? null;
      // Stamp which session's data is now in chatMessages so the view can
      // distinguish "session has been loaded and is genuinely empty" from
      // "session is mid-switch and the new data hasn't landed yet".
      (state as any).chatLoadedSessionKey = sessionKey;

      console.log(`[Chat] loadChatHistory: Normalized ${normalizedMessages.length} messages, first has _extractedText: ${Boolean((normalizedMessages[0] as any)?._extractedText)}`);
    } catch (err) {
      console.error('[Chat] loadChatHistory error:', err);
      state.lastError = String(err);
    } finally {
      state.chatLoading = false;
      inflightChatHistory.delete(sessionKey);
      if (typeof (state as any).requestUpdate === 'function') {
        (state as any).requestUpdate();
      }
    }
  })();
  inflightChatHistory.set(sessionKey, task);
  return task;
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], content: match[2] };
}

export type SendChatOptions = {
  attachments?: ChatAttachment[];
  /** Passive mode: add to context without triggering agent response (for video frames) */
  passive?: boolean;
  /**
   * Send through another chat-shaped RPC instead of `chat.send` (the composer's
   * CLI mode uses `chat.cli.send`). It gets the same sessionKey / message /
   * idempotencyKey plus `params`, and must answer with `chat` events like chat.send.
   */
  rpc?: { method: string; params?: Record<string, unknown> };
  /** Extra fields on the optimistic user message (e.g. the CLI-mode `cli` badge). */
  userMeta?: Record<string, unknown>;
};

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachmentsOrOpts?: ChatAttachment[] | SendChatOptions,
): Promise<boolean> {
  // Handle both old signature (attachments array) and new signature (options object)
  const opts: SendChatOptions = Array.isArray(attachmentsOrOpts)
    ? { attachments: attachmentsOrOpts }
    : (attachmentsOrOpts ?? {});
  const attachments = opts.attachments;
  const passive = opts.passive ?? false;
  if (!state.client || !state.connected) return false;
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) return false;

  const now = Date.now();
  const runId = generateUUID();

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed && !att.ocrId) return null;
          const mimeType = parsed?.mimeType ?? att.mimeType;
          const video = mimeType.startsWith("video/");
          const image = mimeType.startsWith("image/");
          const includeContent = Boolean(
            parsed && ((image && (att.size ?? 0) <= 5_000_000) || !att.ocrId),
          );
          return {
            type: video ? "video" : image ? "image" : "document",
            mimeType,
            // Images still reach vision models and videos reach the local
            // analysis pipeline. Documents already live in the OCR registry,
            // so avoid sending their base64 bytes through chat.send again.
            ...(includeContent && parsed ? { content: parsed.content } : {}),
            ...(att.fileName ? { fileName: att.fileName } : {}),
            ...(att.ocrId ? { ocrId: att.ocrId } : {}),
            ...(att.filePath ? { filePath: att.filePath } : {}),
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  // Passive mode: just send to server, don't show in UI or expect response
  // Server will broadcast the message back via chat event
  if (passive) {
    try {
      await state.client.request("chat.send", {
        sessionKey: state.sessionKey,
        message: msg,
        deliver: false,
        idempotencyKey: runId,
        attachments: apiAttachments,
        passive: true,
      });
      return true;
    } catch (err) {
      console.warn("[Chat] Passive send failed:", err);
      return false;
    }
  }

  // Normal mode: show message immediately, expect response
  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      if (att.mimeType.startsWith("video/")) {
        const who = att.analysts?.length ? ` · analysts: ${att.analysts.join(", ")}` : "";
        contentBlocks.push({ type: "text", text: `[Video attached: ${att.fileName ?? "video"}${who}]` });
        continue;
      }
      if (!att.mimeType.startsWith("image/")) {
        contentBlocks.push({
          type: "text",
          text: `[Document attached: ${att.fileName ?? "document"} · ${att.extractionStatus === "done" ? "text ready" : "extracting locally"}]`,
        });
        continue;
      }
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    stampClientMsgId({
      ...opts.userMeta,
      role: "user",
      content: contentBlocks,
      timestamp: now,
      // Correlate this optimistic turn with its run so a reconcile can match it.
      runId,
      clientMsgId: runId,
    }),
  ];

  state.chatSending = true;
  state.lastError = null;
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;
  // Track when thinking started (for elapsed time display)
  (state as any).chatThinkingStartedAt = now;
  // Arm the dropped-terminal watchdog now so a run that errors before its first
  // token (and whose terminal event is lost) still resolves the spinner.
  armChatWatchdog(state);

  try {
    if (opts.rpc) {
      await state.client.request(opts.rpc.method, {
        ...opts.rpc.params,
        sessionKey: state.sessionKey,
        message: msg,
        idempotencyKey: runId,
      });
    } else {
      await state.client.request("chat.send", {
        sessionKey: state.sessionKey,
        message: msg,
        deliver: false,
        idempotencyKey: runId,
        attachments: apiAttachments,
      });
    }
    const videos = (attachments ?? []).filter((a) => a.mimeType.startsWith("video/"));
    if (videos.length) {
      const client = state.client;
      const secure = isSecureSessionKey(state.sessionKey);
      void import("../components/video-detail").then(async (m) => {
        for (const v of videos) {
          await m
            .startAttachmentVideoAnalysis({ client, dataUrl: v.dataUrl, fileName: v.fileName, analysts: v.analysts ?? [], secure })
            .catch((err) => console.warn("[Chat] video analysis request failed:", err));
        }
      });
    }
    return true;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    (state as any).chatThinkingStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      stampClientMsgId({
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      }),
    ];
    return false;
  } finally {
    state.chatSending = false;
  }
}

/**
 * Send a video frame to the session context without triggering a response.
 * The frame will appear in chat history and be visible to the agent on next real message.
 */
export async function sendVideoFrame(
  state: ChatState,
  base64Image: string,
  mimeType: string = "image/jpeg",
): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  
  // Create a synthetic attachment
  const attachment: ChatAttachment = {
    id: generateUUID(),
    dataUrl: base64Image.startsWith("data:") ? base64Image : `data:${mimeType};base64,${base64Image}`,
    mimeType,
  };

  return sendChatMessage(state, "", { attachments: [attachment], passive: true });
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  clearChatWatchdog(state);
  if (!state.client || !state.connected) return false;
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId
        ? { sessionKey: state.sessionKey, runId }
        : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

/**
 * Append an assistant reply to the visible transcript, keeping it on screen
 * regardless of whether the authoritative history reload lands. This is the
 * safety net for the "final never commits / blank reply" bug: the streamed
 * text only ever lived in the transient `chatStream` buffer, and the post-final
 * `loadChatHistory` reload can be skipped (guarded by chatLoadedSessionKey),
 * return an empty/raced list, or error — any of which silently dropped the
 * reply. We commit optimistically here; the forced reload right after
 * reconciles against the persisted store (dedupe below prevents duplication).
 */
function commitAssistantReply(state: ChatState, text: string | null | undefined) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return;
  const msgs = Array.isArray(state.chatMessages) ? state.chatMessages : [];
  const last = msgs[msgs.length - 1] as Record<string, unknown> | undefined;
  if (last && String(last.role).toLowerCase() === "assistant") {
    const cached = (last as { _extractedText?: unknown })._extractedText;
    const lastText =
      typeof cached === "string" ? cached : extractText(last as unknown);
    if (typeof lastText === "string" && lastText.trim() === trimmed) return;
  }
  state.chatMessages = [
    ...msgs,
    stampClientMsgId(
      normalizeMessageForRender({
        role: "assistant",
        content: [{ type: "text", text: trimmed }],
        timestamp: Date.now(),
      }),
    ),
  ];
}

// Silence window after which we assume a terminal (final/error/aborted) event
// was dropped on a flaky socket and reconcile against the store so the spinner
// can't hang forever. Deltas reset the timer, so a legitimately slow run keeps
// spinning; only true silence triggers the reconciliation.
const CHAT_STREAM_WATCHDOG_MS = 45000;

function clearChatWatchdog(state: ChatState) {
  const timer = (state as { __chatStreamWatchdog?: ReturnType<typeof setTimeout> })
    .__chatStreamWatchdog;
  if (timer) {
    clearTimeout(timer);
    (state as { __chatStreamWatchdog?: ReturnType<typeof setTimeout> | null })
      .__chatStreamWatchdog = null;
  }
}

function armChatWatchdog(state: ChatState) {
  clearChatWatchdog(state);
  const runId = state.chatRunId;
  const sessionKey = state.sessionKey;
  if (!runId) return;
  (state as { __chatStreamWatchdog?: ReturnType<typeof setTimeout> }).__chatStreamWatchdog =
    setTimeout(async () => {
      // Bail if the run already resolved or the user switched away.
      if (state.chatRunId !== runId || state.sessionKey !== sessionKey) return;
      try {
        await loadChatHistory(state, { force: true });
      } catch {
        /* ignore — reconciliation is best-effort */
      }
      if (state.chatRunId !== runId || state.sessionKey !== sessionKey) return;
      const msgs = Array.isArray(state.chatMessages) ? state.chatMessages : [];
      const last = msgs[msgs.length - 1] as Record<string, unknown> | undefined;
      if (last && String(last.role).toLowerCase() === "assistant") {
        // Store already ends with the reply → the terminal event was lost.
        // Clear the stuck spinner; the reply is on screen.
        state.chatStream = null;
        state.chatRunId = null;
        state.chatStreamStartedAt = null;
        if (typeof (state as { requestUpdate?: () => void }).requestUpdate === "function") {
          (state as { requestUpdate?: () => void }).requestUpdate!();
        }
      } else {
        // Still genuinely running (slow tool call / long think) — keep watching.
        armChatWatchdog(state);
      }
    }, CHAT_STREAM_WATCHDOG_MS);
}

export function handleChatEvent(
  state: ChatState,
  payload?: ChatEventPayload,
) {
  if (!payload) return null;
  if (payload.sessionKey !== state.sessionKey) return null;

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/MrYungCEO/infinibot-os/issues/1909
  if (
    payload.runId &&
    state.chatRunId &&
    payload.runId !== state.chatRunId
  ) {
    if (payload.state === "final") return "final";
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
    // Every token resets the dropped-terminal watchdog.
    armChatWatchdog(state);
  } else if (payload.state === "final") {
    clearChatWatchdog(state);
    // Commit the reply before clearing the transient stream buffer so it stays
    // visible even if the forced history reload no-ops/errors. loadChatHistory
    // (forced, from app-gateway) reconciles right after — no duplication.
    commitAssistantReply(state, extractText(payload.message) || state.chatStream || "");
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    clearChatWatchdog(state);
    // Keep whatever streamed before the stop so the partial reply doesn't vanish.
    commitAssistantReply(state, state.chatStream || "");
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    clearChatWatchdog(state);
    // Preserve any text streamed before the error, then surface the error as a
    // visible assistant note (server-side stream errors never hit sendChatMessage's
    // catch, so without this the partial reply and the error both vanished).
    commitAssistantReply(state, state.chatStream || "");
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    const errorText = formatChatErrorText(payload);
    state.lastError = errorText.replace(/^\S+\s/, "");
    commitAssistantReply(state, errorText);
  }
  return payload.state;
}

/**
 * Agent `notice` events (stream "notice", kind "model_fallback"): the turn
 * healed onto another model because the configured one is unavailable. Shown
 * once per session as an inline note after the reply. Returns true when handled.
 */
export function handleChatNotice(state: ChatState, payload: unknown): boolean {
  const notice = parseModelFallbackNotice(payload);
  if (!notice) return false;
  if (notice.sessionKey && notice.sessionKey !== state.sessionKey) return false;
  commitAssistantReply(state, formatModelFallbackNotice(notice));
  return true;
}
