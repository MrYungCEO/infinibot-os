/**
 * Knowledge Graph — 3D holographic stage.
 *
 * Renders the graph the `<infinibot-knowledge-graph>` host lays out (a 3D
 * galaxy simulation in a worker: x/y in "layout px" plus a simulated height)
 * as a glowing galaxy: layout x/y map to world X/Z and height to world Y, so
 * project hubs sit on tilted status shells at different heights with their
 * satellites in clouds around them. Hub drop-lines to the instrument grid and
 * distance fog make depth read while the camera orbits. Built on the shared `lib/glow3d` helpers (bloom scene, instanced
 * orbs, pulse edges, starfield, camera tweens).
 *
 * The host stays the source of truth for data, filters, selection, and the
 * detail/insight panels; the stage only owns rendering, picking, labels and
 * camera moves and reports interactions back through `StageCallbacks`.
 *
 * Perf notes: two instanced draws for nodes, one for edges, one for pulses,
 * one each for stars/dust/rings. Idle motion (bob, twinkle, drift) lives in
 * shaders. Screen-space projection of every node is recomputed only when the
 * camera or the layout moved and feeds both picking and the DOM label pool.
 * The loop pauses when the tab is hidden or the stage leaves the viewport;
 * with prefers-reduced-motion it renders on demand only (static fallback).
 */

import * as THREE from "three";
import {
  BrainCortex,
  BundleRibbons,
  CameraTween,
  createDust,
  createGlowScene,
  createGuideRings,
  createNebula,
  createPolarGrid,
  createStarfield,
  GlowLinks,
  GlowNodes,
  GroupHalos,
  LobeVolumes,
  StatusRings,
  SuperNodes,
  toColor,
  type GlowLinkIn,
  type GlowScene,
  type GlowSurface,
  type HaloItem,
  type LobeItem,
  type RingItem,
  type SuperNodeItem,
} from "../lib/glow3d";
import { lodCollapsed, superRadius } from "./knowledge-graph-layout-v3";
import { createCanvasPause, type CanvasPause } from "../lib/canvas-pause";
import { labelScaleFor, placeLabels, type LabelCandidate } from "./knowledge-graph-model";
import { linkAlpha, linkStyle, linkWidth, REL_STYLES, type ConnectionsMode, type RelStyle } from "./knowledge-graph-links";

export interface StageNode {
  id: string;
  index?: number;
  x?: number;
  y?: number;
  z?: number;
  r: number;
  color: string;
  anchor: boolean;
  /** Silhouette id (glow3d NODE_SHAPES); 0/undefined = orb. */
  shape?: number;
}

export interface StageLink {
  /** Indices into the node array. */
  s: number;
  t: number;
  /** Anchor-to-anchor edge (drawn heavier). */
  heavy: boolean;
  inferred: boolean;
  /** Hierarchy link (parent project → sub-project): drawn brighter/thicker. */
  tree?: boolean;
  /** Link between two different clusters (brain mode): drawn faint so clusters read apart. */
  cross?: boolean;
  /** Relation label (graph-global humanised edge) — drives colour / width. */
  rel?: string;
  weight?: number;
}

export interface StageLabel {
  text: string;
  /** Higher wins placement. */
  pri: number;
  /** Visual class: anchor | client | minor | quiet | focus. */
  cls: string;
  /** Font scale (bigger nodes → bigger labels); 1 = default. */
  scale?: number;
}

export interface StageCallbacks {
  onHover(id: string | null): void;
  /** `additive` = Shift/Ctrl-click toggles the node in a multi-selection. */
  onSelect(id: string | null, opts?: { additive: boolean }): void;
  onOpen(id: string): void;
  /** Node drag in layout coordinates (same space the worker uses). */
  onDragStart(index: number): void;
  /** `z` = height (world Y): drags move on a camera-facing plane. */
  onDrag(index: number, x: number, y: number, z: number): void;
  /** Node currently under the dragged one (-1 = none) — drop-target feedback. */
  onDragOver?(index: number, targetIndex: number): void;
  onDragEnd(index: number, targetIndex: number): void;
  /** Ctrl/⌘-drag (or link mode) from a node: draw a connector to another. */
  onLinkStart?(index: number): void;
  onLinkMove?(x: number, y: number, targetIndex: number): void;
  onLinkEnd?(targetIndex: number): void;
  /** Shift-drag (or select mode) on empty space: flat [x,y,…] screen polygon. */
  onLasso?(points: number[], done: boolean): void;
  /** Right-click / long-press. `id` null = empty space. Coordinates are stage-local. */
  onContextMenu?(id: string | null, x: number, y: number): void;
  /** Screen projection changed (camera or layout moved). */
  onProjected?(): void;
  onUserMoved(): void;
  /** WebGL context lost — host should fall back to the 2D renderer. */
  onContextLost(): void;
  /** Label for a node at zoom-equivalent `k` (1 ≈ overview fit), or null. */
  labelFor(node: StageNode, k: number): StageLabel | null;
  /** 0..1 visibility of a node under the current focus/highlight. */
  emphasisFor(node: StageNode): number;
  /** True for nodes that should breathe (agent working). */
  liveFor(node: StageNode): boolean;
}

export interface StageOptions {
  reducedMotion: boolean;
  /** Phone-sized host: cheaper bloom, fewer pulses/labels. */
  mobile: boolean;
  /** Non-DOM host (React Native expo-gl): GL context, label sink, frame gate. */
  surface?: StageSurface;
}

/** A placed label (stage px, top-left of the box; `y` is the box's vertical centre). */
export interface StageLabelOut {
  id: string;
  text: string;
  cls: string;
  x: number;
  y: number;
  height: number;
  scale: number;
  opacity: number;
  color?: string;
}

/**
 * What a non-DOM host provides instead of a container element: the GL
 * surface, where labels go, floating panels labels must avoid, and when the
 * loop may run (screen focus / app foreground).
 */
export interface StageSurface extends GlowSurface {
  /** Labels + leader lines `[x0, y0, x1, y1, colour]` placed this frame. */
  writeLabels(labels: StageLabelOut[], leaders: Array<[number, number, number, number, string]>): void;
  /** Floating panel rects over the stage (labels never hide under them). */
  obstacles?(): Array<{ x: number; y: number; w: number; h: number }>;
  /** Frame gate (null = always active). */
  pause?: CanvasPause | null;
  /** Bloom on this device (half-float targets, or the 8-bit fallback — see GlowSurface.bloomDivisor). */
  bloom?: boolean;
}

/** A pointer sample in stage px (DOM events and native touches both map to it). */
export interface StagePointer {
  x: number;
  y: number;
  pointerType: string;
  button: number;
  buttons: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  type: string;
}

/** Ring decoration for one node (see glow3d StatusRings). */
export interface StageRing {
  index: number;
  /** 0..1 progress arc; < 0 = no arc. */
  progress: number;
  live: boolean;
  /** 0 none, 1 selected, 2 drop target. */
  mark: number;
}

/** A visual group (halo + label) over member node indices. */
export interface StageGroup {
  key: string;
  label: string;
  color: string;
  members: number[];
  /** Hub node index: the halo centres on it (outliers capped) and no extra label is drawn — the hub names the zone. */
  anchor?: number;
  /**
   * Fixed world-space region (a brain lobe): drawn as a translucent ellipsoid
   * instead of a halo, labelled at its top, shown even when empty.
   */
  volume?: { c: [number, number, number]; r: [number, number, number] };
  /** Fixed world-space disc (v3 regions / pockets): halo at c with radius r. */
  disc?: { c: [number, number, number]; r: number; emphasis?: number };
}

/** v3 layout info (world space): units for LOD/bundles, regions for tags. */
export interface StageUnitV3 {
  key: string;
  c: [number, number, number];
  r: number;
  members: number[];
  rep: number;
  aggregatable: boolean;
  label: string;
  color: string;
  type: string;
  region: number;
  /** Status fractions [open, at risk, backlog, done]. */
  mix: [number, number, number, number];
}

export interface StageRegionV3 {
  key: string;
  label: string;
  color: string;
  c: [number, number, number];
  r: number;
  shape: "disc" | "ring" | "lobe";
  lobe?: string;
  side?: number;
  count: number;
}

export interface StageLayoutV3 {
  mode: string;
  /** Brain scale S (0 = no brain shell). */
  brainScale: number;
  unitOf: Int32Array;
  regionOf: Int32Array;
  units: StageUnitV3[];
  regions: StageRegionV3[];
  bundles: Array<{ a: number; b: number; count: number; ua: number; ub: number; ra: number; rb: number; pa?: [number, number, number]; pb?: [number, number, number] }>;
}

export type QualityMode = "auto" | "high" | "low";

type Drag = { index: number; moved: boolean; sx: number; sy: number; plane: THREE.Plane; over: number };
type Cand = LabelCandidate & { id: string; text: string; cls: string; pri: number; fade: number; color?: string; region?: number; scale?: number };
type LinkDrag = { index: number; moved: boolean; sx: number; sy: number };

const DEFAULT_VIEW_DIR = new THREE.Vector3(0, 0.5, 1).normalize();
/** Brain formation: a 3/4 view — mostly the right side, a little front, a little above. */
const BRAIN_VIEW_DIR = new THREE.Vector3(0.62, 0.5, 0.78).normalize();
/** v3 brain overview: lateral and above, a touch from behind — temporal lobe, Sylvian line, cerebellum and brainstem all read. */
const CORTEX_VIEW_DIR = new THREE.Vector3(0.84, 0.36, -0.2).normalize();
/** Tall screens look from a bit higher so the galaxy fills the height while heights still read. */
const PORTRAIT_VIEW_DIR = new THREE.Vector3(0, 0.8, 1).normalize();
/** v3 zone layouts are wide maps: look down at them steeply so the canvas fills. */
const MAP_VIEW_DIR = new THREE.Vector3(0, 0.84, 0.54).normalize();
const MAP_PORTRAIT_VIEW_DIR = new THREE.Vector3(0, 0.93, 0.36).normalize();
/** Named harness views of the brain. */
const NAMED_VIEWS: Record<string, THREE.Vector3> = {
  side: new THREE.Vector3(1, 0.06, 0.02).normalize(),
  top: new THREE.Vector3(0.0, 1, 0.2).normalize(),
  // 3/4 from the front, right and above: both hemispheres + fissure, frontal pole nearest.
  "34": new THREE.Vector3(0.55, 0.65, 0.5).normalize(),
  "34front": new THREE.Vector3(0.62, 0.5, 0.78).normalize(),
  lateral: new THREE.Vector3(0.84, 0.36, -0.2).normalize(),
  front: new THREE.Vector3(0.05, 0.2, 1).normalize(),
};

export class KnowledgeGraph3DStage {
  private readonly gs: GlowScene;
  private readonly tween: CameraTween;
  private readonly pause: CanvasPause;
  private readonly labelLayer: HTMLDivElement | null = null;
  private readonly labelPool = new Map<string, HTMLDivElement>();
  private readonly labelBudget: number;
  private nodesLayer: GlowNodes | null = null;
  private linksLayer: GlowLinks | null = null;
  private rings: THREE.Group | null = null;
  private statusRings: StatusRings | null = null;
  private ringItems: RingItem[] = [];
  private halos: GroupHalos | null = null;
  private lobes: LobeVolumes | null = null;
  private groups: StageGroup[] = [];
  /** v3 layout (units, regions, bundles) — null for the legacy layouts. */
  private v3: StageLayoutV3 | null = null;
  private cortex: BrainCortex | null = null;
  private superNodes: SuperNodes | null = null;
  private bundlesLayer: BundleRibbons | null = null;
  /** Node hidden by LOD (its unit is drawn as a super-node). */
  private hidden = new Uint8Array(0);
  /** Links per node (mega-hub glow damping). */
  private degreeOf = new Uint16Array(0);
  private unitCollapsed = new Uint8Array(0);
  /** Units the user expanded by clicking: unit → camera distance at that moment. */
  private unitForced = new Map<number, number>();
  /** Units drawn as super-nodes right now (index into v3.units). */
  private superList: number[] = [];
  /** Screen disc per super-node: x, y, r (stage px). */
  private superProj = new Float32Array(0);
  /** Screen disc per region: x, y, r, visible. */
  private regionProj = new Float32Array(0);
  private readonly leaderSvg: SVGSVGElement | null = null;
  private readonly surface: StageSurface | null;
  /** Fraction of the screen covered by node halos (glow budget). */
  private glowCoverage = 0;
  private glowGain = 1;
  private haloItems: HaloItem[] = [];
  private haloGroupOf = new Int32Array(0);
  private readonly ambience: THREE.Object3D[] = [];
  /** Instrument grid under the galaxy (follows the lowest node). */
  private grid: THREE.Object3D | null = null;
  /** Faint vertical drop-lines from each hub to the grid (depth cue). */
  private dropLines: THREE.LineSegments | null = null;
  private dropHubs: number[] = [];
  /** Galaxy bounding radius (world units) — drives distance fog. */
  private extent = 600;
  private linkDrag: LinkDrag | null = null;
  private lasso: number[] | null = null;
  private longPress: { timer: ReturnType<typeof setTimeout>; x: number; y: number; id: string | null } | null = null;
  /** Toolbar modes for touch / mouse users who don't hold modifier keys. */
  private linkMode = false;
  private selectMode = false;
  /** A long-press opened the menu: the matching pointerup must not also select. */
  private longPressFired = false;
  /** 0..1 graph density (dims halos, bloom and edges on huge graphs). */
  private density = 0;
  /**
   * Visual px per CSS px. The app shell can apply CSS \`zoom\` to the page, so
   * pointer/rect coordinates (visual) differ from transform units (CSS).
   * Projection works in visual px; DOM writes divide by this.
   */
  private cssScale = 1;
  private nodes: StageNode[] = [];
  private links: StageLink[] = [];
  private center = { cx: 0, cy: 0 };
  /** World positions `[x,y,z]` per node (layout → world mapped). */
  private pos = new Float32Array(0);
  /** Screen projection per node: sx, sy, cameraDist, screenRadius, visible(0/1). */
  private proj = new Float32Array(0);
  private projDirty = true;
  private posDirty = false;
  private needsRender = true;
  private emphasisCur = new Float32Array(0);
  private emphasisTarget = new Float32Array(0);
  private emphasisAnimating = false;
  private focusId: string | null = null;
  private connectionsMode: ConnectionsMode = "all";
  private hullsOn = true;
  private linkStyles: RelStyle[] = [];
  private hoverIndex = -1;
  private hoverScale = 1;
  private hoverScaleTarget = 1;
  private drag: Drag | null = null;
  /** Empty-canvas press position, to tell a click (clear selection) from an orbit. */
  private downAt: { x: number; y: number } | null = null;
  private pointer = { x: 0, y: 0, pending: false };
  private lastInteraction = performance.now();
  private running = false;
  private rafId = 0;
  private lastFrame = 0;
  private labelFrame = 0;
  private fitDistance = 1200;
  private firstFit = true;
  /**
   * Adaptive quality: 0 = full (bloom + 1.5× DPR), 1 = 1× DPR, 2 = bloom off.
   * Stepped down when the smoothed frame time stays slow; `?kgquality=low|high`
   * pins it.
   */
  private quality = 0;
  private qualityPinned = false;
  private frameEma = 16;
  private slowSince = 0;
  private reducedMotion: boolean;
  private readonly mobile: boolean;
  private disposed = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpM = new THREE.Matrix4();
  private readonly colorCache = new Map<string, THREE.Color>();

  constructor(
    private readonly container: HTMLElement | null,
    private readonly cb: StageCallbacks,
    opts: StageOptions,
  ) {
    this.reducedMotion = opts.reducedMotion;
    this.mobile = opts.mobile;
    this.surface = opts.surface ?? null;
    this.labelBudget = opts.mobile ? 56 : 170;
    const surface = this.surface;
    this.gs = createGlowScene({
      ...(surface ? { surface } : { container: container! }),
      bloom:
        surface && !surface.bloom
          ? false
          : opts.mobile
            ? { strength: 0.75, radius: 0.45, threshold: 0.55 }
            : { strength: 0.85, radius: 0.62, threshold: 0.5 },
      maxPixelRatio: opts.mobile ? 1.25 : 1.5,
      samples: opts.mobile ? 0 : 4,
      fog: { near: 1100, far: 3200, color: "#040309" },
      backdrop: { top: "#0d0a22", bottom: "#030207", glow: "#d4af37" },
      camera: { fov: 46, near: 2, far: 40_000 },
    });
    this.gs.uniforms.uMotion.value = this.reducedMotion ? 0 : 1;
    try {
      const q = new URLSearchParams(location.search).get("kgquality");
      if (q === "low") {
        this.qualityPinned = true;
        this.setQuality(2);
      } else if (q === "high") this.qualityPinned = true;
    } catch {
      /* no location */
    }
    this.gs.controls.enableDamping = !this.reducedMotion;
    this.gs.controls.maxPolarAngle = Math.PI * 0.92;
    this.gs.controls.minPolarAngle = Math.PI * 0.06;
    this.tween = new CameraTween(this.gs.camera, this.gs.controls);

    this.gs.scene.add(
      createStarfield(this.gs.uniforms, { count: opts.mobile ? 900 : 2400, radius: 9000, size: 3.2 }),
    );
    this.gs.scene.add(createDust(this.gs.uniforms, { count: opts.mobile ? 220 : 520, extent: 1100 }));
    // Deep-space colour + an instrument grid under the galaxy (one draw each).
    const nebula = createNebula(this.gs.uniforms, { count: opts.mobile ? 2 : 5 });
    const grid = createPolarGrid(this.gs.uniforms, { radius: 2400, y: -170 });
    this.ambience.push(nebula, grid);
    this.gs.scene.add(nebula, grid);
    this.grid = grid;
    const dropGeo = new THREE.BufferGeometry();
    dropGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    this.dropLines = new THREE.LineSegments(
      dropGeo,
      new THREE.LineBasicMaterial({
        color: new THREE.Color("#d4af37"),
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.dropLines.frustumCulled = false;
    this.dropLines.renderOrder = 4;
    this.gs.scene.add(this.dropLines);
    this.statusRings = new StatusRings(this.gs.uniforms);
    this.halos = new GroupHalos(this.gs.uniforms);
    // Clearer tinted zones (the glow budget below still scales them down when dense).
    this.halos.setStrength(1.45);
    this.lobes = new LobeVolumes(this.gs.uniforms, { detail: opts.mobile ? 3 : 4 });
    this.gs.scene.add(this.statusRings.mesh, this.halos.mesh, this.lobes.mesh);
    this.superNodes = new SuperNodes(this.gs.uniforms);
    this.bundlesLayer = new BundleRibbons(this.gs.uniforms);
    this.gs.scene.add(this.superNodes.mesh, this.bundlesLayer.mesh);

    this.gs.controls.addEventListener("start", this.onControlsStart);
    this.gs.controls.addEventListener("change", this.onControlsChange);
    if (surface || !container) {
      // Native host: it feeds pointers/gestures in and draws the labels.
      this.pause = surface?.pause ?? alwaysActive();
      this.pause.onChange = (active) => {
        if (active) this.start();
        else this.stop();
      };
      this.pause.start();
      if (this.pause.isActive()) this.start();
      return;
    }

    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "kg3d-labels";
    this.labelLayer.setAttribute("aria-hidden", "true");
    container.appendChild(this.labelLayer);
    this.leaderSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.leaderSvg.setAttribute("class", "kg3d-leaders");
    this.labelLayer.appendChild(this.leaderSvg);

    const canvas = this.gs.canvas;
    canvas.setAttribute("aria-label", "Knowledge graph (3D)");
    canvas.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    canvas.addEventListener("pointermove", this.onPointerMove, { capture: true });
    canvas.addEventListener("pointerup", this.onPointerUp, { capture: true });
    canvas.addEventListener("pointercancel", this.onPointerUp, { capture: true });
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("webglcontextlost", this.onContextLost);

    // Harness hook: screen position of a node id (used by visual verification).
    (container as HTMLElement & { __kg3dScreenOf?: (id: string) => [number, number] | null }).__kg3dScreenOf = (
      id,
    ) => {
      const i = this.nodes.findIndex((n) => n.id === id);
      if (i < 0) return null;
      if (this.projDirty) {
        this.project();
        this.projDirty = false;
      }
      return this.proj[i * 5 + 4] ? [this.proj[i * 5], this.proj[i * 5 + 1]] : null;
    };

    // Harness hook: named camera views of the whole graph (side / top / 34 / front).
    (container as HTMLElement & { __kg3dView?: (name: string) => boolean }).__kg3dView = (name) => {
      let dir = NAMED_VIEWS[name];
      const m = /^dir:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/.exec(name);
      if (m) dir = new THREE.Vector3(Number(m[1]), Number(m[2]), Number(m[3])).normalize();
      if (!dir) return false;
      this.cb.onUserMoved();
      this.fitOverview(dir.clone(), 0);
      return true;
    };
    // Harness hook: LOD / glow state.
    (container as HTMLElement & { __kg3dLod?: () => Record<string, unknown> }).__kg3dLod = () => ({
      superNodes: this.superList.length,
      hidden: this.hidden.reduce((a, b) => a + b, 0),
      units: this.v3?.units.length ?? 0,
      glowCoverage: this.glowCoverage,
      glowGain: this.glowGain,
      bloom: this.gs.bloomPass?.strength ?? 0,
    });
    // Harness hook: expand a unit (by index or the biggest aggregatable one).
    (container as HTMLElement & { __kg3dExpand?: (u?: number) => number }).__kg3dExpand = (u) => {
      const v3 = this.v3;
      if (!v3) return -1;
      let pick = u ?? -1;
      if (pick < 0) {
        let best = 0;
        v3.units.forEach((x, i) => {
          if (x.aggregatable && x.members.length > best) {
            best = x.members.length;
            pick = i;
          }
        });
      }
      if (pick >= 0) {
        this.cb.onUserMoved();
        this.expandUnit(pick);
      }
      return pick;
    };

    this.pause = createCanvasPause(container, { throttleWhenBlurred: true, blurredFps: 20 });
    this.pause.onChange = (active) => {
      if (active) this.start();
      else this.stop();
    };
    this.pause.start();
    if (this.pause.isActive()) this.start();
  }

  // ── Graph data ──────────────────────────────────────────────

  /** Replace the graph (topology or styling change). Positions are read from the node objects. */
  setGraph(nodes: StageNode[], links: StageLink[], center: { cx: number; cy: number }, orbitRadii: number[]): void {
    if (this.disposed) return;
    this.nodes = nodes;
    this.links = links;
    this.center = center;
    const n = nodes.length;
    if (!this.nodesLayer || this.nodesLayer.capacity < n) {
      if (this.nodesLayer) {
        this.gs.scene.remove(this.nodesLayer.group);
        this.nodesLayer.dispose();
      }
      this.nodesLayer = new GlowNodes(this.gs.uniforms, {
        capacity: Math.max(256, Math.ceil(n * 1.25)),
        detail: this.mobile ? [10, 7] : [16, 12],
        haloScale: 3.2,
        bob: this.reducedMotion ? 0 : 2.2,
      });
      this.gs.scene.add(this.nodesLayer.group);
      this.updatePxPerUnit();
    }
    if (!this.linksLayer) {
      this.linksLayer = new GlowLinks(this.gs.uniforms, {
        segments: links.length > 6000 ? 1 : links.length > 2500 ? 3 : 6,
        maxPulses: this.mobile ? 110 : 340,
        pulseSpeed: 160,
      });
      this.linksLayer.setPulsesEnabled(!this.reducedMotion);
      this.gs.scene.add(this.linksLayer.group);
    }
    const layer = this.nodesLayer;
    layer.setCount(n);
    // Density: thousands of overlapping additive halos + bloom wash the core
    // out to white. Fade halos and soften bloom as the graph grows.
    this.density = Math.min(1, Math.max(0, (n - 600) / 3400));
    this.applyDensity();
    this.pos = new Float32Array(n * 3);
    this.proj = new Float32Array(n * 5);
    this.hidden = new Uint8Array(n);
    this.emphasisCur = new Float32Array(n).fill(1);
    this.emphasisTarget = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      const phase = (hashId(nd.id) % 628) / 100;
      layer.setStyle(i, this.colorOf(nd.color), nd.r, phase, this.cb.liveFor(nd), nd.shape ?? 0);
      layer.setEmphasis(i, 1);
    }
    layer.commitStyle();
    layer.commitEmphasis();

    // Colour by relation type (blended a little toward each endpoint so a link
    // still reads as joining those two nodes); width by relation strength.
    const relDensity = Math.min(1, Math.max(0, (links.length - 400) / 3600));
    this.linkStyles = links.map((l) => linkStyle(l.tree ? "sub-project of" : l.rel ?? "", l.inferred));
    const edges: GlowLinkIn[] = links.map((l, i) => {
      const st = this.linkStyles[i];
      const rc = this.colorOf(st.color);
      return {
        a: l.s,
        b: l.t,
        colorA: this.colorOf(nodes[l.s].color).clone().lerp(rc, 0.88),
        colorB: this.colorOf(nodes[l.t].color).clone().lerp(rc, 0.88),
        weight: l.tree ? 1.35 : l.cross ? 0.35 : l.heavy ? 1 : 0.55,
        dashed: l.inferred,
        width: linkWidth(st, l.weight ?? 1, relDensity) * (this.mobile ? 0.85 : 1),
        flow: this.reducedMotion ? 0 : st.flow,
      };
    });
    this.linksLayer.setEdges(edges);
    this.linksLayer.setResolution(this.gs.size.w, this.gs.size.h);
    this.linksLayer.setGain(0.8 * (1 - 0.35 * relDensity));
    this.degreeOf = new Uint16Array(n);
    for (const l of links) {
      if (l.s < n) this.degreeOf[l.s]++;
      if (l.t < n) this.degreeOf[l.t]++;
    }

    if (this.rings) {
      this.gs.scene.remove(this.rings);
      this.rings.traverse((o) => {
        const m = o as THREE.LineLoop;
        m.geometry?.dispose();
      });
    }
    this.rings = createGuideRings(orbitRadii, "#d4af37", 0.1);
    this.gs.scene.add(this.rings);
    this.dropHubs = [];
    for (let i = 0; i < n; i++) if (nodes[i].anchor) this.dropHubs.push(i);
    if (this.dropLines) {
      // Faint per line, and fainter still when there are hundreds of hubs, so
      // the lines read as a depth cue instead of a curtain.
      (this.dropLines.material as THREE.LineBasicMaterial).opacity =
        0.16 * Math.min(1, Math.max(0.22, Math.sqrt(30 / Math.max(1, this.dropHubs.length))));
      this.dropLines.geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(this.dropHubs.length * 6), 3).setUsage(THREE.DynamicDrawUsage),
      );
    }

    this.hoverIndex = -1;
    // Indices changed — the host re-sends rings/groups after setGraph.
    this.ringItems = [];
    this.statusRings?.setItems([]);
    this.setGroupsInternal(this.groups.filter((g) => g.members.every((m) => m < n)));
    this.applyPositions();
    this.applyFocus();
  }

  /**
   * v3 layout info (call right after setGraph). Turns on the brain cortex,
   * cluster LOD (super-nodes), bundled inter-cluster edges and region tags.
   * Null returns to the legacy rendering.
   */
  setLayoutV3(info: StageLayoutV3 | null): void {
    if (this.disposed) return;
    this.v3 = info;
    const brain = !!info && info.mode === "brain" && info.brainScale > 0;
    if (brain && !this.cortex) {
      this.cortex = new BrainCortex(this.gs.uniforms, { detail: this.mobile ? 34 : 52 });
      this.gs.scene.add(this.cortex.group);
    }
    if (this.cortex) {
      this.cortex.visible = brain;
      if (brain && info) {
        this.cortex.setScale(info.brainScale);
        this.styleLobes();
      }
    }
    const nU = info?.units.length ?? 0;
    this.unitCollapsed = new Uint8Array(nU);
    this.unitForced.clear();
    this.superList = [];
    this.superProj = new Float32Array(0);
    this.regionProj = new Float32Array((info?.regions.length ?? 0) * 4);
    this.hidden = new Uint8Array(this.nodes.length);
    this.superNodes?.setItems([]);
    if (this.dropLines) this.dropLines.visible = !info && !this.groups.some((g) => g.volume);
    const S = info?.brainScale ?? 0;
    const neural = brain ? { x: 0, y: -0.08 * S, z: 0, radius: S, hemiX: 0.45 * S } : null;
    this.linksLayer?.setNeural(neural ?? (this.groups.some((g) => g.volume) ? { x: 0, y: 0, z: 0, radius: this.brainRadius(), hemiX: this.brainHemiX() } : null));
    this.bundlesLayer?.setNeural(neural);
    this.bundlesLayer?.setBundles(
      (info?.bundles ?? [])
        .filter((b) => (b.pa && b.pb) || (b.a >= 0 && b.b >= 0 && b.a < this.nodes.length && b.b < this.nodes.length))
        .map((b) => ({
          a: Math.max(0, b.a),
          b: Math.max(0, b.b),
          pa: b.pa,
          pb: b.pb,
          count: b.count,
          colorA: this.colorOf(b.pa ? (info!.regions[b.ra]?.color ?? "#d4af37") : this.nodes[b.a].color),
          colorB: this.colorOf(b.pb ? (info!.regions[b.rb]?.color ?? "#d4af37") : this.nodes[b.b].color),
        })),
    );
    this.bundlesLayer?.setResolution(this.gs.size.w, this.gs.size.h);
    if (this.pos.length) this.bundlesLayer?.updatePositions(this.pos);
    this.brainDense = brain || this.groups.some((g) => g.volume);
    this.applyDensity();
    this.projDirty = true;
    this.labelFrame = 0;
    this.applyFocus();
    this.requestRender();
  }

  /** Cortex lobe tints: lobes holding nodes glow, empty ones stay faint; the focused node's lobe lifts. */
  private styleLobes(): void {
    const info = this.v3;
    if (!this.cortex || !info) return;
    const counts = new Map<string, number>();
    for (const r of info.regions) if (r.lobe) counts.set(r.lobe, (counts.get(r.lobe) ?? 0) + r.count);
    const fi = this.focusId ? this.indexOf(this.focusId) : -1;
    const focusLobe = fi >= 0 ? info.regions[info.regionOf[fi]]?.lobe : undefined;
    const style: Record<string, { color: THREE.Color; emphasis: number }> = {};
    for (const r of info.regions) {
      if (!r.lobe || style[r.lobe]) continue;
      const has = (counts.get(r.lobe) ?? 0) > 0;
      style[r.lobe] = {
        color: this.colorOf(r.color),
        emphasis: focusLobe ? (focusLobe === r.lobe ? 1 : 0.3) : has ? 0.72 : 0.22,
      };
    }
    this.cortex.setLobes(style as never);
    this.cortex.setGain((this.focusId ? 0.75 : 1) * (this.mobile ? 1.45 : 1));
  }

  /** Progress / live / selection rings (replaces the previous set). */
  setRings(rings: StageRing[]): void {
    if (!this.statusRings) return;
    const items: RingItem[] = [];
    for (const r of rings) {
      const nd = this.nodes[r.index];
      if (!nd) continue;
      items.push({
        index: r.index,
        radius: nd.r,
        color: this.colorOf(nd.color),
        progress: r.progress,
        live: r.live,
        mark: r.mark,
        emphasis: this.emphasisCur[r.index] ?? 1,
      });
    }
    this.ringItems = items;
    this.statusRings.setItems(items);
    this.statusRings.updatePositions(this.pos, (i) => (i === this.hoverIndex ? this.hoverScale : 1));
    this.requestRender();
  }

  /** Group halos (camera-facing cluster glows + labels). Empty array clears them. */
  setGroups(groups: StageGroup[]): void {
    this.setGroupsInternal(groups);
    this.updateHalos();
    this.labelFrame = 0;
    this.requestRender();
  }

  private setGroupsInternal(groups: StageGroup[]): void {
    this.groups = groups.filter((g) => g.members.length > 0 || g.volume);
    const brain = this.groups.some((g) => g.volume);
    if (this.dropLines) this.dropLines.visible = !brain && !this.v3;
    this.brainDense = brain || this.v3?.mode === "brain";
    this.applyDensity();
    if (!this.v3) this.linksLayer?.setNeural(brain ? { x: 0, y: 0, z: 0, radius: this.brainRadius(), hemiX: this.brainHemiX() } : null);
    this.haloGroupOf = new Int32Array(this.nodes.length).fill(-1);
    this.groups.forEach((g, gi) => {
      for (const m of g.members) if (m < this.haloGroupOf.length) this.haloGroupOf[m] = gi;
    });
  }

  /** Brain mode packs nodes into lobes: treat it as dense (softer halos/bloom). */
  private brainDense = false;

  private applyDensity(): void {
    if (this.v3) {
      // Additive glow budget: halos + bloom scale down as the on-screen halo
      // coverage grows, so a dense cluster never washes out to white.
      // Brain packs clusters in a volume (they overlap on screen): tighter budget.
      const brain = this.v3.mode === "brain";
      const cov = Math.max(0.0001, this.glowCoverage);
      const g = Math.max(0.2, Math.min(1, (brain ? 0.18 : 0.32) / cov));
      this.glowGain = g;
      this.nodesLayer?.setHaloGain((brain ? 0.38 : 0.7) * g);
      if (this.gs.bloomPass && this.quality < 2) {
        const b = Math.max(0.3, Math.min(1, (brain ? 0.25 : 0.45) / cov));
        this.gs.bloomPass.strength = (brain ? 0.58 : 1) * (this.mobile ? 0.62 : 0.7) * b;
        this.gs.bloomPass.threshold = brain ? 0.66 : 0.58;
      }
      return;
    }
    const dense = this.brainDense ? Math.max(this.density, 0.7) : this.density;
    this.nodesLayer?.setHaloGain(1 - 0.78 * dense);
    if (this.gs.bloomPass && this.quality < 2) this.gs.bloomPass.strength = (this.mobile ? 0.75 : 0.85) * (1 - 0.55 * dense);
  }

  /** Rough radius of the lobe volumes (pathway arcs scale with it). */
  private brainRadius(): number {
    let r = 0;
    for (const g of this.groups) {
      const v = g.volume;
      if (v) r = Math.max(r, Math.hypot(v.c[0], v.c[1], v.c[2]) + Math.max(v.r[0], v.r[1], v.r[2]));
    }
    return Math.max(200, r);
  }

  /** Mean |x| of the paired lobe volumes (hemisphere centre offset). */
  private brainHemiX(): number {
    let s = 0, n = 0;
    for (const g of this.groups) {
      if (g.volume && Math.abs(g.volume.c[0]) > 1) {
        s += Math.abs(g.volume.c[0]);
        n++;
      }
    }
    return n ? s / n : 0;
  }

  /** Recompute halo centres/radii from member positions (cheap: O(members)). */
  private updateHalos(): void {
    if (!this.halos) return;
    const focusIdx = this.focusId ? this.nodes.findIndex((n) => n.id === this.focusId) : -1;
    const focusGroup = focusIdx >= 0 ? this.haloGroupOf[focusIdx] : -1;
    const items: HaloItem[] = [];
    const lobeItems: LobeItem[] = [];
    const haloDraw: HaloItem[] = [];
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      if (g.volume) {
        const v = g.volume;
        const color = this.colorOf(g.color);
        // Empty lobes stay as a faint outline so the silhouette survives
        // without reading as a node (e.g. a brainstem with no system nodes).
        const emphasis = !g.members.length ? 0.12 : focusGroup < 0 ? 0.62 : focusGroup === gi ? 1 : 0.32;
        lobeItems.push({ x: v.c[0], y: v.c[1], z: v.c[2], rx: v.r[0], ry: v.r[1], rz: v.r[2], color, emphasis });
        // Label anchor only (not drawn as a halo): the lobe's centre, pushed a
        // little outward. The label loop adds `radius * 0.92` to y, so offset
        // y by that up front.
        const ax = v.c[0] + Math.sign(v.c[0]) * v.r[0] * 0.3;
        items.push({ x: ax, y: v.c[1] - v.r[1] * 0.92, z: v.c[2], radius: v.r[1], color, emphasis });
        continue;
      }
      if (g.disc) {
        const d = g.disc;
        const base = d.emphasis ?? 0.75;
        items.push({
          x: d.c[0],
          y: d.c[1],
          z: d.c[2],
          radius: d.r,
          color: this.colorOf(g.color),
          emphasis: focusGroup < 0 ? base : focusGroup === gi ? 1 : base * 0.4,
        });
        continue;
      }
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const m of g.members) {
        sx += this.pos[m * 3];
        sy += this.pos[m * 3 + 1];
        sz += this.pos[m * 3 + 2];
        n++;
      }
      if (!n) {
        items.push({ x: 0, y: 0, z: 0, radius: 0, color: this.colorOf(g.color), emphasis: 0 });
        continue;
      }
      const hub = g.anchor != null && g.anchor < this.nodes.length ? g.anchor : -1;
      const cx = hub >= 0 ? this.pos[hub * 3] : sx / n;
      const cy = hub >= 0 ? this.pos[hub * 3 + 1] : sy / n;
      const cz = hub >= 0 ? this.pos[hub * 3 + 2] : sz / n;
      let r = 0;
      for (const m of g.members) {
        const dx = this.pos[m * 3] - cx, dy = this.pos[m * 3 + 1] - cy, dz = this.pos[m * 3 + 2] - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // A far-flung satellite (cross-linked elsewhere) shouldn't balloon the zone.
        if (hub >= 0 && d > 200) continue;
        r = Math.max(r, d + this.nodes[m].r * 1.6);
      }
      if (hub >= 0) r = Math.max(r, this.nodes[hub].r * 2.6);
      items.push({
        // Billboarded sphere-like glow around the cluster, at its own height.
        x: cx,
        y: cy,
        z: cz,
        radius: Math.max(36, r + 18),
        color: this.colorOf(g.color),
        emphasis: focusGroup < 0 ? 0.75 : focusGroup === gi ? 1 : 0.3,
      });
    }
    this.haloItems = items;
    for (let gi = 0; gi < items.length; gi++) if (!this.groups[gi]?.volume) haloDraw.push(items[gi]);
    this.halos.setItems(haloDraw);
    this.lobes?.setItems(lobeItems);
  }

  /** Layout tick: node x/y/z changed in place. */
  markPositionsDirty(): void {
    this.posDirty = true;
    this.requestRender();
  }

  private applyPositions(): void {
    const layer = this.nodesLayer;
    if (!layer) return;
    const { cx, cy } = this.center;
    const pos = this.pos;
    for (let i = 0; i < this.nodes.length; i++) {
      const nd = this.nodes[i];
      const wx = (nd.x ?? cx) - cx;
      const wy = nd.z ?? 0;
      const wz = (nd.y ?? cy) - cy;
      pos[i * 3] = wx;
      pos[i * 3 + 1] = wy;
      pos[i * 3 + 2] = wz;
      layer.setPosition(i, wx, wy, wz, this.hidden[i] ? 0 : i === this.hoverIndex ? this.hoverScale : 1);
    }
    layer.commitPositions();
    this.linksLayer?.updatePositions(pos);
    this.bundlesLayer?.updatePositions(pos);
    this.updateDepthGuides();
    if (this.ringItems.length) {
      this.statusRings?.updatePositions(pos, (i) => (i === this.hoverIndex ? this.hoverScale : 1));
    }
    if (this.groups.length) this.updateHalos();
    this.posDirty = false;
    this.projDirty = true;
    this.requestRender();
  }

  /** Grid follows the lowest node; hubs get drop-lines down to it. */
  private updateDepthGuides(): void {
    const pos = this.pos;
    const n = this.nodes.length;
    if (!n) return;
    let miny = Infinity, ext = 0;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (y < miny) miny = y;
      const d = x * x + y * y + z * z;
      if (d > ext) ext = d;
    }
    this.extent = Math.max(200, Math.sqrt(ext));
    const floor = Math.min(-170, miny - 60);
    if (this.grid) this.grid.position.y = floor;
    const lines = this.dropLines;
    if (!lines) return;
    const attr = lines.geometry.getAttribute("position") as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    for (let k = 0; k < this.dropHubs.length; k++) {
      const i = this.dropHubs[k];
      const o = k * 6;
      a[o] = pos[i * 3];
      a[o + 1] = pos[i * 3 + 1] - this.nodes[i].r;
      a[o + 2] = pos[i * 3 + 2];
      a[o + 3] = pos[i * 3];
      a[o + 4] = floor;
      a[o + 5] = pos[i * 3 + 2];
    }
    attr.needsUpdate = true;
    lines.geometry.setDrawRange(0, this.dropHubs.length * 2);
  }

  /** Distance fog relative to the galaxy: far nodes dim toward the backdrop. */
  private updateFog(): void {
    const cam = this.gs.camera.position;
    const t = this.gs.controls.target;
    const d = Math.hypot(cam.x - t.x, cam.y - t.y, cam.z - t.z);
    const r = this.extent;
    this.gs.uniforms.uFogNear.value = Math.max(80, d - r * 0.35);
    this.gs.uniforms.uFogFar.value = d + r * 3;
  }

  // ── Focus / emphasis ────────────────────────────────────────

  /** Connections toolbar: all links / only the selection's / none. */
  setConnectionsMode(mode: ConnectionsMode): void {
    if (this.connectionsMode === mode) return;
    this.connectionsMode = mode;
    this.applyFocus();
  }

  /** Grouping hulls (zone halos + lobe volumes) on/off. */
  setHullsVisible(on: boolean): void {
    this.hullsOn = on;
    if (this.halos) this.halos.mesh.visible = on;
    if (this.lobes) this.lobes.mesh.visible = on;
    this.labelFrame = 0;
    this.requestRender();
  }

  /** Re-evaluate emphasis for every node (selection, hover, insight, search changed). */
  setFocus(focusId: string | null): void {
    this.focusId = focusId;
    // Focusing a node inside a collapsed family opens it, so its links and
    // neighbours are actually on screen (stays open until the user zooms out).
    const v3 = this.v3;
    const fi = focusId ? this.indexOf(focusId) : -1;
    if (v3 && fi >= 0) {
      const ui = v3.unitOf[fi];
      const u = v3.units[ui];
      if (u && this.unitCollapsed[ui] === 1) {
        const cam = this.gs.camera.position;
        const d = Math.hypot(cam.x - u.c[0], cam.y - u.c[1], cam.z - u.c[2]);
        this.unitForced.set(ui, d > 0 ? d : this.fitDistance);
        this.unitCollapsed[ui] = 0;
        this.applyLod(); // re-applies focus
        return;
      }
    }
    this.applyFocus();
  }

  private applyFocus(): void {
    const n = this.nodes.length;
    if (!this.nodesLayer || !this.linksLayer) return;
    for (let i = 0; i < n; i++) this.emphasisTarget[i] = this.cb.emphasisFor(this.nodes[i]);
    this.emphasisAnimating = true;
    if (this.reducedMotion) this.stepEmphasis(1);
    const focus = this.focusId;
    const preferred: number[] = [];
    const v3 = this.v3;
    const hid = this.hidden;
    // Focus + context: the focused node's links go full, links among its
    // neighbours stay readable, the rest fade to a trace (or vanish in
    // "selected" / "none" connection modes).
    const fi0 = focus ? this.indexOf(focus) : -1;
    const nb = new Set<number>();
    if (fi0 >= 0) {
      nb.add(fi0);
      for (const l of this.links) {
        if (l.s === fi0) nb.add(l.t);
        else if (l.t === fi0) nb.add(l.s);
      }
    }
    const mode = this.connectionsMode;
    // A hub with 100+ links: each focused ribbon dims so the fan-out stays
    // readable instead of summing to white (additive glow budget).
    let nFocus = 0;
    if (fi0 >= 0) for (const l of this.links) if (l.s === fi0 || l.t === fi0) nFocus++;
    const focusGain = nFocus > 12 ? Math.max(0.55, Math.sqrt(12 / nFocus)) : 1;
    const focusEdges: number[] = [];
    if (fi0 >= 0 && mode !== "none") this.links.forEach((l, i) => (l.s === fi0 || l.t === fi0) && focusEdges.push(i));
    this.linksLayer.setFocusEdges(focusEdges);
    this.linksLayer.setAlpha((_e, i) => {
      const l = this.links[i];
      const focused = fi0 >= 0 && (l.s === fi0 || l.t === fi0);
      if (focused && mode !== "none") preferred.push(i);
      // Collapsed clusters draw no inner lines.
      if (!focused && v3 && (hid[l.s] || hid[l.t])) return 0;
      // A mega-hub (100+ links) shouldn't burn white where its lines meet.
      const hubDamp = Math.min(1, 3.5 / Math.sqrt(Math.max(1, this.degreeOf[l.s], this.degreeOf[l.t])));
      const st = this.linkStyles[i];
      return (focused ? focusGain : 1) * linkAlpha({
        mode,
        focused,
        hasFocus: fi0 >= 0,
        inNeighbourhood: nb.has(l.s) && nb.has(l.t),
        style: l.tree ? REL_STYLES.hierarchy : st ?? REL_STYLES.other,
        emphasis: Math.min(this.emphasisTarget[l.s], this.emphasisTarget[l.t]),
        cross: !!l.cross || (!!v3 && v3.unitOf[l.s] !== v3.unitOf[l.t]),
        hubDamp: l.tree ? 1 : hubDamp,
        density: this.density,
      });
    });
    this.linksLayer.setPreferredEdges(preferred.length > 60 ? preferred.slice(0, 60) : preferred);
    if (v3 && this.bundlesLayer) {
      const fi = focus ? this.indexOf(focus) : -1;
      const fu = fi >= 0 ? v3.unitOf[fi] : -1;
      const fr = fi >= 0 ? v3.regionOf[fi] : -1;
      const live = v3.bundles.filter((b) => (b.pa && b.pb) || (b.a >= 0 && b.b >= 0 && b.a < this.nodes.length && b.b < this.nodes.length));
      const bmode = this.connectionsMode;
      this.bundlesLayer.setAlpha((k) => {
        if (bmode === "none") return 0;
        if (fu < 0) return bmode === "selected" ? 0 : 0.6;
        const b = live[k];
        if (!b) return 0.25;
        const hit = b.ua >= 0 ? b.ua === fu || b.ub === fu : b.ra === fr || b.rb === fr;
        return hit ? 1.6 : bmode === "selected" ? 0 : 0.25;
      });
    }
    if (v3) this.styleLobes();
    if (this.groups.length) this.updateHalos();
    this.labelFrame = 0;
    this.projDirty = true;
    this.requestRender();
  }

  private stepEmphasis(rate: number): void {
    const layer = this.nodesLayer;
    if (!layer) return;
    let maxDelta = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const cur = this.emphasisCur[i];
      const tgt = this.emphasisTarget[i];
      const next = rate >= 1 ? tgt : cur + (tgt - cur) * rate;
      maxDelta = Math.max(maxDelta, Math.abs(tgt - next));
      this.emphasisCur[i] = next;
      layer.setEmphasis(i, next);
    }
    layer.commitEmphasis();
    if (this.ringItems.length) this.statusRings?.setEmphasisFrom(this.emphasisCur);
    this.emphasisAnimating = maxDelta > 0.004;
    if (!this.emphasisAnimating) {
      for (let i = 0; i < this.nodes.length; i++) this.emphasisCur[i] = this.emphasisTarget[i];
    }
    this.requestRender();
  }

  // ── Camera ──────────────────────────────────────────────────

  private worldOf(index: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos[index * 3], this.pos[index * 3 + 1], this.pos[index * 3 + 2]);
  }

  flyToNode(id: string): void {
    const i = this.nodes.findIndex((n) => n.id === id);
    if (i < 0) return;
    const target = this.worldOf(i, new THREE.Vector3());
    // Big hubs need room for their fan-out.
    const distance = Math.max(150, this.nodes[i].r * 9, Math.min(460, this.fitDistance * 0.26));
    this.tween.flyTo(target, distance, this.reducedMotion ? 0 : 900);
    this.lastInteraction = performance.now();
    this.requestRender();
  }

  /** Frame a set of node ids. */
  fitIds(ids: Iterable<string>, opts: { fill?: number; ms?: number; resetDirection?: boolean; dir?: THREE.Vector3 } = {}): void {
    const idx = new Map<string, number>();
    this.nodes.forEach((n, i) => idx.set(n.id, i));
    const pts: number[] = [];
    for (const id of ids) {
      const i = idx.get(id);
      if (i != null) pts.push(i);
    }
    if (!pts.length) return;
    const portrait = this.gs.size.h > this.gs.size.w * 1.15;
    const brain = this.groups.some((g) => g.volume) || this.v3?.mode === "brain";
    const map = !!this.v3 && !brain;
    const dir =
      opts.dir ??
      (opts.resetDirection || this.firstFit
        ? (brain ? (this.v3 ? CORTEX_VIEW_DIR : BRAIN_VIEW_DIR) : map ? (portrait ? MAP_PORTRAIT_VIEW_DIR : MAP_VIEW_DIR) : portrait ? PORTRAIT_VIEW_DIR : DEFAULT_VIEW_DIR).clone()
        : undefined);
    // Overview of the brain: frame the whole silhouette (every lobe's extremes),
    // not just where the hubs happen to sit.
    const extra: number[] = [];
    const v3 = this.v3;
    if (v3 && opts.resetDirection) {
      if (v3.mode === "brain" && v3.brainScale > 0) {
        const S = v3.brainScale;
        // The silhouette's extremes (not the bounding box corners, which sit
        // far outside an ellipsoidal brain and shrink it in frame).
        // Both hemispheres' own extremes (the near one is closer to the camera).
        for (const sx of [-1, 1]) {
          for (const p of [[0.8, 0.05, 0], [0.41, 0.05, 0.95], [0.41, 0.05, -0.99], [0.41, 0.6, -0.05], [0.6, -0.45, 0.15], [0.25, -0.66, -0.62]])
            extra.push(p[0] * sx * S, p[1] * S, p[2] * S);
        }
        extra.push(0, -0.98 * S, -0.4 * S);
      } else {
        for (const r of v3.regions) {
          if (!r.count) continue;
          extra.push(r.c[0] - r.r, r.c[1], r.c[2], r.c[0] + r.r, r.c[1], r.c[2], r.c[0], r.c[1], r.c[2] - r.r, r.c[0], r.c[1], r.c[2] + r.r);
        }
      }
    } else if (brain && opts.resetDirection) {
      for (const g of this.groups) {
        const v = g.volume;
        if (!v) continue;
        for (let a = 0; a < 3; a++) {
          for (const sgn of [-1, 1]) {
            const p = [v.c[0], v.c[1], v.c[2]];
            p[a] += sgn * v.r[a];
            extra.push(p[0], p[1], p[2]);
          }
        }
      }
    }
    // v3 brain overview: a bounding-sphere fit, so the idle auto-orbit never
    // swings a pole of the brain out of frame.
    if (v3 && opts.resetDirection && v3.mode === "brain" && v3.brainScale > 0) {
      const S = v3.brainScale;
      const portrait = this.gs.size.h > this.gs.size.w * 1.15;
      this.tween.fitSphere(new THREE.Vector3(0, -0.2 * S, -0.03 * S), 1.0 * S, this.reducedMotion ? 0 : (opts.ms ?? 950), this.insetFill((portrait ? 0.8 : 0.9) * (opts.dir ? 0.92 : 1)), dir);
      this.firstFit = false;
      this.lastInteraction = performance.now();
      this.requestRender();
      return;
    }
    // v3 overview: frame the layout's own extents (nodes may still be gliding there).
    if (v3 && opts.resetDirection && extra.length) pts.length = 0;
    const count = pts.length + extra.length / 3;
    const buf = new Float32Array(count * 3);
    let maxR = 0;
    pts.forEach((i, k) => {
      buf[k * 3] = this.pos[i * 3];
      buf[k * 3 + 1] = this.pos[i * 3 + 1];
      buf[k * 3 + 2] = this.pos[i * 3 + 2];
      maxR = Math.max(maxR, this.nodes[i].r);
    });
    buf.set(extra, pts.length * 3);
    if (count === 1) {
      this.tween.flyTo(new THREE.Vector3(buf[0], buf[1], buf[2]), Math.max(150, this.fitDistance * 0.26), this.reducedMotion ? 0 : (opts.ms ?? 950));
    } else {
      this.tween.fitPoints(buf, count, this.reducedMotion ? 0 : (opts.ms ?? 950), this.insetFill(opts.fill ?? 0.8), maxR * 3 + 14, dir);
    }
    this.firstFit = false;
    this.lastInteraction = performance.now();
    this.requestRender();
  }

  /** Frame the whole graph from a direction (harness views, overview). */
  private fitOverview(dir: THREE.Vector3, ms = 900): void {
    const ids = this.nodes.filter((n) => n.anchor).map((n) => n.id);
    const portrait = this.gs.size.h > this.gs.size.w * 1.15;
    this.fitIds(ids.length ? ids : this.nodes.map((n) => n.id), { fill: portrait ? 0.98 : 0.86, resetDirection: true, dir, ms });
    this.projDirty = true;
  }

  /** Overview: frame `ids` and remember the distance as the k=1 reference. */
  resetView(ids: Iterable<string>): void {
    const portrait = this.gs.size.h > this.gs.size.w * 1.15;
    const brain = this.groups.some((g) => g.volume) || this.v3?.mode === "brain";
    this.fitIds(ids, { fill: brain ? (portrait ? 0.94 : 0.86) : this.v3 ? (portrait ? 1.0 : 0.94) : portrait ? 1.08 : 0.9, resetDirection: true });
    const d = this.tween.targetDistance();
    if (d > 0) this.fitDistance = d;
  }

  // ── Motion / lifecycle ──────────────────────────────────────

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.gs.uniforms.uMotion.value = on ? 0 : 1;
    this.gs.controls.enableDamping = !on;
    this.gs.controls.autoRotate = false;
    this.nodesLayer?.setBob(on ? 0 : 2.2);
    this.linksLayer?.setPulsesEnabled(!on);
    if (on) this.stepEmphasis(1);
    this.requestRender();
  }

  /** LOD scale for node shapes: px per world unit at distance 1. */
  private updatePxPerUnit(): void {
    const cam = this.gs.camera;
    this.nodesLayer?.setPxPerUnit(this.gs.size.h / (2 * Math.tan((cam.fov * Math.PI) / 360)));
  }

  /** Left screen inset (px) covered by an overlay panel: the view centre shifts right so framed content isn't hidden under it. */
  private safeInset = 0;
  setSafeInset(px: number): void {
    const v = Math.max(0, Math.round(px));
    if (v === this.safeInset) return;
    this.safeInset = v;
    this.applyViewOffset();
    this.projDirty = true;
    this.requestRender();
  }

  private applyViewOffset(): void {
    const cam = this.gs.camera;
    const { w, h } = this.gs.size;
    if (this.safeInset > 0 && w > this.safeInset * 2) cam.setViewOffset(w, h, -this.safeInset / 2, 0, w, h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  }

  /** Fill factor shrunk to the part of the screen not under the inset panel. */
  private insetFill(fill: number): number {
    const w = this.gs.size.w;
    return this.safeInset > 0 && w > this.safeInset * 2 ? fill * (1 - this.safeInset / w) : fill;
  }

  resize(): void {
    this.updateCssScale();
    this.gs.resize();
    this.applyViewOffset();
    this.updatePxPerUnit();
    this.bundlesLayer?.setResolution(this.gs.size.w, this.gs.size.h);
    this.linksLayer?.setResolution(this.gs.size.w, this.gs.size.h);
    this.projDirty = true;
    this.requestRender();
  }

  requestRender(): void {
    this.needsRender = true;
  }

  private start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private frame = (now: number): void => {
    if (!this.running || this.disposed) return;
    this.rafId = requestAnimationFrame(this.frame);
    if (!this.pause.wantsFrame(now)) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const t0 = performance.now();

    const tweening = this.tween.update(now);
    if (tweening) this.projDirty = true;
    const controls = this.gs.controls;
    controls.autoRotate =
      !this.reducedMotion &&
      !tweening &&
      !this.drag &&
      !this.linkDrag &&
      !this.lasso &&
      !this.focusId &&
      this.hoverIndex < 0 &&
      now - this.lastInteraction > 4000;
    controls.update();

    if (!this.reducedMotion) {
      this.gs.uniforms.uTime.value += dt;
      this.needsRender = true;
    }
    if (this.posDirty) this.applyPositions();
    if (this.emphasisAnimating) this.stepEmphasis(this.reducedMotion ? 1 : 0.22);
    if (Math.abs(this.hoverScale - this.hoverScaleTarget) > 0.002) {
      this.hoverScale += (this.hoverScaleTarget - this.hoverScale) * (this.reducedMotion ? 1 : 0.25);
      if (this.hoverIndex >= 0 && this.nodesLayer) {
        this.nodesLayer.setScale(this.hoverIndex, this.hoverScale);
        this.nodesLayer.commitPositions();
        if (this.ringItems.length) {
          this.statusRings?.updatePositions(this.pos, (i) => (i === this.hoverIndex ? this.hoverScale : 1));
        }
      }
      this.needsRender = true;
    }
    if (!this.reducedMotion) this.linksLayer?.tick(dt);

    if (this.projDirty) {
      this.updateFog();
      this.project();
      this.projDirty = false;
      this.labelFrame = 0;
    }
    if (this.pointer.pending) {
      this.pointer.pending = false;
      if (!this.drag) this.updateHover(this.pointer.x, this.pointer.y);
    }
    if (this.labelFrame === 0) this.layoutLabels();
    this.labelFrame = (this.labelFrame + 1) % 3;

    if (this.needsRender) {
      this.needsRender = false;
      this.gs.render();
      const ms = performance.now() - t0;
      this.publishPerf(ms);
      this.adaptQuality(now, dt * 1000);
    }
  };

  /** Step quality down when the real frame interval stays above ~45 ms (≈22 fps) for 4 s. */
  private adaptQuality(now: number, frameMs: number): void {
    if (this.qualityPinned || this.reducedMotion || this.quality >= 2) return;
    this.frameEma = this.frameEma * 0.9 + Math.min(frameMs, 200) * 0.1;
    if (this.frameEma > 45) {
      if (!this.slowSince) this.slowSince = now;
      else if (now - this.slowSince > 4000) {
        this.setQuality(this.quality + 1);
        this.slowSince = 0;
        this.frameEma = 16;
      }
    } else {
      this.slowSince = 0;
    }
  }

  /** User quality preference: auto adapts, high pins full, low pins cheapest. */
  setQualityMode(mode: QualityMode): void {
    this.qualityPinned = mode !== "auto";
    if (mode === "low") this.setQuality(2);
    else {
      this.quality = 0;
      this.gs.setMaxPixelRatio(this.mobile ? 1.25 : 1.5);
      this.gs.setBloom(true);
      this.frameEma = 16;
      this.slowSince = 0;
      this.projDirty = true;
      this.requestRender();
    }
  }

  /** Ambience layers (grid + nebula) on/off — reduced-motion users can keep them. */
  setAmbience(on: boolean): void {
    for (const o of this.ambience) o.visible = on;
    this.requestRender();
  }

  /** Toolbar modes for users without modifier keys (touch). */
  setInteractionModes(modes: { link: boolean; select: boolean }): void {
    this.linkMode = modes.link;
    this.selectMode = modes.select;
    if (this.gs.canvas.style) this.gs.canvas.style.cursor = modes.link ? "crosshair" : modes.select ? "cell" : "grab";
  }

  /** Screen position (stage-local px) + screen radius of a node, or null when off-screen. */
  screenOf(id: string): { x: number; y: number; r: number } | null {
    const i = this.indexOf(id);
    if (i < 0) return null;
    if (this.projDirty) {
      this.project();
      this.projDirty = false;
    }
    const o = i * 5;
    if (!this.proj[o + 4]) return null;
    return { x: this.proj[o], y: this.proj[o + 1], r: Math.max(4, this.proj[o + 3]) };
  }

  screenOfIndex(i: number): { x: number; y: number; r: number } | null {
    const n = this.nodes[i];
    return n ? this.screenOf(n.id) : null;
  }

  /** Every node's screen position (for lasso selection). */
  screenPoints(): Array<{ id: string; x: number; y: number; visible: boolean }> {
    if (this.projDirty) {
      this.project();
      this.projDirty = false;
    }
    const out: Array<{ id: string; x: number; y: number; visible: boolean }> = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const o = i * 5;
      out.push({ id: this.nodes[i].id, x: this.proj[o], y: this.proj[o + 1], visible: this.proj[o + 4] > 0 });
    }
    return out;
  }

  private idIndex: Map<string, number> | null = null;
  private idIndexFor: StageNode[] | null = null;
  private indexOf(id: string): number {
    if (this.idIndexFor !== this.nodes || !this.idIndex) {
      this.idIndex = new Map(this.nodes.map((n, i) => [n.id, i]));
      this.idIndexFor = this.nodes;
    }
    return this.idIndex.get(id) ?? -1;
  }

  private setQuality(level: number): void {
    this.quality = Math.max(0, Math.min(2, level));
    if (this.quality >= 1) this.gs.setMaxPixelRatio(1);
    if (this.quality >= 2) this.gs.setBloom(false);
    this.projDirty = true;
    this.requestRender();
  }

  private publishPerf(ms: number): void {
    const g = globalThis as Record<string, unknown>;
    const kg = g.__kgPerf as
      | { frames: number; firstPaintAt: number | null; lastDrawMs?: number; avgDrawMs?: number; maxDrawMs?: number; visibleCount?: number }
      | undefined;
    if (kg) {
      kg.frames += 1;
      if (kg.firstPaintAt == null) kg.firstPaintAt = performance.now();
      kg.lastDrawMs = ms;
      kg.avgDrawMs = kg.avgDrawMs == null ? ms : kg.avgDrawMs * 0.9 + ms * 0.1;
      kg.maxDrawMs = Math.max(kg.maxDrawMs ?? 0, ms);
      let vis = 0;
      for (let i = 0; i < this.nodes.length; i++) if (this.proj[i * 5 + 4] > 0) vis++;
      kg.visibleCount = vis;
    }
    const st = this.gs.stats();
    (globalThis as unknown as { __hudPerf?: Record<string, unknown> }).__hudPerf = {
      drawMs: ms,
      drawCalls: st.calls,
      agents: this.nodes.length,
      surface: `knowledge-graph 3d · ${this.links.length} edges · q${this.quality}`,
    };
  }

  // ── Projection / picking ────────────────────────────────────

  private updateCssScale(): void {
    if (!this.container || this.surface) {
      this.cssScale = 1;
      return;
    }
    const w = this.container.offsetWidth;
    const r = this.container.getBoundingClientRect().width;
    this.cssScale = w > 0 && r > 0 ? r / w : 1;
  }

  private project(): void {
    if (this.cssScale === 1) this.updateCssScale();
    const cam = this.gs.camera;
    cam.updateMatrixWorld();
    this.tmpM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const e = this.tmpM.elements;
    const { w, h } = this.gs.size;
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    const halfH = h / 2;
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const margin = 40;
    for (let i = 0; i < this.nodes.length; i++) {
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2];
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      const o = i * 5;
      if (cw <= 0.0001) {
        this.proj[o + 4] = 0;
        continue;
      }
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
      const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
      const sx = (nx * 0.5 + 0.5) * w;
      const sy = (1 - (ny * 0.5 + 0.5)) * h;
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const sr = (this.nodes[i].r * halfH) / (dist * tanHalf);
      this.proj[o] = sx;
      this.proj[o + 1] = sy;
      this.proj[o + 2] = dist;
      this.proj[o + 3] = sr;
      this.proj[o + 4] = sx >= -margin && sx <= w + margin && sy >= -margin && sy <= h + margin ? 1 : 0;
    }
    if (this.v3) this.projectV3(e, w, h, halfH, tanHalf, cx, cy, cz);
    this.cb.onProjected?.();
  }

  /** v3: region/super-node screen discs, cluster LOD switches and the glow budget. */
  private projectV3(e: ArrayLike<number>, w: number, h: number, halfH: number, tanHalf: number, cx: number, cy: number, cz: number): void {
    const v3 = this.v3!;
    const toScreen = (x: number, y: number, z: number, r: number, out: Float32Array, o: number) => {
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw <= 0.0001) {
        out[o + 3] = 0;
        return Infinity;
      }
      out[o] = (((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw) * 0.5 + 0.5) * w;
      out[o + 1] = (1 - (((e[1] * x + e[5] * y + e[9] * z + e[13]) / cw) * 0.5 + 0.5)) * h;
      const dist = Math.hypot(x - cx, y - cy, z - cz);
      out[o + 2] = (r * halfH) / (Math.max(1, dist) * tanHalf);
      out[o + 3] = 1;
      return dist;
    };
    v3.regions.forEach((r, i) => toScreen(r.c[0], r.c[1], r.c[2], r.r, this.regionProj, i * 4));
    // LOD per aggregatable unit.
    const tmp = new Float32Array(4);
    let changed = false;
    v3.units.forEach((u, ui) => {
      if (!u.aggregatable) return;
      const dist = toScreen(u.c[0], u.c[1], u.c[2], u.r, tmp, 0);
      const forced = this.unitForced.get(ui);
      if (forced != null && dist > forced * 1.6) this.unitForced.delete(ui);
      const was = this.unitCollapsed[ui] === 1;
      const want = !this.unitForced.has(ui) && tmp[3] > 0 && lodCollapsed(u.members.length, tmp[2], was);
      if (want !== was) {
        this.unitCollapsed[ui] = want ? 1 : 0;
        changed = true;
      }
    });
    if (changed) this.applyLod();
    // Super-node screen discs (picking + labels).
    const sl = this.superList;
    if (this.superProj.length < sl.length * 4) this.superProj = new Float32Array(sl.length * 4);
    sl.forEach((ui, k) => {
      const u = v3.units[ui];
      toScreen(u.c[0], u.c[1], u.c[2], superRadius(u.members.length, u.r), this.superProj, k * 4);
    });
    // Glow budget: share of the screen the visible halos cover.
    let cov = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const o = i * 5;
      if (!this.proj[o + 4] || this.hidden[i]) continue;
      const hr = this.proj[o + 3] * 1.6;
      cov += hr * hr * Math.PI;
    }
    cov /= Math.max(1, w * h);
    if (Math.abs(cov - this.glowCoverage) > this.glowCoverage * 0.08 + 0.002) {
      this.glowCoverage = cov;
      this.applyDensity();
    }
  }

  /** Apply the collapsed/expanded state: hide members, (re)build super-nodes, re-alpha edges. */
  private applyLod(): void {
    const v3 = this.v3;
    if (!v3) return;
    this.hidden.fill(0);
    const items: SuperNodeItem[] = [];
    this.superList = [];
    v3.units.forEach((u, ui) => {
      if (!this.unitCollapsed[ui]) return;
      // The family's hub stays drawn over its super-node: parents remain the
      // biggest, most visible items even at overview zoom.
      for (const m of u.members) if (m < this.hidden.length && m !== u.rep) this.hidden[m] = 1;
      this.superList.push(ui);
      items.push({
        x: u.c[0],
        y: u.c[1],
        z: u.c[2],
        radius: superRadius(u.members.length, u.r),
        color: this.colorOf(u.color),
        mix: u.mix,
        emphasis: 1,
      });
    });
    // Keep the hovered node visible if its cluster just collapsed under it.
    this.superNodes?.setItems(items);
    this.applyPositions();
    this.applyFocus();
  }

  /** Click on a super-node: open the cluster and fly to it. */
  private expandUnit(ui: number): void {
    const u = this.v3?.units[ui];
    if (!u) return;
    this.fitIds(u.members.map((m) => this.nodes[m]?.id).filter(Boolean) as string[], { fill: 0.82 });
    const d = this.tween.targetDistance();
    this.unitForced.set(ui, d > 0 ? d : this.fitDistance);
    this.unitCollapsed[ui] = 0;
    this.applyLod();
  }

  /** Super-node under a screen point (index into superList), or -1. */
  private hitSuper(px: number, py: number): number {
    for (let k = 0; k < this.superList.length; k++) {
      const o = k * 4;
      if (!this.superProj[o + 3]) continue;
      if (Math.hypot(this.superProj[o] - px, this.superProj[o + 1] - py) <= Math.max(10, this.superProj[o + 2] * 1.4)) return k;
    }
    return -1;
  }

  private hitTest(px: number, py: number, exclude = -1): number {
    let best = -1;
    let bestD = Infinity;
    const slack = this.mobile ? 14 : 7;
    for (let i = 0; i < this.nodes.length; i++) {
      if (i === exclude) continue;
      const o = i * 5;
      if (this.proj[o + 4] === 0) continue;
      if (this.emphasisCur[i] < 0.05 || this.hidden[i]) continue;
      const dx = this.proj[o] - px;
      const dy = this.proj[o + 1] - py;
      const d = Math.sqrt(dx * dx + dy * dy);
      const r = Math.max(5, this.proj[o + 3]) + slack;
      // Prefer the nearer node when discs overlap.
      const score = d - r + this.proj[o + 2] * 0.002;
      if (d <= r && score < bestD) {
        bestD = score;
        best = i;
      }
    }
    return best;
  }

  private updateHover(px: number, py: number): void {
    const i = this.hitTest(px, py);
    if (i === this.hoverIndex) return;
    if (this.hoverIndex >= 0 && this.nodesLayer) {
      this.nodesLayer.setScale(this.hoverIndex, 1);
      this.nodesLayer.commitPositions();
    }
    this.hoverIndex = i;
    this.hoverScale = 1;
    this.hoverScaleTarget = i >= 0 ? 1.18 : 1;
    if (this.gs.canvas.style) this.gs.canvas.style.cursor = i >= 0 || this.hitSuper(px, py) >= 0 ? "pointer" : "grab";
    this.cb.onHover(i >= 0 ? this.nodes[i].id : null);
    this.requestRender();
  }

  // ── Labels (DOM pool, collision-free, LOD by camera distance) ──

  private layoutLabels(): void {
    const { w, h } = this.gs.size;
    const cands: Cand[] = [];
    const v3 = this.v3;
    const fogNear = this.gs.uniforms.uFogNear.value;
    const fogFar = this.gs.uniforms.uFogFar.value;
    for (let i = 0; i < this.nodes.length; i++) {
      const o = i * 5;
      if (this.proj[o + 4] === 0) continue;
      const emph = this.emphasisTarget[i];
      if (emph < 0.2 || this.hidden[i]) continue;
      // A collapsed family's hub is named by its (size-scaled) super-node pill.
      if (v3 && v3.units[v3.unitOf[i]]?.rep === i && this.unitCollapsed[v3.unitOf[i]] === 1 && this.focusId !== this.nodes[i].id) continue;
      const dist = this.proj[o + 2];
      const k = (0.5 * this.fitDistance) / Math.max(1, dist);
      const info = this.cb.labelFor(this.nodes[i], k);
      if (!info) continue;
      const fog = Math.min(1, Math.max(0, (dist - fogNear) / (fogFar - fogNear)));
      // Clear the halo + status ring (≈1.3r) so text never sits on the orb;
      // near the right edge the label flips to the node's left side.
      const gap = this.proj[o + 3] * (this.nodes[i].anchor ? 1.5 : 1.25) + 6;
      const ls = info.scale ?? 1;
      const estW = (info.text.length * (info.cls === "minor" || info.cls === "quiet" ? 6.1 : 7.4) + 6) * ls;
      let sx = this.proj[o] + gap;
      let sy = this.proj[o + 1];
      if (ls >= 1.25) {
        // Big hubs: name centred above the gem — their link fans run sideways,
        // and a side label would collide with what they connect to.
        sx = Math.max(4, Math.min(w - estW - 4, this.proj[o] - estW / 2));
        sy = this.proj[o + 1] - gap - 4 * ls;
      } else if (this.mobile) {
        // Phones: centred under the orb — side labels get ambiguous when the
        // galaxy is small and dense.
        sx = Math.max(4, Math.min(w - estW - 4, this.proj[o] - estW / 2));
        sy = this.proj[o + 1] + gap - 2;
      } else if (sx + estW > w - 6) sx = this.proj[o] - gap - estW;
      if (sx < -10 || sy < -10 || sy > h + 10) continue;
      // Never under the Signals panel (desktop inset).
      if (this.safeInset > 0 && sx < this.safeInset) continue;
      // Phones: a label sitting on another orb reads as that orb's name —
      // drop it (the hover/tap card still names the node).
      if (this.mobile && this.labelHitsOtherOrb(i, sx, sy, estW, 15 * ls)) continue;
      // v3: cluster hubs outrank their members (parents > large clusters > rest).
      let boost = 0;
      if (v3) {
        const u = v3.units[v3.unitOf[i]];
        if (u && u.rep === i && u.members.length > 1) boost = 600 + Math.round(250 * Math.log2(u.members.length));
      }
      cands.push({
        id: this.nodes[i].id,
        region: v3 ? v3.regionOf[i] : -1,
        text: info.text,
        cls: info.cls,
        pri: info.pri + boost + (info.cls === "focus" ? 0 : Math.round((1 - fog) * 40)),
        x: sx,
        y: sy,
        width: estW,
        height: 15 * ls,
        scale: ls,
        fade: (1 - fog * 0.85) * Math.min(1, emph + 0.15),
      });
    }
    if (v3) {
      this.layoutLabelsV3(cands, w, h);
      return;
    }
    // Group names sit on the near rim of their halo and outrank node labels.
    if (this.haloItems.length && this.groups.length) {
      const cam = this.gs.camera;
      for (let gi = 0; gi < this.haloItems.length && gi < this.groups.length; gi++) {
        if (this.groups[gi].anchor != null || !this.groups[gi].label) continue;
        const hi = this.haloItems[gi];
        this.tmpV.set(hi.x, hi.y + hi.radius * 0.92, hi.z).project(cam);
        if (this.tmpV.z > 1) continue;
        const sx = (this.tmpV.x * 0.5 + 0.5) * w;
        const sy = (1 - (this.tmpV.y * 0.5 + 0.5)) * h;
        if (sx < -20 || sx > w + 20 || sy < -10 || sy > h + 10) continue;
        const text = this.groups[gi].label.toUpperCase();
        const width = text.length * (this.groups[gi].volume ? 8.6 : 7.4) + 14;
        // Keep lobe names inside the canvas (lateral anchors sit near the edge on phones).
        const sxc = Math.min(Math.max(sx, width / 2 + 4), w - width / 2 - 4);
        cands.push({
          id: `group:${this.groups[gi].key}`,
          text,
          cls: "group",
          // Lobe names (fixed volumes) always win placement; zone names next.
          pri: (this.groups[gi].volume ? 5000 : 900) + Math.min(80, this.groups[gi].members.length),
          x: sxc - width / 2,
          y: sy,
          width,
          height: 18,
          fade: hi.emphasis < 0.5 ? 0.45 : 0.95,
          color: this.groups[gi].color,
        });
      }
    }
    cands.sort((a, b) => b.pri - a.pri);
    // Brain mode packs hundreds of nodes into lobes: fewer, clearer labels.
    const brain = this.groups.some((g) => g.volume);
    const budget = brain ? Math.round(this.labelBudget * (this.mobile ? 0.45 : 0.35)) : this.labelBudget;
    const accepted = placeLabels(cands, 48, budget);
    this.writeLabels(cands, accepted, []);
  }

  /**
   * v3 labels: region / lobe tags OUTSIDE the node mass with leader lines,
   * super-node counts, then node names with a per-region quota (top-N per
   * region, scaled by the region's on-screen area — zooming in reveals more).
   */
  private layoutLabelsV3(nodeCands: Cand[], w: number, h: number): void {
    const v3 = this.v3!;
    const cam = this.gs.camera;
    const tags: Cand[] = [];
    const leaders: Array<[number, number, number, number, string, string]> = [];
    const placedTags: Array<{ x: number; y: number; w: number; h: number }> = [];
    const proj = (x: number, y: number, z: number): [number, number] | null => {
      this.tmpV.set(x, y, z).project(cam);
      if (this.tmpV.z > 1) return null;
      return [(this.tmpV.x * 0.5 + 0.5) * w, (1 - (this.tmpV.y * 0.5 + 0.5)) * h];
    };
    // Floating panels over the canvas (signals HUD, shape legend, pill) are
    // obstacles: tags never hide under them.
    if (this.surface || !this.container) {
      for (const r of this.surface?.obstacles?.() ?? []) {
        if (r.w > 0 && r.h > 0) placedTags.push({ x: r.x - 6, y: r.y + r.h / 2, w: r.w + 12, h: r.h + 12 });
      }
    } else {
      const host = this.container.getBoundingClientRect();
      const scope = this.container.parentElement ?? this.container;
      for (const el of scope.querySelectorAll<HTMLElement>(".kg-hud, .kg-shape-legend, .kg-hud-pill")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const x = r.left - host.left, y = r.top - host.top;
        placedTags.push({ x: x - 6, y: y + r.height / 2, w: r.width + 12, h: r.height + 12 });
      }
    }
    const overlaps = (x: number, y: number, bw: number, bh: number) =>
      placedTags.some((t) => x < t.x + t.w + 4 && x + bw + 4 > t.x && Math.abs(y - t.y) < (bh + t.h) / 2 + 3);
    /** Try a tag around `dir` from `g` at distance `dist`; returns true when placed. */
    const placeTag = (g: [number, number], dir: [number, number], dist: number, from: [number, number], text: string, color: string, pri: number, id: string, fade: number) => {
      const bw = text.length * (this.mobile ? 6.2 : 7.6) + (this.mobile ? 10 : 16);
      const bh = this.mobile ? 15 : 18;
      // Wider swings only after every usual spot failed: a tag blocked on its
      // own side (e.g. under the cerebellum on a short phone stage) moves
      // round the brain instead of vanishing.
      const passes = [[0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.25, -1.25], [1.7, -1.7, 2.2, -2.2, 2.8, -2.8]];
      for (const rots of passes) {
        for (const extra of [0, 26, 52, 90, 140]) {
          for (const rot of rots) {
            const ca = Math.cos(rot), sa = Math.sin(rot);
            const dx = dir[0] * ca - dir[1] * sa, dy = dir[0] * sa + dir[1] * ca;
            const tx = g[0] + dx * (dist + extra), ty = g[1] + dy * (dist + extra);
            // Box hangs off the tip on the outward side.
            let bx = dx >= 0 ? tx : tx - bw;
            if (Math.abs(dx) < 0.35) bx = tx - bw / 2;
            const by = ty + (dy > 0.35 ? bh / 2 : dy < -0.35 ? -bh / 2 : 0);
            bx = Math.max(4, Math.min(w - bw - 4, bx));
            const cy = Math.max(bh / 2 + 4, Math.min(h - bh / 2 - 4, by));
            if (overlaps(bx, cy, bw, bh)) continue;
            placedTags.push({ x: bx, y: cy, w: bw, h: bh });
            tags.push({ id, region: -1, text, cls: "tag", pri, x: bx, y: cy, width: bw, height: bh, fade, color });
            // Leader: from the region edge to the nearest point of the tag box.
            const lx = Math.max(bx, Math.min(bx + bw, from[0]));
            const ly = Math.max(cy - bh / 2, Math.min(cy + bh / 2, from[1]));
            if (Math.hypot(lx - from[0], ly - from[1]) > 8) leaders.push([from[0], from[1], lx, ly, color, id]);
            return true;
          }
        }
      }
      return false;
    };
    const fi = this.focusId ? this.indexOf(this.focusId) : -1;
    const focusRegion = fi >= 0 ? v3.regionOf[fi] : -1;
    if (v3.mode === "brain" && this.cortex && v3.brainScale > 0) {
      const S = v3.brainScale;
      const g = proj(0, -0.12 * S, 0) ?? [w / 2, h / 2];
      // Silhouette support: projected brain bounds + every lobe anchor.
      // Silhouette support: projected cortex surface samples. The extent along
      // a direction only counts points within ±30° of it, so a tag lands just
      // outside the outline it points at (not past the brain's far tip).
      const pts: Array<[number, number]> = [];
      const hull = this.cortex.hull;
      for (let k = 0; k < hull.length; k += 3) {
        const q = proj(hull[k] * S, hull[k + 1] * S, hull[k + 2] * S);
        if (q) pts.push(q);
      }
      const extent = (dx: number, dy: number) => {
        let m = 0;
        for (const q of pts) {
          const vx = q[0] - g[0], vy = q[1] - g[1];
          const along = vx * dx + vy * dy;
          if (along <= 0) continue;
          if (Math.abs(vx * dy - vy * dx) > along * 0.58) continue;
          m = Math.max(m, along);
        }
        if (m === 0) for (const q of pts) m = Math.max(m, (q[0] - g[0]) * dx + (q[1] - g[1]) * dy);
        return m;
      };
      // The cerebellum / brainstem hang below the cerebrum: on a short phone
      // stage a tag clamped back inside the canvas would land on their rings,
      // so each X-ray part's projected box is an obstacle for every tag.
      for (const part of this.cortex.lowerParts) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < part.length; k += 3) {
          const q = proj(part[k] * S, part[k + 1] * S, part[k + 2] * S);
          if (!q) continue;
          x0 = Math.min(x0, q[0]);
          y0 = Math.min(y0, q[1]);
          x1 = Math.max(x1, q[0]);
          y1 = Math.max(y1, q[1]);
        }
        if (x1 > x0 && y1 > y0) placedTags.push({ x: x0 - 4, y: (y0 + y1) / 2, w: x1 - x0 + 8, h: y1 - y0 + 8 });
      }
      const totals = new Map<string, number>();
      for (const r of v3.regions) if (r.lobe) totals.set(r.lobe, (totals.get(r.lobe) ?? 0) + r.count);
      // Every cerebral lobe that holds nodes, plus the cerebellum and brainstem
      // always (dim when empty) so the anatomy is named.
      const lobes = [...totals.entries()]
        .filter(([l, c]) => c > 0 || l === "cerebellum" || l === "brainstem")
        .sort((a, b) => b[1] - a[1]);
      const camPos = cam.position;
      for (const [lobe, count] of lobes) {
        // The lobe's anchor on the side facing the camera.
        let best: [number, number] | null = null, bestD = Infinity;
        for (const a of this.cortex.anchors) {
          if (a.lobe !== lobe) continue;
          const d = Math.hypot(a.p[0] * S - camPos.x, a.p[1] * S - camPos.y, a.p[2] * S - camPos.z);
          const q = proj(a.p[0] * S, a.p[1] * S, a.p[2] * S);
          if (q && d < bestD) {
            bestD = d;
            best = q;
          }
        }
        if (!best) continue;
        let dx = best[0] - g[0], dy = best[1] - g[1];
        const l = Math.hypot(dx, dy);
        if (l < 1) {
          dx = 0;
          dy = -1;
        } else {
          dx /= l;
          dy /= l;
        }
        if (h > w * 1.15) {
          // Phones: the brain spans the width — tags go above / below it.
          dx *= 0.3;
          if (Math.abs(dy) < 0.4) dy = dy < 0 ? -0.75 : 0.75;
          const l2 = Math.hypot(dx, dy);
          dx /= l2;
          dy /= l2;
        }
        const r = v3.regions.find((x) => x.lobe === lobe);
        const label = (r?.label ?? lobe).replace(/ · [LR]$/, "");
        const dim = focusRegion >= 0 && v3.regions[focusRegion]?.lobe !== lobe;
        placeTag(g, [dx, dy], extent(dx, dy) + 18, best, `${label.toUpperCase()} · ${count}`, r?.color ?? "#d4af37", 9000 + count, `tag:${lobe}`, dim || !count ? 0.5 : 0.96);
      }
    } else {
      const g = proj(0, 0, 0) ?? [w / 2, h / 2];
      // Many small zones (project / cluster modes): tag only the shared
      // regions and the genuinely big zones — a small zone is named by its hub.
      const total = v3.regions.reduce((a, r) => a + r.count, 0);
      const special = (k: string, c: number) => k === "unlinked" || k === "solo" || (k === "unfiled" && c >= 5);
      let order = v3.regions.map((_, i) => i).filter((i) => v3.regions[i].count > 0).sort((a, b) => v3.regions[b].count - v3.regions[a].count);
      const cap = this.mobile ? 4 : 8;
      if (order.length > cap && (this.mobile || v3.mode === "project" || v3.mode === "cluster")) {
        const minBig = Math.max(8, Math.round(total * 0.03));
        const sp = order.filter((i) => special(v3.regions[i].key, v3.regions[i].count));
        const big = order.filter((i) => !special(v3.regions[i].key, v3.regions[i].count) && v3.regions[i].key !== "unfiled" && v3.regions[i].count >= minBig);
        order = [...sp, ...big].slice(0, cap + sp.length);
      }
      let ringK = 0;
      for (const ri of order) {
        const r = v3.regions[ri];
        const o = ri * 4;
        if (!this.regionProj[o + 3]) continue;
        const sx = this.regionProj[o], sy = this.regionProj[o + 1], rs = this.regionProj[o + 2];
        if (rs < 6 && order.length > 12) continue;
        let dx: number, dy: number;
        let from: [number, number];
        if (r.shape === "ring") {
          // Orbit band: tag off the ring's far rim, fanned so bands don't stack.
          const a = -Math.PI / 2 + (ringK++ % 2 ? 0.5 : -0.5) * (1 + ringK * 0.15);
          dx = Math.cos(a);
          dy = Math.sin(a);
          const rim = proj(r.c[0] + Math.cos(a) * r.r, r.c[1], r.c[2] + Math.sin(a) * r.r) ?? [sx, sy - rs];
          from = rim;
          dx = rim[0] - g[0];
          dy = rim[1] - g[1];
          const l = Math.hypot(dx, dy) || 1;
          dx /= l;
          dy /= l;
          placeTag(g, [dx, dy], l + 30, from, `${r.label.toUpperCase()} · ${r.count}`, r.color, 8000 + r.count, `tag:${r.key}`, 0.92);
          continue;
        }
        dx = sx - g[0];
        dy = sy - g[1];
        const l = Math.hypot(dx, dy);
        // A big zone near the middle: name it at its top edge (a sideways
        // direction would put the tag next to some other zone).
        if (l < rs * 0.6) {
          dx = 0;
          dy = -1;
        } else if (l < 2) {
          dx = 0;
          dy = -1;
        } else {
          dx /= l;
          dy /= l;
        }
        from = [sx + dx * rs * 0.97, sy + dy * rs * 0.97];
        const dim = focusRegion >= 0 && focusRegion !== ri;
        placeTag([sx, sy], [dx, dy], rs + 14, from, `${r.label.replace(/ cluster$/i, "").toUpperCase()} · ${r.count}`, r.color, 8000 + Math.min(900, r.count), `tag:${r.key}`, dim ? 0.45 : 0.95);
      }
    }
    // Unlinked pockets: a quiet caption on their top edge (requirement: they read as their own place).
    const pocketTags: Cand[] = [];
    for (const u of v3.units) {
      if (u.type !== "pocket" || u.members.length < 3) continue;
      if (v3.mode === "brain") continue; // pockets sit inside the brain: the lobe tags name the place
      const minRs = v3.mode === "brain" ? 70 : this.mobile ? 48 : 26;
      const ui = v3.units.indexOf(u);
      if (this.unitCollapsed[ui]) continue; // the super-node already names it
      const top = proj(u.c[0], u.c[1], u.c[2]);
      if (!top) continue;
      // Caption on the pocket's outer side (away from its region's centre).
      const rc = v3.regions[u.region];
      const rcs = rc ? proj(rc.c[0], rc.c[1], rc.c[2]) : null;
      let ox = 0, oy = -1;
      if (rcs) {
        const ddx = top[0] - rcs[0], ddy = top[1] - rcs[1];
        const dl = Math.hypot(ddx, ddy);
        if (dl > 4) {
          ox = ddx / dl;
          oy = ddy / dl;
        }
      }
      const dist = Math.hypot(u.c[0] - cam.position.x, u.c[1] - cam.position.y, u.c[2] - cam.position.z);
      const rs = (u.r * h) / 2 / (Math.max(1, dist) * Math.tan((cam.fov * Math.PI) / 360));
      if (rs < minRs) continue;
      const text = `${u.label.toUpperCase()} · ${u.members.length}`;
      const bw = text.length * 7.6 + 16;
      // Outer side first, then above / below — keep the box inside its own region.
      const ri = u.region;
      const rcx = this.regionProj[ri * 4], rcy = this.regionProj[ri * 4 + 1], rr = this.regionProj[ri * 4 + 2];
      let px = 0, py = 0, bx = 0;
      for (const [dx, dy] of [[ox, oy], [0, -1], [0, 1]] as Array<[number, number]>) {
        px = top[0] + dx * (rs + 12);
        py = top[1] + dy * (rs + 12);
        bx = Math.abs(dx) < 0.4 ? px - bw / 2 : dx > 0 ? px : px - bw;
        const far = Math.max(Math.hypot(bx - rcx, py - rcy), Math.hypot(bx + bw - rcx, py - rcy));
        if (!this.regionProj[ri * 4 + 3] || far <= rr + 6) break;
      }
      pocketTags.push({ id: `pocket:${u.key}`, region: -1, text, cls: "pocket", pri: 7500 + u.members.length, x: Math.max(4, Math.min(w - bw - 4, bx)), y: Math.max(12, Math.min(h - 12, py)), width: bw, height: 16, fade: 0.85, color: u.color });
    }
    // Super-nodes: name + count under the orb.
    const supers: Cand[] = [];
    this.superList.forEach((ui, k) => {
      const o = k * 4;
      if (!this.superProj[o + 3]) return;
      const u = v3.units[ui];
      const text = `${u.label} · ${u.members.length}`;
      // A family's hub names it: the pill scales with the hub's size (bigger hub → bigger name).
      const hubR = u.rep >= 0 && u.rep < this.nodes.length ? this.nodes[u.rep].r : 0;
      const sc = labelScaleFor(hubR);
      const bw = (text.length * 7.2 + 14) * sc;
      supers.push({ id: `super:${u.key}`, region: u.region, text, cls: "super", pri: 8500 + u.members.length + Math.round(hubR * 10), x: Math.max(4, Math.min(w - bw - 4, this.superProj[o] - bw / 2)), y: this.superProj[o + 1] + this.superProj[o + 2] * 1.5 + 10, width: bw, height: 17 * sc, fade: 0.98, color: u.color, scale: sc });
    });
    // Node quota per region ∝ its on-screen area.
    const brain = v3.mode === "brain";
    const nodeBudget = Math.round(this.labelBudget * (brain ? (this.mobile ? 0.5 : 0.42) : this.mobile ? 0.8 : 0.72));
    const area = new Float64Array(v3.regions.length);
    let totalArea = 0;
    for (let ri = 0; ri < v3.regions.length; ri++) {
      const o = ri * 4;
      if (!this.regionProj[o + 3] || !v3.regions[ri].count) continue;
      const rs = this.regionProj[o + 2];
      area[ri] = Math.min(w * h, Math.PI * rs * rs);
      totalArea += area[ri];
    }
    nodeCands.sort((a, b) => b.pri - a.pri);
    const used = new Int32Array(v3.regions.length);
    const nodes: Cand[] = [];
    for (const c of nodeCands) {
      const ri = c.region ?? -1;
      if (c.cls !== "focus" && ri >= 0 && totalArea > 0) {
        const quota = Math.max(2, Math.ceil((nodeBudget * area[ri]) / totalArea));
        if (used[ri] >= quota) continue;
        used[ri]++;
      }
      // A little air around every name (no touching stacks).
      nodes.push({ ...c, width: c.width + 10, height: c.height + 7 });
    }
    const all = [...tags, ...supers, ...pocketTags, ...nodes];
    all.sort((a, b) => b.pri - a.pri);
    const accepted = placeLabels(all, 48, tags.length + supers.length + pocketTags.length + nodeBudget);
    const acceptedIds = new Set(accepted.map((i) => all[i].id));
    this.writeLabels(all, accepted, leaders.filter((l) => acceptedIds.has(l[5])).map((l) => [l[0], l[1], l[2], l[3], l[4]] as [number, number, number, number, string]));
  }

  /** Commit label candidates to the DOM pool (+ leader lines). */
  private writeLabels(cands: Cand[], accepted: number[], leaders: Array<[number, number, number, number, string]>): void {
    if (this.surface || !this.labelLayer || !this.leaderSvg) {
      this.surface?.writeLabels(
        accepted.map((idx) => {
          const c = cands[idx];
          return { id: c.id, text: c.text, cls: c.cls, x: c.x, y: c.y, height: c.height, scale: c.scale ?? 1, opacity: c.fade, color: c.color };
        }),
        leaders,
      );
      return;
    }
    const keep = new Set<string>();
    const frag: HTMLDivElement[] = [];
    for (const idx of accepted) {
      const c = cands[idx];
      keep.add(c.id);
      let el = this.labelPool.get(c.id);
      if (!el) {
        el = document.createElement("div");
        el.dataset.text = "";
        this.labelPool.set(c.id, el);
        frag.push(el);
      }
      if (el.dataset.text !== c.text) {
        el.textContent = c.text;
        el.dataset.text = c.text;
      }
      const cls = `kg3d-label kg3d-label--${c.cls}`;
      if (el.className !== cls) el.className = cls;
      const ls = c.scale && c.scale > 1.01 ? ` scale(${c.scale.toFixed(2)})` : "";
      if (c.color && el.dataset.c !== c.color) {
        el.style.setProperty("--gc", c.color);
        el.dataset.c = c.color;
      }
      const z = this.cssScale || 1;
      el.style.transform = `translate3d(${(c.x / z).toFixed(1)}px, ${((c.y - c.height / 2) / z).toFixed(1)}px, 0)${ls}`;
      el.style.opacity = c.fade.toFixed(2);
    }
    for (const [id, el] of this.labelPool) {
      if (!keep.has(id)) {
        el.remove();
        this.labelPool.delete(id);
      }
    }
    for (const el of frag) this.labelLayer.appendChild(el);
    const z = this.cssScale || 1;
    const svg = leaders
      .map(([x0, y0, x1, y1, c]) => `<line x1="${(x0 / z).toFixed(1)}" y1="${(y0 / z).toFixed(1)}" x2="${(x1 / z).toFixed(1)}" y2="${(y1 / z).toFixed(1)}" stroke="${c}"/><circle cx="${(x0 / z).toFixed(1)}" cy="${(y0 / z).toFixed(1)}" r="2.2" fill="${c}"/>`)
      .join("");
    if (this.leaderSvg.dataset.k !== svg) {
      this.leaderSvg.innerHTML = svg;
      this.leaderSvg.dataset.k = svg;
    }
  }

  /** True when the label box overlaps a visible, emphasised orb other than node `self`. */
  private labelHitsOtherOrb(self: number, x: number, y: number, w: number, h: number): boolean {
    const y0 = y - h / 2;
    const y1 = y + h / 2;
    for (let j = 0; j < this.nodes.length; j++) {
      if (j === self) continue;
      const o = j * 5;
      if (!this.proj[o + 4] || this.emphasisTarget[j] < 0.2) continue;
      // Halo-inclusive disc, a little generous so text never kisses an orb.
      const r = Math.max(4, this.proj[o + 3]) * 1.25 + 2;
      const cx = Math.max(x, Math.min(this.proj[o], x + w));
      const cy = Math.max(y0, Math.min(this.proj[o + 1], y1));
      const dx = this.proj[o] - cx;
      const dy = this.proj[o + 1] - cy;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }

  // ── Pointer handling ────────────────────────────────────────

  private local(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.gs.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private pointerOf(e: PointerEvent): StagePointer {
    const { x, y } = this.local(e);
    return {
      x,
      y,
      pointerType: e.pointerType,
      button: e.button,
      buttons: e.buttons,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      type: e.type,
    };
  }

  private cancelLongPress(): void {
    if (this.longPress) clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  private capture(e?: PointerEvent): void {
    if (!e) return;
    try {
      this.gs.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
  }

  private release(e?: PointerEvent): void {
    if (!e) return;
    try {
      this.gs.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
  }

  /** Movement (px) that still counts as a tap / not-yet-a-drag (set per press). */
  private tapSlop = 4;

  private onPointerDown = (ev: PointerEvent): void => this.down(this.pointerOf(ev), ev);
  private onPointerMove = (ev: PointerEvent): void => this.move(this.pointerOf(ev), ev);
  private onPointerUp = (ev: PointerEvent): void => this.up(this.pointerOf(ev), ev);

  // ── Native host input (React Native touches → the same handlers) ──────

  /** One-finger press / move / release in stage px (native hosts). Returns true when the stage took the gesture (node drag, link, lasso). */
  pointerDown(p: StagePointer): boolean {
    this.down(p);
    return this.gestureOwned();
  }

  pointerMove(p: StagePointer): boolean {
    this.move(p);
    return this.gestureOwned();
  }

  pointerUp(p: StagePointer): void {
    this.up(p);
  }

  /** Cancel a press without acting (a second finger landed: pinch / pan). */
  pointerCancel(): void {
    this.cancelLongPress();
    if (this.drag?.moved) this.cb.onDragEnd(this.drag.index, -1);
    if (this.linkDrag?.moved) this.cb.onLinkEnd?.(-1);
    if (this.lasso) this.cb.onLasso?.([], true);
    this.drag = null;
    this.linkDrag = null;
    this.lasso = null;
    this.downAt = null;
    this.gs.controls.enabled = true;
  }

  /** Double tap (native) = double click. */
  doubleTapAt(x: number, y: number): void {
    if (this.projDirty) {
      this.project();
      this.projDirty = false;
    }
    const i = this.hitTest(x, y);
    if (i >= 0) this.cb.onOpen(this.nodes[i].id);
  }

  /** True while a node drag, link drag or lasso owns the current press. */
  gestureOwned(): boolean {
    return !!(this.drag || this.linkDrag || this.lasso);
  }

  /**
   * Camera gestures for native hosts — the same maths OrbitControls applies
   * to touch input on the web (rotate / pan by px, dolly by pinch ratio).
   */
  orbitBy(dx: number, dy: number): void {
    const c = this.gs.controls as unknown as { _rotateLeft(a: number): void; _rotateUp(a: number): void; rotateSpeed: number };
    const h = Math.max(1, this.gs.size.h);
    c._rotateLeft((2 * Math.PI * dx * c.rotateSpeed) / h);
    c._rotateUp((2 * Math.PI * dy * c.rotateSpeed) / h);
    this.cameraMoved();
  }

  panBy(dx: number, dy: number): void {
    const controls = this.gs.controls;
    const c = controls as unknown as { _panLeft(d: number, m: THREE.Matrix4): void; _panUp(d: number, m: THREE.Matrix4): void; panSpeed: number };
    const cam = this.gs.camera;
    let dist = this.tmpV.copy(cam.position).sub(controls.target).length();
    dist *= Math.tan(((cam.fov / 2) * Math.PI) / 180);
    const h = Math.max(1, this.gs.size.h);
    c._panLeft((2 * dx * c.panSpeed * dist) / h, cam.matrix);
    c._panUp((2 * dy * c.panSpeed * dist) / h, cam.matrix);
    this.cameraMoved();
  }

  /** Two-finger twist: spin the view around the vertical axis by `radians`. */
  twistBy(radians: number): void {
    if (!Number.isFinite(radians) || !radians) return;
    (this.gs.controls as unknown as { _rotateLeft(a: number): void })._rotateLeft(radians);
    this.cameraMoved();
  }

  /** Pinch: `ratio` = current finger distance / previous (> 1 zooms in). */
  dollyBy(ratio: number): void {
    if (!(ratio > 0) || !Number.isFinite(ratio)) return;
    const c = this.gs.controls as unknown as { _dollyOut(s: number): void; zoomSpeed: number };
    c._dollyOut(Math.pow(ratio, c.zoomSpeed));
    this.cameraMoved();
  }

  private cameraMoved(): void {
    this.tween.cancel?.();
    this.lastInteraction = performance.now();
    this.cb.onUserMoved();
    if (this.hoverIndex >= 0) this.updateHover(-1e6, -1e6);
    this.projDirty = true;
    this.requestRender();
  }

  /** Native: the host's surface size changed. */
  get size(): { w: number; h: number } {
    return this.gs.size;
  }

  private down(e: StagePointer, ev?: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    this.longPressFired = false;
    // A fingertip wobbles more than a mouse: a touch tap tolerates ~10px.
    this.tapSlop = e.pointerType === "mouse" ? 4 : 10;
    this.lastInteraction = performance.now();
    const { x, y } = e;
    if (this.projDirty) {
      this.project();
      this.projDirty = false;
    }
    const i = this.hitTest(x, y);
    // Touch long-press opens the context menu (no right button on phones).
    if (e.pointerType !== "mouse") {
      this.cancelLongPress();
      const id = i >= 0 ? this.nodes[i].id : null;
      this.longPress = {
        x,
        y,
        id,
        timer: setTimeout(() => {
          const lp = this.longPress;
          this.longPress = null;
          if (!lp) return;
          this.drag = null;
          this.linkDrag = null;
          this.longPressFired = true;
          this.gs.controls.enabled = true;
          this.cb.onContextMenu?.(lp.id, lp.x, lp.y);
        }, 520),
      };
    }
    if (i >= 0 && (e.ctrlKey || e.metaKey || this.linkMode)) {
      // Connector drag: the node stays put, a line follows the pointer.
      this.gs.controls.enabled = false;
      this.linkDrag = { index: i, moved: false, sx: x, sy: y };
      this.capture(ev);
      return;
    }
    if (i >= 0) {
      // Node hit: keep OrbitControls out of it (capture phase runs first).
      this.gs.controls.enabled = false;
      const p = this.worldOf(i, new THREE.Vector3());
      // Drag on the camera-facing plane through the node: the node follows
      // the pointer exactly and keeps its depth from this viewpoint (in 3D a
      // ground plane would make high/low nodes jump under the cursor).
      const camDir = this.gs.camera.getWorldDirection(this.tmpV).clone();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir.negate(), p);
      this.drag = { index: i, moved: false, sx: x, sy: y, plane, over: -1 };
      this.capture(ev);
      return;
    }
    if (e.shiftKey || this.selectMode) {
      // Lasso on empty space; OrbitControls must not orbit underneath.
      this.gs.controls.enabled = false;
      this.lasso = [x, y];
      this.capture(ev);
      ev?.stopPropagation();
      return;
    }
    this.drag = null;
    this.pointer.x = x;
    this.pointer.y = y;
    this.downAt = { x, y };
  }

  private move(e: StagePointer, ev?: PointerEvent): void {
    const { x, y } = e;
    if (this.longPress && Math.hypot(x - this.longPress.x, y - this.longPress.y) > 8) this.cancelLongPress();
    if (this.lasso) {
      const n = this.lasso.length;
      if (Math.hypot(x - this.lasso[n - 2], y - this.lasso[n - 1]) >= 4) {
        this.lasso.push(x, y);
        this.cb.onLasso?.(this.lasso, false);
      }
      ev?.stopPropagation();
      return;
    }
    if (this.linkDrag) {
      const d = this.linkDrag;
      if (!d.moved) {
        if (Math.hypot(x - d.sx, y - d.sy) < this.tapSlop) return;
        d.moved = true;
        this.cb.onLinkStart?.(d.index);
      }
      const over = this.hitTest(x, y, d.index);
      this.cb.onLinkMove?.(x, y, over);
      return;
    }
    if (this.drag) {
      const d = this.drag;
      if (!d.moved) {
        if (Math.hypot(x - d.sx, y - d.sy) < this.tapSlop) return;
        d.moved = true;
        this.cb.onDragStart(d.index);
      }
      const ndc = new THREE.Vector2((x / this.gs.size.w) * 2 - 1, -(y / this.gs.size.h) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.gs.camera);
      const hit = this.raycaster.ray.intersectPlane(d.plane, this.tmpV2);
      if (!hit) return;
      const node = this.nodes[d.index];
      const lx = hit.x + this.center.cx;
      const ly = hit.z + this.center.cy;
      node.x = lx;
      node.y = ly;
      node.z = hit.y;
      this.cb.onDrag(d.index, lx, ly, hit.y);
      this.markPositionsDirty();
      // Drop target = whatever node sits under the pointer (projection of the
      // dragged node itself is excluded).
      if (this.projDirty) {
        this.project();
        this.projDirty = false;
      }
      const over = this.hitTest(x, y, d.index);
      if (over !== d.over) {
        d.over = over;
        this.cb.onDragOver?.(d.index, over);
      }
      return;
    }
    if (e.buttons !== 0) {
      // Orbiting / panning: drop hover so the highlight doesn't flicker.
      if (this.hoverIndex >= 0) this.updateHover(-1e6, -1e6);
      return;
    }
    this.pointer.x = x;
    this.pointer.y = y;
    this.pointer.pending = true;
    this.requestRender();
  }

  private up(e: StagePointer, ev?: PointerEvent): void {
    this.lastInteraction = performance.now();
    this.cancelLongPress();
    if (this.longPressFired) {
      this.longPressFired = false;
      this.downAt = null;
      this.release(ev);
      return;
    }
    const { x, y } = e;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (this.lasso) {
      const pts = this.lasso;
      this.lasso = null;
      this.gs.controls.enabled = true;
      this.release(ev);
      if (pts.length >= 6) this.cb.onLasso?.(pts, true);
      else {
        this.cb.onLasso?.([], true);
        if (!additive) this.cb.onSelect(null);
      }
      return;
    }
    if (this.linkDrag) {
      const d = this.linkDrag;
      this.linkDrag = null;
      this.gs.controls.enabled = true;
      this.release(ev);
      if (d.moved) this.cb.onLinkEnd?.(this.hitTest(x, y, d.index));
      else this.cb.onSelect(this.nodes[d.index].id, { additive: true });
      return;
    }
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      this.gs.controls.enabled = true;
      this.release(ev);
      if (d.moved) this.cb.onDragEnd(d.index, d.over);
      else this.cb.onSelect(this.nodes[d.index].id, { additive });
      return;
    }
    const down = this.downAt;
    this.downAt = null;
    if (down && Math.hypot(x - down.x, y - down.y) < this.tapSlop && e.type === "pointerup") {
      const k = this.hitSuper(x, y);
      if (k >= 0) {
        this.expandUnit(this.superList[k]);
        return;
      }
      this.cb.onSelect(null);
    }
  }

  private onPointerLeave = (): void => {
    if (!this.drag && this.hoverIndex >= 0) this.updateHover(-1e6, -1e6);
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const { x, y } = this.local(e);
    const i = this.hitTest(x, y);
    if (i >= 0) this.cb.onOpen(this.nodes[i].id);
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const { x, y } = this.local(e);
    if (this.projDirty) {
      this.project();
      this.projDirty = false;
    }
    const i = this.hitTest(x, y);
    this.cb.onContextMenu?.(i >= 0 ? this.nodes[i].id : null, x, y);
  };

  private onControlsStart = (): void => {
    this.lastInteraction = performance.now();
    this.cb.onUserMoved();
  };

  private onControlsChange = (): void => {
    this.projDirty = true;
    this.requestRender();
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.cb.onContextLost();
  };

  private colorOf(css: string): THREE.Color {
    let c = this.colorCache.get(css);
    if (!c) {
      c = toColor(css);
      this.colorCache.set(css, c);
    }
    return c;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.pause.stop();
    const canvas = this.gs.canvas;
    if (this.labelLayer) {
    canvas.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    canvas.removeEventListener("pointermove", this.onPointerMove, { capture: true });
    canvas.removeEventListener("pointerup", this.onPointerUp, { capture: true });
    canvas.removeEventListener("pointercancel", this.onPointerUp, { capture: true });
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("dblclick", this.onDoubleClick);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    canvas.removeEventListener("webglcontextlost", this.onContextLost);
    }
    this.cancelLongPress();
    this.gs.controls.removeEventListener("start", this.onControlsStart);
    this.gs.controls.removeEventListener("change", this.onControlsChange);
    this.nodesLayer?.dispose();
    this.linksLayer?.dispose();
    this.statusRings?.dispose();
    this.halos?.dispose();
    this.lobes?.dispose();
    this.cortex?.dispose();
    this.superNodes?.dispose();
    this.bundlesLayer?.dispose();
    this.dropLines?.geometry.dispose();
    (this.dropLines?.material as THREE.Material | undefined)?.dispose();
    for (const o of this.ambience) {
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
    }
    this.labelLayer?.remove();
    this.labelPool.clear();
    this.gs.dispose();
  }
}

function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Frame gate for hosts that pause the loop themselves (native screens). */
export function alwaysActive(): CanvasPause {
  let active = true;
  const gate: CanvasPause = {
    isActive: () => active,
    wantsFrame: () => true,
    start: () => {
      active = true;
    },
    stop: () => {
      active = false;
    },
    onChange: null,
  };
  return gate;
}

/**
 * A frame gate the host flips (screen focus, app foreground): `set(false)`
 * stops the render loop, `set(true)` resumes it.
 */
export function manualPause(initial = true): CanvasPause & { set(active: boolean): void } {
  let active = initial;
  const gate = {
    isActive: () => active,
    wantsFrame: () => true,
    start: () => {},
    stop: () => {},
    onChange: null as ((active: boolean) => void) | null,
    set(next: boolean) {
      if (next === active) return;
      active = next;
      gate.onChange?.(active);
    },
  };
  return gate;
}
