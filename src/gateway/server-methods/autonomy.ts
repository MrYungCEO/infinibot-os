/**
 * Gateway Server Methods — Autonomy
 * HTTP/WebSocket handlers for autonomy system
 */

import type { GatewayRequestHandlers } from "./types.js";
import type { AutonomyBackend } from "../../autonomy/types.js";

/**
 * Parse and validate the `backend` param passed to `autonomy:queue.add`.
 * Returns undefined for anything malformed so the orchestrator falls back
 * to the config default. Strict on shape: missing required fields →
 * undefined, not partial.
 */
function parseBackendParam(raw: unknown): AutonomyBackend | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "claude":
      return {
        kind: "claude",
        profileId: typeof r.profileId === "string" ? r.profileId : undefined,
      };
    case "opencode":
      return { kind: "opencode" };
    case "codex":
      return { kind: "codex" };
    case "grok":
      return { kind: "grok" };
    case "gateway-agent":
      if (typeof r.agentId === "string" && r.agentId.trim().length > 0) {
        return { kind: "gateway-agent", agentId: r.agentId.trim() };
      }
      return undefined;
    default:
      return undefined;
  }
}
import {
  listDaemons,
  pauseContinuousRun,
  resumeContinuousRun,
} from "../../workflows/continuous-runner.js";

// Lazy load autonomy modules to avoid circular deps
const getAutonomy = async () => {
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
  const { initAutonomy, autonomy, audit, queue, pause, hardware, notifications, apiMonitor } =
    await import("../../autonomy/index.js");

  // Get Telegram config for notifications
  const { loadConfig } = await import("../../config/config.js");
  const config = loadConfig();
  const chatIdRaw = config.channels?.telegram?.allowFrom?.[0];
  const telegramConfig =
    config.channels?.telegram?.botToken && chatIdRaw
      ? {
          botToken: config.channels.telegram.botToken,
          chatId: String(chatIdRaw),
        }
      : undefined;

  await initAutonomy(stateDir, {}, telegramConfig);
  // initAutonomy short-circuits after first call (the `initialized` guard), so
  // changing the Telegram bot token / chat id later never re-reached the live
  // notifier. Re-apply the latest config on EVERY autonomy RPC so edits made on
  // the autonomy page take effect without a process restart.
  // COORDINATION: orch-self-heal
  if (telegramConfig) {
    autonomy.reapplyNotificationsConfig(telegramConfig);
  }
  return { autonomy, audit, queue, pause, hardware, notifications, apiMonitor };
};

/**
 * Resolve the operator's Telegram config (bot token + chat id) from the
 * persisted gateway config. The chat id is the first entry of
 * channels.telegram.allowFrom — the same place the rest of the gateway reads
 * the operator's DM id from.
 */
const resolveTelegramConfig = async (): Promise<
  { botToken: string; chatId: string } | undefined
> => {
  const { loadConfig } = await import("../../config/config.js");
  const config = loadConfig();
  const chatIdRaw = config.channels?.telegram?.allowFrom?.[0];
  if (config.channels?.telegram?.botToken && chatIdRaw) {
    return { botToken: config.channels.telegram.botToken, chatId: String(chatIdRaw) };
  }
  return undefined;
};

export const autonomyHandlers: GatewayRequestHandlers = {
  // -------------------------------------------------------------------------
  // STATE & STATUS
  // -------------------------------------------------------------------------

  "autonomy:status": async ({ respond }) => {
    try {
      const { autonomy } = await getAutonomy();
      const status = await autonomy.getStatusForUI();
      respond(true, status);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:state": async ({ respond }) => {
    try {
      const { autonomy } = await getAutonomy();
      const state = await autonomy.getState();
      respond(true, state);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:canWork": async ({ respond }) => {
    try {
      const { autonomy } = await getAutonomy();
      const result = await autonomy.canWork();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // -------------------------------------------------------------------------
  // PAUSE CONTROL
  // -------------------------------------------------------------------------

  "autonomy:pause": async ({ params, respond }) => {
    try {
      const { autonomy } = await getAutonomy();
      const reason = typeof params?.reason === "string" ? params.reason : undefined;
      await autonomy.pause(reason);
      // Propagate pause to all active continuous daemons so they idle
      // rather than continuing to spawn iterations while autonomy is paused.
      for (const d of listDaemons()) {
        if (!d.stopped && !d.paused) {
          pauseContinuousRun(d.runId, "autonomy.pause");
        }
      }
      respond(true, { ok: true, paused: true, reason });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:resume": async ({ respond }) => {
    try {
      const { autonomy } = await getAutonomy();
      await autonomy.resume();
      // Resume any daemons that were paused by an autonomy pause (user-paused
      // daemons stay paused — only autonomy-initiated pauses are lifted here).
      for (const d of listDaemons()) {
        if (!d.stopped && d.paused) {
          resumeContinuousRun(d.runId, "autonomy.resume");
        }
      }
      respond(true, { ok: true, paused: false });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:pauseState": async ({ respond }) => {
    try {
      const { pause } = await getAutonomy();
      respond(true, pause.getState());
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // -------------------------------------------------------------------------
  // TASK QUEUE
  // -------------------------------------------------------------------------

  "autonomy:queue.list": async ({ respond }) => {
    try {
      const { queue } = await getAutonomy();
      respond(true, {
        tasks: queue.get(),
        stats: queue.stats(),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // NO-BLOCKAGES default: `prefireRequired` defaults to **false** here so a
  // freshly-queued task can be picked up by the heartbeat without first
  // prompting the operator for a pre-fire form. Telegram/Kanban import paths
  // that genuinely need a questionnaire opt back in by passing
  // `prefireRequired: true` (see autonomy:queue.importKanban below) or by
  // calling `autonomy:queue.setPrefireRequired` afterwards.
  "autonomy:queue.add": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const title = params?.title as string;
      const description = params?.description as string;
      if (!title || !description) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "title and description required",
        });
        return;
      }
      const incomingContext = (
        params?.context && typeof params.context === "object"
          ? (params.context as Record<string, unknown>)
          : {}
      ) as Record<string, unknown>;
      const prefireRequiredParam = params?.prefireRequired;
      const prefireRequired =
        typeof prefireRequiredParam === "boolean"
          ? prefireRequiredParam
          : typeof incomingContext.prefireRequired === "boolean"
            ? (incomingContext.prefireRequired as boolean)
            : false;
      const mergedContext = { ...incomingContext, prefireRequired };
      // COORDINATION: goal-orchestrator-mode — accept kind:"goal" + goal fields
      const kindParam = params?.kind === "goal" ? ("goal" as const) : undefined;
      const subgoalRaw = params?.subgoalText;
      const subgoalText = Array.isArray(subgoalRaw)
        ? subgoalRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        : undefined;
      const maxTurnsRaw = params?.maxTurns;
      const maxTurns =
        typeof maxTurnsRaw === "number" && Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0
          ? Math.floor(maxTurnsRaw)
          : undefined;
      const task = queue.add(title, description, {
        priority: params?.priority as any,
        projectId: params?.projectId as string,
        projectName: params?.projectName as string,
        kanbanTaskId: params?.kanbanTaskId as string,
        kanbanProjectId: params?.kanbanProjectId as string,
        estimatedDuration: params?.estimatedDuration as string,
        hardwareIntensive: params?.hardwareIntensive as boolean,
        requiresApproval: params?.requiresApproval as boolean,
        context: mergedContext as any,
        kind: kindParam,
        goalText: typeof params?.goalText === "string" ? (params.goalText as string) : undefined,
        subgoalText,
        maxTurns,
        // Per-goal backend override. Validated by the orchestrator's
        // resolveOrchestratorBackend; unknown/invalid shapes fall back to
        // the config default, then to claude.
        backend: parseBackendParam(params?.backend),
      });
      respond(true, { ok: true, task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.importKanban": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const kanbanTaskId = params?.kanbanTaskId as string;
      const kanbanProjectId = params?.kanbanProjectId as string;
      const title = params?.title as string;
      const description = params?.description as string;

      if (!title) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "title required" });
        return;
      }

      // Build context from provided messages
      const context: any = {};
      if (params?.telegramMessages && Array.isArray(params.telegramMessages)) {
        context.telegramMessages = params.telegramMessages;
      }
      if (params?.notes) {
        context.notes = params.notes as string;
      }
      if (params?.instructions) {
        context.instructions = params.instructions as string;
      }
      if (params?.files && Array.isArray(params.files)) {
        context.files = params.files;
      }

      const task = queue.add(title, description || title, {
        priority: (params?.priority as any) || "normal",
        kanbanTaskId,
        kanbanProjectId,
        estimatedDuration: params?.estimatedDuration as string,
        hardwareIntensive: (params?.hardwareIntensive as boolean) || false,
        requiresApproval: params?.requiresApproval !== false, // Default to true for imported tasks
        context: Object.keys(context).length > 0 ? context : undefined,
      });
      respond(true, { ok: true, task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.approve": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = params?.taskId as string;
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }
      const task = queue.approve(taskId);
      respond(true, { ok: !!task, task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.cancel": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = params?.taskId as string;
      const error = params?.error as string;
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }
      const task = queue.cancel(taskId, error);
      respond(true, { ok: !!task, task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.start": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = params?.taskId as string;
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }

      const task = queue.getById(taskId);
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }

      // Pre-fire gate — the orchestrator validates and surfaces what's
      // missing, but we also short-circuit here so the UI gets a clear
      // INVALID_PARAMS response without flipping the queue state.
      const { validatePrefire, startOrchestratedTask } =
        await import("../../autonomy/orchestrator.js");
      const check = validatePrefire(task);
      if (!check.ok && task.context?.prefireRequired !== false) {
        respond(false, undefined, {
          code: "PREFIRE_REQUIRED",
          message: `Pre-fire questionnaire incomplete: ${check.missing.join(", ")}`,
        });
        return;
      }

      // Flip the queue state to running + audit + notify. The orchestrator
      // takes over from there in the background. If startOrchestratedTask
      // refuses to start (e.g. prefire blocks, already running), roll the
      // status back so the UI doesn't show a permanently-running task.
      queue.start(taskId);
      void startOrchestratedTask(task)
        .then((res) => {
          if (!res?.started) {
            try {
              queue.fail(taskId, res?.reason ?? "orchestrator declined to start");
            } catch (e) {
              console.error("[autonomy:queue.start] rollback fail-on-decline failed:", e);
            }
          }
        })
        .catch((e) => {
          console.error("[autonomy:queue.start] orchestrator crashed:", e);
          try {
            queue.fail(taskId, `orchestrator crashed: ${String(e?.message ?? e)}`);
          } catch {
            /* best-effort */
          }
        });

      respond(true, { ok: true, task, message: "Closed-loop orchestrator running" });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Set / patch the pre-fire questionnaire on a queued task. The UI calls
  // this once the operator has filled in success criteria + test targets so
  // queue.start is allowed to fire the closed loop.
  "autonomy:queue.setPrefire": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = params?.taskId as string;
      const prefire = params?.prefire as Record<string, unknown> | undefined;
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }
      if (!prefire || typeof prefire !== "object") {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "prefire object required" });
        return;
      }
      const task = queue.getById(taskId);
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }
      if (!task.context) task.context = {};
      const existing = task.context.prefire ?? {};
      task.context.prefire = {
        successCriteria:
          typeof prefire.successCriteria === "string"
            ? prefire.successCriteria
            : ((existing as any).successCriteria ?? ""),
        testTargets: Array.isArray(prefire.testTargets)
          ? (prefire.testTargets as any[]).map((t) => ({
              description: typeof t?.description === "string" ? t.description : "",
              url: typeof t?.url === "string" ? t.url : undefined,
              selector: typeof t?.selector === "string" ? t.selector : undefined,
              expect: typeof t?.expect === "string" ? t.expect : undefined,
            }))
          : ((existing as any).testTargets ?? []),
        maxIterations:
          typeof prefire.maxIterations === "number"
            ? prefire.maxIterations
            : ((existing as any).maxIterations ?? 5),
        testerEnabled:
          typeof prefire.testerEnabled === "boolean"
            ? prefire.testerEnabled
            : ((existing as any).testerEnabled ?? true),
        builderAgentId:
          typeof prefire.builderAgentId === "string"
            ? prefire.builderAgentId
            : (existing as any).builderAgentId,
        testerAgentId:
          typeof prefire.testerAgentId === "string"
            ? prefire.testerAgentId
            : (existing as any).testerAgentId,
        notes: typeof prefire.notes === "string" ? prefire.notes : (existing as any).notes,
        completed: prefire.completed === true,
        completedAt: prefire.completed === true ? Date.now() : (existing as any).completedAt,
      };
      queue.persist();
      respond(true, { ok: true, task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ---- Dynamic, agent-generated pre-fire form ------------------------------
  // The new pre-fire flow: the agent analyzes the task and emits a custom
  // form, the operator answers it (UI or Telegram), then the agent verdicts
  // readiness. The legacy static questionnaire still works for tasks that
  // were queued before this rollout — see validatePrefire in orchestrator.
  "autonomy:queue.generatePrefireForm": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = (params as Record<string, unknown>)?.taskId as string | undefined;
      if (!taskId) {
        return respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
      }
      const task = queue.getById(taskId);
      if (!task) {
        return respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
      }
      const { generatePrefireForm } = await import("../../autonomy/prefire-form-agent.js");
      // Pull project context if the task is linked to a kanban project so the
      // agent's question selection is grounded.
      let project: { id?: string; name?: string; description?: string } | null = null;
      try {
        const kanbanId =
          (task as unknown as { kanbanProjectId?: string }).kanbanProjectId ||
          (task as unknown as { projectId?: string }).projectId;
        if (kanbanId) {
          const { getKanbanStore } = await import("../../tasks/store.js");
          const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
          const store = getKanbanStore(stateDir);
          const projects = await store.getProjects();
          const found = projects.find((p) => p.id === kanbanId);
          if (found) {
            project = { id: found.id, name: found.name, description: found.description };
          }
        }
      } catch {
        /* best-effort */
      }
      const result = await generatePrefireForm({
        taskId,
        title: task.title,
        description: task.description ?? task.context?.notes,
        project,
        notes: task.context?.notes,
      });
      if (!result.ok || !result.form) {
        return respond(false, undefined, {
          code: "GENERATE_FAILED",
          message: result.error ?? "Failed to generate form",
        });
      }
      if (!task.context) task.context = {};
      // Preserve any prior answers if the user is regenerating mid-flight.
      const prior = task.context.prefireForm?.answers ?? {};
      task.context.prefireForm = { ...result.form, answers: { ...prior } };
      queue.persist();
      respond(true, { ok: true, form: task.context.prefireForm });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.answerPrefireForm": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const p = (params ?? {}) as Record<string, unknown>;
      const taskId = p.taskId as string | undefined;
      const answers = p.answers as Record<string, unknown> | undefined;
      const evaluate = p.evaluate !== false;
      if (!taskId) {
        return respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
      }
      const task = queue.getById(taskId);
      if (!task) {
        return respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
      }
      const form = task.context?.prefireForm;
      if (!form) {
        return respond(false, undefined, {
          code: "NO_FORM",
          message: "No prefire form attached. Generate one first.",
        });
      }
      if (answers && typeof answers === "object") {
        const next: Record<string, string | number | boolean | string[]> = { ...form.answers };
        for (const field of form.fields) {
          if (!(field.id in answers)) continue;
          const raw = answers[field.id];
          if (raw === null || raw === undefined) {
            delete next[field.id];
            continue;
          }
          switch (field.type) {
            case "number":
              next[field.id] = typeof raw === "number" ? raw : Number(raw);
              break;
            case "boolean":
              next[field.id] = raw === true || raw === "true" || raw === 1;
              break;
            case "multiselect":
              next[field.id] = Array.isArray(raw)
                ? raw.filter((v): v is string => typeof v === "string")
                : String(raw)
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
              break;
            default:
              next[field.id] = typeof raw === "string" ? raw : String(raw);
          }
        }
        form.answers = next;
      }
      // Re-evaluate readiness (cheap structural check + LLM verdict).
      if (evaluate) {
        const { evaluatePrefireReadiness } = await import("../../autonomy/prefire-form-agent.js");
        const verdict = await evaluatePrefireReadiness(form, {
          taskId,
          title: task.title,
          description: task.description,
        });
        form.agentReady = verdict.ready;
        form.readyReason = verdict.reason;
        if (verdict.ready) form.readyAt = Date.now();
      }
      queue.persist();
      respond(true, { ok: true, form });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.markPrefireReady": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = (params as Record<string, unknown>)?.taskId as string | undefined;
      if (!taskId) {
        return respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
      }
      const task = queue.getById(taskId);
      if (!task || !task.context?.prefireForm) {
        return respond(false, undefined, { code: "NOT_FOUND", message: "Task or form not found" });
      }
      task.context.prefireForm.agentReady = true;
      task.context.prefireForm.readyAt = Date.now();
      task.context.prefireForm.readyReason = "Operator marked ready.";
      queue.persist();
      respond(true, { ok: true, form: task.context.prefireForm });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.setPrefireRequired": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = (params as Record<string, unknown>)?.taskId as string | undefined;
      const required = (params as Record<string, unknown>)?.required;
      if (!taskId) {
        return respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
      }
      if (typeof required !== "boolean") {
        return respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "required (boolean) is required",
        });
      }
      const task = queue.getById(taskId);
      if (!task) {
        return respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
      }
      if (!task.context) task.context = {};
      task.context.prefireRequired = required;
      queue.persist();
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Validate without mutating — used by the UI to render the missing-fields
  // list in the pre-fire form.
  "autonomy:queue.prefireStatus": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const { validatePrefire } = await import("../../autonomy/orchestrator.js");
      const taskId = params?.taskId as string;
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }
      const task = queue.getById(taskId);
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }
      const check = validatePrefire(task);
      respond(true, {
        ok: check.ok,
        missing: check.missing,
        prefire: task.context?.prefire ?? null,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Full activity log for a single task: merges the orchestrator iterations
  // with every audit entry whose target points at this task, then sorts by
  // timestamp. Used by the detail panel's activity feed so the operator can
  // see exactly what each agent did and when.
  "autonomy:queue.activity": async ({ params, respond }) => {
    try {
      const { queue, audit } = await getAutonomy();
      const taskId = params?.taskId as string;
      const limit = typeof params?.limit === "number" ? params.limit : 200;
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }
      const task = queue.getById(taskId);
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }

      // Pull a wide audit window — we filter to this task's target on the
      // way out. 500 is plenty for a single task's life cycle and stays
      // cheap to slice.
      const auditEntries = (audit.recent(500) || []).filter(
        (e: any) => e?.target === taskId || e?.details?.taskId === taskId,
      );

      type ActivityKind =
        | "queued"
        | "approved"
        | "cancelled"
        | "started"
        | "completed"
        | "failed"
        | "iteration_start"
        | "iteration_build_start"
        | "iteration_build_done"
        | "iteration_test_start"
        | "iteration_test_done"
        | "iteration_assess"
        | "iteration_max_reached"
        | "prefire_blocked"
        | "prefire_completed"
        | "audit"
        | "notification";

      interface ActivityEntry {
        id: string;
        timestamp: number;
        kind: ActivityKind;
        phase?: string;
        title: string;
        detail?: string;
        agentId?: string;
        sessionKey?: string;
        runId?: string;
        iteration?: number;
        outcome?: "success" | "failure" | "pending" | "blocked";
        meta?: Record<string, unknown>;
      }

      const out: ActivityEntry[] = [];

      // Lifecycle anchors from the queue record itself — these are always
      // available even if the audit file got rotated / pruned.
      out.push({
        id: `${task.id}:queued`,
        timestamp: task.createdAt,
        kind: "queued",
        title: "Task queued",
        detail: task.description,
        outcome: "success",
      });
      if (task.executedAt) {
        out.push({
          id: `${task.id}:started`,
          timestamp: task.executedAt,
          kind: "started",
          title: "Task started",
          outcome: "success",
        });
      }
      if (task.completedAt && task.status === "completed") {
        out.push({
          id: `${task.id}:completed`,
          timestamp: task.completedAt,
          kind: "completed",
          title: "Task completed",
          detail: task.outcome,
          outcome: "success",
        });
      }
      if (task.completedAt && task.status === "failed") {
        out.push({
          id: `${task.id}:failed`,
          timestamp: task.completedAt,
          kind: "failed",
          title: "Task failed",
          detail: task.error,
          outcome: "failure",
        });
      }
      if (task.completedAt && task.status === "cancelled") {
        out.push({
          id: `${task.id}:cancelled`,
          timestamp: task.completedAt,
          kind: "cancelled",
          title: "Task cancelled",
          detail: task.error,
          outcome: "blocked",
        });
      }

      // Iterations — one entry per phase transition the orchestrator has
      // observed, so the operator can see build → test → assess unfold.
      for (const it of task.iterations ?? []) {
        out.push({
          id: `${task.id}:iter:${it.number}:start`,
          timestamp: it.startedAt,
          kind: "iteration_start",
          phase: "building",
          title: `Iteration ${it.number} started`,
          agentId: it.buildAgentId,
          sessionKey: it.buildSessionKey,
          runId: it.buildRunId,
          iteration: it.number,
        });
        if (it.buildOutcome) {
          out.push({
            id: `${task.id}:iter:${it.number}:build`,
            timestamp: it.endedAt ?? it.startedAt,
            kind: "iteration_build_done",
            phase: "building",
            title: `Build ${it.buildOutcome.toUpperCase()}`,
            detail: it.buildSummary,
            agentId: it.buildAgentId,
            sessionKey: it.buildSessionKey,
            runId: it.buildRunId,
            iteration: it.number,
            outcome: it.buildOutcome === "ok" ? "success" : "failure",
          });
        }
        if (it.testerVerdict) {
          out.push({
            id: `${task.id}:iter:${it.number}:test`,
            timestamp: it.endedAt ?? it.startedAt,
            kind: "iteration_test_done",
            phase: "testing",
            title: `Tester ${it.testerVerdict.pass ? "PASS" : "FAIL"}`,
            detail: it.testerVerdict.summary,
            sessionKey: it.testerSessionKey,
            runId: it.testerRunId,
            iteration: it.number,
            outcome: it.testerVerdict.pass ? "success" : "failure",
            meta: {
              reasons: it.testerVerdict.reasons,
              evidence: it.testerVerdict.evidence,
              fixHints: it.testerVerdict.fixHints,
            },
          });
        }
        if (it.endedAt) {
          out.push({
            id: `${task.id}:iter:${it.number}:assess`,
            timestamp: it.endedAt,
            kind: "iteration_assess",
            phase: "assessing",
            title: `Iteration ${it.number} assessed`,
            iteration: it.number,
            detail: it.notes,
            outcome:
              it.testerVerdict?.pass === true
                ? "success"
                : it.testerVerdict?.pass === false
                  ? "failure"
                  : it.buildOutcome === "ok"
                    ? "success"
                    : "failure",
          });
        }
      }

      // Generic audit entries for this task — keeps fine-grained signal
      // (file_write, exec_command, api_call, ...) the orchestrator doesn't
      // model directly.
      const seenKinds = new Set([
        "task_queued",
        "task_started",
        "task_completed",
        "task_failed",
        "iteration_started",
        "iteration_build_done",
        "iteration_test_done",
        "iteration_assess",
        "iteration_max_reached",
      ]);
      for (const e of auditEntries) {
        if (seenKinds.has(e.actionType)) continue;
        out.push({
          id: e.id,
          timestamp: e.timestamp,
          kind: (e.actionType === "prefire_blocked"
            ? "prefire_blocked"
            : e.actionType === "prefire_completed"
              ? "prefire_completed"
              : e.actionType === "notification_sent"
                ? "notification"
                : "audit") as ActivityKind,
          title: e.actionType.replace(/_/g, " "),
          detail: e.description,
          outcome: e.outcome,
          agentId: e.agentId,
          sessionKey: e.sessionKey,
          meta: e.details as Record<string, unknown> | undefined,
        });
      }

      out.sort((a, b) => a.timestamp - b.timestamp);

      // Compute the last-activity timestamp so the UI can render a
      // "Updated 12s ago" pill without re-walking the list.
      const lastActivity = out.length > 0 ? out[out.length - 1].timestamp : task.createdAt;

      respond(true, {
        ok: true,
        taskId,
        title: task.title,
        status: task.status,
        currentPhase: task.currentPhase ?? null,
        iterationsTotal: task.iterations?.length ?? 0,
        lastActivity,
        entries: out.slice(-limit),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Read back iteration history for a task — feeds the autonomy view's
  // task-detail panel so iterations are visible while the loop runs.
  "autonomy:queue.iterations": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = params?.taskId as string;
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }
      const task = queue.getById(taskId);
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }
      respond(true, {
        ok: true,
        currentPhase: task.currentPhase ?? null,
        iterations: task.iterations ?? [],
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.complete": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = params?.taskId as string;
      const outcome = params?.outcome as string;
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }
      const task = queue.complete(taskId, outcome);
      respond(true, { ok: !!task, task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.fail": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const taskId = params?.taskId as string;
      const error = (params?.error as string) || "Unknown error";
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }
      const task = queue.fail(taskId, error);
      respond(true, { ok: !!task, task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:queue.next": async ({ respond }) => {
    try {
      const { queue, hardware } = await getAutonomy();
      const hwCheck = await hardware.canRunIntensive();
      const task = queue.next(hwCheck.allowed);
      respond(true, { task, hardwareIntensiveAllowed: hwCheck.allowed });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // -------------------------------------------------------------------------
  // AUDIT LOG
  // -------------------------------------------------------------------------

  "autonomy:audit.recent": async ({ params, respond }) => {
    try {
      const { audit } = await getAutonomy();
      const limit = typeof params?.limit === "number" ? params.limit : 50;
      respond(true, {
        entries: audit.recent(limit),
        stats: audit.stats(),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:audit.today": async ({ respond }) => {
    try {
      const { audit } = await getAutonomy();
      respond(true, {
        entries: audit.read(),
        stats: audit.stats(),
        chainValid: audit.verify().valid,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:audit.verify": async ({ params, respond }) => {
    try {
      const { audit } = await getAutonomy();
      const date = typeof params?.date === "string" ? params.date : undefined;
      respond(true, audit.verify(date));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // -------------------------------------------------------------------------
  // HARDWARE & ACTIVITY
  // -------------------------------------------------------------------------

  "autonomy:hardware.check": async ({ respond }) => {
    try {
      const { hardware } = await getAutonomy();
      const state = await hardware.check();
      const canRunIntensive = await hardware.canRunIntensive();
      respond(true, {
        state,
        canRunIntensive: canRunIntensive.allowed,
        reason: canRunIntensive.reason,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:hardware.isIdle": async ({ respond }) => {
    try {
      const { hardware } = await getAutonomy();
      const isIdle = await hardware.isUserIdle();
      const idleTime = await hardware.getIdleTime();
      respond(true, { isIdle, idleTime });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // -------------------------------------------------------------------------
  // NOTIFICATIONS
  // -------------------------------------------------------------------------

  "autonomy:notify.send": async ({ params, respond }) => {
    try {
      const { notifications } = await getAutonomy();
      const level = params?.level as any;
      const title = params?.title as string;
      const message = params?.message as string;
      const taskId = params?.taskId as string;

      if (!level || !title || !message) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "level, title, and message required",
        });
        return;
      }

      const notification = await notifications.send(level, title, message, { taskId });
      respond(true, { ok: notification.sent, notification });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:notify.pending": async ({ respond }) => {
    try {
      const { notifications } = await getAutonomy();
      respond(true, { pending: notifications.pending() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:notify.retry": async ({ respond }) => {
    try {
      const { notifications } = await getAutonomy();
      const count = await notifications.retry();
      respond(true, { ok: true, retriedCount: count });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // -------------------------------------------------------------------------
  // TELEGRAM CONNECTIVITY (fix + verify the operator's connection)
  // -------------------------------------------------------------------------

  // Report whether Telegram is wired up (configured + chat id present). Used by
  // the autonomy page's Telegram status panel. Never returns the bot token.
  "autonomy:telegram.status": async ({ respond }) => {
    try {
      const { notifications } = await getAutonomy();
      respond(true, notifications.getConfig());
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Send a real Telegram test message and surface the actual API result
  // (e.g. "chat not found", "Unauthorized") to the UI.
  "autonomy:telegram.test": async ({ respond }) => {
    try {
      const { notifications } = await getAutonomy();
      const result = await notifications.test();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Reload Telegram config from disk, re-apply it to the LIVE notifier, then
  // send a test message. This is the "Reconnect Telegram" affordance — it makes
  // a token/chat-id change take effect AND verifies it in one round-trip.
  "autonomy:telegram.reconnect": async ({ respond }) => {
    try {
      const { autonomy, notifications } = await getAutonomy();
      const telegramConfig = await resolveTelegramConfig();
      if (!telegramConfig) {
        respond(true, {
          ok: false,
          error:
            "Telegram is not configured. Set channels.telegram.botToken and channels.telegram.allowFrom[0] (your chat id) first.",
        });
        return;
      }
      autonomy.reapplyNotificationsConfig(telegramConfig);
      const result = await notifications.test();
      respond(true, { ...result, reapplied: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // -------------------------------------------------------------------------
  // API USAGE MONITORING
  // -------------------------------------------------------------------------

  "autonomy:api.record": async ({ params, respond }) => {
    try {
      const { apiMonitor } = await getAutonomy();
      const provider = params?.provider as string;
      const model = params?.model as string;
      const tokensIn = params?.tokensIn as number;
      const tokensOut = params?.tokensOut as number;
      const costUsd = params?.costUsd as number;

      if (!provider || !model || tokensIn == null || tokensOut == null || costUsd == null) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "provider, model, tokensIn, tokensOut, costUsd required",
        });
        return;
      }

      const entry = apiMonitor.record(provider, model, tokensIn, tokensOut, costUsd, {
        sessionKey: params?.sessionKey as string,
        taskId: params?.taskId as string,
        autonomous: params?.autonomous as boolean,
      });
      respond(true, { ok: true, entry });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:api.today": async ({ respond }) => {
    try {
      const { apiMonitor } = await getAutonomy();
      respond(true, apiMonitor.today());
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:api.summary": async ({ params, respond }) => {
    try {
      const { apiMonitor } = await getAutonomy();
      const period = (params?.period as any) || "day";
      respond(true, apiMonitor.summary(period));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:api.recent": async ({ params, respond }) => {
    try {
      const { apiMonitor } = await getAutonomy();
      const limit = typeof params?.limit === "number" ? params.limit : 50;
      respond(true, { entries: apiMonitor.recent(limit) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:api.taskUsage": async ({ params, respond }) => {
    try {
      const { apiMonitor } = await getAutonomy();
      const taskId = params?.taskId as string;
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }
      respond(true, apiMonitor.taskUsage(taskId));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // -------------------------------------------------------------------------
  // CAGE INTERFERENCE REPORTING
  // -------------------------------------------------------------------------

  "autonomy:cage.report": async ({ params, respond }) => {
    try {
      const { autonomy } = await getAutonomy();
      const description = params?.description as string;
      const details = params?.details as Record<string, unknown>;

      if (!description) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "description required" });
        return;
      }

      await autonomy.reportCage(description, details);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // -------------------------------------------------------------------------
  // KANBAN SYNC
  // -------------------------------------------------------------------------

  "autonomy:kanban.sync": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const { syncToKanban } = await import("../../autonomy/kanban-sync.js");
      const taskId = params?.taskId as string;

      if (taskId) {
        // Sync specific task
        const task = queue.getById(taskId);
        if (!task) {
          respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
          return;
        }
        const synced = await syncToKanban(task);
        respond(true, { ok: synced, task });
      } else {
        // Sync all tasks with kanbanTaskId
        const tasks = queue.get().filter((t) => t.kanbanTaskId);
        let syncedCount = 0;
        for (const task of tasks) {
          if (await syncToKanban(task)) {
            syncedCount++;
          }
        }
        respond(true, { ok: true, synced: syncedCount, total: tasks.length });
      }
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "autonomy:kanban.link": async ({ params, respond }) => {
    try {
      const { queue } = await getAutonomy();
      const { kanbanSync } = await import("../../autonomy/kanban-sync.js");
      const taskId = params?.taskId as string;
      const kanbanTaskId = params?.kanbanTaskId as string;

      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId required" });
        return;
      }

      const task = queue.getById(taskId);
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }

      if (kanbanTaskId) {
        // Link to existing kanban task
        task.kanbanTaskId = kanbanTaskId;
      } else {
        // Create new kanban task
        const newId = await kanbanSync.create(task);
        if (newId) {
          task.kanbanTaskId = newId;
        }
      }

      respond(true, { ok: !!task.kanbanTaskId, task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
