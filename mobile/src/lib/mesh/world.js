// world.js — the Agent Mesh world in world coordinates, 1:1 with the web
// station (ui/src/ui/views/agent-ops/iso/sector-layout.ts buildStationComplex,
// plugin-district.ts, activity-map.ts federation pods). The layout/routing
// maths comes from the web's own code (web-mesh.generated.js); the static
// tables below are copied verbatim from sector-layout.ts / district-accents.ts.

import {
  CONCOURSE_GATE,
  ROOM_TILES,
  TILE_H,
  TILE_W,
  computeWorkSlots,
  districtBounds,
  districtConduits,
  planDistrict,
  roomSpecsFromPluginList,
} from './web-mesh.generated';

export const CENTER = { x: 800, y: 600 };
export const STATION_GRID = { cols: 24, rows: 24 };
const OX = CENTER.x - ((STATION_GRID.cols - STATION_GRID.rows) * TILE_W) / 4;
const OY = CENTER.y - ((STATION_GRID.cols + STATION_GRID.rows) * TILE_H) / 4;

/** Station grid cell → world point (top vertex of the cell's diamond). */
export function cell(c, r) {
  return { x: OX + ((c - r) * TILE_W) / 2, y: OY + ((c + r) * TILE_H) / 2 };
}

/** sector-layout.ts SECTORS (3×3 supergrid, right column split for the Vault). */
export const SECTORS = [
  { id: 'observatory', name: 'OBSERVATORY', system: 'analytics', c: 0, r: 0, w: 8, h: 8 },
  { id: 'mission-control', name: 'MISSION CONTROL', system: 'autonomy + cron', c: 8, r: 0, w: 8, h: 8 },
  { id: 'comms-deck', name: 'COMMS DECK', system: 'channels', c: 16, r: 0, w: 8, h: 8 },
  { id: 'agent-quarters', name: 'AGENT QUARTERS', system: 'agents + sessions', c: 0, r: 8, w: 8, h: 8 },
  { id: 'command-atrium', name: 'COMMAND ATRIUM', system: 'federation hub', c: 8, r: 8, w: 8, h: 8 },
  { id: 'broadcast-studio', name: 'BROADCAST STUDIO', system: 'media + voice', c: 16, r: 8, w: 8, h: 4 },
  { id: 'the-vault', name: 'THE VAULT', system: 'security + config', c: 16, r: 12, w: 8, h: 4 },
  { id: 'engineering-bay', name: 'ENGINEERING BAY', system: 'terminals', c: 0, r: 16, w: 8, h: 8 },
  { id: 'gateway-concourse', name: 'GATEWAY CONCOURSE', system: 'gateway', c: 8, r: 16, w: 8, h: 8 },
  { id: 'canvas-atrium', name: 'CANVAS ATRIUM', system: 'canvas + design', c: 16, r: 16, w: 8, h: 8 },
];

/** district-accents.ts */
export const DISTRICT_ACCENT = {
  observatory: '#38bdf8',
  'mission-control': '#fb923c',
  'comms-deck': '#f472b6',
  'agent-quarters': '#a78bfa',
  'command-atrium': '#fbbf24',
  'broadcast-studio': '#e879f9',
  'the-vault': '#34d399',
  'engineering-bay': '#2dd4bf',
  'gateway-concourse': '#60a5fa',
  'canvas-atrium': '#c084fc',
};
export const FALLBACK_ACCENT = '#94a3b8';

/** sector-layout.ts DECOR (zone-relative tile coords). */
export const DECOR = {
  observatory: [
    { t: 'telescope', c: 4.8, r: 1.8 }, { t: 'holoTable', c: 2.6, r: 3.2 }, { t: 'desk', c: 2, r: 5.4 },
    { t: 'crystal', c: 6.4, r: 1.6 }, { t: 'plantHolo', c: 6.2, r: 5.2 }, { t: 'crate', c: 5.2, r: 6.2 },
  ],
  'mission-control': [
    { t: 'bigDisplay', c: 4, r: 1.4 }, { t: 'consoleWide', c: 2.6, r: 4 }, { t: 'consoleWide', c: 5.2, r: 4.6 },
    { t: 'desk', c: 1.6, r: 5.8 }, { t: 'plantHolo', c: 6.6, r: 2 },
  ],
  'comms-deck': [
    { t: 'antenna', c: 5.6, r: 1.4 }, { t: 'commsBoard', c: 3, r: 1.8 }, { t: 'desk', c: 2, r: 4.4 },
    { t: 'desk', c: 4, r: 5.2 }, { t: 'speaker', c: 6.4, r: 3.4 }, { t: 'crate', c: 6, r: 5.6 },
  ],
  'command-atrium': [
    { t: 'holoTable', c: 4, r: 4, s: 1.35 }, { t: 'pedestal', c: 1.6, r: 1.6 }, { t: 'pedestal', c: 6.4, r: 1.6 },
    { t: 'crystal', c: 1.6, r: 6.4 }, { t: 'crystal', c: 6.4, r: 6.4 }, { t: 'plantHolo', c: 4, r: 1.2 },
  ],
  'broadcast-studio': [
    { t: 'bigDisplay', c: 4, r: 0.9 }, { t: 'micBooth', c: 2.6, r: 2.4 }, { t: 'speaker', c: 5.4, r: 2.2 },
    { t: 'speaker', c: 6.2, r: 2.7 }, { t: 'couch', c: 1.6, r: 3 },
  ],
  'the-vault': [
    { t: 'vaultDoor', c: 4, r: 0.9 }, { t: 'gateArch', c: 4, r: 2.9 }, { t: 'safe', c: 1.8, r: 2 },
    { t: 'safe', c: 2.6, r: 2.7 }, { t: 'ingots', c: 5.8, r: 2.1 }, { t: 'ingots', c: 6.4, r: 2.7 },
  ],
  'engineering-bay': [
    { t: 'server', c: 1.6, r: 1.4 }, { t: 'server', c: 3.0, r: 1.4 }, { t: 'server', c: 4.4, r: 1.4 },
    { t: 'roboArm', c: 6, r: 2 }, { t: 'desk', c: 2.4, r: 4.6 }, { t: 'crate', c: 5.4, r: 4.8 },
    { t: 'crate', c: 6.2, r: 5.6 }, { t: 'plantHolo', c: 1.4, r: 6.2 },
  ],
  'gateway-concourse': [{ t: 'gateArch', c: 0.9, r: 0.9 }, { t: 'plantHolo', c: 7.0, r: 7.0 }],
  'canvas-atrium': [
    { t: 'easel', c: 2, r: 2 }, { t: 'easel', c: 4, r: 3 }, { t: 'easel', c: 6, r: 2 },
    { t: 'pedestal', c: 2.4, r: 4.8 }, { t: 'pedestal', c: 4.6, r: 5.6 }, { t: 'holoTable', c: 6.2, r: 4.4, s: 0.8 },
    { t: 'plantHolo', c: 6.6, r: 6.2 },
  ],
  'agent-quarters': [
    { t: 'desk', c: 1.6, r: 1.6 }, { t: 'desk', c: 3.4, r: 1.6 }, { t: 'desk', c: 5.4, r: 1.6 },
    { t: 'consoleWide', c: 2.4, r: 4 }, { t: 'consoleWide', c: 5.2, r: 4 }, { t: 'crate', c: 6.4, r: 6 },
    { t: 'plantHolo', c: 1.4, r: 6.4 },
  ],
};

const WORK_SECTORS = ['observatory', 'mission-control', 'comms-deck', 'agent-quarters', 'command-atrium', 'broadcast-studio', 'the-vault', 'engineering-bay', 'canvas-atrium'];

/** A cols×rows platform centred on `cx,cy` (galactic-assets.ts buildPlatform). */
export function platformGeometry(cols, rows, cx, cy, sideDepth = TILE_H / 2) {
  const ox = cx + (-(cols - rows) * TILE_W) / 4;
  const oy = cy + (-(cols + rows) * TILE_H) / 4;
  const corner = (c, r) => ({ x: ox + ((c - r) * TILE_W) / 2, y: oy + ((c + r) * TILE_H) / 2 });
  const top = corner(0, 0);
  const right = corner(cols, 0);
  const bottom = corner(cols, rows);
  const left = corner(0, rows);
  // Checkerboard: floorAlt on (c+r) odd tiles, one path; seams on every tile's back edges.
  let alt = '';
  let seams = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = corner(c, r);
      const d = `M${p.x} ${p.y}L${p.x + TILE_W / 2} ${p.y + TILE_H / 2}L${p.x} ${p.y + TILE_H}L${p.x - TILE_W / 2} ${p.y + TILE_H / 2}Z`;
      if ((c + r) % 2 === 1) alt += d;
      seams += `M${p.x - TILE_W / 2} ${p.y + TILE_H / 2}L${p.x} ${p.y}L${p.x + TILE_W / 2} ${p.y + TILE_H / 2}`;
    }
  }
  return {
    corners: { top, right, bottom, left },
    top: [top, right, bottom, left],
    leftFace: [left, bottom, { x: bottom.x, y: bottom.y + sideDepth }, { x: left.x, y: left.y + sideDepth }],
    rightFace: [bottom, right, { x: right.x, y: right.y + sideDepth }, { x: bottom.x, y: bottom.y + sideDepth }],
    altPath: alt,
    seamPath: seams,
    height: ((cols + rows) * TILE_H) / 2,
  };
}

const prop = (t, x, y, s) => ({ t, x, y: y + TILE_H / 2, s: s ?? 1 });

/** buildStationComplex() — static station geometry (core, executive suite, HQ sign, beds). */
export function buildStation() {
  const platform = platformGeometry(24, 24, CENTER.x, CENTER.y);
  const zones = [];
  const decor = [];
  const workSlots = {};
  for (const def of SECTORS) {
    const pTop = cell(def.c, def.r);
    const pRight = cell(def.c + def.w, def.r);
    const pBottom = cell(def.c + def.w, def.r + def.h);
    const pLeft = cell(def.c, def.r + def.h);
    zones.push({
      ...def,
      accent: DISTRICT_ACCENT[def.id] || FALLBACK_ACCENT,
      poly: [pTop, pRight, pBottom, pLeft],
      top: pTop,
      center: cell(def.c + def.w / 2, def.r + def.h / 2),
    });
    for (const item of DECOR[def.id] || []) {
      const p = cell(def.c + item.c, def.r + item.r);
      decor.push(prop(item.t, p.x, p.y, item.s));
    }
    if (WORK_SECTORS.includes(def.id)) {
      workSlots[def.id] = computeWorkSlots(def, DECOR[def.id] || []).map((s) => cell(def.c + s.c, def.r + s.r));
    }
  }
  // Gateway Concourse rest area: 4×4 beds (scale 0.72), park point 2px above the foot.
  const conc = SECTORS.find((s) => s.id === 'gateway-concourse');
  const beds = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const p = cell(conc.c + 1.5 + (c * (conc.w - 3)) / 3, conc.r + 1.5 + (r * (conc.h - 3)) / 3);
      beds.push({ x: p.x, y: p.y });
      decor.push({ t: 'bed', x: p.x, y: p.y + TILE_H / 2, s: 0.72, bed: true });
    }
  }
  const bedSlots = beds.map((p) => ({ x: p.x, y: p.y - 2 }));
  // Executive Suite (6×6 pad at +640,-330) + its furniture + dashed bridge to the NE edge.
  const execCenter = { x: CENTER.x + 640, y: CENTER.y - 330 };
  const exec = platformGeometry(6, 6, execCenter.x, execCenter.y, 40);
  const execDecor = [
    { t: 'consoleWide', x: execCenter.x - 16, y: execCenter.y, s: 1.15 },
    { t: 'couch', x: execCenter.x + 70, y: execCenter.y + 42, s: 1 },
    { t: 'pedestal', x: execCenter.x - 96, y: execCenter.y + 30, s: 1 },
    { t: 'plantHolo', x: execCenter.x + 10, y: execCenter.y + 64, s: 1 },
  ];
  // Agent Quarters office slots (2×2) — idle-agent offices on the hub.
  const aq = SECTORS.find((s) => s.id === 'agent-quarters');
  const aqSlots = [];
  for (const sr of [aq.r + 2.2, aq.r + 5.8]) for (const sc of [aq.c + 2.2, aq.c + 5.8]) aqSlots.push(cell(sc, sr));
  return {
    platform,
    zones,
    decor: decor.sort((a, b) => a.y - b.y),
    workSlots,
    bedSlots,
    aqSlots,
    atrium: cell(12, 12),
    concourse: cell(12, 20),
    exec: {
      center: execCenter,
      platform: exec,
      decor: execDecor,
      label: { x: execCenter.x, y: execCenter.y - exec.height / 2 - 6, title: 'EXECUTIVE SUITE', subtitle: 'business + crm' },
      bridge: [execCenter, cell(18, 0)],
      auditor: { x: execCenter.x + 118, y: execCenter.y + 28 },
    },
    hq: { x: cell(0, 0).x, y: cell(0, 0).y - 36, title: 'INFINIBOT HQ', subtitle: 'galactic operations' },
  };
}

/** The Plugin District for a plugins.list answer (plugin-district.ts). `previous` keeps rooms in place. */
export function buildDistrict(pluginList, previous) {
  const specs = roomSpecsFromPluginList(Array.isArray(pluginList) ? pluginList : []);
  const plan = planDistrict(specs, previous || null);
  const rooms = [];
  for (const placed of plan.values()) {
    const { spec } = placed;
    const tiles = ROOM_TILES[spec.size];
    const center = cell(placed.c + tiles / 2, placed.r + tiles / 2);
    const top = cell(placed.c, placed.r);
    const right = cell(placed.c + tiles, placed.r);
    const bottom = cell(placed.c + tiles, placed.r + tiles);
    const left = cell(placed.c, placed.r + tiles);
    const accent = `#${spec.accent.toString(16).padStart(6, '0')}`;
    const decor = spec.decor.map((item) => {
      const p = cell(placed.c + item.c, placed.r + item.r);
      return prop(item.t, p.x, p.y, item.s);
    }).sort((a, b) => a.y - b.y);
    const workSlots = computeWorkSlots({ w: tiles, h: tiles }, spec.decor, { max: spec.size === 'L' ? 12 : spec.size === 'S' ? 6 : 9 })
      .map((s) => cell(placed.c + s.c, placed.r + s.r));
    // Monogram sign over the corner farther from the core (east/west stud).
    const signCorner = center.x >= CENTER.x ? right : left;
    rooms.push({
      id: spec.id, spec, placed, tiles, accent, center, top,
      poly: [top, right, bottom, left],
      platform: platformGeometry(tiles, tiles, center.x, center.y, 26),
      decor, workSlots,
      sign: { x: signCorner.x * 0.9 + center.x * 0.1, y: signCorner.y * 0.9 + center.y * 0.1, text: spec.monogram },
      sectorDef: { id: spec.id, c: placed.c, r: placed.r, w: placed.w, h: placed.h },
    });
  }
  const conduits = rooms.length
    ? districtConduits(plan.values()).map((k) => ({ kind: k.kind, a: cell(k.a.c, k.a.r), b: cell(k.b.c, k.b.r), roomId: k.roomId }))
    : [];
  const tb = districtBounds(plan.values());
  return { plan, rooms, conduits, gate: cell(CONCOURSE_GATE.c, CONCOURSE_GATE.r + 0.9), tileBounds: tb };
}

/** Federation islands for every node but the hub (activity-map.ts pods). */
export function buildIslands(nodes) {
  const anchors = [
    { x: CENTER.x + 550, y: CENTER.y + 1100 },
    { x: CENTER.x - 550, y: CENTER.y + 1100 },
    { x: CENTER.x + 900, y: CENTER.y + 1480 },
    { x: CENTER.x - 900, y: CENTER.y + 1480 },
  ];
  const remote = (nodes || []).filter((n, i) => !(n.role === 'hub' || n.id === 'local' || (i === 0 && n.role !== 'satellite')));
  return remote.map((node, i) => {
    const base = anchors[i % anchors.length];
    const k = Math.floor(i / anchors.length);
    const center = { x: base.x + 70 * k, y: base.y + 200 * k };
    const platform = platformGeometry(16, 16, center.x, center.y, 32);
    const ox = center.x;
    const oy = center.y - (32 * TILE_H) / 4;
    const local = (c, r) => ({ x: ox + ((c - r) * TILE_W) / 2, y: oy + ((c + r) * TILE_H) / 2 });
    const slots = [];
    for (const r of [4.5, 11.5]) for (const c of [4.5, 11.5]) slots.push(local(c, r));
    return { node, center, platform, slots, label: { x: center.x, y: center.y - 128 - 46 }, bridge: [center, cell(12, 12)] };
  });
}

/** zoomToFit() bounds: the static station frame ∪ plugin district ∪ islands (activity-map.ts:6441). */
export function worldBounds(station, district, islands) {
  const b = {
    minX: CENTER.x - 900,
    maxX: CENTER.x + 900,
    minY: CENTER.y - 330 - station.exec.platform.height / 2 - 90,
    maxY: CENTER.y + 480,
  };
  for (const room of district?.rooms || []) {
    for (const p of room.poly) {
      b.minX = Math.min(b.minX, p.x - 40);
      b.maxX = Math.max(b.maxX, p.x + 40);
      b.minY = Math.min(b.minY, p.y - 20);
      b.maxY = Math.max(b.maxY, p.y + 20);
    }
  }
  for (const isl of islands || []) {
    b.minX = Math.min(b.minX, isl.center.x - 280);
    b.maxX = Math.max(b.maxX, isl.center.x + 280);
    b.maxY = Math.max(b.maxY, isl.center.y + 220);
  }
  return b;
}
