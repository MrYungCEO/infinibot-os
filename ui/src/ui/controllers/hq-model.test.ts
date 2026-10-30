import { describe, expect, it } from "vitest";
import type { KanbanProject, KanbanTask } from "../types";
import type { HqCommitment, HqDecision, HqOpportunity, HqRisk } from "./business-hq-objects";
import {
  addDaysKey,
  buildGoalPayload,
  computeProgress,
  dayKey,
  decisionItem,
  delegationCandidates,
  detectParentProject,
  isDelegable,
  metricDeltas,
  nextStage,
  opportunityItem,
  parseSubtasks,
  planAction,
  planBulk,
  rankNextActions,
  resolveObjectProject,
  riskItem,
  taskItem,
  type ProgressEvent,
} from "./hq-model";

const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime(); // Mon 28 Sep 2026, 15:00 local
const DAY = 86_400_000;

function task(p: Partial<KanbanTask> & { id: string }): KanbanTask {
  return { projectId: "p1", title: p.id, status: "todo", createdAt: 0, updatedAt: 0, ...p } as KanbanTask;
}
const decision = (p: Partial<HqDecision> & { id: string }): HqDecision =>
  ({ title: p.id, status: "CEO Review", owner: "", priority: "P2", ...p }) as HqDecision;

const baseRank = {
  decisions: [] as HqDecision[],
  risks: [] as HqRisk[],
  commitments: [] as HqCommitment[],
  opportunities: [] as HqOpportunity[],
  isCriticalRisk: (r: HqRisk) => r.priority === "P0",
  isOverdueCommitment: (c: HqCommitment) => c.overdue,
  now: NOW,
};

describe("rankNextActions", () => {
  it("puts CEO decisions first, then approvals/blocked, then overdue work, and caps at 5", () => {
    const tasks = [
      task({ id: "late-low", dueDate: addDaysKey(NOW, -2) }),
      task({ id: "late-crit", dueDate: addDaysKey(NOW, -1), priority: "critical" }),
      task({ id: "blocked", autonomousStatus: "blocked" }),
      task({ id: "approve", autonomousStatus: "pending_approval" }),
      task({ id: "future", dueDate: addDaysKey(NOW, 3) }),
      task({ id: "done-late", dueDate: addDaysKey(NOW, -5), status: "done" }),
    ];
    const ranked = rankNextActions({ ...baseRank, tasks, decisions: [decision({ id: "d1", priority: "P0" })] });
    // A critical overdue task outranks a normal-priority blocked one.
    expect(ranked.map((r) => r.item.id)).toEqual(["d1", "approve", "late-crit", "blocked", "late-low"]);
    expect(ranked[0].primary.action).toBe("decision.decide");
    expect(ranked[1].primary.action).toBe("task.approve");
    expect(ranked[2].primary.action).toBe("task.done");
    expect(ranked[3].primary.action).toBe("task.unblock");
    expect(ranked.find((r) => r.item.id === "future")).toBeUndefined();
  });

  it("skips snoozed, decided and won/lost items", () => {
    const ranked = rankNextActions({
      ...baseRank,
      tasks: [task({ id: "late", dueDate: addDaysKey(NOW, -1) })],
      decisions: [decision({ id: "d-done", status: "Decided" })],
      opportunities: [{ id: "o-won", name: "Won deal", stage: "Won", stale: true } as HqOpportunity],
      snoozes: { late: NOW + DAY },
    });
    expect(ranked).toEqual([]);
  });

  it("includes overdue commitments, critical risks and cold pipeline with reasons", () => {
    const ranked = rankNextActions({
      ...baseRank,
      tasks: [],
      commitments: [{ id: "c1", name: "Invoice #4", overdue: true, amount: 12000, remainingBalance: 12000, direction: "Incoming" } as HqCommitment],
      risks: [{ id: "r1", title: "Key supplier", priority: "P0", riskScore: 20 } as HqRisk],
      opportunities: [{ id: "o1", name: "Acme", stage: "Proposal", stale: true, estimatedValue: 50000 } as HqOpportunity],
    });
    // Overdue money outranks a critical risk; cold pipeline comes last.
    expect(ranked.map((r) => r.item.kind)).toEqual(["commitment", "risk", "opportunity"]);
    expect(ranked[0].reason).toMatch(/owed to you/);
    expect(ranked[2].reason).toMatch(/cold/);
  });
});

describe("delegation", () => {
  it("never proposes human-judgement work to agents", () => {
    expect(isDelegable(task({ id: "a", title: "Write the onboarding email sequence" }))).toBe(true);
    expect(isDelegable(task({ id: "b", title: "CEO sign-off on pricing" }))).toBe(false);
    expect(isDelegable(task({ id: "c", title: "Approve contractor invoice" }))).toBe(false);
    expect(isDelegable(task({ id: "d", title: "x", autonomousStatus: "pending_approval" }))).toBe(false);
    expect(isDelegable(task({ id: "e", title: "x", autonomousStatus: "in_progress", assignedAgent: "main" }))).toBe(false);
  });
  it("candidates are overdue/blocked/high delegable tasks, highest priority first", () => {
    const c = delegationCandidates(
      [
        task({ id: "normal-late", title: "Research competitors", dueDate: addDaysKey(NOW, -1) }),
        task({ id: "high", title: "Draft landing copy", priority: "high" }),
        task({ id: "calm", title: "Tidy docs" }),
        task({ id: "human", title: "Sign contract", priority: "critical" }),
      ],
      NOW,
    );
    expect(c.map((t) => t.id)).toEqual(["high", "normal-late"]);
  });
});

describe("computeProgress", () => {
  const ev = (daysAgo: number, n: number): ProgressEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `${daysAgo}-${i}`,
      at: NOW - daysAgo * DAY - i * 60_000,
      kind: "task.done" as const,
      objectId: `${daysAgo}-${i}`,
      title: "t",
      source: "kanban",
    }));

  it("counts today vs target and a streak that includes today once hit", () => {
    const p = computeProgress([...ev(0, 3), ...ev(1, 3), ...ev(2, 3), ...ev(4, 5)], 3, NOW);
    expect(p.today).toBe(3);
    expect(p.hitToday).toBe(true);
    expect(p.streak).toBe(3); // today, yesterday, 2 days ago — gap on day 3
    expect(p.pct).toBe(100);
    expect(p.streakAtRisk).toBe(false);
  });

  it("keeps yesterday's streak alive (at risk) until today reaches target", () => {
    const p = computeProgress([...ev(0, 1), ...ev(1, 2), ...ev(2, 2)], 2, NOW);
    expect(p.today).toBe(1);
    expect(p.streak).toBe(2);
    expect(p.streakAtRisk).toBe(true);
    expect(p.pct).toBe(50);
  });

  it("counts this week from Monday and nothing when there are no events", () => {
    // NOW is a Monday, so only today's events are in the week.
    const p = computeProgress([...ev(0, 2), ...ev(1, 4)], 5, NOW);
    expect(p.week).toBe(2);
    expect(computeProgress([], 5, NOW)).toMatchObject({ today: 0, streak: 0, week: 0, pct: 0 });
  });

  it("excludes bulk events from today, streak, week and the today list", () => {
    const bulk = (daysAgo: number, n: number) =>
      ev(daysAgo, n).map((e) => ({ ...e, id: `bulk-${e.id}`, objectId: `bulk-${e.objectId}`, bulk: true }));
    const real = [...ev(0, 2), ...ev(1, 2)];
    const withBulk = computeProgress([...real, ...bulk(0, 900), ...bulk(1, 37)], 2, NOW);
    const without = computeProgress(real, 2, NOW);
    expect(withBulk.today).toBe(2);
    expect(withBulk.week).toBe(2);
    expect(withBulk.streak).toBe(without.streak);
    expect(withBulk.todayEvents).toHaveLength(2);
    expect(withBulk.byKindToday).toEqual({ "task.done": 2 });
    expect(withBulk.bulkWeek).toBe(900); // NOW is Monday: only today's bulk is in this week
    // Bulk-only days don't build a streak.
    expect(computeProgress(bulk(0, 50), 5, NOW)).toMatchObject({ today: 0, streak: 0, week: 0, hitToday: false });
  });
});

describe("metricDeltas", () => {
  it("reports only changed metrics against the day's baseline", () => {
    expect(metricDeltas({ overdue: 5, blocked: 2 }, { overdue: 3, blocked: 2, needsCeo: 1 })).toEqual([
      { key: "overdue", from: 5, to: 3, change: -2 },
    ]);
    expect(metricDeltas(undefined, { overdue: 1 })).toEqual([]);
  });
});

describe("planAction — action → RPC mapping", () => {
  const t = task({ id: "t1", title: "Ship v2", description: "old", projectId: "p9" });

  it("mark done → kanban.tasks.update with an optimistic patch that completes", () => {
    const plan = planAction("task.done", taskItem(t));
    expect(plan.steps).toEqual([{ method: "kanban.tasks.update", params: { id: "t1", patch: { status: "done", done: true } } }]);
    expect(plan.optimistic).toEqual({ kind: "task", id: "t1", patch: { status: "done", done: true } });
    expect(plan.completes).toBe(true);
  });

  it("reschedule +1w, priority, assign, note", () => {
    expect(planAction("task.reschedule", taskItem(t), { days: 7, now: NOW }).optimistic?.patch).toEqual({ dueDate: addDaysKey(NOW, 7) });
    expect(planAction("task.reschedule", taskItem(t), { date: "2026-10-10" }).optimistic?.patch).toEqual({ dueDate: "2026-10-10" });
    expect(planAction("task.priority", taskItem(t), { priority: "high" }).optimistic?.patch).toEqual({ priority: "high" });
    expect(planAction("task.assign", taskItem(t), { person: "Sam" }).optimistic?.patch).toEqual({ assignee: "Sam" });
    const note = planAction("task.note", taskItem(t), { text: "called them", now: NOW }).optimistic?.patch.description as string;
    expect(note.startsWith("old\n\n[2026-09-28 15:00] called them")).toBe(true);
    expect(() => planAction("task.assign", taskItem(t), {})).toThrow(/person/);
  });

  it("snooze → hq.snooze (no optimistic task write)", () => {
    const plan = planAction("task.snooze", taskItem(t), { until: NOW + DAY });
    expect(plan.steps).toEqual([{ method: "hq.snooze", params: { objectId: "t1", until: NOW + DAY } }]);
    expect(plan.optimistic).toBeUndefined();
  });

  it("decide records the decision, rationale and date", () => {
    const plan = planAction("decision.decide", decisionItem(decision({ id: "d1" })), { option: "Go", rationale: "cheaper", now: NOW });
    expect(plan.steps[0]).toEqual({
      method: "decision.update",
      params: { id: "d1", status: "Decided", finalDecision: "Go", rationale: "cheaper", decisionDate: "2026-09-28" },
    });
    expect(plan.completes).toBe(true);
    expect(() => planAction("decision.decide", decisionItem(decision({ id: "d1" })), {})).toThrow();
  });

  it("mitigate a risk creates a task, dates it, then moves the risk to Monitoring", () => {
    const plan = planAction("risk.mitigate", riskItem({ id: "r1", title: "Churn" } as HqRisk), { projectId: "p1", now: NOW });
    expect(plan.steps.map((s) => s.method)).toEqual(["kanban.tasks.create", "kanban.tasks.update", "risk.update"]);
    const dated = plan.steps[1].params as (prev: unknown) => Record<string, unknown>;
    expect(dated({ id: "new-task" })).toEqual({ id: "new-task", patch: { dueDate: addDaysKey(NOW, 3) } });
    expect(() => planAction("risk.mitigate", riskItem({ id: "r1", title: "Churn" } as HqRisk), {})).toThrow(/project/);
  });

  it("pipeline next step / advance stage", () => {
    const o = opportunityItem({ id: "o1", name: "Acme", stage: "Proposal" } as HqOpportunity);
    expect(planAction("opportunity.advance", o).steps[0].params).toEqual({ id: "o1", stage: "Negotiation" });
    expect(planAction("opportunity.next", o, { text: "Send pricing", date: "2026-10-01" }).steps[0].params).toEqual({
      id: "o1",
      nextAction: "Send pricing",
      nextActionDate: "2026-10-01",
    });
    expect(nextStage("Negotiation")).toBe("Won");
  });

  it("rejects actions that don't apply to the item kind", () => {
    expect(() => planAction("decision.decide", taskItem(t), { option: "x" })).toThrow(/not available/);
  });

  it("bulk plans one update per task", () => {
    const plans = planBulk("task.done", [t, task({ id: "t2" })]);
    expect(plans.map((p) => (p.steps[0].params as { id: string }).id)).toEqual(["t1", "t2"]);
  });
});

describe("hand-off + AI helpers", () => {
  it("goal payload tags the task id, targets an agent and uses a verifying check", () => {
    const g = buildGoalPayload(task({ id: "t7", title: "Write FAQ" }), { mode: "goal" }, "Website");
    expect(g.title).toContain("[task:t7]");
    expect(g.target).toEqual({ kind: "agent", agentId: "main" });
    expect(g.checks[0].type).toBe("llm");
    expect(g.goal).toContain("mark kanban task t7 done");
  });

  it("parses subtasks from JSON or a list", () => {
    expect(parseSubtasks('Sure: ["Draft", "Review", "Send"]')).toEqual(["Draft", "Review", "Send"]);
    expect(parseSubtasks("1. Draft copy\n2. Review copy\n- Send it")).toEqual(["Draft copy", "Review copy", "Send it"]);
  });
});

describe("parent project detection (no hardcoded ids)", () => {
  const P = (id: string, name: string, parentProjectId?: string) => ({ id, name, parentProjectId }) as KanbanProject;
  const projects = [
    P("root", "My Company"),
    P("a", "Clients", "root"),
    P("b", "Decisions", "root"),
    P("c", "Risks", "root"),
    P("x", "Clients", "other"),
    P("other", "Side project"),
  ];
  it("picks the parent with the most object boards", () => {
    expect(detectParentProject(projects)).toBe("root");
    expect(detectParentProject([P("a", "Clients", "root")])).toBeNull();
  });
  it("resolves object boards under the parent, or anywhere without one", () => {
    expect(resolveObjectProject(projects, "root", "clients")).toBe("a");
    expect(resolveObjectProject(projects, null, "risks")).toBe("c");
    expect(resolveObjectProject(projects, "root", "products")).toBeNull();
  });
  it("dayKey is local", () => {
    expect(dayKey(NOW)).toBe("2026-09-28");
  });
});
