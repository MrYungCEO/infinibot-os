import { describe, expect, it } from "vitest";
import {
  flattenConnections,
  graphHasResearchEdge,
  graphNodeId,
  linkFromConnection,
  neighborKeysFrom,
  planLink,
  planUnlink,
  relationRef,
  suggestLinks,
  targetKey,
  type Candidate,
} from "./links";

describe("relation refs", () => {
  it("graphs documents as note:doc:<id> and leaves others alone", () => {
    expect(relationRef({ type: "doc", id: "d1" })).toEqual({ type: "note", id: "doc:d1" });
    expect(relationRef({ type: "doc", id: "doc:d1" })).toEqual({ type: "note", id: "doc:d1" });
    expect(relationRef({ type: "note", id: "row_1" })).toEqual({ type: "note", id: "row_1" });
    expect(graphNodeId({ type: "doc", id: "d1" })).toBe("note:doc:d1");
    expect(graphNodeId({ type: "project", id: "p1" })).toBe("project:p1");
  });
});

describe("planLink", () => {
  it("projects go through reports.link (Reports panel + typed edge)", () => {
    expect(planLink("rpt_1", { type: "project", id: "p1", label: "RoboPark" })).toEqual({
      method: "reports.link",
      params: {
        reportId: "rpt_1",
        targetType: "project",
        targetId: "p1",
        createdBy: "research",
        meta: { label: "RoboPark", via: "research" },
      },
    });
  });
  it("everything else is an objrel relates_to edge from the report with a label", () => {
    const plan = planLink("rpt_1", { type: "doc", id: "d9", label: "Spec" });
    expect(plan.method).toBe("objrel.link");
    expect(plan.params).toMatchObject({
      fromType: "report",
      fromId: "rpt_1",
      edge: "relates_to",
      toType: "note",
      toId: "doc:d9",
      meta: { label: "Spec", via: "research" },
    });
    expect(planLink("rpt_1", { type: "task", id: "t1", label: "T" }).params).toMatchObject({ toType: "task", toId: "t1" });
  });
  it("refuses unsaved research and self links", () => {
    expect(() => planLink("", { type: "task", id: "t", label: "t" })).toThrow(/saved to Reports/);
    expect(() => planLink("rpt_1", { type: "report", id: "rpt_1", label: "me" })).toThrow(/itself/);
  });
  it("unlink mirrors link", () => {
    expect(planUnlink("rpt_1", { type: "project", id: "p1" })).toEqual({
      method: "reports.unlink",
      params: { reportId: "rpt_1", targetType: "project", targetId: "p1" },
    });
    expect(planUnlink("rpt_1", { type: "doc", id: "d9" }).params).toEqual({
      fromType: "report",
      fromId: "rpt_1",
      edge: "relates_to",
      toType: "note",
      toId: "doc:d9",
    });
  });
});

describe("reading links back (two-way)", () => {
  it("maps both in and out edges, prefers the stored label, decodes docs", () => {
    expect(
      linkFromConnection({ type: "note", id: "doc:d9", label: "d9…", edgeMeta: { label: "Spec" }, direction: "out" }),
    ).toMatchObject({ type: "doc", id: "d9", label: "Spec" });
    expect(linkFromConnection({ type: "project", id: "p1", label: "RoboPark", direction: "in" })).toMatchObject({
      type: "project",
      label: "RoboPark",
      direction: "in",
    });
    expect(linkFromConnection({ type: "client", id: "c1" })).toBeNull();
  });
  it("flattens grouped connections and dedupes", () => {
    const res = {
      groups: [
        { items: [{ type: "project", id: "p1", label: "A" }, { type: "project", id: "p1", label: "A", edge: "relates_to" }] },
        { items: [{ type: "task", id: "t1", label: "T" }, { type: "lead", id: "l1" }] },
      ],
    };
    expect(flattenConnections(res).map(targetKey)).toEqual(["project:p1", "task:t1"]);
    expect(flattenConnections(null)).toEqual([]);
    expect([...neighborKeysFrom([res])]).toEqual(["project:p1", "task:t1"]);
  });
});

describe("suggestLinks", () => {
  const candidates: Candidate[] = [
    { type: "project", id: "p1", label: "RoboPark", text: "animatronic robots theme park" },
    { type: "project", id: "p2", label: "Kingly Vault", text: "courses membership" },
    { type: "note", id: "n1", label: "Humanoid robot vendors", text: "unitree figure pricing" },
    { type: "task", id: "t1", label: "Email ED-ROM", text: "" },
    { type: "report", id: "rpt_2", label: "Robot market landscape", text: "humanoid robot market" },
  ];
  const research = "Humanoid robot pricing for RoboPark: Unitree vs Figure, robot market";

  it("ranks by name mentions and topic similarity, skipping linked", () => {
    const s = suggestLinks({ researchText: research, candidates, linked: new Set(["report:rpt_2"]) });
    const keys = s.map(targetKey);
    expect(keys[0]).toBe("project:p1"); // name mentioned outright
    expect(keys).toContain("note:n1");
    expect(keys).not.toContain("report:rpt_2"); // already linked
    expect(keys).not.toContain("project:p2"); // unrelated
    expect(s[0].reason).toContain("RoboPark");
  });

  it("boosts graph neighbors and the scope project", () => {
    const s = suggestLinks({
      researchText: "something unrelated entirely",
      candidates,
      linked: new Set(),
      neighborKeys: new Set(["task:t1"]),
      scopeProjectId: "p2",
      minScore: 0.25,
    });
    expect(s.map(targetKey)).toEqual(["project:p2", "task:t1"]);
    expect(s[0].reason).toBe("Research scope");
    expect(s[1].reason).toMatch(/connected/i);
  });

  it("returns nothing for empty text with no scope", () => {
    expect(suggestLinks({ researchText: "", candidates, linked: new Set() })).toEqual([]);
  });
});

describe("graph read-back", () => {
  it("finds the research node + edge in either direction", () => {
    const g = {
      nodes: [{ id: "report:rpt_1" }, { id: "project:p1" }],
      edges: [{ source: "report:rpt_1", target: "project:p1", rel: "documents project" }],
    };
    expect(graphHasResearchEdge(g, "rpt_1", { type: "project", id: "p1" })).toBe(true);
    expect(graphHasResearchEdge(g, "rpt_1", { type: "task", id: "t" })).toBe(false);
    expect(graphHasResearchEdge({ nodes: [], edges: g.edges }, "rpt_1", { type: "project", id: "p1" })).toBe(false);
  });
});
