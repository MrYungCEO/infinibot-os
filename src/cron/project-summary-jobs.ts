import { addAutonomyJob } from "./autonomy-optin.js";
import type { CronService } from "./service.js";
import type { CronJobCreate } from "./types.js";

/**
 * Daily "regenerate AI current-state summaries" cron job.
 *
 * Same two-halves contract as the agency operating loop:
 *  - This operator-visible cron job owns the cadence + enabled flag (editable
 *    from Settings) and its `systemEvent` payload nudges the main session.
 *  - The actual regeneration is plain LLM+DB work that must run whether or not
 *    an agent session is alive, so it executes in-process via
 *    `startProjectSummaryScheduler` (see server.impl.ts), which reads its
 *    cadence from THIS job.
 *
 * Registration is idempotent, matched by `name`, so re-running gateway boot
 * never duplicates the job and never clobbers operator edits.
 */
export const PROJECT_SUMMARY_JOB_NAME = "project-summary-daily";
export const PROJECT_SUMMARY_CATEGORY = "projects:summary";
export const PROJECT_SUMMARY_DEFAULT_MS = 24 * 60 * 60_000;
/** Guard rails so a bad config cannot hammer the LLM or effectively disable it. */
export const PROJECT_SUMMARY_MIN_MS = 60 * 60_000;
export const PROJECT_SUMMARY_MAX_MS = 7 * 24 * 60 * 60_000;

export function normalizeProjectSummaryIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return PROJECT_SUMMARY_DEFAULT_MS;
  }
  return Math.min(PROJECT_SUMMARY_MAX_MS, Math.max(PROJECT_SUMMARY_MIN_MS, value));
}

export function projectSummaryJobSpec(everyMs?: number): CronJobCreate {
  return {
    name: PROJECT_SUMMARY_JOB_NAME,
    description:
      "Regenerates the AI current-state summary for every in-progress project once per day via the " +
      "project-manager agent, so each project page always opens with an up-to-date briefing.",
    enabled: true,
    defaultEnabled: true,
    category: PROJECT_SUMMARY_CATEGORY,
    schedule: { kind: "every", everyMs: normalizeProjectSummaryIntervalMs(everyMs) },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[project-summary-daily] AI current-state summaries were just regenerated for all in-progress " +
        "projects. No action needed unless a summary surfaces a risk worth acting on.",
    },
  };
}

/**
 * Idempotently ensure the daily project-summary cron job exists. Safe to call
 * on every gateway boot — an existing job (matched by name) is left untouched,
 * including operator edits. Returns newly created names.
 */
export async function ensureProjectSummaryCronJobs(
  cron: CronService,
  opts?: { everyMs?: number },
): Promise<string[]> {
  const existing = await cron.list({ includeDisabled: true });
  if (existing.some((job) => job.name === PROJECT_SUMMARY_JOB_NAME)) return [];
  await addAutonomyJob(cron, projectSummaryJobSpec(opts?.everyMs));
  return [PROJECT_SUMMARY_JOB_NAME];
}
