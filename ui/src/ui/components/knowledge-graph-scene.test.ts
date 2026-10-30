import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { digestAllModes } from "./knowledge-graph-scene-digest";
import { makeLiveShapedSnapshot } from "./knowledge-graph-synth";
import {
  buildScene,
  layoutAspectFor,
  stageEmphasis,
  stageFocusId,
  stageRingsOf,
  type GraphNodeIn,
} from "./knowledge-graph-scene";
import type { GraphNodeKind, ProjectHealth } from "./knowledge-graph-model";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "kg-scene-golden.json");

/** The cases the mobile suite replays through the native bundle (see mobile/src/__tests__/kg-native-parity.test.js). */
export function goldenCases(): Record<string, unknown> {
  const plain = makeLiveShapedSnapshot(false, 7);
  const tasks = makeLiveShapedSnapshot(true, 11);
  return {
    "live-shaped/phone": digestAllModes(plain, { aspect: layoutAspectFor(390, 700) }),
    "live-shaped/desktop": digestAllModes(plain, { aspect: layoutAspectFor(1600, 900) }),
    "live-tasks/landscape": digestAllModes(tasks, { aspect: layoutAspectFor(844, 330) }),
    "live-shaped/search": digestAllModes(plain, { aspect: layoutAspectFor(390, 700), search: "kingly" }),
  };
}

describe("knowledge-graph scene (shared web ↔ native pipeline)", () => {
  test("matches the golden digest for every grouping mode", () => {
    const got = goldenCases();
    if (process.env.UPDATE_KG_GOLDEN === "1" || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
    }
    const want = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(got).toEqual(want);
  });

  test("search keeps matches and their direct neighbours", () => {
    const nodes: GraphNodeIn[] = [
      { id: "project:a", kind: "project", label: "Alpha launch", meta: { health: "active" } },
      { id: "project:b", kind: "project", label: "Beta", meta: { health: "active" } },
      { id: "note:c", kind: "note", label: "Gamma notes" },
      { id: "note:d", kind: "note", label: "Delta" },
    ];
    const edges = [
      { source: "note:c", target: "project:a", rel: "about" },
      { source: "note:d", target: "project:b", rel: "about" },
    ];
    const scene = buildScene({
      nodes,
      edges,
      enabledKinds: new Set<GraphNodeKind>(["project", "note"]),
      enabledHealth: new Set<ProjectHealth>(["active"]),
      search: "alpha",
      groupMode: "brain",
      aspect: 1,
    });
    expect(scene.nodes.map((n) => n.id).sort()).toEqual(["note:c", "project:a"]);
    expect([...(scene.searchMatchIds ?? [])]).toEqual(["project:a"]);
  });

  test("consolidated sub-projects stay out unless shown", () => {
    const nodes: GraphNodeIn[] = [
      { id: "project:p1", kind: "project", label: "Parent", meta: { health: "active", projectId: "p1" } },
      { id: "project:p2", kind: "project", label: "Old sub", meta: { health: "active", projectId: "p2" } },
    ];
    const base = { nodes, edges: [], enabledKinds: new Set<GraphNodeKind>(["project"]), enabledHealth: new Set<ProjectHealth>(["active"]), groupMode: "brain" as const, aspect: 1 };
    expect(buildScene({ ...base, consolidatedIds: new Set(["p2"]) }).nodes.map((n) => n.id)).toEqual(["project:p1"]);
    expect(buildScene({ ...base, consolidatedIds: new Set(["p2"]), showConsolidated: true }).nodes).toHaveLength(2);
  });

  test("sub-projects are dimmed, nested and never outgrow their parent", () => {
    const nodes: GraphNodeIn[] = [
      { id: "project:p", kind: "project", label: "Parent", meta: { health: "active" } },
      { id: "project:s", kind: "project", label: "Sub", meta: { health: "active", tasks: 40 } },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `note:${i}`, kind: "note" as const, label: `n${i}` })),
    ];
    const edges = [
      { source: "project:s", target: "project:p", rel: "sub-project of" },
      ...Array.from({ length: 12 }, (_, i) => ({ source: `note:${i}`, target: "project:s", rel: "about" })),
    ];
    const s = buildScene({ nodes, edges, enabledKinds: new Set<GraphNodeKind>(["project", "note"]), enabledHealth: new Set<ProjectHealth>(["active"]), groupMode: "brain", aspect: 1 });
    const p = s.nodeById.get("project:p")!;
    const sub = s.nodeById.get("project:s")!;
    expect(sub.depth).toBe(1);
    expect(p.mainParent).toBe(true);
    expect(p.r).toBeGreaterThan(sub.r);
    // Rings: only the top-level project gets a progress ring; a selected sub-project gets a bezel.
    const rings = stageRingsOf(s.nodes, { selection: new Set(["project:s"]), selectedId: null });
    expect(rings.find((r) => r.index === p.index)).toMatchObject({ mark: 0 });
    expect(rings.find((r) => r.index === sub.index)).toMatchObject({ mark: 1, progress: -1 });
  });

  test("stage focus + emphasis rules", () => {
    const snap = makeLiveShapedSnapshot(false, 7);
    const s = buildScene({ nodes: snap.nodes, edges: snap.edges, enabledKinds: new Set<GraphNodeKind>(["project", "client", "note"]), enabledHealth: new Set<ProjectHealth>(["active", "review", "at_risk", "blocked", "backlog"]), groupMode: "brain", aspect: 1 });
    const n0 = s.nodes[0];
    const f = { selection: new Set<string>(), selectedId: null, hoveredId: null, adjacency: s.adjacency, highlightSet: null, activeInsight: null };
    expect(stageFocusId(f)).toBeNull();
    // Nothing focused: the floor is lifted.
    expect(stageEmphasis(n0, f, () => null)).toBeGreaterThanOrEqual(0.45);
    const focused = { ...f, selectedId: n0.id };
    expect(stageEmphasis(n0, focused, (id) => (id ? new Set([id]) : null))).toBe(1);
    const other = s.nodes.find((n) => n.id !== n0.id && !s.adjacency.get(n0.id)?.has(n.id))!;
    expect(stageEmphasis(other, focused, (id) => (id ? new Set([id]) : null))).toBe(0.07);
  });
});
