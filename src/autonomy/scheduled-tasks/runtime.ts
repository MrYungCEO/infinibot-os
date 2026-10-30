/**
 * Gateway-side singleton for {@link ScheduledTaskService}: production goal API
 * (goals.* service), delivery sink, black-gold PDF rendering + /reports
 * registration, WS events, and boot (recover + seed + tick loop).
 *
 * Env:
 *   INFINIBOT_SCHEDULED_TASKS_DISABLE=1   don't start the tick loop
 *   INFINIBOT_SCHEDULED_TASKS_SINK=file:/x.jsonl | none   delivery override
 *   INFINIBOT_SCHEDULED_TASKS_SEED=0      don't seed the default task
 *   INFINIBOT_SCHEDULED_TASKS_TICK_MS     tick interval (default 15000)
 */

import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { broadcastQueueBridgeEvent } from "../../queue/events.js";
import type { ReportPayload } from "../../reports/types.js";
import { createGoalFromInput, getGoalRunner } from "../goals/service.js";
import { resolveDefaultSink } from "./delivery.js";
import { seedDefaultTasks } from "./seed.js";
import { ScheduledTaskService, type GoalsApi } from "./service.js";
import { getScheduledTaskStore } from "./store.js";

const log = createSubsystemLogger("autonomy.scheduled.runtime");

let service: ScheduledTaskService | null = null;

export const productionGoalsApi: GoalsApi = {
  create: (input) => createGoalFromInput(input),
  get: (id) => getGoalRunner().store.get(id),
  continueWith: (id, instruction) => getGoalRunner().continueWith(id, instruction),
  retry: (id) => getGoalRunner().retry(id),
  cancel: (id, reason) => getGoalRunner().cancel(id, reason),
};

async function renderPdf(
  payload: ReportPayload,
  path: string,
  kind: string,
): Promise<string | null> {
  const { renderReport, ingestExternalPdf } = await import("../../reports/index.js");
  await renderReport(payload, { savePath: path });
  try {
    const rec = ingestExternalPdf({
      path,
      kind,
      title: payload.title,
      summaryText: payload.subtitle ?? undefined,
      trigger: "cron",
    });
    return rec.id;
  } catch (err) {
    log.warn("could not register report in /reports", { error: String(err) });
    return null;
  }
}

export function getScheduledTaskService(): ScheduledTaskService {
  if (!service) {
    service = new ScheduledTaskService({
      store: getScheduledTaskStore(),
      goals: productionGoalsApi,
      sink: resolveDefaultSink(),
      stateDir: resolveStateDir(),
      renderPdf: process.env.INFINIBOT_SCHEDULED_TASKS_PDF === "0" ? null : renderPdf,
      emit: (event, payload) => broadcastQueueBridgeEvent(event, payload),
    });
  }
  return service;
}

export function setScheduledTaskServiceForTests(s: ScheduledTaskService | null): void {
  service = s;
}

export function startScheduledTasks(): void {
  if (process.env.INFINIBOT_SCHEDULED_TASKS_DISABLE === "1") return;
  try {
    const svc = getScheduledTaskService();
    if (process.env.INFINIBOT_SCHEDULED_TASKS_SEED !== "0") {
      try {
        seedDefaultTasks(svc);
      } catch (err) {
        log.warn("scheduled-task seed failed", { error: String(err) });
      }
    }
    svc.start(Number(process.env.INFINIBOT_SCHEDULED_TASKS_TICK_MS) || 15_000);
  } catch (err) {
    log.warn("scheduled tasks failed to start", { error: String(err) });
  }
}
