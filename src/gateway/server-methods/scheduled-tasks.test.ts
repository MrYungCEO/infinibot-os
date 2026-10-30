import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "../../autonomy/goals/store.js";
import { createGoalRunner, setGoalRunnerForTests } from "../../autonomy/goals/service.js";
import type { GoalExecutor } from "../../autonomy/goals/runner.js";
import { MemorySink } from "../../autonomy/scheduled-tasks/delivery.js";
import {
  productionGoalsApi,
  setScheduledTaskServiceForTests,
} from "../../autonomy/scheduled-tasks/runtime.js";
import { ScheduledTaskService } from "../../autonomy/scheduled-tasks/service.js";
import { ScheduledTaskStore } from "../../autonomy/scheduled-tasks/store.js";

const state = mkdtempSync(join(tmpdir(), "sched-rpc-state-"));
const repo = mkdtempSync(join(tmpdir(), "sched-rpc-repo-"));
execFileSync("git", ["init", "-q", "-b", "main", repo]);
writeFileSync(join(repo, "a.txt"), "a");
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "commit",
  "-qm",
  "i",
]);

const executor: GoalExecutor = {
  async start(p) {
    if (p.prompt.includes("WORK SUGGESTION REPORT")) {
      writeFileSync(
        join(p.workdir!, "report.json"),
        JSON.stringify({
          summary: "ok",
          repos: [{ repo: "demo", branch: "main" }],
          items: [
            {
              id: "one",
              title: "One",
              why: "because",
              priority: "P2",
              effort: "S",
              risk: "low",
              repo: "demo",
              files: [],
              dev: { steps: ["x"] },
              checks: [{ type: "file", path: "a.txt" }],
              deploy: { steps: ["y"], rollback: "z" },
              approvals: [],
            },
          ],
        }),
      );
    }
    return { runId: `r-${Math.random()}`, sessionId: null };
  },
  async status() {
    return { state: "exited", exitCode: 0 };
  },
  async output() {
    return "";
  },
  async kill() {},
  supportsResume: () => false,
};

async function call(handlers: any, method: string, params: unknown) {
  let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
  await handlers[method]({
    params,
    client: null,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      out = { ok, payload, error };
    },
  });
  return out;
}

describe("scheduledTasks.* RPCs", () => {
  let handlers: any;
  let svc: ScheduledTaskService;
  beforeAll(async () => {
    const runner = createGoalRunner({ store: new GoalStore(state), executor });
    setGoalRunnerForTests(runner);
    svc = new ScheduledTaskService({
      store: new ScheduledTaskStore(state),
      goals: productionGoalsApi,
      sink: new MemorySink(),
      stateDir: state,
      renderPdf: null,
    });
    setScheduledTaskServiceForTests(svc);
    handlers = (await import("./scheduled-tasks.js")).scheduledTasksHandlers;
  });
  afterAll(() => {
    setScheduledTaskServiceForTests(null);
    setGoalRunnerForTests(null);
  });

  it("validates params (schema + schedule)", async () => {
    expect((await call(handlers, "scheduledTasks.create", { cron: "0 17 * * *" })).error.code).toBe(
      "INVALID_PARAMS",
    );
    const badTz = await call(handlers, "scheduledTasks.create", {
      name: "x",
      cron: "0 17 * * *",
      timezone: "Nowhere/City",
    });
    expect(badTz.error.message).toMatch(/timezone/);
    const badAssignee = await call(handlers, "scheduledTasks.create", {
      name: "x",
      cron: "0 17 * * *",
      assignee: { kind: "cli", backend: "vim" },
    });
    expect(badAssignee.ok).toBe(false);
    const badAction = await call(handlers, "scheduledTasks.approvals.decide", {
      itemId: "si_x",
      action: "yolo",
    });
    expect(badAction.error.code).toBe("INVALID_PARAMS");
  });

  it("create (runNow) → list → get → run → approvals → decide → update → delete", async () => {
    const created = await call(handlers, "scheduledTasks.create", {
      name: "RPC review",
      cron: "0 17 * * *",
      timezone: "Asia/Bangkok",
      assignee: "codex",
      model: "gpt-5.5",
      repos: [{ label: "demo", path: repo, branch: "main" }],
      runNow: true,
    });
    expect(created.ok).toBe(true);
    const id = created.payload.id;
    expect(created.payload.task.assignee).toEqual({
      kind: "cli",
      backend: "codex",
      model: "gpt-5.5",
    });
    expect(created.payload.task.scheduleText).toBe("Daily at 17:00 Asia/Bangkok");
    expect(created.payload.run.status).toBe("running");
    for (let i = 0; i < 4; i++) {
      await setGoalRunnerTick();
      await svc.tick();
    }
    const list = await call(handlers, "scheduledTasks.list", {});
    expect(list.payload.tasks.map((t: any) => t.id)).toContain(id);
    const got = await call(handlers, "scheduledTasks.get", { id });
    expect(got.payload.runs[0].status).toBe("delivered");
    const run = await call(handlers, "scheduledTasks.runs.get", { runId: got.payload.runs[0].id });
    expect(run.payload.items[0].actions).toEqual(["approve", "modify", "reject", "snooze"]);
    const approvals = await call(handlers, "scheduledTasks.approvals.list", {});
    expect(approvals.payload.items).toHaveLength(1);
    const itemId = approvals.payload.items[0].id;
    const snoozed = await call(handlers, "scheduledTasks.approvals.decide", {
      itemId,
      action: "snooze",
      snoozeHours: 2,
    });
    expect(snoozed.payload.item.stage).toBe("snoozed");
    const illegal = await call(handlers, "scheduledTasks.approvals.decide", {
      itemId,
      action: "approve_deploy",
    });
    expect(illegal.ok).toBe(false);
    const rejected = await call(handlers, "scheduledTasks.approvals.decide", {
      itemId,
      action: "reject",
    });
    expect(rejected.payload.item.stage).toBe("rejected");
    const item = await call(handlers, "scheduledTasks.items.get", { itemId });
    expect(item.payload.events.map((e: any) => e.to)).toEqual(["suggested", "snoozed", "rejected"]);
    const upd = await call(handlers, "scheduledTasks.update", {
      id,
      patch: { enabled: false, cron: "30 9 * * 1-5" },
    });
    expect(upd.payload.task.enabled).toBe(false);
    expect(upd.payload.task.scheduleText).toBe("Weekdays at 09:30 Asia/Bangkok");
    expect((await call(handlers, "scheduledTasks.delete", { id })).ok).toBe(true);
    expect((await call(handlers, "scheduledTasks.get", { id })).error.code).toBe("NOT_FOUND");
  });

  it("is registered, scoped and advertised", async () => {
    const { listGatewayMethods, GATEWAY_EVENTS } = await import("../server-methods-list.js");
    const { coreGatewayHandlers, handleGatewayRequest } = await import("../server-methods.js");
    const { SCHEDULED_TASKS_READ_METHODS, SCHEDULED_TASKS_WRITE_METHODS } =
      await import("./scheduled-tasks.js");
    for (const m of [...SCHEDULED_TASKS_READ_METHODS, ...SCHEDULED_TASKS_WRITE_METHODS]) {
      expect(listGatewayMethods()).toContain(m);
      expect(coreGatewayHandlers[m]).toBeTypeOf("function");
    }
    expect(GATEWAY_EVENTS).toContain("scheduledTask.changed");
    const ask = async (method: string, scopes: string[]) => {
      let res: { ok: boolean; error?: any } = { ok: false };
      await handleGatewayRequest({
        req: { type: "req", id: "1", method, params: {} },
        client: { connect: { role: "operator", scopes } } as any,
        isWebchatConnect: () => false,
        context: {} as any,
        respond: (ok: boolean, _p?: unknown, error?: unknown) => {
          res = { ok, error };
        },
      } as any);
      return res;
    };
    expect((await ask("scheduledTasks.list", ["operator.read"])).ok).toBe(true);
    const denied = await ask("scheduledTasks.approvals.decide", ["operator.read"]);
    expect(denied.error?.message).toMatch(/operator.write/);
  });
});

async function setGoalRunnerTick() {
  const { getGoalRunner } = await import("../../autonomy/goals/service.js");
  await getGoalRunner().tick();
}
