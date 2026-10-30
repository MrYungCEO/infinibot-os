/**
 * Agents constellation — 3D holographic renderer (three.js) for the Agents page.
 *
 * Same contract as the 2D canvas engine (`ConstellationEngine`): the view
 * pushes nodes/edges, selection, filters and live pulses; the engine owns the
 * camera, hover card and hit-testing. Visuals:
 *
 * - A dark void with a procedural nebula sky, exponential fog, drifting dust,
 *   a fading floor grid and faint orbit rings per cluster; the camera drifts
 *   slowly until the operator takes over (orbit / pan / zoom / fly-to).
 * - Agents are glass orbs with a fresnel rim lit in their team colour, an
 *   additive halo and UnrealBloom. Idle = soft breathing; working = brighter
 *   pulse + orbiting particles + sonar rings; sub-agent runs in flight =
 *   satellites orbiting the parent on tilted rings. Avatar / monogram
 *   billboards sit in the orb; name labels fade with distance (LOD).
 * - Links are curved beams (fat lines): delegation observed in runs glows in
 *   the team colour with a travelling flow; configured delegation rights are
 *   dashed. Live events travel as light pulses; hover / selection lights the
 *   agent's neighbourhood and dims the rest.
 * - Instanced orbs / halos / satellites, capped particles, render-on-demand
 *   in reduced-motion mode, paused when hidden or scrolled away. Context loss
 *   or missing WebGL hands control back to the host (`onFallback`) which
 *   mounts the 2D engine.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import type { ConstellationEngine, CxEdge, CxNode, CxOptions, CxState } from "./agents-constellation-engine";
import { fillConstellationTip, placeConstellationTip } from "./constellation-tip";
import { isLowEndDevice, isPerformanceMode } from "./perf-mode";
import {
  beamPoints,
  bezierPoint,
  beamControl,
  clamp,
  clusterLabelAlpha,
  focusSet,
  frameDirection,
  frameDistance,
  hash01,
  isEdgeHot,
  labelAlpha,
  labelPriority,
  layout3D,
  nodeVisibility,
  qualityFor,
  satelliteOffset,
  teamTint,
  lighten,
  TAU,
  type LayoutCluster3D,
  type Quality,
  type RGB,
  type Vec3,
} from "./constellation-3d-model";

const BEAM_SEGMENTS = 18;
const MIN_DIST = 40;
const MAX_DIST = 3200;
const AUTO_ROTATE_RESUME_MS = 22_000;

interface NodeRt extends CxNode {
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  r: number;
  tr: number;
  phase: number;
  appear: number;
  ping: number;
  color: RGB;
  idx: number;
  label: THREE.Sprite | null;
  avatar: THREE.Sprite | null;
}

interface Pulse {
  from: string;
  to: string;
  t: number;
  speed: number;
  color: RGB;
}

interface Tween {
  target: THREE.Vector3;
  pos: THREE.Vector3;
}

const POINT_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aSeed;
uniform float uTime;
uniform float uPR;
uniform float uDrift;
uniform float uAtten;
varying vec3 vColor;
varying float vA;
void main() {
  vec3 p = position + vec3(sin(uTime * 0.11 + aSeed * 6.2831), cos(uTime * 0.07 + aSeed * 3.1), sin(uTime * 0.09 + aSeed * 1.7)) * uDrift;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float att = mix(1.0, 420.0 / max(1.0, -mv.z), uAtten);
  gl_PointSize = aSize * uPR * att;
  vColor = aColor;
  vA = 0.6 + 0.4 * sin(uTime * (0.5 + aSeed * 1.5) + aSeed * 40.0);
}`;

const POINT_FRAG = /* glsl */ `
uniform float uAlpha;
varying vec3 vColor;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = exp(-d * d * 4.0) * (1.0 - smoothstep(0.8, 1.0, d)) * vA * uAlpha;
  gl_FragColor = vec4(vColor * a, a);
}`;

const ORB_VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec4 aParam;
attribute vec4 aExtra;
varying vec3 vColor;
varying vec4 vParam;
varying vec4 vExtra;
varying vec3 vN;
varying vec3 vV;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vParam = aParam;
  vExtra = aExtra;
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vN = normalize(mat3(m) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const ORB_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uBg;
uniform vec3 uSel;
varying vec3 vColor;
varying vec4 vParam;
varying vec4 vExtra;
varying vec3 vN;
varying vec3 vV;
#include <fog_pars_fragment>
void main() {
  float ndv = max(dot(normalize(vN), normalize(vV)), 0.0);
  float fres = pow(1.0 - ndv, 2.2);
  float mode = vParam.w;
  float breathe = mode == 1.0 ? 0.5 + 0.5 * sin(uTime * 5.5 + vParam.y) : 0.5 + 0.5 * sin(uTime * 1.5 + vParam.y);
  float glow = vParam.x * (0.7 + 0.5 * breathe);
  vec3 body = mix(uBg, vColor, 0.16);
  vec3 col = body + vColor * (0.06 + fres * (0.9 + 1.8 * glow));
  col += vColor * pow(ndv, 10.0) * 0.25 * glow;
  col += uSel * fres * vExtra.y * 1.6;
  col += vColor * fres * vExtra.z * 0.8;
  col += vColor * vExtra.x * 1.2;
  gl_FragColor = vec4(col, vParam.z);
  #include <fog_fragment>
}`;

const HALO_VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec4 aParam;
attribute vec4 aExtra;
varying vec2 vUv;
varying vec3 vColor;
varying vec4 vParam;
varying vec4 vExtra;
void main() {
  vColor = aColor;
  vParam = aParam;
  vExtra = aExtra;
  vUv = position.xy;
  mat4 m = modelMatrix * instanceMatrix;
  vec4 c = m * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(m[0].xyz);
  vec4 mv = viewMatrix * c;
  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
}`;

const HALO_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSel;
varying vec2 vUv;
varying vec3 vColor;
varying vec4 vParam;
varying vec4 vExtra;
void main() {
  float d = length(vUv);
  float mode = vParam.w;
  float breathe = mode == 1.0 ? 0.5 + 0.5 * sin(uTime * 5.5 + vParam.y) : 0.5 + 0.5 * sin(uTime * 1.5 + vParam.y);
  float glow = vParam.x * (0.6 + 0.6 * breathe);
  float a = exp(-d * d * 9.0) * glow * 0.42 * (0.3 + 0.7 * smoothstep(0.18, 0.46, d));
  if (mode == 1.0) {
    float rt = fract(uTime * 0.5 + vParam.y * 0.159);
    float rr = 0.28 + rt * 0.68;
    a += smoothstep(0.035, 0.0, abs(d - rr)) * (1.0 - rt) * 0.55;
  }
  if (vExtra.x > 0.0) {
    float pr = 0.3 + (1.0 - vExtra.x) * 0.65;
    a += smoothstep(0.04, 0.0, abs(d - pr)) * vExtra.x * 0.9;
  }
  a *= 1.0 - smoothstep(0.92, 1.0, d);
  vec3 col = vColor * a;
  if (vExtra.y > 0.0) col = mix(col, uSel * a, 0.35);
  gl_FragColor = vec4(col * vParam.z, a * vParam.z);
}`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uBase;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5; float s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.1 + vec3(1.7); a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
#ifdef CHEAP_SKY
  vec3 cheap = uBase + uC1 * (0.35 + 0.35 * d.x) * 0.5 + uC2 * (0.35 - 0.35 * d.z) * 0.5;
  gl_FragColor = vec4(cheap * (0.7 + 0.3 * (d.y * 0.5 + 0.5)), 1.0);
  return;
#endif
  float t = uTime * 0.012;
  float n1 = fbm(d * 3.0 + vec3(t, 0.0, 0.0));
  float n2 = fbm(d * 5.0 + vec3(0.0, t * 0.7, 4.0));
  float n3 = fbm(d * 2.2 + vec3(9.0, 3.0, -t));
  vec3 col = uBase;
  col += uC1 * smoothstep(0.36, 0.86, n1) * 0.62;
  col += uC2 * smoothstep(0.44, 0.9, n2) * 0.5;
  col += uC3 * smoothstep(0.56, 0.9, n3) * 0.35;
  col *= 0.7 + 0.3 * (d.y * 0.5 + 0.5);
  gl_FragColor = vec4(col, 1.0);
}`;

const GRID_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const GRID_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uRadius;
uniform vec2 uCenter;
varying vec2 vP;
void main() {
  vec2 q = vP / 80.0;
  vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float rad = length(vP - uCenter) / uRadius;
  float fade = 1.0 - smoothstep(0.15, 1.0, rad);
  float a = line * fade * 0.32;
  gl_FragColor = vec4(uColor * a, a);
}`;

const DISC_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  float a = (1.0 - smoothstep(0.0, 1.0, d)) * 0.07 + smoothstep(0.08, 0.0, abs(d - 0.985)) * 0.12;
  gl_FragColor = vec4(uColor * a, a);
}`;

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  float ring = smoothstep(0.08, 0.0, abs(d - 0.94)) ;
  float ang = atan(vUv.y, vUv.x);
  float dash = step(0.45, fract(ang * 2.8 / 3.14159 + uTime * 0.35));
  float a = ring * mix(0.35, 1.0, dash) * uAlpha;
  gl_FragColor = vec4(uColor * a, a);
}`;

function toColor(c: RGB, mul = 1): THREE.Color {
  return new THREE.Color().setRGB((c[0] / 255) * mul, (c[1] / 255) * mul, (c[2] / 255) * mul, THREE.SRGBColorSpace);
}

function rgbaCss(c: RGB, a: number) {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
}

export class AgentsConstellation3D implements ConstellationEngine {
  readonly host: HTMLElement;
  private opts: CxOptions;
  private canvas: HTMLCanvasElement;
  private tip: HTMLDivElement;
  private probe: HTMLSpanElement;
  private mini: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private raycaster = new THREE.Raycaster();
  private quality: Quality;

  private w = 1;
  private h = 1;
  private z = 1;
  private pr = 1;

  private nodes = new Map<string, NodeRt>();
  private order: NodeRt[] = [];
  private edges: CxEdge[] = [];
  private clusters: LayoutCluster3D[] = [];
  private center: Vec3 = [0, 0, 0];
  private radius = 200;
  private frame3 = { center: [0, 0, 0] as Vec3, radius: 120 };
  /** Camera distance of the last "frame all" — label LOD and fly-to scale from it. */
  private frameDist = 800;
  private pulses: Pulse[] = [];

  private hoverId: string | null = null;
  private selectedId: string | null = null;
  private dimSet: Set<string> | null = null;
  private tween: Tween | null = null;
  private userMoved = false;
  private lastInteractAt = 0;

  private colors = {
    primary: [251, 191, 36] as RGB,
    ok: [34, 197, 94] as RGB,
    warn: [245, 158, 11] as RGB,
    bad: [239, 68, 68] as RGB,
    info: [56, 189, 248] as RGB,
    neutral: [148, 163, 184] as RGB,
    fg: [245, 245, 244] as RGB,
    bg: [7, 6, 4] as RGB,
  };
  /** Text/neutral colour inside the viewport — the void is always dark, even on light themes. */
  private viewFg: RGB = [245, 243, 236];
  private font = "Inter, system-ui, sans-serif";

  // GPU objects
  private orbGeo: THREE.SphereGeometry;
  private orbMat: THREE.ShaderMaterial;
  private orbs: THREE.InstancedMesh;
  private haloMat: THREE.ShaderMaterial;
  private halos: THREE.InstancedMesh;
  private sats: THREE.InstancedMesh;
  private satRings: THREE.InstancedMesh;
  private pointMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private dust: THREE.Points;
  private orbiters: THREE.Points;
  private pulsePts: THREE.Points;
  private sky: THREE.Mesh;
  private grid: THREE.Mesh;
  private ringGroup = new THREE.Group();
  private beamGeoSolid = new LineSegmentsGeometry();
  private beamGeoDash = new LineSegmentsGeometry();
  private beamMats: LineMaterial[] = [];
  private beamFlowMat: LineMaterial;
  private beamObjs: LineSegments2[] = [];
  private selRing: THREE.Mesh;
  private selRingMat: THREE.ShaderMaterial;
  private labelGroup = new THREE.Group();
  private avatarGroup = new THREE.Group();
  private clusterLabels: THREE.Sprite[] = [];
  private textures = new Map<string, THREE.Texture>();
  private instanceCap = 0;

  private raf = 0;
  /** True while frame() runs: kicks from inside a frame (controls "change") must not double the loop. */
  private inFrame = false;
  private lastTs = 0;
  private elapsed = 0;
  private ambientAcc = 0;
  private dirty = true;
  private visible = true;
  private destroyed = false;
  private reduced = false;
  private lost = false;
  private frameMs: number[] = [];
  private drawMs: number[] = [];
  /** "low" = software / slow GPU: bloom off, flat sky, pixel ratio 1. */
  private tier: "full" | "low" = "full";
  private gpu = "";
  private slowFrames = 0;
  private tokenSig = "";
  private tokenCheckAt = 0;

  private pointer = { x: 0, y: 0, has: false };
  private down: { x: number; y: number; id: number } | null = null;
  private downCount = 0;
  private tipFor = "";

  private ro: ResizeObserver;
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver;
  private mql: MediaQueryList | null = null;
  private cleanup: Array<() => void> = [];

  constructor(host: HTMLElement, opts: CxOptions = {}) {
    this.host = host;
    this.opts = opts;
    host.classList.add("agp-cx", "agp-cx--3d");
    host.tabIndex = 0;
    host.setAttribute("role", "application");
    host.setAttribute(
      "aria-label",
      "Agent constellation (3D). Drag to orbit, right-drag or two fingers to pan, scroll or +/- to zoom, 0 to frame all. Use the card grid for a list view.",
    );

    this.canvas = document.createElement("canvas");
    this.canvas.className = "agp-cx-canvas";
    this.tip = document.createElement("div");
    this.tip.className = "agp-cx-tip";
    this.tip.setAttribute("role", "tooltip");
    this.probe = document.createElement("span");
    this.probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
    this.mini = document.createElement("canvas");
    this.mini.className = "agp-cx-mini";
    this.mini.setAttribute("aria-hidden", "true");
    this.mctx = this.mini.getContext("2d")!;
    host.append(this.canvas, this.mini, this.tip, this.probe);

    const rect = host.getBoundingClientRect();
    const lowEnd = isLowEndDevice() || isPerformanceMode();
    this.quality = qualityFor({ width: host.clientWidth || rect.width || 1000, dpr: window.devicePixelRatio || 1, lowEnd });

    // Renderer — throws when WebGL is unavailable; the host falls back to 2D.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.info.autoReset = false;
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      this.gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch {
      this.gpu = "";
    }
    if (/swiftshader|llvmpipe|software|basic render/i.test(this.gpu)) this.tier = "low";
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 9000);
    this.camera.position.set(0, 320, 620);
    this.scene.fog = new THREE.FogExp2(0x070604, 0.00052);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.8;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = MIN_DIST;
    this.controls.maxDistance = MAX_DIST;
    this.controls.maxPolarAngle = 1.52;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.22;
    this.controls.addEventListener("start", () => {
      this.userMoved = true;
      this.tween = null;
      this.controls.autoRotate = false;
      this.lastInteractAt = performance.now();
      this.setHover(null);
    });
    this.controls.addEventListener("end", () => {
      this.lastInteractAt = performance.now();
    });
    this.controls.addEventListener("change", () => {
      this.dirty = true;
      this.kick();
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.9, 0.55, 0.42);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.readColors();

    // ── Static scenery ─────────────────────────────────────────────────
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(4200, 40, 24),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uBase: { value: new THREE.Color(0.012, 0.011, 0.011) },
          uC1: { value: toColor(this.colors.primary, 0.17) },
          uC2: { value: new THREE.Color(0.075, 0.052, 0.028) },
          uC3: { value: new THREE.Color(0.07, 0.065, 0.058) },
        },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    this.pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: { uTime: { value: 0 }, uPR: { value: 1 }, uDrift: { value: 0 }, uAtten: { value: 0 }, uAlpha: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = this.makePoints(this.quality.stars, (i, pos, size, col, seed) => {
      const u = hash01(`s${i}`) * TAU;
      const v = Math.acos(2 * hash01(`t${i}`) - 1);
      const rr = 3300 + hash01(`r${i}`) * 500;
      pos.set([Math.sin(v) * Math.cos(u) * rr, Math.cos(v) * rr * 0.85, Math.sin(v) * Math.sin(u) * rr], i * 3);
      size[i] = 1.4 + hash01(`z${i}`) * 2.6;
      const warm = hash01(`w${i}`);
      col.set(warm > 0.75 ? [1, 0.84, 0.5] : warm > 0.45 ? [0.96, 0.93, 0.86] : [0.9, 0.9, 0.9], i * 3);
      seed[i] = hash01(`q${i}`);
    }, { uAtten: 0, uDrift: 0, uAlpha: 1.15 });
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
    this.dust = this.makePoints(this.quality.dust, (i, pos, size, col, seed) => {
      pos.set([(hash01(`dx${i}`) - 0.5) * 1600, (hash01(`dy${i}`) - 0.5) * 700, (hash01(`dz${i}`) - 0.5) * 1600], i * 3);
      size[i] = 1.6 + hash01(`ds${i}`) * 3.2;
      const c = teamTint(this.colors.primary, Math.floor(hash01(`dc${i}`) * 8));
      col.set([c[0] / 255, c[1] / 255, c[2] / 255], i * 3);
      seed[i] = hash01(`dq${i}`);
    }, { uAtten: 1, uDrift: 26, uAlpha: 0.38 });
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);

    this.grid = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.ShaderMaterial({
        vertexShader: GRID_VERT,
        fragmentShader: GRID_FRAG,
        uniforms: { uColor: { value: toColor(this.colors.primary) }, uRadius: { value: 900 }, uCenter: { value: new THREE.Vector2() } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.grid.rotation.x = -Math.PI / 2;
    this.scene.add(this.grid);
    this.scene.add(this.ringGroup);

    // ── Agents ─────────────────────────────────────────────────────────
    this.orbGeo = new THREE.SphereGeometry(1, 28, 20);
    this.orbMat = new THREE.ShaderMaterial({
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uTime: { value: 0 }, uBg: { value: toColor(this.colors.bg) }, uSel: { value: toColor(this.colors.primary) } },
      ]),
      fog: true,
      transparent: true,
    });
    this.haloMat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: { uTime: { value: 0 }, uSel: { value: toColor(this.colors.primary) } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.orbs = this.makeInstanced(this.orbGeo, this.orbMat, 8);
    this.halos = this.makeInstanced(new THREE.PlaneGeometry(2, 2), this.haloMat, 8);
    this.halos.renderOrder = 2;
    this.sats = this.makeInstanced(new THREE.SphereGeometry(1, 16, 12), this.orbMat, this.quality.maxSatellites);
    this.satRings = new THREE.InstancedMesh(
      new THREE.TorusGeometry(1, 0.012, 4, 72),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }),
      this.quality.maxSatellites,
    );
    this.satRings.count = 0;
    this.scene.add(this.orbs, this.halos, this.sats, this.satRings, this.labelGroup, this.avatarGroup);

    this.orbiters = this.makePoints(this.quality.orbitParticles * 40, () => {}, { uAtten: 1, uDrift: 0, uAlpha: 1 });
    this.orbiters.geometry.setDrawRange(0, 0);
    this.orbiters.frustumCulled = false;
    this.scene.add(this.orbiters);
    this.pulsePts = this.makePoints(this.quality.maxPulses, () => {}, { uAtten: 1, uDrift: 0, uAlpha: 1 });
    this.pulsePts.geometry.setDrawRange(0, 0);
    this.pulsePts.frustumCulled = false;
    this.scene.add(this.pulsePts);

    // Beams: solid (observed delegation) + dashed (configured), each core + halo; flow overlay on solid.
    const mkMat = (dashed: boolean, width: number, opacity: number) =>
      new LineMaterial({
        color: 0xffffff,
        linewidth: width,
        vertexColors: true,
        dashed,
        dashSize: dashed ? 7 : 1,
        gapSize: dashed ? 6 : 0,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        worldUnits: false,
        alphaToCoverage: false,
      });
    const add = (geo: LineSegmentsGeometry, mat: LineMaterial, order: number) => {
      const o = new LineSegments2(geo, mat);
      o.renderOrder = order;
      o.frustumCulled = false;
      this.beamObjs.push(o);
      this.beamMats.push(mat);
      this.scene.add(o);
    };
    add(this.beamGeoSolid, mkMat(false, 6, 0.09), -2);
    add(this.beamGeoSolid, mkMat(false, 1.3, 0.85), -1);
    add(this.beamGeoDash, mkMat(true, 1.2, 0.7), -1);
    this.beamFlowMat = mkMat(true, 2.2, 0.9);
    this.beamFlowMat.dashSize = 7;
    this.beamFlowMat.gapSize = 46;
    add(this.beamGeoSolid, this.beamFlowMat, 0);

    this.selRingMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: { uColor: { value: toColor(this.colors.primary) }, uTime: { value: 0 }, uAlpha: { value: 1 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.selRing = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.selRingMat);
    this.selRing.renderOrder = 12;
    this.selRing.visible = false;
    this.scene.add(this.selRing);

    this.bind();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver((entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
        if (this.visible) this.kick();
      });
      this.io.observe(host);
    }
    this.mo = new MutationObserver(() => {
      this.readColors();
      this.invalidate();
    });
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    try {
      this.mql = window.matchMedia("(prefers-reduced-motion: reduce)");
      const onMq = () => {
        this.reduced = !!this.mql?.matches || isPerformanceMode();
        this.controls.autoRotate = !this.reduced && !this.userMoved;
        this.invalidate();
      };
      onMq();
      this.mql.addEventListener("change", onMq);
      this.cleanup.push(() => this.mql?.removeEventListener("change", onMq));
    } catch {
      this.reduced = isPerformanceMode();
    }
    const onVis = () => {
      if (!document.hidden) this.kick();
    };
    document.addEventListener("visibilitychange", onVis);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", onVis));

    // Diagnostics for headless verification.
    const diag = host as unknown as Record<string, unknown>;
    diag.__cxStats = () => this.stats();
    diag.__cxNodes = () => this.screenNodes();
    diag.__cxPulse = (from: string | null, to: string, kind?: "message" | "spawn" | "complete") => this.pulse(from, to, kind);
    diag.__cxEngine = "3d";
    if (this.tier === "low") this.applyTier();
    this.resize();
  }

  /** Software / slow GPU: drop the expensive passes, keep the look. */
  private applyTier() {
    const low = this.tier === "low";
    this.bloom.enabled = !low;
    const sky = this.sky.material as THREE.ShaderMaterial;
    if (low) sky.defines = { ...(sky.defines ?? {}), CHEAP_SKY: 1 };
    else delete sky.defines?.CHEAP_SKY;
    sky.needsUpdate = true;
    this.dust.visible = !low;
    this.invalidate();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  setOptions(opts: CxOptions) {
    this.opts = opts;
  }

  setData(nodes: CxNode[], edges: CxEdge[]) {
    const seen = new Set<string>();
    const first = this.order.length === 0;
    for (const n of nodes) {
      seen.add(n.id);
      const prev = this.nodes.get(n.id);
      if (prev) {
        const avatarChanged = prev.avatarUrl !== n.avatarUrl || prev.monogram !== n.monogram;
        const nameChanged = prev.name !== n.name;
        Object.assign(prev, n);
        if (avatarChanged && prev.avatar) {
          this.avatarGroup.remove(prev.avatar);
          prev.avatar = null;
        }
        if (nameChanged && prev.label) {
          this.labelGroup.remove(prev.label);
          prev.label = null;
        }
      } else {
        this.nodes.set(n.id, {
          ...n,
          x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0,
          r: 0, tr: 0,
          phase: hash01(n.id) * TAU,
          appear: first ? 1 : 0,
          ping: 0,
          color: this.colors.primary,
          idx: -1,
          label: null,
          avatar: null,
        });
      }
    }
    for (const [id, n] of [...this.nodes]) {
      if (seen.has(id)) continue;
      if (n.label) this.labelGroup.remove(n.label);
      if (n.avatar) this.avatarGroup.remove(n.avatar);
      this.nodes.delete(id);
    }
    this.edges = edges.filter((e) => this.nodes.has(e.from) && this.nodes.has(e.to));
    this.layout();
    this.ensureCapacity(this.nodes.size);
    this.buildBeams();
    this.buildRings();
    if (!this.userMoved) this.fit(!first);
    this.invalidate();
  }

  setSelected(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.invalidate();
  }

  setDimmed(keep: Set<string> | null) {
    this.dimSet = keep;
    this.invalidate();
  }

  focus(id: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.userMoved = true;
    this.controls.autoRotate = false;
    const target = new THREE.Vector3(n.tx, n.ty, n.tz);
    const dist = clamp(Math.max(n.tr * 13, this.frameDist * 0.32), 230, 560);
    const dir = this.viewDir();
    const pos = target.clone().addScaledVector(dir, dist);
    this.flyTo(target, pos);
  }

  fit(animate = true) {
    const target = new THREE.Vector3(...this.frame3.center);
    const aspect = this.camera.aspect || 1;
    // Portrait: turn the layout's long axis (world X) vertical so phones use their height.
    const dir = this.userMoved ? this.viewDir() : new THREE.Vector3(...frameDirection(aspect < 1 ? Math.PI / 2 + 0.35 : 0.35));
    let dist = clamp(frameDistance(this.frame3.radius, this.camera.fov, aspect), MIN_DIST + 40, MAX_DIST);
    // The sphere fit over-estimates a mostly planar layout: refine by the projected extent of the orbs.
    if (this.nodes.size) {
      const probe = this.camera.clone();
      const v = new THREE.Vector3();
      const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
      const fill = aspect < 1 ? 0.8 : 0.76; // leave room for labels, halos and the floating controls
      for (let pass = 0; pass < 3; pass++) {
        probe.position.copy(target).addScaledVector(dir, dist);
        probe.lookAt(target);
        probe.updateMatrixWorld(true);
        let ext = 0;
        for (const n of this.nodes.values()) {
          v.set(n.tx, n.ty, n.tz).applyMatrix4(probe.matrixWorldInverse);
          const depth = Math.max(1, -v.z);
          const pad = n.tr * 2.4;
          const nx = (Math.abs(v.x) + pad) / (depth * tanV * aspect);
          const ny = (Math.abs(v.y) + pad) / (depth * tanV);
          ext = Math.max(ext, nx, ny);
        }
        if (!Number.isFinite(ext) || ext <= 0) break;
        dist = clamp(dist * (ext / fill), MIN_DIST + 40, MAX_DIST);
      }
    }
    this.frameDist = dist;
    const pos = target.clone().addScaledVector(dir, dist);
    if (!animate || this.reduced) {
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
      this.controls.update();
      this.tween = null;
    } else {
      this.flyTo(target, pos);
    }
    this.invalidate();
  }

  resetView() {
    this.userMoved = false;
    this.controls.autoRotate = !this.reduced;
    this.fit(true);
  }

  zoomBy(f: number) {
    this.userMoved = true;
    this.controls.autoRotate = false;
    const target = this.tween?.target.clone() ?? this.controls.target.clone();
    const pos = this.tween?.pos.clone() ?? this.camera.position.clone();
    const off = pos.sub(target);
    const dist = clamp(off.length() / f, MIN_DIST, MAX_DIST);
    this.flyTo(target, target.clone().addScaledVector(off.normalize(), dist));
  }

  pulse(from: string | null, to: string, kind: "message" | "spawn" | "complete" = "message") {
    const target = this.nodes.get(to);
    if (!target) return;
    target.ping = 1;
    const color = kind === "spawn" ? this.colors.primary : kind === "complete" ? lighten(this.colors.primary, 0.6) : lighten(this.colors.primary, 0.3);
    if (from && from !== to && this.nodes.has(from) && !this.reduced && this.pulses.length < this.quality.maxPulses) {
      this.pulses.push({ from, to, t: 0, speed: 0.8, color });
    }
    this.dirty = true;
    this.kick();
  }

  stats() {
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const interval = avg(this.frameMs);
    const info = this.renderer.info.render;
    return {
      engine: "3d",
      nodes: this.nodes.size,
      edges: this.edges.length,
      clusters: this.clusters.length,
      fps: interval > 0 ? Math.round(1000 / interval) : 0,
      avgFrameMs: +interval.toFixed(2),
      avgDrawMs: +avg(this.drawMs).toFixed(2),
      drawCalls: info.calls,
      triangles: info.triangles,
      reducedMotion: this.reduced,
      tier: this.tier,
      gpu: this.gpu,
      pixelRatio: this.pr,
      quality: this.quality,
      camera: { x: +this.camera.position.x.toFixed(1), y: +this.camera.position.y.toFixed(1), z: +this.camera.position.z.toFixed(1), dist: +this.camera.position.distanceTo(this.controls.target).toFixed(1) },
    };
  }

  /** On-screen centre / radius per node in visual px relative to the host. */
  screenNodes() {
    const v = new THREE.Vector3();
    const tan = Math.tan((this.camera.fov * Math.PI) / 360);
    return [...this.nodes.values()].map((n) => {
      v.set(n.x, n.y, n.z);
      const dist = v.distanceTo(this.camera.position);
      v.project(this.camera);
      const sx = ((v.x + 1) / 2) * this.w;
      const sy = ((1 - v.y) / 2) * this.h;
      const r = (n.r * (this.h / 2)) / Math.max(1, dist * tan);
      return { id: n.id, x: Math.round(sx * this.z), y: Math.round(sy * this.z), r: Math.round(r * this.z), state: n.state, cluster: n.cluster, behind: v.z > 1 };
    });
  }

  invalidate() {
    this.dirty = true;
    this.kick();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io?.disconnect();
    this.mo.disconnect();
    for (const fn of this.cleanup) fn();
    this.controls.dispose();
    this.bloom.dispose();
    this.composer.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    this.renderer.dispose();
    this.canvas.remove();
    this.mini.remove();
    this.tip.remove();
    this.probe.remove();
    this.host.classList.remove("agp-cx--3d");
    const diag = this.host as unknown as Record<string, unknown>;
    delete diag.__cxEngine;
    delete diag.__cxPulse;
    delete diag.__cxStats;
    delete diag.__cxNodes;
  }

  // ─── Builders ──────────────────────────────────────────────────────────

  private makePoints(
    count: number,
    fill: (i: number, pos: Float32Array, size: Float32Array, col: Float32Array, seed: Float32Array) => void,
    u: { uAtten: number; uDrift: number; uAlpha: number },
  ): THREE.Points {
    const n = Math.max(1, count);
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < count; i++) fill(i, pos, size, col, seed);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const mat = this.pointMat.clone();
    mat.uniforms.uAtten.value = u.uAtten;
    mat.uniforms.uDrift.value = u.uDrift;
    mat.uniforms.uAlpha.value = u.uAlpha;
    return new THREE.Points(geo, mat);
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number): THREE.InstancedMesh {
    const g = geo.clone();
    g.setAttribute("aColor", new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute("aParam", new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
    g.setAttribute("aExtra", new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
    const m = new THREE.InstancedMesh(g, mat, cap);
    m.count = 0;
    m.frustumCulled = false;
    return m;
  }

  /** Grow the orb / halo instanced meshes (power-of-two capacity). */
  private ensureCapacity(n: number) {
    if (n <= this.instanceCap) return;
    let cap = 8;
    while (cap < n) cap *= 2;
    this.instanceCap = cap;
    const swap = (old: THREE.InstancedMesh, geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const next = this.makeInstanced(geo, mat, cap);
      next.renderOrder = old.renderOrder;
      this.scene.remove(old);
      old.geometry.dispose();
      this.scene.add(next);
      return next;
    };
    this.orbs = swap(this.orbs, this.orbGeo, this.orbMat);
    this.halos = swap(this.halos, new THREE.PlaneGeometry(2, 2), this.haloMat);
  }

  private layout() {
    const lay = layout3D([...this.nodes.values()].map((n) => ({ id: n.id, cluster: n.cluster, clusterLabel: n.clusterLabel, size: n.size })));
    this.clusters = lay.clusters;
    this.center = lay.center;
    this.radius = lay.radius;
    this.frame3 = lay.frame;
    const palette = new Map(lay.clusters.map((c) => [c.key, teamTint(this.colors.primary, c.paletteIndex)]));
    for (const n of this.nodes.values()) {
      const p = lay.nodes.get(n.id)!;
      n.tx = p.x;
      n.ty = p.y;
      n.tz = p.z;
      n.tr = p.r;
      n.color = palette.get(n.cluster) ?? this.colors.primary;
      if (n.appear === 1 && n.r === 0) {
        n.x = p.x; n.y = p.y; n.z = p.z; n.r = p.r;
      } else if (n.r === 0) {
        const c = lay.clusters.find((cl) => cl.key === n.cluster);
        if (c) { n.x = c.x; n.y = c.y; n.z = c.z; }
      }
    }
    this.order = [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    this.order.forEach((n, i) => (n.idx = i));
    const grid = this.grid.material as THREE.ShaderMaterial;
    grid.uniforms.uRadius.value = Math.max(600, this.radius * 1.9);
    grid.uniforms.uCenter.value.set(this.center[0], this.center[2]);
    this.grid.position.y = this.center[1] - Math.max(90, this.radius * 0.42);
    this.scene.fog = new THREE.FogExp2(0x070604, clamp(0.26 / Math.max(200, this.radius), 0.00018, 0.0007));
    this.orbMat.uniforms.fogColor.value = (this.scene.fog as THREE.FogExp2).color;
    this.orbMat.uniforms.fogDensity.value = (this.scene.fog as THREE.FogExp2).density;
  }

  private buildRings() {
    for (const c of this.ringGroup.children.slice()) {
      this.ringGroup.remove(c);
      (c as THREE.Group).traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
    }
    for (const s of this.clusterLabels) {
      this.labelGroup.remove(s);
      s.material.dispose();
    }
    this.clusterLabels = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const c of this.clusters) {
      const col = teamTint(this.colors.primary, c.paletteIndex);
      const g = new THREE.Group();
      g.position.set(c.x, c.y, c.z);
      g.quaternion.setFromUnitVectors(up, new THREE.Vector3(...c.normal));
      // Teams differ by ring style too (solid pair / dashed outer / single), not by hue.
      const style = c.paletteIndex % 3;
      const mat = new THREE.LineBasicMaterial({ color: toColor(col), transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false });
      const dashed = new THREE.LineDashedMaterial({ color: toColor(col), transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, dashSize: 9, gapSize: 7 });
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(c.r * 1.02, 72),
        new THREE.ShaderMaterial({
          vertexShader: RING_VERT,
          fragmentShader: DISC_FRAG,
          uniforms: { uColor: { value: toColor(col) } },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.renderOrder = -5;
      g.add(disc);
      for (const f of style === 2 ? [1.0] : [0.72, 1.0]) {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 96; i++) {
          const a = (i / 96) * TAU;
          pts.push(new THREE.Vector3(Math.cos(a) * c.r * f, 0, Math.sin(a) * c.r * f));
        }
        const dash = style === 1 && f === 1.0;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), dash ? dashed : mat);
        if (dash) line.computeLineDistances();
        g.add(line);
      }
      g.userData.spin = (hash01(c.key) - 0.5) * 0.06;
      this.ringGroup.add(g);

      const sprite = this.textSprite(`${c.label.toUpperCase()}  ·  ${c.count}`, col, 0.86, true);
      sprite.position.set(c.x, c.y + c.r * 0.55 + 36, c.z);
      sprite.userData.cluster = c;
      sprite.renderOrder = 11;
      this.labelGroup.add(sprite);
      this.clusterLabels.push(sprite);
    }
  }

  private buildBeams() {
    const solid: number[] = [];
    const dashed: number[] = [];
    for (const e of this.edges) {
      const a = this.nodes.get(e.from)!;
      const b = this.nodes.get(e.to)!;
      const pts = beamPoints([a.x, a.y, a.z], [b.x, b.y, b.z], BEAM_SEGMENTS);
      const out = e.kind === "delegation" ? solid : dashed;
      for (let i = 0; i < pts.length - 1; i++) out.push(...pts[i], ...pts[i + 1]);
    }
    const apply = (geo: LineSegmentsGeometry, arr: number[]) => {
      const data = arr.length ? arr : [0, 0, 0, 0, 0, 0];
      geo.setPositions(data);
    };
    apply(this.beamGeoSolid, solid);
    apply(this.beamGeoDash, dashed);
    for (const o of this.beamObjs) o.computeLineDistances();
    this.beamGeoSolid.instanceCount = solid.length / 6;
    this.beamGeoDash.instanceCount = dashed.length / 6;
    this.colorBeams();
  }

  private colorBeams() {
    const focusId = this.hoverId ?? this.selectedId;
    const focus = focusSet(focusId, this.edges);
    const solid: number[] = [];
    const dashed: number[] = [];
    const cols: number[] = [];
    for (const e of this.edges) {
      const hot = isEdgeHot(e, focusId);
      const dim = (!!focus && !hot) || this.isDim(e.from) || this.isDim(e.to);
      const a = this.nodes.get(e.from)!;
      let c: RGB;
      let mul: number;
      if (e.kind === "can-delegate") {
        c = this.viewFg;
        mul = hot ? 0.6 : dim ? 0.04 : 0.16;
      } else {
        c = [a.color[0] * 0.35 + this.colors.primary[0] * 0.65, a.color[1] * 0.35 + this.colors.primary[1] * 0.65, a.color[2] * 0.35 + this.colors.primary[2] * 0.65];
        mul = hot ? 1.2 : dim ? 0.05 : e.recent ? 0.5 : 0.2;
      }
      const lin = toColor(c, 1);
      cols.length = 0;
      for (let i = 0; i < BEAM_SEGMENTS; i++) cols.push(lin.r * mul, lin.g * mul, lin.b * mul, lin.r * mul, lin.g * mul, lin.b * mul);
      (e.kind === "delegation" ? solid : dashed).push(...cols);
    }
    this.beamGeoSolid.setColors(solid.length ? solid : [0, 0, 0, 0, 0, 0]);
    this.beamGeoDash.setColors(dashed.length ? dashed : [0, 0, 0, 0, 0, 0]);
  }

  // ─── Textures / sprites ───────────────────────────────────────────────

  private textSprite(text: string, color: RGB, alpha: number, caps = false): THREE.Sprite {
    const key = `t|${text}|${color.join(",")}|${caps}`;
    let tex = this.textures.get(key);
    let aspect = 1;
    const c = document.createElement("canvas");
    const g = c.getContext("2d")!;
    const fs = caps ? 22 : 26;
    g.font = `${caps ? 700 : 600} ${fs}px ${this.font}`;
    const spacing = caps ? 3 : 0;
    const tw = Math.ceil(g.measureText(text).width + text.length * spacing);
    const padX = 18;
    const w = tw + padX * 2;
    const h = fs + 22;
    aspect = w / h;
    if (!tex) {
      c.width = w;
      c.height = h;
      g.font = `${caps ? 700 : 600} ${fs}px ${this.font}`;
      g.textBaseline = "middle";
      if (!caps) {
        g.fillStyle = rgbaCss(this.colors.bg, 0.7);
        g.strokeStyle = rgbaCss(color, 0.45);
        g.lineWidth = 2;
        roundRect(g, 1, 1, w - 2, h - 2, h / 2);
        g.fill();
        g.stroke();
      }
      g.fillStyle = caps ? rgbaCss(color, 0.95) : rgbaCss(this.viewFg, 0.95);
      g.shadowColor = rgbaCss(color, caps ? 0.9 : 0.5);
      g.shadowBlur = caps ? 12 : 6;
      if (spacing) {
        let x = padX;
        g.textAlign = "left";
        for (const ch of text) {
          g.fillText(ch, x, h / 2 + 1);
          x += g.measureText(ch).width + spacing;
        }
      } else {
        g.textAlign = "center";
        g.fillText(text, w / 2, h / 2 + 1);
      }
      tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      this.textures.set(key, tex);
    }
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: alpha, fog: false });
    const s = new THREE.Sprite(mat);
    const hh = caps ? 11 : 10.5;
    s.scale.set(hh * aspect, hh, 1);
    s.userData.aspect = aspect;
    s.renderOrder = 11;
    return s;
  }

  private avatarSprite(n: NodeRt): THREE.Sprite {
    const key = `a|${n.avatarUrl || ""}|${n.monogram}|${n.color.join(",")}`;
    let tex = this.textures.get(key);
    if (!tex) {
      const size = 128;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d")!;
      const drawMono = () => {
        g.clearRect(0, 0, size, size);
        g.beginPath();
        g.arc(size / 2, size / 2, size / 2 - 4, 0, TAU);
        const grad = g.createRadialGradient(size * 0.35, size * 0.3, 6, size / 2, size / 2, size / 2);
        grad.addColorStop(0, rgbaCss([n.color[0] * 0.35 + 20, n.color[1] * 0.35 + 20, n.color[2] * 0.35 + 28], 0.95));
        grad.addColorStop(1, rgbaCss(this.colors.bg, 0.95));
        g.fillStyle = grad;
        g.fill();
        g.fillStyle = rgbaCss(this.viewFg, 0.95);
        g.font = `700 ${Math.round(size * 0.42)}px ${this.font}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(n.monogram, size / 2, size / 2 + 3);
      };
      drawMono();
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      tex = t;
      this.textures.set(key, t);
      if (n.avatarUrl) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          if (this.destroyed) return;
          g.clearRect(0, 0, size, size);
          g.save();
          g.beginPath();
          g.arc(size / 2, size / 2, size / 2 - 4, 0, TAU);
          g.clip();
          g.drawImage(img, 0, 0, size, size);
          g.fillStyle = "rgba(0,0,0,0.18)";
          g.fillRect(0, 0, size, size);
          g.restore();
          t.needsUpdate = true;
          this.invalidate();
        };
        img.src = n.avatarUrl;
      }
    }
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false });
    const s = new THREE.Sprite(mat);
    s.renderOrder = 10;
    return s;
  }

  // ─── Colours ───────────────────────────────────────────────────────────

  private resolve(token: string, fallback: RGB): RGB {
    this.probe.style.color = "";
    this.probe.style.color = `var(${token})`;
    const c = getComputedStyle(this.probe).color;
    const m = c.match(/[\d.]+/g);
    if (!m || m.length < 3 || !this.probe.style.color) return fallback;
    return [Math.round(+m[0]), Math.round(+m[1]), Math.round(+m[2])];
  }

  private readColors() {
    const c = this.colors;
    c.primary = this.resolve("--g-primary", c.primary);
    c.ok = this.resolve("--g-success", c.ok);
    c.warn = this.resolve("--g-warning", c.warn);
    c.bad = this.resolve("--g-danger", c.bad);
    c.info = this.resolve("--g-info", c.info);
    c.neutral = this.resolve("--g-neutral", c.neutral);
    c.fg = this.resolve("--g-fg", c.fg);
    const bg = this.resolve("--g-bg", c.bg);
    // The void is always dark (holographic viewport), even on light themes.
    c.bg = bg[0] + bg[1] + bg[2] > 380 ? [7, 6, 4] : [Math.round(bg[0] * 0.6 + 1), Math.round(bg[1] * 0.55), Math.round(bg[2] * 0.45)];
    this.font = getComputedStyle(this.host).fontFamily || this.font;
    this.renderer.setClearColor(toColor(c.bg));
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    for (const n of this.nodes.values()) {
      if (n.label) { this.labelGroup.remove(n.label); n.label.material.dispose(); n.label = null; }
      if (n.avatar) { this.avatarGroup.remove(n.avatar); n.avatar.material.dispose(); n.avatar = null; }
    }
    if (this.orbMat) {
      this.orbMat.uniforms.uBg.value = toColor(c.bg);
      this.orbMat.uniforms.uSel.value = toColor(c.primary);
      this.haloMat.uniforms.uSel.value = toColor(c.primary);
      this.selRingMat.uniforms.uColor.value = toColor(c.primary);
      (this.grid.material as THREE.ShaderMaterial).uniforms.uColor.value = toColor(c.primary);
      (this.sky.material as THREE.ShaderMaterial).uniforms.uC1.value = toColor(c.primary, 0.17);
      this.buildRings();
      this.colorBeams();
    }
  }

  private stateGlow(s: CxState): { glow: number; mode: number } {
    switch (s) {
      case "working": return { glow: 1.0, mode: 1 };
      case "blocked": return { glow: 0.6, mode: 2 };
      case "error": return { glow: 0.65, mode: 3 };
      case "disabled": return { glow: 0.15, mode: 4 };
      default: return { glow: 0.36, mode: 0 };
    }
  }

  private stateTint(n: NodeRt): RGB {
    switch (n.state) {
      case "working": return lighten(n.color, 0.22); // brighter gold, same family
      case "blocked": return [n.color[0] * 0.35 + this.colors.warn[0] * 0.65, n.color[1] * 0.35 + this.colors.warn[1] * 0.65, n.color[2] * 0.35 + this.colors.warn[2] * 0.65];
      case "error": return [n.color[0] * 0.25 + this.colors.bad[0] * 0.75, n.color[1] * 0.25 + this.colors.bad[1] * 0.75, n.color[2] * 0.25 + this.colors.bad[2] * 0.75];
      case "disabled": return [n.color[0] * 0.3 + this.colors.neutral[0] * 0.7, n.color[1] * 0.3 + this.colors.neutral[1] * 0.7, n.color[2] * 0.3 + this.colors.neutral[2] * 0.7];
      default: return n.color;
    }
  }

  // ─── Loop ──────────────────────────────────────────────────────────────

  private resize() {
    const rect = this.host.getBoundingClientRect();
    this.w = Math.max(1, this.host.clientWidth || rect.width);
    this.h = Math.max(1, this.host.clientHeight || rect.height);
    this.z = rect.width > 0 && this.host.clientWidth > 0 ? rect.width / this.host.clientWidth : 1;
    this.quality = qualityFor({ width: this.w, dpr: (window.devicePixelRatio || 1) * this.z, lowEnd: isLowEndDevice() || isPerformanceMode() });
    this.pr = this.tier === "low" ? 1 : this.quality.pixelRatio;
    this.renderer.setPixelRatio(this.pr);
    this.renderer.setSize(this.w, this.h, false);
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.composer.setPixelRatio(this.pr);
    this.composer.setSize(this.w, this.h);
    this.bloom.setSize(Math.round(this.w * this.pr * this.quality.bloomScale), Math.round(this.h * this.pr * this.quality.bloomScale));
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    for (const m of this.beamMats) m.resolution.set(this.w * this.pr, this.h * this.pr);
    const mw = this.w < 520 ? 120 : 176;
    const mh = Math.round(mw * 0.62);
    this.mini.width = Math.round(mw * this.pr);
    this.mini.height = Math.round(mh * this.pr);
    this.mini.style.width = `${mw}px`;
    this.mini.style.height = `${mh}px`;
    if (!this.userMoved) this.fit(false);
    this.invalidate();
  }

  private kick() {
    if (this.destroyed || this.raf || this.inFrame || this.lost) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(ts: number) {
    this.raf = 0;
    if (this.destroyed || this.lost) return;
    this.inFrame = true;
    try {
      this.frameBody(ts);
    } finally {
      this.inFrame = false;
    }
  }

  private frameBody(ts: number) {
    // A long gap means the loop was paused (hidden tab / reduced motion idle): don't integrate it.
    const gap = this.lastTs ? ts - this.lastTs : 0;
    const dt = gap > 0 && gap < 500 ? gap / 1000 : 0.016;
    if (gap > 0 && gap < 500) {
      const ms = gap;
      this.frameMs.push(ms);
      if (this.frameMs.length > 120) this.frameMs.shift();
      // Sustained >70ms frames (≈14fps) while visible → degrade once, permanently for this mount.
      if (this.tier === "full" && !document.hidden && this.visible) {
        this.slowFrames = ms > 70 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 2);
        if (this.slowFrames > 45) {
          this.tier = "low";
          this.applyTier();
          this.resize();
        }
      }
    }
    this.lastTs = ts;
    if (!this.reduced) this.elapsed += dt;

    if (ts - this.tokenCheckAt > 1000) {
      this.tokenCheckAt = ts;
      const cs = getComputedStyle(this.host);
      const sig = ["--g-bg", "--g-fg", "--g-primary", "--g-success"].map((t) => cs.getPropertyValue(t)).join("|");
      if (sig !== this.tokenSig) {
        if (this.tokenSig) this.readColors();
        this.tokenSig = sig;
        this.dirty = true;
      }
    }
    const animating = this.step(dt, ts);
    if (!this.visible || document.hidden) return; // resumes via observers
    if (this.dirty || animating || !this.reduced) {
      const t0 = performance.now();
      this.renderer.info.reset();
      this.updateScene();
      this.composer.render();
      this.drawMini();
      this.drawMs.push(performance.now() - t0);
      if (this.drawMs.length > 120) this.drawMs.shift();
      this.dirty = false;
    }
    if (animating || !this.reduced) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Easing, camera tween, pulses, ambient traffic; true while something moves. */
  private step(dt: number, ts: number): boolean {
    let moving = false;
    const ease = this.reduced ? 1 : 1 - Math.pow(0.001, dt * 1.6);
    let geomMoved = false;
    for (const n of this.nodes.values()) {
      const dx = n.tx - n.x;
      const dy = n.ty - n.y;
      const dz = n.tz - n.z;
      const dr = n.tr - n.r;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) + Math.abs(dr) > 0.05) {
        n.x += dx * ease;
        n.y += dy * ease;
        n.z += dz * ease;
        n.r += dr * ease;
        moving = true;
        geomMoved = true;
      }
      if (n.appear < 1) {
        n.appear = this.reduced ? 1 : Math.min(1, n.appear + dt * 1.8);
        moving = true;
      }
      if (n.ping > 0) {
        n.ping = Math.max(0, n.ping - dt * (this.reduced ? 1.6 : 0.9));
        moving = true;
      }
    }
    if (geomMoved) this.buildBeams();

    if (this.tween) {
      const e = this.reduced ? 1 : 1 - Math.pow(0.0005, dt * 1.4);
      this.controls.target.lerp(this.tween.target, e);
      this.camera.position.lerp(this.tween.pos, e);
      if (this.controls.target.distanceTo(this.tween.target) < 0.3 && this.camera.position.distanceTo(this.tween.pos) < 0.3) {
        this.controls.target.copy(this.tween.target);
        this.camera.position.copy(this.tween.pos);
        this.tween = null;
      }
      moving = true;
    }
    if (!this.reduced && this.userMoved && !this.controls.autoRotate && !this.tween && ts - this.lastInteractAt > AUTO_ROTATE_RESUME_MS && !this.selectedId) {
      this.controls.autoRotate = true;
    }
    this.controls.update(dt);

    if (this.pulses.length) {
      for (const p of this.pulses) p.t += dt * p.speed;
      this.pulses = this.pulses.filter((p) => p.t < 1);
      moving = true;
    }
    if (!this.reduced) {
      this.ambientAcc += dt;
      if (this.ambientAcc > 1.8) {
        this.ambientAcc = 0;
        const recent = this.edges.filter((e) => e.kind === "delegation" && e.recent);
        if (recent.length && this.pulses.length < this.quality.maxPulses) {
          const e = recent[Math.floor((this.elapsed * 7) % recent.length)];
          const a = this.nodes.get(e.from)!;
          this.pulses.push({ from: e.from, to: e.to, t: 0, speed: 0.45, color: lighten(a.color, 0.2) });
        }
      }
    }
    return moving;
  }

  private isDim(id: string) {
    return !!this.dimSet && !this.dimSet.has(id);
  }

  private viewDir(): THREE.Vector3 {
    const d = this.camera.position.clone().sub(this.controls.target);
    if (d.lengthSq() < 1e-6) return new THREE.Vector3(...frameDirection());
    return d.normalize();
  }

  private flyTo(target: THREE.Vector3, pos: THREE.Vector3) {
    this.tween = { target, pos };
    if (this.reduced) {
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
      this.controls.update();
      this.tween = null;
    }
    this.invalidate();
  }

  private _m4 = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _v = new THREE.Vector3();
  private _s = new THREE.Vector3();
  private _d = new THREE.Vector3();

  /** Push node state into the instanced attributes, sprites, satellites, particles and pulses. */
  private updateScene() {
    const t = this.elapsed;
    const focusId = this.hoverId ?? this.selectedId;
    const focus = focusSet(focusId, this.edges);
    const cam = this.camera.position;
    const camDir = this._d;

    this.orbMat.uniforms.uTime.value = t;
    this.haloMat.uniforms.uTime.value = t;
    this.selRingMat.uniforms.uTime.value = t;
    (this.sky.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    for (const p of [this.stars, this.dust, this.orbiters, this.pulsePts]) {
      const m = p.material as THREE.ShaderMaterial;
      m.uniforms.uTime.value = t;
      m.uniforms.uPR.value = this.pr;
    }
    this.beamFlowMat.dashOffset = -t * 40;
    for (const g of this.ringGroup.children) g.rotation.y = t * (g.userData.spin as number);

    const og = this.orbs.geometry;
    const hg = this.halos.geometry;
    const oCol = og.getAttribute("aColor") as THREE.InstancedBufferAttribute;
    const oPar = og.getAttribute("aParam") as THREE.InstancedBufferAttribute;
    const oExt = og.getAttribute("aExtra") as THREE.InstancedBufferAttribute;
    const hCol = hg.getAttribute("aColor") as THREE.InstancedBufferAttribute;
    const hPar = hg.getAttribute("aParam") as THREE.InstancedBufferAttribute;
    const hExt = hg.getAttribute("aExtra") as THREE.InstancedBufferAttribute;
    const sg = this.sats.geometry;
    const sCol = sg.getAttribute("aColor") as THREE.InstancedBufferAttribute;
    const sPar = sg.getAttribute("aParam") as THREE.InstancedBufferAttribute;
    const sExt = sg.getAttribute("aExtra") as THREE.InstancedBufferAttribute;

    const labelNear = this.frameDist * 0.5;
    const labelFar = this.frameDist * 1.25;
    const budget: Array<{ n: NodeRt; pri: number; dist: number }> = [];
    let satN = 0;
    let orbN = 0;
    const oPos = this.orbiters.geometry.getAttribute("position") as THREE.BufferAttribute;
    const oSize = this.orbiters.geometry.getAttribute("aSize") as THREE.BufferAttribute;
    const oColor = this.orbiters.geometry.getAttribute("aColor") as THREE.BufferAttribute;
    const oSeed = this.orbiters.geometry.getAttribute("aSeed") as THREE.BufferAttribute;
    const orbCap = oPos.count;
    const satCap = this.sats.instanceMatrix.count;

    for (const n of this.order) {
      const i = n.idx;
      const vis = nodeVisibility(n.id, this.dimSet, focus) * n.appear;
      const r = Math.max(2, n.r) * (0.4 + 0.6 * n.appear);
      const tint = this.stateTint(n);
      const lin = toColor(tint);
      const { glow, mode } = this.stateGlow(n.state);
      const isSel = n.id === this.selectedId ? 1 : 0;
      const isHov = n.id === this.hoverId ? 1 : 0;
      const boost = isSel || isHov ? 1.12 : 1;

      this._m4.compose(this._s.set(n.x, n.y, n.z), this._q.identity(), this._v.set(r, r, r));
      this.orbs.setMatrixAt(i, this._m4);
      oCol.setXYZ(i, lin.r, lin.g, lin.b);
      oPar.setXYZW(i, glow * boost, n.phase, vis, mode);
      oExt.setXYZW(i, n.ping, isSel, isHov, 0);

      const hs = r * (n.state === "working" ? 2.7 : n.state === "disabled" ? 1.8 : 2.3) * boost;
      this._m4.compose(this._s.set(n.x, n.y, n.z), this._q.identity(), this._v.set(hs, hs, hs));
      this.halos.setMatrixAt(i, this._m4);
      hCol.setXYZ(i, lin.r, lin.g, lin.b);
      hPar.setXYZW(i, glow * boost, n.phase, vis, mode);
      hExt.setXYZW(i, n.ping, isSel, isHov, 0);

      // Avatar billboard just in front of the orb surface.
      if (!n.avatar) {
        n.avatar = this.avatarSprite(n);
        this.avatarGroup.add(n.avatar);
      }
      camDir.copy(cam).sub(this._s.set(n.x, n.y, n.z)).normalize();
      n.avatar.position.set(n.x + camDir.x * r * 0.98, n.y + camDir.y * r * 0.98, n.z + camDir.z * r * 0.98);
      const ad = r * 1.3;
      n.avatar.scale.set(ad, ad, 1);
      n.avatar.material.opacity = vis * (n.state === "disabled" ? 0.6 : 0.96);

      const dist = cam.distanceTo(this._s.set(n.x, n.y, n.z));
      budget.push({ n, pri: labelPriority(n, this.hoverId, this.selectedId), dist });

      // Satellites: sub-agent runs orbiting the parent.
      const running = Math.min(n.running ?? 0, 6);
      if (running && n.state !== "disabled") {
        const seed = hash01(`${n.id}/sat`);
        for (let k = 0; k < running && satN < satCap; k++) {
          const off = satelliteOffset(k, running, r, this.reduced ? seed * 10 : t, seed);
          const sr = Math.max(3.5, r * 0.3);
          this._m4.compose(this._s.set(n.x + off[0], n.y + off[1], n.z + off[2]), this._q.identity(), this._v.set(sr, sr, sr));
          this.sats.setMatrixAt(satN, this._m4);
          sCol.setXYZ(satN, lin.r, lin.g, lin.b);
          sPar.setXYZW(satN, 1.1, n.phase + k, vis, 1);
          sExt.setXYZW(satN, 0, 0, 0, 0);
          const orbit = r * 2.1 + k * r * 0.35;
          const tilt = 0.45 + seed * 0.5;
          this._m4.makeRotationX(Math.PI / 2 - tilt);
          this._m4.scale(this._v.set(orbit, orbit, orbit));
          this._m4.setPosition(n.x, n.y, n.z);
          this.satRings.setMatrixAt(satN, this._m4);
          this.satRings.setColorAt(satN, lin.clone().multiplyScalar(0.35 + 0.65 * vis));
          satN++;
        }
      }

      // Orbiting particles on working agents.
      if (n.state === "working" && vis > 0.3) {
        const per = this.quality.orbitParticles;
        const seed = hash01(`${n.id}/orb`);
        const tilt = 0.6 + seed * 0.9;
        for (let k = 0; k < per && orbN < orbCap; k++) {
          const a = (this.reduced ? 0 : t * 1.6) + (k / per) * TAU + seed * TAU;
          const rr = r * 1.6;
          const x = Math.cos(a) * rr;
          const yy = Math.sin(a) * rr;
          oPos.setXYZ(orbN, n.x + x, n.y + yy * Math.sin(tilt), n.z + yy * Math.cos(tilt));
          oSize.setX(orbN, 3.2 + (k % 3));
          const iv = lighten(this.colors.primary, k % 2 ? 0.55 : 0.15);
          oColor.setXYZ(orbN, (lin.r * 0.4 + (iv[0] / 255) * 0.6) * vis, (lin.g * 0.4 + (iv[1] / 255) * 0.6) * vis, (lin.b * 0.4 + (iv[2] / 255) * 0.6) * vis);
          oSeed.setX(orbN, seed + k * 0.1);
          orbN++;
        }
      }
    }
    this.orbs.count = this.order.length;
    this.halos.count = this.order.length;
    this.orbs.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;
    for (const a of [oCol, oPar, oExt, hCol, hPar, hExt]) a.needsUpdate = true;
    this.sats.count = satN;
    this.satRings.count = satN;
    if (satN) {
      this.sats.instanceMatrix.needsUpdate = true;
      this.satRings.instanceMatrix.needsUpdate = true;
      if (this.satRings.instanceColor) this.satRings.instanceColor.needsUpdate = true;
      for (const a of [sCol, sPar, sExt]) a.needsUpdate = true;
    }
    this.orbiters.geometry.setDrawRange(0, orbN);
    if (orbN) for (const a of [oPos, oSize, oColor, oSeed]) a.needsUpdate = true;

    // Name labels: focus always, then the best `maxLabels` by priority; LOD fade by distance.
    budget.sort((a, b) => b.pri - a.pri || a.dist - b.dist);
    const shown = new Set<NodeRt>();
    for (let i = 0; i < budget.length; i++) {
      const b = budget[i];
      const forced = b.n.id === this.hoverId || b.n.id === this.selectedId;
      if (forced || i < this.quality.maxLabels) shown.add(b.n);
    }
    for (const b of budget) {
      const n = b.n;
      const want = shown.has(n);
      if (!n.label) {
        if (!want) continue;
        n.label = this.textSprite(n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name, n.color, 1);
        this.labelGroup.add(n.label);
      }
      const forced = n.id === this.hoverId || n.id === this.selectedId;
      const lod = forced ? 1 : labelAlpha(b.dist, labelNear, labelFar);
      const vis = nodeVisibility(n.id, this.dimSet, focus);
      n.label.material.opacity = want ? lod * (vis < 1 ? 0.25 : 0.92) * n.appear : 0;
      n.label.visible = n.label.material.opacity > 0.02;
      const r = Math.max(2, n.r);
      n.label.position.set(n.x, n.y - r - 9, n.z);
      const sc = clamp(b.dist / 420, 0.75, 2.2);
      n.label.scale.set((n.label.userData.aspect as number) * 10.5 * sc, 10.5 * sc, 1);
    }
    for (const s of this.clusterLabels) {
      const c = s.userData.cluster as LayoutCluster3D;
      const d = cam.distanceTo(this._s.set(c.x, c.y, c.z));
      s.material.opacity = clusterLabelAlpha(d, c.r) * 0.8;
      s.visible = s.material.opacity > 0.02;
      const sc = clamp(d / 520, 0.9, 3.4);
      s.scale.set((s.userData.aspect as number) * 11 * sc, 11 * sc, 1);
    }

    // Pulses travelling along beams.
    const pPos = this.pulsePts.geometry.getAttribute("position") as THREE.BufferAttribute;
    const pSize = this.pulsePts.geometry.getAttribute("aSize") as THREE.BufferAttribute;
    const pCol = this.pulsePts.geometry.getAttribute("aColor") as THREE.BufferAttribute;
    let pn = 0;
    for (const p of this.pulses) {
      const a = this.nodes.get(p.from);
      const b = this.nodes.get(p.to);
      if (!a || !b || pn >= pPos.count) continue;
      const A: Vec3 = [a.x, a.y, a.z];
      const B: Vec3 = [b.x, b.y, b.z];
      const pt = bezierPoint(A, beamControl(A, B), B, p.t);
      const amp = Math.sin(Math.PI * p.t);
      pPos.setXYZ(pn, pt[0], pt[1], pt[2]);
      pSize.setX(pn, 14 + amp * 12);
      pCol.setXYZ(pn, (p.color[0] / 255) * amp * 1.6, (p.color[1] / 255) * amp * 1.6, (p.color[2] / 255) * amp * 1.6);
      pn++;
    }
    this.pulsePts.geometry.setDrawRange(0, pn);
    if (pn) for (const a of [pPos, pSize, pCol]) a.needsUpdate = true;

    // Selection ring (billboard, rotating dashes).
    const sel = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
    if (sel) {
      const r = Math.max(2, sel.r) + 8;
      this.selRing.visible = true;
      this.selRing.position.set(sel.x, sel.y, sel.z);
      this.selRing.scale.set(r, r, 1);
      this.selRing.quaternion.copy(this.camera.quaternion);
    } else {
      this.selRing.visible = false;
    }

    // Hover pick (throttled to the frame).
    if (this.pointer.has && !this.down) this.pick();
  }

  private pick() {
    this.raycaster.setFromCamera(new THREE.Vector2(this.pointer.x, this.pointer.y), this.camera);
    const hits = this.raycaster.intersectObject(this.orbs, false);
    const hit = hits.length && typeof hits[0].instanceId === "number" ? this.order[hits[0].instanceId] : null;
    this.setHover(hit ?? null);
  }

  private drawMini() {
    const { mctx: ctx } = this;
    const mw = this.mini.width / this.pr;
    const mh = this.mini.height / this.pr;
    ctx.setTransform(this.pr, 0, 0, this.pr, 0, 0);
    ctx.clearRect(0, 0, mw, mh);
    const pad = 10;
    const ext = Math.max(1, this.radius * 2);
    const s = Math.min((mw - pad * 2) / ext, (mh - pad * 2) / ext);
    const ox = mw / 2 - this.center[0] * s;
    const oy = mh / 2 - this.center[2] * s;
    for (const c of this.clusters) {
      const col = teamTint(this.colors.primary, c.paletteIndex);
      ctx.beginPath();
      ctx.arc(ox + c.x * s, oy + c.z * s, c.r * s, 0, TAU);
      ctx.strokeStyle = rgbaCss(col, 0.35);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const n of this.nodes.values()) {
      ctx.beginPath();
      ctx.arc(ox + n.x * s, oy + n.z * s, Math.max(1.5, n.r * s * 0.9), 0, TAU);
      ctx.fillStyle = rgbaCss(this.stateTint(n), this.isDim(n.id) ? 0.25 : 0.95);
      ctx.fill();
    }
    // Camera: target marker + view direction.
    const tx = ox + this.controls.target.x * s;
    const ty = oy + this.controls.target.z * s;
    const d = this.viewDir();
    ctx.strokeStyle = rgbaCss(this.colors.primary, 0.95);
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(tx, ty, 4, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + d.x * 14, ty + d.z * 14);
    ctx.stroke();
  }

  // ─── Interaction ───────────────────────────────────────────────────────

  private setHover(n: NodeRt | null, sx = 0, sy = 0) {
    const id = n?.id ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.opts.onHover?.(id);
      this.canvas.style.cursor = id ? "pointer" : "grab";
      this.colorBeams();
      this.invalidate();
    }
    if (!n) {
      this.tip.classList.remove("is-on");
      return;
    }
    const sig = JSON.stringify([n.id, n.state, n.hover, n.running]);
    if (sig !== this.tipFor) {
      this.tipFor = sig;
      fillConstellationTip(this.tip, n);
    }
    const px = sx || ((this.pointer.x + 1) / 2) * this.w;
    const py = sy || ((1 - this.pointer.y) / 2) * this.h;
    placeConstellationTip(this.tip, px, py, this.w, this.h);
    this.tip.classList.add("is-on");
  }

  private local(e: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    return { nx: x * 2 - 1, ny: -(y * 2 - 1), sx: x * this.w, sy: y * this.h };
  }

  private bind() {
    const c = this.canvas;
    c.style.cursor = "grab";
    c.style.touchAction = "none";
    const down = (e: PointerEvent) => {
      this.downCount++;
      const p = this.local(e);
      this.down = this.downCount === 1 ? { x: p.sx, y: p.sy, id: e.pointerId } : null;
      this.tip.classList.remove("is-on");
    };
    const move = (e: PointerEvent) => {
      const p = this.local(e);
      this.pointer = { x: p.nx, y: p.ny, has: e.pointerType !== "touch" };
      if (this.down && Math.hypot(p.sx - this.down.x, p.sy - this.down.y) > 5) this.down = null;
      if (!this.down && this.downCount === 0 && this.hoverId) this.setHover(this.nodes.get(this.hoverId) ?? null, p.sx, p.sy);
      if (this.pointer.has && this.downCount === 0) this.invalidate();
    };
    const up = (e: PointerEvent) => {
      this.downCount = Math.max(0, this.downCount - 1);
      const p = this.local(e);
      if (this.down && this.down.id === e.pointerId && this.downCount === 0) {
        this.pointer = { x: p.nx, y: p.ny, has: true };
        this.raycaster.setFromCamera(new THREE.Vector2(p.nx, p.ny), this.camera);
        const hits = this.raycaster.intersectObject(this.orbs, false);
        const n = hits.length && typeof hits[0].instanceId === "number" ? this.order[hits[0].instanceId] : null;
        if (n) {
          this.selectedId = n.id;
          this.setHover(null);
          this.colorBeams();
          this.opts.onSelect?.(n.id);
          this.focus(n.id);
        }
      }
      this.down = null;
      if (e.pointerType === "touch") this.pointer.has = false;
      this.invalidate();
    };
    const leave = () => {
      this.pointer.has = false;
      this.downCount = 0;
      this.down = null;
      this.setHover(null);
    };
    const dbl = (e: MouseEvent) => {
      const p = this.local(e);
      this.raycaster.setFromCamera(new THREE.Vector2(p.nx, p.ny), this.camera);
      if (!this.raycaster.intersectObject(this.orbs, false).length) this.resetView();
    };
    const key = (e: KeyboardEvent) => {
      let handled = true;
      const step = this.camera.position.distanceTo(this.controls.target) * 0.12;
      const pan = (dx: number, dy: number) => {
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const upv = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        const d = right.multiplyScalar(dx * step).add(upv.multiplyScalar(dy * step));
        this.tween = null;
        this.userMoved = true;
        this.controls.autoRotate = false;
        this.controls.target.add(d);
        this.camera.position.add(d);
      };
      if (e.key === "+" || e.key === "=") this.zoomBy(1.25);
      else if (e.key === "-" || e.key === "_") this.zoomBy(0.8);
      else if (e.key === "0") this.resetView();
      else if (e.key === "ArrowLeft") pan(-1, 0);
      else if (e.key === "ArrowRight") pan(1, 0);
      else if (e.key === "ArrowUp") pan(0, 1);
      else if (e.key === "ArrowDown") pan(0, -1);
      else handled = false;
      if (handled) {
        e.preventDefault();
        this.invalidate();
      }
    };
    const miniNav = (e: PointerEvent) => {
      if (e.type === "pointermove" && !(e.buttons & 1)) return;
      e.stopPropagation();
      const r = this.mini.getBoundingClientRect();
      const mw = this.mini.width / this.pr;
      const mh = this.mini.height / this.pr;
      const ext = Math.max(1, this.radius * 2);
      const s = Math.min((mw - 20) / ext, (mh - 20) / ext);
      const x = ((e.clientX - r.left) / r.width) * mw;
      const y = ((e.clientY - r.top) / r.height) * mh;
      const wx = (x - mw / 2) / s + this.center[0];
      const wz = (y - mh / 2) / s + this.center[2];
      const target = new THREE.Vector3(wx, this.center[1], wz);
      const off = this.camera.position.clone().sub(this.controls.target);
      this.userMoved = true;
      this.controls.autoRotate = false;
      if (e.type === "pointermove" || this.reduced) {
        this.tween = null;
        this.controls.target.copy(target);
        this.camera.position.copy(target).add(off);
        this.controls.update();
        this.invalidate();
      } else {
        this.flyTo(target, target.clone().add(off));
      }
    };
    const lost = (e: Event) => {
      e.preventDefault();
      this.lost = true;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.opts.onFallback?.("webgl-context-lost");
    };

    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", leave);
    c.addEventListener("dblclick", dbl);
    c.addEventListener("webglcontextlost", lost);
    this.host.addEventListener("keydown", key);
    this.mini.addEventListener("pointerdown", miniNav);
    this.mini.addEventListener("pointermove", miniNav);
    this.cleanup.push(() => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("pointerleave", leave);
      c.removeEventListener("dblclick", dbl);
      c.removeEventListener("webglcontextlost", lost);
      this.host.removeEventListener("keydown", key);
      this.mini.removeEventListener("pointerdown", miniNav);
      this.mini.removeEventListener("pointermove", miniNav);
    });
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
