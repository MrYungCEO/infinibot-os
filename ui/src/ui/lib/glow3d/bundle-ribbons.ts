/**
 * glow3d bundle ribbons — aggregated edges between clusters. Instead of
 * hundreds of 1 px lines between two groups, one soft ribbon per group pair
 * whose screen-space WIDTH shows how many links it carries. Ribbons are bowed
 * Bézier curves (through the brain's interior in brain mode), expanded in
 * the vertex shader so the width stays in pixels at any zoom. One draw.
 */

import * as THREE from "three";
import { FOG_GLSL, type GlowUniforms } from "./scene";

export interface BundleIn {
  /** Endpoint node indices into the position buffer (ignored when pa/pb are set). */
  a: number;
  b: number;
  /** Fixed world endpoints (e.g. region centres). */
  pa?: [number, number, number];
  pb?: [number, number, number];
  count: number;
  colorA: THREE.Color;
  colorB: THREE.Color;
}

const SEG = 14;

const VERT = /* glsl */ `
  attribute vec3 aNext; attribute float aSide; attribute float aWidth; attribute vec3 color; attribute float aAlpha; attribute float aT;
  uniform vec2 uRes;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec3 vColor; varying float vAlpha; varying float vSide; varying float vT;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec4 c0 = projectionMatrix * mv;
    vec4 c1 = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);
    vec2 s0 = c0.xy / max(1e-4, c0.w) * uRes;
    vec2 s1 = c1.xy / max(1e-4, c1.w) * uRes;
    vec2 dir = s1 - s0;
    float l = length(dir);
    dir = l > 1e-4 ? dir / l : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    // Taper toward both ends so ribbons meet their hubs as points.
    float taper = 0.35 + 0.65 * sin(3.14159265 * aT);
    c0.xy += nrm * aSide * aWidth * taper / uRes * c0.w;
    gl_Position = c0;
    vColor = color; vSide = aSide; vT = aT;
    vAlpha = aAlpha * (1.0 - fogFactor(mv.z));
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime; uniform float uMotion;
  varying vec3 vColor; varying float vAlpha; varying float vSide; varying float vT;
  void main() {
    float edge = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
    float flow = 0.82 + 0.18 * sin(vT * 18.0 - uTime * 2.2 * uMotion);
    float a = vAlpha * edge * flow;
    gl_FragColor = vec4(vColor * a, a);
  }
`;

export class BundleRibbons {
  readonly mesh: THREE.Mesh;
  private bundles: BundleIn[] = [];
  private pos = new Float32Array(0);
  private next = new Float32Array(0);
  private alpha = new Float32Array(0);
  private base = new Float32Array(0);
  private readonly uRes = { value: new THREE.Vector2(800, 600) };
  private neural: { x: number; y: number; z: number; radius: number; hemiX?: number } | null = null;

  constructor(uniforms: GlowUniforms) {
    const geo = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: uniforms.uTime,
          uMotion: uniforms.uMotion,
          uFogNear: uniforms.uFogNear,
          uFogFar: uniforms.uFogFar,
          uFogColor: uniforms.uFogColor,
          uRes: this.uRes,
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  /** Half-resolution in px (NDC → px), set on resize. */
  setResolution(w: number, h: number): void {
    this.uRes.value.set(Math.max(1, w / 2), Math.max(1, h / 2));
  }

  setNeural(c: { x: number; y: number; z: number; radius: number; hemiX?: number } | null): void {
    this.neural = c;
  }

  setBundles(bundles: BundleIn[]): void {
    this.bundles = bundles;
    const verts = bundles.length * (SEG + 1) * 2;
    this.pos = new Float32Array(verts * 3);
    this.next = new Float32Array(verts * 3);
    const side = new Float32Array(verts);
    const width = new Float32Array(verts);
    const col = new Float32Array(verts * 3);
    const t = new Float32Array(verts);
    this.alpha = new Float32Array(verts);
    this.base = new Float32Array(bundles.length);
    const index: number[] = [];
    const c = new THREE.Color();
    bundles.forEach((b, k) => {
      // Width in px ∝ log of the link count; brightness too (but capped).
      const w = Math.min(7, 1.2 + 1.5 * Math.log2(1 + b.count));
      this.base[k] = Math.min(0.42, 0.14 + 0.06 * Math.log2(1 + b.count));
      for (let s = 0; s <= SEG; s++) {
        c.copy(b.colorA).lerp(b.colorB, s / SEG);
        for (let e = 0; e < 2; e++) {
          const v = (k * (SEG + 1) + s) * 2 + e;
          side[v] = e ? 1 : -1;
          width[v] = w;
          t[v] = s / SEG;
          col[v * 3] = c.r;
          col[v * 3 + 1] = c.g;
          col[v * 3 + 2] = c.b;
          this.alpha[v] = this.base[k];
        }
        if (s < SEG) {
          const v0 = (k * (SEG + 1) + s) * 2;
          index.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2);
        }
      }
    });
    const geo = this.mesh.geometry;
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aNext", new THREE.BufferAttribute(this.next, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    geo.setAttribute("aWidth", new THREE.BufferAttribute(width, 1));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aT", new THREE.BufferAttribute(t, 1));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(index);
    this.mesh.visible = bundles.length > 0;
  }

  /** Recompute curves from the node position buffer. */
  updatePositions(pos: Float32Array): void {
    const P = this.pos, N = this.next;
    const pt = new Float32Array((SEG + 1) * 3);
    this.bundles.forEach((b, k) => {
      const ax = b.pa ? b.pa[0] : pos[b.a * 3], ay = b.pa ? b.pa[1] : pos[b.a * 3 + 1], az = b.pa ? b.pa[2] : pos[b.a * 3 + 2];
      const bx = b.pb ? b.pb[0] : pos[b.b * 3], by = b.pb ? b.pb[1] : pos[b.b * 3 + 1], bz = b.pb ? b.pb[2] : pos[b.b * 3 + 2];
      const len = Math.hypot(bx - ax, by - ay, bz - az) || 1;
      let cx = (ax + bx) / 2, cy = (ay + by) / 2 + Math.min(len * 0.18, 140), cz = (az + bz) / 2;
      const nc = this.neural;
      if (nc) {
        const kk = Math.min(0.45, len / (nc.radius * 2.4));
        let tx = nc.x, ty = nc.y;
        if (nc.hemiX) {
          const sa = Math.sign(ax - nc.x), sb = Math.sign(bx - nc.x);
          if (sa === sb && sa !== 0) tx = nc.x + sa * nc.hemiX;
          else ty = nc.y - nc.radius * 0.3;
        }
        cy = (ay + by) / 2;
        cx += (tx - cx) * kk;
        cy += (ty - cy) * kk;
        cz += (nc.z - cz) * kk;
      }
      for (let s = 0; s <= SEG; s++) {
        const tt = s / SEG, u = 1 - tt;
        pt[s * 3] = u * u * ax + 2 * u * tt * cx + tt * tt * bx;
        pt[s * 3 + 1] = u * u * ay + 2 * u * tt * cy + tt * tt * by;
        pt[s * 3 + 2] = u * u * az + 2 * u * tt * cz + tt * tt * bz;
      }
      for (let s = 0; s <= SEG; s++) {
        // Direction sample: next point (last point mirrors back from the previous one).
        const sn = s < SEG ? s + 1 : s - 1;
        const flip = s < SEG ? 1 : -1;
        for (let e = 0; e < 2; e++) {
          const v = (k * (SEG + 1) + s) * 2 + e;
          P[v * 3] = pt[s * 3];
          P[v * 3 + 1] = pt[s * 3 + 1];
          P[v * 3 + 2] = pt[s * 3 + 2];
          N[v * 3] = pt[s * 3] + (pt[sn * 3] - pt[s * 3]) * flip;
          N[v * 3 + 1] = pt[s * 3 + 1] + (pt[sn * 3 + 1] - pt[s * 3 + 1]) * flip;
          N[v * 3 + 2] = pt[s * 3 + 2] + (pt[sn * 3 + 2] - pt[s * 3 + 2]) * flip;
        }
      }
    });
    const geo = this.mesh.geometry;
    const pa = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    const na = geo.getAttribute("aNext") as THREE.BufferAttribute | undefined;
    if (pa) pa.needsUpdate = true;
    if (na) na.needsUpdate = true;
  }

  /** Per-bundle brightness multiplier (focus dims unrelated bundles). */
  setAlpha(fn: (index: number) => number): void {
    const vpb = (SEG + 1) * 2;
    for (let k = 0; k < this.bundles.length; k++) {
      const a = this.base[k] * fn(k);
      for (let v = 0; v < vpb; v++) this.alpha[k * vpb + v] = a;
    }
    const at = this.mesh.geometry.getAttribute("aAlpha") as THREE.BufferAttribute | undefined;
    if (at) at.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
