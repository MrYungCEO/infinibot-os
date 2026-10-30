/**
 * Report kind: `daily_brief` — 24-hour agency operations brief.
 *
 * Collects the last 24h of subagent runs from history.json and produces a
 * strategy-level summary: headline metrics, per-agent activity table, top
 * completed tasks, and any errors/timeouts that need attention.
 *
 * Department: strategy | sourceAgent: main
 */

import { listSubagentHistory } from "../../agents/subagent-history.js";
import type { CollectedReport, ReportKindModule, Theme } from "../types.js";
import { renderReportHtml } from "../template.js";
import { getTheme } from "../themes/index.js";

export const DAILY_BRIEF_KIND = "daily_brief" as const;
const WINDOW_MS = 24 * 60 * 60 * 1000;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const dailyBriefKind: ReportKindModule = {
  kind: DAILY_BRIEF_KIND,

  async collect({ theme, config, stateDir }): Promise<CollectedReport> {
    const now = (config?.now as number | undefined) ?? Date.now();
    const windowMs = (config?.windowMs as number | undefined) ?? WINDOW_MS;
    const since = now - windowMs;

    // ── Data gathering ──────────────────────────────────────────────────────
    const { entries } = safe(
      () => listSubagentHistory({ since, limit: 500 }),
      { entries: [] as ReturnType<typeof listSubagentHistory>["entries"], total: 0 },
    );

    // Aggregate per-agent stats
    const agentMap = new Map<
      string,
      { runs: number; success: number; fail: number; lastAt: number }
    >();
    for (const e of entries) {
      const key = e.label ?? "unnamed";
      const existing = agentMap.get(key) ?? { runs: 0, success: 0, fail: 0, lastAt: 0 };
      existing.runs++;
      if (e.status === "complete") existing.success++;
      else existing.fail++;
      if ((e.endedAt ?? 0) > existing.lastAt) existing.lastAt = e.endedAt ?? 0;
      agentMap.set(key, existing);
    }

    const totalRuns = entries.length;
    const successCount = entries.filter((e) => e.status === "complete").length;
    const successRate =
      totalRuns > 0 ? `${Math.round((successCount / totalRuns) * 100)}%` : "N/A";
    const activeAgentsCount = agentMap.size;

    // Top 5 completed tasks (most recent first)
    const topCompleted = entries
      .filter((e) => e.status === "complete")
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 5)
      .map((e) => {
        const label = e.label ? `${e.label}: ` : "";
        const task = (e.task ?? "").slice(0, 120);
        return `${label}${task}`;
      });

    // Errors / timeouts
    const flags = entries
      .filter((e) => e.status !== "complete")
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 20)
      .map((e) => {
        const label = e.label ? `[${e.label}] ` : "";
        const reason = e.error ? `: ${e.error.slice(0, 100)}` : "";
        return `${label}${e.status}${reason}`;
      });

    // Agent activity table rows (sorted by runs desc)
    const agentTableRows: Array<[string, number, string]> = [...agentMap.entries()]
      .sort(([, a], [, b]) => b.runs - a.runs)
      .slice(0, 30)
      .map(([agent, s]) => [
        agent,
        s.runs,
        `${s.success} / ${s.fail}`,
      ]);

    // ── Build payload and render ────────────────────────────────────────────
    const t = theme ?? getTheme("black-gold");

    const html = renderReportHtml(
      {
        title: "Daily Brief",
        subtitle: `24-hour agency activity overview · ${new Date(now).toLocaleDateString()}`,
        eyebrow: "STRATEGY REPORT",
        generatedAt: now,
        metrics: [
          { label: "Total Runs", value: totalRuns },
          { label: "Success Rate", value: successRate },
          { label: "Active Agents", value: activeAgentsCount },
        ],
        sections: [
          {
            heading: "Executive Summary",
            body:
              `${totalRuns} agent run${totalRuns === 1 ? "" : "s"} recorded in the last 24 hours. ` +
              `${successCount} completed successfully (${successRate}). ` +
              `${entries.length - successCount} ended in error or timeout.` +
              (activeAgentsCount > 0
                ? ` ${activeAgentsCount} distinct agent${activeAgentsCount === 1 ? "" : "s"} active.`
                : ""),
          },
          {
            heading: "Agent Activity",
            count: agentTableRows.length,
            table: agentTableRows.length > 0
              ? {
                  columns: ["Agent", "Runs", "Success / Fail"],
                  rows: agentTableRows,
                }
              : undefined,
            body: agentTableRows.length === 0 ? "No agent activity recorded." : undefined,
          },
          {
            heading: "Top Completions",
            count: topCompleted.length,
            bullets: topCompleted.length > 0 ? topCompleted : undefined,
            body: topCompleted.length === 0 ? "No completions in this window." : undefined,
          },
          {
            heading: "Flags",
            count: flags.length,
            bullets: flags.length > 0 ? flags : undefined,
            body: flags.length === 0 ? "No errors or timeouts." : undefined,
          },
        ],
        footer: "Generated by main · InfiniBot Agency OS",
        theme: "black-gold",
      },
      t as Theme,
    );

    const summaryText =
      `${totalRuns} runs · ${successRate} success · ` +
      `${activeAgentsCount} agent${activeAgentsCount === 1 ? "" : "s"} active`;

    return {
      title: `Daily Brief — ${new Date(now).toLocaleDateString()}`,
      summaryText,
      html,
    };
  },
};

export default dailyBriefKind;
