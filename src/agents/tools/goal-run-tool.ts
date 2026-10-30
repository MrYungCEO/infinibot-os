/**
 * `goal_run` agent tool — start and steer verified autonomous goal runs
 * (`/goal`-style, src/autonomy/goals). Unlike the legacy `goal` tool (LLM
 * judge only), a goal run keeps an agent working until explicit checks pass:
 * shell commands (exit 0), file/grep assertions, or LLM-judged criteria.
 *
 * Every action proxies to the `goals.*` gateway RPCs so the run is durable,
 * shows up on the Autonomy page and notifies on completion/failure.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { GoalCheckSchema, GoalLimitsSchema } from "../../gateway/protocol/schema/goals.js";

const GOAL_RUN_ACTIONS = [
  "start",
  "list",
  "status",
  "pause",
  "resume",
  "cancel",
  "recheck",
  "continue",
  "retry",
] as const;

const GoalRunToolSchema = Type.Object({
  action: stringEnum(GOAL_RUN_ACTIONS),
  // start
  goal: Type.Optional(Type.String({ description: "What the agent must achieve." })),
  title: Type.Optional(Type.String()),
  checks: Type.Optional(
    Type.Array(GoalCheckSchema, {
      description:
        "Completion checks. shell {command} passes on exit 0; file {path[,negate]}; grep {path,pattern[,negate]}; llm {criterion}.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description:
        "CLI backend (claude-code | codex | opencode | gemini | grok) or a gateway agent id from agents_list (e.g. 'coder'). Default claude-code.",
    }),
  ),
  model: Type.Optional(Type.String()),
  workdir: Type.Optional(
    Type.String({ description: "Absolute project directory the agent works in." }),
  ),
  limits: Type.Optional(GoalLimitsSchema),
  // status / controls
  id: Type.Optional(Type.String({ description: "Goal run id (goal_…)." })),
  instruction: Type.Optional(
    Type.String({ description: "continue: extra instruction for the agent." }),
  ),
});

function gatewayOpts(): GatewayCallOptions {
  return { timeoutMs: 60_000 };
}

export function createGoalRunTool(): AnyAgentTool {
  return {
    label: "Goal run",
    name: "goal_run",
    description:
      "Start or steer a verified autonomous goal run: an agent (any CLI backend or gateway agent) keeps working until every completion check passes (or max iterations/time is hit). " +
      "Actions: start {goal, checks[], agent?, model?, workdir?, limits?}, list, status {id}, pause {id}, resume {id}, cancel {id}, recheck {id}, continue {id, instruction}, retry {id}. " +
      "Prefer shell checks (e.g. `pnpm test`, `curl -f http://…`, `grep -q X file`) — success is never declared on process exit alone.",
    parameters: GoalRunToolSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const opts = gatewayOpts();
      const id = readStringParam(params, "id");
      const needId = () => {
        if (!id) throw new Error(`goal_run ${action}: id is required`);
        return id;
      };
      switch (action) {
        case "start": {
          const goal = readStringParam(params, "goal", { required: true });
          const agent = readStringParam(params, "agent") || "claude-code";
          const cli = ["claude-code", "claude", "codex", "opencode", "gemini", "grok"].includes(
            agent,
          );
          const model = readStringParam(params, "model") || undefined;
          const target = cli
            ? { kind: "cli", backend: agent === "claude" ? "claude-code" : agent, model }
            : { kind: "agent", agentId: agent.replace(/^agent:/, ""), model };
          const res = (await callGatewayTool("goals.create", opts, {
            goal,
            title: readStringParam(params, "title") || undefined,
            checks: Array.isArray(params.checks) ? params.checks : [],
            target,
            workdir: readStringParam(params, "workdir") || undefined,
            limits: params.limits && typeof params.limits === "object" ? params.limits : undefined,
          })) as { id?: string; summary?: unknown };
          return jsonResult({
            status: "started",
            id: res?.id,
            summary: res?.summary,
            hint: "Check progress with goal_run status {id}; you will also be notified on completion or failure.",
          });
        }
        case "list":
          return jsonResult(await callGatewayTool("goals.list", opts, { limit: 30 }));
        case "status": {
          const res = (await callGatewayTool("goals.get", opts, { id: needId() })) as {
            summary?: unknown;
            run?: {
              iterations?: Array<Record<string, unknown>>;
              lastResults?: unknown;
              reason?: unknown;
            };
          };
          const iterations = (res?.run?.iterations ?? []).map((i) => ({
            index: i.index,
            outcome: i.outcome,
            exitCode: i.exitCode,
            note: i.note,
          }));
          return jsonResult({
            summary: res?.summary,
            iterations,
            lastResults: res?.run?.lastResults,
          });
        }
        case "pause":
        case "resume":
        case "cancel":
        case "recheck":
        case "retry":
          return jsonResult(
            (await callGatewayTool(`goals.${action}`, opts, { id: needId() })) as object,
          );
        case "continue":
          return jsonResult(
            (await callGatewayTool("goals.continue", opts, {
              id: needId(),
              instruction: readStringParam(params, "instruction") || undefined,
            })) as object,
          );
        default:
          throw new Error(`goal_run: unknown action ${action}`);
      }
    },
  };
}
