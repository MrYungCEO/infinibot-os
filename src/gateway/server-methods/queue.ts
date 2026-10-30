/**
 * Persistent phase queue — gateway RPC handlers.
 *
 *   queue.enqueue   — entry with phases (any agent per phase) + deps/isolation
 *   queue.list      — entries (+ current attempt), dispatch state
 *   queue.get       — entry + every attempt (backend/model/session/verdict/gate) + events
 *   queue.logs      — agent output of an attempt (durable log / session)
 *   queue.metrics   — durations + success rate per agent/backend
 *   queue.backends  — CLI availability (installed / logged in / fix)
 *   queue.pause / queue.resume / queue.cancel / queue.retry / queue.advance / queue.reorder
 *   queue.setPaused — global dispatch pause
 *
 * Params are validated against protocol/schema/queue.ts (TypeBox + ajv).
 * Controls go through the orchestrator so a running attempt's process tree is
 * actually stopped. Scopes: QUEUE_READ_METHODS / QUEUE_WRITE_METHODS.
 */

import AjvPkg, { type ErrorObject } from "ajv";
import type { TSchema } from "@sinclair/typebox";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import {
  QueueAdvanceParamsSchema,
  QueueBackendsParamsSchema,
  QueueCancelParamsSchema,
  QueueEnqueueParamsSchema,
  QueueGetParamsSchema,
  QueueIdParamsSchema,
  QueueListParamsSchema,
  QueueLogsParamsSchema,
  QueueMetricsParamsSchema,
  QueuePauseParamsSchema,
  QueueReorderParamsSchema,
  QueueRetryParamsSchema,
  QueueSetPausedParamsSchema,
  type QueueAdvanceParams,
  type QueueBackendsParams,
  type QueueCancelParams,
  type QueueEnqueueParams,
  type QueueGetParams,
  type QueueIdParams,
  type QueueListParams,
  type QueueLogsParams,
  type QueueMetricsParams,
  type QueuePauseParams,
  type QueueReorderParams,
  type QueueRetryParams,
  type QueueSetPausedParams,
} from "../protocol/schema/queue.js";
import { getQueueStore } from "../../queue/store.js";
import { broadcastQueueEvent } from "../../queue/events.js";
import { peekQueueOrchestrator, QueueOrchestrator } from "../../queue/orchestrator.js";
import { resolveAgent } from "../../queue/backends.js";
import type { QueueEntry, QueuePhase, QueueStatus } from "../../queue/types.js";
import { normalizeChecks } from "../../autonomy/goals/checks.js";
import type { PhaseRunner } from "../../queue/phase-runner.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
});

function validator<T>(schema: TSchema) {
  const fn = ajv.compile<T>(schema);
  return (params: unknown, respond: RespondFn): T | null => {
    const p = params ?? {};
    if (fn(p)) return p as T;
    const msg = (fn.errors ?? [])
      .map((e: ErrorObject) => `${e.instancePath || "params"} ${e.message ?? "invalid"}`)
      .join("; ");
    respond(false, undefined, { code: "INVALID_PARAMS", message: msg || "invalid params" });
    return null;
  };
}

const vEnqueue = validator<QueueEnqueueParams>(QueueEnqueueParamsSchema);
const vList = validator<QueueListParams>(QueueListParamsSchema);
const vId = validator<QueueIdParams>(QueueIdParamsSchema);
const vGet = validator<QueueGetParams>(QueueGetParamsSchema);
const vCancel = validator<QueueCancelParams>(QueueCancelParamsSchema);
const vPause = validator<QueuePauseParams>(QueuePauseParamsSchema);
const vRetry = validator<QueueRetryParams>(QueueRetryParamsSchema);
const vAdvance = validator<QueueAdvanceParams>(QueueAdvanceParamsSchema);
const vReorder = validator<QueueReorderParams>(QueueReorderParamsSchema);
const vLogs = validator<QueueLogsParams>(QueueLogsParamsSchema);
const vMetrics = validator<QueueMetricsParams>(QueueMetricsParamsSchema);
const vBackends = validator<QueueBackendsParams>(QueueBackendsParamsSchema);
const vSetPaused = validator<QueueSetPausedParams>(QueueSetPausedParamsSchema);

export const QUEUE_READ_METHODS = [
  "queue.list",
  "queue.get",
  "queue.logs",
  "queue.metrics",
  "queue.backends",
] as const;

export const QUEUE_WRITE_METHODS = [
  "queue.enqueue",
  "queue.cancel",
  "queue.pause",
  "queue.resume",
  "queue.retry",
  "queue.advance",
  "queue.reorder",
  "queue.setPaused",
] as const;

/** Runner used when the orchestrator is disabled/not booted: controls become store-only. */
const NOOP_RUNNER: PhaseRunner = {
  start: async () => {
    throw new Error("queue orchestrator is not running");
  },
  poll: async () => ({ state: "running" }),
  kill: async () => {},
  output: async () => ({ text: "", source: "none" }),
};

let offlineOrch: QueueOrchestrator | null = null;

/** The live orchestrator, or a non-ticking one for store-only operations. */
export function queueControl(): QueueOrchestrator {
  const live = peekQueueOrchestrator();
  if (live) return live;
  offlineOrch ??= new QueueOrchestrator(getQueueStore(), { runner: NOOP_RUNNER });
  return offlineOrch;
}

function fail(respond: RespondFn, err: unknown, code = "INTERNAL_ERROR"): void {
  const message = err instanceof Error ? err.message : String(err);
  respond(false, undefined, {
    code: /not found/i.test(message) ? "NOT_FOUND" : code,
    message,
  });
}

function resolveId(raw: string): string {
  const id = getQueueStore().resolveId(raw);
  if (!id) throw new Error(`queue entry not found: ${raw}`);
  return id;
}

function view(entry: QueueEntry) {
  const store = getQueueStore();
  return {
    ...entry,
    currentAttempt: entry.currentRunId
      ? store.getAttemptByRunId(entry.currentRunId)
      : store.latestAttempt(entry.id, entry.currentPhaseIdx),
  };
}

/** Normalize a validated phase (gate checks get ids + labels; strings trimmed). */
function normalizePhase(p: QueueEnqueueParams["phaseSpec"][number]): QueuePhase {
  const str = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  return {
    name: p.name.trim(),
    brief: p.brief ?? "",
    blockers: p.blockers,
    gateCriteria:
      typeof p.gateCriteria === "string"
        ? p.gateCriteria
        : Array.isArray(p.gateCriteria)
          ? normalizeChecks(p.gateCriteria)
          : undefined,
    agent: str(p.agent),
    model: str(p.model),
    fallbackAgent: str(p.fallbackAgent),
    workdir: str(p.workdir),
    maxAttempts: p.maxAttempts,
    timeoutSec: p.timeoutSec,
    requireVerified: p.requireVerified,
    isolation: p.isolation,
  };
}

/** Shared by the RPC, the queue_run tool and tests. Throws on invalid input. */
export function enqueueEntry(
  p: QueueEnqueueParams,
  meta: { createdBy?: string | null; trusted?: boolean } = {},
): QueueEntry & { deduped?: boolean } {
  const phases = p.phaseSpec.map(normalizePhase);
  const workdirs = [p.workdir, ...phases.map((ph) => ph.workdir)].filter(Boolean) as string[];
  for (const w of workdirs) {
    if (!w.startsWith("/") && !w.startsWith("~")) {
      throw new Error(`workdir must be an absolute path: ${w}`);
    }
  }
  for (const ph of phases) {
    // Resolve now so a typo'd agent is visible immediately in the entry.
    resolveAgent(ph.agent);
  }
  const home = process.env.HOME ?? "";
  const expand = (w: string | undefined) => (w?.startsWith("~") ? `${home}${w.slice(1)}` : w);
  const entry = getQueueStore().enqueue({
    title: p.title,
    briefMd: p.briefMd ?? "",
    phaseSpec: phases.map((ph) => ({ ...ph, workdir: expand(ph.workdir) })),
    priority: p.priority,
    dependsOn: (p.dependsOn ?? []).map(resolveId),
    workdir: expand(p.workdir) ?? null,
    isolation: p.isolation,
    timeoutSec: p.timeoutSec ?? null,
    idempotencyKey: p.idempotencyKey ?? null,
    paused: p.paused,
    trusted: meta.trusted !== false,
    createdBy: meta.createdBy ?? null,
  });
  if (!entry.deduped) queueControl().created(entry);
  return entry;
}

export const queueHandlers: GatewayRequestHandlers = {
  "queue.enqueue": ({ params, respond, client }) => {
    const p = vEnqueue(params, respond);
    if (!p) return;
    try {
      const entry = enqueueEntry(p, {
        createdBy: client?.authUser || client?.saasEmail || "rpc",
        trusted: p.autoApprove !== false,
      });
      respond(true, { id: entry.id, entry: view(entry), deduped: entry.deduped === true });
    } catch (e) {
      fail(respond, e, "INVALID_PARAMS");
    }
  },

  "queue.list": ({ params, respond }) => {
    const p = vList(params, respond);
    if (!p) return;
    try {
      const store = getQueueStore();
      const entries = store.list({
        status: p.status as QueueStatus | QueueStatus[] | undefined,
        limit: p.limit,
      });
      respond(true, {
        entries: entries.map(view),
        paused: store.isDispatchPaused(),
        maxConcurrent: queueControl().maxConcurrent,
        running: store.countByStatus().running ?? 0,
        orchestrator: peekQueueOrchestrator()
          ? { id: peekQueueOrchestrator()!.id, leader: peekQueueOrchestrator()!.isLeader() }
          : null,
      });
    } catch (e) {
      fail(respond, e);
    }
  },

  "queue.get": ({ params, respond }) => {
    const p = vGet(params, respond);
    if (!p) return;
    try {
      const store = getQueueStore();
      const id = resolveId(p.id);
      const entry = store.get(id)!;
      respond(true, {
        entry: view(entry),
        attempts: store.listAttempts(id),
        events: store.listEvents(id, p.events ?? 200),
      });
    } catch (e) {
      fail(respond, e);
    }
  },

  "queue.logs": async ({ params, respond }) => {
    const p = vLogs(params, respond);
    if (!p) return;
    try {
      const store = getQueueStore();
      const id = resolveId(p.id);
      const attempt = p.attemptId ? store.getAttempt(p.attemptId) : store.latestAttempt(id);
      if (!attempt || attempt.entryId !== id) {
        respond(true, { attempt: null, text: "", source: "none" });
        return;
      }
      const out = await queueControl().attemptOutput(attempt, p.maxChars ?? 20_000);
      respond(true, { attempt, ...out });
    } catch (e) {
      fail(respond, e);
    }
  },

  "queue.metrics": ({ params, respond }) => {
    const p = vMetrics(params, respond);
    if (!p) return;
    try {
      respond(true, getQueueStore().metrics(p.sinceMs ?? 0));
    } catch (e) {
      fail(respond, e);
    }
  },

  "queue.backends": async ({ params, respond }) => {
    const p = vBackends(params, respond);
    if (!p) return;
    try {
      const { queueAvailability } = await import("../../queue/boot.js");
      respond(true, { backends: await queueAvailability.all(p.refresh === true) });
    } catch (e) {
      fail(respond, e);
    }
  },

  "queue.cancel": async ({ params, respond }) => {
    const p = vCancel(params, respond);
    if (!p) return;
    try {
      const entry = await queueControl().cancel(resolveId(p.id), p.reason ?? "operator cancel");
      respond(true, { ok: true, entry: view(entry) });
    } catch (e) {
      fail(respond, e, "INVALID_REQUEST");
    }
  },

  "queue.pause": async ({ params, respond }) => {
    const p = vPause(params, respond);
    if (!p) return;
    try {
      respond(true, { entry: view(await queueControl().pause(resolveId(p.id), p.force === true)) });
    } catch (e) {
      fail(respond, e, "INVALID_REQUEST");
    }
  },

  "queue.resume": async ({ params, respond }) => {
    const p = vId(params, respond);
    if (!p) return;
    try {
      respond(true, { entry: view(await queueControl().resume(resolveId(p.id))) });
    } catch (e) {
      fail(respond, e, "INVALID_REQUEST");
    }
  },

  "queue.retry": async ({ params, respond }) => {
    const p = vRetry(params, respond);
    if (!p) return;
    try {
      const entry = await queueControl().retry(resolveId(p.id), {
        fromPhase: p.fromPhase,
        instruction: p.instruction,
        freshSession: p.freshSession,
        agent: p.agent,
        model: p.model,
      });
      respond(true, { entry: view(entry) });
    } catch (e) {
      fail(respond, e, "INVALID_REQUEST");
    }
  },

  "queue.advance": async ({ params, respond }) => {
    const p = vAdvance(params, respond);
    if (!p) return;
    try {
      respond(true, {
        entry: view(await queueControl().advance(resolveId(p.id), p.reason ?? "no reason given")),
      });
    } catch (e) {
      fail(respond, e, "INVALID_REQUEST");
    }
  },

  "queue.reorder": ({ params, respond }) => {
    const p = vReorder(params, respond);
    if (!p) return;
    try {
      respond(true, { entry: view(queueControl().reorder(resolveId(p.id), p.priority)) });
    } catch (e) {
      fail(respond, e, "INVALID_REQUEST");
    }
  },

  "queue.setPaused": ({ params, respond }) => {
    const p = vSetPaused(params, respond);
    if (!p) return;
    try {
      getQueueStore().setDispatchPaused(p.paused);
      broadcastQueueEvent("queue.changed", { id: "*" });
      respond(true, { paused: getQueueStore().isDispatchPaused() });
    } catch (e) {
      fail(respond, e);
    }
  },
};
