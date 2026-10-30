import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../../config/paths.js";
import {
  appendWorkEvent,
  computeWeeklyStats,
  computeWorkloadSummary,
  purgeWorkDay,
  readWorkEventRange,
  readWorkEvents,
} from "../../workload/store.js";
import type { WorkEvent, WorkEventKind, WorkEventSource } from "../../workload/types.js";
import type { GatewayRequestHandlers } from "./types.js";

const VALID_KINDS = new Set<WorkEventKind>([
  "subagent_started",
  "subagent_completed",
  "subagent_failed",
  "kanban_task_completed",
  "workflow_run_completed",
  "gateway_tool_invocation",
  "voice_session_ended",
  "edit_session",
  "manual",
]);

const VALID_SOURCES = new Set<WorkEventSource>([
  "subagent_registry",
  "kanban",
  "workflow",
  "voice",
  "editor",
  "manual",
  "gateway",
]);

/** In-memory map of active timer blocks keyed by id. */
const activeBlocks = new Map<
  string,
  { label: string; startTs: number; projectId?: string; taskId?: string }
>();

export const workloadHandlers: GatewayRequestHandlers = {
  "workload.log": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as any;
      if (!p.label || typeof p.label !== "string") {
        respond(false, undefined, { code: "BAD_REQUEST", message: "label required" });
        return;
      }
      const kind: WorkEventKind = VALID_KINDS.has(p.kind) ? p.kind : "manual";
      const source: WorkEventSource = VALID_SOURCES.has(p.source) ? p.source : "manual";
      const event: WorkEvent = {
        ts: typeof p.ts === "number" ? p.ts : Date.now(),
        kind,
        source,
        durationMs: typeof p.durationMs === "number" ? Math.max(0, p.durationMs) : undefined,
        label: String(p.label).slice(0, 200),
        projectId: p.projectId || undefined,
        taskId: p.taskId || undefined,
        runId: p.runId || undefined,
        metadata: p.metadata && typeof p.metadata === "object" ? p.metadata : undefined,
      };
      appendWorkEvent(resolveStateDir(), event);
      respond(true, { ok: true, ts: event.ts });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workload.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as any;
      const today = new Date().toISOString().slice(0, 10);
      const startDate =
        typeof p.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.startDate)
          ? p.startDate
          : today;
      const endDate =
        typeof p.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.endDate) ? p.endDate : today;
      let events = readWorkEventRange(resolveStateDir(), startDate, endDate);
      if (p.source && VALID_SOURCES.has(p.source)) {
        events = events.filter((e) => e.source === p.source);
      }
      if (p.kind && VALID_KINDS.has(p.kind)) {
        events = events.filter((e) => e.kind === p.kind);
      }
      if (p.projectId && typeof p.projectId === "string") {
        events = events.filter((e) => e.projectId === p.projectId);
      }
      const limit = typeof p.limit === "number" ? Math.min(Math.max(1, p.limit), 500) : 200;
      respond(true, { events: events.slice(-limit), total: events.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workload.summary": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as any;
      const today = new Date().toISOString().slice(0, 10);
      const date =
        typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : today;
      const events = readWorkEvents(resolveStateDir(), date);
      const summary = computeWorkloadSummary(events, date);
      const weekly = computeWeeklyStats(resolveStateDir(), date);
      respond(true, { summary, weekly });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workload.start_block": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as any;
      if (!p.label || typeof p.label !== "string") {
        respond(false, undefined, { code: "BAD_REQUEST", message: "label required" });
        return;
      }
      const id = p.id || `wb_${randomUUID().slice(0, 8)}`;
      activeBlocks.set(id, {
        label: String(p.label).slice(0, 200),
        startTs: typeof p.startTs === "number" ? p.startTs : Date.now(),
        projectId: p.projectId || undefined,
        taskId: p.taskId || undefined,
      });
      respond(true, { id, startTs: activeBlocks.get(id)!.startTs });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workload.end_block": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as any;
      if (!p.id || typeof p.id !== "string") {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const block = activeBlocks.get(p.id);
      if (!block) {
        respond(false, undefined, { code: "NOT_FOUND", message: "active block not found" });
        return;
      }
      activeBlocks.delete(p.id);
      const endTs = typeof p.endTs === "number" ? p.endTs : Date.now();
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
      respond(true, { ok: true, durationMs: event.durationMs });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workload.purge": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as any;
      const today = new Date().toISOString().slice(0, 10);
      const date =
        typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : today;
      const deleted = purgeWorkDay(resolveStateDir(), date);
      respond(true, { deleted, date });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
