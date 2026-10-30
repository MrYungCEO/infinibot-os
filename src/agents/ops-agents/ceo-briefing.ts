/**
 * §19 DAILY CEO BRIEFING AGENT (pure core).
 *
 * Trigger: each business day. Reads tasks, projects, decisions, opportunities,
 * risks, commitments (financial), and client-tagged records, and emits a tight
 * briefing: MAX ~5–10 TODAY items in the five spec buckets, then a short
 * "FYI — NO ACTION REQUIRED" summary.
 *
 * Rule the spec is emphatic about: the agent MUST NOT manufacture urgency.
 * Every item here is gated on a REAL flag (ceoRequired / escalationRequired /
 * blocked / decision-ready) or a REAL date (a due deadline within the window).
 * A genuinely quiet day returns empty TODAY buckets and says so.
 *
 * Authority L1 (Recommend). Observes and recommends; never acts (§24, §32).
 */

import type { OpsInputs, CeoBriefing, BriefingItem } from "./types.js";
import { isUpcoming, hasText, rank } from "./util.js";

/** CEO deadlines look a little further out than the ops window. */
const CEO_DEADLINE_WINDOW_DAYS = 5;

/** Per-bucket soft caps; a global cap of ~10 is enforced after. */
const PER_BUCKET_CAP = 3;
const UPCOMING_CAP = 4;
const MAX_TODAY = 10;

const byRankThenDate = (a: BriefingItem, b: BriefingItem): number => {
  const r = rank(a.priority) - rank(b.priority);
  if (r !== 0) return r;
  return (a.dueDate ?? "￿").localeCompare(b.dueDate ?? "￿");
};

/** Decisions the CEO must actually decide (the CEO queue, §16). */
function decisionsRequired(inputs: OpsInputs): BriefingItem[] {
  return inputs.decisions
    .filter((d) => d.status === "Ready for Decision" || d.status === "CEO Review")
    .map((d) => ({
      kind: "decision" as const,
      id: d.id,
      // §17 decision-ready one-liner, never a vague "what do you want to do?".
      summary: `${d.decisionType || "Decision"} — ${d.title}`,
      why: hasText(d.decisionDeadline)
        ? `Decision needed by ${d.decisionDeadline}${
            hasText(d.recommendation) ? ` · Ops recommends: ${d.recommendation}` : ""
          }`
        : hasText(d.recommendation)
          ? `Ops recommends: ${d.recommendation}`
          : "Awaiting CEO decision",
      priority: String(d.priority ?? ""),
      dueDate: d.decisionDeadline || undefined,
      clientId: d.clientId || undefined,
    }))
    .sort(byRankThenDate);
}

/** Actions only the CEO can perform: ceoRequired items that aren't decisions. */
function ceoActions(inputs: OpsInputs): BriefingItem[] {
  const items: BriefingItem[] = [];
  for (const o of inputs.opportunities) {
    if (o.ceoRequired && hasText(o.nextAction)) {
      items.push({
        kind: "opportunity",
        id: o.id,
        summary: `${o.name}: ${o.nextAction}`,
        why: "Flagged CEO-required on an active opportunity",
        priority: String(o.priority ?? ""),
        dueDate: o.nextActionDate || undefined,
        clientId: o.clientId || undefined,
      });
    }
  }
  for (const c of inputs.commitments) {
    if (c.ceoRequired && hasText(c.nextAction)) {
      items.push({
        kind: "commitment",
        id: c.id,
        summary: `${c.name}: ${c.nextAction}`,
        why: "Flagged CEO-required on a financial commitment",
        priority: String(c.priority ?? ""),
        dueDate: c.nextActionDate || c.dueDate || undefined,
        clientId: c.clientId || undefined,
      });
    }
  }
  for (const r of inputs.risks) {
    if (r.ceoRequired && hasText(r.nextAction)) {
      items.push({
        kind: "risk",
        id: r.id,
        summary: `${r.title}: ${r.nextAction}`,
        why: "Flagged CEO-required on an open risk",
        priority: String(r.priority ?? ""),
        dueDate: r.nextActionDate || undefined,
        clientId: r.clientId || undefined,
      });
    }
  }
  return items.sort(byRankThenDate);
}

/** Critical blockers: blocked work that is genuinely high-priority. */
function criticalBlockers(inputs: OpsInputs): BriefingItem[] {
  const items: BriefingItem[] = [];
  const pushBlocked = (
    kind: BriefingItem["kind"],
    id: string,
    summary: string,
    blocker: string | undefined,
    priority: string,
    clientId?: string,
  ) => {
    if (rank(priority) <= 1) {
      items.push({
        kind,
        id,
        summary,
        why: hasText(blocker) ? `Blocked: ${blocker}` : "Blocked, high priority",
        priority,
        clientId,
      });
    }
  };
  for (const o of inputs.opportunities)
    if (o.blocked)
      pushBlocked("opportunity", o.id, o.name, o.blocker, String(o.priority ?? ""), o.clientId);
  for (const r of inputs.risks)
    if (r.blocked)
      pushBlocked("risk", r.id, r.title, r.blocker, String(r.priority ?? ""), r.clientId);
  for (const c of inputs.commitments)
    if (c.blocked)
      pushBlocked("commitment", c.id, c.name, c.blocker, String(c.priority ?? ""), c.clientId);
  // Kanban tasks that stalled in the autonomous pipeline count as blockers.
  for (const t of inputs.tasks) {
    if (t.autonomousStatus === "blocked") {
      items.push({
        kind: "task",
        id: t.id,
        summary: t.title,
        why: "Autonomous task is blocked and needs unblocking",
        priority: String(t.priorityLevel ?? t.priority ?? ""),
      });
    }
  }
  return items.sort(byRankThenDate);
}

/** Important client matters: escalations, client risks, client money owed. */
function clientMatters(inputs: OpsInputs): BriefingItem[] {
  const items: BriefingItem[] = [];
  const seen = new Set<string>();
  const add = (it: BriefingItem) => {
    const key = `${it.kind}:${it.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push(it);
    }
  };
  for (const r of inputs.risks) {
    const critical = r.riskLevel === "High" || r.riskLevel === "Critical";
    if (r.category === "Client" && (critical || r.escalationRequired)) {
      add({
        kind: "risk",
        id: r.id,
        summary: `Client risk — ${r.title}`,
        why: r.escalationRequired
          ? "Client escalation flagged"
          : `Client risk rated ${r.riskLevel}`,
        priority: String(r.priority ?? ""),
        clientId: r.clientId || undefined,
      });
    }
  }
  for (const c of inputs.commitments) {
    if (c.direction === "Money In" && c.overdue && c.clientId) {
      add({
        kind: "commitment",
        id: c.id,
        summary: `Overdue client payment — ${c.name}`,
        why: `Invoice past due (${c.dueDate || "no date"}), remaining ${c.remainingBalance}`,
        priority: String(c.priority ?? ""),
        dueDate: c.dueDate || undefined,
        clientId: c.clientId,
      });
    }
  }
  for (const o of inputs.opportunities) {
    if (o.clientId && o.escalationRequired) {
      add({
        kind: "opportunity",
        id: o.id,
        summary: `Client opportunity needs attention — ${o.name}`,
        why: "Escalation flagged on a client opportunity",
        priority: String(o.priority ?? ""),
        clientId: o.clientId,
      });
    }
  }
  return items.sort(byRankThenDate);
}

/** Upcoming deadlines: REAL dates within the CEO window. */
function upcomingDeadlines(inputs: OpsInputs): BriefingItem[] {
  const items: BriefingItem[] = [];
  const W = CEO_DEADLINE_WINDOW_DAYS;
  for (const t of inputs.tasks) {
    if (t.status !== "done" && isUpcoming(t.dueDate, inputs.now, W)) {
      items.push({
        kind: "task",
        id: t.id,
        summary: t.title,
        why: `Task due ${t.dueDate}`,
        priority: String(t.priorityLevel ?? t.priority ?? ""),
        dueDate: t.dueDate,
      });
    }
  }
  for (const d of inputs.decisions) {
    if (
      d.status !== "Decided" &&
      d.status !== "Cancelled" &&
      isUpcoming(d.decisionDeadline, inputs.now, W)
    ) {
      items.push({
        kind: "decision",
        id: d.id,
        summary: `${d.decisionType || "Decision"} — ${d.title}`,
        why: `Decision deadline ${d.decisionDeadline}`,
        priority: String(d.priority ?? ""),
        dueDate: d.decisionDeadline,
        clientId: d.clientId || undefined,
      });
    }
  }
  for (const c of inputs.commitments) {
    if (c.status !== "Paid" && c.status !== "Cancelled" && isUpcoming(c.dueDate, inputs.now, W)) {
      items.push({
        kind: "commitment",
        id: c.id,
        summary: `${c.name} (${c.direction})`,
        why: `Payment due ${c.dueDate}`,
        priority: String(c.priority ?? ""),
        dueDate: c.dueDate,
        clientId: c.clientId || undefined,
      });
    }
  }
  for (const p of inputs.projects) {
    if (isActiveProject(p.status) && isUpcoming(p.dueDate, inputs.now, W)) {
      items.push({
        kind: "project",
        id: p.id,
        summary: `${p.name} delivery`,
        why: `Project due ${p.dueDate}`,
        priority: String(p.priority ?? ""),
        dueDate: p.dueDate,
      });
    }
  }
  return items.sort(byRankThenDate);
}

/** Active = not completed/cancelled. Shared with the health + monitor agents. */
export function isActiveProject(status: string | undefined | null): boolean {
  const s = String(status ?? "").toLowerCase();
  return s !== "completed" && s !== "cancelled" && s !== "";
}

/** Trim TODAY to the global cap, taking from the largest bucket's tail first. */
function enforceGlobalCap(buckets: BriefingItem[][], cap: number): void {
  let total = buckets.reduce((n, b) => n + b.length, 0);
  while (total > cap) {
    // Remove one item from whichever bucket is currently longest (its tail is
    // the least-urgent because each bucket is pre-sorted by rank/date).
    let idx = 0;
    for (let i = 1; i < buckets.length; i++) if (buckets[i].length > buckets[idx].length) idx = i;
    if (buckets[idx].length === 0) break;
    buckets[idx].pop();
    total--;
  }
}

/**
 * Build the daily CEO briefing from an inputs snapshot. Pure and deterministic.
 */
export function generateCeoBriefing(inputs: OpsInputs): CeoBriefing {
  const ceo = ceoActions(inputs).slice(0, PER_BUCKET_CAP);
  const decisions = decisionsRequired(inputs).slice(0, PER_BUCKET_CAP);
  const blockers = criticalBlockers(inputs).slice(0, PER_BUCKET_CAP);
  const client = clientMatters(inputs).slice(0, PER_BUCKET_CAP);
  const deadlines = upcomingDeadlines(inputs).slice(0, UPCOMING_CAP);

  // Global cap of ~10 across all five buckets (spec: "5–10 items").
  enforceGlobalCap([ceo, decisions, blockers, client, deadlines], MAX_TODAY);

  const todayCount =
    ceo.length + decisions.length + blockers.length + client.length + deadlines.length;

  return {
    generatedAt: inputs.now,
    authorityLevel: "L1",
    today: {
      ceoActions: ceo,
      decisionsRequired: decisions,
      criticalBlockers: blockers,
      clientMatters: client,
      upcomingDeadlines: deadlines,
    },
    todayCount,
    fyi: buildFyi(inputs),
    quietDay: todayCount === 0,
  };
}

/** Short, honest situational summary — counts only, no invented urgency. */
function buildFyi(inputs: OpsInputs): string[] {
  const activeProjects = inputs.projects.filter((p) => isActiveProject(p.status)).length;
  const openOpps = inputs.opportunities.filter((o) => o.stage !== "Won" && o.stage !== "Lost");
  const pipeline = openOpps.reduce((sum, o) => sum + (Number(o.estimatedValue) || 0), 0);
  const openRisks = inputs.risks.filter(
    (r) => r.status === "Open" || r.status === "Monitoring",
  ).length;
  const moneyExpected = inputs.commitments
    .filter((c) => c.direction === "Money In" && c.status !== "Paid" && c.status !== "Cancelled")
    .reduce((sum, c) => sum + (Number(c.remainingBalance ?? c.amount) || 0), 0);
  const tasksInFlight = inputs.tasks.filter((t) => t.status === "in_progress").length;

  const fyi: string[] = [];
  fyi.push(`Active projects: ${activeProjects}`);
  fyi.push(`Open opportunities: ${openOpps.length}${pipeline ? ` (pipeline ${pipeline})` : ""}`);
  if (moneyExpected) fyi.push(`Money expected (unpaid): ${moneyExpected}`);
  fyi.push(`Open/monitoring risks: ${openRisks}`);
  fyi.push(`Tasks in progress: ${tasksInFlight}`);
  return fyi;
}
