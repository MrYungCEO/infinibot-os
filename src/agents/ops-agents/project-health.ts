/**
 * §21 PROJECT HEALTH AGENT (pure core).
 *
 * For each ACTIVE project, assign Green / Yellow / Red and — critically — a set
 * of plain-language reasons that explain WHY. The status is the highest
 * severity that any signal triggers (Red > Yellow > Green).
 *
 *   Green  — on schedule, next action assigned, no material blockers,
 *            client obligations current.
 *   Yellow — deadline risk, unresolved dependency, client response delayed,
 *            resource concern, minor scope issue.
 *   Red    — deadline likely to fail, critical blocker, payment issue,
 *            major scope dispute, critical technical risk, client escalation.
 *
 * Reads tasks, commitments, risks, decisions and issues linked to the project
 * by `projectId`. Authority L1 (Recommend) — observes only (§24, §32).
 */

import type { OpsInputs, ProjectHealth, ProjectHealthReport } from "./types.js";
import { isStale } from "../../business-objects/rules.js";
import { isPastDue, isUpcoming, hasText, rank } from "./util.js";
import { isActiveProject } from "./ceo-briefing.js";

/** Progress below this on a project with a near/late deadline is a red flag. */
const LOW_PROGRESS = 50;

function evaluateProject(
  project: OpsInputs["projects"][number],
  inputs: OpsInputs,
): ProjectHealth {
  const { now } = inputs;
  const pid = project.id;

  const tasks = inputs.tasks.filter((t) => t.projectId === pid);
  const openTasks = tasks.filter((t) => t.status !== "done");
  const overdueTasks = openTasks.filter((t) => isPastDue(t.dueDate, now));
  const blockedTasks = openTasks.filter((t) => t.autonomousStatus === "blocked");
  const unassignedTasks = openTasks.filter((t) => !hasText(t.assignee) && !hasText(t.assignedAgent));
  const criticalBlockedTasks = blockedTasks.filter((t) => rank(t.priorityLevel ?? t.priority) <= 1);

  const commitments = inputs.commitments.filter((c) => c.projectId === pid);
  const overdueInvoices = commitments.filter((c) => c.direction === "Money In" && c.overdue);

  const risks = inputs.risks.filter((r) => r.projectId === pid && r.status !== "Closed");
  const criticalTechRisks = risks.filter(
    (r) =>
      r.riskLevel === "Critical" &&
      ["Technical", "Security", "Privacy", "Compliance", "Delivery"].includes(String(r.category)),
  );
  const clientRisks = risks.filter((r) => r.category === "Client");
  const clientEscalations = clientRisks.filter(
    (r) => r.escalationRequired || r.riskLevel === "Critical" || r.riskLevel === "High",
  );

  const decisions = inputs.decisions.filter((d) => d.projectId === pid);
  const overdueDecisions = decisions.filter(
    (d) => d.status !== "Decided" && d.status !== "Cancelled" && isPastDue(d.decisionDeadline, now),
  );

  const issues = inputs.issues.filter((i) => i.projectId === pid);
  const criticalIssues = issues.filter(
    (i) => i.severity === "critical" && i.status !== "fixed" && i.status !== "verified" && i.status !== "wont_fix",
  );

  const deadlinePassed = isPastDue(project.dueDate, now);
  const deadlineNear = isUpcoming(project.dueDate, now, 7);
  const progress = Number(project.progress ?? 0);
  const stale = isStale({ lastUpdated: project.updatedAt }, "project", now);
  // "Next action assigned" ⇒ at least one open task with an owner.
  const hasNextAction = openTasks.some((t) => hasText(t.assignee) || hasText(t.assignedAgent));
  const missingNextAction = openTasks.length > 0 && !hasNextAction;

  const red: string[] = [];
  const yellow: string[] = [];

  // ── RED signals ────────────────────────────────────────────────────────
  if (deadlinePassed) red.push(`Deadline likely to fail: delivery date ${project.dueDate} has passed`);
  else if (deadlineNear && (progress < LOW_PROGRESS || overdueTasks.length >= 2))
    red.push(
      `Deadline likely to fail: due ${project.dueDate} with ${progress}% progress and ${overdueTasks.length} overdue task(s)`,
    );
  if (criticalBlockedTasks.length > 0)
    red.push(`Critical blocker: ${criticalBlockedTasks.length} high-priority task(s) blocked`);
  if (overdueInvoices.length > 0)
    red.push(`Payment issue: ${overdueInvoices.length} overdue client invoice(s)`);
  if (criticalTechRisks.length > 0)
    red.push(`Critical technical risk: ${criticalTechRisks.map((r) => r.title).join("; ")}`);
  if (clientEscalations.length > 0)
    red.push(`Client escalation: ${clientEscalations.length} client risk(s) escalated`);
  if (criticalIssues.length > 0)
    red.push(`Critical issue open: ${criticalIssues.map((i) => i.title).join("; ")}`);

  // ── YELLOW signals (only matter if not already Red) ─────────────────────
  if (deadlineNear) yellow.push(`Deadline risk: delivery due ${project.dueDate}`);
  if (blockedTasks.length > 0)
    yellow.push(`Unresolved dependency: ${blockedTasks.length} blocked task(s)`);
  if (overdueDecisions.length > 0)
    yellow.push(`Dependency: ${overdueDecisions.length} decision(s) past deadline`);
  if (clientRisks.length > 0) yellow.push(`Client matter: ${clientRisks.length} open client risk(s)`);
  if (unassignedTasks.length > 0)
    yellow.push(`Resource concern: ${unassignedTasks.length} unassigned task(s)`);
  if (missingNextAction) yellow.push("Minor scope issue: no next action assigned on open work");
  if (stale) yellow.push("Minor scope issue: project record is stale (§29)");
  if (overdueTasks.length > 0) yellow.push(`${overdueTasks.length} overdue task(s)`);

  let status: ProjectHealth["status"];
  let reasons: string[];
  if (red.length > 0) {
    status = "Red";
    reasons = red;
  } else if (yellow.length > 0) {
    status = "Yellow";
    reasons = yellow;
  } else {
    status = "Green";
    reasons = [
      "On schedule, next action assigned, no material blockers, client obligations current",
    ];
  }

  return {
    projectId: pid,
    name: project.name,
    status,
    reasons,
    signals: {
      openTasks: openTasks.length,
      overdueTasks: overdueTasks.length,
      blockedTasks: blockedTasks.length,
      unassignedTasks: unassignedTasks.length,
      overdueInvoices: overdueInvoices.length,
      criticalRisks: criticalTechRisks.length,
      clientRisks: clientRisks.length,
      stale,
      missingNextAction,
      dueDate: project.dueDate || undefined,
      deadlinePassed,
    },
  };
}

/**
 * Rate every active project. Pure and deterministic. Red projects sort first.
 */
export function generateProjectHealth(inputs: OpsInputs): ProjectHealthReport {
  const projects = inputs.projects
    .filter((p) => isActiveProject(p.status))
    .map((p) => evaluateProject(p, inputs));

  const order: Record<ProjectHealth["status"], number> = { Red: 0, Yellow: 1, Green: 2 };
  projects.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));

  return {
    generatedAt: inputs.now,
    authorityLevel: "L1",
    counts: {
      green: projects.filter((p) => p.status === "Green").length,
      yellow: projects.filter((p) => p.status === "Yellow").length,
      red: projects.filter((p) => p.status === "Red").length,
    },
    projects,
  };
}
