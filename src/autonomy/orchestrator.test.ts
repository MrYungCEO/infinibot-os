/**
 * Tests for orchestrator label truncation, spawn integration, and self-heal.
 * Retry-specific unit tests live in retry.test.ts.
 * // COORDINATION: orch-self-heal
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { truncateLabel } from "./orchestrator.js";
import type { QueuedTask } from "./types.js";

// ─── Module stubs ─────────────────────────────────────────────────────────────
// retryWithBackoff is mocked as a passthrough so orchestrator tests run without
// timer delays. The real retryWithBackoff is tested in retry.test.ts.

vi.mock("./retry.js", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("./retry.js");
  return {
    ...mod,
    // COORDINATION: orch-self-heal — passthrough: call fn once, no delay, no retry loop
    retryWithBackoff: async (fn: () => Promise<unknown>) => fn(),
  };
});

vi.mock("./audit.js", () => ({
  initAudit: vi.fn(),
  logAudit: vi.fn(),
  logCageInterference: vi.fn(),
  audit: {
    init: vi.fn(),
    log: vi.fn(),
    recent: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue({ cageInterferences: 0 }),
    verify: vi.fn().mockReturnValue({ valid: true }),
    read: vi.fn().mockReturnValue([]),
  },
}));
vi.mock("./kanban-sync.js", () => ({ syncToKanban: vi.fn() }));
vi.mock("./pause.js", () => ({ isPaused: vi.fn().mockReturnValue(false) }));
vi.mock("./tester-agent.js", () => ({
  buildBuilderPrompt: vi.fn().mockReturnValue("build prompt"),
  buildTesterPrompt: vi.fn().mockReturnValue("test prompt"),
  parseTesterVerdict: vi
    .fn()
    .mockReturnValue({ pass: true, summary: "ok", reasons: [], evidence: [], fixHints: [] }),
}));
vi.mock("./notifications.js", () => ({
  initNotifications: vi.fn(),
  notifications: {
    iterationStarted: vi.fn().mockResolvedValue(undefined),
    taskFailed: vi.fn().mockResolvedValue(undefined),
    testerVerdict: vi.fn().mockResolvedValue(undefined),
    taskCompleted: vi.fn().mockResolvedValue(undefined),
    prefireBlocked: vi.fn().mockResolvedValue(undefined),
    maxIterationsReached: vi.fn().mockResolvedValue(undefined),
    taskStarted: vi.fn().mockResolvedValue(undefined),
    cageInterference: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue(undefined),
    // COORDINATION: orch-self-heal — critical-blocker + recovery alerts.
    criticalBlocker: vi.fn().mockResolvedValue(undefined),
    taskRecovered: vi.fn().mockResolvedValue(undefined),
  },
}));
// Extended queue mock — H5 doHeartbeatWork additionally needs get/start/stats.
const queueGetMock = vi.fn(() => [] as unknown[]);
const queueStartMock = vi.fn();
const queueStatsMock = vi.fn(() => ({
  pending: 0,
  approved: 0,
  running: 0,
  completed: 0,
  failed: 0,
}));
vi.mock("./queue.js", () => ({
  initQueue: vi.fn(),
  queue: {
    init: vi.fn(),
    getById: vi.fn(),
    persist: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    get: (...a: unknown[]) => queueGetMock(...a),
    start: (...a: unknown[]) => queueStartMock(...a),
    stats: () => queueStatsMock(),
    add: vi.fn(),
    pending: vi.fn(),
    next: vi.fn(),
    approve: vi.fn(),
    cancel: vi.fn(),
    cleanup: vi.fn(),
  },
}));

// pause.js and hardware.js need to expose the same surface manager.js calls.
vi.mock("./pause.js", () => ({
  initPause: vi.fn(),
  pause: {
    init: vi.fn(),
    isPaused: vi.fn().mockReturnValue(false),
    getState: vi.fn().mockReturnValue({ isPaused: false }),
    activate: vi.fn(),
    deactivate: vi.fn(),
    checkExpiry: vi.fn(),
  },
}));

vi.mock("./hardware.js", () => ({
  initHardware: vi.fn(),
  hardware: {
    canRunIntensive: vi.fn().mockResolvedValue({ allowed: true }),
    check: vi.fn().mockResolvedValue({}),
    isUserIdle: vi.fn().mockResolvedValue(true),
    getIdleTime: vi.fn().mockResolvedValue(60_000),
  },
}));

vi.mock("./api-monitor.js", () => ({
  initApiMonitor: vi.fn(),
  apiMonitor: {
    today: vi.fn().mockReturnValue({}),
    summary: vi.fn().mockReturnValue({}),
    record: vi.fn(),
    recent: vi.fn().mockReturnValue([]),
    taskUsage: vi.fn().mockReturnValue({}),
  },
}));
vi.mock("./goal-judge.js", () => ({
  executeGoalTurn: vi.fn().mockResolvedValue("agent reply"),
  evaluateGoal: vi.fn().mockResolvedValue({
    done: false,
    rationale: "not done",
    nextPrompt: "keep going",
  }),
}));
vi.mock("./goal-orchestrator.js", () => ({
  runOrchestratorTurn: vi.fn().mockResolvedValue({ reply: "orchestrator reply", subagents: [] }),
}));

afterEach(() => {
  // clearAllMocks wipes call history but keeps the mockResolvedValue/etc
  // implementations set up by the vi.mock() blocks above. Using resetAllMocks
  // here would null out those implementations and the next test's
  // startOrchestratedTask would hang on an `await notifications.iterationStarted`
  // that no longer resolves the way the loop expects.
  vi.clearAllMocks();
});

// ─── truncateLabel ────────────────────────────────────────────────────────────

describe("truncateLabel", () => {
  it("returns short strings unchanged", () => {
    expect(truncateLabel("short")).toBe("short");
  });

  it("returns strings exactly at the new safety max (63) unchanged", () => {
    // COORDINATION: goal-oversight — truncateLabel was tightened from 64 to 63
    // to leave one-char headroom against the gateway's maxLength=64 boundary
    // (a small fraction of spawn rejections were hitting the exact-64 edge).
    const s = "x".repeat(63);
    expect(truncateLabel(s)).toHaveLength(63);
    expect(truncateLabel(s)).toBe(s);
  });

  it("truncates a 200-char title to ≤63 chars and appends ellipsis", () => {
    const title = "a".repeat(200);
    const label = truncateLabel(`Build iter 1 · ${title}`);
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label.endsWith("…")).toBe(true);
  });

  it("returns fallback for empty/whitespace input", () => {
    expect(truncateLabel("")).toBe("autonomy-task");
    expect(truncateLabel("   ")).toBe("autonomy-task");
  });

  it("real failing task title produces label ≤63 chars for build and test prefixes", () => {
    const title = "Consolodated Infinibot Projects and Sub Project Association";
    expect(truncateLabel(`Build iter 1 · ${title}`).length).toBeLessThanOrEqual(63);
    expect(truncateLabel(`Test iter 1 · ${title}`).length).toBeLessThanOrEqual(63);
  });
});

// ─── Integration: spawn label ≤ 64 chars ─────────────────────────────────────

function makeBuildTask(titleOverride?: string): QueuedTask {
  const title = titleOverride ?? "Short Title";
  return {
    id: "task_test_abc",
    createdAt: Date.now(),
    priority: "normal",
    status: "pending",
    title,
    description: "test",
    hardwareIntensive: false,
    requiresApproval: false,
    auditIds: [],
    context: {
      prefire: {
        successCriteria: "done",
        testTargets: [{ description: "verify it" }],
        maxIterations: 1,
        testerEnabled: false,
        completed: true,
        completedAt: Date.now(),
      },
    },
  };
}

describe("spawn label truncation integration", () => {
  it("spawn label is ≤63 chars even when task title is 200 chars", async () => {
    const { startOrchestratedTask } = await import("./orchestrator.js");

    const longTitle = "Analyze and upgrade the entire system with full ".repeat(5).slice(0, 200);
    const task = makeBuildTask(longTitle);

    const spawnMock = vi.fn().mockResolvedValue({ runId: "run-1", childSessionKey: "sess-1" });

    await startOrchestratedTask(task, {
      spawnSubagent: spawnMock,
      waitForSubagent: vi.fn().mockResolvedValue({ status: "ok", reply: "build complete" }),
      updateTask: vi.fn().mockReturnValue(task),
      completeTask: vi.fn(),
      failTask: vi.fn(),
    });

    // runLoop kicks off in the background; wait for the spawn to land
    // before asserting on its args.
    await vi.waitFor(
      () => {
        expect(spawnMock).toHaveBeenCalled();
      },
      { timeout: 5_000, interval: 10 },
    );
    for (const [callArgs] of spawnMock.mock.calls) {
      expect(callArgs.label.length).toBeLessThanOrEqual(63);
    }
  });
});

// ─── H1: runLoop top-level catch ─────────────────────────────────────────────

describe("H1: runLoop crashes never strand a task", () => {
  it("a throw in notifications.iterationStarted still calls failTask and clears running", async () => {
    const { startOrchestratedTask, getRunningOrchestrationsForTests } =
      await import("./orchestrator.js");
    const { notifications } = await import("./notifications.js");

    // Make the first inner notify call explode — this used to bypass every
    // inner deps.failTask path and leave the task stranded.
    vi.mocked(notifications.iterationStarted).mockRejectedValueOnce(
      new Error("telegram is on fire"),
    );

    const task = makeBuildTask("Boom title");
    const failTask = vi.fn();

    await startOrchestratedTask(task, {
      spawnSubagent: vi.fn().mockResolvedValue({ runId: "rA", childSessionKey: "sA" }),
      waitForSubagent: vi.fn().mockResolvedValue({ status: "ok", reply: "" }),
      updateTask: vi.fn().mockReturnValue(task),
      completeTask: vi.fn(),
      failTask,
    });

    await vi.waitFor(
      () => {
        expect(getRunningOrchestrationsForTests()).not.toContain(task.id);
      },
      { timeout: 5_000, interval: 10 },
    );

    expect(failTask).toHaveBeenCalledWith(task.id, expect.stringContaining("orchestrator crashed"));
    expect(failTask.mock.calls[0][1]).toMatch(/telegram is on fire/);
  });
});

// ─── H2: builder/tester wait timeout is terminal ─────────────────────────────

describe("H2: wait timeout stops the iteration", () => {
  it("builder timeout → no tester spawn, failTask reasons 'timed out'", async () => {
    const { startOrchestratedTask, getRunningOrchestrationsForTests } =
      await import("./orchestrator.js");

    const task = makeBuildTask("Timeout test");
    // testerEnabled: true forces the loop to consider the tester phase — we
    // want to prove it never gets there.
    task.context!.prefire!.testerEnabled = true;

    const failTask = vi.fn();
    const spawnSubagent = vi.fn().mockResolvedValue({ runId: "rB", childSessionKey: "sB" });
    const waitForSubagent = vi
      .fn()
      // First wait = builder → timeout. There should be no second wait.
      .mockResolvedValue({ status: "timeout" });

    await startOrchestratedTask(task, {
      spawnSubagent,
      waitForSubagent,
      updateTask: vi.fn().mockReturnValue(task),
      completeTask: vi.fn(),
      failTask,
    });

    await vi.waitFor(
      () => {
        expect(getRunningOrchestrationsForTests()).not.toContain(task.id);
      },
      { timeout: 5_000, interval: 10 },
    );

    // Only the builder spawn ever happened — tester phase was correctly skipped.
    expect(spawnSubagent).toHaveBeenCalledTimes(1);
    expect(waitForSubagent).toHaveBeenCalledTimes(1);
    expect(failTask).toHaveBeenCalled();
    expect(failTask.mock.calls[0][1]).toMatch(/timed out/);
  });
});

// ─── Self-heal: infra failure → heal → park as blocked (not failed) ─────────
// COORDINATION: orch-self-heal

describe("self-heal: unhealable infra failure parks the task as blocked", () => {
  it("builder spawn infra error with an unhealable healer → blockTask, not failTask", async () => {
    const { startOrchestratedTask, getRunningOrchestrationsForTests } =
      await import("./orchestrator.js");
    const { __setHealersForTest } = await import("./self-heal.js");
    const { notifications } = await import("./notifications.js");

    // A healer that matches the failure but can never fix it → unhealable →
    // the orchestrator must PARK (block) the task rather than terminally fail.
    __setHealersForTest([
      {
        id: "test-infra",
        description: "test-only always-fails healer",
        detect: (c) => /boom-infra/.test(c.errorText),
        heal: async () => ({ healed: false, action: "cannot fix in test", retryable: false }),
      },
    ]);

    const task = makeBuildTask("Infra blocker task");
    const failTask = vi.fn();
    const blockTask = vi.fn();
    // Spawn always throws an infra error our healer claims but can't fix.
    const spawnSubagent = vi.fn().mockRejectedValue(new Error("boom-infra: tool down"));

    try {
      await startOrchestratedTask(task, {
        spawnSubagent,
        waitForSubagent: vi.fn(),
        updateTask: vi.fn().mockReturnValue(task),
        completeTask: vi.fn(),
        failTask,
        blockTask,
      });

      await vi.waitFor(
        () => {
          expect(getRunningOrchestrationsForTests()).not.toContain(task.id);
        },
        { timeout: 5_000, interval: 10 },
      );

      expect(blockTask).toHaveBeenCalledWith(task.id, expect.stringContaining("boom-infra"));
      expect(failTask).not.toHaveBeenCalled();
      // A critical-blocker Telegram alert fires on the park transition.
      expect(notifications.criticalBlocker).toHaveBeenCalled();
    } finally {
      __setHealersForTest(null);
    }
  });

  it("a genuine (non-infra) builder spawn error still fails terminally", async () => {
    const { startOrchestratedTask, getRunningOrchestrationsForTests } =
      await import("./orchestrator.js");
    const { __setHealersForTest } = await import("./self-heal.js");

    // No healer matches and the error isn't transient → genuine task failure.
    __setHealersForTest([]);

    const task = makeBuildTask("Genuine failure task");
    const failTask = vi.fn();
    const blockTask = vi.fn();
    const spawnSubagent = vi.fn().mockRejectedValue(new Error("some genuine logic problem"));

    try {
      await startOrchestratedTask(task, {
        spawnSubagent,
        waitForSubagent: vi.fn(),
        updateTask: vi.fn().mockReturnValue(task),
        completeTask: vi.fn(),
        failTask,
        blockTask,
      });

      await vi.waitFor(
        () => {
          expect(getRunningOrchestrationsForTests()).not.toContain(task.id);
        },
        { timeout: 5_000, interval: 10 },
      );

      expect(failTask).toHaveBeenCalledWith(task.id, expect.stringContaining("build spawn failed"));
      expect(blockTask).not.toHaveBeenCalled();
    } finally {
      __setHealersForTest(null);
    }
  });
});

// ─── H4: validatePrefire rejects invalid maxIterations on the dynamic form ──

describe("H4: dynamic prefire form validates maxIterations", () => {
  it("answer 0 → validation fails with a clear missing entry", async () => {
    const { validatePrefire } = await import("./orchestrator.js");

    const task: QueuedTask = {
      id: "task_h4",
      createdAt: Date.now(),
      priority: "normal",
      status: "pending",
      title: "Dynamic form",
      description: "test",
      hardwareIntensive: false,
      requiresApproval: false,
      auditIds: [],
      context: {
        prefireForm: {
          fields: [
            { id: "successCriteria", label: "Success criteria", type: "text", required: true },
            { id: "maxIterations", label: "Max iterations", type: "number", required: true },
          ],
          answers: { successCriteria: "done", maxIterations: 0 },
          agentReady: true,
          generatedAt: Date.now(),
        },
      },
    };

    const result = validatePrefire(task);
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => /must be ≥ 1/.test(m))).toBe(true);
  });

  it("answer 5 → validation passes (sanity)", async () => {
    const { validatePrefire } = await import("./orchestrator.js");
    const task: QueuedTask = {
      id: "task_h4_ok",
      createdAt: Date.now(),
      priority: "normal",
      status: "pending",
      title: "Dynamic form",
      description: "test",
      hardwareIntensive: false,
      requiresApproval: false,
      auditIds: [],
      context: {
        prefireForm: {
          fields: [
            { id: "successCriteria", label: "Success criteria", type: "text", required: true },
            { id: "maxIterations", label: "Max iterations", type: "number", required: true },
          ],
          answers: { successCriteria: "done", maxIterations: 5 },
          agentReady: true,
          generatedAt: Date.now(),
        },
      },
    };
    const result = validatePrefire(task);
    expect(result.ok).toBe(true);
  });
});

// ─── H5: doHeartbeatWork respects queue-side running tasks ───────────────────

describe("H5: heartbeat does not race the orchestrator path", () => {
  it("returns didWork:false when any queue task is status:'running'", async () => {
    // Simulate: the gateway orchestrator path already flipped task A to
    // running. currentTask global is null because the orchestrator path
    // does NOT touch it. Without the H5 guard, the heartbeat picks task B
    // and we end up with two concurrent runs.
    queueGetMock.mockReturnValue([
      {
        id: "task_a",
        createdAt: Date.now(),
        priority: "normal",
        status: "running",
        title: "Already running via orchestrator",
        description: "",
        hardwareIntensive: false,
        requiresApproval: false,
        auditIds: [],
      },
      {
        id: "task_b",
        createdAt: Date.now(),
        priority: "normal",
        status: "pending",
        title: "Would be picked second",
        description: "",
        hardwareIntensive: false,
        requiresApproval: false,
        auditIds: [],
      },
    ]);

    const { doHeartbeatWork, setCurrentTask } = await import("./manager.js");
    setCurrentTask(null);

    const result = await doHeartbeatWork();

    expect(result.didWork).toBe(false);
    expect(result.error).toMatch(/Already running/);
    // Cannot have spawned a second task — that was the production failure.
    expect(queueStartMock).not.toHaveBeenCalled();
  });

  it("picks a pending task normally when nothing is running", async () => {
    queueGetMock.mockReturnValue([
      {
        id: "task_pending",
        createdAt: Date.now(),
        priority: "normal",
        status: "pending",
        title: "Pick me",
        description: "",
        hardwareIntensive: false,
        requiresApproval: false,
        auditIds: [],
      },
    ]);
    queueStartMock.mockImplementation((id: string) => ({
      id,
      title: "Pick me",
      status: "running",
    }));

    const { doHeartbeatWork, setCurrentTask } = await import("./manager.js");
    setCurrentTask(null);

    const result = await doHeartbeatWork();

    expect(result.didWork).toBe(true);
    expect(result.task?.id).toBe("task_pending");
    expect(queueStartMock).toHaveBeenCalledWith("task_pending");

    setCurrentTask(null);
  });
});

// ─── Self-heal: 3 consecutive executor failures → task fails ─────────────────
// retryWithBackoff is mocked as a passthrough above so no timer delays needed.
// The loop increments consecutiveFailures each time executeGoalTurn returns an
// error string; after 3, failTask is called.

// PRE-EXISTING SKIP — this test exercises a `kind: "goal"` branch + a
// "self-heal exhausted" code path that the current orchestrator.ts does not
// implement on this branch. Skipping until the goal-mode loop lands in
// orchestrator.ts (tracked separately). The reliability properties this
// test wants to assert are covered for the orchestrator-mode goal turn by
// src/autonomy/autonomy.e2e.test.ts.
describe.skip("goal loop self-heal", () => {
  it("marks goal task failed after 3 consecutive executor errors", async () => {
    const { executeGoalTurn } = await import("./goal-judge.js");
    vi.mocked(executeGoalTurn).mockResolvedValue("(execution error: simulated failure)");

    const { startOrchestratedTask, getRunningOrchestrationsForTests } =
      await import("./orchestrator.js");

    const task: QueuedTask = {
      id: "task_self_heal_test",
      createdAt: Date.now(),
      priority: "normal",
      status: "pending",
      title: "Goal: always fail",
      description: "failing goal",
      hardwareIntensive: false,
      requiresApproval: false,
      auditIds: [],
      kind: "goal",
      goalText: "Do something impossible",
      budget: { maxTurns: 10, turnsUsed: 0 },
    };

    const failTask = vi.fn();

    await startOrchestratedTask(task, {
      spawnSubagent: vi.fn(),
      waitForSubagent: vi.fn(),
      updateTask: vi.fn().mockReturnValue(task),
      completeTask: vi.fn(),
      failTask,
    });

    // Poll until the background loop finishes (passthrough retry means no real delays)
    await vi.waitFor(
      () => {
        expect(getRunningOrchestrationsForTests()).not.toContain(task.id);
      },
      { timeout: 10_000, interval: 20 },
    );

    expect(failTask).toHaveBeenCalledWith(task.id, expect.stringContaining("self-heal exhausted"));
  });
});

// ─── Prefire gate honors prefireRequired === false ───────────────────────────

describe("prefire gate respects prefireRequired:false", () => {
  it("starts a task whose prefire form is incomplete when prefireRequired is false", async () => {
    const { startOrchestratedTask } = await import("./orchestrator.js");

    const task: QueuedTask = {
      id: "task_skip_prefire",
      createdAt: Date.now(),
      priority: "normal",
      status: "pending",
      title: "create canary file",
      description: "Create /tmp/canary.txt with content 'OK'",
      hardwareIntensive: false,
      requiresApproval: false,
      auditIds: [],
      context: {
        prefireRequired: false,
        prefire: {
          // intentionally incomplete — no successCriteria, no testTargets
          completed: false,
        } as unknown as NonNullable<QueuedTask["context"]>["prefire"],
      },
    };

    const spawnMock = vi
      .fn()
      .mockResolvedValue({ runId: "run-skip", childSessionKey: "sess-skip" });
    const res = await startOrchestratedTask(task, {
      spawnSubagent: spawnMock,
      waitForSubagent: vi.fn().mockResolvedValue({ status: "ok", reply: "build complete" }),
      updateTask: vi.fn().mockReturnValue(task),
      completeTask: vi.fn(),
      failTask: vi.fn(),
    });

    expect(res.started).toBe(true);
    await vi.waitFor(
      () => {
        expect(spawnMock).toHaveBeenCalled();
      },
      { timeout: 5_000, interval: 10 },
    );
  });

  it("self-heals when prefireRequired is unset and form is incomplete (NO-BLOCKAGES)", async () => {
    // Updated 2026-05-28: the orchestrator now auto-flips prefireRequired to
    // false rather than refusing to start. The runLoop has deterministic
    // fallbacks for every prefire field so we never strand a task on a
    // missing questionnaire. See startOrchestratedTask → "SELF-HEAL" block.
    const { startOrchestratedTask } = await import("./orchestrator.js");

    const task: QueuedTask = {
      id: "task_require_prefire",
      createdAt: Date.now(),
      priority: "normal",
      status: "pending",
      title: "another canary",
      description: "Create /tmp/other.txt",
      hardwareIntensive: false,
      requiresApproval: false,
      auditIds: [],
      context: {
        // prefireRequired NOT set
        prefire: {
          completed: false,
        } as unknown as NonNullable<QueuedTask["context"]>["prefire"],
      },
    };

    const spawnMock = vi.fn().mockResolvedValue({ runId: "rh", childSessionKey: "sh" });
    const res = await startOrchestratedTask(task, {
      spawnSubagent: spawnMock,
      waitForSubagent: vi.fn().mockResolvedValue({ status: "ok", reply: "ok" }),
      updateTask: vi.fn().mockReturnValue(task),
      completeTask: vi.fn(),
      failTask: vi.fn(),
    });

    expect(res.started).toBe(true);
    expect(task.context?.prefireRequired).toBe(false);
    await vi.waitFor(
      () => {
        expect(spawnMock).toHaveBeenCalled();
      },
      { timeout: 5_000, interval: 10 },
    );
  });
});

// ─── successCriteria synthesis ───────────────────────────────────────────────

describe("synthesizeSuccessCriteria", () => {
  it("uses task description when available", async () => {
    const { synthesizeSuccessCriteria } = await import("./orchestrator.js");
    const task = {
      id: "t1",
      createdAt: Date.now(),
      priority: "normal",
      status: "pending",
      title: "Build login",
      description: "User can sign in via /signin and see /dashboard.",
      hardwareIntensive: false,
      requiresApproval: false,
      auditIds: [],
    } as unknown as QueuedTask;
    const criteria = synthesizeSuccessCriteria(task);
    expect(criteria).toContain("User can sign in");
    expect(criteria.length).toBeGreaterThan(20);
  });

  it("falls back to title when description is empty", async () => {
    const { synthesizeSuccessCriteria } = await import("./orchestrator.js");
    const task = {
      id: "t2",
      createdAt: Date.now(),
      priority: "normal",
      status: "pending",
      title: "Refactor auth",
      description: "",
      hardwareIntensive: false,
      requiresApproval: false,
      auditIds: [],
    } as unknown as QueuedTask;
    expect(synthesizeSuccessCriteria(task)).toContain("Refactor auth");
  });

  it("always returns a non-empty criteria string", async () => {
    const { synthesizeSuccessCriteria } = await import("./orchestrator.js");
    const task = {
      id: "t3",
      createdAt: Date.now(),
      priority: "normal",
      status: "pending",
      title: "",
      description: "",
      hardwareIntensive: false,
      requiresApproval: false,
      auditIds: [],
    } as unknown as QueuedTask;
    expect(synthesizeSuccessCriteria(task).trim().length).toBeGreaterThan(0);
  });
});
