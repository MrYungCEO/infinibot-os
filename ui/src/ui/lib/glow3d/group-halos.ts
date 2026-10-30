/**
 * glow3d group halos — soft luminous camera-facing glows around each cluster
 * (a project and its satellites, a status band, a type sector…), centred at
 * the cluster's own height so they read as spheres in a 3D layout. One
 * instanced draw for every group: a faint fill, a crisp rim, and a slowly
 * rotating graduated bezel so groups read as "zones" without hiding nodes.
 */

import * as THREE from "three";
import { FOG_GLSL, type GlowUniforms } from "./scene";

export interface HaloItem {
  x: number;
  y: number;
  z: number;
  radius: number;
  color: THREE.Color;
  /** 0..1 — dims halos outside the focused group. */
  emphasis: number;
}

const VERT = /* glsl */ `
  attribute vec4 aDisc; // x, y, z, radius
  attribute vec4 aTint; // rgb, emphasis
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec2 vUv; varying vec4 vTint; varying float vFog; varying float vR;
  void main() {
    // Billboard: always faces the camera, like the silhouette of a sphere.
    vec4 mv = viewMatrix * vec4(aDisc.xyz, 1.0);
    mv.xy += position.xy * aDisc.w;
    vUv = uv; vTint = aTint; vFog = fogFactor(mv.z); vR = aDisc.w;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime; uniform float uMotion; uniform float uStrength;
  varying vec2 vUv; varying vec4 vTint; varying float vFog; varying float vR;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    if (d > 1.0) discard;
    float px = 1.5 / max(vR, 1.0); // ~1.5 world units of anti-alias
    // Luminous zone: a soft filled disc (brightest toward the centre) with a
    // fine rim — reads as a place, not a wire.
    float fill = (smoothstep(1.0, 0.0, d) * 0.12 + smoothstep(0.98, 0.7, d) * 0.06) * uStrength;
    float rim = smoothstep(px * 2.0, 0.0, abs(d - 0.97)) * 0.42 * min(1.6, uStrength);
    float inner = smoothstep(px * 1.5, 0.0, abs(d - 0.9)) * 0.18;
    float ang = atan(p.y, p.x) / 6.2831853 + 0.5;
    float ticks = step(0.8, fract(ang * 72.0 + uTime * 0.01 * uMotion)) * smoothstep(px * 6.0, 0.0, abs(d - 0.935)) * 0.35;
    float sweep = pow(fract(ang - uTime * 0.04 * uMotion), 14.0) * smoothstep(0.98, 0.6, d) * 0.12;
    float a = (fill + rim + inner + ticks + sweep) * mix(0.25, 1.0, vTint.a) * (1.0 - vFog);
    gl_FragColor = vec4(vTint.rgb * a, a);
  }
`;

export class GroupHalos {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private capacity = 0;
  private aDisc!: THREE.InstancedBufferAttribute;
  private aTint!: THREE.InstancedBufferAttribute;
  private readonly uStrength = { value: 1 };

  constructor(uniforms: GlowUniforms) {
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.geo.setAttribute("uv", quad.getAttribute("uv"));
    this.ensure(32);
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: uniforms.uTime,
          uMotion: uniforms.uMotion,
          uFogNear: uniforms.uFogNear,
          uFogFar: uniforms.uFogFar,
          uFogColor: uniforms.uFogColor,
          uStrength: this.uStrength,
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
    this.mesh.renderOrder = 5;
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return;
    this.capacity = Math.max(32, Math.ceil(n * 1.5));
    this.aDisc = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.aDisc.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aDisc", this.aDisc);
    this.geo.setAttribute("aTint", this.aTint);
  }

  /** Tint strength of the zone fill + rim (1 = original). */
  setStrength(s: number): void {
    this.uStrength.value = Math.max(0, Math.min(2.5, s));
  }

  setItems(items: HaloItem[]): void {
    this.ensure(items.length);
    const d = this.aDisc.array as Float32Array;
    const t = this.aTint.array as Float32Array;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      d[i * 4] = it.x;
      d[i * 4 + 1] = it.y;
      d[i * 4 + 2] = it.z;
      d[i * 4 + 3] = it.radius;
      t[i * 4] = it.color.r;
      t[i * 4 + 1] = it.color.g;
      t[i * 4 + 2] = it.color.b;
      t[i * 4 + 3] = it.emphasis;
    }
    this.aDisc.needsUpdate = true;
    this.aTint.needsUpdate = true;
    this.geo.instanceCount = items.length;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
