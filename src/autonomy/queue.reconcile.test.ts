/**
 * PILLAR 1 — restart persistence: a queue file left with a "running" task
 * (a process that died mid-iteration) must be reconciled to a runnable state
 * on init so the heartbeat is never perma-blocked.
 * // COORDINATION: orch-self-heal
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// kanban-sync is fire-and-forget inside blockTask; stub it so the test never
// reaches the real gateway.
vi.mock("./kanban-sync.js", () => ({ syncToKanban: vi.fn().mockResolvedValue(false) }));

import { initAudit } from "./audit.js";
import { initQueue, queue } from "./queue.js";
import type { QueuedTask } from "./types.js";

let dir: string;

function baseTask(overrides: Partial<QueuedTask>): QueuedTask {
  return {
    id: "task_x",
    createdAt: Date.now(),
    priority: "normal",
    status: "running",
    title: "Orphaned task",
    description: "left running by a dead process",
    hardwareIntensive: false,
    requiresApproval: false,
    auditIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autonomy-reconcile-"));
  initAudit(join(dir, "audit"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("reconcileOrphans on init", () => {
  it("resets a non-approval running task to pending and clears the running count", () => {
    const queuePath = join(dir, "queue.json");
    writeFileSync(
      queuePath,
      JSON.stringify([baseTask({ id: "task_run", status: "running", currentPhase: "building" })]),
      "utf-8",
    );

    initQueue(queuePath);

    const tasks = queue.get();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("pending");
    // The dead in-flight phase marker is cleared so a resume starts clean.
    expect(tasks[0].currentPhase).toBeUndefined();
    expect(tasks[0].recoveredCount).toBe(1);
    // The heartbeat's perma-block guard keys off the running count.
    expect(queue.stats().running).toBe(0);
  });

  it("resets a requiresApproval running task back to approved (it must have been approved)", () => {
    const queuePath = join(dir, "queue.json");
    writeFileSync(
      queuePath,
      JSON.stringify([baseTask({ id: "task_appr", status: "running", requiresApproval: true })]),
      "utf-8",
    );

    initQueue(queuePath);

    expect(queue.getById("task_appr")?.status).toBe("approved");
    expect(queue.stats().running).toBe(0);
  });

  it("parks a running task as blocked when it recorded an unhealable blocker", () => {
    const queuePath = join(dir, "queue.json");
    writeFileSync(
      queuePath,
      JSON.stringify([
        baseTask({
          id: "task_block",
          status: "running",
          healState: {
            attempts: [],
            budgetUsed: { "brave-search-key": 3 },
            lastUnhealable: true,
            lastBlocker: "missing_brave_api_key",
          },
        }),
      ]),
      "utf-8",
    );

    initQueue(queuePath);

    const t = queue.getById("task_block");
    expect(t?.status).toBe("blocked");
    expect(t?.blockedReason).toBe("missing_brave_api_key");
    // blockedUntil is set so the heartbeat eventually re-picks it (park & resume).
    expect(typeof t?.blockedUntil).toBe("number");
    expect(queue.stats().running).toBe(0);
  });

  it("leaves an eligible (pending) task untouched and resumable by the heartbeat", () => {
    const queuePath = join(dir, "queue.json");
    writeFileSync(
      queuePath,
      JSON.stringify([
        baseTask({ id: "task_run", status: "running" }),
        baseTask({ id: "task_pending", status: "pending", title: "fresh" }),
      ]),
      "utf-8",
    );

    initQueue(queuePath);

    // After reconcile, BOTH tasks are runnable (pending) and nothing is running,
    // so the heartbeat's `alreadyRunning` guard can't perma-block the queue.
    const runnable = queue.get().filter((t) => t.status === "pending" || t.status === "approved");
    expect(runnable.map((t) => t.id).sort()).toEqual(["task_pending", "task_run"]);
    expect(queue.stats().running).toBe(0);
  });
});
