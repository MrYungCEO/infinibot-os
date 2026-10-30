/**
 * autonomous-task-tool — lets agents create, list, update, and assign tasks
 * on the Autonomous Kanban board.
 */

import { Type } from "@sinclair/typebox";
import { getAutonomousTasksStore } from "../../gateway/server-methods/autonomous-tasks.js";
import type { AutonomousTaskPriority, AutonomousTaskStatus } from "../../gateway/server-methods/autonomous-tasks.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { stringEnum } from "../schema/typebox.js";

const STATUSES = ["inbox", "ready", "in_progress", "review", "done"] as const;
const PRIORITIES = ["low", "normal", "high", "critical"] as const;
const ACTIONS = ["create", "list", "update", "assign"] as const;

const AutonomousTaskToolSchema = Type.Object({
  action: stringEnum(ACTIONS),
  /** create / update: task title */
  title: Type.Optional(Type.String()),
  /** create / update: scope / success description */
  scope: Type.Optional(Type.String()),
  /** create / update: absolute directory to work in (required on create) */
  workdir: Type.Optional(Type.String()),
  /** create / update / assign: agent id */
  agent_id: Type.Optional(Type.String()),
  /** create / update: priority */
  priority: Type.Optional(stringEnum(PRIORITIES)),
  /** create / update: status */
  status: Type.Optional(stringEnum(STATUSES)),
  /** create / update: linked kanban project id */
  project_id: Type.Optional(Type.String()),
  /** update / assign: task id */
  id: Type.Optional(Type.String()),
  /** list: filter by status */
  filter_status: Type.Optional(stringEnum(STATUSES)),
  /** list: filter by agent */
  filter_agent_id: Type.Optional(Type.String()),
});

export function createAutonomousTaskTool(): AnyAgentTool {
  return {
    name: "autonomous_task",
    label: "Autonomous Task Queue",
    description:
      "Create, list, update, and assign tasks on the Autonomous Kanban board. " +
      "Agents can self-assign tasks from Inbox, push new tasks into the queue, " +
      "and advance tasks through the pipeline.",
    parameters: AutonomousTaskToolSchema,
    execute: async (_toolCallId, args) => {
      const p = args as Record<string, unknown>;
      const action = String(p.action ?? "");
      const store = getAutonomousTasksStore();

      if (action === "create") {
        if (!p.title || typeof p.title !== "string") {
          return jsonResult({ ok: false, error: "title is required" });
        }
        if (!p.workdir || typeof p.workdir !== "string" || !p.workdir.trim()) {
          return jsonResult({ ok: false, error: "workdir is required" });
        }
        try {
          const task = store.create({
            title: p.title.trim(),
            scope: typeof p.scope === "string" ? p.scope : "",
            workdir: p.workdir.trim(),
            agent_id: typeof p.agent_id === "string" ? p.agent_id : null,
            priority: (PRIORITIES.includes(p.priority as AutonomousTaskPriority)
              ? p.priority
              : "normal") as AutonomousTaskPriority,
            project_id: typeof p.project_id === "string" ? p.project_id : null,
          });
          return jsonResult({ ok: true, task });
        } catch (e) {
          return jsonResult({ ok: false, error: String(e) });
        }
      }

      if (action === "list") {
        const filter: { status?: AutonomousTaskStatus; agent_id?: string } = {};
        if (typeof p.filter_status === "string" && STATUSES.includes(p.filter_status as AutonomousTaskStatus)) {
          filter.status = p.filter_status as AutonomousTaskStatus;
        }
        if (typeof p.filter_agent_id === "string" && p.filter_agent_id) {
          filter.agent_id = p.filter_agent_id;
        }
        const tasks = store.list(Object.keys(filter).length ? filter : undefined);
        return jsonResult({ ok: true, tasks });
      }

      if (action === "update") {
        if (!p.id || typeof p.id !== "string") {
          return jsonResult({ ok: false, error: "id is required for update" });
        }
        const patch: Record<string, unknown> = {};
        if (typeof p.title === "string" && p.title.trim()) patch.title = p.title.trim();
        if (typeof p.scope === "string") patch.scope = p.scope;
        if (typeof p.workdir === "string" && p.workdir.trim()) patch.workdir = p.workdir.trim();
        if (typeof p.agent_id === "string") patch.agent_id = p.agent_id || null;
        if (typeof p.priority === "string" && PRIORITIES.includes(p.priority as AutonomousTaskPriority)) {
          patch.priority = p.priority;
        }
        if (typeof p.status === "string" && STATUSES.includes(p.status as AutonomousTaskStatus)) {
          patch.status = p.status;
        }
        if (typeof p.project_id === "string") patch.project_id = p.project_id || null;
        const updated = store.update(p.id, patch);
        if (!updated) return jsonResult({ ok: false, error: "Task not found" });
        return jsonResult({ ok: true, task: updated });
      }

      if (action === "assign") {
        if (!p.id || typeof p.id !== "string") {
          return jsonResult({ ok: false, error: "id is required for assign" });
        }
        if (!p.agent_id || typeof p.agent_id !== "string") {
          return jsonResult({ ok: false, error: "agent_id is required for assign" });
        }
        const updated = store.assign(p.id, p.agent_id);
        if (!updated) return jsonResult({ ok: false, error: "Task not found" });
        return jsonResult({ ok: true, task: updated });
      }

      return jsonResult({ ok: false, error: `Unknown action: ${action}` });
    },
  };
}
