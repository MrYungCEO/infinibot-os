/**
 * `scheduled_task` agent tool — create and steer Scheduled Agent Tasks
 * (src/autonomy/scheduled-tasks): "every day at 5pm have Codex check X and
 * send me a plan". Each run is a read-only review that returns a standard
 * work-suggestion report; approved items continue as verified goal runs in
 * isolated worktrees, with a second approval before deploy.
 *
 * Every action proxies to the scheduledTasks.* gateway RPCs.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { RepoSpecSchema } from "../../gateway/protocol/schema/scheduled-tasks.js";

const ACTIONS = [
  "create",
  "list",
  "get",
  "update",
  "enable",
  "disable",
  "delete",
  "run_now",
  "run",
  "approvals",
  "decide",
] as const;

const DAY_CODES: Record<string, string> = {
  daily: "*",
  everyday: "*",
  weekdays: "1-5",
  weekends: "0,6",
  sun: "0",
  mon: "1",
  tue: "2",
  wed: "3",
  thu: "4",
  fri: "5",
  sat: "6",
};

/** "17:00" / "5pm" + "daily|weekdays|mon,thu" → cron. */
export function timeToCron(at: string, days = "daily"): string {
  const m = at
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new Error(`unrecognised time "${at}" — use HH:MM (24h) or e.g. 5pm`);
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (m[3] === "pm" && hour < 12) hour += 12;
  if (m[3] === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) throw new Error(`time out of range: ${at}`);
  const dow = days
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((d) => {
      const code = DAY_CODES[d] ?? DAY_CODES[d.slice(0, 3)];
      if (code === undefined) throw new Error(`unrecognised day "${d}"`);
      return code;
    });
  const dowExpr = dow.includes("*") ? "*" : dow.join(",");
  return `${minute} ${hour} * * ${dowExpr}`;
}

const ScheduledTaskToolSchema = Type.Object({
  action: stringEnum(ACTIONS),
  id: Type.Optional(Type.String({ description: "Scheduled task id (st_…)." })),
  name: Type.Optional(Type.String()),
  cron: Type.Optional(
    Type.String({ description: "Cron expression, e.g. '0 17 * * *' (daily 17:00)." }),
  ),
  at: Type.Optional(
    Type.String({ description: "Alternative to cron: time of day, e.g. '17:00' or '5pm'." }),
  ),
  days: Type.Optional(
    Type.String({ description: "With `at`: daily (default) | weekdays | weekends | mon,thu …" }),
  ),
  timezone: Type.Optional(
    Type.String({ description: "IANA timezone (default: the gateway's timezone)." }),
  ),
  agent: Type.Optional(
    Type.String({
      description:
        "Assignee: CLI backend (claude-code | codex | opencode | gemini | grok) or a gateway agent id. Default claude-code.",
    }),
  ),
  model: Type.Optional(Type.String()),
  repos: Type.Optional(
    Type.Array(Type.Union([RepoSpecSchema, Type.String()]), {
      description: "Repos to review: absolute paths, or {label, path, branch?, focus?, notes?}.",
    }),
  ),
  instructions: Type.Optional(
    Type.String({ description: "What to check / focus on; added to the standard review prompt." }),
  ),
  delivery: Type.Optional(
    Type.Array(stringEnum(["telegram", "ui"] as const), {
      description: "Where the report goes (default telegram + ui).",
    }),
  ),
  deployCommand: Type.Optional(
    Type.String({
      description:
        "Owner deploy command for the deploy stage; overrides the agent's proposed commands.",
    }),
  ),
  requireDeployApproval: Type.Optional(Type.Boolean()),
  runNow: Type.Optional(Type.Boolean({ description: "create: also run once right away." })),
  runId: Type.Optional(
    Type.String({ description: "run: run id (sr_…); decide approve_low_risk." }),
  ),
  itemId: Type.Optional(Type.String({ description: "decide: pipeline item id (si_…)." })),
  decision: Type.Optional(
    stringEnum([
      "approve",
      "reject",
      "modify",
      "snooze",
      "start",
      "approve_deploy",
      "reject_deploy",
      "retry",
      "continue",
      "approve_low_risk",
    ] as const),
  ),
  instruction: Type.Optional(Type.String({ description: "decide modify/continue: the change." })),
});

function defaultTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function createScheduledTaskTool(): AnyAgentTool {
  const opts: GatewayCallOptions = { timeoutMs: 60_000 };
  return {
    label: "Scheduled task",
    name: "scheduled_task",
    description:
      "Schedule an agent or CLI (claude-code | codex | opencode | gemini | grok | gateway agent) to review repos on a cron schedule and send the owner a standard work-suggestion report (repo health + suggested items, each with dev / test / deploy plan) to Telegram + the Autonomy page. " +
      "Approved items continue automatically as verified goal runs in isolated git worktrees; deploys need a second approval. Nothing merges, pushes or deploys without the owner's approval. " +
      "Actions: create {name, cron | at(+days), timezone?, agent?, model?, repos[], instructions?, delivery?, deployCommand?, runNow?}, list, get {id}, update {id, …fields}, enable {id}, disable {id}, delete {id}, run_now {id}, run {runId}, approvals, decide {itemId, decision, instruction?} (approve_low_risk takes runId). " +
      "Example: 'every day at 5pm have Codex check ~/app and send me a plan' → create {name:'App daily review', at:'17:00', agent:'codex', repos:['/abs/path/app']}.",
    parameters: ScheduledTaskToolSchema,
    execute: async (_id, args) => {
      const p = args as Record<string, unknown>;
      const action = readStringParam(p, "action", { required: true });
      const id = readStringParam(p, "id");
      const needId = () => {
        if (!id) throw new Error(`scheduled_task ${action}: id is required`);
        return id;
      };
      const fields = (): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        const at = readStringParam(p, "at");
        const cron =
          readStringParam(p, "cron") ||
          (at ? timeToCron(at, readStringParam(p, "days") || "daily") : undefined);
        if (cron) out.cron = cron;
        for (const k of ["name", "timezone", "instructions", "deployCommand", "model"] as const) {
          const v = readStringParam(p, k);
          if (v) out[k] = v;
        }
        const agent = readStringParam(p, "agent");
        if (agent) out.assignee = agent.replace(/^claude$/, "claude-code");
        if (Array.isArray(p.repos)) out.repos = p.repos;
        if (Array.isArray(p.delivery)) out.delivery = p.delivery;
        if (typeof p.requireDeployApproval === "boolean")
          out.approval = { requireDeployApproval: p.requireDeployApproval };
        return out;
      };
      switch (action) {
        case "create": {
          const f = fields();
          if (!f.name) throw new Error("scheduled_task create: name is required");
          if (!f.cron) throw new Error("scheduled_task create: cron or at is required");
          const res = await callGatewayTool("scheduledTasks.create", opts, {
            timezone: defaultTz(),
            ...f,
            ...(p.runNow === true ? { runNow: true } : {}),
          });
          return jsonResult(res as object);
        }
        case "list":
          return jsonResult((await callGatewayTool("scheduledTasks.list", opts, {})) as object);
        case "get":
          return jsonResult(
            (await callGatewayTool("scheduledTasks.get", opts, { id: needId() })) as object,
          );
        case "update":
          return jsonResult(
            (await callGatewayTool("scheduledTasks.update", opts, {
              id: needId(),
              patch: fields(),
            })) as object,
          );
        case "enable":
        case "disable":
          return jsonResult(
            (await callGatewayTool("scheduledTasks.update", opts, {
              id: needId(),
              patch: { enabled: action === "enable" },
            })) as object,
          );
        case "delete":
          return jsonResult(
            (await callGatewayTool("scheduledTasks.delete", opts, { id: needId() })) as object,
          );
        case "run_now":
          return jsonResult(
            (await callGatewayTool("scheduledTasks.runNow", opts, { id: needId() })) as object,
          );
        case "run": {
          const runId = readStringParam(p, "runId", { required: true });
          return jsonResult(
            (await callGatewayTool("scheduledTasks.runs.get", opts, { runId })) as object,
          );
        }
        case "approvals":
          return jsonResult(
            (await callGatewayTool(
              "scheduledTasks.approvals.list",
              opts,
              id ? { taskId: id } : {},
            )) as object,
          );
        case "decide": {
          const decision = readStringParam(p, "decision", { required: true });
          return jsonResult(
            (await callGatewayTool("scheduledTasks.approvals.decide", opts, {
              action: decision,
              ...(readStringParam(p, "itemId") ? { itemId: readStringParam(p, "itemId") } : {}),
              ...(readStringParam(p, "runId") ? { runId: readStringParam(p, "runId") } : {}),
              ...(readStringParam(p, "instruction")
                ? { instruction: readStringParam(p, "instruction") }
                : {}),
            })) as object,
          );
        }
        default:
          throw new Error(`scheduled_task: unknown action ${action}`);
      }
    },
  };
}
