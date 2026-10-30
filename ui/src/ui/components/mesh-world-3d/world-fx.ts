/**
 * Pooled effects for the 3D Agent Mesh — each pool is ONE draw call whose
 * animation runs in the shader from a birth time, so spawning an effect is a
 * few attribute writes and an idle pool costs nothing.
 *
 *   Beams   message / delegation / federation arcs with a travelling head
 *   Rings   spawn / finish / tool pulses expanding on the floor
 *   Sparks  spawn columns and finish bursts (points with ballistic motion)
 *   Links   plugin conduits + federation arcs with flowing dashes
 */
import * as THREE from "three";

export const BEAM_LIFE = 1.5;
export const RING_LIFE = 1.1;
export const SPARK_LIFE = 1.3;

const SEG = 24;

function bezier(out: THREE.Vector3, a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
  return out;
}

export class BeamPool {
  readonly mesh: THREE.LineSegments;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly pos: THREE.BufferAttribute;
  private readonly t: THREE.BufferAttribute;
  private readonly birth: THREE.BufferAttribute;
  private readonly color: THREE.BufferAttribute;
  private next = 0;
  private readonly beams: Array<{ a: THREE.Vector3; c: THREE.Vector3; b: THREE.Vector3; born: number; color: THREE.Color } | null>;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly capacity: number, uTime: THREE.IUniform<number>) {
    const verts = capacity * SEG * 2;
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.t = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.birth = new THREE.BufferAttribute(new Float32Array(verts).fill(-1e6), 1);
    this.color = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    for (const a of [this.pos, this.t, this.birth, this.color]) a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.pos);
    this.geometry.setAttribute("aT", this.t);
    this.geometry.setAttribute("aBirth", this.birth);
    this.geometry.setAttribute("aColor", this.color);
    this.beams = new Array(capacity).fill(null);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime, uLife: { value: BEAM_LIFE } },
      vertexShader: /* glsl */ `
        attribute float aT; attribute float aBirth; attribute vec3 aColor;
        uniform float uTime; uniform float uLife;
        varying float vA; varying vec3 vC;
        void main() {
          float age = (uTime - aBirth) / uLife;
          float head = age * 1.35;
          float tail = smoothstep(head - 0.45, head, aT) * step(aT, head);
          vA = (age >= 0.0 && age <= 1.0) ? tail * (1.0 - age * 0.6) : 0.0;
          vC = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA; varying vec3 vC;
        void main() { if (vA < 0.01) discard; gl_FragColor = vec4(vC * vA * 1.6, vA); }
      `,
    });
    this.mesh = new THREE.LineSegments(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  spawn(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, now: number, lift = 1): void {
    const slot = this.next;
    this.next = (this.next + 1) % this.capacity;
    const dist = a.distanceTo(b);
    const c = new THREE.Vector3((a.x + b.x) / 2, Math.max(a.y, b.y) + (1.2 + dist * 0.32) * lift, (a.z + b.z) / 2);
    const base = slot * SEG * 2;
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (let s = 0; s < SEG; s++) {
      const t0 = s / SEG;
      const t1 = (s + 1) / SEG;
      bezier(p, a, c, b, t0);
      bezier(q, a, c, b, t1);
      const i = base + s * 2;
      this.pos.setXYZ(i, p.x, p.y, p.z);
      this.pos.setXYZ(i + 1, q.x, q.y, q.z);
      this.t.setX(i, t0);
      this.t.setX(i + 1, t1);
      this.birth.setX(i, now);
      this.birth.setX(i + 1, now);
      this.color.setXYZ(i, color.r, color.g, color.b);
      this.color.setXYZ(i + 1, color.r, color.g, color.b);
    }
    for (const at of [this.pos, this.t, this.birth, this.color]) at.needsUpdate = true;
    this.beams[slot] = { a: a.clone(), c, b: b.clone(), born: now, color: color.clone() };
  }

  /** Visit each live beam's head (for the bright comet sprite). */
  heads(now: number, fn: (p: THREE.Vector3, color: THREE.Color, alpha: number) => void): number {
    let live = 0;
    for (let i = 0; i < this.beams.length; i++) {
      const bm = this.beams[i];
      if (!bm) continue;
      const age = (now - bm.born) / BEAM_LIFE;
      if (age > 1) {
        this.beams[i] = null;
        continue;
      }
      live++;
      const h = Math.min(1, age * 1.35);
      fn(bezier(this.tmp, bm.a, bm.c, bm.b, h), bm.color, h >= 1 ? 1 - age : 1);
    }
    return live;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class RingPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly birth: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly scale: THREE.InstancedBufferAttribute;
  private next = 0;
  private lastBirth = -1e6;
  private readonly m = new THREE.Matrix4();

  constructor(private readonly capacity: number, uTime: THREE.IUniform<number>) {
    const geo = new THREE.RingGeometry(0.82, 1, 40, 1);
    geo.rotateX(-Math.PI / 2);
    this.birth = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(-1e6), 1);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.scale = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
    geo.setAttribute("aBirth", this.birth);
    geo.setAttribute("aColor", this.color);
    geo.setAttribute("aScale", this.scale);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uTime, uLife: { value: RING_LIFE } },
      vertexShader: /* glsl */ `
        attribute float aBirth; attribute vec3 aColor; attribute float aScale;
        uniform float uTime; uniform float uLife;
        varying float vA; varying vec3 vC;
        void main() {
          float age = (uTime - aBirth) / uLife;
          float k = clamp(age, 0.0, 1.0);
          float grow = (0.25 + 1.0 - pow(1.0 - k, 3.0)) * aScale;
          vA = (age >= 0.0 && age <= 1.0) ? (1.0 - k) : 0.0;
          vC = aColor;
          vec3 p = position * grow;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA; varying vec3 vC;
        void main() { if (vA < 0.01) discard; gl_FragColor = vec4(vC * vA * 1.4, vA); }
      `,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this.m.identity());
  }

  spawn(x: number, y: number, z: number, color: THREE.Color, scale: number, now: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.m.makeTranslation(x, y, z);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.birth.setX(i, now);
    this.color.setXYZ(i, color.r, color.g, color.b);
    this.scale.setX(i, scale);
    this.birth.needsUpdate = this.color.needsUpdate = this.scale.needsUpdate = true;
    this.lastBirth = now;
  }

  alive(now: number): boolean {
    return now - this.lastBirth < RING_LIFE;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

export class SparkPool {
  readonly points: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly start: THREE.BufferAttribute;
  private readonly vel: THREE.BufferAttribute;
  private readonly birth: THREE.BufferAttribute;
  private readonly color: THREE.BufferAttribute;
  private next = 0;
  private lastBirth = -1e6;

  constructor(private readonly capacity: number, uTime: THREE.IUniform<number>, pixelRatio: () => number) {
    this.start = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.vel = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(capacity).fill(-1e6), 1);
    this.color = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    for (const a of [this.start, this.vel, this.birth, this.color]) a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.start);
    this.geometry.setAttribute("aVel", this.vel);
    this.geometry.setAttribute("aBirth", this.birth);
    this.geometry.setAttribute("aColor", this.color);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime, uLife: { value: SPARK_LIFE }, uPx: { value: pixelRatio() } },
      vertexShader: /* glsl */ `
        attribute vec3 aVel; attribute float aBirth; attribute vec3 aColor;
        uniform float uTime; uniform float uLife; uniform float uPx;
        varying float vA; varying vec3 vC;
        void main() {
          float t = uTime - aBirth;
          float age = t / uLife;
          vec3 p = position + aVel * t + vec3(0.0, -2.4, 0.0) * t * t;
          vA = (age >= 0.0 && age <= 1.0) ? (1.0 - age) : 0.0;
          vC = aColor;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = vA > 0.0 ? (90.0 * uPx / -mv.z) * (0.6 + 0.4 * vA) : 0.0;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA; varying vec3 vC;
        void main() {
          float d = length(gl_PointCoord * 2.0 - 1.0);
          float a = pow(max(0.0, 1.0 - d), 2.0) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vC * a * 1.8, a);
        }
      `,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
  }

  setPixelRatio(px: number): void {
    this.material.uniforms.uPx.value = px;
  }

  /**
   * `mode`: "column" rises (spawn), "burst" sprays (finish), "sparkle"
   * twinkles in a loose shell (image / media generation), "swirl" spirals up
   * around the agent (edits).
   */
  burst(x: number, y: number, z: number, color: THREE.Color, n: number, now: number, mode: "column" | "burst" | "sparkle" | "swirl"): void {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      const ang = Math.random() * Math.PI * 2;
      if (mode === "sparkle") {
        const r = 0.35 + Math.random() * 0.7;
        const yy = y + (Math.random() - 0.3) * 1.1;
        this.start.setXYZ(i, x + Math.cos(ang) * r, yy, z + Math.sin(ang) * r);
        this.vel.setXYZ(i, Math.cos(ang) * 0.15, 1.45 + Math.random() * 0.5, Math.sin(ang) * 0.15);
        this.birth.setX(i, now + Math.random() * 0.7);
      } else if (mode === "swirl") {
        const r = 0.55;
        this.start.setXYZ(i, x + Math.cos(ang) * r, y, z + Math.sin(ang) * r);
        // Tangential + inward: particles curl in around the agent.
        this.vel.setXYZ(i, -Math.sin(ang) * 1.1 - Math.cos(ang) * 0.3, 2.0 + Math.random() * 0.8, Math.cos(ang) * 1.1 - Math.sin(ang) * 0.3);
        this.birth.setX(i, now + Math.random() * 0.35);
      } else {
        const sp = mode === "burst" ? 1.2 + Math.random() * 1.8 : 0.25 + Math.random() * 0.5;
        const up = mode === "burst" ? 2 + Math.random() * 2.5 : 3 + Math.random() * 2.5;
        this.start.setXYZ(i, x + Math.cos(ang) * 0.15, y, z + Math.sin(ang) * 0.15);
        this.vel.setXYZ(i, Math.cos(ang) * sp, up, Math.sin(ang) * sp);
        this.birth.setX(i, now + (mode === "column" ? Math.random() * 0.25 : 0));
      }
      this.color.setXYZ(i, color.r, color.g, color.b);
    }
    for (const a of [this.start, this.vel, this.birth, this.color]) a.needsUpdate = true;
    this.lastBirth = now + 0.7;
  }

  alive(now: number): boolean {
    return now - this.lastBirth < SPARK_LIFE;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export interface LinkSpec {
  a: THREE.Vector3;
  b: THREE.Vector3;
  color: THREE.Color;
  /** Arc height (0 = flat on the floor). */
  lift: number;
}

/** Static link set with flowing dashes; rebuilt when the zone set changes. */
export function buildLinks(links: readonly LinkSpec[], uTime: THREE.IUniform<number>): THREE.LineSegments | null {
  if (!links.length) return null;
  const segs = 28;
  const n = links.length * segs * 2;
  const pos = new Float32Array(n * 3);
  const tt = new Float32Array(n);
  const len = new Float32Array(n);
  const col = new Float32Array(n * 3);
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  links.forEach((lk, li) => {
    const c = new THREE.Vector3((lk.a.x + lk.b.x) / 2, Math.max(lk.a.y, lk.b.y) + lk.lift, (lk.a.z + lk.b.z) / 2);
    const L = lk.a.distanceTo(lk.b);
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      bezier(p, lk.a, c, lk.b, t0);
      bezier(q, lk.a, c, lk.b, t1);
      const i = (li * segs + s) * 2;
      pos.set([p.x, p.y, p.z, q.x, q.y, q.z], i * 3);
      tt[i] = t0;
      tt[i + 1] = t1;
      len[i] = len[i + 1] = L;
      col.set([lk.color.r, lk.color.g, lk.color.b, lk.color.r, lk.color.g, lk.color.b], i * 3);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aT", new THREE.BufferAttribute(tt, 1));
  geo.setAttribute("aLen", new THREE.BufferAttribute(len, 1));
  geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime },
    vertexShader: /* glsl */ `
      attribute float aT; attribute float aLen; attribute vec3 aColor;
      varying float vD; varying vec3 vC; varying float vT;
      uniform float uTime;
      void main() {
        vD = aT * aLen * 0.9 - uTime * 1.6;
        vC = aColor; vT = aT;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vD; varying vec3 vC; varying float vT;
      void main() {
        float dash = smoothstep(0.0, 0.15, fract(vD)) * (1.0 - smoothstep(0.35, 0.5, fract(vD)));
        float a = 0.16 + 0.6 * dash;
        a *= smoothstep(0.0, 0.06, vT) * smoothstep(1.0, 0.94, vT);
        gl_FragColor = vec4(vC * a, a);
      }
    `,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 3;
  return lines;
}

// ── Holo panels (per working agent, dynamic) ─────────────────────────────

/**
 * Floating holo-screens in front of standing working agents (typing on air):
 * one instanced additive quad per agent, the same scrolling-code shader as
 * the desk screens.
 */
export class HoloPanels {
  readonly mesh: THREE.InstancedMesh;
  private readonly level: THREE.InstancedBufferAttribute;
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(capacity: number, material: THREE.ShaderMaterial) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.level = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.level.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aLevel", this.level);
    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  begin(): void {
    this.n = 0;
  }

  push(x: number, y: number, z: number, rotY: number, tilt: number, w: number, h: number, level: number, color: THREE.Color): void {
    if (this.n >= this.level.count) return;
    this.e.set(tilt, rotY, 0, "YXZ");
    this.q.setFromEuler(this.e);
    this.m.compose(this.v.set(x, y, z), this.q, this.s.set(w, h, 1));
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, color);
    this.level.setX(this.n, level);
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.level.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

// ── Terminal glyphs (Bash / exec pulses) ─────────────────────────────────

/** 5×7 bitmap glyphs for the terminal pulse (no canvas needed — native safe). */
const GLYPHS: string[][] = [
  // >
  ["10000", "01000", "00100", "00010", "00100", "01000", "10000"],
  // _
  ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  // $
  ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  // {
  ["00110", "00100", "00100", "01000", "00100", "00100", "00110"],
  // }
  ["01100", "00100", "00100", "00010", "00100", "00100", "01100"],
  // /
  ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  // 0
  ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  // 1
  ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
];
export const GLYPH_COUNT = GLYPHS.length;

function glyphAtlas(): THREE.DataTexture {
  const cw = 8;
  const ch = 8;
  const w = cw * GLYPHS.length;
  const data = new Uint8Array(w * ch * 4);
  GLYPHS.forEach((rows, gi) => {
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < 5; rx++) {
        if (row[rx] !== "1") continue;
        const x = gi * cw + rx + 1;
        const y = ch - 1 - ry; // texture rows bottom-up
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 255;
      }
    });
  });
  const tex = new THREE.DataTexture(data, w, ch, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export const GLYPH_LIFE = 1.6;

/** Rising terminal glyphs, billboarded, one draw call; animation in the shader. */
export class GlyphPool {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aStart: THREE.InstancedBufferAttribute;
  private readonly aMeta: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly tex = glyphAtlas();
  private next = 0;
  private lastBirth = -1e6;

  constructor(private readonly capacity: number, uTime: THREE.IUniform<number>) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = base.index;
    this.geometry.setAttribute("position", base.getAttribute("position"));
    this.geometry.setAttribute("uv", base.getAttribute("uv"));
    base.dispose();
    this.aStart = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    // birth, glyph index, size, drift
    this.aMeta = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4).fill(-1e6), 4);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    for (const a of [this.aStart, this.aMeta, this.aColor]) a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aStart", this.aStart);
    this.geometry.setAttribute("aMeta", this.aMeta);
    this.geometry.setAttribute("aColor", this.aColor);
    this.geometry.instanceCount = capacity;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: { uTime, uMap: { value: this.tex }, uLife: { value: GLYPH_LIFE }, uN: { value: GLYPHS.length } },
      vertexShader: /* glsl */ `
        attribute vec3 aStart; attribute vec4 aMeta; attribute vec3 aColor;
        uniform float uTime; uniform float uLife; uniform float uN;
        varying vec2 vUv; varying vec3 vC; varying float vA;
        void main() {
          float t = uTime - aMeta.x;
          float age = t / uLife;
          vA = (age >= 0.0 && age <= 1.0) ? smoothstep(0.0, 0.12, age) * (1.0 - age) : 0.0;
          vC = aColor;
          vUv = vec2((uv.x + aMeta.y) / uN, uv.y);
          vec3 p = aStart + vec3(sin(t * 2.0 + aMeta.w) * 0.08, t * 0.75, 0.0);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          mv.xy += position.xy * aMeta.z * (vA > 0.0 ? 1.0 : 0.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; varying vec2 vUv; varying vec3 vC; varying float vA;
        void main() {
          float g = texture2D(uMap, vUv).a;
          float a = g * vA;
          if (a < 0.02) discard;
          gl_FragColor = vec4(vC * a * 1.6, a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
  }

  emit(x: number, y: number, z: number, color: THREE.Color, n: number, now: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      const ang = Math.random() * Math.PI * 2;
      this.aStart.setXYZ(i, x + Math.cos(ang) * 0.4, y + Math.random() * 0.3, z + Math.sin(ang) * 0.4);
      this.aMeta.setXYZW(i, now + k * 0.09, Math.floor(Math.random() * GLYPHS.length), 0.16 + Math.random() * 0.08, Math.random() * 6);
      this.aColor.setXYZ(i, color.r, color.g, color.b);
    }
    for (const a of [this.aStart, this.aMeta, this.aColor]) a.needsUpdate = true;
    this.lastBirth = now + n * 0.09;
  }

  alive(now: number): boolean {
    return now - this.lastBirth < GLYPH_LIFE;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.tex.dispose();
  }
}

// ── Scanning beams (search / research pulses) ────────────────────────────

export const SCAN_LIFE = 1.8;

/** A radar wedge that sweeps around the agent on the floor + a light sheet. */
export class ScanPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly birth: THREE.InstancedBufferAttribute;
  private next = 0;
  private lastBirth = -1e6;
  private readonly m = new THREE.Matrix4();

  constructor(private readonly capacity: number, uTime: THREE.IUniform<number>) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.birth = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(-1e6), 1);
    this.birth.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aBirth", this.birth);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: { uTime, uLife: { value: SCAN_LIFE } },
      vertexShader: /* glsl */ `
        attribute float aBirth; varying vec2 vUv; varying vec3 vCol; varying float vAge;
        uniform float uTime; uniform float uLife;
        void main() {
          vUv = uv * 2.0 - 1.0;
          vAge = (uTime - aBirth) / uLife;
          vCol = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            vCol = instanceColor;
          #endif
          gl_Position = (vAge >= 0.0 && vAge <= 1.0) ? projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vCol; varying float vAge;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          float sweep = vAge * 6.2831 * 1.5;
          float ang = atan(vUv.y, vUv.x);
          float d = mod(sweep - ang, 6.2831);
          float wedge = exp(-d * 2.2) * smoothstep(1.0, 0.85, r) * smoothstep(0.08, 0.2, r);
          float rim = smoothstep(0.03, 0.0, abs(r - min(1.0, vAge * 1.6))) * 0.6;
          float fade = smoothstep(0.0, 0.1, vAge) * (1.0 - smoothstep(0.7, 1.0, vAge));
          float a = (wedge * 0.8 + rim) * fade;
          gl_FragColor = vec4(vCol * a, a);
        }
      `,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
  }

  spawn(x: number, y: number, z: number, color: THREE.Color, radius: number, now: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.m.makeScale(radius * 2, 1, radius * 2).setPosition(x, y, z);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.setColorAt(i, color);
    this.birth.setX(i, now);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.birth.needsUpdate = true;
    this.lastBirth = now;
  }

  alive(now: number): boolean {
    return now - this.lastBirth < SCAN_LIFE;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

// ── Ambient drones ───────────────────────────────────────────────────────

/** Small sleek drones patrolling the station (instanced; lights go through the glow sprites). */
export class DroneSet {
  readonly mesh: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private n = 0;

  constructor(capacity: number, geometry: THREE.BufferGeometry, material: THREE.Material) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  begin(): void {
    this.n = 0;
  }

  push(x: number, y: number, z: number, heading: number, bank: number, scale: number): void {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    this.e.set(0, heading, bank, "YXZ");
    this.q.setFromEuler(this.e);
    this.m.compose(this.v.set(x, y, z), this.q, this.s.setScalar(scale));
    this.mesh.setMatrixAt(this.n++, this.m);
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
