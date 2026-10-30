/**
 * End-to-end reliability test for the autonomy stack — drives
 * runOrchestratorTurn() through the five scenarios called out in
 * docs/hermes-reliability-audit.md → Phase 3:
 *
 *   1. Happy path
 *   2. Transient ECONNRESET on the planning call → retry succeeds
 *   3. Non-retryable spawn-param error → iteration fails without retry
 *      and without ever round-tripping the gateway
 *   4. Malformed planner JSON → single repair retry kicks in
 *      (sub-scenarios: repair succeeds; repair also fails)
 *   5. Tool call exceeds MAX_PARALLEL → cap enforced, clear error
 *
 * Plus a 6th: wallclock cap short-circuits before any model call.
 *
 * Everything below the runOrchestratorTurn entrypoint is mocked at the
 * pi-ai / gateway / subagent-registry / model-auth boundary so the test
 * is deterministic and runs in ~1s.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  runOrchestratorTurn,
  tryParsePlanResponse,
  type OrchestratorTurnInput,
} from "./goal-orchestrator.js";

// ─── Mocks ────────────────────────────────────────────────────────────────

const completeMock = vi.fn();
vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return { ...mod, complete: (...args: unknown[]) => completeMock(...args) };
});

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

const setSubagentLineageMock = vi.fn();
const listSubagentRunsByGoalIdMock = vi.fn();
vi.mock("../agents/subagent-registry.js", () => ({
  setSubagentLineage: (...args: unknown[]) => setSubagentLineageMock(...args),
  listSubagentRunsByGoalId: (...args: unknown[]) => listSubagentRunsByGoalIdMock(...args),
  getSubagentRun: vi.fn(),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn().mockReturnValue({
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    authStorage: { setRuntimeApiKey: vi.fn() },
    error: undefined,
  }),
}));

vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn().mockResolvedValue({ apiKey: "test-key", mode: "api" }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

function asAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function plan(reasoning: string, toolCalls: unknown[]): string {
  return JSON.stringify({ reasoning, tool_calls: toolCalls });
}

function baseInput(overrides: Partial<OrchestratorTurnInput> = {}): OrchestratorTurnInput {
  return {
    goalText: "ship the thing",
    priorIterations: [],
    budget: { maxTurns: 5, turnsUsed: 0 },
    goalId: "goal_test_1",
    iterationIndex: 1,
    priorityMode: "production-reliability",
    ...overrides,
  };
}

beforeEach(() => {
  completeMock.mockReset();
  callGatewayMock.mockReset();
  setSubagentLineageMock.mockReset();
  listSubagentRunsByGoalIdMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Sanity: parser used by repair path ──────────────────────────────────

describe("tryParsePlanResponse", () => {
  it("returns null on completely non-JSON input", () => {
    expect(tryParsePlanResponse("here is a paragraph about the weather")).toBeNull();
  });
  it("returns null on broken JSON", () => {
    expect(tryParsePlanResponse('{"reasoning": "hi", "tool_calls": [')).toBeNull();
  });
  it("parses a fenced JSON block", () => {
    const parsed = tryParsePlanResponse(
      "```json\n" + plan("ok", [{ tool: "list_my_subagents" }]) + "\n```",
    );
    expect(parsed?.toolCalls).toHaveLength(1);
    expect(parsed?.toolCalls[0]?.tool).toBe("list_my_subagents");
  });
});

// ─── Scenario 1: happy path ──────────────────────────────────────────────

describe("scenario 1: happy path", () => {
  it("plans → spawns → syntheses with no errors", async () => {
    completeMock
      // planning call
      .mockResolvedValueOnce(
        asAssistantMessage(
          plan("spawn one worker", [
            { tool: "spawn_subagent", label: "do thing", task: "Do the thing." },
          ]),
        ),
      )
      // synthesis call
      .mockResolvedValueOnce(asAssistantMessage("Spawned one worker, done."));
    callGatewayMock.mockResolvedValue({ runId: "run-1", childSessionKey: "sess-1" });

    const result = await runOrchestratorTurn(baseInput());

    expect(result.errors).toBeUndefined();
    expect(result.spawnedRunIds).toEqual(["run-1"]);
    expect(result.summary).toBe("Spawned one worker, done.");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock.mock.calls[0]?.[0]?.method).toBe("sessions.spawn");
    // Lineage stamped on registry entry
    expect(setSubagentLineageMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ parentGoalId: "goal_test_1" }),
    );
  });
});

// ─── Scenario 2: transient ECONNRESET → retry succeeds ───────────────────

describe("scenario 2: transient planning error retries and succeeds", () => {
  it("first ECONNRESET on planning call retries, second attempt succeeds", async () => {
    vi.useFakeTimers();

    completeMock
      // planning call: first attempt fails, second succeeds
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockResolvedValueOnce(asAssistantMessage(plan("no action needed", [])))
      // synthesis call
      .mockResolvedValueOnce(asAssistantMessage("Nothing to do this turn."));

    const promise = runOrchestratorTurn(baseInput());
    // Drain the backoff sleep(s).
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.errors).toBeUndefined();
    expect(result.summary).toBe("Nothing to do this turn.");
    // Planning + synthesis = 2 complete() calls, but planning retried once,
    // so 3 total invocations.
    expect(completeMock).toHaveBeenCalledTimes(3);
  });
});

// ─── Scenario 3: non-retryable spawn-param error → fails without retry ──

describe("scenario 3: non-retryable spawn-param error", () => {
  it("planner emits empty label → validateSpawnParams rejects → no gateway call, no retry", async () => {
    completeMock
      // planning call: emit a spawn with an empty label
      .mockResolvedValueOnce(
        asAssistantMessage(plan("spawn", [{ tool: "spawn_subagent", label: "", task: "Do it." }])),
      )
      // synthesis
      .mockResolvedValueOnce(asAssistantMessage("Failed to spawn."));

    const result = await runOrchestratorTurn(baseInput());

    // Gateway sessions.spawn must NOT have been called — the validator
    // rejected the request locally, the way the 64-char regression patch
    // intends. The same invariant guards against any future bad-params spawn.
    const spawnCalls = callGatewayMock.mock.calls.filter(
      (c) => (c[0] as { method: string }).method === "sessions.spawn",
    );
    expect(spawnCalls).toHaveLength(0);
    expect(result.spawnedRunIds).toEqual([]);
    expect(result.errors?.[0]?.phase).toBe("tool");
    expect(result.errors?.[0]?.message).toMatch(/invalid agent params/);
  });

  it("64-char regression: planner emits a 100-char label → validator truncates → spawn succeeds", async () => {
    // The whole reason validateSpawnParams exists — confirm a too-long
    // label can't reproduce the original failure mode.
    const longLabel = "x".repeat(100);
    completeMock
      .mockResolvedValueOnce(
        asAssistantMessage(
          plan("spawn", [{ tool: "spawn_subagent", label: longLabel, task: "Work." }]),
        ),
      )
      .mockResolvedValueOnce(asAssistantMessage("Spawned."));
    callGatewayMock.mockResolvedValue({ runId: "run-7", childSessionKey: "sess-7" });

    const result = await runOrchestratorTurn(baseInput());

    const spawnCall = callGatewayMock.mock.calls.find(
      (c) => (c[0] as { method: string }).method === "sessions.spawn",
    );
    expect(spawnCall).toBeDefined();
    const labelSent = (spawnCall![0] as { params: { label: string } }).params.label;
    expect(labelSent.length).toBeLessThanOrEqual(63);
    expect(result.spawnedRunIds).toEqual(["run-7"]);
    expect(result.errors).toBeUndefined();
  });
});

// ─── Scenario 4: malformed JSON → repair retry ──────────────────────────

describe("scenario 4: malformed planner JSON triggers repair retry", () => {
  it("first planning call returns junk, repair retry returns valid JSON, turn completes", async () => {
    vi.useFakeTimers();

    completeMock
      // planning call: total garbage
      .mockResolvedValueOnce(
        asAssistantMessage("I had a great time at the park yesterday, no JSON here."),
      )
      // repair retry: clean JSON
      .mockResolvedValueOnce(asAssistantMessage(plan("no action", [])))
      // synthesis
      .mockResolvedValueOnce(asAssistantMessage("Recovered after repair."));

    const promise = runOrchestratorTurn(baseInput());
    await vi.runAllTimersAsync();
    const result = await promise;

    // Repair recovered cleanly — no errors recorded.
    expect(result.errors).toBeUndefined();
    expect(result.summary).toBe("Recovered after repair.");
    // 1 planning + 1 repair + 1 synthesis = 3 LLM calls
    expect(completeMock).toHaveBeenCalledTimes(3);
  });

  it("if repair retry also fails, iteration is logged as a planning failure, not silent zero-tool-call", async () => {
    vi.useFakeTimers();

    completeMock
      // planning call: junk
      .mockResolvedValueOnce(asAssistantMessage("free text only"))
      // repair retry: still junk
      .mockResolvedValueOnce(asAssistantMessage("more free text"))
      // synthesis still runs to give the operator a summary
      .mockResolvedValueOnce(asAssistantMessage("Could not parse plan."));

    const promise = runOrchestratorTurn(baseInput());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.spawnedRunIds).toEqual([]);
    // The audit requirement: surface the failure as a structured error, not
    // a silent empty-toolCalls result. Hermes mirrors this with
    // _has_content_after_think_block + structured logging.
    expect(result.errors).toBeDefined();
    const planningErr = result.errors!.find((e) => e.phase === "planning");
    expect(planningErr).toBeDefined();
    expect(planningErr!.message).toMatch(/unparseable after one repair retry/);
    expect(planningErr!.detail).toBeDefined();
  });
});

// ─── Scenario 5: MAX_PARALLEL cap enforced ──────────────────────────────

describe("scenario 5: spawn cap enforcement", () => {
  it("5th concurrent spawn returns a clear cap error from the orchestrator", async () => {
    // Planner asks for 5 spawns. Cap default is 4.
    const fiveSpawns = Array.from({ length: 5 }, (_, i) => ({
      tool: "spawn_subagent",
      label: `worker ${i + 1}`,
      task: `Task ${i + 1}.`,
    }));

    completeMock
      .mockResolvedValueOnce(asAssistantMessage(plan("spawn 5 workers", fiveSpawns)))
      .mockResolvedValueOnce(asAssistantMessage("Spawned 4, 5th capped."));

    // First 4 sessions.spawn return ids, 5th won't be called.
    let n = 0;
    callGatewayMock.mockImplementation(async (req) => {
      const r = req as { method: string };
      if (r.method === "sessions.spawn") {
        n++;
        return { runId: `run-${n}`, childSessionKey: `sess-${n}` };
      }
      return {};
    });

    // H3 regression: in production, setSubagentLineage immediately registers
    // the just-spawned run, so the registry view (`listSubagentRunsByGoalId`)
    // already counts the in-turn spawns by the time the next iteration of
    // the for-loop runs. Mirror that here, otherwise the cap check sees zero
    // every time and lets all 5 through (which is exactly the bug-restore
    // path the prior version of this test was silently exercising).
    const fakeRegistry: Array<{
      runId: string;
      parentGoalId?: string;
      endedAt?: number;
      label?: string;
      outcome?: { status?: string };
      parentGoalIterationIndex?: number;
    }> = [];
    setSubagentLineageMock.mockImplementation((runId: string) => {
      fakeRegistry.push({ runId, parentGoalId: "goal_test_1" });
    });
    listSubagentRunsByGoalIdMock.mockImplementation(() => fakeRegistry);

    const result = await runOrchestratorTurn(baseInput());

    // Only 4 actual spawns went out.
    const spawnCalls = callGatewayMock.mock.calls.filter(
      (c) => (c[0] as { method: string }).method === "sessions.spawn",
    );
    expect(spawnCalls).toHaveLength(4);
    expect(result.spawnedRunIds).toHaveLength(4);

    // The 5th attempt is recorded as a tool error with a clear cap message.
    const capError = result.errors?.find((e) => /Concurrent sub-agent cap reached/.test(e.message));
    expect(capError).toBeDefined();
  });

  it("H3: with mock registry simulating in-turn spawns, cap still fires at 5 (not 3)", async () => {
    // Direct H3 coverage — this is the asymmetry the double-count bug
    // produced: the cap fired at MAX_PARALLEL/2 instead of MAX_PARALLEL.
    const fiveSpawns = Array.from({ length: 5 }, (_, i) => ({
      tool: "spawn_subagent",
      label: `worker ${i + 1}`,
      task: `Task ${i + 1}.`,
    }));
    completeMock
      .mockResolvedValueOnce(asAssistantMessage(plan("spawn 5", fiveSpawns)))
      .mockResolvedValueOnce(asAssistantMessage("ok"));

    let n = 0;
    callGatewayMock.mockImplementation(async (req) => {
      const r = req as { method: string };
      if (r.method === "sessions.spawn") {
        n++;
        return { runId: `run-${n}`, childSessionKey: `sess-${n}` };
      }
      return {};
    });

    const fakeRegistry: Array<{ runId: string; endedAt?: number }> = [];
    setSubagentLineageMock.mockImplementation((runId: string) => {
      fakeRegistry.push({ runId });
    });
    listSubagentRunsByGoalIdMock.mockImplementation(() => fakeRegistry);

    const result = await runOrchestratorTurn(baseInput());

    // With the fix: exactly MAX_PARALLEL (4) succeed; the 5th hits the cap.
    // Before the fix: only 2 succeeded because each new spawn was counted twice.
    expect(result.spawnedRunIds).toHaveLength(4);
  });
});

// ─── H6: await_subagent timeout surfaces a useful error string ──────────

describe("H6: await_subagent on timeout returns an explanatory error", () => {
  it("agent.wait returning {status:'timeout'} produces an error string for synthesis", async () => {
    completeMock
      // planner asks the orchestrator to await a runId the gateway can't find
      .mockResolvedValueOnce(
        asAssistantMessage(
          plan("wait on missing", [
            { tool: "await_subagent", runId: "ghost-run", timeoutSec: 1 },
          ]),
        ),
      )
      .mockResolvedValueOnce(asAssistantMessage("Ghost did not respond."));

    callGatewayMock.mockImplementation(async (req) => {
      const r = req as { method: string };
      if (r.method === "agent.wait") {
        // No error, no reply, just status:timeout — the production failure mode.
        return { status: "timeout" };
      }
      return {};
    });

    const result = await runOrchestratorTurn(baseInput());

    // The orchestrator surfaces the timeout as a structured tool error so
    // the operator (and the synthesis turn) see *why*, not just "FAILED".
    const awaitError = result.errors?.find((e) =>
      /await_subagent: await timed out after 1s/.test(e.message),
    );
    expect(awaitError).toBeDefined();
  });
});

// ─── Bonus: wallclock cap short-circuits the turn ───────────────────────

describe("scenario 6 (bonus): wallclock cap short-circuits", () => {
  it("returns immediately with a structured error when budget.startedAt is older than the cap", async () => {
    // 1 hour ago — well past the 30-min default cap.
    const input = baseInput({
      budget: { maxTurns: 5, turnsUsed: 0, startedAt: Date.now() - 3_600_000 },
    });

    const result = await runOrchestratorTurn(input);

    expect(result.summary).toMatch(/wallclock cap/i);
    expect(result.errors?.[0]?.message).toMatch(/wallclock cap/);
    // No model call, no gateway call — proves the cap fires BEFORE auth.
    expect(completeMock).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
