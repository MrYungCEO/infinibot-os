/**
 * Translate the three ops-agent outputs into `ReportPayload`s for the canonical
 * black-gold report system (src/reports/renderReport). Kept separate from the
 * agent cores so the pure logic has no PDF/render dependency.
 */

import type { ReportPayload, ReportSection } from "../../reports/types.js";
import type { CeoBriefing, ExceptionReport, ProjectHealthReport, BriefingItem } from "./types.js";

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const itemLine = (it: BriefingItem): string => {
  const bits = [it.summary];
  if (it.why) bits.push(`— ${it.why}`);
  if (it.priority) bits.push(`[${it.priority}]`);
  return bits.join(" ");
};

/** §19 → black-gold Daily CEO Briefing PDF. */
export function ceoBriefingReport(b: CeoBriefing): ReportPayload {
  const t = b.today;
  const sections: ReportSection[] = [];

  const addBucket = (heading: string, items: BriefingItem[]) => {
    if (items.length > 0) {
      sections.push({ heading, count: items.length, bullets: items.map(itemLine) });
    }
  };

  if (b.quietDay) {
    sections.push({
      heading: "TODAY",
      body: "No items require CEO action today. (Urgency is not manufactured — an empty list is a real signal.)",
    });
  } else {
    addBucket("TODAY · Actions only the CEO can perform", t.ceoActions);
    addBucket("TODAY · Decisions required", t.decisionsRequired);
    addBucket("TODAY · Critical blockers", t.criticalBlockers);
    addBucket("TODAY · Important client matters", t.clientMatters);
    addBucket("TODAY · Upcoming deadlines", t.upcomingDeadlines);
  }

  sections.push({ heading: "FYI — NO ACTION REQUIRED", bullets: b.fyi });

  return {
    title: `Daily CEO Briefing — ${fmtDate(b.generatedAt)}`,
    subtitle: b.quietDay ? "A quiet day — nothing needs you." : `${b.todayCount} item(s) need your attention today.`,
    eyebrow: "InfiniBot · Executive Command Center",
    generatedAt: b.generatedAt,
    metrics: [
      { label: "TODAY items", value: b.todayCount },
      { label: "Decisions", value: t.decisionsRequired.length },
      { label: "Blockers", value: t.criticalBlockers.length },
      { label: "Client matters", value: t.clientMatters.length },
    ],
    sections,
    footer: "Authority L1 · Observe & Recommend — no autonomous action (§24)",
    theme: "black-gold",
  };
}

/** §20 → black-gold Operations Exception Report PDF. */
export function exceptionReportPdf(r: ExceptionReport): ReportPayload {
  const sections: ReportSection[] = r.clean
    ? [{ heading: "No exceptions", body: "Every monitored record is within policy." }]
    : r.groups.map((g) => ({
        heading: g.label,
        count: g.count,
        table: {
          columns: ["Item", "Detail", "Owner", "Priority"],
          rows: g.items.map((i) => [i.title, i.detail, i.owner ?? "—", i.priority ?? "—"]),
        },
      }));

  return {
    title: `Operations Exception Report — ${fmtDate(r.generatedAt)}`,
    subtitle: r.clean ? "Clean — nothing out of policy." : `${r.totalExceptions} exception(s) across ${r.groups.length} categor(ies).`,
    eyebrow: "InfiniBot · Operations Command Center",
    generatedAt: r.generatedAt,
    metrics: [
      { label: "Exceptions", value: r.totalExceptions },
      { label: "Categories", value: r.groups.length },
    ],
    sections,
    footer: "Authority L1 · Exception report, not a summary of everything (§20)",
    theme: "black-gold",
  };
}

/** §21 → black-gold Project Health PDF (Green/Yellow/Red + why). */
export function projectHealthReport(h: ProjectHealthReport): ReportPayload {
  const sections: ReportSection[] = [
    {
      heading: "Project Health",
      count: h.projects.length,
      table: {
        columns: ["Project", "Status", "Why"],
        rows: h.projects.map((p) => [p.name, p.status, p.reasons.join(" · ")]),
        pillColumns: [1],
      },
    },
  ];

  return {
    title: `Project Health — ${fmtDate(h.generatedAt)}`,
    subtitle: `${h.counts.red} Red · ${h.counts.yellow} Yellow · ${h.counts.green} Green`,
    eyebrow: "InfiniBot · Project Health Agent",
    generatedAt: h.generatedAt,
    metrics: [
      { label: "Red", value: h.counts.red },
      { label: "Yellow", value: h.counts.yellow },
      { label: "Green", value: h.counts.green },
    ],
    sections,
    footer: "Authority L1 · Each status explained (§21)",
    theme: "black-gold",
  };
}
