/**
 * Report kind: `velocity_report` (oversight weekly #4).
 *
 * Projects ranked by tasks completed last week, with a week-over-week delta.
 * Lowest-velocity projects with open work are flagged.
 */

import type { CollectedReport, ReportKindModule, ReportPayload } from "../../types.js";
import { renderOversightCollected } from "../../oversight/markdown.js";
import { collectVelocity } from "../../oversight/collectors.js";

export const VELOCITY_REPORT_KIND = "velocity_report" as const;

function deltaStr(d: number): string {
  if (d > 0) return `▲ +${d}`;
  if (d < 0) return `▼ ${d}`;
  return "—";
}

export const velocityReportKind: ReportKindModule = {
  kind: VELOCITY_REPORT_KIND,
  async collect({ theme, config, stateDir }): Promise<CollectedReport> {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const { rows, gaps } = await collectVelocity({ now, stateDir });
    const declining = rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta);

    const sections: ReportPayload["sections"] = [
      {
        heading: "Velocity by project (tasks done)",
        count: rows.length,
        table: {
          columns: ["Project", "This week", "Last week", "WoW"],
          rows: rows.map((r) => [
            r.name,
            String(r.thisWeek),
            String(r.lastWeek),
            deltaStr(r.delta),
          ]),
        },
      },
    ];
    if (declining.length) {
      sections.push({
        heading: "Slowing down",
        count: declining.length,
        bullets: declining
          .slice(0, 10)
          .map((r) => `${r.name}: ${r.lastWeek} → ${r.thisWeek} (${deltaStr(r.delta)})`),
      });
    }
    if (gaps.length) sections.push({ heading: "Data gaps", bullets: gaps });

    const topActions = declining
      .slice(0, 3)
      .map((r) => `Investigate "${r.name}" — velocity dropped ${Math.abs(r.delta)} WoW.`);
    if (!topActions.length) topActions.push("No declining projects — velocity holding or rising.");

    const totalThis = rows.reduce((s, r) => s + r.thisWeek, 0);
    const payload: ReportPayload = {
      title: `Velocity Report — week of ${new Date(now).toLocaleDateString()}`,
      subtitle: "Completed tasks per project, week over week.",
      eyebrow: "InfiniBot · Oversight",
      generatedAt: now,
      metrics: [
        { label: "Done this week", value: totalThis },
        { label: "Projects", value: rows.length },
        { label: "Declining", value: declining.length },
      ],
      sections,
      footer: "velocity_report",
    };

    return renderOversightCollected({
      slug: "velocity-report",
      freq: "weekly",
      payload,
      theme,
      topActions,
      summaryText: `${totalThis} task(s) done this week across ${rows.length} project(s); ${declining.length} declining`,
      stateDir,
      now,
    });
  },
};

export default velocityReportKind;
