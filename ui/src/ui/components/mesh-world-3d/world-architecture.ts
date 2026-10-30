/**
 * Architecture for the 3D Agent Mesh: every core district gets its own
 * signature form + animated centerpiece, every plugin building its own
 * silhouette + hero prop — all in the theme palette (obsidian / brushed metal /
 * ONE accent), never per-room rainbow colours.
 *
 *   Command Atrium      holo-table with a rotating globe + federation rings
 *   Mission Control     curved screen wall, two tiers of consoles
 *   Comms Deck          dish array on a yoke + signal mast
 *   Agent Quarters      lounge pods around a floating hearth crystal
 *   Observatory         rotating dome with a telescope through its slit
 *   Broadcast Studio    stage + backdrop wall, cameras, swaying light rig
 *   The Vault           circular vault door with a turning dial, key pedestal
 *   Engineering Bay     server towers with light flowing up them
 *   Gateway Concourse   portal arch with a spinning flow ring, rest pods
 *   Canvas Atrium       floating holo-sculpture on a plinth, drafting tables
 *
 * Static parts merge into the shared per-material meshes (one draw call per
 * material for the whole station); each moving part is one AnimSpec the scene
 * spins. Glow / flow parts carry their zone index, so a busy district lights
 * up (shared uniform array — no extra draw calls).
 */
import * as THREE from "three";
import type { WorldZone } from "../../views/agent-ops/mesh-world-model";
import { deskSeats } from "../../views/agent-ops/mesh-world-model";
import {
  FLOOR_Y,
  MAX_ZONES,
  StaticBuilder,
  buildingHeight,
  rbox,
  toX,
  toZ,
  type AnimSpec,
  type ScreenSpec,
  type WorldBuild,
} from "./world-geometry";
import { mix, type WorldTheme } from "./world-theme";

const F = FLOOR_Y;
const DESK_S = 1.25;
const SEAT_Y: Record<string, number> = { console: 0.52, table: 0.55, pod: 0.5, drafting: 0.52 };

type Ctx = {
  b: StaticBuilder;
  out: WorldBuild;
  z: WorldZone;
  P: WorldTheme;
  /** zone-relative tile → world x / z */
  X: (c: number) => number;
  Z: (r: number) => number;
};

/** Build a moving part around a pivot (local coordinates inside `fn`). */
function anim(ctx: Ctx, x: number, y: number, z: number, fn: (ab: StaticBuilder) => void, opts: Omit<AnimSpec, "zoneId" | "x" | "y" | "z" | "geos"> = {}): void {
  const ab = new StaticBuilder();
  ab.zone = ctx.b.zone;
  fn(ab);
  if (ab.empty) return;
  ctx.out.anims.push({ zoneId: ctx.z.id, x, y, z, geos: ab.geometries(), ...opts });
}

const screen = (ctx: Ctx, s: Omit<ScreenSpec, "zoneId" | "desk" | "color"> & { color?: number; desk?: number }): number => {
  ctx.out.screens.push({ ...s, color: s.color ?? ctx.P.accent, zoneId: ctx.z.id, desk: s.desk ?? -1 });
  return ctx.out.screens.length - 1;
};

const pool = (ctx: Ctx, x: number, z: number, r: number, a = 0.5) => ctx.out.pools.push({ x, z, r, a, zoneId: ctx.z.id });

// ── Room shell ───────────────────────────────────────────────────────────

/** Glass partition along one room edge with a door gap in the middle. */
function partition(ctx: Ctx, x0: number, z0: number, len: number, alongX: boolean, h: number): void {
  const { b, P } = ctx;
  const gap = 1.7;
  const seg = (len - gap) / 2;
  for (const s of [0, 1]) {
    const start = s === 0 ? 0 : seg + gap;
    const mid = start + seg / 2;
    const px = alongX ? x0 + mid : x0;
    const pz = alongX ? z0 : z0 + mid;
    b.add("glass", new THREE.BoxGeometry(alongX ? seg - 0.06 : 0.03, h, alongX ? 0.03 : seg - 0.06), P.glass, px, F + h / 2, pz);
    b.add("metal", new THREE.BoxGeometry(alongX ? seg : 0.04, 0.03, alongX ? 0.04 : seg), P.metalHi, px, F + h, pz);
    b.add("glow", new THREE.BoxGeometry(alongX ? seg - 0.1 : 0.012, 0.012, alongX ? 0.012 : seg - 0.1), P.accentDeep, px, F + 0.03, pz);
    for (const e of [start, start + seg]) b.add("metal", new THREE.BoxGeometry(0.05, h, 0.05), P.metal, alongX ? x0 + e : x0, F + h / 2, alongX ? z0 : z0 + e);
  }
}

/** Solid back wall along an outer edge: obsidian panels, accent light strip, slim fins. */
function backWall(ctx: Ctx, x0: number, z0: number, len: number, alongX: boolean, h = 1.5): void {
  const { b, P } = ctx;
  const t = 0.16;
  const cx = alongX ? x0 + len / 2 : x0;
  const cz = alongX ? z0 : z0 + len / 2;
  b.add("body", rbox(alongX ? len : t, h, alongX ? t : len, 0.03), P.body, cx, F + h / 2, cz);
  b.add("metal", new THREE.BoxGeometry(alongX ? len + 0.02 : t + 0.03, 0.035, alongX ? t + 0.03 : len + 0.02), P.metalHi, cx, F + h, cz);
  const off = 0.085;
  b.add("glow", new THREE.BoxGeometry(alongX ? len - 0.4 : 0.012, 0.018, alongX ? 0.012 : len - 0.4), P.accent, alongX ? cx : cx + off, F + h * 0.86, alongX ? cz + off : cz);
  const n = Math.max(2, Math.round(len / 1.6));
  for (let i = 1; i < n; i++) {
    const e = (i / n) * len;
    b.add("metal", new THREE.BoxGeometry(alongX ? 0.03 : 0.05, h * 0.8, alongX ? 0.05 : 0.03), P.metal, alongX ? x0 + e : x0 + off, F + h * 0.42, alongX ? z0 + off : z0 + e);
  }
}

/** Low glass balustrade along a camera-facing edge. */
function balustrade(ctx: Ctx, x0: number, z0: number, len: number, alongX: boolean): void {
  const { b, P } = ctx;
  const cx = alongX ? x0 + len / 2 : x0;
  const cz = alongX ? z0 : z0 + len / 2;
  b.add("glass", new THREE.BoxGeometry(alongX ? len : 0.025, 0.34, alongX ? 0.025 : len), P.glass, cx, F + 0.17, cz);
  b.add("metal", new THREE.BoxGeometry(alongX ? len : 0.04, 0.025, alongX ? 0.04 : len), P.metalHi, cx, F + 0.35, cz);
}

/** Inlay lines (unlit, follow zone intensity). */
function inlayRect(ctx: Ctx, cx: number, cz: number, w: number, d: number, color: number, t = 0.03): void {
  const { b } = ctx;
  b.add("glow", new THREE.BoxGeometry(w, 0.01, t), color, cx, F + 0.009, cz - d / 2);
  b.add("glow", new THREE.BoxGeometry(w, 0.01, t), color, cx, F + 0.009, cz + d / 2);
  b.add("glow", new THREE.BoxGeometry(t, 0.01, d), color, cx - w / 2, F + 0.009, cz);
  b.add("glow", new THREE.BoxGeometry(t, 0.01, d), color, cx + w / 2, F + 0.009, cz);
}

const inlayRing = (ctx: Ctx, x: number, z: number, r: number, color: number, t = 0.022) =>
  ctx.b.add("glow", new THREE.TorusGeometry(r, t, 3, Math.max(24, Math.round(r * 24))), color, x, F + 0.009, z, 0, [1, 1, 0.2], Math.PI / 2);

// ── Core districts ───────────────────────────────────────────────────────

function commandAtrium(ctx: Ctx): void {
  const { b, P, X, Z } = ctx;
  const cx = X(4);
  const cz = Z(4);
  // Stepped round dais + pedestal + polished table top with a light ring.
  b.add("body", new THREE.CylinderGeometry(1.75, 1.85, 0.1, 48), P.bodyHi, cx, F + 0.05, cz);
  b.add("metal", new THREE.TorusGeometry(1.8, 0.02, 4, 64), P.accent, cx, F + 0.1, cz, 0, undefined, Math.PI / 2);
  b.add("body", new THREE.CylinderGeometry(0.55, 0.7, 0.72, 32), P.body, cx, F + 0.46, cz);
  b.add("metal", new THREE.CylinderGeometry(1.28, 1.22, 0.07, 48), P.metal, cx, F + 0.85, cz);
  b.add("glow", new THREE.TorusGeometry(1.24, 0.02, 4, 64), P.accent, cx, F + 0.89, cz, 0, undefined, Math.PI / 2);
  b.add("glow", new THREE.CylinderGeometry(1.05, 1.05, 0.01, 48), P.accentDeep, cx, F + 0.89, cz);
  // Light cone up into the hologram.
  b.add("glow", new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), P.accent, cx, F + 1.12, cz);
  // Floor: concentric rings + radial spokes.
  for (const r of [2.6, 3.3]) inlayRing(ctx, cx, cz, r, P.accentDeep);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.add("glow", new THREE.BoxGeometry(0.02, 0.01, 0.8), P.accentDeep, cx + Math.cos(a) * 2.2, F + 0.009, cz + Math.sin(a) * 2.2, Math.PI / 2 - a);
  }
  pool(ctx, cx, cz, 4.2, 0.55);
  // Globe: dark sphere, latitude + meridian rings, orbiting nodes.
  const gy = F + 1.75;
  anim(ctx, cx, gy, cz, (a) => {
    a.add("metal", new THREE.SphereGeometry(0.42, 28, 18), P.body, 0, 0, 0);
    for (const lat of [-0.5, 0, 0.5]) {
      const r = Math.cos(lat) * 0.45;
      a.add("glow", new THREE.TorusGeometry(r, 0.008, 3, 48), P.accent, 0, Math.sin(lat) * 0.45, 0, 0, undefined, Math.PI / 2);
    }
    for (let i = 0; i < 3; i++) a.add("glow", new THREE.TorusGeometry(0.45, 0.007, 3, 48), P.accentHi, 0, 0, 0, (i / 3) * Math.PI);
  }, { spin: [0, 0.3, 0], busySpin: 3, bob: 0.06 });
  // Federation ring (tilted, counter-rotating) with node beads.
  anim(ctx, cx, gy, cz, (a) => {
    a.add("glow", new THREE.TorusGeometry(0.95, 0.012, 3, 96), P.accent, 0, 0, 0, 0, undefined, Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * Math.PI * 2;
      a.add("glow", new THREE.OctahedronGeometry(0.06, 0), P.accentHi, Math.cos(t) * 0.95, 0, Math.sin(t) * 0.95);
    }
  }, { spin: [0, -0.45, 0], busySpin: 2.5, rot: [0.42, 0, 0.18] });
  anim(ctx, cx, gy, cz, (a) => {
    a.add("glow", new THREE.TorusGeometry(1.15, 0.006, 3, 96), P.tint, 0, 0, 0, 0, undefined, Math.PI / 2);
  }, { spin: [0, 0.22, 0], rot: [-0.3, 0, -0.25] });
  ctx.out.hubs.set(ctx.z.id, { x: cx, y: gy, z: cz });
  ctx.out.labelY.set(ctx.z.id, F + 3.0);
}

function missionControl(ctx: Ctx): void {
  const { b, P, X, Z } = ctx;
  // Curved screen wall: panels on an arc around the room centre.
  const R = 5.4;
  const ox = X(4);
  const oz = Z(0.55) + R;
  const n = 5;
  const span = 1.05;
  for (let i = 0; i < n; i++) {
    const a = -span / 2 + (i / (n - 1)) * span;
    const px = ox + Math.sin(a) * R;
    const pz = oz - Math.cos(a) * R;
    const rot = -a;
    b.add("body", rbox(1.18, 2.15, 0.14, 0.03), P.body, px, F + 1.2, pz, rot);
    b.add("metal", new THREE.BoxGeometry(1.2, 0.03, 0.16), P.metalHi, px, F + 2.3, pz, rot);
    const fx = Math.sin(rot) * 0.08;
    const fz = Math.cos(rot) * 0.08;
    screen(ctx, { x: px + fx, y: F + 1.55, z: pz + fz, rotY: rot, tilt: 0, w: 1.06, h: 0.95 });
    screen(ctx, { x: px + fx, y: F + 0.72, z: pz + fz, rotY: rot, tilt: 0, w: 1.06, h: 0.55, color: P.accentDeep });
  }
  // Header light bar over the wall.
  b.add("glow", new THREE.TorusGeometry(R, 0.02, 3, 64, span + 0.2), P.accent, ox, F + 2.42, oz, 0, undefined, Math.PI / 2, -Math.PI / 2 - (span + 0.2) / 2);
  // Rear tier riser.
  b.add("body", rbox(4.4, 0.08, 2.0, 0.03), P.bodyHi, X(4), F + 0.04, Z(5.45));
  b.add("glow", new THREE.BoxGeometry(4.3, 0.012, 0.02), P.accent, X(4), F + 0.08, Z(4.45));
  // Floor: linear runway stripes toward the wall.
  for (const c of [1.0, 7.0]) b.add("glow", new THREE.BoxGeometry(0.025, 0.01, 6.2), P.accentDeep, X(c), F + 0.009, Z(4.2));
  // Radar ring floating above the floor in front of the wall.
  anim(ctx, X(4), F + 2.75, Z(2.2), (a) => {
    a.add("glow", new THREE.TorusGeometry(0.55, 0.01, 3, 64, Math.PI * 1.5), P.accent, 0, 0, 0, 0, undefined, Math.PI / 2);
    a.add("glow", new THREE.BoxGeometry(0.55, 0.008, 0.02), P.accentHi, 0.275, 0, 0);
  }, { spin: [0, 1.2, 0], busySpin: 2 });
  pool(ctx, X(4), Z(2.2), 3.4, 0.4);
  ctx.out.hubs.set(ctx.z.id, { x: X(4), y: F + 2.75, z: Z(2.2) });
  ctx.out.labelY.set(ctx.z.id, F + 3.1);
}

function commsDeck(ctx: Ctx): void {
  const { b, P, X, Z } = ctx;
  const dx = X(5.6);
  const dz = Z(2.0);
  // Dish pedestal.
  b.add("body", new THREE.CylinderGeometry(0.7, 0.85, 0.3, 32), P.bodyHi, dx, F + 0.15, dz);
  b.add("glow", new THREE.TorusGeometry(0.78, 0.015, 3, 48), P.accent, dx, F + 0.31, dz, 0, undefined, Math.PI / 2);
  b.add("metal", new THREE.CylinderGeometry(0.16, 0.22, 1.3, 16), P.metal, dx, F + 0.95, dz);
  // Dish on a yoke — turns to track.
  anim(ctx, dx, F + 1.65, dz, (a) => {
    a.add("metal", new THREE.BoxGeometry(0.9, 0.08, 0.12), P.metalHi, 0, 0, 0);
    for (const s of [-1, 1]) a.add("metal", new THREE.BoxGeometry(0.06, 0.5, 0.1), P.metalHi, s * 0.45, 0.22, 0);
    a.add("metal", new THREE.SphereGeometry(1.0, 32, 10, 0, Math.PI * 2, 0, 0.62), P.metalHi, 0, 0.55, 0, 0, undefined, -Math.PI * 0.62);
    a.add("body", new THREE.SphereGeometry(0.985, 32, 10, 0, Math.PI * 2, 0, 0.6), P.body, 0, 0.56, 0.01, 0, undefined, -Math.PI * 0.62);
    a.add("metal", new THREE.CylinderGeometry(0.015, 0.015, 0.9, 6), P.metal, 0, 0.75, 0.42, 0, undefined, 0.95);
    a.add("glow", new THREE.SphereGeometry(0.06, 12, 8), P.accentHi, 0, 1.0, 0.75);
  }, { sway: { axis: "y", amp: 0.9, freq: 0.08 }, busySpin: 3 });
  // Signal mast with stacked rings.
  const mx = X(2.0);
  const mz = Z(1.8);
  b.add("body", new THREE.CylinderGeometry(0.32, 0.4, 0.2, 24), P.bodyHi, mx, F + 0.1, mz);
  b.add("metal", new THREE.CylinderGeometry(0.05, 0.08, 3.0, 10), P.metalHi, mx, F + 1.6, mz);
  anim(ctx, mx, F + 1.6, mz, (a) => {
    for (const [y, r] of [[-0.9, 0.42], [-0.2, 0.34], [0.5, 0.26], [1.1, 0.18]] as const) a.add("glow", new THREE.TorusGeometry(r, 0.012, 3, 40), P.accent, 0, y, 0, 0, undefined, Math.PI / 2);
  }, { spin: [0, 0.5, 0], bob: 0.05 });
  // Wave arcs on the floor.
  for (const r of [1.6, 2.3, 3.0]) ctx.b.add("glow", new THREE.TorusGeometry(r, 0.02, 3, 48, Math.PI * 0.6), P.accentDeep, dx, F + 0.009, dz, 0, [1, 1, 0.2], Math.PI / 2, 0);
  pool(ctx, dx, dz, 2.8, 0.45);
  ctx.out.hubs.set(ctx.z.id, { x: dx, y: F + 2.4, z: dz });
  ctx.out.labelY.set(ctx.z.id, F + 3.4);
}

function agentQuarters(ctx: Ctx): void {
  const { b, P, X, Z } = ctx;
  const cx = X(4);
  const cz = Z(4);
  // Sunken lounge rug + low round table with a floating hearth crystal.
  b.add("floor", new THREE.CylinderGeometry(2.6, 2.6, 0.012, 48), mix(P.floor, P.bodyHi, 0.6), cx, F + 0.006, cz);
  inlayRing(ctx, cx, cz, 2.6, P.accentDeep);
  b.add("body", new THREE.CylinderGeometry(0.62, 0.66, 0.34, 32), P.bodyHi, cx, F + 0.17, cz);
  b.add("metal", new THREE.TorusGeometry(0.63, 0.015, 3, 40), P.accent, cx, F + 0.34, cz, 0, undefined, Math.PI / 2);
  b.add("glow", new THREE.CylinderGeometry(0.4, 0.4, 0.01, 32), P.accentDeep, cx, F + 0.345, cz);
  anim(ctx, cx, F + 0.95, cz, (a) => {
    a.add("glow", new THREE.OctahedronGeometry(0.22, 0), P.accentHi, 0, 0, 0, 0, [1, 1.6, 1]);
    a.add("glow", new THREE.TorusGeometry(0.36, 0.006, 3, 40), P.accent, 0, -0.2, 0, 0, undefined, Math.PI / 2);
  }, { spin: [0, 0.4, 0], bob: 0.08 });
  // Soft wall lights on the back wall.
  for (const c of [2, 4, 6]) b.add("glow", new THREE.BoxGeometry(0.5, 0.02, 0.02), P.accent, X(c), F + 0.9, Z(0.2));
  pool(ctx, cx, cz, 3.2, 0.35);
  ctx.out.hubs.set(ctx.z.id, { x: cx, y: F + 0.95, z: cz });
  ctx.out.labelY.set(ctx.z.id, F + 2.2);
}

function observatory(ctx: Ctx): void {
  const { b, P, X, Z } = ctx;
  const cx = X(2.8);
  const cz = Z(2.8);
  // Drum + gallery ring.
  b.add("body", new THREE.CylinderGeometry(1.75, 1.85, 1.0, 48), P.body, cx, F + 0.5, cz);
  b.add("metal", new THREE.TorusGeometry(1.78, 0.03, 4, 64), P.metalHi, cx, F + 1.0, cz, 0, undefined, Math.PI / 2);
  b.add("glow", new THREE.TorusGeometry(1.86, 0.015, 3, 64), P.accent, cx, F + 0.12, cz, 0, undefined, Math.PI / 2);
  // Rotating dome with an open slit + telescope through it.
  anim(ctx, cx, F + 1.0, cz, (a) => {
    a.add("metal", new THREE.SphereGeometry(1.7, 40, 16, 0.35, Math.PI * 2 - 0.7, 0, Math.PI / 2), P.metalHi, 0, 0, 0);
    a.add("body", new THREE.SphereGeometry(1.66, 40, 16, 0.35, Math.PI * 2 - 0.7, 0, Math.PI / 2), P.body, 0, 0, 0, 0, undefined, 0, 0);
    for (const s of [-1, 1]) a.add("glow", new THREE.TorusGeometry(1.71, 0.012, 3, 40, Math.PI / 2), P.accent, s * 0.0, 0, 0, s * 0.35 - Math.PI / 2, undefined, 0, -Math.PI / 2);
    a.add("metal", new THREE.CylinderGeometry(0.2, 0.26, 2.4, 20), P.metal, 0, 0.9, 0.6, 0, undefined, 0.75);
    a.add("glow", new THREE.TorusGeometry(0.2, 0.02, 4, 24), P.accentHi, 0, 1.75, 1.42, 0, undefined, 0.75 + Math.PI / 2);
    a.add("glass", new THREE.CircleGeometry(0.19, 24), P.glass, 0, 1.76, 1.43, 0, undefined, 0.75 - Math.PI / 2);
  }, { spin: [0, 0.06, 0], busySpin: 4 });
  // Star-chart floor: scattered points + an orbit ring.
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 22; i++) {
    const c = 4.6 + rnd() * 2.8;
    const r = 0.8 + rnd() * 6.4;
    if (c < 5.2 && r < 5.2) continue;
    b.add("glow", new THREE.CircleGeometry(0.03 + rnd() * 0.03, 6), P.accentHi, X(c), F + 0.01, Z(r), 0, undefined, -Math.PI / 2);
  }
  inlayRing(ctx, cx, cz, 2.5, P.accentDeep);
  anim(ctx, cx, F + 3.0, cz, (a) => {
    a.add("glow", new THREE.TorusGeometry(2.2, 0.006, 3, 96), P.tint, 0, 0, 0, 0, undefined, Math.PI / 2);
    a.add("glow", new THREE.SphereGeometry(0.07, 10, 8), P.accentHi, 2.2, 0, 0);
  }, { spin: [0, 0.25, 0], rot: [0.2, 0, 0.1] });
  pool(ctx, cx, cz, 3.6, 0.4);
  ctx.out.hubs.set(ctx.z.id, { x: cx, y: F + 2.8, z: cz });
  ctx.out.labelY.set(ctx.z.id, F + 3.6);
}

function broadcastStudio(ctx: Ctx): void {
  const { b, P, X, Z } = ctx;
  // Stage platform with stepped front edge and a backdrop screen wall.
  b.add("body", rbox(3.0, 0.16, 1.4, 0.04), P.bodyHi, X(2.0), F + 0.08, Z(1.0));
  b.add("glow", new THREE.BoxGeometry(2.9, 0.012, 0.02), P.accent, X(2.0), F + 0.16, Z(1.7));
  b.add("body", rbox(3.0, 2.0, 0.12, 0.03), P.body, X(2.0), F + 1.15, Z(0.25));
  screen(ctx, { x: X(2.0), y: F + 1.25, z: Z(0.32), rotY: 0, tilt: 0, w: 2.7, h: 1.5 });
  // Light-rig truss over the stage: two posts + beam + swaying spots.
  for (const c of [0.5, 3.5]) b.add("metal", new THREE.BoxGeometry(0.07, 2.7, 0.07), P.metal, X(c), F + 1.35, Z(1.6));
  b.add("metal", new THREE.BoxGeometry(3.1, 0.07, 0.07), P.metal, X(2.0), F + 2.7, Z(1.6));
  b.add("metal", new THREE.BoxGeometry(3.1, 0.04, 0.04), P.metal, X(2.0), F + 2.55, Z(1.6));
  for (let i = 0; i < 3; i++) {
    const sx = X(1.0 + i);
    anim(ctx, sx, F + 2.6, Z(1.6), (a) => {
      a.add("metal", new THREE.CylinderGeometry(0.09, 0.12, 0.26, 14), P.metalHi, 0, -0.15, 0, 0, undefined, 0.5);
      a.add("glow", new THREE.CylinderGeometry(0.02, 0.6, 2.2, 20, 1, true), P.accentDeep, 0, -1.25, -0.55, 0, undefined, 0.5);
    }, { sway: { axis: "z", amp: 0.35, freq: 0.25 + i * 0.07 } });
  }
  // Cameras on tripods aimed at the stage.
  for (const r of [1.2, 2.6]) {
    const cx = X(4.7);
    const cz = Z(r);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      b.add("metal", new THREE.CylinderGeometry(0.015, 0.015, 1.0, 5), P.metal, cx + Math.sin(a) * 0.16, F + 0.48, cz + Math.cos(a) * 0.16, a, undefined, 0.2);
    }
    anim(ctx, cx, F + 1.02, cz, (a) => {
      a.add("body", rbox(0.4, 0.28, 0.28, 0.05), P.bodyHi, 0, 0, 0);
      a.add("metal", new THREE.CylinderGeometry(0.1, 0.12, 0.22, 16), P.metal, -0.3, 0, 0, 0, undefined, 0, Math.PI / 2);
      a.add("glow", new THREE.SphereGeometry(0.03, 8, 6), P.accentHi, 0.12, 0.17, 0.1);
    }, { sway: { axis: "y", amp: 0.25, freq: 0.15 + r * 0.03 } });
  }
  pool(ctx, X(2.0), Z(1.6), 2.4, 0.55);
  ctx.out.hubs.set(ctx.z.id, { x: X(2.0), y: F + 1.4, z: Z(0.6) });
  ctx.out.labelY.set(ctx.z.id, F + 3.1);
}

function vault(ctx: Ctx): void {
  const { b, P, X, Z } = ctx;
  const vx = X(4);
  const vz = Z(0.42);
  const vy = F + 1.25;
  // Massive frame + recessed door.
  b.add("body", rbox(3.0, 2.5, 0.5, 0.06), P.body, vx, F + 1.25, vz - 0.1);
  b.add("metal", new THREE.TorusGeometry(1.15, 0.12, 12, 48), P.metalHi, vx, vy, vz + 0.18);
  b.add("glow", new THREE.TorusGeometry(1.31, 0.015, 3, 64), P.accent, vx, vy, vz + 0.17);
  b.add("metal", new THREE.CylinderGeometry(1.02, 1.02, 0.18, 48), P.metal, vx, vy, vz + 0.12, 0, undefined, Math.PI / 2);
  // Locking bolts.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    b.add("metal", new THREE.CylinderGeometry(0.045, 0.045, 0.1, 10), P.metalHi, vx + Math.cos(a) * 0.9, vy + Math.sin(a) * 0.9, vz + 0.24, 0, undefined, Math.PI / 2);
  }
  // Turning dial wheel.
  anim(ctx, vx, vy, vz + 0.3, (a) => {
    a.add("metal", new THREE.CylinderGeometry(0.2, 0.2, 0.12, 24), P.metalHi, 0, 0, 0, 0, undefined, Math.PI / 2);
    for (let i = 0; i < 3; i++) a.add("metal", rbox(1.2, 0.06, 0.06, 0.02), P.metalHi, 0, 0, 0.04, 0, undefined, 0, (i / 3) * Math.PI);
    a.add("glow", new THREE.TorusGeometry(0.62, 0.012, 3, 48), P.accent, 0, 0, 0.06);
    a.add("glow", new THREE.TorusGeometry(0.28, 0.01, 3, 32), P.accentHi, 0, 0, 0.07);
  }, { spin: [0, 0, 0.2], busySpin: 4 });
  // Pedestal with a floating key crystal.
  const px = X(4);
  const pz = Z(2.6);
  b.add("body", new THREE.CylinderGeometry(0.28, 0.36, 0.9, 6), P.bodyHi, px, F + 0.45, pz);
  b.add("metal", new THREE.CylinderGeometry(0.32, 0.32, 0.04, 6), P.metalHi, px, F + 0.92, pz);
  anim(ctx, px, F + 1.35, pz, (a) => {
    a.add("glow", new THREE.OctahedronGeometry(0.2, 0), P.accentHi, 0, 0, 0, 0, [0.8, 1.5, 0.8]);
    a.add("glow", new THREE.TorusGeometry(0.32, 0.006, 3, 32), P.accent, 0, 0, 0, 0, undefined, Math.PI / 2);
  }, { spin: [0, 0.8, 0], bob: 0.06 });
  // Concentric squares on the floor.
  for (const s of [1.2, 1.9]) inlayRect(ctx, px, pz, s * 1.6, s, P.accentDeep, 0.02);
  pool(ctx, px, pz, 2.2, 0.5);
  ctx.out.hubs.set(ctx.z.id, { x: px, y: F + 1.35, z: pz });
  ctx.out.labelY.set(ctx.z.id, F + 2.9);
}

function engineeringBay(ctx: Ctx): void {
  const { b, out, P, X, Z } = ctx;
  // Two rows of server towers; light flows up their faces (zone-intensity flow layer).
  for (const r of [1.25, 2.95]) {
    for (const c of [1.3, 2.75, 4.2, 5.65]) {
      const x = X(c);
      const z = Z(r);
      out.kits.push({ kit: "rack", x, y: F, z, rotY: 0, scale: 1, tint: 0xffffff });
      for (const dx of [-0.24, 0, 0.24]) b.add("flow", new THREE.BoxGeometry(0.03, 2.0, 0.012), P.accent, x + dx, F + 1.18, z + 0.37);
      out.blobs.push({ x, z, sx: 1.2, sz: 1.1, rot: 0, a: 0.4 });
    }
  }
  // Overhead cable tray feeding the terminals.
  b.add("metal", new THREE.BoxGeometry(5.6, 0.06, 0.28), P.metal, X(3.5), F + 2.75, Z(2.1));
  b.add("flow", new THREE.BoxGeometry(5.5, 0.02, 0.03), P.accent, X(3.5), F + 2.71, Z(2.1));
  for (const c of [0.9, 6.1]) b.add("metal", new THREE.BoxGeometry(0.06, 2.75, 0.06), P.metal, X(c), F + 1.37, Z(2.1));
  // Floor grating stripes.
  for (let i = 0; i < 6; i++) b.add("glow", new THREE.BoxGeometry(6.2, 0.01, 0.018), P.accentDeep, X(3.5), F + 0.009, Z(3.9 + i * 0.12));
  // Coolant core: a slowly turning ring stack at the end of the rows.
  b.add("body", new THREE.CylinderGeometry(0.42, 0.5, 0.2, 24), P.bodyHi, X(7.0), F + 0.1, Z(2.1));
  anim(ctx, X(7.0), F + 1.2, Z(2.1), (a) => {
    a.add("glass", new THREE.CylinderGeometry(0.3, 0.3, 1.8, 24, 1, true), P.glass, 0, 0, 0);
    for (const y of [-0.6, 0, 0.6]) a.add("glow", new THREE.TorusGeometry(0.32, 0.012, 3, 32), P.accent, 0, y, 0, 0, undefined, Math.PI / 2);
  }, { spin: [0, 0.6, 0], busySpin: 3 });
  b.add("flow", new THREE.CylinderGeometry(0.07, 0.07, 1.7, 10), P.accent, X(7.0), F + 1.2, Z(2.1));
  pool(ctx, X(3.5), Z(2.1), 3.6, 0.35);
  ctx.out.hubs.set(ctx.z.id, { x: X(3.5), y: F + 2.75, z: Z(2.1) });
  ctx.out.labelY.set(ctx.z.id, F + 3.2);
}

function gatewayConcourse(ctx: Ctx, bedSlots: ReadonlyArray<{ c: number; r: number }>): void {
  const { b, out, P, X, Z } = ctx;
  const ax = X(4);
  const az = Z(1.3);
  const ay = F + 1.6;
  // Pylons + monumental half-ring arch.
  for (const s of [-1, 1]) {
    b.add("body", rbox(0.42, 3.0, 0.5, 0.05), P.body, ax + s * 1.65, F + 1.5, az);
    b.add("glow", new THREE.BoxGeometry(0.02, 2.6, 0.012), P.accent, ax + s * 1.65 - s * 0.22, F + 1.4, az + 0.26);
  }
  b.add("metal", new THREE.TorusGeometry(1.65, 0.16, 12, 48, Math.PI), P.metalHi, ax, F + 3.0 - 1.65 + 0.15, az);
  b.add("body", rbox(3.9, 0.22, 0.56, 0.05), P.body, ax, F + 3.08, az);
  // Portal membrane + spinning flow ring.
  b.add("glass", new THREE.CircleGeometry(1.25, 48), P.glass, ax, ay, az, 0);
  anim(ctx, ax, ay, az, (a) => {
    a.add("glow", new THREE.TorusGeometry(1.3, 0.035, 4, 72), P.accent, 0, 0, 0);
    for (let i = 0; i < 8; i++) {
      const t = (i / 8) * Math.PI * 2;
      a.add("glow", new THREE.BoxGeometry(0.16, 0.05, 0.05), P.accentHi, Math.cos(t) * 1.3, Math.sin(t) * 1.3, 0, 0, undefined, 0, t);
    }
  }, { spin: [0, 0, 0.5], busySpin: 3 });
  anim(ctx, ax, ay, az, (a) => {
    a.add("glow", new THREE.TorusGeometry(1.0, 0.008, 3, 64, Math.PI * 1.4), P.tint, 0, 0, 0);
  }, { spin: [0, 0, -0.8] });
  // Runway light lines from the portal toward the plugin district gate.
  for (const s of [-1, 1]) b.add("flow", new THREE.BoxGeometry(0.03, 0.01, 6.6), P.accent, ax + s * 0.75, F + 0.01, Z(4.8));
  // Rest pods (finished runs lie here).
  for (const s of bedSlots) {
    out.kits.push({ kit: "bed", x: toX(s.c), y: F, z: toZ(s.r), rotY: 0, scale: 1.12, tint: 0xffffff });
    out.blobs.push({ x: toX(s.c), z: toZ(s.r), sx: 1.5, sz: 0.95, rot: 0, a: 0.4 });
  }
  pool(ctx, ax, Z(1.9), 2.6, 0.6);
  ctx.out.hubs.set(ctx.z.id, { x: ax, y: ay, z: az });
  ctx.out.labelY.set(ctx.z.id, F + 3.7);
}

function canvasAtrium(ctx: Ctx): void {
  const { b, P, X, Z } = ctx;
  const cx = X(4);
  const cz = Z(2.8);
  b.add("body", new THREE.CylinderGeometry(0.85, 1.0, 0.5, 6), P.bodyHi, cx, F + 0.25, cz, Math.PI / 6);
  b.add("metal", new THREE.CylinderGeometry(0.88, 0.88, 0.03, 6), P.metalHi, cx, F + 0.51, cz, Math.PI / 6);
  b.add("glow", new THREE.TorusGeometry(0.95, 0.012, 3, 6), P.accent, cx, F + 0.53, cz, Math.PI / 6, undefined, Math.PI / 2);
  // Floating holo-sculpture.
  anim(ctx, cx, F + 1.75, cz, (a) => {
    a.add("glow", new THREE.TorusKnotGeometry(0.5, 0.045, 160, 8, 2, 3), P.accent, 0, 0, 0);
    a.add("metal", new THREE.IcosahedronGeometry(0.2, 1), P.metalHi, 0, 0, 0);
  }, { spin: [0.15, 0.45, 0], busySpin: 3, bob: 0.08 });
  // Two floating canvases orbiting the sculpture.
  anim(ctx, cx, F + 1.75, cz, (a) => {
    for (const s of [-1, 1]) {
      a.add("glass", new THREE.BoxGeometry(0.7, 0.5, 0.012), P.glass, s * 1.3, 0.1, 0, s * 0.4);
      a.add("glow", new THREE.BoxGeometry(0.72, 0.012, 0.014), P.accent, s * 1.3, -0.15, 0, s * 0.4);
    }
  }, { spin: [0, -0.25, 0] });
  // Diagonal floor inlay (a draftsman's grid).
  for (let i = -3; i <= 3; i++) b.add("glow", new THREE.BoxGeometry(0.016, 0.01, 2.2), P.accentDeep, X(4 + i * 0.9), F + 0.009, Z(4.4), Math.PI / 4);
  pool(ctx, cx, cz, 2.8, 0.5);
  ctx.out.hubs.set(ctx.z.id, { x: cx, y: F + 1.75, z: cz });
  ctx.out.labelY.set(ctx.z.id, F + 3.0);
}

// ── Plugin buildings ─────────────────────────────────────────────────────

interface Footprint {
  cx: number;
  bz: number;
  bw: number;
  bd: number;
  h: number;
  front: number;
}

/** Building silhouette per plugin theme. Returns the roofline height. */
function pluginBuilding(ctx: Ctx, fp: Footprint): number {
  const { b, P } = ctx;
  const { cx, bz, bw, bd, h, front } = fp;
  const theme = ctx.z.theme ?? "generic";
  const strip = (y: number, w = bw * 0.92, d = 0.012) => b.add("glow", new THREE.BoxGeometry(w, 0.02, d), P.accent, cx, y, front + 0.01);
  switch (theme) {
    case "media-studio": {
      // FlyPic Studio: a lens tower — cylinder with lit bands, iris crown.
      const r = Math.min(bw, bd * 1.7) / 2;
      b.add("body", new THREE.CylinderGeometry(r, r * 1.04, h, 40), P.body, cx, F + h / 2, bz);
      for (let i = 1; i < 4; i++) b.add("glow", new THREE.TorusGeometry(r + 0.01, 0.012, 3, 64), P.accent, cx, F + (h * i) / 4, bz, 0, undefined, Math.PI / 2);
      b.add("metal", new THREE.TorusGeometry(r, 0.08, 8, 48), P.metalHi, cx, F + h, bz, 0, undefined, Math.PI / 2);
      anim(ctx, cx, F + h + 0.12, bz, (a) => {
        for (let i = 0; i < 8; i++) {
          const t = (i / 8) * Math.PI * 2;
          a.add("metal", new THREE.BoxGeometry(r * 0.75, 0.04, r * 0.32), P.metal, Math.cos(t) * r * 0.48, 0, Math.sin(t) * r * 0.48, -t + 0.5);
        }
        a.add("glow", new THREE.CircleGeometry(r * 0.28, 24), P.accentHi, 0, 0.01, 0, 0, undefined, -Math.PI / 2);
      }, { spin: [0, 0.35, 0], busySpin: 3 });
      return h + 0.2;
    }
    case "trading-floor": {
      // InfiniTrade: stepped glass tower with a ticker band streaming up the front.
      const tiers = 3;
      for (let i = 0; i < tiers; i++) {
        const k = 1 - i * 0.22;
        const th = h / tiers;
        b.add("body", rbox(bw * k, th, bd * k, 0.05), P.body, cx, F + th * (i + 0.5), bz);
        b.add("glass", new THREE.BoxGeometry(bw * k * 0.9, th * 0.7, 0.02), P.glass, cx, F + th * (i + 0.5), bz + (bd * k) / 2 + 0.01);
        b.add("metal", new THREE.BoxGeometry(bw * k + 0.04, 0.04, bd * k + 0.04), P.metalHi, cx, F + th * (i + 1), bz);
      }
      b.add("flow", new THREE.BoxGeometry(0.16, h * 0.95, 0.02), P.accent, cx, F + h * 0.48, front + 0.03);
      return h + 0.1;
    }
    case "fleet": {
      // Droid Swarm: hangar with a vaulted roof and a lit landing pad on top.
      const r = bw / 2;
      b.add("body", rbox(bw, h * 0.45, bd, 0.06), P.body, cx, F + h * 0.225, bz);
      b.add("body", new THREE.CylinderGeometry(r, r, bd, 32, 1, false, 0, Math.PI), P.bodyHi, cx, F + h * 0.45, bz, Math.PI / 2, [1, 0.55, 1], Math.PI / 2);
      for (let i = 0; i < 5; i++) b.add("metal", new THREE.TorusGeometry(r, 0.025, 4, 32, Math.PI), P.metalHi, cx, F + h * 0.45, bz - bd / 2 + (bd * (i + 0.5)) / 5, 0, [1, 0.55, 1]);
      b.add("glass", new THREE.BoxGeometry(bw * 0.7, h * 0.32, 0.02), P.glass, cx, F + h * 0.2, front + 0.01);
      strip(F + h * 0.43);
      return h * 0.45 + r * 0.55;
    }
    case "holo-gallery": {
      // HoloCanvas: stacked offset gallery boxes with cantilevered glass frames.
      b.add("body", rbox(bw * 0.8, h * 0.55, bd, 0.05), P.body, cx - bw * 0.08, F + h * 0.275, bz);
      b.add("body", rbox(bw * 0.7, h * 0.45, bd * 0.9, 0.05), P.bodyHi, cx + bw * 0.12, F + h * 0.775, bz - 0.05);
      b.add("glass", new THREE.BoxGeometry(bw * 0.6, h * 0.34, 0.02), P.glass, cx + bw * 0.12, F + h * 0.78, bz + bd * 0.45 - 0.03);
      b.add("glow", new THREE.BoxGeometry(bw * 0.62, 0.02, 0.02), P.accent, cx + bw * 0.12, F + h * 0.56, bz + bd * 0.45);
      strip(F + h * 0.05, bw * 0.7);
      return h;
    }
    case "dojo": {
      // Discipline Dojo: pagoda — three tiers of thin wide roofs over a slim core.
      b.add("body", rbox(bw * 0.55, h, bd * 0.7, 0.04), P.body, cx, F + h / 2, bz);
      for (let i = 0; i < 3; i++) {
        const y = F + h * (0.36 + i * 0.3);
        const k = 1.05 - i * 0.2;
        b.add("metal", rbox(bw * k, 0.07, bd * k * 1.25, 0.03), P.metalHi, cx, y, bz);
        b.add("glow", new THREE.BoxGeometry(bw * k * 0.96, 0.015, 0.015), P.accent, cx, y - 0.05, bz + (bd * k * 1.25) / 2);
      }
      b.add("metal", new THREE.ConeGeometry(0.08, 0.6, 8), P.metalHi, cx, F + h + 0.3, bz);
      return h + 0.6;
    }
    case "boardroom": {
      // Agency Boardroom: obsidian monolith with vertical brushed fins.
      b.add("body", rbox(bw * 0.8, h * 1.15, bd * 0.8, 0.05), P.body, cx, F + h * 0.575, bz);
      const n = 9;
      for (let i = 0; i < n; i++) b.add("metal", new THREE.BoxGeometry(0.035, h * 1.08, 0.12), P.metalHi, cx - bw * 0.38 + (bw * 0.76 * i) / (n - 1), F + h * 0.56, bz + bd * 0.4 + 0.05);
      strip(F + h * 1.12, bw * 0.78);
      b.add("glow", new THREE.BoxGeometry(bw * 0.3, 0.6, 0.012), P.accentDeep, cx, F + 0.5, front - bd * 0.1 + 0.07);
      return h * 1.15;
    }
    case "terminal-vault": {
      // Solatrix: faceted prism tower crowned with a crystal.
      b.add("body", new THREE.CylinderGeometry(bw * 0.28, bw * 0.42, h, 6), P.body, cx, F + h / 2, bz, Math.PI / 6);
      for (let i = 0; i < 6; i++) {
        const t = (i / 6) * Math.PI * 2 + Math.PI / 6;
        b.add("glow", new THREE.BoxGeometry(0.014, h * 0.96, 0.014), P.accent, cx + Math.cos(t) * bw * 0.35, F + h / 2, bz + Math.sin(t) * bw * 0.35, 0, undefined, Math.cos(t) * -0.06, Math.sin(t) * 0.06);
      }
      anim(ctx, cx, F + h + 0.45, bz, (a) => {
        a.add("glow", new THREE.OctahedronGeometry(0.32, 0), P.accentHi, 0, 0, 0, 0, [1, 1.4, 1]);
      }, { spin: [0, 0.6, 0], bob: 0.05 });
      return h + 0.9;
    }
    case "voice-studio": {
      // Voice studio: rounded pill hall with waveform fins on the roof.
      b.add("body", new THREE.CapsuleGeometry(bd * 0.5, bw - bd, 6, 24), P.body, cx, F + bd * 0.5, bz, 0, [1, h / bd, 1], 0, Math.PI / 2);
      const n = 11;
      for (let i = 0; i < n; i++) {
        const fh = 0.2 + Math.abs(Math.sin(i * 1.3)) * 0.7;
        b.add("flow", new THREE.BoxGeometry(0.06, fh, 0.06), P.accent, cx - bw * 0.35 + (bw * 0.7 * i) / (n - 1), F + h + fh / 2 - 0.05, bz);
      }
      return h + 0.8;
    }
    case "clinic": {
      // Clinic + lab: cross-plan block with a glass core.
      b.add("body", rbox(bw, h * 0.7, bd * 0.5, 0.05), P.body, cx, F + h * 0.35, bz);
      b.add("body", rbox(bw * 0.4, h, bd, 0.05), P.bodyHi, cx, F + h / 2, bz);
      b.add("glass", new THREE.BoxGeometry(bw * 0.3, h * 0.8, 0.02), P.glass, cx, F + h * 0.45, bz + bd / 2 + 0.01);
      strip(F + h * 0.7 + 0.02, bw * 0.98);
      return h;
    }
    case "content-lab": {
      // Content lab: three offset, slightly twisted stacked volumes.
      for (let i = 0; i < 3; i++) {
        const th = h / 3;
        b.add("body", rbox(bw * (0.85 - i * 0.1), th * 0.96, bd * (0.95 - i * 0.08), 0.05), i % 2 ? P.bodyHi : P.body, cx + (i - 1) * 0.18, F + th * (i + 0.5), bz, (i - 1) * 0.12);
        b.add("glow", new THREE.BoxGeometry(bw * (0.8 - i * 0.1), 0.018, 0.015), P.accent, cx + (i - 1) * 0.18, F + th * (i + 1) - 0.04, bz + bd * (0.95 - i * 0.08) / 2 + 0.01, (i - 1) * 0.12);
      }
      return h;
    }
    case "showroom": {
      // Showroom: low glass pavilion under a cantilevered blade roof.
      const ph = h * 0.55;
      b.add("glass", new THREE.BoxGeometry(bw * 0.9, ph, bd * 0.9), P.glass, cx, F + ph / 2, bz);
      b.add("body", rbox(bw * 0.3, ph, bd * 0.5, 0.04), P.body, cx - bw * 0.25, F + ph / 2, bz - bd * 0.1);
      b.add("metal", rbox(bw * 1.15, 0.08, bd * 1.25, 0.03), P.metalHi, cx + 0.15, F + ph + 0.04, bz + 0.1);
      b.add("glow", new THREE.BoxGeometry(bw * 1.1, 0.015, 0.015), P.accent, cx + 0.15, F + ph, bz + 0.1 + bd * 0.62);
      return ph + 0.1;
    }
    case "drawing-studio": {
      // Drawing studio: A-frame with a glazed gable.
      for (const s of [-1, 1]) b.add("body", rbox(bw * 0.62, 0.1, bd, 0.03), P.body, cx + s * bw * 0.22, F + h * 0.45, bz, 0, undefined, 0, -s * 0.95);
      b.add("glass", new THREE.CylinderGeometry(0.01, bw * 0.48, h * 0.85, 3, 1, false), P.glass, cx, F + h * 0.42, bz + bd / 2 - 0.05, Math.PI, [1, 1, 0.05]);
      b.add("metal", new THREE.BoxGeometry(0.06, 0.06, bd + 0.1), P.metalHi, cx, F + h * 0.86, bz);
      strip(F + 0.05, bw * 0.8);
      return h * 0.9;
    }
    default: {
      // Generic: slim tower with a glass curtain wall and an antenna ring.
      b.add("body", rbox(bw * 0.7, h, bd, 0.08), P.body, cx, F + h / 2, bz);
      b.add("glass", new THREE.BoxGeometry(bw * 0.6, h * 0.8, 0.02), P.glass, cx, F + h * 0.45, bz + bd / 2 + 0.01);
      for (let i = 1; i < 4; i++) strip(F + (h * i) / 4, bw * 0.62);
      b.add("metal", new THREE.CylinderGeometry(0.02, 0.02, 0.8, 6), P.metalHi, cx, F + h + 0.4, bz);
      anim(ctx, cx, F + h + 0.6, bz, (a) => a.add("glow", new THREE.TorusGeometry(0.22, 0.012, 3, 32), P.accent, 0, 0, 0, 0, undefined, Math.PI / 2), { spin: [0, 0.8, 0.0], rot: [0.3, 0, 0] });
      return h + 0.8;
    }
  }
}

/** Hero prop on the forecourt per plugin theme. */
function pluginHero(ctx: Ctx, x: number, z: number): void {
  const { b, P } = ctx;
  const theme = ctx.z.theme ?? "generic";
  b.add("body", new THREE.CylinderGeometry(0.42, 0.5, 0.18, 32), P.bodyHi, x, F + 0.09, z);
  b.add("glow", new THREE.TorusGeometry(0.45, 0.012, 3, 40), P.accent, x, F + 0.185, z, 0, undefined, Math.PI / 2);
  const y = F + 1.0;
  const opts = { spin: [0, 0.5, 0] as [number, number, number], busySpin: 3, bob: 0.06 };
  switch (theme) {
    case "media-studio":
      anim(ctx, x, y, z, (a) => {
        a.add("metal", new THREE.TorusGeometry(0.42, 0.07, 10, 40), P.metalHi, 0, 0, 0);
        a.add("glass", new THREE.CircleGeometry(0.38, 32), P.glass, 0, 0, 0);
        a.add("glow", new THREE.TorusGeometry(0.3, 0.01, 3, 32), P.accentHi, 0, 0, 0.02);
      }, { ...opts, rot: [0, 0, 0] });
      break;
    case "trading-floor":
      for (let i = 0; i < 5; i++) {
        const hh = 0.35 + ((i * 37) % 5) * 0.15 + i * 0.08;
        b.add("flow", new THREE.BoxGeometry(0.1, hh, 0.1), P.accent, x - 0.3 + i * 0.15, F + 0.18 + hh / 2, z);
      }
      break;
    case "fleet":
      anim(ctx, x, y + 0.2, z, (a) => {
        for (let i = 0; i < 3; i++) {
          const t = (i / 3) * Math.PI * 2;
          a.add("body", rbox(0.16, 0.05, 0.16, 0.02), P.bodyHi, Math.cos(t) * 0.45, 0, Math.sin(t) * 0.45);
          a.add("glow", new THREE.TorusGeometry(0.1, 0.008, 3, 16), P.accent, Math.cos(t) * 0.45, 0.03, Math.sin(t) * 0.45, 0, undefined, Math.PI / 2);
        }
      }, { spin: [0, 1.2, 0], busySpin: 2, bob: 0.1 });
      break;
    case "holo-gallery":
      anim(ctx, x, y, z, (a) => {
        const s = 0.5;
        for (const [px, py, pz, w, hh, d] of [
          [0, s / 2, s / 2, s, 0.015, 0.015], [0, -s / 2, s / 2, s, 0.015, 0.015], [0, s / 2, -s / 2, s, 0.015, 0.015], [0, -s / 2, -s / 2, s, 0.015, 0.015],
          [s / 2, 0, s / 2, 0.015, s, 0.015], [-s / 2, 0, s / 2, 0.015, s, 0.015], [s / 2, 0, -s / 2, 0.015, s, 0.015], [-s / 2, 0, -s / 2, 0.015, s, 0.015],
          [s / 2, s / 2, 0, 0.015, 0.015, s], [-s / 2, s / 2, 0, 0.015, 0.015, s], [s / 2, -s / 2, 0, 0.015, 0.015, s], [-s / 2, -s / 2, 0, 0.015, 0.015, s],
        ] as const) a.add("glow", new THREE.BoxGeometry(w, hh, d), P.accent, px, py, pz);
        a.add("glass", new THREE.BoxGeometry(s * 0.6, s * 0.6, s * 0.6), P.glass, 0, 0, 0);
      }, { ...opts, rot: [0.6, 0, 0.6] });
      break;
    case "dojo":
      b.add("floor", new THREE.CylinderGeometry(0.7, 0.7, 0.02, 40), mix(P.floor, P.bodyHi, 0.7), x, F + 0.2, z);
      anim(ctx, x, y, z, (a) => a.add("glow", new THREE.TorusGeometry(0.42, 0.035, 6, 48, Math.PI * 1.8), P.accent, 0, 0, 0), { spin: [0, 0.2, 0], bob: 0.05 });
      break;
    case "boardroom":
      b.add("body", new THREE.CylinderGeometry(0.5, 0.5, 0.05, 40), P.body, x, F + 0.6, z);
      b.add("metal", new THREE.CylinderGeometry(0.06, 0.12, 0.42, 10), P.metal, x, F + 0.38, z);
      anim(ctx, x, F + 0.95, z, (a) => a.add("glow", new THREE.TorusGeometry(0.3, 0.01, 3, 40), P.accent, 0, 0, 0, 0, undefined, Math.PI / 2), { spin: [0, 0.6, 0], bob: 0.04 });
      break;
    case "terminal-vault":
      anim(ctx, x, y, z, (a) => {
        for (let i = 0; i < 3; i++) a.add("glow", rbox(0.6, 0.08, 0.14, 0.03), i === 1 ? P.accentHi : P.accent, (i - 1) * 0.06, (i - 1) * 0.2, 0, 0, undefined, 0, i === 1 ? -0.25 : 0.25);
      }, opts);
      break;
    case "voice-studio":
      for (let i = 0; i < 7; i++) {
        const hh = 0.2 + Math.abs(Math.sin(i * 0.9)) * 0.6;
        b.add("flow", new THREE.BoxGeometry(0.06, hh, 0.06), P.accent, x - 0.27 + i * 0.09, F + 0.18 + hh / 2, z);
      }
      break;
    case "clinic":
      anim(ctx, x, y, z, (a) => {
        for (let i = 0; i < 14; i++) {
          const t = i * 0.55;
          for (const s of [0, Math.PI]) a.add("glow", new THREE.SphereGeometry(0.035, 8, 6), s ? P.tint : P.accent, Math.cos(t + s) * 0.2, -0.45 + i * 0.07, Math.sin(t + s) * 0.2);
        }
      }, opts);
      break;
    case "content-lab":
      anim(ctx, x, y, z, (a) => a.add("glow", new THREE.CylinderGeometry(0.3, 0.3, 0.12, 3), P.accent, 0, 0, 0, 0, undefined, Math.PI / 2), opts);
      break;
    case "showroom":
      anim(ctx, x, F + 0.5, z, (a) => {
        a.add("body", new THREE.CapsuleGeometry(0.16, 0.5, 6, 16), P.bodyHi, 0, 0, 0, 0, undefined, 0, Math.PI / 2);
        a.add("glow", new THREE.BoxGeometry(0.5, 0.012, 0.3), P.accent, 0, -0.1, 0);
      }, { spin: [0, 0.45, 0], busySpin: 2 });
      break;
    case "drawing-studio":
      b.add("metal", new THREE.BoxGeometry(0.03, 1.1, 0.03), P.metal, x, F + 0.6, z - 0.1, 0, undefined, 0.2);
      anim(ctx, x, F + 1.05, z, (a) => a.add("glow", new THREE.BoxGeometry(0.6, 0.45, 0.015), P.accentDeep, 0, 0, 0, 0, undefined, -0.15), { sway: { axis: "y", amp: 0.3, freq: 0.2 } });
      break;
    default:
      b.add("body", rbox(0.22, 1.1, 0.12, 0.03), P.body, x, F + 0.7, z);
      anim(ctx, x, F + 0.9, z, (a) => a.add("glow", new THREE.TorusGeometry(0.32, 0.01, 3, 40), P.accent, 0, 0, 0, 0, undefined, Math.PI / 2), { spin: [0, 0.7, 0], rot: [0.5, 0, 0] });
  }
}

// ── Build ────────────────────────────────────────────────────────────────

/** Build every zone into the static builder + the instanced furniture / screen / anim lists. */
export function buildStaticWorld(b: StaticBuilder, zones: readonly WorldZone[], bedSlots: ReadonlyArray<{ c: number; r: number }>, P: WorldTheme): WorldBuild {
  const out: WorldBuild = { kits: [], screens: [], blobs: [], desks: [], doors: new Map(), labelY: new Map(), anims: [], pools: [], hubs: new Map(), zoneIndex: new Map() };
  zones.forEach((z, i) => out.zoneIndex.set(z.id, Math.min(i, MAX_ZONES - 1)));
  const core = zones.filter((z) => z.kind === "core");

  // Station plinth — a polished obsidian slab with a gold edge line.
  b.zone = -1;
  let minC = 0, minR = 0, maxC = 24, maxR = 24;
  if (core.length) {
    minC = Math.min(...core.map((z) => z.c));
    minR = Math.min(...core.map((z) => z.r));
    maxC = Math.max(...core.map((z) => z.c + z.w));
    maxR = Math.max(...core.map((z) => z.r + z.h));
    const cx = toX((minC + maxC) / 2);
    const cz = toZ((minR + maxR) / 2);
    const w = maxC - minC + 0.7;
    const d = maxR - minR + 0.7;
    b.add("body", rbox(w, 0.9, d, 0.18, 2), P.body, cx, -0.45 + 0.02, cz);
    b.add("metal", rbox(w + 0.06, 0.05, d + 0.06, 0.02), P.metalHi, cx, -0.06, cz);
    b.add("glow", new THREE.BoxGeometry(w + 0.08, 0.018, 0.02), P.accent, cx, -0.3, cz + d / 2 + 0.035);
    b.add("glow", new THREE.BoxGeometry(0.02, 0.018, d + 0.08), P.accent, cx + w / 2 + 0.035, -0.3, cz);
    b.add("glow", new THREE.BoxGeometry(w + 0.08, 0.018, 0.02), P.accent, cx, -0.3, cz - d / 2 - 0.035);
    b.add("glow", new THREE.BoxGeometry(0.02, 0.018, d + 0.08), P.accent, cx - w / 2 - 0.035, -0.3, cz);
  }

  for (const z of zones) {
    b.zone = out.zoneIndex.get(z.id) ?? -1;
    const x0 = toX(z.c);
    const z0 = toZ(z.r);
    const cx = x0 + z.w / 2;
    const cz = z0 + z.h / 2;
    const ctx: Ctx = { b, out, z, P, X: (c) => x0 + c, Z: (r) => z0 + r };

    if (z.kind === "island") {
      const r = z.w / 2;
      const online = z.status === "online";
      b.add("body", new THREE.CylinderGeometry(r, r - 0.9, 1.1, 6), P.body, cx, -0.4, cz, Math.PI / 6);
      b.add("floor", new THREE.CylinderGeometry(r - 0.25, r - 0.2, 0.12, 6), P.floor, cx, F - 0.06, cz, Math.PI / 6);
      b.add("metal", new THREE.TorusGeometry(r - 0.1, 0.03, 4, 6), P.metalHi, cx, F - 0.02, cz, Math.PI / 6, undefined, Math.PI / 2);
      b.add("glow", new THREE.TorusGeometry(r - 0.35, 0.02, 3, 6), online ? P.accent : P.metal, cx, F + 0.01, cz, Math.PI / 6, undefined, Math.PI / 2);
      b.add("body", new THREE.CylinderGeometry(0.2, 0.4, 2.4, 6), P.bodyHi, cx, F + 1.2, cz, Math.PI / 6);
      anim(ctx, cx, F + 2.8, cz, (a) => {
        a.add(online ? "glow" : "metal", new THREE.OctahedronGeometry(0.42, 0), online ? P.accent : P.metal, 0, 0, 0);
        a.add("glow", new THREE.TorusGeometry(0.62, 0.01, 3, 40), online ? P.accentHi : P.metal, 0, 0, 0, 0, undefined, Math.PI / 2);
      }, { spin: [0, 0.5, 0], bob: 0.1 });
      out.blobs.push({ x: cx, z: cz, sx: 2.2, sz: 2.2, rot: 0, a: 0.5 });
      if (online) pool(ctx, cx, cz, 2.4, 0.45);
      out.hubs.set(z.id, { x: cx, y: F + 2.8, z: cz });
      out.labelY.set(z.id, F + 3.6);
      out.doors.set(z.id, [{ x: cx, z: z0 + z.h - 0.6 }]);
      continue;
    }

    // Floor slab: polished, with a fine accent border.
    const plinth = z.kind === "plugin" ? 0.5 : 0;
    b.add("floor", rbox(z.w - 0.1, 0.16 + plinth, z.h - 0.1, 0.05), P.floor, cx, F - (0.16 + plinth) / 2, cz);
    if (plinth) b.add("glow", new THREE.BoxGeometry(z.w - 0.1, 0.015, 0.015), P.accent, cx, F - 0.25, z0 + z.h - 0.045);
    inlayRect(ctx, cx, cz, z.w - 0.9, z.h - 0.9, P.floorInlay, 0.02);

    out.doors.set(z.id, [
      { x: cx, z: z0 + 0.35 },
      { x: cx, z: z0 + z.h - 0.35 },
      { x: x0 + 0.35, z: cz },
      { x: x0 + z.w - 0.35, z: cz },
    ]);

    if (z.kind === "core") {
      if (z.r === minR) backWall(ctx, x0, z0 + 0.08, z.w, true);
      if (z.c === minC) backWall(ctx, x0 + 0.08, z0, z.h, false);
      if (z.r + z.h < maxR) partition(ctx, x0, z0 + z.h, z.w, true, 0.8);
      else balustrade(ctx, x0, z0 + z.h - 0.08, z.w, true);
      if (z.c + z.w < maxC) partition(ctx, x0 + z.w, z0, z.h, false, 0.8);
      else balustrade(ctx, x0 + z.w - 0.08, z0, z.h, false);
      switch (z.id) {
        case "command-atrium": commandAtrium(ctx); break;
        case "mission-control": missionControl(ctx); break;
        case "comms-deck": commsDeck(ctx); break;
        case "agent-quarters": agentQuarters(ctx); break;
        case "observatory": observatory(ctx); break;
        case "broadcast-studio": broadcastStudio(ctx); break;
        case "the-vault": vault(ctx); break;
        case "engineering-bay": engineeringBay(ctx); break;
        case "gateway-concourse": gatewayConcourse(ctx, bedSlots); break;
        case "canvas-atrium": canvasAtrium(ctx); break;
        default:
          b.add("body", rbox(1, 1, 1, 0.08), P.body, x0 + 1.5, F + 0.5, z0 + 1.5);
          out.labelY.set(z.id, F + 2);
      }
      // Corner light bollards (architecture, not plants).
      for (const [pc, pr] of [[z.w - 0.5, z.h - 0.5], [0.5, z.h - 0.5]]) out.kits.push({ kit: "bollard", x: x0 + pc, y: F, z: z0 + pr, rotY: 0, scale: 1, tint: 0xffffff });
    } else {
      balustrade(ctx, x0 + 0.1, z0 + z.h - 0.12, z.w - 0.2, true);
      const h = buildingHeight(z);
      const bw = z.w * 0.62;
      const bd = z.h * 0.34;
      const bz = z0 + z.h * 0.29;
      const front = bz + bd / 2;
      const top = pluginBuilding(ctx, { cx, bz, bw, bd, h, front });
      // Entrance portal: slim canopy + lit door.
      b.add("metal", rbox(1.2, 0.04, 0.5, 0.02), P.metalHi, cx, F + 1.0, front + 0.28);
      b.add("glow", new THREE.BoxGeometry(1.18, 0.012, 0.012), P.accent, cx, F + 0.98, front + 0.53);
      b.add("glow", rbox(0.62, 0.84, 0.02, 0.01), P.accentDeep, cx, F + 0.42, front + 0.04);
      pluginHero(ctx, x0 + z.w * 0.5, z0 + z.h * 0.64);
      out.blobs.push({ x: cx, z: bz + 0.1, sx: bw * 1.25, sz: bd * 1.5, rot: 0, a: 0.55 });
      pool(ctx, x0 + z.w * 0.5, z0 + z.h * 0.64, 1.6, 0.45);
      out.hubs.set(z.id, { x: x0 + z.w * 0.5, y: F + 1.0, z: z0 + z.h * 0.64 });
      out.labelY.set(z.id, F + top + 0.75);
    }

    // Workstations: few, per the district plan; agents sit (or stand) at them.
    b.zone = out.zoneIndex.get(z.id) ?? -1;
    for (const s of deskSeats(z.kind, z.w, z.h, z.id)) {
      const dx = x0 + s.desk.c;
      const dz = z0 + s.desk.r;
      const seat = s.seat ? { x: x0 + s.seat.c, z: z0 + s.seat.r } : { x: dx, z: dz + 0.9 };
      // Facing: from the desk toward its seat (kits face +Z = the seat side).
      const rotY = Math.atan2(seat.x - dx, seat.z - dz);
      const sin = Math.sin(rotY);
      const cos = Math.cos(rotY);
      const style = s.style;
      let screenIdx = -1;
      let seated = true;
      const deskIdx = s.seat ? out.desks.length : -1;
      if (style === "console") {
        const px = dx + sin * 0.15;
        const pz = dz + cos * 0.15;
        out.kits.push({ kit: "console", x: px, y: F, z: pz, rotY, scale: DESK_S, tint: 0xffffff });
        out.blobs.push({ x: px, z: pz, sx: 1.6, sz: 0.9, rot: rotY, a: 0.4 });
        screenIdx = screen(ctx, { x: px - sin * 0.2 * DESK_S, y: F + 1.08 * DESK_S, z: pz - cos * 0.2 * DESK_S, rotY, tilt: -0.1, w: 0.74 * DESK_S, h: 0.42 * DESK_S, desk: deskIdx });
        if (s.seat) out.kits.push({ kit: "chair", x: seat.x, y: F, z: seat.z, rotY: rotY + Math.PI, scale: 1.15, tint: 0xffffff });
      } else if (style === "table") {
        out.kits.push({ kit: "stool", x: seat.x, y: F, z: seat.z, rotY, scale: 1.1, tint: 0xffffff });
        screenIdx = screen(ctx, { x: dx + sin * 0.1, y: F + 1.3, z: dz + cos * 0.1, rotY, tilt: -0.35, w: 0.62, h: 0.36, desk: deskIdx });
      } else if (style === "pod") {
        out.kits.push({ kit: "pod", x: seat.x - sin * 0.12, y: F, z: seat.z - cos * 0.12, rotY, scale: 1.25, tint: 0xffffff });
        out.blobs.push({ x: seat.x, z: seat.z, sx: 1.5, sz: 1.5, rot: 0, a: 0.4 });
        screenIdx = screen(ctx, { x: seat.x + sin * 0.95, y: F + 1.25, z: seat.z + cos * 0.95, rotY: rotY + Math.PI, tilt: 0.1, w: 0.62, h: 0.38, desk: deskIdx });
      } else if (style === "kiosk") {
        out.kits.push({ kit: "kiosk", x: dx, y: F, z: dz, rotY, scale: 1.2, tint: 0xffffff });
        screenIdx = screen(ctx, { x: dx + sin * 0.05, y: F + 1.5, z: dz + cos * 0.05, rotY, tilt: -0.3, w: 0.56, h: 0.34, desk: deskIdx });
        seated = false;
      } else if (style === "drafting") {
        out.kits.push({ kit: "drafting", x: dx, y: F, z: dz, rotY, scale: 1.2, tint: 0xffffff });
        out.kits.push({ kit: "stool", x: seat.x, y: F, z: seat.z, rotY, scale: 1.1, tint: 0xffffff });
        screenIdx = screen(ctx, { x: dx - sin * 0.05, y: F + 0.99, z: dz - cos * 0.05, rotY, tilt: -1.2, w: 0.9, h: 0.55, desk: deskIdx, color: P.accentDeep });
      } else if (style === "mic") {
        out.kits.push({ kit: "mic", x: dx, y: F, z: dz, rotY, scale: 1.1, tint: 0xffffff });
        seated = false;
      }
      if (s.seat) {
        out.blobs.push({ x: seat.x, z: seat.z, sx: 0.7, sz: 0.7, rot: 0, a: 0.3 });
        out.desks.push({ zoneId: z.id, sx: seat.x, sz: seat.z, heading: rotY + Math.PI, screen: screenIdx, seated, seatY: SEAT_Y[style] ?? 0.52 });
      }
    }
  }
  b.zone = -1;
  return out;
}
