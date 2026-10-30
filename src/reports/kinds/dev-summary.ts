/**
 * Report kind: `dev_summary` — engineering activity summary.
 *
 * Filters subagent history for coder/dev/qa agents, aggregates files touched,
 * run durations, and success/fail — and produces an engineering-department
 * PDF report.
 *
 * Department: engineering | sourceAgent: head-of-dev
 */

import { listSubagentHistory } from "../../agents/subagent-history.js";
import type { CollectedReport, ReportKindModule, Theme } from "../types.js";
import { renderReportHtml } from "../template.js";
import { getTheme } from "../themes/index.js";

export const DEV_SUMMARY_KIND = "dev_summary" as const;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Agent label substrings that qualify as engineering agents. */
const DEV_AGENT_PATTERNS = [
  "coder",
  "coder-claude",
  "head-of-dev",
  "head_of_dev",
  "webdev",
  "web-dev",
  "web_dev",
  "qa",
  "tester",
  "devops",
  "backend",
  "frontend",
];

function isDevAgent(label: string | undefined): boolean {
  if (!label) return false;
  const lower = label.toLowerCase();
  return DEV_AGENT_PATTERNS.some((p) => lower.includes(p));
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function fmtDuration(startedAt: number | undefined, endedAt: number): string {
  if (!startedAt) return "—";
  const secs = Math.round((endedAt - startedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  return `${mins}m${s > 0 ? ` ${s}s` : ""}`;
}

export const devSummaryKind: ReportKindModule = {
  kind: DEV_SUMMARY_KIND,

  async collect({ theme, config }): Promise<CollectedReport> {
    const now = (config?.now as number | undefined) ?? Date.now();
    const windowMs = (config?.windowMs as number | undefined) ?? WINDOW_MS;
    const since = now - windowMs;

    // ── Data gathering ──────────────────────────────────────────────────────
    const { entries } = safe(
      () => listSubagentHistory({ since, limit: 500 }),
      { entries: [] as ReturnType<typeof listSubagentHistory>["entries"], total: 0 },
    );

    const devEntries = entries.filter((e) => isDevAgent(e.label));

    const runsTotal = devEntries.length;
    const successCount = devEntries.filter((e) => e.status === "complete").length;
    const successRate =
      runsTotal > 0 ? `${Math.round((successCount / runsTotal) * 100)}%` : "N/A";
    const filesTouched = devEntries.reduce(
      (acc, e) => acc + (e.filesTouchedCount ?? 0),
      0,
    );

    // Table rows: label, status, files_touched, duration
    const tableRows: Array<[string, string, number | string, string]> = devEntries
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 40)
      .map((e) => [
        (e.label ?? "coder").slice(0, 40),
        e.status,
        e.filesTouchedCount ?? 0,
        fmtDuration(e.startedAt, e.endedAt ?? now),
      ]);

    // Issues: failed / timed-out runs
    const issues = devEntries
      .filter((e) => e.status !== "complete")
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 15)
      .map((e) => {
        const label = e.label ? `[${e.label}] ` : "";
        const reason = e.error ? `: ${e.error.slice(0, 100)}` : ` (${e.status})`;
        return `${label}${(e.task ?? "").slice(0, 100)}${reason}`;
      });

    // ── Build payload and render ────────────────────────────────────────────
    const t = theme ?? getTheme("black-gold");

    const html = renderReportHtml(
      {
        title: "Dev Summary",
        subtitle: `Engineering activity · ${new Date(now).toLocaleDateString()}`,
        eyebrow: "ENGINEERING REPORT",
        generatedAt: now,
        metrics: [
          { label: "Runs Total", value: runsTotal },
          { label: "Files Touched", value: filesTouched },
          { label: "Success Rate", value: successRate },
        ],
        sections: [
          {
            heading: "Engineering Activity",
            body:
              devEntries.length > 0
                ? `${runsTotal} engineering run${runsTotal === 1 ? "" : "s"} in the last 24 hours. ` +
                  `${successCount} completed successfully (${successRate}). ` +
                  `${filesTouched} file${filesTouched === 1 ? "" : "s"} touched in total.`
                : "No engineering agent activity recorded in this window.",
          },
          {
            heading: "Run Results",
            count: tableRows.length,
            table: tableRows.length > 0
              ? {
                  columns: ["Agent", "Status", "Files Touched", "Duration"],
                  rows: tableRows,
                  pillColumns: [1],
                }
              : undefined,
            body: tableRows.length === 0 ? "No runs to display." : undefined,
          },
          {
            heading: "Issues",
            count: issues.length,
            bullets: issues.length > 0 ? issues : undefined,
            body: issues.length === 0 ? "No errors or timeouts." : undefined,
          },
        ],
        footer: "Generated by head-of-dev · InfiniBot Agency OS",
        theme: "black-gold",
      },
      t as Theme,
    );

    const summaryText =
      `${runsTotal} run${runsTotal === 1 ? "" : "s"} · ${filesTouched} files touched · ${successRate} success`;

    return {
      title: `Dev Summary — ${new Date(now).toLocaleDateString()}`,
      summaryText,
      html,
    };
  },
};

export default devSummaryKind;
