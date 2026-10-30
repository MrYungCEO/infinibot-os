import { describe, expect, it } from "vitest";
import {
  UndoStack,
  aiPrompt,
  buildAiContext,
  communities,
  computeGrouping,
  currentProjectOf,
  detectInsights,
  diffActivity,
  findDuplicates,
  groupTargets,
  planBulkDelete,
  planBulkLink,
  planBulkReassign,
  planBulkStatus,
  planBulkTag,
  planConsolidate,
  planLink,
  planReassign,
  pointInPolygon,
  sanitizeSnapshot,
  selectInLasso,
  spawnTask,
  storeIdOf,
  suggestLinks,
  tokensOf,
  unlinkCall,
  type OpEdge,
  type OpNode,
} from "./knowledge-graph-ops";

const P = (id: string, label: string, meta: Record<string, unknown> = {}): OpNode => ({
  id: `project:${id}`,
  kind: "project",
  label,
  meta: { projectId: id, health: "active", ...meta },
});
const T = (id: string, label: string, projectId?: string, meta: Record<string, unknown> = {}): OpNode => ({
  id: `task:${id}`,
  kind: "task",
  label,
  meta: { status: "todo", projectId, ...meta },
});
const N = (id: string, label: string, meta: Record<string, unknown> = {}): OpNode => ({
  id: `note:${id}`,
  kind: "note",
  label,
  meta,
});
const byIdOf = (nodes: OpNode[]) => new Map(nodes.map((n) => [n.id, n]));

describe("ids", () => {
  it("prefers explicit store ids from meta", () => {
    expect(storeIdOf(P("abc", "A"))).toBe("abc");
    expect(storeIdOf({ id: "client:x:y", kind: "client", label: "c" })).toBe("x:y");
    expect(storeIdOf(N("n1", "n"))).toBe("n1");
  });
});

describe("planLink", () => {
  it("links two nodes with relates_to by default", () => {
    const p = planLink(N("a", "A"), N("b", "B"));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.call).toEqual({
      method: "objrel.link",
      params: { fromType: "note", fromId: "a", toType: "note", toId: "b", edge: "relates_to", createdBy: "knowledge-graph" },
    });
    expect(unlinkCall(p, "rel-1")).toEqual({ method: "objrel.unlink", params: { id: "rel-1" } });
    expect(unlinkCall(p).params).toMatchObject({ fromType: "note", fromId: "a", toId: "b", edge: "relates_to" });
  });

  it("orients typed edges regardless of drag direction", () => {
    const p = planLink(T("t1", "Task"), P("p1", "Proj"));
    expect(p.ok && p.edge).toBe("project_has_task");
    expect(p.ok && p.fromType).toBe("project");
    expect(p.ok && p.toId).toBe("t1");
  });

  it("rejects self links, unlinkable kinds and existing links", () => {
    const a = N("a", "A");
    expect(planLink(a, a)).toMatchObject({ ok: false });
    expect(planLink(a, { id: "run:1", kind: "run", label: "r" })).toMatchObject({ ok: false });
    expect(planLink(a, undefined)).toMatchObject({ ok: false });
    const adj = new Map([["note:a", new Set(["note:b"])]]);
    expect(planLink(a, N("b", "B"), adj)).toEqual({ ok: false, reason: "These are already linked." });
  });
});

describe("planReassign", () => {
  const p1 = P("p1", "Alpha");
  const p2 = P("p2", "Beta");
  const t = T("t1", "Write spec", "p1");
  const note = N("n1", "Spec notes");
  const edges: OpEdge[] = [
    { source: "project:p1", target: "task:t1", rel: "contains" },
    { source: "note:n1", target: "project:p1", rel: "about" },
  ];
  const byId = byIdOf([p1, p2, t, note]);

  it("moves a task with an undo back to its old project", () => {
    const r = planReassign(t, p2, edges, byId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op.call).toEqual({ method: "kanban.tasks.update", params: { id: "t1", projectId: "p2" } });
    expect(r.op.undo).toEqual([{ method: "kanban.tasks.update", params: { id: "t1", projectId: "p1" } }]);
    expect(r.fromProjectId).toBe("p1");
  });

  it("files a note under a project via notes.update", () => {
    expect(currentProjectOf(note, edges, byId)).toBe("p1");
    const r = planReassign(note, p2, edges, byId);
    expect(r.ok && r.op.call).toEqual({ method: "notes.update", params: { id: "n1", projectId: "p2" } });
    expect(r.ok && r.op.undo[0].params).toEqual({ id: "n1", projectId: "p1" });
  });

  it("refuses no-op, non-project targets, and falls back to link for other kinds", () => {
    expect(planReassign(t, p1, edges, byId)).toMatchObject({ ok: false });
    expect(planReassign(t, note, edges, byId)).toMatchObject({ ok: false });
    const issue: OpNode = { id: "issue:i", kind: "issue", label: "Bug" };
    expect(planReassign(issue, p2, edges, byId)).toMatchObject({ ok: false, fallbackLink: true });
  });

  it("re-parents projects but never into a loop", () => {
    const parent = P("pa", "Parent");
    const child = P("ch", "Child", { parentProjectId: "pa" });
    const map = byIdOf([parent, child, p2]);
    const ok = planReassign(parent, p2, [], map);
    expect(ok.ok && ok.op.call).toEqual({ method: "kanban.projects.update", params: { id: "pa", parentProjectId: "p2" } });
    expect(planReassign(parent, child, [], map)).toMatchObject({ ok: false });
  });
});

describe("document nodes (note:doc:<id>)", () => {
  const doc: OpNode = { id: "note:doc:abc", kind: "note", label: "Imported vault page" };
  const proj = P("p", "Proj");
  it("are linkable but never written through notes.*", () => {
    expect(planLink(doc, proj)).toMatchObject({ ok: true, call: { params: { fromType: "note", fromId: "doc:abc" } } });
    expect(planReassign(doc, proj, [], byIdOf([doc, proj]))).toMatchObject({ ok: false, fallbackLink: true });
    expect(planBulkTag([doc], "x").ops).toEqual([]);
    expect(planBulkDelete([doc]).ops).toEqual([]);
    expect(planConsolidate([{ node: doc, body: "", degree: 0 }, { node: N("n", "Note"), body: "", degree: 0 }], [], byIdOf([doc]))).toMatchObject({ ok: false });
  });
});

describe("bulk planners", () => {
  const nodes = [T("t1", "A", "p1", { status: "todo", tags: ["x"] }), P("p1", "Proj", { status: "In progress" }), N("n1", "Note", { tags: ["x"] }), { id: "issue:i", kind: "issue", label: "I" } as OpNode];

  it("status maps tasks 1:1 and projects to project statuses", () => {
    const plan = planBulkStatus(nodes, "done");
    expect(plan.ops.map((o) => o.call)).toEqual([
      { method: "kanban.tasks.update", params: { id: "t1", status: "done" } },
      { method: "kanban.projects.update", params: { id: "p1", status: "Completed" } },
    ]);
    expect(plan.ops[0].undo[0].params.status).toBe("todo");
    expect(plan.skipped.map((s) => s.nodeId)).toEqual(["note:n1", "issue:i"]);
  });

  it("tags merge with existing tags and skip unknown task tags", () => {
    const plan = planBulkTag([...nodes, T("t2", "B")], "#Launch Prep");
    expect(plan.ops.map((o) => o.call.params)).toEqual([
      { id: "t1", tags: ["x", "launch-prep"] },
      { id: "n1", tags: ["x", "launch-prep"] },
    ]);
    expect(plan.ops[1].undo[0].params.tags).toEqual(["x"]);
    expect(plan.skipped.find((s) => s.nodeId === "task:t2")?.reason).toMatch(/unknown/);
  });

  it("delete only plans tasks + notes", () => {
    const plan = planBulkDelete(nodes);
    expect(plan.ops.map((o) => o.call.method)).toEqual(["kanban.tasks.delete", "notes.delete"]);
    expect(plan.skipped).toHaveLength(2);
  });

  it("reassign + link in bulk", () => {
    const target = P("p9", "Target");
    const map = byIdOf([...nodes, target]);
    const re = planBulkReassign(nodes, target, [], map);
    expect(re.ops.map((o) => o.call.method)).toEqual(["kanban.tasks.update", "kanban.projects.update", "notes.update"]);
    expect(re.skipped.map((s) => s.nodeId)).toEqual(["issue:i"]);
    const ln = planBulkLink([...nodes, target], target);
    expect(ln.links).toHaveLength(4);
  });
});

describe("planConsolidate", () => {
  const a = N("a", "Launch plan");
  const b = N("b", "Launch plan (1)");
  const c = N("c", "Launch plan copy");
  const proj = P("p", "Launch");
  const client: OpNode = { id: "client:k", kind: "client", label: "Acme", meta: { clientId: "k" } };
  const edges: OpEdge[] = [
    { source: "note:a", target: "project:p", rel: "about" },
    { source: "note:b", target: "client:k", rel: "relates to" },
    { source: "note:c", target: "note:a", rel: "links" },
  ];
  const byId = byIdOf([a, b, c, proj, client]);

  it("merges bodies into the most connected note and carries relations", () => {
    const plan = planConsolidate(
      [
        { node: a, body: "Intro\n\nShared para", degree: 2 },
        { node: b, body: "Shared para\n\nExtra from B", degree: 1 },
        { node: c, body: "", degree: 1 },
      ],
      edges,
      byId,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.primaryId).toBe("note:a");
    expect(plan.body).toContain("Intro");
    expect(plan.body.match(/Shared para/g)).toHaveLength(1);
    expect(plan.body).toContain("## Merged from: Launch plan (1)");
    expect(plan.body).toContain("Extra from B");
    expect(plan.relinks.map((r) => r.to.id)).toEqual(["client:k"]);
    expect(plan.calls[0]).toMatchObject({ method: "notes.update", params: { id: "a" } });
    expect(plan.calls.filter((c) => c.method === "objrel.link")).toHaveLength(1);
    expect(plan.calls.filter((c) => c.method === "notes.delete").map((c) => c.params.id)).toEqual(["b", "c"]);
  });

  it("honours an explicit primary, archive mode and edited text", () => {
    const plan = planConsolidate(
      [
        { node: a, body: "A", degree: 2 },
        { node: b, body: "B", degree: 1 },
      ],
      edges,
      byId,
      { primaryId: "note:b", removeMode: "archive", body: "Edited", title: "Final" },
    );
    expect(plan.ok && plan.primaryId).toBe("note:b");
    expect(plan.ok && plan.calls[0].params).toEqual({ id: "b", name: "Final", body: "Edited" });
    expect(plan.ok && plan.calls.at(-1)).toEqual({ method: "notes.update", params: { id: "a", tags: ["merged"] } });
  });

  it("tasks write markdown and archive duplicates as done", () => {
    const t1 = T("1", "Fix login");
    const t2 = T("2", "Fix login bug");
    const plan = planConsolidate(
      [
        { node: t1, body: "x", degree: 1 },
        { node: t2, body: "y", degree: 0 },
      ],
      [],
      byIdOf([t1, t2]),
    );
    expect(plan.ok && plan.calls.map((c) => c.method)).toEqual(["kanban.tasks.content.setMarkdown", "kanban.tasks.update"]);
    expect(plan.ok && plan.calls[1].params).toEqual({ id: "2", status: "done" });
  });

  it("rejects mixed kinds or a single item", () => {
    expect(planConsolidate([{ node: a, body: "", degree: 0 }], [], byId)).toMatchObject({ ok: false });
    expect(
      planConsolidate(
        [
          { node: a, body: "", degree: 0 },
          { node: T("1", "x"), body: "", degree: 0 },
        ],
        [],
        byId,
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("duplicates + suggestions", () => {
  it("tokenises away noise words and copy counters", () => {
    expect(tokensOf("Launch Plan (2) - copy")).toEqual(["launch", "plan"]);
  });

  it("never treats titles that differ only by a number as duplicates", () => {
    expect(findDuplicates([N("a", "Sprint 12"), N("b", "Sprint 13"), N("c", "decision-3"), N("d", "decision-13")])).toEqual([]);
    expect(findDuplicates([N("a", "Sprint 12 retro"), N("b", "Sprint 12 retro (1)")])).toHaveLength(1);
  });

  it("groups near-identical titles of the same kind", () => {
    const nodes = [N("a", "Robovoice pricing plan"), N("b", "Robovoice pricing plan (1)"), N("c", "Pricing plan robovoice"), N("d", "Totally different"), T("t", "Robovoice pricing plan")];
    const groups = findDuplicates(nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(["note:a", "note:b", "note:c"]);
  });

  it("handles thousands of nodes quickly", () => {
    const nodes: OpNode[] = [];
    for (let i = 0; i < 6000; i++) nodes.push(N(String(i), `item ${i} alpha${i % 300} beta${i % 17}`));
    const t0 = performance.now();
    findDuplicates(nodes);
    suggestLinks(nodes, [], { limit: 5 });
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("suggests links for unconnected nodes sharing distinctive words or neighbours", () => {
    const nodes = [P("p", "Robovoice launch"), N("a", "Robovoice launch checklist"), N("b", "Weekly standup"), N("c", "Standup agenda"), N("z1", "Misc"), N("z2", "Other"), N("z3", "Filler"), N("z4", "More")];
    const edges: OpEdge[] = [
      { source: "note:b", target: "project:p", rel: "about" },
      { source: "note:c", target: "project:p", rel: "about" },
    ];
    const s = suggestLinks(nodes, edges);
    expect(s.some((x) => [x.a, x.b].sort().join() === ["note:a", "project:p"].sort().join())).toBe(true);
    expect(s.every((x) => !(x.a === "note:b" && x.b === "project:p"))).toBe(true);
    const focused = suggestLinks(nodes, edges, { focus: new Set(["note:a"]) });
    expect(focused.every((x) => x.a === "note:a" || x.b === "note:a")).toBe(true);
  });
});

describe("insights", () => {
  const now = Date.UTC(2026, 9, 13);
  const nodes = [
    P("p1", "Stale one", { lastActivityAt: now - 30 * 86_400_000 }),
    P("p2", "Busy", { blocked: 3, lastActivityAt: now }),
    N("o", "Lonely note"),
    N("d1", "Quarterly board deck"),
    N("d2", "Quarterly board deck (1)"),
  ];
  const edges: OpEdge[] = [{ source: "note:d1", target: "project:p2", rel: "about" }, { source: "note:d2", target: "project:p2", rel: "about" }];

  it("detects stale, blocked tasks, orphans and duplicates with actions", () => {
    const ins = detectInsights(nodes, edges, [], now);
    const kinds = ins.map((i) => i.kind);
    expect(kinds).toContain("stale");
    expect(kinds).toContain("blocked-tasks");
    expect(kinds).toContain("orphans");
    expect(kinds).toContain("duplicates");
    expect(ins[0].severity).toBe("high");
    expect(ins.find((i) => i.kind === "duplicates")!.actions).toContain("consolidate");
    expect(ins.find((i) => i.kind === "orphans")!.nodeIds).toEqual(["note:o"]);
  });

  it("keeps gateway insights (dropping unknown ids), skips duplicate stale, honours dismissals", () => {
    const server = [{ id: "stale", kind: "stale", severity: "medium" as const, title: "1 gone quiet", nodeIds: ["project:p1", "project:gone"] }];
    const ins = detectInsights(nodes, edges, server, now, new Set(["g:orphans"]));
    expect(ins.filter((i) => i.kind === "stale")).toHaveLength(1);
    expect(ins.find((i) => i.kind === "stale")!.nodeIds).toEqual(["project:p1"]);
    expect(ins.find((i) => i.kind === "stale")!.actions).toContain("spawn");
    expect(ins.some((i) => i.id === "g:orphans")).toBe(false);
  });

  it("diffs activity between polls", () => {
    const before = [P("a", "A", { health: "active" }), N("x", "X")];
    const after = [P("a", "A", { health: "blocked", live: true }), N("x", "X"), N("y", "New idea")];
    const items = diffActivity(before, after, now);
    expect(items.map((i) => i.tone).sort()).toEqual(["live", "new", "status"]);
    expect(diffActivity(null, after, now)).toEqual([]);
  });
});

describe("grouping", () => {
  const nodes = [P("p1", "Alpha"), P("p2", "Beta", { health: "blocked" }), T("t1", "t", "p1"), N("n1", "n"), N("n2", "loose")];
  const edges: OpEdge[] = [
    { source: "project:p1", target: "task:t1", rel: "contains" },
    { source: "note:n1", target: "project:p2", rel: "about" },
  ];

  it("groups satellites under their project", () => {
    const g = computeGrouping(nodes, edges, "project");
    expect(g.groupOf.get("task:t1")).toBe("project:p1");
    expect(g.groupOf.get("note:n1")).toBe("project:p2");
    expect(g.groupOf.has("note:n2")).toBe(false);
  });

  it("groups by status and type", () => {
    const s = computeGrouping(nodes, edges, "status");
    expect(s.groupOf.get("note:n1")).toBe("h:blocked");
    expect(s.groupOf.get("note:n2")).toBe("unfiled");
    const t = computeGrouping(nodes, edges, "type");
    expect(t.groups.find((x) => x.key === "k:note")!.memberIds).toHaveLength(2);
    expect(computeGrouping(nodes, edges, "orbit").groups).toEqual([]);
  });

  it("auto-clusters connected components deterministically", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const e: OpEdge[] = [
      { source: "a", target: "b", rel: "x" },
      { source: "b", target: "c", rel: "x" },
      { source: "a", target: "c", rel: "x" },
      { source: "d", target: "e", rel: "x" },
      { source: "e", target: "f", rel: "x" },
      { source: "d", target: "f", rel: "x" },
    ];
    const lab = communities(ids, e);
    expect(lab.get("a")).toBe(lab.get("c"));
    expect(lab.get("d")).toBe(lab.get("f"));
    expect(lab.get("a")).not.toBe(lab.get("d"));
    const ns = ids.map((id) => N(id, id));
    const g = computeGrouping(ns, e.map((x) => ({ ...x, source: `note:${x.source}`, target: `note:${x.target}` })), "cluster");
    expect(g.groups).toHaveLength(2);
  });

  it("places group targets on a ring", () => {
    const t = groupTargets(
      [
        { key: "a", label: "a", color: "#fff", memberIds: ["1", "2"] },
        { key: "b", label: "b", color: "#fff", memberIds: ["3"] },
      ],
      { cx: 0, cy: 0 },
    );
    const a = t.get("a")!;
    const b = t.get("b")!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(100);
    expect(groupTargets([], { cx: 0, cy: 0 }).size).toBe(0);
  });
});

describe("selection geometry", () => {
  it("point in polygon + lasso", () => {
    const sq = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(pointInPolygon(5, 5, sq)).toBe(true);
    expect(pointInPolygon(15, 5, sq)).toBe(false);
    const ids = selectInLasso(sq, [
      { id: "in", x: 2, y: 2, visible: true },
      { id: "hidden", x: 3, y: 3, visible: false },
      { id: "out", x: 20, y: 2, visible: true },
    ]);
    expect(ids).toEqual(["in"]);
    expect(selectInLasso([0, 0, 1, 1], [{ id: "x", x: 0, y: 0, visible: true }])).toEqual([]);
  });
});

describe("undo + AI text", () => {
  it("undo stack is bounded and LIFO", () => {
    const u = new UndoStack(2);
    u.push("a", [{ method: "m", params: {} }]);
    u.push("b", [{ method: "m", params: {} }]);
    u.push("c", [{ method: "m", params: {} }]);
    u.push("empty", []);
    expect(u.size).toBe(2);
    expect(u.pop()!.label).toBe("c");
    expect(u.pop()!.label).toBe("b");
    expect(u.pop()).toBeUndefined();
  });

  it("builds bounded context and prompts", () => {
    const p = P("p", "Alpha", { tasks: 10, done: 4, blocked: 1 });
    const n = N("n", "Spec", { tags: ["x"] });
    const ctx = buildAiContext([p, n], [{ source: "note:n", target: "project:p", rel: "about" }], byIdOf([p, n]));
    expect(ctx).toContain("[project] Alpha");
    expect(ctx).toContain("4/10 tasks done");
    expect(ctx).toContain('about project "Alpha" (in selection)');
    const big = Array.from({ length: 500 }, (_, i) => N(String(i), `note number ${i} with a long title`));
    expect(buildAiContext(big, [], byIdOf(big), 2000).length).toBeLessThanOrEqual(2000);
    expect(aiPrompt("summarize", ctx, 2)).toMatch(/Summarize/);
    expect(aiPrompt("chat", ctx, 1)).toMatch(/one item/);
    expect(spawnTask(ctx, 2, "")).toMatch(/Review these items/);
  });
});

describe("sanitizeSnapshot", () => {
  it("survives garbage", () => {
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot("nope")).toBeNull();
    const s = sanitizeSnapshot({ nodes: "x", edges: 5 })!;
    expect(s.nodes).toEqual([]);
    expect(s.edges).toEqual([]);
  });

  it("drops malformed nodes/edges, dedupes, and normalises kinds", () => {
    const s = sanitizeSnapshot({
      generatedAt: 1,
      nodes: [
        { id: "a", kind: "note", label: "A" },
        { id: "a", kind: "note", label: "dup" },
        { kind: "note" },
        null,
        { id: 7, kind: "alien", label: "" },
        { id: "b", kind: "project", label: "  B  ", meta: [1], weight: Number.NaN },
      ],
      edges: [
        { source: "a", target: "b", rel: "x" },
        { source: "a", target: "missing" },
        { source: "a", target: "a" },
        { source: "7", target: "b" },
        "bad",
      ],
      insights: [{ id: "i", nodeIds: ["a"] }, { nope: true }],
    })!;
    expect(s.nodes.map((n) => [n.id, n.kind, n.label])).toEqual([
      ["a", "note", "A"],
      ["7", "node", "7"],
      ["b", "project", "B"],
    ]);
    expect(s.nodes[2].meta).toBeUndefined();
    expect(s.edges).toEqual([
      { source: "a", target: "b", rel: "x" },
      { source: "7", target: "b", rel: "relates to" },
    ]);
    expect(s.insights).toHaveLength(1);
    expect(s.dropped).toBe(6);
  });
});
