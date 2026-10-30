/**
 * KIS Phase 1 **operations agents** (§19–§21) — public surface.
 *
 * Three read-only agents over the live business-object stores:
 *   • generateCeoBriefing      §19 Daily CEO Briefing
 *   • generateExceptionReport  §20 Operations Monitor (exception report)
 *   • generateProjectHealth    §21 Project Health (Green/Yellow/Red + why)
 *
 * All three are pure functions over an `OpsInputs` snapshot. `collectOpsInputs`
 * builds that snapshot from the singleton stores; `run*` convenience wrappers
 * collect-then-run and log the run to the audit trail (§ authority L1 — observe
 * & recommend only, never act).
 */

import { logAudit } from "../../autonomy/audit.js";
import { collectOpsInputs } from "./inputs.js";
import { generateCeoBriefing } from "./ceo-briefing.js";
import { generateExceptionReport } from "./operations-monitor.js";
import { generateProjectHealth } from "./project-health.js";
import type { CeoBriefing, ExceptionReport, ProjectHealthReport } from "./types.js";

export * from "./types.js";
export { collectOpsInputs } from "./inputs.js";
export { generateCeoBriefing } from "./ceo-briefing.js";
export { generateExceptionReport } from "./operations-monitor.js";
export { generateProjectHealth } from "./project-health.js";
export { ceoBriefingReport, exceptionReportPdf, projectHealthReport } from "./reports.js";

export interface OpsAgentRunOptions {
  now?: number;
  stateDir?: string;
}

/** §19 — collect live inputs, build the briefing, and audit the run. */
export async function runCeoBriefing(opts: OpsAgentRunOptions = {}): Promise<CeoBriefing> {
  const inputs = await collectOpsInputs(opts);
  const briefing = generateCeoBriefing(inputs);
  logAudit("system_event", "Daily CEO briefing generated", {
    category: "system",
    agentId: "ops-ceo-briefing",
    outcome: "success",
    details: { todayCount: briefing.todayCount, quietDay: briefing.quietDay },
  });
  return briefing;
}

/** §20 — collect live inputs, scan for exceptions, and audit the run. */
export async function runOperationsMonitor(opts: OpsAgentRunOptions = {}): Promise<ExceptionReport> {
  const inputs = await collectOpsInputs(opts);
  const report = generateExceptionReport(inputs);
  logAudit("system_event", "Operations monitor exception scan", {
    category: "system",
    agentId: "ops-monitor",
    outcome: "success",
    details: { totalExceptions: report.totalExceptions, categories: report.groups.length },
  });
  return report;
}

/** §21 — collect live inputs, rate project health, and audit the run. */
export async function runProjectHealth(opts: OpsAgentRunOptions = {}): Promise<ProjectHealthReport> {
  const inputs = await collectOpsInputs(opts);
  const report = generateProjectHealth(inputs);
  logAudit("system_event", "Project health evaluation", {
    category: "system",
    agentId: "ops-project-health",
    outcome: "success",
    details: report.counts,
  });
  return report;
}
