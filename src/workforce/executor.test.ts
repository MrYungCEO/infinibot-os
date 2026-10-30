import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EXECUTION_STAGE,
  WorkItemExecutor,
  composeWorkItemPrompt,
  createWorkItemExecutorConfig,
  decideAutonomy,
  describeWorkItemExecution,
  isExecutionEligibleStage,
  listExecutionEligibleWorkItems,
  resolveBackendForBinding,
  sopCandidatePaths,
  type CoderSpawnFn,
  type WorkItemExecutorConfig,
} from "./executor.js";
import { WorkforceOperatingStore } from "./operating-store.js";
import { WorkforceStore } from "./store.js";
import type { Worker } from "./types.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const AGENCY = "agency-1";

let tempDir: string;
let workforce: WorkforceStore;
let operating: WorkforceOperatingStore;

function makeWorker(overrides: Partial<Worker> & { id: string }): Worker {
  const created = workforce.createWorker(
    {
      id: overrides.id,
      agencyId: AGENCY,
      type: overrides.type ?? "ai",
      displayName: overrides.displayName ?? "Dev",
      title: "Back End Developer",
      employmentStatus: overrides.employmentStatus ?? "active",
      employmentType: "agent",
      agentId: overrides.agentId ?? overrides.id,
      modelBinding: overrides.modelBinding ?? "codex",
      persona: overrides.persona ?? "Ships small reviewable diffs.",
      goals: overrides.goals ?? ["Automate every repeatable step"],
      kpis: overrides.kpis ?? ["test pass rate"],
      autonomyLevel: overrides.autonomyLevel ?? 3,
      approvalThreshold: overrides.approvalThreshold ?? 500,
      sopPath: overrides.sopPath ?? "agents/coder.yaml",
      workspacePath: overrides.workspacePath ?? "agencies/agency-1/agents/coder",
      capabilities: ["backend-implementation"],
    },
    "tester",
  );
  return created;
}

/** Enqueue a card and stage it into the execution column, like a human would. */
function stageWorkItem(workerId: string, extra: Record<string, unknown> = {}) {
  const item = operating.enqueueWorkItem(AGENCY, {
    workerId,
    title: "Ship the invoice importer",
    instructions: "Implement the CSV importer and add tests.",
    ...extra,
  });
  return operating.transitionWorkItem(AGENCY, item.id, "accepted");
}

function enabledConfig(overrides: Partial<WorkItemExecutorConfig> = {}): WorkItemExecutorConfig {
  return { ...createWorkItemExecutorConfig({ executeWorkItems: true }), ...overrides };
}

/** A spawn that always succeeds. NEVER touches a real CLI. */
const okSpawn = (output = "done: importer shipped"): CoderSpawnFn =>
  vi.fn(async () => ({ output, exitCode: 0 }));

function makeExecutor(config: WorkItemExecutorConfig, spawn: CoderSpawnFn, extra = {}) {
  return new WorkItemExecutor({
    operatingStore: operating,
    workerStore: workforce,
    config,
    workspaceRoot: tempDir,
    spawn,
    readSop: () => null,
    directoryExists: () => false,
    ...extra,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wf-exec-"));
  const dbPath = join(tempDir, "agency.db");
  workforce = new WorkforceStore(dbPath);
  operating = new WorkforceOperatingStore(dbPath);
});

afterEach(() => {
  operating.close();
  workforce.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ── pure helpers ────────────────────────────────────────────────────────────

describe("resolveBackendForBinding", () => {
  it.each([
    ["claude", "claude-code"],
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["gemini", "gemini"],
    ["anthropic/claude-opus-4-6", "claude-code"],
    ["claude-sonnet-4-6", "claude-code"],
  ])("maps %s -> %s", (binding, expected) => {
    expect(resolveBackendForBinding(binding)).toBe(expected);
  });

  it("falls back for empty or unknown bindings", () => {
    expect(resolveBackendForBinding(null, "codex")).toBe("codex");
    expect(resolveBackendForBinding("some-unknown-model", "opencode")).toBe("opencode");
  });
});

describe("execution stage", () => {
  it("only accepts the staged column", () => {
    expect(EXECUTION_STAGE).toBe("accepted");
    expect(isExecutionEligibleStage("accepted")).toBe(true);
    expect(isExecutionEligibleStage("queued")).toBe(false);
    expect(isExecutionEligibleStage("in_progress")).toBe(false);
    expect(isExecutionEligibleStage("review")).toBe(false);
  });
});

describe("decideAutonomy", () => {
  const item = { context: {} };
  it("never executes level 0", () => {
    expect(decideAutonomy({ autonomyLevel: 0, approvalThreshold: 999 }, item)).toMatchObject({
      execute: false,
    });
  });
  it("always reviews level 1", () => {
    expect(decideAutonomy({ autonomyLevel: 1, approvalThreshold: 999 }, item)).toMatchObject({
      execute: true,
      terminalStatus: "review",
    });
  });
  it("completes level 2 within the approval threshold", () => {
    expect(
      decideAutonomy(
        { autonomyLevel: 2, approvalThreshold: 500 },
        { context: { estimatedCost: 100 } },
      ),
    ).toMatchObject({ execute: true, terminalStatus: "completed" });
  });
  it("reviews level 2 above the approval threshold", () => {
    expect(
      decideAutonomy(
        { autonomyLevel: 2, approvalThreshold: 500 },
        { context: { estimatedCost: 900 } },
      ),
    ).toMatchObject({ execute: true, terminalStatus: "review" });
  });
  it("completes level 3", () => {
    expect(decideAutonomy({ autonomyLevel: 3, approvalThreshold: 0 }, item)).toMatchObject({
      execute: true,
      terminalStatus: "completed",
    });
  });
});

describe("sopCandidatePaths", () => {
  it("resolves relative SOPs against the workspace root and the worker workspace", () => {
    const worker = { sopPath: "agents/coder.yaml", workspacePath: "agencies/a/coder" } as Worker;
    const paths = sopCandidatePaths(worker, "/state");
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain(join("state", "agents", "coder.yaml"));
    expect(paths[1]).toContain(join("agencies", "a", "coder", "agents", "coder.yaml"));
  });

  it("returns nothing when the worker has no SOP", () => {
    expect(sopCandidatePaths({ sopPath: null, workspacePath: null } as Worker, "/state")).toEqual(
      [],
    );
  });
});

describe("composeWorkItemPrompt", () => {
  it("includes persona, goals, SOP and the review expectation", () => {
    const worker = {
      id: "w1",
      displayName: "Dev",
      title: "Back End Developer",
      agentId: "coder",
      autonomyLevel: 1,
      persona: "Ships small reviewable diffs.",
      goals: ["Automate everything"],
      kpis: ["test pass rate"],
      capabilities: ["backend-implementation"],
    } as unknown as Worker;
    const prompt = composeWorkItemPrompt({
      worker,
      item: {
        title: "Ship importer",
        instructions: "Do the thing",
        priority: "high",
        dueAt: null,
        context: {},
      } as never,
      sop: "STEP 1: read the brief",
      memory: [{ key: "last-run", value: { outcome: "completed" } }],
      terminalStatus: "review",
    });
    expect(prompt).toContain("You are Dev, Back End Developer");
    expect(prompt).toContain("Ships small reviewable diffs.");
    expect(prompt).toContain("STEP 1: read the brief");
    expect(prompt).toContain("Automate everything");
    expect(prompt).toContain("Ship importer");
    expect(prompt).toContain("HELD FOR HUMAN REVIEW");
  });
});

// ── safety: disabled by default ─────────────────────────────────────────────

describe("disabled by default", () => {
  it("createWorkItemExecutorConfig defaults enabled to false", () => {
    expect(createWorkItemExecutorConfig().enabled).toBe(false);
    expect(createWorkItemExecutorConfig(null).enabled).toBe(false);
    expect(createWorkItemExecutorConfig({}).enabled).toBe(false);
    expect(createWorkItemExecutorConfig({ executeWorkItems: false }).enabled).toBe(false);
    expect(createWorkItemExecutorConfig({ executeWorkItems: true }).enabled).toBe(true);
  });

  it("never spawns and never transitions while disabled", async () => {
    const worker = makeWorker({ id: "w1" });
    const staged = stageWorkItem(worker.id);
    const spawn = okSpawn();
    const executor = makeExecutor(createWorkItemExecutorConfig(), spawn);

    const pass = await executor.executeStagedWorkItems(AGENCY);

    expect(pass.enabled).toBe(false);
    expect(pass.considered).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(operating.getWorkItem(AGENCY, staged.id)?.status).toBe("accepted");
  });

  it("clamps the operator-supplied bounds", () => {
    const config = createWorkItemExecutorConfig({
      executeWorkItems: true,
      maxConcurrency: 999,
      maxItemsPerPass: 0,
      timeoutMinutes: 10_000,
    });
    expect(config.maxConcurrency).toBe(8);
    expect(config.maxItemsPerPass).toBe(1);
    expect(config.timeoutMinutes).toBe(240);
  });
});

// ── the board stage is the trigger ──────────────────────────────────────────

describe("board stage gating", () => {
  it("ignores freshly generated queued backlog items", async () => {
    const worker = makeWorker({ id: "w1" });
    const queued = operating.enqueueWorkItem(AGENCY, { workerId: worker.id, title: "Backlog" });
    const spawn = okSpawn();

    const pass = await makeExecutor(enabledConfig(), spawn).executeStagedWorkItems(AGENCY);

    expect(pass.considered).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(operating.getWorkItem(AGENCY, queued.id)?.status).toBe("queued");
  });

  it("executes only once the card is staged into accepted", async () => {
    const worker = makeWorker({ id: "w1" });
    const item = operating.enqueueWorkItem(AGENCY, { workerId: worker.id, title: "Backlog" });
    const spawn = okSpawn();
    const executor = makeExecutor(enabledConfig(), spawn);

    expect((await executor.executeStagedWorkItems(AGENCY)).executed).toBe(0);

    // The human moves the card — this is the approval.
    operating.transitionWorkItem(AGENCY, item.id, "accepted");
    const pass = await executor.executeStagedWorkItems(AGENCY);

    expect(pass.executed).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses to execute an item that is not in the staged column", async () => {
    const worker = makeWorker({ id: "w1" });
    const item = operating.enqueueWorkItem(AGENCY, { workerId: worker.id, title: "Backlog" });
    const spawn = okSpawn();

    const result = await makeExecutor(enabledConfig(), spawn).executeOne(AGENCY, item);

    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("only accepted items are execution-eligible");
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ── lifecycle ───────────────────────────────────────────────────────────────

describe("lifecycle transitions", () => {
  it("drives accepted -> in_progress -> completed for an autonomous worker", async () => {
    const worker = makeWorker({ id: "w1", autonomyLevel: 3 });
    const staged = stageWorkItem(worker.id);
    const seen: string[] = [];
    const spawn: CoderSpawnFn = vi.fn(async () => {
      seen.push(operating.getWorkItem(AGENCY, staged.id)!.status);
      return { output: "ok", exitCode: 0 };
    });

    const result = await makeExecutor(enabledConfig(), spawn).executeOne(AGENCY, staged);

    // The item was in_progress *while* the backend ran — never skipped.
    expect(seen).toEqual(["in_progress"]);
    expect(result.outcome).toBe("completed");
    const final = operating.getWorkItem(AGENCY, staged.id)!;
    expect(final.status).toBe("completed");
    expect(final.startedAt).not.toBeNull();
    expect(final.completedAt).not.toBeNull();
  });

  it("holds a low-autonomy worker's output in review", async () => {
    const worker = makeWorker({ id: "w1", autonomyLevel: 1 });
    const staged = stageWorkItem(worker.id);

    const result = await makeExecutor(enabledConfig(), okSpawn("draft output")).executeOne(
      AGENCY,
      staged,
    );

    expect(result.outcome).toBe("review");
    const final = operating.getWorkItem(AGENCY, staged.id)!;
    expect(final.status).toBe("review");
    expect(final.reviewNote).toContain("draft output");
  });

  it("holds a supervised worker's expensive item in review but completes cheap ones", async () => {
    const worker = makeWorker({ id: "w1", autonomyLevel: 2, approvalThreshold: 500 });
    const cheap = stageWorkItem(worker.id, { context: { estimatedCost: 100 } });
    const pricey = stageWorkItem(worker.id, { context: { estimatedCost: 5_000 } });
    const executor = makeExecutor(enabledConfig(), okSpawn());

    expect((await executor.executeOne(AGENCY, cheap)).outcome).toBe("completed");
    expect((await executor.executeOne(AGENCY, pricey)).outcome).toBe("review");
  });

  it("never executes a level-0 worker, leaving the card staged", async () => {
    const worker = makeWorker({ id: "w1", autonomyLevel: 0 });
    const staged = stageWorkItem(worker.id);
    const spawn = okSpawn();

    const result = await makeExecutor(enabledConfig(), spawn).executeOne(AGENCY, staged);

    expect(result.outcome).toBe("skipped");
    expect(spawn).not.toHaveBeenCalled();
    expect(operating.getWorkItem(AGENCY, staged.id)?.status).toBe("accepted");
  });

  it("skips inactive and human workers", async () => {
    const human = makeWorker({ id: "human", type: "human", displayName: "Sam" });
    const onLeave = makeWorker({ id: "leave", employmentStatus: "on_leave" });
    const spawn = okSpawn();
    const executor = makeExecutor(enabledConfig(), spawn);

    expect((await executor.executeOne(AGENCY, stageWorkItem(human.id))).outcome).toBe("skipped");
    expect((await executor.executeOne(AGENCY, stageWorkItem(onLeave.id))).outcome).toBe("skipped");
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ── failure isolation ───────────────────────────────────────────────────────

describe("failure isolation", () => {
  it("escalates a failed run instead of throwing", async () => {
    const worker = makeWorker({ id: "w1" });
    const staged = stageWorkItem(worker.id);
    const spawn: CoderSpawnFn = vi.fn(async () => {
      throw new Error("codex is not installed");
    });

    const result = await makeExecutor(enabledConfig(), spawn).executeOne(AGENCY, staged);

    expect(result.outcome).toBe("escalated");
    expect(result.error).toContain("codex is not installed");
    const final = operating.getWorkItem(AGENCY, staged.id)!;
    expect(final.status).toBe("escalated");
    expect(final.escalationLevel).toBe(1);
  });

  it("escalates a non-zero exit code", async () => {
    const worker = makeWorker({ id: "w1" });
    const staged = stageWorkItem(worker.id);
    const spawn: CoderSpawnFn = vi.fn(async () => ({ output: "boom", exitCode: 2 }));

    const result = await makeExecutor(enabledConfig(), spawn).executeOne(AGENCY, staged);

    expect(result.outcome).toBe("escalated");
    expect(result.error).toContain("code 2");
  });

  it("retries once with the configured fallback backend", async () => {
    const worker = makeWorker({ id: "w1", modelBinding: "codex" });
    const staged = stageWorkItem(worker.id);
    const backends: string[] = [];
    const spawn: CoderSpawnFn = vi.fn(async (request) => {
      backends.push(request.backend);
      if (request.backend === "codex") throw new Error("codex unavailable");
      return { output: "ok", exitCode: 0 };
    });

    const result = await makeExecutor(
      enabledConfig({ fallbackBackend: "claude-code" }),
      spawn,
    ).executeOne(AGENCY, staged);

    expect(backends).toEqual(["codex", "claude-code"]);
    expect(result.outcome).toBe("completed");
    expect(result.backend).toBe("claude-code");
  });

  it("one failing item does not abort the rest of the pass", async () => {
    const good = makeWorker({ id: "good" });
    const bad = makeWorker({ id: "bad" });
    stageWorkItem(bad.id, { title: "explodes" });
    stageWorkItem(good.id, { title: "works" });
    const spawn: CoderSpawnFn = vi.fn(async (request) => {
      if (request.worker.id === "bad") throw new Error("nope");
      return { output: "ok", exitCode: 0 };
    });

    const pass = await makeExecutor(enabledConfig(), spawn).executeStagedWorkItems(AGENCY);

    expect(pass.considered).toBe(2);
    expect(pass.executed).toBe(2);
    expect(pass.completed).toBe(1);
    expect(pass.escalated).toBe(1);
  });

  it("survives a broken broadcast", async () => {
    const worker = makeWorker({ id: "w1" });
    const staged = stageWorkItem(worker.id);
    const executor = makeExecutor(enabledConfig(), okSpawn(), {
      broadcast: () => {
        throw new Error("socket closed");
      },
    });

    expect((await executor.executeOne(AGENCY, staged)).outcome).toBe("completed");
  });
});

// ── bounded concurrency + hard cap ──────────────────────────────────────────

describe("bounds", () => {
  it("never exceeds maxConcurrency simultaneous spawns", async () => {
    const worker = makeWorker({ id: "w1" });
    for (let i = 0; i < 6; i += 1) stageWorkItem(worker.id, { title: `item-${i}` });

    let inFlight = 0;
    let peak = 0;
    const spawn: CoderSpawnFn = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { output: "ok", exitCode: 0 };
    });

    const pass = await makeExecutor(
      enabledConfig({ maxConcurrency: 2, maxItemsPerPass: 6 }),
      spawn,
    ).executeStagedWorkItems(AGENCY);

    expect(pass.executed).toBe(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it("caps the number of items executed per pass", async () => {
    const worker = makeWorker({ id: "w1" });
    for (let i = 0; i < 10; i += 1) stageWorkItem(worker.id, { title: `item-${i}` });
    const spawn = okSpawn();

    const pass = await makeExecutor(
      enabledConfig({ maxItemsPerPass: 3, maxConcurrency: 3 }),
      spawn,
    ).executeStagedWorkItems(AGENCY);

    expect(pass.considered).toBe(3);
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});

// ── job memory + broadcast ──────────────────────────────────────────────────

describe("job memory and broadcasts", () => {
  it("records what the employee did", async () => {
    const worker = makeWorker({ id: "w1" });
    const staged = stageWorkItem(worker.id);

    await makeExecutor(enabledConfig(), okSpawn("shipped the importer")).executeOne(AGENCY, staged);

    const memory = operating.listJobMemory(AGENCY, worker.id, "work-item-execution");
    const keys = memory.map((record) => record.key);
    expect(keys).toContain(`work-item:${staged.id}`);
    expect(keys).toContain("last-run");
    const record = memory.find((entry) => entry.key === "last-run")!.value as Record<
      string,
      unknown
    >;
    expect(record.outcome).toBe("completed");
    expect(String(record.output)).toContain("shipped the importer");
    expect(record.backend).toBe("codex");
  });

  it("broadcasts an invalidation signal for start and finish", async () => {
    const worker = makeWorker({ id: "w1" });
    const staged = stageWorkItem(worker.id);
    const broadcast = vi.fn();

    await makeExecutor(enabledConfig(), okSpawn(), { broadcast }).executeOne(AGENCY, staged);

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[0][0]).toBe("agency.work.updated");
    expect(broadcast.mock.calls[0][1]).toMatchObject({
      agencyId: AGENCY,
      workItemId: staged.id,
      status: "in_progress",
    });
    expect(broadcast.mock.calls[1][1]).toMatchObject({ status: "completed" });
  });
});

// ── board views ─────────────────────────────────────────────────────────────

describe("board execution views", () => {
  const viewDeps = (enabled: boolean) => ({
    operatingStore: operating,
    workerStore: workforce,
    config: { enabled, defaultBackend: "claude-code" as const },
  });

  it("lists only staged cards with their readiness", () => {
    const worker = makeWorker({ id: "w1", autonomyLevel: 3, modelBinding: "codex" });
    operating.enqueueWorkItem(AGENCY, { workerId: worker.id, title: "Backlog" });
    const staged = stageWorkItem(worker.id);

    const views = listExecutionEligibleWorkItems(viewDeps(true), AGENCY);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      workItemId: staged.id,
      stage: "accepted",
      executionEligible: true,
      executorEnabled: true,
      backend: "codex",
      terminalStage: "completed",
      blockedReason: null,
    });
  });

  it("explains why a card will not run", () => {
    const worker = makeWorker({ id: "w1", autonomyLevel: 0 });
    const staged = stageWorkItem(worker.id);

    expect(describeWorkItemExecution(viewDeps(true), AGENCY, staged).blockedReason).toContain(
      "autonomyLevel 0",
    );

    const other = makeWorker({ id: "w2", autonomyLevel: 3 });
    const staged2 = stageWorkItem(other.id);
    expect(describeWorkItemExecution(viewDeps(false), AGENCY, staged2).blockedReason).toContain(
      "executeWorkItems",
    );

    const backlog = operating.enqueueWorkItem(AGENCY, { workerId: other.id, title: "Backlog" });
    expect(describeWorkItemExecution(viewDeps(true), AGENCY, backlog).blockedReason).toContain(
      "move the card",
    );
  });

  it("surfaces the last run recorded in job memory", async () => {
    const worker = makeWorker({ id: "w1" });
    const staged = stageWorkItem(worker.id);
    await makeExecutor(enabledConfig(), okSpawn("finished")).executeOne(AGENCY, staged);

    const view = describeWorkItemExecution(
      viewDeps(true),
      AGENCY,
      operating.getWorkItem(AGENCY, staged.id)!,
    );
    expect(view.lastRun).toMatchObject({ outcome: "completed" });
  });
});
