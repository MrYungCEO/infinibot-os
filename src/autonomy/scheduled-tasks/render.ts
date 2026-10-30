/**
 * Report payloads (black-gold, via src/reports) and Telegram texts/buttons for
 * every pipeline stage.
 */

import type { ReportPayload, ReportSection } from "../../reports/types.js";
import { describeCheck } from "../goals/checks.js";
import { actionsFor, STAGE_LABEL } from "./pipeline.js";
import { describeCron, formatInZone } from "./schedule.js";
import { deployCommandFor } from "./types.js";
import type {
  DecisionAction,
  PipelineItem,
  ScheduledTask,
  SuggestedWorkItem,
  TaskRun,
} from "./types.js";

export type Button = { text: string; callback_data: string };

/** Telegram callback_data (≤ 64 bytes): `st:<code>:<id>`. */
export const ACTION_CODES: Record<DecisionAction | "approve_low_risk", string> = {
  approve: "a",
  reject: "r",
  modify: "m",
  snooze: "s",
  start: "b",
  approve_deploy: "da",
  reject_deploy: "dr",
  retry: "rt",
  continue: "ci",
  approve_low_risk: "al",
};

const BUTTON_TEXT: Record<DecisionAction, string> = {
  approve: "✓ Approve",
  reject: "✗ Reject",
  modify: "✎ Modify",
  snooze: "⏰ Snooze 24h",
  start: "▶ Start build",
  approve_deploy: "🚀 Approve deploy",
  reject_deploy: "✗ Reject deploy",
  retry: "↻ Retry",
  continue: "✎ Continue with instruction",
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cut(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function itemButtons(item: PipelineItem, task: ScheduledTask): Button[][] {
  const acts = actionsFor(item.stage, task.approval);
  const btns = acts.map((a) => ({
    text: BUTTON_TEXT[a],
    callback_data: `st:${ACTION_CODES[a]}:${item.id}`,
  }));
  const rows: Button[][] = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return rows;
}

function tag(w: SuggestedWorkItem): string {
  return `${w.priority} · ${w.effort} · ${w.risk} risk`;
}

export function itemText(item: PipelineItem, task: ScheduledTask): string {
  const w = item.item;
  const lines = [
    `<b>${esc(w.title)}</b>`,
    `<i>${esc(tag(w))} · ${esc(w.repo)}</i> — ${esc(STAGE_LABEL[item.stage])}`,
    "",
    esc(cut(w.why, 600)),
  ];
  if (item.stage === "suggested" || item.stage === "snoozed") {
    lines.push(
      "",
      `<b>Dev</b>: ${esc(cut(w.dev.steps.join(" → "), 400))}`,
      `<b>Verify</b>: ${esc(cut(w.checks.map(describeCheck).join(" · "), 300))}`,
      `<b>Deploy</b>: ${esc(cut(w.deploy.steps.join(" → "), 250))}`,
    );
  }
  if (item.instructions.length)
    lines.push("", `<b>Your changes</b>: ${esc(cut(item.instructions.join(" / "), 400))}`);
  if (item.lastError && (item.stage === "build_failed" || item.stage === "deploy_failed"))
    lines.push("", `<b>Reason</b>: ${esc(cut(item.lastError, 600))}`);
  lines.push("", `<code>${item.id}</code> · ${esc(task.name)}`);
  return lines.join("\n");
}

export function readyText(item: PipelineItem, task: ScheduledTask): string {
  const w = item.item;
  return [
    `<b>Ready to deploy: ${esc(w.title)}</b>`,
    `<i>${esc(tag(w))} · ${esc(w.repo)} · branch ${esc(item.branch ?? "?")}</i>`,
    "",
    `<b>Checks passed</b>\n<pre>${esc(cut(item.testEvidence ?? "", 900))}</pre>`,
    `<b>Diff</b>\n<pre>${esc(cut(item.diffSummary ?? "", 900))}</pre>`,
    `<b>Deploy plan</b>: ${esc(cut(w.deploy.steps.join(" → "), 500))}`,
    `<b>Rollback</b>: ${esc(cut(w.deploy.rollback, 300))}`,
    deployCommandFor(task, w)
      ? `<b>Command</b>: <code>${esc(cut(deployCommandFor(task, w), 300))}</code>`
      : "",
    "",
    `<code>${item.id}</code>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function runSummaryText(task: ScheduledTask, run: TaskRun, pdf: boolean): string {
  const r = run.report;
  const items = r?.items.length ?? 0;
  const lowRisk = r?.items.filter((i) => i.risk === "low").length ?? 0;
  const lines = [
    `<b>${esc(task.name)}</b> — work suggestions`,
    r ? esc(cut(r.summary, 1500)) : esc(run.error ?? "No report"),
    "",
    `${items} suggested item(s)${lowRisk ? `, ${lowRisk} low-risk` : ""}. ${pdf ? "Full report attached above." : ""}`,
  ];
  if (run.readOnlyViolations.length)
    lines.push("", `⚠️ <b>Read-only violation</b>: ${esc(run.readOnlyViolations.join("; "))}`);
  return lines.join("\n");
}

export function lowRiskButton(run: TaskRun, count: number): Button[][] {
  return count > 0
    ? [
        [
          {
            text: `✓ Approve all low-risk (${count})`,
            callback_data: `st:${ACTION_CODES.approve_low_risk}:${run.id}`,
          },
        ],
      ]
    : [];
}

// ── PDF payloads ─────────────────────────────────────────────────────────────

function itemSection(w: SuggestedWorkItem, idx: number): ReportSection {
  const body = [
    `${tag(w)} · repo ${w.repo}`,
    "",
    w.why,
    "",
    "DEV PLAN",
    ...w.dev.steps.map((s) => `- ${s}`),
    "",
    "VERIFICATION",
    ...w.checks.map((c) => `- [${c.type}] ${describeCheck(c)}`),
    "",
    "DEPLOY",
    ...w.deploy.steps.map((s) => `- ${s}`),
    `- Rollback: ${w.deploy.rollback}`,
    ...(w.deploy.command ? [`- Command: ${w.deploy.command}`] : []),
    ...(w.approvals.length ? ["", `Approvals: ${w.approvals.join(", ")}`] : []),
  ].join("\n");
  return {
    heading: `${idx + 1}. ${w.title}`,
    body,
    ...(w.files.length ? { code: w.files.join("\n") } : {}),
  };
}

export function suggestionReportPayload(task: ScheduledTask, run: TaskRun): ReportPayload {
  const r = run.report!;
  const sections: ReportSection[] = [{ heading: "Summary", body: r.summary }];
  if (run.readOnlyViolations.length)
    sections.push({
      heading: "Read-only violations",
      bullets: run.readOnlyViolations,
    });
  if (r.repos.length)
    sections.push({
      heading: "Repository health",
      count: r.repos.length,
      table: {
        columns: ["Repo", "Branch", "±", "PRs", "Issues", "CI", "Dirty", "Deploy"],
        rows: r.repos.map((h) => [
          h.repo,
          h.branch,
          `${h.ahead ?? "?"}/${h.behind ?? "?"}`,
          h.openPRs ?? "?",
          h.openIssues ?? "?",
          h.ci ?? "unknown",
          h.uncommittedChanges ?? "?",
          cut(h.deployStatus ?? "unknown", 40),
        ]),
      },
    });
  const details = r.repos
    .filter((h) => h.failingTests?.length || h.staleBranches?.length || h.notes)
    .map((h) =>
      [
        `${h.repo}:`,
        h.failingTests?.length ? `  failing: ${h.failingTests.join(", ")}` : "",
        h.staleBranches?.length ? `  stale: ${h.staleBranches.join(", ")}` : "",
        h.notes ? `  ${h.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  if (details.length) sections.push({ heading: "Repo notes", code: details.join("\n\n") });
  if (r.items.length) {
    sections.push({
      heading: "Suggested work",
      count: r.items.length,
      table: {
        columns: ["#", "Item", "Priority", "Effort", "Risk", "Repo"],
        rows: r.items.map((w, i) => [i + 1, w.title, w.priority, w.effort, w.risk, w.repo]),
      },
    });
    r.items.forEach((w, i) => sections.push(itemSection(w, i)));
  } else {
    sections.push({ heading: "Suggested work", body: "Nothing worth doing today." });
  }
  return {
    title: `${task.name} — Work Suggestions`,
    subtitle: `${describeCron(task.cron, task.timezone)} · ${formatInZone(run.createdAt, task.timezone)}`,
    eyebrow: "InfiniBot · Scheduled Agent Task",
    generatedAt: Date.now(),
    metrics: [
      { label: "Repos", value: r.repos.length },
      { label: "Items", value: r.items.length },
      { label: "Low risk", value: r.items.filter((i) => i.risk === "low").length },
      {
        label: "Assignee",
        value:
          task.assignee.kind === "cli" ? task.assignee.backend : `agent:${task.assignee.agentId}`,
      },
    ],
    sections,
    footer: `Run ${run.id} · approve items in Telegram or Autonomy → Scheduled`,
  };
}

export function finalReportPayload(
  task: ScheduledTask,
  item: PipelineItem,
  events: Array<{
    from: string | null;
    to: string;
    actor: string;
    note: string | null;
    at: number;
  }>,
): ReportPayload {
  const w = item.item;
  return {
    title: `${w.title} — ${STAGE_LABEL[item.stage]}`,
    subtitle: `${task.name} · ${w.repo} · branch ${item.branch ?? "?"}`,
    eyebrow: "InfiniBot · Scheduled Agent Task · Final report",
    generatedAt: Date.now(),
    metrics: [
      { label: "Outcome", value: STAGE_LABEL[item.stage] },
      { label: "Priority", value: w.priority },
      { label: "Risk", value: w.risk },
      { label: "Transitions", value: events.length },
    ],
    sections: [
      { heading: "Why", body: w.why },
      ...(item.instructions.length
        ? [{ heading: "Owner instructions", bullets: item.instructions }]
        : []),
      { heading: "What was built", code: item.diffSummary ?? "(no diff recorded)" },
      { heading: "Verification", code: item.testEvidence ?? "(no check results)" },
      {
        heading: "Deploy",
        body: [...w.deploy.steps.map((s) => `- ${s}`), `- Rollback: ${w.deploy.rollback}`].join(
          "\n",
        ),
        ...(item.deployOutput ? { code: item.deployOutput } : {}),
      },
      {
        heading: "Pipeline log",
        table: {
          columns: ["When", "From", "To", "By", "Note"],
          rows: events.map((e) => [
            formatInZone(e.at, task.timezone),
            e.from ?? "",
            e.to,
            e.actor,
            cut(e.note ?? "", 80),
          ]),
        },
      },
    ],
    footer: `Item ${item.id} · run ${item.runId}`,
  };
}
