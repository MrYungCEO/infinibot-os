/**
 * Subagent registry retention tests.
 *
 * Asserts that:
 * 1. Registry retains an entry across many sweeper cycles with no expiry.
 * 2. Registry is NOT purged based on heartbeat silence alone.
 * 3. After cleanup:"delete" finalisation the registry entry stays alive for
 *    ~10 minutes (COMPLETED_ARCHIVE_DELAY_MS) before the sweeper deletes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Heavy deps mocked before any tested module is imported ──────────────────

vi.mock("../gateway/call.js", () => ({
  // agent.wait must NOT resolve immediately — return a never-settling promise
  // so waitForSubagentCompletion() doesn't set endedAt during the test run.
  // All other gateway calls (sessions.delete, etc.) can succeed silently.
  callGateway: vi.fn(async (opts: { method?: string }) => {
    if (opts?.method === "agent.wait") {
      return new Promise(() => {}); // intentionally never resolves
    }
    return {};
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
  })),
}));

const agentEventListeners = vi.hoisted(() => new Set<(evt: unknown) => void>());
vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((fn: (evt: unknown) => void) => {
    agentEventListeners.add(fn);
    return () => agentEventListeners.delete(fn);
  }),
}));
const emitAgentEvent = (evt: Record<string, unknown>) => {
  for (const fn of agentEventListeners) fn({ seq: 1, ts: Date.now(), ...evt });
};

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(),
}));

vi.mock("./subagent-progress.js", () => ({
  initProgressTracking: vi.fn(),
  completeProgress: vi.fn(),
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 30 * 60_000),
}));

vi.mock("./tools/kanban-tool.js", () => ({
  findOrCreateProject: vi.fn(async () => null),
  mcpCreateTask: vi.fn(async () => ({ id: "task-1" })),
  mcpUpdateTask: vi.fn(async () => {}),
}));

// Import after all mocks are in place.
import {
  registerSubagentRun,
  getRunForTests,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
  runSweepForTests,
  getPendingLifecycleRunCountForTests,
  releaseSubagentRun,
} from "./subagent-registry.js";

// ─────────────────────────────────────────────────────────────────────────────

const REQUESTER = "agent:main:requester-1";

function makeRun(id: string) {
  return {
    runId: id,
    childSessionKey: `agent:coder:${id}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: REQUESTER,
    task: `Test task for ${id}`,
    cleanup: "delete" as const,
    label: `Run ${id}`,
  };
}

describe("subagent registry retention", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSubagentRegistryForTests();
  });

  it("retains registry entry after multiple sweeper cycles with no expiry", async () => {
    const run = makeRun("run-retain-1");
    registerSubagentRun(run);

    expect(getRunForTests(run.runId)).toBeDefined();

    // Advance 5 minutes and sweep — entry must survive (no endedAt set).
    vi.advanceTimersByTime(5 * 60_000);
    await runSweepForTests();

    expect(getRunForTests(run.runId)).toBeDefined();
    expect(getRunForTests(run.runId)?.endedAt).toBeUndefined();
  });

  it("does NOT expire an in-progress entry based on heartbeat silence", async () => {
    const run = makeRun("run-silence-1");
    registerSubagentRun(run);

    // No progress events at all. 28 min of silence — well short of the
    // 30-min expectedEndByMs + STUCK_DEFAULT_MS threshold.
    vi.advanceTimersByTime(28 * 60_000);
    await runSweepForTests();

    expect(getRunForTests(run.runId)).toBeDefined();
  });

  it("listSubagentRunsForRequester includes the run throughout its active lifetime", async () => {
    const run = makeRun("run-list-1");
    registerSubagentRun(run);

    expect(listSubagentRunsForRequester(REQUESTER)).toHaveLength(1);

    vi.advanceTimersByTime(4 * 60_000);
    await runSweepForTests();

    expect(listSubagentRunsForRequester(REQUESTER)).toHaveLength(1);
  });

  it("keeps the registry entry alive for ~9 min after cleanup:delete is finalised (within grace window)", async () => {
    const run = makeRun("run-grace-1");
    registerSubagentRun(run);

    // Simulate a completion event: set endedAt and cleanupHandled manually
    // (without going through the full lifecycle plumbing) to mimic what
    // applyLifecycleEvent + beginSubagentCleanup + finalizeSubagentCleanup do.
    const entry = getRunForTests(run.runId)!;
    expect(entry).toBeDefined();

    // Mark completed but don't set archiveAtMs — finalizeSubagentCleanup
    // should set it to now + 10 min when cleanup:"delete" + didAnnounce.
    entry.endedAt = Date.now();
    entry.outcome = { status: "ok" };
    // Simulate finalizeSubagentCleanup setting archiveAtMs to 10 min from now.
    entry.archiveAtMs = Date.now() + 10 * 60_000;
    entry.cleanupCompletedAt = Date.now();

    // 1 minute later — entry must still be present (inside grace window).
    vi.advanceTimersByTime(60_000);
    await runSweepForTests();
    expect(getRunForTests(run.runId)).toBeDefined();

    // 9 minutes total — still inside the 10-min grace window.
    vi.advanceTimersByTime(8 * 60_000); // total ~9 min
    await runSweepForTests();
    expect(getRunForTests(run.runId)).toBeDefined();
  });

  it("deletes the registry entry after the 10-min grace window expires", async () => {
    const run = makeRun("run-expire-1");
    registerSubagentRun(run);

    const entry = getRunForTests(run.runId)!;
    entry.endedAt = Date.now();
    entry.outcome = { status: "ok" };
    // Set archiveAtMs to exactly 10 minutes from now.
    entry.archiveAtMs = Date.now() + 10 * 60_000;
    entry.cleanupCompletedAt = Date.now();

    // Advance past the archive window.
    vi.advanceTimersByTime(10 * 60_000 + 1_000);
    await runSweepForTests();

    // Entry should now be purged by the archive sweep.
    expect(getRunForTests(run.runId)).toBeUndefined();
  });

  it("expires queued lifecycle events of non-subagent runs (no unbounded growth)", () => {
    registerSubagentRun(makeRun("run-listener-anchor")); // starts the lifecycle listener
    releaseSubagentRun("run-listener-anchor"); // …then no subagent runs: sweeper idle
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 200; i++) {
        const runId = `chat-run-${batch}-${i}`;
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start" } });
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
      }
      vi.advanceTimersByTime(31_000);
    }
    // Only roughly the latest batch (or two) can still be pending, not all 2000 runs.
    expect(getPendingLifecycleRunCountForTests()).toBeLessThanOrEqual(400);
  });
});
