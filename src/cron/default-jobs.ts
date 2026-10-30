import {
  addAutonomyJob,
  applyAutonomyOptIn,
  resolveAutonomySeedEnabled,
} from "./autonomy-optin.js";
import type { CronService } from "./service.js";
import type { CronJobCreate } from "./types.js";

/**
 * Default proactive cron jobs.
 *
 * These give the gateway a self-driven cadence even when no one is actively
 * chatting: a periodic "proactive check" nudge into the main session, and a
 * faster poll that pokes the autonomy queue so parked/blocked work resumes
 * without waiting for a human to open the autonomy page.
 *
 * Jobs are matched/deduped by `name` (cron job ids are random UUIDs, so the
 * name is the stable identity). Re-running setup is a no-op once they exist —
 * we never duplicate and never clobber operator edits (enabled flag, schedule,
 * payload text are left alone if the job is already present).
 */
export const DEFAULT_PROACTIVE_JOBS: CronJobCreate[] = [
  {
    name: "heartbeat-proactive",
    description:
      "Every 15 minutes: nudge the main session to run a proactive check (review queue, kanban, blockers, and surface anything that needs attention).",
    enabled: true,
    schedule: { kind: "every", everyMs: 15 * 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[proactive-check] Time for a proactive sweep. Review the autonomy queue, kanban board, " +
        "and any blocked/parked tasks. If there is useful autonomous work to do (or a blocker to " +
        "report), act on it; otherwise stay idle. Keep this lightweight.",
    },
  },
  {
    name: "autonomy-queue-poll",
    description:
      "Every 5 minutes: poke the autonomy queue so pending/blocked tasks get re-evaluated and resumed.",
    enabled: true,
    schedule: { kind: "every", everyMs: 5 * 60_000 },
    sessionTarget: "main",
    // "now" forces an immediate heartbeat so the autonomy manager processes the
    // queue promptly rather than waiting for the next scheduled heartbeat tick.
    wakeMode: "now",
    payload: {
      kind: "systemEvent",
      text:
        "[autonomy-queue-poll] Process the autonomy queue: pick up any pending/approved tasks and " +
        "re-evaluate blocked tasks whose backoff has elapsed.",
    },
  },
];

/**
 * Idempotently ensure the default proactive cron jobs exist. Safe to call on
 * every gateway boot — existing jobs (matched by name) are left untouched.
 * Returns the names of jobs that were newly created.
 *
 * This is the first seeder the gateway runs on boot, so it also applies a
 * pending autonomy opt-in (see ./autonomy-optin.ts). On a fresh install new
 * jobs are created disabled until the operator opts in.
 */
export async function ensureDefaultProactiveCronJobs(cron: CronService): Promise<string[]> {
  await applyAutonomyOptIn(cron);
  const existing = await cron.list({ includeDisabled: true });
  const existingNames = new Set(existing.map((j) => j.name));
  const enabled = await resolveAutonomySeedEnabled(cron);
  const created: string[] = [];
  for (const spec of DEFAULT_PROACTIVE_JOBS) {
    if (existingNames.has(spec.name)) continue;
    await addAutonomyJob(cron, spec, { enabled });
    created.push(spec.name);
  }
  return created;
}
