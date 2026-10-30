/**
 * Attaching, detaching and firing SOPs.
 *
 * `WorkforceSopStore` owns rows; this module owns the three-way reconciliation
 * that turns a row into something the agency actually runs:
 *
 *   wf_sop_schedules            the operator's binding of one SOP to one worker
 *   wf_recurring_responsibilities  what `tick()` reads to materialise work
 *   cron job (agency:sop)       the operator-visible schedule in Settings
 *
 * All three are kept in lockstep by `attachSopSchedule`, and every write is a
 * genuine no-op when nothing changed — this database was once grown to 633 MB
 * by "idempotent" writes that were not.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 * Everything generated here lands in `queued` (the Backlog column). Nothing in
 * this module ever produces an `accepted` work item, because `accepted` IS the
 * human authorisation gate that lets the executor spawn a real coder CLI.
 *
 * ── NO EPOCH SCHEDULING ─────────────────────────────────────────────────────
 * Every path computes its next occurrence from `now`. An omitted or non-positive
 * `nextRunAt` is never persisted as 0: that is the bug that rendered as
 * "next 20657d ago" and made the loop crawl one interval per tick from 1970.
 */

import {
  SOP_CRON_CATEGORY,
  ensureSopCronJob,
  removeSopCronJob,
  sopCronJobName,
  sopCronJobSpec,
  sopCronSchedule,
  type SopCronPort,
} from "../cron/sop-jobs.js";
import type { CronJob } from "../cron/types.js";
import { nextResponsibilityRun } from "./lifecycle.js";
import type { WorkforceOperatingStore } from "./operating-store.js";
import { renderSopMarkdown, type WorkforceSopStore } from "./sop-store.js";
import type { Sop, SopRun, SopSchedule, SopScheduleInput } from "./sop-types.js";
import type { EmployeeWorkItem, RecurringResponsibility, WorkItemPriority } from "./types.js";

/** Context key set on every responsibility / work item generated from an SOP. */
export const SOP_CONTEXT_SOURCE = "sop";

/** Structural slice of the operating store the SOP service writes through. */
export type SopOperatingStorePort = Pick<
  WorkforceOperatingStore,
  | "getResponsibility"
  | "createResponsibility"
  | "updateResponsibility"
  | "deleteResponsibility"
  | "enqueueWorkItem"
>;

/** Structural slice of the worker store, used only for display names. */
export interface SopWorkerPort {
  getWorker(agencyId: string, workerId: string): { id: string; displayName: string } | null;
}

export type SopServiceDeps = {
  sopStore: WorkforceSopStore;
  operatingStore: SopOperatingStorePort;
  /** Optional: without it the row is still written, just with no cron entry. */
  cron?: SopCronPort | null;
  workerStore?: SopWorkerPort | null;
  now?: () => number;
};

export type AttachSopScheduleResult = {
  sop: Sop;
  schedule: SopSchedule;
  responsibility: RecurringResponsibility;
  /** Null when no cron service was supplied. */
  cronJob: CronJob | null;
  /** True when the cron job did not exist and was created by this call. */
  cronJobCreated: boolean;
  /** False when nothing at all changed — the fully idempotent case. */
  changed: boolean;
};

function contextFor(sop: Sop, scheduleId: string | null): Record<string, unknown> {
  return {
    source: SOP_CONTEXT_SOURCE,
    sopId: sop.id,
    sopSlug: sop.slug,
    sopVersion: sop.version,
    ...(scheduleId ? { sopScheduleId: scheduleId } : {}),
  };
}

/**
 * Bind an SOP to a worker on a cadence, producing a real cron job and a real
 * recurring responsibility.
 *
 * Safe to call repeatedly with the same input: the schedule row, the
 * responsibility and the cron job are each reconciled, and an unchanged call
 * writes nothing anywhere.
 */
export async function attachSopSchedule(
  deps: SopServiceDeps,
  agencyId: string,
  input: SopScheduleInput,
): Promise<AttachSopScheduleResult> {
  const now = deps.now?.() ?? Date.now();
  const sop = deps.sopStore.getSop(agencyId, input.sopId);
  if (!sop) throw new Error("SOP not found");
  if (!input.workerId?.trim()) throw new Error("workerId required");

  const cronJobName = sopCronJobName(sop.slug, input.workerId);
  // A caller that omits nextRunAt (or passes the RPC's 0 default) must NEVER
  // persist the epoch — drop it and let the store anchor to the next occurrence.
  const requestedNextRunAt =
    typeof input.nextRunAt === "number" && input.nextRunAt > 0 ? input.nextRunAt : undefined;

  const { schedule, changed: scheduleChanged } = deps.sopStore.upsertSchedule(
    agencyId,
    { ...input, nextRunAt: requestedNextRunAt, cronJobName },
    now,
  );

  // Belt and braces: repair a pre-existing row that somehow carries an epoch.
  let nextRunAt = schedule.nextRunAt;
  if (!(nextRunAt > 0)) {
    nextRunAt = nextResponsibilityRun(schedule, now);
  }

  const instructions = renderSopMarkdown(sop);
  const existing = schedule.responsibilityId
    ? deps.operatingStore.getResponsibility(agencyId, schedule.responsibilityId)
    : null;

  let responsibility: RecurringResponsibility;
  let responsibilityChanged = false;
  if (existing) {
    const cadenceChanged =
      existing.cadence !== schedule.cadence ||
      existing.interval !== schedule.interval ||
      existing.weekday !== schedule.weekday ||
      existing.monthDay !== schedule.monthDay ||
      existing.runAt !== schedule.runAt;
    responsibility =
      deps.operatingStore.updateResponsibility(agencyId, existing.id, {
        managerWorkerId: schedule.managerWorkerId,
        title: sop.name,
        instructions,
        cadence: schedule.cadence,
        interval: schedule.interval,
        weekday: schedule.weekday,
        monthDay: schedule.monthDay,
        runAt: schedule.runAt,
        slaMinutes: schedule.slaMinutes,
        priority: schedule.priority,
        enabled: schedule.enabled,
        context: contextFor(sop, schedule.id),
        // Only re-anchor when the cadence shape actually moved, or when the
        // stored value is unusable. Rewriting it on every reconciliation would
        // silently undo the advancement `tick()` just made.
        ...(cadenceChanged || !(existing.nextRunAt > 0) ? { nextRunAt } : {}),
      }) ?? existing;
    responsibilityChanged = responsibility.updatedAt !== existing.updatedAt;
  } else {
    responsibility = deps.operatingStore.createResponsibility(agencyId, {
      workerId: schedule.workerId,
      managerWorkerId: schedule.managerWorkerId,
      title: sop.name,
      instructions,
      cadence: schedule.cadence,
      interval: schedule.interval,
      weekday: schedule.weekday,
      monthDay: schedule.monthDay,
      runAt: schedule.runAt,
      slaMinutes: schedule.slaMinutes,
      priority: schedule.priority,
      enabled: schedule.enabled,
      nextRunAt,
      context: contextFor(sop, schedule.id),
    });
    responsibilityChanged = true;
  }

  let cronJob: CronJob | null = null;
  let cronJobCreated = false;
  if (deps.cron) {
    const workerName =
      deps.workerStore?.getWorker(agencyId, schedule.workerId)?.displayName ?? schedule.workerId;
    const ensured = await ensureSopCronJob(
      deps.cron,
      sopCronJobSpec({
        name: cronJobName,
        sopName: sop.name,
        sopSlug: sop.slug,
        workerName,
        enabled: schedule.enabled,
        schedule: sopCronSchedule({ ...schedule, nextRunAt }, now),
      }),
    );
    cronJob = ensured.job;
    cronJobCreated = ensured.created;
  }

  const linked =
    deps.sopStore.setScheduleLinks(agencyId, schedule.id, {
      cronJobId: cronJob?.id ?? schedule.cronJobId,
      responsibilityId: responsibility.id,
      nextRunAt,
    }) ?? schedule;

  return {
    sop,
    schedule: linked,
    responsibility,
    cronJob,
    cronJobCreated,
    changed: scheduleChanged || responsibilityChanged || cronJobCreated,
  };
}

export type DetachSopScheduleResult = {
  schedule: SopSchedule | null;
  responsibilityRemoved: boolean;
  cronJobRemoved: boolean;
};

/**
 * Unbind an SOP from a worker: drop the schedule row, its recurring
 * responsibility and its cron job. Historical `wf_sop_runs` are kept, and work
 * items already generated are left alone — they are real work someone may still
 * be doing.
 */
export async function detachSopSchedule(
  deps: SopServiceDeps,
  agencyId: string,
  scheduleId: string,
): Promise<DetachSopScheduleResult> {
  const schedule = deps.sopStore.getSchedule(agencyId, scheduleId);
  if (!schedule) return { schedule: null, responsibilityRemoved: false, cronJobRemoved: false };

  const responsibilityRemoved = schedule.responsibilityId
    ? deps.operatingStore.deleteResponsibility(agencyId, schedule.responsibilityId)
    : false;
  const cronJobRemoved = deps.cron
    ? await removeSopCronJob(deps.cron, schedule.cronJobName)
    : false;
  deps.sopStore.deleteSchedule(agencyId, scheduleId);
  return { schedule, responsibilityRemoved, cronJobRemoved };
}

export type RunSopOnceResult = {
  sop: Sop;
  run: SopRun;
  workItem: EmployeeWorkItem;
};

/**
 * Fire an SOP once — "run now", or "run at" a future timestamp.
 *
 * Produces a single Backlog (`queued`) work item plus a `SopRun` record. A
 * future `runAt` needs no cron entry: the item carries `scheduledFor` and the
 * executor only ever considers items whose `scheduledFor <= now`.
 *
 * Idempotent per (SOP, occurrence): re-firing for the same `scheduledFor`
 * returns the existing work item rather than a duplicate.
 */
export function runSopOnce(
  deps: SopServiceDeps,
  agencyId: string,
  input: {
    sopId: string;
    workerId?: string;
    managerWorkerId?: string | null;
    /** Absolute ms. Non-positive or absent means "now". Never the epoch. */
    runAt?: number;
    priority?: WorkItemPriority;
    slaMinutes?: number;
    note?: string | null;
  },
): RunSopOnceResult {
  const now = deps.now?.() ?? Date.now();
  const sop = deps.sopStore.getSop(agencyId, input.sopId);
  if (!sop) throw new Error("SOP not found");

  const workerId = input.workerId?.trim() || sop.ownerWorkerId;
  if (!workerId) throw new Error("workerId required: this SOP has no owner");

  const schedule = deps.sopStore.findSchedule(agencyId, sop.id, workerId);
  const scheduledFor =
    typeof input.runAt === "number" && input.runAt > 0 ? Math.round(input.runAt) : now;
  const slaMinutes = Math.min(
    43_200,
    Math.max(1, Math.round(input.slaMinutes ?? schedule?.slaMinutes ?? 1_440)),
  );
  const priority = input.priority ?? schedule?.priority ?? sop.defaultPriority;

  const workItem = deps.operatingStore.enqueueWorkItem(agencyId, {
    workerId,
    managerWorkerId: input.managerWorkerId ?? schedule?.managerWorkerId ?? null,
    // Deliberately NOT linked to the schedule's responsibility: a manual run is
    // not one of its recurring occurrences and must not disturb its cadence.
    responsibilityId: null,
    title: sop.name,
    instructions: renderSopMarkdown(sop),
    priority,
    scheduledFor,
    dueAt: scheduledFor + slaMinutes * 60_000,
    // Same occurrence ⇒ same card. `enqueueWorkItem` returns the existing row.
    idempotencyKey: `sop-once:${sop.id}:${workerId}:${scheduledFor}`,
    context: { ...contextFor(sop, schedule?.id ?? null), trigger: "manual" },
  });

  const run = deps.sopStore.recordRun(agencyId, {
    sopId: sop.id,
    scheduleId: schedule?.id ?? null,
    workerId,
    workItemId: workItem.id,
    trigger: "manual",
    sopVersion: sop.version,
    status: "materialised",
    note: input.note ?? null,
    scheduledFor,
  });

  return { sop, run, workItem };
}

export { SOP_CRON_CATEGORY };
