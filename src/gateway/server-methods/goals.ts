/**
 * Goal runs — gateway RPC handlers (`/goal`-style verified autonomous runs).
 *
 *   goals.create   — goal + completion checks + agent target (+ limits) → run
 *   goals.list     — summaries (optionally filtered by status)
 *   goals.get      — full run incl. iterations + per-check history
 *   goals.log      — live (or final) agent output of an iteration
 *   goals.pause / goals.resume / goals.cancel
 *   goals.recheck  — run every check now (completes the run if all pass)
 *   goals.continue — add an instruction / reopen a finished run
 *   goals.retry    — reopen a failed / exhausted / canceled run
 *   goals.delete   — remove a finished run
 *
 * Params are validated against the TypeBox schemas in
 * protocol/schema/goals.ts. Events: goal.created | goal.updated |
 * goal.iteration | goal.checked | goal.completed | goal.failed + goal.changed.
 */

import AjvPkg, { type ErrorObject } from "ajv";
import type { TSchema } from "@sinclair/typebox";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import {
  GoalIdParamsSchema,
  GoalsContinueParamsSchema,
  GoalsCreateParamsSchema,
  GoalsListParamsSchema,
  GoalsLogParamsSchema,
  type GoalIdParams,
  type GoalsLogParams,
  type GoalsContinueParams,
  type GoalsListParams,
} from "../protocol/schema/goals.js";
import { createGoalFromInput, getGoalRunner, summarizeGoal } from "../../autonomy/goals/service.js";
import { GOAL_TERMINAL_STATUSES, type GoalRunStatus } from "../../autonomy/goals/types.js";
import { broadcastQueueBridgeEvent } from "../../queue/events.js";

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

const vCreate = validator<Record<string, unknown>>(GoalsCreateParamsSchema);
const vList = validator<GoalsListParams>(GoalsListParamsSchema);
const vId = validator<GoalIdParams>(GoalIdParamsSchema);
const vLog = validator<GoalsLogParams>(GoalsLogParamsSchema);
const vContinue = validator<GoalsContinueParams>(GoalsContinueParamsSchema);

function fail(respond: RespondFn, err: unknown, code = "INTERNAL_ERROR"): void {
  const message = err instanceof Error ? err.message : String(err);
  respond(false, undefined, {
    code: /not found/.test(message) ? "NOT_FOUND" : code,
    message,
  });
}

function detail(id: string) {
  const runner = getGoalRunner();
  const run = runner.store.get(id);
  if (!run) return null;
  return { run, summary: summarizeGoal(run), history: runner.store.checkHistory(id) };
}

export const GOALS_READ_METHODS = ["goals.list", "goals.get", "goals.log"] as const;
export const GOALS_WRITE_METHODS = [
  "goals.create",
  "goals.pause",
  "goals.resume",
  "goals.cancel",
  "goals.recheck",
  "goals.continue",
  "goals.retry",
  "goals.delete",
] as const;

export const goalsHandlers: GatewayRequestHandlers = {
  "goals.create": ({ params, respond, client }) => {
    const p = vCreate(params, respond);
    if (!p) return;
    try {
      const run = createGoalFromInput({
        ...p,
        createdBy: client?.authUser || client?.saasEmail || "control-ui",
      });
      respond(true, { id: run.id, summary: summarizeGoal(run), run });
    } catch (err) {
      fail(respond, err, "INVALID_PARAMS");
    }
  },

  "goals.list": ({ params, respond }) => {
    const p = vList(params, respond);
    if (!p) return;
    try {
      const runs = getGoalRunner().store.list({
        status: p.status as GoalRunStatus[] | undefined,
        limit: p.limit,
      });
      respond(true, { goals: runs.map(summarizeGoal) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "goals.get": ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    const d = detail(p.id);
    if (!d) return fail(respond, new Error(`goal run not found: ${p.id}`));
    respond(true, d);
  },

  "goals.log": async ({ params, respond }) => {
    const p = vLog(params, respond);
    if (!p) return;
    try {
      respond(true, await getGoalRunner().log(p.id, p.iteration));
    } catch (err) {
      fail(respond, err);
    }
  },

  "goals.pause": async ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    try {
      await getGoalRunner().pause(p.id);
      respond(true, detail(p.id));
    } catch (err) {
      fail(respond, err);
    }
  },

  "goals.resume": async ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    try {
      await getGoalRunner().resume(p.id);
      respond(true, detail(p.id));
    } catch (err) {
      fail(respond, err);
    }
  },

  "goals.cancel": async ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    try {
      await getGoalRunner().cancel(p.id);
      respond(true, detail(p.id));
    } catch (err) {
      fail(respond, err);
    }
  },

  "goals.recheck": async ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    try {
      const { allPass } = await getGoalRunner().recheck(p.id);
      respond(true, { allPass, ...detail(p.id) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "goals.continue": async ({ params, respond }) => {
    const p = vContinue(params, respond);
    if (!p) return;
    try {
      await getGoalRunner().continueWith(p.id, p.instruction ?? null);
      respond(true, detail(p.id));
    } catch (err) {
      fail(respond, err);
    }
  },

  "goals.retry": async ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    try {
      await getGoalRunner().retry(p.id);
      respond(true, detail(p.id));
    } catch (err) {
      fail(respond, err);
    }
  },

  "goals.delete": ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    try {
      const store = getGoalRunner().store;
      const run = store.get(p.id);
      if (!run) return fail(respond, new Error(`goal run not found: ${p.id}`));
      if (!GOAL_TERMINAL_STATUSES.has(run.status) && run.status !== "paused") {
        return fail(
          respond,
          new Error("cancel or pause the run before deleting it"),
          "INVALID_PARAMS",
        );
      }
      store.delete(p.id);
      broadcastQueueBridgeEvent("goal.changed", { id: p.id, deleted: true });
      respond(true, { ok: true, id: p.id });
    } catch (err) {
      fail(respond, err);
    }
  },
};
