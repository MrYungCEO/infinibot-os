/**
 * Real cron jobs for scheduled SOPs.
 *
 * Attaching a schedule to an SOP must produce a genuine, operator-visible entry
 * in the cron service — not just a row in `wf_sop_schedules`. This module owns
 * that half, and follows `agency-operating-jobs.ts` exactly:
 *
 *  - registration is idempotent and matched by `name` (ids are random UUIDs),
 *    so re-running gateway boot, or re-saving an unchanged schedule in the UI,
 *    never duplicates a job;
 *  - an existing job is LEFT UNTOUCHED, including operator edits to `enabled`
 *    and `schedule`. Pausing a scheduled SOP in Settings therefore sticks.
 *
 * The same two-halves split as the operating loop applies: this cron job is the
 * operator-visible schedule and the agent nudge; the actual materialisation of a
 * work item is done by `WorkforceOperatingStore.tick()` against the
 * `wf_recurring_responsibilities` row that `attachSopSchedule` keeps in lockstep
 * with the job. Database work must happen whether or not an agent session is
 * alive, so it is never done from a cron payload.
 */

import type { CronJob, CronJobCreate, CronSchedule } from "./types.js";

/**
 * The slice of `CronService` the SOP layer uses. Structural on purpose: the
 * real service satisfies it, and tests can supply an in-memory double without
 * booting the cron store or arming a timer.
 */
export interface SopCronPort {
  list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]>;
  add(input: CronJobCreate): Promise<CronJob>;
  remove(id: string): Promise<{ ok: boolean; removed: boolean }>;
}

/** UI grouping key for every SOP-owned cron job. */
export const SOP_CRON_CATEGORY = "agency:sop";

const DAY_MS = 86_400_000;

/** Lowercase, dash-separated, safe inside a cron job name. */
function sanitizeSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unknown"
  );
}

/**
 * Deterministic, human-readable job name. Deterministic is the whole contract:
 * it is what makes `ensureSopCronJob` idempotent, and it is persisted on the
 * schedule row as `cronJobName`.
 */
export function sopCronJobName(sopSlug: string, workerId: string): string {
  return `agency-sop:${sanitizeSegment(sopSlug)}:${sanitizeSegment(workerId)}`;
}

export type SopCronCadence = {
  cadence: "daily" | "weekly" | "monthly";
  interval: number;
  weekday: number | null;
  monthDay: number | null;
  /** HH:MM. */
  runAt: string;
  timezone?: string;
  /** Anchor for interval schedules a cron expression cannot express. */
  nextRunAt?: number;
};

/**
 * Map an SOP cadence onto a cron schedule.
 *
 * Every-N schedules (fortnightly, every third month, …) are not expressible as
 * a standard cron expression, so they fall back to `{kind:"every"}` anchored on
 * the schedule's next occurrence. The anchor is clamped to a real timestamp:
 * an epoch anchor is the exact bug that made the operating loop crawl forward
 * from 1970, and it must not be reintroduced here.
 */
export function sopCronSchedule(spec: SopCronCadence, now = Date.now()): CronSchedule {
  const [rawHour, rawMinute] = spec.runAt.split(":");
  const hour = Number.isFinite(Number(rawHour)) ? Math.min(23, Math.max(0, Number(rawHour))) : 9;
  const minute = Number.isFinite(Number(rawMinute))
    ? Math.min(59, Math.max(0, Number(rawMinute)))
    : 0;
  const tz = spec.timezone?.trim() || "UTC";
  const interval = Math.max(1, Math.round(spec.interval || 1));

  if (interval === 1) {
    if (spec.cadence === "daily") return { kind: "cron", expr: `${minute} ${hour} * * *`, tz };
    if (spec.cadence === "weekly" && spec.weekday !== null) {
      return { kind: "cron", expr: `${minute} ${hour} * * ${spec.weekday}`, tz };
    }
    if (spec.cadence === "monthly" && spec.monthDay !== null) {
      return { kind: "cron", expr: `${minute} ${hour} ${spec.monthDay} * *`, tz };
    }
  }

  const periodMs =
    spec.cadence === "daily"
      ? interval * DAY_MS
      : spec.cadence === "weekly"
        ? interval * 7 * DAY_MS
        : interval * 30 * DAY_MS;
  // NEVER anchor at (or before) the epoch.
  const anchorMs = spec.nextRunAt && spec.nextRunAt > 0 ? spec.nextRunAt : now + periodMs;
  return { kind: "every", everyMs: periodMs, anchorMs };
}

export function sopCronJobSpec(input: {
  name: string;
  sopName: string;
  sopSlug: string;
  workerName: string;
  schedule: CronSchedule;
  enabled: boolean;
}): CronJobCreate {
  return {
    name: input.name,
    description:
      `Scheduled SOP "${input.sopName}" (${input.sopSlug}) for ${input.workerName}. ` +
      "The recurring responsibility behind it materialises a Backlog work item on this cadence.",
    enabled: input.enabled,
    defaultEnabled: true,
    category: SOP_CRON_CATEGORY,
    schedule: input.schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        `[agency-sop] The scheduled SOP "${input.sopName}" (${input.sopSlug}) is due for ` +
        `${input.workerName}. A work item has been generated into Backlog by the operating loop. ` +
        "Check `agency.ops.employee.inbox.list`. Do NOT stage it for autonomous execution " +
        "yourself — moving a card out of Backlog is the human authorisation gate.",
    },
  };
}

export type EnsureSopCronJobResult = {
  job: CronJob;
  /** False when a job of this name already existed and was left untouched. */
  created: boolean;
};

/**
 * Idempotently ensure the cron job for one scheduled SOP exists.
 *
 * Matched by name. An existing job is returned as-is: operator edits to
 * `enabled` or `schedule` are never clobbered, exactly like
 * `ensureAgencyOperatingLoopCronJobs`.
 */
export async function ensureSopCronJob(
  cron: SopCronPort,
  spec: CronJobCreate,
): Promise<EnsureSopCronJobResult> {
  // Serialise per job name: two concurrent callers would both miss the job in
  // list() and both add it, leaving a duplicate schedule.
  const previous = ensureLocks.get(spec.name) ?? Promise.resolve();
  const run = previous.then(() => ensureSopCronJobUnlocked(cron, spec));
  const settled = run.catch(() => undefined);
  ensureLocks.set(spec.name, settled);
  void settled.then(() => {
    if (ensureLocks.get(spec.name) === settled) ensureLocks.delete(spec.name);
  });
  return run;
}

const ensureLocks = new Map<string, Promise<unknown>>();

async function ensureSopCronJobUnlocked(
  cron: SopCronPort,
  spec: CronJobCreate,
): Promise<EnsureSopCronJobResult> {
  const existing = (await cron.list({ includeDisabled: true })).find(
    (job) => job.name === spec.name,
  );
  if (existing) return { job: existing, created: false };
  return { job: await cron.add(spec), created: true };
}

export async function findSopCronJob(
  cron: SopCronPort,
  name: string,
): Promise<CronJob | undefined> {
  return (await cron.list({ includeDisabled: true })).find((job) => job.name === name);
}

/**
 * Remove the cron job for a detached SOP schedule.
 *
 * Only ever removes a job this module owns (`category === SOP_CRON_CATEGORY`),
 * so a name collision with an operator-created job can never delete their work.
 */
export async function removeSopCronJob(cron: SopCronPort, name: string): Promise<boolean> {
  const job = await findSopCronJob(cron, name);
  if (!job || job.category !== SOP_CRON_CATEGORY) return false;
  const result = await cron.remove(job.id);
  return result.removed === true;
}
