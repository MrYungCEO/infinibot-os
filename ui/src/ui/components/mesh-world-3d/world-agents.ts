/**
 * Agent avatars for the 3D Agent Mesh — stylised articulated characters,
 * fully instanced.
 *
 * Every avatar is assembled from parts (legs, torso, arms, head, visor, chest
 * badge) that live in one InstancedMesh each, so 100 agents are still ~8 draw
 * calls. Two head styles: a rounded helmet with a wrap-around visor for
 * session agents, a boxy screen-faced bot (with antenna) for coder runs.
 *
 * Poses are plain numbers (`AvatarPose`) produced per activity by `poseFor`
 * (idle breathe, walk cycle, seated typing, hand-to-chin thinking, talking
 * gestures, error slump, lying on a rest pod, celebrate hop); the rig turns a
 * root matrix + pose into part matrices. Hover / selection draws the same
 * parts again through an inverted-hull outline material (two instances at
 * most).
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AgentActivity } from "../../views/agent-ops/mesh-world-model";
import { rbox } from "./world-geometry";

export interface AvatarPose {
  hipY: number;
  legL: number;
  legR: number;
  armL: number;
  armR: number;
  rollL: number;
  rollR: number;
  torsoPitch: number;
  breathe: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
  /** Extra vertical offset of the whole body (bob / hop). */
  bob: number;
}

export const HIP_Y = 0.42;
const SEAT_HIP_Y = 0.5;
/** Avatar height (feet → top of head) before per-agent scale. */
export const AVATAR_HEIGHT = 1.52;

export function restPose(): AvatarPose {
  return { hipY: HIP_Y, legL: 0, legR: 0, armL: 0, armR: 0, rollL: 0.1, rollR: 0.1, torsoPitch: 0, breathe: 1, headYaw: 0, headPitch: 0, headRoll: 0, bob: 0 };
}

export interface PoseInput {
  activity: AgentActivity;
  walking: boolean;
  seated: boolean;
  lying: boolean;
  /** Seconds (already offset by the agent's phase). */
  t: number;
  /** 0..1 strength of the success celebration (decays). */
  celebrate: number;
  motion: boolean;
  /** Seated hip height in the avatar's local units (chair seat / scale). */
  seatHip?: number;
}

/** Pose for an activity — the same states the 2D map animates. */
export function poseFor(inp: PoseInput, out: AvatarPose = restPose()): AvatarPose {
  const p = Object.assign(out, restPose());
  const { t } = inp;
  const m = inp.motion ? 1 : 0;
  p.breathe = 1 + 0.025 * Math.sin(t * 1.8) * m;
  if (inp.lying) {
    p.breathe = 1 + 0.03 * Math.sin(t * 0.9) * m;
    p.rollL = p.rollR = 0.05;
    return p;
  }
  if (inp.walking) {
    const s = Math.sin(t * 9) * m;
    p.legL = s * 0.65;
    p.legR = -s * 0.65;
    p.armL = -s * 0.55;
    p.armR = s * 0.55;
    p.bob = Math.abs(Math.sin(t * 9)) * 0.06 * m;
    p.torsoPitch = 0.08;
    return p;
  }
  if (inp.seated) {
    p.hipY = inp.seatHip ?? SEAT_HIP_Y;
    p.legL = p.legR = -1.45;
  }
  switch (inp.activity) {
    case "type": {
      const k = Math.sin(t * 15) * m;
      p.armL = -1.2 + k * 0.09;
      p.armR = -1.2 - k * 0.09;
      p.rollL = p.rollR = -0.06;
      p.torsoPitch = 0.12;
      p.headPitch = 0.2 + Math.sin(t * 1.3) * 0.04 * m;
      p.headYaw = Math.sin(t * 0.7) * 0.12 * m;
      break;
    }
    case "think": {
      p.armR = -2.15;
      p.rollR = -0.55;
      p.armL = -0.55;
      p.rollL = -0.5;
      p.headRoll = 0.16;
      p.headPitch = -0.16 + Math.sin(t * 0.8) * 0.05 * m;
      p.headYaw = Math.sin(t * 0.45) * 0.3 * m;
      break;
    }
    case "talk": {
      p.armL = -0.65 - Math.max(0, Math.sin(t * 3.2)) * 0.45 * m;
      p.rollL = 0.3;
      p.armR = -0.3 + Math.sin(t * 2.1 + 1) * 0.25 * m;
      p.rollR = 0.2;
      p.headPitch = Math.sin(t * 6) * 0.07 * m;
      p.headYaw = Math.sin(t * 0.9) * 0.25 * m;
      break;
    }
    case "wait": {
      p.armL = p.armR = -0.25;
      p.rollL = p.rollR = 0.75; // hands on hips
      if (!inp.seated) p.legR = -Math.max(0, Math.sin(t * 6)) * 0.28 * m; // foot tap
      p.headRoll = Math.sin(t * 0.8) * 0.16 * m;
      p.headYaw = Math.sin(t * 0.35) * 0.4 * m;
      break;
    }
    case "error": {
      p.torsoPitch = 0.38;
      p.headPitch = 0.5;
      p.armL = p.armR = 0.12;
      p.rollL = p.rollR = 0.04;
      p.breathe = 1 + 0.012 * Math.sin(t * 1.1) * m;
      break;
    }
    default: {
      // idle / rest-standing: breathe + look around.
      p.headYaw = Math.sin(t * 0.5) * 0.35 * m;
      p.armL = Math.sin(t * 1.8) * 0.05 * m;
      p.armR = -p.armL;
    }
  }
  if (inp.celebrate > 0 && inp.motion) {
    const c = inp.celebrate;
    const w = Math.sin(t * 11) * 0.22;
    p.armL = THREE.MathUtils.lerp(p.armL, -2.9 + w, c);
    p.armR = THREE.MathUtils.lerp(p.armR, -2.9 - w, c);
    p.rollL = THREE.MathUtils.lerp(p.rollL, 0.35, c);
    p.rollR = THREE.MathUtils.lerp(p.rollR, 0.35, c);
    p.headPitch = THREE.MathUtils.lerp(p.headPitch, -0.3, c);
    if (!inp.seated) p.bob += Math.abs(Math.sin(t * 7)) * 0.28 * c;
  }
  return p;
}

// ── Geometry ─────────────────────────────────────────────────────────────

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    for (const a of ["uv", "uv1"]) if (n.getAttribute(a)) n.deleteAttribute(a);
    return n;
  });
  const out = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}

const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s?: [number, number, number]) => {
  if (s) g.scale(s[0], s[1], s[2]);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
};

/** Part geometries, each modelled around its own pivot. */
export function avatarGeometries() {
  return {
    // Pivot: hip joint. Leg + boot.
    leg: merge([
      at(new THREE.CapsuleGeometry(0.085, 0.22, 3, 8), 0, -0.17, 0),
      at(rbox(0.15, 0.09, 0.24, 0.04), 0, -0.375, 0.04),
    ]),
    // Pivot: hips. Pelvis + chest + shoulder yoke.
    torso: merge([
      at(rbox(0.34, 0.15, 0.25, 0.06), 0, 0.06, 0),
      at(rbox(0.44, 0.38, 0.3, 0.12, 2), 0, 0.33, 0),
      at(new THREE.CapsuleGeometry(0.075, 0.38, 3, 8), 0, 0.5, 0, 0, 0, Math.PI / 2),
    ]),
    // Pivot: shoulder. Upper arm + mitt hand.
    arm: merge([
      at(new THREE.CapsuleGeometry(0.068, 0.2, 3, 8), 0, -0.16, 0),
      at(new THREE.SphereGeometry(0.085, 10, 8), 0, -0.34, 0.01),
    ]),
    // Pivot: neck. Session helmet: round shell + ear pods + neck.
    headSession: merge([
      at(new THREE.SphereGeometry(0.27, 20, 14), 0, 0.27, 0, 0, 0, 0, [1, 0.95, 0.98]),
      at(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 14), -0.27, 0.27, 0, 0, 0, Math.PI / 2),
      at(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 14), 0.27, 0.27, 0, 0, 0, Math.PI / 2),
      at(new THREE.CylinderGeometry(0.08, 0.1, 0.08, 12), 0, 0.02, 0),
    ]),
    // Pivot: neck. Coder bot: boxy head, antenna.
    headBot: merge([
      at(rbox(0.5, 0.4, 0.44, 0.1, 2), 0, 0.25, 0),
      at(new THREE.CylinderGeometry(0.015, 0.015, 0.2, 6), 0.1, 0.53, 0),
      at(new THREE.CylinderGeometry(0.08, 0.1, 0.08, 12), 0, 0.02, 0),
      at(rbox(0.07, 0.16, 0.16, 0.03), -0.26, 0.25, 0),
      at(rbox(0.07, 0.16, 0.16, 0.03), 0.26, 0.25, 0),
    ]),
    // Visors (emissive) in the head's pivot space.
    visorSession: merge([
      at(new THREE.SphereGeometry(0.278, 28, 6, Math.PI / 2 - 1.05, 2.1, Math.PI * 0.42, Math.PI * 0.2), 0, 0.27, 0, 0, Math.PI, 0, [1, 0.95, 0.98]),
    ]),
    visorBot: merge([
      at(rbox(0.38, 0.17, 0.03, 0.015), 0, 0.27, 0.215),
      at(new THREE.SphereGeometry(0.045, 10, 8), 0.1, 0.66, 0),
    ]),
    // Chest badge + belt light (torso pivot space).
    badge: merge([
      at(new THREE.CylinderGeometry(0.055, 0.055, 0.02, 16), 0, 0.36, 0.155, Math.PI / 2),
      at(new THREE.BoxGeometry(0.3, 0.025, 0.02), 0, 0.13, 0.128),
    ]),
    // Picking volume (feet at 0).
    hit: at(new THREE.BoxGeometry(0.85, 1.6, 0.8), 0, 0.8, 0),
  };
}

type PartName = "leg" | "torso" | "arm" | "headSession" | "headBot" | "visorSession" | "visorBot" | "badge";
const PARTS: PartName[] = ["leg", "torso", "arm", "headSession", "headBot", "visorSession", "visorBot", "badge"];
const PER_AGENT: Record<PartName, number> = { leg: 2, torso: 1, arm: 2, headSession: 1, headBot: 1, visorSession: 1, visorBot: 1, badge: 1 };
const GLOW_PARTS = new Set<PartName>(["visorSession", "visorBot", "badge"]);

export interface AvatarColors {
  body: THREE.Color;
  limb: THREE.Color;
  shell: THREE.Color;
  visor: THREE.Color;
  badge: THREE.Color;
}

/** Instanced avatar renderer (+ outline pass for hover / selection). */
export class AvatarRig {
  readonly group = new THREE.Group();
  readonly hit: THREE.InstancedMesh;
  private readonly geos: ReturnType<typeof avatarGeometries>;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly outlineMat: THREE.MeshBasicMaterial;
  private meshes!: Record<PartName, THREE.InstancedMesh>;
  private outlines!: Record<PartName, THREE.InstancedMesh>;
  private counts = {} as Record<PartName, number>;
  private oCounts = {} as Record<PartName, number>;
  private hitN = 0;
  private cap = 0;
  private readonly oCap = 4;
  /** hit instance → agent key */
  readonly hitKeys: string[] = [];

  private readonly mRoot = new THREE.Matrix4();
  private readonly mTorso = new THREE.Matrix4();
  private readonly mPart = new THREE.Matrix4();
  private readonly mL = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(capacity: number, private shadows: boolean) {
    this.geos = avatarGeometries();
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.22 });
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.outlineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide, toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false });
    this.outlineMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\ntransformed += normalize(normal) * 0.035;",
      );
    };
    this.outlineMat.customProgramCacheKey = () => "mesh3d-outline-v1";
    this.hit = new THREE.InstancedMesh(this.geos.hit, new THREE.MeshBasicMaterial({ visible: false }), capacity);
    this.hit.count = 0;
    this.alloc(capacity);
    this.group.add(this.hit);
  }

  private alloc(cap: number): void {
    this.cap = cap;
    const mk = (part: PartName, n: number, outline: boolean) => {
      const mat = outline ? this.outlineMat : GLOW_PARTS.has(part) ? this.glowMat : this.bodyMat;
      const m = new THREE.InstancedMesh(this.geos[part], mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color());
      m.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = !outline && !GLOW_PARTS.has(part) && this.shadows;
      if (outline) m.renderOrder = 4;
      this.group.add(m);
      return m;
    };
    this.meshes = {} as Record<PartName, THREE.InstancedMesh>;
    this.outlines = {} as Record<PartName, THREE.InstancedMesh>;
    for (const p of PARTS) {
      this.meshes[p] = mk(p, cap * PER_AGENT[p], false);
      this.outlines[p] = mk(p, this.oCap * PER_AGENT[p], true);
    }
  }

  get capacity(): number {
    return this.cap;
  }

  ensureCapacity(need: number): void {
    if (need <= this.cap) return;
    let cap = this.cap;
    while (cap < need) cap *= 2;
    for (const p of PARTS) {
      for (const m of [this.meshes[p], this.outlines[p]]) {
        this.group.remove(m);
        m.dispose();
      }
    }
    this.alloc(cap);
    this.group.remove(this.hit);
    const hit = new THREE.InstancedMesh(this.geos.hit, this.hit.material, cap);
    hit.count = 0;
    this.hit.dispose();
    (this as { hit: THREE.InstancedMesh }).hit = hit;
    this.group.add(hit);
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const p of PARTS) this.meshes[p].castShadow = on && !GLOW_PARTS.has(p);
  }

  begin(): void {
    for (const p of PARTS) {
      this.counts[p] = 0;
      this.oCounts[p] = 0;
    }
    this.hitN = 0;
    this.hitKeys.length = 0;
  }

  private put(part: PartName, m: THREE.Matrix4, color: THREE.Color, outline: THREE.Color | null): void {
    const mesh = this.meshes[part];
    const i = this.counts[part]++;
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, color);
    if (outline) {
      const om = this.outlines[part];
      const j = this.oCounts[part];
      if (j < this.oCap * PER_AGENT[part]) {
        om.setMatrixAt(j, m);
        om.setColorAt(j, outline);
        this.oCounts[part]++;
      }
    }
  }

  private local(x: number, y: number, z: number, rx: number, ry: number, rz: number, sy = 1): THREE.Matrix4 {
    this.e.set(rx, ry, rz, "YXZ");
    this.q.setFromEuler(this.e);
    return this.mL.compose(this.v.set(x, y, z), this.q, sy === 1 ? this.one : this.s.set(1, sy, 1));
  }

  /**
   * Write one avatar. `root` places the feet (position, heading, lie roll,
   * scale). `bot` picks the coder head. `outline` (hover / selected) draws the
   * inverted hull in that colour.
   */
  push(key: string, root: THREE.Matrix4, pose: AvatarPose, bot: boolean, c: AvatarColors, outline: THREE.Color | null, hitScale: number, hitPos: THREE.Vector3): void {
    if (this.hitN >= this.cap) return;
    const mr = this.mRoot.copy(root);
    if (pose.bob) mr.multiply(this.local(0, pose.bob, 0, 0, 0, 0));
    // Legs.
    for (const side of [-1, 1]) {
      const a = side < 0 ? pose.legL : pose.legR;
      this.mPart.multiplyMatrices(mr, this.local(side * 0.1, pose.hipY, 0, a, 0, 0));
      this.put("leg", this.mPart, c.limb, outline);
    }
    // Torso (breathing squash on the torso only).
    const mt = this.mTorso.multiplyMatrices(mr, this.local(0, pose.hipY, 0, pose.torsoPitch, 0, 0));
    this.mPart.multiplyMatrices(mt, this.local(0, 0, 0, 0, 0, 0, pose.breathe));
    this.put("torso", this.mPart, c.body, outline);
    this.put("badge", this.mPart, c.badge, null);
    // Arms.
    const sh = 0.48 * pose.breathe;
    for (const side of [-1, 1]) {
      const pitch = side < 0 ? pose.armL : pose.armR;
      const roll = side < 0 ? pose.rollL : pose.rollR;
      this.mPart.multiplyMatrices(mt, this.local(side * 0.29, sh, 0, pitch, 0, -side * roll));
      this.put("arm", this.mPart, c.limb, outline);
    }
    // Head + visor.
    this.mPart.multiplyMatrices(mt, this.local(0, 0.56 * pose.breathe, 0, pose.headPitch, pose.headYaw, pose.headRoll));
    this.put(bot ? "headBot" : "headSession", this.mPart, c.shell, outline);
    this.put(bot ? "visorBot" : "visorSession", this.mPart, c.visor, null);
    // Hit box (upright, unaffected by pose).
    this.mPart.compose(hitPos, this.q.identity(), this.s.setScalar(hitScale));
    this.hit.setMatrixAt(this.hitN, this.mPart);
    this.hitKeys[this.hitN] = key;
    this.hitN++;
  }

  end(boundsDirty: boolean): void {
    for (const p of PARTS) {
      for (const [m, n] of [[this.meshes[p], this.counts[p]], [this.outlines[p], this.oCounts[p]]] as const) {
        m.count = n;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
    this.hit.count = this.hitN;
    this.hit.instanceMatrix.needsUpdate = true;
    if (boundsDirty) this.hit.computeBoundingSphere();
  }

  dispose(): void {
    for (const p of PARTS) {
      this.meshes[p].dispose();
      this.outlines[p].dispose();
    }
    this.hit.dispose();
    for (const g of Object.values(this.geos)) g.dispose();
    this.bodyMat.dispose();
    this.glowMat.dispose();
    this.outlineMat.dispose();
    (this.hit.material as THREE.Material).dispose();
  }
}

// ── Floor status halo (instanced shader quad) ────────────────────────────

/** Halo modes, written per instance. */
export const HALO_MODE: Record<AgentActivity | "walk", number> = { idle: 0, rest: 0, walk: 0, type: 1, think: 1, talk: 1, wait: 2, error: 3 };

export class HaloSet {
  readonly mesh: THREE.InstancedMesh;
  private readonly aMode: THREE.InstancedBufferAttribute;
  private readonly aBoost: THREE.InstancedBufferAttribute;
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  constructor(capacity: number, uTime: THREE.IUniform<number>) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.aMode = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aBoost = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.aMode, this.aBoost]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aMode", this.aMode);
    geo.setAttribute("aBoost", this.aBoost);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: { uTime },
      vertexShader: /* glsl */ `
        attribute float aMode; attribute float aBoost;
        varying vec2 vUv; varying vec3 vCol; varying float vMode; varying float vBoost; varying float vSeed;
        void main() {
          vUv = uv * 2.0 - 1.0; vMode = aMode; vBoost = aBoost;
          vCol = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            vCol = instanceColor;
          #endif
          vSeed = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv; varying vec3 vCol; varying float vMode; varying float vBoost; varying float vSeed;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          float t = uTime + vSeed;
          float pulse = 1.0;
          if (vMode > 2.5) pulse = 0.55 + 0.45 * step(0.0, sin(t * 9.0));
          else if (vMode > 1.5) pulse = 0.7 + 0.3 * sin(t * 2.6);
          float ringR = 0.74;
          float ring = smoothstep(0.075, 0.0, abs(r - ringR));
          float ang = atan(vUv.y, vUv.x);
          float dash = 1.0;
          if (vMode > 0.5 && vMode < 1.5) dash = 0.45 + 0.55 * step(0.0, sin(ang * 6.0 - t * 3.0));
          float fill = smoothstep(ringR, 0.0, r) * 0.1;
          float outer = smoothstep(1.0, ringR, r) * smoothstep(ringR - 0.02, ringR + 0.1, r) * 0.22;
          float a = (ring * dash + fill + outer) * pulse * clamp(0.55 + vBoost * 0.6, 0.15, 1.3);
          gl_FragColor = vec4(vCol * a, a);
        }
      `,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  get capacity(): number {
    return this.aMode.count;
  }

  begin(): void {
    this.n = 0;
  }

  push(x: number, y: number, z: number, size: number, color: THREE.Color, mode: number, boost: number): void {
    if (this.n >= this.capacity) return;
    this.m.compose(this.v.set(x, y, z), this.q.identity(), this.s.set(size, 1, size));
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, color);
    this.aMode.setX(this.n, mode);
    this.aBoost.setX(this.n, boost);
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.aMode.needsUpdate = true;
    this.aBoost.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
