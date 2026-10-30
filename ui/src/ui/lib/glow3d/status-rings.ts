/**
 * glow3d status rings — camera-facing rings drawn around selected nodes in
 * ONE instanced draw. Each ring can carry:
 *
 *   • a progress arc (projects: done / total, swept clockwise from 12 o'clock)
 *     over a dim track in the node's status colour,
 *   • a "live" comet that orbits the ring while an agent works on it,
 *   • a selection halo (thin cyan outer ring) and a drop-target pulse.
 *
 * Only the nodes that need a ring get an instance (`setItems`), so a 5k-node
 * graph with 60 projects pays for 60 quads. Positions are read from the
 * stage's world-position buffer by index on `updatePositions`.
 */

import * as THREE from "three";
import { FOG_GLSL, type GlowUniforms } from "./scene";

export interface RingItem {
  /** Index into the stage's node/position arrays. */
  index: number;
  /** World radius of the node the ring hugs. */
  radius: number;
  color: THREE.Color;
  /** 0..1 progress arc, or < 0 for no arc (selection-only ring). */
  progress: number;
  live: boolean;
  /** 0 = none, 1 = selected, 2 = drop target. */
  mark: number;
  emphasis: number;
}

const VERT = /* glsl */ `
  attribute vec3 aColor; attribute vec4 aState; // progress, live, mark, emphasis
  attribute vec4 aOffset; // xyz centre, w radius
  uniform float uTime; uniform float uMotion; uniform float uBob;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec2 vUv; varying vec3 vColor; varying vec4 vState; varying float vFog;
  void main() {
    vec3 c = aOffset.xyz;
    vec4 mv = viewMatrix * vec4(c, 1.0);
    float grow = 1.0 + step(1.5, aState.z) * 0.12 * (0.5 + 0.5 * sin(uTime * 6.0)) * uMotion;
    mv.xy += position.xy * aOffset.w * 2.05 * grow;
    vUv = uv; vColor = aColor; vState = aState; vFog = fogFactor(mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime; uniform float uMotion;
  varying vec2 vUv; varying vec3 vColor; varying vec4 vState; varying float vFog;
  const float PI = 3.14159265;
  float band(float d, float r, float w) { return smoothstep(w, 0.0, abs(d - r)); }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    if (d > 1.0) discard;
    float progress = vState.x; float live = vState.y; float mark = vState.z; float emph = vState.w;
    // angle 0 at 12 o'clock, increasing clockwise, 0..1
    float ang = fract(atan(p.x, p.y) / (2.0 * PI) + 1.0);
    vec3 col = vec3(0.0); float a = 0.0;
    // Ring radii in quad space (node edge sits at ~0.49).
    float rTrack = 0.62;
    if (progress >= 0.0) {
      float track = band(d, rTrack, 0.035);
      col += vColor * track * 0.55; a += track * 0.55;
      float filled = step(ang, progress) * band(d, rTrack, 0.05);
      vec3 gold = vec3(1.0, 0.82, 0.38);
      col += mix(gold, vColor, 0.25) * filled * 1.6; a += filled;
      // Tick marks every 10% for a precision-instrument read.
      float ticks = band(d, 0.72, 0.018) * step(0.92, fract(ang * 10.0 + 0.04));
      col += vec3(0.9, 0.85, 0.7) * ticks * 0.5; a += ticks * 0.5;
    }
    if (live > 0.5) {
      float head = fract(uTime * 0.35 * uMotion + 0.0);
      float da = fract(head - ang + 1.0);
      float comet = smoothstep(0.22, 0.0, da) * band(d, rTrack + 0.06, 0.05);
      col += vec3(0.45, 1.0, 0.75) * comet * 1.8; a += comet;
      float breathe = (0.5 + 0.5 * sin(uTime * 3.2)) * uMotion;
      float aura = band(d, 0.8, 0.08) * (0.25 + 0.35 * breathe);
      col += vec3(0.35, 0.95, 0.7) * aura; a += aura * 0.6;
    }
    if (mark > 0.5) {
      vec3 cyan = vec3(0.38, 0.92, 1.0);
      float sel = band(d, 0.9, 0.03);
      // Dashed bezel that slowly rotates.
      float dash = step(0.5, fract(ang * 24.0 + uTime * 0.25 * uMotion));
      float strength = mark > 1.5 ? 1.8 : 1.0;
      col += cyan * sel * (0.55 + 0.45 * dash) * strength; a += sel * strength;
      if (mark > 1.5) {
        float fill = smoothstep(0.95, 0.5, d) * 0.12;
        col += cyan * fill; a += fill;
      }
    }
    float vis = mix(0.12, 1.0, max(emph, step(0.5, mark)));
    a *= vis * (1.0 - vFog * 0.85);
    gl_FragColor = vec4(col * vis * (1.0 - vFog * 0.85), clamp(a, 0.0, 1.0));
  }
`;

export class StatusRings {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private capacity = 0;
  private items: RingItem[] = [];
  private aColor!: THREE.InstancedBufferAttribute;
  private aState!: THREE.InstancedBufferAttribute;
  private aOffset!: THREE.InstancedBufferAttribute;

  constructor(uniforms: GlowUniforms) {
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.geo.setAttribute("uv", quad.getAttribute("uv"));
    this.ensure(64);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: uniforms.uTime,
        uMotion: uniforms.uMotion,
        uFogNear: uniforms.uFogNear,
        uFogFar: uniforms.uFogFar,
        uFogColor: uniforms.uFogColor,
        uBob: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return;
    this.capacity = Math.max(64, Math.ceil(n * 1.5));
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.aState = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.aState.setUsage(THREE.DynamicDrawUsage);
    this.aOffset.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aColor", this.aColor);
    this.geo.setAttribute("aState", this.aState);
    this.geo.setAttribute("aOffset", this.aOffset);
  }

  /** Replace the ring set. Call `updatePositions` afterwards. */
  setItems(items: RingItem[]): void {
    this.ensure(items.length);
    this.items = items;
    const c = this.aColor.array as Float32Array;
    const s = this.aState.array as Float32Array;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      c[i * 3] = it.color.r;
      c[i * 3 + 1] = it.color.g;
      c[i * 3 + 2] = it.color.b;
      s[i * 4] = it.progress;
      s[i * 4 + 1] = it.live ? 1 : 0;
      s[i * 4 + 2] = it.mark;
      s[i * 4 + 3] = it.emphasis;
    }
    this.aColor.needsUpdate = true;
    this.aState.needsUpdate = true;
    this.geo.instanceCount = items.length;
  }

  /** Update emphasis for every ring from a per-node emphasis array. */
  setEmphasisFrom(emph: Float32Array): void {
    const s = this.aState.array as Float32Array;
    for (let i = 0; i < this.items.length; i++) s[i * 4 + 3] = emph[this.items[i].index] ?? 1;
    this.aState.needsUpdate = true;
  }

  /** Copy centres from the stage's world positions (`[x,y,z]` per node). */
  updatePositions(pos: Float32Array, scaleOf?: (index: number) => number): void {
    const o = this.aOffset.array as Float32Array;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      o[i * 4] = pos[it.index * 3];
      o[i * 4 + 1] = pos[it.index * 3 + 1];
      o[i * 4 + 2] = pos[it.index * 3 + 2];
      o[i * 4 + 3] = it.radius * (scaleOf ? scaleOf(it.index) : 1);
    }
    this.aOffset.needsUpdate = true;
  }

  get count(): number {
    return this.items.length;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
