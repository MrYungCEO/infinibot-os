import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkItemExecutionPassResult } from "../workforce/executor.js";
import type { TaskRoutingPassResult } from "../workforce/task-router.js";
import type { OperatingLoopTickResult } from "../workforce/types.js";
import {
  createAgencyOperatingLoopDeps,
  runAgencyOperatingLoop,
  runAgencyOperatingLoopPass,
  startAgencyOperatingLoopScheduler,
} from "./operating-loop.js";

const emptyTick = (): OperatingLoopTickResult => ({
  generatedWorkItemIds: [],
  escalatedWorkItemIds: [],
  dueReviewCycleIds: [],
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe("runAgencyOperatingLoop", () => {
  it("ticks every agency and aggregates the results", () => {
    const tick = vi.fn(
      (agencyId: string): OperatingLoopTickResult => ({
        generatedWorkItemIds: [`${agencyId}-w1`],
        escalatedWorkItemIds: agencyId === "b" ? ["b-esc"] : [],
        dueReviewCycleIds: [],
      }),
    );

    const summary = runAgencyOperatingLoop({
      listAgencyIds: () => ["a", "b", "c"],
      tick,
      log: logger,
    });

    expect(tick).toHaveBeenCalledTimes(3);
    expect(tick.mock.calls.map((call) => call[0])).toEqual(["a", "b", "c"]);
    expect(summary).toMatchObject({
      agencies: 3,
      ticked: 3,
      failed: 0,
      generatedWorkItems: 3,
      escalatedWorkItems: 1,
      dueReviewCycles: 0,
      errors: [],
    });
  });

  it("keeps going when one agency throws", () => {
    const summary = runAgencyOperatingLoop({
      listAgencyIds: () => ["a", "boom", "c"],
      tick: (agencyId) => {
        if (agencyId === "boom") throw new Error("database is locked");
        return emptyTick();
      },
      log: logger,
    });

    expect(summary.agencies).toBe(3);
    expect(summary.ticked).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.errors).toEqual([{ agencyId: "boom", message: "database is locked" }]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the agency listing itself fails", () => {
    const summary = runAgencyOperatingLoop({
      listAgencyIds: () => {
        throw new Error("no database");
      },
      tick: () => emptyTick(),
      log: logger,
    });

    expect(summary.agencies).toBe(0);
    expect(summary.errors).toEqual([{ agencyId: "*", message: "no database" }]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

const emptyPass = (agencyId: string): WorkItemExecutionPassResult => ({
  agencyId,
  enabled: true,
  considered: 0,
  executed: 0,
  completed: 0,
  review: 0,
  escalated: 0,
  skipped: 0,
  results: [],
});

describe("runAgencyOperatingLoopPass", () => {
  it("ticks then executes staged work for every agency", async () => {
    const executeWorkItems = vi.fn(async (agencyId: string) => ({
      ...emptyPass(agencyId),
      executed: 2,
      completed: 1,
      review: 1,
    }));

    const summary = await runAgencyOperatingLoopPass({
      listAgencyIds: () => ["a", "b"],
      tick: () => emptyTick(),
      executeWorkItems,
      log: logger,
    });

    expect(executeWorkItems.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
    expect(summary).toMatchObject({
      executedWorkItems: 4,
      completedWorkItems: 2,
      reviewWorkItems: 2,
      failedWorkItems: 0,
    });
  });

  it("does not execute anything when no executor is wired (the default)", async () => {
    const summary = await runAgencyOperatingLoopPass({
      listAgencyIds: () => ["a"],
      tick: () => emptyTick(),
      log: logger,
    });
    expect(summary.executedWorkItems).toBe(0);
  });

  it("isolates an agency whose execution throws", async () => {
    const summary = await runAgencyOperatingLoopPass({
      listAgencyIds: () => ["a", "boom", "c"],
      tick: () => emptyTick(),
      executeWorkItems: async (agencyId) => {
        if (agencyId === "boom") throw new Error("db locked");
        return { ...emptyPass(agencyId), executed: 1, completed: 1 };
      },
      log: logger,
    });

    expect(summary.executedWorkItems).toBe(2);
    expect(summary.errors).toEqual([{ agencyId: "boom", message: "db locked" }]);
  });
});

describe("automatic task routing in the loop", () => {
  const routingPass = (overrides: Partial<TaskRoutingPassResult> = {}): TaskRoutingPassResult => ({
    agencyId: "a",
    enabled: true,
    mode: "auto",
    candidates: 0,
    skipped: 0,
    pinned: 0,
    deferred: 0,
    assigned: 0,
    unmatched: 0,
    needsHuman: 0,
    autoStaged: 0,
    stageRecommended: 0,
    workItemsCreated: 0,
    writes: 0,
    autoStageBudgetLeft: 5,
    load: [],
    decisions: [],
    durationMs: 0,
    ...overrides,
  });

  it("routes every agency's real work before ticking it", () => {
    const order: string[] = [];
    const summary = runAgencyOperatingLoop({
      listAgencyIds: () => ["a", "b"],
      routeTasks: (agencyId) => {
        order.push(`route:${agencyId}`);
        return routingPass({ assigned: 2, autoStaged: 1, unmatched: 3 });
      },
      tick: (agencyId) => {
        order.push(`tick:${agencyId}`);
        return emptyTick();
      },
      log: logger,
    });

    expect(order).toEqual(["route:a", "tick:a", "route:b", "tick:b"]);
    expect(summary.routedTasks).toBe(4);
    expect(summary.autoStagedTasks).toBe(2);
    expect(summary.unmatchedTasks).toBe(6);
  });

  it("a routing failure never stops the agency's tick", () => {
    const tick = vi.fn(() => emptyTick());
    const summary = runAgencyOperatingLoop({
      listAgencyIds: () => ["a"],
      routeTasks: () => {
        throw new Error("database is locked");
      },
      tick,
      log: logger,
    });

    expect(tick).toHaveBeenCalledTimes(1);
    expect(summary.ticked).toBe(1);
    expect(summary.errors).toEqual([{ agencyId: "a", message: "database is locked" }]);
  });

  it("provisions each agency before the pass and counts only real changes", async () => {
    const ensureProvisioned = vi.fn(async (agencyId: string) => ({
      agencyId,
      changed: agencyId === "a",
      workforce: null,
      sops: null,
      schedules: { attached: 0, skipped: 0, failed: 0 },
      routingPolicyCreated: false,
      warnings: [],
    }));
    const summary = await runAgencyOperatingLoopPass({
      listAgencyIds: () => ["a", "b"],
      tick: () => emptyTick(),
      ensureProvisioned,
      log: logger,
    });

    expect(ensureProvisioned).toHaveBeenCalledTimes(2);
    expect(summary.provisionedAgencies).toBe(1);
    expect(summary.ticked).toBe(2);
  });

  it("a provisioning failure never stops the pass", async () => {
    const summary = await runAgencyOperatingLoopPass({
      listAgencyIds: () => ["a"],
      tick: () => emptyTick(),
      ensureProvisioned: async () => {
        throw new Error("cron unavailable");
      },
      log: logger,
    });
    expect(summary.ticked).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("createAgencyOperatingLoopDeps", () => {
  it("wires routing and provisioning on by default, and lets a node opt out", () => {
    const on = createAgencyOperatingLoopDeps("state");
    expect(on.routeTasks).toBeTypeOf("function");
    expect(on.ensureProvisioned).toBeTypeOf("function");

    const off = createAgencyOperatingLoopDeps("state", undefined, {
      routeTasks: false,
      provision: false,
    });
    expect(off.routeTasks).toBeUndefined();
    expect(off.ensureProvisioned).toBeUndefined();
  });

  it("omits the executor unless executeWorkItems is explicitly enabled", () => {
    expect(createAgencyOperatingLoopDeps("state").executeWorkItems).toBeUndefined();
    expect(
      createAgencyOperatingLoopDeps("state", undefined, { execution: {} }).executeWorkItems,
    ).toBeUndefined();
    expect(
      createAgencyOperatingLoopDeps("state", undefined, { execution: { executeWorkItems: false } })
        .executeWorkItems,
    ).toBeUndefined();
    expect(
      createAgencyOperatingLoopDeps("state", undefined, { execution: { executeWorkItems: true } })
        .executeWorkItems,
    ).toBeTypeOf("function");
  });
});

describe("startAgencyOperatingLoopScheduler", () => {
  // A pass is async (it may await work-item execution), so the timers have to
  // be advanced asynchronously for the in-flight guard to clear between passes.
  it("ticks on its interval and stops cleanly", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(() => emptyTick());
    const scheduler = startAgencyOperatingLoopScheduler({
      deps: { listAgencyIds: () => ["a"], tick },
      intervalMs: 60_000,
      log: logger,
    });

    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(tick).toHaveBeenCalledTimes(3);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("skips passes while the cron job is disabled", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(() => emptyTick());
    let enabled = false;
    const scheduler = startAgencyOperatingLoopScheduler({
      deps: { listAgencyIds: () => ["a"], tick },
      intervalMs: 60_000,
      isEnabled: () => enabled,
      log: logger,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).not.toHaveBeenCalled();

    enabled = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
});
