/**
 * Scheduled Agent Tasks — gateway RPC handlers (src/autonomy/scheduled-tasks).
 *
 *   scheduledTasks.create / update / delete / runNow
 *   scheduledTasks.list / get                 tasks (+ recent runs)
 *   scheduledTasks.runs.get                   one run: report + items + log
 *   scheduledTasks.items.list / items.get     pipeline items (+ stage log)
 *   scheduledTasks.approvals.list             items waiting for the owner
 *   scheduledTasks.approvals.decide           approve | reject | modify | snooze | start |
 *                                             approve_deploy | reject_deploy | retry |
 *                                             continue | approve_low_risk
 *
 * Params are validated against protocol/schema/scheduled-tasks.ts. Event:
 * `scheduledTask.changed` {taskId, runId?, itemId?}.
 */

import AjvPkg, { type ErrorObject } from "ajv";
import type { TSchema } from "@sinclair/typebox";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import {
  ScheduledTaskApprovalsListParamsSchema,
  ScheduledTaskDecideParamsSchema,
  ScheduledTaskIdParamsSchema,
  ScheduledTaskItemGetParamsSchema,
  ScheduledTaskItemsListParamsSchema,
  ScheduledTaskRunGetParamsSchema,
  ScheduledTasksCreateParamsSchema,
  ScheduledTasksListParamsSchema,
  ScheduledTasksUpdateParamsSchema,
  type ScheduledTaskDecideParams,
  type ScheduledTaskItemsListParams,
  type ScheduledTasksCreateParams,
  type ScheduledTasksUpdateParams,
} from "../protocol/schema/scheduled-tasks.js";
import { parseGoalTarget } from "../../autonomy/goals/service.js";
import { actionsFor, STAGE_LABEL } from "../../autonomy/scheduled-tasks/pipeline.js";
import { describeCron } from "../../autonomy/scheduled-tasks/schedule.js";
import { getScheduledTaskService } from "../../autonomy/scheduled-tasks/runtime.js";
import type { TaskInput } from "../../autonomy/scheduled-tasks/service.js";
import {
  ITEM_DECISION_STAGES,
  type ItemStage,
  type PipelineItem,
} from "../../autonomy/scheduled-tasks/types.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
});

function validator<T>(schema: TSchema) {
  const fn = ajv.compile<T>(schema);
  return (params: unknown, respond: RespondFn): T | null => {
    const p = params ?? {};
    if (fn(p)) return p as T;
    const msg = (fn.errors ?? [])
      .map((e: ErrorObject) => `${e.instancePath || "params"} ${e.message ?? "invalid"}`)
      .join("; ");
    respond(false, undefined, { code: "INVALID_PARAMS", message: msg || "invalid params" });
    return null;
  };
}

const vCreate = validator<ScheduledTasksCreateParams>(ScheduledTasksCreateParamsSchema);
const vUpdate = validator<ScheduledTasksUpdateParams>(ScheduledTasksUpdateParamsSchema);
const vId = validator<{ id: string }>(ScheduledTaskIdParamsSchema);
const vList = validator<{ includeDisabled?: boolean }>(ScheduledTasksListParamsSchema);
const vRun = validator<{ runId: string }>(ScheduledTaskRunGetParamsSchema);
const vItems = validator<ScheduledTaskItemsListParams>(ScheduledTaskItemsListParamsSchema);
const vItem = validator<{ itemId: string }>(ScheduledTaskItemGetParamsSchema);
const vApprovals = validator<{ taskId?: string }>(ScheduledTaskApprovalsListParamsSchema);
const vDecide = validator<ScheduledTaskDecideParams>(ScheduledTaskDecideParamsSchema);

function fail(respond: RespondFn, err: unknown, code = "INVALID_PARAMS"): void {
  const message = err instanceof Error ? err.message : String(err);
  respond(false, undefined, { code: /not found/.test(message) ? "NOT_FOUND" : code, message });
}

/** Loose RPC/tool input → service TaskInput (assignee string/object + model). */
export function toTaskInput(p: Record<string, unknown>): TaskInput {
  const out: TaskInput = {};
  for (const k of [
    "name",
    "cron",
    "timezone",
    "repos",
    "instructions",
    "reportTemplate",
    "delivery",
    "approval",
    "limits",
    "deployCommand",
    "enabled",
  ] as const) {
    if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  }
  if (p.assignee !== undefined || p.model !== undefined) {
    const target = parseGoalTarget(p.assignee ?? "claude-code");
    if (typeof p.model === "string" && p.model.trim()) target.model = p.model.trim();
    out.assignee = target;
  }
  return out;
}

export function itemView(it: PipelineItem) {
  const svc = getScheduledTaskService();
  const task = svc.store.getTask(it.taskId);
  return {
    ...it,
    stageLabel: STAGE_LABEL[it.stage],
    actions: task ? actionsFor(it.stage, task.approval) : [],
    taskName: task?.name ?? null,
  };
}

function taskView(taskId: string) {
  const svc = getScheduledTaskService();
  const t = svc.store.getTask(taskId);
  if (!t) return null;
  return { ...svc.summarizeTask(t), scheduleText: describeCron(t.cron, t.timezone) };
}

export const SCHEDULED_TASKS_READ_METHODS = [
  "scheduledTasks.list",
  "scheduledTasks.get",
  "scheduledTasks.runs.get",
  "scheduledTasks.items.list",
  "scheduledTasks.items.get",
  "scheduledTasks.approvals.list",
] as const;

export const SCHEDULED_TASKS_WRITE_METHODS = [
  "scheduledTasks.create",
  "scheduledTasks.update",
  "scheduledTasks.delete",
  "scheduledTasks.runNow",
  "scheduledTasks.approvals.decide",
] as const;

export const scheduledTasksHandlers: GatewayRequestHandlers = {
  "scheduledTasks.create": ({ params, respond, client }) => {
    const p = vCreate(params, respond);
    if (!p) return;
    try {
      const svc = getScheduledTaskService();
      const task = svc.createTask({
        ...toTaskInput(p as Record<string, unknown>),
        createdBy: client?.authUser || client?.saasEmail || "control-ui",
      });
      const run = p.runNow ? svc.runNow(task.id) : null;
      respond(true, { id: task.id, task: taskView(task.id), run });
    } catch (err) {
      fail(respond, err);
    }
  },

  "scheduledTasks.update": ({ params, respond }) => {
    const p = vUpdate(params, respond);
    if (!p) return;
    try {
      getScheduledTaskService().updateTask(p.id, toTaskInput(p.patch as Record<string, unknown>));
      respond(true, { task: taskView(p.id) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "scheduledTasks.delete": async ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    try {
      await getScheduledTaskService().deleteTask(p.id);
      respond(true, { ok: true, id: p.id });
    } catch (err) {
      fail(respond, err);
    }
  },

  "scheduledTasks.runNow": ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    try {
      const run = getScheduledTaskService().runNow(p.id, "manual");
      respond(true, { run, task: taskView(p.id) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "scheduledTasks.list": ({ params, respond }) => {
    const p = vList(params, respond);
    if (!p) return;
    try {
      const svc = getScheduledTaskService();
      const tasks = svc.store
        .listTasks()
        .filter((t) => p.includeDisabled !== false || t.enabled)
        .map((t) => taskView(t.id));
      respond(true, { tasks });
    } catch (err) {
      fail(respond, err, "INTERNAL_ERROR");
    }
  },

  "scheduledTasks.get": ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    const svc = getScheduledTaskService();
    const task = taskView(p.id);
    if (!task) return fail(respond, new Error(`scheduled task not found: ${p.id}`));
    const runs = svc.store.listRuns({ taskId: p.id, limit: 30 }).map((r) => ({
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      goalId: r.goalId,
      error: r.error,
      items: r.report?.items.length ?? null,
      summary: r.report?.summary ?? null,
      readOnlyViolations: r.readOnlyViolations,
      reportId: r.reportId,
      deliveredAt: r.deliveredAt,
      deliveryError: r.deliveryError,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    }));
    respond(true, { task, runs, events: svc.store.events({ taskId: p.id, limit: 100 }) });
  },

  "scheduledTasks.runs.get": ({ params, respond }) => {
    const p = vRun(params, respond);
    if (!p) return;
    const svc = getScheduledTaskService();
    const run = svc.store.getRun(p.runId);
    if (!run) return fail(respond, new Error(`run not found: ${p.runId}`));
    respond(true, {
      run,
      task: taskView(run.taskId),
      items: svc.store.listItems({ runId: run.id }).map(itemView),
      events: svc.store.events({ runId: run.id }),
    });
  },

  "scheduledTasks.items.list": ({ params, respond }) => {
    const p = vItems(params, respond);
    if (!p) return;
    const items = getScheduledTaskService()
      .store.listItems({
        taskId: p.taskId,
        runId: p.runId,
        stages: p.stages as ItemStage[] | undefined,
        limit: p.limit,
      })
      .map(itemView);
    respond(true, { items });
  },

  "scheduledTasks.items.get": ({ params, respond }) => {
    const p = vItem(params, respond);
    if (!p) return;
    const svc = getScheduledTaskService();
    const it = svc.store.getItem(p.itemId);
    if (!it) return fail(respond, new Error(`item not found: ${p.itemId}`));
    respond(true, { item: itemView(it), events: svc.store.events({ itemId: it.id }) });
  },

  "scheduledTasks.approvals.list": ({ params, respond }) => {
    const p = vApprovals(params, respond);
    if (!p) return;
    const items = getScheduledTaskService()
      .store.listItems({ taskId: p.taskId, stages: [...ITEM_DECISION_STAGES] })
      .map(itemView);
    respond(true, { items });
  },

  "scheduledTasks.approvals.decide": async ({ params, respond, client }) => {
    const p = vDecide(params, respond);
    if (!p) return;
    const actor = client?.authUser || client?.saasEmail || "control-ui";
    try {
      const svc = getScheduledTaskService();
      if (p.action === "approve_low_risk") {
        const runId = p.runId ?? (p.itemId ? svc.store.getItem(p.itemId)?.runId : undefined);
        if (!runId) throw new Error("approve_low_risk needs runId");
        const items = await svc.approveLowRisk(runId, actor);
        respond(true, { items: items.map(itemView) });
        return;
      }
      if (!p.itemId) throw new Error(`${p.action} needs itemId`);
      const item = await svc.decide(p.itemId, {
        action: p.action,
        instruction: p.instruction ?? null,
        snoozeHours: p.snoozeHours,
        actor,
      });
      respond(true, { item: itemView(item) });
    } catch (err) {
      fail(respond, err);
    }
  },
};
