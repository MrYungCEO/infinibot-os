import { describe, expect, it } from "vitest";
import {
  buildUndo,
  captureOf,
  clusterSubProjects,
  describePlan,
  planConvertToTasks,
  planMergeDuplicates,
  resolveRefs,
  subProjectsOf,
  subTitleTokens,
  taskStatusFor,
  titleSimilarity,
  UNRESOLVED,
  type SubDetail,
} from "./knowledge-graph-consolidate";
import type { OpEdge, OpNode } from "./knowledge-graph-ops";

const proj = (id: string, label: string, meta: Record<string, unknown> = {}): OpNode => ({
  id: `project:${id}`,
  kind: "project",
  label,
  meta: { projectId: id, ...meta },
});

// Fixture modelled on the live InfinibotOS project: many "relates to" sub-projects,
// several of them near-identical.
const PARENT = proj("os", "InfinibotOS", { parentProjectId: "trader" });
const SUBS: OpNode[] = [
  proj("c1", "InfiniBot Cloud SaaS", { tasks: 22 }),
  proj("c2", "InfiniBot Cloud SaaS", { tasks: 2 }),
  proj("c3", "Moltbot Cloud SaaS", { tasks: 1 }),
  proj("w1", "InfiniBot Web UI", { tasks: 1 }),
  proj("w2", "InfiniBot WebUI", { tasks: 1 }),
  proj("p1", "Part Scan plugin", { tasks: 2 }),
  proj("p2", "IB plugin part scan"),
  proj("m1", "InfiniBot mobile app", { tasks: 8 }),
  proj("m2", "InfiniBot Mobile App Upgrade", { tasks: 10 }),
  proj("a1", "InfiniBot admin cost", { tasks: 5 }),
  proj("a2", "InfiniBot admin plans"),
  proj("pg1", "InfiniBot project page", { tasks: 9 }),
  proj("pg2", "InfiniBot Activity Page", { tasks: 16 }),
  proj("e1", "InfiniBot Notes Editor"),
  proj("e2", "InfiniBot project task document editor"),
  proj("solo", "InfiniBot"),
];
const TRADER = proj("trader", "Trader AI OS");
const NODES = [PARENT, TRADER, ...SUBS, proj("x", "Unrelated")];
const EDGES: OpEdge[] = [
  ...SUBS.map((s) => ({ source: s.id, target: PARENT.id, rel: "relates to" })),
  { source: PARENT.id, target: TRADER.id, rel: "sub-project of" },
  { source: TRADER.id, target: PARENT.id, rel: "relates to" },
];

describe("subProjectsOf", () => {
  it("collects relates-to / child projects and excludes the parent's own parent", () => {
    const subs = subProjectsOf(PARENT, NODES, EDGES).map((n) => n.id).sort();
    expect(subs).toEqual(SUBS.map((s) => s.id).sort());
    expect(subs).not.toContain(TRADER.id);
    expect(subs).not.toContain("project:x");
  });
  it("includes children by meta.parentProjectId and sub-project-of edges", () => {
    const child = proj("k", "Kid", { parentProjectId: "os" });
    const child2 = proj("k2", "Kid two");
    const subs = subProjectsOf(PARENT, [PARENT, child, child2], [{ source: child2.id, target: PARENT.id, rel: "sub-project of" }]);
    expect(subs.map((n) => n.id).sort()).toEqual([child.id, child2.id].sort());
  });
});

describe("duplicate-cluster detection", () => {
  it("strips the parent/brand words and plurals", () => {
    expect(subTitleTokens("InfiniBot Cloud SaaS", "InfinibotOS")).toEqual(["cloud", "saas"]);
    expect(subTitleTokens("Moltbot Cloud SaaS", "InfinibotOS")).toEqual(["cloud", "saas"]);
    expect(subTitleTokens("InfiniBot federation satellites", "InfinibotOS")).toEqual(["federation", "satellite"]);
    expect(subTitleTokens("InfiniBot projects page", "InfinibotOS")).toEqual(["page"]);
  });
  it("scores spacing variants and containment, not shared topic words", () => {
    expect(titleSimilarity(["web", "ui"], ["webui"])).toBe(1);
    expect(titleSimilarity(["mobile", "app"], ["mobile", "app", "upgrade"])).toBeGreaterThanOrEqual(0.8);
    expect(titleSimilarity(["page"], ["activity", "page"])).toBeLessThan(0.6);
    expect(titleSimilarity(["admin", "cost"], ["admin", "plan"])).toBeLessThan(0.6);
  });
  it("finds the near-duplicate clusters and picks the richest keeper", () => {
    const subs = subProjectsOf(PARENT, NODES, EDGES);
    const clusters = clusterSubProjects(PARENT, subs);
    const sets = clusters.map((c) => c.ids.slice().sort().join(","));
    expect(sets).toContain(["project:c1", "project:c2", "project:c3"].join(","));
    expect(sets).toContain(["project:w1", "project:w2"].join(","));
    expect(sets).toContain(["project:p1", "project:p2"].join(","));
    expect(sets).toContain(["project:m1", "project:m2"].join(","));
    // Distinct features sharing one word are NOT duplicates.
    expect(clusters.flatMap((c) => c.ids)).not.toContain("project:a1");
    expect(clusters.flatMap((c) => c.ids)).not.toContain("project:pg1");
    expect(clusters.flatMap((c) => c.ids)).not.toContain("project:e1");
    // A brand-only title never clusters.
    expect(clusters.flatMap((c) => c.ids)).not.toContain("project:solo");
    const cloud = clusters.find((c) => c.ids.includes("project:c1"))!;
    expect(cloud.tier).toBe("duplicate");
    expect(cloud.keeperId).toBe("project:c1"); // 22 tasks
    expect(clusters[0].tier).toBe("duplicate");
  });
  it("marks a chain of look-alikes as near, not duplicate", () => {
    const P = proj("p", "Hub");
    const chain = [proj("1", "mobile app"), proj("2", "mobile app parity"), proj("3", "app parity")];
    const cl = clusterSubProjects(P, chain);
    expect(cl).toHaveLength(1);
    expect(cl[0].tier).toBe("near");
  });
});

const detail = (n: OpNode, extra: Partial<SubDetail> = {}): SubDetail => ({
  node: n,
  id: String(n.meta!.projectId),
  status: "Not started",
  priority: "High",
  description: `About ${n.label}`,
  markdown: `# ${n.label}\n\nBody`,
  tasks: [],
  relations: [],
  notes: [],
  ...extra,
});

const C2 = detail(SUBS[1], {
  status: "In progress",
  tasks: [
    { id: "t1", title: "Ship billing", status: "done" },
    { id: "t2", title: "Pricing page", status: "todo" },
  ],
  notes: [{ id: "n1", label: "Pricing notes" }],
  relations: [
    { id: "r-parent", fromType: "project", fromId: "c2", edge: "relates_to", toType: "project", toId: "os", createdBy: "agent" },
    { id: "r-report", fromType: "report", fromId: "rep1", edge: "report_documents_project", toType: "project", toId: "c2" },
    { id: "r-task", fromType: "project", fromId: "c2", edge: "project_has_task", toType: "task", toId: "t1" },
    { id: "r-client", fromType: "project", fromId: "c2", edge: "relates_to", toType: "client", toId: "cl1" },
  ],
});
const W2 = detail(SUBS[4], { relations: [{ id: "rw", fromType: "project", fromId: "w2", edge: "relates_to", toType: "project", toId: "os" }] });

describe("planConvertToTasks", () => {
  const plan = planConvertToTasks(PARENT, [C2, W2], { taskMode: "move", batchId: "b1", today: "2026-10-13" });

  it("never deletes anything and archives every original", () => {
    expect(plan.deletes).toBe(0);
    expect(plan.steps.some((s) => /\.delete$/.test(s.call.method))).toBe(false);
    const archives = plan.steps.filter((s) => s.call.method === "kanban.projects.update");
    expect(archives.map((s) => s.call.params)).toEqual([
      { id: "c2", archived: true },
      { id: "w2", archived: true },
    ]);
    // Undo un-archives.
    expect(archives[0].undo[0].params).toEqual({ id: "c2", archived: false });
  });

  it("creates a task on the parent keeping title, status, priority, description and a back-reference", () => {
    const create = plan.steps.find((s) => s.key === "c2:create")!;
    expect(create.call).toMatchObject({
      method: "kanban.tasks.create",
      params: { title: "InfiniBot Cloud SaaS", projectId: "os", status: "in_progress", priority: "high" },
    });
    expect(String(create.call.params.description)).toContain("project:c2");
    expect(create.capture).toBe("task:c2");
    expect(create.critical).toBe(true);
    const back = plan.steps.find((s) => s.key === "c2:backref")!;
    expect(back.call.params).toMatchObject({ fromType: "task", fromId: "$ref:task:c2", toType: "project", toId: "c2" });
    expect((back.call.params.meta as Record<string, unknown>).convertedFromProjectId).toBe("c2");
    expect((back.call.params.meta as { detachedRelations: unknown[] }).detachedRelations).toHaveLength(1);
    const body = plan.steps.find((s) => s.key === "c2:body")!;
    expect(String(body.call.params.markdown)).toContain("Converted from sub-project");
    expect(String(body.call.params.markdown)).toContain("Ship billing");
  });

  it("carries relations to the task, moves tasks + notes, detaches the parent link", () => {
    const rels = plan.steps.filter((s) => s.key.startsWith("c2:rel:"));
    expect(rels.map((s) => s.call.params.toType ?? "")).toHaveLength(2); // report + client (not parent, not has_task)
    const report = rels.find((s) => s.key === "c2:rel:r-report")!;
    expect(report.call.params).toMatchObject({ fromType: "report", fromId: "rep1", toType: "task", toId: "$ref:task:c2", edge: "relates_to" });
    const moves = plan.steps.filter((s) => s.key.startsWith("c2:task:"));
    expect(moves.map((s) => s.call.params)).toEqual([
      { id: "t1", projectId: "os", source: "bulk" },
      { id: "t2", projectId: "os", source: "bulk" },
    ]);
    expect(moves[0].undo[0].params).toEqual({ id: "t1", projectId: "c2", source: "bulk" });
    const note = plan.steps.find((s) => s.key === "c2:note:n1")!;
    expect(note.call.params).toEqual({ id: "n1", projectId: "os" });
    const detach = plan.steps.find((s) => s.key === "c2:detach:r-parent")!;
    expect(detach.call).toEqual({ method: "objrel.unlink", params: { id: "r-parent" } });
    expect(detach.undo[0].method).toBe("objrel.link");
    expect(detach.undo[0].params).toMatchObject({ fromId: "c2", toId: "os", edge: "relates_to", clientRequestId: "r-parent" });
  });

  it("checklist mode nests tasks in the body instead of moving them", () => {
    const p = planConvertToTasks(PARENT, [C2], { taskMode: "checklist", batchId: "b2", today: "2026-10-13" });
    expect(p.steps.some((s) => s.key.startsWith("c2:task:"))).toBe(false);
    const md = String(p.steps.find((s) => s.key === "c2:body")!.call.params.markdown);
    expect(md).toContain("- [x] Ship billing");
    expect(md).toContain("- [ ] Pricing page");
    expect(p.items[0].checklist).toBe(2);
  });

  it("maps project statuses to task statuses", () => {
    expect(taskStatusFor("Not started")).toBe("todo");
    expect(taskStatusFor("In progress")).toBe("in_progress");
    expect(taskStatusFor("Reviewing")).toBe("review");
    expect(taskStatusFor("Completed")).toBe("done");
    expect(taskStatusFor("Cancelled")).toBe("backlog");
  });

  it("produces a readable dry-run report", () => {
    const txt = describePlan(plan, clusterSubProjects(PARENT, SUBS), (id) => NODES.find((n) => n.id === id)?.label ?? id);
    expect(txt).toContain("DRY RUN");
    expect(txt).toContain("Deletes of originals: 0");
    expect(txt).toContain("→ task under InfinibotOS");
  });
});

describe("undo plan", () => {
  const plan = planConvertToTasks(PARENT, [C2], { taskMode: "move", batchId: "b1", today: "2026-10-13" });

  it("resolves refs and drops calls whose refs are unknown", () => {
    expect(resolveRefs({ id: "$ref:task:c2", n: [1, "$ref:task:c2"] }, new Map([["task:c2", "T9"]]))).toEqual({ id: "T9", n: [1, "T9"] });
    expect(resolveRefs({ id: "$ref:nope" }, new Map())).toBe(UNRESOLVED);
  });

  it("only captures relation ids the gateway actually created", () => {
    const back = plan.steps.find((s) => s.key === "c2:backref")!;
    const call = resolveRefs(back.call, new Map([["task:c2", "T9"]]));
    if (call === UNRESOLVED) throw new Error("unresolved");
    expect(captureOf(back, call, { id: call.params.clientRequestId })).toBe(call.params.clientRequestId);
    // An existing relation came back: never unlink it on undo.
    expect(captureOf(back, call, { id: "pre-existing" })).toBeNull();
  });

  it("reverses executed steps newest-first, deleting only the task it created", () => {
    const refs = new Map<string, string | null>([["task:c2", "T9"]]);
    for (const s of plan.steps) if (s.capture?.startsWith("rel:")) refs.set(s.capture, String(s.call.params.clientRequestId));
    const undo = buildUndo(plan.steps, refs);
    expect(undo[0]).toEqual({ method: "kanban.projects.update", params: { id: "c2", archived: false } });
    expect(undo.at(-1)).toEqual({ method: "kanban.tasks.delete", params: { id: "T9" } });
    const deletes = undo.filter((c) => c.method.endsWith(".delete"));
    expect(deletes).toEqual([{ method: "kanban.tasks.delete", params: { id: "T9" } }]);
    expect(undo.some((c) => c.method === "objrel.link" && c.params.clientRequestId === "r-parent")).toBe(true);
    // Partial batch (create failed → nothing captured): nothing to delete.
    expect(buildUndo(plan.steps.slice(0, 1), new Map())).toEqual([]);
  });
});

describe("planMergeDuplicates", () => {
  it("keeps the richest, re-points links, moves tasks and archives the rest", () => {
    const keeper = detail(SUBS[0], {
      tasks: [{ id: "k1", title: "k" }],
      relations: [{ id: "rk", fromType: "report", fromId: "rep1", edge: "report_documents_project", toType: "project", toId: "c1" }],
    });
    const plan = planMergeDuplicates(PARENT, [{ keeper, others: [C2] }], { batchId: "m1", today: "2026-10-13" });
    expect(plan.deletes).toBe(0);
    expect(plan.items.map((i) => i.action)).toEqual(["keep", "merge-into"]);
    // Report link already on the keeper → not duplicated; client link re-pointed.
    const rels = plan.steps.filter((s) => s.key.startsWith("c2:rel:"));
    expect(rels).toHaveLength(1);
    expect(rels[0].call.params).toMatchObject({ fromType: "project", fromId: "c1", toType: "client", toId: "cl1", edge: "relates_to" });
    expect(plan.steps.find((s) => s.key === "c2:task:t1")!.call.params).toEqual({ id: "t1", projectId: "c1", source: "bulk" });
    const back = plan.steps.find((s) => s.key === "c2:backref")!;
    expect((back.call.params.meta as Record<string, unknown>).mergedIntoProjectId).toBe("c1");
    const append = plan.steps.find((s) => s.key === "c1:append")!;
    expect(append.undo[0]).toEqual({ method: "kanban.projects.content.setMarkdown", params: { projectId: "c1", markdown: keeper.markdown } });
    expect(plan.steps.find((s) => s.key === "c2:archive")!.call.params).toEqual({ id: "c2", archived: true });
  });
});
