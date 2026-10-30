import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it } from "vitest";

import type { AnyAgentTool } from "../../agents/tools/common.js";
import { clearAcksForTests } from "./voice-ack.js";
import {
  runFastVoiceTurn,
  type FastModelHandle,
  type FastStreamEvent,
  type FastTurnDeps,
} from "./voice-fast-turn.js";
import {
  bindableSessionKey,
  runGatewayVoiceTurn,
  voiceCallSessionKey,
  type GatewayTurnDeps,
  type VoiceLlmTurnRequest,
} from "./voice-llm-turn.js";
import {
  busyBackground,
  clearBackgroundForTests,
  isCancelUtterance,
  takeFinished,
} from "./voice-pending.js";
import { clearVoiceRoutesForTests } from "./voice-route.js";
import { executeVoiceToolCalls } from "./voice-tools.js";

beforeEach(() => {
  clearVoiceRoutesForTests();
  clearBackgroundForTests();
  clearAcksForTests();
});

const handle = {
  ref: "fake/voice",
  model: { id: "voice", provider: "fake", api: "openai-completions" },
  apiKey: "k",
} as unknown as FastModelHandle;

const owner = (over: Partial<VoiceLlmTurnRequest> = {}): VoiceLlmTurnRequest => ({
  agentId: "main",
  backend: "gateway",
  mode: "auto",
  message: "what's on my board?",
  callKey: "loc-1:room",
  provider: "robovoice",
  callerIsOwner: true,
  onDelta: () => {},
  ...over,
});

function tool(name: string, run: (args: unknown) => Promise<string> | string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    execute: async (_id: string, args: unknown) => ({
      content: [{ type: "text", text: await run(args) }],
      details: {},
    }),
  } as unknown as AnyAgentTool;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A scripted fast model: one list of events per round; records the context of each round. */
function scripted(
  rounds: FastStreamEvent[][],
  seen: Array<{ roles: string[]; tools: string[]; system: string }> = [],
) {
  const queue = [...rounds];
  return async function* (
    _h: FastModelHandle,
    context: Parameters<NonNullable<FastTurnDeps["stream"]>>[1],
  ) {
    seen.push({
      roles: context.messages.map((m) => m.role),
      tools: (context.tools ?? []).map((t) => t.name),
      system: context.systemPrompt ?? "",
    });
    for (const ev of queue.shift() ?? []) yield ev;
  };
}

const noAgent: GatewayTurnDeps = {
  onAgentEvent: () => () => {},
  runAgent: async () => {
    throw new Error("the full agent must not run");
  },
};

describe("voice tool agent (fast step with tools)", () => {
  it("answers a work request with one tool round, no full agent, no filler when the tool is fast", async () => {
    const seen: Array<{ roles: string[]; tools: string[]; system: string }> = [];
    const r = await runFastVoiceTurn(owner(), {
      resolveModel: async () => handle,
      persona: () => "",
      gateway: noAgent,
      ackDelayMs: 200,
      tools: async () => [tool("kanban", () => "2 open tasks: ship voice, fix billing")],
      stream: scripted(
        [
          [
            {
              type: "toolcall",
              call: { type: "toolCall", id: "c1", name: "kanban", arguments: {} },
            },
          ],
          [{ type: "text", delta: "You have two open tasks: ship voice and fix billing." }],
        ],
        seen,
      ),
    });
    expect(r.text).toBe("You have two open tasks: ship voice and fix billing.");
    expect(r.timings).toMatchObject({ path: "fast", toolCalls: ["kanban"] });
    expect(seen[0].tools).toEqual(["kanban", "delegate_to_main", "handoff_to_agent"]);
    expect(seen[0].system).toContain("call your tools directly");
    expect(seen[1].roles.slice(-2)).toEqual(["assistant", "toolResult"]);
  });

  it("speaks a varied acknowledgement only when the tool is slower than the ack delay, never the canned line", async () => {
    const deltas: string[] = [];
    const r = await runFastVoiceTurn(owner({ onDelta: (t) => deltas.push(t) }), {
      resolveModel: async () => handle,
      persona: () => "",
      gateway: noAgent,
      ackDelayMs: 10,
      tools: async () => [tool("web_search", async () => (await sleep(80), "Sunny, 24 degrees"))],
      stream: scripted([
        [
          { type: "text", delta: "One moment, let me check." },
          {
            type: "toolcall",
            call: { type: "toolCall", id: "c1", name: "web_search", arguments: {} },
          },
        ],
        [{ type: "text", delta: "It's sunny and twenty four degrees." }],
      ]),
    });
    expect(r.text).not.toMatch(/one moment/i);
    expect(r.text).toMatch(/^\S.*\. It's sunny and twenty four degrees\.$/);
    expect(deltas.join("")).toBe(r.text);
  });

  it("runs independent tool calls in parallel", async () => {
    // Overlap, not wall time (a loaded machine stretches timers): every call
    // starts before any of them finishes.
    let finished = 0;
    const startedBeforeAnyFinished: string[] = [];
    const slow = (name: string) =>
      tool(name, async () => {
        if (finished === 0) startedBeforeAnyFinished.push(name);
        await sleep(60);
        finished += 1;
        return `${name} ok`;
      });
    const results = await executeVoiceToolCalls(
      [
        { type: "toolCall", id: "a", name: "kanban", arguments: {} },
        { type: "toolCall", id: "b", name: "notes", arguments: {} },
        { type: "toolCall", id: "c", name: "calendar", arguments: {} },
      ],
      [slow("kanban"), slow("notes"), slow("calendar")],
    );
    expect(results.map((r) => r.text)).toEqual(["kanban ok", "notes ok", "calendar ok"]);
    expect(startedBeforeAnyFinished.sort()).toEqual(["calendar", "kanban", "notes"]);
  });

  it("a tool past its timeout keeps running in the background and is reported on the next turn", async () => {
    const r = await runFastVoiceTurn(owner({ message: "search my notes for the launch date" }), {
      resolveModel: async () => handle,
      persona: () => "",
      gateway: noAgent,
      ackDelayMs: 1000,
      toolTimeoutMs: 20,
      tools: async () => [tool("notes", async () => (await sleep(60), "Launch is on October 20"))],
      stream: scripted([
        [
          {
            type: "toolcall",
            call: { type: "toolCall", id: "c1", name: "notes", arguments: {} },
          },
        ],
        [{ type: "text", delta: "Still digging on that, I'll tell you as soon as I have it." }],
      ]),
    });
    expect(r.text).toMatch(/I'll tell you/);
    const key = voiceCallSessionKey(owner());
    expect(busyBackground(key)).toHaveLength(1);
    await sleep(80);
    const seen: Array<{ roles: string[]; tools: string[]; system: string }> = [];
    await runFastVoiceTurn(owner({ message: "hello again" }), {
      resolveModel: async () => handle,
      persona: () => "",
      gateway: noAgent,
      tools: async () => [],
      stream: scripted(
        [[{ type: "text", delta: "Quick update: the launch is on October twentieth." }]],
        seen,
      ),
    });
    expect(seen[0].system).toContain("Background work of this call finished");
    expect(seen[0].system).toContain("Launch is on October 20");
    expect(takeFinished(key)).toEqual([]);
  });

  it("guests never get tools (the full agent applies guest rules)", async () => {
    let toolsAsked = false;
    const seen: Array<{ roles: string[]; tools: string[]; system: string }> = [];
    await runFastVoiceTurn(
      owner({ callerIsOwner: false, message: "the thing from yesterday, you know the one" }),
      {
        resolveModel: async () => handle,
        persona: () => "",
        tools: async () => {
          toolsAsked = true;
          return [tool("kanban", () => "x")];
        },
        stream: scripted(
          [[{ type: "text", delta: "Sure thing, happy to chat about anything you like today." }]],
          seen,
        ),
      },
    );
    expect(toolsAsked).toBe(false);
    expect(seen[0].tools).toEqual(["handoff_to_agent"]);
  });
});

describe("background work + barge-in", () => {
  /** A full agent that starts a tool, then answers after `ms`. */
  function workingAgent(ms: number, answer: string) {
    let listener:
      | ((evt: { runId?: string; stream?: string; data?: Record<string, unknown> }) => void)
      | null = null;
    const state = { aborted: false, finished: false };
    const deps: GatewayTurnDeps = {
      onAgentEvent: (l) => {
        listener = l;
        return () => (listener = null);
      },
      runAgent: async (o) => {
        o.abortSignal?.addEventListener("abort", () => (state.aborted = true));
        listener?.({ runId: o.runId, stream: "lifecycle", data: { phase: "start" } });
        listener?.({
          runId: o.runId,
          stream: "tool",
          data: { phase: "start", name: "sessions_spawn" },
        });
        await sleep(ms);
        state.finished = true;
        return { payloads: [{ text: answer }] };
      },
    };
    return { deps, state };
  }

  it("barge-in during in-flight tool work detaches it instead of killing it; the result comes back next turn", async () => {
    const abort = new AbortController();
    const { deps, state } = workingAgent(60, "The report is ready.");
    const req = owner({ mode: "agent", message: "build the weekly report", signal: abort.signal });
    const turn = runGatewayVoiceTurn(req, deps, { emptyFallback: "" });
    await sleep(10);
    abort.abort(); // the caller talks over the work
    await expect(turn).rejects.toMatchObject({ code: "aborted" });
    expect(state.aborted).toBe(false);
    await sleep(80);
    expect(state.finished).toBe(true);
    const done = takeFinished(voiceCallSessionKey(req));
    expect(done.map((d) => d.result)).toEqual(["The report is ready."]);
  });

  it("past the speaking budget the turn says so and the work continues in the background", async () => {
    const { deps, state } = workingAgent(80, "All three sites load.");
    const req = owner({ mode: "agent", message: "check all three purchase flows" });
    const r = await runGatewayVoiceTurn(req, deps, { speakBudgetMs: 20 });
    expect(r.text).toMatch(/keep working on it/);
    expect(r.timings?.detached).toBe(true);
    expect(busyBackground(voiceCallSessionKey(req))).toHaveLength(1);
    await sleep(100);
    expect(state.finished).toBe(true);
    expect(takeFinished(voiceCallSessionKey(req))[0]?.result).toBe("All three sites load.");
  });

  it('"stop" aborts background work of the call', async () => {
    const { deps, state } = workingAgent(200, "late");
    const req = owner({ mode: "agent", message: "research competitors" });
    await runGatewayVoiceTurn(req, deps, { speakBudgetMs: 10 });
    expect(isCancelUtterance("Okay stop that")).toBe(true);
    expect(isCancelUtterance("never mind")).toBe(true);
    expect(isCancelUtterance("stop by the store later and buy milk")).toBe(false);
    const r = await runFastVoiceTurn(owner({ message: "never mind" }), {
      resolveModel: async () => handle,
      tools: async () => [],
    });
    expect(r.text).toBe("Okay, I stopped that.");
    expect(state.aborted).toBe(true);
  });
});

describe("calls bound to a chat session", () => {
  it("the owner's call runs on the chat session it was started from", () => {
    expect(voiceCallSessionKey(owner({ sessionKey: "agent:main:webchat:abc" }))).toBe(
      "agent:main:webchat:abc",
    );
    expect(bindableSessionKey(owner({ sessionKey: "agent:main:main" }))).toBe("agent:main:main");
  });

  it("guests, other agents' sessions and voicecall/sub-agent keys are never bound", () => {
    expect(
      voiceCallSessionKey(owner({ callerIsOwner: false, sessionKey: "agent:main:webchat:abc" })),
    ).toMatch(/:voicecall:/);
    expect(bindableSessionKey(owner({ sessionKey: "agent:other:webchat:abc" }))).toBeUndefined();
    expect(
      bindableSessionKey(owner({ sessionKey: "agent:main:voicecall-owner:robovoice:x" })),
    ).toBeUndefined();
    expect(bindableSessionKey(owner({ sessionKey: "agent:main:subagent:123" }))).toBeUndefined();
  });

  it("a full-agent turn of a bound call runs the agent on that session key", async () => {
    const keys: string[] = [];
    const deps: GatewayTurnDeps = {
      onAgentEvent: () => () => {},
      runAgent: async (o) => {
        keys.push(o.sessionKey);
        return { payloads: [{ text: "Done." }] };
      },
    };
    await runGatewayVoiceTurn(owner({ mode: "agent", sessionKey: "agent:main:webchat:abc" }), deps);
    expect(keys).toEqual(["agent:main:webchat:abc"]);
  });
});
