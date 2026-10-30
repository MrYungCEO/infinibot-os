import { describe, expect, it } from "vitest";

import { BRAIN_BOUNDS, brainSdf, FISSURE, lobeAt, sdCerebrum } from "../lib/glow3d/brain-anatomy";
import {
  AGG_MIN,
  layoutV3,
  LOD_COLLAPSE_PX,
  LOD_EXPAND_PX,
  lobeOccupancy,
  lodCollapsed,
  minNodeGap,
  minRegionGap,
  minUnitGap,
  NODE_PAD,
  packCircles,
  ringPack,
  shellPack,
  superRadius,
  UNIT_GAP,
  unlinkedPurity,
  type V3Mode,
  type V3NodeIn,
} from "./knowledge-graph-layout-v3";
import { hierarchyRadius, type GraphNodeKind } from "./knowledge-graph-model";
import { computeGrouping } from "./knowledge-graph-ops";
import { makeLiveShapedSnapshot } from "./knowledge-graph-synth";

/** The live-shaped graph (350 projects, 31 clients, 121 notes, 6 reports, ~110 orphans, ± 2,194 tasks). */
function live(withTasks = false) {
  const snap = makeLiveShapedSnapshot(withTasks);
  const index = new Map(snap.nodes.map((n, i) => [n.id, i]));
  const sub = new Map<number, number>();
  for (const e of snap.edges) if (e.rel === "sub-project of") sub.set(index.get(e.source)!, index.get(e.target)!);
  const nodes: V3NodeIn[] = snap.nodes.map((n, i) => ({
    id: n.id,
    kind: n.kind,
    anchor: n.kind === "project" || n.kind === "client",
    r: hierarchyRadius(n.kind as GraphNodeKind, sub.has(i) ? 1 : 0, n.weight),
    label: n.label,
    meta: n.meta,
    parent: sub.get(i),
  }));
  const neighbors: number[][] = nodes.map(() => []);
  for (const e of snap.edges) {
    const a = index.get(e.source)!, b = index.get(e.target)!;
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  return { snap, nodes, neighbors };
}

function run(mode: V3Mode, withTasks = false) {
  const f = live(withTasks);
  let groupOf: Array<string | undefined> | undefined;
  let groups;
  if (mode !== "brain" && mode !== "orbit") {
    const g = computeGrouping(
      f.nodes.map((n) => ({ id: n.id, kind: n.kind as GraphNodeKind, label: n.label ?? n.id, meta: n.meta })),
      f.snap.edges,
      mode,
    );
    groupOf = f.nodes.map((n) => g.groupOf.get(n.id));
    groups = g.groups;
  }
  const L = layoutV3(f.nodes, f.neighbors, { mode, groupOf, groups, aspect: 1.9 });
  return { ...f, L };
}

const MODES: V3Mode[] = ["brain", "orbit", "project", "status", "type", "cluster"];
const cache = new Map<string, ReturnType<typeof run>>();
const get = (mode: V3Mode, tasks = false) => {
  const k = `${mode}:${tasks}`;
  if (!cache.has(k)) cache.set(k, run(mode, tasks));
  return cache.get(k)!;
};

describe("live-shaped fixture", () => {
  it("matches the live counts", () => {
    const { snap } = live();
    const count = (k: string) => snap.nodes.filter((n) => n.kind === k).length;
    expect(count("project")).toBe(350);
    expect(count("client")).toBe(31);
    expect(count("note")).toBe(121);
    expect(count("report")).toBe(6);
    const { neighbors } = live();
    const orphans = neighbors.filter((l) => !l.length).length;
    expect(orphans).toBeGreaterThan(90);
    expect(orphans).toBeLessThan(260);
    expect(live(true).snap.nodes.filter((n) => n.kind === "task").length).toBe(2194);
  });
});

describe("v3 layout — no overlap, separated regions", () => {
  for (const mode of MODES) {
    it(`${mode}: every pair of nodes keeps ≥ NODE_PAD between their rims`, () => {
      const { nodes, L } = get(mode);
      expect(minNodeGap(L.target, nodes.map((n) => n.r))).toBeGreaterThanOrEqual(NODE_PAD - 1e-3);
    });
    it(`${mode}: units never touch, unlinked pockets keep the full moat`, () => {
      const { L } = get(mode);
      expect(minUnitGap(L)).toBeGreaterThanOrEqual(12 - 1e-3);
      const pocketVsLinked = minUnitGap(L, (a, b) => a.region === b.region && (a.type === "pocket") !== (b.type === "pocket"));
      expect(pocketVsLinked).toBeGreaterThanOrEqual(UNIT_GAP - 1e-3);
    });
  }
  for (const mode of ["project", "status", "type", "cluster"] as V3Mode[]) {
    it(`${mode}: different regions are separated by a clear gap`, () => {
      const { L } = get(mode);
      expect(minRegionGap(L)).toBeGreaterThan(24);
    });
  }
  it("type mode: one region per kind, no region holds two kinds", () => {
    const { nodes, L } = get("type");
    for (const r of L.regions) {
      const kinds = new Set(r.members.map((i) => nodes[i].kind));
      expect(kinds.size).toBeLessThanOrEqual(1);
    }
  });
  it("uses the canvas: the region map is wider than tall for a wide canvas", () => {
    const { L } = get("type");
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const r of L.regions) {
      x0 = Math.min(x0, r.c[0] - r.r);
      x1 = Math.max(x1, r.c[0] + r.r);
      z0 = Math.min(z0, r.c[2] - r.r);
      z1 = Math.max(z1, r.c[2] + r.r);
    }
    expect((x1 - x0) / (z1 - z0)).toBeGreaterThan(1.15);
  });
  it("is deterministic", () => {
    const a = run("status").L.target;
    const b = run("status").L.target;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  it("tasks on (2,717 nodes): brain and type stay overlap-free", () => {
    for (const mode of ["brain", "type"] as V3Mode[]) {
      const { nodes, L } = get(mode, true);
      expect(minNodeGap(L.target, nodes.map((n) => n.r))).toBeGreaterThanOrEqual(NODE_PAD - 1e-3);
    }
  });
});

describe("v3 layout — same-type grouping of unlinked nodes", () => {
  for (const mode of MODES) {
    it(`${mode}: every unlinked node sits in a pocket of only unlinked nodes of its own kind`, () => {
      const { nodes, neighbors, L } = get(mode);
      expect(unlinkedPurity(L, nodes, neighbors)).toBe(1);
    });
  }
  it("non-brain modes: one pocket per kind per region (unlinked clients together, notes together…)", () => {
    for (const mode of ["status", "type", "project", "cluster", "orbit"] as V3Mode[]) {
      const { L } = get(mode);
      const seen = new Set<string>();
      for (const u of L.units) {
        if (u.type !== "pocket") continue;
        const k = `${u.region}:${u.nodeKind}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });
  it("brain: chunks of one pocket stay in that kind's preferred lobes and sit next to each other", () => {
    const { L } = get("brain");
    const chunks = L.units.filter((u) => u.type === "pocket" && u.nodeKind === "project" && !u.key.includes(":done"));
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk's nearest sibling chunk is closer than the brain radius.
    for (const c of chunks) {
      let best = Infinity;
      for (const o of chunks) if (o !== c) best = Math.min(best, Math.hypot(c.c[0] - o.c[0], c.c[1] - o.c[1], c.c[2] - o.c[2]));
      expect(best).toBeLessThan(L.scale);
    }
  });
  it("linked families stay together: every satellite shares a unit with another family member", () => {
    const { nodes, L, neighbors } = get("brain");
    for (let i = 0; i < nodes.length; i++) {
      if (!neighbors[i].length) continue;
      const u = L.units[L.unitOf[i]];
      expect(u.type === "pocket").toBe(false);
    }
  });
});

describe("v3 LOD (super-nodes) and bundles", () => {
  it("collapses only big units, with hysteresis", () => {
    expect(lodCollapsed(AGG_MIN - 1, 1, false)).toBe(false);
    const n = 100;
    const rCollapse = LOD_COLLAPSE_PX * Math.sqrt(n) - 1;
    const rBetween = ((LOD_COLLAPSE_PX + LOD_EXPAND_PX) / 2) * Math.sqrt(n);
    const rExpand = LOD_EXPAND_PX * Math.sqrt(n) + 1;
    expect(lodCollapsed(n, rCollapse, false)).toBe(true);
    expect(lodCollapsed(n, rBetween, false)).toBe(false);
    expect(lodCollapsed(n, rBetween, true)).toBe(true);
    expect(lodCollapsed(n, rExpand, true)).toBe(false);
  });
  it("super-node size grows with the count but never exceeds the unit", () => {
    expect(superRadius(400, 300)).toBeGreaterThan(superRadius(50, 300));
    expect(superRadius(10_000, 120)).toBeLessThanOrEqual(120 * 0.62 + 1e-9);
  });
  it("marks the big task clusters aggregatable when tasks are on", () => {
    const { L } = get("type", true);
    const agg = L.units.filter((u) => u.aggregatable);
    expect(agg.length).toBeGreaterThan(2);
    for (const u of agg) expect(u.members.length).toBeGreaterThanOrEqual(AGG_MIN);
  });
  it("bundles carry every cross-unit link exactly once (few ribbons instead of many lines)", () => {
    for (const mode of ["type", "status", "brain"] as V3Mode[]) {
      const { neighbors, L } = get(mode);
      let cross = 0;
      for (let a = 0; a < neighbors.length; a++) for (const b of neighbors[a]) if (b > a && L.unitOf[a] !== L.unitOf[b]) cross++;
      const total = L.bundles.reduce((s, b) => s + b.count, 0);
      expect(total).toBe(cross);
      expect(L.bundles.length).toBeLessThan(cross);
    }
  });
});

describe("v3 brain — anatomy and lobe balance", () => {
  it("every brain node lies inside the brain, off the longitudinal fissure", () => {
    const { nodes, L } = get("brain");
    const S = L.scale;
    for (let i = 0; i < nodes.length; i++) {
      const x = L.target[i * 3] / S, y = L.target[i * 3 + 1] / S, z = L.target[i * 3 + 2] / S;
      expect(brainSdf(x, y, z)).toBeLessThan(0);
      const lobe = lobeAt(x, y, z);
      if (lobe !== "brainstem") expect(Math.abs(x)).toBeGreaterThan(FISSURE);
    }
  });
  it("nodes sit in the lobe their region names", () => {
    const { nodes, L } = get("brain");
    const S = L.scale;
    let ok = 0;
    for (let i = 0; i < nodes.length; i++) {
      const rg = L.regions[L.regionOf[i]];
      if (lobeAt(L.target[i * 3] / S, L.target[i * 3 + 1] / S, L.target[i * 3 + 2] / S) === rg.lobe) ok++;
    }
    expect(ok / nodes.length).toBeGreaterThan(0.85);
  });
  it("the fissure gap is empty tissue-wise and the hemispheres are mirror images", () => {
    for (let y = -0.4; y <= 0.55; y += 0.05)
      for (let z = -0.9; z <= 0.9; z += 0.05) {
        expect(sdCerebrum(0, y, z)).toBeGreaterThan(0);
        expect(sdCerebrum(FISSURE * 0.6, y, z)).toBeGreaterThan(0);
        expect(sdCerebrum(0.3, y, z)).toBeCloseTo(sdCerebrum(-0.3, y, z), 9);
      }
  });
  it("the brain is longer front-to-back than wide, wider than tall (a brain, not a sphere)", () => {
    let x1 = 0, y0 = 0, y1 = 0, z0 = 0, z1 = 0;
    const { min, max } = BRAIN_BOUNDS;
    for (let x = 0; x <= max[0]; x += 0.02)
      for (let y = min[1]; y <= max[1]; y += 0.02)
        for (let z = min[2]; z <= max[2]; z += 0.04) {
          if (sdCerebrum(x, y, z) >= 0) continue;
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          z0 = Math.min(z0, z);
          z1 = Math.max(z1, z);
        }
    const length = z1 - z0, width = 2 * x1, height = y1 - y0;
    expect(length / width).toBeGreaterThan(1.1);
    expect(width / height).toBeGreaterThan(1.05);
  });
  it("has all four cerebral lobes plus cerebellum and brainstem as regions of one shape", () => {
    const seen = new Set<string>();
    for (let x = -0.85; x <= 0.85; x += 0.05)
      for (let y = -1; y <= 0.6; y += 0.05)
        for (let z = -1; z <= 1; z += 0.05) if (brainSdf(x, y, z) < 0) seen.add(lobeAt(x, y, z));
    expect([...seen].sort()).toEqual(["brainstem", "cerebellum", "frontal", "occipital", "parietal", "temporal"]);
  });
  it("balances lobe capacity: max/min cerebral occupancy stays bounded", () => {
    for (const tasks of [false, true]) {
      const occ = Object.values(lobeOccupancy(get("brain", tasks).L));
      expect(Math.max(...occ) / Math.min(...occ)).toBeLessThan(2.2);
    }
  });
});

describe("v3 packing primitives", () => {
  it("ringPack keeps neighbours ≥ pad apart for mixed radii", () => {
    const radii = [17, ...Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 6 : 3.6))];
    const { pts } = ringPack(radii, NODE_PAD);
    for (let i = 0; i < radii.length; i++)
      for (let j = i + 1; j < radii.length; j++)
        expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) - radii[i] - radii[j]).toBeGreaterThanOrEqual(NODE_PAD - 1e-6);
  });
  it("shellPack keeps neighbours ≥ pad apart in 3D", () => {
    const radii = [15, ...Array.from({ length: 300 }, () => 3)];
    const { pts } = shellPack(radii, NODE_PAD);
    for (let i = 0; i < radii.length; i++)
      for (let j = i + 1; j < radii.length; j++)
        expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]) - radii[i] - radii[j]).toBeGreaterThanOrEqual(NODE_PAD - 1e-6);
  });
  it("packCircles honours per-circle gaps and fills a wide ellipse", () => {
    const radii = Array.from({ length: 80 }, (_, i) => 10 + ((i * 37) % 60));
    const gaps = radii.map((r) => 10 + r * 0.2);
    const pos = packCircles(radii, gaps, 2);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < radii.length; i++) {
      x0 = Math.min(x0, pos[i][0] - radii[i]);
      x1 = Math.max(x1, pos[i][0] + radii[i]);
      y0 = Math.min(y0, pos[i][1] - radii[i]);
      y1 = Math.max(y1, pos[i][1] + radii[i]);
      for (let j = i + 1; j < radii.length; j++)
        expect(Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]) - radii[i] - radii[j]).toBeGreaterThanOrEqual(Math.max(gaps[i], gaps[j]) - 1e-6);
    }
    expect((x1 - x0) / (y1 - y0)).toBeGreaterThan(1.4);
  });
});

describe("v3 project mode hierarchy", () => {
  it("sub-projects share their top-level parent's zone", () => {
    const { nodes, L } = get("project");
    let checked = 0;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i].parent;
      if (p == null) continue;
      expect(L.regionOf[i]).toBe(L.regionOf[p]);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});
