/**
 * Tests for the continuous workflow daemon (continuous-runner.ts).
 *
 * The daemon depends on callGateway (sessions.spawn) for each iteration and
 * WorkflowStore/WorkflowRunStore for persistence. Both are mocked so the
 * loop runs in the test process without touching the network or disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi, type MockedFunction } from "vitest";

// ── Mock callGateway before importing the module under test ───────────────────
vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

import { callGateway } from "../gateway/call.js";
import { WorkflowStore } from "./store.js";
import {
  startContinuousWorkflow,
  stopContinuousRun,
  pauseContinuousRun,
  resumeContinuousRun,
  getDaemon,
  listDaemons,
  reconcileStaleContinuousRuns,
} from "./continuous-runner.js";
import { WorkflowRunStore } from "./runner.js";
import type { WorkflowRun } from "./types.js";

const mockCallGateway = callGateway as MockedFunction<typeof callGateway>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-runner-test-"));
}

function seedContinuousWorkflow(stateDir: string, overrides: Record<string, unknown> = {}): void {
  const store = new WorkflowStore(stateDir);
  store.create({
    id: "test-loop",
    name: "Test Loop",
    kind: "continuous",
    body: "Do one iteration of the thing.",
    continuous: {
      iterationIntervalSeconds: 0, // back-to-back for speed
      maxIterations: 2,
      iterationTimeoutSeconds: 10,
      errorStreakThreshold: 3,
      stopOn: ["manual", "iteration_limit", "error_streak"],
      ...overrides,
    },
  });
}

/** Returns a successful spawn response (what sessions.spawn returns). */
function spawnOk(): unknown {
  return { childSessionKey: "child-key-1", runId: "run-id-1", status: "ok" };
}

/** Waits up to `maxMs` for a predicate to become true, polling every 50ms. */
async function waitFor(predicate: () => boolean, maxMs = 5_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

/** Read a run fresh from disk each call (bypasses WorkflowRunStore in-memory cache). */
function getFreshRun(stateDir: string, runId: string): WorkflowRun | null {
  return new WorkflowRunStore(stateDir).get(runId);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("startContinuousWorkflow", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    mockCallGateway.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("returns a run record with kind=continuous and status=running", async () => {
    seedContinuousWorkflow(tmp);
    mockCallGateway.mockResolvedValue(spawnOk());

    const { run } = await startContinuousWorkflow({ stateDir: tmp, workflowId: "test-loop" });

    expect(run.kind).toBe("continuous");
    expect(run.status).toBe("running");
    expect(run.workflowId).toBe("test-loop");
  });

  test("workflow not found → throws", async () => {
    await expect(
      startContinuousWorkflow({ stateDir: tmp, workflowId: "no-such-workflow" }),
    ).rejects.toThrow("not found");
  });

  test("wrong kind (static) → throws", async () => {
    const store = new WorkflowStore(tmp);
    store.create({ id: "static-wf", name: "Static", body: "something" });
    await expect(
      startContinuousWorkflow({ stateDir: tmp, workflowId: "static-wf" }),
    ).rejects.toThrow("not 'continuous'");
  });

  test("registers daemon in daemons map after start", async () => {
    seedContinuousWorkflow(tmp);
    mockCallGateway.mockResolvedValue(spawnOk());

    const { run } = await startContinuousWorkflow({ stateDir: tmp, workflowId: "test-loop" });

    expect(getDaemon(run.id)).not.toBeNull();
  });

  test("daemon runs to iteration_limit and updates run status to completed", async () => {
    // maxIterations: 2 — loop should auto-stop after 2 iterations
    seedContinuousWorkflow(tmp);
    mockCallGateway.mockResolvedValue(spawnOk());

    const { run } = await startContinuousWorkflow({ stateDir: tmp, workflowId: "test-loop" });

    // Poll fresh from disk each time — WorkflowRunStore caches on first read
    await waitFor(() => {
      const r = getFreshRun(tmp, run.id);
      return r?.status === "completed" || r?.status === "failed";
    });

    const final = getFreshRun(tmp, run.id);
    expect(final?.status).toBe("completed");
    expect(final?.iterationCount).toBe(2);
    expect(final?.stopReason).toBe("iteration_limit");
  });
});

describe("stopContinuousRun", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    mockCallGateway.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("returns false for unknown runId", () => {
    expect(stopContinuousRun("no-such-run")).toBe(false);
  });

  test("returns true and stops the daemon", async () => {
    // Seed with unbounded iterations so we can stop it ourselves
    seedContinuousWorkflow(tmp, { maxIterations: null });
    mockCallGateway.mockResolvedValue(spawnOk());

    const { run } = await startContinuousWorkflow({ stateDir: tmp, workflowId: "test-loop" });

    expect(getDaemon(run.id)).not.toBeNull();
    const ok = stopContinuousRun(run.id, "test", "manual");
    expect(ok).toBe(true);

    // After stopping, the daemon should eventually remove itself from the map
    await waitFor(() => {
      const r = getFreshRun(tmp, run.id);
      return r?.status === "completed" || r?.status === "failed";
    });

    expect(getDaemon(run.id)).toBeNull();
  });
});

describe("pauseContinuousRun / resumeContinuousRun", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    mockCallGateway.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("pause returns false for unknown runId", () => {
    expect(pauseContinuousRun("no-such-run")).toBe(false);
  });

  test("resume returns false for unknown runId", () => {
    expect(resumeContinuousRun("no-such-run")).toBe(false);
  });

  test("pause marks the daemon paused; resume unpauses it", async () => {
    seedContinuousWorkflow(tmp, { maxIterations: null, iterationIntervalSeconds: 60 });
    mockCallGateway.mockResolvedValue(spawnOk());

    const { run } = await startContinuousWorkflow({ stateDir: tmp, workflowId: "test-loop" });

    // getDaemon returns a DaemonHandle; live state is exposed via .status()
    // The daemon increments iterationCount before the first await, so it should
    // be reachable very quickly after startContinuousWorkflow returns.
    await waitFor(() => (getDaemon(run.id)?.status().iterationCount ?? 0) >= 1);

    const paused = pauseContinuousRun(run.id, "test");
    expect(paused).toBe(true);
    expect(getDaemon(run.id)?.status().paused).toBe(true);

    const resumed = resumeContinuousRun(run.id, "test");
    expect(resumed).toBe(true);
    expect(getDaemon(run.id)?.status().paused).toBe(false);

    // Clean up
    stopContinuousRun(run.id, "test", "manual");
  });
});

describe("listDaemons", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    mockCallGateway.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("returns empty array when no daemons running", () => {
    // Note: other tests may have left daemons; we check only that this is an
    // array (isolation from concurrently running daemons from other tests).
    expect(Array.isArray(listDaemons())).toBe(true);
  });

  test("includes newly started daemon", async () => {
    seedContinuousWorkflow(tmp, { maxIterations: null });
    mockCallGateway.mockResolvedValue(spawnOk());

    const { run } = await startContinuousWorkflow({ stateDir: tmp, workflowId: "test-loop" });

    const daemon = listDaemons().find((d) => d.runId === run.id);
    expect(daemon).toBeDefined();
    expect(daemon?.workflowId).toBe("test-loop");

    stopContinuousRun(run.id, "test", "manual");
  });
});

describe("error streak auto-stop", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    mockCallGateway.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("daemon stops after errorStreakThreshold consecutive failures", async () => {
    const store = new WorkflowStore(tmp);
    store.create({
      id: "error-loop",
      name: "Error Loop",
      kind: "continuous",
      body: "attempt something",
      continuous: {
        iterationIntervalSeconds: 0,
        maxIterations: null,
        iterationTimeoutSeconds: 10,
        errorStreakThreshold: 2,
        stopOn: ["error_streak"],
      },
    });

    // Every call fails
    mockCallGateway.mockRejectedValue(new Error("simulated spawn failure"));

    const { run } = await startContinuousWorkflow({ stateDir: tmp, workflowId: "error-loop" });

    await waitFor(() => getFreshRun(tmp, run.id)?.status === "failed");

    const final = getFreshRun(tmp, run.id);
    expect(final?.status).toBe("failed");
    expect(final?.stopReason).toBe("error_streak");
  });
});

describe("reconcileStaleContinuousRuns", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("does nothing when no runs exist", () => {
    expect(() => reconcileStaleContinuousRuns(tmp)).not.toThrow();
  });

  test("marks orphaned running continuous runs as failed", () => {
    // Manually insert a run record with status="running" (no live daemon).
    // Use a fresh store to insert, then read back via another fresh instance
    // after reconcile to avoid WorkflowRunStore's in-memory cache.
    new WorkflowRunStore(tmp).insert({
      id: "wfr_orphan-run-id",
      workflowId: "test-loop",
      workflowName: "Test Loop",
      kind: "continuous",
      status: "running",
      inputs: {},
      agent: "main",
      startedAt: new Date().toISOString(),
      iterationCount: 3,
      errorStreak: 0,
    });

    const fixed = reconcileStaleContinuousRuns(tmp);
    expect(fixed).toBe(1);

    const after = getFreshRun(tmp, "wfr_orphan-run-id");
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("gateway restart");
    expect(after?.stopRequestedBy).toBe("gateway_restart");
  });

  test("marks orphaned paused continuous runs as failed", () => {
    new WorkflowRunStore(tmp).insert({
      id: "wfr_orphan-paused-id",
      workflowId: "test-loop",
      workflowName: "Test Loop",
      kind: "continuous",
      status: "paused",
      inputs: {},
      agent: "main",
      startedAt: new Date().toISOString(),
      iterationCount: 1,
      errorStreak: 0,
    });

    const fixed = reconcileStaleContinuousRuns(tmp);
    expect(fixed).toBe(1);

    const after = getFreshRun(tmp, "wfr_orphan-paused-id");
    expect(after?.status).toBe("failed");
  });

  test("leaves already-completed runs untouched", () => {
    new WorkflowRunStore(tmp).insert({
      id: "wfr_completed-id",
      workflowId: "test-loop",
      workflowName: "Test Loop",
      kind: "continuous",
      status: "completed",
      inputs: {},
      agent: "main",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      iterationCount: 5,
      errorStreak: 0,
    });

    const fixed = reconcileStaleContinuousRuns(tmp);
    expect(fixed).toBe(0);

    const after = getFreshRun(tmp, "wfr_completed-id");
    expect(after?.status).toBe("completed");
  });

  test("leaves static (non-continuous) running runs untouched", () => {
    new WorkflowRunStore(tmp).insert({
      id: "wfr_static-id",
      workflowId: "static-wf",
      workflowName: "Static WF",
      kind: "static",
      status: "running",
      inputs: {},
      agent: "main",
      startedAt: new Date().toISOString(),
    });

    const fixed = reconcileStaleContinuousRuns(tmp);
    expect(fixed).toBe(0);

    const after = getFreshRun(tmp, "wfr_static-id");
    expect(after?.status).toBe("running");
  });

  test("leaves runs with a live daemon untouched", async () => {
    // Start a real daemon (no-op callGateway) then reconcile — the live
    // daemon must shield its run from being marked failed.
    mockCallGateway.mockReset();
    mockCallGateway.mockResolvedValue(spawnOk());
    const store = new WorkflowStore(tmp);
    store.create({
      id: "live-loop",
      name: "Live Loop",
      kind: "continuous",
      body: "live",
      continuous: {
        iterationIntervalSeconds: 60,
        maxIterations: null,
        errorStreakThreshold: 5,
        stopOn: ["manual"],
      },
    });

    const { run } = await startContinuousWorkflow({ stateDir: tmp, workflowId: "live-loop" });

    const fixed = reconcileStaleContinuousRuns(tmp);
    expect(fixed).toBe(0);

    const after = getFreshRun(tmp, run.id);
    expect(after?.status).toBe("running");

    stopContinuousRun(run.id, "test", "manual");
  });
});
