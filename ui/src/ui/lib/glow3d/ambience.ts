/**
 * glow3d ambience — a distant twinkling starfield and a cloud of slowly
 * drifting dust motes around the subject. Both are single `Points` draws
 * with all motion in the vertex shader, so they cost one draw call each and
 * nothing on the CPU per frame. `uMotion` (0..1) stills them for
 * prefers-reduced-motion.
 */

import * as THREE from "three";
import { FOG_GLSL, type GlowUniforms } from "./scene";
import { radialSpriteTexture } from "./textures";

function hash(i: number, salt: number): number {
  // Deterministic 0..1 noise so the field looks the same on every mount.
  let x = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 15), 0xc2b2ae35);
  return ((x ^ (x >>> 13)) >>> 0) / 4294967296;
}

export interface StarfieldOptions {
  count?: number;
  /** Shell radius the stars sit on. */
  radius?: number;
  /** Base point size in px at the reference distance. */
  size?: number;
  /** Warm tint mixed into a third of the stars. */
  tint?: string;
}

export function createStarfield(uniforms: GlowUniforms, opts: StarfieldOptions = {}): THREE.Points {
  const count = opts.count ?? 1400;
  const radius = opts.radius ?? 5000;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const attr = new Float32Array(count * 2); // size, phase
  const tint = new THREE.Color(opts.tint ?? "#f5c542");
  const white = new THREE.Color("#dfe6ff");
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = hash(i, 1) * 2 - 1;
    const phi = hash(i, 2) * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.7 + hash(i, 3) * 0.3);
    pos[i * 3] = r * s * Math.cos(phi);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * s * Math.sin(phi);
    c.copy(white).lerp(tint, hash(i, 4) < 0.3 ? 0.6 : 0.05);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    attr[i * 2] = (opts.size ?? 2.2) * (0.5 + hash(i, 5) * 1.4);
    attr[i * 2 + 1] = hash(i, 6) * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aStar", new THREE.BufferAttribute(attr, 2));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: uniforms.uTime,
      uMotion: uniforms.uMotion,
      uMap: { value: radialSpriteTexture(32, 0.1, 1.2) },
      uDpr: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aStar; attribute vec3 color;
      uniform float uTime; uniform float uMotion; uniform float uDpr;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        vColor = color;
        float tw = 0.65 + 0.35 * sin(uTime * (0.6 + aStar.y * 0.3) + aStar.y * 7.0) * uMotion;
        vAlpha = tw;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aStar.x * uDpr * (0.8 + 0.4 * tw);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
        gl_FragColor = vec4(vColor * a * 0.9, a);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -500;
  return pts;
}

export interface DustOptions {
  count?: number;
  /** Half-extent of the box the motes drift in. */
  extent?: number;
  size?: number;
  color?: string;
}

export function createDust(uniforms: GlowUniforms, opts: DustOptions = {}): THREE.Points {
  const count = opts.count ?? 520;
  const ext = opts.extent ?? 900;
  const pos = new Float32Array(count * 3);
  const attr = new Float32Array(count * 4); // size, phase, drift amp, speed
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (hash(i, 11) * 2 - 1) * ext;
    pos[i * 3 + 1] = (hash(i, 12) * 2 - 1) * ext * 0.6;
    pos[i * 3 + 2] = (hash(i, 13) * 2 - 1) * ext;
    attr[i * 4] = (opts.size ?? 3) * (0.4 + hash(i, 14) * 1.2);
    attr[i * 4 + 1] = hash(i, 15) * Math.PI * 2;
    attr[i * 4 + 2] = 10 + hash(i, 16) * 30;
    attr[i * 4 + 3] = 0.08 + hash(i, 17) * 0.12;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aDust", new THREE.BufferAttribute(attr, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: uniforms.uTime,
      uMotion: uniforms.uMotion,
      uFogNear: uniforms.uFogNear,
      uFogFar: uniforms.uFogFar,
      uFogColor: uniforms.uFogColor,
      uColor: { value: new THREE.Color(opts.color ?? "#e8c76a") },
      uMap: { value: radialSpriteTexture(32, 0.0, 2.0) },
      uDpr: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aDust;
      uniform float uTime; uniform float uMotion; uniform float uDpr;
      ${FOG_GLSL.uniforms}
      ${FOG_GLSL.factor}
      varying float vAlpha;
      void main() {
        float t = uTime * aDust.w * uMotion;
        vec3 p = position;
        p.x += sin(t + aDust.y) * aDust.z;
        p.y += cos(t * 0.8 + aDust.y * 1.7) * aDust.z * 0.6;
        p.z += sin(t * 0.6 + aDust.y * 2.3) * aDust.z;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float fog = fogFactor(mv.z);
        vAlpha = (0.25 + 0.25 * sin(t * 2.0 + aDust.y)) * (1.0 - fog);
        gl_PointSize = aDust.x * uDpr * (300.0 / max(60.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -400;
  return pts;
}

/** Faint concentric guide rings on the z=0 plane (orbit / tier markers). */
export function createGuideRings(radii: number[], color = "#d4af37", opacity = 0.09): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  for (const r of radii) {
    const segs = Math.max(48, Math.min(180, Math.round(r / 6)));
    const pos = new Float32Array(segs * 3);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const loop = new THREE.LineLoop(geo, mat);
    loop.renderOrder = -300;
    group.add(loop);
  }
  return group;
}

/**
 * Polar instrument grid on the ground plane: fine concentric rings and
 * radial spokes that fade toward the rim, plus a slow radar sweep. One quad,
 * all detail in the fragment shader.
 */
export function createPolarGrid(
  uniforms: GlowUniforms,
  opts: { radius?: number; y?: number; color?: string; accent?: string } = {},
): THREE.Mesh {
  const radius = opts.radius ?? 1600;
  const geo = new THREE.PlaneGeometry(2, 2);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: uniforms.uTime,
      uMotion: uniforms.uMotion,
      uFogNear: uniforms.uFogNear,
      uFogFar: uniforms.uFogFar,
      uFogColor: uniforms.uFogColor,
      uRadius: { value: radius },
      uColor: { value: new THREE.Color(opts.color ?? "#d4af37") },
      uAccent: { value: new THREE.Color(opts.accent ?? "#5ee7ff") },
    },
    vertexShader: /* glsl */ `
      uniform float uRadius;
      ${FOG_GLSL.uniforms}
      ${FOG_GLSL.factor}
      varying vec2 vP; varying float vFog;
      void main() {
        vec3 p = position * uRadius;
        vP = p.xz;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vFog = fogFactor(mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uMotion; uniform float uRadius; uniform vec3 uColor; uniform vec3 uAccent;
      varying vec2 vP; varying float vFog;
      void main() {
        float r = length(vP);
        float nr = r / uRadius;
        if (nr > 1.0) discard;
        float fw = fwidth(r);
        float ring = 1.0 - smoothstep(0.0, fw * 1.2, abs(fract(r / 80.0 + 0.5) - 0.5) * 80.0);
        float major = 1.0 - smoothstep(0.0, fw * 1.6, abs(fract(r / 400.0 + 0.5) - 0.5) * 400.0);
        float ang = atan(vP.y, vP.x);
        float sp = abs(fract(ang / 6.2831853 * 24.0 + 0.5) - 0.5) * 6.2831853 / 24.0 * r;
        float spoke = (1.0 - smoothstep(0.0, fw * 1.2, sp)) * smoothstep(60.0, 220.0, r);
        float fade = smoothstep(1.0, 0.25, nr) * smoothstep(0.0, 0.06, nr);
        float sweepA = fract(ang / 6.2831853 - uTime * 0.03 * uMotion);
        float sweep = pow(sweepA, 18.0) * 0.5 * uMotion;
        vec3 col = uColor * (ring * 0.05 + major * 0.11 + spoke * 0.035) + uAccent * sweep * 0.06 * fade;
        float a = (ring * 0.05 + major * 0.11 + spoke * 0.035 + sweep * 0.05) * fade * (1.0 - vFog);
        gl_FragColor = vec4(col * fade * (1.0 - vFog), a);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = opts.y ?? -160;
  mesh.frustumCulled = false;
  mesh.renderOrder = -350;
  return mesh;
}

/**
 * Distant nebula wisps: a handful of huge additive quads with cheap value
 * noise in violet / cyan / gold, parked far behind the subject so they read
 * as deep-space colour without competing with the nodes.
 */
export function createNebula(uniforms: GlowUniforms, opts: { count?: number; distance?: number } = {}): THREE.Group {
  const group = new THREE.Group();
  const count = opts.count ?? 5;
  const dist = opts.distance ?? 5200;
  const palette = ["#3b2a7a", "#0f5a6e", "#6b4a12", "#2a1650", "#114a5a"];
  const geo = new THREE.PlaneGeometry(2, 2);
  for (let i = 0; i < count; i++) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: uniforms.uTime,
        uMotion: uniforms.uMotion,
        uColor: { value: new THREE.Color(palette[i % palette.length]) },
        uSeed: { value: hash(i, 40) * 50 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uMotion; uniform vec3 uColor; uniform float uSeed;
        varying vec2 vUv;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
        float n(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float d = length(p);
          if (d > 1.0) discard;
          vec2 q = vUv * 3.0 + vec2(uTime * 0.006 * uMotion, 0.0);
          float f = n(q) * 0.55 + n(q * 2.1) * 0.3 + n(q * 4.3) * 0.15;
          float a = smoothstep(1.0, 0.1, d) * smoothstep(0.35, 0.85, f) * 0.22;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });
    const m = new THREE.Mesh(geo, mat);
    const theta = hash(i, 41) * Math.PI * 2;
    const phi = (hash(i, 42) - 0.35) * 0.9;
    m.position.set(Math.cos(theta) * dist, Math.sin(phi) * dist * 0.5, Math.sin(theta) * dist);
    m.scale.setScalar(dist * (0.45 + hash(i, 43) * 0.35));
    m.lookAt(0, 0, 0);
    m.renderOrder = -900;
    m.frustumCulled = false;
    group.add(m);
  }
  return group;
}
