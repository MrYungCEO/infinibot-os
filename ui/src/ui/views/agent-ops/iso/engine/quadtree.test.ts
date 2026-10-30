/**
 * Quadtree correctness + benchmark-vs-linear tests.
 *
 * Correctness is checked against the linear-scan reference (the quadtree must
 * return exactly the same set for every query). The benchmark asserts the
 * quadtree out-performs linear scan once the world is large (>500 items),
 * which is the whole reason it exists.
 */

import { describe, expect, it } from "vitest";
import {
  Quadtree,
  linearQueryRect,
  pointInRect,
  type QuadtreeItem,
  type Rect,
} from "./quadtree";
import { Rng } from "./determinism";

interface Agent extends QuadtreeItem {
  id: number;
}

const WORLD: Rect = { x: 0, y: 0, w: 1000, h: 1000 };

function makeAgents(n: number, seed = 1234): Agent[] {
  const rng = new Rng(seed);
  const out: Agent[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: i, x: rng.range(0, 1000), y: rng.range(0, 1000) });
  }
  return out;
}

const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;

describe("Quadtree", () => {
  it("queryRect matches linear scan for random queries", () => {
    const agents = makeAgents(600);
    const qt = new Quadtree<Agent>(WORLD, { capacity: 8 });
    for (const a of agents) qt.insert(a);

    const rng = new Rng(42);
    for (let q = 0; q < 50; q++) {
      const rect: Rect = {
        x: rng.range(0, 800),
        y: rng.range(0, 800),
        w: rng.range(20, 200),
        h: rng.range(20, 200),
      };
      const got = qt.queryRect(rect).sort(byId);
      const want = linearQueryRect(agents, rect).sort(byId);
      expect(got).toEqual(want);
    }
  });

  it("queryCircle returns exactly the points within the radius", () => {
    const agents = makeAgents(500, 99);
    const qt = new Quadtree<Agent>(WORLD);
    for (const a of agents) qt.insert(a);

    const cx = 500;
    const cy = 500;
    const r = 120;
    const got = qt.queryCircle(cx, cy, r).sort(byId);
    const want = agents
      .filter((a) => (a.x - cx) ** 2 + (a.y - cy) ** 2 <= r * r)
      .sort(byId);
    expect(got).toEqual(want);
  });

  it("remove() drops items and reflects in subsequent queries", () => {
    const agents = makeAgents(200);
    const qt = new Quadtree<Agent>(WORLD);
    for (const a of agents) qt.insert(a);
    expect(qt.size).toBe(200);

    const victim = agents[0];
    expect(qt.remove(victim)).toBe(true);
    expect(qt.remove(victim)).toBe(false); // already gone
    expect(qt.size).toBe(199);

    const all = qt.queryRect(WORLD);
    expect(all.find((a) => a.id === victim.id)).toBeUndefined();
    expect(all.length).toBe(199);
  });

  it("rebuild() picks up in-place position mutations", () => {
    const agents = makeAgents(100);
    const qt = new Quadtree<Agent>(WORLD);
    for (const a of agents) qt.insert(a);

    // Teleport everyone into a tiny corner, then rebuild.
    for (const a of agents) {
      a.x = 5;
      a.y = 5;
    }
    qt.rebuild();
    const corner = qt.queryRect({ x: 0, y: 0, w: 10, h: 10 });
    expect(corner.length).toBe(100);
    const far = qt.queryRect({ x: 500, y: 500, w: 100, h: 100 });
    expect(far.length).toBe(0);
  });

  it("keeps out-of-bounds points queryable instead of dropping them", () => {
    const qt = new Quadtree<Agent>(WORLD);
    const stray: Agent = { id: 1, x: -50, y: -50 };
    qt.insert(stray);
    expect(qt.size).toBe(1);
    const got = qt.queryRect({ x: -100, y: -100, w: 100, h: 100 });
    expect(got).toEqual([stray]);
  });

  it("is faster than linear scan for >500 items (many queries)", () => {
    const N = 2000;
    const QUERIES = 2000;
    const agents = makeAgents(N, 7);
    const qt = new Quadtree<Agent>(WORLD, { capacity: 8 });
    for (const a of agents) qt.insert(a);

    const rng = new Rng(11);
    const rects: Rect[] = [];
    for (let i = 0; i < QUERIES; i++) {
      rects.push({
        x: rng.range(0, 950),
        y: rng.range(0, 950),
        w: 40,
        h: 40,
      });
    }

    // Warm both paths so JIT isn't the differentiator.
    for (let i = 0; i < 50; i++) {
      qt.queryRect(rects[i]);
      linearQueryRect(agents, rects[i]);
    }

    const tLinear0 = performance.now();
    let linSum = 0;
    for (const r of rects) linSum += linearQueryRect(agents, r).length;
    const tLinear = performance.now() - tLinear0;

    const tQt0 = performance.now();
    let qtSum = 0;
    const out: Agent[] = [];
    for (const r of rects) {
      out.length = 0;
      qtSum += qt.queryRect(r, out).length;
      out.length = 0;
    }
    const tQt = performance.now() - tQt0;

    expect(qtSum).toBe(linSum); // same answers
    // Quadtree should win decisively; allow generous slack for CI noise.
    expect(tQt).toBeLessThan(tLinear);
    // eslint-disable-next-line no-console
    console.log(
      `[quadtree bench] N=${N} queries=${QUERIES}  linear=${tLinear.toFixed(1)}ms  quadtree=${tQt.toFixed(1)}ms  speedup=${(tLinear / tQt).toFixed(1)}×`,
    );
  });

  it("pointInRect is half-open on the far edges", () => {
    const r: Rect = { x: 0, y: 0, w: 10, h: 10 };
    expect(pointInRect(0, 0, r)).toBe(true);
    expect(pointInRect(9.99, 9.99, r)).toBe(true);
    expect(pointInRect(10, 10, r)).toBe(false);
  });
});
