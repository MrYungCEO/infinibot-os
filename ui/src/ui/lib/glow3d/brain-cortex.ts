/**
 * glow3d brain cortex — a procedural, anatomically shaped brain shell drawn
 * as a holographic fresnel surface (gold rim, lobe-tinted, glowing sulci).
 *
 *   • hemispheres — rays from each hemisphere's centre are bisected against
 *     the analytic brain (brain-anatomy.ts), so the silhouette, the flat
 *     medial faces (longitudinal fissure) and the Sylvian slit come from the
 *     same shape the layout uses. Gyri/sulci are pushed into the surface
 *     along the normal from a domain-warped noise network.
 *   • cerebellum — same construction with fine horizontal folia.
 *   • brainstem — a lathe along its axis with a pons bulge.
 *
 * Each vertex carries its lobe index (LOBE_IDS order) and its fold depth,
 * so lobes read as tints ON the cortex and folds as faint glowing lines.
 * Built once in unit space; the mesh group is scaled by the brain scale S.
 */

import * as THREE from "three";
import {
  BRAIN_BOUNDS,
  CEREBELLUM_CENTER,
  FISSURE,
  HEMI_CENTER,
  LOBE_IDS,
  cerebellumRadius,
  foliumAt,
  hemiRadius,
  lobeAt,
  sdBrainstem,
  sulcusAt,
  sylvianGroove,
  type LobeId,
} from "./brain-anatomy";
import { FOG_GLSL, type GlowUniforms } from "./scene";

const VERT = /* glsl */ `
  attribute float aFold; attribute float aLobe;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec3 vN; varying vec3 vView; varying float vFold; varying float vLobe; varying float vFog; varying vec3 vObj;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    vFold = aFold; vLobe = aLobe; vObj = position;
    vFog = fogFactor(mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime; uniform float uMotion; uniform float uGain;
  uniform vec3 uLobeColor[6]; uniform float uLobeEmph[6]; uniform vec3 uRimColor;
  varying vec3 vN; varying vec3 vView; varying float vFold; varying float vLobe; varying float vFog; varying vec3 vObj;
  void main() {
    int li = int(vLobe + 0.5);
    vec3 tint = uLobeColor[0]; float emph = uLobeEmph[0];
    for (int i = 1; i < 6; i++) { if (i == li) { tint = uLobeColor[i]; emph = uLobeEmph[i]; } }
    float facing = abs(dot(normalize(vN), normalize(vView)));
    float rim = pow(1.0 - facing, 2.3);
    // Sulci: thin glowing lines at the bottom of each fold.
    float sulcus = smoothstep(0.55, 0.95, vFold);
    float crown = 1.0 - smoothstep(0.0, 0.25, vFold);
    // Slow holographic scan band sweeping front to back.
    float scan = pow(0.5 + 0.5 * sin(vObj.z * 6.0 - uTime * 0.6 * uMotion), 18.0) * 0.06;
    // Cerebellum (4) and brainstem (5) always read as structure, even empty.
    if (li >= 4) emph = max(emph, 0.75);
    // Cerebellum: a soft lit body under its folia so it reads as tissue, not a wire hull.
    float body = li == 4 ? 0.05 + 0.05 * facing : 0.0;
    vec3 col = mix(uRimColor, tint, 0.7 + 0.3 * emph);
    float a = (0.02 + body + crown * 0.014 + rim * (li == 4 ? 0.22 : 0.46) + sulcus * (1.15 + 0.35 * rim) + scan) * mix(0.45, 1.0, emph) * uGain * (1.0 - vFog);
    gl_FragColor = vec4(col * a, a);
  }
`;

/** Unit-space surface distance along `dir` from `c` where `sd` turns positive (march + bisection). */
function surfaceAlong(c: [number, number, number], dir: [number, number, number], sd: (x: number, y: number, z: number) => number, maxT: number): number {
  let lo = 0, hi = maxT;
  const steps = 32;
  for (let s = 1; s <= steps; s++) {
    const t = (s / steps) * maxT;
    if (sd(c[0] + dir[0] * t, c[1] + dir[1] * t, c[2] + dir[2] * t) > 0) {
      hi = t;
      lo = ((s - 1) / steps) * maxT;
      break;
    }
  }
  for (let i = 0; i < 20; i++) {
    const m = (lo + hi) / 2;
    if (sd(c[0] + dir[0] * m, c[1] + dir[1] * m, c[2] + dir[2] * m) > 0) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

interface Part {
  geo: THREE.BufferGeometry;
}

/**
 * Star-shaped part (right side): every sphere direction maps to
 * centre + d · radius(d). `fold` gives the per-vertex fold depth (0..1) for
 * the shader. Returns the right part and its mirror (left).
 */
function buildStarPair(
  center: [number, number, number],
  radius: (dx: number, dy: number, dz: number) => number,
  fold: (x: number, y: number, z: number) => number,
  detail: number,
): [Part, Part] {
  const base = new THREE.IcosahedronGeometry(1, detail);
  base.deleteAttribute("normal");
  base.deleteAttribute("uv");
  const ico = mergeVerts(base);
  base.dispose();
  const pos = ico.getAttribute("position") as THREE.BufferAttribute;
  const n = pos.count;
  const out = new Float32Array(n * 3);
  const folds = new Float32Array(n);
  const lobes = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dx = pos.getX(i), dy = pos.getY(i), dz = pos.getZ(i);
    const r = radius(dx, dy, dz);
    const x = center[0] + dx * r, y = center[1] + dy * r, z = center[2] + dz * r;
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
    folds[i] = fold(x, y, z);
    // Lobe from a point slightly inside the surface.
    const k = Math.max(0, r - 0.03) / Math.max(1e-6, r);
    lobes[i] = LOBE_IDS.indexOf(lobeAt(center[0] + dx * r * k, center[1] + dy * r * k, center[2] + dz * r * k));
  }
  const make = (mirror: boolean): Part => {
    const p = new Float32Array(out);
    if (mirror) for (let i = 0; i < n; i++) p[i * 3] = -p[i * 3];
    const idx = Array.from(ico.getIndex()!.array as ArrayLike<number>);
    if (mirror) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    const geo = new THREE.BufferGeometry();
    geo.setIndex(idx);
    geo.setAttribute("position", new THREE.BufferAttribute(p, 3));
    geo.setAttribute("aFold", new THREE.BufferAttribute(new Float32Array(folds), 1));
    geo.setAttribute("aLobe", new THREE.BufferAttribute(new Float32Array(lobes), 1));
    geo.computeVertexNormals();
    return { geo };
  };
  return [make(false), make(true)];
}

/** Merge duplicate vertices of a non-indexed geometry (positions only). */
function mergeVerts(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const map = new Map<string, number>();
  const verts: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = map.get(key);
    if (id == null) {
      id = verts.length / 3;
      map.set(key, id);
      verts.push(x, y, z);
    }
    index.push(id);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(index);
  return out;
}

/** Brainstem: a lathe along the stalk axis, radius from the SDF. */
function buildBrainstem(radial: number, rings: number): Part {
  const a = new THREE.Vector3(0, -0.2, -0.235);
  const b = new THREE.Vector3(0, -0.98, -0.4);
  const axis = b.clone().sub(a);
  const len = axis.length();
  axis.normalize();
  const u = new THREE.Vector3(1, 0, 0);
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  const pos: number[] = [];
  const folds: number[] = [];
  const lobes: number[] = [];
  const index: number[] = [];
  const bsIdx = LOBE_IDS.indexOf("brainstem");
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const c = a.clone().addScaledVector(axis, t * len);
    for (let s = 0; s < radial; s++) {
      const th = (s / radial) * Math.PI * 2;
      const dir = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(v, Math.sin(th));
      const rr = surfaceAlong([c.x, c.y, c.z], [dir.x, dir.y, dir.z], sdBrainstem, 0.3);
      pos.push(c.x + dir.x * rr, c.y + dir.y * rr, c.z + dir.z * rr);
      folds.push(0.62 * Math.max(0, Math.sin(t * 46)) ** 6);
      lobes.push(bsIdx);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < radial; s++) {
      const i0 = r * radial + s;
      const i1 = r * radial + ((s + 1) % radial);
      const i2 = i0 + radial;
      const i3 = i1 + radial;
      index.push(i0, i1, i2, i1, i3, i2);
    }
  }
  // Make sure triangles face outward (normal · (vertex − axis) > 0).
  {
    const p0 = new THREE.Vector3(pos[index[0] * 3], pos[index[0] * 3 + 1], pos[index[0] * 3 + 2]);
    const p1 = new THREE.Vector3(pos[index[1] * 3], pos[index[1] * 3 + 1], pos[index[1] * 3 + 2]);
    const p2 = new THREE.Vector3(pos[index[2] * 3], pos[index[2] * 3 + 1], pos[index[2] * 3 + 2]);
    const nrm = p1.clone().sub(p0).cross(p2.clone().sub(p0));
    const c0 = a.clone();
    const out = p0.clone().sub(c0).sub(axis.clone().multiplyScalar(p0.clone().sub(c0).dot(axis)));
    if (nrm.dot(out) < 0) for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("aFold", new THREE.Float32BufferAttribute(folds, 1));
  geo.setAttribute("aLobe", new THREE.Float32BufferAttribute(lobes, 1));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return { geo };
}

export interface BrainCortexOptions {
  /** Icosphere subdivision for each hemisphere (higher = finer folds). */
  detail?: number;
}

/** Lateral surface anchor per lobe and side (unit space) — where lobe tags attach. */
export interface LobeAnchor {
  lobe: LobeId;
  side: -1 | 0 | 1;
  p: [number, number, number];
}

export class BrainCortex {
  readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  /**
   * Depth-only pre-pass: only the nearest cortex surface gets colour (no doubled hemisphere outlines).
   * `transparent` keeps it in three.js's transparent list so renderOrder 90 is honoured — an opaque
   * material renders before every transparent one and its depth would hide the links inside the brain.
   */
  private readonly depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true, transparent: true });
  /** Same shader without depth testing against the cortex (cerebellum, brainstem). */
  private readonly xrayMat: THREE.ShaderMaterial;
  private readonly parts: THREE.Mesh[] = [];
  private readonly lobeColor: THREE.Color[];
  private readonly lobeEmph: number[];
  readonly anchors: LobeAnchor[];
  /** ~400 surface points (unit space): the silhouette support for lobe tags. */
  readonly hull: Float32Array;
  /** Surface samples per X-ray part (cerebellum halves, brainstem): tag obstacles. */
  readonly lowerParts: Float32Array[];

  constructor(uniforms: GlowUniforms, opts: BrainCortexOptions = {}) {
    const detail = opts.detail ?? 48;
    this.lobeColor = LOBE_IDS.map(() => new THREE.Color("#d4af37"));
    this.lobeEmph = LOBE_IDS.map(() => 0.6);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: uniforms.uTime,
        uMotion: uniforms.uMotion,
        uFogNear: uniforms.uFogNear,
        uFogFar: uniforms.uFogFar,
        uFogColor: uniforms.uFogColor,
        uGain: { value: 1 },
        uLobeColor: { value: this.lobeColor },
        uLobeEmph: { value: this.lobeEmph },
        uRimColor: { value: new THREE.Color("#e8c76b") },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
    });
    this.xrayMat = this.material.clone();
    this.xrayMat.uniforms = this.material.uniforms;
    this.xrayMat.depthFunc = THREE.LessEqualDepth;
    const hemi = buildStarPair(HEMI_CENTER, (dx, dy, dz) => hemiRadius(dx, dy, dz, true), (x, y, z) => {
      if (Math.abs(x) < FISSURE + 0.02) return 0;
      return Math.max(sulcusAt(x, y, z), 0.78 * sylvianGroove(x, y, z));
    }, detail);
    const cb = buildStarPair(CEREBELLUM_CENTER, (dx, dy, dz) => {
      const r = cerebellumRadius(dx, dy, dz);
      const x = CEREBELLUM_CENTER[0] + dx * r, y = CEREBELLUM_CENTER[1] + dy * r, z = CEREBELLUM_CENTER[2] + dz * r;
      return r - 0.011 * foliumAt(x, y, z);
    }, foliumAt, Math.max(16, Math.round(detail * 0.6)));
    for (const p of hemi) this.addPart(p.geo, true);
    // Cerebellum + brainstem skip the depth pre-pass: they sit under the
    // cerebrum and should show through it, like an X-ray.
    for (const p of cb) this.addPart(p.geo, false);
    this.addPart(buildBrainstem(28, 26).geo, false);
    this.group.renderOrder = 2;
    this.anchors = this.computeAnchors();
    const pts: number[] = [];
    for (const m of this.parts) {
      const pos = m.geometry.getAttribute("position") as THREE.BufferAttribute;
      const step = Math.max(1, Math.floor(pos.count / 120));
      for (let i = 0; i < pos.count; i += step) pts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    this.hull = new Float32Array(pts);
    this.lowerParts = this.parts
      .filter((m) => m.material === this.xrayMat)
      .map((m) => {
        const pos = m.geometry.getAttribute("position") as THREE.BufferAttribute;
        const step = Math.max(1, Math.floor(pos.count / 80));
        const out: number[] = [];
        for (let i = 0; i < pos.count; i += step) out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        return new Float32Array(out);
      });
  }

  private addPart(geo: THREE.BufferGeometry, occlude: boolean): void {
    // Drawn last: everything else (nodes, links, halos) is already on screen,
    // so the depth pre-pass only hides the cortex's own far surfaces.
    const m = new THREE.Mesh(geo, occlude ? this.material : this.xrayMat);
    m.frustumCulled = false;
    m.renderOrder = occlude ? 91 : 89;
    this.parts.push(m);
    this.group.add(m);
    if (occlude) {
      const d = new THREE.Mesh(geo, this.depthMat);
      d.frustumCulled = false;
      d.renderOrder = 90;
      this.group.add(d);
    }
  }

  /** Lobe tag anchors: the most lateral/outer surface point of each lobe region. */
  private computeAnchors(): LobeAnchor[] {
    const best = new Map<string, { p: [number, number, number]; score: number }>();
    for (const m of this.parts) {
      const pos = m.geometry.getAttribute("position") as THREE.BufferAttribute;
      const lob = m.geometry.getAttribute("aLobe") as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const lobe = LOBE_IDS[Math.round(lob.getX(i))];
        const side = lobe === "brainstem" ? 0 : x < 0 ? -1 : 1;
        // Prefer points facing outward from the lobe's natural direction.
        const dirScore =
          lobe === "frontal" ? z * 0.9 + y * 0.6 :
          lobe === "parietal" ? y * 1.0 - z * 0.3 :
          lobe === "temporal" ? Math.abs(x) * 0.8 - y * 0.6 + z * 0.2 :
          lobe === "occipital" ? -z * 1.0 :
          lobe === "cerebellum" ? -z * 0.6 - y * 0.6 :
          -y;
        const key = `${lobe}:${side}`;
        const cur = best.get(key);
        if (!cur || dirScore > cur.score) best.set(key, { p: [x, y, z], score: dirScore });
      }
    }
    const out: LobeAnchor[] = [];
    for (const [key, v] of best) {
      const [lobe, side] = key.split(":");
      out.push({ lobe: lobe as LobeId, side: Number(side) as -1 | 0 | 1, p: v.p });
    }
    return out;
  }

  /** Brain scale S (world units per unit-space unit). */
  setScale(s: number): void {
    this.group.scale.setScalar(Math.max(1, s));
  }

  /** Per-lobe tint and emphasis (0..1). */
  setLobes(style: Partial<Record<LobeId, { color: THREE.Color; emphasis: number }>>): void {
    LOBE_IDS.forEach((id, i) => {
      const s = style[id];
      if (!s) return;
      this.lobeColor[i].copy(s.color);
      this.lobeEmph[i] = s.emphasis;
    });
  }

  /** Overall shell brightness (dims while a node is focused). */
  setGain(g: number): void {
    this.material.uniforms.uGain.value = g;
  }

  set visible(on: boolean) {
    this.group.visible = on;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  dispose(): void {
    for (const m of this.parts) m.geometry.dispose();
    this.material.dispose();
    this.depthMat.dispose();
    this.xrayMat.dispose();
  }
}

export { BRAIN_BOUNDS };
