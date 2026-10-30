import { describe, expect, it } from "vitest";

import {
    handleChatEvent,
    handleChatNotice,
    loadChatHistory,
    type ChatEventPayload,
    type ChatState,
} from "./chat";

function textOf(msg: unknown): string {
  const m = msg as Record<string, unknown>;
  const cached = (m as { _extractedText?: unknown })._extractedText;
  if (typeof cached === "string") return cached;
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p?.type === "text" ? p.text : ""))
      .join("");
  }
  return "";
}

/** Minimal fake gateway client that returns a canned chat.history snapshot. */
function fakeClient(snapshot: unknown[]) {
  return {
    request: async (method: string) => {
      if (method === "chat.history") return { messages: snapshot };
      return {};
    },
  } as unknown as ChatState["client"];
}

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    client: null,
    connected: true,
    sessionKey: "main",
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatSending: false,
    chatMessage: "",
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("handleChatEvent", () => {
  it("returns null when payload is missing", () => {
    const state = createState();
    expect(handleChatEvent(state, undefined)).toBe(null);
  });

  it("returns null when sessionKey does not match", () => {
    const state = createState({ sessionKey: "main" });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe(null);
  });

  it("returns null for delta from another run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Hello");
  });

  it("returns 'final' for final from another run (e.g. sub-agent announce) without clearing state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sub-agent findings" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
  });

  it("MERGE reconcile never deletes local in-flight messages (regression)", async () => {
    // Local transcript: an optimistic user turn + a just-streamed assistant
    // reply, neither persisted yet.
    const userMsg = {
      role: "user",
      clientMsgId: "u-1",
      content: [{ type: "text", text: "hey there" }],
      timestamp: 2000,
    };
    const streamingAssistantMsg = {
      role: "assistant",
      clientMsgId: "a-1",
      content: [{ type: "text", text: "on it, working..." }],
      timestamp: 2001,
    };
    // Store returns an OLDER snapshot that predates both — this is the racing
    // reconcile that used to REPLACE and wipe them.
    const olderStoreMsg = {
      role: "assistant",
      id: "srv-old",
      content: [{ type: "text", text: "previous answer" }],
      timestamp: 1000,
    };
    const state = createState({
      sessionKey: "main",
      client: fakeClient([olderStoreMsg]),
      chatMessages: [userMsg, streamingAssistantMsg],
    });

    await loadChatHistory(state, { force: true });

    const texts = state.chatMessages.map(textOf);
    // Store row applied AND both local rows preserved (not deleted).
    expect(texts).toContain("previous answer");
    expect(texts).toContain("hey there");
    expect(texts).toContain("on it, working...");
    expect(state.chatMessages.length).toBe(3);
    // Time-ordered: older store row first.
    expect(textOf(state.chatMessages[0])).toBe("previous answer");
  });

  it("MERGE applies store updates by id and does not duplicate (regression)", async () => {
    // A streaming placeholder that the store now returns (same id) with its
    // final persisted content — the store version should win, no duplicate.
    const placeholder = {
      role: "assistant",
      id: "srv-1",
      content: [{ type: "text", text: "partial..." }],
      timestamp: 3000,
    };
    const persisted = {
      role: "assistant",
      id: "srv-1",
      content: [{ type: "text", text: "final complete answer" }],
      timestamp: 3000,
    };
    const state = createState({
      sessionKey: "main",
      client: fakeClient([persisted]),
      chatMessages: [placeholder],
    });

    await loadChatHistory(state, { force: true });

    expect(state.chatMessages.length).toBe(1);
    expect(textOf(state.chatMessages[0])).toBe("final complete answer");
  });

  it("MERGE dedupes a locally-committed reply persisted under a new id", async () => {
    // Optimistic user turn (no store id) + assistant reply committed locally.
    const userMsg = {
      role: "user",
      clientMsgId: "u-9",
      content: [{ type: "text", text: "question" }],
      timestamp: 4000,
    };
    const localReply = {
      role: "assistant",
      clientMsgId: "a-9",
      content: [{ type: "text", text: "the answer" }],
      timestamp: 4001,
    };
    // Store has caught up: both turns persisted under server ids.
    const storeUser = {
      role: "user",
      id: "srv-u",
      content: [{ type: "text", text: "question" }],
      timestamp: 4000,
    };
    const storeReply = {
      role: "assistant",
      id: "srv-a",
      content: [{ type: "text", text: "the answer" }],
      timestamp: 4001,
    };
    const state = createState({
      sessionKey: "main",
      client: fakeClient([storeUser, storeReply]),
      chatMessages: [userMsg, localReply],
    });

    await loadChatHistory(state, { force: true });

    // No duplicates — content-level dedupe collapses local copies into store.
    expect(state.chatMessages.length).toBe(2);
    expect(state.chatMessages.map(textOf)).toEqual(["question", "the answer"]);
  });

  it("processes final from own run and clears state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });
});

describe("pre-reply failures + model-heal notices", () => {
  it("renders an error bubble with reason and hint, clears the spinner", async () => {
    const state = createState({
      sessionKey: "agent:main:main",
      chatRunId: "run-1",
      chatStream: null,
      client: fakeClient([{ role: "user", content: "hi", timestamp: 1 }]),
    });
    const result = handleChatEvent(state, {
      runId: "run-1",
      sessionKey: "agent:main:main",
      state: "error",
      errorMessage: "Model ollama-cloud/kimi-k2.5 isn't available",
      errorCode: "model_unavailable",
      errorHint: "Switch model: pick another one in the chat's model picker.",
    });
    expect(result).toBe("error");
    expect(state.chatRunId).toBe(null);
    const last = state.chatMessages[state.chatMessages.length - 1];
    expect(textOf(last)).toBe(
      "⚠️ Model ollama-cloud/kimi-k2.5 isn't available\n\nSwitch model: pick another one in the chat's model picker.",
    );
    // The forced history reload that follows must not wipe the local bubble.
    await loadChatHistory(state, { force: true });
    expect(state.chatMessages.some((m) => textOf(m).includes("isn't available"))).toBe(true);
  });

  it("adds a default model hint when only the code is present", () => {
    const state = createState({ sessionKey: "s", chatRunId: "r" });
    handleChatEvent(state, {
      runId: "r",
      sessionKey: "s",
      state: "error",
      errorMessage: "Unknown model: a/b",
      errorCode: "model_unavailable",
    });
    expect(textOf(state.chatMessages[0])).toMatch(/model picker/);
  });

  it("appends the model fallback notice for its own session only", () => {
    const state = createState({ sessionKey: "agent:main:main" });
    const notice = {
      runId: "r",
      stream: "notice",
      sessionKey: "agent:main:main",
      data: {
        kind: "model_fallback",
        from: "ollama-cloud/kimi-k2.5",
        to: "ollama-cloud/gpt-oss:120b",
        message: "model ollama-cloud/kimi-k2.5 unavailable (retired?) — using ollama-cloud/gpt-oss:120b",
      },
    };
    expect(handleChatNotice(state, { ...notice, sessionKey: "other" })).toBe(false);
    expect(handleChatNotice(state, { runId: "r", stream: "tool", data: {} })).toBe(false);
    expect(handleChatNotice(state, notice)).toBe(true);
    expect(textOf(state.chatMessages[0])).toContain("ollama-cloud/gpt-oss:120b");
    expect(textOf(state.chatMessages[0])).toContain("ollama-cloud/kimi-k2.5");
  });
});
