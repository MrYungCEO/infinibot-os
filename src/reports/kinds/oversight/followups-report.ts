/**
 * Report kind: `followups_report` (oversight weekly #7).
 *
 * Tasks tagged "follow-up" / "waiting-on" (or parked in review), aged so the
 * oldest waits surface first.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { getKanbanStore } from "../../../tasks/store.js";
import type { KanbanTask } from "../../../tasks/types.js";
import type { CollectedReport, ReportKindModule, ReportPayload } from "../../types.js";
import { renderOversightCollected } from "../../oversight/markdown.js";
import { daysSince, isFollowUpTask, resolveStateDir } from "../../oversight/collectors.js";

export const FOLLOWUPS_REPORT_KIND = "followups_report" as const;

export const followupsReportKind: ReportKindModule = {
  kind: FOLLOWUPS_REPORT_KIND,
  async collect({ theme, config, stateDir }): Promise<CollectedReport> {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const dir = resolveStateDir(stateDir) || join(homedir(), ".infinibot");
    const gaps: string[] = [];
    let tasks: KanbanTask[] = [];
    try {
      tasks = (await getKanbanStore(dir).getTasks()).filter(isFollowUpTask);
    } catch (err) {
      gaps.push(`kanban.getTasks: ${String((err as Error)?.message ?? err)}`);
    }
    const aged = tasks
      .map((t) => ({ t, age: daysSince(t.updatedAt, now) }))
      .sort((a, b) => b.age - a.age);

    const sections: ReportPayload["sections"] = [
      {
        heading: "Outstanding follow-ups",
        count: aged.length,
        table: {
          columns: ["Task", "Status", "Age (days)", "Assignee"],
          rows: aged.map(({ t, age }) => [
            t.title,
            String(t.status),
            age < 0 ? "—" : String(age),
            t.assignee ?? "—",
          ]),
        },
      },
    ];
    if (gaps.length) sections.push({ heading: "Data gaps", bullets: gaps });

    const topActions = aged
      .slice(0, 3)
      .map(({ t, age }) => `Chase "${t.title}" — waiting ${age < 0 ? "?" : age}d.`);
    if (!topActions.length) topActions.push("No outstanding follow-ups.");

    const payload: ReportPayload = {
      title: `Outstanding Follow-ups — ${new Date(now).toLocaleDateString()}`,
      subtitle: "Tasks tagged follow-up / waiting-on (and review-parked), oldest first.",
      eyebrow: "InfiniBot · Oversight",
      generatedAt: now,
      metrics: [{ label: "Follow-ups", value: aged.length }],
      sections,
      footer: "followups_report",
    };

    return renderOversightCollected({
      slug: "followups-report",
      freq: "weekly",
      payload,
      theme,
      topActions,
      summaryText: `${aged.length} outstanding follow-up(s)`,
      stateDir,
      now,
    });
  },
};

export default followupsReportKind;
