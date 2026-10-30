/**
 * Verifies the registry-backed fallback in `dispatchPush`. The lifecycle
 * emit sites (`pi-embedded-subscribe.handlers.lifecycle.ts`,
 * `agent-runner-execution.ts`, `terminal/spawn-agent.ts`, …) currently
 * pass only `{ phase, startedAt, endedAt, error }` into `evt.data` — no
 * `label` or `task`. Without the registry fallback, the resulting Expo
 * push lands with a raw-runId title like "Sub-agent finished: coder…",
 * defeating `formatSubagentNotificationTitle`.
 *
 * The test stuffs a SubagentRunRecord into the registry (the same shape
 * `registerSubagentRun` produces), fires a lifecycle "end" event with an
 * intentionally bare `evt.data`, and asserts the call to `emitNotification`
 * carries the friendly label + task description.
 *
 * `emitNotification` is mocked because the real path requires
 * better-sqlite3 to be loaded for the history store — orthogonal to this
 * test's goal of verifying the dispatcher's resolution logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitNotificationMock = vi.fn(async (_opts: unknown) => "mock-id");

vi.mock("./emit.js", () => ({
  emitNotification: emitNotificationMock,
  setNotificationBroadcaster: vi.fn(),
}));

// Import AFTER the mock is registered so mobile-push.ts picks up the mock.
const { resetDedupForTests, startMobilePushDispatcher, stopMobilePushDispatcher } =
  await import("./mobile-push.js");
const { emitAgentEvent } = await import("../infra/agent-events.js");
const { addSubagentRunForTests, resetSubagentRegistryForTests } =
  await import("../agents/subagent-registry.js");

describe("mobile-push dispatchPush + subagent registry fallback", () => {
  beforeEach(() => {
    emitNotificationMock.mockClear();
    resetSubagentRegistryForTests();
    stopMobilePushDispatcher();
    resetDedupForTests();
    startMobilePushDispatcher();
  });

  afterEach(() => {
    stopMobilePushDispatcher();
    resetSubagentRegistryForTests();
  });

  async function flushMicrotasks() {
    // dispatchPush is fire-and-forget from onAgentEvent. Two ticks lets the
    // `void dispatchPush(...).catch(...)` chain run the synchronous prefix
    // up to the (mocked) emitNotification call.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("pulls label + task from the registry when evt.data omits them (phase=end)", async () => {
    const runId = "coder-mobile-fix-x9y2";
    const startedAt = Date.now() - 252_000;
    addSubagentRunForTests({
      runId,
      childSessionKey: `agent:coder:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Fix the navigator error in Kanban",
      cleanup: "delete",
      label: "coder-mobile-fix-x9y2",
      createdAt: startedAt,
      startedAt,
    });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      sessionKey: `agent:coder:${runId}`,
      data: { phase: "end", startedAt, endedAt: startedAt + 252_000 },
    });

    await flushMicrotasks();

    expect(emitNotificationMock).toHaveBeenCalledTimes(1);
    const args = emitNotificationMock.mock.calls[0]?.[0] as Record<string, any>;
    // Title humanized from the registry label — NOT the raw runId.
    expect(args.title).toBe("Sub-agent finished: Mobile fix");
    expect(args.displayTitle).toBe("Sub-agent finished: Mobile fix");
    // Body has the duration AND the registry task as a fallback excerpt.
    expect(args.body).toContain("completed in 4m 12s");
    expect(args.body).toContain("Fix the navigator error in Kanban");
    // Severity + category route this to the agent-messages channel.
    expect(args.category).toBe("agent.completed");
    expect(args.severity).toBe("success");
    expect(args.data?.agentLabel).toBe("Mobile fix");
    expect(args.data?.phase).toBe("complete");
  });

  it("uses the registry task for spawn-phase notifications too", async () => {
    const runId = "subagent-voice-revamp-9b7c";
    const startedAt = Date.now();
    addSubagentRunForTests({
      runId,
      childSessionKey: `agent:coder:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Rework the VoiceCallContext to use the new gateway shape",
      cleanup: "delete",
      label: "subagent-voice-revamp-9b7c",
      createdAt: startedAt,
      startedAt,
    });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt },
    });

    await flushMicrotasks();

    expect(emitNotificationMock).toHaveBeenCalledTimes(1);
    const args = emitNotificationMock.mock.calls[0]?.[0] as Record<string, any>;
    // Spawn title format: "<Label> — running"
    expect(args.title).toMatch(/^Voice revamp\s*—\s*running$/);
    expect(args.body).toContain("Rework the VoiceCallContext");
  });

  it("still produces a humanized title when the registry has no record", async () => {
    const runId = "orphan-run-abc1";
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: Date.now() - 1000, endedAt: Date.now() },
    });

    await flushMicrotasks();

    expect(emitNotificationMock).toHaveBeenCalledTimes(1);
    const args = emitNotificationMock.mock.calls[0]?.[0] as Record<string, any>;
    // Without a registry record we still humanize from runId — must not be
    // the raw runId string, and must use the friendly "Sub-agent finished:"
    // prefix from formatSubagentNotificationTitle.
    expect(args.title).not.toBe(runId);
    expect(args.title.startsWith("Sub-agent finished:")).toBe(true);
  });

  it("error-phase keeps the registry label + adds the sanitized error", async () => {
    const runId = "coder-mobile-blob-x1a2";
    const startedAt = Date.now() - 30_000;
    addSubagentRunForTests({
      runId,
      childSessionKey: `agent:coder:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Add a SVG fallback for the voice blob",
      cleanup: "delete",
      label: "coder-mobile-blob-x1a2",
      createdAt: startedAt,
      startedAt,
    });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt,
        endedAt: startedAt + 30_000,
        error: "TypeError: foo is not a function\n    at file:42",
      },
    });

    await flushMicrotasks();

    expect(emitNotificationMock).toHaveBeenCalledTimes(1);
    const args = emitNotificationMock.mock.calls[0]?.[0] as Record<string, any>;
    expect(args.title).toBe("Sub-agent failed: Mobile blob");
    expect(args.severity).toBe("error");
    expect(args.body).toContain("TypeError: foo is not a function");
    // Stack trace must be stripped from the sanitized error.
    expect(args.body).not.toContain("at file:42");
  });
});
