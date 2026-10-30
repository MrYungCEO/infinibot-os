/**
 * Report kind: `morning_brief` (oversight daily #1).
 *
 * Last-24h operating picture: tasks completed / in-progress / blocked, sub-agent
 * success-vs-fail counts, drift summary, and a "Top 3 actions" footer. Renders
 * the canonical black-gold PDF + a freq markdown copy under reports/daily/.
 */

import type { CollectedReport, ReportKindModule, ReportPayload } from "../../types.js";
import { renderOversightCollected } from "../../oversight/markdown.js";
import {
  collectActivityWindow,
  collectProjectActivity,
  DAY_MS,
} from "../../oversight/collectors.js";

export const MORNING_BRIEF_KIND = "morning_brief" as const;
const MAX_ROWS = 25;

export const morningBriefKind: ReportKindModule = {
  kind: MORNING_BRIEF_KIND,
  async collect({ theme, config, stateDir }): Promise<CollectedReport> {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const windowMs = typeof config?.windowMs === "number" ? (config.windowMs as number) : DAY_MS;
    const a = await collectActivityWindow({ now, windowMs, stateDir });
    const { projects, gaps: pGaps } = await collectProjectActivity({ now, stateDir });
    const drift = projects
      .filter((p) => p.daysSinceActivity >= 7 && p.openCount > 0)
      .sort((x, y) => y.daysSinceActivity - x.daysSinceActivity)
      .slice(0, 10);
    const gaps = [...a.gaps, ...pGaps];

    const sections: ReportPayload["sections"] = [
      {
        heading: "Completed (last 24h)",
        count: a.tasksCompleted.length,
        table: {
          columns: ["Task", "Assignee"],
          rows: a.tasksCompleted.slice(0, MAX_ROWS).map((t) => [t.title, t.assignee ?? "—"]),
        },
      },
      {
        heading: "In progress",
        count: a.tasksInProgress.length,
        table: {
          columns: ["Task", "Assignee"],
          rows: a.tasksInProgress.slice(0, MAX_ROWS).map((t) => [t.title, t.assignee ?? "—"]),
        },
      },
      {
        heading: "Blocked / needs verification",
        count: a.tasksBlocked.length,
        table: {
          columns: ["Task", "Status"],
          rows: a.tasksBlocked.slice(0, MAX_ROWS).map((t) => [t.title, String(t.status)]),
        },
      },
      {
        heading: "Sub-agent runs (24h)",
        body: `${a.agents.completed} completed · ${a.agents.failed} failed · ${a.agents.timedOut} timed out · ${a.agents.inProgress} still running`,
        table: a.agentFailures.length
          ? {
              columns: ["Run", "Status", "Task"],
              pillColumns: [1],
              rows: a.agentFailures
                .slice(0, 10)
                .map((f) => [f.runId.slice(0, 12), f.status, f.task.slice(0, 80)]),
            }
          : undefined,
      },
      {
        heading: "Drift radar",
        count: drift.length,
        table: {
          columns: ["Project", "Days idle", "Open"],
          rows: drift.map((d) => [
            d.project.name,
            String(d.daysSinceActivity),
            String(d.openCount),
          ]),
        },
      },
    ];
    if (gaps.length) {
      sections.push({ heading: "Data gaps", bullets: gaps });
    }

    const topActions: string[] = [];
    if (a.agents.failed + a.agents.timedOut > 0)
      topActions.push(
        `Review ${a.agents.failed + a.agents.timedOut} failed/timed-out sub-agent run(s).`,
      );
    if (a.tasksBlocked.length)
      topActions.push(`Unblock ${a.tasksBlocked.length} task(s) waiting in review/blocked.`);
    if (drift.length)
      topActions.push(
        `Re-engage "${drift[0].project.name}" — idle ${drift[0].daysSinceActivity}d.`,
      );
    if (!topActions.length) topActions.push("No critical actions — keep current focus.");

    const payload: ReportPayload = {
      title: `Morning Brief — ${new Date(now).toLocaleDateString()}`,
      subtitle: "What moved in the last 24 hours, what's stuck, and what to do first.",
      eyebrow: "InfiniBot · Oversight",
      generatedAt: now,
      metrics: [
        { label: "Completed", value: a.tasksCompleted.length },
        { label: "In progress", value: a.tasksInProgress.length },
        { label: "Blocked", value: a.tasksBlocked.length },
        { label: "Agent fails", value: a.agents.failed + a.agents.timedOut },
      ],
      sections,
      footer: "morning_brief",
    };

    const summaryText =
      `${a.tasksCompleted.length} done · ${a.tasksInProgress.length} in progress · ` +
      `${a.tasksBlocked.length} blocked · ${a.agents.failed + a.agents.timedOut} agent issue(s)`;

    return renderOversightCollected({
      slug: "morning-brief",
      freq: "daily",
      payload,
      theme,
      topActions,
      summaryText,
      stateDir,
      now,
    });
  },
};

export default morningBriefKind;
