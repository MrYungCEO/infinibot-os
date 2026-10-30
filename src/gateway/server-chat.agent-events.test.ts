import { describe, expect, it, vi } from "vitest";

import { createAgentEventHandler, createChatRunState } from "./server-chat.js";

describe("agent event handler", () => {
  it("emits chat delta for assistant text-only events", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy.mockRestore();
  });
});

describe("agent event handler — pre-reply failures", () => {
  it("maps a lifecycle error (no start, no text) to a chat error with code + hint", () => {
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-err", {
      sessionKey: "agent:main:main",
      clientRunId: "client-err",
    });
    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq: new Map(),
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-err",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: {
        phase: "error",
        error: "Model ollama-cloud/kimi-k2.5 isn't available",
        errorCode: "model_unavailable",
        errorHint: "Switch model",
      },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.[1]).toMatchObject({
      runId: "client-err",
      sessionKey: "agent:main:main",
      state: "error",
      errorMessage: "Model ollama-cloud/kimi-k2.5 isn't available",
      errorCode: "model_unavailable",
      errorHint: "Switch model",
    });
  });
});

describe("agent event handler — tool activity for non-verbose sessions", () => {
  it("sends a name-only tool_status ping instead of the full tool event", async () => {
    const { registerAgentRunContext, clearAgentRunContext } = await import("../infra/agent-events.js");
    registerAgentRunContext("run-quiet", { sessionKey: "agent:main:main", verboseLevel: "off" });
    const broadcast = vi.fn();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-quiet", { sessionKey: "agent:main:main", clientRunId: "client-quiet" });
    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession: vi.fn(),
      agentRunSeq: new Map(),
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });
    const tool = (seq: number, data: Record<string, unknown>) =>
      handler({ runId: "run-quiet", seq, stream: "tool", ts: 5, data });
    tool(1, { phase: "start", name: "flypic_generate_image", toolCallId: "tc1", args: { prompt: "secret" } });
    tool(2, { phase: "update", name: "flypic_generate_image", toolCallId: "tc1", partialResult: "x" });
    tool(3, { phase: "result", name: "flypic_generate_image", toolCallId: "tc1", result: { big: true }, isError: false });

    const agentCalls = broadcast.mock.calls.filter(([event]) => event === "agent").map(([, p]) => p);
    expect(agentCalls).toEqual([
      { runId: "run-quiet", seq: 1, stream: "tool_status", ts: 5, sessionKey: "agent:main:main", data: { phase: "start", name: "flypic_generate_image", toolCallId: "tc1" } },
      { runId: "run-quiet", seq: 3, stream: "tool_status", ts: 5, sessionKey: "agent:main:main", data: { phase: "result", name: "flypic_generate_image", toolCallId: "tc1", isError: false } },
    ]);
    expect(agentCalls.some((p) => (p as { stream?: string }).stream === "tool")).toBe(false);
    clearAgentRunContext("run-quiet");
  });
});
