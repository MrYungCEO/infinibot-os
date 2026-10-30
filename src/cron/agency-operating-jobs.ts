import { addAutonomyJob } from "./autonomy-optin.js";
import type { CronService } from "./service.js";
import type { CronJob, CronJobCreate } from "./types.js";

/**
 * The agency workforce operating loop cron job.
 *
 * `WorkforceOperatingStore.tick()` is what makes the agency an *operating*
 * system rather than a set of tables: it materialises due work items from
 * recurring responsibilities, escalates SLA-breached items and moves manager
 * review cycles to `due`. Nothing scheduled it before this job existed — it
 * only ran when someone manually invoked `agency.ops.employee.loop.tick`.
 *
 * Two halves, deliberately:
 *  - This cron job is the operator-visible schedule. It lives in the same store
 *    as the other default jobs, so it can be paused, re-timed or run on demand
 *    from Settings, and its `systemEvent` payload nudges the main session to
 *    act on whatever the tick just produced.
 *  - The tick itself is plain database work that must happen whether or not an
 *    agent session is alive, so it is executed in-process by
 *    `startAgencyOperatingLoopScheduler` (src/agency-operations/operating-loop.ts),
 *    which reads its cadence from *this* job. Editing the job's schedule or
 *    disabling it therefore controls the real loop, not just the nudge.
 *
 * Registration is idempotent and matched by `name` (ids are random UUIDs), the
 * same contract as `ensureDefaultProactiveCronJobs`: re-running gateway boot
 * never duplicates the job and never clobbers operator edits.
 */
export const AGENCY_OPERATING_LOOP_JOB_NAME = "agency-operating-loop";
export const AGENCY_OPERATING_LOOP_CATEGORY = "agency:operating";
export const AGENCY_OPERATING_LOOP_DEFAULT_MS = 15 * 60_000;
/** Guard rails so a bad config cannot hammer (or effectively disable) the loop. */
export const AGENCY_OPERATING_LOOP_MIN_MS = 60_000;
export const AGENCY_OPERATING_LOOP_MAX_MS = 24 * 60 * 60_000;

export function normalizeOperatingLoopIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return AGENCY_OPERATING_LOOP_DEFAULT_MS;
  }
  return Math.min(AGENCY_OPERATING_LOOP_MAX_MS, Math.max(AGENCY_OPERATING_LOOP_MIN_MS, value));
}

export function agencyOperatingLoopJobSpec(everyMs?: number): CronJobCreate {
  return {
    name: AGENCY_OPERATING_LOOP_JOB_NAME,
    description:
      "Runs the agency workforce operating loop for every agency: generate due recurring work, " +
      "escalate SLA breaches and mark manager review cycles due.",
    enabled: true,
    defaultEnabled: true,
    category: AGENCY_OPERATING_LOOP_CATEGORY,
    schedule: { kind: "every", everyMs: normalizeOperatingLoopIntervalMs(everyMs) },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[agency-operating-loop] The workforce operating loop just ran for every agency. " +
        "Check `agency.ops.employee.inbox.list` for newly generated or escalated work items and " +
        "`agency.ops.employee.reviews.list` for due manager reviews. Act on anything urgent or " +
        "blocked; otherwise stay idle. Keep this lightweight.",
    },
  };
}

/**
 * Idempotently ensure the agency operating loop cron job exists. Safe to call on
 * every gateway boot — an existing job (matched by name) is left untouched,
 * including operator edits to schedule/enabled. Returns newly created names.
 */
export async function ensureAgencyOperatingLoopCronJobs(
  cron: CronService,
  opts?: { everyMs?: number },
): Promise<string[]> {
  const existing = await cron.list({ includeDisabled: true });
  if (existing.some((job) => job.name === AGENCY_OPERATING_LOOP_JOB_NAME)) return [];
  await addAutonomyJob(cron, agencyOperatingLoopJobSpec(opts?.everyMs));
  return [AGENCY_OPERATING_LOOP_JOB_NAME];
}

export async function findAgencyOperatingLoopJob(cron: CronService): Promise<CronJob | undefined> {
  const jobs = await cron.list({ includeDisabled: true });
  return jobs.find((job) => job.name === AGENCY_OPERATING_LOOP_JOB_NAME);
}

/** Effective cadence: the operator-edited cron schedule wins over the default. */
export function operatingLoopIntervalFromJob(
  job: CronJob | undefined,
  fallbackMs?: number,
): number {
  if (job?.schedule.kind === "every") return normalizeOperatingLoopIntervalMs(job.schedule.everyMs);
  return normalizeOperatingLoopIntervalMs(fallbackMs);
}
