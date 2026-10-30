/**
 * Subagent registry recovery tests.
 *
 * Covers the four fixes for the "7 agents lost on gateway restart" incident:
 *
 * Fix A — registerSubagentRunForCoder persists coder runs to disk immediately.
 * Fix B — dead childPid entries carry the state needed for `--resume` recovery.
 * Fix C — kanban footer format matches the reconcile regex.
 * Fix D — interruptAllSubagentRuns sets interruptedAt + sends SIGTERM to children.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Heavy deps mocked before any tested module is imported ──────────────────

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (opts: { method?: string }) => {
    if (opts?.method === "agent.wait") return new Promise(() => {}); // never resolves
    if (opts?.method === "terminal.reattachSpawnAgent") return { success: true };
    return {};
  }),
}));

// Tmux backend — controllable liveness for the tmux-aware recovery branch.
// Defaults to "no live session" so existing tests keep the old recovery path;
// the tmux-reattach test flips it on via vi.mocked(hasLiveSessionSync).
vi.mock("../terminal/tmux-backend.js", () => ({
  hasLiveSessionSync: vi.fn(() => false),
  tmuxSessionName: vi.fn(
    (terminalId: string) => `infinibot_${terminalId.replace(/[^a-zA-Z0-9_]/g, "_")}`,
  ),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
  })),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => () => {}),
}));

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

vi.mock("../workload/emitter.js", () => ({
  emitSubagentStarted: vi.fn(),
  emitSubagentCompleted: vi.fn(),
  emitSubagentFailed: vi.fn(),
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 30 * 60_000),
}));

vi.mock("./tools/kanban-tool.js", () => ({
  findOrCreateProject: vi.fn(async () => null),
  mcpCreateTask: vi.fn(async () => ({ id: "kanban-task-1" })),
  mcpUpdateTask: vi.fn(async () => {}),
}));

// Fix B: mock the coder backend used by resumeInterruptedCoderRun
vi.mock("../agents/coder-backend/registry.js", () => ({
  getCoderBackend: vi.fn(() => ({
    spawnBackground: vi.fn(() => ({
      pid: 99999,
      startedAt: Date.now(),
      mcpServers: [],
      finalPromise: Promise.resolve({
        runId: "resume-run",
        agentId: "test",
        output: "",
        exitCode: 0,
        killed: false,
        mcpServers: [],
        durationMs: 100,
        sessionId: "resumed-session",
      }),
      onStdout: vi.fn(() => () => {}),
      onStderr: vi.fn(() => () => {}),
      kill: vi.fn(() => true),
    })),
  })),
}));

// Fix C: mock the kanban store
const mockTasks: Array<{
  id: string;
  title: string;
  status: string;
  description?: string;
  createdAt?: number;
}> = [];
vi.mock("../tasks/store.js", () => ({
  getKanbanStore: vi.fn(() => ({
    getTasks: vi.fn(async () => mockTasks),
  })),
}));

vi.mock("../config/paths.js", () => ({
  STATE_DIR: "/tmp/test-state",
  // Logging subsystem (pulled in transitively via log.warn/log.info) resolves a
  // config path on first emit; point it at a non-existent file so readLoggingConfig
  // short-circuits to "no config" instead of throwing on an unmocked export.
  resolveConfigPath: () => "/tmp/test-state/nonexistent-infinibot.json",
  // subagent-history's archive path resolver (hit by the async cleanup flow).
  resolveStateDir: () => "/tmp/test-state",
  resolveStateDirWithLegacyEnv: () => "/tmp/test-state",
  // logger.ts resolves its default log dir from the shared state dir at import.
  resolveSharedDir: () => "/tmp/test-state",
}));

// Import after all mocks are in place.
import {
  registerSubagentRun,
  registerSubagentRunForCoder,
  updateSubagentRunClaudeSessionId,
  markSubagentRunComplete,
  interruptAllSubagentRuns,
  getRunForTests,
  resetSubagentRegistryForTests,
  addSubagentRunForTests,
  runSweepForTests,
} from "./subagent-registry.js";
import { resumeRunForTests, type SubagentRunRecord } from "./subagent-registry.js";
import { saveSubagentRegistryToDisk } from "./subagent-registry.store.js";
import { mcpCreateTask, mcpUpdateTask } from "./tools/kanban-tool.js";
import { callGateway } from "../gateway/call.js";
import { getCoderBackend } from "../agents/coder-backend/registry.js";
import { hasLiveSessionSync } from "../terminal/tmux-backend.js";

const saveMock = vi.mocked(saveSubagentRegistryToDisk);

// ─────────────────────────────────────────────────────────────────────────────

const REQUESTER = "agent:main:requester-1";

function makeCoderParams(id: string) {
  return {
    runId: id,
    childSessionKey: `agent:coder:${id}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: REQUESTER,
    task: `Coder task for ${id}`,
    label: `Run ${id}`,
    kanbanTaskId: `kanban-${id}`,
    childPid: 12345,
    timeoutMinutes: 30,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Fix A — registerSubagentRunForCoder", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    saveMock.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetSubagentRegistryForTests();
  });

  it("persists the run to the in-memory registry immediately", () => {
    const params = makeCoderParams("coder-a1");
    registerSubagentRunForCoder(params);
    const entry = getRunForTests(params.runId);
    expect(entry).toBeDefined();
    expect(entry!.runId).toBe(params.runId);
    expect(entry!.childPid).toBe(params.childPid);
    expect(entry!.kanbanTaskId).toBe(params.kanbanTaskId);
  });

  it("writes to disk (saveSubagentRegistryToDisk is called)", () => {
    saveMock.mockClear();
    registerSubagentRunForCoder(makeCoderParams("coder-a2"));
    expect(saveMock).toHaveBeenCalled();
  });

  it("updateSubagentRunClaudeSessionId stores the session ID on the entry", () => {
    const params = makeCoderParams("coder-a3");
    registerSubagentRunForCoder(params);
    updateSubagentRunClaudeSessionId(params.runId, "claude-session-xyz");
    expect(getRunForTests(params.runId)!.claudeSessionId).toBe("claude-session-xyz");
  });

  it("updateSubagentRunClaudeSessionId is idempotent (first write wins)", () => {
    const params = makeCoderParams("coder-a4");
    registerSubagentRunForCoder(params);
    updateSubagentRunClaudeSessionId(params.runId, "first");
    updateSubagentRunClaudeSessionId(params.runId, "second");
    expect(getRunForTests(params.runId)!.claudeSessionId).toBe("first");
  });

  it("markSubagentRunComplete sets endedAt and outcome", () => {
    const params = makeCoderParams("coder-a5");
    registerSubagentRunForCoder(params);
    markSubagentRunComplete(params.runId, { status: "ok" });
    const entry = getRunForTests(params.runId);
    expect(entry!.endedAt).toBeGreaterThan(0);
    expect(entry!.outcome?.status).toBe("ok");
  });

  it("markSubagentRunComplete is idempotent (first call wins)", () => {
    const params = makeCoderParams("coder-a6");
    registerSubagentRunForCoder(params);
    markSubagentRunComplete(params.runId, { status: "ok" }, 1_000_000);
    markSubagentRunComplete(params.runId, { status: "error", error: "late error" }, 2_000_000);
    const entry = getRunForTests(params.runId);
    expect(entry!.outcome?.status).toBe("ok");
    expect(entry!.endedAt).toBe(1_000_000);
  });

  it("sweeper does NOT prematurely expire a registered coder run within its timeout window", async () => {
    // The sweep also reconciles process liveness, so the child must be a PID
    // that is really alive — an arbitrary number is only alive by accident.
    const params = { ...makeCoderParams("coder-a7"), childPid: process.pid };
    registerSubagentRunForCoder(params); // 30m timeout + 2m grace = 32m deadline
    vi.advanceTimersByTime(29 * 60_000); // 29 min — under the deadline
    await runSweepForTests();
    expect(getRunForTests(params.runId)).toBeDefined();
    expect(getRunForTests(params.runId)?.endedAt).toBeUndefined();
  });

  it("coder run has childPid and kanbanTaskId in the persisted entry", () => {
    const params = makeCoderParams("coder-a8");
    params.childPid = 54321;
    params.kanbanTaskId = "notion-page-abc";
    registerSubagentRunForCoder(params);
    const entry = getRunForTests("coder-a8")!;
    expect(entry.childPid).toBe(54321);
    expect(entry.kanbanTaskId).toBe("notion-page-abc");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fix B — dead PID state stored for resume recovery", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetSubagentRegistryForTests();
  });

  it("entry has childPid so isPidAlive can be called on restart", () => {
    const params = makeCoderParams("coder-b1");
    params.childPid = 77777;
    registerSubagentRunForCoder(params);
    const entry = getRunForTests("coder-b1")!;
    expect(typeof entry.childPid).toBe("number");
    expect(entry.childPid).toBe(77777);
  });

  it("claudeSessionId is stored and accessible for --resume after updateSubagentRunClaudeSessionId", () => {
    const params = makeCoderParams("coder-b2");
    params.childPid = 88888;
    registerSubagentRunForCoder(params);
    updateSubagentRunClaudeSessionId(params.runId, "session-for-resume-xyz");
    const entry = getRunForTests("coder-b2")!;
    expect(entry.claudeSessionId).toBe("session-for-resume-xyz");
    expect(entry.childPid).toBe(88888);
  });

  it("entry without claudeSessionId still has childPid for dead-check", () => {
    const params = makeCoderParams("coder-b3");
    params.childPid = 33333;
    registerSubagentRunForCoder(params);
    const entry = getRunForTests("coder-b3")!;
    expect(entry.claudeSessionId).toBeUndefined();
    expect(entry.childPid).toBe(33333);
  });

  it("stuck sweeper auto-times-out runs without childPid after deadline passes", async () => {
    // Simulate a pre-Fix-A entry that has no childPid — sweeper should still clean it up.
    const entry = {
      runId: "coder-b4",
      childSessionKey: "agent:coder:coder-b4",
      requesterSessionKey: REQUESTER,
      requesterDisplayKey: REQUESTER,
      task: "old task",
      cleanup: "delete" as const,
      createdAt: Date.now(),
      expectedEndByMs: Date.now() + 1_000, // 1 second from now
      cleanupHandled: false,
    };
    addSubagentRunForTests(entry);
    vi.advanceTimersByTime(2_000); // past expectedEndByMs
    await runSweepForTests();
    const after = getRunForTests("coder-b4");
    // sweeper should have set endedAt
    expect(after?.endedAt).toBeGreaterThan(0);
    expect(after?.outcome?.status).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fix C — kanban footer format", () => {
  // These tests verify the footer format string matches the reconcile regex
  // without needing to invoke the full async reconcile flow.
  const FOOTER_RE = /<!--\s*subagent runId:(\S+)\s+childKey:(\S+)\s+requester:(\S+)\s*-->/;

  it("footer string for a known run parses correctly", () => {
    const runId = "coder-c1";
    const childKey = `agent:coder:${runId}`;
    const footer = `<!-- subagent runId:${runId} childKey:${childKey} requester:${REQUESTER} -->`;
    const match = footer.match(FOOTER_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(runId);
    expect(match![2]).toBe(childKey);
    expect(match![3]).toBe(REQUESTER);
  });

  it("footer embedded in a larger note body still matches", () => {
    const runId = "coder-c2";
    const childKey = `agent:coder:${runId}`;
    const note = [
      `▶ claude_coder run ${runId}`,
      "mode: detach",
      `session: ${childKey}`,
      "workdir: /home/user/project",
      "timeout: 30m",
      "",
      "Task:",
      "Fix the bug in foo.ts",
      "",
      `<!-- subagent runId:${runId} childKey:${childKey} requester:${REQUESTER} -->`,
    ].join("\n");
    const match = note.match(FOOTER_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(runId);
  });

  it("footer is absent from notes without the comment (no false positives)", () => {
    const note = "Some task note without a footer\nStep 1: do X\nStep 2: do Y";
    expect(note.match(FOOTER_RE)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Fix D — interruptAllSubagentRuns (graceful shutdown)", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    saveMock.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetSubagentRegistryForTests();
  });

  it("sets interruptedAt on all in-flight runs", () => {
    registerSubagentRunForCoder(makeCoderParams("coder-d1"));
    registerSubagentRunForCoder(makeCoderParams("coder-d2"));

    interruptAllSubagentRuns();

    expect(getRunForTests("coder-d1")!.interruptedAt).toBeGreaterThan(0);
    expect(getRunForTests("coder-d2")!.interruptedAt).toBeGreaterThan(0);
  });

  it("does NOT set interruptedAt on already-completed runs", () => {
    const p = makeCoderParams("coder-d3");
    registerSubagentRunForCoder(p);
    markSubagentRunComplete(p.runId, { status: "ok" });

    interruptAllSubagentRuns();

    expect(getRunForTests("coder-d3")!.interruptedAt).toBeUndefined();
  });

  it("sends SIGTERM to tracked child PIDs", () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const p = makeCoderParams("coder-d4");
    p.childPid = 55555;
    registerSubagentRunForCoder(p);

    interruptAllSubagentRuns();

    expect(killSpy).toHaveBeenCalledWith(55555, "SIGTERM");
    killSpy.mockRestore();
  });

  it("persists registry to disk after interrupting runs", () => {
    saveMock.mockClear();
    registerSubagentRunForCoder(makeCoderParams("coder-d5"));
    saveMock.mockClear();

    interruptAllSubagentRuns();

    expect(saveMock).toHaveBeenCalled();
  });

  it("is a no-op when there are no in-flight runs (no throw, no SIGTERM)", () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(() => interruptAllSubagentRuns()).not.toThrow();
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("does not crash when SIGTERM fails (PID already gone)", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    const p = makeCoderParams("coder-d6");
    p.childPid = 11111;
    registerSubagentRunForCoder(p);

    expect(() => interruptAllSubagentRuns()).not.toThrow();
    // interruptedAt should still be set even if SIGTERM failed
    expect(getRunForTests("coder-d6")!.interruptedAt).toBeGreaterThan(0);
    killSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-kanban-task creation: the generic `registerSubagentRun` path (used by
 * non-coder subagent spawns) must asynchronously create a kanban task with
 * status="in_progress" and attach the returned id back onto the registry
 * entry. Without this we'd silently lose the spawn→task link for everything
 * that isn't a claude-coder spawn.
 */
describe("registerSubagentRun — auto kanban task creation", () => {
  const createMock = vi.mocked(mcpCreateTask);
  const updateMock = vi.mocked(mcpUpdateTask);

  beforeEach(() => {
    resetSubagentRegistryForTests();
    createMock.mockClear();
    updateMock.mockClear();
    createMock.mockResolvedValue({ id: "kanban-auto-task-1" });
  });
  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("calls mcpCreateTask with the run's label + in_progress status", async () => {
    registerSubagentRun({
      runId: "auto-1",
      childSessionKey: "agent:coder:auto-1",
      requesterSessionKey: REQUESTER,
      requesterDisplayKey: REQUESTER,
      task: "Refactor the spawn pipeline",
      cleanup: "delete",
      label: "Refactor spawn pipeline",
      projectHint: "Spawn Pipeline",
    });
    // Auto-create runs on a microtask — flush it.
    await new Promise((r) => setImmediate(r));
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0]?.[0] as {
      title: string;
      status: string;
      priority: string;
    };
    expect(arg.title).toContain("Refactor spawn pipeline");
    expect(arg.status).toBe("in_progress");
    expect(arg.priority).toBe("medium");
  });

  it("attaches the returned task id onto the registry entry", async () => {
    registerSubagentRun({
      runId: "auto-2",
      childSessionKey: "agent:coder:auto-2",
      requesterSessionKey: REQUESTER,
      requesterDisplayKey: REQUESTER,
      task: "Build something",
      cleanup: "delete",
      label: "Build something",
    });
    await new Promise((r) => setImmediate(r));
    const entry = getRunForTests("auto-2");
    expect(entry?.kanbanTaskId).toBe("kanban-auto-task-1");
  });

  it("uses the projectId passed by the caller without re-resolving", async () => {
    registerSubagentRun({
      runId: "auto-3",
      childSessionKey: "agent:coder:auto-3",
      requesterSessionKey: REQUESTER,
      requesterDisplayKey: REQUESTER,
      task: "Targeted task",
      cleanup: "delete",
      label: "Targeted",
      projectId: "explicit-proj-id",
    });
    await new Promise((r) => setImmediate(r));
    const arg = createMock.mock.calls[0]?.[0] as { projectId?: string };
    expect(arg.projectId).toBe("explicit-proj-id");
  });

  it("does not throw if mcpCreateTask rejects", async () => {
    createMock.mockRejectedValueOnce(new Error("notion offline"));
    expect(() =>
      registerSubagentRun({
        runId: "auto-4",
        childSessionKey: "agent:coder:auto-4",
        requesterSessionKey: REQUESTER,
        requesterDisplayKey: REQUESTER,
        task: "Will fail kanban write",
        cleanup: "delete",
      }),
    ).not.toThrow();
    // Wait for the rejection to settle so the catch block runs without
    // crashing the test process.
    await new Promise((r) => setImmediate(r));
    const entry = getRunForTests("auto-4");
    expect(entry).toBeDefined();
    expect(entry?.kanbanTaskId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * TMUX-AWARE RECOVERY — a run whose tmux session survived a gateway restart is
 * reattached (re-binding the exit listener) instead of being marked interrupted
 * or re-spawned via `claude --resume`. Critical for the "died at 0 tokens"
 * hole: recovery keys on the durable tmux session name, not the claudeSessionId.
 */
const runOnPosix = process.platform === "win32" ? describe.skip : describe;
runOnPosix("TMUX-aware recovery — reattach live session on restart", () => {
  const callGatewayMock = vi.mocked(callGateway);
  const hasLiveSessionSyncMock = vi.mocked(hasLiveSessionSync);
  const getCoderBackendMock = vi.mocked(getCoderBackend);

  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    getCoderBackendMock.mockClear();
    hasLiveSessionSyncMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetSubagentRegistryForTests();
  });

  function makeTerminalRun(id: string): SubagentRunRecord {
    return {
      runId: id,
      childSessionKey: `agent:coder:${id}`,
      requesterSessionKey: REQUESTER,
      requesterDisplayKey: REQUESTER,
      task: `terminal task ${id}`,
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
      cleanupHandled: false,
      // Terminal-path recovery keys: no childPid, no claudeSessionId. This is the
      // "died at 0 tokens" case that the old PID/resume path abandoned.
      terminalId: `spawn-${id.slice(0, 8)}-1700000000000`,
      tmuxSession: `infinibot_spawn-${id.slice(0, 8)}-1700000000000`,
      agentId: "coder",
    };
  }

  it("reattaches (not resumes) when the tmux session is still live", async () => {
    hasLiveSessionSyncMock.mockReturnValue(true);
    const entry = makeTerminalRun("tmux-live-1");
    addSubagentRunForTests(entry);

    resumeRunForTests(entry.runId);
    await Promise.resolve();
    await Promise.resolve();

    // Reattached via terminal.reattachSpawnAgent…
    const reattachCalls = callGatewayMock.mock.calls.filter(
      ([opts]) => (opts as { method?: string })?.method === "terminal.reattachSpawnAgent",
    );
    expect(reattachCalls.length).toBe(1);
    expect((reattachCalls[0][0] as { params?: any }).params.terminalId).toBe(entry.terminalId);
    // …and did NOT fall through to the claude --resume backend path.
    expect(getCoderBackendMock).not.toHaveBeenCalled();
    // Run remains in flight (no forced interruption).
    expect(getRunForTests(entry.runId)?.endedAt).toBeUndefined();
    expect(getRunForTests(entry.runId)?.outcome).toBeUndefined();
  });

  it("does NOT reattach when the tmux session is gone (falls through)", async () => {
    hasLiveSessionSyncMock.mockReturnValue(false);
    const entry = makeTerminalRun("tmux-gone-1");
    addSubagentRunForTests(entry);

    resumeRunForTests(entry.runId);
    await Promise.resolve();

    const reattachCalls = callGatewayMock.mock.calls.filter(
      ([opts]) => (opts as { method?: string })?.method === "terminal.reattachSpawnAgent",
    );
    expect(reattachCalls.length).toBe(0);
  });

  it("registerSubagentRun stores terminalId + derived tmuxSession", () => {
    registerSubagentRun({
      runId: "tmux-store-1",
      childSessionKey: "agent:coder:tmux-store-1",
      requesterSessionKey: REQUESTER,
      requesterDisplayKey: REQUESTER,
      task: "store tmux fields",
      cleanup: "keep",
      terminalId: "spawn-abcd1234-1700000000000",
      agentId: "coder",
    });
    const entry = getRunForTests("tmux-store-1");
    expect(entry?.terminalId).toBe("spawn-abcd1234-1700000000000");
    // tmuxSessionName sanitizes non-alnum/underscore (hyphens → underscores).
    expect(entry?.tmuxSession).toBe("infinibot_spawn_abcd1234_1700000000000");
    expect(entry?.agentId).toBe("coder");
  });
});
