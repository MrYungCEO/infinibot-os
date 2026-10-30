/**
 * glow3d lobe volumes — soft translucent ellipsoids (one per brain lobe or
 * any region) drawn in ONE instanced draw. A fresnel rim makes each volume
 * read as a tinted glass shell, a faint fill keeps the interior hazy, and a
 * slow gyri pattern (folds) on the rim sells the "brain" read without
 * hiding the nodes inside.
 */

import * as THREE from "three";
import { FOG_GLSL, type GlowUniforms } from "./scene";

export interface LobeItem {
  /** Centre (world). */
  x: number;
  y: number;
  z: number;
  /** Ellipsoid radii (world). */
  rx: number;
  ry: number;
  rz: number;
  color: THREE.Color;
  /** 0..1 — the hovered/focused lobe glows brighter. */
  emphasis: number;
}

const VERT = /* glsl */ `
  attribute vec3 aCenter; attribute vec3 aRadii; attribute vec4 aTint;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec3 vN; varying vec3 vView; varying vec3 vObj; varying vec4 vTint; varying float vFog;
  void main() {
    vec3 wp = aCenter + position * aRadii;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    vN = normalize(mat3(viewMatrix) * normalize(position / aRadii));
    vView = normalize(-mv.xyz);
    vObj = position;
    vTint = aTint;
    vFog = fogFactor(mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime; uniform float uMotion;
  varying vec3 vN; varying vec3 vView; varying vec3 vObj; varying vec4 vTint; varying float vFog;
  void main() {
    float facing = abs(dot(normalize(vN), normalize(vView)));
    float rim = pow(1.0 - facing, 2.0);
    // Gyri: wavy folds across the surface, strongest toward the rim.
    float g = sin(vObj.x * 9.0 + sin(vObj.y * 6.5 + uTime * 0.15 * uMotion) * 1.8 + vObj.z * 7.0);
    float folds = smoothstep(0.86, 1.0, g) * (0.25 + 0.75 * rim);
    float emph = mix(0.38, 1.0, vTint.a);
    float a = (0.045 + rim * 0.62 + folds * 0.14) * emph * (1.0 - vFog);
    gl_FragColor = vec4(vTint.rgb * a, a);
  }
`;

export class LobeVolumes {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private capacity = 0;
  private aCenter!: THREE.InstancedBufferAttribute;
  private aRadii!: THREE.InstancedBufferAttribute;
  private aTint!: THREE.InstancedBufferAttribute;

  constructor(uniforms: GlowUniforms, opts: { detail?: number } = {}) {
    const sphere = new THREE.IcosahedronGeometry(1, opts.detail ?? 4);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = sphere.index;
    this.geo.setAttribute("position", sphere.getAttribute("position"));
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
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.geo.instanceCount = 0;
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return;
    this.capacity = Math.max(16, Math.ceil(n * 1.5));
    this.aCenter = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.aRadii = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.geo.setAttribute("aCenter", this.aCenter);
    this.geo.setAttribute("aRadii", this.aRadii);
    this.geo.setAttribute("aTint", this.aTint);
  }

  setItems(items: LobeItem[]): void {
    this.ensure(items.length);
    const c = this.aCenter.array as Float32Array;
    const r = this.aRadii.array as Float32Array;
    const t = this.aTint.array as Float32Array;
    items.forEach((it, i) => {
      c[i * 3] = it.x;
      c[i * 3 + 1] = it.y;
      c[i * 3 + 2] = it.z;
      r[i * 3] = it.rx;
      r[i * 3 + 1] = it.ry;
      r[i * 3 + 2] = it.rz;
      t[i * 4] = it.color.r;
      t[i * 4 + 1] = it.color.g;
      t[i * 4 + 2] = it.color.b;
      t[i * 4 + 3] = it.emphasis;
    });
    this.aCenter.needsUpdate = true;
    this.aRadii.needsUpdate = true;
    this.aTint.needsUpdate = true;
    this.geo.instanceCount = items.length;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
