import { describe, expect, it } from "vitest";
import {
  DEGREE_K,
  DEGREE_MAX,
  MAX_NODE_R,
  degreeScale,
  enforceParentSize,
  hierarchyRadius,
  labelScaleFor,
  nodeRadius,
  type GraphNodeKind,
} from "./knowledge-graph-model";
import { REL_STYLES, linkAlpha, linkStyle, linkWidth, relClassOf, type LinkVisIn } from "./knowledge-graph-links";

describe("size by connections", () => {
  it("degree scale is monotonic, sub-linear and clamped", () => {
    let prev = 0;
    for (let d = 0; d <= 500; d++) {
      const f = degreeScale(d);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(degreeScale(0)).toBe(1);
    expect(degreeScale(1)).toBeCloseTo(1 + DEGREE_K, 5);
    // Sub-linear: each extra connection adds less than the one before, and f(2d) < 2·f(d).
    for (let d = 0; d < 60; d++) {
      expect(degreeScale(d + 2) - degreeScale(d + 1)).toBeLessThanOrEqual(degreeScale(d + 1) - degreeScale(d) + 1e-12);
      expect(degreeScale(2 * d + 2)).toBeLessThan(2 * degreeScale(d + 1));
    }
    expect(degreeScale(10_000)).toBe(DEGREE_MAX);
    expect(degreeScale(-5)).toBe(1);
    expect(degreeScale(Number.NaN)).toBe(1);
  });

  it("node radius is monotonic in degree and never below the hierarchy floor", () => {
    const kinds: GraphNodeKind[] = ["project", "task", "note", "client", "agent", "report"];
    for (const kind of kinds) {
      for (const depth of [0, 1, 2]) {
        let prev = 0;
        for (let d = 0; d < 300; d += 3) {
          const r = nodeRadius({ kind, depth, weight: 0.5, degree: d, hub: false });
          expect(r).toBeGreaterThanOrEqual(prev);
          expect(r).toBeGreaterThanOrEqual(hierarchyRadius(kind, depth, 0.5));
          prev = r;
        }
      }
    }
  });

  it("is clamped: the busiest hub stays bounded", () => {
    const r = nodeRadius({ kind: "project", depth: 0, weight: 1, degree: 100_000, hub: true });
    expect(r).toBeLessThanOrEqual(MAX_NODE_R);
    const leaf = nodeRadius({ kind: "task", depth: 0, weight: 1, degree: 100_000, hub: false });
    expect(leaf).toBeLessThanOrEqual(MAX_NODE_R * 0.5);
  });

  it("hubs (parent projects) get the extra multiplier", () => {
    const plain = nodeRadius({ kind: "project", depth: 0, weight: 0.5, degree: 5, hub: false });
    const hub = nodeRadius({ kind: "project", depth: 0, weight: 0.5, degree: 5, hub: true });
    expect(hub).toBeGreaterThan(plain);
    // Only projects are hubs.
    expect(nodeRadius({ kind: "note", depth: 0, weight: 0.5, degree: 5, hub: true })).toBe(
      nodeRadius({ kind: "note", depth: 0, weight: 0.5, degree: 5, hub: false }),
    );
  });

  it("a busy hub is clearly bigger than a quiet top-level project", () => {
    const quiet = nodeRadius({ kind: "project", depth: 0, weight: 0.5, degree: 1, hub: false });
    const busy = nodeRadius({ kind: "project", depth: 0, weight: 0.5, degree: 119, hub: true });
    expect(busy / quiet).toBeGreaterThan(1.8);
  });

  it("parent ≥ children, even when a sub-project is busier than its parent", () => {
    // 0 = parent (quiet), 1 = busy child, 2 = grandchild busier still.
    const radii = [
      nodeRadius({ kind: "project", depth: 0, weight: 0.5, degree: 1, hub: true }),
      nodeRadius({ kind: "project", depth: 1, weight: 0.5, degree: 400, hub: true }),
      nodeRadius({ kind: "project", depth: 2, weight: 0.5, degree: 800, hub: true }),
    ];
    enforceParentSize(radii, [-1, 0, 1], [0, 1, 2]);
    expect(radii[0]).toBeGreaterThanOrEqual(radii[1]);
    expect(radii[1]).toBeGreaterThanOrEqual(radii[2]);
    expect(radii[0]).toBeLessThanOrEqual(MAX_NODE_R * 1.25);
  });

  it("label scale grows with radius and is clamped", () => {
    expect(labelScaleFor(3)).toBe(1);
    expect(labelScaleFor(30)).toBeGreaterThan(labelScaleFor(15));
    expect(labelScaleFor(500)).toBeLessThanOrEqual(1.65);
  });
});

describe("link-style mapping", () => {
  it("classifies relation labels", () => {
    expect(relClassOf("sub-project of")).toBe("hierarchy");
    expect(relClassOf("contains")).toBe("tasks");
    expect(relClassOf("has task")).toBe("tasks");
    expect(relClassOf("client of")).toBe("client");
    expect(relClassOf("relates to")).toBe("relates");
    expect(relClassOf("report documents project")).toBe("report");
    expect(relClassOf("about")).toBe("about");
    expect(relClassOf("running")).toBe("activity");
    expect(relClassOf("relates to", true)).toBe("inferred");
    expect(relClassOf("something odd")).toBe("other");
  });

  it("parent → child is the thickest relation; every class has a distinct colour", () => {
    const widths = Object.values(REL_STYLES).map((s) => s.width);
    expect(REL_STYLES.hierarchy.width).toBe(Math.max(...widths));
    expect(new Set(Object.values(REL_STYLES).map((s) => s.color)).size).toBe(Object.keys(REL_STYLES).length);
    expect(linkStyle("sub-project of").width).toBeGreaterThan(linkStyle("relates to").width);
  });

  it("width follows weight, thins with density, never below 0.8 px", () => {
    const st = REL_STYLES.relates;
    expect(linkWidth(st, 2)).toBeGreaterThan(linkWidth(st, 0.5));
    expect(linkWidth(st, 1, 1)).toBeLessThan(linkWidth(st, 1, 0));
    expect(linkWidth(REL_STYLES.inferred, 0, 1)).toBeGreaterThanOrEqual(0.8);
  });

  it("connections mode + focus+context alpha", () => {
    const base: LinkVisIn = {
      mode: "all",
      focused: false,
      hasFocus: false,
      inNeighbourhood: false,
      style: REL_STYLES.relates,
      emphasis: 1,
      cross: false,
      hubDamp: 1,
      density: 0,
    };
    const all = linkAlpha(base);
    expect(all).toBeGreaterThan(0.4);
    expect(all).toBeLessThan(1); // glow budget: unfocused links never full white
    expect(linkAlpha({ ...base, focused: true, hasFocus: true })).toBe(1);
    // Focus dims the rest, keeps neighbour↔neighbour readable.
    expect(linkAlpha({ ...base, hasFocus: true })).toBeLessThan(0.06);
    expect(linkAlpha({ ...base, hasFocus: true, inNeighbourhood: true })).toBeGreaterThan(0.2);
    // Selected-only mode: nothing without a focus.
    expect(linkAlpha({ ...base, mode: "selected" })).toBe(0);
    expect(linkAlpha({ ...base, mode: "selected", focused: true, hasFocus: true })).toBe(1);
    // None hides everything, even the focus.
    expect(linkAlpha({ ...base, mode: "none", focused: true, hasFocus: true })).toBe(0);
    // Cross-cluster + mega-hub damping lower it.
    expect(linkAlpha({ ...base, cross: true })).toBeLessThan(all);
    expect(linkAlpha({ ...base, hubDamp: 0.3 })).toBeLessThan(all);
  });
});

describe("hub gap (family members orbit clear of a big hub)", () => {
  it("first ring/shell sits at least hubGap beyond the hub's edge", async () => {
    const { ringPack, shellPack, NODE_PAD } = await import("./knowledge-graph-layout-v3");
    const radii = [40, 8, 8, 8, 8, 8, 8];
    for (const { pts } of [ringPack(radii, NODE_PAD, 0, 36), shellPack(radii, NODE_PAD, 0, 36)]) {
      for (let k = 1; k < pts.length; k++) {
        const d = Math.hypot(...(pts[k] as number[]));
        expect(d).toBeGreaterThanOrEqual(40 + 36 + 8 - 1e-6);
      }
    }
    // Default (no gap) keeps the tight packing.
    const tight = ringPack(radii, NODE_PAD).pts;
    expect(Math.hypot(...(tight[1] as number[]))).toBeCloseTo(40 + NODE_PAD + 8, 5);
  });
});
