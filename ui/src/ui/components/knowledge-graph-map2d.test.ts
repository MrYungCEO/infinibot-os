import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { retypeBloomTargets } from "../lib/glow3d/scene";
import { digestMap2dCases, recordingCtx } from "./knowledge-graph-map2d-digest";
import { fitViewport, hitTest2d, hitTestExcept2d, zoomAround, type Map2DNode } from "./knowledge-graph-map2d";
import { KnowledgeGraphMap2DStage, LONG_PRESS_MS, type Map2DCallbacks } from "./knowledge-graph-map2d-stage";
import { makeLiveShapedSnapshot } from "./knowledge-graph-synth";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "kg-map2d-golden.json");

/** The cases the mobile suite replays through the native bundle (mobile/src/__tests__/kg-map2d.test.js). */
export function map2dGoldenCases(): Record<string, unknown> {
  return digestMap2dCases(makeLiveShapedSnapshot(false, 7));
}

function node(id: string, x: number, y: number, r = 8, extra: Partial<Map2DNode> = {}): Map2DNode {
  return { id, kind: "project", label: id, x, y, r, color: "#d4af37", anchor: true, index: 0, ...extra } as Map2DNode;
}

function makeStage(nodes: Map2DNode[], size = { w: 400, h: 400 }) {
  nodes.forEach((n, i) => (n.index = i));
  const calls: Array<[string, ...unknown[]]> = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const state = {
    selection: new Set<string>(),
    selectedId: null as string | null,
    hoveredId: null,
    adjacency: new Map<string, Set<string>>(),
    highlightSet: null,
    activeInsight: null,
    dropTarget: null,
    degree: nodes.map(() => 0),
  };
  const rec = (name: string) => (...a: unknown[]) => calls.push([name, ...a]);
  const cb: Map2DCallbacks = {
    onSelect: rec("select"),
    onOpen: rec("open"),
    onDragStart: rec("dragStart"),
    onDragOver: rec("dragOver"),
    onDragEnd: rec("dragEnd"),
    onLinkStart: rec("linkStart"),
    onLinkMove: rec("linkMove"),
    onLinkEnd: rec("linkEnd"),
    onLasso: rec("lasso"),
    onContextMenu: rec("menu"),
    onUserMoved: rec("moved"),
    mapState: () => state,
  };
  let draws = 0;
  const stage = new KnowledgeGraphMap2DStage(cb, { size: () => size, requestDraw: () => draws++, dpr: 1 }, {
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
  });
  stage.setGraph(nodes, []);
  // Identity view: world == stage px.
  stage.viewport = { x: 0, y: 0, k: 1 };
  const fire = (ms: number) => timers.filter((t) => t.live && t.ms === ms).forEach((t) => ((t.live = false), t.fn()));
  return { stage, calls, state, fire, draws: () => draws, names: () => calls.map((c) => c[0]) };
}

const P = (x: number, y: number) => ({ x, y, pointerType: "touch" });

describe("knowledge-graph 2D map (shared web ↔ native renderer)", () => {
  test("matches the golden frame digest (every grouping mode, focus, search)", () => {
    const got = map2dGoldenCases();
    if (process.env.UPDATE_KG_GOLDEN === "1" || !existsSync(GOLDEN)) writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  });

  test("a frame draws zones, curved links, orbs and labels; focus adds marching ants + the focus ring", () => {
    const cases = map2dGoldenCases() as Record<string, { calls: number; labels: string[] }>;
    expect(cases["phone/brain"].calls).toBeGreaterThan(500);
    expect(cases["phone/brain"].labels.length).toBeGreaterThan(3);
    // Focus: different call stream (dashed active links, focus ring, neighbourhood labels).
    expect(cases["phone/brain/focus"]).not.toEqual(cases["phone/brain"]);
  });

  test("recording ctx logs the canvas calls the renderer makes", () => {
    const { ctx, log } = recordingCtx();
    ctx.beginPath();
    ctx.arc(1, 2, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    expect(log).toEqual(["beginPath()", "arc(1,2,3,0,6.283)", "fillStyle=#fff", "fill()"]);
  });

  test("viewport maths: fit, zoom about a point, hit tests", () => {
    const ns = [node("a", 0, 0), node("b", 200, 100)];
    const v = fitViewport(ns, { w: 400, h: 300 }, { maxK: 2 })!;
    // Centred, within the zoom cap.
    expect(v.k).toBeGreaterThan(0.12);
    expect(v.k).toBeLessThanOrEqual(2);
    expect(Math.round(100 * v.k + v.x)).toBe(200);
    const z = zoomAround({ x: 10, y: 20, k: 1 }, 2, 100, 100);
    // The world point under (100, 100) stays put.
    expect((100 - z.x) / z.k).toBeCloseTo((100 - 10) / 1);
    expect(zoomAround({ x: 0, y: 0, k: 5 }, 10, 0, 0).k).toBe(6);
    expect(hitTest2d(ns, 3, 2, 1)?.id).toBe("a");
    expect(hitTest2d(ns, 60, 60, 1)).toBeNull();
    expect(hitTestExcept2d(ns, 1, 1, 1, ns[0])).toBeNull();
    expect(hitTestExcept2d(ns, 201, 101, 1, ns[0])?.id).toBe("b");
  });

  test("tap a node selects it; tap empty space clears; a pan doesn't", () => {
    const t = makeStage([node("a", 100, 100)]);
    t.stage.pointerDown(P(100, 100));
    t.stage.pointerUp(P(100, 100));
    expect(t.calls.at(-1)).toEqual(["select", "a", undefined]);
    t.state.selectedId = "a";
    t.stage.pointerDown(P(300, 300));
    t.stage.pointerUp(P(301, 300));
    expect(t.calls.at(-1)).toEqual(["select", null]);
    const n = t.calls.length;
    t.stage.pointerDown(P(300, 300));
    t.stage.pointerMove(P(340, 330));
    t.stage.pointerUp(P(340, 330));
    expect(t.stage.viewport).toMatchObject({ x: 40, y: 30 });
    expect(t.calls.slice(n).some((c) => c[0] === "select")).toBe(false);
  });

  test("drag a node: drag start → over a target → end (the controller re-assigns + glides back)", () => {
    const t = makeStage([node("a", 100, 100), node("b", 200, 100)]);
    t.stage.pointerDown(P(100, 100));
    t.stage.pointerMove(P(150, 100));
    t.stage.pointerMove(P(200, 101));
    t.stage.pointerUp(P(200, 101));
    expect(t.names()).toEqual(["dragStart", "dragOver", "dragOver", "dragEnd"]);
    expect(t.calls.filter((c) => c[0] === "dragOver").map((c) => c[2])).toEqual([-1, 1]);
  });

  test("long-press opens the menu and swallows the lift; moving cancels it", () => {
    const t = makeStage([node("a", 100, 100)]);
    t.stage.pointerDown(P(100, 100));
    t.fire(LONG_PRESS_MS);
    t.stage.pointerUp(P(100, 100));
    expect(t.calls).toEqual([["menu", "a", 100, 100]]);
    const u = makeStage([node("a", 100, 100)]);
    u.stage.pointerDown(P(300, 300));
    u.stage.pointerMove(P(320, 300));
    u.fire(LONG_PRESS_MS);
    u.stage.pointerUp(P(320, 300));
    expect(u.names()).not.toContain("menu");
  });

  test("link mode: drag node → node links; a tap picks the source; select mode lassos", () => {
    const t = makeStage([node("a", 100, 100), node("b", 200, 100)]);
    t.stage.setInteractionModes({ link: true, select: false });
    t.stage.pointerDown(P(100, 100));
    t.stage.pointerMove(P(150, 100));
    t.stage.pointerMove(P(200, 100));
    t.stage.pointerUp(P(200, 100));
    expect(t.names()).toEqual(["linkStart", "linkMove", "linkMove", "linkEnd"]);
    expect(t.calls.at(-1)).toEqual(["linkEnd", 1]);
    t.stage.pointerDown(P(100, 100));
    t.stage.pointerUp(P(100, 100));
    expect(t.calls.at(-1)).toEqual(["select", "a", undefined]);
    t.stage.setInteractionModes({ link: false, select: true });
    t.stage.pointerDown(P(10, 10));
    for (const [x, y] of [[60, 10], [60, 60], [10, 60]]) t.stage.pointerMove(P(x, y));
    t.stage.pointerUp(P(10, 60));
    expect(t.calls.at(-1)?.[0]).toBe("lasso");
    expect(t.calls.at(-1)?.[2]).toBe(true);
  });

  test("pinch zoom keeps the world point under the fingers; double tap opens; screenOf follows the view", () => {
    const t = makeStage([node("a", 100, 100)]);
    t.stage.dollyBy(2, 100, 100);
    expect(t.stage.screenOf("a")).toMatchObject({ x: 100, y: 100 });
    t.stage.panBy(10, -5);
    expect(t.stage.screenOf("a")).toMatchObject({ x: 110, y: 95, r: 16 });
    t.stage.doubleTapAt(110, 95);
    expect(t.calls.at(-1)).toEqual(["open", "a"]);
    expect(t.names()).toContain("moved");
  });

  test("bottom inset frames above host chrome; the anim loop pauses while a finger is down", () => {
    const nodes = [node("a", -50, -50), node("b", 50, 50, 8, { meta: { live: true } })];
    const t = makeStage(nodes, { w: 400, h: 600 });
    t.stage.resetView(["a", "b"]);
    const free = t.stage.screenOf("a")!.y + t.stage.screenOf("b")!.y;
    t.stage.setBottomInset(200);
    t.stage.resetView(["a", "b"]);
    const inset = t.stage.screenOf("a")!.y + t.stage.screenOf("b")!.y;
    expect(inset).toBeLessThan(free);
    const { ctx } = recordingCtx();
    const setTimer = vi.fn();
    (t.stage as unknown as { setTimer: unknown }).setTimer = setTimer;
    t.stage.pointerDown(P(300, 500));
    t.stage.frame(ctx);
    expect(setTimer).toHaveBeenCalledTimes(1); // only the long-press timer, no animation frame
  });
});

describe("2D stage framing", () => {
  test("a resize re-frames an untouched view; after the user pans it only re-centres", () => {
    const size = { w: 400, h: 600 };
    const t = makeStage([node("a", -100, -100), node("b", 100, 100)], size);
    t.stage.resize();
    t.stage.resetView(["a", "b"]);
    const k0 = t.stage.viewport.k;
    size.h = 300; // the stage shrank (legend wrapped / landscape)
    t.stage.resize();
    expect(t.stage.viewport.k).toBeLessThan(k0);
    const b = t.stage.screenOf("b")!;
    expect(b.y).toBeLessThanOrEqual(300);
    t.stage.panBy(5, 0);
    const k1 = t.stage.viewport.k;
    size.h = 500;
    t.stage.resize();
    expect(t.stage.viewport.k).toBe(k1);
  });
});

describe("bloom fallback", () => {
  test("retypes every bloom render target (8-bit LDR bloom when half float is missing)", () => {
    const pass = new UnrealBloomPass(new THREE.Vector2(4, 4), 1, 0.5, 0.5);
    retypeBloomTargets(pass, THREE.UnsignedByteType);
    const rts = [pass.renderTargetBright, ...pass.renderTargetsHorizontal, ...pass.renderTargetsVertical];
    expect(rts.length).toBe(11);
    expect(rts.every((rt) => rt.texture.type === THREE.UnsignedByteType)).toBe(true);
    pass.dispose();
  });
});
