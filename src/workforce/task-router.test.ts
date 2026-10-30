import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { AgencyOperationsStore } from "../agency-operations/store.js";
import { seedAgencyAiWorkforce } from "../agency-operations/seed-workforce.js";
import { WorkforceOperatingStore } from "./operating-store.js";
import { WorkforceRoutingStore } from "./routing-store.js";
import { WorkforceStore } from "./store.js";
import {
  applyTaskRouting,
  overrideTaskRouting,
  previewTaskRouting,
  stageRoutedWork,
  unassignTask,
  type TaskRouterDeps,
} from "./task-router.js";

const ACTOR = "owner-1";

let dir: string;
let dbPath: string;
let operations: AgencyOperationsStore;
let workers: WorkforceStore;
let operating: WorkforceOperatingStore;
let routing: WorkforceRoutingStore;
let deps: TaskRouterDeps;
let agencyId: string;
let projectId: string;
let events: Array<{ event: string; payload: unknown }>;

/** Count rows in a table straight from SQLite — the honest idempotence check. */
function rowCount(table: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
  } finally {
    db.close();
  }
}

function addTask(
  title: string,
  extra: Partial<{ description: string; acceptanceCriteria: string }> = {},
) {
  return operations.createTask(
    agencyId,
    {
      projectId,
      title,
      description: extra.description ?? "",
      acceptanceCriteria: extra.acceptanceCriteria ?? "Reviewed and accepted by owner",
    },
    ACTOR,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "task-router-"));
  dbPath = join(dir, "agency.db");
  operations = new AgencyOperationsStore(dbPath);
  workers = new WorkforceStore(dbPath);
  operating = new WorkforceOperatingStore(dbPath);
  routing = new WorkforceRoutingStore(dbPath);
  events = [];

  const agency = operations.createAgency({ name: "Acme", slug: "acme", ownerUserId: ACTOR });
  agencyId = agency.id;
  seedAgencyAiWorkforce(workers, agencyId, ACTOR);
  projectId = operations.createProject(agencyId, { name: "Client delivery" }, ACTOR).id;

  deps = {
    operationsStore: operations,
    workerStore: workers,
    operatingStore: operating,
    routingStore: routing,
    broadcast: (event, payload) => events.push({ event, payload }),
  };
});

afterEach(() => {
  routing.close();
  operating.close();
  workers.close();
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("applyTaskRouting", () => {
  it("assigns real tasks to the plausible AI employee and records the rationale", () => {
    const frontend = addTask("Rebuild the landing page with responsive CSS", {
      acceptanceCriteria: "Passes Core Web Vitals and WCAG AA.",
    });
    const backend = addTask("Build the webhook api integration endpoint", {
      description: "Server side, needs a database migration.",
    });

    const result = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(result.assigned).toBe(2);

    const frontendTask = operations.getTask(agencyId, frontend.id)!;
    const backendTask = operations.getTask(agencyId, backend.id)!;
    expect(frontendTask.assigneeType).toBe("ai");
    expect(workers.getWorker(agencyId, frontendTask.assigneeId!)?.agentId).toBe("web-builder");
    expect(workers.getWorker(agencyId, backendTask.assigneeId!)?.agentId).toBe("coder");

    const decision = routing.getDecision(agencyId, frontend.id)!;
    expect(decision.outcome).toBe("assigned");
    expect(decision.rationale).toContain("Wren");
    expect(decision.rationale).toContain("suitability");
    expect(decision.runnerUp).not.toBeNull();
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it("is idempotent: a second pass writes nothing at all", () => {
    addTask("Rebuild the landing page with responsive CSS");
    addTask("Build the webhook api integration endpoint");
    addTask("Write the seo newsletter campaign copy");

    const first = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(first.writes).toBeGreaterThan(0);

    const before = {
      decisions: rowCount("wf_task_routing_decisions"),
      workItems: rowCount("wf_employee_work_items"),
      audit: rowCount("wf_audit_entries"),
      agencyAudit: rowCount("audit_events"),
    };

    const second = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(second.writes).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.assigned).toBe(0);
    expect({
      decisions: rowCount("wf_task_routing_decisions"),
      workItems: rowCount("wf_employee_work_items"),
      audit: rowCount("wf_audit_entries"),
      agencyAudit: rowCount("audit_events"),
    }).toEqual(before);
  });

  it("re-routes only the task whose content actually changed", () => {
    const a = addTask("Rebuild the landing page with responsive CSS");
    addTask("Build the webhook api integration endpoint");
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });

    operations.updateTask(
      agencyId,
      a.id,
      { title: "Write the seo campaign newsletter copy" },
      ACTOR,
    );
    const second = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(second.skipped).toBe(1);
    expect(second.assigned).toBe(1);
    expect(
      workers.getWorker(agencyId, operations.getTask(agencyId, a.id)!.assigneeId!)?.agentId,
    ).toBe("marketing-studio");
  });

  it("leaves unmatched work unassigned and surfaces it for a human", () => {
    const vague = addTask("Thing", { description: "Do the needful." });
    const result = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(result.unmatched).toBe(1);
    expect(result.needsHuman).toBe(1);
    expect(operations.getTask(agencyId, vague.id)!.assigneeId).toBeNull();
    const decision = routing.getDecision(agencyId, vague.id)!;
    expect(decision.outcome).toBe("unmatched");
    expect(decision.needsHuman).toBe(true);
    expect(decision.rationale.length).toBeGreaterThan(20);
  });

  it("`enabled: false` makes the whole pass inert", () => {
    routing.setPolicy(agencyId, { enabled: false });
    const task = addTask("Rebuild the landing page with responsive CSS");
    const result = applyTaskRouting(deps, agencyId, { actorId: ACTOR });

    expect(result.enabled).toBe(false);
    expect(result.candidates).toBe(0);
    expect(result.writes).toBe(0);
    expect(operations.getTask(agencyId, task.id)!.assigneeId).toBeNull();
    expect(rowCount("wf_task_routing_decisions")).toBe(0);
  });

  it("mode 'off' routes into the Backlog and never into the execution stage", () => {
    routing.setPolicy(agencyId, { mode: "off" });
    const task = addTask("Rebuild the landing page with responsive CSS");
    const result = applyTaskRouting(deps, agencyId, { actorId: ACTOR });

    expect(result.assigned).toBe(1);
    expect(result.autoStaged).toBe(0);
    const decision = routing.getDecision(agencyId, task.id)!;
    const item = operating.getWorkItem(agencyId, decision.workItemId!)!;
    expect(item.status).toBe("queued");
    expect(item.acceptedAt).toBeNull();
  });

  it("mode 'auto' stages confident work and emits a signal saying what it started", () => {
    const task = addTask("Rebuild the landing page with responsive CSS", {
      acceptanceCriteria: "Passes Core Web Vitals and WCAG AA.",
    });
    const result = applyTaskRouting(deps, agencyId, { actorId: ACTOR });

    expect(result.autoStaged).toBe(1);
    const decision = routing.getDecision(agencyId, task.id)!;
    expect(decision.autoStaged).toBe(true);
    expect(decision.stagedAt).not.toBeNull();
    expect(operating.getWorkItem(agencyId, decision.workItemId!)!.status).toBe("accepted");

    const staged = events.filter((entry) => entry.event === "agency.routing.staged");
    expect(staged).toHaveLength(1);
    expect(staged[0].payload).toMatchObject({ taskId: task.id, workerName: "Wren" });
    expect((staged[0].payload as { rationale: string }).rationale).toContain("Wren");
  });

  it("caps how many cards one pass may hand to the executor", () => {
    routing.setPolicy(agencyId, { maxAutoStagePerPass: 2 });
    for (let index = 0; index < 6; index += 1) {
      addTask(`Rebuild landing page ${index} with responsive CSS`);
    }
    const result = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(result.assigned).toBe(6);
    expect(result.autoStaged).toBe(2);
    expect(rowCount("wf_employee_work_items")).toBe(6);
  });

  it("respects the rolling daily auto-stage cap across passes", () => {
    routing.setPolicy(agencyId, { maxAutoStagePerPass: 10, maxAutoStagePerDay: 3 });
    for (let index = 0; index < 4; index += 1) {
      addTask(`Rebuild landing page ${index} with responsive CSS`);
    }
    const first = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(first.autoStaged).toBe(3);

    for (let index = 4; index < 8; index += 1) {
      addTask(`Rebuild landing page ${index} with responsive CSS`);
    }
    const second = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(second.autoStaged).toBe(0);
    expect(second.assigned).toBe(4);
  });

  it("never stages a card whose employee is autonomy level 0", () => {
    const wren = workers
      .listWorkers(agencyId, { type: "ai" })
      .find((worker) => worker.agentId === "web-builder")!;
    workers.updateWorker(agencyId, wren.id, { autonomyLevel: 0 }, ACTOR);
    const task = addTask("Rebuild the landing page with responsive CSS");

    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    const decision = routing.getDecision(agencyId, task.id)!;
    expect(decision.workerId).toBe(wren.id);
    expect(decision.autoStaged).toBe(false);
    expect(operating.getWorkItem(agencyId, decision.workItemId!)!.status).toBe("queued");
  });

  it("writes exactly one audit row per pass, never one per task", () => {
    for (let index = 0; index < 20; index += 1) {
      addTask(`Rebuild landing page ${index} with responsive CSS`);
    }
    const before = rowCount("wf_audit_entries");
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(rowCount("wf_audit_entries")).toBe(before + 1);
  });

  it("leaves a task a human assigned by hand completely alone", () => {
    const task = addTask("Rebuild the landing page with responsive CSS");
    const dev = workers.listWorkers(agencyId, { type: "ai" }).find((w) => w.agentId === "coder")!;
    operations.updateTask(agencyId, task.id, { assigneeId: dev.id, assigneeType: "ai" }, ACTOR);

    const result = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(result.candidates).toBe(0);
    expect(operations.getTask(agencyId, task.id)!.assigneeId).toBe(dev.id);
  });

  it("does not route tasks of a cancelled project", () => {
    const dormant = operations.createProject(agencyId, { name: "Dead project" }, ACTOR);
    operations.transitionProject(agencyId, dormant.id, "cancelled", ACTOR);
    const task = operations.createTask(
      agencyId,
      {
        projectId: dormant.id,
        title: "Rebuild the landing page with responsive CSS",
        acceptanceCriteria: "n/a",
      },
      ACTOR,
    );
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(operations.getTask(agencyId, task.id)!.assigneeId).toBeNull();
  });
});

describe("previewTaskRouting", () => {
  it("is a genuine dry run: nothing is written anywhere", () => {
    addTask("Rebuild the landing page with responsive CSS");
    addTask("Build the webhook api integration endpoint");
    const before = {
      decisions: rowCount("wf_task_routing_decisions"),
      workItems: rowCount("wf_employee_work_items"),
      audit: rowCount("wf_audit_entries"),
      agencyAudit: rowCount("audit_events"),
    };

    const preview = previewTaskRouting(deps, agencyId);
    expect(preview.assigned).toBe(2);
    expect(preview.writes).toBe(0);
    expect(preview.decisions[0]!.rationale.length).toBeGreaterThan(20);
    expect({
      decisions: rowCount("wf_task_routing_decisions"),
      workItems: rowCount("wf_employee_work_items"),
      audit: rowCount("wf_audit_entries"),
      agencyAudit: rowCount("audit_events"),
    }).toEqual(before);
  });
});

describe("batch staging", () => {
  it("stages every recommended card for one worker in a single action", () => {
    routing.setPolicy(agencyId, { mode: "recommend" });
    for (let index = 0; index < 5; index += 1) {
      addTask(`Rebuild landing page ${index} with responsive CSS`);
    }
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    const wren = workers
      .listWorkers(agencyId, { type: "ai" })
      .find((w) => w.agentId === "web-builder")!;

    const result = stageRoutedWork(deps, agencyId, { workerId: wren.id, actorId: ACTOR });
    expect(result.staged).toBe(5);
    for (const item of result.items) {
      expect(operating.getWorkItem(agencyId, item.workItemId)!.status).toBe("accepted");
    }
    expect(events.filter((entry) => entry.event === "agency.routing.staged")).toHaveLength(5);
  });

  it("refuses to stage a card belonging to an autonomy-0 employee", () => {
    routing.setPolicy(agencyId, { mode: "recommend" });
    const wren = workers
      .listWorkers(agencyId, { type: "ai" })
      .find((w) => w.agentId === "web-builder")!;
    addTask("Rebuild the landing page with responsive CSS");
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    workers.updateWorker(agencyId, wren.id, { autonomyLevel: 0 }, ACTOR);

    const result = stageRoutedWork(deps, agencyId, { workerId: wren.id, actorId: ACTOR });
    expect(result.staged).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe("operator overrides", () => {
  it("reassigns a task and pins it so the router never takes it back", () => {
    const task = addTask("Rebuild the landing page with responsive CSS");
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    const pace = workers.listWorkers(agencyId, { type: "ai" }).find((w) => w.agentId === "pm")!;

    const decision = overrideTaskRouting(deps, agencyId, {
      taskId: task.id,
      workerId: pace.id,
      actorId: ACTOR,
      note: "Pace owns client comms",
    });
    expect(decision.pinned).toBe(true);
    expect(decision.decidedBy).toBe("operator");
    expect(decision.rationale).toContain("Pace owns client comms");
    expect(operations.getTask(agencyId, task.id)!.assigneeId).toBe(pace.id);

    const after = applyTaskRouting(deps, agencyId, { actorId: ACTOR, force: true });
    expect(after.pinned).toBe(1);
    expect(operations.getTask(agencyId, task.id)!.assigneeId).toBe(pace.id);
  });

  it("unassigns, cancels the employee's card, and stays unassigned on the next pass", () => {
    const task = addTask("Rebuild the landing page with responsive CSS");
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    const workItemId = routing.getDecision(agencyId, task.id)!.workItemId!;

    const decision = unassignTask(deps, agencyId, { taskId: task.id, actorId: ACTOR })!;
    expect(decision.outcome).toBe("unassigned");
    expect(decision.pinned).toBe(true);
    expect(operations.getTask(agencyId, task.id)!.assigneeId).toBeNull();
    expect(operating.getWorkItem(agencyId, workItemId)!.status).toBe("cancelled");

    applyTaskRouting(deps, agencyId, { actorId: ACTOR, force: true });
    expect(operations.getTask(agencyId, task.id)!.assigneeId).toBeNull();
  });

  it("`unpin` hands the task back to the router", () => {
    const task = addTask("Rebuild the landing page with responsive CSS");
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    unassignTask(deps, agencyId, { taskId: task.id, actorId: ACTOR, unpin: true });
    expect(routing.getDecision(agencyId, task.id)).toBeNull();

    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(operations.getTask(agencyId, task.id)!.assigneeId).not.toBeNull();
  });
});

describe("capacity", () => {
  it("does not pile an unbounded backlog onto one employee", () => {
    routing.setPolicy(agencyId, { maxTasksPerWorkerPerPass: 200, maxAssignmentsPerPass: 500 });
    for (let index = 0; index < 200; index += 1) {
      addTask(`Rebuild landing page ${index} with responsive CSS`);
    }
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });

    const wren = workers
      .listWorkers(agencyId, { type: "ai" })
      .find((w) => w.agentId === "web-builder")!;
    const mine = operations.listTasks(agencyId, { assigneeId: wren.id });
    // 168h effective × 0.8 headroom ÷ 2h per task ≈ 67 tasks, not 200.
    expect(mine.length).toBeLessThan(80);
    expect(mine.length).toBeGreaterThan(0);
  });

  it("retries understood work once the bench frees up, writing nothing meanwhile", () => {
    routing.setPolicy(agencyId, { maxTasksPerWorkerPerPass: 500, maxAssignmentsPerPass: 500 });
    const tasks = Array.from({ length: 90 }, (_, index) =>
      addTask(`Rebuild landing page ${index} with responsive CSS`),
    );
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    const blocked = tasks.filter((task) => !operations.getTask(agencyId, task.id)!.assigneeId);
    expect(blocked.length).toBeGreaterThan(0);

    // Nothing changed: understood-but-blocked work is re-scored and re-verified
    // every pass, and still writes nothing.
    expect(applyTaskRouting(deps, agencyId, { actorId: ACTOR }).writes).toBe(0);

    // Free the bench by completing the work that filled it.
    for (const task of tasks) {
      const current = operations.getTask(agencyId, task.id)!;
      if (!current.assigneeId) continue;
      operations.transitionTask(agencyId, task.id, "ready", ACTOR);
      operations.transitionTask(agencyId, task.id, "in_progress", ACTOR);
      operations.transitionTask(agencyId, task.id, "review", ACTOR);
      operations.transitionTask(agencyId, task.id, "done", ACTOR);
    }

    const recovered = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    expect(recovered.assigned).toBeGreaterThan(0);
  });

  it("carries load across passes instead of re-filling a full bench", () => {
    routing.setPolicy(agencyId, { maxTasksPerWorkerPerPass: 200, maxAssignmentsPerPass: 500 });
    for (let index = 0; index < 100; index += 1) {
      addTask(`Rebuild landing page ${index} with responsive CSS`);
    }
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    const wren = workers
      .listWorkers(agencyId, { type: "ai" })
      .find((w) => w.agentId === "web-builder")!;
    const afterFirst = operations.listTasks(agencyId, { assigneeId: wren.id }).length;

    for (let index = 100; index < 160; index += 1) {
      addTask(`Rebuild landing page ${index} with responsive CSS`);
    }
    applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    const afterSecond = operations.listTasks(agencyId, { assigneeId: wren.id }).length;
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("scale", () => {
  it("routes a 2853-task agency without blocking, and converges to zero writes", () => {
    routing.setPolicy(agencyId, { maxAssignmentsPerPass: 500, maxTasksPerWorkerPerPass: 500 });
    const titles = [
      "Rebuild the responsive landing page CSS",
      "Build the webhook api integration endpoint",
      "Write the seo newsletter campaign copy",
      "Prepare the client status report and kickoff agenda",
      "Do the needful",
    ];
    for (let index = 0; index < 2853; index += 1) {
      addTask(`${titles[index % titles.length]} #${index}`);
    }

    const firstStart = Date.now();
    const first = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    const firstMs = Date.now() - firstStart;
    expect(first.candidates).toBe(2853);
    expect(first.assigned + first.unmatched + first.deferred).toBe(2853);

    const secondStart = Date.now();
    const second = applyTaskRouting(deps, agencyId, { actorId: ACTOR });
    const secondMs = Date.now() - secondStart;
    // Converged. Understood-but-unplaceable work is re-scored every pass (it
    // must be, so it is picked up when capacity frees) yet still writes NOTHING
    // while the verdict is unchanged.
    expect(second.writes).toBe(0);

    // Generous ceilings; the point is that neither pass is anywhere near the
    // 15-minute operating-loop interval, and the converged pass is cheap.
    expect(firstMs).toBeLessThan(120_000);
    expect(secondMs).toBeLessThan(60_000);
  }, 300_000);
});
