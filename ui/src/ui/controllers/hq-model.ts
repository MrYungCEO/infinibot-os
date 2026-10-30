/**
 * Business HQ — pure model for the actionable dashboard.
 *
 * Nothing in here touches the DOM or the network, so the ranking, the progress
 * maths and the action → RPC mapping are unit-tested directly
 * (`hq-model.test.ts`). The executor that runs these plans (optimistic patch,
 * rollback, refresh) lives in `hq-actions.ts`.
 */
import type { KanbanProject, KanbanTask } from "../types";
import type {
  HqClient,
  HqCommitment,
  HqDecision,
  HqOpportunity,
  HqRisk,
} from "./business-hq-objects";

// ── Items ────────────────────────────────────────────────────────────────────

export type HqKind = "task" | "decision" | "risk" | "commitment" | "opportunity" | "client" | "project";

export type HqItem =
  | { kind: "task"; id: string; title: string; raw: KanbanTask }
  | { kind: "decision"; id: string; title: string; raw: HqDecision }
  | { kind: "risk"; id: string; title: string; raw: HqRisk }
  | { kind: "commitment"; id: string; title: string; raw: HqCommitment }
  | { kind: "opportunity"; id: string; title: string; raw: HqOpportunity }
  | { kind: "client"; id: string; title: string; raw: HqClient }
  | { kind: "project"; id: string; title: string; raw: KanbanProject };

export const taskItem = (t: KanbanTask): HqItem => ({ kind: "task", id: t.id, title: t.title || "Untitled", raw: t });
export const decisionItem = (d: HqDecision): HqItem => ({ kind: "decision", id: d.id, title: d.title || "Decision", raw: d });
export const riskItem = (r: HqRisk): HqItem => ({ kind: "risk", id: r.id, title: r.title || "Risk", raw: r });
export const commitmentItem = (c: HqCommitment): HqItem => ({ kind: "commitment", id: c.id, title: c.name || "Commitment", raw: c });
export const opportunityItem = (o: HqOpportunity): HqItem => ({ kind: "opportunity", id: o.id, title: o.name || "Opportunity", raw: o });
export const clientItem = (c: HqClient): HqItem => ({ kind: "client", id: c.id, title: c.name || "Client", raw: c });
export const projectItem = (p: KanbanProject): HqItem => ({ kind: "project", id: p.id, title: p.name || "Project", raw: p });

// ── Dates ────────────────────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local calendar key, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Monday 00:00 local of the week containing `ms`. */
export function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  const dow = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export function addDaysKey(now: number, days: number): string {
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() + days);
  return dayKey(d.getTime());
}

function parseDate(s?: string): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

// ── Task predicates (the same semantics the HQ sections use) ─────────────────

export const isTaskDone = (t: KanbanTask) => t.status === "done" || t.done === true;
export function isTaskOverdue(t: KanbanTask, now = Date.now()): boolean {
  const due = parseDate(t.dueDate);
  return due !== null && due < startOfDay(now) && !isTaskDone(t);
}
export const isTaskBlocked = (t: KanbanTask) => t.autonomousStatus === "blocked";
export function taskPrio(t: KanbanTask): number {
  const p = (t.priority || "").toLowerCase();
  if (p === "critical" || p === "immediate" || p === "urgent") return 3; // local store id for critical
  if (p === "high") return 2;
  if (p === "normal" || p === "medium") return 1;
  const pl = (t.priorityLevel || "").toLowerCase();
  if (pl === "immediate") return 3;
  if (pl === "high") return 2;
  if (pl === "medium") return 1;
  return 0;
}
export function daysOverdue(t: KanbanTask, now = Date.now()): number {
  const due = parseDate(t.dueDate);
  if (due === null) return 0;
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(due)) / DAY_MS));
}
const P_RANK: Record<string, number> = { P0: 3, P1: 2, P2: 1, P3: 0 };
const objPrio = (p?: string) => P_RANK[(p || "").toUpperCase()] ?? 0;

// ── Next best actions ────────────────────────────────────────────────────────

export type PrimaryAction =
  | "task.done"
  | "task.unblock"
  | "task.approve"
  | "decision.decide"
  | "risk.mitigate"
  | "commitment.resolve"
  | "opportunity.next";

export interface NextAction {
  item: HqItem;
  score: number;
  reason: string;
  primary: { action: PrimaryAction; label: string };
  delegable: boolean;
}

export interface RankInput {
  tasks: KanbanTask[];
  decisions: HqDecision[];
  risks: HqRisk[];
  commitments: HqCommitment[];
  opportunities: HqOpportunity[];
  snoozes?: Record<string, number>;
  now?: number;
  isCriticalRisk: (r: HqRisk) => boolean;
  isOverdueCommitment: (c: HqCommitment) => boolean;
}

/** Work that needs a human's judgement or signature — never proposed for agents. */
const HUMAN_ONLY = /\bceo\b|sign[- ]?off|\bsign\b|approv|\bdecid|\bdecision\b|contract|\bhire\b|\bfire\b|\bpay(ment)?\b|invoice|legal/i;

export function isDelegable(t: KanbanTask): boolean {
  if (isTaskDone(t)) return false;
  if (t.autonomousStatus === "pending_approval") return false;
  if (t.autonomousStatus === "in_progress" && t.assignedAgent) return false; // already handed off
  return !HUMAN_ONLY.test(`${t.title || ""}`);
}

/**
 * Rank the highest-leverage actions. Scores are additive and deliberately
 * simple so the order is explainable in the UI ("why this is here"):
 * decisions waiting on the CEO outrank everything because nothing downstream
 * can move; then things that are actively costing (overdue money, overdue or
 * blocked work); then pipeline that is going cold.
 */
export function rankNextActions(input: RankInput, limit = 5): NextAction[] {
  const now = input.now ?? Date.now();
  const snoozed = (id: string) => (input.snoozes?.[id] ?? 0) > now;
  const out: NextAction[] = [];

  for (const d of input.decisions) {
    if (snoozed(d.id) || /decided|deferred|cancelled/i.test(d.status || "")) continue;
    const deadline = parseDate(d.decisionDeadline);
    const late = deadline !== null && deadline < startOfDay(now);
    out.push({
      item: decisionItem(d),
      score: 80 + objPrio(d.priority) * 6 + (late ? 15 : 0),
      reason: late ? "Decision past its deadline — work is waiting on it" : "Waiting on your decision",
      primary: { action: "decision.decide", label: "Decide" },
      delegable: false,
    });
  }

  for (const t of input.tasks) {
    if (isTaskDone(t) || snoozed(t.id)) continue;
    const prio = taskPrio(t);
    if (t.autonomousStatus === "pending_approval") {
      out.push({
        item: taskItem(t),
        score: 75 + prio * 5,
        reason: "An agent is waiting for your approval",
        primary: { action: "task.approve", label: "Approve" },
        delegable: false,
      });
    } else if (isTaskBlocked(t)) {
      out.push({
        item: taskItem(t),
        score: 62 + prio * 6,
        reason: "Blocked — nothing moves until it's unblocked",
        primary: { action: "task.unblock", label: "Unblock" },
        delegable: isDelegable(t),
      });
    } else if (isTaskOverdue(t, now)) {
      const late = daysOverdue(t, now);
      out.push({
        item: taskItem(t),
        score: 50 + Math.min(late, 14) * 1.5 + prio * 7,
        reason: `${late} day${late === 1 ? "" : "s"} overdue`,
        primary: { action: "task.done", label: "Mark done" },
        delegable: isDelegable(t),
      });
    }
  }

  for (const c of input.commitments) {
    if (snoozed(c.id) || !input.isOverdueCommitment(c)) continue;
    const amt = Number(c.remainingBalance || c.amount) || 0;
    out.push({
      item: commitmentItem(c),
      score: 58 + Math.min(12, Math.log10(Math.max(1, amt)) * 3),
      reason: /in|receiv/i.test(c.direction || "") ? "Money owed to you is overdue" : "Payment overdue",
      primary: { action: "commitment.resolve", label: "Resolve" },
      delegable: false,
    });
  }

  for (const r of input.risks) {
    if (snoozed(r.id) || !input.isCriticalRisk(r)) continue;
    out.push({
      item: riskItem(r),
      score: 45 + Math.min(25, Number(r.riskScore) || 0),
      reason: "Critical risk with no mitigation underway",
      primary: { action: "risk.mitigate", label: "Mitigate" },
      delegable: false,
    });
  }

  for (const o of input.opportunities) {
    if (snoozed(o.id) || /won|lost/i.test(o.stage || "")) continue;
    const nextDue = parseDate(o.nextActionDate);
    const slipped = nextDue !== null && nextDue < startOfDay(now);
    if (!o.stale && !o.needsAction && !slipped) continue;
    const value = Number(o.estimatedValue) || 0;
    out.push({
      item: opportunityItem(o),
      score: 35 + Math.min(20, Math.log10(Math.max(1, value)) * 4) + objPrio(o.priority) * 4,
      reason: o.stale ? "Deal going cold — no update in 7+ days" : slipped ? "Next step date slipped" : "No next step set",
      primary: { action: "opportunity.next", label: "Set next step" },
      delegable: false,
    });
  }

  return out.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title)).slice(0, limit);
}

/** Delegable open tasks worth proposing to agents (overdue, blocked, or high). */
export function delegationCandidates(tasks: KanbanTask[], now = Date.now(), limit = 8): KanbanTask[] {
  return tasks
    .filter((t) => isDelegable(t) && (isTaskOverdue(t, now) || isTaskBlocked(t) || taskPrio(t) >= 2))
    .sort((a, b) => taskPrio(b) - taskPrio(a) || daysOverdue(b, now) - daysOverdue(a, now))
    .slice(0, limit);
}

// ── Progress ─────────────────────────────────────────────────────────────────

export interface ProgressEvent {
  id: string;
  at: number;
  kind: "task.done" | "decision.decided" | "risk.resolved" | "commitment.settled";
  objectId: string;
  title: string;
  source: string;
  /** "user" | "agent" | "bulk" | "automation" when the caller declared it. */
  origin?: string;
  /** Bulk/scripted completion — kept in the log for audit, never counted. */
  bulk?: boolean;
  bulkReason?: string;
}

/** Events that count toward progress (bulk completions are excluded). */
export function countedProgressEvents(events: ProgressEvent[]): ProgressEvent[] {
  return events.filter((e) => e.bulk !== true);
}

export interface ProgressSummary {
  today: number;
  target: number;
  pct: number;
  hitToday: boolean;
  /** Consecutive days at/over target, ending today (or yesterday when today isn't met yet). */
  streak: number;
  /** True when the streak only survives if today reaches the target. */
  streakAtRisk: boolean;
  week: number;
  todayEvents: ProgressEvent[];
  byKindToday: Record<string, number>;
  /** Bulk completions this week that were excluded from every figure above. */
  bulkWeek: number;
}

/**
 * Progress strip maths. Bulk events (scripts, automations, bursts — see
 * src/hq-progress/store.ts) are excluded from today, streak, week and the
 * today list; `bulkWeek` reports how many were left out.
 */
export function computeProgress(allEvents: ProgressEvent[], target: number, now = Date.now()): ProgressSummary {
  const events = countedProgressEvents(allEvents);
  const perDay = new Map<string, number>();
  for (const e of events) perDay.set(dayKey(e.at), (perDay.get(dayKey(e.at)) ?? 0) + 1);
  const t = Math.max(1, Math.round(target) || 1);
  const todayKey = dayKey(now);
  const today = perDay.get(todayKey) ?? 0;
  const hitToday = today >= t;

  let streak = 0;
  let offset = hitToday ? 0 : 1;
  for (;;) {
    const k = addDaysKey(now, -offset);
    if ((perDay.get(k) ?? 0) >= t) {
      streak++;
      offset++;
    } else break;
    if (offset > 400) break;
  }

  const weekStart = startOfWeek(now);
  const todayStart = startOfDay(now);
  const todayEvents = events.filter((e) => e.at >= todayStart).sort((a, b) => b.at - a.at);
  const byKindToday: Record<string, number> = {};
  for (const e of todayEvents) byKindToday[e.kind] = (byKindToday[e.kind] ?? 0) + 1;

  return {
    today,
    target: t,
    pct: Math.min(100, Math.round((today / t) * 100)),
    hitToday,
    streak,
    streakAtRisk: !hitToday && streak > 0,
    week: events.filter((e) => e.at >= weekStart).length,
    todayEvents,
    byKindToday,
    bulkWeek: allEvents.filter((e) => e.bulk === true && e.at >= weekStart).length,
  };
}

export type HqMetricKey = "overdue" | "blocked" | "needsCeo" | "criticalRisks" | "overdueCommitments" | "openTasks";

export interface MetricDelta {
  key: HqMetricKey;
  from: number;
  to: number;
  /** Negative is good for every tracked metric (they are all "things wrong"). */
  change: number;
}

export function metricDeltas(
  baseline: Partial<Record<string, number>> | undefined,
  current: Partial<Record<HqMetricKey, number>>,
): MetricDelta[] {
  if (!baseline) return [];
  const out: MetricDelta[] = [];
  for (const [k, to] of Object.entries(current) as [HqMetricKey, number][]) {
    const from = baseline[k];
    if (typeof from !== "number" || typeof to !== "number" || from === to) continue;
    out.push({ key: k, from, to, change: to - from });
  }
  return out;
}

// ── Actions → RPC plans ──────────────────────────────────────────────────────

export type ActionId =
  // tasks
  | "task.done"
  | "task.reopen"
  | "task.reschedule"
  | "task.priority"
  | "task.assign"
  | "task.assignAgent"
  | "task.note"
  | "task.unblock"
  | "task.escalate"
  | "task.approve"
  | "task.snooze"
  | "task.subtasks"
  // decisions
  | "decision.decide"
  | "decision.delegate"
  | "decision.defer"
  | "decision.saveRecommendation"
  // risks / commitments
  | "risk.resolve"
  | "risk.renegotiate"
  | "risk.mitigate"
  | "risk.escalate"
  | "commitment.resolve"
  | "commitment.renegotiate"
  | "commitment.mitigate"
  // pipeline / clients
  | "opportunity.next"
  | "opportunity.advance"
  | "opportunity.touch"
  | "opportunity.followup"
  | "client.touch"
  | "client.followup"
  // any
  | "snooze";

export interface ActionArgs {
  date?: string; // YYYY-MM-DD
  days?: number;
  priority?: string;
  person?: string;
  agentId?: string;
  text?: string;
  option?: string;
  rationale?: string;
  until?: number;
  subtasks?: string[];
  projectId?: string;
  /** task.reopen: the status to restore (default todo). */
  status?: string;
  now?: number;
}

export interface RpcStep {
  method: string;
  /** Static params, or derived from the previous step's result (e.g. a new task id). */
  params: Record<string, unknown> | ((prev: unknown) => Record<string, unknown>);
}

export interface ActionPlan {
  steps: RpcStep[];
  /** Optimistic local patch applied before the RPCs run and rolled back on failure. */
  optimistic?: { kind: HqKind; id: string; patch: Record<string, unknown> };
  /** Message shown once all steps succeed. */
  success: string;
  /** True when the plan completes the item (drives the completion animation). */
  completes?: boolean;
}

export const PIPELINE_ORDER = ["New", "Qualification", "Discovery", "Evaluation", "Proposal", "Negotiation", "Won"];

export function nextStage(stage?: string): string {
  const i = PIPELINE_ORDER.findIndex((s) => s.toLowerCase() === (stage || "New").toLowerCase());
  if (i < 0) return "Qualification";
  return PIPELINE_ORDER[Math.min(PIPELINE_ORDER.length - 1, i + 1)];
}

function stamp(now: number): string {
  const d = new Date(now);
  return `${dayKey(now)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Append a dated line to a free-text field (task description, deal notes). */
export function appendNote(existing: string | undefined, text: string, now = Date.now()): string {
  const line = `[${stamp(now)}] ${text.trim()}`;
  return existing && existing.trim() ? `${existing.trimEnd()}\n\n${line}` : line;
}

function resolveDate(args: ActionArgs): string {
  const now = args.now ?? Date.now();
  if (args.date) return args.date;
  return addDaysKey(now, args.days ?? 1);
}

function createTaskSteps(projectId: string, title: string, description: string, due: string | undefined, priority = "high"): RpcStep[] {
  const steps: RpcStep[] = [
    { method: "kanban.tasks.create", params: { projectId, title, description, priority, status: "todo" } },
  ];
  // kanban.tasks.create doesn't take a due date — set it on the new task.
  if (due) {
    steps.push({
      method: "kanban.tasks.update",
      params: (prev) => ({ id: (prev as { id?: string } | null)?.id ?? "", patch: { dueDate: due } }),
    });
  }
  return steps;
}

/**
 * Map a user action on an item to the exact gateway calls it makes. Throws on
 * a missing argument so the modal can't fire a half-specified write.
 */
export function planAction(action: ActionId, item: HqItem, args: ActionArgs = {}): ActionPlan {
  const now = args.now ?? Date.now();
  const need = <T>(v: T | undefined | null | "", what: string): T => {
    if (v === undefined || v === null || v === "") throw new Error(`${what} is required`);
    return v as T;
  };
  const taskUpdate = (patch: Record<string, unknown>, success: string, completes = false): ActionPlan => ({
    steps: [{ method: "kanban.tasks.update", params: { id: item.id, patch } }],
    optimistic: { kind: "task", id: item.id, patch },
    success,
    completes,
  });

  if (action === "snooze" || action === "task.snooze") {
    const until = args.until ?? startOfDay(now) + DAY_MS + 9 * 3600_000; // tomorrow 09:00
    return {
      steps: [{ method: "hq.snooze", params: { objectId: item.id, until } }],
      success: `Snoozed until ${new Date(until).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`,
    };
  }

  switch (item.kind) {
    case "task": {
      const t = item.raw;
      switch (action) {
        case "task.done":
          return taskUpdate({ status: "done", done: true }, "Marked done", true);
        case "task.reopen":
          return taskUpdate({ status: args.status && args.status !== "done" ? args.status : "todo", done: false }, "Reopened");
        case "task.reschedule": {
          const date = resolveDate(args);
          return taskUpdate({ dueDate: date }, `Rescheduled to ${date}`);
        }
        case "task.priority":
          return taskUpdate({ priority: need(args.priority, "priority") }, `Priority set to ${args.priority}`);
        case "task.assign":
          return taskUpdate({ assignee: need(args.person, "person") }, `Assigned to ${args.person}`);
        case "task.assignAgent":
          return taskUpdate({ assignedAgent: need(args.agentId, "agent") }, `Assigned to agent ${args.agentId}`);
        case "task.note":
          return taskUpdate({ description: appendNote(t.description, need(args.text, "note"), now) }, "Note added");
        case "task.unblock": {
          const what = need(args.text, "what's needed");
          return taskUpdate(
            { autonomousStatus: "approved", description: appendNote(t.description, `Unblocked — ${what}`, now) },
            "Unblocked",
          );
        }
        case "task.approve":
          return taskUpdate(
            { autonomousStatus: "approved", description: appendNote(t.description, "Approved from Business HQ", now) },
            "Approved — the agent can proceed",
          );
        case "task.escalate":
          return taskUpdate(
            {
              priority: "critical",
              description: appendNote(t.description, `Escalated${args.text ? ` — ${args.text}` : ""}`, now),
            },
            "Escalated to critical",
          );
        case "task.subtasks": {
          const subs = (args.subtasks ?? []).map((s) => s.trim()).filter(Boolean);
          if (!subs.length) throw new Error("no subtasks to create");
          return {
            steps: subs.map((title) => ({
              method: "kanban.tasks.create",
              params: {
                projectId: t.projectId,
                title,
                description: `Subtask of: ${t.title}`,
                priority: t.priority || "medium",
                status: "todo",
              },
            })),
            success: `Created ${subs.length} subtask${subs.length === 1 ? "" : "s"}`,
          };
        }
      }
      break;
    }
    case "decision": {
      switch (action) {
        case "decision.decide": {
          const option = need(args.option, "decision");
          const patch = {
            status: "Decided",
            finalDecision: option,
            rationale: args.rationale?.trim() || "",
            decisionDate: dayKey(now),
          };
          return {
            steps: [{ method: "decision.update", params: { id: item.id, ...patch } }],
            optimistic: { kind: "decision", id: item.id, patch },
            success: "Decision recorded",
            completes: true,
          };
        }
        case "decision.delegate": {
          const patch = { owner: need(args.person, "owner"), ceoRequired: false, status: "Preparing" };
          return {
            steps: [{ method: "decision.update", params: { id: item.id, ...patch } }],
            optimistic: { kind: "decision", id: item.id, patch },
            success: `Delegated to ${args.person}`,
          };
        }
        case "decision.defer": {
          const patch = { status: "Deferred", decisionDeadline: resolveDate({ days: 7, ...args }) };
          return {
            steps: [{ method: "decision.update", params: { id: item.id, ...patch } }],
            optimistic: { kind: "decision", id: item.id, patch },
            success: `Deferred to ${patch.decisionDeadline}`,
          };
        }
        case "decision.saveRecommendation": {
          const patch = { recommendation: need(args.text, "recommendation") };
          return {
            steps: [{ method: "decision.update", params: { id: item.id, ...patch } }],
            optimistic: { kind: "decision", id: item.id, patch },
            success: "Recommendation saved to the decision",
          };
        }
      }
      break;
    }
    case "risk": {
      const r = item.raw;
      switch (action) {
        case "risk.resolve": {
          const patch = { status: "Mitigated" };
          return { steps: [{ method: "risk.update", params: { id: item.id, ...patch } }], optimistic: { kind: "risk", id: item.id, patch }, success: "Risk marked mitigated", completes: true };
        }
        case "risk.renegotiate": {
          const patch = { nextActionDate: resolveDate({ days: 7, ...args }) };
          return { steps: [{ method: "risk.update", params: { id: item.id, ...patch } }], optimistic: { kind: "risk", id: item.id, patch }, success: `Review moved to ${patch.nextActionDate}` };
        }
        case "risk.escalate": {
          const patch = { priority: "P0", escalationRequired: true };
          return { steps: [{ method: "risk.update", params: { id: item.id, ...patch } }], optimistic: { kind: "risk", id: item.id, patch }, success: "Risk escalated to P0" };
        }
        case "risk.mitigate": {
          const title = args.text?.trim() || `Mitigate risk: ${r.title}`;
          const pid = need(args.projectId, "project");
          const due = resolveDate({ days: 3, ...args });
          return {
            steps: [
              ...createTaskSteps(pid, title, `Mitigation for risk "${r.title}" (${r.category || "risk"}, score ${r.riskScore || "?"}).`, due),
              { method: "risk.update", params: { id: item.id, status: "Monitoring", nextAction: title, nextActionDate: due } },
            ],
            optimistic: { kind: "risk", id: item.id, patch: { status: "Monitoring", nextAction: title } },
            success: "Mitigation task created",
          };
        }
      }
      break;
    }
    case "commitment": {
      const c = item.raw;
      switch (action) {
        case "commitment.resolve": {
          const patch = { status: "Paid", amountPaid: Number(c.amount) || 0 };
          return { steps: [{ method: "commitment.update", params: { id: item.id, ...patch } }], optimistic: { kind: "commitment", id: item.id, patch: { ...patch, overdue: false, remainingBalance: 0 } }, success: "Commitment settled", completes: true };
        }
        case "commitment.renegotiate": {
          const patch = { dueDate: resolveDate({ days: 14, ...args }) };
          return { steps: [{ method: "commitment.update", params: { id: item.id, ...patch } }], optimistic: { kind: "commitment", id: item.id, patch: { ...patch, overdue: false } }, success: `Due date moved to ${patch.dueDate}` };
        }
        case "commitment.mitigate": {
          const title = args.text?.trim() || `Chase / renegotiate: ${c.name}`;
          const pid = need(args.projectId, "project");
          return {
            steps: createTaskSteps(pid, title, `Follow-up on commitment "${c.name}" (${c.direction || ""}, remaining ${c.remainingBalance ?? c.amount}).`, resolveDate({ days: 2, ...args })),
            success: "Follow-up task created",
          };
        }
      }
      break;
    }
    case "opportunity": {
      const o = item.raw;
      switch (action) {
        case "opportunity.next": {
          const patch = { nextAction: need(args.text, "next step"), nextActionDate: resolveDate({ days: 2, ...args }) };
          return { steps: [{ method: "opportunity.update", params: { id: item.id, ...patch } }], optimistic: { kind: "opportunity", id: item.id, patch: { ...patch, needsAction: false, stale: false } }, success: "Next step set" };
        }
        case "opportunity.advance": {
          const patch = { stage: nextStage(o.stage) };
          return { steps: [{ method: "opportunity.update", params: { id: item.id, ...patch } }], optimistic: { kind: "opportunity", id: item.id, patch: { ...patch, stale: false } }, success: `Moved to ${patch.stage}`, completes: patch.stage === "Won" };
        }
        case "opportunity.touch": {
          const notes = appendNote((o as HqOpportunity & { notes?: string }).notes, `Touch: ${need(args.text, "what happened")}`, now);
          return { steps: [{ method: "opportunity.update", params: { id: item.id, notes } }], optimistic: { kind: "opportunity", id: item.id, patch: { notes, stale: false } }, success: "Touch logged" };
        }
        case "opportunity.followup": {
          const pid = need(args.projectId, "project");
          return { steps: createTaskSteps(pid, args.text?.trim() || `Follow up: ${o.name}`, `Pipeline follow-up for "${o.name}" (${o.stage || "New"}).`, resolveDate({ days: 2, ...args })), success: "Follow-up task created" };
        }
      }
      break;
    }
    case "client": {
      const c = item.raw;
      switch (action) {
        case "client.touch":
          return { steps: [{ method: "clients.activity.log", params: { clientId: item.id, type: "touch", note: need(args.text, "what happened") } }], success: "Touch logged on the client" };
        case "client.followup": {
          const pid = need(args.projectId, "project");
          return { steps: createTaskSteps(pid, args.text?.trim() || `Follow up with ${c.name}`, `Client follow-up for ${c.name}.`, resolveDate({ days: 2, ...args })), success: "Follow-up task created" };
        }
      }
      break;
    }
  }
  throw new Error(`Action ${action} is not available for a ${item.kind}`);
}

/** Bulk: one plan per selected task (done / reschedule / assign only). */
export function planBulk(action: "task.done" | "task.reschedule" | "task.assign", tasks: KanbanTask[], args: ActionArgs = {}): ActionPlan[] {
  return tasks.map((t) => planAction(action, taskItem(t), args));
}

// ── Hand to an agent ─────────────────────────────────────────────────────────

export const GOAL_TAG = (taskId: string) => `[task:${taskId}]`;

export interface HandoffOptions {
  mode: "goal" | "coder";
  agentId?: string; // goal: gateway agent (default main)
  context?: string;
}

/**
 * goals.create payload for a kanban task. The completion check is an LLM
 * judge against the task's own definition of done — a plan, a question back
 * or "I'll do it later" does not pass, so the run only reports success with
 * evidence. The task id is tagged into the title so the focus modal can list
 * the runs linked to the task.
 */
export function buildGoalPayload(t: KanbanTask, opts: HandoffOptions, projectName?: string) {
  const desc = (t.description || "").trim();
  const goal = [
    `Complete this task from the business board${projectName ? ` (project: ${projectName})` : ""}:`,
    `"${t.title}"`,
    desc ? `\nDetails:\n${desc.slice(0, 2000)}` : "",
    t.dueDate ? `\nDue: ${t.dueDate}` : "",
    opts.context ? `\nOwner's note: ${opts.context}` : "",
    `\nWhen finished, mark kanban task ${t.id} done and report concrete evidence (links, files, messages sent).`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    title: `HQ · ${t.title.slice(0, 80)} ${GOAL_TAG(t.id)}`,
    goal,
    checks: [
      {
        type: "llm" as const,
        label: "Task actually done, with evidence",
        criterion: `The agent completed the task "${t.title}" and its final output shows concrete evidence of the result (a link, file, sent message or recorded change). A plan, a question back to the owner, or a promise to do it later does NOT pass.`,
      },
    ],
    target: { kind: "agent" as const, agentId: opts.agentId || "main" },
    notify: true,
    limits: { maxIterations: 3, maxWallClockSec: 3600, iterationTimeoutSec: 1200, checkIntervalSec: 120, hangSec: 600 },
  };
}

export function buildCoderSpawn(t: KanbanTask, opts: HandoffOptions, projectName?: string) {
  const payload = buildGoalPayload(t, opts, projectName);
  return { task: payload.goal, agentId: opts.agentId || "coder", label: t.title.slice(0, 60) };
}

// ── AI prompts ───────────────────────────────────────────────────────────────

export function decisionAdvicePrompt(d: HqDecision): string {
  const lines = [
    "You are advising a business owner on a pending decision. Give a clear recommendation.",
    `Decision: ${d.title}`,
    d.decisionRequired ? `Question: ${d.decisionRequired}` : "",
    d.options ? `Options:\n${d.options}` : "",
    d.whyNow ? `Why now: ${d.whyNow}` : "",
    d.impactIfDelayed ? `Impact if delayed: ${d.impactIfDelayed}` : "",
    d.recommendation ? `Current recommendation from the team: ${d.recommendation}` : "",
    d.decisionDeadline ? `Deadline: ${d.decisionDeadline}` : "",
    "",
    "Reply in under 120 words: first line 'Recommend: <option>', then 2-4 bullet reasons and one key risk. No preamble.",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function subtaskPrompt(t: KanbanTask): string {
  return [
    "Break this task into 3-6 concrete, independently completable subtasks.",
    `Task: ${t.title}`,
    t.description ? `Details: ${t.description.slice(0, 1500)}` : "",
    "Reply with ONLY a JSON array of short imperative subtask titles, e.g. [\"Draft the email\", \"Send it\"]. No prose.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function followupDraftPrompt(name: string, context: string): string {
  return [
    `Draft a short, warm follow-up message to ${name}.`,
    context ? `Context: ${context}` : "",
    "Under 90 words, plain text, no subject line, end with one clear next step.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Parse an AI subtask reply: a JSON array, or a bullet/numbered list as a fallback. */
export function parseSubtasks(reply: string): string[] {
  const m = reply.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        return arr.map((s) => String(typeof s === "object" && s ? (s as { title?: string }).title ?? "" : s).trim()).filter(Boolean).slice(0, 10);
      }
    } catch {
      /* fall through */
    }
  }
  return reply
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 2 && l.length < 160)
    .slice(0, 10);
}

// ── Parent project (no owner-specific ids) ───────────────────────────────────

export const OBJECT_NAME_MATCH: Record<string, RegExp> = {
  clients: /^clients?$/i,
  opportunities: /^opportunit/i,
  products: /^products?$/i,
  risks: /^risks?$/i,
  decisions: /^decisions?$/i,
  commitments: /financial commitment|^commitment/i,
  ceoQueue: /^ceo queue$/i,
  ceoDashboard: /^ceo dashboard$/i,
};

/**
 * Auto-detect the project that parents the business object boards: the
 * parent with the most children whose names match the object vocabulary
 * (needs at least 2 to count). Returns null when no such parent exists.
 */
export function detectParentProject(projects: KanbanProject[]): string | null {
  const score = new Map<string, number>();
  const rxs = Object.values(OBJECT_NAME_MATCH);
  for (const p of projects) {
    if (!p.parentProjectId) continue;
    if (rxs.some((rx) => rx.test((p.name || "").trim()))) {
      score.set(p.parentProjectId, (score.get(p.parentProjectId) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestN = 1;
  for (const [id, n] of score) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

/** Resolve an object board by name under the parent (or anywhere when there is no parent). */
export function resolveObjectProject(projects: KanbanProject[], parentId: string | null, key: string): string | null {
  const rx = OBJECT_NAME_MATCH[key];
  if (!rx) return null;
  const hit = projects.find(
    (p) => (parentId ? p.parentProjectId === parentId : true) && rx.test((p.name || "").trim()),
  );
  return hit?.id ?? null;
}
