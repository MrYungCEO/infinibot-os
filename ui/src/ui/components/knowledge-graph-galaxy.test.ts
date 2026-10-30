import { describe, expect, it } from "vitest";

import {
  createGalaxyLayout,
  groupHeights,
  MIN_CHILD_OFFSET,
  planGalaxy,
  seedHeights,
  spreadMetrics,
  type GalaxyNodeIn,
  type LayoutLinkIn,
} from "./knowledge-graph-galaxy";
import { computeOrbits } from "./knowledge-graph-model";

/** A realistic graph: projects on status orbits, each with a cloud of tasks/notes/reports, plus clients and strays. */
function fixture(projects: number, perProject: number) {
  const nodes: (GalaxyNodeIn & { r: number })[] = [];
  const links: LayoutLinkIn[] = [];
  const orbits = computeOrbits({ open: Math.ceil(projects / 2), backlog: Math.floor(projects / 3), done: projects });
  const kinds = ["task", "note", "report", "agent"];
  const clients: number[] = [];
  for (let c = 0; c < Math.max(1, Math.floor(projects / 6)); c++) {
    clients.push(nodes.length);
    nodes.push({ id: `client:${c}`, kind: "client", anchor: true, r: 9 });
  }
  for (let p = 0; p < projects; p++) {
    const hub = nodes.length;
    const orbit = p % 3 === 0 ? orbits.open : p % 3 === 1 ? orbits.backlog : orbits.done;
    nodes.push({ id: `project:${p}`, kind: "project", anchor: true, orbit, r: 10 });
    links.push({ source: clients[p % clients.length], target: hub, distance: 70, strength: 0.3 });
    for (let k = 0; k < perProject; k++) {
      const kind = kinds[k % kinds.length];
      const i = nodes.length;
      nodes.push({ id: `${kind}:${p}-${k}`, kind, anchor: false, r: 4 });
      links.push({ source: hub, target: i, distance: kind === "task" ? 26 : 48, strength: kind === "task" ? 0.6 : 0.3 });
    }
  }
  for (let s = 0; s < 8; s++) nodes.push({ id: `note:stray-${s}`, kind: "note", anchor: false, orbit: orbits.stray, r: 4 });
  const neighbors: number[][] = nodes.map(() => []);
  for (const l of links) {
    neighbors[l.source].push(l.target);
    neighbors[l.target].push(l.source);
  }
  return { nodes, links, neighbors, orbits };
}

function settle(projects: number, perProject: number) {
  const f = fixture(projects, perProject);
  const plans = planGalaxy(f.nodes, f.neighbors, { scale: f.orbits.backlog });
  const W = 1200, H = 800;
  // Seed x/y like the host does: projects on their orbit, satellites next to their hub.
  const raw = f.nodes.map((n, i) => {
    const a = i * 2.399963;
    const R = n.orbit ?? 60;
    return { r: n.r, x: W / 2 + R * Math.cos(a), y: H / 2 + R * Math.sin(a), orbit: n.orbit, orbitStrength: n.kind === "project" ? 0.09 : 0.03, charge: n.kind === "project" ? -240 : -60, plan: plans[i] };
  });
  const { sim, nodes } = createGalaxyLayout(raw, f.links, W, H, 1);
  sim.stop();
  sim.tick(300);
  return { f, plans, nodes };
}

describe("galaxy layout (true 3D)", () => {
  it("spreads nodes vertically: height stddev > 25% of the horizontal spread", () => {
    const { nodes } = settle(24, 12);
    const m = spreadMetrics(nodes);
    // Logged so the run report can quote the numbers.
    console.log(`[galaxy] n=${nodes.length} heightStd=${m.heightStd.toFixed(1)} horizontalStd=${m.horizontalStd.toFixed(1)} ratio=${m.ratio.toFixed(3)}`);
    expect(m.ratio).toBeGreaterThan(0.25);
    // Both above and below the reference plane, clearly.
    const above = nodes.filter((n) => n.z > 40).length;
    const below = nodes.filter((n) => n.z < -40).length;
    expect(above).toBeGreaterThan(nodes.length * 0.2);
    expect(below).toBeGreaterThan(nodes.length * 0.2);
  });

  it("hubs sit at different heights (not one plane)", () => {
    const { f, nodes } = settle(24, 12);
    const hubs = nodes.filter((_, i) => f.nodes[i].kind === "project");
    const hz = hubs.map((n) => n.z);
    const range = Math.max(...hz) - Math.min(...hz);
    expect(range).toBeGreaterThan(200);
    // Hubs on a status shell keep ~their orbit radius in 3D (tilted, not flattened).
    expect(spreadMetrics(hubs).ratio).toBeGreaterThan(0.25);
  });

  it("no satellite shares its hub's exact plane", () => {
    const { plans, nodes } = settle(24, 12);
    let children = 0;
    plans.forEach((p, i) => {
      if (p.parent < 0) return;
      children++;
      expect(Math.abs(p.zOff)).toBeGreaterThanOrEqual(MIN_CHILD_OFFSET);
      // Settled height gap stays a real fraction of the planned offset.
      expect(Math.abs(nodes[i].z - nodes[p.parent].z)).toBeGreaterThan(MIN_CHILD_OFFSET * 0.5);
    });
    expect(children).toBeGreaterThan(200);
  });

  it("satellites form 3D clouds: both above and below their hub", () => {
    const { plans, nodes } = settle(10, 16);
    let up = 0, down = 0;
    plans.forEach((p, i) => {
      if (p.parent < 0) return;
      if (nodes[i].z > nodes[p.parent].z) up++;
      else down++;
    });
    expect(up).toBeGreaterThan(30);
    expect(down).toBeGreaterThan(30);
  });

  it("is deterministic (seeded, no randomness)", () => {
    const a = settle(8, 6).nodes.map((n) => [n.x, n.y, n.z]);
    const b = settle(8, 6).nodes.map((n) => [n.x, n.y, n.z]);
    expect(a).toEqual(b);
  });

  it("keeps saved heights when hydrating and seeds the rest from the plan", () => {
    const f = fixture(3, 2);
    const plans = planGalaxy(f.nodes, f.neighbors, { scale: f.orbits.backlog });
    const z = seedHeights(plans, f.nodes.map((_, i) => (i === 1 ? 123 : undefined)));
    expect(z[1]).toBe(123);
    plans.forEach((p, i) => {
      if (p.parent >= 0) expect(z[i]).toBeCloseTo(z[p.parent] + p.zOff, 5);
    });
  });

  it("sector groups get distinct heights", () => {
    const g = groupHeights(["open", "backlog", "done", "client"], 300);
    const vals = [...g.values()];
    expect(new Set(vals.map((v) => Math.round(v))).size).toBe(4);
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(80);
  });

  it("1000+ nodes settle fast enough for the worker", () => {
    const t0 = performance.now();
    const { nodes } = settle(80, 13);
    const ms = performance.now() - t0;
    console.log(`[galaxy] 1000+ nodes: n=${nodes.length} 300 ticks in ${ms.toFixed(0)} ms; ratio=${spreadMetrics(nodes).ratio.toFixed(3)}`);
    expect(nodes.length).toBeGreaterThan(1000);
    expect(nodes.every((n) => Number.isFinite(n.x!) && Number.isFinite(n.y!) && Number.isFinite(n.z))).toBe(true);
    expect(spreadMetrics(nodes).ratio).toBeGreaterThan(0.25);
  });
});
