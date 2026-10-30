/**
 * Payload builders for common report kinds.
 *
 * Thin, dependency-free helpers that shape raw inputs into a {@link ReportPayload}
 * for {@link renderReport}. They do NOT gather data themselves (the caller passes
 * already-collected rows) — that keeps them pure, testable, and usable from both
 * the gateway and ad-hoc scripts. Add a new builder here whenever a report shape
 * recurs, instead of re-deriving the payload inline at each call site.
 */

import type { ReportPayload, ReportSection } from "./types.js";

/** A single agent/subagent row for the status overview. */
export interface AgentStatusRow {
  id: string;
  label: string;
  status: string;
  backend?: string;
  project?: string;
  /** Short last-progress / detail line. */
  detail?: string;
}

export interface AgentStatusInput {
  /** Window length in hours (used in the subtitle). */
  windowHours: number;
  generatedAt?: number;
  /** One-paragraph executive summary. */
  executiveSummary: string;
  agents: AgentStatusRow[];
  /** Optional "by surface / area" progress lines. */
  bySurface?: Array<{ surface: string; progress: string }>;
  /** Outstanding decisions needing a human. */
  outstandingDecisions?: string[];
  /** Next steps queued. */
  nextSteps?: string[];
  /** Optional headline metrics override (else derived from agents). */
  metrics?: ReportPayload["metrics"];
}

/** Build the standard "N-hour agent status overview" payload. */
export function buildAgentStatusPayload(input: AgentStatusInput): ReportPayload {
  const sections: ReportSection[] = [
    { heading: "Executive Summary", body: input.executiveSummary },
    {
      heading: "Agents",
      count: input.agents.length,
      table: {
        columns: ["Run / ID", "Label", "Status", "Backend", "Project"],
        pillColumns: [2],
        rows: input.agents.map((a) => [
          a.id.slice(0, 28),
          a.label,
          a.status,
          a.backend ?? "—",
          a.project ?? "—",
        ]),
      },
    },
  ];

  if (input.bySurface?.length) {
    sections.push({
      heading: "Progress by Surface",
      table: {
        columns: ["Surface", "Progress"],
        rows: input.bySurface.map((s) => [s.surface, s.progress]),
      },
    });
  }
  if (input.outstandingDecisions?.length) {
    sections.push({
      heading: "Outstanding Decisions",
      count: input.outstandingDecisions.length,
      bullets: input.outstandingDecisions,
    });
  }
  if (input.nextSteps?.length) {
    sections.push({
      heading: "Next Steps Queued",
      count: input.nextSteps.length,
      bullets: input.nextSteps,
    });
  }

  return {
    title: `${input.windowHours}-Hour Agent Status Overview`,
    subtitle: `Everything InfiniBot's agents touched in the last ${input.windowHours} hours.`,
    eyebrow: "InfiniBot · Agent Status",
    generatedAt: input.generatedAt,
    metrics: input.metrics ?? [{ label: "Agents", value: input.agents.length }],
    sections,
    footer: "agent_status",
  };
}

export interface SecurityPlanInput {
  title?: string;
  generatedAt?: number;
  overview: string;
  findings?: Array<{ severity: string; title: string; detail: string }>;
  remediation?: string[];
}

/** Build a security plan / audit report payload. */
export function buildSecurityPlanPayload(input: SecurityPlanInput): ReportPayload {
  const sections: ReportSection[] = [{ heading: "Overview", body: input.overview }];
  if (input.findings?.length) {
    sections.push({
      heading: "Findings",
      count: input.findings.length,
      table: {
        columns: ["Severity", "Finding", "Detail"],
        pillColumns: [0],
        rows: input.findings.map((f) => [f.severity, f.title, f.detail]),
      },
    });
  }
  if (input.remediation?.length) {
    sections.push({
      heading: "Remediation Plan",
      count: input.remediation.length,
      bullets: input.remediation,
    });
  }
  return {
    title: input.title ?? "Security Plan",
    eyebrow: "InfiniBot · Security",
    generatedAt: input.generatedAt,
    sections,
    footer: "security_plan",
  };
}

export interface WeeklyDigestInput {
  generatedAt?: number;
  summary: string;
  highlights: string[];
  metrics?: ReportPayload["metrics"];
  sections?: ReportSection[];
}

/** Build a weekly strategic digest payload. */
export function buildWeeklyDigestPayload(input: WeeklyDigestInput): ReportPayload {
  return {
    title: "Weekly Strategic Digest",
    subtitle: "The week in InfiniBot: what shipped, what's at risk, what's next.",
    eyebrow: "InfiniBot · Weekly",
    generatedAt: input.generatedAt,
    metrics: input.metrics,
    sections: [
      { heading: "Summary", body: input.summary },
      { heading: "Highlights", count: input.highlights.length, bullets: input.highlights },
      ...(input.sections ?? []),
    ],
    footer: "weekly_strategic",
  };
}
