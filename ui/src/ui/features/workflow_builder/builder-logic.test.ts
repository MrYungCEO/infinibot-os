import { describe, expect, it } from "vitest";
import { topologicalLayers } from "../../../../../src/shared/group-chat/workflow-graph.js";
import {
  NODE_H,
  NODE_W,
  connect,
  describeOrder,
  dropAgent,
  emptyWorkflow,
  links,
  nodeAt,
  nodeStatuses,
  quickAddAgent,
  releaseNode,
  starterWorkflow,
} from "./builder-logic";

describe("workflow builder drag & drop", () => {
  it("dropping on empty canvas adds a top-level step centered on the pointer", () => {
    const { graph, nodeId } = dropAgent(emptyWorkflow(), "coder", { x: 300, y: 200 });
    const n = graph.nodes.find((x) => x.id === nodeId)!;
    expect(n).toMatchObject({ agentId: "coder", parentId: null, x: 300 - NODE_W / 2, y: 200 - NODE_H / 2 });
  });

  it("dropping onto a step makes the new agent its sub-agent", () => {
    const a = dropAgent(emptyWorkflow(), "main", { x: 200, y: 100 });
    const lead = a.graph.nodes[0];
    const b = dropAgent(a.graph, "coder", { x: lead.x + 10, y: lead.y + 10 });
    const c = dropAgent(b.graph, "qa", { x: lead.x + 10, y: lead.y + 10 });
    const sub1 = c.graph.nodes.find((n) => n.id === b.nodeId)!;
    const sub2 = c.graph.nodes.find((n) => n.id === c.nodeId)!;
    expect(sub1.parentId).toBe(lead.id);
    expect(sub2.parentId).toBe(lead.id);
    expect(sub1.y).toBeGreaterThan(lead.y + NODE_H);
    // Lead first, then both sub-agents in parallel.
    expect(topologicalLayers(c.graph).map((l) => l.map((n) => n.agentId))).toEqual([["main"], ["coder", "qa"]]);
  });

  it("dragging a step onto another step re-parents it; onto empty space just moves it", () => {
    let g = dropAgent(emptyWorkflow(), "main", { x: 120, y: 80 }).graph;
    const r = dropAgent(g, "coder", { x: 600, y: 80 });
    g = r.graph;
    const lead = g.nodes[0];
    const moved = releaseNode(g, r.nodeId, { x: 700, y: 300 }, { x: 760, y: 330 });
    expect(moved.reparentedTo).toBeNull();
    expect(moved.graph.nodes.find((n) => n.id === r.nodeId)).toMatchObject({ x: 700, y: 300, parentId: null });
    const re = releaseNode(g, r.nodeId, { x: lead.x, y: lead.y }, { x: lead.x + 20, y: lead.y + 20 });
    expect(re.reparentedTo).toBe(lead.id);
    expect(re.graph.nodes.find((n) => n.id === r.nodeId)?.parentId).toBe(lead.id);
    // The lead can't then be made a sub-agent of its own sub-agent.
    const sub = re.graph.nodes.find((n) => n.id === r.nodeId)!;
    const bad = releaseNode(re.graph, lead.id, { x: sub.x, y: sub.y }, { x: sub.x + 5, y: sub.y + 5 });
    expect(bad.error).toMatch(/lead itself/);
    expect(bad.reparentedTo).toBeNull();
  });

  it("connecting steps adds a sequence edge and refuses loops", () => {
    let g = dropAgent(emptyWorkflow(), "main", { x: 100, y: 100 }).graph;
    const b = dropAgent(g, "coder", { x: 500, y: 100 });
    g = b.graph;
    const [a] = g.nodes;
    const c1 = connect(g, a.id, b.nodeId);
    expect(c1.graph.edges).toHaveLength(1);
    const c2 = connect(c1.graph, b.nodeId, a.id);
    expect(c2.error).toMatch(/loop/);
    expect(c2.graph.edges).toHaveLength(1);
    expect(links(c1.graph).map((l) => l.kind)).toEqual(["edge"]);
  });

  it("tap-to-add chains after the last step, or nests under the selected one", () => {
    let r = quickAddAgent(emptyWorkflow(), "main", null);
    r = quickAddAgent(r.graph, "coder", null);
    expect(r.graph.edges).toHaveLength(1);
    const sel = r.nodeId;
    r = quickAddAgent(r.graph, "qa", sel);
    expect(r.graph.nodes.find((n) => n.id === r.nodeId)?.parentId).toBe(sel);
    expect(describeOrder(r.graph, (n) => n.agentId)).toBe("main → coder → qa");
  });

  it("hit-testing, starter template, order summary and run status", () => {
    const g = starterWorkflow(["main", "coder", "qa"]);
    expect(g.nodes).toHaveLength(3);
    expect(describeOrder(g, (n) => n.label!)).toBe("Plan → Build → Review");
    const n = g.nodes[1];
    expect(nodeAt(g, n.x + 5, n.y + 5)?.id).toBe(n.id);
    expect(nodeAt(g, -50, -50)).toBeNull();
    const { run, byNode } = nodeStatuses(g, [
      { id: "r0", workflowId: "other", workflowName: "x", status: "done", input: "", startedAt: 0, steps: [] },
      {
        id: "r1",
        workflowId: g.id,
        workflowName: g.name,
        status: "running",
        input: "",
        startedAt: 1,
        steps: [{ nodeId: n.id, agentId: "coder", status: "running", layer: 1 }],
      },
    ]);
    expect(run?.id).toBe("r1");
    expect(byNode.get(n.id)).toBe("running");
  });
});
