/**
 * glow3d nodes — thousands of emissive nodes in a handful of instanced draws:
 *
 *   • `meshes` — one InstancedMesh per SHAPE (orb, gem, pages, agent…; see
 *                node-shapes.ts) with a fresnel rim so each node reads as a
 *                lit, faceted object, bright enough for bloom to catch.
 *                Far-away nodes collapse (LOD) and leave only their halo, a
 *                type-tinted glowing point.
 *   • `halo`  — InstancedMesh of camera-facing quads behind each orb giving
 *                a soft additive corona (the "glow" even without bloom).
 *
 * Per-instance state lives in attributes: colour (`instanceColor`),
 * emphasis 0..1 (dims the rest when a neighbourhood is focused), a phase for
 * the idle bob/pulse, and a live flag that makes the halo breathe. Positions
 * are plain `instanceMatrix` updates; the bob is done in the shader so a
 * 5k-node idle animation costs nothing on the CPU.
 */

import * as THREE from "three";
import { shapeGeometry } from "./node-shapes";
import { FOG_GLSL, type GlowUniforms } from "./scene";

export interface GlowNodesOptions {
  capacity: number;
  /** Sphere tessellation (width/height segments). Lower on mobile. */
  detail?: [number, number];
  /** Halo quad size as a multiple of the node radius. */
  haloScale?: number;
  /** Idle bob amplitude in world units (0 disables). */
  bob?: number;
}

const NODE_VERT = /* glsl */ `
  attribute float aEmphasis; attribute float aPhase; attribute float aLive;
  uniform float uTime; uniform float uBob; uniform float uMotion; uniform float uPxPerUnit;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec3 vColor; varying float vEmph; varying vec3 vNormal; varying vec3 vViewDir; varying float vFog; varying float vLive;
  void main() {
    // LOD: below ~2.2 px radius the shape is unreadable — collapse it and let
    // the halo (a type-tinted glow point) stand in.
    vec4 c0 = viewMatrix * modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float px = length(instanceMatrix[0].xyz) * uPxPerUnit / max(1.0, -c0.z);
    float keep = step(2.2, px);
    vec4 wp = modelMatrix * instanceMatrix * vec4(position * keep, 1.0);
    wp.y += sin(uTime * 0.9 + aPhase) * uBob * uMotion;
    vec4 mv = viewMatrix * wp;
    vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vViewDir = normalize(-mv.xyz);
    vColor = instanceColor;
    vEmph = aEmphasis;
    vLive = aLive;
    vFog = fogFactor(mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const NODE_FRAG = /* glsl */ `
  uniform float uTime; uniform vec3 uFogColor;
  varying vec3 vColor; varying float vEmph; varying vec3 vNormal; varying vec3 vViewDir; varying float vFog; varying float vLive;
  void main() {
    vec3 n = normalize(vNormal);
    float ndv = max(dot(n, vViewDir), 0.0);
    float fres = pow(1.0 - ndv, 2.4);
    vec3 key = normalize(vec3(0.35, 0.75, 0.55));
    float diff = 0.35 + 0.65 * max(dot(n, key), 0.0);
    // Lit orb: shaded base, bright rim in its own colour, hot white rim tip.
    vec3 col = vColor * diff * 1.0 + vColor * fres * 1.7 + vec3(1.0) * fres * 0.18;
    // Glossy highlight toward the key light.
    vec3 h = normalize(key + vViewDir);
    col += vec3(1.0, 0.98, 0.9) * pow(max(dot(n, h), 0.0), 48.0) * 0.35;
    float pulse = 1.0 + vLive * 0.35 * (0.5 + 0.5 * sin(uTime * 3.2));
    col *= mix(0.16, 1.12, vEmph) * pulse;
    col = mix(col, uFogColor, vFog * 0.9);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const HALO_VERT = /* glsl */ `
  attribute float aEmphasis; attribute float aPhase; attribute float aLive;
  uniform float uTime; uniform float uBob; uniform float uMotion; uniform float uHaloScale; uniform float uPxPerUnit;
  ${FOG_GLSL.uniforms}
  ${FOG_GLSL.factor}
  varying vec3 vColor; varying float vEmph; varying vec2 vUv; varying float vFog; varying float vLive; varying float vPhase;
  void main() {
    vec4 centre = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    centre.y += sin(uTime * 0.9 + aPhase) * uBob * uMotion;
    vec4 mv = viewMatrix * centre;
    float s = length(instanceMatrix[0].xyz);
    float breathe = 1.0 + aLive * 0.25 * (0.5 + 0.5 * sin(uTime * 3.2 + aPhase)) * uMotion;
    // Collapsed (LOD) nodes keep a slightly larger glow point so they stay visible.
    float px = s * uPxPerUnit / max(1.0, -mv.z);
    float lod = px < 2.2 ? 1.6 : 1.0;
    // Big hubs: the glow grows slowly past r=18 so a large node never floods the view.
    float hs = s < 18.0 ? s * uHaloScale : 18.0 * uHaloScale + (s - 18.0) * 1.3;
    mv.xy += position.xy * hs * breathe * lod;
    vColor = instanceColor;
    vEmph = aEmphasis;
    vUv = uv;
    vLive = aLive;
    vPhase = aPhase;
    vFog = fogFactor(mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const HALO_FRAG = /* glsl */ `
  uniform float uTime; uniform vec3 uFogColor; uniform float uHaloGain;
  varying vec3 vColor; varying float vEmph; varying vec2 vUv; varying float vFog; varying float vLive; varying float vPhase;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    if (d > 1.0) discard;
    float a = pow(1.0 - d, 2.6);
    // Thin bright ring near the orb edge gives a "contained energy" look.
    a += 0.35 * exp(-pow((d - 0.32) * 9.0, 2.0));
    a *= mix(0.05, 1.0, vEmph) * (1.0 - vFog) * uHaloGain;
    vec3 col = vColor * a * 0.9;
    gl_FragColor = vec4(col, a);
  }
`;

/** One shape's instanced mesh and its per-instance attributes. */
interface Bucket {
  mesh: THREE.InstancedMesh;
  emphasis: THREE.InstancedBufferAttribute;
  phase: THREE.InstancedBufferAttribute;
  live: THREE.InstancedBufferAttribute;
  /** Node index per slot. */
  nodes: number[];
}

export class GlowNodes {
  readonly group = new THREE.Group();
  readonly halo: THREE.InstancedMesh;
  readonly capacity: number;
  private count = 0;
  private readonly haloEmphasis: THREE.InstancedBufferAttribute;
  private readonly haloPhase: THREE.InstancedBufferAttribute;
  private readonly haloLive: THREE.InstancedBufferAttribute;
  private readonly buckets = new Map<number, Bucket>();
  /** Per node: shape id and slot inside that shape's bucket (-1 = none). */
  private readonly shapeOf: Int16Array;
  private readonly slotOf: Int32Array;
  private readonly m = new THREE.Matrix4();
  private readonly scaleOf: Float32Array;
  private readonly posOf: Float32Array;
  private readonly uBob: THREE.IUniform<number>;
  /** Halo intensity (lowered for dense graphs so additive coronas don't blow out). */
  private readonly uHaloGain: THREE.IUniform<number> = { value: 1 };
  /** Screen px per world unit at distance 1 (LOD); set from the camera via `setPxPerUnit`. */
  private readonly uPxPerUnit: THREE.IUniform<number> = { value: 1000 };
  private readonly nodeMat: THREE.ShaderMaterial;
  private readonly detail: [number, number];

  constructor(uniforms: GlowUniforms, opts: GlowNodesOptions) {
    this.capacity = Math.max(1, opts.capacity);
    this.detail = opts.detail ?? [14, 10];
    const quad = new THREE.PlaneGeometry(2, 2);
    this.haloEmphasis = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity).fill(1), 1);
    this.haloPhase = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.haloLive = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.haloEmphasis.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute("aEmphasis", this.haloEmphasis);
    quad.setAttribute("aPhase", this.haloPhase);
    quad.setAttribute("aLive", this.haloLive);
    this.uBob = { value: opts.bob ?? 2.2 };
    const shared = {
      uTime: uniforms.uTime,
      uMotion: uniforms.uMotion,
      uFogNear: uniforms.uFogNear,
      uFogFar: uniforms.uFogFar,
      uFogColor: uniforms.uFogColor,
      uBob: this.uBob,
      uPxPerUnit: this.uPxPerUnit,
    };
    this.nodeMat = new THREE.ShaderMaterial({
      uniforms: { ...shared },
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      side: THREE.DoubleSide,
    });
    const haloMat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uHaloScale: { value: opts.haloScale ?? 3.1 }, uHaloGain: this.uHaloGain },
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.halo = new THREE.InstancedMesh(quad, haloMat, this.capacity);
    this.halo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.halo.setColorAt(0, new THREE.Color(1, 1, 1));
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 10;
    this.scaleOf = new Float32Array(this.capacity).fill(1);
    this.posOf = new Float32Array(this.capacity * 3);
    this.shapeOf = new Int16Array(this.capacity).fill(-1);
    this.slotOf = new Int32Array(this.capacity).fill(-1);
    this.group.add(this.halo);
    this.setCount(0);
  }

  get length(): number {
    return this.count;
  }

  private bucket(shape: number): Bucket {
    let b = this.buckets.get(shape);
    if (b) return b;
    const geo = shapeGeometry(shape, this.detail);
    const emphasis = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity).fill(1), 1);
    const phase = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    const live = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    emphasis.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aEmphasis", emphasis);
    geo.setAttribute("aPhase", phase);
    geo.setAttribute("aLive", live);
    const mesh = new THREE.InstancedMesh(geo, this.nodeMat, this.capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // enables USE_INSTANCING_COLOR
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    mesh.count = 0;
    b = { mesh, emphasis, phase, live, nodes: [] };
    this.buckets.set(shape, b);
    this.group.add(mesh);
    return b;
  }

  /** Node count; shapes are (re)assigned by the following `setStyle` calls. */
  setCount(n: number): void {
    this.count = Math.min(this.capacity, Math.max(0, n));
    this.halo.count = this.count;
    for (const b of this.buckets.values()) {
      b.nodes.length = 0;
      b.mesh.count = 0;
    }
    this.shapeOf.fill(-1);
    this.slotOf.fill(-1);
  }

  /** Move node i into the bucket for `shape` (swap-remove from its old one). */
  private assign(i: number, shape: number): Bucket {
    const cur = this.shapeOf[i];
    if (cur === shape && this.slotOf[i] >= 0) return this.buckets.get(shape)!;
    if (cur >= 0) {
      const ob = this.buckets.get(cur)!;
      const slot = this.slotOf[i];
      const last = ob.nodes.length - 1;
      if (slot !== last) {
        const moved = ob.nodes[last];
        ob.nodes[slot] = moved;
        this.slotOf[moved] = slot;
        this.copySlot(ob, last, slot);
      }
      ob.nodes.pop();
      ob.mesh.count = ob.nodes.length;
    }
    const b = this.bucket(shape);
    this.shapeOf[i] = shape;
    this.slotOf[i] = b.nodes.length;
    b.nodes.push(i);
    b.mesh.count = b.nodes.length;
    return b;
  }

  private copySlot(b: Bucket, from: number, to: number): void {
    b.mesh.getMatrixAt(from, this.m);
    b.mesh.setMatrixAt(to, this.m);
    if (b.mesh.instanceColor) {
      const c = new THREE.Color();
      b.mesh.getColorAt(from, c);
      b.mesh.setColorAt(to, c);
      b.mesh.instanceColor.needsUpdate = true;
    }
    b.emphasis.setX(to, b.emphasis.getX(from));
    b.phase.setX(to, b.phase.getX(from));
    b.live.setX(to, b.live.getX(from));
    b.mesh.instanceMatrix.needsUpdate = true;
    b.emphasis.needsUpdate = b.phase.needsUpdate = b.live.needsUpdate = true;
  }

  /** Set the static look of instance `i`. Call `commitStyle()` afterwards. */
  setStyle(i: number, color: THREE.Color, radius: number, phase: number, live: boolean, shape = 0): void {
    const b = this.assign(i, shape);
    const slot = this.slotOf[i];
    b.mesh.setColorAt(slot, color);
    this.halo.setColorAt(i, color);
    this.scaleOf[i] = radius;
    b.phase.setX(slot, phase);
    b.live.setX(slot, live ? 1 : 0);
    this.haloPhase.setX(i, phase);
    this.haloLive.setX(i, live ? 1 : 0);
  }

  commitStyle(): void {
    for (const b of this.buckets.values()) {
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      b.phase.needsUpdate = true;
      b.live.needsUpdate = true;
    }
    if (this.halo.instanceColor) this.halo.instanceColor.needsUpdate = true;
    this.haloPhase.needsUpdate = true;
    this.haloLive.needsUpdate = true;
  }

  /** Move instance `i`; `scale` multiplies its base radius (hover grow). */
  setPosition(i: number, x: number, y: number, z: number, scale = 1): void {
    this.posOf[i * 3] = x;
    this.posOf[i * 3 + 1] = y;
    this.posOf[i * 3 + 2] = z;
    const s = this.scaleOf[i] * scale;
    this.m.makeScale(s, s, s);
    this.m.setPosition(x, y, z);
    this.halo.setMatrixAt(i, this.m);
    const sh = this.shapeOf[i];
    if (sh >= 0) this.buckets.get(sh)!.mesh.setMatrixAt(this.slotOf[i], this.m);
  }

  /** Re-apply a scale to an already positioned instance (hover spring). */
  setScale(i: number, scale: number): void {
    this.setPosition(i, this.posOf[i * 3], this.posOf[i * 3 + 1], this.posOf[i * 3 + 2], scale);
  }

  commitPositions(): void {
    for (const b of this.buckets.values()) b.mesh.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
  }

  setEmphasis(i: number, e: number): void {
    this.haloEmphasis.setX(i, e);
    const sh = this.shapeOf[i];
    if (sh >= 0) this.buckets.get(sh)!.emphasis.setX(this.slotOf[i], e);
  }

  getEmphasis(i: number): number {
    return this.haloEmphasis.getX(i);
  }

  commitEmphasis(): void {
    this.haloEmphasis.needsUpdate = true;
    for (const b of this.buckets.values()) b.emphasis.needsUpdate = true;
  }

  setHaloGain(g: number): void {
    this.uHaloGain.value = g;
  }

  setBob(amp: number): void {
    this.uBob.value = amp;
  }

  /** LOD reference: viewport height / (2·tan(fov/2)) in px. */
  setPxPerUnit(v: number): void {
    this.uPxPerUnit.value = v;
  }

  dispose(): void {
    for (const b of this.buckets.values()) {
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.nodeMat.dispose();
    this.halo.geometry.dispose();
    (this.halo.material as THREE.Material).dispose();
    this.halo.dispose();
  }
}
