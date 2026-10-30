/**
 * Report kind: `drift_digest` (oversight daily #2).
 *
 * Projects with no commit/activity in N days (default 7), priority-ordered by
 * how long they've been idle and how much open work they carry.
 */

import type { CollectedReport, ReportKindModule, ReportPayload } from "../../types.js";
import { renderOversightCollected } from "../../oversight/markdown.js";
import { collectProjectActivity } from "../../oversight/collectors.js";

export const DRIFT_DIGEST_KIND = "drift_digest" as const;

export const driftDigestKind: ReportKindModule = {
  kind: DRIFT_DIGEST_KIND,
  async collect({ theme, config, stateDir }): Promise<CollectedReport> {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const driftDays = typeof config?.driftDays === "number" ? (config.driftDays as number) : 7;
    const { projects, gaps } = await collectProjectActivity({ now, stateDir });
    const drifting = projects
      .filter((p) => p.openCount > 0 && p.daysSinceActivity >= driftDays)
      // worst-first: idle longest, then most open work
      .sort((a, b) => b.daysSinceActivity - a.daysSinceActivity || b.openCount - a.openCount);

    const sections: ReportPayload["sections"] = [
      {
        heading: `Drifting projects (≥ ${driftDays}d idle)`,
        count: drifting.length,
        table: {
          columns: ["Project", "Days idle", "Open", "Done"],
          rows: drifting.map((d) => [
            d.project.name,
            String(d.daysSinceActivity),
            String(d.openCount),
            String(d.doneCount),
          ]),
        },
      },
    ];
    if (gaps.length) sections.push({ heading: "Data gaps", bullets: gaps });

    const topActions = drifting
      .slice(0, 3)
      .map(
        (d) => `Re-engage "${d.project.name}" — ${d.daysSinceActivity}d idle, ${d.openCount} open.`,
      );
    if (!topActions.length)
      topActions.push("No drifting projects — everything has recent activity.");

    const payload: ReportPayload = {
      title: `Drift Digest — ${new Date(now).toLocaleDateString()}`,
      subtitle: `Projects with no activity in ${driftDays}+ days, worst first.`,
      eyebrow: "InfiniBot · Oversight",
      generatedAt: now,
      metrics: [{ label: "Drifting", value: drifting.length }],
      sections,
      footer: "drift_digest",
    };

    return renderOversightCollected({
      slug: "drift-digest",
      freq: "daily",
      payload,
      theme,
      topActions,
      summaryText: `${drifting.length} project(s) idle ≥ ${driftDays}d`,
      stateDir,
      now,
    });
  },
};

export default driftDigestKind;
