import { describe, expect, it } from "vitest";

import {
  brainRegions,
  ellipsoidRho,
  FISSURE,
  insideBrain,
  KIND_LOBE,
  layoutBrain,
  LOBES,
  type BrainNodeIn,
} from "./knowledge-graph-brain";
import { createGalaxyLayout, spreadMetrics } from "./knowledge-graph-galaxy";
import type { GraphNodeKind } from "./knowledge-graph-model";

/** Live-like graph: lots of projects (mixed health), clients, notes, reports, agents, a federation node, orphans. */
function fixture(projects = 120, perProject = 3) {
  const nodes: BrainNodeIn[] = [];
  const links: Array<[number, number]> = [];
  const health = ["active", "backlog", "backlog", "backlog", "done", "at_risk", "blocked"];
  const add = (n: BrainNodeIn) => nodes.push(n) - 1;
  const clients = Array.from({ length: 12 }, (_, c) => add({ id: `client:${c}`, kind: "client", anchor: true }));
  for (let p = 0; p < projects; p++) {
    const hub = add({ id: `project:${p}`, kind: "project", anchor: true, meta: { status: health[p % health.length], health: health[p % health.length] } });
    if (p % 4 === 0) links.push([clients[p % clients.length], hub]);
    for (let k = 0; k < perProject; k++) {
      const kind: GraphNodeKind = (["note", "task", "report"] as const)[k % 3];
      links.push([hub, add({ id: `${kind}:${p}-${k}`, kind, anchor: false })]);
    }
  }
  for (let i = 0; i < 40; i++) add({ id: `note:orphan-${i}`, kind: "note", anchor: false });
  for (let i = 0; i < 10; i++) add({ id: `report:r-${i}`, kind: "report", anchor: false });
  const agents = Array.from({ length: 14 }, (_, i) => add({ id: `agent:${i}`, kind: "agent", anchor: false }));
  for (let i = 0; i < 6; i++) links.push([agents[i], add({ id: `run:${i}`, kind: "run", anchor: false })]);
  add({ id: "node:master", kind: "node", anchor: false });
  add({ id: "user:system", kind: "user", anchor: false });
  const neighbors: number[][] = nodes.map(() => []);
  for (const [a, b] of links) {
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  return { nodes, links, neighbors };
}

const pt = (t: Float32Array, i: number): [number, number, number] => [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];

describe("brain lobe mapping", () => {
  it("documents a lobe for every graph kind", () => {
    const ids = new Set(LOBES.map((l) => l.id));
    for (const l of Object.values(KIND_LOBE)) expect(ids.has(l)).toBe(true);
    expect(KIND_LOBE.project).toBe("frontal");
    expect(KIND_LOBE.task).toBe("parietal");
    expect(KIND_LOBE.note).toBe("temporal");
    expect(KIND_LOBE.report).toBe("occipital");
    expect(KIND_LOBE.agent).toBe("cerebellum");
    expect(KIND_LOBE.node).toBe("brainstem");
  });

  it("places free nodes in their kind's lobe and satellites with their hub", () => {
    const f = fixture();
    const b = layoutBrain(f.nodes, f.neighbors);
    const lobe = (i: number) => b.regionOf[i].split(":")[0];
    f.nodes.forEach((n, i) => {
      if (b.parent[i] >= 0) expect(b.regionOf[i]).toBe(b.regionOf[b.parent[i]]);
      else if (n.kind !== "project") expect(lobe(i)).toBe(KIND_LOBE[n.kind as GraphNodeKind]);
    });
    // A satellite note sits in its project's lobe, an orphan note in the temporal lobe.
    expect(lobe(f.nodes.findIndex((n) => n.id === "note:orphan-0"))).toBe("temporal");
    expect(lobe(f.nodes.findIndex((n) => n.id === "agent:0"))).toBe("cerebellum");
    expect(lobe(f.nodes.findIndex((n) => n.id === "node:master"))).toBe("brainstem");
  });

  it("spills projects out of an overloaded frontal lobe by health (open work stays frontal)", () => {
    const f = fixture(200, 3);
    const b = layoutBrain(f.nodes, f.neighbors);
    const lobes = new Map<string, number>();
    f.nodes.forEach((n, i) => {
      if (n.kind !== "project") return;
      const l = b.regionOf[i].split(":")[0];
      lobes.set(l, (lobes.get(l) ?? 0) + 1);
    });
    expect(lobes.size).toBeGreaterThan(1);
    const active = f.nodes.findIndex((n) => n.id === "project:0"); // active
    expect(b.regionOf[active].startsWith("frontal")).toBe(true);
    const frontalShare = (lobes.get("frontal") ?? 0) / 200;
    expect(frontalShare).toBeLessThan(0.75);
  });
});

describe("brain shape", () => {
  const f = fixture();
  const b = layoutBrain(f.nodes, f.neighbors);
  const S = b.scale;

  it("every target lies inside its lobe and inside the brain silhouette", () => {
    const regions = new Map(brainRegions(S).map((r) => [r.key, r]));
    for (let i = 0; i < f.nodes.length; i++) {
      const p = pt(b.target, i);
      const rg = regions.get(b.regionOf[i])!;
      expect(ellipsoidRho(p, rg.c, rg.r)).toBeLessThanOrEqual(1.06);
      expect(insideBrain(p, S, 1.06)).toBe(true);
    }
  });

  it("populates both hemispheres and leaves a gap at the midline", () => {
    let left = 0, right = 0, inGap = 0;
    for (let i = 0; i < f.nodes.length; i++) {
      const lobe = b.regionOf[i].split(":")[0];
      if (lobe === "brainstem") continue; // only the brainstem sits on the midline
      const x = b.target[i * 3];
      if (x < 0) left++;
      else right++;
      if (Math.abs(x) < FISSURE * S * 0.99) inGap++;
    }
    expect(left).toBeGreaterThan(80);
    expect(right).toBeGreaterThan(80);
    expect(Math.abs(left - right) / (left + right)).toBeLessThan(0.25);
    expect(inGap).toBe(0);
  });

  it("is a brain silhouette: longer front-to-back than tall, cerebellum low at the back, brainstem below", () => {
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < f.nodes.length; i++) {
      xs.push(b.target[i * 3]);
      ys.push(b.target[i * 3 + 1]);
      zs.push(b.target[i * 3 + 2]);
    }
    const range = (a: number[]) => Math.max(...a) - Math.min(...a);
    expect(range(zs)).toBeGreaterThan(range(ys) * 1.05);
    const cb = f.nodes.findIndex((n) => n.id === "agent:0");
    const stem = f.nodes.findIndex((n) => n.id === "node:master");
    expect(b.target[cb * 3 + 1]).toBeLessThan(-0.2 * S); // low
    expect(b.target[cb * 3 + 2]).toBeLessThan(-0.3 * S); // back
    expect(b.target[stem * 3 + 1]).toBeLessThan(-0.45 * S); // below
  });

  it("has a non-trivial height spread and is denser near the lobe surfaces", () => {
    const pts = Array.from({ length: f.nodes.length }, (_, i) => ({ x: b.target[i * 3], y: b.target[i * 3 + 2], z: b.target[i * 3 + 1] }));
    const m = spreadMetrics(pts);
    console.log(`[brain] targets n=${pts.length} heightStd=${m.heightStd.toFixed(1)} horizontalStd=${m.horizontalStd.toFixed(1)} ratio=${m.ratio.toFixed(3)} S=${S.toFixed(0)}`);
    expect(m.ratio).toBeGreaterThan(0.25);
    const regions = new Map(brainRegions(S).map((r) => [r.key, r]));
    let outer = 0, inner = 0;
    for (let i = 0; i < f.nodes.length; i++) {
      if (b.parent[i] >= 0 || b.orphan[i]) continue; // orphans live in the sparse core by design
      const rg = regions.get(b.regionOf[i])!;
      const rho = ellipsoidRho(pt(b.target, i), rg.c, rg.r);
      if (rho > 0.6) outer++;
      else inner++;
    }
    // Outer shell (ρ>0.6) is ~78% of an ellipsoid's volume; cortex bias puts clearly more there.
    expect(outer / (outer + inner)).toBeGreaterThan(0.85);
  });

  it("is deterministic", () => {
    const again = layoutBrain(f.nodes, f.neighbors);
    expect(Array.from(again.target)).toEqual(Array.from(b.target));
    expect(again.regionOf).toEqual(b.regionOf);
  });

  it("keeps the brain shape after the force simulation settles (1000+ nodes)", () => {
    const big = fixture(320, 2);
    const bl = layoutBrain(big.nodes, big.neighbors);
    const W = 1200, H = 800;
    const raw = big.nodes.map((n, i) => ({
      r: n.anchor ? 9 : 4,
      x: W / 2 + bl.target[i * 3],
      y: H / 2 + bl.target[i * 3 + 2],
      z: bl.target[i * 3 + 1],
      charge: -10,
      gx: W / 2 + bl.target[i * 3],
      gy: H / 2 + bl.target[i * 3 + 2],
      gs: 0.25,
      plan: { gz: bl.target[i * 3 + 1], parent: -1, zOff: 0, zs: 0.25 },
    }));
    const t0 = performance.now();
    const { sim, nodes } = createGalaxyLayout(
      raw,
      big.links.map(([s, t]) => ({ source: s, target: t, distance: 30, strength: 0.05 })),
      W,
      H,
      1,
      { centerStrength: 0, chargeRange: 60 },
    );
    sim.stop();
    sim.tick(200);
    const ms = performance.now() - t0;
    let outside = 0, left = 0, right = 0;
    for (const nd of nodes) {
      const p: [number, number, number] = [nd.x! - W / 2, nd.z, nd.y! - H / 2];
      if (!insideBrain(p, bl.scale, 1.15)) outside++;
      if (p[0] < 0) left++;
      else right++;
    }
    const m = spreadMetrics(nodes.map((nd) => ({ x: nd.x, y: nd.y, z: nd.z })));
    console.log(`[brain] settled n=${nodes.length} in ${ms.toFixed(0)} ms; outside=${outside}; ratio=${m.ratio.toFixed(3)}`);
    expect(nodes.length).toBeGreaterThan(1000);
    expect(outside / nodes.length).toBeLessThan(0.02);
    expect(Math.min(left, right)).toBeGreaterThan(nodes.length * 0.3);
    expect(m.ratio).toBeGreaterThan(0.25);
  });
});

describe("brain grouping mode", () => {
  it("groups nodes by lobe region and carries the brain targets", async () => {
    const { computeGrouping, GROUP_MODES } = await import("./knowledge-graph-ops");
    expect(GROUP_MODES[0].id).toBe("brain");
    const f = fixture(20, 2);
    const ops = f.nodes.map((n) => ({ id: n.id, kind: n.kind as GraphNodeKind, label: n.id, meta: n.meta }));
    const edges = f.links.map(([a, b]) => ({ source: f.nodes[a].id, target: f.nodes[b].id, rel: "contains" }));
    const g = computeGrouping(ops, edges, "brain");
    expect(g.brain).toBeDefined();
    expect(g.groups.map((x) => x.key)).toEqual(brainRegions(g.brain!.scale).map((r) => r.key));
    expect(g.groups.reduce((a, x) => a + x.memberIds.length, 0)).toBe(f.nodes.length);
    expect(g.groupOf.get("agent:0")).toMatch(/^cerebellum:[LR]$/);
  });
});

describe("brain clusters, orphans and hierarchy", () => {
  /** Projects with sub-projects + leaves, plus a pile of orphans. */
  function families() {
    const nodes: BrainNodeIn[] = [];
    const links: Array<[number, number]> = [];
    const add = (n: BrainNodeIn) => nodes.push(n) - 1;
    for (let p = 0; p < 60; p++) {
      const hub = add({ id: `project:${p}`, kind: "project", anchor: true, meta: { health: p % 3 ? "backlog" : "active" } });
      const subs = p % 4 === 0 ? 2 : 0;
      for (let s = 0; s < subs; s++) {
        const sub = add({ id: `project:${p}.${s}`, kind: "project", anchor: true, parent: hub });
        links.push([sub, hub]);
        for (let k = 0; k < 3; k++) links.push([sub, add({ id: `note:${p}.${s}.${k}`, kind: "note", anchor: false })]);
      }
      for (let k = 0; k < (p % 5) + 1; k++) links.push([hub, add({ id: `report:${p}-${k}`, kind: "report", anchor: false })]);
    }
    for (let i = 0; i < 90; i++) add({ id: `note:orphan-${i}`, kind: "note", anchor: false });
    for (let i = 0; i < 12; i++) add({ id: `report:orphan-${i}`, kind: "report", anchor: false });
    const neighbors: number[][] = nodes.map(() => []);
    for (const [a, b] of links) {
      neighbors[a].push(b);
      neighbors[b].push(a);
    }
    return { nodes, links, neighbors };
  }
  const f = families();
  const b = layoutBrain(f.nodes, f.neighbors);
  const d = (i: number, j: number) => Math.hypot(b.target[i * 3] - b.target[j * 3], b.target[i * 3 + 1] - b.target[j * 3 + 1], b.target[i * 3 + 2] - b.target[j * 3 + 2]);
  const clusters = new Map<number, number[]>();
  f.nodes.forEach((_, i) => {
    if (b.orphan[i]) return;
    (clusters.get(b.family[i]) ?? clusters.set(b.family[i], []).get(b.family[i])!).push(i);
  });
  const linked = [...clusters.values()].filter((m) => m.length >= 2);
  const intra: number[] = [];
  f.nodes.forEach((_, i) => {
    if (b.parent[i] >= 0) intra.push(d(i, b.parent[i]));
  });
  intra.sort((x, y) => x - y);
  const typical = intra[Math.floor(intra.length / 2)];

  it("sub-projects orbit their parent project (same family, close by)", () => {
    f.nodes.forEach((n, i) => {
      if (n.parent == null) return;
      expect(b.parent[i]).toBe(n.parent);
      expect(b.family[i]).toBe(b.family[n.parent]);
      // Close orbit: about one leaf-link plus the sub-project's own cloud.
      expect(d(i, n.parent)).toBeLessThan(typical * 2.2);
    });
  });

  it("keeps unlinked nodes clearly apart from every linked cluster", () => {
    let minGap = Infinity;
    f.nodes.forEach((_, o) => {
      if (!b.orphan[o]) return;
      for (const m of linked) for (const i of m) minGap = Math.min(minGap, d(o, i));
    });
    console.log(`[brain] orphan↔cluster min distance=${minGap.toFixed(1)} typical intra-cluster link=${typical.toFixed(1)} clusters=${linked.length}`);
    expect(minGap).toBeGreaterThan(typical);
  });

  it("has no overlapping clusters", () => {
    const spheres = linked.map((m) => {
      const root = b.family[m[0]];
      let r = 0;
      for (const i of m) r = Math.max(r, d(i, root));
      return { root, r };
    });
    let overlaps = 0;
    for (let a = 0; a < spheres.length; a++)
      for (let c = a + 1; c < spheres.length; c++) {
        if (d(spheres[a].root, spheres[c].root) < spheres[a].r + spheres[c].r) overlaps++;
      }
    expect(overlaps).toBe(0);
  });

  it("orphans sit in their lobe's sparse core, clusters on the cortex", () => {
    const regions = new Map(brainRegions(b.scale).map((r) => [r.key, r]));
    f.nodes.forEach((_, i) => {
      if (b.parent[i] >= 0) return;
      const rg = regions.get(b.regionOf[i])!;
      const rho = ellipsoidRho(pt(b.target, i), rg.c, rg.r);
      if (b.orphan[i]) expect(rho).toBeLessThanOrEqual(0.36);
    });
  });
});
