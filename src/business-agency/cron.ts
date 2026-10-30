/**
 * Cron jobs owned by the Business & Agency plugin.
 *
 * Plugins can't register cron jobs, so core seeds these at boot — but only
 * while the business-agency plugin is loaded (server.impl.ts):
 *   - `agency-operating-loop` (src/cron/agency-operating-jobs.ts) + its
 *     in-process scheduler,
 *   - `agency-sop:<slug>:<worker>` SOP schedules (created by agency.ops.*),
 *   - `ceo-hourly-insights` (src/reports/ceo-cron.ts),
 *   - `oversight-client-snapshot` (src/cron/oversight-jobs.ts, per-client report).
 *
 * A fresh install (plugin off) therefore gets none of them. An install that
 * turns the plugin off keeps its jobs exactly as they were (their `enabled`
 * flags are never touched, so turning it back on resumes them); the cron
 * runner just skips a plugin-owned job while the plugin is off.
 */

import { BUSINESS_AGENCY_PLUGIN_NAME } from "./methods.js";

export const BUSINESS_AGENCY_CRON_JOB_NAMES: ReadonlySet<string> = new Set([
  "agency-operating-loop",
  "ceo-hourly-insights",
  // Weekly per-client status report (src/cron/oversight-jobs.ts).
  "oversight-client-snapshot",
]);

const SOP_JOB_PREFIX = "agency-sop:";

/** True for a cron job the business-agency plugin owns (matched by name). */
export function isBusinessAgencyCronJob(name: string | undefined): boolean {
  if (!name) return false;
  return BUSINESS_AGENCY_CRON_JOB_NAMES.has(name) || name.startsWith(SOP_JOB_PREFIX);
}

/** Why a plugin-owned job is skipped right now, or null when it may run. */
export function businessAgencyCronSkipReason(
  name: string | undefined,
  isActive: () => boolean,
): string | null {
  if (!isBusinessAgencyCronJob(name) || isActive()) return null;
  return `paused: the ${BUSINESS_AGENCY_PLUGIN_NAME} plugin is turned off (enable it in Setup › Plugins)`;
}
