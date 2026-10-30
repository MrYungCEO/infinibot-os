import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";
import { getBudgetStore } from "../../budget/store.js";
import { getActiveSubscriptions, getAllSubscriptions } from "../../budget/subscriptions.js";
import { routeTask } from "../../budget/router.js";
import { scoreTaskComplexity } from "../../budget/complexity.js";
import { loadConfig } from "../../config/config.js";

const BUDGET_ACTIONS = [
  "check_budget",
  "route_task",
  "record_usage",
  "get_subscriptions",
  "get_complexity",
] as const;

const BudgetToolSchema = Type.Object({
  action: stringEnum(BUDGET_ACTIONS),
  // route_task / get_complexity
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  task_type: Type.Optional(Type.String()),
  preferred_provider: Type.Optional(Type.String()),
  force_local: Type.Optional(Type.Boolean()),
  // record_usage
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  tokens_in: Type.Optional(Type.Number()),
  tokens_out: Type.Optional(Type.Number()),
  cost_usd: Type.Optional(Type.Number()),
  // check_budget
  days: Type.Optional(Type.Number()),
});

export function createBudgetTool(options?: { agentId?: string }): AnyAgentTool {
  const callingAgentId = options?.agentId || "main";

  return {
    label: "Budget",
    name: "budget",
    description:
      "Check API usage budget, get routing recommendations for task delegation, and record usage. Actions: check_budget (view monthly spend and remaining budget), route_task (get optimal provider/model for a task based on budget and complexity), record_usage (log API usage), get_subscriptions (list provider subscriptions), get_complexity (score task complexity).",
    parameters: BudgetToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "check_budget": {
          return await handleCheckBudget(params);
        }
        case "route_task": {
          return await handleRouteTask(params);
        }
        case "record_usage": {
          return await handleRecordUsage(params, callingAgentId);
        }
        case "get_subscriptions": {
          return await handleGetSubscriptions();
        }
        case "get_complexity": {
          return await handleGetComplexity(params);
        }
        default:
          return jsonResult({ status: "error", error: `Unknown action: ${action}` });
      }
    },
  };
}

async function handleCheckBudget(params: Record<string, unknown>) {
  try {
    const store = getBudgetStore();
    const days = readNumberParam(params, "days", { integer: true }) ?? 7;
    const monthlySummaries = store.getAllMonthlySpend();
    const dailyCosts = store.getDailyCosts(days);
    return jsonResult({
      status: "ok",
      monthlySummaries,
      dailyCosts,
      updatedAt: Date.now(),
    });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

async function handleRouteTask(params: Record<string, unknown>) {
  try {
    const config = loadConfig();
    const decision = await routeTask(
      {
        title: readStringParam(params, "title"),
        description: readStringParam(params, "description"),
        taskType: readStringParam(params, "task_type"),
        preferredProvider: readStringParam(params, "preferred_provider"),
        forceLocal: params.force_local === true,
      },
      config,
    );
    return jsonResult({ status: "ok", decision });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

async function handleRecordUsage(params: Record<string, unknown>, agentId: string) {
  try {
    const store = getBudgetStore();
    const entry = store.recordUsage({
      provider: readStringParam(params, "provider") ?? "unknown",
      model: readStringParam(params, "model"),
      tokensIn: readNumberParam(params, "tokens_in") ?? 0,
      tokensOut: readNumberParam(params, "tokens_out") ?? 0,
      costUsd: readNumberParam(params, "cost_usd") ?? 0,
      agentId,
      timestamp: Date.now(),
    });
    return jsonResult({ status: "ok", entry });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

async function handleGetSubscriptions() {
  try {
    const config = loadConfig();
    const active = getActiveSubscriptions(config);
    const all = getAllSubscriptions(config);
    return jsonResult({ status: "ok", active, all });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}

async function handleGetComplexity(params: Record<string, unknown>) {
  try {
    const score = scoreTaskComplexity({
      title: readStringParam(params, "title"),
      description: readStringParam(params, "description"),
      taskType: readStringParam(params, "task_type"),
    });
    return jsonResult({ status: "ok", complexity: score });
  } catch (err: any) {
    return jsonResult({ status: "error", error: err.message });
  }
}
