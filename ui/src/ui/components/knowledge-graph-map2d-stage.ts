/**
 * Knowledge Graph — the flat 2D map as a stage.
 *
 * The web graph's 2D mode lives inside the Lit element (canvas + pointer
 * handlers + viewport). Hosts without that element (the native mobile graph)
 * drive this class instead: it has the SAME method surface as
 * KnowledgeGraph3DStage (setGraph / setFocus / resetView / fitIds / screenOf /
 * pointerDown… / dollyBy / panBy), so one controller drives either renderer,
 * and it draws with the web's own 2D renderer (knowledge-graph-map2d).
 *
 * Interaction is a port of the web host's 2D touch handling:
 *   tap a node → select + peek; tap empty → clear (a pan doesn't)
 *   drag a node → move it (drop on a project = re-assign, glide back)
 *   drag empty space → pan; pinch → zoom around the fingers
 *   long-press (520 ms, < 8 px) → context menu
 *   link mode: drag (or tap, tap) node → node; select mode: lasso on empty space
 *   double tap a node → open
 *
 * The host supplies a `ctx` per frame (a real 2D canvas context, or the
 * native Canvas2D → SVG recorder) through `surface.requestDraw()` → `frame(ctx)`.
 */

import type { Grouping } from "./knowledge-graph-ops";
import type { ConnectionsMode } from "./knowledge-graph-links";
import {
  drawMap2d,
  fitViewport,
  hitTest2d,
  hitTestExcept2d,
  labelInfo2d,
  MAX_ZOOM,
  MIN_ZOOM,
  zoomAround,
  type Ctx2D,
  type LabelInfo,
  type Map2DLink,
  type Map2DNode,
  type Map2DViewport,
} from "./knowledge-graph-map2d";
import { emphasisOf, neighbourhoodOf, type FocusState } from "./knowledge-graph-scene";

export interface Map2DPointer {
  x: number;
  y: number;
  pointerType?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** What the map reads from its host every frame (the controller's state). */
export interface Map2DHostState extends FocusState {
  dropTarget: { id: string; ok?: boolean } | null;
  degree: ArrayLike<number>;
}

export interface Map2DCallbacks {
  onSelect(id: string | null, opts?: { additive?: boolean }): void;
  onOpen(id: string): void;
  onDragStart(index: number): void;
  onDragOver(index: number, target: number): void;
  onDragEnd(index: number): void;
  onLinkStart(index: number): void;
  onLinkMove(x: number, y: number, target: number): void;
  onLinkEnd(target: number): void;
  onLasso(pts: number[], done: boolean): void;
  onContextMenu(id: string | null, x: number, y: number): void;
  onUserMoved?(): void;
  onProjected?(): void;
  /** Selection / hover / insight / drop state for emphasis, labels and bezels. */
  mapState(): Map2DHostState;
}

export interface Map2DSurface {
  /** Stage size in CSS px. */
  size(): { w: number; h: number };
  /** Schedule a `frame(ctx)` call (coalesced by the host). */
  requestDraw(): void;
  /** Device px per CSS px for the ctx (1 for the SVG recorder). */
  dpr?: number;
}

export interface Map2DStageOptions {
  reducedMotion?: boolean;
  /** Minimum ms between animation frames (pulse / marching ants). */
  frameInterval?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export const LONG_PRESS_MS = 520;
const LONG_PRESS_SLOP = 8;
const TAP_SLOP = 4;

interface StageLinkLike {
  s: number;
  t: number;
  rel?: string;
  inferred: boolean;
  weight?: number;
}

export class KnowledgeGraphMap2DStage<N extends Map2DNode = Map2DNode> {
  readonly is2d = true;
  viewport: Map2DViewport = { x: 0, y: 0, k: 1 };
  private nodes: N[] = [];
  private links: Array<Map2DLink<N>> = [];
  private nodeById = new Map<string, N>();
  private center = { cx: 0, cy: 0 };
  private grouping: Grouping | null = null;
  private groupMode = "brain";
  private search = "";
  private connectionsMode: ConnectionsMode = "all";
  private reducedMotion: boolean;
  private linkMode = false;
  private selectMode = false;
  private active = true;
  private disposed = false;
  private lastSize = { w: 0, h: 0 };
  /** Stage px at the bottom covered by host chrome (a floating dock): fits frame above it. */
  private bottomInset = 0;
  /** The last framing (ids + zoom cap) and whether the user moved since: resizes re-frame until they do. */
  private lastFit: { ids: string[]; maxK: number } | null = null;
  private userMoved = false;
  private dashPhase = 0;
  private lastFrameAt = 0;
  private animTimer: unknown = null;
  private labelWidths = new Map<string, number>();
  private nbhCache: { id: string | null; set: Set<string> | null } = { id: null, set: null };
  private nbhAdjacency: Map<string, Set<string>> | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly frameInterval: number;

  // One-finger gesture state (the web host's 2D fields).
  private dragging: { node: N; moved: boolean } | null = null;
  private pan: { x: number; y: number; vx: number; vy: number; moved: number } | null = null;
  private linkDrag: { node: N; moved: boolean } | null = null;
  private lasso: number[] | null = null;
  private longPress: { timer: unknown; x: number; y: number } | null = null;
  private longPressFired = false;

  constructor(
    private readonly cb: Map2DCallbacks,
    private readonly surface: Map2DSurface,
    opts: Map2DStageOptions = {},
  ) {
    this.reducedMotion = !!opts.reducedMotion;
    this.frameInterval = opts.frameInterval ?? 33;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  // ── Graph ────────────────────────────────────────────────────────────

  setGraph(nodes: N[], links: StageLinkLike[], center: { cx: number; cy: number }, _orbitRadii?: number[]): void {
    this.nodes = nodes;
    this.nodeById = new Map(nodes.map((n) => [n.id, n]));
    this.links = links
      .filter((l) => nodes[l.s] && nodes[l.t])
      .map((l) => ({ source: nodes[l.s], target: nodes[l.t], rel: l.rel ?? "", inferred: l.inferred, weight: l.weight }));
    this.center = center;
    this.nbhCache = { id: null, set: null };
    this.requestDraw();
  }

  /** The active grouping (zones + labels), its mode and the search (orbit guides hide while searching). */
  setGrouping(g: Grouping | null, mode: string, search = ""): void {
    this.grouping = g;
    this.groupMode = mode;
    this.search = search;
    this.requestDraw();
  }

  setLayoutV3(_v3: unknown): void {}
  setGroups(_groups: unknown): void {}
  setRings(_rings: unknown): void {
    this.requestDraw();
  }
  setFocus(_id: string | null): void {
    this.requestDraw();
  }
  markPositionsDirty(): void {
    this.requestDraw();
  }
  setConnectionsMode(m: ConnectionsMode): void {
    this.connectionsMode = m;
    this.requestDraw();
  }
  setHullsVisible(_on: boolean): void {}
  setAmbience(_on: boolean): void {}
  setQualityMode(_q: string): void {}
  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.requestDraw();
  }
  setInteractionModes(m: { link: boolean; select: boolean }): void {
    this.linkMode = !!m.link;
    this.selectMode = !!m.select;
  }
  /** Pause the animation loop (screen unfocused / app in the background). */
  setActive(on: boolean): void {
    this.active = on;
    if (on) this.requestDraw();
    else this.stopAnim();
  }

  // ── Camera ───────────────────────────────────────────────────────────

  get size(): { w: number; h: number } {
    return this.surface.size();
  }

  resize(): void {
    const { w, h } = this.surface.size();
    const prev = this.lastSize;
    this.lastSize = { w, h };
    if (prev.w && (Math.abs(w - prev.w) >= 2 || Math.abs(h - prev.h) >= 2)) {
      // Untouched view (the stage settled into its size: legend wrap, rotation,
      // dock): frame it again. Otherwise keep it centred, like the web map.
      if (!this.userMoved && this.lastFit) {
        this.fit(this.lastFit.ids, this.lastFit.maxK);
        return;
      }
      this.viewport = { ...this.viewport, x: this.viewport.x + (w - prev.w) / 2, y: this.viewport.y + (h - prev.h) / 2 };
    }
    this.requestDraw();
  }

  setBottomInset(px: number): void {
    this.bottomInset = Math.max(0, Math.round(px));
  }

  /** Frame the anchors (projects + clients) — the web map's "Reset view". */
  resetView(ids: Iterable<string>): void {
    this.fit(ids, 2);
  }

  fitIds(ids: Iterable<string>, opts: { fill?: number } = {}): void {
    this.fit(ids, (opts.fill ?? 0.8) >= 0.8 ? 1.8 : 1.6);
  }

  /** The flat map keeps the view on selection; it only scrolls a node that is off screen into view. */
  flyToNode(id: string): void {
    const p = this.screenOf(id);
    if (!p) return;
    const { w, h } = this.surface.size();
    if (p.x > 24 && p.x < w - 24 && p.y > 24 && p.y < h - 24) return;
    this.viewport = { ...this.viewport, x: this.viewport.x + (w / 2 - p.x), y: this.viewport.y + (h / 2 - p.y) };
    this.requestDraw();
  }

  private fit(ids: Iterable<string>, maxK: number): void {
    const list = [...ids];
    this.lastFit = { ids: list, maxK };
    this.userMoved = false;
    const size = this.surface.size();
    const visibleH = Math.max(120, size.h - this.bottomInset);
    const v = fitViewport(list.map((id) => this.nodeById.get(id)), { w: size.w, h: visibleH }, { maxK });
    this.lastSize = { ...size };
    if (!v) {
      if (!this.nodes.length) this.viewport = { x: 0, y: 0, k: 1 };
    } else this.viewport = v;
    this.requestDraw();
  }

  orbitBy(dx: number, dy: number): void {
    this.panBy(dx, dy);
  }

  panBy(dx: number, dy: number): void {
    if (!dx && !dy) return;
    this.viewport = { ...this.viewport, x: this.viewport.x + dx, y: this.viewport.y + dy };
    this.userMoved = true;
    this.cb.onUserMoved?.();
    this.moved();
  }

  /** Pinch / wheel: zoom by `ratio` around (mx, my) (the stage centre when omitted). */
  dollyBy(ratio: number, mx?: number, my?: number): void {
    if (!(ratio > 0) || ratio === 1) return;
    const { w, h } = this.surface.size();
    this.viewport = zoomAround(this.viewport, ratio, mx ?? w / 2, my ?? h / 2);
    this.userMoved = true;
    this.cb.onUserMoved?.();
    this.moved();
  }

  twistBy(_radians: number): void {}

  get zoom(): number {
    return this.viewport.k;
  }

  static readonly ZOOM_RANGE = [MIN_ZOOM, MAX_ZOOM] as const;

  private moved(): void {
    this.requestDraw();
    this.cb.onProjected?.();
  }

  // ── Projection ───────────────────────────────────────────────────────

  screenOf(id: string): { x: number; y: number; r: number } | null {
    const n = this.nodeById.get(id);
    if (!n || n.x == null || n.y == null) return null;
    const k = this.viewport.k;
    return { x: n.x * k + this.viewport.x, y: n.y * k + this.viewport.y, r: Math.max(4, n.r * k) };
  }

  screenOfIndex(i: number): { x: number; y: number; r: number } | null {
    const n = this.nodes[i];
    return n ? this.screenOf(n.id) : null;
  }

  screenPoints(): Array<{ id: string; x: number; y: number; visible: boolean }> {
    const { w, h } = this.surface.size();
    const out: Array<{ id: string; x: number; y: number; visible: boolean }> = [];
    for (const n of this.nodes) {
      const p = this.screenOf(n.id);
      if (!p) continue;
      out.push({ id: n.id, x: p.x, y: p.y, visible: p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h });
    }
    return out;
  }

  private world(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.viewport.x) / this.viewport.k, y: (y - this.viewport.y) / this.viewport.k };
  }

  /** Node under a stage-local point (null on empty space). */
  nodeAt(x: number, y: number): N | null {
    const p = this.world(x, y);
    return hitTest2d(this.nodes, p.x, p.y, this.viewport.k);
  }

  // ── Pointer (one finger / mouse) ─────────────────────────────────────

  pointerDown(e: Map2DPointer): boolean {
    this.longPressFired = false;
    const node = this.nodeAt(e.x, e.y);
    if (e.pointerType !== "mouse") {
      // Touch long-press = right-click (context menu).
      this.clearLongPress();
      const id = node?.id ?? null;
      const at = { x: e.x, y: e.y };
      this.longPress = {
        x: e.x,
        y: e.y,
        timer: this.setTimer(() => {
          this.longPress = null;
          this.longPressFired = true;
          this.pointerCancel();
          this.cb.onContextMenu(id, at.x, at.y);
        }, LONG_PRESS_MS),
      };
    }
    if (node && (e.ctrlKey || e.metaKey || this.linkMode)) {
      this.linkDrag = { node, moved: false };
      return true;
    }
    if (!node && (e.shiftKey || this.selectMode)) {
      this.lasso = [e.x, e.y];
      return true;
    }
    if (node) this.dragging = { node, moved: false };
    else this.pan = { x: e.x, y: e.y, vx: this.viewport.x, vy: this.viewport.y, moved: 0 };
    return true;
  }

  /** True when the map owns the move (it always does: drag, link, lasso or pan). */
  pointerMove(e: Map2DPointer): boolean {
    if (this.longPress && Math.hypot(e.x - this.longPress.x, e.y - this.longPress.y) > LONG_PRESS_SLOP) this.clearLongPress();
    if (this.linkDrag) {
      const p = this.world(e.x, e.y);
      if (!this.linkDrag.moved && Math.hypot(p.x - (this.linkDrag.node.x ?? 0), p.y - (this.linkDrag.node.y ?? 0)) >= 3 / this.viewport.k) {
        this.linkDrag.moved = true;
        this.cb.onLinkStart(this.linkDrag.node.index ?? -1);
      }
      if (this.linkDrag.moved) {
        const t = hitTestExcept2d(this.nodes, p.x, p.y, this.viewport.k, this.linkDrag.node);
        this.cb.onLinkMove(e.x, e.y, t?.index ?? -1);
      }
      return true;
    }
    if (this.lasso) {
      const n = this.lasso.length;
      if (Math.hypot(e.x - this.lasso[n - 2], e.y - this.lasso[n - 1]) >= 4) {
        this.lasso.push(e.x, e.y);
        this.cb.onLasso(this.lasso, false);
      }
      return true;
    }
    if (this.dragging) {
      const p = this.world(e.x, e.y);
      const node = this.dragging.node;
      if (!this.dragging.moved) {
        // Only start a real drag once the finger actually moves, so a plain
        // tap to select never jiggles the layout.
        if (Math.hypot(p.x - (node.x ?? 0), p.y - (node.y ?? 0)) < 3 / this.viewport.k) return true;
        this.dragging.moved = true;
        this.cb.onDragStart(node.index ?? -1);
      }
      node.x = p.x;
      node.y = p.y;
      const t = hitTestExcept2d(this.nodes, p.x, p.y, this.viewport.k, node);
      this.cb.onDragOver(node.index ?? -1, t?.index ?? -1);
      this.moved();
      return true;
    }
    if (this.pan) {
      this.pan.moved = Math.max(this.pan.moved, Math.hypot(e.x - this.pan.x, e.y - this.pan.y));
      this.viewport = { ...this.viewport, x: this.pan.vx + (e.x - this.pan.x), y: this.pan.vy + (e.y - this.pan.y) };
      this.userMoved = true;
      this.cb.onUserMoved?.();
      this.moved();
      return true;
    }
    return false;
  }

  pointerUp(e: Map2DPointer): void {
    this.clearLongPress();
    this.requestDraw(); // resume the pulse / marching ants paused during the touch
    if (this.longPressFired) {
      this.longPressFired = false;
      return;
    }
    if (this.linkDrag) {
      const { node: from, moved } = this.linkDrag;
      this.linkDrag = null;
      const p = this.world(e.x, e.y);
      const target = hitTestExcept2d(this.nodes, p.x, p.y, this.viewport.k, from);
      if (!moved) {
        // Link mode: a tap picks the source, the next tap the target.
        this.cb.onSelect(from.id, e.ctrlKey || e.metaKey ? { additive: true } : undefined);
        return;
      }
      this.cb.onLinkEnd(target?.index ?? -1);
      return;
    }
    if (this.lasso) {
      const pts = this.lasso;
      this.lasso = null;
      if (pts.length >= 6) this.cb.onLasso(pts, true);
      else {
        this.cb.onLasso([], true);
        if (!e.shiftKey) this.cb.onSelect(null);
      }
      return;
    }
    if (this.dragging) {
      const { node, moved } = this.dragging;
      this.dragging = null;
      if (moved) this.cb.onDragEnd(node.index ?? -1);
      else this.cb.onSelect(node.id, e.shiftKey ? { additive: true } : undefined);
      return;
    }
    if (this.pan) {
      const moved = this.pan.moved;
      this.pan = null;
      // A tap on empty space clears the selection (a pan doesn't).
      if (moved < TAP_SLOP) {
        const st = this.cb.mapState();
        if (st.selectedId || st.selection.size) this.cb.onSelect(null);
      }
    }
  }

  /** Abort whatever one finger started (a second finger / long-press took over). */
  pointerCancel(): void {
    this.clearLongPress();
    if (this.linkDrag) {
      const moved = this.linkDrag.moved;
      this.linkDrag = null;
      if (moved) this.cb.onLinkEnd(-2);
    }
    if (this.lasso) {
      this.lasso = null;
      this.cb.onLasso([], true);
    }
    if (this.dragging) {
      const { node, moved } = this.dragging;
      this.dragging = null;
      if (moved) this.cb.onDragEnd(node.index ?? -1);
    }
    this.pan = null;
  }

  doubleTapAt(x: number, y: number): void {
    const n = this.nodeAt(x, y);
    if (n) this.cb.onOpen(n.id);
  }

  gestureOwned(): boolean {
    return !!(this.dragging || this.linkDrag || this.lasso || this.pan);
  }

  private clearLongPress(): void {
    if (this.longPress) this.clearTimer(this.longPress.timer);
    this.longPress = null;
  }

  // ── Frame ────────────────────────────────────────────────────────────

  requestRender(): void {
    this.requestDraw();
  }

  private requestDraw(): void {
    if (this.disposed) return;
    this.surface.requestDraw();
  }

  private neighbourhood(state: Map2DHostState, id: string | null): Set<string> | null {
    if (!id) return null;
    if (this.nbhCache.id === id && this.nbhAdjacency === state.adjacency && this.nbhCache.set) return this.nbhCache.set;
    const set = neighbourhoodOf(state.adjacency, id);
    this.nbhCache = { id, set };
    this.nbhAdjacency = state.adjacency;
    return set;
  }

  /** Draw one frame into `ctx`; keeps the pulse / marching-ant loop alive while needed. */
  frame(ctx: Ctx2D): { visible: number } {
    const { w, h } = this.surface.size();
    if (!this.lastSize.w) this.lastSize = { w, h };
    const t = this.now();
    const dt = this.lastFrameAt ? Math.min(100, t - this.lastFrameAt) : 16.7;
    this.lastFrameAt = t;
    const st = this.cb.mapState();
    const focusId = st.selectedId ?? st.hoveredId;
    const marching = !!focusId && !!st.adjacency.get(focusId)?.size && this.connectionsMode !== "none";
    // The web loop advances 0.6 px per 60 Hz frame; keep that speed at any rate.
    if (marching && !this.reducedMotion) this.dashPhase = (this.dashPhase + 0.6 * (dt / 16.7)) % 1000;
    const res = drawMap2d<N>(ctx, {
      w,
      h,
      dpr: this.surface.dpr ?? 1,
      viewport: this.viewport,
      center: this.center,
      nodes: this.nodes,
      links: this.links,
      nodeById: this.nodeById,
      grouping: this.grouping,
      groupMode: this.groupMode,
      search: this.search,
      connectionsMode: this.connectionsMode,
      selection: st.selection,
      dropTarget: st.dropTarget,
      selectedId: st.selectedId,
      hoveredId: st.hoveredId,
      hoverScale: 1,
      dashPhase: this.dashPhase,
      reducedMotion: this.reducedMotion,
      now: t,
      emphasis: (n, fid, nbh) => emphasisOf(n, fid, nbh, st),
      neighbourhood: (id) => this.neighbourhood(st, id),
      labelInfo: (n, k, fid, nbh, minorOk): LabelInfo | null =>
        labelInfo2d(n, k, { focusId: fid, nbh, highlightSet: st.highlightSet, minorOk, degree: st.degree, stage3d: false }),
      labelWidth: (font, text, c) => {
        const key = `${font}|${text}`;
        let wv = this.labelWidths.get(key);
        if (wv == null) {
          c.font = font;
          wv = c.measureText(text).width;
          if (this.labelWidths.size > 5000) this.labelWidths.clear();
          this.labelWidths.set(key, wv);
        }
        return wv;
      },
    });
    const live = this.nodes.some((n) => (n.kind === "project" && n.meta?.live === true) || (n.kind === "run" && n.meta?.active === true));
    if (this.active && !this.reducedMotion && (live || marching)) this.scheduleAnim();
    return { visible: res.visible.length };
  }

  private scheduleAnim(): void {
    // A finger is down: no animation frames, so a tap's touch-up (and the
    // long-press decision) never queues behind a frame render.
    if (this.animTimer != null || this.disposed || this.longPress || this.gestureOwned()) return;
    this.animTimer = this.setTimer(() => {
      this.animTimer = null;
      this.requestDraw();
    }, this.frameInterval);
  }

  private stopAnim(): void {
    if (this.animTimer != null) this.clearTimer(this.animTimer);
    this.animTimer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.stopAnim();
    this.clearLongPress();
  }
}
