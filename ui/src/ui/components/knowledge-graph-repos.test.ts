import { describe, expect, it } from "vitest";
import { colorFor } from "./knowledge-graph-model";
import { buildScene } from "./knowledge-graph-scene";
import {
  ALL_HEALTH,
  heatTint,
  LANG_COLORS,
  REPO_KINDS,
  repoGraphsToSnapshot,
  repoLanguages,
  repoMetaOf,
  repoNodeBudget,
  type RepoGraphPayload,
} from "./knowledge-graph-repos";

const graph: RepoGraphPayload = {
  root: "/r/demo",
  head: "abc",
  repo: { name: "demo", branch: "main", dirty: true, dirtyCount: 2 },
  nodes: [
    { id: "", kind: "dir", name: "demo", parent: null, depth: 0, fileCount: 3, expanded: true },
    { id: "src", kind: "dir", name: "src", parent: "", depth: 1, fileCount: 2, expanded: true },
    { id: "src/a.ts", kind: "file", name: "a.ts", parent: "src", depth: 2, lang: "ts", heat: 1, commits: 4 },
    { id: "src/b.py", kind: "file", name: "b.py", parent: "src", depth: 2, lang: "py" },
    { id: "big", kind: "dir", name: "big", parent: "", depth: 1, fileCount: 900, expanded: false },
  ],
  edges: [
    { source: "", target: "src", kind: "contains" },
    { source: "src", target: "src/a.ts", kind: "contains" },
    { source: "src", target: "src/b.py", kind: "contains" },
    { source: "", target: "big", kind: "contains" },
    { source: "src/a.ts", target: "src/b.py", kind: "import" },
  ],
  stats: { files: 903, dirs: 3, visibleNodes: 5, importEdges: 1, truncatedWalk: false, collapsedDirs: 1, heatWindowDays: 90, scanMs: 3 },
};

describe("knowledge-graph repos mode", () => {
  const snap = repoGraphsToSnapshot([{ projectId: "p1", projectName: "Demo", graph }]);

  it("builds project → repo → dir → file with import edges", () => {
    const kinds = snap.nodes.map((n) => `${n.kind}:${repoMetaOf(n.meta)?.repoNode}`);
    expect(kinds).toEqual(["project:project", "database:repo", "topic:dir", "file:file", "file:file", "topic:dir"]);
    expect(snap.edges.find((e) => e.rel === "repo")).toMatchObject({ source: "repo-project:p1", target: "repo:p1" });
    expect(snap.edges.find((e) => e.rel === "imports")).toMatchObject({
      source: "repo-entry:p1:src/a.ts",
      target: "repo-entry:p1:src/b.py",
    });
    // Root dir collapses into the repo node.
    expect(snap.edges.find((e) => e.target === "repo-entry:p1:src")?.source).toBe("repo:p1");
  });

  it("colours by language with heat tint and flags collapsed dirs", () => {
    const a = snap.nodes.find((n) => n.id === "repo-entry:p1:src/a.ts")!;
    const b = snap.nodes.find((n) => n.id === "repo-entry:p1:src/b.py")!;
    expect(colorFor(b.kind, b.meta)).toBe(LANG_COLORS.py);
    expect(colorFor(a.kind, a.meta)).toBe(heatTint(LANG_COLORS.ts, 1));
    expect(colorFor(a.kind, a.meta)).not.toBe(LANG_COLORS.ts);
    expect(repoMetaOf(snap.nodes.find((n) => n.id === "repo-entry:p1:big")!.meta)?.expandable).toBe(true);
    expect(repoLanguages(snap).map((l) => l.lang).sort()).toEqual(["py", "ts"]);
  });

  it("feeds the shared scene pipeline", () => {
    const scene = buildScene({
      nodes: snap.nodes,
      edges: snap.edges,
      enabledKinds: REPO_KINDS,
      enabledHealth: ALL_HEALTH,
      groupMode: "cluster",
      aspect: 1.6,
    });
    expect(scene.nodes).toHaveLength(snap.nodes.length);
    expect(scene.links.length).toBe(snap.edges.length);
  });

  it("normal colouring is unchanged without repoColor", () => {
    expect(colorFor("file", {})).toBe("#5ec8d8");
    expect(repoNodeBudget(1)).toBe(1200);
    expect(repoNodeBudget(8)).toBe(250);
  });
});
