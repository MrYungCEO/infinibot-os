/**
 * Cron registrations for proactive department report kinds.
 *
 * Registers three daily cron jobs that nudge the main session to generate:
 *   - daily_brief:      07:00 local — strategy overview for the day
 *   - dev_summary:      08:00 local — engineering activity from the night before
 *   - content_overview: 09:00 local — marketing/content pipeline status
 *
 * All three follow the same pattern as ceo-cron.ts: main-session nudge via
 * `reports.generate`, matched by name so re-running on every boot is a no-op.
 */

import { addAutonomyJob, resolveAutonomySeedEnabled } from "../cron/autonomy-optin.js";
import type { CronService } from "../cron/service.js";
import type { CronJobCreate } from "../cron/types.js";

export const PROACTIVE_CRON_JOBS: CronJobCreate[] = [
  {
    name: "proactive-daily-brief",
    description:
      "Daily at 07:00 — generate the Daily Brief report (24h strategy-level agency overview).",
    enabled: true,
    schedule: { kind: "cron", expr: "0 7 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[proactive-daily-brief] Generate the daily brief report now. " +
        'Call: reports.generate({ kind: "daily_brief" }). ' +
        "Do NOT summarize yourself — just trigger the report and confirm the run id.",
    },
  },
  {
    name: "proactive-dev-summary",
    description:
      "Daily at 08:00 — generate the Dev Summary report (24h engineering activity overview).",
    enabled: true,
    schedule: { kind: "cron", expr: "0 8 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[proactive-dev-summary] Generate the dev summary report now. " +
        'Call: reports.generate({ kind: "dev_summary" }). ' +
        "Do NOT summarize yourself — just trigger the report and confirm the run id.",
    },
  },
  {
    name: "proactive-content-overview",
    description:
      "Daily at 09:00 — generate the Content Overview report (marketing content pipeline status).",
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[proactive-content-overview] Generate the content overview report now. " +
        'Call: reports.generate({ kind: "content_overview" }). ' +
        "Do NOT summarize yourself — just trigger the report and confirm the run id.",
    },
  },
];

/**
 * Idempotently register all three proactive department report cron jobs.
 * Returns the number of new jobs created (0 if all already exist).
 */
export async function ensureProactiveReportCronJobs(cron: CronService): Promise<number> {
  const existing = await cron.list({ includeDisabled: true });
  const existingNames = new Set(existing.map((j) => j.name));
  const enabled = await resolveAutonomySeedEnabled(cron);
  let created = 0;
  for (const job of PROACTIVE_CRON_JOBS) {
    if (!existingNames.has(job.name)) {
      await addAutonomyJob(cron, job, { enabled });
      created++;
    }
  }
  return created;
}
