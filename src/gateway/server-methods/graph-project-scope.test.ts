import { describe, expect, it } from "vitest";

import {
  clampHops,
  parseScopeParams,
  pruneToComponent,
  scopeSnapshotToProject,
  type ScopeEdge,
  type ScopeNode,
} from "./graph-project-scope.js";

const node = (id: string, kind: string, meta?: Record<string, unknown>): ScopeNode => ({
  id,
  kind,
  label: id,
  ...(meta ? { meta } : {}),
});
const edge = (
  source: string,
  target: string,
  rel = "relates",
  extra: Partial<ScopeEdge> = {},
): ScopeEdge => ({
  source,
  target,
  rel,
  ...extra,
});

/**
 * Two projects that share a hub (the owner agent + a common client), each
 * with private tasks/files/notes, plus an unrelated island.
 */
function twoProjectFixture(): { nodes: ScopeNode[]; edges: ScopeEdge[] } {
  const nodes: ScopeNode[] = [
    node("project:flypic", "project", { projectId: "flypic" }),
    node("project:infini", "project", { projectId: "infini" }),
    node("task:f1", "task", { projectId: "flypic" }),
    node("task:f2", "task", { projectId: "flypic" }),
    node("task:i1", "task", { projectId: "infini" }),
    node("task:i2", "task", { projectId: "infini" }),
    node("file:fspec", "file", { projectId: "flypic" }),
    node("file:ispec", "file", { projectId: "infini" }),
    // A run that only declares its project in meta (no stored edge).
    node("run:r-f", "run", { projectId: "flypic" }),
    node("note:fnote", "note"),
    node("note:inote", "note"),
    node("agent:main", "agent"),
    node("client:acme", "client"),
    node("user:owner", "user"),
    node("report:r1", "report"),
    node("note:island", "note"),
    node("note:island2", "note"),
    node("note:deep", "note"),
    node("note:deeper", "note"),
  ];
  const edges: ScopeEdge[] = [
    edge("project:flypic", "task:f1", "contains"),
    edge("project:flypic", "task:f2", "contains"),
    edge("project:infini", "task:i1", "contains"),
    edge("project:infini", "task:i2", "contains"),
    edge("file:fspec", "project:flypic", "in project"),
    edge("file:ispec", "project:infini", "in project"),
    edge("note:fnote", "project:flypic", "mentions", { inferred: true }),
    edge("note:inote", "project:infini", "mentions", { inferred: true }),
    // Shared hubs.
    edge("client:acme", "project:flypic", "client of"),
    edge("client:acme", "project:infini", "client of"),
    edge("agent:main", "task:f1", "assigned"),
    edge("agent:main", "task:i1", "assigned"),
    edge("user:owner", "project:flypic", "owns"),
    edge("user:owner", "project:infini", "owns"),
    // Report on flypic's note.
    edge("report:r1", "note:fnote", "reports on"),
    // A chain out of flypic: note:fnote → note:deep → note:deeper.
    edge("note:fnote", "note:deep", "links"),
    edge("note:deep", "note:deeper", "links"),
    // Unrelated island.
    edge("note:island", "note:island2", "links"),
  ];
  // Make agent:main a real hub (lots of runs elsewhere).
  for (let i = 0; i < 40; i++) {
    nodes.push(node(`run:x${i}`, "run"));
    edges.push(edge("agent:main", `run:x${i}`, "running"));
  }
  return { nodes, edges };
}

const ids = (r: { nodes: ScopeNode[] }) => new Set(r.nodes.map((n) => n.id));

describe("scopeSnapshotToProject", () => {
  it("keeps only nodes connected to the project, no unrelated islands", () => {
    const r = scopeSnapshotToProject(twoProjectFixture(), { projectId: "flypic" });
    const got = ids(r);
    expect(r.scope.found).toBe(true);
    expect(got.has("project:flypic")).toBe(true);
    for (const id of ["task:f1", "task:f2", "file:fspec", "note:fnote", "report:r1", "run:r-f"]) {
      expect(got.has(id), id).toBe(true);
    }
    expect(got.has("note:island")).toBe(false);
    expect(got.has("note:island2")).toBe(false);
    // Every kept node is reachable from the project over kept edges.
    const pr = pruneToComponent(r.nodes, r.edges, "project:flypic");
    expect(pr.nodes.length).toBe(r.nodes.length);
    expect(r.scope.totalNodes).toBeGreaterThan(r.nodes.length);
  });

  it("never leaks the other project's private nodes through a shared hub", () => {
    const fx = twoProjectFixture();
    const flypic = ids(scopeSnapshotToProject(fx, { projectId: "flypic", hops: 4 }));
    for (const id of ["task:i1", "task:i2", "file:ispec", "note:inote"]) {
      expect(flypic.has(id), id).toBe(false);
    }
    const infini = ids(scopeSnapshotToProject(fx, { projectId: "infini", hops: 4 }));
    for (const id of ["task:f1", "task:f2", "file:fspec", "note:fnote", "run:r-f", "report:r1"]) {
      expect(infini.has(id), id).toBe(false);
    }
    // The shared client may appear (it IS related) — but as a boundary.
    expect(infini.has("client:acme")).toBe(true);
  });

  it("caps hubs: a high-degree node is shown but not expanded", () => {
    const r = scopeSnapshotToProject(twoProjectFixture(), { projectId: "flypic", hops: 4 });
    const got = ids(r);
    expect(got.has("agent:main")).toBe(true);
    expect(r.scope.hubs).toContain("agent:main");
    expect([...got].some((id) => id.startsWith("run:x"))).toBe(false);
    // The owner node is a hub kind: present, never expanded into infini.
    expect(r.scope.hubs).toContain("user:owner");
    expect(got.has("project:infini")).toBe(false);
  });

  it("respects the hop limit", () => {
    const fx = twoProjectFixture();
    const h1 = ids(scopeSnapshotToProject(fx, { projectId: "flypic", hops: 1 }));
    expect(h1.has("note:fnote")).toBe(true);
    expect(h1.has("report:r1")).toBe(false);
    expect(h1.has("note:deep")).toBe(false);
    const h2 = ids(scopeSnapshotToProject(fx, { projectId: "flypic", hops: 2 }));
    expect(h2.has("report:r1")).toBe(true);
    expect(h2.has("note:deep")).toBe(true);
    expect(h2.has("note:deeper")).toBe(false);
    const h3 = ids(scopeSnapshotToProject(fx, { projectId: "flypic", hops: 3 }));
    expect(h3.has("note:deeper")).toBe(true);
    // Hop 0: the project and the items it owns, nothing else.
    const h0 = ids(scopeSnapshotToProject(fx, { projectId: "flypic", hops: 0 }));
    expect([...h0].sort()).toEqual(
      ["file:fspec", "project:flypic", "run:r-f", "task:f1", "task:f2"].sort(),
    );
  });

  it("attaches meta-only seeds with an inferred 'in project' edge", () => {
    const r = scopeSnapshotToProject(twoProjectFixture(), { projectId: "flypic" });
    const e = r.edges.find((x) => x.source === "run:r-f");
    expect(e?.target).toBe("project:flypic");
    expect(e?.rel).toBe("in project");
    expect(e?.inferred).toBe(true);
  });

  it("filters traversal by relation type", () => {
    const r = scopeSnapshotToProject(twoProjectFixture(), {
      projectId: "flypic",
      rels: ["contains"],
    });
    const got = ids(r);
    expect(got.has("task:f1")).toBe(true);
    expect(got.has("note:fnote")).toBe(false);
    expect(got.has("client:acme")).toBe(false);
  });

  it("excludes secure items unless the caller is the secure lane", () => {
    const fx = twoProjectFixture();
    fx.nodes.push(node("task:secret", "task", { projectId: "flypic", secure: true }));
    fx.nodes.push(node("file:sealed", "file", { lane: "secure" }));
    fx.nodes.push(node("secure:doc:1", "note"));
    fx.edges.push(edge("project:flypic", "task:secret", "contains"));
    fx.edges.push(edge("file:sealed", "project:flypic", "in project"));
    fx.edges.push(edge("secure:doc:1", "task:f1", "mentions"));
    const normal = scopeSnapshotToProject(fx, { projectId: "flypic" });
    const got = ids(normal);
    expect(got.has("task:secret")).toBe(false);
    expect(got.has("file:sealed")).toBe(false);
    expect(got.has("secure:doc:1")).toBe(false);
    expect(normal.scope.secureExcluded).toBe(3);
    const secure = ids(scopeSnapshotToProject(fx, { projectId: "flypic", includeSecure: true }));
    expect(secure.has("task:secret")).toBe(true);
    expect(secure.has("file:sealed")).toBe(true);
  });

  it("resolves secure-lane project ids and marks the root", () => {
    const snap = {
      nodes: [
        node("secure:project:p1", "project", { secure: true }),
        node("secure:task:t1", "task", { secure: true }),
      ],
      edges: [edge("secure:project:p1", "secure:task:t1", "contains")],
    };
    const r = scopeSnapshotToProject(snap, { projectId: "p1", includeSecure: true });
    expect(r.nodes.map((n) => n.id).sort()).toEqual(["secure:project:p1", "secure:task:t1"]);
    expect(r.nodes.find((n) => n.id === "secure:project:p1")?.meta?.scopeRoot).toBe(true);
  });

  it("returns an empty, not-found scope for an unknown project", () => {
    const r = scopeSnapshotToProject(twoProjectFixture(), { projectId: "nope" });
    expect(r.scope.found).toBe(false);
    expect(r.nodes).toEqual([]);
  });

  it("caps fan-out per node", () => {
    const nodes = [node("project:p", "project")];
    const edges: ScopeEdge[] = [];
    for (let i = 0; i < 100; i++) {
      nodes.push(node(`note:n${i}`, "note"));
      edges.push(edge("project:p", `note:n${i}`, "mentions"));
    }
    const r = scopeSnapshotToProject(
      { nodes, edges },
      { projectId: "p", maxFanout: 10, hubDegree: 1000 },
    );
    expect(r.nodes.length).toBe(11);
    expect(r.scope.capped).toBe(90);
  });
});

describe("scope params", () => {
  it("clamps hops and parses params", () => {
    expect(clampHops(undefined)).toBe(2);
    expect(clampHops(9)).toBe(4);
    expect(clampHops(-3)).toBe(0);
    expect(clampHops("1")).toBe(1);
    expect(parseScopeParams({})).toBeNull();
    expect(parseScopeParams({ projectId: "abc", hops: 3, rels: ["contains", 4] })).toMatchObject({
      projectId: "abc",
      hops: 3,
      rels: ["contains"],
    });
  });
});
