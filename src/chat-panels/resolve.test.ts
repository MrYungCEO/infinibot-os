import { describe, expect, it } from "vitest";

import { parseChecklist } from "./kinds.js";
import {
  PANEL_KINDS,
  PANEL_METHODS,
  buildPanelRef,
  isPanelKind,
  resolvePanel,
  type PanelCaller,
} from "./resolve.js";

/** A caller that records (method, params) and returns a stub (or throws an Error stub). */
function stubCaller(returns: Record<string, unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const call: PanelCaller = async (method, params) => {
    calls.push({ method, params });
    const r = returns[method];
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  return { call, calls };
}

const PROJECTS = [
  { id: "p1", name: "Robovoice", status: "In progress" },
  { id: "p2", name: "Example Launch", status: "Completed" },
];
const TASKS = [
  { id: "t1", projectId: "p1", title: "Ship TTS fix", status: "done", updatedAt: 3 },
  {
    id: "t2",
    projectId: "p1",
    title: "Latency overlay",
    status: "in_progress",
    assignee: "claude",
    updatedAt: 5,
  },
  {
    id: "t3",
    projectId: "p1",
    title: "Billing holds",
    status: "todo",
    autonomousStatus: "blocked",
    description: "Wire holds.\n- [x] schema\n- [ ] settlement\n- [ ] refunds",
    updatedAt: 4,
  },
];
const RUNS = [
  {
    runId: "run-aaa",
    sessionKey: "agent:main:sub:1",
    label: "chat-panels",
    task: "Build chat panels",
    status: "running",
    progress: 40,
    lastActivity: { kind: "tool", label: "Edit kinds.ts", at: 1 },
    recentUpdates: [{ status: "running", message: "wrote resolver", timestamp: 1 }],
  },
  {
    runId: "run-bbb",
    label: "old",
    task: "Old job",
    status: "completed",
    progress: 100,
    endedAt: 9,
  },
];

describe("registry", () => {
  it("declares every requested kind and rejects others", () => {
    for (const k of [
      "mesh",
      "project",
      "task",
      "agent",
      "agents",
      "business",
      "clients",
      "opportunities",
      "table",
    ])
      expect(isPanelKind(k)).toBe(true);
    expect(isPanelKind("nope")).toBe(false);
    expect(isPanelKind(3)).toBe(false);
    expect(PANEL_KINDS.length).toBe(9);
  });

  it("only allows read data sources", () => {
    for (const m of PANEL_METHODS) expect(m).toMatch(/\.(list|detail)$/);
  });

  it("unknown kind → honest error result, never a throw", async () => {
    const { call } = stubCaller({});
    const r = await resolvePanel("nope", {}, call);
    expect(r.error).toContain("unknown panel kind");
    expect(r.empty).toBe(true);
  });

  it("a kind cannot call RPCs outside its own allowlist", async () => {
    // table declares no methods; a (hypothetical) stray call would be rejected
    const r = await resolvePanel("table", { rows: [] }, async () => {
      throw new Error("should not be called");
    });
    expect(r.error).toBeNull();
  });
});

describe("mesh", () => {
  it("summarises running sub-agents + roster", async () => {
    const { call, calls } = stubCaller({
      "subagents.list": { subagents: RUNS },
      "agents.list": { agents: [{ id: "main", identity: { name: "ASH" } }, { id: "cmo" }] },
    });
    const r = await resolvePanel("mesh", {}, call);
    expect(calls.map((c) => c.method).sort()).toEqual(["agents.list", "subagents.list"]);
    expect(r.count).toBe(1);
    expect(r.summary).toContain("1 sub-agent running");
    expect(r.summary).toContain("2 roster agents");
    expect(r.link).toMatchObject({ tab: "mesh", path: "/mesh" });
    expect(r.refreshMs).toBeGreaterThan(0);
  });

  it("survives one source failing", async () => {
    const { call } = stubCaller({
      "subagents.list": new Error("boom"),
      "agents.list": { agents: [{ id: "a" }] },
    });
    const r = await resolvePanel("mesh", {}, call);
    expect(r.error).toBeNull();
    expect(r.summary).toContain("1 roster agent");
  });
});

describe("project", () => {
  it("fuzzy-matches by name and computes progress from real tasks", async () => {
    const { call, calls } = stubCaller({
      "kanban.projects.list": PROJECTS,
      "kanban.tasks.list": TASKS,
    });
    const r = await resolvePanel("project", { name: "robo" }, call);
    expect(calls[1]).toEqual({ method: "kanban.tasks.list", params: { projectId: "p1" } });
    const d = r.data as { progressPct: number; blocked: number; tasks: Array<{ id: string }> };
    expect(r.title).toBe("Robovoice");
    expect(d.progressPct).toBe(33);
    expect(d.blocked).toBe(1);
    expect(d.tasks[0].id).toBe("t2"); // in_progress sorts first
    expect(r.summary).toContain("1/3 tasks done");
    expect(r.link.path).toBe("/projects/p1");
    expect(r.text).toContain("Robovoice");
  });

  it("not found → real error with suggestions", async () => {
    const { call } = stubCaller({ "kanban.projects.list": PROJECTS });
    const r = await resolvePanel("project", { name: "zzz" }, call);
    expect(r.error).toContain('No project matches "zzz"');
    expect(r.error).toContain('"Robovoice"');
  });

  it("missing id/name → error", async () => {
    const r = await resolvePanel("project", {}, stubCaller({}).call);
    expect(r.error).toMatch(/needs an id or name/);
  });
});

describe("task", () => {
  it("finds by id, splits checklist from prose, exposes statuses for the status action", async () => {
    const { call } = stubCaller({ "kanban.tasks.list": TASKS, "kanban.projects.list": PROJECTS });
    const r = await resolvePanel("task", { id: "t3" }, call);
    const d = r.data as {
      checklist: unknown[];
      preview: string;
      projectName: string;
      statuses: string[];
    };
    expect(d.checklist).toHaveLength(3);
    expect(d.preview).toBe("Wire holds.");
    expect(d.projectName).toBe("Robovoice");
    expect(d.statuses).toContain("in_progress");
    expect(r.summary).toContain("checklist 1/3");
    expect(r.link.path).toBe("/tasks/t3");
  });

  it("parseChecklist handles both marks", () => {
    expect(parseChecklist("a\n* [X] b\n- [ ] c").checklist).toEqual([
      { text: "b", done: true },
      { text: "c", done: false },
    ]);
  });
});

describe("agent / agents", () => {
  it("agent by label enriches with files from subagents.detail and links to agent focus", async () => {
    const { call } = stubCaller({
      "subagents.list": { subagents: RUNS },
      "subagents.detail": {
        ok: true,
        run: { runId: "run-aaa", filesTouched: [{ path: "/x/kinds.ts", action: "edited", at: 2 }] },
      },
    });
    const r = await resolvePanel("agent", { label: "chat-panels" }, call);
    const d = r.data as { files: Array<{ path: string }>; updates: unknown[] };
    expect(d.files[0].path).toBe("/x/kinds.ts");
    expect(d.updates).toHaveLength(1);
    expect(r.summary).toContain("now: Edit kinds.ts");
    expect(r.link).toMatchObject({ action: "agent-focus", actionParams: { runId: "run-aaa" } });
  });

  it("agent with no query picks the most recent running run", async () => {
    const { call } = stubCaller({
      "subagents.list": { subagents: RUNS },
      "subagents.detail": { ok: false },
    });
    const r = await resolvePanel("agent", {}, call);
    expect(r.title).toBe("chat-panels");
  });

  it("agents filters by status", async () => {
    const { call } = stubCaller({ "subagents.list": { subagents: RUNS } });
    const r = await resolvePanel("agents", { status: "running" }, call);
    expect(r.count).toBe(1);
    expect(r.summary).toContain("(running)");
  });
});

describe("business", () => {
  it("derives needs-attention + outstanding invoices from the HQ object stores", async () => {
    const { call } = stubCaller({
      "kanban.projects.list": PROJECTS,
      "kanban.tasks.list": TASKS,
      "opportunity.list": {
        opportunities: [
          { id: "o1", name: "Big deal", stage: "Proposal", estimatedValue: 12000 },
          { id: "o2", name: "Done deal", stage: "Won", estimatedValue: 5000 },
        ],
      },
      "decision.list": {
        decisions: [{ id: "d1", title: "Pick vendor", ceoRequired: true, status: "open" }],
      },
      "risk.list": { risks: [{ id: "r1", title: "Churn", priority: "P0", status: "open" }] },
      "commitment.list": {
        commitments: [
          {
            id: "c1",
            name: "Inv 7",
            direction: "Money In",
            status: "Invoiced",
            amount: 900,
            remainingBalance: 900,
          },
        ],
      },
      "clients.list": new Error("clients store offline"),
    });
    const r = await resolvePanel("business", {}, call);
    const d = r.data as {
      metrics: Record<string, number>;
      warnings: string[];
      attention: unknown[];
    };
    expect(d.metrics.activeOpportunities).toBe(1);
    expect(d.metrics.pipelineValue).toBe(12000);
    expect(d.metrics.outstandingValue).toBe(900);
    expect(d.metrics.criticalRisks).toBe(1);
    expect(d.metrics.ceoDecisions).toBe(1);
    expect(d.metrics.blockedTasks).toBe(1);
    expect(d.warnings[0]).toContain("clients store offline");
    expect(r.count).toBe(d.attention.length);
    expect(r.summary).toContain("1 source(s) unavailable");
    expect(r.error).toBeNull();
  });
});

describe("clients / opportunities / table", () => {
  it("clients passes filters through and searches locally", async () => {
    const { call, calls } = stubCaller({
      "clients.list": {
        clients: [
          { id: "c1", name: "Acme", status: "active" },
          { id: "c2", name: "Beta" },
        ],
        stats: { active: 1 },
      },
    });
    const r = await resolvePanel("clients", { status: "active", search: "acm" }, call);
    expect(calls[0].params).toMatchObject({ all: true, status: "active" });
    expect(r.count).toBe(1);
  });

  it("opportunities maps search → query and sorts by value", async () => {
    const { call, calls } = stubCaller({
      "opportunity.list": {
        opportunities: [
          { name: "a", estimatedValue: 1 },
          { name: "b", estimatedValue: 9 },
        ],
      },
    });
    const r = await resolvePanel("opportunities", { search: "x", stage: "Lead" }, call);
    expect(calls[0].params).toEqual({ query: "x", stage: "Lead" });
    expect((r.data as { rows: Array<{ name: string }> }).rows[0].name).toBe("b");
  });

  it("table accepts object rows, derives columns, empty state when no rows", async () => {
    const r = await resolvePanel("table", { rows: [{ a: 1, b: "x" }] }, stubCaller({}).call);
    expect(r.data).toMatchObject({ columns: ["a", "b"], rows: [[1, "x"]] });
    expect(r.text).toContain("| a | b |");
    const e = await resolvePanel("table", {}, stubCaller({}).call);
    expect(e.empty).toBe(true);
  });
});

describe("buildPanelRef", () => {
  it("is data-free and versioned", async () => {
    const r = await resolvePanel("table", { rows: [[1]] }, stubCaller({}).call);
    const ref = buildPanelRef(r, { rows: [[1]] }, { panelId: "p", display: "modal" });
    expect(ref).toMatchObject({ v: 1, panelId: "p", kind: "table", display: "modal" });
    expect(ref).not.toHaveProperty("data");
  });
});
