import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  appendWorkEvent,
  computeWeeklyStats,
  computeWorkloadSummary,
  purgeWorkDay,
  readWorkEventRange,
  readWorkEvents,
} from "../../workload/store.js";
import type { WorkEvent, WorkEventKind, WorkEventSource } from "../../workload/types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { stringEnum } from "../schema/typebox.js";

const log = createSubsystemLogger("workload-tool");

const WORK_KINDS = [
  "subagent_started",
  "subagent_completed",
  "subagent_failed",
  "kanban_task_completed",
  "workflow_run_completed",
  "gateway_tool_invocation",
  "voice_session_ended",
  "edit_session",
  "manual",
] as const;

const WORK_SOURCES = [
  "subagent_registry",
  "kanban",
  "workflow",
  "voice",
  "editor",
  "manual",
  "gateway",
] as const;

const ACTIONS = ["log", "list", "summary", "start_block", "end_block", "purge"] as const;

const WorkloadToolSchema = Type.Object({
  action: stringEnum(ACTIONS),
  /** Manual label for the event or block. */
  label: Type.Optional(Type.String()),
  /** ISO date YYYY-MM-DD. Defaults to today. */
  date: Type.Optional(Type.String()),
  /** Range start date for list queries. */
  startDate: Type.Optional(Type.String()),
  /** Range end date for list queries. */
  endDate: Type.Optional(Type.String()),
  /** Filter by kind. */
  kind: Type.Optional(stringEnum(WORK_KINDS)),
  /** Filter by source. */
  source: Type.Optional(stringEnum(WORK_SOURCES)),
  /** Filter by project id. */
  projectId: Type.Optional(Type.String()),
  /** Kanban task id to associate. */
  taskId: Type.Optional(Type.String()),
  /** Agent run id (for manual checkpoints). */
  runId: Type.Optional(Type.String()),
  /** Duration in milliseconds for manual log entries. */
  durationMs: Type.Optional(Type.Number()),
  /** Block id — required for end_block, optional for start_block. */
  blockId: Type.Optional(Type.String()),
  /** Max events to return (list action). Default 200. */
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  /** Extra metadata (arbitrary JSON object). */
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/** In-memory active block timers keyed by blockId. */
const activeBlocks = new Map<
  string,
  { label: string; startTs: number; projectId?: string; taskId?: string }
>();

export function createWorkloadTool(): AnyAgentTool {
  return {
    label: "Workload",
    name: "workload",
    description: `Track and query the automatic workload activity log for today's work session.

**Actions:**
- **log**: Manually append a work event (label + optional durationMs, projectId, kind, metadata).
- **list**: Query work events by date range, source, kind, or projectId. Returns raw events.
- **summary**: Daily summary with total time, breakdown by category/source/project, and 7-day sparkline.
- **start_block**: Start a named timer block (returns blockId). Call end_block when done.
- **end_block**: Stop a timer block (by blockId), compute durationMs, auto-emit a work event.
- **purge**: Delete all work events for a given date (default today). Use for privacy.

Events for sub-agent runs, kanban completions, and workflow runs are captured automatically.
Use \`log\` only when you want to mark a manual checkpoint that isn't naturally captured.`,

    parameters: WorkloadToolSchema,

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const today = new Date().toISOString().slice(0, 10);

      try {
        switch (action) {
          case "log": {
            const label = readStringParam(params, "label", { required: true });
            const kind = (
              WORK_KINDS.includes(params.kind as any) ? params.kind : "manual"
            ) as WorkEventKind;
            const source = (
              WORK_SOURCES.includes(params.source as any) ? params.source : "manual"
            ) as WorkEventSource;
            const event: WorkEvent = {
              ts: Date.now(),
              kind,
              source,
              label: label.slice(0, 200),
              durationMs:
                typeof params.durationMs === "number" ? Math.max(0, params.durationMs) : undefined,
              projectId: typeof params.projectId === "string" ? params.projectId : undefined,
              taskId: typeof params.taskId === "string" ? params.taskId : undefined,
              runId: typeof params.runId === "string" ? params.runId : undefined,
              metadata:
                params.metadata && typeof params.metadata === "object"
                  ? (params.metadata as Record<string, unknown>)
                  : undefined,
            };
            appendWorkEvent(resolveStateDir(), event);
            return jsonResult({ ok: true, ts: event.ts, label: event.label });
          }

          case "list": {
            const startDate =
              typeof params.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.startDate)
                ? params.startDate
                : today;
            const endDate =
              typeof params.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.endDate)
                ? params.endDate
                : today;
            let events = readWorkEventRange(resolveStateDir(), startDate, endDate);
            if (typeof params.source === "string" && WORK_SOURCES.includes(params.source as any)) {
              events = events.filter((e) => e.source === params.source);
            }
            if (typeof params.kind === "string" && WORK_KINDS.includes(params.kind as any)) {
              events = events.filter((e) => e.kind === params.kind);
            }
            if (typeof params.projectId === "string") {
              events = events.filter((e) => e.projectId === params.projectId);
            }
            const limit =
              typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 500) : 200;
            return jsonResult({ events: events.slice(-limit), total: events.length });
          }

          case "summary": {
            const date =
              typeof params.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
                ? params.date
                : today;
            const events = readWorkEvents(resolveStateDir(), date);
            const summary = computeWorkloadSummary(events, date);
            const weekly = computeWeeklyStats(resolveStateDir(), date);
            return jsonResult({ summary, weekly });
          }

          case "start_block": {
            const label = readStringParam(params, "label", { required: true });
            const blockId =
              typeof params.blockId === "string" && params.blockId.trim()
                ? params.blockId.trim()
                : `wb_${randomUUID().slice(0, 8)}`;
            const startTs = Date.now();
            activeBlocks.set(blockId, {
              label: label.slice(0, 200),
              startTs,
              projectId: typeof params.projectId === "string" ? params.projectId : undefined,
              taskId: typeof params.taskId === "string" ? params.taskId : undefined,
            });
            return jsonResult({ blockId, startTs, label });
          }

          case "end_block": {
            const blockId = readStringParam(params, "blockId", { required: true });
            const block = activeBlocks.get(blockId);
            if (!block) {
              return jsonResult({ error: `No active block with id: ${blockId}` });
            }
            activeBlocks.delete(blockId);
            const endTs = Date.now();
            const durationMs = endTs - block.startTs;
            const event: WorkEvent = {
              ts: endTs,
              kind: "manual",
              source: "manual",
              durationMs: Math.max(0, durationMs),
              label: block.label,
              projectId: block.projectId,
              taskId: block.taskId,
            };
            appendWorkEvent(resolveStateDir(), event);
            return jsonResult({
              ok: true,
              blockId,
              durationMs: event.durationMs,
              label: block.label,
            });
          }

          case "purge": {
            const date =
              typeof params.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
                ? params.date
                : today;
            const deleted = purgeWorkDay(resolveStateDir(), date);
            return jsonResult({ deleted, date });
          }

          default:
            return jsonResult({ error: `Unknown action: ${action}` });
        }
      } catch (err) {
        log.warn("workload tool error", {
          action,
          err: err instanceof Error ? err.message : String(err),
        });
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
