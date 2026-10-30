import { describe, expect, it } from "vitest";
import {
  beamControl,
  beamPoints,
  bezierPoint,
  clusterLabelAlpha,
  discBasis,
  focusSet,
  frameDirection,
  frameDistance,
  isEdgeHot,
  labelAlpha,
  labelPriority,
  layout3D,
  nodeRadius,
  nodeVisibility,
  qualityFor,
  satelliteOffset,
  teamColor,
  teamTint,
  rgbToHsl,
  hslToRgb,
  lighten,
  TEAM_PALETTE,
  TEAM_STEPS,
  type LayoutInputNode,
} from "./constellation-3d-model";

const roster = (): LayoutInputNode[] => [
  { id: "main", cluster: "core", clusterLabel: "Core", size: 1 },
  { id: "research", cluster: "core", clusterLabel: "Core", size: 0.4 },
  { id: "writer", cluster: "core", clusterLabel: "Core", size: 0.2 },
  { id: "cmo", cluster: "plugin:growth", clusterLabel: "Growth", size: 0.6 },
  { id: "seo", cluster: "plugin:growth", clusterLabel: "Growth", size: 0.1 },
  { id: "cli:codex", cluster: "cli", clusterLabel: "CLI coders", size: 0.5 },
];

describe("layout3D", () => {
  it("is deterministic and keeps clusters apart", () => {
    const a = layout3D(roster());
    const b = layout3D(roster().reverse());
    const dump = (l: ReturnType<typeof layout3D>) =>
      [...l.nodes.values()].sort((x, y) => x.id.localeCompare(y.id)).map((n) => [n.id, n.x, n.y, n.z]);
    expect(dump(a)).toEqual(dump(b));
    expect(a.clusters.map((c) => c.key)).toEqual(["core", "plugin:growth", "cli"]);
    for (let i = 0; i < a.clusters.length; i++) {
      for (let j = i + 1; j < a.clusters.length; j++) {
        const p = a.clusters[i];
        const q = a.clusters[j];
        expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThan(p.r + q.r);
      }
    }
  });

  it("places every node inside its cluster disc and sizes by activity", () => {
    const lay = layout3D(roster());
    for (const n of lay.nodes.values()) {
      const c = lay.clusters.find((cl) => cl.key === n.cluster)!;
      expect(Math.hypot(n.x - c.x, n.y - c.y, n.z - c.z)).toBeLessThanOrEqual(c.r + 1);
      expect(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)).toBe(true);
    }
    expect(lay.nodes.get("main")!.r).toBe(nodeRadius(1));
    expect(lay.nodes.get("seo")!.r).toBe(nodeRadius(0.1));
    expect(lay.nodes.get("main")!.r).toBeGreaterThan(lay.nodes.get("seo")!.r);
    expect(lay.radius).toBeGreaterThan(0);
    // The tight frame covers every agent and is never larger than the cluster extent.
    expect(lay.frame.radius).toBeLessThanOrEqual(lay.radius);
    for (const n of lay.nodes.values()) {
      expect(Math.hypot(n.x - lay.frame.center[0], n.y - lay.frame.center[1], n.z - lay.frame.center[2]) + n.r).toBeLessThanOrEqual(lay.frame.radius + 1e-6);
    }
    for (const c of lay.clusters) {
      expect(Math.hypot(c.x - lay.center[0], c.y - lay.center[1], c.z - lay.center[2]) + c.r).toBeLessThanOrEqual(lay.radius + 1e-6);
      expect(Math.hypot(...c.normal)).toBeCloseTo(1, 6);
      expect(c.normal[1]).toBeGreaterThan(0.9); // discs stay roughly horizontal
    }
  });

  it("handles an empty roster and a single agent", () => {
    expect(layout3D([]).clusters).toEqual([]);
    const one = layout3D([{ id: "x", cluster: "c", clusterLabel: "C", size: 0 }]);
    const x = one.nodes.get("x")!;
    expect(Math.hypot(x.x, x.y, x.z)).toBeLessThan(10); // alone at the cluster centre (tiny lift only)
    expect(one.clusters[0].paletteIndex).toBe(0);
  });

  it("assigns palette slots in layout order", () => {
    const lay = layout3D(roster());
    expect(lay.clusters.map((c) => c.paletteIndex)).toEqual([0, 1, 2]);
    expect(teamColor(0)).toEqual(TEAM_PALETTE[0]);
    expect(teamColor(TEAM_PALETTE.length + 1)).toEqual(TEAM_PALETTE[1]);
    expect(teamColor(-1)).toEqual(TEAM_PALETTE[TEAM_PALETTE.length - 1]);
  });

  it("team tints stay in the accent family and follow the theme primary", () => {
    const gold: [number, number, number] = [251, 191, 36];
    const [h0] = rgbToHsl(gold);
    const tints = TEAM_STEPS.map((_, i) => teamTint(gold, i));
    for (const t of tints) {
      const [h, , l] = rgbToHsl(t);
      expect(Math.abs(((h - h0 + 0.5) % 1) - 0.5)).toBeLessThan(0.05); // within ±18° of the accent hue
      expect(l).toBeGreaterThanOrEqual(0.3);
      expect(l).toBeLessThanOrEqual(0.92);
    }
    expect(new Set(tints.map((t) => t.map(Math.round).join(","))).size).toBe(tints.length); // distinct steps
    expect(teamTint(gold, 0).map(Math.round)).toEqual(gold); // slot 0 is the accent itself
    const violet: [number, number, number] = [168, 85, 247];
    const [hv] = rgbToHsl(teamTint(violet, 2));
    expect(Math.abs(hv - rgbToHsl(violet)[0])).toBeLessThan(0.05); // a different branding accent is followed
    expect(hslToRgb(rgbToHsl([200, 100, 50])).map(Math.round)).toEqual([200, 100, 50]);
    expect(lighten([0, 0, 0], 1)).toEqual([255, 255, 255]);
  });

  it("disc basis is orthonormal", () => {
    const [u, v] = discBasis([0.1, 0.98, 0.17]);
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(Math.abs(dot(u, v))).toBeLessThan(1e-6);
    expect(Math.hypot(...u)).toBeCloseTo(1, 6);
    expect(Math.hypot(...v)).toBeCloseTo(1, 6);
  });
});

describe("beams", () => {
  it("curves above the chord and ends on the nodes", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [200, 0, 0];
    const c = beamControl(a, b);
    expect(c[1]).toBeGreaterThan(0);
    const pts = beamPoints(a, b, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual(a);
    expect(pts[10]).toEqual(b);
    expect(bezierPoint(a, c, b, 0.5)[1]).toBeGreaterThan(0);
  });
});

describe("focus / dim", () => {
  const edges = [
    { from: "main", to: "research" },
    { from: "research", to: "cli:codex" },
    { from: "cmo", to: "seo" },
  ];
  it("lights the focused agent and its links only", () => {
    expect(focusSet(null, edges)).toBeNull();
    expect([...focusSet("research", edges)!].sort()).toEqual(["cli:codex", "main", "research"]);
    expect(isEdgeHot(edges[0], "research")).toBe(true);
    expect(isEdgeHot(edges[2], "research")).toBe(false);
  });
  it("filters dim harder than focus", () => {
    const keep = new Set(["main"]);
    expect(nodeVisibility("main", keep, null)).toBe(1);
    expect(nodeVisibility("seo", keep, null)).toBeLessThan(0.25);
    expect(nodeVisibility("seo", null, focusSet("main", edges))).toBeLessThan(0.3);
    expect(nodeVisibility("research", null, focusSet("main", edges))).toBe(1);
  });
});

describe("LOD + camera", () => {
  it("fades name labels out and cluster captions in with distance", () => {
    expect(labelAlpha(10, 100, 500)).toBe(1);
    expect(labelAlpha(600, 100, 500)).toBe(0);
    const mid = labelAlpha(300, 100, 500);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(clusterLabelAlpha(10, 100)).toBe(0);
    expect(clusterLabelAlpha(1000, 100)).toBe(1);
  });
  it("frame distance fits the bounding sphere for wide and tall viewports", () => {
    const wide = frameDistance(300, 50, 16 / 9);
    const tall = frameDistance(300, 50, 390 / 700);
    expect(tall).toBeGreaterThan(wide);
    expect(wide).toBeGreaterThan(300);
    const d = frameDirection();
    expect(Math.hypot(...d)).toBeCloseTo(1, 6);
    expect(d[1]).toBeGreaterThan(0);
  });
  it("prioritises hover/selection, then working agents", () => {
    expect(labelPriority({ id: "a", state: "idle", size: 1 }, "a", null)).toBe(3);
    expect(labelPriority({ id: "b", state: "working", size: 0 }, null, null)).toBe(2);
    expect(labelPriority({ id: "c", state: "idle", size: 0.5 }, null, null)).toBeLessThan(2);
  });
  it("satellites orbit outside the parent", () => {
    for (let t = 0; t < 10; t += 0.7) {
      const o = satelliteOffset(0, 2, 20, t, 0.3);
      expect(Math.hypot(...o)).toBeGreaterThan(20 * 2);
    }
  });
});

describe("quality caps", () => {
  it("drops particle budgets and pixel ratio on phones / low-end devices", () => {
    const desk = qualityFor({ width: 1400, dpr: 2, lowEnd: false });
    const phone = qualityFor({ width: 390, dpr: 3, lowEnd: false });
    const low = qualityFor({ width: 1400, dpr: 1, lowEnd: true });
    expect(phone.pixelRatio).toBeLessThanOrEqual(1.5);
    expect(desk.pixelRatio).toBeLessThanOrEqual(2);
    expect(phone.stars).toBeLessThan(desk.stars);
    expect(phone.dust).toBeLessThan(desk.dust);
    expect(phone.maxLabels).toBeLessThan(desk.maxLabels);
    expect(low.bloomScale).toBeLessThan(desk.bloomScale);
  });
});
