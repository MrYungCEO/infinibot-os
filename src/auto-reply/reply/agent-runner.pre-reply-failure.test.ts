import { afterEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { resetModelHealedNoticesForTest } from "../../agents/turn-failure.js";
import { onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const fallbackMock = vi.hoisted(() => ({ impl: null as null | ((p: any) => Promise<unknown>) }));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => fallbackMock.impl!(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

function createBaseRun(params: { runOverrides?: Partial<FollowupRun["run"]> }) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "telegram",
    OriginatingTo: "chat",
    AccountId: "primary",
    MessageSid: "msg",
    Surface: "telegram",
  } as unknown as TemplateContext;

  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;

  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "telegram",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude-opus",
      authProfileId: "anthropic:clawd",
      authProfileIdSource: "manual",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 5_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  return {
    typing,
    sessionCtx,
    resolvedQueue,
    followupRun: {
      ...followupRun,
      run: { ...followupRun.run, ...params.runOverrides },
    },
  };
}

async function runTurn(runId: string) {
  const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
    runOverrides: { provider: "ollama-cloud", model: "kimi-k2.5", authProfileId: undefined },
  });
  const sessionKey = "agent:main:main";
  const sessionEntry = {
    sessionId: "session",
    updatedAt: Date.now(),
    totalTokens: 1,
    compactionCount: 0,
  };
  return await runReplyAgent({
    commandBody: "hello",
    followupRun: { ...followupRun, run: { ...followupRun.run, sessionKey } },
    queueKey: sessionKey,
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing,
    sessionCtx,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    storePath: undefined,
    defaultModel: "ollama-cloud/kimi-k2.5",
    agentCfgContextTokens: 100_000,
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    opts: { runId },
  } as Parameters<typeof runReplyAgent>[0]);
}

function captureEvents() {
  const events: AgentEventPayload[] = [];
  const stop = onAgentEvent((evt) => events.push(evt));
  return { events, stop };
}

afterEach(() => {
  runEmbeddedPiAgentMock.mockReset();
  resetModelHealedNoticesForTest();
});

describe("pre-reply failures surface a terminal error", () => {
  it("emits lifecycle error (model_unavailable + hint) when the turn dies before the runner starts", async () => {
    fallbackMock.impl = async () => {
      throw new FailoverError(
        "Unknown model: ollama-cloud/kimi-k2.5 (not in the provider's model catalog — retired upstream?)",
        { reason: "model_not_found", provider: "ollama-cloud", model: "kimi-k2.5" },
      );
    };
    const { events, stop } = captureEvents();
    const reply = await runTurn("run-pre-reply-fail");
    stop();

    const lifecycle = events.filter(
      (e) => e.runId === "run-pre-reply-fail" && e.stream === "lifecycle",
    );
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]?.data).toMatchObject({
      phase: "error",
      errorCode: "model_unavailable",
    });
    expect(String(lifecycle[0]?.data.error)).toContain("ollama-cloud/kimi-k2.5");
    expect(String(lifecycle[0]?.data.errorHint)).toMatch(/model picker/);
    // Channels (Telegram etc.) still get a readable text reply with the hint.
    const text = JSON.stringify(reply);
    expect(text).toContain("was not found by its provider");
    expect(text).toContain("Switch model");
  });

  it("does not emit a second terminal event when the runner already ended the lifecycle", async () => {
    fallbackMock.impl = async ({ run }: any) => run("ollama-cloud", "gpt-oss:120b");
    runEmbeddedPiAgentMock.mockImplementation(async (params: { runId: string }) => {
      const { emitAgentEvent } = await import("../../infra/agent-events.js");
      emitAgentEvent({ runId: params.runId, stream: "lifecycle", data: { phase: "start" } });
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: { phase: "error", error: "boom" },
      });
      throw new Error("boom after start");
    });
    const { events, stop } = captureEvents();
    await runTurn("run-post-start-fail");
    stop();
    const errors = events.filter(
      (e) =>
        e.runId === "run-post-start-fail" && e.stream === "lifecycle" && e.data.phase === "error",
    );
    expect(errors).toHaveLength(1);
  });

  it("emits the model-heal notice once per session", async () => {
    fallbackMock.impl = async ({ run, onModelHealed }: any) => {
      const result = await run("ollama-cloud", "gpt-oss:120b");
      await onModelHealed?.({
        from: "ollama-cloud/kimi-k2.5",
        to: "ollama-cloud/gpt-oss:120b",
        message:
          "model ollama-cloud/kimi-k2.5 unavailable (retired?) — using ollama-cloud/gpt-oss:120b",
      });
      return { result, provider: "ollama-cloud", model: "gpt-oss:120b", attempts: [] };
    };
    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [{ text: "hi" }], meta: {} });
    const { events, stop } = captureEvents();
    await runTurn("run-heal-1");
    await runTurn("run-heal-2");
    stop();
    const notices = events.filter((e) => e.stream === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      runId: "run-heal-1",
      sessionKey: "agent:main:main",
      data: {
        kind: "model_fallback",
        from: "ollama-cloud/kimi-k2.5",
        to: "ollama-cloud/gpt-oss:120b",
      },
    });
  });
});
