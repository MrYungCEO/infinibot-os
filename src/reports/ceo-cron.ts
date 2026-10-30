/**
 * Cron registration for the CEO hourly insights report.
 *
 * Registers a single idempotent cron entry that fires every 30 minutes at :05
 * and :35 local (avoids top-of-hour contention, per the plan). The cadence was
 * raised from hourly → 30-min as part of ticket 2409 (closed-loop feedback
 * architecture) so the loop's OBSERVE→REPORT→PLAN→ACT→VERIFY cycle turns over
 * twice as fast and planning/UI-surface context stays fresher. The entry is a `main`
 * `systemEvent` that nudges the main session to trigger the report via the
 * foundation RPC `reports.generate({ kind: "ceo_hourly_insights" })`. This mirrors
 * the existing `heartbeat-proactive` pattern in `src/cron/default-jobs.ts`
 * (main-session nudges) and is matched/deduped by `name`, so re-running setup is
 * a no-op and never clobbers operator edits.
 *
 * MIGRATION NOTE: once the foundation's `report_schedules` table + worker land,
 * this should migrate to a native report schedule (cron handled by the report
 * worker, no LLM in the trigger loop). Until then the main-session nudge is the
 * only deterministic hook the cron service exposes (payloads are static strings;
 * the service has no code-callback). The nudge text is explicit enough that the
 * main agent reliably calls the RPC.
 */

import { addAutonomyJob } from "../cron/autonomy-optin.js";
import type { CronService } from "../cron/service.js";
import type { CronJobCreate } from "../cron/types.js";

export const CEO_HOURLY_CRON_NAME = "ceo-hourly-insights";

const CEO_HOURLY_CRON_JOB: CronJobCreate = {
  name: CEO_HOURLY_CRON_NAME,
  description:
    "Every 30 min at :05 and :35 — generate the CEO insights report (3-7 actionable insights over the last 60 min of kanban/agents/credits/discipline activity + planning/UI-surface context), render the PDF, and ship to UI + Telegram.",
  enabled: true,
  // Minutes 5 and 35 of every hour, local time (every 30 min). The cron service
  // supports a 5-field expr. Raised from hourly under ticket 2409 to tighten the
  // closed-loop feedback cycle.
  schedule: { kind: "cron", expr: "5,35 * * * *" },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: {
    kind: "systemEvent",
    text:
      "[ceo-hourly-insights] Generate the CEO hourly insights report now. " +
      'Call the report system: reports.generate({ kind: "ceo_hourly_insights" }). ' +
      "Do NOT summarize the hour yourself — just trigger the report and confirm the run id. " +
      "The report worker collects the last 60 min of activity, spawns the CEO/overseer agent, " +
      "writes the insight rows, and renders + ships the PDF.",
  },
};

/**
 * Idempotently ensure the CEO hourly cron job exists. Safe to call on every
 * gateway boot — an existing job (matched by name) is left untouched. Returns
 * true if a new job was created.
 */
export async function ensureCeoReportCronJobs(cron: CronService): Promise<boolean> {
  const existing = await cron.list({ includeDisabled: true });
  if (existing.some((j) => j.name === CEO_HOURLY_CRON_NAME)) return false;
  await addAutonomyJob(cron, CEO_HOURLY_CRON_JOB);
  return true;
}
