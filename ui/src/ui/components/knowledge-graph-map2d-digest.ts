/**
 * Deterministic digest of the flat 2D map: every canvas call one frame makes
 * (paths, gradients, dashes, alpha, text) for a snapshot, grouping mode,
 * stage size and focus. The web suite pins it to a golden file and the mobile
 * suite checks the native bundle draws the identical call stream (web ↔
 * native parity for the 2D renderer and the 2D stage's framing).
 */

import { DEFAULT_HEALTH, DEFAULT_KINDS, type GraphNodeKind, type ProjectHealth } from "./knowledge-graph-model";
import { GROUP_MODES, type GroupMode } from "./knowledge-graph-ops";
import { buildScene, layoutAspectFor, placeOnTargets, stageLinksOf, type GraphEdgeIn, type GraphNodeIn } from "./knowledge-graph-scene";
import { KnowledgeGraphMap2DStage } from "./knowledge-graph-map2d-stage";
import type { Ctx2D } from "./knowledge-graph-map2d";

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const r3 = (v: unknown) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);

/** A 2D context that logs every call / property write (text measured at 6 px per char). */
export function recordingCtx(): { ctx: Ctx2D; log: string[] } {
  const log: string[] = [];
  const grad = (kind: string, args: unknown[]) => {
    const id = log.length;
    log.push(`${kind}(${args.map(r3).join(",")})#${id}`);
    return { addColorStop: (o: number, c: string) => log.push(`stop#${id}(${r3(o)},${c})`) };
  };
  const target: Record<string, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: (...a: unknown[]) => grad("lin", a),
    createRadialGradient: (...a: unknown[]) => grad("rad", a),
  };
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...args: unknown[]) => {
        log.push(`${k}(${args.map((a) => (Array.isArray(a) ? `[${a.map(r3).join(",")}]` : r3(a))).join(",")})`);
      };
    },
    set(t, k: string, v: unknown) {
      log.push(`${k}=${typeof v === "object" && v ? "gradient" : r3(v)}`);
      t[`_${k}`] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as Ctx2D, log };
}

export interface Map2DDigestOpts {
  w: number;
  h: number;
  mode: GroupMode;
  /** Focus the biggest hub (marching-ant links, focus ring, neighbourhood labels). */
  focus?: boolean;
  search?: string;
}

/** One frame of the 2D map for `snap` → { calls, hash, labels }. */
export function digestMap2d(snap: { nodes: GraphNodeIn[]; edges: GraphEdgeIn[] }, o: Map2DDigestOpts): Record<string, unknown> {
  const scene = buildScene({
    nodes: snap.nodes,
    edges: snap.edges,
    enabledKinds: new Set<GraphNodeKind>(DEFAULT_KINDS),
    enabledHealth: new Set<ProjectHealth>(DEFAULT_HEALTH),
    search: o.search ?? "",
    groupMode: o.mode,
    aspect: layoutAspectFor(o.w, o.h),
  });
  placeOnTargets(scene.nodes, scene.v3, { cx: 0, cy: 0 });
  let hub = scene.nodes[0];
  for (const n of scene.nodes) if ((scene.adjacency.get(n.id)?.size ?? 0) > (scene.adjacency.get(hub?.id ?? "")?.size ?? -1)) hub = n;
  const focusId = o.focus && hub ? hub.id : null;
  const state = {
    selection: new Set<string>(focusId ? [focusId] : []),
    selectedId: focusId,
    hoveredId: null,
    adjacency: scene.adjacency,
    highlightSet: null,
    activeInsight: null,
    dropTarget: null,
    degree: scene.degree,
  };
  const noop = () => {};
  const stage = new KnowledgeGraphMap2DStage(
    {
      onSelect: noop,
      onOpen: noop,
      onDragStart: noop,
      onDragOver: noop,
      onDragEnd: noop,
      onLinkStart: noop,
      onLinkMove: noop,
      onLinkEnd: noop,
      onLasso: noop,
      onContextMenu: noop,
      mapState: () => state,
    },
    { size: () => ({ w: o.w, h: o.h }), requestDraw: noop, dpr: 1 },
    { now: () => 900, setTimer: () => null, clearTimer: noop },
  );
  stage.setGraph(scene.nodes, stageLinksOf(scene.links, scene.v3), { cx: 0, cy: 0 });
  stage.setGrouping(scene.grouping, o.mode, o.search ?? "");
  stage.resetView(scene.nodes.filter((n) => n.anchor).map((n) => n.id));
  const { ctx, log } = recordingCtx();
  stage.frame(ctx);
  stage.dispose();
  const labels = log.filter((l) => l.startsWith("fillText(")).slice(0, 12);
  return { calls: log.length, hash: fnv(log.join("\n")), view: [r3(stage.viewport.x), r3(stage.viewport.y), r3(stage.viewport.k)], labels };
}

/** Every grouping mode at phone portrait, plus a focused hub and a search. */
export function digestMap2dCases(snap: { nodes: GraphNodeIn[]; edges: GraphEdgeIn[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of GROUP_MODES) out[`phone/${m.id}`] = digestMap2d(snap, { w: 390, h: 520, mode: m.id });
  out["phone/brain/focus"] = digestMap2d(snap, { w: 390, h: 520, mode: "brain", focus: true });
  out["desktop/orbit/focus"] = digestMap2d(snap, { w: 1400, h: 820, mode: "orbit", focus: true });
  out["phone/brain/search"] = digestMap2d(snap, { w: 390, h: 520, mode: "brain", search: "kingly" });
  return out;
}
