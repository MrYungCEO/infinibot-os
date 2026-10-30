/**
 * Procedural diorama geometry for the 3D Agent Mesh.
 *
 *   static world   station plinth, beveled room floors + carpet inlays, back
 *                  walls, glass partitions with door gaps, railings, one
 *                  bespoke landmark per sector (observatory dome, mission
 *                  control screen wall, vault door …), plugin towers with glass
 *                  curtain walls, federation islands — MERGED by material
 *                  (floor / body / metal / glow / glass), so the whole station
 *                  is five draw calls.
 *   furniture      desks, chairs, plants, server racks, rest pods: built once
 *                  as "kits" (vertex-coloured, beveled) and INSTANCED — one
 *                  draw call per kit part however many rooms there are.
 *   screens        every monitor / wall panel is one instance of an animated
 *                  shader quad whose brightness tracks live activity.
 *   blobs          baked contact shadows (soft radial decals) under props.
 *
 * Coordinates: 1 tile = 1 world unit, the 24×24 core station centred on the
 * origin (toX / toZ). Kits face +Z (the seat side).
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldZone } from "../../views/agent-ops/mesh-world-model";

export const GOLD = 0xd4af37;
export const GOLD_HI = 0xf5d77a;
export const INK = 0x0a0a0e;

/** World units: 1 tile = 1 unit, station centred on the origin. */
export const toX = (c: number) => c - 12;
export const toZ = (r: number) => r - 12;

/** Building height per plugin room size. */
export function buildingHeight(z: Pick<WorldZone, "w">): number {
  return z.w >= 10 ? 4.6 : z.w >= 8 ? 3.6 : 2.8;
}

/** Floor top (agents stand here). */
export const FLOOR_Y = 0.16;
/** Furniture scale vs. the kit models (sized for the chunky avatars). */
const DESK_S = 1.25;
const CHAIR_S = 1.15;

// ── Merge helper ─────────────────────────────────────────────────────────

/**
 * Material roles. "glow" + "flow" are unlit and scale with their zone's live
 * intensity (busy districts brighten); "flow" also streams light along +Y / +X
 * (server towers, portal rings, ticker bands).
 */
export type PartKind = "floor" | "body" | "metal" | "glow" | "glass" | "flow";
export const PART_KINDS: PartKind[] = ["floor", "body", "metal", "glow", "glass", "flow"];

/** Max zones whose intensity the shared materials track (uniform array size). */
export const MAX_ZONES = 64;

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpE = new THREE.Euler();
const tmpC = new THREE.Color();

export const rbox = (w: number, h: number, d: number, r = 0.04, seg = 1) =>
  new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));

const emptyParts = (): Record<PartKind, THREE.BufferGeometry[]> => ({ floor: [], body: [], metal: [], glow: [], glass: [], flow: [] });

export class StaticBuilder {
  private parts = emptyParts();
  /** Zone index written into every vertex (aZone): -1 = constant intensity (kits). */
  zone = -1;

  /** Add a primitive at (x,y,z) with optional rotation / scale. Consumes `geo`. */
  add(kind: PartKind, geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rotY = 0, scale?: [number, number, number], rotX = 0, rotZ = 0): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (g.getAttribute("uv")) g.deleteAttribute("uv");
    if (g.getAttribute("uv1")) g.deleteAttribute("uv1");
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    tmpE.set(rotX, rotY, rotZ, "YXZ");
    tmpQ.setFromEuler(tmpE);
    tmpS.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
    tmpP.set(x, y, z);
    tmpM.compose(tmpP, tmpQ, tmpS);
    g.applyMatrix4(tmpM);
    const n = g.getAttribute("position").count;
    const col = new Float32Array(n * 3);
    tmpC.setHex(color, THREE.SRGBColorSpace);
    for (let i = 0; i < n; i++) {
      col[i * 3] = tmpC.r;
      col[i * 3 + 1] = tmpC.g;
      col[i * 3 + 2] = tmpC.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aZone", new THREE.BufferAttribute(new Float32Array(n).fill(this.zone), 1));
    this.parts[kind].push(g);
  }

  get empty(): boolean {
    return PART_KINDS.every((k) => !this.parts[k].length);
  }

  /** Merge each part list into one geometry (clears the builder). */
  geometries(): Partial<Record<PartKind, THREE.BufferGeometry>> {
    const out: Partial<Record<PartKind, THREE.BufferGeometry>> = {};
    for (const kind of PART_KINDS) {
      const list = this.parts[kind];
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      out[kind] = merged;
    }
    this.parts = emptyParts();
    return out;
  }

  build(materials: Record<PartKind, THREE.Material>): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const geos = this.geometries();
    for (const kind of PART_KINDS) {
      const g = geos[kind];
      if (!g) continue;
      out.push(partMesh(g, materials, kind, `static-${kind}`));
    }
    return out;
  }
}

/** One mesh of a material role with the right shadow / order flags. */
export function partMesh(g: THREE.BufferGeometry, materials: Record<PartKind, THREE.Material>, kind: PartKind, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(g, materials[kind]);
  mesh.name = name;
  mesh.castShadow = kind === "body" || kind === "metal";
  mesh.receiveShadow = kind === "floor" || kind === "body";
  if (kind === "glass") mesh.renderOrder = 3;
  return mesh;
}

export function mixHex(a: number, b: number, t: number): number {
  const ca = new THREE.Color(a);
  ca.lerp(new THREE.Color(b), t);
  return ca.getHex();
}

// ── Materials ────────────────────────────────────────────────────────────

/** Uniforms every world material shares (time + per-zone live intensity). */
export interface WorldUniforms {
  uTime: THREE.IUniform<number>;
  uZoneI: THREE.IUniform<number[]>;
}

export function createWorldUniforms(uTime: THREE.IUniform<number>): WorldUniforms {
  return { uTime, uZoneI: { value: new Array(MAX_ZONES).fill(0.6) } };
}

/** Theme finish for the shared materials. */
export interface MaterialFinish {
  light: boolean;
  /** Env-map strength for the polished floor / metal / glass. */
  reflect: number;
}

const ZONE_VERT_PARS = /* glsl */ `
attribute float aZone;
uniform float uZoneI[${MAX_ZONES}];
varying float vZoneI;
`;
const ZONE_VERT = /* glsl */ `
vZoneI = aZone < 0.0 ? 1.0 : uZoneI[int(aZone + 0.5)];
`;

/** Unlit trim / light-strip material that scales with the zone's intensity (HDR above 1 → bloom). */
function zoneGlow(u: WorldUniforms, flow: boolean, key: string): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uZoneI = u.uZoneI;
    shader.uniforms.uTime = u.uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${ZONE_VERT_PARS}\nvarying vec3 vWpF;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${ZONE_VERT}\nvWpF = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vZoneI;\nvarying vec3 vWpF;\nuniform float uTime;")
      .replace(
        "#include <color_fragment>",
        flow
          ? `#include <color_fragment>
            {
              float s = fract((vWpF.y + vWpF.x * 0.35 + vWpF.z * 0.35) * 1.6 - uTime * (0.6 + 1.6 * vZoneI));
              float streak = smoothstep(0.0, 0.08, s) * smoothstep(0.5, 0.12, s);
              diffuseColor.rgb *= (0.28 + 1.4 * streak) * vZoneI;
            }`
          : `#include <color_fragment>\ndiffuseColor.rgb *= vZoneI;`,
      );
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/**
 * Shared static / kit materials for a theme. The floor is polished stone /
 * obsidian (env-mapped, soft tile seams from world position), metal is
 * brushed, glass frosted; glow + flow follow per-zone intensity.
 */
export function createWorldMaterials(u: WorldUniforms, finish: MaterialFinish = { light: false, reflect: 1 }): Record<PartKind, THREE.Material> {
  const L = finish.light;
  const floor = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: L ? 0.3 : 0.2, metalness: L ? 0.12 : 0.55, envMapIntensity: finish.reflect });
  floor.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWp;\nvarying float vUp;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUp = normalize(mat3(modelMatrix) * objectNormal).y;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWp;\nvarying float vUp;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec2 g = abs(fract(vWp.xz * 0.5 + 0.5) - 0.5);
          float w = fwidth(vWp.x) + fwidth(vWp.z);
          float seam = smoothstep(0.0, 0.012 + w * 0.5, min(g.x, g.y));
          float up = smoothstep(0.6, 0.95, vUp);
          diffuseColor.rgb *= mix(1.0, mix(${L ? "0.86" : "0.6"}, 1.0, seam), up);
        }`,
      );
  };
  floor.customProgramCacheKey = () => `mesh3d-floor-v2-${L ? "l" : "d"}`;
  return {
    floor,
    body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: L ? 0.42 : 0.38, metalness: L ? 0.05 : 0.42, envMapIntensity: finish.reflect * 0.6 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.26, metalness: 0.95, envMapIntensity: finish.reflect * 1.2 }),
    glow: zoneGlow(u, false, "mesh3d-zglow-v1"),
    glass: new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: L ? 0.34 : 0.22,
      roughness: 0.08,
      metalness: 0.65,
      envMapIntensity: finish.reflect * 1.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    flow: zoneGlow(u, true, "mesh3d-zflow-v1"),
  };
}

// ── Furniture kits (instanced) ───────────────────────────────────────────

export type KitId = "console" | "chair" | "stool" | "pod" | "kiosk" | "drafting" | "mic" | "bollard" | "rack" | "bed";
export const KIT_IDS: KitId[] = ["console", "chair", "stool", "pod", "kiosk", "drafting", "mic", "bollard", "rack", "bed"];

export type Kit = Partial<Record<PartKind, THREE.BufferGeometry>>;

/** Palette roles the kits are built from (world-theme.ts WorldTheme subset). */
export interface KitPalette {
  body: number;
  bodyHi: number;
  metal: number;
  metalHi: number;
  accent: number;
  accentDeep: number;
  glass: number;
}

/** Build every furniture kit once per theme (consumers instance them). Kits face +Z (the seat side). */
export function createKits(P: KitPalette): Record<KitId, Kit> {
  const b = new StaticBuilder();
  b.zone = -1;
  const kits = {} as Record<KitId, Kit>;

  // Sleek workstation: cantilevered slab on a single blade leg, accent edge light, holo-screen frame.
  b.add("body", rbox(1.0, 0.05, 0.5, 0.02), P.body, 0, 0.66, 0);
  b.add("metal", new THREE.BoxGeometry(1.0, 0.012, 0.012), P.accent, 0, 0.66, 0.25);
  b.add("glow", new THREE.BoxGeometry(0.94, 0.008, 0.012), P.accent, 0, 0.638, 0.252);
  b.add("metal", new THREE.BoxGeometry(0.08, 0.64, 0.36), P.metal, 0, 0.32, -0.04);
  b.add("metal", rbox(0.5, 0.025, 0.42, 0.01), P.metal, 0, 0.012, -0.04);
  b.add("body", new THREE.BoxGeometry(0.42, 0.012, 0.13), P.bodyHi, 0, 0.69, 0.09);
  b.add("metal", new THREE.BoxGeometry(0.02, 0.32, 0.02), P.metal, 0, 0.83, -0.17);
  b.add("metal", new THREE.BoxGeometry(0.7, 0.012, 0.02), P.accentDeep, 0, 0.73, -0.17);
  kits.console = b.geometries();

  // Shell chair: one curved seat piece on a pedestal.
  b.add("body", rbox(0.44, 0.07, 0.42, 0.03), P.bodyHi, 0, 0.44, 0);
  b.add("body", rbox(0.44, 0.44, 0.06, 0.03), P.body, 0, 0.72, -0.21, 0, undefined, 0.14);
  b.add("metal", new THREE.BoxGeometry(0.46, 0.012, 0.012), P.accent, 0, 0.94, -0.24, 0, undefined, 0.14);
  b.add("metal", new THREE.CylinderGeometry(0.03, 0.03, 0.34, 8), P.metal, 0, 0.24, 0);
  b.add("metal", new THREE.CylinderGeometry(0.2, 0.22, 0.03, 18), P.metal, 0, 0.03, 0);
  kits.chair = b.geometries();

  // Stool (holo-table seats).
  b.add("body", new THREE.CylinderGeometry(0.2, 0.2, 0.07, 20), P.bodyHi, 0, 0.47, 0);
  b.add("metal", new THREE.TorusGeometry(0.2, 0.012, 4, 24), P.accent, 0, 0.5, 0, 0, undefined, Math.PI / 2);
  b.add("metal", new THREE.CylinderGeometry(0.035, 0.05, 0.44, 8), P.metal, 0, 0.22, 0);
  b.add("metal", new THREE.CylinderGeometry(0.18, 0.2, 0.025, 18), P.metal, 0, 0.012, 0);
  kits.stool = b.geometries();

  // Lounge pod: open egg shell around the seat (opening toward +Z), accent rim, soft inner light.
  b.add("body", new THREE.SphereGeometry(0.62, 22, 14, Math.PI * 0.2 + Math.PI / 2, Math.PI * 1.6, 0, Math.PI * 0.82), P.body, 0, 0.62, 0, 0, [1, 1.12, 1]);
  b.add("body", new THREE.CylinderGeometry(0.5, 0.5, 0.12, 24), P.bodyHi, 0, 0.42, 0.04);
  b.add("glow", new THREE.TorusGeometry(0.6, 0.018, 4, 32, Math.PI * 1.6), P.accent, 0, 0.62, 0, Math.PI * 0.2 + Math.PI / 2 + Math.PI * 1.6 + Math.PI, [1, 1.12, 1], Math.PI / 2);
  b.add("metal", new THREE.CylinderGeometry(0.3, 0.38, 0.06, 24), P.metal, 0, 0.03, 0);
  kits.pod = b.geometries();

  // Info kiosk: slim pillar with an angled top.
  b.add("body", rbox(0.34, 1.0, 0.26, 0.04), P.body, 0, 0.5, -0.05);
  b.add("body", rbox(0.5, 0.04, 0.34, 0.02), P.bodyHi, 0, 1.05, 0.0, 0, undefined, 0.45);
  b.add("glow", new THREE.BoxGeometry(0.02, 0.9, 0.012), P.accent, 0, 0.5, 0.085);
  b.add("metal", rbox(0.44, 0.03, 0.36, 0.01), P.metal, 0, 0.015, -0.05);
  kits.kiosk = b.geometries();

  // Drafting table: tilted glowing work surface on a trestle.
  b.add("metal", new THREE.BoxGeometry(0.05, 0.72, 0.05), P.metal, -0.4, 0.36, 0);
  b.add("metal", new THREE.BoxGeometry(0.05, 0.72, 0.05), P.metal, 0.4, 0.36, 0);
  b.add("metal", new THREE.BoxGeometry(0.85, 0.04, 0.05), P.metal, 0, 0.18, 0);
  b.add("body", rbox(0.98, 0.04, 0.62, 0.015), P.body, 0, 0.78, 0, 0, undefined, 0.38);
  b.add("metal", new THREE.BoxGeometry(0.98, 0.012, 0.012), P.accent, 0, 0.66, 0.3);
  kits.drafting = b.geometries();

  // Mic stand.
  b.add("metal", new THREE.CylinderGeometry(0.16, 0.18, 0.03, 16), P.metal, 0, 0.015, 0);
  b.add("metal", new THREE.CylinderGeometry(0.014, 0.014, 1.3, 6), P.metal, 0, 0.65, 0);
  b.add("body", new THREE.CapsuleGeometry(0.045, 0.1, 3, 10), P.bodyHi, 0, 1.36, 0.06, 0, undefined, 0.6);
  b.add("glow", new THREE.TorusGeometry(0.05, 0.008, 4, 12), P.accent, 0, 1.31, 0.04, 0, undefined, 0.6);
  kits.mic = b.geometries();

  // Light bollard (replaces potted plants: architecture, not décor clutter).
  b.add("body", new THREE.CylinderGeometry(0.1, 0.12, 0.6, 12), P.body, 0, 0.3, 0);
  b.add("glow", new THREE.CylinderGeometry(0.102, 0.102, 0.08, 12), P.accent, 0, 0.5, 0);
  b.add("metal", new THREE.CylinderGeometry(0.11, 0.11, 0.025, 12), P.metalHi, 0, 0.61, 0);
  kits.bollard = b.geometries();

  // Server tower: obsidian cabinet, brushed cap, vent ribs (light flow lives on the zone flow layer).
  b.add("body", rbox(0.78, 2.3, 0.72, 0.04), P.body, 0, 1.15, 0);
  b.add("metal", rbox(0.8, 0.05, 0.74, 0.015), P.metalHi, 0, 2.31, 0);
  for (let k = 0; k < 7; k++) b.add("body", new THREE.BoxGeometry(0.6, 0.012, 0.02), P.bodyHi, 0, 0.35 + k * 0.28, 0.362);
  kits.rack = b.geometries();

  // Rest pod (concourse) — long axis X; capsule bed with canopy and accent strip.
  b.add("body", rbox(1.2, 0.26, 0.66, 0.08), P.body, 0, 0.13, 0);
  b.add("body", rbox(1.04, 0.1, 0.54, 0.05), P.bodyHi, 0, 0.3, 0);
  b.add("body", rbox(0.24, 0.08, 0.4, 0.04), P.metalHi, -0.38, 0.38, 0);
  b.add("glass", new THREE.SphereGeometry(0.42, 18, 8, 0, Math.PI, 0, Math.PI / 2), P.glass, -0.3, 0.3, 0, -Math.PI / 2, [1.1, 0.75, 0.82]);
  b.add("glow", new THREE.BoxGeometry(1.0, 0.02, 0.02), P.accent, 0, 0.2, 0.335);
  kits.bed = b.geometries();
  return kits;
}

export interface KitPlacement {
  kit: KitId;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  tint: number;
}

// ── Screens (animated instanced quads) ───────────────────────────────────

export interface ScreenSpec {
  x: number;
  y: number;
  z: number;
  rotY: number;
  tilt: number;
  w: number;
  h: number;
  color: number;
  zoneId: string;
  /** Index into WorldBuild.desks when this is a desk monitor. */
  desk: number;
}

/**
 * Holo-screen shader: scrolling "code" rows over a soft panel glow, additive
 * (projected light, not a lit surface). Brightness + scroll speed follow
 * aLevel (0 idle … 1 busy typing).
 */
export function screenMaterial(uTime: THREE.IUniform<number>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aLevel;
      varying vec2 vUv; varying vec3 vCol; varying float vLevel; varying float vSeed;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv; vLevel = aLevel;
        vCol = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #endif
        vSeed = instanceMatrix[3].x * 3.7 + instanceMatrix[3].z * 1.3;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv; varying vec3 vCol; varying float vLevel; varying float vSeed;
      #include <fog_pars_fragment>
      float h(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        vec2 p = vUv;
        float rows = 11.0;
        float t = uTime * mix(0.15, 3.0, vLevel);
        float row = floor(p.y * rows + t);
        float len = 0.2 + 0.6 * h(row * 1.7 + vSeed);
        float ind = 0.08 + 0.2 * h(row * 3.1 + vSeed);
        float lineY = fract(p.y * rows + t);
        float line = step(0.32, lineY) * step(lineY, 0.7) * step(ind, p.x) * step(p.x, ind + len);
        float edge = smoothstep(0.0, 0.04, p.x) * smoothstep(0.0, 0.04, 1.0 - p.x) * smoothstep(0.0, 0.05, p.y) * smoothstep(0.0, 0.05, 1.0 - p.y);
        float frame = (1.0 - smoothstep(0.0, 0.025, min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y)))) * 0.8;
        float scan = smoothstep(0.04, 0.0, abs(fract(p.y - uTime * 0.35 + vSeed) - 0.5)) * 0.25 * vLevel;
        float on = mix(0.25, 1.15, vLevel);
        vec3 c = vCol * ((0.1 + line * 0.85 + scan) * edge + frame) * on;
        gl_FragColor = vec4(c, 1.0);
        #include <fog_fragment>
      }
    `,
    fog: true,
    toneMapped: false,
  });
}

export class ScreenSet {
  readonly mesh: THREE.InstancedMesh;
  private readonly level: THREE.InstancedBufferAttribute;
  readonly specs: ScreenSpec[];

  constructor(specs: ScreenSpec[], uTime: THREE.IUniform<number>) {
    this.specs = specs;
    const geo = new THREE.PlaneGeometry(1, 1);
    const n = Math.max(1, specs.length);
    this.level = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.level.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aLevel", this.level);
    const mat = screenMaterial(uTime);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.count = specs.length;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const c = new THREE.Color();
    specs.forEach((s, i) => {
      e.set(s.tilt, s.rotY, 0, "YXZ");
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(s.w, s.h, 1));
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, c.setHex(s.color));
      this.level.setX(i, 0);
    });
    if (!specs.length) this.mesh.setColorAt(0, c.setHex(0));
    this.mesh.computeBoundingSphere();
    this.mesh.name = "screens";
  }

  /** Set screen activity levels (0 = idle glow, 1 = busy scrolling). */
  setLevels(fn: (s: ScreenSpec, i: number) => number): boolean {
    let changed = false;
    this.specs.forEach((s, i) => {
      const v = fn(s, i);
      if (Math.abs(this.level.getX(i) - v) > 1e-3) {
        this.level.setX(i, v);
        changed = true;
      }
    });
    if (changed) this.level.needsUpdate = true;
    return changed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

// ── Contact shadows (soft radial decals) ─────────────────────────────────

export function blobTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const d = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - d, 1.6);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(a * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export interface BlobSpec {
  x: number;
  z: number;
  sx: number;
  sz: number;
  rot: number;
  a: number;
}

/** Instanced flat shadow decals (static or per-frame). */
export class BlobSet {
  readonly mesh: THREE.InstancedMesh;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private n = 0;

  constructor(capacity: number, tex: THREE.Texture, y = FLOOR_Y + 0.006, light?: { color: THREE.Color }) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, y, 0);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aAlpha", this.alpha);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: light ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
      uniforms: { uMap: { value: tex }, uColor: { value: light?.color ?? new THREE.Color(0) } },
      vertexShader: /* glsl */ `
        attribute float aAlpha; varying vec2 vUv; varying float vA;
        void main() { vUv = uv; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: light
        ? /* glsl */ `
        uniform sampler2D uMap; uniform vec3 uColor; varying vec2 vUv; varying float vA;
        void main() { float a = texture2D(uMap, vUv).r * vA; if (a < 0.004) discard; gl_FragColor = vec4(uColor * a, a); }
      `
        : /* glsl */ `
        uniform sampler2D uMap; varying vec2 vUv; varying float vA;
        void main() { float a = texture2D(uMap, vUv).r * vA; if (a < 0.004) discard; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }
      `,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
  }

  get capacity(): number {
    return this.alpha.count;
  }

  begin(): void {
    this.n = 0;
  }

  push(x: number, z: number, sx: number, sz: number, rot: number, a: number, y = 0): void {
    if (this.n >= this.capacity) return;
    tmpE.set(0, rot, 0);
    tmpQ.setFromEuler(tmpE);
    tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, 1, sz));
    this.mesh.setMatrixAt(this.n, tmpM);
    this.alpha.setX(this.n, a);
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

// ── World build ──────────────────────────────────────────────────────────

/** A desk + its seat in world space (agents type here). */
export interface DeskSpot {
  zoneId: string;
  /** Seat (agent position). */
  sx: number;
  sz: number;
  /** Heading that faces the desk from the seat. */
  heading: number;
  /** Screen index (ScreenSet) of this desk's monitor (-1 = none). */
  screen: number;
  /** Agents sit here (chairs, stools, pods); false = they stand (kiosk, mic). */
  seated: boolean;
  /** Seat height (world units above the floor) for the seated pose. */
  seatY: number;
}

/**
 * A moving part of a centerpiece / hero prop: merged geometry around a pivot,
 * spun / bobbed / swayed by the scene each frame, faster and brighter while
 * its zone is busy.
 */
export interface AnimSpec {
  zoneId: string;
  x: number;
  y: number;
  z: number;
  geos: Partial<Record<PartKind, THREE.BufferGeometry>>;
  /** Idle angular speed (rad/s) about local X / Y / Z. */
  spin?: [number, number, number];
  /** Extra spin multiplier at full intensity (default 2.5). */
  busySpin?: number;
  /** Vertical float amplitude. */
  bob?: number;
  /** Oscillation instead of a full turn: axis, amplitude (rad), frequency (Hz-ish). */
  sway?: { axis: "x" | "y" | "z"; amp: number; freq: number };
  /** Static base orientation (applied before spin). */
  rot?: [number, number, number];
}

/** Additive light pool on the floor (district lighting). */
export interface PoolSpec {
  x: number;
  z: number;
  r: number;
  a: number;
  zoneId: string;
}

export interface DoorSpot {
  x: number;
  z: number;
}

export interface WorldBuild {
  kits: KitPlacement[];
  screens: ScreenSpec[];
  blobs: BlobSpec[];
  desks: DeskSpot[];
  /** Door points per zone (room edge midpoints; walkers route through them). */
  doors: Map<string, DoorSpot[]>;
  /** Label anchor height per zone (above the tallest thing the sign belongs to). */
  labelY: Map<string, number>;
  /** Moving centerpiece parts. */
  anims: AnimSpec[];
  /** Floor light pools. */
  pools: PoolSpec[];
  /** Where each zone's centerpiece "lives" (data streams flow here). */
  hubs: Map<string, { x: number; y: number; z: number }>;
  /** zone id → index into the shared per-zone intensity uniform. */
  zoneIndex: Map<string, number>;
}

// ── Glow sprites (additive billboards, one draw call) ────────────────────

export class GlowSprites {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aOffset: THREE.InstancedBufferAttribute;
  private readonly aSize: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private count = 0;

  constructor(readonly capacity: number) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = base.index;
    this.geometry.setAttribute("position", base.getAttribute("position"));
    this.geometry.setAttribute("uv", base.getAttribute("uv"));
    base.dispose();
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    for (const a of [this.aOffset, this.aSize, this.aColor]) a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aOffset", this.aOffset);
    this.geometry.setAttribute("aSize", this.aSize);
    this.geometry.setAttribute("aColor", this.aColor);
    this.geometry.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset; attribute float aSize; attribute vec4 aColor;
        varying vec2 vUv; varying vec4 vColor;
        void main() {
          vUv = uv; vColor = aColor;
          vec4 mv = viewMatrix * vec4(aOffset, 1.0);
          mv.xy += position.xy * aSize;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec4 vColor;
        void main() {
          float d = length(vUv * 2.0 - 1.0);
          float a = pow(max(0.0, 1.0 - d), 2.4) * vColor.a;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor.rgb * a, a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  begin(): void {
    this.count = 0;
  }

  push(x: number, y: number, z: number, size: number, color: THREE.Color, alpha: number): void {
    if (this.count >= this.capacity || alpha <= 0.003) return;
    const i = this.count++;
    this.aOffset.setXYZ(i, x, y, z);
    this.aSize.setX(i, size);
    this.aColor.setXYZW(i, color.r, color.g, color.b, alpha);
  }

  end(): void {
    this.geometry.instanceCount = this.count;
    for (const a of [this.aOffset, this.aSize, this.aColor]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
