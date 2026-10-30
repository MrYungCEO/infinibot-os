/**
 * glow3d links — glowing connections plus energy pulses travelling along them.
 *
 *   • `lines`  — one LineSegments draw. Every edge is a gently bowed curve
 *                 split into `segments` pieces with a colour gradient from
 *                 source to target and a per-edge alpha (emphasis). Additive
 *                 blending + bloom turn 1px GL lines into light.
 *   • `pulses` — one Points draw of at most `maxPulses` sprites that slide
 *                 along edges; the focused neighbourhood's edges get first
 *                 pick so interaction reads as energy flowing to/from the node.
 *
 * Edge endpoints come from `updatePositions(pos)` where `pos` is the node
 * position buffer `[x0,y0,z0, x1,…]` — the same array the layout feeds.
 *
 * Neural mode (`setNeural`): long edges arc through a volume toward its centre
 * (pathways through a brain instead of chords over it), and pulses travel
 * faster and flare as they arrive, like synapses firing.
 */

import * as THREE from "three";
import { FOG_GLSL, type GlowUniforms } from "./scene";
import { radialSpriteTexture } from "./textures";

export interface GlowLinkIn {
  /** Node indices into the position buffer. */
  a: number;
  b: number;
  colorA: THREE.Color;
  colorB: THREE.Color;
  /** Base brightness 0..1 (anchor-to-anchor edges are heavier). */
  weight: number;
  /** Dashed look for inferred relations. */
  dashed?: boolean;
  /** Ribbon width in CSS px (relation strength); 0/undefined = hairline only. */
  width?: number;
  /** Flow sheen speed (0 = still). */
  flow?: number;
}

export interface GlowLinksOptions {
  /** Curve subdivisions per edge (1 = straight). */
  segments?: number;
  maxPulses?: number;
  /** World units per second a pulse travels. */
  pulseSpeed?: number;
  pulseColor?: string;
}

const LINE_VERT = /* glsl */ `
  attribute vec3 color; attribute float aAlpha; attribute float aDash;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec3 vColor; varying float vAlpha; varying float vDash;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vAlpha = aAlpha * (1.0 - fogFactor(mv.z));
    vDash = aDash;
    gl_Position = projectionMatrix * mv;
  }
`;

const LINE_FRAG = /* glsl */ `
  uniform float uLineGain;
  varying vec3 vColor; varying float vAlpha; varying float vDash;
  void main() {
    // Dashed (inferred) edges: alternate along the interpolated dash coordinate.
    float dash = vDash < 0.0 ? 1.0 : step(0.5, fract(vDash));
    float a = vAlpha * dash * uLineGain;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * (0.6 + 1.1 * a), a);
  }
`;

/**
 * Ribbons: every curve segment is an instanced quad expanded in screen space,
 * so links get a real pixel width (GL lines are always 1 px). Instance data
 * reads straight from the line buffers (stride 2 vertices per segment).
 */
const RIBBON_VERT = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 iA; attribute vec3 iB; attribute vec3 iColA; attribute vec3 iColB;
  attribute float iAlpha; attribute float iTA; attribute float iTB; attribute float iDash;
  attribute float iWidth; attribute float iFlow;
  uniform vec2 uRes;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec3 vColor; varying float vAlpha; varying float vSide; varying float vT; varying float vDash; varying float vFlow;
  void main() {
    vec4 mvA = modelViewMatrix * vec4(iA, 1.0);
    vec4 mvB = modelViewMatrix * vec4(iB, 1.0);
    vec4 cA = projectionMatrix * mvA;
    vec4 cB = projectionMatrix * mvB;
    vec2 sA = cA.xy / max(1e-4, cA.w) * uRes;
    vec2 sB = cB.xy / max(1e-4, cB.w) * uRes;
    vec2 dir = sB - sA;
    float l = length(dir);
    dir = l > 1e-4 ? dir / l : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    bool atB = corner.y > 0.5;
    vec4 c = atB ? cB : cA;
    vec4 mv = atB ? mvB : mvA;
    // Overlap a hair along the segment so bends don't show seams.
    c.xy += dir * (atB ? 0.5 : -0.5) * iWidth / uRes * c.w;
    c.xy += nrm * corner.x * iWidth / uRes * c.w;
    gl_Position = c;
    vColor = atB ? iColB : iColA;
    vSide = corner.x;
    vT = atB ? iTB : iTA;
    vDash = iDash;
    vFlow = iFlow;
    vAlpha = (cA.w > 0.0 && cB.w > 0.0 ? iAlpha : 0.0) * (1.0 - fogFactor(mv.z));
  }
`;

const RIBBON_FRAG = /* glsl */ `
  uniform float uTime; uniform float uMotion; uniform float uGain;
  varying vec3 vColor; varying float vAlpha; varying float vSide; varying float vT; varying float vDash; varying float vFlow;
  void main() {
    float edge = 1.0 - smoothstep(0.25, 1.0, abs(vSide));
    float dash = vDash < 0.0 ? 1.0 : step(0.5, fract(vT * 14.0));
    // Subtle flow source → target; a brighter core along the centre line.
    float flow = 0.8 + 0.2 * sin(vT * 16.0 - uTime * 2.4 * vFlow * uMotion);
    float core = 1.0 - smoothstep(0.0, 0.45, abs(vSide));
    float a = vAlpha * edge * dash * mix(1.0, flow, step(0.001, vFlow)) * uGain;
    if (a < 0.003) discard;
    // Normal (not additive) blending: a 100-link fan converges to its relation
    // colour instead of summing to white. The bright core still feeds bloom.
    gl_FragColor = vec4(vColor * (0.72 + 0.33 * core), min(0.9, a));
  }
`;

const PULSE_VERT = /* glsl */ `
  attribute vec3 color; attribute float aSize;
  uniform float uDpr;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec3 vColor; varying float vAlpha;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vAlpha = (1.0 - fogFactor(mv.z)) * step(0.5, aSize);
    gl_PointSize = aSize * uDpr * (420.0 / max(40.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const PULSE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec3 vColor; varying float vAlpha;
  void main() {
    float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
    gl_FragColor = vec4(vColor * a * 1.6, a);
  }
`;

type Pulse = { edge: number; t: number; speed: number };

const WHITE_GOLD = new THREE.Color("#fff6d8");

export class GlowLinks {
  readonly group = new THREE.Group();
  readonly lines: THREE.LineSegments;
  readonly pulses: THREE.Points;
  /** Pixel-width ribbons over the hairlines (null until edges with width arrive). */
  readonly ribbons: THREE.Mesh;
  private readonly uRes = { value: new THREE.Vector2(400, 300) };
  private readonly uGain = { value: 0.62 };
  /** Additive hairline brightness: low under ribbons so 100-link hubs don't glare white. */
  private readonly uLineGain = { value: 1 };
  private edges: GlowLinkIn[] = [];
  private lineT = new Float32Array(0);
  private segWidth = new Float32Array(0);
  private segFlow = new Float32Array(0);
  private ribbonBufs: THREE.InstancedInterleavedBuffer[] = [];
  private degree = new Uint16Array(0);
  private hubPull = new Float32Array(0);
  private bundling = true;
  private focusEdges = new Set<number>();
  private readonly segments: number;
  private readonly maxPulses: number;
  private readonly pulseSpeed: number;
  private readonly pulseColor: THREE.Color;
  private linePos = new Float32Array(0);
  private lineCol = new Float32Array(0);
  private lineAlpha = new Float32Array(0);
  private lineDash = new Float32Array(0);
  private edgeAlpha = new Float32Array(0);
  /** Per-edge curve control point, recomputed with positions. */
  private ctrl = new Float32Array(0);
  private edgeLen = new Float32Array(0);
  private pulseList: Pulse[] = [];
  private readonly pulsePos: Float32Array;
  private readonly pulseCol: Float32Array;
  private readonly pulseSize: Float32Array;
  private readonly pulsePosAttr: THREE.BufferAttribute;
  private readonly pulseColAttr: THREE.BufferAttribute;
  private readonly pulseSizeAttr: THREE.BufferAttribute;
  private preferred: number[] = [];
  private pos: Float32Array | null = null;
  private pulsesOn = true;
  private neural: { x: number; y: number; z: number; radius: number; hemiX?: number } | null = null;
  private seed = 12345;

  constructor(uniforms: GlowUniforms, opts: GlowLinksOptions = {}) {
    this.segments = Math.max(1, Math.min(12, opts.segments ?? 6));
    this.maxPulses = Math.max(0, opts.maxPulses ?? 320);
    this.pulseSpeed = opts.pulseSpeed ?? 150;
    this.pulseColor = new THREE.Color(opts.pulseColor ?? "#ffd970");
    const shared = {
      uFogNear: uniforms.uFogNear,
      uFogFar: uniforms.uFogFar,
      uFogColor: uniforms.uFogColor,
    };
    const lineGeo = new THREE.BufferGeometry();
    const lineMat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uLineGain: this.uLineGain },
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lines = new THREE.LineSegments(lineGeo, lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;

    const n = Math.max(1, this.maxPulses);
    this.pulsePos = new Float32Array(n * 3);
    this.pulseCol = new Float32Array(n * 3);
    this.pulseSize = new Float32Array(n);
    const pulseGeo = new THREE.BufferGeometry();
    this.pulsePosAttr = new THREE.BufferAttribute(this.pulsePos, 3);
    this.pulseColAttr = new THREE.BufferAttribute(this.pulseCol, 3);
    this.pulseSizeAttr = new THREE.BufferAttribute(this.pulseSize, 1);
    this.pulsePosAttr.setUsage(THREE.DynamicDrawUsage);
    this.pulseSizeAttr.setUsage(THREE.DynamicDrawUsage);
    pulseGeo.setAttribute("position", this.pulsePosAttr);
    pulseGeo.setAttribute("color", this.pulseColAttr);
    pulseGeo.setAttribute("aSize", this.pulseSizeAttr);
    const pulseMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uMap: { value: radialSpriteTexture(32, 0.12, 1.4) },
        uDpr: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: PULSE_VERT,
      fragmentShader: PULSE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.pulses = new THREE.Points(pulseGeo, pulseMat);
    this.pulses.frustumCulled = false;
    this.pulses.renderOrder = 30;
    this.pulses.geometry.setDrawRange(0, 0);

    const ribbonGeo = new THREE.InstancedBufferGeometry();
    ribbonGeo.setAttribute("corner", new THREE.BufferAttribute(new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]), 2));
    ribbonGeo.setIndex([0, 1, 2, 2, 1, 3]);
    ribbonGeo.instanceCount = 0;
    this.ribbons = new THREE.Mesh(
      ribbonGeo,
      new THREE.ShaderMaterial({
        uniforms: { ...shared, uTime: uniforms.uTime, uMotion: uniforms.uMotion, uRes: this.uRes, uGain: this.uGain },
        vertexShader: RIBBON_VERT,
        fragmentShader: RIBBON_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
      }),
    );
    this.ribbons.frustumCulled = false;
    this.ribbons.renderOrder = 4;
    this.group.add(this.ribbons, this.lines, this.pulses);
  }

  /** Half-resolution in CSS px (NDC → px), set on resize. */
  setResolution(w: number, h: number): void {
    this.uRes.value.set(Math.max(1, w / 2), Math.max(1, h / 2));
  }

  /** Overall ribbon brightness (density / glow budget). */
  setGain(g: number): void {
    this.uGain.value = Math.max(0, Math.min(1, g));
  }

  /** Gentle bundling of dense hubs' links (curves share a trunk out of the hub). */
  setBundling(on: boolean): void {
    this.bundling = on;
    if (this.pos) this.updatePositions(this.pos);
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  /** Replace the edge set (topology change). Positions are applied separately. */
  setEdges(edges: GlowLinkIn[]): void {
    this.edges = edges;
    const S = this.segments;
    const vertsPerEdge = S * 2;
    const total = edges.length * vertsPerEdge;
    this.linePos = new Float32Array(total * 3);
    this.lineCol = new Float32Array(total * 3);
    this.lineAlpha = new Float32Array(total);
    this.lineDash = new Float32Array(total);
    this.lineT = new Float32Array(total);
    this.segWidth = new Float32Array(edges.length * S);
    this.segFlow = new Float32Array(edges.length * S);
    this.edgeAlpha = new Float32Array(edges.length).fill(1);
    let maxNode = 0;
    for (const ed of edges) maxNode = Math.max(maxNode, ed.a, ed.b);
    this.degree = new Uint16Array(edges.length ? maxNode + 1 : 0);
    for (const ed of edges) {
      this.degree[ed.a]++;
      this.degree[ed.b]++;
    }
    this.hubPull = new Float32Array(this.degree.length * 3);
    this.ctrl = new Float32Array(edges.length * 3);
    this.edgeLen = new Float32Array(edges.length);
    const c = new THREE.Color();
    for (let e = 0; e < edges.length; e++) {
      const ed = edges[e];
      for (let s = 0; s < S; s++) {
        for (let k = 0; k < 2; k++) {
          const v = e * vertsPerEdge + s * 2 + k;
          const t = (s + k) / S;
          c.copy(ed.colorA).lerp(ed.colorB, t);
          this.lineCol[v * 3] = c.r;
          this.lineCol[v * 3 + 1] = c.g;
          this.lineCol[v * 3 + 2] = c.b;
          this.lineDash[v] = ed.dashed ? t * 14 : -1;
          this.lineT[v] = t;
        }
        this.segWidth[e * S + s] = ed.width ?? 0;
        this.segFlow[e * S + s] = ed.flow ?? 0;
      }
    }
    const geo = this.lines.geometry;
    geo.setAttribute("position", new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(this.lineCol, 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.lineAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aDash", new THREE.BufferAttribute(this.lineDash, 1));
    geo.setDrawRange(0, total);
    this.buildRibbons(edges.length * S);
    this.uLineGain.value = edges.some((e) => (e.width ?? 0) > 0) ? 0.3 : 1;
    this.pulseList = [];
    this.preferred = [];
    this.applyAlpha();
  }

  /** Recompute every vertex from the node position buffer. */
  updatePositions(pos: Float32Array): void {
    this.pos = pos;
    const S = this.segments;
    const vpe = S * 2;
    const E = this.edges;
    const lp = this.linePos;
    // Dense hubs: centroid of each hub's neighbours. Curves leaving a hub bend
    // toward that trunk direction first, so a 100-link starburst reads as a
    // few soft bundles instead of a hairball.
    const HUB_MIN = 10;
    const hp = this.hubPull;
    if (this.bundling && hp.length) {
      hp.fill(0);
      for (const ed of E) {
        if (this.degree[ed.a] >= HUB_MIN) {
          hp[ed.a * 3] += pos[ed.b * 3]; hp[ed.a * 3 + 1] += pos[ed.b * 3 + 1]; hp[ed.a * 3 + 2] += pos[ed.b * 3 + 2];
        }
        if (this.degree[ed.b] >= HUB_MIN) {
          hp[ed.b * 3] += pos[ed.a * 3]; hp[ed.b * 3 + 1] += pos[ed.a * 3 + 1]; hp[ed.b * 3 + 2] += pos[ed.a * 3 + 2];
        }
      }
      for (let i = 0; i < this.degree.length; i++) {
        const d = this.degree[i];
        if (d < HUB_MIN) continue;
        hp[i * 3] /= d; hp[i * 3 + 1] /= d; hp[i * 3 + 2] /= d;
      }
    }
    for (let e = 0; e < E.length; e++) {
      const ed = E[e];
      const ax = pos[ed.a * 3], ay = pos[ed.a * 3 + 1], az = pos[ed.a * 3 + 2];
      const bx = pos[ed.b * 3], by = pos[ed.b * 3 + 1], bz = pos[ed.b * 3 + 2];
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      this.edgeLen[e] = len;
      // Bow sideways in the ground plane (cross with world up), capped so
      // long edges don't balloon.
      const bow = Math.min(len * 0.14, 34);
      let px = -dz, py = 0, pz = dx;
      const pl = Math.sqrt(px * px + pz * pz);
      if (pl < 1e-3) {
        px = 1; py = 0; pz = 0;
      } else {
        px /= pl; pz /= pl;
      }
      let cx = (ax + bx) / 2 + px * bow;
      let cy = (ay + by) / 2 + py * bow + bow * 0.35;
      let cz = (az + bz) / 2 + pz * bow;
      const nc = this.neural;
      if (nc) {
        // Pathway: long edges dip toward the centre of the volume.
        const k = Math.min(0.35, len / (nc.radius * 3));
        let tx = nc.x, ty = nc.y;
        if (nc.hemiX) {
          const sa = Math.sign(ax - nc.x), sb = Math.sign(bx - nc.x);
          if (sa === sb && sa !== 0) tx = nc.x + sa * nc.hemiX;
          else ty = nc.y - nc.radius * 0.32;
        }
        cx += (tx - cx) * k;
        cy += (ty - cy) * k;
        cz += (nc.z - cz) * k;
      }
      if (this.bundling && hp.length) {
        const da = this.degree[ed.a], db = this.degree[ed.b];
        const h = da >= db ? ed.a : ed.b;
        const dh = Math.max(da, db);
        if (dh >= HUB_MIN) {
          // Trunk point: from the hub 40 % of the way to its neighbours' centroid.
          const hx = pos[h * 3], hy = pos[h * 3 + 1], hz = pos[h * 3 + 2];
          const tx = hx + (hp[h * 3] - hx) * 0.4, ty = hy + (hp[h * 3 + 1] - hy) * 0.4, tz = hz + (hp[h * 3 + 2] - hz) * 0.4;
          const k = Math.min(0.6, 0.2 + 0.04 * Math.sqrt(dh));
          cx += (tx - cx) * k;
          cy += (ty - cy) * k;
          cz += (tz - cz) * k;
        }
      }
      this.ctrl[e * 3] = cx;
      this.ctrl[e * 3 + 1] = cy;
      this.ctrl[e * 3 + 2] = cz;
      for (let s = 0; s < S; s++) {
        for (let k = 0; k < 2; k++) {
          const t = (s + k) / S;
          const u = 1 - t;
          const v = e * vpe + s * 2 + k;
          lp[v * 3] = u * u * ax + 2 * u * t * cx + t * t * bx;
          lp[v * 3 + 1] = u * u * ay + 2 * u * t * cy + t * t * by;
          lp[v * 3 + 2] = u * u * az + 2 * u * t * cz + t * t * bz;
        }
      }
    }
    const attr = this.lines.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
    if (this.ribbonBufs[0]) this.ribbonBufs[0].needsUpdate = true;
  }

  /** Instanced ribbon geometry over the current line buffers (one quad per segment). */
  private buildRibbons(segments: number): void {
    const geo = this.ribbons.geometry as THREE.InstancedBufferGeometry;
    const posBuf = new THREE.InstancedInterleavedBuffer(this.linePos, 6, 1).setUsage(THREE.DynamicDrawUsage);
    const colBuf = new THREE.InstancedInterleavedBuffer(this.lineCol, 6, 1);
    const alphaBuf = new THREE.InstancedInterleavedBuffer(this.lineAlpha, 2, 1).setUsage(THREE.DynamicDrawUsage);
    const tBuf = new THREE.InstancedInterleavedBuffer(this.lineT, 2, 1);
    const dashBuf = new THREE.InstancedInterleavedBuffer(this.lineDash, 2, 1);
    geo.setAttribute("iA", new THREE.InterleavedBufferAttribute(posBuf, 3, 0));
    geo.setAttribute("iB", new THREE.InterleavedBufferAttribute(posBuf, 3, 3));
    geo.setAttribute("iColA", new THREE.InterleavedBufferAttribute(colBuf, 3, 0));
    geo.setAttribute("iColB", new THREE.InterleavedBufferAttribute(colBuf, 3, 3));
    geo.setAttribute("iAlpha", new THREE.InterleavedBufferAttribute(alphaBuf, 1, 0));
    geo.setAttribute("iTA", new THREE.InterleavedBufferAttribute(tBuf, 1, 0));
    geo.setAttribute("iTB", new THREE.InterleavedBufferAttribute(tBuf, 1, 1));
    geo.setAttribute("iDash", new THREE.InterleavedBufferAttribute(dashBuf, 1, 0));
    geo.setAttribute("iWidth", new THREE.InstancedBufferAttribute(this.segWidth, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("iFlow", new THREE.InstancedBufferAttribute(this.segFlow, 1));
    geo.instanceCount = segments;
    this.ribbonBufs = [posBuf, alphaBuf];
  }

  /** Per-edge brightness 0..1; pass a function for bulk updates. */
  setAlpha(fn: (edge: GlowLinkIn, index: number) => number): void {
    for (let e = 0; e < this.edges.length; e++) this.edgeAlpha[e] = fn(this.edges[e], e);
    this.applyAlpha();
  }

  private applyAlpha(): void {
    const S = this.segments;
    const vpe = S * 2;
    for (let e = 0; e < this.edges.length; e++) {
      const a = this.edgeAlpha[e];
      for (let v = 0; v < vpe; v++) this.lineAlpha[e * vpe + v] = a;
      // Highlighted (focus) links widen; faint context links thin out.
      const base = this.edges[e].width ?? 0;
      // Focused links: much wider (≥ 3 px) so a hover reads instantly.
      const w = this.focusEdges.has(e) ? Math.max(3, base * 2.2) : base * (a < 0.12 ? 0.7 : 1);
      for (let s = 0; s < S; s++) this.segWidth[e * S + s] = w;
    }
    const attr = this.lines.geometry.getAttribute("aAlpha") as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
    if (this.ribbonBufs[1]) this.ribbonBufs[1].needsUpdate = true;
    const wa = this.ribbons.geometry.getAttribute("iWidth") as THREE.InstancedBufferAttribute | undefined;
    if (wa) wa.needsUpdate = true;
  }

  /** Edges of the focused node: drawn wider (call before `setAlpha`). */
  setFocusEdges(indices: number[]): void {
    this.focusEdges = new Set(indices);
  }

  /** Edges whose pulses should run first (the focused neighbourhood). */
  setPreferredEdges(indices: number[]): void {
    this.preferred = indices;
    // Reassign existing pulses so the focus change is immediate.
    if (indices.length) {
      for (let i = 0; i < this.pulseList.length; i++) {
        if (i < Math.min(this.pulseList.length, indices.length * 2)) {
          this.pulseList[i].edge = indices[i % indices.length];
          this.pulseList[i].t = this.rand();
        }
      }
    }
  }

  /**
   * Neural pathways + synapse-style pulses (null = classic bowed links).
   * With `hemiX`, edges within one side arc through that side's centre
   * (±hemiX) and edges between sides dip deep and low through the middle
   * (a corpus callosum), keeping the midline fissure dark from above.
   */
  setNeural(center: { x: number; y: number; z: number; radius: number; hemiX?: number } | null): void {
    this.neural = center;
    if (this.pos) this.updatePositions(this.pos);
  }

  setPulsesEnabled(on: boolean): void {
    this.pulsesOn = on;
    this.pulses.visible = on;
    if (!on) this.pulses.geometry.setDrawRange(0, 0);
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private pickEdge(i: number): number {
    const E = this.edges.length;
    if (!E) return 0;
    if (this.preferred.length && i < this.preferred.length * 2) {
      return this.preferred[i % this.preferred.length];
    }
    return Math.floor(this.rand() * E);
  }

  /** Advance pulses by `dt` seconds and write their sprites. */
  tick(dt: number): void {
    if (!this.pulsesOn || !this.pos || !this.edges.length) return;
    const want = Math.min(this.maxPulses, Math.max(24, Math.ceil(this.edges.length * 0.4)));
    while (this.pulseList.length < want) {
      const i = this.pulseList.length;
      this.pulseList.push({ edge: this.pickEdge(i), t: this.rand(), speed: 0.7 + this.rand() * 0.6 });
    }
    if (this.pulseList.length > want) this.pulseList.length = want;
    const pos = this.pos;
    const c = new THREE.Color();
    let n = 0;
    for (let i = 0; i < this.pulseList.length; i++) {
      const p = this.pulseList[i];
      const ed = this.edges[p.edge];
      if (!ed) {
        p.edge = this.pickEdge(i);
        continue;
      }
      const len = Math.max(20, this.edgeLen[p.edge]);
      p.t += (dt * this.pulseSpeed * p.speed * (this.neural ? 1.7 : 1)) / len;
      if (p.t >= 1) {
        p.t = 0;
        p.edge = this.pickEdge(i);
        continue;
      }
      const alpha = this.edgeAlpha[p.edge];
      if (alpha < 0.12) {
        // Dimmed edge: park the pulse (size 0 hides it) but keep it moving.
        this.pulseSize[n] = 0;
        n++;
        continue;
      }
      const t = p.t;
      const u = 1 - t;
      const ax = pos[ed.a * 3], ay = pos[ed.a * 3 + 1], az = pos[ed.a * 3 + 2];
      const bx = pos[ed.b * 3], by = pos[ed.b * 3 + 1], bz = pos[ed.b * 3 + 2];
      const cx = this.ctrl[p.edge * 3], cy = this.ctrl[p.edge * 3 + 1], cz = this.ctrl[p.edge * 3 + 2];
      this.pulsePos[n * 3] = u * u * ax + 2 * u * t * cx + t * t * bx;
      this.pulsePos[n * 3 + 1] = u * u * ay + 2 * u * t * cy + t * t * by;
      this.pulsePos[n * 3 + 2] = u * u * az + 2 * u * t * cz + t * t * bz;
      // Fade in/out at the ends so pulses appear to leave and arrive; in
      // neural mode the arrival instead flares white-gold (a synapse firing).
      let ends = Math.min(1, Math.min(t, 1 - t) * 5);
      let flare = 0;
      if (this.neural) {
        ends = Math.min(1, t * 6);
        flare = t > 0.82 ? (t - 0.82) / 0.18 : 0;
        ends *= 1 + 2.4 * flare * flare;
      }
      c.copy(ed.colorB).lerp(this.pulseColor, alpha >= 0.95 ? 0.75 : 0.3);
      if (flare > 0) c.lerp(WHITE_GOLD, flare);
      this.pulseCol[n * 3] = c.r;
      this.pulseCol[n * 3 + 1] = c.g;
      this.pulseCol[n * 3 + 2] = c.b;
      this.pulseSize[n] = (alpha >= 0.95 ? 5.2 : 3.4) * ends * (0.6 + 0.4 * ed.weight);
      n++;
    }
    this.pulses.geometry.setDrawRange(0, n);
    this.pulsePosAttr.needsUpdate = true;
    this.pulseColAttr.needsUpdate = true;
    this.pulseSizeAttr.needsUpdate = true;
  }

  dispose(): void {
    this.ribbons.geometry.dispose();
    (this.ribbons.material as THREE.Material).dispose();
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.pulses.geometry.dispose();
    (this.pulses.material as THREE.Material).dispose();
  }
}
