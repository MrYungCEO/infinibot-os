/**
 * Report kind: `client_snapshot` (oversight weekly #6).
 *
 * Per active client: status, days since last touch, next deliverable. Flags any
 * client stale > 14 days. Reads the canonical databases "clients" system role.
 */

import type { CollectedReport, ReportKindModule, ReportPayload } from "../../types.js";
import { renderOversightCollected } from "../../oversight/markdown.js";
import { collectClients } from "../../oversight/collectors.js";

export const CLIENT_SNAPSHOT_KIND = "client_snapshot" as const;
const STALE_DAYS = 14;

export const clientSnapshotKind: ReportKindModule = {
  kind: CLIENT_SNAPSHOT_KIND,
  collect({ theme, config, stateDir }): CollectedReport {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const staleDays =
      typeof config?.staleDays === "number" ? (config.staleDays as number) : STALE_DAYS;
    const { clients, gaps } = collectClients({ now, stateDir });
    const stale = clients.filter((c) => c.daysSinceTouch >= staleDays);

    const sections: ReportPayload["sections"] = [
      {
        heading: "Clients",
        count: clients.length,
        table: {
          columns: ["Client", "Status", "Days since touch", "Next deliverable"],
          rows: clients.map((c) => [
            c.name,
            c.status,
            c.daysSinceTouch < 0 ? "—" : String(c.daysSinceTouch),
            c.nextDeliverable,
          ]),
        },
      },
    ];
    if (stale.length) {
      sections.push({
        heading: `Stale > ${staleDays} days`,
        count: stale.length,
        bullets: stale.map(
          (c) => `${c.name} — ${c.daysSinceTouch}d since last touch (status: ${c.status})`,
        ),
      });
    }
    if (gaps.length) sections.push({ heading: "Data gaps", bullets: gaps });

    const topActions: string[] = [];
    for (const c of stale.slice(0, 3))
      topActions.push(`Reach out to ${c.name} — ${c.daysSinceTouch}d cold.`);
    if (!topActions.length) topActions.push("All clients touched recently — no follow-up overdue.");

    const payload: ReportPayload = {
      title: `Client Status Snapshot — ${new Date(now).toLocaleDateString()}`,
      subtitle: "Progress, last touch, next deliverable, and who's gone quiet.",
      eyebrow: "InfiniBot · Oversight",
      generatedAt: now,
      metrics: [
        { label: "Clients", value: clients.length },
        { label: `Stale >${staleDays}d`, value: stale.length },
      ],
      sections,
      footer: "client_snapshot",
    };

    return renderOversightCollected({
      slug: "client-snapshot",
      freq: "weekly",
      payload,
      theme,
      topActions,
      summaryText: `${clients.length} client(s) · ${stale.length} stale > ${staleDays}d`,
      stateDir,
      now,
    });
  },
};

export default clientSnapshotKind;
