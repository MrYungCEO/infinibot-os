/**
 * glow3d super-nodes — level-of-detail stand-ins for big clusters. When a
 * cluster is too small on screen to read node by node, the stage hides its
 * members and draws ONE super-node: a glowing core sized by the member count,
 * a segmented status mini-ring (open · at risk · backlog · done) and a soft
 * corona capped so a crowd of super-nodes never blooms into a white blob.
 * One instanced, camera-facing draw for all of them.
 */

import * as THREE from "three";
import { FOG_GLSL, type GlowUniforms } from "./scene";

export interface SuperNodeItem {
  x: number;
  y: number;
  z: number;
  /** World radius of the core. */
  radius: number;
  color: THREE.Color;
  /** Status fractions [open, at risk, backlog, done] (sum ≈ 1). */
  mix: [number, number, number, number];
  /** 0..1 — fades in/out as the LOD switches, dims outside a focus. */
  emphasis: number;
}

const VERT = /* glsl */ `
  attribute vec4 aDisc; attribute vec4 aTint; attribute vec4 aMix;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec2 vUv; varying vec4 vTint; varying vec4 vMix; varying float vFog; varying float vR;
  void main() {
    vec4 mv = viewMatrix * vec4(aDisc.xyz, 1.0);
    // Quad spans 1.9× the core so the ring + corona fit.
    mv.xy += position.xy * aDisc.w * 1.9;
    vUv = uv; vTint = aTint; vMix = aMix; vFog = fogFactor(mv.z); vR = aDisc.w;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime; uniform float uMotion; uniform float uGain;
  varying vec2 vUv; varying vec4 vTint; varying vec4 vMix; varying float vFog; varying float vR;
  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * 1.9; // in core radii
    float d = length(p);
    if (d > 1.9 || vTint.a < 0.01) discard;
    float aa = 1.6 / max(vR, 1.0);
    // Core: lit glass disc, brighter rim.
    float core = smoothstep(1.0 + aa, 1.0 - aa, d);
    float shade = 0.28 + 0.4 * (1.0 - d * d) + 0.5 * smoothstep(0.75, 0.98, d) * core;
    // Status mini-ring between 1.18 and 1.36 radii, segmented by angle.
    float ring = smoothstep(1.16 - aa, 1.18, d) * smoothstep(1.38 + aa, 1.36, d);
    float ang = fract(atan(p.x, p.y) / 6.2831853 + 1.0);
    vec3 cOpen = vec3(0.24, 0.86, 0.59), cRisk = vec3(0.94, 0.32, 0.37), cBack = vec3(0.61, 0.64, 0.69), cDone = vec3(0.37, 0.92, 0.83);
    float e0 = vMix.x, e1 = vMix.x + vMix.y, e2 = vMix.x + vMix.y + vMix.z;
    vec3 rc = ang < e0 ? cOpen : ang < e1 ? cRisk : ang < e2 ? cBack : cDone;
    float gapA = 0.006 / max(0.2, d);
    float seg = step(gapA, abs(ang - e0)) * step(gapA, abs(ang - e1)) * step(gapA, abs(ang - e2)) * step(gapA, min(ang, 1.0 - ang));
    ring *= seg;
    // Corona: soft, capped.
    float corona = (1.0 - smoothstep(1.0, 1.9, d)) * 0.22 * (1.0 - core);
    float pulse = 0.92 + 0.08 * sin(uTime * 1.6 * uMotion + vR);
    // Core stays under the bloom threshold: a lit glass token, not a lamp.
    vec3 col = vTint.rgb * (core * shade * pulse * 0.5 + corona * 0.6) + rc * ring * 0.85;
    float a = (core * 0.85 + ring * 0.9 + corona) * vTint.a * uGain * (1.0 - vFog);
    gl_FragColor = vec4(col * vTint.a * uGain * (1.0 - vFog), a);
  }
`;

export class SuperNodes {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private capacity = 0;
  private aDisc!: THREE.InstancedBufferAttribute;
  private aTint!: THREE.InstancedBufferAttribute;
  private aMix!: THREE.InstancedBufferAttribute;
  private readonly uGain = { value: 1 };

  constructor(uniforms: GlowUniforms) {
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.geo.setAttribute("uv", quad.getAttribute("uv"));
    this.ensure(16);
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: uniforms.uTime,
          uMotion: uniforms.uMotion,
          uFogNear: uniforms.uFogNear,
          uFogFar: uniforms.uFogFar,
          uFogColor: uniforms.uFogColor,
          uGain: this.uGain,
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        // Premultiplied "over": the core occludes what is behind it instead of adding to it.
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.geo.instanceCount = 0;
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return;
    this.capacity = Math.max(16, Math.ceil(n * 1.5));
    this.aDisc = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aMix = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.geo.setAttribute("aDisc", this.aDisc);
    this.geo.setAttribute("aTint", this.aTint);
    this.geo.setAttribute("aMix", this.aMix);
  }

  setItems(items: SuperNodeItem[]): void {
    this.ensure(items.length);
    const d = this.aDisc.array as Float32Array;
    const t = this.aTint.array as Float32Array;
    const m = this.aMix.array as Float32Array;
    items.forEach((it, i) => {
      d[i * 4] = it.x;
      d[i * 4 + 1] = it.y;
      d[i * 4 + 2] = it.z;
      d[i * 4 + 3] = it.radius;
      t[i * 4] = it.color.r;
      t[i * 4 + 1] = it.color.g;
      t[i * 4 + 2] = it.color.b;
      t[i * 4 + 3] = it.emphasis;
      m[i * 4] = it.mix[0];
      m[i * 4 + 1] = it.mix[1];
      m[i * 4 + 2] = it.mix[2];
      m[i * 4 + 3] = it.mix[3];
    });
    this.aDisc.needsUpdate = true;
    this.aTint.needsUpdate = true;
    this.aMix.needsUpdate = true;
    this.geo.instanceCount = items.length;
  }

  /** Per-item emphasis only (cheap LOD fades). */
  setEmphasis(i: number, e: number): void {
    (this.aTint.array as Float32Array)[i * 4 + 3] = e;
    this.aTint.needsUpdate = true;
  }

  setGain(g: number): void {
    this.uGain.value = g;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
