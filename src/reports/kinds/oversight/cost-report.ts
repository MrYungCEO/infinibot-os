/**
 * Report kind: `cost_report` (oversight weekly #5).
 *
 * Token/cost burn by backend and by project, plus budget posture and per-
 * provider plan-window usage (the data the /credits page also reads). Flags any
 * budget or provider plan window at/over 80%.
 */

import type { CollectedReport, ReportKindModule, ReportPayload } from "../../types.js";
import { renderOversightCollected } from "../../oversight/markdown.js";
import { collectCost } from "../../oversight/collectors.js";

export const COST_REPORT_KIND = "cost_report" as const;

export const costReportKind: ReportKindModule = {
  kind: COST_REPORT_KIND,
  collect({ theme, config, stateDir }): CollectedReport {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const period = (config?.period as "day" | "week" | "month") ?? "week";
    const c = collectCost({ period, stateDir });

    const hotBudgets = c.budgets.filter((b) => b.pctUsed >= 80 || b.state !== "ok");
    const hotPlans = c.plans.filter((p) => p.pctUsed >= 80);

    const sections: ReportPayload["sections"] = [
      {
        heading: "Spend by backend",
        count: c.byBackend.length,
        table: {
          columns: ["Backend", "Cost (USD)", "Requests"],
          rows: c.byBackend.map((b) => [b.backend, `$${b.costUsd.toFixed(4)}`, String(b.requests)]),
        },
      },
      {
        heading: "Spend by project",
        count: c.byProject.length,
        table: {
          columns: ["Project", "Cost (USD)", "Requests"],
          rows: c.byProject
            .slice(0, 25)
            .map((p) => [p.projectId, `$${p.costUsd.toFixed(4)}`, String(p.requests)]),
        },
      },
      {
        heading: "Budget posture",
        count: c.budgets.length,
        table: {
          columns: ["Budget", "% used", "Spend", "Ceiling", "State"],
          pillColumns: [4],
          rows: c.budgets.map((b) => [
            b.name,
            `${b.pctUsed}%`,
            `$${b.currentSpendUsd}`,
            b.monthlyLimitUsd ? `$${b.monthlyLimitUsd}` : "—",
            b.state,
          ]),
        },
      },
      {
        heading: "Provider plan windows",
        count: c.plans.length,
        table: {
          columns: ["Provider", "% of plan", "Used", "Limit", "Status"],
          pillColumns: [4],
          rows: c.plans.map((p) => [
            p.provider,
            `${p.pctUsed}%`,
            p.usedUsd != null ? `$${p.usedUsd.toFixed(2)}` : "—",
            p.limitUsd != null ? `$${p.limitUsd.toFixed(2)}` : "—",
            p.status,
          ]),
        },
      },
    ];
    if (c.gaps.length) sections.push({ heading: "Data gaps", bullets: c.gaps });

    const topActions: string[] = [];
    for (const b of hotBudgets.slice(0, 2))
      topActions.push(`Budget "${b.name}" at ${b.pctUsed}% (${b.state}) — review spend.`);
    for (const p of hotPlans.slice(0, 2))
      topActions.push(`Provider ${p.provider} plan window at ${p.pctUsed}% — throttle or upgrade.`);
    if (!topActions.length) topActions.push("Spend within limits — no action needed.");

    const payload: ReportPayload = {
      title: `Cost & Token Usage — ${period}`,
      subtitle: "Burn by backend and project against budget + provider plan ceilings.",
      eyebrow: "InfiniBot · Oversight",
      generatedAt: now,
      metrics: [
        { label: "Total", value: `$${c.totalCostUsd.toFixed(2)}` },
        { label: "Backends", value: c.byBackend.length },
        { label: "Hot budgets", value: hotBudgets.length },
        { label: "Hot plans", value: hotPlans.length },
      ],
      sections,
      footer: "cost_report",
    };

    return renderOversightCollected({
      slug: "cost-report",
      freq: "weekly",
      payload,
      theme,
      topActions,
      summaryText: `$${c.totalCostUsd.toFixed(2)} ${period} burn · ${hotBudgets.length} budget + ${hotPlans.length} plan window(s) hot`,
      stateDir,
      now,
    });
  },
};

export default costReportKind;
