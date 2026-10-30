/**
 * Durable sub-agent survival across a gateway restart.
 *
 * The bug: `interruptAllSubagentRuns()` (called from the gateway close handler)
 * SIGTERM'd every run carrying a `childPid`, so a restart killed all in-flight
 * claude_coder sub-agents. Now that detach mode launches the CLI inside a tmux
 * session, that kill would destroy exactly the work tmux exists to protect.
 *
 * These tests pin the two halves of the contract:
 *   1. shutdown PRESERVES durable runs (no signal, no terminal ledger event)
 *   2. boot recovery REATTACHES a durable run whose tmux session is still live
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => new Promise(() => {})), // agent.wait never resolves
}));

const tmuxLive = { value: true };
vi.mock("../terminal/tmux-backend.js", () => ({
  isTmuxAvailable: vi.fn(() => true),
  hasLiveSessionSync: vi.fn(() => tmuxLive.value),
  tmuxSessionName: (terminalId: string) => `infinibot_${terminalId.replace(/[^a-zA-Z0-9_]/g, "_")}`,
}));

vi.mock("./coder-backend/durable-spawn.js", () => ({
  durableRunDir: (runId: string) => `/tmp/durable/${runId}`,
  isDurableRunAlive: vi.fn(() => tmuxLive.value),
  reattachDurableTmux: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    pid: 5150,
  })),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } } })),
}));
vi.mock("../infra/agent-events.js", () => ({ onAgentEvent: vi.fn(() => () => {}) }));
vi.mock("./subagent-announce.js", () => ({ runSubagentAnnounceFlow: vi.fn(async () => true) }));
vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(),
}));
vi.mock("./subagent-progress.js", () => ({
  initProgressTracking: vi.fn(),
  completeProgress: vi.fn(),
  recordActivity: vi.fn(),
}));
vi.mock("../workload/emitter.js", () => ({
  emitSubagentStarted: vi.fn(),
  emitSubagentCompleted: vi.fn(),
  emitSubagentFailed: vi.fn(),
}));
vi.mock("./timeout.js", () => ({ resolveAgentTimeoutMs: vi.fn(() => 30 * 60_000) }));
vi.mock("./tools/kanban-tool.js", () => ({
  findOrCreateProject: vi.fn(async () => null),
  mcpCreateTask: vi.fn(async () => ({ id: "task-1" })),
  mcpUpdateTask: vi.fn(async () => {}),
}));
vi.mock("./verification-gate.js", () => ({
  verifyAndFinalizeKanban: vi.fn(async () => ({ pass: true, reason: "ok" })),
}));

vi.mock("./spawn-ledger.js", () => ({
  appendSpawnEvent: vi.fn(),
  readSpawnLedger: vi.fn(() => []),
  replayLedgerToRunRecords: vi.fn(() => new Map()),
}));

vi.mock("./subagent-history.js", () => ({ archiveSubagentRun: vi.fn(async () => {}) }));
vi.mock("./coder-runtime/subagent-broadcast.js", () => ({ broadcastSubagentLifecycle: vi.fn() }));
vi.mock("../achievements/gamification.js", () => ({
  getGamificationEngine: vi.fn(() => null),
}));

import { reattachDurableTmux } from "./coder-backend/durable-spawn.js";
import { appendSpawnEvent } from "./spawn-ledger.js";
import {
  addSubagentRunForTests,
  getRunForTests,
  interruptAllSubagentRuns,
  isDurableSubagentRun,
  reconcileSubagentLiveness,
  resetSubagentRegistryForTests,
  resumeRunForTests,
  type SubagentRunRecord,
} from "./subagent-registry.js";

function makeRun(over: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-durable",
    childSessionKey: "agent:coder:child",
    requesterSessionKey: "agent:main",
    requesterDisplayKey: "agent:main",
    task: "long running task",
    label: "durable task",
    cleanup: "delete",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 60_000,
    childPid: 999_999,
    coderBackend: "claude-code",
    ...over,
  } as SubagentRunRecord;
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetSubagentRegistryForTests();
  tmuxLive.value = true;
  vi.mocked(appendSpawnEvent).mockClear();
  vi.mocked(reattachDurableTmux).mockClear();
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  killSpy.mockRestore();
  resetSubagentRegistryForTests();
});

describe("isDurableSubagentRun", () => {
  it("is true for a tmux-backed coder run", () => {
    expect(isDurableSubagentRun(makeRun({ durableSpawn: "tmux-coder" }))).toBe(true);
  });

  it("stays true even when the liveness probe says the session is gone", () => {
    // Erring toward "durable" only skips a kill for an already-dead process;
    // erring the other way kills live work.
    tmuxLive.value = false;
    expect(isDurableSubagentRun(makeRun({ durableSpawn: "tmux-coder" }))).toBe(true);
  });

  it("is true for a terminal-path run whose tmux session is live", () => {
    expect(isDurableSubagentRun(makeRun({ terminalId: "spawn-abc-1" }))).toBe(true);
  });

  it("is false for a legacy direct-child run", () => {
    expect(isDurableSubagentRun(makeRun())).toBe(false);
  });
});

describe("interruptAllSubagentRuns — gateway shutdown", () => {
  it("does NOT signal a durable run", () => {
    addSubagentRunForTests(
      makeRun({ durableSpawn: "tmux-coder", terminalId: "spawn-run-durable" }),
    );
    interruptAllSubagentRuns();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("leaves the durable run in-flight (no endedAt/outcome) for recovery", () => {
    addSubagentRunForTests(makeRun({ durableSpawn: "tmux-coder" }));
    interruptAllSubagentRuns();
    const entry = getRunForTests("run-durable");
    expect(entry?.interruptedAt).toBeTypeOf("number");
    expect(entry?.endedAt).toBeUndefined();
    expect(entry?.outcome).toBeUndefined();
  });

  it("writes no terminal `run.ended` ledger event for a durable run", () => {
    // The ledger replay treats run.ended as final; a durable run has not ended.
    addSubagentRunForTests(makeRun({ durableSpawn: "tmux-coder" }));
    interruptAllSubagentRuns();
    const ended = vi
      .mocked(appendSpawnEvent)
      .mock.calls.filter((c) => (c[0] as { event?: string })?.event === "run.ended");
    expect(ended).toHaveLength(0);
  });

  it("still SIGTERMs a legacy direct-child run", () => {
    addSubagentRunForTests(makeRun({ runId: "run-legacy" }));
    interruptAllSubagentRuns();
    expect(killSpy).toHaveBeenCalledWith(999_999, "SIGTERM");
    const ended = vi
      .mocked(appendSpawnEvent)
      .mock.calls.filter((c) => (c[0] as { event?: string })?.event === "run.ended");
    expect(ended).toHaveLength(1);
  });

  it("preserves the durable run while still interrupting a legacy one in the same sweep", () => {
    addSubagentRunForTests(makeRun({ runId: "run-durable", durableSpawn: "tmux-coder" }));
    addSubagentRunForTests(makeRun({ runId: "run-legacy", childPid: 777_777 }));
    interruptAllSubagentRuns();
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(777_777, "SIGTERM");
  });
});

describe("boot recovery", () => {
  it("reattaches a durable run whose tmux session is still alive", () => {
    addSubagentRunForTests(
      makeRun({
        durableSpawn: "tmux-coder",
        terminalId: "spawn-run-durable",
        interruptedAt: Date.now(),
      }),
    );
    resumeRunForTests("run-durable");
    expect(reattachDurableTmux).toHaveBeenCalledWith("run-durable");
    // Reattached runs are live again, so the restart marker is cleared.
    expect(getRunForTests("run-durable")?.interruptedAt).toBeUndefined();
    expect(getRunForTests("run-durable")?.endedAt).toBeUndefined();
  });

  it("does not reattach — and settles — when the session died while we were down", () => {
    tmuxLive.value = false;
    addSubagentRunForTests(
      makeRun({ durableSpawn: "tmux-coder", terminalId: "spawn-run-durable" }),
    );
    resumeRunForTests("run-durable");
    expect(reattachDurableTmux).not.toHaveBeenCalled();
  });
});

describe("liveness sweep — durable run that exited on its own", () => {
  const dir = "/tmp/durable/run-durable";

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    tmuxLive.value = false;
    // The recorded pane pid is gone.
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a just-exited run to its completion path instead of marking it failed", () => {
    fs.writeFileSync(`${dir}/exit.code`, "0\n");
    addSubagentRunForTests(makeRun({ durableSpawn: "tmux-coder" }));
    expect(reconcileSubagentLiveness()).toBe(0);
    const run = getRunForTests("run-durable");
    expect(run?.endedAt).toBeUndefined();
    expect(run?.outcome).toBeUndefined();
  });

  it("settles from the exit code (not 'without a completion signal') after the grace", () => {
    fs.writeFileSync(`${dir}/exit.code`, "0\n");
    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(`${dir}/exit.code`, old, old);
    addSubagentRunForTests(makeRun({ durableSpawn: "tmux-coder" }));
    reconcileSubagentLiveness();
    const run = getRunForTests("run-durable");
    expect(run?.outcome?.error ?? "").not.toMatch(/without a completion signal/);
  });

  it("still reaps a durable run that died without recording an exit code", () => {
    addSubagentRunForTests(makeRun({ durableSpawn: "tmux-coder" }));
    expect(reconcileSubagentLiveness()).toBe(1);
    expect(getRunForTests("run-durable")?.outcome?.status).toBe("error");
  });
});
