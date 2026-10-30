/**
 * MeshWorldScene — the three.js renderer behind <mesh-world-3d> (and the
 * mobile expo-gl embed).
 *
 * Draws a MeshWorldLayout (views/agent-ops/mesh-world-model.ts — the same
 * model the 2D map is fed from) as a premium low-poly diorama:
 *
 *   static world   station plinth, beveled rooms, walls / glass partitions,
 *                  one landmark per sector, plugin towers, federation islands
 *                  → 5 merged meshes (floor / body / metal / glow / glass)
 *   furniture      desks, chairs, plants, racks, rest pods → instanced kits;
 *                  every monitor is one instance of an animated screen shader
 *                  whose brightness follows the agent at that desk
 *   agents         articulated avatars (world-agents.ts) — legs, torso, arms,
 *                  head + visor — instanced per part, posed per activity
 *                  (agentActivity: idle / wait / type / think / talk / error /
 *                  rest) + walking along door-to-door paths; floor status
 *                  halos, contact shadows, outline on hover / selection,
 *                  screen-space name tags with a status-icon chip
 *   fx             handoff beams, rings, sparks, spawn / despawn columns,
 *                  thinking orbit + speech dots, success hop, error flash
 *   ambience       hemisphere + key light (shadow map on the high tier),
 *                  baked contact shadows everywhere, bloom on emissives, fog
 *
 * Performance: repeated things are instanced, static things merged; labels
 * come from one screen-space atlas with greedy decluttering; the loop renders
 * on demand (camera input, tweens, walking / animated agents, live effects)
 * and stops when nothing moves; the host pauses it when hidden; DPR is capped
 * per quality tier and the tier adapts to measured FPS (low: no shadows, no
 * bloom).
 */
import * as THREE from "three";
import { CameraTween, createGlowScene, type GlowScene, type GlowSurface } from "../../lib/glow3d";
import type { AgentActivity, AgentVisualState, MeshWorldLayout, PlacedAgent, WorldEffect, WorldZone } from "../../views/agent-ops/mesh-world-model";
import { BED_SLOTS, agentActivity } from "../../views/agent-ops/mesh-world-model";
import { LabelAtlas, roundRect } from "./label-atlas";
import { AutoTier, FpsMeter, initialTier, settingsFor, type QualityMode, type QualityTier, type TierSettings } from "./quality";
import { AVATAR_HEIGHT, AvatarRig, HALO_MODE, HaloSet, poseFor, restPose, type AvatarColors } from "./world-agents";
import { buildStaticWorld } from "./world-architecture";
import {
  BlobSet,
  FLOOR_Y,
  GlowSprites,
  KIT_IDS,
  MAX_ZONES,
  PART_KINDS,
  ScreenSet,
  StaticBuilder,
  blobTexture,
  buildingHeight,
  createKits,
  createWorldMaterials,
  createWorldUniforms,
  partMesh,
  rbox,
  screenMaterial,
  toX,
  toZ,
  type AnimSpec,
  type DoorSpot,
  type Kit,
  type KitId,
  type PartKind,
  type WorldBuild,
  type WorldUniforms,
} from "./world-geometry";
import { BeamPool, DroneSet, GlyphPool, HoloPanels, RingPool, ScanPool, SparkPool, buildLinks, type LinkSpec } from "./world-fx";
import { hexCss, worldThemeFrom, type ThemeTokens, type WorldTheme } from "./world-theme";

/** Default (black + gold) status colours; live scenes use `scene.palette.state`. */
export const STATE_COLOR: Record<AgentVisualState, number> = { ...worldThemeFrom().state };

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Tool kind → the pulse it plays (search scans, shell glyphs, media sparkles, edit swirls). */
export type ToolPulse = "scan" | "terminal" | "sparkle" | "edit" | "ring";
export function toolPulse(kind: string, label = ""): ToolPulse {
  const k = `${kind} ${label}`.toLowerCase();
  if (/(image|video|flypic|generate_|gen_|render|media|photo|canva|draw|motion)/.test(k)) return "sparkle";
  if (/(search|grep|glob|find|research|web_|fetch|read_url|lookup|browse|memory_search|rss|youtube)/.test(k)) return "scan";
  if (/(bash|exec|shell|terminal|run_|command|npm|pnpm|git |process|tmux)/.test(k)) return "terminal";
  if (/(edit|write|patch|replace|apply|multiedit|notebook|create_file|str_replace)/.test(k)) return "edit";
  return "ring";
}

const BACKEND_MONO: Record<string, string> = { "claude-code": "CL", codex: "CX", opencode: "OC", gemini: "GE" };

/** Short human label for an activity (tooltips, tags, native overlays). */
export const ACTIVITY_LABEL: Record<AgentActivity | "walk", string> = {
  idle: "Idle",
  wait: "Waiting",
  type: "Typing",
  think: "Thinking",
  talk: "Talking",
  error: "Error",
  rest: "Resting",
  walk: "Walking",
};

export interface SceneCallbacks {
  onAgentHover?(key: string | null, screen: { x: number; y: number } | null): void;
  onAgentClick?(key: string): void;
  onZoneHover?(zoneId: string | null, screen: { x: number; y: number } | null): void;
  onZoneClick?(zoneId: string): void;
  onTierChange?(tier: QualityTier): void;
  onFollowEnd?(): void;
  /** Double-click on the world: the view was reset. */
  onReset?(): void;
  /** After every rendered frame (hosts move their HTML overlay panels here). */
  onFrame?(): void;
}

export interface SceneOptions {
  container?: HTMLElement;
  surface?: GlowSurface;
  mobile?: boolean;
  reducedMotion?: boolean;
  quality?: QualityMode;
  /**
   * Draw name tags / zone signs in-GL (needs a 2D canvas for the atlas).
   * Default: on wherever a DOM exists. Native hosts render `labelAnchors()`
   * in their own overlay instead.
   */
  labels?: boolean;
  /** Appearance theme (tokens from the host's CSS / app theme). Default: black + gold. */
  theme?: ThemeTokens;
  /** Env-map reflections allowed on this surface (needs float render targets). Default true. */
  reflections?: boolean;
}

/** A name tag / zone sign / agent panel the host should draw (screen px, canvas-relative). */
export interface LabelAnchor {
  kind: "agent" | "zone" | "panel";
  id: string;
  name: string;
  sub: string;
  state?: AgentVisualState;
  activity?: AgentActivity | "walk";
  x: number;
  y: number;
  alpha: number;
  pinned: boolean;
  /** Panels: scale (distance LOD), expanded (hover / selection) and live data. */
  scale?: number;
  expanded?: boolean;
  task?: string;
  tool?: string;
  progress?: number;
  startedAt?: number;
}

/** Where a host-drawn overlay panel goes this frame (top-left corner, canvas px). */
export interface PanelAnchor {
  key: string;
  x: number;
  y: number;
  /** Bottom edge of the scaled panel (the nub sits here, just above the head). */
  bottom: number;
  /** Anchor point (agent head) the panel's pointer aims at. */
  ax: number;
  ay: number;
  scale: number;
  alpha: number;
  expanded: boolean;
}

interface AgentRt {
  key: string;
  placed: PlacedAgent;
  bot: boolean;
  x: number;
  z: number;
  tx: number;
  tz: number;
  path: DoorSpot[];
  zoneId: string;
  desk: number;
  heading: number;
  /** Per-agent shell variation (0..1) — identity without rainbow colours. */
  shade: number;
  scale: number;
  born: number;
  leaving: number; // 0 = not leaving, else time it started
  phase: number;
  walking: boolean;
  lie: number; // 0..1 lying-down blend (finished runs on beds)
  activity: AgentActivity;
  celebrateAt: number;
  errorAt: number;
  talkUntil: number;
  /** Last tool pulse (time) — drives the brighter "busy" beat. */
  toolAt: number;
  /** Distance scale applied this frame (overview LOD). */
  lod: number;
}

interface LabelPick {
  kind: "agent" | "zone";
  key: string;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  /** Pixel nudge keeping the label inside the view (screen y down). */
  dx: number;
  dy: number;
  d: number;
  pin: boolean;
  scale: number;
  alpha: number;
  rt?: AgentRt;
  zone?: WorldZone;
  /** Agent drawn as an overlay panel (host DOM / native view) instead of a GL tag. */
  panel?: boolean;
  expanded?: boolean;
  /** Panel box (unscaled px). */
  pw?: number;
  ph?: number;
}

interface AnimRt {
  spec: AnimSpec;
  obj: THREE.Group;
  zone: number;
  a: [number, number, number];
}

const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(0xffffff);
/** Avatars are drawn at roughly 1.75 tiles tall so they read at overview zoom. */
const AGENT_SCALE = 1.6;
/** Name tags beyond this camera distance are culled (LOD). */
const BASE_LABEL_FAR = 85;
/** Agent panels beyond this distance collapse to name tags. */
const BASE_PANEL_FAR = 80;
const AGENT_TAG = { w: 216, h: 40 };
const ZONE_SIGN = { w: 264, h: 50 };

export class MeshWorldScene {
  readonly glow: GlowScene;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly tween: CameraTween;
  private readonly uTime = { value: 0 };
  private readonly t0 = performance.now();
  private readonly mobile: boolean;
  private reducedMotion: boolean;
  private qualityMode: QualityMode;
  private tier: QualityTier;
  private settings: TierSettings;
  private readonly auto: AutoTier;
  readonly meter = new FpsMeter(120);
  private theme: WorldTheme;
  private readonly reflectionsAllowed: boolean;

  // lights
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly fill: THREE.DirectionalLight;
  private envTex: THREE.Texture | null = null;

  // static world
  private readonly worldGroup = new THREE.Group();
  private readonly worldU: WorldUniforms;
  private materials: Record<PartKind, THREE.Material>;
  private kits: Record<KitId, Kit>;
  private readonly blobTex: THREE.DataTexture;
  private build: WorldBuild | null = null;
  private screens: ScreenSet | null = null;
  private staticBlobs: BlobSet | null = null;
  private lightPools: BlobSet | null = null;
  private anims: AnimRt[] = [];
  /** Smoothed per-zone intensity (index = WorldBuild.zoneIndex). */
  private readonly zoneLevel = new Float32Array(MAX_ZONES).fill(0.6);
  private zoneSig = "";
  private zones: WorldZone[] = [];
  private zoneById = new Map<string, WorldZone>();
  private zoneHit: THREE.InstancedMesh | null = null;
  private zoneHitIds: string[] = [];
  private links: THREE.LineSegments | null = null;
  private readonly corePos = new THREE.Vector3(toX(12), FLOOR_Y + 1.75, toZ(12));
  private readonly ground: THREE.Mesh;
  private readonly stars: THREE.Points;
  private readonly dust: THREE.Points;
  private readonly hoverFrame: THREE.LineSegments;

  // agents
  private readonly rig: AvatarRig;
  private readonly halos: HaloSet;
  private readonly agentBlobs: BlobSet;
  private readonly rts = new Map<string, AgentRt>();
  private boundsAt = 0;
  private readonly pose = restPose();
  private readonly colors: AvatarColors = { body: new THREE.Color(), limb: new THREE.Color(), shell: new THREE.Color(), visor: new THREE.Color(), badge: new THREE.Color() };
  private readonly mRoot = new THREE.Matrix4();

  // labels + glows + fx
  private readonly labels: LabelAtlas | null;
  private readonly zoneLabels: LabelAtlas | null;
  private readonly labelAlpha = new Map<string, number>();
  private labelsSettling = false;
  /** Labels picked by the last frame (host-drawn when the atlas is off). */
  private picked: LabelPick[] = [];
  /** Screen rects (canvas px) the host's HUD covers — labels keep out of them. */
  private labelAvoid: Array<[number, number, number, number]> = [];
  /** Agent whose overlay panel the pointer is on (host-reported) — expanded + pinned. */
  private panelHover: string | null = null;
  private panelBox = { w: 232, h: 92, ew: 300, eh: 250 };
  private readonly glows = new GlowSprites(2048);
  private readonly beams: BeamPool;
  private readonly rings: RingPool;
  private readonly sparks: SparkPool;
  private readonly glyphs: GlyphPool;
  private readonly scans: ScanPool;
  private readonly holo: HoloPanels;
  private readonly drones: DroneSet;
  private readonly droneGeo: THREE.BufferGeometry;
  private readonly droneMat: THREE.MeshStandardMaterial;
  private readonly screenMat: THREE.ShaderMaterial;

  // interaction
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private pointerDirty = false;
  private pointerIn = false;
  private pointerScreen = { x: 0, y: 0 };
  private down: { x: number; y: number; t: number } | null = null;
  private hoveredAgent: string | null = null;
  private hoveredZone: string | null = null;
  private selected: string | null = null;
  private follow: string | null = null;
  private autoRotate = false;
  private readonly cb: SceneCallbacks;

  // loop
  private raf = 0;
  private active = true;
  private lastFrame = 0;
  private continuousPrev = false;
  private controlsMoving = false;
  private frames = 0;
  private disposed = false;
  private dayness = -1;
  private wallNow = Date.now();
  private readonly container: HTMLElement | null;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpV3 = new THREE.Vector3();
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();
  private readonly tmpC2 = new THREE.Color();
  private readonly tmpE = new THREE.Euler();

  constructor(opts: SceneOptions, cb: SceneCallbacks = {}) {
    this.cb = cb;
    this.mobile = !!opts.mobile;
    this.reducedMotion = !!opts.reducedMotion;
    this.container = opts.container ?? null;
    this.qualityMode = opts.quality ?? "auto";
    this.reflectionsAllowed = opts.reflections !== false;
    this.theme = worldThemeFrom(opts.theme);
    const T = this.theme;
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
    this.tier = this.qualityMode === "auto"
      ? initialTier({ mobile: this.mobile, cores: nav?.hardwareConcurrency, memoryGb: nav?.deviceMemory })
      : this.qualityMode;
    this.settings = settingsFor(this.tier, { mobile: this.mobile });
    this.auto = new AutoTier(this.tier);

    this.glow = createGlowScene({
      container: opts.container,
      surface: opts.surface,
      bloom: { strength: T.bloom, radius: 0.6, threshold: T.bloomThreshold },
      maxPixelRatio: this.settings.maxPixelRatio,
      samples: this.mobile ? 2 : 4,
      composeAlways: this.settings.compose,
      fog: { near: 60, far: 220, color: hexCss(T.fog) },
      backdrop: { top: hexCss(T.skyTop), bottom: hexCss(T.skyBottom), glow: hexCss(T.accent) },
      camera: { fov: 40, near: 0.1, far: 900 },
    });
    this.glow.setBloom(this.settings.bloom);
    this.scene = this.glow.scene;
    this.camera = this.glow.camera;
    this.scene.fog = new THREE.Fog(T.fog, T.fogNear, T.fogFar);
    const controls = this.glow.controls;
    controls.minDistance = 3;
    controls.maxDistance = 170;
    controls.maxPolarAngle = 1.3;
    controls.dampingFactor = 0.075;
    controls.rotateSpeed = 0.7;
    controls.screenSpacePanning = false; // pan across the ground plane
    controls.zoomToCursor = true;
    controls.autoRotateSpeed = 0.35;
    controls.addEventListener("change", this.onControlsChange);
    controls.addEventListener("start", this.onControlsStart);
    this.tween = new CameraTween(this.camera, controls);
    this.camera.position.set(30, 32, 38);
    controls.target.set(0, 0, 2);
    controls.update();

    const r = this.glow.renderer;
    r.shadowMap.enabled = this.settings.shadows;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    // Lights: soft hemisphere, warm key with soft shadows, neutral rim fill.
    this.hemi = new THREE.HemisphereLight(T.hemiSky, T.hemiGround, T.hemi);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(T.keyColor, T.key);
    this.sun.position.set(-22, 38, 24);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 3;
    const sc = this.sun.shadow.camera;
    sc.left = -40;
    sc.right = 40;
    sc.top = 40;
    sc.bottom = -40;
    sc.near = 1;
    sc.far = 130;
    this.scene.add(this.sun, this.sun.target);
    this.fill = new THREE.DirectionalLight(0xdfe4ee, T.fill);
    this.fill.position.set(28, 18, -30);
    this.scene.add(this.fill);

    this.worldU = createWorldUniforms(this.uTime);
    this.materials = createWorldMaterials(this.worldU, { light: T.mode === "light", reflect: T.reflect });
    this.kits = createKits(T);
    this.blobTex = blobTexture();
    this.scene.add(this.worldGroup);

    this.ground = this.createGround();
    this.scene.add(this.ground);
    this.stars = this.createStars();
    this.scene.add(this.stars);
    this.dust = this.createDust();
    this.dust.visible = this.settings.dust && !this.reducedMotion;
    this.scene.add(this.dust);

    // Hover frame (zone outline).
    const frameGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.hoverFrame = new THREE.LineSegments(frameGeo, new THREE.LineBasicMaterial({ color: T.accentHi, transparent: true, opacity: 0.9, toneMapped: false }));
    this.hoverFrame.visible = false;
    this.scene.add(this.hoverFrame);

    // Agents.
    this.rig = new AvatarRig(64, this.settings.shadows);
    this.scene.add(this.rig.group);
    this.halos = new HaloSet(512, this.uTime);
    this.agentBlobs = new BlobSet(512, this.blobTex);
    this.scene.add(this.halos.mesh, this.agentBlobs.mesh);

    // Labels: screen-space atlases rendered at the device pixel ratio.
    const atlas = opts.labels ?? typeof document !== "undefined";
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    this.labels = atlas ? new LabelAtlas(AGENT_TAG.w, AGENT_TAG.h, 2048, 2048, { renderOrder: 30, screenSpace: true, scale: dpr }) : null;
    this.zoneLabels = atlas ? new LabelAtlas(ZONE_SIGN.w, ZONE_SIGN.h, 2048, 2048, { renderOrder: 29, screenSpace: true, scale: dpr }) : null;
    if (this.labels && this.zoneLabels) this.scene.add(this.zoneLabels.mesh, this.labels.mesh);
    this.scene.add(this.glows.mesh);

    this.beams = new BeamPool(48, this.uTime);
    this.rings = new RingPool(64, this.uTime);
    this.sparks = new SparkPool(1024, this.uTime, () => Math.min(globalThis.devicePixelRatio || 1, this.settings.maxPixelRatio));
    this.glyphs = new GlyphPool(256, this.uTime);
    this.scans = new ScanPool(24, this.uTime);
    this.screenMat = screenMaterial(this.uTime);
    this.holo = new HoloPanels(128, this.screenMat);
    this.scene.add(this.beams.mesh, this.rings.mesh, this.sparks.points, this.glyphs.mesh, this.scans.mesh, this.holo.mesh);

    // Ambient drones: slim body, four rotor rings, one accent light (glow sprite).
    const db = new StaticBuilder();
    db.add("body", rbox(0.34, 0.07, 0.22, 0.03), 0xffffff, 0, 0, 0);
    for (const [x, z] of [[-0.2, -0.14], [0.2, -0.14], [-0.2, 0.14], [0.2, 0.14]]) db.add("body", new THREE.TorusGeometry(0.08, 0.012, 4, 16), 0xffffff, x, 0.02, z, 0, undefined, Math.PI / 2);
    this.droneGeo = db.geometries().body!;
    this.droneMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: T.bodyHi, roughness: 0.3, metalness: 0.8 });
    this.drones = new DroneSet(16, this.droneGeo, this.droneMat);
    this.scene.add(this.drones.mesh);

    if (this.container) {
      const c = this.glow.canvas;
      c.addEventListener("pointermove", this.onPointerMove);
      c.addEventListener("pointerdown", this.onPointerDown);
      c.addEventListener("pointerup", this.onPointerUp);
      c.addEventListener("pointerleave", this.onPointerLeave);
      c.addEventListener("dblclick", this.onDoubleClick);
      c.addEventListener("webglcontextlost", this.onContextLost, false);
    }
    this.applyThemeLook();
    this.updateDayNight(true);
    this.invalidate();
  }

  // ── public API ──────────────────────────────────────────────────────────

  get canvas(): HTMLCanvasElement {
    return this.glow.canvas;
  }

  get qualityTier(): QualityTier {
    return this.tier;
  }

  get mode(): QualityMode {
    return this.qualityMode;
  }

  setQuality(mode: QualityMode): void {
    this.qualityMode = mode;
    if (mode !== "auto") this.applyTier(mode);
    else {
      this.auto.tier = this.tier;
      this.auto.reset();
    }
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.dust.visible = this.settings.dust && !on;
    if (on) this.setAutoRotate(false);
    this.invalidate();
  }

  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    this.auto.reset();
    this.meter.clear();
    if (on) {
      this.lastFrame = 0;
      this.invalidate();
    } else if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  resize(): void {
    this.glow.resize();
    this.invalidate();
  }

  /** Apply a fresh layout (zones + placed agents) from the shared model. */
  setLayout(layout: MeshWorldLayout): void {
    this.lastLayout = layout;
    const sig = layout.zones.map((z) => `${z.id}:${z.c},${z.r},${z.w},${z.h}:${z.accent}:${z.status ?? ""}`).join("|");
    if (sig !== this.zoneSig) {
      this.zoneSig = sig;
      this.zones = layout.zones;
      this.zoneById = new Map(layout.zones.map((z) => [z.id, z]));
      this.rebuildWorld(layout);
    }
    this.zones = layout.zones;
    this.zoneById = new Map(layout.zones.map((z) => [z.id, z]));
    const now = this.now();
    this.wallNow = Date.now();
    const seen = new Set<string>();
    for (const p of layout.agents) {
      seen.add(p.key);
      let tx = toX(p.c);
      let tz = toZ(p.r);
      const desk = p.where === "desk" ? this.deskAt(p.zoneId, tx, tz) : -1;
      if (desk >= 0) {
        const d = this.build!.desks[desk];
        tx = d.sx;
        tz = d.sz;
      }
      let rt = this.rts.get(p.key);
      if (!rt) {
        rt = {
          key: p.key,
          placed: p,
          bot: !!(p.agent.isBuild || p.agent.coderBackend),
          x: tx,
          z: tz,
          tx,
          tz,
          path: [],
          zoneId: p.zoneId,
          desk,
          heading: desk >= 0 ? this.build!.desks[desk].heading : (hash32(p.key) % 628) / 100,
          shade: (hash32(p.key + "c") % 1000) / 1000,
          scale: (0.94 + (hash32(p.key + "s") % 13) / 100) * AGENT_SCALE,
          born: now,
          leaving: 0,
          phase: (hash32(p.key) % 1000) / 159,
          walking: false,
          lie: p.where === "bed" && (p.state === "done" || p.state === "error") ? 1 : 0,
          activity: agentActivity(p, this.wallNow),
          celebrateAt: 0,
          errorAt: 0,
          talkUntil: 0,
          toolAt: 0,
          lod: 1,
        };
        this.rts.set(p.key, rt);
      } else {
        rt.leaving = 0;
        rt.bot = !!(p.agent.isBuild || p.agent.coderBackend);
        if (Math.hypot(rt.tx - tx, rt.tz - tz) > 0.05) this.routeTo(rt, p.zoneId, tx, tz);
        rt.desk = desk;
      }
      rt.placed = p;
      rt.zoneId = p.zoneId;
      rt.tx = tx;
      rt.tz = tz;
      if (this.reducedMotion) {
        rt.x = tx;
        rt.z = tz;
        rt.path = [];
      }
    }
    for (const [key, rt] of this.rts) {
      if (!seen.has(key) && !rt.leaving) rt.leaving = now;
    }
    if (this.selected && !seen.has(this.selected)) this.selected = null;
    if (this.follow && !seen.has(this.follow)) {
      this.follow = null;
      this.cb.onFollowEnd?.();
    }
    this.invalidate();
  }

  /** Play model effects (spawn / finish / tool / message / federation / task / leave). */
  playEffects(effects: readonly WorldEffect[]): void {
    if (!effects.length) return;
    const now = this.now();
    const T = this.theme;
    const sparks = this.reducedMotion ? 0 : this.settings.sparks;
    const particles = this.settings.particles && !this.reducedMotion;
    for (const e of effects) {
      switch (e.kind) {
        case "spawn": {
          const p = this.agentPos(e.key);
          if (!p) break;
          const rt = this.rts.get(e.key);
          if (rt) rt.born = now;
          this.rings.spawn(p.x, FLOOR_Y + 0.02, p.z, this.color(T.accentHi), 1.8, now);
          if (sparks) this.sparks.burst(p.x, FLOOR_Y + 0.2, p.z, this.color(T.accent), Math.round(sparks * 0.8), now, "column");
          // Handoff: the parent beams the task to the new agent.
          const parent = rt?.placed.agent.parent;
          const pp = parent ? this.agentPos(parent) : null;
          if (pp) this.beams.spawn(pp.clone().setY(1.7), p.clone().setY(1.7), this.color(T.accentHi), now, 1.6);
          break;
        }
        case "complete": {
          const p = this.agentPos(e.key);
          if (!p) break;
          const rt = this.rts.get(e.key);
          if (rt) {
            if (e.success) rt.celebrateAt = now;
            else rt.errorAt = now;
          }
          const col = this.color(e.success ? T.accentHi : T.state.error);
          this.rings.spawn(p.x, FLOOR_Y + 0.02, p.z, col, e.success ? 2.8 : 2.2, now);
          if (e.success) this.rings.spawn(p.x, FLOOR_Y + 0.02, p.z, this.color(T.state.done), 1.6, now + 0.15);
          if (sparks) this.sparks.burst(p.x, 1.5, p.z, col, e.success ? Math.round(sparks * 1.4) : Math.round(sparks * 0.6), now, "burst");
          if (e.success && particles) this.sparks.burst(p.x, 1.6, p.z, this.color(T.state.done), Math.round(sparks * 0.6), now + 0.1, "sparkle");
          break;
        }
        case "tool": {
          const p = this.agentPos(e.key);
          const rt = this.rts.get(e.key);
          if (!p || !rt) break;
          rt.toolAt = now;
          const kind = toolPulse(e.tool, e.label);
          const head = FLOOR_Y + AVATAR_HEIGHT * rt.scale * rt.lod;
          const acc = this.color(T.accent);
          if (!particles || kind === "ring") {
            this.rings.spawn(p.x, FLOOR_Y + 0.02, p.z, acc, 1.1, now);
            break;
          }
          if (kind === "scan") this.scans.spawn(p.x, FLOOR_Y + 0.03, p.z, acc, 2.6, now);
          else if (kind === "terminal") this.glyphs.emit(p.x, head * 0.85, p.z, acc, 7, now);
          else if (kind === "sparkle") this.sparks.burst(p.x, head * 0.7, p.z, this.color(T.accentHi), 22, now, "sparkle");
          else this.sparks.burst(p.x, FLOOR_Y + 0.3, p.z, acc, 18, now, "swirl");
          this.rings.spawn(p.x, FLOOR_Y + 0.02, p.z, acc, 0.9, now);
          break;
        }
        case "message": {
          const a = this.agentPos(e.from) ?? this.corePos.clone();
          const b = this.agentPos(e.to) ?? this.corePos.clone();
          if (a.distanceTo(b) < 0.3) break;
          for (const k of [e.from, e.to]) {
            const rt = this.rts.get(k);
            if (rt) rt.talkUntil = now + 2.4;
          }
          const col = e.type === "response" ? T.tint : e.type === "broadcast" ? T.state.done : T.accentHi;
          this.beams.spawn(a.clone().setY(a.y > 1 ? a.y : 1.7), b.clone().setY(b.y > 1 ? b.y : 1.7), this.color(col), now);
          break;
        }
        case "federation": {
          const z = this.zoneById.get(`node:${e.nodeId}`);
          if (!z) break;
          const island = new THREE.Vector3(toX(z.c + z.w / 2), FLOOR_Y + 2.8, toZ(z.r + z.h / 2));
          const core = this.corePos.clone();
          const col = e.type === "fail" || e.type === "disconnect" ? T.state.error : e.type === "ack" ? T.state.done : T.accentHi;
          if (e.type === "ack") this.beams.spawn(island, core, this.color(col), now, 1.4);
          else this.beams.spawn(core, island, this.color(col), now, 1.4);
          this.rings.spawn(island.x, FLOOR_Y + 0.02, island.z, this.color(col), 2.6, now);
          break;
        }
        case "task": {
          const h = this.build?.hubs.get("mission-control");
          if (h) this.rings.spawn(h.x, FLOOR_Y + 0.02, h.z, this.color(T.accent), 2.8, now);
          break;
        }
        case "leave": {
          const p = this.agentPos(e.key);
          if (p && sparks) this.sparks.burst(p.x, FLOOR_Y + 0.2, p.z, this.color(T.tint), Math.round(sparks * 0.6), now, "column");
          break;
        }
      }
    }
    this.invalidate();
  }

  /** The live world palette (status colours, accent) for host chrome. */
  get palette(): WorldTheme {
    return this.theme;
  }

  /**
   * Re-theme the world from the host's appearance tokens. Rebuilds the
   * materials, kits, env map and static geometry when the palette changes.
   */
  setTheme(tokens: ThemeTokens): void {
    const next = worldThemeFrom(tokens);
    if (next.sig === this.theme.sig) return;
    this.theme = next;
    for (const m of Object.values(this.materials)) m.dispose();
    this.materials = createWorldMaterials(this.worldU, { light: next.mode === "light", reflect: next.reflect });
    for (const kit of Object.values(this.kits)) for (const g of Object.values(kit)) g?.dispose();
    this.kits = createKits(next);
    this.applyThemeLook();
    // Labels redraw with the new ink.
    if (this.labels) for (const k of this.labels.keys()) this.labels.release(k);
    if (this.zoneLabels) for (const k of this.zoneLabels.keys()) this.zoneLabels.release(k);
    const layout = this.lastLayout;
    this.zoneSig = "";
    if (layout) this.setLayout(layout);
    this.invalidate();
  }

  private lastLayout: MeshWorldLayout | null = null;

  /** Fog, backdrop, lights, ground, bloom and env map for the current theme. */
  private applyThemeLook(): void {
    const T = this.theme;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setHex(T.fog);
    fog.near = T.fogNear;
    fog.far = T.fogFar;
    this.glow.renderer.setClearColor(T.skyBottom, 1);
    this.glow.renderer.toneMappingExposure = T.exposure;
    for (const o of this.scene.children) {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (o.renderOrder === -1000 && m?.uniforms?.uTop) {
        m.uniforms.uTop.value.setHex(T.skyTop);
        m.uniforms.uBottom.value.setHex(T.skyBottom);
        m.uniforms.uGlow.value.setHex(T.accent);
      }
    }
    const fu = this.glow.uniforms as unknown as { uFogColor?: { value: THREE.Color } };
    fu.uFogColor?.value.setHex(T.fog);
    this.hemi.color.setHex(T.hemiSky);
    this.hemi.groundColor.setHex(T.hemiGround);
    this.fill.intensity = T.fill;
    if (this.glow.bloomPass) {
      this.glow.bloomPass.strength = T.bloom;
      this.glow.bloomPass.threshold = T.bloomThreshold;
    }
    const gu = (this.ground.material as THREE.ShaderMaterial).uniforms;
    gu.uBase.value.setHex(T.ground);
    gu.uLine.value.setHex(T.groundLine);
    gu.uLight.value = T.mode === "light" ? 1 : 0;
    (this.stars.material as THREE.PointsMaterial).opacity = T.mode === "light" ? 0 : 0.5;
    (this.stars.material as THREE.PointsMaterial).color.setHex(T.mode === "light" ? 0xffffff : 0xeee6cc);
    (this.dust.material as THREE.ShaderMaterial).uniforms.uColor.value.setHex(T.accentHi);
    (this.hoverFrame.material as THREE.LineBasicMaterial).color.setHex(T.accentHi);
    this.droneMat.color.setHex(T.mode === "light" ? 0x3a3936 : T.bodyHi);
    // Additive light vanishes on a light floor: status rings + glows blend normally there.
    const light = T.mode === "light";
    for (const m of [this.halos.mesh.material, this.glows.mesh.material, this.rings.mesh.material, this.scans.mesh.material] as THREE.Material[]) {
      m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      m.premultipliedAlpha = light;
      m.needsUpdate = true;
    }
    this.updateDayNight(true);
    this.applyEnvironment();
  }

  /**
   * Polished-floor reflections: a studio environment (dark room, accent
   * light strips, soft white softboxes) prefiltered once per theme. Dropped
   * on the low tier and on surfaces without float render targets.
   */
  private applyEnvironment(): void {
    const want = this.reflectionsAllowed && this.settings.reflections;
    if (!want) {
      if (this.scene.environment) {
        this.scene.environment = null;
        this.markMaterialsDirty();
      }
      return;
    }
    const T = this.theme;
    try {
      const env = new THREE.Scene();
      const room = new THREE.Mesh(new THREE.BoxGeometry(40, 14, 40), new THREE.MeshBasicMaterial({ color: T.mode === "light" ? 0xd9d5cc : 0x060608, side: THREE.BackSide }));
      env.add(room);
      const lit = (color: number, k: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) });
      const strip = new THREE.BoxGeometry(18, 0.25, 0.25);
      const accent = lit(T.accent, T.mode === "light" ? 1.2 : 3.2);
      for (const [x, z, ry] of [[0, -16, 0], [0, 16, 0], [-16, 0, Math.PI / 2], [16, 0, Math.PI / 2]] as const) {
        const m = new THREE.Mesh(strip, accent);
        m.position.set(x, 5.5, z);
        m.rotation.y = ry;
        env.add(m);
      }
      const box = new THREE.PlaneGeometry(9, 4);
      const soft = lit(0xfff6e6, T.mode === "light" ? 2.4 : 1.6);
      for (const [x, z] of [[-8, -6], [8, 6], [7, -9]] as const) {
        const m = new THREE.Mesh(box, soft);
        m.position.set(x, 6.8, z);
        m.rotation.x = Math.PI / 2;
        env.add(m);
      }
      const pm = new THREE.PMREMGenerator(this.glow.renderer);
      const rt = pm.fromScene(env, 0.035);
      pm.dispose();
      env.traverse((o) => {
        const mm = o as THREE.Mesh;
        mm.geometry?.dispose();
        (mm.material as THREE.Material | undefined)?.dispose();
      });
      this.envTex?.dispose();
      this.envTex = rt.texture;
      const had = !!this.scene.environment;
      this.scene.environment = rt.texture;
      if (!had) this.markMaterialsDirty();
    } catch (err) {
      console.warn("[mesh-world-3d] environment map unavailable", err);
      this.scene.environment = null;
    }
  }

  private markMaterialsDirty(): void {
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (m) for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
  }

  /** Host-measured overlay panel boxes (compact / expanded, px) so declutter reserves the right space. */
  setPanelBox(box: { w: number; h: number; ew: number; eh: number }): void {
    if (Object.entries(box).every(([k, v]) => Math.abs((this.panelBox as Record<string, number>)[k] - v) < 2)) return;
    this.panelBox = { ...box };
    this.invalidate();
  }

  /** The pointer is on an agent's overlay panel: keep it expanded + pinned. */
  setPanelHover(key: string | null): void {
    if (this.panelHover === key) return;
    this.panelHover = key;
    this.invalidate();
  }

  /** Overlay panels to draw this frame (screen px, top-left corner), nearest / pinned first. */
  panelAnchors(): PanelAnchor[] {
    const out: PanelAnchor[] = [];
    for (const c of this.picked) {
      if (!c.panel || !c.rt) continue;
      const p0 = this.project(this.tmpV.set(c.x, c.y, c.z));
      if (!p0) continue;
      const w = (c.pw ?? this.panelBox.w) * c.scale;
      const h = (c.ph ?? this.panelBox.h) * c.scale;
      const cx = p0.x + c.dx;
      const bottom = p0.y + c.dy;
      out.push({ key: c.key, x: cx - w / 2, y: bottom - h, bottom, ax: p0.x, ay: p0.y, scale: c.scale, alpha: c.alpha, expanded: !!c.expanded });
    }
    return out;
  }

  select(key: string | null): void {
    this.selected = key;
    this.invalidate();
  }

  setFollow(key: string | null): void {
    this.follow = key;
    if (key) this.flyToAgent(key, 9);
    this.invalidate();
  }

  get following(): string | null {
    return this.follow;
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on && !this.reducedMotion;
    this.glow.controls.autoRotate = this.autoRotate;
    this.invalidate();
  }

  get autoRotating(): boolean {
    return this.autoRotate;
  }

  /**
   * Fly to an agent. `lift` (0..1) frames it that fraction of the view
   * height above centre — phones keep it clear of the bottom sheet.
   */
  flyToAgent(key: string, distance = 10, lift = 0): void {
    const p = this.agentPos(key);
    if (!p) return;
    p.setY(1.0);
    if (lift) {
      // Move the look-at point toward the camera along the ground: the agent rises on screen.
      const back = this.tmpV2.copy(this.camera.position).sub(this.glow.controls.target).setY(0);
      if (back.lengthSq() > 1e-6) p.add(back.normalize().multiplyScalar(distance * Math.tan((this.camera.fov * Math.PI) / 360) * 2 * lift));
    }
    this.tween.flyTo(p, distance, this.reducedMotion ? 0 : 900);
    this.invalidate();
  }

  flyToZone(id: string): void {
    const z = this.zoneById.get(id);
    if (!z) return;
    const center = new THREE.Vector3(toX(z.c + z.w / 2), z.kind === "plugin" ? 1.2 : 0.5, toZ(z.r + z.h / 2));
    this.tween.fitSphere(center, Math.max(z.w, z.h) * 0.8, this.reducedMotion ? 0 : 900);
    this.invalidate();
  }

  /** Frame the whole world (reset view). */
  resetView(ms = 900): void {
    let minX = -12, minZ = -12, maxX = 12, maxZ = 12;
    for (const z of this.zones) {
      minX = Math.min(minX, toX(z.c));
      minZ = Math.min(minZ, toZ(z.r));
      maxX = Math.max(maxX, toX(z.c + z.w));
      maxZ = Math.max(maxZ, toZ(z.r + z.h));
    }
    const center = new THREE.Vector3((minX + maxX) / 2 * 0.4, 0, (minZ + maxZ) / 2 * 0.4);
    const radius = Math.hypot(maxX - minX, maxZ - minZ) / 2;
    const aspect = this.glow.size.w / Math.max(1, this.glow.size.h);
    if (aspect < 0.8) {
      // Portrait phones: frame the core station across the width (plugins are a pan away).
      this.tween.fitSphere(new THREE.Vector3(0, 0, 3), 15.5, this.reducedMotion ? 0 : ms, 1, new THREE.Vector3(0.5, 0.95, 0.75));
      this.invalidate();
      return;
    }
    const r = Math.min(radius * 0.8, 50);
    this.tween.fitSphere(center, r, this.reducedMotion ? 0 : ms, 1, new THREE.Vector3(0.55, 0.66, 0.88));
    this.invalidate();
  }

  zoomBy(factor: number, ms = 320): void {
    const c = this.glow.controls;
    const dir = this.tmpV.copy(this.camera.position).sub(c.target);
    const d = THREE.MathUtils.clamp(dir.length() * factor, c.minDistance, c.maxDistance);
    this.tween.flyTo(c.target.clone(), d, this.reducedMotion ? 0 : ms);
    this.invalidate();
  }

  /** Pan the target across the ground plane (keyboard). dx/dz in screen-aligned units. */
  panBy(dx: number, dz: number): void {
    const c = this.glow.controls;
    const fwd = this.tmpV.copy(c.target).sub(this.camera.position).setY(0).normalize();
    const right = this.tmpV2.crossVectors(fwd, UP).normalize();
    const step = this.camera.position.distanceTo(c.target) * 0.08;
    const delta = right.multiplyScalar(dx * step).add(fwd.multiplyScalar(-dz * step));
    c.target.add(delta);
    this.camera.position.add(delta);
    c.update();
    this.invalidate();
  }

  orbitBy(dAzimuth: number): void {
    const c = this.glow.controls;
    const off = this.tmpV.copy(this.camera.position).sub(c.target);
    off.applyAxisAngle(UP, dAzimuth);
    this.camera.position.copy(c.target).add(off);
    c.update();
    this.invalidate();
  }

  /** Tilt the camera toward / away from straight-down (touch hosts; radians). */
  tiltBy(dPolar: number): void {
    const c = this.glow.controls;
    const off = this.tmpV.copy(this.camera.position).sub(c.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.phi = THREE.MathUtils.clamp(sph.phi + dPolar, 0.12, c.maxPolarAngle);
    off.setFromSpherical(sph);
    this.camera.position.copy(c.target).add(off);
    c.update();
    this.invalidate();
  }

  /**
   * Hosts without DOM pointer events (native): resolve a tap at canvas px and
   * fire the same click callbacks a pointer tap would.
   */
  tapAt(x: number, y: number, touch = true): void {
    this.setPointerPx(x, y);
    this.setAutoRotate(false);
    const hit = this.raycast();
    const agent = hit.agent ?? (touch ? this.nearestAgentOnScreen({ x, y }, 28) : null);
    if (agent) this.cb.onAgentClick?.(agent);
    else if (hit.zone) this.cb.onZoneClick?.(hit.zone);
  }

  /** Name tags + zone signs to draw this frame when the in-GL atlas is off. */
  labelAnchors(): LabelAnchor[] {
    const out: LabelAnchor[] = [];
    for (const c of this.picked) {
      const p0 = this.project(this.tmpV.set(c.x, c.y, c.z));
      if (!p0) continue;
      const p = { x: p0.x + c.dx, y: p0.y + c.dy };
      if (c.kind === "zone" && c.zone) {
        const z = c.zone;
        out.push({ kind: "zone", id: z.id, name: z.name, sub: z.subtitle, x: p.x, y: p.y, alpha: c.alpha, pinned: c.pin });
      } else if (c.rt) {
        const rt = c.rt;
        const a = rt.placed.agent;
        const base = { id: rt.key, name: a.label || a.agentId || rt.key, sub: a.currentTask || "", state: rt.placed.state, activity: rt.walking ? ("walk" as const) : rt.activity, x: p.x, y: p.y, alpha: c.alpha, pinned: c.pin };
        if (c.panel) {
          const tool = rt.placed.tool?.label || a.activityLabel || (a.lastActivity?.label as string | undefined) || "";
          out.push({ ...base, kind: "panel", scale: c.scale, expanded: !!c.expanded, task: a.currentTask || "", tool, progress: Number.isFinite(a.progress) ? a.progress : undefined, startedAt: a.startedAt });
        } else out.push({ ...base, kind: "agent" });
      }
    }
    return out;
  }

  /** Screen position (px, relative to the canvas) of an agent's head. */
  agentScreen(key: string): { x: number; y: number } | null {
    const rt = this.rts.get(key);
    if (!rt) return null;
    return this.project(this.tmpV.set(rt.x, FLOOR_Y + AVATAR_HEIGHT * rt.scale * 0.7, rt.z));
  }

  /** Screen position (px) of an agent's feet — tooltips sit below this so they never cover the name tag. */
  agentFeetScreen(key: string): { x: number; y: number } | null {
    const rt = this.rts.get(key);
    if (!rt) return null;
    return this.project(this.tmpV.set(rt.x, FLOOR_Y, rt.z));
  }

  zoneScreen(id: string): { x: number; y: number } | null {
    const z = this.zoneById.get(id);
    if (!z) return null;
    const h = z.kind === "plugin" ? buildingHeight(z) * 0.5 : 0.6;
    return this.project(this.tmpV.set(toX(z.c + z.w / 2), h, toZ(z.r + z.h / 2)));
  }

  /** HUD rects (x, y, w, h in canvas px) labels must not slide under. */
  setLabelAvoid(rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>): void {
    this.labelAvoid = rects.map((r) => [r.x, r.y, r.x + r.w, r.y + r.h]);
    this.invalidate();
  }

  /** What an agent is visibly doing right now (tooltips / tests). */
  agentActivity(key: string): AgentActivity | "walk" | null {
    const rt = this.rts.get(key);
    return rt ? (rt.walking ? "walk" : rt.activity) : null;
  }

  /** Live positions for the minimap. */
  positions(): Array<{ key: string; x: number; z: number; state: AgentVisualState }> {
    const out: Array<{ key: string; x: number; z: number; state: AgentVisualState }> = [];
    for (const rt of this.rts.values()) if (!rt.leaving) out.push({ key: rt.key, x: rt.x, z: rt.z, state: rt.placed.state });
    return out;
  }

  /** Camera ground target + view azimuth (for the minimap viewport marker). */
  view(): { x: number; z: number; azimuth: number; distance: number } {
    const c = this.glow.controls;
    return {
      x: c.target.x,
      z: c.target.z,
      azimuth: Math.atan2(this.camera.position.x - c.target.x, this.camera.position.z - c.target.z),
      distance: this.camera.position.distanceTo(c.target),
    };
  }

  /** Fly the camera target to a ground point (minimap click). */
  lookAtGround(x: number, z: number): void {
    this.tween.flyTo(new THREE.Vector3(x, 0, z), this.tween.targetDistance(), this.reducedMotion ? 0 : 600);
    this.invalidate();
  }

  /** On-map agent keys (parity checks). Agents walking off are excluded. */
  agentKeys(): string[] {
    return [...this.rts.values()].filter((r) => !r.leaving).map((r) => r.key);
  }

  zoneIds(kind?: WorldZone["kind"]): string[] {
    return this.zones.filter((z) => !kind || z.kind === kind).map((z) => z.id);
  }

  stats(): {
    fps: number;
    p95: number;
    tier: QualityTier;
    mode: QualityMode;
    calls: number;
    triangles: number;
    agents: number;
    labels: number;
    frames: number;
    continuous: boolean;
    pixelRatio: number;
  } {
    const s = this.glow.stats();
    return {
      fps: Math.round(this.meter.fps * 10) / 10,
      p95: Math.round(this.meter.p95 * 10) / 10,
      tier: this.tier,
      mode: this.qualityMode,
      calls: s.calls,
      triangles: s.triangles,
      agents: this.agentKeys().length,
      labels: this.labels ? this.labels.visibleCount + (this.zoneLabels?.visibleCount ?? 0) : this.picked.length,
      frames: this.frames,
      continuous: this.continuousPrev,
      pixelRatio: this.glow.renderer.getPixelRatio(),
    };
  }

  /** Request a frame (render on demand). */
  invalidate(): void {
    if (this.disposed || !this.active || this.raf) return;
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.container) {
      const c = this.glow.canvas;
      c.removeEventListener("pointermove", this.onPointerMove);
      c.removeEventListener("pointerdown", this.onPointerDown);
      c.removeEventListener("pointerup", this.onPointerUp);
      c.removeEventListener("pointerleave", this.onPointerLeave);
      c.removeEventListener("dblclick", this.onDoubleClick);
      c.removeEventListener("webglcontextlost", this.onContextLost, false);
    }
    this.glow.controls.removeEventListener("change", this.onControlsChange);
    this.glow.controls.removeEventListener("start", this.onControlsStart);
    this.labels?.dispose();
    this.zoneLabels?.dispose();
    this.glows.dispose();
    this.beams.dispose();
    this.rings.dispose();
    this.sparks.dispose();
    this.disposeWorld();
    this.rig.dispose();
    this.halos.dispose();
    this.agentBlobs.dispose();
    for (const kit of Object.values(this.kits)) for (const g of Object.values(kit)) g?.dispose();
    this.blobTex.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.glyphs.dispose();
    this.scans.dispose();
    this.holo.dispose();
    this.screenMat.dispose();
    this.drones.dispose();
    this.droneGeo.dispose();
    this.droneMat.dispose();
    this.envTex?.dispose();
    this.scene.environment = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const o of [this.stars, this.dust, this.hoverFrame]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.sun.shadow.map?.dispose();
    this.rts.clear();
    this.glow.dispose();
    // Host-owned surfaces (expo-gl's GLView, incl. its web canvas) are not torn
    // down by glow3d; a live WebGL context keeps its detached canvas — and every
    // closure hanging off that subtree — alive, so release it here.
    if (!this.container) this.glow.renderer.forceContextLoss();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private now(): number {
    return (performance.now() - this.t0) / 1000;
  }

  private color(hex: number): THREE.Color {
    return this.tmpC.setHex(hex);
  }

  private agentPos(key: string): THREE.Vector3 | null {
    const rt = this.rts.get(key);
    return rt ? new THREE.Vector3(rt.x, FLOOR_Y, rt.z) : null;
  }

  private project(v: THREE.Vector3): { x: number; y: number } | null {
    v.project(this.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return null;
    const { w, h } = this.glow.size;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  /** Desk spot whose seat is this agent's placed position (same zone). */
  private deskAt(zoneId: string, x: number, z: number): number {
    const desks = this.build?.desks;
    if (!desks) return -1;
    let best = -1;
    let bestD = 0.35;
    for (let i = 0; i < desks.length; i++) {
      const d = desks[i];
      if (d.zoneId !== zoneId) continue;
      const dd = Math.hypot(d.sx - x, d.sz - z);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
    return best;
  }

  /** Walk route: out through the nearest door of the old room, in through the new room's door, then to the spot. */
  private routeTo(rt: AgentRt, zoneId: string, tx: number, tz: number): void {
    const doors = this.build?.doors;
    const from = doors?.get(rt.zoneId);
    const to = doors?.get(zoneId);
    if (rt.zoneId === zoneId || !from?.length || !to?.length) {
      rt.path = [{ x: tx, z: tz }];
      return;
    }
    const nearest = (list: DoorSpot[], x: number, z: number) => list.reduce((a, b) => (Math.hypot(b.x - x, b.z - z) < Math.hypot(a.x - x, a.z - z) ? b : a));
    const exit = nearest(from, tx, tz);
    const entry = nearest(to, exit.x, exit.z);
    rt.path = [exit, entry, { x: tx, z: tz }];
  }

  private applyTier(t: QualityTier): void {
    if (t === this.tier) return;
    this.tier = t;
    this.settings = settingsFor(t, { mobile: this.mobile });
    this.glow.setMaxPixelRatio(this.settings.maxPixelRatio);
    this.glow.setBloom(this.settings.bloom);
    this.glow.setCompose(this.settings.compose);
    this.sparks.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, this.settings.maxPixelRatio));
    const r = this.glow.renderer;
    if (r.shadowMap.enabled !== this.settings.shadows) {
      r.shadowMap.enabled = this.settings.shadows;
      this.rig.setShadows(this.settings.shadows);
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (m) for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
      });
    }
    this.dust.visible = this.settings.dust && !this.reducedMotion;
    this.applyEnvironment();
    this.meter.clear();
    this.auto.rewarm();
    this.cb.onTierChange?.(t);
    this.invalidate();
  }

  private disposeWorld(): void {
    for (const child of [...this.worldGroup.children]) {
      this.worldGroup.remove(child);
      if (child instanceof THREE.InstancedMesh) child.dispose(); // kit geometry is shared
      else if (child instanceof THREE.Group) child.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      else (child as THREE.Mesh).geometry?.dispose();
    }
    this.anims = [];
    this.screens?.dispose();
    this.screens = null;
    this.staticBlobs?.dispose();
    this.staticBlobs = null;
    this.lightPools?.dispose();
    this.lightPools = null;
    if (this.zoneHit) {
      this.scene.remove(this.zoneHit);
      this.zoneHit.geometry.dispose();
      (this.zoneHit.material as THREE.Material).dispose();
      this.zoneHit.dispose();
      this.zoneHit = null;
    }
    if (this.links) {
      this.scene.remove(this.links);
      this.links.geometry.dispose();
      (this.links.material as THREE.Material).dispose();
      this.links = null;
    }
  }

  private rebuildWorld(layout: MeshWorldLayout): void {
    this.disposeWorld();
    const T = this.theme;
    const b = new StaticBuilder();
    const build = buildStaticWorld(b, layout.zones, BED_SLOTS, T);
    this.build = build;
    for (const m of b.build(this.materials)) this.worldGroup.add(m);

    // Furniture kits: one InstancedMesh per kit part.
    const m = this.tmpM;
    for (const id of KIT_IDS) {
      const list = build.kits.filter((k) => k.kit === id);
      if (!list.length) continue;
      const kit = this.kits[id];
      for (const part of PART_KINDS) {
        const geo = kit[part];
        if (!geo) continue;
        const mesh = new THREE.InstancedMesh(geo, this.materials[part], list.length);
        list.forEach((k, i) => {
          this.tmpE.set(0, k.rotY, 0);
          this.tmpQ.setFromEuler(this.tmpE);
          m.compose(this.tmpV.set(k.x, k.y, k.z), this.tmpQ, this.tmpS.setScalar(k.scale));
          mesh.setMatrixAt(i, m);
          mesh.setColorAt(i, this.tmpC.setHex(k.tint));
        });
        mesh.castShadow = part === "body" || part === "metal";
        mesh.receiveShadow = part === "body";
        mesh.computeBoundingSphere();
        mesh.name = `kit-${id}-${part}`;
        this.worldGroup.add(mesh);
      }
    }

    // Moving centerpiece parts: one group per spec, shared materials.
    for (const spec of build.anims) {
      const g = new THREE.Group();
      g.position.set(spec.x, spec.y, spec.z);
      for (const kind of PART_KINDS) {
        const geo = spec.geos[kind];
        if (geo) g.add(partMesh(geo, this.materials, kind, `anim-${spec.zoneId}-${kind}`));
      }
      if (spec.rot) g.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
      this.worldGroup.add(g);
      this.anims.push({ spec, obj: g, zone: build.zoneIndex.get(spec.zoneId) ?? -1, a: [0, 0, 0] });
    }

    // Screens + contact shadows + light pools.
    this.screens = new ScreenSet(build.screens, this.uTime);
    this.worldGroup.add(this.screens.mesh);
    this.staticBlobs = new BlobSet(Math.max(1, build.blobs.length), this.blobTex);
    this.staticBlobs.begin();
    for (const s of build.blobs) this.staticBlobs.push(s.x, s.z, s.sx, s.sz, s.rot, s.a);
    this.staticBlobs.end();
    this.worldGroup.add(this.staticBlobs.mesh);
    this.lightPools = new BlobSet(Math.max(1, build.pools.length), this.blobTex, FLOOR_Y + 0.012, { color: new THREE.Color(T.accent).multiplyScalar(T.mode === "light" ? 0.12 : 0.5) });
    this.worldGroup.add(this.lightPools.mesh);

    // Atrium globe = the hub federation beams start from.
    const hub = build.hubs.get("command-atrium");
    if (hub) this.corePos.set(hub.x, hub.y, hub.z);

    // Zone hit boxes (one instanced, invisible) — buildings are tall, slabs flat.
    const hitGeo = new THREE.BoxGeometry(1, 1, 1);
    hitGeo.translate(0, 0.5, 0);
    const hit = new THREE.InstancedMesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }), Math.max(1, layout.zones.length));
    this.zoneHitIds = [];
    layout.zones.forEach((z, i) => {
      const h = z.kind === "plugin" ? buildingHeight(z) + 0.3 : z.kind === "island" ? 3.4 : 0.3;
      this.tmpM.compose(
        this.tmpV.set(toX(z.c + z.w / 2), z.kind === "island" ? -0.3 : 0, toZ(z.r + z.h / 2)),
        this.tmpQ.identity(),
        this.tmpS.set(z.w - 0.2, h, z.h - 0.2),
      );
      hit.setMatrixAt(i, this.tmpM);
      this.zoneHitIds.push(z.id);
    });
    hit.count = layout.zones.length;
    hit.computeBoundingSphere();
    this.zoneHit = hit;
    this.scene.add(hit);

    // Conduits (gate → plugin rooms, on the floor) + federation arcs — accent only.
    const specs: LinkSpec[] = layout.links.map((l) => {
      const fed = l.kind === "federation";
      return {
        a: new THREE.Vector3(toX(l.from.c), fed ? 2.4 : FLOOR_Y + 0.03, toZ(l.from.r)),
        b: new THREE.Vector3(toX(l.to.c), fed ? FLOOR_Y + 2.8 : FLOOR_Y + 0.03, toZ(l.to.r)),
        color: new THREE.Color(T.accent),
        lift: fed ? 5 : 0,
      };
    });
    this.links = buildLinks(specs, this.uTime);
    if (this.links) this.scene.add(this.links);

    // Ground grid covers the world bounds.
    const span = Math.max(layout.bounds.maxC - layout.bounds.minC, layout.bounds.maxR - layout.bounds.minR) + 40;
    (this.ground.material as THREE.ShaderMaterial).uniforms.uRadius.value = span * 0.55;

    // Shadow camera fits the world.
    const sc = this.sun.shadow.camera;
    const half = span / 2 - 8;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.updateProjectionMatrix();

    // Desk assignments are indices into the new build: re-resolve.
    for (const rt of this.rts.values()) rt.desk = rt.placed.where === "desk" ? this.deskAt(rt.placed.zoneId, toX(rt.placed.c), toZ(rt.placed.r)) : -1;

    // Zone sign slots.
    const keep = new Set(layout.zones.map((z) => z.id));
    if (this.zoneLabels) for (const k of this.zoneLabels.keys()) if (!keep.has(k)) this.zoneLabels.release(k);
  }

  private createGround(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(600, 600, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uRadius: { value: 40 }, uTime: this.uTime, uNight: { value: 0.5 }, uBase: { value: new THREE.Color() }, uLine: { value: new THREE.Color() }, uLight: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
      `,
      fragmentShader: /* glsl */ `
        uniform float uRadius; uniform float uNight; uniform vec3 uBase; uniform vec3 uLine; uniform float uLight; varying vec3 vW;
        float grid(vec2 p, float s, float w) {
          vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s);
          return 1.0 - min(min(g.x, g.y) / w, 1.0);
        }
        void main() {
          vec2 p = vW.xz;
          float d = length(p);
          float fade = 1.0 - smoothstep(uRadius * 0.5, uRadius * 1.3, d);
          float major = grid(p + 12.0, 4.0, 1.0) * mix(0.045, 0.12, uLight);
          float minor = grid(p + 12.0, 1.0, 1.0) * 0.012;
          vec3 col = mix(uBase, uLine, (major + minor) * fade * (0.6 + 0.4 * uNight));
          // Soft pool of light under the station.
          col += uLine * 0.05 * (1.0 - smoothstep(4.0, uRadius * 0.9, d)) * (1.0 - uLight);
          float a = 0.96 * (0.4 + 0.6 * fade);
          gl_FragColor = vec4(col, a);
        }
      `,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = -0.92;
    m.renderOrder = -10;
    return m;
  }

  private createStars(): THREE.Points {
    const n = 900;
    const pos = new Float32Array(n * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd() * Math.PI * 2;
      const v = 0.08 + rnd() * 0.9;
      const r = 380 + rnd() * 80;
      pos[i * 3] = Math.cos(u) * Math.cos(v * 1.4) * r;
      pos[i * 3 + 1] = Math.sin(v * 1.4) * r * 0.8 + 10;
      pos[i * 3 + 2] = Math.sin(u) * Math.cos(v * 1.4) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xeee6cc, size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0.5, fog: false, depthWrite: false });
    return new THREE.Points(geo, mat);
  }

  /** Slow motes of accent light drifting through the station (idle ambient life). */
  private createDust(): THREE.Points {
    const n = 260;
    const pos = new Float32Array(n * 3);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rnd() - 0.5) * 60;
      pos[i * 3 + 1] = 0.6 + rnd() * 8;
      pos[i * 3 + 2] = (rnd() - 0.5) * 60;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.uTime, uColor: { value: new THREE.Color(0xf5d77a) } },
      vertexShader: /* glsl */ `
        uniform float uTime; varying float vA;
        void main() {
          vec3 p = position;
          float s = p.x * 0.37 + p.z * 0.21;
          p.y += mod(uTime * 0.12 + s, 8.0) - 4.0 + sin(uTime * 0.35 + s) * 0.4;
          p.x += cos(uTime * 0.2 + s * 1.7) * 0.5;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vA = 0.3 * smoothstep(80.0, 10.0, -mv.z) * (0.5 + 0.5 * sin(uTime * 1.7 + s * 3.0));
          gl_PointSize = 40.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vA;
        void main() { float d = length(gl_PointCoord * 2.0 - 1.0); float a = pow(max(0.0, 1.0 - d), 2.0) * vA; gl_FragColor = vec4(uColor * a, a); }
      `,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }

  /** Light from the local clock: a touch warmer and brighter by day (theme sets the base). */
  private updateDayNight(force = false): void {
    const d = new Date();
    const hour = d.getHours() + d.getMinutes() / 60;
    const day = 0.5 + 0.5 * Math.cos(((hour - 13) / 24) * Math.PI * 2);
    if (!force && Math.abs(day - this.dayness) < 0.01) return;
    this.dayness = day;
    const T = this.theme;
    this.hemi.intensity = T.hemi * (0.85 + 0.3 * day);
    this.sun.intensity = T.key * (0.85 + 0.3 * day);
    this.sun.color.setHex(T.keyColor);
    (this.ground.material as THREE.ShaderMaterial).uniforms.uNight.value = 1 - day;
  }

  // ── loop ────────────────────────────────────────────────────────────────

  private readonly onControlsChange = (): void => this.invalidate();
  private readonly onControlsStart = (): void => {
    // Manual input cancels follow + cinematic orbit.
    if (this.follow) {
      this.follow = null;
      this.cb.onFollowEnd?.();
    }
  };

  private readonly loop = (ms: number): void => {
    this.raf = 0;
    if (this.disposed || !this.active) return;
    const dtMs = this.lastFrame ? ms - this.lastFrame : 16.7;
    this.lastFrame = ms;
    const now = this.now();
    this.wallNow = Date.now();
    this.uTime.value = now;
    const dt = Math.min(0.05, dtMs / 1000);

    const tweening = this.tween.update(performance.now());
    if (this.follow && !tweening) this.trackFollow(dt);
    this.controlsMoving = this.glow.controls.update(dt) || this.autoRotate;
    const animating = this.updateAgents(now, dt);
    this.updateScreens();
    if (this.pointerDirty) this.pick();
    this.updateLabels(dt);
    this.updateWorldLife(now, dt);
    this.updateGlows(now);
    if ((this.frames & 63) === 0) this.updateDayNight();

    this.glow.render();
    this.frames++;
    this.cb.onFrame?.();

    const fxAlive = this.rings.alive(now) || this.sparks.alive(now) || this.glyphs.alive(now) || this.scans.alive(now) || this.beamLive > 0;
    const continuous = tweening || this.controlsMoving || animating || fxAlive || !!this.follow || this.labelsSettling;
    // Idle ambient life (rotating centerpieces, drones, motes) keeps going at a gentle 30 fps.
    if (!continuous && !this.reducedMotion && !this.disposed) {
      this.continuousPrev = false;
      this.auto.reset();
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.invalidate();
      }, 30);
      return;
    }
    if (continuous && this.continuousPrev) {
      this.meter.push(dtMs);
      if (this.qualityMode === "auto") {
        const next = this.auto.frame(dtMs, ms);
        if (next) this.applyTier(next);
      }
    } else this.auto.reset();
    this.continuousPrev = continuous;
    if (continuous) this.invalidate();
    else this.lastFrame = 0;
  };

  private beamLive = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Living world: per-zone intensity follows how many agents work there
   * (trim + centerpiece glow, spin speed), centerpieces turn, light pools
   * breathe, drones patrol.
   */
  private updateWorldLife(now: number, dt: number): void {
    const build = this.build;
    if (!build) return;
    const motion = !this.reducedMotion;
    const lv = this.zoneLevel;
    const out = this.worldU.uZoneI.value;
    const k = Math.min(1, dt * 2.2);
    for (const z of this.zones) {
      const i = build.zoneIndex.get(z.id);
      if (i === undefined) continue;
      const busy = Math.min(1, z.busy / 3);
      const hov = z.id === this.hoveredZone ? 0.25 : 0;
      const goal = (z.kind === "island" && z.status !== "online" ? 0.3 : 0.58) + busy * 0.9 + hov;
      lv[i] += (goal - lv[i]) * k;
      const breathe = motion ? 1 + 0.06 * Math.sin(now * (1.2 + busy * 2.5) + i) : 1;
      out[i] = lv[i] * breathe;
    }
    for (const an of this.anims) {
      const s = an.spec;
      const inten = an.zone >= 0 ? Math.max(0, lv[an.zone] - 0.58) / 0.9 : 0;
      if (!motion) continue;
      const mult = 1 + (s.busySpin ?? 2.5) * inten;
      if (s.spin) for (let a = 0; a < 3; a++) an.a[a] += s.spin[a] * mult * dt;
      const base = s.rot ?? [0, 0, 0];
      let rx = base[0], ry = base[1], rz = base[2];
      if (s.sway) {
        const v = Math.sin(now * s.sway.freq * Math.PI * 2 * (1 + inten)) * s.sway.amp;
        if (s.sway.axis === "x") rx += v;
        else if (s.sway.axis === "y") ry += v;
        else rz += v;
      }
      an.obj.rotation.set(rx, ry, rz);
      if (s.spin) {
        // Spin about the (tilted) local axes.
        an.obj.rotateX(an.a[0]);
        an.obj.rotateY(an.a[1]);
        an.obj.rotateZ(an.a[2]);
      }
      if (s.bob) an.obj.position.y = s.y + Math.sin(now * 1.3 + s.x) * s.bob * (1 + inten);
    }
    const pools = this.lightPools;
    if (pools) {
      pools.begin();
      for (const p of build.pools) {
        const i = build.zoneIndex.get(p.zoneId) ?? 0;
        pools.push(p.x, p.z, p.r * 2, p.r * 2, 0, p.a * Math.min(1.6, lv[i]));
      }
      pools.end();
    }
    // Drones: lazy figure-eights over the station, banking into turns.
    const n = motion ? this.settings.drones : 0;
    this.drones.begin();
    for (let i = 0; i < n; i++) {
      const sp = 0.07 + (i % 3) * 0.02;
      const t = now * sp + i * 1.7;
      const R = 9 + (i % 4) * 4;
      const x = Math.sin(t) * R;
      const z = Math.sin(t * 2) * R * 0.5 + (i % 2 ? 3 : -3);
      const y = 4.2 + (i % 3) * 1.1 + Math.sin(now * 0.8 + i) * 0.25;
      const vx = Math.cos(t) * R;
      const vz = Math.cos(t * 2) * R;
      const heading = Math.atan2(vx, vz);
      const bank = Math.max(-0.4, Math.min(0.4, -Math.sin(t * 2) * 0.35));
      this.drones.push(x, y, z, heading, bank, 1.3);
      this.dronePos[i * 3] = x;
      this.dronePos[i * 3 + 1] = y;
      this.dronePos[i * 3 + 2] = z;
    }
    this.drones.end();
    this.droneCount = n;
  }

  private droneCount = 0;
  private readonly dronePos = new Float32Array(16 * 3);

  private trackFollow(dt: number): void {
    const rt = this.follow ? this.rts.get(this.follow) : null;
    if (!rt) return;
    const c = this.glow.controls;
    const goal = this.tmpV.set(rt.x, 1.0, rt.z);
    const delta = this.tmpV2.copy(goal).sub(c.target).multiplyScalar(Math.min(1, dt * 4));
    c.target.add(delta);
    this.camera.position.add(delta);
  }

  /** Advance agent motion + write the avatar instances. Returns true while anything animates. */
  private updateAgents(now: number, dt: number): boolean {
    const live = [...this.rts.values()];
    this.rig.ensureCapacity(live.length);
    let animating = false;
    const motion = !this.reducedMotion;
    this.rig.begin();
    this.halos.begin();
    this.agentBlobs.begin();
    this.holo.begin();
    const T = this.theme;
    const particles = this.settings.particles && motion;
    const cols = this.colors;
    const camPos = this.camera.position;
    for (const rt of live) {
      // Leaving: beam out (shrink up into a column), then drop.
      let k = 1;
      let stretch = 1;
      let lift = 0;
      if (rt.leaving) {
        const t = (now - rt.leaving) / 0.7;
        if (t >= 1 || !motion) {
          this.rts.delete(rt.key);
          this.labels?.release(rt.key);
          this.labelAlpha.delete(`a:${rt.key}`);
          continue;
        }
        k = 1 - t * 0.6;
        stretch = 1 + t * 1.2;
        lift = t * 0.8;
        animating = true;
      }
      // Spawn: beam in with an overshoot pop.
      const age = now - rt.born;
      let flash = 0;
      if (age < 0.7 && motion) {
        const t = age / 0.7;
        const c1 = 1.70158;
        const c3 = c1 + 1;
        k *= Math.max(0.02, 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2));
        flash = 1 - t;
        animating = true;
      }
      if (rt.leaving) flash = Math.max(flash, (now - rt.leaving) / 0.7);

      // Walk the route.
      let target = rt.path[0];
      if (!target && Math.hypot(rt.tx - rt.x, rt.tz - rt.z) > 0.02) target = { x: rt.tx, z: rt.tz };
      rt.walking = false;
      if (target && motion) {
        const dx = target.x - rt.x;
        const dz = target.z - rt.z;
        const dist = Math.hypot(dx, dz);
        let remaining = dist;
        for (let i = 1; i < rt.path.length; i++) remaining += Math.hypot(rt.path[i].x - rt.path[i - 1].x, rt.path[i].z - rt.path[i - 1].z);
        if (dist < 0.03) {
          rt.x = target.x;
          rt.z = target.z;
          rt.path.shift();
        } else {
          const speed = Math.max(2.6, remaining / 4.5);
          const step = Math.min(dist, speed * dt);
          rt.x += (dx / dist) * step;
          rt.z += (dz / dist) * step;
          const want = Math.atan2(dx, dz);
          let dh = want - rt.heading;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          rt.heading += dh * Math.min(1, dt * 10);
          rt.walking = true;
        }
        animating = true;
      } else if (target) {
        rt.x = rt.tx;
        rt.z = rt.tz;
        rt.path = [];
      }

      const placed = rt.placed;
      const state = placed.state;
      rt.activity = now < rt.talkUntil && state === "working" ? "talk" : agentActivity(placed, this.wallNow);
      const desk = rt.desk >= 0 ? this.build?.desks[rt.desk] : undefined;
      const atDesk = !!desk && !rt.walking && Math.hypot(desk.sx - rt.x, desk.sz - rt.z) < 0.05;
      // Face the workstation; standing workers face their district's centerpiece.
      let faceTo: number | null = atDesk && desk ? desk.heading : null;
      if (faceTo === null && !rt.walking && placed.where === "desk" && state !== "idle") {
        const hub = this.build?.hubs.get(rt.zoneId);
        if (hub && Math.hypot(hub.x - rt.x, hub.z - rt.z) > 0.4) faceTo = Math.atan2(hub.x - rt.x, hub.z - rt.z);
      }
      if (faceTo !== null) {
        let dh = faceTo - rt.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        if (Math.abs(dh) > 0.01) {
          rt.heading += dh * Math.min(1, dt * 8);
          animating = true;
        }
      }
      const onBed = placed.where === "bed" && (state === "done" || state === "error");
      const lieGoal = onBed && !rt.walking ? 1 : 0;
      if (rt.lie !== lieGoal) {
        rt.lie += Math.sign(lieGoal - rt.lie) * Math.min(Math.abs(lieGoal - rt.lie), dt * 3);
        animating = true;
      }
      if (rt.lie > 0) rt.heading += (0 - Math.atan2(Math.sin(rt.heading), Math.cos(rt.heading))) * Math.min(1, dt * 6);
      if (motion && state !== "idle" && state !== "done") animating = true;
      const celebrate = rt.celebrateAt ? THREE.MathUtils.clamp(1 - (now - rt.celebrateAt) / 1.8, 0, 1) : 0;
      const errFlash = rt.errorAt ? THREE.MathUtils.clamp(1 - (now - rt.errorAt) / 1.6, 0, 1) : 0;
      if ((celebrate > 0 || errFlash > 0) && motion) animating = true;

      const t = now + rt.phase;
      const seated = atDesk && !!desk?.seated && rt.lie < 0.5;
      poseFor({ activity: rt.activity, walking: rt.walking, seated, lying: rt.lie > 0.5, t, celebrate, motion, seatHip: ((desk?.seatY ?? 0.52) + 0.04) / rt.scale }, this.pose);

      // Root: feet position, heading, lie roll, scale.
      // Lying avatars shrink a touch so they fit the rest pods.
      // Overview LOD: avatars grow with camera distance so they stay readable zoomed out.
      const lod = THREE.MathUtils.clamp(camPos.distanceTo(this.tmpV.set(rt.x, 1, rt.z)) / 34, 1, 1.6);
      rt.lod = lod;
      const sc = rt.scale * k * lod * (1 - 0.32 * rt.lie);
      const shake = errFlash > 0 && motion ? Math.sin(now * 46) * 0.06 * errFlash : 0;
      const lieX = rt.lie * 0.48 * rt.scale;
      const y = FLOOR_Y + rt.lie * 0.4 + lift;
      this.tmpE.set(0, rt.heading, rt.lie * (Math.PI / 2) * 0.98, "YXZ");
      this.tmpQ.setFromEuler(this.tmpE);
      this.mRoot.compose(this.tmpV.set(rt.x + shake + lieX, y, rt.z), this.tmpQ, this.tmpS.set(sc / Math.sqrt(stretch), sc * stretch, sc / Math.sqrt(stretch)));

      // Colours (theme palette): obsidian suit, dark-metal limbs, champagne shell
      // (bots a shade more metallic), accent visor glowing with the status.
      const stCol = T.state[state];
      cols.body.setHex(T.avatarBody).lerp(this.tmpC2.setHex(T.accentDeep), 0.12 + rt.shade * 0.1);
      cols.limb.setHex(T.avatarLimb);
      cols.shell.setHex(T.avatarShell).lerp(this.tmpC2.setHex(rt.bot ? T.metalHi : T.bodyHi), rt.bot ? 0.35 + rt.shade * 0.25 : rt.shade * 0.2);
      const visorK = state === "idle" ? 0.45 : state === "done" ? 0.6 : 0.95 + (now - rt.toolAt < 0.6 ? 0.45 : 0);
      cols.visor.setHex(state === "working" ? T.accentHi : stCol).multiplyScalar(visorK);
      cols.badge.setHex(stCol).multiplyScalar(state === "working" ? 1.4 : 1);
      const errorOn = state === "error" && motion ? 0.5 + 0.5 * Math.sin(now * 7 + rt.phase) : state === "error" ? 1 : 0;
      const red = Math.max(errFlash, errorOn * 0.6);
      if (red > 0) {
        const err = this.tmpC2.setHex(T.state.error);
        cols.visor.lerp(err, Math.min(1, red * 1.3));
        cols.body.lerp(err, red * 0.35);
      }
      if (flash > 0) {
        for (const c of [cols.body, cols.limb, cols.shell, cols.visor]) c.lerp(WHITE, flash * 0.8);
      }
      const sel = rt.key === this.selected;
      const hov = rt.key === this.hoveredAgent;
      const outline = sel ? this.tmpC2.setHex(T.accent).multiplyScalar(0.75) : hov ? this.tmpC2.setHex(T.accentHi).multiplyScalar(0.6) : null;
      this.rig.push(rt.key, this.mRoot, this.pose, rt.bot, cols, outline, rt.scale * lod * (rt.lie > 0.5 ? 0.75 : 1), this.tmpV2.set(rt.x + lieX * 0.5, FLOOR_Y, rt.z));

      // Floor status halo + contact shadow.
      if (!rt.leaving || k > 0.3) {
        const mode = rt.walking ? 0 : HALO_MODE[rt.activity];
        this.halos.push(rt.x + lieX * 0.5, FLOOR_Y + (rt.lie > 0.5 ? 0.36 : 0.012), rt.z, 1.3 * rt.scale * lod * Math.max(0.3, k), this.color(stCol), mode, sel ? 1 : hov ? 0.7 : rt.activity === "idle" || rt.activity === "rest" ? -0.5 : 0);
      }
      this.agentBlobs.push(rt.x + lieX * 0.5, rt.z, (rt.lie > 0.5 ? 1.5 : 0.95) * rt.scale, 0.95 * rt.scale, rt.heading, 0.5 * k, rt.lie > 0.5 ? 0.36 : 0);

      // Standing workers type on a floating holo-screen (seated ones use their desk screen).
      if (particles && !rt.walking && !rt.leaving && !atDesk && state === "working" && rt.lie < 0.5 && (rt.activity === "type" || rt.activity === "think")) {
        const fx = Math.sin(rt.heading);
        const fz = Math.cos(rt.heading);
        const hs = rt.scale * lod;
        const lvl = rt.activity === "type" ? (now - rt.toolAt < 1 ? 1 : 0.8) : 0.45;
        this.holo.push(rt.x + fx * 0.55 * hs, FLOOR_Y + 0.98 * hs, rt.z + fz * 0.55 * hs, rt.heading + Math.PI, -0.35, 0.62 * hs, 0.38 * hs, lvl, this.color(T.accent));
      }
    }
    const boundsDirty = now - this.boundsAt > 0.25;
    if (boundsDirty) this.boundsAt = now;
    this.rig.end(boundsDirty);
    this.halos.end();
    this.agentBlobs.end();
    this.holo.end();
    return animating;
  }

  /** Monitor brightness follows the agent at each desk; mission control follows the whole station. */
  private updateScreens(): void {
    const scr = this.screens;
    const build = this.build;
    if (!scr || !build) return;
    const level = new Map<number, number>();
    let working = 0;
    for (const rt of this.rts.values()) {
      if (rt.leaving) continue;
      if (rt.placed.state === "working") working++;
      if (rt.desk < 0 || rt.walking) continue;
      const d = build.desks[rt.desk];
      if (!d || Math.hypot(d.sx - rt.x, d.sz - rt.z) > 0.3) continue;
      const v = rt.activity === "type" ? 1 : rt.activity === "think" || rt.activity === "talk" ? 0.6 : rt.activity === "wait" ? 0.4 : rt.activity === "error" ? 0.15 : 0.3;
      level.set(rt.desk, Math.max(level.get(rt.desk) ?? 0, v));
    }
    const station = Math.min(1, 0.35 + working * 0.2);
    scr.setLevels((s) => (s.desk >= 0 ? level.get(s.desk) ?? 0 : s.zoneId === "mission-control" ? station : (this.zoneById.get(s.zoneId)?.busy ?? 0) > 0 ? 0.85 : 0.3));
  }

  private labelSig(p: PlacedAgent, act: string, sel: boolean): string {
    return `${p.agent.label}|${p.state}|${act}|${p.agent.coderBackend ?? ""}|${sel ? 1 : 0}`;
  }

  /** Small vector glyph for an activity, centred at (x, y). */
  private drawGlyph(ctx: CanvasRenderingContext2D, act: AgentActivity | "walk", x: number, y: number, ink: string): void {
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    switch (act) {
      case "type":
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(x - 5 + (i === 1 ? 2 : 0), y - 4 + i * 4);
          ctx.lineTo(x + 5 - (i === 2 ? 3 : 0), y - 4 + i * 4);
          ctx.stroke();
        }
        break;
      case "think":
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.arc(x + i * 4.5, y, 1.7, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case "talk":
        roundRect(ctx, x - 6, y - 5, 12, 8.5, 3);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 2.5, y + 3.5);
        ctx.lineTo(x - 4, y + 6.5);
        ctx.lineTo(x + 0.5, y + 3.5);
        ctx.stroke();
        break;
      case "wait":
        ctx.beginPath();
        ctx.moveTo(x - 4.5, y - 6);
        ctx.lineTo(x + 4.5, y - 6);
        ctx.lineTo(x - 4.5, y + 6);
        ctx.lineTo(x + 4.5, y + 6);
        ctx.closePath();
        ctx.stroke();
        break;
      case "error":
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x, y + 1.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y + 5, 1.4, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "rest":
        ctx.beginPath();
        ctx.moveTo(x - 5, y);
        ctx.lineTo(x - 1.5, y + 4);
        ctx.lineTo(x + 5.5, y - 4.5);
        ctx.stroke();
        break;
      case "walk":
        ctx.beginPath();
        ctx.moveTo(x - 5, y);
        ctx.lineTo(x + 5, y);
        ctx.moveTo(x + 1, y - 4);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x + 1, y + 4);
        ctx.stroke();
        break;
      default:
        ctx.font = "700 10px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("z", x - 2, y + 1);
        ctx.font = "700 7px Inter, system-ui, sans-serif";
        ctx.fillText("z", x + 3.5, y - 3);
    }
    ctx.restore();
  }

  private drawAgentLabel(p: PlacedAgent, act: AgentActivity | "walk", sel: boolean) {
    return (ctx: CanvasRenderingContext2D, w: number, h: number): number => {
      const full = p.agent.label || p.agent.agentId || p.key;
      const mono = p.agent.coderBackend ? BACKEND_MONO[p.agent.coderBackend] ?? "" : "";
      ctx.font = "600 13.5px Inter, 'Space Grotesk', system-ui, sans-serif";
      const maxText = w - 64 - (mono ? 26 : 0);
      let name = full;
      if (ctx.measureText(name).width > maxText) {
        while (name.length > 3 && ctx.measureText(name + "…").width > maxText) name = name.slice(0, -1);
        name = name.trimEnd() + "…";
      }
      const tw = ctx.measureText(name).width;
      const pillH = 28;
      const pillW = Math.min(w - 4, tw + 50 + (mono ? 26 : 0));
      const x = Math.round((w - pillW) / 2);
      const y = h - pillH - 4;
      const T = this.theme;
      const stateHex = hexCss(T.state[p.state]);
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
      roundRect(ctx, x + 1, y, pillW - 2, pillH, pillH / 2);
      ctx.fillStyle = T.labelBg;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.lineWidth = sel ? 2 : 1.25;
      ctx.strokeStyle = sel ? hexCss(T.accentHi) : hexCss(T.accent) + "8c";
      ctx.stroke();
      // Status-icon chip.
      const cx = x + 16;
      const cy = y + pillH / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 10.5, 0, Math.PI * 2);
      ctx.fillStyle = stateHex;
      ctx.fill();
      this.drawGlyph(ctx, act, cx, cy, "#121216");
      ctx.fillStyle = T.labelInk;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(name, x + 33, cy + 0.5);
      if (mono) {
        ctx.font = "700 10.5px 'JetBrains Mono', ui-monospace, monospace";
        ctx.fillStyle = hexCss(T.accent);
        ctx.fillText(mono, x + 38 + tw, cy + 0.5);
      }
      // Pointer nub toward the head.
      ctx.beginPath();
      ctx.moveTo(w / 2 - 4, y + pillH);
      ctx.lineTo(w / 2, y + pillH + 4);
      ctx.lineTo(w / 2 + 4, y + pillH);
      ctx.fillStyle = sel ? hexCss(T.accentHi) : hexCss(T.accent) + "b3";
      ctx.fill();
      return pillW;
    };
  }

  private drawZoneLabel(z: WorldZone, hovered: boolean) {
    return (ctx: CanvasRenderingContext2D, w: number, h: number): number => {
      const T = this.theme;
      const accent = hexCss(T.accent);
      const title = (z.kind === "core" ? z.name.toUpperCase() : z.name.toUpperCase()).slice(0, 26);
      const occ = z.occupants ? ` · ${z.occupants} agent${z.occupants === 1 ? "" : "s"}` : "";
      const sub = ((z.monogram && z.kind === "plugin" ? `${z.monogram} · ` : "") + z.subtitle + occ).slice(0, 40);
      const ls = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
      ctx.font = "700 13px 'Space Grotesk', Inter, system-ui, sans-serif";
      if ("letterSpacing" in ls) ls.letterSpacing = "1.2px";
      const tw = ctx.measureText(title).width;
      if ("letterSpacing" in ls) ls.letterSpacing = "0px";
      ctx.font = "500 11px Inter, system-ui, sans-serif";
      const sw = ctx.measureText(sub).width;
      const bw = Math.min(w - 4, Math.max(tw, sw) + 34);
      const x = Math.round((w - bw) / 2);
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      roundRect(ctx, x + 1, 2, bw - 2, h - 6, 9);
      ctx.fillStyle = T.labelBg;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.lineWidth = hovered ? 1.6 : 1;
      ctx.strokeStyle = hovered ? accent : accent + "61";
      ctx.stroke();
      // Accent bar.
      roundRect(ctx, x + 7, 9, 3, h - 20, 1.5);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.font = "700 13px 'Space Grotesk', Inter, system-ui, sans-serif";
      if ("letterSpacing" in ls) ls.letterSpacing = "1.2px";
      ctx.fillStyle = T.mode === "light" ? T.labelInk : hexCss(T.accentHi);
      ctx.fillText(title, x + 18, 21);
      if ("letterSpacing" in ls) ls.letterSpacing = "0px";
      ctx.font = "500 11px Inter, system-ui, sans-serif";
      ctx.fillStyle = T.labelSub;
      ctx.fillText(sub, x + 18, 37);
      return bw;
    };
  }

  /** Where a zone's sign anchors (bottom-centre of the sign). */
  private zoneAnchor(z: WorldZone, out: THREE.Vector3): THREE.Vector3 {
    const y = this.build?.labelY.get(z.id) ?? FLOOR_Y + 2;
    if (z.kind === "plugin") return out.set(toX(z.c + z.w / 2), y, toZ(z.r + z.h * 0.29));
    if (z.kind === "island") return out.set(toX(z.c + z.w / 2), y, toZ(z.r + z.h / 2));
    return out.set(toX(z.c + z.w / 2), y, toZ(z.r) + 0.9);
  }

  /**
   * Labels: agent overlay panels, zone signs and agent name tags,
   * screen-space, greedily decluttered (pinned first, then the nearest working
   * agents' panels, then tags, then signs near→far), fading in and out
   * instead of popping. Panels are drawn by the host (HTML / native views);
   * this only reserves their space and tells the host where they go.
   */
  private updateLabels(dt: number): void {
    const camPos = this.camera.position;
    const { w: vw, h: vh } = this.glow.size;
    const max = this.settings.maxLabels;
    const maxPanels = this.settings.maxPanels;
    // Portrait phones frame the station from farther away: stretch the LOD cutoffs.
    const aspect = vw / Math.max(1, vh);
    const farK = aspect < 0.8 ? 1.5 : 1;
    const LABEL_FAR = BASE_LABEL_FAR * farK;
    const PANEL_FAR = BASE_PANEL_FAR * farK;
    // Phones: smaller signs + tags so the world stays visible between them.
    const narrow = vw < 600 ? 0.9 : 1;
    const pinnedAgents: LabelPick[] = [];
    const agents: LabelPick[] = [];
    const zones: LabelPick[] = [];
    const proj = (x: number, y: number, z: number) => {
      const v = this.tmpV2.set(x, y, z).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return null;
      return { sx: ((v.x + 1) / 2) * vw, sy: ((1 - v.y) / 2) * vh };
    };
    for (const rt of this.rts.values()) {
      if (rt.leaving) continue;
      const pin = rt.key === this.selected || rt.key === this.hoveredAgent || rt.key === this.follow || rt.key === this.panelHover;
      const y = FLOOR_Y + (rt.lie > 0.5 ? 0.95 : AVATAR_HEIGHT * rt.scale * rt.lod + 0.12);
      const x = rt.x + rt.lie * 0.31 * rt.scale;
      const d = camPos.distanceTo(this.tmpV.set(x, y, rt.z));
      if (!pin && d > LABEL_FAR) continue;
      const p = proj(x, y, rt.z);
      if (!p) continue;
      const scale = (pin ? 1 : THREE.MathUtils.clamp((30 * farK) / d, 0.78, 1)) * narrow;
      (pin ? pinnedAgents : agents).push({ kind: "agent", key: rt.key, x, y, z: rt.z, sx: p.sx, sy: p.sy, dx: 0, dy: 0, d, pin, scale, alpha: 0, rt });
    }
    for (const z of this.zones) {
      const a = this.zoneAnchor(z, this.tmpV);
      const ax = a.x, ay = a.y, az = a.z;
      const d = camPos.distanceTo(a);
      if (d > 160) continue;
      const p = proj(ax, ay, az);
      if (!p) continue;
      const scale = THREE.MathUtils.clamp(42 / d, 0.82, 1) * narrow;
      zones.push({ kind: "zone", key: z.id, x: ax, y: ay, z: az, sx: p.sx, sy: p.sy, dx: 0, dy: 0, d, pin: z.id === this.hoveredZone, scale, alpha: 0, zone: z });
    }
    // Hysteresis: labels already showing keep their place, so walkers don't make signs flicker.
    const shown = (c: LabelPick) => ((this.labelAlpha.get((c.kind === "agent" ? "a:" : "z:") + c.key) ?? 0) > 0.5 ? 0 : 1);
    const panelShown = (c: LabelPick) => ((this.labelAlpha.get("p:" + c.key) ?? 0) > 0.5 ? 0 : 1);
    zones.sort((a, b) => (a.pin === b.pin ? shown(a) - shown(b) || a.d - b.d : a.pin ? -1 : 1));
    const busyRank = (c: LabelPick) => (c.rt && (c.rt.placed.state === "working" || c.rt.placed.state === "error" || c.rt.placed.state === "waiting") ? 0 : 1);
    agents.sort((a, b) => busyRank(a) - busyRank(b) || panelShown(a) - panelShown(b) || shown(a) - shown(b) || a.d - b.d);

    // Greedy declutter in screen space.
    const rects: Array<[number, number, number, number]> = this.labelAvoid.map((r) => [...r] as [number, number, number, number]);
    const placed = new Set<string>();
    const idOf = (c: LabelPick) => (c.kind === "zone" ? "z:" : c.panel ? "p:" : "a:") + c.key;
    const fits = (r: [number, number, number, number]) => rects.every((q) => r[0] >= q[2] || r[2] <= q[0] || r[1] >= q[3] || r[3] <= q[1]);
    const rectOf = (c: LabelPick, w: number, h: number, shiftX = 0): [number, number, number, number] => {
      const ww = w * c.scale;
      const hh = h * c.scale;
      // Keep the whole label on screen: slide it in from the edges.
      const m = 6;
      const cx = THREE.MathUtils.clamp(c.sx + shiftX * ww, Math.min(vw / 2, ww / 2 + m), Math.max(vw / 2, vw - ww / 2 - m));
      const top = THREE.MathUtils.clamp(c.sy - hh, m, Math.max(m, vh - hh - m));
      c.dx = cx - c.sx;
      c.dy = top - (c.sy - hh);
      return [cx - ww / 2 - 2, top - 2, cx + ww / 2 + 2, top + hh + 2];
    };
    const tagW = (c: LabelPick) => (this.labels && this.labels.keys().includes(c.key) ? this.labels.contentWidth(c.key) : Math.min(AGENT_TAG.w, 70 + (c.rt?.placed.agent.label?.length ?? 8) * 7.2));
    const signW = (c: LabelPick) => (this.zoneLabels && this.zoneLabels.keys().includes(c.key) ? this.zoneLabels.contentWidth(c.key) : Math.min(ZONE_SIGN.w, 60 + (c.zone?.name.length ?? 10) * 8.5));
    const chosen: LabelPick[] = [];
    const place = (c: LabelPick, w: number, h: number, lifts: number[], force: boolean, shifts: number[] = [0]): boolean => {
      for (const lift of lifts) {
        for (const shift of shifts) {
          const probe = { ...c, sy: c.sy - lift };
          const r = rectOf(probe, w, h, shift);
          if (force || fits(r)) {
            rects.push(r);
            c.dx = probe.dx;
            c.dy = probe.dy - lift;
            placed.add(idOf(c));
            chosen.push(c);
            return true;
          }
        }
      }
      return false;
    };
    const box = this.panelBox;
    const panelOk = (c: LabelPick) => !!c.rt && c.rt.lie < 0.5 && !c.rt.walking && (c.pin || (c.d < PANEL_FAR * 0.85 && c.rt.placed.state !== "idle" && c.rt.placed.state !== "done"));
    let panels = 0;
    for (const c of pinnedAgents) {
      if (panelOk(c) || c.pin) {
        const exp = c.key === this.selected || c.key === this.panelHover || c.key === this.hoveredAgent;
        c.panel = true;
        c.expanded = exp && !this.mobile;
        c.pw = c.expanded ? box.ew : box.w;
        c.ph = c.expanded ? box.eh : box.h;
        if (!place(c, c.pw, c.ph, [0, -40, 30], false, [0, -0.35, 0.35])) place(c, c.pw, c.ph, [0], true);
        panels++;
      } else place(c, tagW(c), 34, [0], true);
    }
    for (const c of zones) if (c.pin) place(c, signW(c), 46, [0], true);
    // Agents before signs: the people are the point; a crowded sign steps aside.
    let n = 0;
    for (const c of agents) {
      if (n >= max) break;
      if (panels < maxPanels && panelOk(c)) {
        c.panel = true;
        c.pw = box.w;
        c.ph = box.h;
        c.scale = THREE.MathUtils.clamp((30 * farK) / c.d, 0.7, 1) * narrow;
        if (place(c, box.w, box.h, [0, 26, 52], false, [0, -0.55, 0.55])) {
          panels++;
          n++;
          continue;
        }
        c.panel = false;
        c.scale = THREE.MathUtils.clamp((30 * farK) / c.d, 0.78, 1) * narrow;
      }
      if (place(c, tagW(c), 34, [0, 22, 44], false)) n++;
    }
    for (const c of zones) if (!c.pin) place(c, signW(c), 46, [0, -26, 26, 52], false);

    // Fade toward chosen / not chosen.
    const k = this.reducedMotion ? 1 : Math.min(1, dt * 9);
    let settling = false;
    const all = [...pinnedAgents, ...zones, ...agents];
    const out: LabelPick[] = [];
    const live = new Set<string>();
    for (const c of all) {
      // An agent switching tag ↔ panel fades one out while the other fades in.
      const ids = c.kind === "zone" ? ["z:" + c.key] : ["a:" + c.key, "p:" + c.key];
      for (const id of ids) {
        live.add(id);
        const mine = id === idOf(c);
        const on = mine && placed.has(id);
        const farFade = c.kind === "zone" ? 1 - THREE.MathUtils.smoothstep(c.d, 110, 160) : c.pin || c.panel ? 1 : 1 - THREE.MathUtils.smoothstep(c.d, LABEL_FAR * 0.75, LABEL_FAR);
        const goal = on ? farFade : 0;
        const cur = this.labelAlpha.get(id) ?? 0;
        const next = cur + (goal - cur) * k;
        if (Math.abs(goal - next) > 0.02) settling = true;
        this.labelAlpha.set(id, next);
        if (mine) {
          c.alpha = next;
          if (next > 0.02) out.push(c);
        }
      }
    }
    // Labels that dropped out of the candidate lists entirely fade too.
    for (const [id, a] of this.labelAlpha) if (!live.has(id) && a > 0) this.labelAlpha.set(id, 0);
    this.labelsSettling = settling;
    this.picked = out;

    if (!this.labels || !this.zoneLabels) return;
    const dpr = Math.min(this.settings.maxPixelRatio, globalThis.devicePixelRatio || 1);
    this.labels.setViewport(vw, vh, Math.max(1, dpr));
    this.zoneLabels.setViewport(vw, vh, Math.max(1, dpr));
    this.labels.begin();
    this.zoneLabels.begin();
    // Zones first (agents draw on top: higher renderOrder). Panels are host-drawn.
    for (const c of out) {
      if (c.kind === "zone" && c.zone) {
        const hov = c.zone.id === this.hoveredZone;
        const slot = this.zoneLabels.ensure(c.key, `${c.zone.name}|${c.zone.subtitle}|${c.zone.occupants}|${hov ? 1 : 0}`, this.drawZoneLabel(c.zone, hov));
        if (slot !== null) this.zoneLabels.push(c.key, c.x, c.y, c.z, c.scale, c.alpha, c.dx, -c.dy);
      } else if (c.rt && !c.panel) {
        const p = c.rt.placed;
        const act = c.rt.walking ? "walk" : c.rt.activity;
        const slot = this.labels.ensure(p.key, this.labelSig(p, act, c.pin), this.drawAgentLabel(p, act, c.pin));
        if (slot !== null) this.labels.push(p.key, c.x, c.y, c.z, c.scale, c.alpha, c.dx, -c.dy);
      }
    }
    this.labels.end();
    this.zoneLabels.end();
  }

  /**
   * Additive glows: data streams (agent → district centerpiece → gateway),
   * thinking orbit, speech dots, spawn columns, beam heads, completion
   * bursts, drone lights, building beacons.
   */
  private updateGlows(now: number): void {
    const g = this.glows;
    g.begin();
    const motion = !this.reducedMotion;
    const T = this.theme;
    const particles = this.settings.particles && motion;
    const acc = this.tmpC2.setHex(T.accent);
    const hubs = this.build?.hubs;
    const gate = hubs?.get("gateway-concourse");
    const busyZones = new Set<string>();
    for (const rt of this.rts.values()) {
      const head = FLOOR_Y + AVATAR_HEIGHT * rt.scale * rt.lod;
      if (rt.lie > 0.5) continue;
      const age = now - rt.born;
      if (age < 0.9 && motion) {
        const a = (1 - age / 0.9) * 0.55;
        for (let i = 0; i < 6; i++) g.push(rt.x, FLOOR_Y + 0.2 + i * 0.45, rt.z, 0.9 - i * 0.07, this.color(T.accentHi), a);
      }
      if (rt.leaving) {
        const a = Math.max(0, 1 - (now - rt.leaving) / 0.7) * 0.5;
        for (let i = 0; i < 6; i++) g.push(rt.x, FLOOR_Y + 0.4 + i * 0.5, rt.z, 0.8, this.color(T.tint), a);
        continue;
      }
      const state = rt.placed.state;
      // Accent aura behind every working agent — easy to spot at any zoom.
      if (state === "working") g.push(rt.x, head * 0.55, rt.z, 1.5 * rt.scale * rt.lod, acc, 0.16 + (motion ? 0.05 * Math.sin(now * 2 + rt.phase) : 0));
      if (rt.walking) continue;
      const t = now + rt.phase;
      // Gold data stream: packets flow from the agent into its district's centerpiece.
      if (particles && state === "working" && hubs) {
        const hub = hubs.get(rt.zoneId);
        if (hub) {
          busyZones.add(rt.zoneId);
          const ax = rt.x, ay = head * 0.75, az = rt.z;
          const L = Math.hypot(hub.x - ax, hub.z - az);
          if (L > 0.5) {
            const lift = Math.min(2.4, 0.6 + L * 0.25);
            const cy = Math.max(ay, hub.y) + lift;
            const n = Math.min(6, 3 + Math.floor(L / 2));
            const speed = now - rt.toolAt < 1.2 ? 0.9 : 0.45;
            for (let i = 0; i < n; i++) {
              const u = (t * speed + i / n) % 1;
              const w = 1 - u;
              const px = w * w * ax + 2 * w * u * ((ax + hub.x) / 2) + u * u * hub.x;
              const py = w * w * ay + 2 * w * u * cy + u * u * hub.y;
              const pz = w * w * az + 2 * w * u * ((az + hub.z) / 2) + u * u * hub.z;
              g.push(px, py, pz, 0.26, acc, Math.sin(u * Math.PI) * 0.85);
            }
          }
        }
      }
      if (rt.activity === "think") {
        for (let i = 0; i < 3; i++) {
          const a = (motion ? t * 2.6 : 0) + (i * Math.PI * 2) / 3;
          g.push(rt.x + Math.cos(a) * 0.5, head + 0.3 + Math.sin(a * 2) * 0.06, rt.z + Math.sin(a) * 0.5, 0.32, this.color(T.accentHi), 1);
        }
      } else if (rt.activity === "talk") {
        const fx = Math.sin(rt.heading);
        const fz = Math.cos(rt.heading);
        for (let i = 0; i < 3; i++) {
          const ph = motion ? (t * 1.6 + i / 3) % 1 : i / 3;
          g.push(rt.x + fx * (0.45 + ph * 0.6), head - 0.35 + ph * 0.3, rt.z + fz * (0.45 + ph * 0.6), 0.24 + ph * 0.16, this.color(T.tint), (1 - ph) * 0.95);
        }
      } else if (rt.activity === "error") {
        g.push(rt.x, head + 0.25, rt.z, 0.7, this.color(T.state.error), motion ? 0.35 + 0.35 * Math.max(0, Math.sin(t * 7)) : 0.5);
      }
      if (rt.errorAt && now - rt.errorAt < 1.2) {
        const a = 1 - (now - rt.errorAt) / 1.2;
        g.push(rt.x, head * 0.6, rt.z, 3.0, this.color(T.state.error), a * 0.55);
      }
      if (rt.celebrateAt && now - rt.celebrateAt < 1.8) {
        const a = 1 - (now - rt.celebrateAt) / 1.8;
        g.push(rt.x, head * 0.6, rt.z, 2.6, this.color(T.accentHi), a * 0.5);
        for (let i = 0; i < 8; i++) g.push(rt.x, FLOOR_Y + 0.3 + (1 - a) * 3 + i * 0.35 * a, rt.z, 0.5, this.color(T.state.done), a * 0.5);
      }
    }
    // Busy districts send a slow gold stream down to the gateway.
    if (particles && gate && hubs) {
      for (const id of busyZones) {
        const hub = hubs.get(id);
        if (!hub || id === "gateway-concourse") continue;
        const L = Math.hypot(hub.x - gate.x, hub.z - gate.z);
        const n = Math.min(8, 3 + Math.floor(L / 3));
        const cy = Math.max(hub.y, gate.y) + 2 + L * 0.15;
        for (let i = 0; i < n; i++) {
          const u = (now * 0.18 + i / n + (id.length % 7) * 0.13) % 1;
          const w = 1 - u;
          g.push(w * w * hub.x + 2 * w * u * ((hub.x + gate.x) / 2) + u * u * gate.x, w * w * hub.y + 2 * w * u * cy + u * u * gate.y, w * w * hub.z + 2 * w * u * ((hub.z + gate.z) / 2) + u * u * gate.z, 0.34, acc, Math.sin(u * Math.PI) * 0.7);
        }
      }
    }
    this.beamLive = this.beams.heads(now, (p, color, alpha) => g.push(p.x, p.y, p.z, 1.0, color, alpha * 0.9));
    // Centerpiece halos (brighter while busy) + drone running lights.
    if (hubs && this.build) {
      for (const [id, h] of hubs) {
        const i = this.build.zoneIndex.get(id) ?? 0;
        const lv = this.zoneLevel[i] ?? 0.6;
        g.push(h.x, h.y, h.z, 2.2 + lv, acc, (0.1 + Math.max(0, lv - 0.58) * 0.35) * (T.mode === "light" ? 0.5 : 1));
      }
    }
    for (let i = 0; i < this.droneCount; i++) {
      const blink = motion && Math.sin(now * 3 + i * 1.3) > 0.6 ? 1 : 0.55;
      g.push(this.dronePos[i * 3], this.dronePos[i * 3 + 1] - 0.05, this.dronePos[i * 3 + 2], 0.45, acc, 0.6 * blink);
    }
    g.end();
  }

  // ── picking ─────────────────────────────────────────────────────────────

  private setPointerPx(x: number, y: number, w = this.glow.size.w, h = this.glow.size.h): void {
    this.pointerScreen = { x, y };
    this.pointer.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.glow.canvas.getBoundingClientRect();
    this.setPointerPx(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    this.pointerIn = true;
    if (e.pointerType === "mouse") {
      this.pointerDirty = true;
      this.invalidate();
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.setAutoRotate(false);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 7 || performance.now() - d.t > 600) return;
    this.onPointerMove(e);
    const hit = this.raycast();
    // Fingers are coarse: a touch that misses every hit box still selects an
    // agent drawn within reach before falling through to the building under it.
    const agent = hit.agent ?? (e.pointerType === "mouse" ? this.nearestAgentOnScreen(this.pointerScreen, 10) : this.nearestAgentOnScreen(this.pointerScreen, 28));
    if (agent) this.cb.onAgentClick?.(agent);
    else if (hit.zone) this.cb.onZoneClick?.(hit.zone);
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    e.preventDefault();
    this.follow = null;
    this.resetView();
    this.cb.onReset?.();
  };

  private nearestAgentOnScreen(at: { x: number; y: number }, maxPx: number): string | null {
    let best: string | null = null;
    let bestD = maxPx;
    for (const rt of this.rts.values()) {
      if (rt.leaving) continue;
      const p = this.project(this.tmpV.set(rt.x, FLOOR_Y + 0.8 * rt.scale, rt.z));
      if (!p) continue;
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (d < bestD) {
        bestD = d;
        best = rt.key;
      }
    }
    return best;
  }

  private readonly onPointerLeave = (): void => {
    this.pointerIn = false;
    this.setHover(null, null);
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.container?.dispatchEvent(new CustomEvent("mesh3d-context-lost", { bubbles: true, composed: true }));
  };

  private raycast(): { agent: string | null; zone: string | null } {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hm = this.rig.hit;
    if (hm.count) hm.computeBoundingSphere();
    const ah = hm.count ? this.raycaster.intersectObject(hm, false)[0] : undefined;
    if (ah && ah.instanceId !== undefined) return { agent: this.rig.hitKeys[ah.instanceId] ?? null, zone: null };
    const zh = this.zoneHit ? this.raycaster.intersectObject(this.zoneHit, false)[0] : undefined;
    if (zh && zh.instanceId !== undefined) return { agent: null, zone: this.zoneHitIds[zh.instanceId] ?? null };
    return { agent: null, zone: null };
  }

  private pick(): void {
    this.pointerDirty = false;
    if (!this.pointerIn) return;
    const hit = this.raycast();
    this.setHover(hit.agent, hit.agent ? null : hit.zone);
  }

  private setHover(agent: string | null, zone: string | null): void {
    if (agent !== this.hoveredAgent) {
      this.hoveredAgent = agent;
      this.cb.onAgentHover?.(agent, agent ? { ...this.pointerScreen } : null);
    } else if (agent) this.cb.onAgentHover?.(agent, { ...this.pointerScreen });
    if (zone !== this.hoveredZone) {
      this.hoveredZone = zone;
      this.cb.onZoneHover?.(zone, zone ? { ...this.pointerScreen } : null);
      const z = zone ? this.zoneById.get(zone) : null;
      this.hoverFrame.visible = !!z;
      if (z) {
        const h = z.kind === "plugin" ? buildingHeight(z) + 0.3 : z.kind === "island" ? 3.4 : 0.3;
        this.hoverFrame.position.set(toX(z.c + z.w / 2), FLOOR_Y + h / 2 - (z.kind === "plugin" ? 0.15 : 0.12), toZ(z.r + z.h / 2));
        this.hoverFrame.scale.set(z.w - 0.1, h, z.h - 0.1);
        (this.hoverFrame.material as THREE.LineBasicMaterial).color.setHex(this.theme.accentHi);
      }
    } else if (zone) this.cb.onZoneHover?.(zone, { ...this.pointerScreen });
    if (this.container) this.glow.canvas.style.cursor = agent || zone ? "pointer" : "";
    this.invalidate();
  }
}
