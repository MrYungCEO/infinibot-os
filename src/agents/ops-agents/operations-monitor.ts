/**
 * §20 OPERATIONS MONITOR AGENT (pure core).
 *
 * "This agent works for you." It scans the full object set and emits an
 * EXCEPTION REPORT — only what is out of policy — never a summary of everything.
 * A clean org produces an empty report.
 *
 * It reuses the foundation rules (src/business-objects/rules.ts) so "stale",
 * "needs next action", and "single owner" mean exactly what they mean
 * everywhere else. Authority L1 (Recommend) — observes only (§24, §32).
 */

import type { OpsInputs, Exception, ExceptionGroup, ExceptionReport } from "./types.js";
import { isStale, needsNextAction } from "../../business-objects/rules.js";
import type { NextActionRecord } from "../../business-objects/rules.js";
import { isPastDue, isUpcoming, hasText } from "./util.js";
import { isActiveProject } from "./ceo-briefing.js";

const GROUP_LABELS: Record<Exception["kind"], string> = {
  overdue_task: "Overdue tasks",
  missing_owner: "Missing owners",
  missing_deadline: "Missing deadlines",
  stale_project: "Stale projects",
  missing_next_action: "Missing next actions",
  blocked_work: "Blocked work",
  upcoming_milestone: "Upcoming milestones",
  overdue_invoice: "Overdue invoices",
  risk_needs_review: "Risks needing review",
  opportunity_no_followup: "Opportunities without follow-up",
  decision_deadline_approaching: "CEO decisions approaching deadline",
};

/** Whether a KIS object is in an active (worth-monitoring) state. */
function activeStatus(status: string | undefined): boolean {
  const s = String(status ?? "").toLowerCase();
  return !["closed", "mitigated", "paid", "cancelled", "decided", "deferred", "lost", "won"].includes(s);
}

/**
 * Build the exception report from an inputs snapshot. Pure and deterministic.
 */
export function generateExceptionReport(inputs: OpsInputs): ExceptionReport {
  const { now } = inputs;
  const ex: Exception[] = [];
  const push = (e: Exception) => ex.push(e);

  // 1. Overdue tasks -------------------------------------------------------
  for (const t of inputs.tasks) {
    if (t.status !== "done" && isPastDue(t.dueDate, now)) {
      push({
        kind: "overdue_task",
        objectType: "task",
        id: t.id,
        title: t.title,
        detail: `Due ${t.dueDate}, status "${t.status}"`,
        owner: t.assignee || t.assignedAgent || undefined,
        priority: String(t.priorityLevel ?? t.priority ?? ""),
        dueDate: t.dueDate,
      });
    }
  }

  // 2. Missing owners ------------------------------------------------------
  for (const t of inputs.tasks) {
    if (t.status !== "done" && !hasText(t.assignee) && !hasText(t.assignedAgent)) {
      push({
        kind: "missing_owner",
        objectType: "task",
        id: t.id,
        title: t.title,
        detail: "Active task has no owner — a task without an owner is a wish (§27)",
      });
    }
  }
  type OwnableRec = { id: string; owner?: string; status?: string; name?: string; title?: string };
  const forOwnable = (type: Exception["objectType"], recs: OwnableRec[]) => {
    for (const rec of recs) {
      if (activeStatus(rec.status) && !hasText(rec.owner)) {
        push({
          kind: "missing_owner",
          objectType: type,
          id: rec.id,
          title: rec.name || rec.title || rec.id,
          detail: `Active ${type} has no accountable owner (§27)`,
        });
      }
    }
  };
  forOwnable("opportunity", inputs.opportunities);
  forOwnable("risk", inputs.risks);
  forOwnable("decision", inputs.decisions);
  forOwnable("commitment", inputs.commitments);

  // 3. Missing deadlines ---------------------------------------------------
  for (const t of inputs.tasks) {
    if (t.status === "in_progress" && !hasText(t.dueDate)) {
      push({
        kind: "missing_deadline",
        objectType: "task",
        id: t.id,
        title: t.title,
        detail: "In-progress task has no due date",
        owner: t.assignee || t.assignedAgent || undefined,
      });
    }
  }
  for (const p of inputs.projects) {
    if (isActiveProject(p.status) && !hasText(p.dueDate)) {
      push({
        kind: "missing_deadline",
        objectType: "project",
        id: p.id,
        title: p.name,
        detail: "Active project has no delivery date",
      });
    }
  }

  // 4. Stale projects (§29) ------------------------------------------------
  for (const p of inputs.projects) {
    if (isActiveProject(p.status) && isStale({ lastUpdated: p.updatedAt }, "project", now)) {
      push({
        kind: "stale_project",
        objectType: "project",
        id: p.id,
        title: p.name,
        detail: "Not updated within the project staleness window (§29)",
      });
    }
  }

  // 5. Missing next actions (§28) -----------------------------------------
  type NextActionRec = NextActionRecord & { id: string; status?: string; name?: string; title?: string };
  const forNextAction = (type: Exception["objectType"], recs: NextActionRec[]) => {
    for (const rec of recs) {
      if (activeStatus(rec.status) && needsNextAction(rec)) {
        push({
          kind: "missing_next_action",
          objectType: type,
          id: rec.id,
          title: rec.name || rec.title || rec.id,
          detail: "No Next Action + Owner + Date (or Waiting For + Review Date) (§28)",
        });
      }
    }
  };
  forNextAction("opportunity", inputs.opportunities);
  forNextAction("risk", inputs.risks);
  forNextAction("decision", inputs.decisions);

  // 6. Blocked work --------------------------------------------------------
  type BlockRec = { id: string; blocked?: boolean; blocker?: string; name?: string; title?: string };
  const forBlocked = (type: Exception["objectType"], recs: BlockRec[]) => {
    for (const rec of recs) {
      if (rec.blocked) {
        push({
          kind: "blocked_work",
          objectType: type,
          id: rec.id,
          title: rec.name || rec.title || rec.id,
          detail: hasText(rec.blocker) ? `Blocked: ${rec.blocker}` : "Blocked",
        });
      }
    }
  };
  forBlocked("opportunity", inputs.opportunities);
  forBlocked("risk", inputs.risks);
  forBlocked("commitment", inputs.commitments);
  for (const t of inputs.tasks) {
    if (t.autonomousStatus === "blocked") {
      push({
        kind: "blocked_work",
        objectType: "task",
        id: t.id,
        title: t.title,
        detail: "Autonomous task is blocked",
        owner: t.assignee || t.assignedAgent || undefined,
      });
    }
  }

  // 7. Upcoming milestones -------------------------------------------------
  for (const p of inputs.projects) {
    if (isActiveProject(p.status) && isUpcoming(p.dueDate, now)) {
      push({
        kind: "upcoming_milestone",
        objectType: "project",
        id: p.id,
        title: p.name,
        detail: `Delivery due ${p.dueDate}`,
        dueDate: p.dueDate,
      });
    }
  }

  // 8. Overdue invoices ----------------------------------------------------
  for (const c of inputs.commitments) {
    if (c.direction === "Money In" && c.overdue) {
      push({
        kind: "overdue_invoice",
        objectType: "commitment",
        id: c.id,
        title: c.name,
        detail: `Overdue since ${c.dueDate || "unknown"} · remaining ${c.remainingBalance ?? c.amount}`,
        owner: c.owner || undefined,
        dueDate: c.dueDate,
      });
    }
  }

  // 9. Risks needing review ------------------------------------------------
  for (const r of inputs.risks) {
    if (r.status === "Closed") continue;
    const reviewOverdue = isPastDue(r.nextReviewDate, now);
    const critical = r.riskLevel === "Critical" || r.riskLevel === "High";
    const staleForCadence = isStale(
      { lastUpdated: r.lastUpdated },
      critical ? "criticalRisk" : "normalRisk",
      now,
    );
    if (reviewOverdue || staleForCadence) {
      push({
        kind: "risk_needs_review",
        objectType: "risk",
        id: r.id,
        title: r.title,
        detail: reviewOverdue
          ? `Review date ${r.nextReviewDate} has passed`
          : `No update within the ${critical ? "critical" : "normal"}-risk review cadence (§29)`,
        owner: r.owner || undefined,
        priority: String(r.priority ?? ""),
      });
    }
  }

  // 10. Opportunities without follow-up (§28) -----------------------------
  for (const o of inputs.opportunities) {
    if (activeStatus(o.stage) && needsNextAction(o)) {
      push({
        kind: "opportunity_no_followup",
        objectType: "opportunity",
        id: o.id,
        title: o.name,
        detail: "Open opportunity has no next action or review date (§28)",
        owner: o.owner || undefined,
      });
    }
  }

  // 11. CEO decisions approaching deadline --------------------------------
  for (const d of inputs.decisions) {
    if (d.status === "Decided" || d.status === "Cancelled") continue;
    if (isUpcoming(d.decisionDeadline, now) || isPastDue(d.decisionDeadline, now)) {
      push({
        kind: "decision_deadline_approaching",
        objectType: "decision",
        id: d.id,
        title: d.title,
        detail: isPastDue(d.decisionDeadline, now)
          ? `Decision deadline ${d.decisionDeadline} has passed`
          : `Decision due ${d.decisionDeadline}`,
        owner: d.owner || undefined,
        priority: String(d.priority ?? ""),
        dueDate: d.decisionDeadline,
      });
    }
  }

  // Group by kind, preserving spec order; omit empty groups.
  const groups: ExceptionGroup[] = [];
  for (const kind of Object.keys(GROUP_LABELS) as Exception["kind"][]) {
    const items = ex.filter((e) => e.kind === kind);
    if (items.length > 0) {
      groups.push({ kind, label: GROUP_LABELS[kind], count: items.length, items });
    }
  }

  return {
    generatedAt: now,
    authorityLevel: "L1",
    totalExceptions: ex.length,
    groups,
    clean: ex.length === 0,
  };
}
