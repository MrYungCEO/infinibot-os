import { randomUUID } from "node:crypto";
import { LaunchPanelStore } from "../../launch-panel/store.js";
import { createLaunchPanelRun } from "../../launch-panel/runner.js";
import { DEFAULT_LAUNCH_FLOWS } from "../../launch-panel/workflow.js";
import { ensureLaunchPanelWorkflow } from "../../launch-panel/register-workflow.js";
import type {
  LaunchPanelRunInput,
  LaunchPanelSchedule,
  LaunchPersona,
} from "../../launch-panel/types.js";
import { getGroupChatService } from "./group-chat.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

export const LAUNCH_PANEL_READ_METHODS = [
  "launch_panel.personas.list",
  "launch_panel.runs.list",
  "launch_panel.run.get",
  "launch_panel.schedules.list",
] as const;

export const LAUNCH_PANEL_WRITE_METHODS = [
  "launch_panel.run",
  "launch_panel.run.cancel",
  "launch_panel.personas.update",
  "launch_panel.personas.reset",
  "launch_panel.schedules.upsert",
  "launch_panel.schedules.delete",
] as const;

const store = new LaunchPanelStore();
let latestContext: GatewayRequestContext | null = null;

function fail(
  respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void,
  err: unknown,
) {
  respond(false, undefined, {
    code: "LAUNCH_PANEL_ERROR",
    message: err instanceof Error ? err.message : String(err),
  });
}

function nextRunAt(schedule: LaunchPanelSchedule): number | null {
  const base = Date.parse(schedule.runAt);
  if (!Number.isFinite(base)) return null;
  if (!schedule.lastRunAt) return base;
  const step =
    schedule.repeat === "daily" ? 86_400_000 : schedule.repeat === "weekly" ? 604_800_000 : 0;
  if (!step) return null;
  let next = base;
  while (next <= schedule.lastRunAt) next += step;
  return next;
}

async function tickSchedules() {
  if (!latestContext) return;
  const now = Date.now();
  for (const schedule of store.read().schedules) {
    const due = schedule.enabled ? nextRunAt(schedule) : null;
    if (due === null || due > now || (schedule.lastRunAt && now - schedule.lastRunAt < 30_000))
      continue;
    try {
      const run = createLaunchPanelRun(schedule.input, latestContext, store);
      schedule.lastRunAt = now;
      schedule.lastRunId = run.id;
      if (schedule.repeat === "none") schedule.enabled = false;
      store.saveSchedule(schedule);
      latestContext.broadcast("launch-panel", { type: "schedule.started", schedule, run });
    } catch (err) {
      latestContext.logGateway.warn(`launch panel schedule ${schedule.id} failed: ${String(err)}`);
    }
  }
}

const scheduleTimer = setInterval(() => void tickSchedules(), 30_000);
scheduleTimer.unref?.();

export const launchPanelHandlers: GatewayRequestHandlers = {
  "launch_panel.personas.list": ({ respond, context }) => {
    latestContext = context;
    ensureLaunchPanelWorkflow();
    respond(true, { personas: store.listPersonas(), flows: DEFAULT_LAUNCH_FLOWS });
  },
  "launch_panel.personas.update": ({ params, respond, context }) => {
    latestContext = context;
    try {
      const persona = store.savePersona(params?.persona as LaunchPersona);
      context.broadcast("launch-panel", { type: "personas.updated", persona });
      respond(true, { persona });
    } catch (err) {
      fail(respond, err);
    }
  },
  "launch_panel.personas.reset": ({ respond, context }) => {
    latestContext = context;
    try {
      const personas = store.resetPersonas();
      context.broadcast("launch-panel", { type: "personas.updated", personas });
      respond(true, { personas });
    } catch (err) {
      fail(respond, err);
    }
  },
  "launch_panel.runs.list": ({ params, respond, context }) => {
    latestContext = context;
    const limit = Math.max(1, Math.min(100, Number(params?.limit) || 30));
    respond(true, { runs: store.listRuns().slice(0, limit) });
  },
  "launch_panel.run.get": ({ params, respond, context }) => {
    latestContext = context;
    const run = store.getRun(String(params?.id || ""));
    if (!run)
      return respond(false, undefined, {
        code: "NOT_FOUND",
        message: "Launch Panel run not found",
      });
    respond(true, { run });
  },
  "launch_panel.run": ({ params, respond, context }) => {
    latestContext = context;
    try {
      const run = createLaunchPanelRun(
        (params || {}) as unknown as LaunchPanelRunInput,
        context,
        store,
      );
      respond(true, { run });
    } catch (err) {
      fail(respond, err);
    }
  },
  "launch_panel.run.cancel": ({ params, respond, context }) => {
    latestContext = context;
    try {
      const run = store.getRun(String(params?.id || ""));
      if (!run)
        return respond(false, undefined, {
          code: "NOT_FOUND",
          message: "Launch Panel run not found",
        });
      if (run.groupKey) getGroupChatService(context).abort(run.groupKey);
      run.status = "cancelled";
      run.completedAt = Date.now();
      store.saveRun(run);
      context.broadcast("launch-panel", { type: "run.updated", run });
      respond(true, { run });
    } catch (err) {
      fail(respond, err);
    }
  },
  "launch_panel.schedules.list": ({ respond, context }) => {
    latestContext = context;
    respond(true, {
      schedules: store
        .read()
        .schedules.map((schedule) => ({ ...schedule, nextRunAt: nextRunAt(schedule) })),
    });
  },
  "launch_panel.schedules.upsert": ({ params, respond, context }) => {
    latestContext = context;
    try {
      const raw = (params?.schedule || params || {}) as Partial<LaunchPanelSchedule>;
      const runAt = new Date(String(raw.runAt || ""));
      if (!Number.isFinite(runAt.getTime())) throw new Error("schedule.runAt must be a valid date");
      if (!raw.input?.url) throw new Error("schedule.input.url is required");
      const schedule: LaunchPanelSchedule = {
        id: raw.id || `lps-${randomUUID().slice(0, 10)}`,
        name: String(raw.name || `Pre-launch check · ${new URL(raw.input.url).hostname}`).slice(
          0,
          120,
        ),
        enabled: raw.enabled !== false,
        runAt: runAt.toISOString(),
        repeat: ["daily", "weekly"].includes(String(raw.repeat))
          ? (raw.repeat as "daily" | "weekly")
          : "none",
        input: raw.input,
        createdAt: raw.createdAt || Date.now(),
        lastRunAt: raw.lastRunAt,
        lastRunId: raw.lastRunId,
      };
      store.saveSchedule(schedule);
      context.broadcast("launch-panel", { type: "schedules.updated", schedule });
      respond(true, { schedule, nextRunAt: nextRunAt(schedule) });
    } catch (err) {
      fail(respond, err);
    }
  },
  "launch_panel.schedules.delete": ({ params, respond, context }) => {
    latestContext = context;
    const deleted = store.deleteSchedule(String(params?.id || ""));
    context.broadcast("launch-panel", { type: "schedules.updated" });
    respond(true, { deleted });
  },
};
