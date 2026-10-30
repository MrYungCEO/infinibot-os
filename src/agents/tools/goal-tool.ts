/**
 * Goal Tool — exposes /goal operations as an MCP-style agent tool.
 *
 * Actions: set | status | pause | resume | clear | subtask_add (alias: subgoal_add)
 * Each delegates to the gateway autonomy.goal.* RPCs via callGateway.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";
import { callGateway } from "../../gateway/call.js";

// COORDINATION: goal-rename — subtask_add is the canonical name; subgoal_add kept for backcompat
const GOAL_ACTIONS = [
  "set",
  "status",
  "pause",
  "resume",
  "clear",
  "subtask_add",
  "subgoal_add",
] as const;

const GoalToolSchema = Type.Object({
  action: stringEnum(GOAL_ACTIONS),
  // set
  text: Type.Optional(Type.String()),
  budget: Type.Optional(Type.Number()),
  // COORDINATION: prefire-telegram-push — opt-in: push pre-fire form to Telegram when set=true
  notify_telegram: Type.Optional(Type.Boolean()),
  // COORDINATION: goal-orchestrator-mode — "orchestrator" (default) or "single" (legacy flat LLM)
  mode: Type.Optional(stringEnum(["orchestrator", "single"] as const)),
  // status / clear
  task_id: Type.Optional(Type.String()),
  // subtask_add (subgoal_add is a backcompat alias)
  parent_task_id: Type.Optional(Type.String()),
  subtask_text: Type.Optional(Type.String()),
  /** @deprecated use subtask_text */
  subgoal_text: Type.Optional(Type.String()),
});

export function createGoalTool(): AnyAgentTool {
  return {
    label: "Goal",
    name: "goal",
    // COORDINATION: goal-rename — description updated to use subtask vocabulary
    // COORDINATION: goal-orchestrator-mode — added mode param
    description:
      "Manage autonomous goals (Hermes-style goal loop). Actions: " +
      "set (enqueue a new goal; optional mode='orchestrator'|'single' — default orchestrator spawns parallel sub-agents; mode='single' uses legacy flat LLM; pass notify_telegram=true to push pre-fire questions to Telegram), " +
      "status (get status of a goal by task_id, or list all), " +
      "pause (pause all running goal loops), " +
      "resume (resume paused goal loops), " +
      "clear (cancel + archive a goal by task_id), " +
      "subtask_add (add a kanban subtask under parent_task_id using subtask_text). " +
      "For work that must be VERIFIED (tests pass, file exists, URL responds) use goal_run instead.",
    parameters: GoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "set": {
          const text = readStringParam(params, "text", { required: true });
          const budget = readNumberParam(params, "budget", { integer: true }) ?? 20;
          // COORDINATION: prefire-telegram-push — pass opt-in flag to gateway enqueue
          const notifyTelegram = params.notify_telegram === true;
          // COORDINATION: goal-orchestrator-mode — default "orchestrator"; pass --single via mode param
          const modeParam = readStringParam(params, "mode");
          const goalMode: "orchestrator" | "single" =
            modeParam === "single" ? "single" : "orchestrator";
          const enqueueParams: Record<string, unknown> = { text, budget, goalMode };
          if (notifyTelegram) enqueueParams.notifyPrefireViaTelegram = true;
          const res = (await callGateway({
            method: "autonomy:goal.enqueue",
            params: enqueueParams,
            timeoutMs: 12_000,
          })) as any;
          return jsonResult({
            status: "ok",
            taskId: res?.taskId,
            goalMode: res?.goalMode ?? goalMode,
            message:
              (res?.message ?? `Goal enqueued (budget: ${budget} turns, mode: ${goalMode})`) +
              (notifyTelegram ? "; pre-fire questions will be pushed to Telegram" : ""),
          });
        }

        case "status": {
          const taskId = readStringParam(params, "task_id");
          if (taskId) {
            const res = (await callGateway({
              method: "autonomy:goal.status",
              params: { taskId },
              timeoutMs: 8_000,
            })) as any;
            return jsonResult({ status: "ok", goal: res });
          }
          // List all goals.
          const res = (await callGateway({
            method: "autonomy:goal.list",
            params: {},
            timeoutMs: 8_000,
          })) as any;
          return jsonResult({ status: "ok", goals: res?.goals ?? [], total: res?.total ?? 0 });
        }

        case "pause": {
          await callGateway({
            method: "autonomy:pause",
            params: { reason: "goal tool pause" },
            timeoutMs: 5_000,
          });
          return jsonResult({
            status: "ok",
            message: "Autonomy paused. Goal loops halt at next turn boundary.",
          });
        }

        case "resume": {
          await callGateway({ method: "autonomy:resume", params: {}, timeoutMs: 5_000 });
          return jsonResult({ status: "ok", message: "Autonomy resumed." });
        }

        case "clear": {
          const taskId = readStringParam(params, "task_id", { required: true });
          await callGateway({
            method: "autonomy:goal.clear",
            params: { taskId },
            timeoutMs: 8_000,
          });
          return jsonResult({ status: "ok", message: `Goal ${taskId} cleared.` });
        }

        // COORDINATION: goal-rename — subtask_add is canonical; subgoal_add is a backcompat alias
        case "subtask_add":
        case "subgoal_add": {
          const parentTaskId = readStringParam(params, "parent_task_id", { required: true });
          // Accept subtask_text (canonical) or legacy subgoal_text
          const subtaskText =
            readStringParam(params, "subtask_text") ??
            readStringParam(params, "subgoal_text", { required: true });
          const res = (await callGateway({
            method: "autonomy:goal.subtask_add",
            params: { parentTaskId, text: subtaskText },
            timeoutMs: 8_000,
          })) as any;
          return jsonResult({
            status: "ok",
            parentTaskId,
            subtaskKanbanId: res?.subgoalKanbanId ?? null,
            childTaskIds: res?.childTaskIds ?? res?.subgoalTaskIds ?? [],
          });
        }

        default:
          return jsonResult({ status: "error", error: `Unknown action: ${action}` });
      }
    },
  };
}
