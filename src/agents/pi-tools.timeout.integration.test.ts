/**
 * Integration: the real pi-agent-core Agent loop with a scripted model that
 * makes the CMO's two parallel calls (kanban list_projects + web_fetch) in one
 * turn — the shape of the live wedge on 2026-10-26. The first tool hangs
 * forever and ignores its signal. With the runner's wrappers the turn must
 * still finish: kanban gets a timeout error result, web_fetch still runs, the
 * model gets a follow-up call and answers. A run abort must also end the turn
 * promptly instead of waiting on the hung tool.
 */
import { Agent } from "@mariozechner/pi-agent-core";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import { wrapToolWithExecutionTimeout } from "./pi-tools.timeout.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { wrapToolWithResultCap } from "./tool-result-cap.js";

const model = {
  id: "huihui_ai/Qwen3.8-abliterated:latest",
  name: "Qwen3.8 (test)",
  api: "openai-completions",
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 2048,
} as const;

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: unknown[], stopReason: "toolUse" | "stop") {
  return {
    role: "assistant" as const,
    content,
    stopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    timestamp: Date.now(),
  };
}

/** Turn 1: two parallel tool calls. Turn 2+: a plain answer. */
function scriptedStreamFn(calls: { count: number }) {
  return () => {
    calls.count += 1;
    const stream = new AssistantMessageEventStream();
    const message =
      calls.count === 1
        ? assistant(
            [
              {
                type: "toolCall",
                id: "call_n6ixsy2k",
                name: "kanban",
                arguments: { action: "list_projects", query: "infinibot" },
              },
              {
                type: "toolCall",
                id: "call_m4ivqyex",
                name: "web_fetch",
                arguments: { url: "https://infinibotos.com" },
              },
            ],
            "toolUse",
          )
        : assistant(
            [{ type: "text", text: "Kanban is unavailable; here is the site summary." }],
            "stop",
          );
    queueMicrotask(() => {
      stream.push({ type: "done", reason: message.stopReason, message } as never);
      stream.end();
    });
    return stream;
  };
}

function tool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute,
  };
}

/** Same wrapper order as createInfiniBotCodingTools: abort → timeout → cap. */
function runnerWrapped(tools: AnyAgentTool[], runAbort: AbortSignal, timeoutMs: number) {
  return tools
    .map((t) => wrapToolWithAbortSignal(t, runAbort))
    .map((t) => wrapToolWithExecutionTimeout(t, { timeoutMs }))
    .map((t) => wrapToolWithResultCap(t));
}

function makeTools(state: { webFetchRan: boolean }) {
  return [
    tool("kanban", async () => await new Promise<never>(() => {})),
    tool("web_fetch", async () => {
      state.webFetchRan = true;
      return { content: [{ type: "text", text: "InfiniBot — your AI OS" }], details: {} };
    }),
  ];
}

describe("embedded tool pipeline with a hung tool (integration)", () => {
  it("finishes the turn: hung kanban → timeout result, web_fetch still runs, model answers", async () => {
    const calls = { count: 0 };
    const state = { webFetchRan: false };
    const runAbort = new AbortController();
    const agent = new Agent({
      initialState: {
        systemPrompt: "test",
        model: model as never,
        tools: runnerWrapped(makeTools(state), runAbort.signal, 150) as never,
      },
      streamFn: scriptedStreamFn(calls) as never,
    });

    const t0 = Date.now();
    await agent.prompt("Check kanban and the website in parallel");
    expect(Date.now() - t0).toBeLessThan(5_000);

    const results = agent.state.messages.filter((m) => m.role === "toolResult") as Array<{
      toolName: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(results.map((r) => r.toolName)).toEqual(["kanban", "web_fetch"]);
    expect(results[0].content[0].text).toMatch(/tool kanban timed out/);
    expect(state.webFetchRan).toBe(true);
    // The loop went back to the model with both results and got an answer.
    expect(calls.count).toBe(2);
    const last = agent.state.messages.at(-1) as { role: string; content: Array<{ text?: string }> };
    expect(last.role).toBe("assistant");
    expect(last.content[0].text).toMatch(/Kanban is unavailable/);
    expect(agent.state.isStreaming).toBe(false);
  });

  it("an aborted run releases promptly even though kanban never returns", async () => {
    const calls = { count: 0 };
    const state = { webFetchRan: false };
    const runAbort = new AbortController();
    const agent = new Agent({
      initialState: {
        systemPrompt: "test",
        model: model as never,
        // Deadline far away: only the abort can end this turn.
        tools: runnerWrapped(makeTools(state), runAbort.signal, 600_000) as never,
      },
      streamFn: scriptedStreamFn(calls) as never,
    });
    agent.subscribe((evt) => {
      if (evt.type === "tool_execution_start" && evt.toolName === "kanban") {
        setTimeout(() => {
          runAbort.abort();
          agent.abort();
        }, 30);
      }
    });

    const t0 = Date.now();
    await agent.prompt("Check kanban and the website in parallel");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(agent.state.isStreaming).toBe(false);
    const kanban = agent.state.messages.find(
      (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "kanban",
    ) as { isError: boolean; content: Array<{ text?: string }> } | undefined;
    expect(kanban?.isError).toBe(true);
    expect(kanban?.content[0].text).toMatch(/Aborted/);
  });
});
