/**
 * Agency World — Upgraded 2D animated world for Agent Operations Center.
 *
 * A top-down living "agency floor": each federation node is a building with
 * work zones (terminals, library, drafting tables, comm desks, lounge).
 * Pixel-character agents walk between zones based on lastActivity.kind,
 * couriers fly between agents on inter-agent messages, and a conveyor at
 * the top delivers incoming tasks.
 *
 * Public API mirrors ActivityMap so the two engines are swappable from
 * the same controller wiring.
 */

import * as PIXI from "pixi.js";
import { Viewport } from "pixi-viewport";
import gsap from "gsap";
import type { MeshNode, MeshAgent, MeshMessage } from "./activity-map";
import { buildSpriteAtlas, type SpriteAtlas } from "./agency-sprite-atlas";
import {
  FxLayer,
  SkyCycle,
  AudioBus,
  cameraShake,
  PacingController,
  PacedAnimator,
  PacedTimer,
  type PacingConfig,
  DEFAULT_PACING,
} from "./agency-fx";
import {
  drawRoofFeatures,
  drawHardwareSignage,
  drawSecondFloor,
  getRoadPath,
  drawReceptionist,
  type NodeRole,
} from "./agency-buildings";
import {
  loadCozyRoomAssets,
  createDeskSprite,
  createSofaSprite,
  createChairSprite,
  areTexturesLoaded,
} from "./cozy-room-assets";

export type { MeshNode, MeshAgent, MeshMessage };

// ════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════

const TILE = 24;
const BUILDING_PAD = 32;
const ZONE_GAP = 24;
const WALL_TH = 6;

const COLORS = {
  bgSky: 0x0a0e1a,
  bgFar: 0x111726,
  ground: 0x14202b,
  grass1: 0x1b2c2a,
  grass2: 0x223634,
  road: 0x1a1f2e,
  roadLine: 0x3b3f55,
  building: 0x1c2433,
  buildingTrim: 0xd4af37,
  buildingFloor: 0x2a3344,
  buildingFloorAlt: 0x222a39,
  roof: 0x0e1421,
  roofTrim: 0xd4af37,
  wall: 0x1a212d,
  wallTop: 0x232b3a,
  zoneTerminal: 0x12384f,
  zoneLibrary: 0x4a2a1a,
  zoneDrafting: 0x3a3a1f,
  zoneComm: 0x2a1f3a,
  zoneLounge: 0x1f3a2a,
  zoneKanban: 0x3a2a30,
  zoneRecords: 0x252836,
  zoneBrowser: 0x1f3a3a,
  zoneEntry: 0x2a2d3a,
  text: 0xe4e4e7,
  textDim: 0x9aa2b1,
  gold: 0xd4af37,
  goldDim: 0x8a7028,
  white: 0xffffff,
  shadow: 0x000000,
  online: 0x22c55e,
  offline: 0xef4444,
  connecting: 0xf59e0b,
  // Upgraded palette additions
  warmGravel: 0x3a3328,
  wetRoad: 0x151a25,
  whitePaint: 0xd4d4d8,
  fireRed: 0xdc2626,
  lushGreen: 0x22c55e,
  steelSilver: 0x9ca3af,
  neonCyan: 0x22d3ee,
  neonMagenta: 0xec4899,
  sidewalk: 0x2a3040,
  sidewalkLine: 0x3a4050,
  sidewalkCrack: 0x1a2030,
  crosswalkWhite: 0xc8c8d0,
  grassTuft: 0x2a5a3a,
  grassTuftDark: 0x1a4a2a,
  puddleReflect: 0x1a2a40,
  roadShoulder: 0x22283a,
  rumbleStrip: 0x2a3048,
  speedBump: 0x3a2a1a,
  parkingMarker: 0xb0b0b8,
  fireHydrantRed: 0xcc2222,
  fireHydrantCap: 0xaa1818,
  streetLampPost: 0x4a5060,
  streetLampGlow: 0xffeeaa,
  dumpsterGreen: 0x2a4a2a,
  dumpsterBlue: 0x2a3a5a,
  bikeRack: 0x5a6070,
  flagRed: 0xcc3333,
  woodBrown: 0x6a4a2a,
  infoKiosk: 0x4a4a5a,
  potBrown: 0x5a3a1a,
  treeTrunk: 0x4a2a1a,
  treeGreen: 0x2a6a3a,
  treeGreenLight: 0x3a7a4a,
  fireEscape: 0x5a6070,
  waterTank: 0x4a5a6a,
  conveyorFrame: 0x3a4050,
  conveyorRivet: 0x6a7080,
  priorityRed: 0xdc2626,
  priorityYellow: 0xfbbf24,
  priorityGreen: 0x22c55e,
  envelopePkg: 0xfaf3e0,
  folderPkg: 0xf5d0a9,
  bugPkg: 0xef4444,
  featurePkg: 0x22d3ee,
  cloudShadow: 0x0a0e14,
  steam: 0x3a4a5a,
};

const STATUS_COLORS: Record<string, number> = {
  starting: 0x3b82f6,
  idle: 0x6a8a6a,
  working: 0xffd700,
  blocked: 0xe74c3c,
  finishing: 0xf59e0b,
  completed: 0x22c55e,
  failed: 0xef4444,
};

// ════════════════════════════════════════════════════════════════
// ZONES — which lastActivity.kind maps to which workspace
// ════════════════════════════════════════════════════════════════

export type ZoneKind =
  | "terminal"
  | "library"
  | "drafting"
  | "comm"
  | "browser"
  | "kanban"
  | "records"
  | "lounge"
  | "entry";

const TOOL_TO_ZONE: Record<string, ZoneKind> = {
  // Coding/editing
  edit: "drafting",
  write: "drafting",
  notebookedit: "drafting",
  // Reading/searching
  read: "library",
  glob: "library",
  grep: "library",
  toolsearch: "library",
  search: "library",
  // Terminal/system
  bash: "terminal",
  bashoutput: "terminal",
  // Web
  webfetch: "browser",
  websearch: "browser",
  browser: "browser",
  // Agents / comms
  task: "comm",
  agent: "comm",
  message: "comm",
  // Kanban / tasks
  taskcreate: "kanban",
  taskupdate: "kanban",
  tasklist: "kanban",
  taskget: "kanban",
  // Memory / scheduling
  memoryget: "records",
  memorysearch: "records",
  schedulewakeup: "records",
  // Default
  assistant: "drafting",
};

const ZONE_LABEL: Record<ZoneKind, string> = {
  terminal: "TERMINAL BANK",
  library: "RESEARCH LIB",
  drafting: "DRAFTING TABLES",
  comm: "COMMS DESK",
  browser: "BROWSER PIT",
  kanban: "KANBAN WALL",
  records: "ARCHIVES",
  lounge: "BREAK ROOM",
  entry: "ENTRYWAY",
};

const ZONE_BG: Record<ZoneKind, number> = {
  terminal: COLORS.zoneTerminal,
  library: COLORS.zoneLibrary,
  drafting: COLORS.zoneDrafting,
  comm: COLORS.zoneComm,
  browser: COLORS.zoneBrowser,
  kanban: COLORS.zoneKanban,
  records: COLORS.zoneRecords,
  lounge: COLORS.zoneLounge,
  entry: COLORS.zoneEntry,
};

const ZONE_ICON: Record<ZoneKind, string> = {
  terminal: ">_",
  library: "BK",
  drafting: "ED",
  comm: "TX",
  browser: "WB",
  kanban: "KB",
  records: "MM",
  lounge: "ZZ",
  entry: "IN",
};

export function inferZone(agent: MeshAgent): ZoneKind {
  const status = agent.status;
  if (status === "idle" || status === "completed") return "lounge";
  if (status === "starting") return "entry";
  const kindRaw =
    (agent as any).lastActivityKind ||
    (agent as any).lastActivity?.kind ||
    "";
  const k = String(kindRaw || "").toLowerCase();
  if (k && TOOL_TO_ZONE[k]) return TOOL_TO_ZONE[k];
  // fall back to agent id keyword
  const aid = String(agent.agentId || "").toLowerCase();
  if (aid.includes("coder")) return "drafting";
  if (aid.includes("research")) return "library";
  if (aid.includes("browser")) return "browser";
  if (aid.includes("tester")) return "terminal";
  return "drafting";
}

// ════════════════════════════════════════════════════════════════
// PIXEL FONT (compact, for labels)
// ════════════════════════════════════════════════════════════════

const FONT: Record<string, number[][]> = {
  A: [[0,1,1,0],[1,0,0,1],[1,1,1,1],[1,0,0,1],[1,0,0,1]],
  B: [[1,1,1,0],[1,0,0,1],[1,1,1,0],[1,0,0,1],[1,1,1,0]],
  C: [[0,1,1,1],[1,0,0,0],[1,0,0,0],[1,0,0,0],[0,1,1,1]],
  D: [[1,1,1,0],[1,0,0,1],[1,0,0,1],[1,0,0,1],[1,1,1,0]],
  E: [[1,1,1,1],[1,0,0,0],[1,1,1,0],[1,0,0,0],[1,1,1,1]],
  F: [[1,1,1,1],[1,0,0,0],[1,1,1,0],[1,0,0,0],[1,0,0,0]],
  G: [[0,1,1,1],[1,0,0,0],[1,0,1,1],[1,0,0,1],[0,1,1,0]],
  H: [[1,0,0,1],[1,0,0,1],[1,1,1,1],[1,0,0,1],[1,0,0,1]],
  I: [[1,1,1],[0,1,0],[0,1,0],[0,1,0],[1,1,1]],
  J: [[0,0,1],[0,0,1],[0,0,1],[1,0,1],[0,1,0]],
  K: [[1,0,0,1],[1,0,1,0],[1,1,0,0],[1,0,1,0],[1,0,0,1]],
  L: [[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,1,1,1]],
  M: [[1,0,0,0,1],[1,1,0,1,1],[1,0,1,0,1],[1,0,0,0,1],[1,0,0,0,1]],
  N: [[1,0,0,1],[1,1,0,1],[1,0,1,1],[1,0,0,1],[1,0,0,1]],
  O: [[0,1,1,0],[1,0,0,1],[1,0,0,1],[1,0,0,1],[0,1,1,0]],
  P: [[1,1,1,0],[1,0,0,1],[1,1,1,0],[1,0,0,0],[1,0,0,0]],
  Q: [[0,1,1,0],[1,0,0,1],[1,0,0,1],[1,0,1,1],[0,1,1,1]],
  R: [[1,1,1,0],[1,0,0,1],[1,1,1,0],[1,0,1,0],[1,0,0,1]],
  S: [[0,1,1,1],[1,0,0,0],[0,1,1,0],[0,0,0,1],[1,1,1,0]],
  T: [[1,1,1,1,1],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]],
  U: [[1,0,0,1],[1,0,0,1],[1,0,0,1],[1,0,0,1],[0,1,1,0]],
  V: [[1,0,0,0,1],[1,0,0,0,1],[0,1,0,1,0],[0,1,0,1,0],[0,0,1,0,0]],
  W: [[1,0,0,0,1],[1,0,0,0,1],[1,0,1,0,1],[1,1,0,1,1],[1,0,0,0,1]],
  X: [[1,0,0,1],[0,1,1,0],[0,1,1,0],[0,1,1,0],[1,0,0,1]],
  Y: [[1,0,0,0,1],[0,1,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]],
  Z: [[1,1,1,1],[0,0,1,0],[0,1,0,0],[1,0,0,0],[1,1,1,1]],
  "0": [[0,1,1,0],[1,0,0,1],[1,0,0,1],[1,0,0,1],[0,1,1,0]],
  "1": [[0,1,0],[1,1,0],[0,1,0],[0,1,0],[1,1,1]],
  "2": [[1,1,1,0],[0,0,0,1],[0,1,1,0],[1,0,0,0],[1,1,1,1]],
  "3": [[1,1,1,0],[0,0,0,1],[0,1,1,0],[0,0,0,1],[1,1,1,0]],
  "4": [[1,0,0,1],[1,0,0,1],[1,1,1,1],[0,0,0,1],[0,0,0,1]],
  "5": [[1,1,1,1],[1,0,0,0],[1,1,1,0],[0,0,0,1],[1,1,1,0]],
  "6": [[0,1,1,0],[1,0,0,0],[1,1,1,0],[1,0,0,1],[0,1,1,0]],
  "7": [[1,1,1,1],[0,0,0,1],[0,0,1,0],[0,1,0,0],[0,1,0,0]],
  "8": [[0,1,1,0],[1,0,0,1],[0,1,1,0],[1,0,0,1],[0,1,1,0]],
  "9": [[0,1,1,0],[1,0,0,1],[0,1,1,1],[0,0,0,1],[0,1,1,0]],
  " ": [[0,0],[0,0],[0,0],[0,0],[0,0]],
  ".": [[0],[0],[0],[0],[1]],
  "-": [[0,0,0],[0,0,0],[1,1,1],[0,0,0],[0,0,0]],
  ":": [[0],[1],[0],[1],[0]],
  "%": [[1,0,0,1],[0,0,1,0],[0,1,0,0],[1,0,0,1],[0,0,0,0]],
  "_": [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,1,1,1]],
  "/": [[0,0,0,1],[0,0,1,0],[0,1,0,0],[1,0,0,0],[0,0,0,0]],
  "+": [[0,0,0],[0,1,0],[1,1,1],[0,1,0],[0,0,0]],
  ">": [[1,0,0],[0,1,0],[0,0,1],[0,1,0],[1,0,0]],
  "<": [[0,0,1],[0,1,0],[1,0,0],[0,1,0],[0,0,1]],
  "!": [[1],[1],[1],[0],[1]],
  "#": [[0,1,0,1,0],[1,1,1,1,1],[0,1,0,1,0],[1,1,1,1,1],[0,1,0,1,0]],
};

function drawText(
  g: PIXI.Graphics,
  text: string,
  x: number,
  y: number,
  color: number,
  scale = 1,
): number {
  let cx = x;
  for (const ch of text.toUpperCase().split("")) {
    const p = FONT[ch];
    if (!p) {
      cx += 4 * scale;
      continue;
    }
    for (let r = 0; r < p.length; r++) {
      for (let c = 0; c < p[r].length; c++) {
        if (p[r][c]) {
          g.beginFill(color);
          g.drawRect(cx + c * scale, y + r * scale, scale, scale);
          g.endFill();
        }
      }
    }
    cx += (p[0].length + 1) * scale;
  }
  return cx - x;
}

function measureText(text: string, scale = 1): number {
  let w = 0;
  for (const ch of text.toUpperCase().split("")) {
    const p = FONT[ch];
    if (!p) {
      w += 4 * scale;
      continue;
    }
    w += (p[0].length + 1) * scale;
  }
  return w - scale;
}

// ════════════════════════════════════════════════════════════════
// CHARACTER — pixel-art agent with walk anim and provider colors
// ════════════════════════════════════════════════════════════════

export function inferProvider(agent: MeshAgent): string {
  const id = String(agent.agentId || "").toLowerCase();
  const label = String(agent.label || "").toLowerCase();
  const model = String((agent as any).model || "").toLowerCase();
  const s = `${id} ${label} ${model}`;
  if (s.includes("claude") || s.includes("anthropic")) return "claude";
  if (s.includes("opus")) return "claude";
  if (s.includes("sonnet")) return "claude";
  if (s.includes("haiku")) return "claude";
  if (s.includes("gpt") || s.includes("openai") || s.includes("codex"))
    return "openai";
  if (s.includes("gemini") || s.includes("google")) return "gemini";
  if (s.includes("ollama") || s.includes("local")) return "ollama";
  if (s.includes("xai") || s.includes("grok")) return "xai";
  return "default";
}

const PROVIDER_PALETTE: Record<
  string,
  { shirt: number; hair: number; skin: number; accent: number }
> = {
  claude: { shirt: 0xc97a4a, hair: 0x4a3324, skin: 0xf5d0a9, accent: 0xff9a4f },
  openai: { shirt: 0x10a37f, hair: 0x2a2a2a, skin: 0xf5d0a9, accent: 0x1be3a5 },
  gemini: { shirt: 0x4285f4, hair: 0x3a2a1a, skin: 0xf5d0a9, accent: 0x60a5fa },
  ollama: { shirt: 0x6b46c1, hair: 0x2a1a3a, skin: 0xf5d0a9, accent: 0xa78bfa },
  xai: { shirt: 0x111111, hair: 0xe4e4e7, skin: 0xf5d0a9, accent: 0xe4e4e7 },
  default: { shirt: 0x5a7a5a, hair: 0x3a3a4a, skin: 0xf5d0a9, accent: 0xffd700 },
};

type Facing = "S" | "N" | "E" | "W";

function drawCharacter(
  g: PIXI.Graphics,
  facing: Facing,
  walkFrame: 0 | 1 | 2 | 3,
  palette: { shirt: number; hair: number; skin: number; accent: number },
  status: string,
) {
  // Character is 8 wide × 12 tall, drawn centered on (0,0) with feet at y≈+6
  // Pixel size is 1 PIXI unit; the container is then upscaled by AGENT_SCALE.
  g.clear();
  const px = (x: number, y: number, c: number) => {
    g.beginFill(c);
    g.drawRect(x, y, 1, 1);
    g.endFill();
  };

  // Shadow (always under feet)
  g.beginFill(COLORS.shadow, 0.3);
  g.drawEllipse(0, 7, 3, 1);
  g.endFill();

  // Head (4x4 block)
  const headY = -6;
  for (let yy = 0; yy < 4; yy++)
    for (let xx = 0; xx < 4; xx++) px(-2 + xx, headY + yy, palette.skin);

  // Hair on top
  for (let xx = 0; xx < 4; xx++) px(-2 + xx, headY, palette.hair);
  if (facing !== "N") {
    // Side fringe on south/E/W
    px(-2, headY + 1, palette.hair);
    px(1, headY + 1, palette.hair);
  }

  // Eyes / mouth — only on facing-S characters (player facing camera)
  if (facing === "S") {
    px(-1, headY + 2, COLORS.shadow);
    px(0, headY + 2, COLORS.shadow);
  } else if (facing === "E") {
    px(1, headY + 2, COLORS.shadow);
  } else if (facing === "W") {
    px(-2, headY + 2, COLORS.shadow);
  } else {
    // N: no eyes (back of head)
  }

  // Torso (4w x 4h) — shirt color
  const torsoY = -2;
  for (let yy = 0; yy < 4; yy++)
    for (let xx = 0; xx < 4; xx++) px(-2 + xx, torsoY + yy, palette.shirt);

  // Belt accent
  for (let xx = 0; xx < 4; xx++) px(-2 + xx, torsoY + 3, palette.accent);

  // Arms — 1px each side, shift on walk frames for swing
  const armSwing = walkFrame === 1 ? 1 : walkFrame === 3 ? -1 : 0;
  px(-3, torsoY + armSwing, palette.shirt);
  px(-3, torsoY + 1 + armSwing, palette.shirt);
  px(2, torsoY - armSwing, palette.shirt);
  px(2, torsoY + 1 - armSwing, palette.shirt);

  // Legs — alternate per frame
  const legY = 2;
  const legShift = walkFrame === 1 ? 1 : walkFrame === 3 ? -1 : 0;
  // left leg
  px(-1, legY, palette.shirt);
  px(-1, legY + 1, COLORS.shadow);
  px(-1, legY + 2 + legShift, COLORS.shadow);
  // right leg
  px(0, legY, palette.shirt);
  px(0, legY + 1, COLORS.shadow);
  px(0, legY + 2 - legShift, COLORS.shadow);

  // Status indicator dot above head
  const sc = STATUS_COLORS[status] || STATUS_COLORS.idle;
  g.beginFill(sc);
  g.drawRect(-1, headY - 3, 2, 2);
  g.endFill();
  g.beginFill(sc, 0.3);
  g.drawRect(-2, headY - 4, 4, 3);
  g.endFill();
}

// ════════════════════════════════════════════════════════════════
// ZONE — a workstation cluster inside a building
// ════════════════════════════════════════════════════════════════

interface Seat {
  x: number;
  y: number;
  occupiedBy: string | null;
  facing: Facing;
}

class Zone {
  container: PIXI.Container;
  bg: PIXI.Graphics;
  decor: PIXI.Graphics;
  label: PIXI.Graphics;
  kind: ZoneKind;
  seats: Seat[] = [];
  // Local coords within building
  ox: number;
  oy: number;
  w: number;
  h: number;

  constructor(kind: ZoneKind, ox: number, oy: number, w: number, h: number) {
    this.kind = kind;
    this.ox = ox;
    this.oy = oy;
    this.w = w;
    this.h = h;
    this.container = new PIXI.Container();
    this.container.position.set(ox, oy);
    this.bg = new PIXI.Graphics();
    this.decor = new PIXI.Graphics();
    this.label = new PIXI.Graphics();
    this.container.addChild(this.bg, this.decor, this.label);
    this.draw();
    this.layoutSeats();
  }

  private draw() {
    this.bg.clear();
    // Floor pad
    this.bg.beginFill(ZONE_BG[this.kind]);
    this.bg.drawRoundedRect(0, 0, this.w, this.h, 4);
    this.bg.endFill();
    // Inner highlight
    this.bg.lineStyle(1, COLORS.gold, 0.18);
    this.bg.drawRoundedRect(1, 1, this.w - 2, this.h - 2, 4);
    this.bg.lineStyle(0);

    // Decor: workstation items per zone
    this.drawDecor();
    // Cozy-room sprite overlay (graceful fallback if not loaded)
    this.addSpriteDecor();

    // Label
    this.label.clear();
    const name = ZONE_LABEL[this.kind];
    const tw = measureText(name, 1);
    drawText(this.label, name, (this.w - tw) / 2, this.h - 8, COLORS.gold, 1);
    // Zone tag (top-left)
    const ic = ZONE_ICON[this.kind];
    drawText(this.label, ic, 4, 4, COLORS.gold, 1);
  }

  private drawDecor() {
    const g = this.decor;
    g.clear();
    const w = this.w;
    const h = this.h;
    const seatRows = this.kind === "terminal" || this.kind === "lounge" ? 2 : 1;
    const seatCols = this.zoneCapacity() / seatRows;

    switch (this.kind) {
      case "terminal": {
        // Multi-monitor setups with colored scanlines
        for (let i = 0; i < seatCols; i++) {
          const cx = 10 + i * ((w - 20) / seatCols) + ((w - 20) / seatCols) / 2;
          // Primary monitor
          g.beginFill(0x0a0a0a);
          g.drawRect(cx - 7, 10, 14, 10);
          g.endFill();
          g.beginFill(0x22c55e);
          g.drawRect(cx - 6, 11, 12, 8);
          g.endFill();
          // Scanlines on screen
          g.beginFill(0x0a0a0a, 0.3);
          for (let sl = 0; sl < 4; sl++) {
            g.drawRect(cx - 6, 12 + sl * 2, 12, 1);
          }
          g.endFill();
          // Screen content dots
          g.beginFill(0x0a0a0a);
          g.drawRect(cx - 5, 13, 2, 1);
          g.drawRect(cx - 1, 15, 4, 1);
          g.drawRect(cx - 4, 17, 3, 1);
          g.endFill();
          // Secondary stacked monitor
          g.beginFill(0x0a0a0a);
          g.drawRect(cx + 2, 4, 8, 6);
          g.endFill();
          g.beginFill(0x3b82f6);
          g.drawRect(cx + 3, 5, 6, 4);
          g.endFill();
          // Monitor stand
          g.beginFill(0x333333);
          g.drawRect(cx - 1, 20, 3, 2);
          g.drawRect(cx - 3, 22, 6, 1);
          g.endFill();
          // Cable management tray under desk
          g.beginFill(0x222222);
          g.drawRect(cx - 5, 24, 10, 2);
          g.endFill();
          g.beginFill(COLORS.steelSilver, 0.3);
          g.drawRect(cx - 4, 24, 8, 1);
          g.endFill();
        }
        // Ergonomic chairs (small U shapes)
        for (let i = 0; i < seatCols; i++) {
          const chx = 10 + i * ((w - 20) / seatCols) + ((w - 20) / seatCols) / 2;
          g.beginFill(0x2a2a3a);
          g.drawRoundedRect(chx - 4, h - 16, 8, 6, 2);
          g.endFill();
          // Chair back
          g.beginFill(0x2a2a3a, 0.6);
          g.drawRect(chx - 3, h - 14, 1, 4);
          g.drawRect(chx + 3, h - 14, 1, 4);
          g.endFill();
        }
        // Small whiteboard on wall (top right)
        g.beginFill(0xe8e8e8);
        g.drawRect(w - 26, 2, 22, 14);
        g.endFill();
        g.beginFill(0x1a1a1a, 0.5);
        g.drawRect(w - 24, 4, 4, 2);
        g.drawRect(w - 18, 4, 8, 2);
        g.drawRect(w - 24, 8, 6, 1);
        g.endFill();
        // Coffee cup holder attached to desk
        g.beginFill(COLORS.steelSilver, 0.6);
        g.drawRect(4, 24, 4, 4);
        g.endFill();
        g.beginFill(0x6a4a2a);
        g.drawCircle(6, 25, 2);
        g.endFill();
        break;
      }
      case "library": {
        // Floor-to-ceiling bookshelves (filled with colored book spines)
        g.beginFill(0x4a2a1a);
        g.drawRect(4, 4, w - 8, 8);
        g.drawRect(4, h - 18, w - 8, 10);
        g.endFill();
        // Book spines at different heights and colors
        const bookColors = [0xb04e1e, 0x643b1c, 0x1a4a6a, 0x4a1a4a, 0x3a5a2a, 0x8a6a3a, 0x2a2a6a, 0x6a2a2a];
        for (let shelf = 0; shelf < 2; shelf++) {
          const shelfY = shelf === 0 ? 5 : h - 17;
          const shelfH = shelf === 0 ? 6 : 8;
          for (let i = 0; i < 12; i++) {
            const bh = shelfH - ((i * 3) % 3);
            g.beginFill(bookColors[i % bookColors.length]);
            g.drawRect(6 + i * ((w - 12) / 12), shelfY + (shelfH - bh), ((w - 12) / 12) - 1, bh);
            g.endFill();
          }
        }
        // Reading lamp (desk lamp shape)
        const lx = w / 2 - 8;
        g.beginFill(COLORS.gold, 0.5);
        g.drawPolygon([lx, 22, lx + 8, 22, lx + 6, 19]);
        g.endFill();
        g.beginFill(COLORS.streetLampPost);
        g.drawRect(lx + 3, 22, 1, 5);
        g.endFill();
        // Ladder on rails (right side)
        g.beginFill(COLORS.steelSilver, 0.4);
        g.drawRect(w - 7, 12, 3, h - 24);
        g.endFill();
        for (let rung = 0; rung < 4; rung++) {
          g.beginFill(COLORS.steelSilver, 0.3);
          g.drawRect(w - 7, 14 + rung * 8, 3, 1);
          g.endFill();
        }
        // Globe on stand (left side)
        g.beginFill(0x2a5a6a);
        g.drawCircle(8, 18, 3);
        g.endFill();
        g.beginFill(0x3a7a8a, 0.5);
        g.drawCircle(8, 17, 2);
        g.endFill();
        g.beginFill(COLORS.steelSilver);
        g.drawRect(7, 21, 2, 3);
        g.drawRect(6, 24, 4, 1);
        g.endFill();
        // Magnifying glass
        g.beginFill(COLORS.steelSilver, 0.4);
        g.drawCircle(w / 2 + 12, 20, 2);
        g.endFill();
        g.beginFill(COLORS.steelSilver, 0.3);
        g.drawRect(w / 2 + 13, 21, 1, 3);
        g.endFill();
        // Small book cart
        g.beginFill(0x6a4a2a);
        g.drawRect(4, h - 26, 10, 5);
        g.endFill();
        g.beginFill(COLORS.steelSilver, 0.3);
        g.drawCircle(5, h - 20, 2);
        g.drawCircle(12, h - 20, 2);
        g.endFill();
        // Reading desks
        for (let i = 0; i < seatCols; i++) {
          const x = 14 + i * ((w - 28) / seatCols);
          g.beginFill(0x6b3e1f);
          g.drawRect(x, h - 14, ((w - 28) / seatCols) - 4, 4);
          g.endFill();
        }
        break;
      }
      case "drafting": {
        // Inspiration board with pinned items (top area)
        g.beginFill(0xe8e8e8);
        g.drawRect(4, 2, w - 8, 14);
        g.endFill();
        // Pinned items on board (colored rectangles with pin dots)
        const pinColors = [0xef4444, 0x3b82f6, 0x22c55e, 0xfbbf24];
        for (let p = 0; p < 5; p++) {
          const px = 6 + p * ((w - 16) / 5);
          g.beginFill(p % 2 === 0 ? 0x1a1a1a : 0x4a4a4a);
          g.drawRect(px, 4, ((w - 16) / 5) - 3, 6);
          g.endFill();
          // Pin dot
          g.beginFill(pinColors[p % pinColors.length]);
          g.drawRect(px + ((w - 16) / 10) - 1, 3, 2, 2);
          g.endFill();
        }
        // Whiteboard section
        g.beginFill(0xe8e8e8);
        g.drawRect(4, 18, w - 8, 4);
        g.endFill();
        g.beginFill(0x1a1a1a);
        g.drawRect(5, 19, 6, 2);
        g.drawRect(15, 19, 4, 2);
        g.drawRect(21, 19, 8, 2);
        g.endFill();
        // Large tilted drawing tables
        for (let i = 0; i < seatCols; i++) {
          const x = 14 + i * ((w - 28) / seatCols);
          const tw = ((w - 28) / seatCols) - 4;
          // Table surface (slightly angled look)
          g.beginFill(0x8a6a3a);
          g.drawRect(x, h - 24, tw, 8);
          g.endFill();
          // T-square across table
          g.beginFill(COLORS.steelSilver, 0.5);
          g.drawRect(x + 1, h - 22, tw - 2, 1);
          g.drawRect(x + tw / 2, h - 24, 1, 8);
          g.endFill();
          // Paper on table
          g.beginFill(0xe8e8e8, 0.4);
          g.drawRect(x + 3, h - 21, tw - 6, 4);
          g.endFill();
        }
        // Blueprint tubes in rack (right wall)
        g.beginFill(COLORS.steelSilver, 0.3);
        g.drawRect(w - 8, 24, 6, h - 32);
        g.endFill();
        const tubeColors = [0x3b82f6, 0x22c55e, 0xfbbf24, 0xef4444];
        for (let t = 0; t < 4; t++) {
          g.beginFill(tubeColors[t], 0.5);
          g.drawRect(w - 7, 26 + t * 8, 4, 6);
          g.endFill();
          // Cap
          g.beginFill(COLORS.steelSilver, 0.4);
          g.drawRect(w - 7, 26 + t * 8, 4, 1);
          g.endFill();
        }
        // Pencil holder with different sizes
        g.beginFill(0x444444);
        g.drawRect(3, h - 26, 5, 5);
        g.endFill();
        const pencilColors = [0xfbbf24, 0xef4444, 0x3b82f6];
        for (let p = 0; p < 3; p++) {
          g.beginFill(pencilColors[p]);
          g.drawRect(4 + p, h - 28 - p, 1, 4 + p);
          g.endFill();
        }
        // Paper bin
        g.beginFill(COLORS.steelSilver, 0.3);
        g.drawRect(w - 12, h - 14, 6, 6);
        g.endFill();
        g.beginFill(0xe8e8e8, 0.2);
        g.drawRect(w - 11, h - 13, 4, 1);
        g.endFill();
        break;
      }
      case "comm": {
        // Switchboard/console with multiple indicator lights
        for (let i = 0; i < seatCols; i++) {
          const x = 14 + i * ((w - 28) / seatCols);
          const cw = ((w - 28) / seatCols) - 4;
          // Console body
          g.beginFill(0x3a2a4a);
          g.drawRect(x, 8, cw, 16);
          g.endFill();
          // Indicator lights row
          const lightColors = [0x22c55e, 0xfbbf24, 0xef4444, 0x3b82f6];
          for (let li = 0; li < 4; li++) {
            g.beginFill(lightColors[li], 0.7);
            g.drawRect(x + 2 + li * 3, 10, 2, 2);
            g.endFill();
            // Glow
            g.beginFill(lightColors[li], 0.15);
            g.drawRect(x + 1 + li * 3, 9, 4, 4);
            g.endFill();
          }
          // Antenna
          g.beginFill(COLORS.gold);
          g.drawRect(x + cw / 2, 4, 1, 4);
          g.endFill();
          g.beginFill(COLORS.gold, 0.5);
          g.drawRect(x + cw / 2 - 1, 3, 3, 1);
          g.endFill();
          // Switches
          for (let sw = 0; sw < 3; sw++) {
            g.beginFill(COLORS.steelSilver, 0.4);
            g.drawRect(x + 2 + sw * 4, 14, 3, 2);
            g.endFill();
          }
        }
        // Headset on hook (right side)
        g.beginFill(COLORS.steelSilver);
        g.drawRect(w - 14, 6, 1, 8);
        g.endFill();
        g.beginFill(0x1a1a2a);
        g.drawRoundedRect(w - 16, 14, 5, 4, 2);
        g.endFill();
        // Earpiece
        g.beginFill(0x2a2a3a);
        g.drawRect(w - 11, 8, 2, 3);
        g.endFill();
        // Message queue display (scrolling dots)
        g.beginFill(0x0a0a1a);
        g.drawRect(4, 26, w / 3, 6);
        g.endFill();
        for (let d = 0; d < 8; d++) {
          g.beginFill(COLORS.gold, 0.4 + (d % 3) * 0.15);
          g.drawRect(6 + d * ((w / 3 - 4) / 8), 28, 1, 2);
          g.endFill();
        }
        // Intercom speaker (left wall)
        g.beginFill(COLORS.steelSilver, 0.4);
        g.drawRect(2, 10, 3, 8);
        g.endFill();
        for (let gr = 0; gr < 3; gr++) {
          g.beginFill(0x333333);
          g.drawRect(3, 12 + gr * 2, 1, 1);
          g.endFill();
        }
        // Clipboard rack
        g.beginFill(COLORS.woodBrown, 0.5);
        g.drawRect(w - 8, 22, 6, h - 28);
        g.endFill();
        g.beginFill(0xe8e8e8, 0.3);
        g.drawRect(w - 7, 24, 4, 5);
        g.drawRect(w - 7, 32, 4, 5);
        g.endFill();
        // World time zone clocks (3 small clocks)
        for (let c = 0; c < 3; c++) {
          const cx = 4 + c * 16;
          const cy = h - 12;
          g.beginFill(COLORS.steelSilver, 0.4);
          g.drawCircle(cx + 5, cy, 4);
          g.endFill();
          g.beginFill(0x0a0a0a);
          g.drawCircle(cx + 5, cy, 3);
          g.endFill();
          // Clock hand
          g.beginFill(COLORS.whitePaint, 0.5);
          g.drawRect(cx + 5, cy - 2, 1, 2);
          g.drawRect(cx + 5, cy, 2, 1);
          g.endFill();
        }
        break;
      }
      case "browser": {
        for (let i = 0; i < seatCols; i++) {
          const x = 14 + i * ((w - 28) / seatCols);
          g.beginFill(0x0e2e3a);
          g.drawRect(x, 10, ((w - 28) / seatCols) - 4, 10);
          g.endFill();
          // Address bar
          g.beginFill(0x3aa8c8, 0.7);
          g.drawRect(x + 1, 11, ((w - 28) / seatCols) - 6, 2);
          g.endFill();
          // Content
          g.beginFill(0xe4e4e7);
          g.drawRect(x + 1, 14, 4, 1);
          g.drawRect(x + 1, 16, 6, 1);
          g.endFill();
          // Tab row
          g.beginFill(COLORS.steelSilver, 0.3);
          g.drawRect(x + 1, 10, 6, 1);
          g.endFill();
          // Scroll bar
          g.beginFill(COLORS.steelSilver, 0.2);
          g.drawRect(x + ((w - 28) / seatCols) - 5, 13, 1, 6);
          g.endFill();
        }
        break;
      }
      case "kanban": {
        // Kanban board grid (3 columns x 4 cards)
        g.beginFill(0xe4e4e7);
        g.drawRect(8, 10, w - 16, h - 22);
        g.endFill();
        const colW = (w - 20) / 3;
        for (let c = 0; c < 3; c++) {
          g.beginFill(c === 0 ? 0xcccccc : c === 1 ? 0xffe599 : 0xb6d7a8);
          g.drawRect(10 + c * colW, 12, colW - 2, 8);
          g.endFill();
          for (let r = 0; r < 3; r++) {
            g.beginFill(0xfafafa);
            g.drawRect(10 + c * colW, 22 + r * 7, colW - 2, 5);
            g.endFill();
          }
        }
        break;
      }
      case "records": {
        // Filing cabinets
        for (let i = 0; i < seatCols + 1; i++) {
          const x = 8 + i * ((w - 16) / (seatCols + 1));
          g.beginFill(0x444a55);
          g.drawRect(x, 10, ((w - 16) / (seatCols + 1)) - 2, h - 20);
          g.endFill();
          g.beginFill(0x222732);
          for (let row = 0; row < 4; row++) {
            g.drawRect(x + 1, 12 + row * 6, ((w - 16) / (seatCols + 1)) - 4, 1);
          }
          g.endFill();
          // Drawer handles
          for (let row = 0; row < 4; row++) {
            g.beginFill(COLORS.steelSilver, 0.3);
            g.drawRect(x + ((w - 16) / (seatCols + 1)) / 2 - 2, 13 + row * 6, 4, 1);
            g.endFill();
          }
        }
        break;
      }
      case "lounge": {
        // Bean bag chairs (rounded blobs)
        g.beginFill(0x5a2a5a);
        g.drawRoundedRect(6, h - 24, 14, 8, 4);
        g.endFill();
        g.beginFill(0x2a4a6a);
        g.drawRoundedRect(w - 22, h - 24, 14, 8, 4);
        g.endFill();
        // Couch (longer)
        g.beginFill(0x6a3a3a);
        g.drawRect(24, h - 24, w - 48, 8);
        g.endFill();
        g.beginFill(0x4a2a2a);
        g.drawRect(24, h - 16, w - 48, 2);
        g.endFill();
        // Coffee table
        g.beginFill(0x5a3a1a);
        g.drawRect(w / 2 - 10, h - 14, 20, 5);
        g.endFill();
        // Mini fridge (right side)
        g.beginFill(COLORS.steelSilver, 0.5);
        g.drawRect(w - 14, 4, 10, 14);
        g.endFill();
        g.beginFill(COLORS.steelSilver, 0.3);
        g.drawRect(w - 13, 5, 8, 1);
        g.drawRect(w - 13, 12, 8, 1);
        g.endFill();
        // Fridge handle
        g.beginFill(0x333333);
        g.drawRect(w - 5, 7, 1, 4);
        g.endFill();
        // Water cooler (next to fridge)
        g.beginFill(0x4a8aaa);
        g.drawRect(w - 26, 4, 5, 10);
        g.endFill();
        g.beginFill(0x6aaaca, 0.5);
        g.drawEllipse(w - 23, 3, 3, 2);
        g.endFill();
        // Snack vending machine
        g.beginFill(0x333344);
        g.drawRect(w - 40, 4, 12, 14);
        g.endFill();
        g.beginFill(0x1a1a2a);
        g.drawRect(w - 38, 6, 8, 8);
        g.endFill();
        const snackColors = [0xef4444, 0x22c55e, 0xfbbf24, 0x3b82f6];
        for (let s = 0; s < 4; s++) {
          g.beginFill(snackColors[s], 0.6);
          g.drawRect(w - 37 + s * 2, 7 + s * 2, 1, 1);
          g.endFill();
        }
        // Dispense tray
        g.beginFill(COLORS.steelSilver, 0.3);
        g.drawRect(w - 38, 15, 8, 2);
        g.endFill();
        // Dart board on wall (left side)
        g.beginFill(0x2a2a3a);
        g.drawCircle(8, 8, 5);
        g.endFill();
        g.beginFill(0xef4444, 0.5);
        g.drawCircle(8, 8, 3);
        g.endFill();
        g.beginFill(0x22c55e, 0.5);
        g.drawCircle(8, 8, 2);
        g.endFill();
        g.beginFill(0xef4444, 0.7);
        g.drawRect(7, 7, 2, 2);
        g.endFill();
        // Fish tank (bottom left)
        g.beginFill(0x1a3a5a, 0.6);
        g.drawRect(2, h - 14, 20, 8);
        g.endFill();
        g.beginFill(0x3aaa6a, 0.3);
        g.drawRect(4, h - 11, 3, 2);
        g.endFill();
        g.beginFill(0xef8844, 0.4);
        g.drawRect(12, h - 10, 2, 1);
        g.drawRect(15, h - 9, 2, 1);
        g.endFill();
        // Bubbles
        g.beginFill(0x4a8aaa, 0.2);
        g.drawCircle(6, h - 12, 1);
        g.drawCircle(10, h - 13, 1);
        g.endFill();
        // Magazine rack
        g.beginFill(COLORS.woodBrown, 0.5);
        g.drawRect(22, 4, 3, 10);
        g.endFill();
        g.beginFill(COLORS.gold, 0.3);
        g.drawRect(23, 5, 1, 3);
        g.drawRect(23, 9, 1, 3);
        g.endFill();
        // Hammock/couch area indicator
        g.beginFill(0x8a6a4a, 0.3);
        g.drawRoundedRect(w / 2 - 20, 6, 40, 4, 2);
        g.endFill();
        // Plant (original + upgraded)
        g.beginFill(0x2a4a1a);
        g.drawCircle(w - 8, 20, 4);
        g.endFill();
        g.beginFill(COLORS.treeGreenLight, 0.4);
        g.drawCircle(w - 9, 19, 2);
        g.endFill();
        g.beginFill(0x6a4a2a);
        g.drawRect(w - 9, 22, 3, 4);
        g.endFill();
        break;
      }
      case "entry": {
        // Door + welcome mat
        g.beginFill(0x5a4a3a);
        g.drawRect(w / 2 - 6, 4, 12, 14);
        g.endFill();
        // Door window
        g.beginFill(0x2a3a5a, 0.5);
        g.drawRect(w / 2 - 4, 6, 4, 4);
        g.endFill();
        g.beginFill(COLORS.gold);
        g.drawRect(w / 2 + 3, 11, 2, 2);
        g.endFill();
        // Welcome mat
        g.beginFill(0x8a3030);
        g.drawRect(w / 2 - 10, h - 14, 20, 6);
        g.endFill();
        g.beginFill(0xb04545);
        g.drawRect(w / 2 - 9, h - 13, 18, 4);
        g.endFill();
        // Overhead light
        g.beginFill(COLORS.streetLampGlow, 0.3);
        g.drawEllipse(w / 2, 3, 5, 2);
        g.endFill();
        break;
      }
    }
  }

  private zoneCapacity(): number {
    switch (this.kind) {
      case "terminal":
        return 6;
      case "library":
        return 4;
      case "drafting":
        return 4;
      case "comm":
        return 3;
      case "browser":
        return 3;
      case "kanban":
        return 2;
      case "records":
        return 3;
      case "lounge":
        return 4;
      case "entry":
        return 2;
      default:
        return 4;
    }
  }

  private layoutSeats() {
    const cap = this.zoneCapacity();
    const rows = this.kind === "terminal" || this.kind === "lounge" ? 2 : 1;
    const cols = cap / rows;
    const padX = 14;
    const padY = this.kind === "entry" ? 26 : 30;
    const innerW = this.w - padX * 2;
    const stepX = cols > 1 ? innerW / (cols - 1) : 0;
    const stepY = rows > 1 ? 12 : 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = padX + (cols > 1 ? c * stepX : innerW / 2);
        const y = padY + r * stepY;
        const facing: Facing =
          this.kind === "lounge"
            ? "S"
            : this.kind === "terminal" || this.kind === "browser"
              ? "N"
              : "S";
        this.seats.push({ x, y, occupiedBy: null, facing });
      }
    }
  }

  /** Claim the first free seat for an agent (or current seat if already inside). */
  claimSeat(sessionKey: string): Seat | null {
    // Stay on existing seat
    for (const s of this.seats) if (s.occupiedBy === sessionKey) return s;
    // Take first open
    for (const s of this.seats)
      if (!s.occupiedBy) {
        s.occupiedBy = sessionKey;
        return s;
      }
    // Overflow: stand at zone center
    return null;
  }

  releaseSeat(sessionKey: string) {
    for (const s of this.seats)
      if (s.occupiedBy === sessionKey) s.occupiedBy = null;
  }

  /** World-local position of a seat (relative to building origin). */
  worldOf(seat: Seat | null): { x: number; y: number; facing: Facing } {
    if (!seat) {
      return { x: this.ox + this.w / 2, y: this.oy + this.h / 2, facing: "S" };
    }
    return { x: this.ox + seat.x, y: this.oy + seat.y, facing: seat.facing };
  }

  /** Overlay cozy-room sprite textures on zones when loaded (graceful Graphics fallback). */
  private addSpriteDecor() {
    if (!areTexturesLoaded()) return;
    const w = this.w;
    const h = this.h;

    if (this.kind === "terminal") {
      const seatCols = this.zoneCapacity() / 2;
      for (let i = 0; i < seatCols; i++) {
        const cx = 10 + i * ((w - 20) / seatCols) + ((w - 20) / seatCols) / 2;
        const desk = createDeskSprite(i % 2 === 0 ? "gray" : "beige");
        if (desk) {
          desk.scale.set(0.55);
          desk.position.set(cx, 14);
          desk.zIndex = 50;
          this.container.addChild(desk);
        }
        const chair = createChairSprite(i % 2 === 0 ? "black" : "blue");
        if (chair) {
          chair.scale.set(0.55);
          chair.position.set(cx, h - 12);
          chair.zIndex = 48;
          this.container.addChild(chair);
        }
      }
    } else if (this.kind === "lounge") {
      // Accent sofa on left side
      const sofa = createSofaSprite("brown");
      if (sofa) {
        sofa.scale.set(0.55);
        sofa.position.set(w * 0.3, h - 14);
        sofa.zIndex = 50;
        this.container.addChild(sofa);
      }
      const sofa2 = createSofaSprite("red");
      if (sofa2) {
        sofa2.scale.set(0.5);
        sofa2.position.set(w * 0.6, h - 12);
        sofa2.zIndex = 49;
        this.container.addChild(sofa2);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════
// BUILDING — federation node as a multi-zone floor
// ════════════════════════════════════════════════════════════════

const BUILDING_WIDTH = 760;
const BUILDING_HEIGHT = 360;

class Building {
  container: PIXI.Container;
  shell: PIXI.Graphics;
  roof: PIXI.Graphics;
  labelG: PIXI.Graphics;
  zonesLayer: PIXI.Container;
  agentsLayer: PIXI.Container;
  effectsLayer: PIXI.Container;
  zones: Map<ZoneKind, Zone> = new Map();
  data: MeshNode;

  // Receptionist greeter in the entry zone
  private receptionistG: PIXI.Graphics | null = null;
  waveFrame = 0;

  private waveAnimator: PacedAnimator;
  private statusBlink = 0;

  constructor(node: MeshNode, pacing?: PacingConfig) {
    this.data = node;
    this.container = new PIXI.Container();
    this.container.sortableChildren = true;
    this.shell = new PIXI.Graphics();
    this.roof = new PIXI.Graphics();
    this.labelG = new PIXI.Graphics();
    this.zonesLayer = new PIXI.Container();
    this.agentsLayer = new PIXI.Container();
    this.agentsLayer.sortableChildren = true;
    this.effectsLayer = new PIXI.Container();
    this.container.addChild(
      this.shell,
      this.zonesLayer,
      this.agentsLayer,
      this.effectsLayer,
      this.roof,
      this.labelG,
    );
    this.buildShell();
    this.buildZones();
    this.buildReceptionist();
    this.drawLabel();
    this.waveAnimator = new PacedAnimator(4, pacing?.receptionistWaveFps ?? DEFAULT_PACING.receptionistWaveFps);
  }

  /** Count of currently-working agents inside this building. */
  private workingCount = 0;

  setWorkingCount(n: number) {
    if (n === this.workingCount) return;
    this.workingCount = Math.max(0, n);
    this.drawLabel();
  }

  private buildShell() {
    const g = this.shell;
    g.clear();
    const w = BUILDING_WIDTH;
    const h = BUILDING_HEIGHT;

    // Foundation / isometric 3D base shadow
    g.beginFill(0x0a0e16, 0.6);
    g.drawRoundedRect(6, 16, w, h, 12);
    g.endFill();
    g.beginFill(COLORS.shadow, 0.35);
    g.drawRoundedRect(4, 12, w, h, 12);
    g.endFill();

    // Floor
    g.beginFill(COLORS.buildingFloor);
    g.drawRoundedRect(0, 0, w, h, 12);
    g.endFill();

    // Two-tone diamond checkerboard parquet
    const tileSize = 12;
    for (let ty = 8; ty < h - 4; ty += tileSize) {
      for (let tx = 8; tx < w - 4; tx += tileSize) {
        const checker = ((Math.floor(tx / tileSize) + Math.floor(ty / tileSize)) % 2) === 0;
        g.beginFill(checker ? COLORS.buildingFloor : COLORS.buildingFloorAlt, checker ? 0.55 : 0.4);
        g.drawRect(tx, ty, tileSize - 1, tileSize - 1);
        g.endFill();
      }
    }

    // Wall panel/brick texture between gold border and interior
    g.lineStyle(0);
    for (let y = WALL_TH + 4; y < h - WALL_TH - 4; y += 8) {
      const offset = (Math.floor(y / 8) % 2) === 0 ? 0 : 10;
      for (let bx = WALL_TH + offset; bx < w - WALL_TH; bx += 20) {
        g.beginFill(0x1a212d, 0.12);
        g.drawRect(bx, y, 18, 6);
        g.endFill();
        g.lineStyle(0.5, 0x151b26, 0.15);
        g.drawRect(bx, y, 18, 6);
        g.lineStyle(0);
      }
    }

    // Gold kick-plate / baseboard strip at bottom
    g.beginFill(COLORS.buildingTrim, 0.8);
    g.drawRect(4, h - 8, w - 8, 4);
    g.endFill();
    g.beginFill(COLORS.buildingTrim, 0.4);
    g.drawRect(4, h - 12, w - 8, 2);
    g.endFill();

    // Inner border / wall stub
    g.lineStyle(WALL_TH, COLORS.wall);
    g.drawRoundedRect(WALL_TH / 2, WALL_TH / 2, w - WALL_TH, h - WALL_TH, 10);
    g.lineStyle(0);
    // Wall top highlight (gold trim)
    g.lineStyle(2, COLORS.buildingTrim, 0.7);
    g.drawRoundedRect(2, 2, w - 4, h - 4, 9);
    g.lineStyle(0);

    // Corner pillar decorations (gold-capped at 4 corners)
    const pillarW = 8;
    const pillarH = 14;
    const capH = 4;
    const corners = [
      [6, 6],
      [w - 6 - pillarW, 6],
      [6, h - 6 - pillarH],
      [w - 6 - pillarW, h - 6 - pillarH],
    ] as const;
    for (const [px, py] of corners) {
      g.beginFill(0x2a3344);
      g.drawRect(px, py + capH, pillarW, pillarH - capH);
      g.endFill();
      g.beginFill(COLORS.buildingTrim, 0.85);
      g.drawRect(px - 1, py, pillarW + 2, capH);
      g.endFill();
      g.lineStyle(0.5, COLORS.buildingTrim, 0.4);
      g.drawRect(px, py + capH, pillarW, pillarH - capH);
      g.lineStyle(0);
    }

    // Horizontal window strips along outer walls (top and bottom rows)
    const winMarginX = 60;
    const winW = 10;
    const winH = 8;
    const winGap = 4;
    const topWinY = WALL_TH + 2;
    const botWinY = h - WALL_TH - winH - 2;
    for (let wx = winMarginX; wx + winW < w - winMarginX; wx += winW + winGap) {
      const lit = ((wx / (winW + winGap)) | 0) % 3 !== 0;
      const c = lit ? 0xffe9a8 : 0x121a26;
      g.beginFill(c, lit ? 0.5 : 0.35);
      g.drawRect(wx, topWinY, winW, winH);
      g.endFill();
      g.beginFill(c, lit ? 0.5 : 0.35);
      g.drawRect(wx, botWinY, winW, winH);
      g.endFill();
      if (lit) {
        g.lineStyle(0.5, COLORS.buildingTrim, 0.4);
        g.moveTo(wx + winW / 2, topWinY);
        g.lineTo(wx + winW / 2, topWinY + winH);
        g.moveTo(wx, topWinY + winH / 2);
        g.lineTo(wx + winW, topWinY + winH / 2);
        g.moveTo(wx + winW / 2, botWinY);
        g.lineTo(wx + winW / 2, botWinY + winH);
        g.moveTo(wx, botWinY + winH / 2);
        g.lineTo(wx + winW, botWinY + winH / 2);
        g.lineStyle(0);
      }
    }
  }

  private buildZones() {
    // Layout zones in a 4-column grid inside the building.
    // Adapts to building width. Each zone is ~170x130.
    const padX = 18;
    const padY = 56; // leave room for the roof sign at top
    const cellW = 175;
    const cellH = 120;
    const gap = ZONE_GAP;

    const zonesOrder: ZoneKind[] = [
      "terminal",
      "library",
      "drafting",
      "comm",
      "browser",
      "kanban",
      "records",
      "lounge",
    ];
    const cols = 4;
    zonesOrder.forEach((k, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = padX + c * (cellW + gap);
      const y = padY + r * (cellH + gap);
      const zone = new Zone(k, x, y, cellW, cellH);
      this.zones.set(k, zone);
      this.zonesLayer.addChild(zone.container);
    });

    // Entry "door" on left wall
    const entry = new Zone("entry", -16, BUILDING_HEIGHT / 2 - 40, 28, 80);
    this.zones.set("entry", entry);
    this.zonesLayer.addChild(entry.container);
  }

  private buildReceptionist() {
    const entry = this.zones.get("entry");
    if (!entry) return;
    const g = new PIXI.Graphics();
    g.scale.set(2.2);
    // Stand just inside the entry zone, feet near the welcome mat.
    g.position.set(entry.w / 2, entry.h - 16);
    this.receptionistG = g;
    entry.container.addChild(g);
    this.drawReceptionist();
  }

  private drawReceptionist() {
    if (!this.receptionistG) return;
    this.receptionistG.clear();
    drawReceptionist(this.receptionistG, 0, 0, this.waveFrame);
  }

  private drawLabel() {
    const g = this.labelG;
    g.clear();
    // Roof sign across top
    const signH = 28;
    const w = BUILDING_WIDTH;
    g.beginFill(COLORS.roof);
    g.drawRoundedRect(0, -signH - 2, w, signH, 6);
    g.endFill();
    g.beginFill(COLORS.roofTrim, 0.9);
    g.drawRoundedRect(0, -2, w, 2, 0);
    g.endFill();
    // Sign text
    const name = (this.data.name || this.data.id || "NODE").toUpperCase();
    const tw = measureText(name, 2);
    drawText(g, name, (w - tw) / 2, -signH + 6, COLORS.gold, 2);

    // Status light
    const status = this.data.status;
    const color =
      status === "online"
        ? COLORS.online
        : status === "connecting"
          ? COLORS.connecting
          : COLORS.offline;
    g.beginFill(color);
    g.drawCircle(w - 18, -signH / 2 - 1, 5);
    g.endFill();
    g.beginFill(color, 0.3);
    g.drawCircle(w - 18, -signH / 2 - 1, 10);
    g.endFill();

    // Agent count / role badge
    const sub = `${(this.data.role || "node").toUpperCase()}  ${this.data.agentCount || 0} AGENTS`;
    drawText(g, sub, 12, -signH + 18, COLORS.textDim, 1);

    // ── Wave-1 additive draws (appended after the roof-sign block) ──
    // Grow a second storey for busy buildings (>12 agents).
    if ((this.data.agentCount || 0) > 12) {
      const total = Math.min(12, this.data.agentCount || 0);
      const litCount = Math.max(0, Math.min(total, this.workingCount));
      drawSecondFloor(g, BUILDING_WIDTH, litCount, total);
    }
    // Role-specific roof features (antennas, dish, chimney).
    drawRoofFeatures(
      g,
      (this.data.role || "local") as NodeRole,
      BUILDING_WIDTH,
      BUILDING_HEIGHT,
    );
    // Live hardware readout (no-ops when undefined). MeshNode has no hardware
    // field, so read it via cast — populated by the bridge when available.
    drawHardwareSignage(
      g,
      BUILDING_WIDTH,
      (this.data as any).hardware,
    );
    // Neon signage on building facade
    const neonColor =
      (this.data.role || "local") === "hub"
        ? COLORS.neonCyan
        : (this.data.role || "local") === "satellite"
          ? COLORS.neonMagenta
          : COLORS.gold;
    g.beginFill(neonColor, 0.06);
    g.drawEllipse(BUILDING_WIDTH / 2, BUILDING_HEIGHT + 2, 60, 6);
    g.endFill();
    g.beginFill(neonColor, 0.12);
    g.drawEllipse(BUILDING_WIDTH / 2, BUILDING_HEIGHT + 2, 30, 3);
    g.endFill();
  }

  update(data: MeshNode) {
    this.data = { ...this.data, ...data };
    this.drawLabel();
  }

  zoneOf(kind: ZoneKind): Zone {
    return this.zones.get(kind) || this.zones.get("drafting")!;
  }

  animate(dt: number, worldDtMs: number) {
    this.statusBlink += dt;
    // Subtle roof sign blink for connecting nodes
    if (this.data.status === "connecting") {
      this.labelG.alpha = 0.6 + 0.4 * Math.sin(this.statusBlink * 0.06);
    } else {
      this.labelG.alpha = 1;
    }
    // Receptionist wave cycle via PacedAnimator
    const newFrame = this.waveAnimator.update(worldDtMs);
    if (newFrame !== this.waveFrame) {
      this.waveFrame = newFrame as 0 | 1 | 2 | 3;
      this.drawReceptionist();
    }
  }
}

// ════════════════════════════════════════════════════════════════
// AGENT CHARACTER — pixel walker
// ════════════════════════════════════════════════════════════════

const AGENT_SCALE = 2.4;
const WALK_SPEED_PX = 95; // building-local px / sec

class AgentChar {
  container: PIXI.Container;
  bodyG: PIXI.Graphics;
  bodySprite: PIXI.Sprite;
  statusDotG: PIXI.Graphics;
  bubbleG: PIXI.Graphics;
  data: MeshAgent;

  // Position in building-local space
  pos: { x: number; y: number };
  target: { x: number; y: number; facing: Facing } | null = null;
  building: Building | null = null;
  zone: Zone | null = null;
  seat: Seat | null = null;
  facing: Facing = "S";
  walkFrame: 0 | 1 | 2 | 3 = 0;
  frameTimer = 0;
  palette: ReturnType<typeof inferProvider> extends never
    ? never
    : (typeof PROVIDER_PALETTE)[keyof typeof PROVIDER_PALETTE];
  showName = true;
  spokenAt = 0;
  bubbleText: string | null = null;

  // Sprite-atlas backing (when ready). providerKey selects the baked sheet.
  private atlas: SpriteAtlas | undefined;
  private providerKey: string;
  private blinkTimer = 0;
  private blinking = false;
  private lastDotStatus = "";

  // External: emit work particle each tick at zone
  private workTimer = 0;
  spawnParticle: ((x: number, y: number, color: number) => void) | null = null;
  // Engine-owned FX hook (WORLD coords resolved by the engine).
  emitWorkFx:
    | ((x: number, y: number, kind: ZoneKind) => void)
    | null = null;

  constructor(
    agent: MeshAgent,
    onClick?: (a: MeshAgent) => void,
    atlas?: SpriteAtlas,
  ) {
    this.data = agent;
    this.atlas = atlas;
    this.providerKey = inferProvider(agent);
    this.container = new PIXI.Container();
    this.container.sortableChildren = true;
    // Baked sprite sits behind the bubble; falls back to bodyG when no atlas.
    this.bodySprite = new PIXI.Sprite();
    this.bodySprite.anchor.set(0.5, 0.5);
    this.bodySprite.scale.set(AGENT_SCALE);
    this.bodySprite.visible = false;
    this.bodyG = new PIXI.Graphics();
    this.bodyG.scale.set(AGENT_SCALE);
    // Live status dot overlay (used when the sprite path is active — the baked
    // sprite carries only a neutral dot).
    this.statusDotG = new PIXI.Graphics();
    this.statusDotG.scale.set(AGENT_SCALE);
    this.statusDotG.visible = false;
    this.bubbleG = new PIXI.Graphics();
    this.bubbleG.zIndex = 100;
    this.container.addChildAt(this.bodySprite, 0);
    this.container.addChild(this.bodyG, this.statusDotG, this.bubbleG);
    this.pos = { x: 0, y: 0 };
    this.palette =
      PROVIDER_PALETTE[inferProvider(agent)] || PROVIDER_PALETTE.default;

    (this.container as any).interactive = true;
    (this.container as any).cursor = "pointer";
    if (onClick) {
      (this.container as any).on("pointertap", () => onClick(this.data));
    }
    this.redraw();
    this.drawNameTag();
  }

  private redraw() {
    if (this.atlas?.isReady()) {
      // 0..3 walk, 4 idle, 5 blink
      const frame = this.blinking ? 5 : this.target ? this.walkFrame : 4;
      const tex = this.atlas.charTexture(this.providerKey, this.facing, frame);
      if (tex) {
        this.bodySprite.texture = tex;
        this.bodySprite.visible = true;
        this.bodyG.visible = false;
        this.drawStatusDot();
        return;
      }
    }
    // Fallback: live per-pixel character render.
    this.bodySprite.visible = false;
    this.statusDotG.visible = false;
    this.bodyG.visible = true;
    drawCharacter(
      this.bodyG,
      this.facing,
      this.walkFrame,
      this.palette,
      this.data.status,
    );
  }

  /** Draw JUST the live status dot above the head when the sprite path is on. */
  private drawStatusDot() {
    if (this.lastDotStatus === this.data.status && this.statusDotG.visible)
      return;
    this.lastDotStatus = this.data.status;
    const g = this.statusDotG;
    g.clear();
    g.visible = true;
    // Match drawCharacter's dot geometry (headY = -6).
    const headY = -6;
    const sc = STATUS_COLORS[this.data.status] || STATUS_COLORS.idle;
    g.beginFill(sc);
    g.drawRect(-1, headY - 3, 2, 2);
    g.endFill();
    g.beginFill(sc, 0.3);
    g.drawRect(-2, headY - 4, 4, 3);
    g.endFill();
  }

  private drawNameTag() {
    const g = this.bubbleG;
    g.clear();
    if (!this.showName) return;
    const label = (this.data.label || this.data.agentId || "")
      .slice(0, 12)
      .toUpperCase();
    if (!label) return;
    const tw = measureText(label, 1);
    g.beginFill(0x000000, 0.55);
    g.drawRoundedRect(-tw / 2 - 3, -32, tw + 6, 9, 2);
    g.endFill();
    drawText(g, label, -tw / 2, -31, COLORS.gold, 1);
  }

  setStatus(status: string) {
    if (this.data.status === status) return;
    this.data.status = status;
    // Sprite path: only the live dot changes (texture is status-agnostic).
    if (this.bodySprite.visible) this.drawStatusDot();
    else this.redraw();
  }

  setData(data: Partial<MeshAgent>) {
    if (data.label !== undefined && data.label !== this.data.label) {
      this.data.label = data.label;
      this.drawNameTag();
    }
    if (data.status !== undefined) this.setStatus(data.status);
    if (data.progress !== undefined) this.data.progress = data.progress;
    if (data.currentTask !== undefined) this.data.currentTask = data.currentTask;
    if ((data as any).lastActivity !== undefined)
      (this.data as any).lastActivity = (data as any).lastActivity;
    if ((data as any).lastActivityKind !== undefined)
      (this.data as any).lastActivityKind = (data as any).lastActivityKind;
  }

  /** Set agent's target zone within its building. Releases prior seat. */
  setZone(building: Building, zoneKind: ZoneKind) {
    // Snap building reference if first time
    if (!this.building) {
      this.building = building;
      // Spawn at entry zone center
      const entry = building.zoneOf("entry");
      const start = entry.worldOf(entry.seats[0] || null);
      this.pos = { x: start.x, y: start.y };
    }
    if (this.building !== building) {
      // moved nodes (rare) — fully re-place
      if (this.zone) this.zone.releaseSeat(this.data.sessionKey);
      this.building = building;
    }
    const newZone = building.zoneOf(zoneKind);
    if (newZone === this.zone) return; // already there
    if (this.zone) this.zone.releaseSeat(this.data.sessionKey);
    this.zone = newZone;
    this.seat = newZone.claimSeat(this.data.sessionKey);
    const wo = newZone.worldOf(this.seat);
    this.target = wo;
    // Cancel any in-progress idle blink when a walk begins.
    this.blinking = false;
    this.blinkTimer = 0;
    if (this.atlas?.isReady()) this.redraw();
  }

  /** Toward the target seat in building-local coords. */
  update(dt: number) {
    if (this.target) {
      const dx = this.target.x - this.pos.x;
      const dy = this.target.y - this.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = WALK_SPEED_PX * dt;
      if (dist <= step + 0.5) {
        this.pos.x = this.target.x;
        this.pos.y = this.target.y;
        this.facing = this.target.facing;
        this.target = null;
        this.walkFrame = 0;
        this.frameTimer = 0;
        this.redraw();
      } else {
        const ux = dx / dist;
        const uy = dy / dist;
        this.pos.x += ux * step;
        this.pos.y += uy * step;
        this.facing =
          Math.abs(ux) > Math.abs(uy)
            ? ux > 0
              ? "E"
              : "W"
            : uy > 0
              ? "S"
              : "N";
        this.frameTimer += dt;
        if (this.frameTimer > 0.12) {
          this.frameTimer = 0;
          this.walkFrame = ((this.walkFrame + 1) % 4) as 0 | 1 | 2 | 3;
          this.redraw();
        }
      }
    } else {
      // Working idle: small bob and emit work FX when 'working'.
      this.workTimer += dt;
      if (
        this.data.status === "working" &&
        this.workTimer > 0.7 &&
        this.zone
      ) {
        this.workTimer = 0;
        // Engine owns the FX layer (WORLD coords); pass building-local point.
        this.emitWorkFx?.(this.pos.x, this.pos.y - 8, this.zone.kind);
      }
      // Subtle breathing on whichever body is active.
      const bob = Math.sin(this.workTimer * 4) * 0.06;
      const active = this.bodySprite.visible ? this.bodySprite : this.bodyG;
      active.scale.set(AGENT_SCALE, AGENT_SCALE * (1 + bob));

      // Idle blink: every ~3s flash frame 5 for ~120ms (sprite path only).
      if (this.atlas?.isReady()) {
        this.blinkTimer += dt;
        if (!this.blinking && this.blinkTimer > 3) {
          this.blinking = true;
          this.blinkTimer = 0;
          this.redraw();
        } else if (this.blinking && this.blinkTimer > 0.12) {
          this.blinking = false;
          this.blinkTimer = 0;
          this.redraw();
        }
      }
    }

    // Apply position into container, with z-sort by y
    this.container.position.set(this.pos.x, this.pos.y);
    this.container.zIndex = Math.floor(this.pos.y);
  }

  say(text: string) {
    this.bubbleText = text;
    this.spokenAt = performance.now();
    this.drawBubble();
  }

  private drawBubble() {
    const g = this.bubbleG;
    g.clear();
    if (!this.bubbleText) {
      this.drawNameTag();
      return;
    }
    const text = this.bubbleText.toUpperCase().slice(0, 28);
    const tw = measureText(text, 1);
    g.beginFill(COLORS.white, 0.95);
    g.drawRoundedRect(-tw / 2 - 5, -42, tw + 10, 14, 3);
    g.endFill();
    g.beginFill(COLORS.white, 0.95);
    g.drawPolygon([-3, -28, 3, -28, 0, -24]);
    g.endFill();
    drawText(g, text, -tw / 2, -39, COLORS.text, 1);
  }

  tickBubble(now: number) {
    if (this.bubbleText && now - this.spokenAt > 2400) {
      this.bubbleText = null;
      this.drawNameTag();
    }
  }
}

// ════════════════════════════════════════════════════════════════
// COURIER — sprite that flies between agents for inter-agent messages
// ════════════════════════════════════════════════════════════════

class Courier {
  container: PIXI.Container;
  g: PIXI.Graphics;
  from: { x: number; y: number };
  to: { x: number; y: number };
  dur: number;
  elapsed = 0;
  type: string;

  // Road-routed polyline (WORLD coords) + cumulative segment lengths.
  private waypoints: Array<{ x: number; y: number }>;
  private cumLen: number[];
  private totalLen: number;

  constructor(
    from: { x: number; y: number },
    to: { x: number; y: number },
    type: string,
  ) {
    this.container = new PIXI.Container();
    this.g = new PIXI.Graphics();
    this.container.addChild(this.g);
    this.from = from;
    this.to = to;
    this.dur = 0.85;
    this.type = type;
    // Route along the ground road instead of cutting through walls.
    this.waypoints = getRoadPath(from, to);
    this.cumLen = [0];
    let acc = 0;
    for (let i = 1; i < this.waypoints.length; i++) {
      const a = this.waypoints[i - 1];
      const b = this.waypoints[i];
      acc += Math.hypot(b.x - a.x, b.y - a.y);
      this.cumLen.push(acc);
    }
    this.totalLen = acc;
    this.draw();
    this.container.position.set(from.x, from.y);
    this.container.zIndex = 9000;
  }

  private draw() {
    const g = this.g;
    g.clear();
    const color =
      this.type === "request"
        ? COLORS.gold
        : this.type === "response"
          ? 0x22c55e
          : this.type === "broadcast"
            ? 0x60a5fa
            : 0xa78bfa;
    // Envelope
    g.beginFill(0xfaf3e0);
    g.drawRect(-6, -4, 12, 8);
    g.endFill();
    g.lineStyle(1, color);
    g.moveTo(-6, -4);
    g.lineTo(0, 1);
    g.lineTo(6, -4);
    g.lineStyle(0);
    // Seal
    g.beginFill(color);
    g.drawRect(-1, 0, 2, 2);
    g.endFill();
  }

  /** Returns true when the courier has arrived (caller removes it). */
  update(dt: number): boolean {
    this.elapsed += dt;
    const t = Math.min(this.elapsed / this.dur, 1);
    // Smooth ease-in-out maps time → distance along the road polyline.
    const e = t * t * (3 - 2 * t);
    const targetLen = e * this.totalLen;
    let x = this.to.x;
    let y = this.to.y;
    if (this.totalLen <= 0 || this.waypoints.length < 2) {
      x = this.from.x;
      y = this.from.y;
    } else {
      // Find the segment that contains targetLen and lerp within it.
      let seg = this.waypoints.length - 2;
      for (let i = 1; i < this.cumLen.length; i++) {
        if (targetLen <= this.cumLen[i]) {
          seg = i - 1;
          break;
        }
      }
      const a = this.waypoints[seg];
      const b = this.waypoints[seg + 1];
      const segLen = this.cumLen[seg + 1] - this.cumLen[seg];
      const local = segLen > 0 ? (targetLen - this.cumLen[seg]) / segLen : 0;
      x = a.x + (b.x - a.x) * local;
      y = a.y + (b.y - a.y) * local;
    }
    this.container.position.set(x, y);
    this.container.rotation = Math.sin(this.elapsed * 16) * 0.15;
    return t >= 1;
  }
}

// ════════════════════════════════════════════════════════════════
// CONVEYOR — incoming task strip at the top of the world
// ════════════════════════════════════════════════════════════════

class Conveyor {
  container: PIXI.Container;
  bg: PIXI.Graphics;
  itemsLayer: PIXI.Container;
  width: number;
  speedPxPerSec = 30;

  constructor(width: number) {
    this.width = width;
    this.container = new PIXI.Container();
    this.bg = new PIXI.Graphics();
    this.itemsLayer = new PIXI.Container();
    this.container.addChild(this.bg, this.itemsLayer);
    this.draw();
  }

  resize(width: number) {
    this.width = width;
    this.draw();
  }

  private draw() {
    const g = this.bg;
    g.clear();
    // Conveyor belt texture (rolling segments with highlight/shadow)
    g.beginFill(0x14202b);
    g.drawRect(0, 0, this.width, 28);
    g.endFill();
    // Rolling belt segments
    for (let x = 0; x < this.width; x += 16) {
      // Segment base
      g.beginFill(0x202d3a);
      g.drawRect(x, 4, 12, 20);
      g.endFill();
      // Segment highlight (top edge)
      g.beginFill(0x2a3a4a, 0.5);
      g.drawRect(x, 4, 12, 2);
      g.endFill();
      // Segment shadow (bottom edge)
      g.beginFill(0x0a0e14, 0.4);
      g.drawRect(x, 22, 12, 2);
      g.endFill();
      // Roller gap
      g.beginFill(0x0a0e14, 0.6);
      g.drawRect(x + 12, 4, 4, 20);
      g.endFill();
    }
    // Conveyor support structure (metal frame with rivets)
    // Top rail
    g.beginFill(COLORS.conveyorFrame);
    g.drawRect(0, 0, this.width, 3);
    g.endFill();
    // Bottom rail
    g.beginFill(COLORS.conveyorFrame);
    g.drawRect(0, 25, this.width, 3);
    g.endFill();
    // Rivets along frame
    for (let x = 8; x < this.width; x += 40) {
      g.beginFill(COLORS.conveyorRivet);
      g.drawRect(x, 1, 2, 2);
      g.drawRect(x, 26, 2, 2);
      g.endFill();
    }
    // End caps
    g.beginFill(COLORS.conveyorFrame, 0.8);
    g.drawRect(0, 0, 4, 28);
    g.drawRect(this.width - 4, 0, 4, 28);
    g.endFill();
    // Trim gold accent
    g.beginFill(COLORS.gold, 0.4);
    g.drawRect(4, 0, this.width - 8, 1);
    g.drawRect(4, 27, this.width - 8, 1);
    g.endFill();
    // Sorting mechanism at delivery end (rotating arm)
    g.beginFill(COLORS.steelSilver, 0.5);
    g.drawRect(this.width - 28, 6, 20, 16);
    g.endFill();
    g.beginFill(COLORS.gold, 0.4);
    // Chute shape
    g.drawPolygon([this.width - 26, 10, this.width - 10, 8, this.width - 10, 20, this.width - 26, 18]);
    g.endFill();
    // Inbox/pending area with stacked packages
    g.beginFill(0x0a0e14, 0.6);
    g.drawRect(0, 28, 60, 14);
    g.endFill();
    g.beginFill(COLORS.conveyorFrame, 0.5);
    g.drawRect(0, 28, 60, 1);
    g.drawRect(0, 41, 60, 1);
    g.drawRect(60, 28, 1, 14);
    g.endFill();
    // Stacked packages in inbox
    const pkgColors = [COLORS.priorityGreen, COLORS.priorityYellow, COLORS.priorityRed];
    for (let p = 0; p < 3; p++) {
      g.beginFill(pkgColors[p], 0.4);
      g.drawRect(6 + p * 14, 30 + p * 2, 10, 8);
      g.endFill();
    }
    // Header sign
    g.beginFill(0x0a0a0a);
    g.drawRoundedRect(8, -22, 220, 22, 4);
    g.endFill();
    const header = "INCOMING TASKS";
    const tw = measureText(header, 2);
    drawText(g, header, 8 + (220 - tw) / 2, -17, COLORS.gold, 2);
  }

  pushItem(label: string, color: number, onArrive?: () => void) {
    const item = new PIXI.Container();
    const g = new PIXI.Graphics();
    item.addChild(g);
    // Determine package type from label for pixel-art icon
    const isBug = label.toLowerCase().includes("bug") || label.toLowerCase().includes("fix");
    const isFeature = label.toLowerCase().includes("feature") || label.toLowerCase().includes("add");
    const isTask = label.toLowerCase().includes("task");
    // Task package is a small colored box
    g.beginFill(0x1a1a1a);
    g.drawRect(-6, -7, 12, 14);
    g.endFill();
    g.beginFill(color, 0.8);
    g.drawRect(-5, -6, 10, 10);
    g.endFill();
    // Priority indicator tag (red/yellow/green)
    const priority = isBug ? COLORS.priorityRed : isFeature ? COLORS.priorityYellow : COLORS.priorityGreen;
    g.beginFill(priority, 0.8);
    g.drawRect(-5, 5, 10, 2);
    g.endFill();
    // Tiny pixel-art icon on package
    if (isBug) {
      // Bug icon: small X with body
      g.beginFill(COLORS.bugPkg);
      g.drawRect(-2, -4, 4, 4);
      g.drawRect(-3, -3, 1, 1);
      g.drawRect(3, -3, 1, 1);
      g.endFill();
    } else if (isFeature) {
      // Feature icon: star/sparkle
      g.beginFill(COLORS.featurePkg);
      g.drawRect(-1, -5, 2, 6);
      g.drawRect(-3, -3, 6, 2);
      g.endFill();
    } else if (isTask) {
      // Envelope icon
      g.beginFill(COLORS.envelopePkg);
      g.drawRect(-3, -4, 6, 5);
      g.endFill();
      g.beginFill(0x1a1a1a);
      g.drawPolygon([-3, -4, 0, -1, 3, -4]);
      g.endFill();
    } else {
      // Folder icon
      g.beginFill(COLORS.folderPkg);
      g.drawRect(-3, -5, 3, 2);
      g.drawRect(-3, -4, 6, 5);
      g.endFill();
    }
    // Highlight sheen
    g.beginFill(COLORS.whitePaint, 0.15);
    g.drawRect(-4, -5, 4, 4);
    g.endFill();
    // Label tag
    const text = label.toUpperCase().slice(0, 10);
    const tw = measureText(text, 1);
    g.beginFill(0x000000, 0.6);
    g.drawRoundedRect(-tw / 2 - 3, 9, tw + 6, 9, 2);
    g.endFill();
    drawText(g, text, -tw / 2, 10, COLORS.white, 1);

    item.position.set(-12, 14);
    (item as any).vx = this.speedPxPerSec;
    (item as any).arriveCb = onArrive;
    this.itemsLayer.addChild(item);
  }

  update(dt: number) {
    const remove: PIXI.DisplayObject[] = [];
    this.itemsLayer.children.forEach((c) => {
      const it = c as PIXI.Container & { vx?: number; arriveCb?: () => void };
      const v = it.vx || this.speedPxPerSec;
      it.position.x += v * dt;
      if (it.position.x > this.width - 30) {
        // Drop down into the world
        it.position.y += 240 * dt;
        if (it.position.y > 220) {
          if (it.arriveCb) it.arriveCb();
          remove.push(it);
        }
      }
    });
    remove.forEach((r) => this.itemsLayer.removeChild(r));
  }
}

// ════════════════════════════════════════════════════════════════
// PARTICLE — small bursts above working agents
// ════════════════════════════════════════════════════════════════

class Particle {
  container: PIXI.Container;
  g: PIXI.Graphics;
  vx: number;
  vy: number;
  life: number;
  age = 0;
  color: number;

  constructor(x: number, y: number, color: number) {
    this.container = new PIXI.Container();
    this.g = new PIXI.Graphics();
    this.container.addChild(this.g);
    this.container.position.set(x, y);
    this.vx = (Math.random() - 0.5) * 18;
    this.vy = -28 - Math.random() * 18;
    this.life = 0.7 + Math.random() * 0.5;
    this.color = color;
    this.draw();
  }

  private draw() {
    const g = this.g;
    g.clear();
    g.beginFill(this.color);
    g.drawRect(-1, -1, 2, 2);
    g.endFill();
  }

  update(dt: number): boolean {
    this.age += dt;
    this.vy += 22 * dt; // mild gravity, particles arc up then settle
    this.container.position.x += this.vx * dt;
    this.container.position.y += this.vy * dt;
    this.container.alpha = Math.max(0, 1 - this.age / this.life);
    return this.age >= this.life;
  }
}

// ════════════════════════════════════════════════════════════════
// MINIMAP / UI — small map overlay
// ════════════════════════════════════════════════════════════════

class WorldMinimap {
  container: PIXI.Container;
  bg: PIXI.Graphics;
  pts: PIXI.Graphics;
  rect: PIXI.Graphics;
  scale = 0.04;

  constructor() {
    this.container = new PIXI.Container();
    this.bg = new PIXI.Graphics();
    this.pts = new PIXI.Graphics();
    this.rect = new PIXI.Graphics();
    this.container.addChild(this.bg, this.pts, this.rect);
    this.drawBg();
  }

  private drawBg() {
    const g = this.bg;
    g.clear();
    g.beginFill(0x000000, 0.55);
    g.drawRoundedRect(0, 0, 160, 110, 6);
    g.endFill();
    g.lineStyle(1, COLORS.gold, 0.8);
    g.drawRoundedRect(0, 0, 160, 110, 6);
    g.lineStyle(0);
    drawText(g, "MAP", 6, 6, COLORS.gold, 1);
  }

  update(buildings: Map<string, Building>, viewport: Viewport) {
    this.pts.clear();
    buildings.forEach((b) => {
      const cx = b.container.x * this.scale + 12;
      const cy = b.container.y * this.scale + 22;
      this.pts.beginFill(COLORS.gold, 0.9);
      this.pts.drawRect(cx, cy, BUILDING_WIDTH * this.scale, BUILDING_HEIGHT * this.scale);
      this.pts.endFill();
    });
    this.rect.clear();
    this.rect.lineStyle(1, COLORS.white, 0.8);
    const vx = viewport.left * this.scale + 12;
    const vy = viewport.top * this.scale + 22;
    const vw = (viewport.screenWidth / viewport.scale.x) * this.scale;
    const vh = (viewport.screenHeight / viewport.scale.y) * this.scale;
    this.rect.drawRect(vx, vy, vw, vh);
  }
}

// ════════════════════════════════════════════════════════════════
// AGENCY WORLD — main exported class (mirrors ActivityMap API)
// ════════════════════════════════════════════════════════════════

export interface WorldNote {
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface NoteClickDetail {
  noteId: string;
  screenX: number;
  screenY: number;
}

export interface AgencyWorldOptions {
  width?: number;
  height?: number;
  onAgentClick?: (agent: MeshAgent) => void;
  onNodeClick?: (node: MeshNode) => void;
  onNoteClick?: (detail: NoteClickDetail) => void;
  onNoteCreate?: (worldX: number, worldY: number, screenX: number, screenY: number) => void;
}

export class AgencyWorld {
  private app: PIXI.Application;
  private viewport: Viewport;
  private container: HTMLElement;
  private opts: AgencyWorldOptions;

  // Layers
  private groundLayer: PIXI.Container;
  private buildingsLayer: PIXI.Container;
  private worldEffectsLayer: PIXI.Container;
  private uiLayer: PIXI.Container;

  // World content
  private buildings: Map<string, Building> = new Map();
  private agents: Map<string, AgentChar> = new Map();
  private agentToNode: Map<string, string> = new Map();
  private couriers: Courier[] = [];
  private particles: Particle[] = [];
  private conveyor: Conveyor;
  private minimap: WorldMinimap;
  private resizeObs?: ResizeObserver;

  // Wave-1 engines
  private atlas: SpriteAtlas;
  private fx: FxLayer;
  private sky: SkyCycle;

  // Interactivity: dim everything except the focused node.
  private nodeFilter: string | null = null;

  private worldWidth = 3200;
  private worldHeight = 2000;
  private lastTime = performance.now();
  private autoFit = false;
  private atmosphereG: PIXI.Graphics | null = null;
  private atmosphereTime = 0;
  private cloudShadowOffset = 0;
  private birdTimer = 0;

  private notes: Map<string, WorldNote> = new Map();
  private noteSprites: Map<string, PIXI.Container> = new Map();
  private loadingOverlay: PIXI.Container | null = null;
  private emptyOverlay: PIXI.Container | null = null;
  private emptyCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private _destroyed = false;
  private _visHandler: (() => void) | null = null;
  private _hideTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityObserver: IntersectionObserver | null = null;
  private offscreen = false;
  private panelActive = true;

  /**
   * Cursor-anchored mouse-wheel / trackpad-pinch zoom. Mirrors ActivityMap's
   * handler: a multiplicative `exp(-deltaY * k)` step keeps mice and trackpads
   * on one curve, the world point under the pointer is held fixed across the
   * scale change, and ctrl/cmd-wheel (trackpad pinch) is treated identically.
   * Replaces pixi-viewport's .wheel() plugin, which binds to document.body and
   * bails when event.target isn't the canvas (unreliable under HUD overlays).
   */
  private readonly handleWheelZoom = (e: WheelEvent): void => {
    e.preventDefault();
    if (this._destroyed || this.viewport.pause) return;
    const vp = this.viewport;
    const canvas = this.app.view as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= rect.height;
    const factor = Math.exp(-dy * 0.001);
    if (!Number.isFinite(factor) || factor === 1) return;

    const cur = vp.scale.x;
    const next = Math.min(Math.max(cur * factor, 0.25), 2.5); // matches clampZoom
    if (Math.abs(next - cur) < 1e-4) return;

    vp.plugins.remove('animate');
    vp.plugins.remove('snap-zoom');

    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = vp.toWorld(sx, sy);
    vp.scale.set(next);
    // screen = world * scale + position  ⇒  position = screen − world * scale
    vp.x = sx - before.x * next;
    vp.y = sy - before.y * next;
    vp.emit('zoomed', { viewport: vp, type: 'wheel' });
    vp.emit('moved', { viewport: vp, type: 'wheel' });
  };

  constructor(container: HTMLElement, opts: AgencyWorldOptions = {}) {
    this.container = container;
    this.opts = opts;
    const width = opts.width || container.clientWidth || 900;
    const height = opts.height || 520;

    this.app = new PIXI.Application({
      width,
      height,
      backgroundColor: COLORS.bgSky,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;
    PIXI.settings.ROUND_PIXELS = true;

    // Pre-bake the character sprite sheet (synchronous). Pass the concrete
    // renderer directly — PIXI.IRenderer does not exist in v6.
    this.atlas = buildSpriteAtlas(this.app.renderer);

    const canvas = this.app.view as HTMLCanvasElement;
    canvas.style.touchAction = "none";
    canvas.style.userSelect = "none";
    canvas.style.display = "block";
    canvas.addEventListener('wheel', this.handleWheelZoom, { passive: false });
    container.appendChild(canvas);

    // Viewport
    this.viewport = new Viewport({
      screenWidth: width,
      screenHeight: height,
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
      interaction: this.app.renderer.plugins.interaction,
      passiveWheel: false,
      stopPropagation: true,
      disableOnContextMenu: true,
    });
    this.viewport
      .drag({ pressDrag: true })
      .pinch({ noDrag: false })
      // Wheel zoom handled by our cursor-anchored handleWheelZoom (see above).
      .decelerate({ friction: 0.94 })
      .clampZoom({ minScale: 0.25, maxScale: 2.5 });
    this.app.stage.addChild(this.viewport);

    // Layers
    this.groundLayer = new PIXI.Container();
    this.buildingsLayer = new PIXI.Container();
    this.buildingsLayer.sortableChildren = true;
    this.worldEffectsLayer = new PIXI.Container();
    this.worldEffectsLayer.sortableChildren = true;
    this.viewport.addChild(
      this.groundLayer,
      this.buildingsLayer,
      this.worldEffectsLayer,
    );
    // Pooled FX live in the world-effects layer (WORLD coords).
    this.fx = new FxLayer(this.worldEffectsLayer);
    this.drawGround();
    // Day/night sky tint over the ground.
    this.sky = new SkyCycle(this.groundLayer, this.worldWidth, this.worldHeight);
    // Modern-Office background (async, graceful fallback)
    this.loadModernOfficeBackground();

    // UI Layer (screen-space, not in viewport)
    this.uiLayer = new PIXI.Container();
    this.conveyor = new Conveyor(width - 32);
    this.conveyor.container.position.set(16, 36);
    this.uiLayer.addChild(this.conveyor.container);
    this.minimap = new WorldMinimap();
    this.minimap.container.position.set(width - 170, height - 120);
    this.uiLayer.addChild(this.minimap.container);
    this.drawLegend(width, height);
    this.app.stage.addChild(this.uiLayer);

    // Set world at alpha 0 for fade-in reveal
    this.viewport.alpha = 0;

    // Loading overlay (shown during initialisation, faded out after reveal)
    const loadG = new PIXI.Graphics();
    loadG.beginFill(COLORS.bgSky, 1);
    loadG.drawRect(0, 0, width, height);
    loadG.endFill();
    const loadTxt = new PIXI.Text("Loading World...", {
      fontFamily: "monospace",
      fontSize: 14,
      fill: 0x9aa2b1,
    });
    loadTxt.anchor.set(0.5);
    loadTxt.position.set(width / 2, height / 2);
    loadG.addChild(loadTxt);
    this.uiLayer.addChild(loadG);
    this.loadingOverlay = loadG;

    // Empty-state overlay (hidden until checkEmpty shows it)
    this.emptyOverlay = this.createEmptyOverlay(width, height);
    this.uiLayer.addChild(this.emptyOverlay);
    this.emptyOverlay.visible = false;

    // Start centered
    this.viewport.moveCenter(this.worldWidth / 2, this.worldHeight / 2);

    // Reveal world with fade-in after initialisation
    setTimeout(() => {
      if (this._destroyed) return;
      gsap.to(this.viewport, { alpha: 1, duration: 0.6, ease: "power2.out" });
      gsap.to(loadG, {
        alpha: 0,
        duration: 0.4,
        delay: 0.2,
        ease: "power2.out",
        onComplete: () => {
          if (loadG.parent) loadG.parent.removeChild(loadG);
          this.loadingOverlay = null;
        },
      });
    }, 100);

    // Empty-state check after 5 seconds
    this.emptyCheckTimer = setTimeout(() => this.checkEmpty(), 5000);

    // Ticker
    this.app.ticker.add(() => this.tick());

    if (typeof IntersectionObserver !== "undefined") {
      this.visibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.target === container) {
            this.offscreen = !entry.isIntersecting;
            this.updateTickerState();
          }
        }
      }, { threshold: 0 });
      this.visibilityObserver.observe(container);
    }

    // Pause the Pixi ticker when the document is hidden (wall window off-screen).
    // The tick() already has a document.hidden guard, but the ticker itself still
    // fires every vsync. Stopping it saves both CPU and the Pixi overhead.
    this._visHandler = () => {
      if (this._destroyed) return;
      // No WEBGL_lose_context.loseContext() here: Pixi restores the context
      // on the next tick and the atlas's generateTexture() RenderTextures come
      // back blank — the world lost its styling after ~60s hidden.
      this.updateTickerState();
    };
    document.addEventListener('visibilitychange', this._visHandler, { passive: true });
    // Apply immediately in case the window was already hidden when this mounts.
    this.updateTickerState();

    // Resize
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.handleResize());
      this.resizeObs.observe(container);
    } else {
      window.addEventListener("resize", this.handleResize);
    }
  }

  /** Atmospheric details: cloud shadows, birds/drones, steam, neon signage. */
  private tickAtmosphere(dt: number, now: number) {
    if (!this.atmosphereG) return;
    this.atmosphereTime += dt;
    this.cloudShadowOffset += dt * 18;
    this.birdTimer += dt;

    const g = this.atmosphereG;
    g.clear();
    const ww = this.worldWidth;
    const wh = this.worldHeight;

    // Cloud shadows that slowly move across the ground
    const cloudPositions = [200, 800, 1500, 2200, 2800];
    for (let i = 0; i < cloudPositions.length; i++) {
      const baseCx = cloudPositions[i];
      const cx = (baseCx + this.cloudShadowOffset * (0.5 + i * 0.15)) % (ww + 200) - 100;
      const cy = 500 + (i * 137) % 400;
      const rw = 60 + (i * 23) % 40;
      const rh = 20 + (i * 7) % 15;
      g.beginFill(COLORS.cloudShadow, 0.07 + i * 0.01);
      g.drawEllipse(cx, cy, rw, rh);
      g.endFill();
    }

    // Birds / small drones occasionally visible
    if (this.birdTimer > 2.5 && Math.random() < 0.02) {
      this.birdTimer = 0;
    }
    const birdPhase = this.atmosphereTime * 0.8;
    // 2-3 persistent bird/drone cross-shapes
    for (let b = 0; b < 2; b++) {
      const bx = ((birdPhase * (40 + b * 20) + b * 400) % (ww + 100)) - 50;
      const by = 100 + b * 60 + Math.sin(birdPhase * 2 + b * 3) * 15;
      const wingPhase = Math.sin(birdPhase * 8 + b * 4);
      g.beginFill(0xffffff, 0.3);
      g.drawRect(bx - 2, by, 1, 1);
      g.drawRect(bx + 2, by, 1, 1);
      // Wings
      g.drawRect(bx - 3, by - 1 + (wingPhase > 0 ? 0 : 1), 2, 1);
      g.drawRect(bx + 2, by - 1 + (wingPhase > 0 ? 0 : 1), 2, 1);
      g.endFill();
    }

    // Steam / heat shimmer from building vents (wavy semi-transparent lines)
    const steamPhase = this.atmosphereTime * 2;
    const ventPositions = [380, 1050, 1720, 2500];
    for (let v = 0; v < ventPositions.length; v++) {
      const vx = ventPositions[v];
      const vy = 500 + v * 30;
      for (let s = 0; s < 5; s++) {
        const sx = vx + Math.sin(steamPhase + s * 0.8 + v * 2) * 4;
        const sy = vy - s * 8 - (this.atmosphereTime * 6 % 40);
        const alpha = Math.max(0, 0.12 - s * 0.025);
        g.beginFill(COLORS.steam, alpha);
        g.drawRect(sx, sy, 2 + s % 2, 3);
        g.endFill();
      }
    }

    // Neon signage glow on building facades (pulsing)
    const neonPhase = Math.sin(this.atmosphereTime * 3) * 0.15 + 0.85;
    const neonSigns = [
      { x: 370, y: 520, text: "HUB", color: COLORS.neonCyan },
      { x: 1050, y: 520, text: "SAT", color: COLORS.neonMagenta },
    ];
    for (const sign of neonSigns) {
      g.beginFill(sign.color, 0.06 * neonPhase);
      g.drawEllipse(sign.x, sign.y, 40, 15);
      g.endFill();
      g.beginFill(sign.color, 0.12 * neonPhase);
      g.drawEllipse(sign.x, sign.y, 20, 8);
      g.endFill();
    }
  }

  private drawGround() {
    const g = new PIXI.Graphics();
    // Sky gradient stripes
    g.beginFill(COLORS.bgSky);
    g.drawRect(0, 0, this.worldWidth, 200);
    g.endFill();
    g.beginFill(COLORS.bgFar);
    g.drawRect(0, 200, this.worldWidth, 240);
    g.endFill();
    // Ground base
    g.beginFill(COLORS.ground);
    g.drawRect(0, 440, this.worldWidth, this.worldHeight - 440);
    g.endFill();

    this.drawGroundTiles(g);
    this.drawRoadSystem(g);
    this.drawEnvironmentalDetails(g);

    // Stars
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * this.worldWidth;
      const y = Math.random() * 180;
      const a = 0.4 + Math.random() * 0.6;
      g.beginFill(0xffffff, a);
      g.drawRect(x, y, 1, 1);
      g.endFill();
    }
    // Moon
    g.beginFill(0xfff0c2, 0.9);
    g.drawCircle(this.worldWidth - 220, 110, 26);
    g.endFill();
    g.beginFill(0x0a0e1a, 1);
    g.drawCircle(this.worldWidth - 234, 102, 22);
    g.endFill();
    this.groundLayer.addChild(g);

    // Animated atmospheric layer
    this.atmosphereG = new PIXI.Graphics();
    this.groundLayer.addChild(this.atmosphereG);
    this.atmosphereTime = 0;
  }

  /** Load the modern-office background image (async — fails gracefully). */
  private async loadModernOfficeBackground(): Promise<void> {
    try {
      const bgUrl = "./assets/agency-world/backgrounds/modern-office-upscaled.png";
      const texture = await PIXI.Texture.fromURL(bgUrl);
      const bg = new PIXI.Sprite(texture);
      bg.width = this.worldWidth;
      bg.height = 440; // sky height (bgSky + bgFar bands)
      bg.position.set(0, 0);
      // Insert behind everything in groundLayer
      this.groundLayer.addChildAt(bg, 0);
    } catch (err) {
      console.warn("[AgencyWorld] modern-office background not available", err);
      // Graceful fallback: procedural sky remains
    }
  }

  /** Rich tiled ground plane with sidewalks, grass, crosswalks, and details. */
  private drawGroundTiles(g: PIXI.Graphics) {
    const roadY = 920;
    const roadH = 90;
    const sidewalkW = 24;
    const ww = this.worldWidth;
    const wh = this.worldHeight;

    // Grass patches with textured tufts
    for (let y = 460; y < wh; y += 48) {
      for (let x = 0; x < ww; x += 48) {
        const isRoad = y >= roadY - sidewalkW && y < roadY + roadH + sidewalkW;
        if (isRoad) continue;
        const base = (x / 48 + y / 48) % 2 === 0 ? COLORS.grass1 : COLORS.grass2;
        g.beginFill(base);
        g.drawRect(x, y, 48, 48);
        g.endFill();
        // Grass tufts: small clusters of 2-3 pixel lines
        for (let i = 0; i < 3; i++) {
          const tx = x + 8 + ((x * 7 + y * 13 + i * 37) % 32);
          const ty = y + 12 + ((x * 11 + y * 3 + i * 23) % 24);
          g.beginFill(COLORS.grassTuft);
          g.drawRect(tx, ty, 1, 2);
          g.drawRect(tx + 1, ty + 1, 1, 2);
          g.endFill();
          g.beginFill(COLORS.grassTuftDark);
          g.drawRect(tx + 2, ty, 1, 1);
          g.endFill();
        }
      }
    }

    // Sidewalk tiles around road (lighter rectangular tiles with grid lines)
    // Top sidewalk
    g.beginFill(COLORS.sidewalk);
    g.drawRect(0, roadY - sidewalkW, ww, sidewalkW);
    g.endFill();
    // Bottom sidewalk
    g.beginFill(COLORS.sidewalk);
    g.drawRect(0, roadY + roadH, ww, sidewalkW);
    g.endFill();
    // Sidewalk grid lines and cracks
    for (let x = 0; x < ww; x += 32) {
      g.beginFill(COLORS.sidewalkLine, 0.5);
      g.drawRect(x, roadY - sidewalkW, 1, sidewalkW);
      g.drawRect(x, roadY + roadH, 1, sidewalkW);
      g.endFill();
      // Occasional cracks
      if ((x * 7 + 3) % 64 === 0) {
        g.beginFill(COLORS.sidewalkCrack);
        g.drawRect(x + 5, roadY - sidewalkW + 4, 1, sidewalkW - 8);
        g.drawRect(x + 5, roadY + roadH + 4, 1, sidewalkW - 8);
        g.endFill();
        // Weeds poking through sidewalk cracks
        g.beginFill(COLORS.grassTuftDark);
        g.drawRect(x + 4, roadY - sidewalkW + 2, 1, 2);
        g.drawRect(x + 6, roadY + roadH + sidewalkW - 4, 1, 2);
        g.endFill();
      }
    }
    // Sidewalk edge line
    g.beginFill(COLORS.sidewalkLine, 0.7);
    g.drawRect(0, roadY - sidewalkW, ww, 1);
    g.drawRect(0, roadY + roadH + sidewalkW - 1, ww, 1);
    g.endFill();

    // Crosswalk patterns at intervals
    for (let cx = 200; cx < ww; cx += 600) {
      // Top crosswalk (across road, crossing vertically)
      for (let s = 0; s < 6; s++) {
        const alpha = 0.7 - s * 0.08;
        g.beginFill(COLORS.crosswalkWhite, alpha);
        g.drawRect(cx + s * 10, roadY - sidewalkW + 2, 8, sidewalkW - 4);
        g.drawRect(cx + s * 10, roadY + roadH + 2, 8, sidewalkW - 4);
        g.endFill();
      }
    }

    // Puddle reflections (semi-transparent oval mirrors)
    const puddles = [
      { x: 340, y: roadY + 30, rx: 18, ry: 8 },
      { x: 1100, y: roadY + roadH - 18, rx: 14, ry: 6 },
      { x: 2200, y: roadY + 40, rx: 20, ry: 7 },
      { x: 600, y: 620, rx: 16, ry: 9 },
      { x: 1800, y: 580, rx: 12, ry: 6 },
    ];
    for (const p of puddles) {
      g.beginFill(COLORS.puddleReflect, 0.25);
      g.drawEllipse(p.x, p.y, p.rx, p.ry);
      g.endFill();
      g.beginFill(COLORS.whitePaint, 0.06);
      g.drawEllipse(p.x - p.rx * 0.2, p.y - p.ry * 0.3, p.rx * 0.5, p.ry * 0.4);
      g.endFill();
    }
  }

  /** Detailed road system with markings, shoulders, infrastructure. */
  private drawRoadSystem(g: PIXI.Graphics) {
    const roadY = 920;
    const roadH = 90;
    const ww = this.worldWidth;
    const shoulderW = 6;

    // Road base
    g.beginFill(COLORS.road);
    g.drawRect(0, roadY, ww, roadH);
    g.endFill();

    // Wet road patches
    for (let i = 0; i < 5; i++) {
      const wx = (i * 617 + 113) % ww;
      const wy = roadY + 20 + (i * 13) % 50;
      g.beginFill(COLORS.wetRoad, 0.4);
      g.drawEllipse(wx, wy, 30 + (i * 7) % 20, 12 + (i * 5) % 10);
      g.endFill();
    }

    // Road shoulders (lighter bordered strips with gravel texture)
    g.beginFill(COLORS.roadShoulder);
    g.drawRect(0, roadY, ww, shoulderW);
    g.drawRect(0, roadY + roadH - shoulderW, ww, shoulderW);
    g.endFill();
    // Gravel texture on shoulders
    for (let x = 0; x < ww; x += 4) {
      if ((x * 3 + 1) % 8 < 3) {
        g.beginFill(COLORS.warmGravel, 0.4);
        g.drawRect(x, roadY + 1, 2, 2);
        g.drawRect(x + 1, roadY + roadH - 4, 2, 2);
        g.endFill();
      }
    }

    // Solid edge lines with rumble strip texture
    g.beginFill(COLORS.roadLine, 0.8);
    g.drawRect(0, roadY + shoulderW, ww, 2);
    g.drawRect(0, roadY + roadH - shoulderW - 2, ww, 2);
    g.endFill();
    // Rumble strip ticks
    for (let x = 0; x < ww; x += 6) {
      g.beginFill(COLORS.rumbleStrip, 0.5);
      g.drawRect(x, roadY + shoulderW + 2, 3, 1);
      g.drawRect(x, roadY + roadH - shoulderW - 3, 3, 1);
      g.endFill();
    }

    // Lane dividers: dashed white center line
    const centerLineY = roadY + roadH / 2 - 2;
    for (let x = 0; x < ww; x += 80) {
      g.beginFill(COLORS.whitePaint, 0.7);
      g.drawRect(x, centerLineY, 32, 3);
      g.endFill();
    }
    // Second lane line
    for (let x = 20; x < ww; x += 80) {
      g.beginFill(COLORS.whitePaint, 0.35);
      g.drawRect(x, centerLineY + 8, 24, 2);
      g.endFill();
    }

    // Manhole covers on roads
    const manholePositions = [180, 780, 1400, 2100, 2700];
    for (const mx of manholePositions) {
      const my = roadY + 35 + ((mx * 3) % 20);
      g.beginFill(COLORS.steelSilver, 0.5);
      g.drawCircle(mx, my, 7);
      g.endFill();
      g.beginFill(COLORS.road, 0.8);
      g.drawCircle(mx, my, 5);
      g.endFill();
      // Cross lines on manhole
      g.beginFill(COLORS.steelSilver, 0.4);
      g.drawRect(mx - 5, my - 1, 10, 1);
      g.drawRect(mx - 1, my - 5, 1, 10);
      g.endFill();
    }

    // Storm drains along road edges
    for (let x = 100; x < ww; x += 200) {
      // Top edge drain
      g.beginFill(COLORS.steelSilver, 0.3);
      g.drawRect(x, roadY + shoulderW + 3, 12, 4);
      g.endFill();
      for (let bar = 0; bar < 5; bar++) {
        g.beginFill(COLORS.shadow, 0.6);
        g.drawRect(x + 1 + bar * 2, roadY + shoulderW + 4, 1, 2);
        g.endFill();
      }
      // Bottom edge drain
      g.beginFill(COLORS.steelSilver, 0.3);
      g.drawRect(x + 100, roadY + roadH - shoulderW - 7, 12, 4);
      g.endFill();
      for (let bar = 0; bar < 5; bar++) {
        g.beginFill(COLORS.shadow, 0.6);
        g.drawRect(x + 101 + bar * 2, roadY + roadH - shoulderW - 6, 1, 2);
        g.endFill();
      }
    }

    // Parking spaces along building fronts (above road)
    for (let x = 80; x < ww; x += 120) {
      if (x % 600 < 60) continue;
      // Upper parking row
      g.beginFill(COLORS.parkingMarker, 0.2);
      g.drawRect(x, roadY - 20, 2, 18);
      g.drawRect(x + 40, roadY - 20, 2, 18);
      g.endFill();
      g.beginFill(COLORS.parkingMarker, 0.15);
      g.drawRect(x, roadY - 20, 40, 1);
      g.endFill();
    }

    // Speed bump indicators at building entrances
    const bumpXPositions = [400, 1000, 1600, 2200, 2800];
    for (const bx of bumpXPositions) {
      g.beginFill(COLORS.speedBump, 0.6);
      g.drawRect(bx, roadY + roadH - shoulderW - 2, 24, 3);
      g.endFill();
      g.beginFill(COLORS.speedBump, 0.3);
      g.drawRect(bx, roadY + shoulderW, 24, 3);
      g.endFill();
    }

    // Fire hydrants at building corners
    for (let hx = 300; hx < ww; hx += 650) {
      const hy = roadY - 4;
      // Body (cylinder)
      g.beginFill(COLORS.fireHydrantRed);
      g.drawRect(hx, hy, 5, 10);
      g.endFill();
      // Top cap
      g.beginFill(COLORS.fireHydrantCap);
      g.drawRect(hx - 1, hy - 1, 7, 3);
      g.endFill();
      // Side nozzle
      g.beginFill(COLORS.fireHydrantCap);
      g.drawRect(hx + 5, hy + 3, 2, 2);
      g.endFill();
    }

    // Street lamps along roads
    for (let lx = 160; lx < ww; lx += 250) {
      const ly = roadY - 18;
      // Post
      g.beginFill(COLORS.streetLampPost);
      g.drawRect(lx, ly, 2, 22);
      g.endFill();
      // Lamp head (cone pointing down)
      g.beginFill(COLORS.streetLampPost);
      g.drawPolygon([lx - 4, ly, lx + 6, ly, lx + 2, ly + 4]);
      g.endFill();
      // Glow
      g.beginFill(COLORS.streetLampGlow, 0.15);
      g.drawEllipse(lx + 1, ly + 6, 14, 10);
      g.endFill();
      g.beginFill(COLORS.streetLampGlow, 0.5);
      g.drawEllipse(lx + 1, ly + 4, 4, 3);
      g.endFill();
    }

    // Direction arrows painted on road surface
    for (let ax = 350; ax < ww; ax += 500) {
      const ay = roadY + roadH / 2 + 16;
      g.beginFill(COLORS.whitePaint, 0.25);
      // Arrow pointing right
      g.drawPolygon([ax, ay, ax + 8, ay, ax + 8, ay - 3, ax + 12, ay + 2, ax + 8, ay + 7, ax + 8, ay + 4, ax, ay + 4]);
      g.endFill();
    }
  }

  /** Environmental set dressing: dumpsters, bike racks, trees, etc. */
  private drawEnvironmentalDetails(g: PIXI.Graphics) {
    const roadY = 920;
    const roadH = 90;
    const sidewalkW = 24;
    const ww = this.worldWidth;

    // Dumpster / recycling bins behind buildings (below road)
    for (let dx = 120; dx < ww; dx += 700) {
      const dy = roadY + roadH + sidewalkW + 8;
      // Green dumpster
      g.beginFill(COLORS.dumpsterGreen);
      g.drawRect(dx, dy, 22, 16);
      g.endFill();
      g.beginFill(COLORS.shadow, 0.3);
      g.drawRect(dx, dy, 22, 2);
      g.endFill();
      // Lid
      g.beginFill(COLORS.dumpsterGreen, 0.7);
      g.drawRect(dx - 1, dy - 2, 24, 3);
      g.endFill();
      // Blue recycling bin
      g.beginFill(COLORS.dumpsterBlue);
      g.drawRect(dx + 26, dy + 2, 14, 14);
      g.endFill();
      g.beginFill(COLORS.whitePaint, 0.3);
      g.drawPolygon([dx + 30, dy + 5, dx + 36, dy + 5, dx + 33, dy + 11]);
      g.endFill();
    }

    // Bike rack with bicycle silhouettes
    for (let bx = 500; bx < ww; bx += 900) {
      const by = roadY - sidewalkW - 14;
      // Rack frame
      g.beginFill(COLORS.bikeRack);
      g.drawRect(bx, by, 30, 2);
      g.drawRect(bx, by - 6, 2, 8);
      g.drawRect(bx + 14, by - 6, 2, 8);
      g.drawRect(bx + 28, by - 6, 2, 8);
      g.endFill();
      // Bicycle silhouette (tiny)
      g.beginFill(COLORS.steelSilver, 0.4);
      g.drawCircle(bx + 7, by - 4, 4);
      g.drawCircle(bx + 21, by - 4, 4);
      g.endFill();
      g.beginFill(COLORS.bikeRack, 0.5);
      g.drawRect(bx + 5, by - 8, 18, 1);
      g.drawRect(bx + 12, by - 10, 3, 4);
      g.endFill();
    }

    // Flagpole near first building area
    const fx = 160;
    const fy = roadY - sidewalkW - 2;
    g.beginFill(COLORS.steelSilver);
    g.drawRect(fx, fy - 40, 1, 40);
    g.endFill();
    // Flag (triangular)
    g.beginFill(COLORS.flagRed);
    g.drawPolygon([fx + 1, fy - 38, fx + 12, fy - 34, fx + 1, fy - 30]);
    g.endFill();
    // Gold ball on top
    g.beginFill(COLORS.gold);
    g.drawRect(fx, fy - 42, 2, 2);
    g.endFill();

    // Picnic table area
    const px = ww - 400;
    const py = roadY + roadH + sidewalkW + 10;
    // Table
    g.beginFill(COLORS.woodBrown);
    g.drawRect(px, py, 30, 3);
    g.endFill();
    g.beginFill(COLORS.woodBrown, 0.7);
    g.drawRect(px + 4, py + 3, 2, 6);
    g.drawRect(px + 24, py + 3, 2, 6);
    g.endFill();
    // Benches
    g.beginFill(COLORS.woodBrown, 0.6);
    g.drawRect(px - 4, py + 1, 2, 8);
    g.drawRect(px + 32, py + 1, 2, 8);
    g.endFill();

    // Information kiosk
    const kx = ww / 2 - 20;
    const ky = roadY - sidewalkW - 16;
    g.beginFill(COLORS.infoKiosk);
    g.drawRect(kx, ky, 16, 16);
    g.endFill();
    // Roof
    g.beginFill(COLORS.gold, 0.5);
    g.drawPolygon([kx - 2, ky, kx + 8, ky - 6, kx + 18, ky]);
    g.endFill();
    // Info "i" symbol
    g.beginFill(COLORS.whitePaint, 0.5);
    g.drawRect(kx + 7, ky + 4, 2, 2);
    g.drawRect(kx + 7, ky + 7, 2, 5);
    g.endFill();

    // Potted plants/trees along walkways
    const treePositions = [80, 320, 560, 850, 1200, 1550, 1900, 2300, 2600, 2900];
    for (const tx of treePositions) {
      const isTree = (tx * 7) % 3 === 0;
      const ty = roadY - sidewalkW - (isTree ? 20 : 8);
      if (isTree) {
        // Tree: brown trunk + green circle
        g.beginFill(COLORS.treeTrunk);
        g.drawRect(tx, ty + 10, 3, 14);
        g.endFill();
        g.beginFill(COLORS.treeGreen);
        g.drawCircle(tx + 1, ty + 6, 8);
        g.endFill();
        g.beginFill(COLORS.treeGreenLight, 0.5);
        g.drawCircle(tx - 2, ty + 4, 4);
        g.endFill();
      } else {
        // Bush: green blob
        g.beginFill(COLORS.potBrown);
        g.drawRect(tx, ty + 6, 6, 5);
        g.endFill();
        g.beginFill(COLORS.grassTuft);
        g.drawCircle(tx + 3, ty + 4, 5);
        g.endFill();
        g.beginFill(COLORS.grassTuftDark, 0.5);
        g.drawCircle(tx + 1, ty + 2, 3);
        g.endFill();
      }
    }

    // Fire escape stairs on building sides (decorative, at building edge)
    for (let ex = 200; ex < ww; ex += 1100) {
      const ey = roadY - 60;
      // Zigzag metal stairs
      for (let s = 0; s < 4; s++) {
        const sy = ey - s * 14;
        g.beginFill(COLORS.fireEscape, 0.4);
        g.drawRect(ex, sy, 10, 2);
        g.drawRect(ex + (s % 2 === 0 ? 8 : 0), sy - 12, 2, 14);
        g.endFill();
        // Railing
        g.beginFill(COLORS.fireEscape, 0.25);
        g.drawRect(ex - 1, sy, 1, 12);
        g.endFill();
      }
    }

    // Rooftop water tanks (decorative cylinders on "building tops" - near road, above)
    for (let rx = 400; rx < ww; rx += 1300) {
      const ry = roadY - 80;
      g.beginFill(COLORS.waterTank, 0.6);
      g.drawRect(rx, ry, 14, 12);
      g.endFill();
      // Dome top
      g.beginFill(COLORS.waterTank, 0.4);
      g.drawEllipse(rx + 7, ry, 7, 4);
      g.endFill();
      // Bands
      g.beginFill(COLORS.steelSilver, 0.3);
      g.drawRect(rx, ry + 3, 14, 1);
      g.drawRect(rx, ry + 8, 14, 1);
      g.endFill();
    }

    // Satellite uplink cables running between buildings (thin lines with support poles)
    for (let sx = 300; sx < ww - 400; sx += 800) {
      const sy1 = roadY - 90;
      const sy2 = roadY - 85;
      // Catenary cable
      g.lineStyle(1, COLORS.steelSilver, 0.3);
      g.moveTo(sx, sy1);
      const mid = sx + 400;
      g.quadraticCurveTo(mid, sy1 + 8, sx + 800, sy2);
      g.lineStyle(0);
      // Support poles
      g.beginFill(COLORS.steelSilver, 0.3);
      g.drawRect(sx + 100, sy1 - 3, 2, 6);
      g.drawRect(sx + 400, sy1 + 4, 2, 6);
      g.drawRect(sx + 700, sy2 - 3, 2, 6);
      g.endFill();
    }
  }

  private drawLegend(width: number, height: number) {
    const legend = new PIXI.Graphics();
    legend.beginFill(0x000000, 0.55);
    legend.drawRoundedRect(0, 0, 220, 90, 6);
    legend.endFill();
    legend.lineStyle(1, COLORS.gold, 0.8);
    legend.drawRoundedRect(0, 0, 220, 90, 6);
    legend.lineStyle(0);
    drawText(legend, "AGENCY WORLD", 10, 6, COLORS.gold, 2);
    drawText(legend, "AGENTS WALK BETWEEN STATIONS", 10, 24, COLORS.text, 1);
    drawText(legend, "EACH BUILDING = NODE", 10, 36, COLORS.textDim, 1);
    drawText(legend, "GEMS = INCOMING TASKS", 10, 48, COLORS.textDim, 1);
    drawText(legend, "ENVELOPES = INTER-AGENT MSGS", 10, 60, COLORS.textDim, 1);
    legend.position.set(16, height - 105);
    this.uiLayer.addChild(legend);
  }

  private handleResize = () => {
    const width = this.container.clientWidth || 900;
    const height = this.opts.height || this.container.clientHeight || 520;
    this.app.renderer.resize(width, height);
    this.viewport.resize(width, height, this.worldWidth, this.worldHeight);
    this.conveyor.resize(width - 32);
    this.minimap.container.position.set(width - 170, height - 120);
  };

  private tick() {
    if (this._destroyed) return;
    // Skip rendering when tab is hidden or this panel is offscreen.
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.offscreen || !this.panelActive) return;
    try {
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.05);
      this.lastTime = now;

      // Ambient engines (FX particles + day/night sky).
      this.fx.tick(dt, now);
      this.sky.tick(now);

      // Buildings (label blink only — zones are static)
      this.buildings.forEach((b) => b.animate(dt));

      // Agents
      this.agents.forEach((a) => {
        a.update(dt);
        a.tickBubble(now);
      });

      // Couriers
      const remCour: Courier[] = [];
      this.couriers.forEach((c) => {
        if (c.update(dt)) remCour.push(c);
      });
      remCour.forEach((c) => {
        this.worldEffectsLayer.removeChild(c.container);
        this.couriers.splice(this.couriers.indexOf(c), 1);
      });

      // Particles
      const remPart: Particle[] = [];
      this.particles.forEach((p) => {
        if (p.update(dt)) remPart.push(p);
      });
      remPart.forEach((p) => {
        this.worldEffectsLayer.removeChild(p.container);
        this.particles.splice(this.particles.indexOf(p), 1);
      });

      // Conveyor
      this.conveyor.update(dt);

      // Atmospheric details
      this.tickAtmosphere(dt, now);

      // Minimap
      if ((this.app.ticker.lastTime | 0) % 6 === 0) {
        this.minimap.update(this.buildings, this.viewport);
      }

      // Periodically re-check empty state
      if (!this.emptyChecked) this.checkEmpty();
    } catch (err) {
      console.error("[AgencyWorld] tick error:", err);
    }
  }

  setActive(active: boolean): void {
    if (this.panelActive === active) return;
    this.panelActive = active;
    this.updateTickerState();
  }

  private updateTickerState(): void {
    if (this._destroyed) return;
    const visible = typeof document === "undefined" || !document.hidden;
    const shouldRun = visible && this.panelActive && !this.offscreen;
    if (shouldRun) this.app.ticker.start();
    else this.app.ticker.stop();
  }

  private createEmptyOverlay(w: number, h: number): PIXI.Container {
    const c = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(0x0a0e1a, 0.75);
    bg.drawRect(0, 0, w, h);
    bg.endFill();
    c.addChild(bg);
    const txt = new PIXI.Text(
      "No agents connected — spawn one from the Operations panel",
      {
        fontFamily: "monospace",
        fontSize: 13,
        fill: 0x9aa2b1,
      },
    );
    txt.anchor.set(0.5);
    txt.position.set(w / 2, h / 2);
    c.addChild(txt);
    return c;
  }

  private checkEmpty(): void {
    if (this._destroyed) return;
    const empty = this.buildings.size === 0 && this.agents.size === 0;
    if (this.emptyOverlay) {
      this.emptyOverlay.visible = empty;
    }
  }

  // ─────────────────────── public API ───────────────────────

  addNode(node: MeshNode): void {
    if (this.buildings.has(node.id)) return;
    const b = new Building(node);
    const i = this.buildings.size;
    // Layout: 2 buildings per row, centered in world
    const col = i % 2;
    const row = Math.floor(i / 2);
    const gapX = 60;
    const gapY = 120;
    const totalW = 2 * BUILDING_WIDTH + gapX;
    const startX = (this.worldWidth - totalW) / 2;
    const startY = 540;
    b.container.position.set(
      startX + col * (BUILDING_WIDTH + gapX),
      startY + row * (BUILDING_HEIGHT + gapY),
    );
    b.container.zIndex = b.container.y;
    this.buildingsLayer.addChild(b.container);
    this.buildings.set(node.id, b);

    // Node click always toggles the focus dim; onNodeClick still fires so the
    // panel keeps receiving the event.
    (b.container as any).interactive = true;
    (b.container as any).cursor = "pointer";
    (b.container as any).on("pointertap", () => {
      this.nodeFilter = this.nodeFilter === node.id ? null : node.id;
      this.setNodeFilter(this.nodeFilter);
      this.opts.onNodeClick?.(node);
    });

    gsap.from(b.container, { alpha: 0, y: b.container.y + 30, duration: 0.45, ease: "back.out(1.4)" });
    if (!this.autoFit) {
      this.autoFit = true;
      setTimeout(() => this.zoomToFit(), 500);
    }
    this.checkEmpty();
  }

  updateNode(nodeId: string, data: Partial<MeshNode>): void {
    const b = this.buildings.get(nodeId);
    if (b) b.update({ ...b.data, ...data });
  }

  removeNode(nodeId: string): void {
    const b = this.buildings.get(nodeId);
    if (!b) return;
    gsap.to(b.container, {
      alpha: 0,
      duration: 0.3,
      onComplete: () => {
        this.buildingsLayer.removeChild(b.container);
        this.buildings.delete(nodeId);
        this.checkEmpty();
      },
    });
  }

  addAgent(agent: MeshAgent): void {
    if (this.agents.has(agent.sessionKey)) return;
    const b = this.buildings.get(agent.nodeId);
    if (!b) return;
    const char = new AgentChar(agent, this.opts.onAgentClick, this.atlas);
    char.spawnParticle = (x, y, color) => {
      const p = new Particle(b.container.x + x, b.container.y + y, color);
      this.worldEffectsLayer.addChild(p.container);
      this.particles.push(p);
    };
    // Engine owns the FX layer; resolve building-local → world coords here.
    char.emitWorkFx = (x, y, kind) =>
      this.fx.spawnToolParticle(b.container.x + x, b.container.y + y, kind);
    // Spawn at entry, then walk to zone
    char.setZone(b, "entry");
    b.agentsLayer.addChild(char.container);
    this.agents.set(agent.sessionKey, char);
    this.agentToNode.set(agent.sessionKey, agent.nodeId);
    this.refreshWorkingCount(b);
    // Schedule first move to inferred zone
    setTimeout(() => {
      const zone = inferZone(agent);
      char.setZone(b, zone);
    }, 350 + Math.random() * 350);
    // Briefly say hi
    char.say("CHECKING IN");
    const label = (agent.label || agent.agentId || "agent").slice(0, 20);
    this.narrate(`${label} checked in`);
    this.checkEmpty();
  }

  /** Recompute the count of working agents in a building (drives lit windows). */
  private refreshWorkingCount(b: Building): void {
    let n = 0;
    for (const a of this.agents.values()) {
      if (a.building === b && a.data.status === "working") n++;
    }
    b.setWorkingCount(n);
  }

  updateAgent(sessionKey: string, data: Partial<MeshAgent>): void {
    const char = this.agents.get(sessionKey);
    if (!char) return;
    const oldStatus = char.data.status;
    char.setData(data);
    const newStatus = char.data.status;
    // Recompute zone if status / lastActivity changed
    const b = char.building;
    const label = (char.data.label || char.data.agentId || "agent").slice(0, 20);
    if (b) {
      const target = inferZone(char.data);
      if (char.zone?.kind !== target) {
        char.setZone(b, target);
        // Speech for transitions
        const speech =
          target === "library"
            ? "LET ME READ"
            : target === "terminal"
              ? "RUNNING IT"
              : target === "drafting"
                ? "EDITING"
                : target === "browser"
                  ? "BROWSING"
                  : target === "comm"
                    ? "MESSAGING"
                    : target === "kanban"
                      ? "TRIAGE"
                      : target === "lounge"
                        ? "TAKING FIVE"
                        : "";
        if (speech) {
          char.say(speech);
          this.narrate(`${label} ${speech.toLowerCase()}`);
        }
      } else if (oldStatus !== char.data.status) {
        if (char.data.status === "completed") char.say("DONE");
        else if (char.data.status === "blocked") char.say("STUCK");
      }

      // Status-transition FX (world coords above the agent's head).
      if (oldStatus !== newStatus) {
        const wx = b.container.x + char.pos.x;
        const wy = b.container.y + char.pos.y - 12;
        if (newStatus === "completed") {
          this.fx.confettiBurst(wx, wy, char.palette.shirt);
          AudioBus.shared().play("chime");
          this.narrate(`${label} done`);
        } else if (newStatus === "blocked") {
          this.fx.alarmPulse(wx, wy);
          AudioBus.shared().play("alert");
        } else if (newStatus === "failed") {
          cameraShake(this.viewport);
        }
      }
    }
    // Lit-window count tracks working agents.
    if (b && oldStatus !== newStatus) this.refreshWorkingCount(b);
  }

  removeAgent(sessionKey: string): void {
    const char = this.agents.get(sessionKey);
    if (!char) return;
    if (char.zone) char.zone.releaseSeat(sessionKey);
    if (char.building) {
      const exitBuilding = char.building;
      // Animate exit to entry then remove
      const entry = char.building.zoneOf("entry");
      const ex = entry.worldOf(entry.seats[0] || null);
      char.target = ex;
      gsap.to(char.container, {
        alpha: 0,
        delay: 0.4,
        duration: 0.35,
        onComplete: () => {
          exitBuilding.agentsLayer.removeChild(char.container);
          this.agents.delete(sessionKey);
          this.agentToNode.delete(sessionKey);
          this.refreshWorkingCount(exitBuilding);
          this.checkEmpty();
        },
      });
    } else {
      this.agents.delete(sessionKey);
      this.agentToNode.delete(sessionKey);
    }
  }

  showMessage(message: MeshMessage): void {
    const fromChar = this.agents.get(message.from);
    const toChar = this.agents.get(message.to);
    if (!fromChar || !toChar || !fromChar.building || !toChar.building) return;
    const fromWorld = {
      x: fromChar.building.container.x + fromChar.pos.x,
      y: fromChar.building.container.y + fromChar.pos.y - 14,
    };
    const toWorld = {
      x: toChar.building.container.x + toChar.pos.x,
      y: toChar.building.container.y + toChar.pos.y - 14,
    };
    const c = new Courier(fromWorld, toWorld, message.type);
    this.worldEffectsLayer.addChild(c.container);
    this.couriers.push(c);
  }

  /** Push a task gem onto the conveyor. Optionally targets a building/agent. */
  pushTask(label: string, color = 0xfbbf24, targetNodeId?: string): void {
    this.narrate(`new task: ${label}`);
    this.conveyor.pushItem(label, color, () => {
      if (!targetNodeId) return;
      const b = this.buildings.get(targetNodeId);
      if (!b) return;
      // Spawn a courier from conveyor drop point to a working agent in node
      const drop = {
        x: b.container.x + BUILDING_WIDTH / 2,
        y: 200,
      };
      // Find a working agent in the node
      let target: AgentChar | undefined;
      for (const a of this.agents.values()) {
        if (a.building === b && (a.data.status === "working" || a.data.status === "idle")) {
          target = a;
          break;
        }
      }
      const dst = target
        ? { x: b.container.x + target.pos.x, y: b.container.y + target.pos.y - 14 }
        : { x: b.container.x + BUILDING_WIDTH / 2, y: b.container.y + BUILDING_HEIGHT / 2 };
      const c = new Courier(drop, dst, "request");
      this.worldEffectsLayer.addChild(c.container);
      this.couriers.push(c);
    });
  }

  centerView(): void {
    if (this.buildings.size > 0) this.zoomToFit();
    else this.viewport.moveCenter(this.worldWidth / 2, this.worldHeight / 2);
  }

  zoomIn(): void {
    gsap.to(this.viewport.scale, {
      x: Math.min(this.viewport.scale.x * 1.25, 2.5),
      y: Math.min(this.viewport.scale.y * 1.25, 2.5),
      duration: 0.25,
    });
  }

  zoomOut(): void {
    gsap.to(this.viewport.scale, {
      x: Math.max(this.viewport.scale.x / 1.25, 0.25),
      y: Math.max(this.viewport.scale.y / 1.25, 0.25),
      duration: 0.25,
    });
  }

  zoomToFit(): void {
    if (this.buildings.size === 0) {
      this.viewport.moveCenter(this.worldWidth / 2, this.worldHeight / 2);
      return;
    }
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    this.buildings.forEach((b) => {
      minX = Math.min(minX, b.container.x);
      maxX = Math.max(maxX, b.container.x + BUILDING_WIDTH);
      minY = Math.min(minY, b.container.y - 40);
      maxY = Math.max(maxY, b.container.y + BUILDING_HEIGHT);
    });
    const w = maxX - minX;
    const h = maxY - minY;
    const target = Math.min(
      (this.viewport.screenWidth - 80) / w,
      (this.viewport.screenHeight - 160) / h,
      1.4,
    );
    this.viewport.moveCenter(minX + w / 2, minY + h / 2);
    gsap.to(this.viewport.scale, { x: target, y: target, duration: 0.35 });
  }

  clear(): void {
    Array.from(this.agentToNode.keys()).forEach((k) => this.removeAgent(k));
    Array.from(this.buildings.keys()).forEach((k) => this.removeNode(k));
  }

  destroy(): void {
    this._destroyed = true;
    if (this.emptyCheckTimer) clearTimeout(this.emptyCheckTimer);
    if (this._visHandler) {
      document.removeEventListener('visibilitychange', this._visHandler);
      this._visHandler = null;
    }
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    // Clear internal collections first
    this.buildings.clear();
    this.agents.clear();
    this.agentToNode.clear();
    this.couriers.length = 0;
    this.particles.length = 0;
    this.notes.clear();
    this.noteSprites.clear();
    this.loadingOverlay = null;
    this.emptyOverlay = null;
    // Remove event listeners
    try { (this.app.view as HTMLCanvasElement).removeEventListener('wheel', this.handleWheelZoom); } catch { /* ignore */ }
    if (this.resizeObs) this.resizeObs.disconnect();
    else window.removeEventListener("resize", this.handleResize);
    this.atmosphereG = null;
    // Stop the ticker before destroying
    if (this.app.ticker) this.app.ticker.stop();
    try {
      this.fx.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.sky.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.atlas?.destroy();
    } catch {
      /* ignore */
    }
    this.app.destroy(true, { children: true, texture: true });
  }

  getAgentCount(): number {
    return this.agents.size;
  }

  getNodeCount(): number {
    return this.buildings.size;
  }

  // ─────────────────── Wave-2 public surface ───────────────────

  /** Underlying PixiJS canvas (used by the viz wrapper / panel). */
  getView(): HTMLCanvasElement {
    return this.app.view as HTMLCanvasElement;
  }

  /**
   * Dim all buildings except `id`; pass null to clear. Also drives the
   * internal node-click focus toggle.
   */
  setNodeFilter(id: string | null): void {
    this.nodeFilter = id;
    this.buildings.forEach((b) => {
      gsap.to(b.container, {
        alpha: id && b.data.id !== id ? 0.35 : 1,
        duration: 0.3,
      });
    });
  }

  /** Quick full-screen lightning flash signalling a federation disconnect. */
  signalDisconnect(): void {
    this.screenFlash([0.6, 0.0, 0.5, 0.0], 0xffffff);
  }

  /** Soft flash + ding signalling federation reconnect. */
  signalReconnect(): void {
    AudioBus.shared().play("ding");
    this.screenFlash([0.35, 0.0], 0x9fc6e0);
  }

  /**
   * Screen-space flash on the UI layer. `frames` is an alternating list of
   * alpha targets tweened in sequence (start alpha 0). Sized to the renderer.
   */
  private screenFlash(frames: number[], color: number): void {
    const flash = new PIXI.Graphics();
    flash.beginFill(color, 1);
    flash.drawRect(
      0,
      0,
      this.app.renderer.width,
      this.app.renderer.height,
    );
    flash.endFill();
    flash.alpha = 0;
    this.uiLayer.addChild(flash);
    const tl = gsap.timeline({
      onComplete: () => {
        if (flash.parent) flash.parent.removeChild(flash);
        flash.destroy();
      },
    });
    for (const a of frames) {
      tl.to(flash, { alpha: a, duration: 0.08, ease: "power1.out" });
    }
  }

  /** Broadcast a one-line world event for the news ticker to pick up. */
  private narrate(text: string): void {
    try {
      this.container.dispatchEvent(
        new CustomEvent("agency-news", {
          detail: { ts: Date.now(), text },
          bubbles: true,
          composed: true,
        }),
      );
    } catch {
      /* CustomEvent unsupported (non-DOM env) — ignore */
    }
  }
}
