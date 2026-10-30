import { getBudgetStore } from "../../budget/store.js";
import { getAllSubscriptions, getActiveSubscriptions } from "../../budget/subscriptions.js";
import { routeTask } from "../../budget/router.js";
import { scoreTaskComplexity } from "../../budget/complexity.js";
import { loadConfig } from "../../config/config.js";
import { STATE_DIR } from "../../config/paths.js";
import type { GatewayRequestHandlers } from "./types.js";

const getStore = () => {
  return getBudgetStore(STATE_DIR);
};

export const budgetHandlers: GatewayRequestHandlers = {
  "budget.status": async ({ respond }) => {
    try {
      const store = getStore();
      const monthlySummaries = store.getAllMonthlySpend();
      const dailyCosts = store.getDailyCosts(7);
      respond(true, {
        monthlySummaries,
        dailyCosts,
        updatedAt: Date.now(),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "budget.route": async ({ params, respond }) => {
    try {
      const config = loadConfig();
      const decision = await routeTask(
        {
          title: typeof params.title === "string" ? params.title : undefined,
          description: typeof params.description === "string" ? params.description : undefined,
          taskType: typeof params.taskType === "string" ? params.taskType : undefined,
          preferredProvider: typeof params.preferredProvider === "string" ? params.preferredProvider : undefined,
          forceLocal: params.forceLocal === true,
        },
        config,
      );
      respond(true, decision);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "budget.record": async ({ params, respond }) => {
    try {
      const store = getStore();
      const entry = store.recordUsage({
        provider: typeof params.provider === "string" ? params.provider : "unknown",
        model: typeof params.model === "string" ? params.model : undefined,
        tokensIn: typeof params.tokensIn === "number" ? params.tokensIn : 0,
        tokensOut: typeof params.tokensOut === "number" ? params.tokensOut : 0,
        costUsd: typeof params.costUsd === "number" ? params.costUsd : 0,
        agentId: typeof params.agentId === "string" ? params.agentId : "unknown",
        sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : undefined,
        timestamp: typeof params.timestamp === "number" ? params.timestamp : Date.now(),
      });
      respond(true, entry);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "budget.subscriptions": async ({ respond }) => {
    try {
      const config = loadConfig();
      const all = getAllSubscriptions(config);
      const active = getActiveSubscriptions(config);
      respond(true, { all, active });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "budget.history": async ({ params, respond }) => {
    try {
      const store = getStore();
      const limit = typeof params.limit === "number" ? Math.min(params.limit, 200) : 50;
      const entries = store.getRecentEntries(limit);
      respond(true, { entries, count: entries.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "budget.complexity": async ({ params, respond }) => {
    try {
      const score = scoreTaskComplexity({
        title: typeof params.title === "string" ? params.title : undefined,
        description: typeof params.description === "string" ? params.description : undefined,
        taskType: typeof params.taskType === "string" ? params.taskType : undefined,
        estimatedTokens: typeof params.estimatedTokens === "number" ? params.estimatedTokens : undefined,
      });
      respond(true, score);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
