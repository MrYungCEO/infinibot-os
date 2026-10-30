/**
 * Activity Map — PixiJS-based visualization for Agent Operations Center
 * 🏠 ToffeeCraft Cozy Room sprite-based rendering
 * 
 * Layout:
 * - Federation Node = Building/Area containing multiple agent rooms
 * - Each Agent = Own Room with desk, chair, laptop, carpet, plant
 * - Agent status determines position (working → desk, idle → sofa, blocked → standing)
 */

import * as PIXI from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import gsap from 'gsap';

import {
  loadCozyRoomAssets,
  areTexturesLoaded,
  getCozyTextures,
  createRoomSprite,
  createDeskSprite,
  createChairSprite,
  createSofaSprite,
  createLaptopSprite,
  createPlantSprite,
  createCarpetSprite,
  createCoffeeSprite,
  createTeddySprite,
  createBookcaseSprite,
  getDeskColorByIndex,
  getChairColorByIndex,
  getPlantVariantByIndex,
  type DeskColor,
  type ChairColor,
} from './cozy-room-assets';
import {
  GALACTIC,
  setGalacticAccent,
  setGalacticTheme,
  resolveGalacticTheme,
  ACCENT_PRESETS,
} from './iso/galactic-theme';
import { getGalacticTextures, getAgentSpriteTextures, loadAgentSprites, resetGalacticTextures, drawDashedLine, drawDashedArc, type GalacticTextures } from './iso/galactic-assets';
// Per-agent sprite variants (Phase 1 §1): a stable per-sessionKey hue + accent so
// five same-backend coders read as five distinct characters instead of one clone.
import { variantForRun, accentForVariant } from './iso/sprites/palette';
import { normalizeAgentKind } from './iso/sprites/registry';
import {
  buildStationComplex,
  buildPod,
  type StationComplex,
  type SectorDef,
} from './iso/sector-layout';
import { accentForSector } from './iso/district-accents';
import { IslandAura, type IslandMood } from './iso/island-aura';
import { Starfield } from './iso/starfield';
import { GALACTIC_LABEL_FADE_MS, GALACTIC_LABEL_IDLE_ALPHA, CinematicOverlay, HudOverlay, ThemePicker, makeText } from './iso/hud';
// Phase 2 §drone-cam + Phase 4 origin-story/recordCinematic: the cinematic camera
// engine (auto-drone orbit, composed shots, off-screen clip capture). Built but
// previously only exercised by its test harness — wired live here.
import { CinematicCamera } from './iso/cinematic-camera';
import { drawPixelText, measurePixelText } from './iso/pixel-text';
import { MAX_RESTING_COMPLETED } from './resting-completed';
import {
  placeAgentOverlays,
  placeFloatingRect,
  type BubblePlacementInput,
  type LabelPlacementInput,
  type OverlayPlacement,
  type ScreenRect,
  type SpriteObstacle,
} from './overlay-placement';
import { ProviderBadge, preloadProviderLogos } from './provider-logos';
import { AgentSpreadDriver, type SpreadAgentView } from './iso/agent-spread-driver';
import { TOOL_SIGNAL_TTL_MS } from './iso/agent-spread';
import { PluginDistrict, type DistrictOccupant } from './iso/plugin-district';
import { roomSectorId, type PluginRoomSpec } from './iso/plugin-rooms';
import type { PluginActivityIndex } from './iso/plugin-activity';

// ════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════

const ROOM_WIDTH = 180;   // Width of one agent room
const ROOM_HEIGHT = 140;  // Height of one agent room
const ROOMS_PER_ROW = 4;  // Rooms per row in a node
const NODE_PADDING = 60;  // Padding around node area
const NODE_GAP = 100;     // Gap between nodes
const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 1800;
const LABELS_HIDDEN_STORAGE_KEY = 'infinibot.hq.labelsHidden';
const ZOOM_STEP_IN = 1.25;
const ZOOM_STEP_OUT = 0.8;
const ZOOM_EASE_MS = 150;
const MIN_ZOOM = 0.2;
// Phase 4 §federation galaxy: below this zoom the view reads as an interstellar
// map — federation nodes are labeled "stations", bridges become bright trade
// routes, and per-agent detail LODs away (the FX layers already fade via
// __agentFxZoom). Crossed both ways with hysteresis to avoid flicker.
const GALAXY_ZOOM_ENTER = 0.42;
const GALAXY_ZOOM_EXIT = 0.5;
// Phase 1 holographic revamp: widen the ceiling so the broadcast camera can push
// in far enough to read an agent's caption tag clearly.
const MAX_ZOOM = 3.5;

// When true, galactic mode renders the baked AI-generated PNG character sprites
// from ui/public/agent-sprites/{claude,opencode,codex,gemini,default}.png,
// keyed by resolveAgentSpriteSlot(agent.coderBackend). When false, falls back
// to the hand-drawn pixel ninja patterns (ROBOT_PATTERNS.ninja_*).
const USE_GENERATED_SPRITES = true;

const COLORS = {
  bg: 0x87ceeb,           // Sky blue background
  text: 0x3a3a4a,
  textLight: 0x6a7a8a,
  white: 0xffffff,
  gold: 0xffd700,
  shadow: 0x000000,
  nodeOnline: 0x22c55e,
  nodeOffline: 0xef4444,
  nodeConnecting: 0xf59e0b,
};

const STATUS_COLORS: Record<string, number> = {
  starting: 0x3b82f6,
  idle: 0x6a8a6a,
  running: 0xffd700,
  working: 0xffd700,
  blocked: 0xe74c3c,
  finishing: 0xf59e0b,
  completed: 0x22c55e,
  failed: 0xef4444,
};

const AGENT_WALK_SPEED_PX = 60;
const AGENT_IDLE_SPEED_PX = 24;
const AGENT_IDLE_RADIUS_X = 22;
const AGENT_IDLE_RADIUS_Y = 12;
const AGENT_IDLE_MIN_SECONDS = 3;
const AGENT_IDLE_MAX_SECONDS = 6;
const AGENT_WORK_BOB_PX = 2;
const AGENT_WORK_BOB_HZ = 2;
const AGENT_WORK_FLASH_SECONDS = 1.5;
// ── Mesh liveness (feat/mesh-map-liveness) ──────────────────────────────────
// Subtle "between tool calls" drift so a running agent breathes instead of
// freezing solid while it waits on a long call. Small radius, slow cadence.
const AGENT_ACTIVE_DRIFT_RADIUS_X = 7;
const AGENT_ACTIVE_DRIFT_RADIUS_Y = 4;
const AGENT_ACTIVE_DRIFT_MIN_SECONDS = 2.2;
const AGENT_ACTIVE_DRIFT_MAX_SECONDS = 4.6;
// Premium nameplate + progress-bar geometry (galactic mode), rendered below the
// agent's feet. Counter-scaled with zoom so it stays readable, culled below
// LABEL_MIN_ZOOM (the map reads as a star-field at that distance anyway).
const LABEL_STACK_Y = 30;             // px below agent center → nameplate top
const LABEL_H = 14;                   // nameplate pill height
const LABEL_MIN_ZOOM = 0.5;           // hide per-agent plate/bar below this zoom
const LABEL_MIN_SCALE = 0.32;
const LABEL_MAX_SCALE = 1.8;
const LABEL_MAX_CHARS = 14;
// Finished runs resting on a Concourse bed: shorter, smaller plate that sits
// on the bed (beds are a tight 4×4 grid, so no stagger).
const LABEL_RESTING_MAX_CHARS = 12;
const LABEL_RESTING_SCALE = 0.8;
const LABEL_RESTING_Y = -62; // above the head: the bed in front draws over anything below
// Gentle render-space repulsion so co-located RUNNING agents don't stack on top
// of each other (labels would collide). Additive offset only — never touches the
// agent's logical target, self-limits via decay, and caps so agents stay near
// their meaningful home/sector.
const AGENT_SEPARATION_MIN_PX = 52;
const AGENT_SEPARATION_MAX_OFFSET = 24;
const AGENT_SEPARATION_STRENGTH = 30;
const AGENT_SEPARATION_DECAY = 4.5;   // per-second exponential relax
// Finished agents shouldn't linger — depart quickly. Failed lingers a touch
// longer so the red completion glyph is readable before it leaves.
const HUDDLE_MIN_AGENTS = 3;
const HUDDLE_BASE_RADIUS = 20;
const HUDDLE_RADIUS_PER_AGENT = 3;
const ATRIUM_CORE_BASE_RADIUS = 80;
const ATRIUM_CORE_BREATH_HZ = 0.5;
const ATRIUM_CORE_MIN_ALPHA = 0.3;
const ATRIUM_CORE_MAX_ALPHA = 0.55;
const ATRIUM_SURGE_MS = 800;
const ATRIUM_CONDUIT_IDLE_ALPHA = 0.18;
const ATRIUM_CONDUIT_PULSE_MS = 250;
const ATRIUM_CONDUIT_FAIL_MS = 400;
const ATRIUM_CONDUIT_DRAW_MS = 600;
const ATRIUM_CONDUIT_DISCONNECT_MS = 5000;
const ATRIUM_GLYPH_SPEED = 500;
const ATRIUM_MAX_GLYPHS = 60;
const ATRIUM_GOLD = 0xffd700;
const ATRIUM_SKY = 0x0ea5e9;
const ATRIUM_FAIL = 0xef4444;

// ── Activity-driven movement (Part 1) ───────────────────────────
// Agents walk to the HQ sector matching the tool they fire, sit there for
// the call, then return home. Speeds are at 1.0 viewport scale.
const TOOL_WALK_SPEED_PX = 80;        // outbound trip to a tool sector
const TOOL_RETURN_SPEED_PX = 120;     // brisker walk back home
const TOOL_HOLD_MS = 5000;            // return after 5s of no further tool events
const TASK_TRIP_HOLD_MS = 10000;      // "look at the task" dwell at the board
// Sector-dwell spread. Agents that share a state region (thinking → observatory,
// write → workshop, etc.) used to be scattered with a hash-mod jitter
// (`hash % JITTER`) that collided — two distinct agent ids could land on the
// exact same tile, so several agents stacked into one cluttered blob. They now
// pack on a golden-angle (Vogel/sunflower) phyllotaxis: near-uniform spacing,
// no overlap for any count, deterministic in slot order. Indexed by stable
// agent-id hash so the same occupant set reproduces the same layout (stable
// across refresh). Replaces the old ring/jitter branches entirely.
const SECTOR_SLOT_SPACING = 34;       // ≈ avatar diameter → min center-to-center, no overlap
const SECTOR_ISO_SQUASH = 0.55;       // vertical foreshorten on the iso floor
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad — optimal angular spacing
// Phase 3 drag-to-assign: coarse "kind" per sector, read by the spawn pre-fill
// when an idle agent is dropped on a building. Unmapped sectors default to "tool".
const SECTOR_DROP_KIND: Record<string, string> = {
  'mission-control': 'autonomy',
  'agent-quarters': 'agents',
  'engineering-bay': 'terminals',
  'command-atrium': 'federation',
  'comms-deck': 'channels',
  'observatory': 'analytics',
  'broadcast-studio': 'media',
  'canvas-atrium': 'canvas',
  'the-vault': 'security',
};
const REST_WALK_SPEED_PX = 70;        // unhurried glide to a concourse bed
const SECTORS_CORE_COUNT = 10;        // fixed core floorplan (iso/sector-layout.ts)

// ── Per-agent station anchoring (spread / furniture-anchored resting) ────
// A "station" is the local-space point inside a NodeArea where one specific
// agent works / rests / stands — anchored to a furniture object (desk, bench,
// server, pad) on pod nodes, or to a tight cluster slot in the AQ hub. Replaces
// the old hardcoded posture coords that put every agent on the same spot.
type Station = { x: number; y: number; kind: string };

// Pod-node furniture anchors (local to each office container; identical layout
// per room, so they double as a shared station pool the NodeArea cycles agents
// through). Coords mirror buildGalacticOffice() furniture placement.
const POD_DESK_STATION = { x: -34, y: 14 };   // console desk (work)
const POD_SERVER_STATION = { x: 52, y: -8 };  // server obelisk (work, alt)
const POD_BENCH_STATION = { x: 36, y: 30 };   // glass bench (rest)
const POD_PAD_STATION = { x: 0, y: 8 };        // pad center (stand)

// Agent-Quarters hub has no furniture (stripped). Spread agents in a tight
// 5-point cluster (center + 4 corners) inside their assigned grid cell so up to
// ~5 near-coincident agents don't render perfectly stacked. Small magnitudes —
// AQ rooms render at a reduced scale and are densely packed.
const AQ_CLUSTER_OFFSETS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: -2 },
  { x: -7, y: 3 },
  { x: 7, y: 3 },
  { x: -4, y: -6 },
  { x: 4, y: -6 },
];

// ── Agent-Quarters spread layout ─────────────────────────────────────────────
// Agents that share the Agent-Quarters hub used to be pulled into a single tight
// huddle circle (HUDDLE_BASE_RADIUS≈20px) and bunched on top of each other. They
// now distribute on a deterministic, stable slot grid keyed by agent-id hash:
//   N ≤ 4  → 2×2,  N ≤ 9 → 3×3,  otherwise an expanding square spiral.
// Min slot spacing ≥ avatar diameter + padding so no two avatars overlap. Y is
// foreshortened to read correctly on the iso floor; the collision pass uses the
// same factor so "no overlap" is enforced in the rendered (squashed) space.
const AQ_AVATAR_DIAMETER = 34;        // ~body width of an agent sprite
const AQ_SLOT_PADDING = 14;           // gap between neighbouring avatars
const AQ_MIN_DISTANCE = AQ_AVATAR_DIAMETER + AQ_SLOT_PADDING; // 48px center-to-center
const AQ_STEP_X = AQ_MIN_DISTANCE;    // horizontal slot pitch
const AQ_ISO_SQUASH = 0.62;           // vertical foreshorten (matches huddle 0.55-ish)
const AQ_STEP_Y = AQ_MIN_DISTANCE;    // vertical slot pitch (pre-squash)

/** Lattice (col,row) coordinates for `count` agents: 2×2 / 3×3 grid, else an
 *  expanding clockwise square spiral. Pure + deterministic so the same agent set
 *  always yields the same slots (stable reflow). Returned coords are centered on
 *  (0,0) in lattice units; callers scale by the slot pitch. */
function aqLatticeCoords(count: number): Array<{ cx: number; cy: number }> {
  if (count <= 0) return [];
  // Grid shapes for the small, common cases.
  if (count <= 9) {
    const cols = count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    const out: Array<{ cx: number; cy: number }> = [];
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      out.push({ cx: col - (cols - 1) / 2, cy: row - (rows - 1) / 2 });
    }
    return out;
  }
  // Spiral pack: ring outward from the origin, one step per cell.
  const out: Array<{ cx: number; cy: number }> = [{ cx: 0, cy: 0 }];
  let x = 0, y = 0, dx = 1, dy = 0, seg = 1, segLeft = 1, turns = 0;
  while (out.length < count) {
    x += dx; y += dy;
    out.push({ cx: x, cy: y });
    if (--segLeft === 0) {
      // rotate direction clockwise: (dx,dy) -> (-dy,dx)
      const ndx = -dy; const ndy = dx; dx = ndx; dy = ndy;
      if (++turns % 2 === 0) seg++;
      segLeft = seg;
    }
  }
  return out;
}

// Deterministic jitter applied to duplicate furniture assignments (when more
// agents share a node than there are unique furniture anchors). `dup` is how
// many full pool-cycles deep this assignment is; index decides the sign so the
// two offsets fan out in opposite iso directions. Capped at ±8px / ±4px.
function stationJitter(dup: number, index: number): { dx: number; dy: number } {
  if (dup <= 0) return { dx: 0, dy: 0 };
  const sign = index % 2 === 0 ? 1 : -1;
  const dx = sign * Math.min(8, 4 + (dup - 1) * 2);
  const dy = sign * Math.min(4, 2 + (dup - 1) * 1);
  return { dx, dy };
}

// Golden-angle (Vogel/sunflower) phyllotaxis slot for sector dwell. Packs N
// points around a center with constant density (radius ∝ √index) and the
// golden angle between successive points, which is the angular spacing that
// minimises clustering — guaranteeing ≥ ~SECTOR_SLOT_SPACING between any two
// neighbours and no overlap for any count. Pure + deterministic: slot `index`
// always yields the same offset, so a stable per-agent index → stable position.
// Caller foreshortens dy for the iso floor.
function sectorSlot(index: number, total: number): { dx: number; dy: number } {
  if (total <= 1) return { dx: 0, dy: 0 }; // lone occupant sits dead-center
  const r = SECTOR_SLOT_SPACING * Math.sqrt(index + 0.5);
  const a = index * GOLDEN_ANGLE;
  return { dx: Math.cos(a) * r, dy: Math.sin(a) * r };
}

// Room footprint (matches AgentRoom.hitRect base extents) used for collision
// spread. Kept as module constants so spread math doesn't depend on the live
// (walk-mutated) hitRect.
const ROOM_FOOTPRINT_X = -20;
const ROOM_FOOTPRINT_Y = -34;
const ROOM_FOOTPRINT_W = 40;
const ROOM_FOOTPRINT_H = 92;
const SPREAD_PUSH_PX = 30;            // single nudge resolves a >50% overlap
const SPREAD_OVERLAP_THRESHOLD = 0.5;

function rectOverlapRatio(a: PIXI.Rectangle, b: PIXI.Rectangle): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 ? inter / minArea : 0;
}

function isWorkingStatus(status?: string): boolean {
  return status === 'running' || status === 'working' || status === 'starting' || status === 'finishing';
}

function isIdleStatus(status?: string): boolean {
  return status === undefined || status === 'idle';
}

/** Resting = no active task / no in-flight work. These agents glide to the
 *  gateway concourse and park on a bed (full size — never shrunk in place).
 *  Finished runs (completed AND failed) rest too — see MAX_RESTING_COMPLETED. */
function isRestingStatus(status?: string): boolean {
  return status === undefined || status === 'idle' || isFinishedStatus(status);
}

/** A finished run (success or failure) — rests on a bed with a ✓ / ✕ marker. */
function isFinishedStatus(status?: string): boolean {
  return status === 'completed' || status === 'failed';
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** True when the OS/browser requests reduced motion — gates expensive FX. */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function seededUnit(state: number): { value: number; state: number } {
  let next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next };
}

/**
 * World theme: 'galactic' is the black & gold isometric station
 * (docs/design/galactic-hq-activity-map.md); 'cozy' is the legacy
 * ToffeeCraft map, kept as a rollback path.
 */
export type WorldTheme = 'galactic' | 'cozy';

// Set once by the ActivityMap constructor before any scene object is built.
let WORLD_THEME: WorldTheme = 'galactic';
const isGalactic = () => WORLD_THEME === 'galactic';

function readPointerType(event: unknown): string | undefined {
  const e = event as { pointerType?: string; data?: { pointerType?: string } };
  return e.data?.pointerType ?? e.pointerType;
}

function readPointerId(event: unknown): string {
  const e = event as {
    pointerId?: string | number;
    identifier?: string | number;
    data?: { pointerId?: string | number; identifier?: string | number };
  };
  return String(e.data?.pointerId ?? e.data?.identifier ?? e.pointerId ?? e.identifier ?? 'touch');
}

function readLabelsHiddenSetting(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(LABELS_HIDDEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeLabelsHiddenSetting(hidden: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LABELS_HIDDEN_STORAGE_KEY, hidden ? 'true' : 'false');
  } catch {
    // Ignore storage failures; the in-memory toggle still works.
  }
}

// ════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════

export interface MeshNode {
  id: string;
  name: string;
  role: 'hub' | 'satellite' | 'local';
  status: 'online' | 'offline' | 'connecting';
  agentCount: number;
  capabilities?: string[];
  mcpConnections?: string[];
  messageRate?: number;
  x?: number;
  y?: number;
}

export interface MeshAgent {
  sessionKey: string;
  agentId: string;
  label: string;
  nodeId: string;
  status: string;
  progress: number;
  currentTask?: string;
  parent?: string;
  children?: string[];
  /** CLI provider that produced this run, when known. Drives the small logo
   *  badge rendered above the agent's head. */
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /** subagents.list run id, when this agent is a tracked sub-agent run. */
  runId?: string;
  /** True for coder (CLI backend) sub-agent runs — drawn as build agents. */
  isBuild?: boolean;
  /** Human label of the run's latest tool call ("Bash: pnpm test"). */
  activityLabel?: string;
  /** Cumulative session token usage, when the gateway reports it (HUD Tokens/Hr). */
  totalTokens?: number;
  /** Provider model when the gateway exposes it (also used as a backend hint). */
  model?: string;
  /** Run timing fields used by the Agent Mesh detail hover card. */
  startedAt?: number;
  lastUpdateAt?: number;
  lastActivityAt?: number;
  /** Latest named milestone/checkpoint, when reported by a sub-agent run. */
  currentCheckpoint?: string;
  /** Files the run touched (subagents.list filesTouchedCount). */
  filesTouchedCount?: number;
  /** Kanban task auto-created for this run, when any. */
  kanbanTaskId?: string;
  /** Epoch ms the run ended (finished runs resting on the map). */
  endedAt?: number;
  /** Most recent structured activity record. */
  lastActivity?: { kind?: string; label?: string; at?: number; [key: string]: unknown };
  /** Plugin this run/task is tagged with (phase/goal/scheduled task `plugin`),
   *  when the gateway says so. Routes the agent to that plugin's map room. */
  pluginId?: string;
}

export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  type: 'request' | 'response' | 'broadcast' | 'event';
  preview?: string;
  timestamp: number;
}

export interface ActivityMapOptions {
  width?: number;
  height?: number;
  worldTheme?: WorldTheme;
  onAgentClick?: (agent: MeshAgent) => void;
  onNodeClick?: (node: MeshNode) => void;
  onZoneClick?: (sector: SectorDef) => void;
  /** A plugin room in the Plugin District was clicked (opens the plugin's page). */
  onPluginRoomClick?: (spec: PluginRoomSpec) => void;
}

export type { SectorDef } from './iso/sector-layout';
export type { PluginRoomSpec } from './iso/plugin-rooms';

type AtriumConduitKind = 'fed' | 'ssh';
type AtriumPulseKind = 'send' | 'ack' | 'fail' | 'command';

interface AtriumConduitState {
  key: string;
  peerId: string;
  kind: AtriumConduitKind;
  host?: string;
  displayName?: string;
  angle?: number;
  active: boolean;
  container: PIXI.Container;
  line: PIXI.Graphics;
  label: PIXI.Graphics;
  sparkle: PIXI.Graphics;
  anchor: PIXI.Point;
  drawProgress: number;
  disconnectedUntil: number;
  pulsePower: number;
  failUntil: number;
  sparkleUntil: number;
}

interface AtriumGlyph {
  container: PIXI.Container;
  text: PIXI.Graphics;
  echoes: PIXI.Graphics[];
  active: boolean;
  conduitKey: string;
  from: PIXI.Point;
  to: PIXI.Point;
  elapsedMs: number;
  durationMs: number;
}

// ── Time-scrub replay (world-space history) ────────────────────────────────
// The engine records a 1 Hz ring buffer of every on-map agent's WORLD position
// + status, plus the active federation/ssh conduit set. <world-timeline-scrubber>
// drives replay by handing the engine a timestamp via setReplayTime(); the
// animate loop then freezes live room motion and forces each sprite to its
// interpolated historical position, reconciling conduits to match.
interface ReplayAgentSample {
  id: string;
  wx: number;
  wy: number;
  status: string;
  backend?: string;
}
interface ReplayConduitSample {
  peerId: string;
  kind: AtriumConduitKind;
  host?: string;
  displayName?: string;
  angle?: number;
}
interface ReplayHistorySample {
  t: number;
  agents: ReplayAgentSample[];
  conduits: ReplayConduitSample[];
}

// Discrete world events (tool invocations, completions, agent dialogue) recorded
// at the live emit site with an epoch-ms timestamp. Positions live in the 1 Hz
// `ReplayHistorySample` ring; these events are *between* those samples, so they
// get their own time-ordered log that replay diffs and re-fires. Each kind maps
// to the SAME render method the live path calls (single source of truth):
//   tool     → showToolBubble + spawnPulseRing  (speech bubble + tool pulse)
//   dialogue → showToolBubble                    (free-text agent speech)
//   complete → burstCompletion                   (success/fail glyph burst)
type ReplayEventKind = "tool" | "dialogue" | "complete";
interface ReplayEventSample {
  t: number;
  sessionKey: string;
  kind: ReplayEventKind;
  toolKind?: string;
  label?: string;
  success?: boolean;
}


// ════════════════════════════════════════════════════════════════
// PIXEL AGENT CHARACTER
// ════════════════════════════════════════════════════════════════

const AGENT_PATTERNS: Record<string, number[][]> = {
  main: [
    [0,0,1,1,1,1,0,0],
    [0,1,2,2,2,2,1,0],
    [1,2,3,2,2,3,2,1],
    [1,2,2,2,2,2,2,1],
    [0,1,2,4,4,2,1,0],
    [0,0,1,1,1,1,0,0],
    [0,1,5,1,1,5,1,0],
    [0,1,1,0,0,1,1,0],
  ],
  coder: [
    [0,0,1,1,1,1,0,0],
    [0,1,2,2,2,2,1,0],
    [1,2,6,2,2,6,2,1],
    [1,2,2,2,2,2,2,1],
    [0,1,2,2,2,2,1,0],
    [0,0,1,1,1,1,0,0],
    [0,1,7,1,1,7,1,0],
    [0,1,1,0,0,1,1,0],
  ],
  default: [
    [0,0,1,1,1,1,0,0],
    [0,1,2,2,2,2,1,0],
    [1,2,3,2,2,3,2,1],
    [1,2,2,2,2,2,2,1],
    [0,1,2,2,2,2,1,0],
    [0,0,1,1,1,1,0,0],
    [0,1,2,1,1,2,1,0],
    [0,1,1,0,0,1,1,0],
  ],
};

const SPRITE_PALETTE: Record<number, number> = {
  0: 0x000000, // transparent
  1: 0x3a3a4a, // outline
  2: 0xf5d0a9, // skin
  3: 0x2a2a4a, // eyes
  4: 0xc9302c, // mouth
  5: 0x5a7a5a, // shirt
  6: 0x4a9eff, // glasses
  7: 0x4a5a6a, // hoodie
};

// ── Galactic robot crew ──────────────────────────────────────────
// Primary pixel art — the house render path in both flat and galactic mode.
// The baked per-backend PNG sprites are disabled by default
// (USE_GENERATED_SPRITES = false) because the AAA character art clashed with
// the iso pixel theme; drawAgent() only consults them when that flag is on.
// Palette indices: 1 outline · 9 metal light · 10 metal mid ·
// 11 metal dark · 13 white highlight · 8 accent glow (theme goldLt) ·
// 12 accent deep (theme gold). Accent cells re-tint live with the theme.

const ROBOT_PATTERNS: Record<string, number[][]> = {
  // Antenna, gold collar, glowing chest core — the orchestrator
  commander: [
    [0,0,0,8,8,0,0,0],
    [0,0,0,1,1,0,0,0],
    [0,1,9,9,9,9,1,0],
    [1,9,8,9,9,8,9,1],
    [1,9,9,9,9,9,9,1],
    [0,1,12,12,12,12,1,0],
    [1,10,9,10,10,9,10,1],
    [1,10,10,8,8,10,10,1],
    [0,1,10,10,10,10,1,0],
    [0,1,1,0,0,1,1,0],
  ],
  // Full-width glowing visor — the coder unit
  visor: [
    [0,0,1,1,1,1,0,0],
    [0,1,9,9,9,9,1,0],
    [1,9,8,8,8,8,9,1],
    [1,9,11,11,11,11,9,1],
    [0,1,9,9,9,9,1,0],
    [0,1,10,12,12,10,1,0],
    [1,10,10,10,10,10,10,1],
    [0,1,10,10,10,10,1,0],
    [0,1,1,0,0,1,1,0],
  ],
  // Hovering monocular drone with thruster glow, no legs
  drone: [
    [0,0,1,1,1,1,0,0],
    [0,1,9,9,9,9,1,0],
    [1,9,9,8,8,9,9,1],
    [1,9,9,8,8,9,9,1],
    [0,1,9,9,9,9,1,0],
    [0,0,1,10,10,1,0,0],
    [0,0,8,0,0,8,0,0],
    [0,0,0,8,8,0,0,0],
  ],
  // Broad-shouldered heavy unit with an accent power band
  mech: [
    [0,1,1,1,1,1,1,0],
    [1,9,8,9,9,8,9,1],
    [1,9,9,9,9,9,9,1],
    [1,1,1,1,1,1,1,1],
    [1,10,10,10,10,10,10,1],
    [1,10,8,8,8,8,10,1],
    [1,10,10,10,10,10,10,1],
    [0,1,10,0,0,10,1,0],
    [0,1,1,0,0,1,1,0],
  ],
  // Slim recon unit with a beacon mast
  scout: [
    [0,0,0,0,8,0,0,0],
    [0,0,0,0,1,0,0,0],
    [0,0,1,9,9,1,0,0],
    [0,1,9,8,8,9,1,0],
    [0,1,9,9,9,9,1,0],
    [0,0,1,12,12,1,0,0],
    [0,1,10,10,10,10,1,0],
    [0,0,1,10,10,1,0,0],
    [0,0,1,0,0,1,0,0],
    [0,1,1,0,0,1,1,0],
  ],

  // ── Per-backend ninja crew ────────────────────────────────────
  // Hand-drawn to match the iso pixel aesthetic. One distinct silhouette per
  // CLI backend slot. Same palette + scale as the crew above (1/8/9/10/11/12/13).

  // House style — neutral gold-sentinel ninja. Rounded helm, single visor
  // slit, vertical chest power core (8·12·8), arms at sides. The baseline the
  // other four vary off of.
  ninja_default: [
    [0,0,0,1,1,1,0,0,0],
    [0,0,1,9,9,9,1,0,0],
    [0,1,9,9,9,9,9,1,0],
    [0,1,11,8,8,8,11,1,0],
    [0,1,9,9,9,9,9,1,0],
    [0,1,12,12,12,12,12,1,0],
    [1,10,9,9,8,9,9,10,1],
    [1,10,9,9,12,9,9,10,1],
    [1,10,9,9,8,9,9,10,1],
    [1,10,10,9,9,9,10,10,1],
    [0,1,10,10,1,10,10,1,0],
    [0,1,10,1,0,1,10,1,0],
    [0,1,1,0,0,0,1,1,0],
  ],

  // claude-code — hooded cyber-monk. Tall outline-heavy cowl bulging forward,
  // a single glowing visor slit, a chest sash (12·8·12 diagonal), and a
  // trailing scarf jutting off the right shoulder (asymmetric). Calm, robed.
  ninja_claude: [
    [0,1,1,1,1,1,0,0,0],
    [1,1,9,9,9,1,1,0,0],
    [1,9,9,9,9,9,1,0,0],
    [1,9,11,8,8,11,9,1,0],
    [1,9,9,9,9,9,9,1,0],
    [0,1,9,9,9,9,1,12,0],
    [0,1,12,8,12,9,1,12,0],
    [0,1,9,12,8,12,1,0,0],
    [0,1,10,9,9,10,1,0,0],
    [0,1,10,10,10,10,1,0,0],
    [0,1,10,1,1,10,1,0,0],
    [0,1,1,0,0,1,1,0,0],
  ],

  // opencode — agile rogue. Crested helm with two katana pommels poking up
  // over the shoulders (gold hilts crossing behind), a 3-cell visor slit, a
  // cinched gold waist, and a crouched ready stance with feet planted wide.
  ninja_opencode: [
    [0,0,0,1,1,1,0,0,0],
    [0,12,1,9,9,9,1,12,0],
    [0,1,1,9,9,9,1,1,0],
    [0,1,9,8,8,8,9,1,0],
    [0,1,9,9,9,9,9,1,0],
    [1,12,10,9,9,9,10,12,1],
    [0,1,10,10,10,10,10,1,0],
    [0,0,1,12,12,12,1,0,0],
    [0,1,10,10,9,10,10,1,0],
    [0,1,10,1,0,1,10,1,0],
    [1,1,0,0,0,0,0,1,1],
  ],

  // codex — scholar-warrior. Vertical lozenge visor (taller than wide), a
  // scroll/satchel roll slung across the back above the shoulders (metal-mid
  // with gold caps), a robed lower half wider than the chest, one palm out.
  ninja_codex: [
    [0,0,0,1,1,1,0,0,0],
    [0,0,1,9,9,9,1,0,0],
    [0,1,9,9,8,9,9,1,0],
    [0,1,9,9,8,9,9,1,0],
    [0,1,9,9,9,9,9,1,0],
    [1,12,10,10,10,10,10,12,1],
    [1,12,10,10,10,10,10,12,1],
    [0,1,12,9,9,9,12,1,0],
    [0,1,10,9,9,9,10,1,9],
    [1,10,10,10,10,10,10,10,1],
    [1,10,10,10,10,10,10,10,1],
    [1,10,10,1,1,1,10,10,1],
    [0,1,1,0,0,0,1,1,0],
  ],

  // gemini — twin-pair. Two narrow heads side-by-side with mirrored visor
  // slits and a faint 8-glow halo, merging into one shared torso below with a
  // central power core and gold band. Mirror-symmetric.
  ninja_gemini: [
    [0,8,8,0,0,0,8,8,0],
    [0,1,1,0,0,0,1,1,0],
    [8,9,9,8,0,8,9,9,8],
    [0,8,8,0,0,0,8,8,0],
    [0,1,1,0,0,0,1,1,0],
    [0,1,9,1,1,1,9,1,0],
    [1,9,9,9,12,9,9,9,1],
    [1,10,9,9,8,9,9,10,1],
    [1,10,10,12,12,12,10,10,1],
    [1,10,10,10,10,10,10,10,1],
    [0,1,10,10,1,10,10,1,0],
    [0,1,10,1,0,1,10,1,0],
    [0,1,1,0,0,0,1,1,0],
  ],
};

const ROBOT_METALS: Record<number, number> = {
  1: 0x23262c,  // outline
  9: 0xb9bdc6,  // metal light
  10: 0x7a8089, // metal mid
  11: 0x14161a, // metal dark / visor housing
  13: 0xffffff, // highlight
};

/** Accent cells read the LIVE palette so robots re-tint with the theme. */
function robotColor(index: number): number {
  if (index === 8) return GALACTIC.goldLt;
  if (index === 12) return GALACTIC.gold;
  return ROBOT_METALS[index] ?? 0xff00ff;
}


/**
 * Map an agent's CLI backend to its baked sprite slot. Used for the galactic
 * robot-ninja sprite lookup AND kept consistent with the backend badge glyph
 * (drawBackendBadge) so the two never disagree about which provider a bot is.
 */
export function resolveAgentSpriteSlot(
  agent: MeshAgent,
): 'claude' | 'opencode' | 'codex' | 'gemini' | 'default' {
  switch (agent.coderBackend) {
    case 'claude-code': return 'claude';
    case 'opencode': return 'opencode';
    case 'codex': return 'codex';
    case 'gemini': return 'gemini';
    // Grok Build has no baked ninja sprite yet; its run badge (GK monogram)
    // still tells it apart.
    default: return 'default';
  }
}

// Maps a backend slot to its hand-drawn ninja pattern. Slot resolution is
// shared with the backend badge via resolveAgentSpriteSlot.
const NINJA_BY_SLOT: Record<ReturnType<typeof resolveAgentSpriteSlot>, number[][]> = {
  claude: ROBOT_PATTERNS.ninja_claude,
  opencode: ROBOT_PATTERNS.ninja_opencode,
  codex: ROBOT_PATTERNS.ninja_codex,
  gemini: ROBOT_PATTERNS.ninja_gemini,
  default: ROBOT_PATTERNS.ninja_default,
};

/** Stable robot style per agent: known roles get signature bots, then the CLI
 *  backend picks its ninja silhouette, and anything unknown falls back to the
 *  neutral ninja_default house style. */
function robotPatternFor(agent: MeshAgent): number[][] {
  if (agent.agentId === 'main') return ROBOT_PATTERNS.commander;
  if (agent.agentId === 'coder') return ROBOT_PATTERNS.visor;
  // Known CLI backend → its dedicated ninja. ninja_default covers the
  // missing/unknown-backend case, so there's no hash fallthrough.
  if (agent.coderBackend) return NINJA_BY_SLOT[resolveAgentSpriteSlot(agent)];
  return ROBOT_PATTERNS.ninja_default;
}

// ════════════════════════════════════════════════════════════════
// AGENT ROOM CLASS — One room per agent
// ════════════════════════════════════════════════════════════════

/** Parse "#rrggbb" → 0xRRGGBB int (falls back to white on garbage). */
function hexToInt(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? parseInt(m[1], 16) : 0xffffff;
}

/** Blend an int color toward white by `amount` (0..1). Used to soften a
 *  saturated accent into a multiplicative sprite tint that won't muddy art. */
function lightenInt(color: number, amount: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return (lr << 16) | (lg << 8) | lb;
}

class AgentRoom {
  container: PIXI.Container;
  data: MeshAgent;
  
  private roomSprite: PIXI.Sprite | null = null;
  private carpetSprite: PIXI.Sprite | null = null;
  private deskSprite: PIXI.Sprite | null = null;
  private chairSprite: PIXI.Sprite | null = null;
  private laptopSprite: PIXI.Sprite | null = null;
  private plantSprite: PIXI.Sprite | null = null;
  private sofaSprite: PIXI.Sprite | null = null;
  
  private agentGraphics: PIXI.Graphics;
  /** Galactic-mode baked sprite (per-backend robot ninja). Lazily created on
   *  first draw; null in flat theme or until its texture has loaded. */
  private agentSprite: PIXI.Sprite | null = null;
  /** Sprite slot currently bound to agentSprite's texture, to detect changes. */
  private agentSpriteSlot: string | null = null;
  /** Whether agentSprite is currently white-tinted by the work flash. */
  private agentSpriteFlashing = false;
  /** Per-agent variant tint (Phase 1 §1) — a stable pastel wash derived from the
   *  sessionKey so same-backend siblings are visually distinct. Multiplied onto
   *  the base sprite; the work flash temporarily overrides it. 0xffffff = none. */
  private variantTint = 0xffffff;
  /** Saturated per-agent accent (variant ring/pip + name accent). */
  private variantAccent = 0xffffff;
  /** Stable 1-based variant ordinal (1..8) shown as a small badge pip. */
  private variantBadge = 0;
  /** Variant accessory pip drawn at the agent's shoulder (cheap Graphics). */
  private variantPip: PIXI.Graphics | null = null;
  private statusIndicator: PIXI.Graphics;
  private progressBar: PIXI.Graphics;
  private nameLabel: PIXI.Graphics;
  /** CLI-provider logo badge above the agent's head (claude/codex/etc). */
  private backendBadge: ProviderBadge;
  /** "Zzz" sleep glyph drawn above a resting agent parked on a concourse bed. */
  private restGlyph: PIXI.Graphics;
  /** World-level overlay root. Plates/bars/badges/markers are reparented here
   *  so one front agent can never draw over another agent's tool bubble. */
  private overlayRoot: PIXI.Container | null = null;
  private overlayLeader: PIXI.Graphics | null = null;
  /** True while this agent is resting on a concourse bed (drives the Zzz glyph).
   *  Cosmetic only — it NEVER changes the agent's size. */
  private resting = false;

  private readonly seed: number;
  private rngState: number;
  private elapsedSeconds = 0;
  // Exposed publicly so the engine's agentWorldPos() can include the agent's
  // current walked position (not just the room anchor) — keeps the published
  // FX feed in sync with the rendered sprite as agents move around the floor.
  localX = 0;
  localY = 0;
  private targetX = 0;
  private targetY = 0;
  private walkPath: PIXI.Point[] = [];
  private huddleTarget: PIXI.Point | null = null;
  // Activity-driven detour (Part 1): a local-space point the agent walks to and
  // holds (a tool sector / task board). Higher priority than huddle/idle. When
  // cleared, `returning` makes the trip home use the faster return speed.
  private toolDetour: PIXI.Point | null = null;
  private detourSpeed = TOOL_WALK_SPEED_PX;
  private returning = false;
  private idleCountdown = 0;
  private activeDriftCountdown = 0;
  private flashCountdown = AGENT_WORK_FLASH_SECONDS;
  private flashFrames = 0;
  // Live viewport zoom, pushed each frame by the owning NodeArea. Drives label
  // LOD (cull when far) + counter-scale (stay readable when close).
  private viewZoom = 1;
  // Render-space separation offset (anti-cluster). Added to visualPosition so the
  // agent + its nameplate shift together; decays back to 0 each frame.
  private sepX = 0;
  private sepY = 0;
  // Host-level label toggle (LOD/active gating is applied on top in labelActive).
  private labelsEnabled = true;
  // Last position the agent layers were drawn at — lets animate() skip the full
  // 6-layer geometry rebuild when a stationary, non-animating agent would draw
  // pixel-identical output (the dominant steady-state cost: ~70 drawRect ops ×
  // every agent × every frame). NaN forces a draw on the first frame.
  private _lastDrawX = NaN;
  private _lastDrawY = NaN;
  private _wasAnimating = true; // force a settle-redraw when motion/bob stops
  private hitRect = new PIXI.Rectangle(-20, -34, 40, 92);
  private isHovered = false;
  private roomIndex: number;
  private skipOfficeFurniture: boolean;
  // This engine's baked set — textures are bound to ONE renderer's GL context.
  private galacticTextures: GalacticTextures | null;

  // Per-agent resting/working anchors assigned by the owning NodeArea (see
  // assignStations). When set, getPosturePosition reads these instead of the
  // legacy hardcoded coords, so agents sharing a node spread across furniture.
  private workStation: Station | null = null;
  private restStation: Station | null = null;
  private standStation: Station | null = null;

  constructor(agent: MeshAgent, roomIndex: number, onClick?: (agent: MeshAgent) => void, skipOfficeFurniture = false, galacticTextures: GalacticTextures | null = null) {
    this.galacticTextures = galacticTextures;
    this.data = agent;
    this.roomIndex = roomIndex;
    this.skipOfficeFurniture = skipOfficeFurniture;
    this.seed = hashString(agent.sessionKey || agent.agentId);
    this.rngState = this.seed || 1;
    this.computeVariant();
    this.container = new PIXI.Container();
    this.container.sortableChildren = true;
    (this.container as any).interactive = true;
    (this.container as any).buttonMode = true;
    (this.container as any).hitArea = this.hitRect;
    
    // Build room
    this.buildRoom();

    const start = this.getPosturePosition();
    this.localX = start.x;
    this.localY = start.y;
    this.targetX = start.x;
    this.targetY = start.y;
    this.idleCountdown = this.nextIdleDelay();
    
    // Agent graphics
    this.agentGraphics = new PIXI.Graphics();
    this.agentGraphics.zIndex = 50;
    this.container.addChild(this.agentGraphics);
    
    // Status indicator
    this.statusIndicator = new PIXI.Graphics();
    this.statusIndicator.zIndex = 60;
    this.container.addChild(this.statusIndicator);
    
    // Progress bar
    this.progressBar = new PIXI.Graphics();
    this.progressBar.zIndex = 20;
    this.container.addChild(this.progressBar);
    
    // Name label
    this.nameLabel = new PIXI.Graphics();
    this.nameLabel.zIndex = 30;
    this.container.addChild(this.nameLabel);

    // CLI-provider logo badge (above the head; below any chat bubbles)
    this.backendBadge = new ProviderBadge();
    this.backendBadge.view.zIndex = 63;
    this.container.addChild(this.backendBadge.view);

    // Sleep "Zzz" glyph (concourse rest) — above the head, below chat bubbles.
    this.restGlyph = new PIXI.Graphics();
    this.restGlyph.zIndex = 50;
    this.restGlyph.visible = false;
    this.container.addChild(this.restGlyph);

    // Draw initial state
    this.drawAgent();
    this.drawStatusIndicator();
    this.drawProgressBar();
    this.drawNameLabel();
    this.drawBackendBadge();
    
    // Click handler
    if (onClick) {
      (this.container as any).on('pointerdown', () => onClick(this.data));
    }
    
    (this.container as any).on('pointerover', () => { this.isHovered = true; });
    (this.container as any).on('pointerout', () => { this.isHovered = false; });
  }

  /** Reparent non-body adornments into the shared world label layer. */
  mountOverlay(layer: PIXI.Container): void {
    if (this.overlayRoot) return;
    const root = new PIXI.Container();
    root.sortableChildren = true;
    const leader = new PIXI.Graphics();
    leader.zIndex = 0;
    root.addChild(leader);
    for (const child of [this.progressBar, this.nameLabel, this.backendBadge.view, this.restGlyph]) {
      child.parent?.removeChild(child);
      root.addChild(child);
    }
    layer.addChild(root);
    this.overlayRoot = root;
    this.overlayLeader = leader;
  }

  /** Overlay roots outlive the y-sorted room container, so tear them down explicitly. */
  destroyOverlay(): void {
    const root = this.overlayRoot;
    if (!root) return;
    root.parent?.removeChild(root);
    root.destroy({ children: true });
    this.overlayRoot = null;
    this.overlayLeader = null;
  }

  overlayPriority(hasToolBubble: boolean): number {
    if (hasToolBubble) return 4;
    if (this.isActive) return 3;
    if (this.resting) return 1;
    return 2;
  }

  /** Keep the detached overlay aligned with the room while nodes/rooms animate. */
  syncOverlayRoot(
    nodeX: number,
    nodeY: number,
    hasToolBubble: boolean,
    parentAlpha = 1,
    parentVisible = true,
  ): void {
    if (!this.overlayRoot) return;
    this.overlayRoot.position.set(nodeX + this.container.x, nodeY + this.container.y);
    this.overlayRoot.alpha = parentAlpha * this.container.alpha;
    this.overlayRoot.visible = parentVisible && this.container.visible;
    const priority = this.overlayPriority(hasToolBubble);
    this.overlayRoot.zIndex = (this.isHovered ? 10_000 : 0) + priority * 100;
  }

  private labelName(): string {
    const raw = this.data.label || this.data.agentId || 'AGENT';
    const maxChars = this.restingFinished ? LABEL_RESTING_MAX_CHARS : LABEL_MAX_CHARS;
    return (raw.length > maxChars ? raw.slice(0, maxChars - 1) + '…' : raw).toUpperCase();
  }

  private labelGeometry(): {
    centerX: number;
    top: number;
    bottom: number;
    width: number;
    nameX: number;
    nameY: number;
    progressX: number;
    progressY: number;
    showProgress: boolean;
  } {
    const pos = this.visualPosition();
    if (!isGalactic()) {
      const name = (this.data.label.length > 10 ? this.data.label.slice(0, 8) + '..' : this.data.label).toUpperCase();
      const nameWidth = measurePixelText(name, 1) + 8;
      const showProgress = this.data.progress > 0;
      const nameY = pos.y + 44;
      const progressY = pos.y + 34;
      return {
        centerX: pos.x,
        top: showProgress ? progressY : nameY,
        bottom: nameY + 12,
        width: Math.max(nameWidth, showProgress ? 50 : 0),
        nameX: pos.x,
        nameY,
        progressX: pos.x,
        progressY,
        showProgress,
      };
    }

    const finished = this.restingFinished;
    const name = this.labelName();
    const scale = this.labelScale() * (finished ? LABEL_RESTING_SCALE : 1);
    const width = (8 + measurePixelText(name, 1) + 12) * scale;
    const nameY = pos.y + (finished ? LABEL_RESTING_Y : LABEL_STACK_Y + this.labelStagger());
    const showProgress = !finished;
    const progressY = nameY + LABEL_H * scale + 3;
    const bottom = showProgress ? progressY + 4 * scale : nameY + LABEL_H * scale;
    return {
      centerX: pos.x,
      top: nameY,
      bottom,
      width: Math.max(width, showProgress ? 54 * scale : 0),
      nameX: pos.x,
      nameY,
      progressX: pos.x,
      progressY,
      showProgress,
    };
  }

  labelPlacementInput(
    screenX: number,
    screenY: number,
    zoom: number,
    hasToolBubble: boolean,
    previousOffset?: { x: number; y: number },
  ): LabelPlacementInput | null {
    if (!this.labelActive()) return null;
    const pos = this.visualPosition();
    const geometry = this.labelGeometry();
    const width = geometry.width * zoom;
    const height = Math.max(1, (geometry.bottom - geometry.top) * zoom);
    return {
      id: this.data.sessionKey,
      ownerId: this.data.sessionKey,
      preferred: {
        x: screenX + (geometry.centerX - pos.x) * zoom - width / 2,
        y: screenY + (geometry.top - pos.y) * zoom,
        width,
        height,
      },
      fallbackTop: screenY + 34 * zoom,
      priority: this.overlayPriority(hasToolBubble),
      previousOffset,
      allowHide: true,
    };
  }

  applyLabelPlacement(placement: OverlayPlacement | undefined, zoom: number): void {
    const active = this.labelActive();
    const hidden = !active || !placement || placement.hidden;
    this.nameLabel.visible = !hidden;
    const geometry = this.labelGeometry();
    this.progressBar.visible = !hidden && geometry.showProgress;
    const leader = this.overlayLeader;
    if (leader) leader.clear();
    if (hidden) return;

    const dx = placement.offsetX / Math.max(zoom, 0.001);
    const dy = placement.offsetY / Math.max(zoom, 0.001);
    this.nameLabel.position.set(geometry.nameX + dx, geometry.nameY + dy);
    this.progressBar.position.set(geometry.progressX + dx, geometry.progressY + dy);

    if (leader && placement.movedFar) {
      const pos = this.visualPosition();
      const labelCenterY = (geometry.top + geometry.bottom) / 2 + dy;
      const startY = labelCenterY < pos.y ? pos.y - 28 : pos.y + 18;
      const endY = labelCenterY < pos.y ? labelCenterY + (geometry.bottom - geometry.top) / 2 : labelCenterY - (geometry.bottom - geometry.top) / 2;
      leader.lineStyle(Math.max(0.6, 1 / Math.max(zoom, 0.5)), isGalactic() ? GALACTIC.gold : COLORS.textLight, 0.48);
      leader.moveTo(pos.x, startY);
      leader.lineTo(geometry.centerX + dx, endY);
      leader.lineStyle(0);
      leader.beginFill(isGalactic() ? GALACTIC.goldLt : COLORS.textLight, 0.65);
      leader.drawCircle(geometry.centerX + dx, endY, Math.max(1, 1.5 / Math.max(zoom, 0.5)));
      leader.endFill();
    }
  }
  
  private buildRoom(): void {
    if (isGalactic()) {
      // AQ hub agents render bare on the zone floor — no office pad, desk,
      // bench, or server cabinet (those make every spawn look elevated).
      if (this.skipOfficeFurniture) return;
      this.buildGalacticOffice();
      return;
    }

    const texturesLoaded = areTexturesLoaded();
    const scale = 1.2;

    // Room background (Room1 or Room2 based on index)
    const roomVariant = this.roomIndex % 2 === 0 ? 'room1' : 'room2';
    this.roomSprite = createRoomSprite(roomVariant);
    if (this.roomSprite) {
      this.roomSprite.scale.set(scale);
      this.roomSprite.anchor.set(0.5, 0.5);
      this.roomSprite.position.set(0, 0);
      this.roomSprite.zIndex = 0;
      this.container.addChild(this.roomSprite);
    } else {
      // Placeholder rectangle if texture not loaded
      const placeholder = new PIXI.Graphics();
      placeholder.beginFill(isGalactic() ? GALACTIC.glass : 0xd4b584, isGalactic() ? 0.4 : 1);
      placeholder.drawRect(-80, -60, 160, 120);
      placeholder.endFill();
      if (isGalactic()) {
        placeholder.lineStyle(1, GALACTIC.goldDp, 0.6);
        placeholder.drawRect(-80, -60, 160, 120);
        placeholder.lineStyle(0);
      }
      placeholder.zIndex = 0;
      this.container.addChild(placeholder);
    }
    
    // Carpet (color varies by room)
    const carpetColors: ('default' | 'blue' | 'green' | 'purple' | 'red')[] = ['blue', 'green', 'purple', 'red', 'default'];
    this.carpetSprite = createCarpetSprite(carpetColors[this.roomIndex % carpetColors.length]);
    if (this.carpetSprite) {
      this.carpetSprite.scale.set(scale * 0.8);
      this.carpetSprite.position.set(0, 20);
      this.carpetSprite.zIndex = 5;
      this.container.addChild(this.carpetSprite);
    }
    
    // Desk
    const deskColor = getDeskColorByIndex(this.roomIndex);
    this.deskSprite = createDeskSprite(deskColor);
    if (this.deskSprite) {
      this.deskSprite.scale.set(scale);
      this.deskSprite.position.set(-25, 15);
      this.deskSprite.zIndex = 20;
      this.container.addChild(this.deskSprite);
    }
    
    // Chair
    const chairColor = getChairColorByIndex(this.roomIndex);
    this.chairSprite = createChairSprite(chairColor);
    if (this.chairSprite) {
      this.chairSprite.scale.set(scale);
      this.chairSprite.position.set(-25, 35);
      this.chairSprite.zIndex = 15;
      this.container.addChild(this.chairSprite);
    }
    
    // Laptop on desk
    this.laptopSprite = createLaptopSprite('silver');
    if (this.laptopSprite) {
      this.laptopSprite.scale.set(scale * 0.6);
      this.laptopSprite.position.set(-30, 0);
      this.laptopSprite.zIndex = 25;
      this.container.addChild(this.laptopSprite);
    }
    
    // Plant in corner
    this.plantSprite = createPlantSprite(getPlantVariantByIndex(this.roomIndex));
    if (this.plantSprite) {
      this.plantSprite.scale.set(scale);
      this.plantSprite.position.set(50, 30);
      this.plantSprite.zIndex = 30;
      this.container.addChild(this.plantSprite);
    }
    
    // Sofa (for idle agents)
    this.sofaSprite = createSofaSprite('brown');
    if (this.sofaSprite) {
      this.sofaSprite.scale.set(scale * 0.8);
      this.sofaSprite.position.set(35, 0);
      this.sofaSprite.zIndex = 18;
      this.container.addChild(this.sofaSprite);
    }
  }

  /**
   * Compact black & gold iso office: floor pad, console desk, glass bench,
   * server obelisk. All textures pre-baked — no async loading.
   */
  private buildGalacticOffice(): void {
    const tex = this.galacticTextures ?? getGalacticTextures();
    if (!tex) {
      // Bakery not initialized yet (shouldn't happen — constructor bakes first)
      const placeholder = new PIXI.Graphics();
      placeholder.beginFill(GALACTIC.glass, 0.4);
      placeholder.drawPolygon([0, -64, 128, 0, 0, 64, -128, 0]);
      placeholder.endFill();
      placeholder.zIndex = 0;
      this.container.addChild(placeholder);
      return;
    }

    const pad = new PIXI.Sprite(tex.officePad);
    pad.anchor.set(0.5, 0.5);
    pad.position.set(0, 8);
    pad.zIndex = 0;
    this.container.addChild(pad);
    this.roomSprite = pad;

    const desk = new PIXI.Sprite(tex.desk);
    desk.anchor.set(0.5, 1);
    desk.position.set(-34, 14);
    desk.zIndex = 20;
    this.container.addChild(desk);
    this.deskSprite = desk;

    const bench = new PIXI.Sprite(tex.bench);
    bench.anchor.set(0.5, 1);
    bench.position.set(36, 30);
    bench.zIndex = 18;
    this.container.addChild(bench);
    this.sofaSprite = bench;

    // Server obelisk in the rear corner, on two of three offices for variety
    if (this.roomIndex % 3 !== 1) {
      const server = new PIXI.Sprite(tex.server);
      server.anchor.set(0.5, 1);
      server.position.set(52, -8);
      server.zIndex = 10;
      this.container.addChild(server);
      this.plantSprite = server;
    }
  }

  /**
   * Assign this agent's furniture-anchored stations (work/rest/stand). Called by
   * the owning NodeArea after placement. Passing null for any posture falls back
   * to the legacy hardcoded coords for that posture (defensive).
   */
  assignStations(work: Station | null, rest: Station | null, stand: Station | null): void {
    this.workStation = work;
    this.restStation = rest;
    this.standStation = stand;
  }

  private getPosturePosition(): { x: number; y: number } {
    const working = isWorkingStatus(this.data.status);
    const resting = this.data.status === 'idle' || this.data.status === 'completed';

    // Prefer the assigned station for the current posture so agents anchor to
    // their own furniture / cluster slot instead of all piling on one spot.
    const station = working ? this.workStation : resting ? this.restStation : this.standStation;
    if (station) return { x: station.x, y: station.y };

    // Fallback (stations unassigned — flat theme, or before NodeArea placement).
    if (isGalactic()) {
      if (working) return { x: -32, y: 4 };   // at the console desk
      if (resting) return { x: 36, y: 0 };    // on the glass bench
      return { x: 0, y: 20 };                 // standing (blocked, failed)
    }

    if (working) return { x: -25, y: 25 };    // at desk
    if (resting) return { x: 35, y: -5 };     // on sofa
    return { x: 0, y: 35 };                   // standing
  }

  /**
   * Node-local footprint rect (container position + scale applied to the base
   * hit extents). Used by NodeArea.enforceSpread for overlap detection. Uses
   * fixed extents — not the walk-mutated hitRect — so it reflects the room slot.
   */
  footprint(): PIXI.Rectangle {
    const s = this.container.scale.x;
    return new PIXI.Rectangle(
      this.container.x + ROOM_FOOTPRINT_X * s,
      this.container.y + ROOM_FOOTPRINT_Y * s,
      ROOM_FOOTPRINT_W * s,
      ROOM_FOOTPRINT_H * s,
    );
  }

  /** Nudge this room's slot along the iso-x axis (collision spread). */
  nudgeX(dx: number): void {
    this.container.x += dx;
  }

  private nextRandom(): number {
    const next = seededUnit(this.rngState);
    this.rngState = next.state;
    return next.value;
  }

  private nextIdleDelay(): number {
    return AGENT_IDLE_MIN_SECONDS + this.nextRandom() * (AGENT_IDLE_MAX_SECONDS - AGENT_IDLE_MIN_SECONDS);
  }

  private desiredTarget(): { x: number; y: number } {
    if (this.toolDetour) return this.toolDetour;   // activity detour wins (Part 1)
    if (this.huddleTarget) return this.huddleTarget;
    return { x: this.targetX, y: this.targetY };
  }

  private visualPosition(): { x: number; y: number; shadowY: number } {
    const runningBob = isWorkingStatus(this.data.status)
      ? Math.sin((this.elapsedSeconds * AGENT_WORK_BOB_HZ + (this.seed % 997) / 997) * Math.PI * 2) * AGENT_WORK_BOB_PX
      : 0;
    return { x: this.localX + this.sepX, y: this.localY + this.sepY + runningBob, shadowY: this.localY + this.sepY };
  }

  /** Push the live viewport zoom (drives nameplate LOD + counter-scale). */
  setViewZoom(z: number): void {
    if (z === this.viewZoom) return;
    this.viewZoom = z;
    this.drawBackendBadge(); // stationary agents skip redraws; keep the badge counter-scaled
  }

  /** True while this agent is actively running work (drives labels/bars/drift). */
  get isActive(): boolean { return isWorkingStatus(this.data.status); }

  /** Node-local render center (room slot + walked/bobbed/separated offset). */
  nodeLocalCenter(): { x: number; y: number } {
    const p = this.visualPosition();
    return { x: this.container.x + p.x, y: this.container.y + p.y };
  }

  /** Accumulate a render-space anti-cluster nudge (capped so it stays local). */
  applySeparation(dx: number, dy: number): void {
    const M = AGENT_SEPARATION_MAX_OFFSET;
    this.sepX = Math.max(-M, Math.min(M, this.sepX + dx));
    this.sepY = Math.max(-M, Math.min(M, this.sepY + dy));
  }

  private decaySeparation(dt: number): void {
    if (this.sepX === 0 && this.sepY === 0) return;
    const k = Math.exp(-AGENT_SEPARATION_DECAY * dt);
    this.sepX *= k; this.sepY *= k;
    if (Math.abs(this.sepX) < 0.05) this.sepX = 0;
    if (Math.abs(this.sepY) < 0.05) this.sepY = 0;
  }

  /** Whether the premium nameplate/bar should render right now: host toggle ON,
   *  agent actively running (not idle/resting concourse extra), zoomed in enough. */
  private labelActive(): boolean {
    if (!this.labelsEnabled) return false;
    if (!isGalactic()) {
      // Cozy mode historically shows every plate. Preserve that at useful zooms,
      // but collapse low-priority idle/resting labels first in the far LOD.
      const minZoom = this.isActive ? 0.38 : this.resting ? 0.68 : 0.55;
      return this.viewZoom >= minZoom;
    }
    if (this.isActive && !this.resting) return this.viewZoom >= LABEL_MIN_ZOOM;
    // Finished runs resting on a bed keep their compact plate at mid/close zoom.
    return this.restingFinished && this.viewZoom >= 0.72;
  }

  /** Counter-scale so the plate reads at a glance across the zoom range. */
  private labelScale(): number {
    return Math.min(Math.max(1 / this.viewZoom, LABEL_MIN_SCALE), LABEL_MAX_SCALE);
  }

  /** Deterministic per-agent vertical stagger: alternating agents drop their
   *  plate one row lower so neighbours in the same iso-row don't collide. */
  private labelStagger(): number {
    return (this.seed % 2) ? (LABEL_H + 5) : 0;
  }

  private updateHitArea(): void {
    const pos = this.visualPosition();
    this.hitRect.x = pos.x - 22;
    this.hitRect.y = pos.y - 34;
    this.hitRect.width = 44;
    this.hitRect.height = 92;
  }
  
  private drawAgent(): void {
    const g = this.agentGraphics;
    g.clear();

    const galactic = isGalactic();
    const pos = this.visualPosition();

    // Galactic mode: optionally prefer the baked per-backend PNG sprite. Gated
    // off by default (USE_GENERATED_SPRITES) — the hand-drawn pixel ninja
    // patterns below are the house style. Falls through to the pixel pattern
    // when its texture isn't loaded yet.
    if (galactic && USE_GENERATED_SPRITES && this.tryDrawAgentSprite(pos)) {
      // Soft contact shadow under the sprite's feet.
      g.beginFill(COLORS.shadow, 0.22);
      g.drawEllipse(pos.x, pos.shadowY + 12, 13, 4);
      g.endFill();
      this.updateHitArea();
      return;
    }
    // Sprite not active — make sure any previously-shown sprite is hidden so it
    // doesn't double-render over the pixel pattern (e.g. theme/backend switch).
    if (this.agentSprite) this.agentSprite.visible = false;
    if (this.variantPip) this.variantPip.visible = false;

    const pattern = galactic
      ? robotPatternFor(this.data)
      : AGENT_PATTERNS[this.data.agentId] || AGENT_PATTERNS.default;
    const pixelSize = 3;
    const offsetX = pos.x - (pattern[0].length * pixelSize) / 2;
    const offsetY = pos.y - (pattern.length * pixelSize) / 2;

    // Draw shadow (hover drones float higher, cast a tighter shadow)
    const hovers = galactic && pattern === ROBOT_PATTERNS.drone;
    g.beginFill(COLORS.shadow, 0.2);
    g.drawEllipse(pos.x, pos.shadowY + 12, hovers ? 8 : 12, hovers ? 3 : 4);
    g.endFill();

    // Draw character
    for (let y = 0; y < pattern.length; y++) {
      for (let x = 0; x < pattern[y].length; x++) {
        const colorIndex = pattern[y][x];
        if (colorIndex === 0) continue;
        const flashAccent = galactic && this.flashFrames > 0 && (colorIndex === 8 || colorIndex === 12);
        const color = flashAccent ? 0xffffff : galactic ? robotColor(colorIndex) : SPRITE_PALETTE[colorIndex] || 0xff00ff;
        g.beginFill(color);
        g.drawRect(offsetX + x * pixelSize, offsetY + y * pixelSize - (hovers ? 4 : 0), pixelSize, pixelSize);
        g.endFill();
      }
    }
    this.updateHitArea();
  }

  /** Sprite stands 64px tall in world space (before viewport zoom). */
  private static readonly SPRITE_HEIGHT_PX = 64;

  /**
   * Galactic-mode sprite render. Lazily creates a PIXI.Sprite, swaps its texture
   * when the backend changes, positions it at the agent's feet, and applies the
   * work-flash tint. Returns false (and draws nothing) when the resolved
   * backend's texture hasn't loaded — caller then renders the pixel fallback.
   */
  private tryDrawAgentSprite(pos: { x: number; y: number }): boolean {
    const slot = resolveAgentSpriteSlot(this.data);
    const textures = getAgentSpriteTextures();
    const texture = textures[slot];
    if (!texture || !texture.valid) return false;

    if (!this.agentSprite) {
      this.agentSprite = new PIXI.Sprite(texture);
      this.agentSprite.anchor.set(0.5, 1); // stand on the position point
      this.agentSprite.zIndex = 50;
      this.container.addChild(this.agentSprite);
    }
    const sprite = this.agentSprite;
    if (this.agentSpriteSlot !== slot) {
      sprite.texture = texture;
      this.agentSpriteSlot = slot;
    }
    sprite.visible = true;

    // Scale so the rendered sprite is ~64px tall regardless of source size.
    const scale = AgentRoom.SPRITE_HEIGHT_PX / texture.height;
    sprite.scale.set(scale);
    sprite.position.set(pos.x, pos.y + 16); // feet a touch below the anchor point

    // Work-flash accent over the per-agent variant wash. PIXI tint multiplies,
    // so the resting tint is the variant pastel (per sessionKey) and the flash
    // pops to warm gold. Re-applied whenever the flash state OR variant changes.
    const flashing = this.flashFrames > 0;
    const restTint = this.variantTint;
    if (flashing !== this.agentSpriteFlashing || sprite.tint !== (flashing ? 0xfff0c0 : restTint)) {
      sprite.tint = flashing ? 0xfff0c0 : restTint;
      this.agentSpriteFlashing = flashing;
    }
    this.drawVariantPip(pos);
    return true;
  }

  /** Compute the stable per-agent variant (Phase 1 §1) from the sessionKey. The
   *  hue is independent of backend (variantForRun keys on the run id), while the
   *  accent mixes the backend's base color so identity + individuality coexist. */
  private computeVariant(): void {
    const key = this.data.sessionKey || this.data.agentId || "";
    const kind = normalizeAgentKind(this.data.coderBackend ?? key);
    const v = variantForRun(key);
    this.variantBadge = (v.index % 8) + 1;
    this.variantAccent = hexToInt(accentForVariant(kind, key));
    this.variantTint = lightenInt(this.variantAccent, 0.62);
  }

  /** A small saturated accent pip at the agent's shoulder — the cheap "accessory"
   *  marker that makes same-tint agents distinguishable at a glance. Reuses one
   *  Graphics per agent; redrawn in place (no per-frame allocation). */
  private drawVariantPip(pos: { x: number; y: number }): void {
    if (!this.variantPip) {
      this.variantPip = new PIXI.Graphics();
      this.variantPip.zIndex = 58; // above the sprite (50), below status (60)
      this.container.addChild(this.variantPip);
    }
    const g = this.variantPip;
    g.clear();
    // Position at the upper-right "shoulder" of the ~64px sprite.
    const px = pos.x + 9;
    const py = pos.y - 30;
    g.lineStyle(1.2, 0x0b0d14, 0.9);
    g.beginFill(this.variantAccent, 1);
    g.drawCircle(px, py, 3.4);
    g.endFill();
    g.visible = true;
  }
  
  private drawStatusIndicator(): void {
    const g = this.statusIndicator;
    g.clear();
    const color = STATUS_COLORS[this.data.status] || STATUS_COLORS.idle;
    const pos = this.visualPosition();
    
    // Status dot above head
    g.beginFill(color);
    g.drawRect(pos.x - 3, pos.y - 25, 6, 6);
    g.endFill();
    
    // Glow
    g.beginFill(color, 0.3);
    g.drawRect(pos.x - 8, pos.y - 28, 16, 12);
    g.endFill();
  }
  
  private drawProgressBar(): void {
    const g = this.progressBar;
    g.clear();
    g.scale.set(1);
    g.position.set(0, 0);

    // Cozy/flat theme keeps the legacy inline bar (progress > 0 only).
    if (!isGalactic()) {
      if (!this.labelActive() || this.data.progress <= 0) { g.visible = false; return; }
      g.visible = true;
      const barWidth = 50, barHeight = 6;
      const pos = this.visualPosition();
      const x = -barWidth / 2;
      g.position.set(pos.x, pos.y + 34);
      g.beginFill(COLORS.white); g.drawRect(x, 0, barWidth, barHeight); g.endFill();
      g.lineStyle(1, COLORS.textLight); g.drawRect(x, 0, barWidth, barHeight); g.lineStyle(0);
      const fillColor = this.data.progress >= 80 ? 0x22c55e : COLORS.gold;
      g.beginFill(fillColor);
      g.drawRect(x + 1, 1, (this.data.progress / 100) * (barWidth - 2), barHeight - 2);
      g.endFill();
      return;
    }

    // Galactic: a thin premium bar attached under the nameplate. Only for live
    // agents (paired with the plate). Determinate fill when we have numeric
    // progress; otherwise an indeterminate gold shimmer that reads as "working".
    if (!this.labelActive() || this.restingFinished) { g.visible = false; return; }
    g.visible = true;
    const pos = this.visualPosition();
    const s = this.labelScale();
    const barWidth = 54, barHeight = 4, r = 2;
    const nameY = pos.y + LABEL_STACK_Y + this.labelStagger();
    g.position.set(pos.x, nameY + LABEL_H * s + 3);
    g.scale.set(s);
    const left = -barWidth / 2;
    // Track
    g.beginFill(GALACTIC.glass, 0.92); g.drawRoundedRect(left, 0, barWidth, barHeight, r); g.endFill();
    g.lineStyle(1, GALACTIC.goldDp, 0.45); g.drawRoundedRect(left, 0, barWidth, barHeight, r); g.lineStyle(0);

    const p = this.data.progress;
    if (p > 0) {
      const w = Math.max(2, (Math.min(100, p) / 100) * (barWidth - 2));
      const fill = p >= 90 ? 0x22c55e : GALACTIC.goldLt;
      g.beginFill(fill); g.drawRoundedRect(left + 1, 1, w, barHeight - 2, 1.5); g.endFill();
      g.beginFill(0xffffff, 0.25); g.drawRoundedRect(left + 1, 1, w, 1, 1); g.endFill();
    } else {
      // Indeterminate sweep: a gold segment travelling across the track.
      const segW = barWidth * 0.36;
      const t = (this.elapsedSeconds * 0.9 + (this.seed % 100) / 100) % 1;
      const travel = (barWidth - 2 + segW) * t - segW;
      const sx = Math.max(left + 1, left + 1 + travel);
      const ex = Math.min(left + barWidth - 1, left + 1 + travel + segW);
      if (ex > sx) { g.beginFill(GALACTIC.goldLt, 0.9); g.drawRoundedRect(sx, 1, ex - sx, barHeight - 2, 1.5); g.endFill(); }
    }
  }

  private drawNameLabel(): void {
    const g = this.nameLabel;
    g.clear();
    g.scale.set(1);
    g.position.set(0, 0);

    // Cozy/flat theme keeps the legacy plate, with the same far-zoom LOD used
    // by the shared placement pass.
    if (!isGalactic()) {
      if (!this.labelActive()) { g.visible = false; return; }
      g.visible = true;
      const name = (this.data.label.length > 10 ? this.data.label.slice(0, 8) + '..' : this.data.label).toUpperCase();
      const width = measurePixelText(name, 1);
      const pos = this.visualPosition();
      const x = -width / 2;
      g.position.set(pos.x, pos.y + 44);
      g.beginFill(COLORS.white, 0.9); g.drawRect(x - 4, 0, width + 8, 12); g.endFill();
      drawPixelText(g, name, x, 2, COLORS.text, 1);
      return;
    }

    // Galactic premium nameplate — only for live/active agents, LOD-culled far.
    if (!this.labelActive()) { g.visible = false; return; }
    g.visible = true;

    const finished = this.restingFinished;
    const name = this.labelName();
    const pos = this.visualPosition();
    const s = this.labelScale() * (finished ? LABEL_RESTING_SCALE : 1);
    const dotW = 8;
    const padX = 6;
    const textW = measurePixelText(name, 1);
    const w = dotW + textW + padX * 2;
    const h = LABEL_H;
    const left = -w / 2;

    // Anchor the pill's own origin under the agent (staggered), then counter-scale.
    g.position.set(pos.x, pos.y + (finished ? LABEL_RESTING_Y : LABEL_STACK_Y + this.labelStagger()));
    g.scale.set(s);

    // Drop shadow (soft, offset down).
    g.beginFill(0x000000, 0.38); g.drawRoundedRect(left + 1, 3, w, h, 5); g.endFill();
    // Obsidian pill.
    g.beginFill(GALACTIC.panel, 0.96); g.drawRoundedRect(left, 0, w, h, 5); g.endFill();
    // Gold hairline border.
    g.lineStyle(1, GALACTIC.gold, 0.7); g.drawRoundedRect(left, 0, w, h, 5); g.lineStyle(0);
    // Top gloss.
    g.beginFill(GALACTIC.goldLt, 0.10); g.drawRoundedRect(left + 1, 1, w - 2, h / 2 - 1, 4); g.endFill();
    // Status dot (glow + core).
    const dotColor = STATUS_COLORS[this.data.status] ?? GALACTIC.goldLt;
    g.beginFill(dotColor, 0.3); g.drawCircle(left + padX + 2, h / 2, 4); g.endFill();
    g.beginFill(dotColor); g.drawCircle(left + padX + 2, h / 2, 2.2); g.endFill();
    // Name text.
    drawPixelText(g, name, left + padX + dotW, (h - 5) / 2, GALACTIC.goldLt, 1);
  }
  
  update(data: Partial<MeshAgent>): void {
    if (data.label !== undefined) { this.data.label = data.label; this.drawNameLabel(); }
    if (data.nodeId !== undefined) this.data.nodeId = data.nodeId;
    if (data.status !== undefined) {
      this.data.status = data.status;
      if (!isIdleStatus(data.status) && !this.huddleTarget && this.walkPath.length === 0) {
        const target = this.getPosturePosition();
        this.targetX = target.x;
        this.targetY = target.y;
      }
      this.drawStatusIndicator();
      this.drawAgent();
      // Status gates the premium nameplate/bar (running-only) — refresh both so
      // visibility flips immediately on complete/idle rather than next redraw.
      this.drawNameLabel();
      this.drawProgressBar();
    }
    if (data.progress !== undefined) { this.data.progress = data.progress; this.drawProgressBar(); }
    if (data.currentTask !== undefined) this.data.currentTask = data.currentTask;
    if (data.parent !== undefined) this.data.parent = data.parent;
    if (data.children !== undefined) this.data.children = data.children;
    if (data.coderBackend !== undefined) { this.data.coderBackend = data.coderBackend; this.computeVariant(); this.drawBackendBadge(); }
  }

  setLabelsVisible(visible: boolean): void {
    // Host-level request only. Final visibility is derived in labelActive()
    // (also gates on running-state + zoom LOD) and applied on the next draw.
    this.labelsEnabled = visible;
    if (!visible) { this.nameLabel.visible = false; this.progressBar.visible = false; }
  }

  setRoomIndex(index: number): void {
    this.roomIndex = index;
  }

  setHuddleTarget(target: PIXI.Point | null): void {
    this.huddleTarget = target;
    if (!target && this.walkPath.length === 0) {
      const posture = this.getPosturePosition();
      this.targetX = posture.x;
      this.targetY = posture.y;
    }
  }

  /**
   * Activity-driven detour (Part 1). Walk to `point` (local space, relative to
   * this room's container) and hold there until clearRoute(). Overrides idle
   * wander + huddle while active. The host (ActivityMap) computes the point
   * from a sector center and schedules the return.
   */
  routeToLocal(point: PIXI.Point, speed: number = TOOL_WALK_SPEED_PX): void {
    this.toolDetour = point;
    this.detourSpeed = speed;
    this.returning = false;
    this.idleCountdown = this.nextIdleDelay();
  }

  /** End a detour and walk home (posture slot) at the faster return speed. */
  clearRoute(): void {
    if (!this.toolDetour && !this.returning) return;
    this.toolDetour = null;
    this.returning = true;
    const posture = this.getPosturePosition();
    this.targetX = posture.x;
    this.targetY = posture.y;
  }

  /** True while detoured to / dwelling at an activity sector. */
  get isRouted(): boolean {
    return this.toolDetour !== null;
  }

  /** True while the sprite is actually moving (walking a path or still short
   *  of its detour point) — false once it has arrived and is dwelling. */
  get isWalking(): boolean {
    if (this.walkPath.length > 0) return true;
    if (this.toolDetour) return Math.hypot(this.toolDetour.x - this.localX, this.toolDetour.y - this.localY) > 2;
    return this.returning;
  }

  beginWalk(localPath: PIXI.Point[]): void {
    if (localPath.length === 0) return;
    const [start, ...rest] = localPath;
    this.localX = start.x;
    this.localY = start.y;
    this.walkPath = rest;
    this.idleCountdown = this.nextIdleDelay();
    this.drawAllAgentLayers();
  }

  getWorldAgentPosition(nodeX: number, nodeY: number): PIXI.Point {
    return new PIXI.Point(nodeX + this.container.x + this.localX, nodeY + this.container.y + this.localY);
  }

  getWorldVisualPosition(nodeX: number, nodeY: number): PIXI.Point {
    const pos = this.visualPosition();
    return new PIXI.Point(nodeX + this.container.x + pos.x, nodeY + this.container.y + pos.y);
  }

  getWorldTargetPosition(nodeX: number, nodeY: number): PIXI.Point {
    const target = this.desiredTarget();
    return new PIXI.Point(nodeX + this.container.x + target.x, nodeY + this.container.y + target.y);
  }

  get huddleSortKey(): number {
    return this.seed;
  }

  private moveToward(target: { x: number; y: number }, speed: number, dt: number): boolean {
    const dx = target.x - this.localX;
    const dy = target.y - this.localY;
    const dist = Math.hypot(dx, dy);
    const step = speed * dt;
    if (dist <= step + 0.25) {
      this.localX = target.x;
      this.localY = target.y;
      return true;
    }
    this.localX += (dx / dist) * step;
    this.localY += (dy / dist) * step;
    return false;
  }

  private updateIdleTarget(dt: number): void {
    if (!isIdleStatus(this.data.status) || this.walkPath.length > 0 || this.huddleTarget || this.toolDetour || this.returning) return;
    this.idleCountdown -= dt;
    if (this.idleCountdown > 0) return;

    const posture = this.getPosturePosition();
    const angle = this.nextRandom() * Math.PI * 2;
    const radius = Math.sqrt(this.nextRandom());
    this.targetX = posture.x + Math.cos(angle) * AGENT_IDLE_RADIUS_X * radius;
    this.targetY = posture.y + Math.sin(angle) * AGENT_IDLE_RADIUS_Y * radius;
    this.idleCountdown = this.nextIdleDelay();
  }

  /** Subtle "between tool calls" wander for a RUNNING agent so it breathes at
   *  its station instead of freezing solid while a long call is in flight. Small
   *  radius around the posture slot; the existing moveToward easing tweens it. */
  private updateActiveDrift(dt: number): void {
    if (!isWorkingStatus(this.data.status)) return;
    if (this.walkPath.length > 0 || this.huddleTarget || this.toolDetour || this.returning) return;
    this.activeDriftCountdown -= dt;
    if (this.activeDriftCountdown > 0) return;
    const posture = this.getPosturePosition();
    const angle = this.nextRandom() * Math.PI * 2;
    const radius = Math.sqrt(this.nextRandom());
    this.targetX = posture.x + Math.cos(angle) * AGENT_ACTIVE_DRIFT_RADIUS_X * radius;
    this.targetY = posture.y + Math.sin(angle) * AGENT_ACTIVE_DRIFT_RADIUS_Y * radius;
    this.activeDriftCountdown =
      AGENT_ACTIVE_DRIFT_MIN_SECONDS + this.nextRandom() * (AGENT_ACTIVE_DRIFT_MAX_SECONDS - AGENT_ACTIVE_DRIFT_MIN_SECONDS);
  }

  private updateWorkingFlash(dt: number): void {
    if (!isWorkingStatus(this.data.status)) {
      this.flashFrames = 0;
      this.flashCountdown = AGENT_WORK_FLASH_SECONDS;
      return;
    }
    this.flashCountdown -= dt;
    if (this.flashCountdown <= 0) {
      this.flashFrames = 1;
      this.flashCountdown = AGENT_WORK_FLASH_SECONDS + this.nextRandom() * 0.2;
    } else if (this.flashFrames > 0) {
      this.flashFrames--;
    }
  }

  private drawAllAgentLayers(): void {
    this.drawAgent();
    this.drawStatusIndicator();
    this.drawProgressBar();
    this.drawNameLabel();
    this.drawBackendBadge();
    this.drawRestGlyph();
  }

  /** True while the agent is parked on a concourse bed. */
  get isResting(): boolean {
    return this.resting;
  }

  /** Parked on a bed AND finished (completed / failed) — dimmed + ✓ / ✕ marker. */
  get restingFinished(): boolean {
    return this.resting && isFinishedStatus(this.data.status);
  }

  /** Toggle the resting (sleeping-on-a-bed) cosmetic state. Size is untouched. */
  setResting(on: boolean): void {
    if (this.resting === on) return;
    this.resting = on;
    this.restGlyph.visible = on;
    if (!on) { this.restGlyph.clear(); this.setBodyAlpha(1); }
  }

  /** Dim the character body (pixel pattern and baked sprite), not its plate / marker. */
  private setBodyAlpha(a: number): void {
    this.agentGraphics.alpha = a;
    if (this.agentSprite) this.agentSprite.alpha = a;
  }

  /**
   * While parked on a bed, depth-sort by where the agent actually is (its bed)
   * rather than its home slot, so an agent on a bed in front draws over — and
   * its plate isn't covered by — the agent on the bed behind it.
   */
  private syncRestingDepth(): void {
    if (!this.resting) return;
    const z = 10 + Math.round(this.container.y + this.localY);
    if (this.container.zIndex !== z) this.container.zIndex = z;
  }

  /**
   * The room container was re-placed (NodeArea relayout) so a held detour's
   * local point is stale. Shift the detour AND the agent's walked position by
   * the same delta — the sprite stays put in world space and keeps its bed.
   */
  retargetDetour(point: PIXI.Point): void {
    const d = this.toolDetour;
    if (!d) return;
    const dx = point.x - d.x, dy = point.y - d.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    this.toolDetour = point;
    this.localX += dx; this.localY += dy;
    this.targetX += dx; this.targetY += dy;
    this.walkPath = [];
  }

  /** Jump straight onto a local point and hold (restored resting agents). */
  snapToLocal(point: PIXI.Point): void {
    this.routeToLocal(point, REST_WALK_SPEED_PX);
    this.localX = this.targetX = point.x;
    this.localY = this.targetY = point.y;
    this.returning = false;
  }

  /**
   * Floating "Zzz" sleep glyph above a resting agent. Purely cosmetic: it bobs
   * on its own and gently breathes alpha — it does NOT scale the agent. Anchored
   * to the live agent position so it follows the sprite onto the bed.
   */
  private drawRestGlyph(): void {
    const g = this.restGlyph;
    if (!this.resting) { if (g.visible) g.visible = false; return; }
    g.visible = true;
    g.clear();
    const pos = this.visualPosition();
    const t = this.elapsedSeconds;
    if (isFinishedStatus(this.data.status)) {
      this.setBodyAlpha(0.6); // dimmed: done for the day
      this.drawFinishedMark(g, pos.x + 12, pos.y - 30, this.data.status === 'failed');
      return;
    }
    this.setBodyAlpha(1);
    const breathe = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.2));
    const color = isGalactic() ? GALACTIC.goldLt : 0x9fd0ff;
    // Three rising Z's of increasing size, drifting up-right and fading.
    const sizes = [1, 1.5, 2];
    sizes.forEach((s, i) => {
      const rise = ((t * 14 + i * 16) % 36);            // continuous upward drift
      const x = pos.x + 8 + i * 7 + Math.sin((t + i) * 1.6) * 2;
      const y = pos.y - 30 - rise - i * 4;
      const a = breathe * Math.max(0, 1 - rise / 36);   // fade as it rises
      this.drawZ(g, x, y, 4 * s, color, a);
    });
  }

  /** ✓ (done, green) / ✕ (failed, red) disc floating above a finished resting agent. */
  private drawFinishedMark(g: PIXI.Graphics, x: number, y: number, failed: boolean): void {
    const color = failed ? STATUS_COLORS.failed : STATUS_COLORS.completed;
    const r = 5.5;
    g.beginFill(0x000000, 0.45); g.drawCircle(x + 0.6, y + 1, r + 1.2); g.endFill();
    g.beginFill(color, 0.95); g.drawCircle(x, y, r); g.endFill();
    g.lineStyle(1, 0xffffff, 0.55); g.drawCircle(x, y, r); g.lineStyle(0);
    g.lineStyle(1.8, 0xffffff, 1);
    if (failed) {
      g.moveTo(x - 2.4, y - 2.4); g.lineTo(x + 2.4, y + 2.4);
      g.moveTo(x + 2.4, y - 2.4); g.lineTo(x - 2.4, y + 2.4);
    } else {
      g.moveTo(x - 2.8, y + 0.2); g.lineTo(x - 0.8, y + 2.3); g.lineTo(x + 2.9, y - 2.3);
    }
    g.lineStyle(0);
  }

  /** Draw a single pixel-styled "Z" at (x,y) with the given half-size + alpha. */
  private drawZ(g: PIXI.Graphics, x: number, y: number, r: number, color: number, alpha: number): void {
    g.lineStyle(Math.max(1, r * 0.45), color, alpha);
    g.moveTo(x - r, y - r);
    g.lineTo(x + r, y - r);
    g.lineTo(x - r, y + r);
    g.lineTo(x + r, y + r);
    g.lineStyle(0);
  }

  /**
   * Provider logo badge (Claude / Codex / Gemini / OpenCode, InfiniBot when
   * unset) above the agent's head — see provider-logos.ts. Anchored at the
   * live sprite position and counter-scaled like the nameplate. While resting
   * it shifts left so it never covers the ✓ / ✕ marker or the Zzz glyph.
   */
  private drawBackendBadge(): void {
    const badge = this.backendBadge;
    badge.setBackend(this.data.coderBackend);
    const pos = this.visualPosition();
    const s = this.labelScale();
    const resting = this.resting;
    badge.layout({
      x: pos.x + (resting ? -13 : 0),
      y: pos.y + (resting ? -31 : -41),
      scale: resting ? s * 0.8 : s,
      viewZoom: this.viewZoom,
    });
  }

  /** Patch the backend logo at runtime (bridge learns the CLI mid-run). */
  setCoderBackend(backend: MeshAgent['coderBackend']): void {
    if (this.data.coderBackend === backend) return;
    this.data.coderBackend = backend;
    this.computeVariant();
    this.drawBackendBadge();
  }
  
  animate(dt: number): void {
    this.elapsedSeconds += dt;
    this.decaySeparation(dt);
    this.updateIdleTarget(dt);
    this.updateActiveDrift(dt);
    this.updateWorkingFlash(dt);

    if (this.walkPath.length > 0) {
      if (this.moveToward(this.walkPath[0], AGENT_WALK_SPEED_PX, dt)) this.walkPath.shift();
    } else {
      const target = this.desiredTarget();
      // Activity detour walks at its own (tunable) speed; a return trip uses the
      // faster return speed until it lands back at the posture slot.
      const speed = this.toolDetour
        ? this.detourSpeed
        : this.returning
          ? TOOL_RETURN_SPEED_PX
          : this.huddleTarget
            ? AGENT_WALK_SPEED_PX
            : AGENT_IDLE_SPEED_PX;
      const arrived = this.moveToward(target, speed, dt);
      if (this.returning && arrived) this.returning = false;
    }

    // Steady-state fast path: a stationary agent that isn't working (no bob),
    // flashing, or resting (no Zzz) renders byte-identical layers frame to
    // frame. Skip the full geometry rebuild in that case. >0.05px motion or any
    // animating state forces the redraw, so visuals are unchanged.
    this.syncRestingDepth();
    const animating =
      isWorkingStatus(this.data.status) || this.flashFrames > 0 || this.resting;
    const moved =
      !(Math.abs(this.localX - this._lastDrawX) < 0.05 &&
        Math.abs(this.localY - this._lastDrawY) < 0.05);
    // `_wasAnimating` guarantees one final redraw the frame motion stops, so the
    // bob/flash settles to its rest pose instead of freezing mid-animation.
    if (animating || moved || this._wasAnimating) {
      this.drawAllAgentLayers();
      this._lastDrawX = this.localX;
      this._lastDrawY = this.localY;
    }
    this._wasAnimating = animating;
  }
  
  /** Local-space point just above the agent's head, where tool bubbles anchor. */
  getBubbleAnchor(): { x: number; y: number } {
    const pos = this.visualPosition();
    return { x: pos.x, y: pos.y - 26 };
  }

  getTooltipLines(): string[] {
    return [
      `AGENT: ${this.data.agentId.toUpperCase()}`,
      `STATUS: ${this.data.status.toUpperCase()}`,
      `PROGRESS: ${this.data.progress}%`,
      this.data.currentTask ? `TASK: ${this.data.currentTask.slice(0, 25).toUpperCase()}` : '',
    ].filter(Boolean);
  }
  
  /**
   * Rebuild room with textures after they've loaded
   */
  rebuildWithTextures(): void {
    if (!areTexturesLoaded()) return;
    
    // Remove existing room elements (but keep agent graphics, status, etc.)
    const childrenToRemove: PIXI.DisplayObject[] = [];
    this.container.children.forEach(child => {
      if (child !== this.agentGraphics &&
          child !== this.agentSprite &&
          child !== this.statusIndicator &&
          child !== this.progressBar &&
          child !== this.nameLabel &&
          child !== this.backendBadge.view &&
          child !== this.restGlyph) {
        childrenToRemove.push(child);
      }
    });
    childrenToRemove.forEach(child => this.container.removeChild(child));
    
    // Clear sprite references
    this.roomSprite = null;
    this.carpetSprite = null;
    this.deskSprite = null;
    this.chairSprite = null;
    this.laptopSprite = null;
    this.plantSprite = null;
    this.sofaSprite = null;
    
    // Rebuild room with actual textures
    this.buildRoom();
    
    // Re-add the graphics at the right z-index
    this.container.addChild(this.agentGraphics);
    if (this.agentSprite) this.container.addChild(this.agentSprite);
    this.container.addChild(this.statusIndicator);
    // Overlay adornments stay in the shared label layer once mounted. Before
    // mount (constructor-only path), keep the legacy parent until mountOverlay.
    if (!this.overlayRoot) {
      this.container.addChild(this.progressBar);
      this.container.addChild(this.nameLabel);
      this.container.addChild(this.backendBadge.view);
      this.container.addChild(this.restGlyph);
    }

    // Force redraw
    this.drawAgent();
    this.drawBackendBadge();
  }
}

// ════════════════════════════════════════════════════════════════
// NODE AREA CLASS — Collection of agent rooms for a node
// ════════════════════════════════════════════════════════════════

class NodeArea {
  container: PIXI.Container;
  data: MeshNode;
  rooms: Map<string, AgentRoom> = new Map();

  private bgGraphics: PIXI.Graphics;
  private labelGraphics: PIXI.Graphics;
  private statusGraphics: PIXI.Graphics;
  private isHovered = false;
  private labelAlpha = GALACTIC_LABEL_IDLE_ALPHA;
  private targetLabelAlpha = GALACTIC_LABEL_IDLE_ALPHA;
  private touchPointers = new Set<string>();
  private touchOutTimer: ReturnType<typeof setTimeout> | null = null;

  // Galactic layout: office slot offsets (local space) + plaque position
  private galacticSlots: PIXI.Point[] | null = null;
  // Furniture-anchored station pools for pod nodes (null in AQ hub / flat mode).
  // Pre-computed once on setGalacticLayout; agents cycle through them by index.
  private stationPools: { work: { x: number; y: number }[]; rest: { x: number; y: number }[]; stand: { x: number; y: number }[] } | null = null;
  private galacticLabelX = 0;
  private galacticLabelY = -40;
  private plaque: PIXI.Container | null = null;
  private plaqueCount: PIXI.Text | null = null;
  private plaqueLamp: PIXI.Graphics | null = null;

  constructor(node: MeshNode, onClick?: (node: MeshNode) => void) {
    this.data = node;
    this.container = new PIXI.Container();
    this.container.sortableChildren = true;
    (this.container as any).interactive = true;
    (this.container as any).buttonMode = true;
    
    // Background
    this.bgGraphics = new PIXI.Graphics();
    this.bgGraphics.zIndex = 0;
    this.container.addChild(this.bgGraphics);
    
    // Label
    this.labelGraphics = new PIXI.Graphics();
    this.labelGraphics.zIndex = 100;
    this.container.addChild(this.labelGraphics);
    
    // Status indicator
    this.statusGraphics = new PIXI.Graphics();
    this.statusGraphics.zIndex = 101;
    this.container.addChild(this.statusGraphics);
    
    this.drawBackground();
    this.drawLabel();
    this.drawStatus();
    
    (this.container as any).on('pointerdown', (event: unknown) => {
      this.handleTouchHoverStart(event);
      onClick?.(node);
    });
    
    (this.container as any).on('pointerover', () => {
      this.isHovered = true;
      this.setLabelHover(true);
    });
    (this.container as any).on('pointerout', () => {
      this.isHovered = false;
      if (this.touchPointers.size === 0) this.setLabelHover(false);
    });
    const releaseTouchHover = (event: unknown) => this.handleTouchHoverEnd(event);
    (this.container as any).on('pointerup', releaseTouchHover);
    (this.container as any).on('pointerupoutside', releaseTouchHover);
    (this.container as any).on('pointercancel', releaseTouchHover);
  }
  
  /**
   * Galactic mode: assign office slot offsets (relative to this container)
   * and the plaque height, plus an optional pod platform underneath.
   */
  /** When true, AgentRoom skips its office-pad/desk/bench/server furniture and
   *  renders just the agent sprite. Used for the Agent Quarters hub so agents
   *  appear directly on the AQ floor without an elevated cabinet block. */
  isAgentQuartersHub = false;
  /** Owning engine's baked galactic textures (set right after construction). */
  galacticTextures: GalacticTextures | null = null;
  /** Last node-level label visibility request (from setLabelsVisible). Lets the
   *  AQ spread layout keep per-agent labels hidden when a quarter is crowded
   *  even after a global show-labels toggle re-runs. */
  private nodeLabelsVisible = true;

  setGalacticLayout(slots: PIXI.Point[], labelX: number, labelY: number, podPlatform?: PIXI.Container, isAgentQuartersHub = false): void {
    this.galacticSlots = slots;
    this.galacticLabelX = labelX;
    this.galacticLabelY = labelY;
    this.isAgentQuartersHub = isAgentQuartersHub;
    // Pod/satellite nodes anchor agents to office furniture; the AQ hub has no
    // furniture and instead clusters agents inside their grid cell (handled in
    // assignRoomStations), so it gets no pool.
    this.stationPools = isAgentQuartersHub
      ? null
      : {
          work: [POD_DESK_STATION, POD_SERVER_STATION],
          rest: [POD_BENCH_STATION],
          stand: [POD_PAD_STATION],
        };
    // Re-derive stations for any already-placed rooms under the new layout.
    this.relayoutRooms();
    if (podPlatform) {
      // Far below any office: room zIndex is 10 + local y, which goes negative
      // for slots above the pod center
      podPlatform.zIndex = -100000;
      this.container.addChild(podPlatform);
    }
    this.buildPlaque();
    this.drawBackground();
    this.drawLabel();
    this.drawStatus();
  }

  /** Crisp text plaque (galactic): name + agent count + status lamp. */
  private buildPlaque(): void {
    if (this.plaque) {
      this.container.removeChild(this.plaque);
      this.plaque.destroy({ children: true });
    }
    const title = makeText(this.data.name.toUpperCase(), { size: 12 });
    const count = makeText(`${this.rooms.size} AGENTS`, { size: 8, color: GALACTIC.muted, weight: '500', spacing: 1.5 });
    const padX = 12;
    const padY = 5;
    const lampSpace = 16;
    const w = Math.max(title.width, count.width) + padX * 2 + lampSpace;
    const h = padY * 2 + title.height + count.height + 1;

    const plaque = new PIXI.Container();
    const plate = new PIXI.Graphics();
    plate.beginFill(0x0a0a0c, 0.86);
    plate.drawRoundedRect(-w / 2, 0, w, h, 5);
    plate.endFill();
    plate.lineStyle(1, GALACTIC.gold, 0.7);
    plate.drawRoundedRect(-w / 2, 0, w, h, 5);
    plate.lineStyle(0);
    plate.beginFill(GALACTIC.goldLt, 0.9);
    plate.drawRect(-w / 2 + 1.5, 3, 2.5, h - 6);
    plate.endFill();
    plaque.addChild(plate);

    title.position.set(-w / 2 + padX, padY - 1);
    plaque.addChild(title);
    count.position.set(-w / 2 + padX, padY + title.height);
    plaque.addChild(count);

    const lamp = new PIXI.Graphics();
    lamp.position.set(w / 2 - 10, 11);
    plaque.addChild(lamp);

    plaque.position.set(this.galacticLabelX, this.galacticLabelY);
    plaque.zIndex = 100;
    plaque.alpha = this.labelAlpha;
    this.container.addChild(plaque);

    this.plaque = plaque;
    this.plaqueCount = count;
    this.plaqueLamp = lamp;
  }

  /** Counter-scale the plaque so it stays readable at any zoom. */
  applyLabelScale(inv: number): void {
    this.plaque?.scale.set(inv);
  }

  updateLabelAlpha(deltaMS: number): void {
    if (!this.plaque || this.labelAlpha === this.targetLabelAlpha) return;
    const step = (deltaMS / GALACTIC_LABEL_FADE_MS) * (1 - GALACTIC_LABEL_IDLE_ALPHA);
    if (this.labelAlpha < this.targetLabelAlpha) {
      this.labelAlpha = Math.min(this.targetLabelAlpha, this.labelAlpha + step);
    } else {
      this.labelAlpha = Math.max(this.targetLabelAlpha, this.labelAlpha - step);
    }
    this.plaque.alpha = this.labelAlpha;
  }

  setLabelsVisible(visible: boolean): void {
    this.nodeLabelsVisible = visible;
    this.labelGraphics.visible = visible;
    if (this.plaque) this.plaque.visible = visible;
    // Per-room label gating (running-only + zoom LOD) lives in AgentRoom; here we
    // only propagate the global toggle. Running agents keep their plate even in a
    // crowded hub (that legibility is the whole point).
    this.rooms.forEach(room => room.setLabelsVisible(visible));
  }

  private setLabelHover(hovered: boolean): void {
    this.targetLabelAlpha = hovered ? 1 : GALACTIC_LABEL_IDLE_ALPHA;
  }

  private handleTouchHoverStart(event: unknown): void {
    if (readPointerType(event) !== 'touch') return;
    if (this.touchOutTimer) {
      clearTimeout(this.touchOutTimer);
      this.touchOutTimer = null;
    }
    this.touchPointers.add(readPointerId(event));
    this.setLabelHover(true);
  }

  private handleTouchHoverEnd(event: unknown): void {
    if (readPointerType(event) !== 'touch') return;
    this.touchPointers.delete(readPointerId(event));
    if (this.touchPointers.size > 0) return;
    if (this.touchOutTimer) clearTimeout(this.touchOutTimer);
    this.touchOutTimer = setTimeout(() => {
      this.touchOutTimer = null;
      if (!this.isHovered && this.touchPointers.size === 0) this.setLabelHover(false);
    }, 180);
  }

  private slotPosition(index: number): { x: number; y: number } {
    if (this.galacticSlots && this.galacticSlots.length > 0) {
      const slots = this.galacticSlots;
      const count = Math.max(this.rooms.size, 1);
      // At or below slot count: use the original 4 anchor positions as-is.
      if (count <= slots.length) {
        return { x: slots[index].x, y: slots[index].y };
      }
      // Above slot count: fill the AQ footprint with a tight grid so agents
      // don't stack diagonally on top of each other.
      let minX = slots[0].x, maxX = slots[0].x, minY = slots[0].y, maxY = slots[0].y;
      for (const s of slots) {
        if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
      }
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      const stepX = (maxX - minX) / Math.max(cols - 1, 1);
      const stepY = (maxY - minY) / Math.max(rows - 1, 1);
      const col = index % cols;
      const row = Math.floor(index / cols);
      return { x: minX + col * stepX, y: minY + row * stepY };
    }
    const col = index % ROOMS_PER_ROW;
    const row = Math.floor(index / ROOMS_PER_ROW);
    const size = this.getAreaSize();
    return {
      x: -size.width / 2 + NODE_PADDING + ROOM_WIDTH / 2 + col * ROOM_WIDTH,
      y: row * ROOM_HEIGHT + ROOM_HEIGHT / 2,
    };
  }

  /** Every agent room renders at a single uniform scale — no per-node, count, or
   *  status-driven shrink. This is what keeps every agent the exact same pixel
   *  size as the active Claude agent: crowded nodes pack via position (grid /
   *  huddle / spread), never by scaling agents down. Scale 1 also keeps the
   *  world↔room-local routing math (worldToRoomLocal / getWorldAgentPosition,
   *  which assume an unscaled container) exact, so concourse/sector walks land
   *  precisely. */
  private galacticRoomScale(): number {
    return 1;
  }

  private huddleAnchor(): PIXI.Point {
    if (this.galacticSlots) return new PIXI.Point(0, 12);
    return new PIXI.Point(0, 72);
  }

  private placeRoom(room: AgentRoom, index: number): void {
    room.setRoomIndex(index);
    const pos = this.slotPosition(index);
    room.container.x = pos.x;
    room.container.y = pos.y;
    room.container.zIndex = 10 + Math.round(pos.y);
    const scale = this.galacticRoomScale();
    if (room.container.scale.x !== scale) room.container.scale.set(scale);
    this.assignRoomStations(room, index);
  }

  /**
   * Derive this room's furniture-anchored (pod) or cluster (AQ hub) stations
   * from its index. Pure function of index + layout, so it's idempotent across
   * relayouts. Flat (non-galactic) mode leaves stations null → legacy coords.
   */
  private assignRoomStations(room: AgentRoom, index: number): void {
    if (!this.galacticSlots) {
      room.assignStations(null, null, null);
      return;
    }
    if (this.isAgentQuartersHub || !this.stationPools) {
      // AQ hub: no furniture — spread inside the assigned grid cell. Work/rest/
      // stand share the cluster slot (nowhere to "walk to" in AQ).
      const c = AQ_CLUSTER_OFFSETS[index % AQ_CLUSTER_OFFSETS.length];
      room.assignStations(
        { x: c.x, y: c.y, kind: 'aq-work' },
        { x: c.x, y: c.y, kind: 'aq-rest' },
        { x: c.x, y: c.y, kind: 'aq-stand' },
      );
      return;
    }
    room.assignStations(
      this.pickStation(this.stationPools.work, index, 'desk'),
      this.pickStation(this.stationPools.rest, index, 'bench'),
      this.pickStation(this.stationPools.stand, index, 'pad'),
    );
  }

  /** Cyclically pick a furniture anchor from a pool, jittering duplicates. */
  private pickStation(pool: { x: number; y: number }[], index: number, kind: string): Station {
    const base = pool[index % pool.length];
    const dup = Math.floor(index / pool.length);
    const j = stationJitter(dup, index);
    return { x: base.x + j.dx, y: base.y + j.dy, kind };
  }

  /**
   * Collision-spread pass: when two room slots overlap by more than half, nudge
   * the later one along the iso-x axis. Deterministic order + a push large
   * enough to clear a single overlap → idempotent (a settled layout re-runs to a
   * no-op). Always preceded by relayoutRooms so it starts from clean slots.
   */
  private enforceSpread(): void {
    // The Agent-Quarters hub owns its own collision-safe spread layout
    // (applyAgentQuartersLayout). Nudging room containers here would shift the
    // already-resolved huddle targets (they are relative to container.x).
    if (this.isAgentQuartersHub) return;
    const rooms = Array.from(this.rooms.values()).sort((a, b) => a.huddleSortKey - b.huddleSortKey);
    if (rooms.length < 2) return;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i].footprint();
        const b = rooms[j].footprint();
        if (rectOverlapRatio(a, b) > SPREAD_OVERLAP_THRESHOLD) {
          const dir = b.x >= a.x ? 1 : -1;
          rooms[j].nudgeX(dir * SPREAD_PUSH_PX);
        }
      }
    }
  }

  private relayoutRooms(): void {
    let index = 0;
    this.rooms.forEach(room => {
      this.placeRoom(room, index);
      index++;
    });
    this.refreshHuddles();
  }

  private refreshHuddles(): void {
    const rooms = Array.from(this.rooms.values());
    // Agent-Quarters hub: deterministic spread grid instead of a huddle circle.
    // (Dev-only escape hatch `__INFINIBOT_AQ_LEGACY__` falls back to the legacy
    // huddle so the before/after can be compared in the harness; never set in
    // production.)
    if (this.isAgentQuartersHub && this.galacticSlots &&
        !(globalThis as { __INFINIBOT_AQ_LEGACY__?: boolean }).__INFINIBOT_AQ_LEGACY__) {
      this.applyAgentQuartersLayout();
      return;
    }
    if (rooms.length < HUDDLE_MIN_AGENTS) {
      rooms.forEach(room => room.setHuddleTarget(null));
      return;
    }

    const anchor = this.huddleAnchor();
    const radius = HUDDLE_BASE_RADIUS + Math.min(rooms.length, 8) * HUDDLE_RADIUS_PER_AGENT;
    const ordered = rooms.slice().sort((a, b) => a.huddleSortKey - b.huddleSortKey);
    ordered.forEach((room, index) => {
      const angle = (index / ordered.length) * Math.PI * 2 - Math.PI / 2;
      const nodeLocalX = anchor.x + Math.cos(angle) * radius;
      const nodeLocalY = anchor.y + Math.sin(angle) * radius * 0.55;
      room.setHuddleTarget(new PIXI.Point(
        nodeLocalX - room.container.x,
        nodeLocalY - room.container.y,
      ));
    });
  }

  /**
   * Spread the agents that share the Agent-Quarters hub across a stable slot
   * grid so they never bunch on top of each other.
   *
   *  • Slot assignment is keyed by agent-id hash (huddleSortKey), so a given set
   *    of agents always maps to the same slots — reflow on add/remove is stable.
   *  • Shape scales: 2×2 (≤4), 3×3 (≤9), spiral pack beyond.
   *  • A min-distance collision pass guarantees ≥ AQ_MIN_DISTANCE between any two
   *    avatars in the rendered (iso-squashed) space.
   *  • z-order is derived from the stable slot row → no flicker on reflow.
   *  • Targets are fed through setHuddleTarget, so the existing per-frame easing
   *    tweens each agent smoothly (~quarter-second) to its new slot.
   *  • Per-agent labels are hidden once a quarter holds more than 4 agents.
   */
  private applyAgentQuartersLayout(): void {
    const ordered = Array.from(this.rooms.values()).sort(
      (a, b) => a.huddleSortKey - b.huddleSortKey,
    );
    const count = ordered.length;
    if (count === 0) return;

    const anchor = this.huddleAnchor();
    const lattice = aqLatticeCoords(count);
    // Node-local target points, foreshortened on Y for the iso floor.
    const pts = lattice.map(c => ({
      x: anchor.x + c.cx * AQ_STEP_X,
      y: anchor.y + c.cy * AQ_STEP_Y * AQ_ISO_SQUASH,
    }));

    // Collision pass: enforce min spacing in rendered space (un-squash Y so the
    // distance check matches what the eye sees), deterministic + idempotent.
    const minD = AQ_MIN_DISTANCE;
    const invSquash = 1 / AQ_ISO_SQUASH;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[j].x - pts[i].x;
          const dyView = (pts[j].y - pts[i].y) * invSquash;
          const dist = Math.hypot(dx, dyView);
          if (dist >= minD || dist === 0) continue;
          const push = (minD - dist) / 2 + 0.5;
          const ux = dist === 0 ? 1 : dx / dist;
          const uy = dist === 0 ? 0 : dyView / dist;
          pts[i].x -= ux * push;       pts[j].x += ux * push;
          pts[i].y -= uy * push * AQ_ISO_SQUASH; pts[j].y += uy * push * AQ_ISO_SQUASH;
          moved = true;
        }
      }
      if (!moved) break;
    }

    // Per-agent nameplates are gated to RUNNING agents + zoom LOD inside
    // AgentRoom.labelActive(), so a crowded idle hub already stays clean without
    // a blanket count cap. Respect only the global labels-hidden toggle here so
    // every live/running agent still gets its plate.
    const labelsOn = this.nodeLabelsVisible;
    ordered.forEach((room, index) => {
      const p = pts[index];
      room.setHuddleTarget(new PIXI.Point(
        p.x - room.container.x,
        p.y - room.container.y,
      ));
      // Stable depth: back rows (smaller y) draw behind front rows. Derived from
      // the stable slot, so stacking order never flickers as agents come/go.
      room.container.zIndex = 10 + Math.round(p.y);
      room.setLabelsVisible(labelsOn);
    });
  }

  private getAreaSize(): { width: number; height: number } {
    const roomCount = Math.max(this.rooms.size, 1);
    const cols = Math.min(roomCount, ROOMS_PER_ROW);
    const rows = Math.ceil(roomCount / ROOMS_PER_ROW);
    return {
      width: cols * ROOM_WIDTH + NODE_PADDING * 2,
      height: rows * ROOM_HEIGHT + NODE_PADDING * 2 + 40, // Extra for header
    };
  }
  
  private drawBackground(): void {
    const g = this.bgGraphics;
    g.clear();

    const size = this.getAreaSize();

    if (isGalactic()) {
      // Zones and pod platforms provide the visuals — no panel box
      return;
    }

    // Outer border
    g.beginFill(0xe8e0d8);
    g.drawRoundedRect(-size.width/2, -40, size.width, size.height, 12);
    g.endFill();

    // Inner floor
    g.beginFill(0xc4a574, 0.5);
    g.drawRoundedRect(-size.width/2 + 8, -32, size.width - 16, size.height - 16, 8);
    g.endFill();

    // Shadow
    g.beginFill(COLORS.shadow, 0.1);
    g.drawRoundedRect(-size.width/2 + 4, size.height - 44, size.width, 8, 4);
    g.endFill();
  }
  
  private drawLabel(): void {
    const g = this.labelGraphics;
    g.clear();
    
    const name = this.data.name.toUpperCase();
    const width = measurePixelText(name, 2);
    const size = this.getAreaSize();

    if (isGalactic()) {
      // Crisp plaque is a separate object; just refresh the count
      if (this.plaqueCount) this.plaqueCount.text = `${this.rooms.size} AGENTS`;
      return;
    }

    // Label background
    g.beginFill(0xc87a3c);
    g.drawRect(-width/2 - 12, -35, width + 24, 20);
    g.endFill();

    // Label text
    drawPixelText(g, name, -width/2, -32, COLORS.white, 2);

    // Agent count
    const countText = `${this.rooms.size} AGENTS`;
    const countWidth = measurePixelText(countText, 1);
    drawPixelText(g, countText, -countWidth/2, -12, COLORS.textLight, 1);
  }
  
  private drawStatus(): void {
    const g = this.statusGraphics;
    g.clear();

    const color = this.data.status === 'online' ? COLORS.nodeOnline :
                  this.data.status === 'connecting' ? COLORS.nodeConnecting :
                  COLORS.nodeOffline;

    if (isGalactic()) {
      // Status lamp lives on the plaque
      const lamp = this.plaqueLamp;
      if (lamp) {
        lamp.clear();
        lamp.beginFill(color);
        lamp.drawCircle(0, 0, 4);
        lamp.endFill();
        lamp.beginFill(color, 0.3);
        lamp.drawCircle(0, 0, 8);
        lamp.endFill();
      }
      return;
    }

    const size = this.getAreaSize();

    // Status light
    g.beginFill(color);
    g.drawCircle(size.width/2 - 20, -30, 6);
    g.endFill();

    // Glow
    g.beginFill(color, 0.3);
    g.drawCircle(size.width/2 - 20, -30, 12);
    g.endFill();
  }
  
  addRoom(agent: MeshAgent, onClick?: (agent: MeshAgent) => void): AgentRoom {
    const roomIndex = this.rooms.size;
    const room = new AgentRoom(agent, roomIndex, onClick, this.isAgentQuartersHub, this.galacticTextures);
    room.setLabelsVisible(this.labelGraphics.visible);

    this.container.addChild(room.container);
    this.rooms.set(agent.sessionKey, room);
    // Re-place ALL rooms from clean slots (re-derives stations) then spread, so
    // the layout is a pure function of membership — no accumulated drift.
    this.relayoutRooms();
    this.enforceSpread();

    // Redraw background to fit new room count
    this.drawBackground();
    this.drawLabel();

    return room;
  }

  removeRoom(sessionKey: string): void {
    const room = this.rooms.get(sessionKey);
    if (!room) return;

    room.destroyOverlay();
    this.container.removeChild(room.container);
    this.rooms.delete(sessionKey);

    this.relayoutRooms();
    this.enforceSpread();

    this.drawBackground();
    this.drawLabel();
  }

  detachRoom(sessionKey: string): AgentRoom | null {
    const room = this.rooms.get(sessionKey);
    if (!room) return null;

    this.container.removeChild(room.container);
    this.rooms.delete(sessionKey);
    this.relayoutRooms();
    this.enforceSpread();
    this.drawBackground();
    this.drawLabel();
    return room;
  }

  attachRoom(room: AgentRoom): void {
    room.setLabelsVisible(this.labelGraphics.visible);
    this.container.addChild(room.container);
    this.rooms.set(room.data.sessionKey, room);
    this.relayoutRooms();
    this.enforceSpread();
    this.drawBackground();
    this.drawLabel();
  }
  
  update(node: MeshNode): void {
    this.data = node;
    this.drawStatus();
    this.drawLabel();
  }
  
  animateRooms(dt: number, viewZoom = 1): void {
    this.rooms.forEach(room => { room.setViewZoom(viewZoom); room.animate(dt); });
    this.separateActiveRooms(dt);
  }

  /** Anti-cluster: gently repel RUNNING agents that render too close together so
   *  each stays distinct and their nameplates don't collide. Render-space only —
   *  it nudges each room's separation offset (capped + decaying), never the
   *  logical target, so agents remain near their meaningful home/sector. */
  private separateActiveRooms(dt: number): void {
    const active: AgentRoom[] = [];
    this.rooms.forEach(r => { if (r.isActive) active.push(r); });
    if (active.length < 2) return;
    for (let i = 0; i < active.length; i++) {
      const a = active[i].nodeLocalCenter();
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j].nodeLocalCenter();
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        if (dist >= AGENT_SEPARATION_MIN_PX) continue;
        const push = ((AGENT_SEPARATION_MIN_PX - dist) / AGENT_SEPARATION_MIN_PX) * AGENT_SEPARATION_STRENGTH * dt;
        const ux = dx / dist;
        const uy = dy / dist;
        // Foreshorten Y so the spread reads correctly on the iso floor.
        active[i].applySeparation(-ux * push, -uy * push * 0.6);
        active[j].applySeparation(ux * push, uy * push * 0.6);
      }
    }
  }

  destroy(): void {
    if (this.touchOutTimer) clearTimeout(this.touchOutTimer);
    this.rooms.forEach(room => room.destroyOverlay());
    this.container.destroy({ children: true });
  }

  getTooltipLines(): string[] {
    return [
      `NODE: ${this.data.name.toUpperCase()}`,
      `ROLE: ${this.data.role.toUpperCase()}`,
      `STATUS: ${this.data.status.toUpperCase()}`,
      `AGENTS: ${this.rooms.size}`,
    ];
  }
  
  get x() { return this.container.x; }
  get y() { return this.container.y; }
  set x(val: number) { this.container.x = val; }
  set y(val: number) { this.container.y = val; }
}

// ════════════════════════════════════════════════════════════════
// MINIMAP
// ════════════════════════════════════════════════════════════════

class Minimap {
  container: PIXI.Container;
  private content: PIXI.Graphics;
  private viewRect: PIXI.Graphics;
  private scale = 0.04;
  private offsetX = 70;
  private offsetY = 40;

  constructor() {
    this.container = new PIXI.Container();
    if (isGalactic()) {
      // Wider world (platform + orbital pods) needs a smaller scale
      this.scale = 0.028;
      this.offsetX = 75;
      this.offsetY = 45;
    }
    
    // Background
    const bg = new PIXI.Graphics();
    if (isGalactic()) {
      bg.beginFill(0x0a0a0c, 0.82);
      bg.drawRoundedRect(0, 0, 140, 100, 8);
      bg.endFill();
      bg.lineStyle(1, GALACTIC.gold, 0.85);
      bg.drawRoundedRect(0, 0, 140, 100, 8);
    } else {
      bg.beginFill(COLORS.white, 0.9);
      bg.drawRect(0, 0, 140, 100);
      bg.endFill();
      bg.lineStyle(2, 0xc87a3c);
      bg.drawRect(0, 0, 140, 100);
    }
    this.container.addChild(bg);

    // Title
    if (isGalactic()) {
      const t = makeText('ORBITAL MAP', { size: 8, color: GALACTIC.gold, spacing: 2.5 });
      t.position.set(8, 4);
      this.container.addChild(t);
    } else {
      const title = new PIXI.Graphics();
      drawPixelText(title, 'MAP', 5, 3, 0xc87a3c, 1);
      this.container.addChild(title);
    }
    
    this.content = new PIXI.Graphics();
    this.content.y = 12;
    this.container.addChild(this.content);
    
    this.viewRect = new PIXI.Graphics();
    this.viewRect.y = 12;
    this.container.addChild(this.viewRect);
  }
  
  update(nodes: Map<string, NodeArea>, agents: Map<string, AgentRoom>, viewport: Viewport): void {
    this.content.clear();

    // Station outline for orientation
    if (isGalactic()) {
      this.content.lineStyle(1, GALACTIC.goldDp, 0.7);
      this.content.drawPolygon([
        800 * this.scale + this.offsetX, (600 - 384) * this.scale + this.offsetY,
        (800 + 768) * this.scale + this.offsetX, 600 * this.scale + this.offsetY,
        800 * this.scale + this.offsetX, (600 + 384) * this.scale + this.offsetY,
        (800 - 768) * this.scale + this.offsetX, 600 * this.scale + this.offsetY,
      ]);
      this.content.lineStyle(0);
    }

    // Draw nodes as larger dots
    nodes.forEach(n => {
      this.content.beginFill(COLORS.gold, 0.8);
      const cx = n.x * this.scale + this.offsetX;
      const cy = n.y * this.scale + this.offsetY;
      this.content.drawRect(cx - 4, cy - 4, 8, 8);
      this.content.endFill();
    });

    // View rectangle
    this.viewRect.clear();
    this.viewRect.lineStyle(1, COLORS.gold, 0.9);
    const vx = viewport.left * this.scale + this.offsetX;
    const vy = viewport.top * this.scale + this.offsetY;
    const vw = viewport.screenWidth / viewport.scale.x * this.scale;
    const vh = viewport.screenHeight / viewport.scale.y * this.scale;
    this.viewRect.drawRect(vx, vy, vw, vh);
  }
}

// ════════════════════════════════════════════════════════════════
// UI CONTROLS
// ════════════════════════════════════════════════════════════════

class UIControls {
  container: PIXI.Container;
  private readonly buttons = new Map<string, PIXI.Container>();
  private labelsHidden: boolean;
  private readonly size = 28;
  private readonly gap = 6;
  private readonly margin = 14;
  
  constructor(
    onAction: (action: string) => void,
    options: { width: number; height: number; labelsHidden: boolean },
  ) {
    this.container = new PIXI.Container();
    this.labelsHidden = options.labelsHidden;
    
    const buttons = [
      { id: 'zoomIn', text: '+', y: 0 },
      { id: 'zoomOut', text: '-', y: 34 },
      { id: 'fitAll', text: '⊡', y: 68 },
      { id: 'toggleLabels', text: '', y: 102 },
    ];
    
    for (const def of buttons) {
      const btn = this.buildButton(def.id, def.text);
      btn.y = def.y;
      (btn as any).interactive = true;
      (btn as any).buttonMode = true;
      (btn as any).on('pointerdown', () => onAction(def.id));
      
      this.buttons.set(def.id, btn);
      this.container.addChild(btn);
    }

    this.resize(options.width, options.height);
  }

  resize(width: number, height: number, bottomReservedPx = 0): void {
    const stackHeight = this.size * 4 + this.gap * 3;
    this.container.position.set(
      Math.max(this.margin, width - this.margin - this.size),
      Math.max(this.margin, height - this.margin - stackHeight - bottomReservedPx),
    );
  }

  setLabelsHidden(hidden: boolean): void {
    if (this.labelsHidden === hidden) return;
    this.labelsHidden = hidden;
    const button = this.buttons.get('toggleLabels');
    if (!button) return;
    button.removeChildren().forEach(child => child.destroy({ children: true }));
    this.drawButton(button, '', 'toggleLabels');
  }

  private buildButton(id: string, text: string): PIXI.Container {
    const btn = new PIXI.Container();
    (btn as any).hitArea = new PIXI.Rectangle(0, 0, this.size, this.size);
    this.drawButton(btn, text, id);
    return btn;
  }

  private drawButton(btn: PIXI.Container, text: string, id: string): void {
    const bg = new PIXI.Graphics();
    if (isGalactic()) {
      bg.beginFill(GALACTIC.void, 0.86);
      bg.drawRoundedRect(0, 0, this.size, this.size, 6);
      bg.endFill();
      bg.lineStyle(1, GALACTIC.gold, 0.86);
      bg.drawRoundedRect(0, 0, this.size, this.size, 6);
      bg.lineStyle(0);
      bg.beginFill(GALACTIC.goldLt, 0.16);
      bg.drawRoundedRect(2, 2, this.size - 4, 8, 4);
      bg.endFill();
    } else {
      bg.beginFill(0xc87a3c);
      bg.drawRect(0, 0, this.size, this.size);
      bg.endFill();
      bg.beginFill(0xe89a5c);
      bg.drawRect(0, 0, this.size, 2);
      bg.drawRect(0, 0, 2, this.size);
      bg.endFill();
      bg.beginFill(0xa65a2c);
      bg.drawRect(this.size - 2, 0, 2, this.size);
      bg.drawRect(0, this.size - 2, this.size, 2);
      bg.endFill();
    }
    btn.addChild(bg);

    if (id === 'toggleLabels') {
      this.drawEyeIcon(btn);
      return;
    }

    if (isGalactic()) {
      const t = makeText(text, { size: text === '⊡' ? 14 : 16, color: GALACTIC.goldLt });
      t.position.set((this.size - t.width) / 2, (this.size - t.height) / 2 - 1);
      btn.addChild(t);
    } else {
      const label = new PIXI.Graphics();
      drawPixelText(label, text, (this.size - measurePixelText(text, 2)) / 2, 6, COLORS.white, 2);
      btn.addChild(label);
    }
  }

  private drawEyeIcon(btn: PIXI.Container): void {
    const g = new PIXI.Graphics();
    const cx = this.size / 2;
    const cy = this.size / 2;
    const color = this.labelsHidden ? GALACTIC.muted : GALACTIC.goldLt;
    g.lineStyle(1.5, color, 0.95);
    g.drawEllipse(cx, cy, 8, 5);
    g.lineStyle(0);
    g.beginFill(color, 0.95);
    g.drawCircle(cx, cy, 2.5);
    g.endFill();
    if (this.labelsHidden) {
      g.lineStyle(2, GALACTIC.warn, 0.95);
      g.moveTo(8, 21);
      g.lineTo(20, 7);
      g.lineStyle(0);
    }
    btn.addChild(g);
  }
}

// ════════════════════════════════════════════════════════════════
// TOOLTIP
// ════════════════════════════════════════════════════════════════

class Tooltip {
  container: PIXI.Container;
  private bg: PIXI.Graphics;
  private content: PIXI.Graphics;
  
  constructor() {
    this.container = new PIXI.Container();
    this.container.visible = false;
    this.container.zIndex = 1000;
    
    this.bg = new PIXI.Graphics();
    this.container.addChild(this.bg);
    
    this.content = new PIXI.Graphics();
    this.container.addChild(this.content);
  }
  
  show(x: number, y: number, lines: string[]): void {
    this.bg.clear();
    this.content.clear();
    
    const padding = 8;
    const lineHeight = 10;
    const scale = 2;
    
    let maxWidth = 0;
    for (const line of lines) {
      maxWidth = Math.max(maxWidth, measurePixelText(line, scale));
    }
    const width = maxWidth + padding * 2;
    const height = lines.length * lineHeight + padding * 2;
    
    // Background
    this.bg.beginFill(isGalactic() ? 0x0a0a0a : COLORS.white, isGalactic() ? 0.95 : 1);
    this.bg.drawRect(0, 0, width, height);
    this.bg.endFill();

    // Border
    this.bg.lineStyle(isGalactic() ? 1 : 2, isGalactic() ? GALACTIC.gold : COLORS.text);
    this.bg.drawRect(0, 0, width, height);
    this.bg.lineStyle(0);

    // Text
    lines.forEach((line, i) => {
      drawPixelText(this.content, line, padding, padding + i * lineHeight, isGalactic() ? GALACTIC.goldLt : COLORS.text, scale);
    });
    
    this.container.x = x + 20;
    this.container.y = y - height / 2;
    this.container.visible = true;
  }
  
  hide(): void {
    this.container.visible = false;
  }
}

// ════════════════════════════════════════════════════════════════
// MESSAGE TRAIL EFFECT
// ════════════════════════════════════════════════════════════════

class MessageTrail {
  container: PIXI.Container;
  private particles: PIXI.Graphics[] = [];
  
  constructor(from: { x: number; y: number }, to: { x: number; y: number }, type: string) {
    this.container = new PIXI.Container();
    
    const color = type === 'request' ? COLORS.gold :
                  type === 'response' ? 0x22c55e :
                  type === 'broadcast' ? 0x3b82f6 : 0xd4af37;
    
    for (let i = 0; i < 5; i++) {
      const p = new PIXI.Graphics();
      const size = (5 - i) * 2;
      p.beginFill(color);
      p.drawRect(-size/2, -size/2, size, size);
      p.endFill();
      p.position.set(from.x, from.y);
      this.particles.push(p);
      this.container.addChild(p);
    }
    
    // Animate
    this.particles.forEach((p, i) => {
      gsap.to(p.position, {
        x: to.x,
        y: to.y,
        duration: 0.5,
        delay: i * 0.04,
        ease: 'none',
      });
      gsap.to(p, { alpha: 0, duration: 0.15, delay: 0.35 + i * 0.04 });
    });
  }
}

// ════════════════════════════════════════════════════════════════
// TOOL-CALL CHAT BUBBLE
// ════════════════════════════════════════════════════════════════

/** Category color for a tool kind, drawn from the live GALACTIC palette. */
function toolBubbleColor(kind: string): number {
  const k = (kind || '').toLowerCase();
  if (/read|list|cat|grep|glob|search|view|\bls\b|find|fetch.*read/.test(k)) return GALACTIC.info; // blue
  if (/write|edit|create|update|patch|apply|insert|mkdir|notebook/.test(k)) return GALACTIC.ok;   // green
  if (/bash|exec|shell|run|command|terminal|\bcmd\b|spawn|script/.test(k)) return GALACTIC.warn;   // orange
  if (/web|fetch|http|net|url|curl|download|\bapi\b|browser|request/.test(k)) return 0x9a6cf0;     // violet
  return GALACTIC.muted;                                                                            // gray
}

/**
 * A small speech bubble shown above an agent sprite when it fires a tool.
 * Lives ~3s then fades over 300ms. Positioned each frame by ActivityMap so
 * it follows its agent and stacks with siblings.
 */
class ToolBubble {
  container: PIXI.Container;
  readonly width: number;
  readonly height: number;
  /** Lerped vertical offset above the anchor — gives older bubbles a drift. */
  stackOffset = 0;

  private bornAt: number;
  private static readonly LIFE_MS = 3000;
  private static readonly FADE_MS = 300;

  constructor(kind: string, label: string, now: number) {
    this.bornAt = now;
    this.container = new PIXI.Container();

    const color = toolBubbleColor(kind);
    let text = (label && label.trim()) ? label.trim() : (kind || 'TOOL');
    if (text.length > 24) text = text.slice(0, 22) + '..';

    const scale = 1;
    const barW = 3;
    const padX = 6;
    const padY = 4;
    const fontH = 5; // pixel-font glyph height at scale 1
    const textW = measurePixelText(text, scale);
    const w = barW + textW + padX * 2;
    const h = fontH + padY * 2;
    this.width = w;
    this.height = h;

    // Bubble body sits ABOVE the anchor (y in [-h, 0]); tail points down to it.
    const g = new PIXI.Graphics();
    g.beginFill(0x0a0a0c, 0.92);
    g.drawRoundedRect(-w / 2, -h, w, h, 3);
    g.endFill();
    g.lineStyle(1, color, 0.85);
    g.drawRoundedRect(-w / 2, -h, w, h, 3);
    g.lineStyle(0);
    // Category accent bar
    g.beginFill(color, 0.95);
    g.drawRect(-w / 2 + 1.5, -h + 2, barW, h - 4);
    g.endFill();
    // Downward tail
    g.beginFill(0x0a0a0c, 0.92);
    g.drawPolygon([-3, -1, 3, -1, 0, 4]);
    g.endFill();
    this.container.addChild(g);

    const txt = new PIXI.Graphics();
    drawPixelText(txt, text, -w / 2 + barW + padX, -h + padY, 0xf4f4f4, scale);
    this.container.addChild(txt);
  }

  /** Advance fade/lifetime; returns false once fully expired. */
  tick(now: number): boolean {
    const age = now - this.bornAt;
    if (age >= ToolBubble.LIFE_MS + ToolBubble.FADE_MS) return false;
    this.container.alpha = age > ToolBubble.LIFE_MS
      ? 1 - (age - ToolBubble.LIFE_MS) / ToolBubble.FADE_MS
      : 1;
    return true;
  }
}

// ════════════════════════════════════════════════════════════════
// MAIN ACTIVITY MAP CLASS
// ════════════════════════════════════════════════════════════════

export class ActivityMap {
  private app: PIXI.Application;
  private viewport: Viewport;
  private container: HTMLElement;
  private options: ActivityMapOptions;
  private canvas: HTMLCanvasElement;
  
  private backgroundLayer: PIXI.Container;
  private nodeLayer: PIXI.Container;
  private effectsLayer: PIXI.Container;
  private labelLayer: PIXI.Container;
  private toolBubbleLayer: PIXI.Container;
  private tooltipLayer: PIXI.Container;
  private uiLayer: PIXI.Container;
  private hud: HudOverlay | null = null;
  private hudPanelHidden = false;
  private cinematic: CinematicOverlay | null = null;
  // Live cinematic camera engine (drone orbit + origin-story intro + clip capture).
  private cinematicCam: CinematicCamera | null = null;
  /** performance.now() of the most recent world activity — drives auto-drone quiet
   *  detection. Bumped on every agent add/update and message. */
  private worldLastActivityAt = 0;
  // Phase 4 §fidelity — WebGL cinematic color-grade filter over the world. A
  // full-viewport filter renders the world to a texture each frame, so it is
  // OPT-IN (window.__worldFidelity) and gated behind the perf/LOD foundation,
  // exactly as the plan stages it. (True WebGPU volumetric fog/SSR needs a Pixi
  // v8 upgrade — this engine is v6, WebGL-only.)
  private fidelityFilter: PIXI.Filter | null = null;
  // Phase 4 §federation galaxy — true while zoomed out into the interstellar tier.
  private galaxyActive = false;
  
  private nodes: Map<string, NodeArea> = new Map();
  private agentToNode: Map<string, string> = new Map(); // sessionKey -> nodeId

  private minimap!: Minimap;
  private uiControls!: UIControls;
  private tooltip: Tooltip;
  private starfield: Starfield | null = null;
  private themePicker: ThemePicker | null = null;

  // Galactic station state
  private station: StationComplex | null = null;
  // Plugin District — one room per enabled plugin (iso/plugin-district.ts).
  // Specs are kept so a theme/context rebuild re-creates the same rooms.
  private district: PluginDistrict | null = null;
  private pluginRoomSpecs: PluginRoomSpec[] = [];
  private pluginActivity: PluginActivityIndex | null = null;
  // sessionKey → plugin room the agent was last planned into (cross-room carry FX).
  private lastPluginRoomOf = new Map<string, string>();
  // sessionKey → performance.now() deadline while the agent carries an item.
  private carryingUntil = new Map<string, number>();
  private hoveredPluginRoom: string | null = null;
  // Phase 1 §4: volumetric pulsing ground grid — a single additive overlay over
  // the station floor whose alpha breathes at a rate scaled by aggregate system
  // activity (credit burn + live agents), published as window.__worldActivity.
  private floorPulse: PIXI.Graphics | null = null;
  private floorPulsePhase = 0;
  // Animated, activity-driven island borders (mesh-plan "islands"). One aura per
  // station district zone (key `zone:<id>`) + one per satellite pod (key
  // `pod:<nodeId>`). Ticked every frame; activity refreshed periodically from
  // live agent counts/status; ripples fired from real tool/completion events.
  private islandAuras = new Map<string, IslandAura>();
  private islandAuraLayer: PIXI.Container | null = null;
  // §5 reliability: toggleable debug telemetry overlay (FPS / agents / objects /
  // frame cost / dropped frames). DOM sibling of the canvas; off by default.
  private debugOverlay: HTMLDivElement | null = null;
  private debugEnabled = false;
  private frameMsEMA = 0;
  private droppedFrames = 0;
  private bridges: Map<string, PIXI.Graphics> = new Map();
  // Slot allocator: monotonic counter is the high-water mark; freePodSlots
  // holds released indices so reconnects reuse the nearest free anchor
  // instead of walking the next island further out each cycle.
  private podSlotHigh = 0;
  private freePodSlots: number[] = [];
  private podSlotOf: Map<string, number> = new Map();
  // Per-satellite bridge anchor (final world coords). Lets updateNode
  // redraw the bridge when a node's position changes instead of leaving
  // the dashed line pinned to the original spawn coord.
  private bridgeAnchors: Map<string, { x: number; y: number }> = new Map();
  // Nodes that arrived before this.station was constructed (galactic mode
  // race during initial sync). Replayed once the station exists so they
  // don't end up stranded in the flat-grid fallback branch.
  private pendingGalacticNodes: MeshNode[] = [];
  private zoneOwnerNodeId: string | null = null;
  private activeSectors = new Set<string>();

  // ── Activity-driven movement (Part 1) ──
  // sessionKey → sectorId the agent is currently routed to.
  private agentToolSector = new Map<string, string>();
  // Agent spread (iso/agent-spread*.ts): working agents take distinct desks
  // across every sector instead of bunching in Agent Quarters.
  private spread = new AgentSpreadDriver({
    workingAgents: () => {
      const out: Array<{ key: string; label?: string; currentTask?: string; agentId?: string; backend?: string | null }> = [];
      this.nodes.forEach(n => n.rooms.forEach((room, key) => {
        const d = room.data;
        if (!isRestingStatus(d.status)) out.push({ key, label: d.label, currentTask: d.currentTask, agentId: d.agentId, backend: d.coderBackend });
      }));
      return out;
    },
    allAgentKeys: () => [...this.agentToNode.keys()],
    isParked: key => this.agentBed.has(key) || this.agentToolSector.has(key),
    slotsFor: id => this.station?.sectorWorkSlots?.[id] ?? this.district?.workSlots(id),
    sectorCenter: id => this.sectorCenter(id),
    roomFor: (a, tool) => this.pluginRoomFor(a, tool),
    routeTo: (key, world, fresh) => {
      const found = this.roomOf(key);
      if (!found) return;
      const local = this.worldToRoomLocal(found.room, found.nodeArea, new PIXI.Point(world.x, world.y));
      if (fresh || !found.room.isRouted) found.room.routeToLocal(local, TOOL_WALK_SPEED_PX);
      else found.room.retargetDetour(local);
    },
    release: key => this.roomOf(key)?.room.clearRoute(),
    worldPos: key => {
      const found = this.roomOf(key);
      if (!found) return null;
      const p = found.room.nodeLocalCenter();
      return { x: found.nodeArea.x + p.x, y: found.nodeArea.y + p.y };
    },
    nudge: (key, dx, dy) => this.roomOf(key)?.room.applySeparation(dx, dy),
  });
  // sectorId → set of sessionKeys dwelling there (for ring compaction + hot tint).
  private sectorOccupants = new Map<string, Set<string>>();
  // sessionKey → pending "return home" timer.
  private routeReturnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Pending "depart the map" timers for completed/failed agents so the map only
  // shows what's actually running. Cleared if the agent goes active again.
  private completionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── Gateway-concourse rest area (idle agents glide to a bed) ──
  // sessionKey → index into station.concourseBedSlots the agent is parked on.
  private agentBed = new Map<string, number>();
  // bedIndex → sessionKey occupying it (inverse of agentBed, for free-slot scan).
  private bedOccupant = new Map<number, string>();
  // Finished (completed/failed) agents resting on the map, newest first. Capped
  // at MAX_RESTING_COMPLETED — the oldest departs when an 11th finishes. (The
  // data bridge enforces the same cap; this is the engine-side safety net for
  // other feeders like the demo source.)
  private finishedOrder: string[] = [];

  // Live tool-call chat bubbles, keyed by agent sessionKey (newest at end).
  private toolBubbles: Map<string, ToolBubble[]> = new Map();
  private labelPlacementOffsets = new Map<string, { x: number; y: number }>();
  /** Latest screen-space overlay pass (sprites + placed labels/bubbles), kept
   *  by reference so DOM hover cards can dodge name tags without re-solving. */
  private lastOverlaySprites: SpriteObstacle[] = [];
  private lastOverlayPlaced: { labels: Record<string, OverlayPlacement>; bubbles: Record<string, OverlayPlacement> } = { labels: {}, bubbles: {} };
  /** Screen px covered by host DOM chrome (HUD column…); zoomToFit frames
   *  the world inside the remaining area so nothing starts under a panel. */
  private fitInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Screen rects (canvas px) covered by host DOM chrome — floor signs under them hide. */
  private chromeRects: ScreenRect[] = [];
  private chromeOccluded = new Set<PIXI.DisplayObject>();
  private bubblePlacementOffsets = new Map<string, { x: number; y: number }>();

  // Live-FX + HUD-metric state (see the LIVE FX section).
  private toolEventTimes: number[] = [];
  private trailingAgents = new Map<string, { until: number; color: number }>();
  private trailDots: { g: PIXI.Graphics; born: number }[] = [];
  private tokenBaseline: { t: number; total: number } | null = null;
  private tokenLatest: { t: number; total: number } | null = null;
  private destroyed = false;
  private _visHandler: (() => void) | null = null;
  private contextLost = false;
  private contextRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly handleContextLost = (e: Event): void => {
    // Pixi's ContextSystem already preventDefault()s; do it too so the
    // browser is guaranteed to fire webglcontextrestored.
    e.preventDefault();
    this.contextLost = true;
    if (this.contextRestoreTimer) { clearTimeout(this.contextRestoreTimer); this.contextRestoreTimer = null; }
  };

  private readonly handleContextRestored = (): void => {
    if (this.destroyed) return;
    if (this.contextRestoreTimer) clearTimeout(this.contextRestoreTimer);
    // Defer a macrotask so Pixi's own contextChange runners settle first.
    this.contextRestoreTimer = setTimeout(() => {
      this.contextRestoreTimer = null;
      if (this.destroyed) return;
      this.contextLost = false;
      this.rebakeAfterContextRestore();
    }, 0);
  };

  /** True between a GL context loss and the post-restore re-bake. */
  isContextLost(): boolean {
    return this.contextLost;
  }

  /**
   * In-process equivalent of a page refresh for the GPU side: re-bake every
   * generateTexture() RenderTexture and rebuild the scene objects that point
   * at them, preserving nodes/agents/sector activity.
   */
  rebakeAfterContextRestore(): void {
    if (this.destroyed) return;
    try {
      if (isGalactic()) {
        this.rebuildGalacticWorld();
      } else {
        this.rebuildAllRooms();
      }
      this.updateTickerState();
      this.app.render();
    } catch (err) {
      console.warn('[activity-map] re-bake after WebGL context restore failed', err);
    }
  }

  // Vertical space (px) reserved at the bottom-right for the recently-completed
  // pin board overlay, so the Pixi UI controls float ABOVE it instead of
  // overlapping. Set by the host via setBottomReserved(); 0 = no overlay.
  private bottomReservedPx = 0;
  // Hide the top-right minimap + theme picker (the host sets this on narrow
  // screens where its top-left HUD column spans the full width).
  private topRightChromeHidden = false;

  private atrium_layer: PIXI.Container | null = null;
  private atrium_conduitLayer: PIXI.Container | null = null;
  private atrium_glyphLayer: PIXI.Container | null = null;
  private atrium_coreGlow: PIXI.Graphics | null = null;
  private atrium_conduits: Map<string, AtriumConduitState> = new Map();
  private atrium_glyphs: AtriumGlyph[] = [];
  private atrium_glyphPool: AtriumGlyph[] = [];
  private atrium_elapsedMs = 0;
  private atrium_surgePower = 0;
  private atrium_ringSurgePower = 0;
  private atrium_ringWrap: PIXI.Container | null = null;

  // ── Replay state ──────────────────────────────────────────────────────────
  private replayHistory: ReplayHistorySample[] = [];
  private readonly replayCap = 3600; // ~1h @1Hz
  private replayLastSampleT = 0; // Date.now() of last recorded sample
  private replayActive = false;
  private replayTargetT = 0;
  // Discrete-event log (tool/dialogue/complete) + the last replay time we've
  // already fired events up to (so a paused frame never double-emits).
  private replayEvents: ReplayEventSample[] = [];
  private readonly replayEventCap = 4000;
  private replayEmitT = 0;
  private replayAppliedConduitT = -1; // last sample.t whose conduits were reconciled
  private replayStatusById = new Map<string, string>(); // historical status during replay
  /** Session keys of LIVE rooms hidden during replay because they didn't exist
   *  at the scrubbed time. Restored to visible on resumeLive(). */
  private replayHidden = new Set<string>();

  private animationFrame = 0;
  private hasAutoFit = false;
  /** External per-frame hooks (review mesh layer). Run inside animate(), so
   *  they pause with the ticker (hidden tab / offscreen / inactive panel). */
  private frameListeners = new Set<(deltaMS: number) => void>();
  /** World-space overlay layers handed out to external modules. */
  private overlayLayers: PIXI.Container[] = [];
  /** Perf: pause the ticker's work when the map is scrolled out of view, and
   *  throttle to ~30fps when the window is blurred (see animate()). */
  private offscreen = false;
  private panelActive = true;
  private windowBlurred = typeof document !== "undefined" && typeof document.hasFocus === "function" ? !document.hasFocus() : false;
  private lastRenderMS = 0;
  private visibilityObserver: IntersectionObserver | null = null;
  private readonly handleWindowFocus = () => { this.windowBlurred = false; };
  private readonly handleWindowBlur = () => { this.windowBlurred = true; };
  labelsHidden = readLabelsHiddenSetting();
  private pointerInsideCanvas = false;
  private readonly handleCanvasPointerEnter = () => { this.pointerInsideCanvas = true; };
  private readonly handleCanvasPointerLeave = () => { this.pointerInsideCanvas = false; };
  private readonly handleCanvasPointerDown = () => { this.canvas.focus({ preventScroll: true }); };
  
  constructor(container: HTMLElement, options: ActivityMapOptions = {}) {
    this.container = container;
    this.options = options;
    WORLD_THEME = options.worldTheme ?? 'galactic';

    const width = options.width || container.clientWidth || 800;
    const height = options.height || container.clientHeight || 500;

    // Create PIXI app
    this.app = new PIXI.Application({
      width,
      height,
      backgroundColor: isGalactic() ? GALACTIC.void : COLORS.bg,
      antialias: false,
      resolution: 1,
      autoDensity: false,
    });
    PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;
    PIXI.settings.ROUND_PIXELS = true;
    
    // Add canvas to container with touch support styles
    const canvas = this.app.view as HTMLCanvasElement;
    this.canvas = canvas;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    canvas.style.webkitUserSelect = 'none';
    canvas.style.userSelect = 'none';
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerenter', this.handleCanvasPointerEnter);
    canvas.addEventListener('pointerleave', this.handleCanvasPointerLeave);
    canvas.addEventListener('pointerdown', this.handleCanvasPointerDown);
    container.appendChild(canvas);
    // §5: toggle the debug telemetry overlay with Shift+D while the world is focused.
    canvas.addEventListener('keydown', this.handleDebugKey);
    (window as any).__worldToggleDebug = () => this.toggleDebugOverlay();
    
    // Viewport with touch support
    this.viewport = new Viewport({
      screenWidth: width,
      screenHeight: height,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
      interaction: this.app.renderer.plugins.interaction,
      passiveWheel: false, // Required for mobile touch wheel emulation
      stopPropagation: true,
      disableOnContextMenu: true,
    });
    this.viewport
      .drag({ pressDrag: true })  // Enable drag with touch press
      .pinch({ noDrag: false })   // Enable pinch zoom with simultaneous drag
      .wheel({ smooth: 3 })       // Smooth wheel zoom
      .decelerate({ friction: 0.95 })
      .clampZoom({ minScale: MIN_ZOOM, maxScale: MAX_ZOOM });
    this.app.stage.addChild(this.viewport);

    // Eagerly load the per-backend robot-ninja PNG sprites (idempotent) so they
    // are ready by the time agents first draw in galactic mode.
    if (isGalactic()) void loadAgentSprites();
    preloadProviderLogos();

    // Parallax starfield sits on the stage BEHIND the viewport
    if (isGalactic()) {
      this.starfield = new Starfield(this.app.renderer, width, height);
      this.app.stage.addChildAt(this.starfield.container, 0);
    }

    // Layers — labels render ABOVE the world so signage is never occluded
    this.backgroundLayer = new PIXI.Container();
    this.nodeLayer = new PIXI.Container();
    this.nodeLayer.sortableChildren = true;
    this.effectsLayer = new PIXI.Container();
    this.labelLayer = new PIXI.Container();
    this.labelLayer.sortableChildren = true;
    this.toolBubbleLayer = new PIXI.Container();
    this.tooltipLayer = new PIXI.Container();
    this.uiLayer = new PIXI.Container();

    // Phase 4 §persistent cosmetics — apply the saved accent before the bake.
    this.restorePersistedAccent();
    // Draw background
    this.drawBackground(WORLD_WIDTH, WORLD_HEIGHT);
    this.atrium_installLayer();

    // Tooltip
    this.tooltip = new Tooltip();
    this.tooltipLayer.addChild(this.tooltip.container);

    this.viewport.addChild(
      this.backgroundLayer,
      this.nodeLayer,
      this.effectsLayer,
      this.labelLayer,
      this.toolBubbleLayer,
      this.tooltipLayer,
    );

    // UI
    this.buildChrome();
    this.app.stage.addChild(this.uiLayer);
    this.applyLabelVisibility();
    
    // Start centered
    this.viewport.moveCenter(800, 600);
    
    // Event handlers
    this.handleResize = this.handleResize.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('keydown', this.handleKeydown);
    window.addEventListener('focus', this.handleWindowFocus, { passive: true });
    window.addEventListener('blur', this.handleWindowBlur, { passive: true });

    // Perf: stop animating the world when it scrolls out of the viewport.
    if (typeof IntersectionObserver !== "undefined") {
      this.visibilityObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.target === container) {
            this.offscreen = !e.isIntersecting;
            this.updateTickerState();
          }
        }
      }, { threshold: 0 });
      this.visibilityObserver.observe(container);
    }

    // Animation loop
    this.app.ticker.add((delta) => this.animate(delta));

    // Pause the Pixi ticker when the document is hidden (wall window off-screen).
    // animate() already guards with document.hidden, but the ticker still fires
    // every vsync without this; stopping it eliminates that overhead entirely.
    //
    // NOTE: never call WEBGL_lose_context.loseContext() here as a "free GPU
    // memory while hidden" trick. Pixi's ContextSystem restores the context on
    // the very next tick, and every generateTexture()-baked RenderTexture
    // (floors, furniture, starfield) comes back BLANK — the map lost all its
    // styling after ~60s idle until a full page refresh.
    this._visHandler = () => {
      if (this.destroyed) return;
      this.updateTickerState();
    };
    document.addEventListener('visibilitychange', this._visHandler, { passive: true });
    this.updateTickerState();

    // The browser can still drop the context on its own (GPU reset, too many
    // live contexts, long background). Pixi re-creates GL state for
    // image/Graphics/Text resources, but baked RenderTextures have no CPU-side
    // source — re-bake the world once Pixi's own restore has run.
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);

    // Cinematic camera engine (drone orbit + origin-story intro + clip capture).
    if (isGalactic()) this.installCinematicCamera();

    // Phase 4 fidelity pass — opt-in (window.__worldFidelity) cinematic grade.
    (window as any).__worldToggleFidelity = (on?: boolean) => this.toggleFidelityPass(on);
    if (isGalactic() && (window as any).__worldFidelity === true) this.toggleFidelityPass(true);
    // Phase 4 §federation galaxy — convenience hook to fly out to the galaxy tier.
    (window as any).__worldZoomToGalaxy = () => this.zoomToGalaxy();

    // Cozy theme streams ToffeeCraft sprites; galactic bakes everything up front
    if (!isGalactic()) {
      this.loadTextures();
    }
  }

  /**
   * Phase 4 §federation galaxy — detect the interstellar zoom tier and re-skin the
   * federation for it: bridges between nodes become bright "trade routes" and the
   * galaxy flag is published (FX/emote layers already LOD their detail down via
   * __agentFxZoom). Hysteresis on the zoom band prevents flicker at the boundary.
   */
  private updateGalaxyLOD(): void {
    const z = this.viewport.scale.x;
    const next = this.galaxyActive ? z < GALAXY_ZOOM_EXIT : z < GALAXY_ZOOM_ENTER;
    if (next !== this.galaxyActive) {
      this.galaxyActive = next;
      (window as any).__worldGalaxy = next;
      // Brighten inter-node bridges into "interstellar trade routes" when far out.
      this.bridges.forEach((b) => {
        b.alpha = next ? 1 : 0.55;
      });
    }
  }

  /** Public: fly the camera all the way out to the interstellar tier, framing
   *  every federation node as a station in the galaxy. */
  zoomToGalaxy(): void {
    try {
      this.cameraFlyTo(800, 600, Math.max(MIN_ZOOM, GALAXY_ZOOM_ENTER - 0.06), 1400);
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Phase 4 §fidelity — toggle the WebGL cinematic color-grade over the world.
   * Builds a ColorMatrixFilter (slight contrast + saturation + cool shadow lift)
   * and applies it to the viewport. Off by default; the heavy full-viewport pass
   * only runs when explicitly enabled (perf-gated per the plan's staging).
   */
  toggleFidelityPass(force?: boolean): void {
    const want = typeof force === "boolean" ? force : !this.fidelityFilter;
    if (want === !!this.fidelityFilter) return;
    try {
      if (want) {
        const ColorMatrix = (PIXI as any).filters?.ColorMatrixFilter;
        if (!ColorMatrix) return;
        const cm = new ColorMatrix();
        cm.contrast(0.12, true);
        cm.saturate(0.18, true);
        cm.brightness(1.02, true);
        this.fidelityFilter = cm as PIXI.Filter;
        this.viewport.filters = [this.fidelityFilter];
        (window as any).__worldFidelity = true;
      } else {
        this.viewport.filters = [];
        this.fidelityFilter = null;
        (window as any).__worldFidelity = false;
      }
    } catch (err) {
      console.warn("[ActivityMap] fidelity pass toggle failed:", err);
      this.fidelityFilter = null;
    }
  }

  /** Wire the cinematic camera engine to this map and publish window.cinematicCamera.
   *  Drives Phase-2 auto-drone, the Phase-4 origin-story intro, and recordCinematic
   *  clip capture. All deps are lazy callbacks, so it tolerates the async station. */
  private installCinematicCamera(): void {
    if (this.cinematicCam) return;
    try {
      this.cinematicCam = new CinematicCamera({
        now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
        flyTo: (x, y, scale, timeMs) => this.cameraFlyTo(x, y, scale, timeMs),
        worldBounds: () => {
          const b = this.station?.bounds;
          return b ? { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY } : null;
        },
        agentPositions: () => {
          const out: Array<{ id: string; x: number; y: number }> = [];
          for (const sk of this.agentToNode.keys()) {
            const p = this.agentWorldPos(sk);
            if (p) out.push({ id: sk, x: p.x, y: p.y });
          }
          return out;
        },
        lastActivityAt: () => this.worldLastActivityAt,
        recordElement: () => this.canvas,
        director: null,
      });
      this.cinematicCam.install();
      // Phase 4 §origin-story — fly in from orbit the first time the world opens
      // each day. Runs after the station has had a moment to build.
      this.maybePlayOriginIntro();
    } catch (err) {
      console.warn("[ActivityMap] cinematic camera failed to install:", err);
      this.cinematicCam = null;
    }
  }

  /** Phase 4 §origin-story intro flight: on the first world-open of the day, push
   *  the camera far out then glide down to the hub. Guarded once-per-day via
   *  localStorage. A pointer/scroll/key interrupt cancels it (viewport.animate
   *  removeOnInterrupt), so it never traps the user. */
  private maybePlayOriginIntro(): void {
    let firstToday = true;
    try {
      const key = "infinibot-world-origin-intro";
      const today = new Date().toISOString().slice(0, 10);
      if (typeof localStorage !== "undefined") {
        firstToday = localStorage.getItem(key) !== today;
        if (firstToday) localStorage.setItem(key, today);
      }
    } catch {
      /* storage blocked — just skip the intro rather than replay it every load */
      firstToday = false;
    }
    if (!firstToday) return;
    // Snap far out immediately, then fly down to the hub over ~3.4s.
    try {
      this.viewport.plugins.remove("animate");
      this.viewport.moveCenter(800, 600);
      this.viewport.setZoom(Math.max(MIN_ZOOM, 0.34), true);
      // Let the first frame settle, then ease in.
      setTimeout(() => this.cameraFlyTo(800, 600, 0.92, 3400), 220);
    } catch {
      /* non-fatal: a failed intro must not block the world */
    }
  }
  
  /** (Re)build screen-space chrome: zoom buttons, minimap, HUD, theme picker. */
  private buildChrome(): void {
    const width = this.viewport.screenWidth;
    const height = this.viewport.screenHeight;

    this.uiLayer.removeChildren().forEach(child => child.destroy({ children: true }));

    if (isGalactic()) {
      // Cinematic overlay (scanlines + vignette + god-ray) is OPT-IN — was previously
      // always-on for Galactic mode and obscured the iso map. Toggle via
      // `window.__cinematicOverlay = true` (or `?cinematic=1` query) before mount.
      const cinematicOptIn =
        (window as unknown as { __cinematicOverlay?: boolean }).__cinematicOverlay === true ||
        new URLSearchParams(window.location.search).get("cinematic") === "1";
      if (cinematicOptIn) {
        // Cinematic overlay sits UNDER the HUD chrome so its text stays crisp.
        this.cinematic = new CinematicOverlay(width, height, prefersReducedMotion());
        this.uiLayer.addChild(this.cinematic.container);
      }

      this.hud = new HudOverlay(width, height);
      this.hud.setMetricsPanelVisible(!this.hudPanelHidden);
      this.uiLayer.addChild(this.hud.container);
    }

    this.uiControls = new UIControls(action => this.handleUIAction(action), {
      width,
      height,
      labelsHidden: this.labelsHidden,
    });
    this.uiLayer.addChild(this.uiControls.container);

    this.minimap = new Minimap();
    this.minimap.container.x = width - 150;
    this.minimap.container.y = 10;
    this.minimap.container.visible = !this.topRightChromeHidden;
    this.uiLayer.addChild(this.minimap.container);

    if (isGalactic()) {
      this.themePicker = new ThemePicker(ACCENT_PRESETS, GALACTIC.gold, color => this.setAccent(color));
      this.themePicker.container.position.set(width - 150, 122);
      this.themePicker.container.visible = !this.topRightChromeHidden;
      this.uiLayer.addChild(this.themePicker.container);
    }
  }

  private async loadTextures(): Promise<void> {
    try {
      console.log('[ActivityMap] Loading cozy room textures...');
      await loadCozyRoomAssets();
      console.log('[ActivityMap] Textures loaded! Rebuilding rooms...');
      // Rebuild all agent rooms now that textures are loaded
      this.rebuildAllRooms();
    } catch (err) {
      console.warn('[ActivityMap] Failed to load textures:', err);
    }
  }
  
  private rebuildAllRooms(): void {
    // Rebuild each agent room with proper sprites now that textures are loaded
    for (const nodeArea of this.nodes.values()) {
      for (const agentRoom of nodeArea.rooms.values()) {
        agentRoom.rebuildWithTextures();
      }
    }
  }
  
  private drawBackground(worldWidth: number, worldHeight: number): void {
    if (isGalactic()) {
      // Station complex centered on the initial view
      this.station = buildStationComplex(this.app.renderer, {
        centerX: 800,
        centerY: 600,
        onZoneClick: this.options.onZoneClick,
      });
      this.backgroundLayer.addChild(this.station.container);
      this.labelLayer.addChild(this.station.labelLayer);
      this.installDistrict(); // Plugin District ring around the core station
      this.installFloorPulse(); // Phase 1 §4: volumetric pulsing ground grid
      this.installDistrictAccents(); // Phase 1: faint per-district ground tint + border
      this.installIslandAuras(); // Mesh plan: animated, activity-driven island borders
      this.applyLabelVisibility();
      // Replay any node adds that arrived during the construction race.
      if (this.pendingGalacticNodes.length > 0) {
        const queued = this.pendingGalacticNodes;
        this.pendingGalacticNodes = [];
        for (const n of queued) this.addNode(n);
      }
      return;
    }

    const g = new PIXI.Graphics();

    // Sky gradient
    g.beginFill(COLORS.bg);
    g.drawRect(0, 0, worldWidth, worldHeight);
    g.endFill();
    
    // Floor pattern (simple checkerboard)
    const tileSize = 64;
    for (let y = 0; y < worldHeight; y += tileSize) {
      for (let x = 0; x < worldWidth; x += tileSize) {
        const color = ((x + y) / tileSize) % 2 === 0 ? 0xc4a574 : 0xa88b5a;
        g.beginFill(color, 0.3);
        g.drawRect(x, y, tileSize, tileSize);
        g.endFill();
      }
    }
    
    this.backgroundLayer.addChild(g);
  }

  /**
   * Phase 1 §4 — build the volumetric pulsing ground grid: a single additive grid
   * of accent lines centered on the station, drawn once. Its brightness (the
   * container alpha) is modulated every frame in updateFloorPulse() so the floor
   * literally breathes faster/brighter when the fleet is busy. No per-frame redraw.
   */
  private installFloorPulse(): void {
    if (this.floorPulse) {
      this.floorPulse.destroy();
      this.floorPulse = null;
    }
    const g = new PIXI.Graphics();
    const accent = isGalactic() ? (GALACTIC.accent2 ?? GALACTIC.gold ?? 0x38bdf8) : 0x38bdf8;
    const half = 1400;
    const step = 80;
    g.lineStyle(1, accent, 0.5);
    for (let x = -half; x <= half; x += step) {
      g.moveTo(800 + x, 600 - half);
      g.lineTo(800 + x, 600 + half);
    }
    for (let y = -half; y <= half; y += step) {
      g.moveTo(800 - half, 600 + y);
      g.lineTo(800 + half, 600 + y);
    }
    (g as unknown as { blendMode: number }).blendMode = PIXI.BLEND_MODES.ADD;
    g.alpha = 0.05;
    g.zIndex = -5; // behind rooms/agents, above the station base fill
    // Insert just above the station so it overlays the floor, below everything else.
    this.backgroundLayer.addChild(g);
    this.floorPulse = g;
  }

  /** Modulate the floor pulse from window.__worldActivity (0..1). Cheap: only
   *  touches alpha. Idle world ≈ slow faint breath; busy fleet ≈ faster, brighter. */
  private updateFloorPulse(dtSeconds: number): void {
    if (!this.floorPulse) return;
    const activity = Math.max(0, Math.min(1, (window as any).__worldActivity ?? 0));
    // Speed: 0.6 rad/s idle → 2.4 rad/s busy. Amplitude + base brighten with load.
    this.floorPulsePhase += dtSeconds * (0.6 + 2.0 * activity);
    const wave = 0.5 + 0.5 * Math.sin(this.floorPulsePhase);
    const base = 0.04 + 0.10 * activity;
    const amp = 0.05 + 0.16 * activity;
    this.floorPulse.alpha = base + amp * wave;
  }

  private handleDebugKey = (e: KeyboardEvent): void => {
    if (e.key === "D" && e.shiftKey) {
      e.preventDefault();
      this.toggleDebugOverlay();
    }
  };

  /** Show/hide the §5 debug telemetry overlay. Public so the HUD chrome and the
   *  test harness can flip it (also wired to window.__worldToggleDebug). */
  toggleDebugOverlay(force?: boolean): void {
    this.debugEnabled = typeof force === "boolean" ? force : !this.debugEnabled;
    if (this.debugEnabled) {
      if (!this.debugOverlay) {
        const el = document.createElement("div");
        el.style.cssText = [
          "position:absolute",
          "top:8px",
          "left:8px",
          "z-index:50",
          "padding:6px 9px",
          "border-radius:8px",
          "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
          "color:#9ff7c7",
          "background:rgba(6,9,16,0.82)",
          "border:1px solid rgba(120,200,160,0.28)",
          "pointer-events:none",
          "white-space:pre",
          "letter-spacing:0.02em",
        ].join(";");
        this.container.appendChild(el);
        this.debugOverlay = el;
      }
      this.debugOverlay.style.display = "block";
    } else if (this.debugOverlay) {
      this.debugOverlay.style.display = "none";
    }
  }

  /** Per-frame telemetry sample. Cheap; only mutates one textContent every ~10
   *  frames. Reports the metrics the §5 plan calls for: FPS, agent/node counts,
   *  total display objects (draw-call proxy), frame cost (EMA ms), dropped frames. */
  private updateDebugOverlay(frameMs: number): void {
    // Dropped-frame accounting runs even when the overlay is hidden so the count
    // is meaningful the instant it's shown.
    if (frameMs > 32) this.droppedFrames++;
    this.frameMsEMA = this.frameMsEMA === 0 ? frameMs : this.frameMsEMA * 0.9 + frameMs * 0.1;
    if (!this.debugEnabled || !this.debugOverlay) return;
    if (this.animationFrame % 10 !== 0) return;
    const fps = this.app?.ticker ? Math.round(this.app.ticker.FPS) : 0;
    const objects =
      this.backgroundLayer.children.length +
      this.nodeLayer.children.length +
      this.effectsLayer.children.length +
      this.labelLayer.children.length +
      this.uiLayer.children.length;
    const fx = Array.isArray((window as any).__agentFxState) ? (window as any).__agentFxState.length : 0;
    const activity = Math.round((((window as any).__worldActivity ?? 0) as number) * 100);
    this.debugOverlay.textContent =
      `▢ MESH TELEMETRY\n` +
      `fps        ${fps}\n` +
      `frame      ${this.frameMsEMA.toFixed(1)} ms\n` +
      `dropped    ${this.droppedFrames}\n` +
      `nodes      ${this.nodes.size}\n` +
      `agents     ${this.agentToNode.size}\n` +
      `fx feed    ${fx}\n` +
      `objects    ${objects}\n` +
      `activity   ${activity}%`;
  }

  private atrium_installLayer(): void {
    if (!this.atrium_layer || (this.atrium_layer as any).destroyed) {
      this.atrium_layer = new PIXI.Container();
      this.atrium_layer.sortableChildren = true;
      this.atrium_conduitLayer = new PIXI.Container();
      this.atrium_coreGlow = new PIXI.Graphics();
      this.atrium_glyphLayer = new PIXI.Container();
      this.atrium_conduitLayer.zIndex = 5;
      this.atrium_coreGlow.zIndex = 10;
      this.atrium_glyphLayer.zIndex = 20;
      (this.atrium_coreGlow as any).blendMode = PIXI.BLEND_MODES.ADD;
      this.atrium_layer.addChild(this.atrium_conduitLayer, this.atrium_coreGlow, this.atrium_glyphLayer);
    }

    if (this.atrium_layer.parent) {
      this.atrium_layer.parent.removeChild(this.atrium_layer);
    }

    this.atrium_ringWrap = null;
    if (isGalactic() && this.station) {
      const ringIndex = this.atrium_findRingIndex();
      this.station.container.addChildAt(this.atrium_layer, Math.max(0, ringIndex));
      this.atrium_ringWrap = this.station.container.children[ringIndex + 1] instanceof PIXI.Container
        ? this.station.container.children[ringIndex + 1] as PIXI.Container
        : this.atrium_findRingWrap();
    } else {
      this.effectsLayer.addChildAt(this.atrium_layer, 0);
    }

    this.atrium_conduits.forEach((state) => {
      if (!state.container.parent) this.atrium_conduitLayer?.addChild(state.container);
      state.drawProgress = Math.min(state.drawProgress, 1);
      this.atrium_updateConduitAnchor(state);
      this.atrium_drawConduit(state);
    });
    this.atrium_glyphs.forEach((glyph) => {
      if (!glyph.container.parent) this.atrium_glyphLayer?.addChild(glyph.container);
    });
  }

  private atrium_findRingIndex(): number {
    if (!this.station) return 0;
    const ring = this.atrium_findRingWrap();
    return ring ? Math.max(0, this.station.container.getChildIndex(ring)) : this.station.container.children.length;
  }

  private atrium_findRingWrap(): PIXI.Container | null {
    if (!this.station) return null;
    const atrium = this.station.atriumCenter;
    for (const child of this.station.container.children) {
      if (!(child instanceof PIXI.Container)) continue;
      if (Math.abs(child.x - atrium.x) > 0.5 || Math.abs(child.y - atrium.y) > 0.5) continue;
      if (Math.abs(child.scale.y - 0.5) > 0.01 || child.children.length < 2) continue;
      return child;
    }
    return null;
  }

  private atrium_center(): PIXI.Point {
    return this.station?.atriumCenter ?? new PIXI.Point(800, 600);
  }

  private atrium_now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private atrium_shortId(value: string): string {
    return value.length <= 10 ? value : `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  private atrium_sanitizeGlyphText(text: string, fallback: string): string {
    const clean = (text || fallback).replace(/[\r\n\t]+/g, ' ').trim();
    return (clean || fallback).slice(0, 12);
  }

  private atrium_conduitKey(kind: AtriumConduitKind, peerId: string): string {
    return `${kind}:${peerId}`;
  }

  private atrium_findConduit(peerId: string): AtriumConduitState | undefined {
    return this.atrium_conduits.get(peerId)
      ?? this.atrium_conduits.get(this.atrium_conduitKey('fed', peerId))
      ?? this.atrium_conduits.get(this.atrium_conduitKey('ssh', peerId));
  }

  private atrium_makeConduit(
    kind: AtriumConduitKind,
    peerId: string,
    opts: { displayName?: string; angle?: number; host?: string } = {},
  ): AtriumConduitState {
    this.atrium_installLayer();
    const key = this.atrium_conduitKey(kind, peerId);
    const container = new PIXI.Container();
    container.sortableChildren = true;
    const line = new PIXI.Graphics();
    const label = new PIXI.Graphics();
    const sparkle = new PIXI.Graphics();
    line.zIndex = 0;
    sparkle.zIndex = 1;
    label.zIndex = 2;
    container.addChild(line, sparkle, label);
    this.atrium_conduitLayer?.addChild(container);

    const state: AtriumConduitState = {
      key,
      peerId,
      kind,
      host: opts.host,
      displayName: opts.displayName,
      angle: opts.angle,
      active: true,
      container,
      line,
      label,
      sparkle,
      anchor: new PIXI.Point(),
      drawProgress: 0,
      disconnectedUntil: 0,
      pulsePower: 0,
      failUntil: 0,
      sparkleUntil: this.atrium_now() + ATRIUM_CONDUIT_DRAW_MS,
    };
    this.atrium_conduits.set(key, state);
    this.atrium_updateConduitAnchor(state);
    this.atrium_drawConduit(state);
    return state;
  }

  private atrium_peerAngle(peerId: string, explicit?: number): number {
    if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
    return (hashString(peerId) / 0xffffffff) * Math.PI * 2;
  }

  private atrium_sectorCenter(sectorId: string): PIXI.Point | null {
    const zone = this.station?.zones.find(z => z.def.id === sectorId);
    return zone ? new PIXI.Point(zone.center.x, zone.center.y) : null;
  }

  private atrium_sshDockAnchor(): PIXI.Point {
    const dock = this.atrium_sectorCenter('ssh-dock') ?? this.atrium_sectorCenter('comms-deck');
    return dock ?? new PIXI.Point(800 + 512, 600 - 256);
  }

  private atrium_viewportEdgeAnchor(peerId: string, angle?: number): PIXI.Point {
    const center = this.atrium_center();
    const a = this.atrium_peerAngle(peerId, angle);
    const dx = Math.cos(a) || 0.0001;
    const dy = Math.sin(a) || 0.0001;
    const margin = 72 / Math.max(this.viewport.scale.x, 0.2);
    const left = this.viewport.left + margin;
    const right = this.viewport.right - margin;
    const top = this.viewport.top + margin;
    const bottom = this.viewport.bottom - margin;
    const candidates: number[] = [];
    if (dx > 0) candidates.push((right - center.x) / dx);
    else candidates.push((left - center.x) / dx);
    if (dy > 0) candidates.push((bottom - center.y) / dy);
    else candidates.push((top - center.y) / dy);
    const positive = candidates.filter(v => Number.isFinite(v) && v > 0);
    const t = Math.max(160, positive.length ? Math.min(...positive) : 600);
    return new PIXI.Point(center.x + dx * t, center.y + dy * t);
  }

  private atrium_updateConduitAnchor(state: AtriumConduitState): void {
    if (state.kind === 'ssh') {
      state.anchor.copyFrom(this.atrium_sshDockAnchor());
      return;
    }
    const node = this.nodes.get(state.peerId);
    if (node) {
      state.anchor.set(node.x, node.y);
      return;
    }
    const sector = this.atrium_sectorCenter(state.peerId);
    if (sector) {
      state.anchor.copyFrom(sector);
      return;
    }
    state.anchor.copyFrom(this.atrium_viewportEdgeAnchor(state.peerId, state.angle));
  }

  private atrium_mixColor(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
  }

  private atrium_drawConduit(state: AtriumConduitState): void {
    const now = this.atrium_now();
    const start = this.atrium_center();
    const end = state.anchor;
    const progress = Math.max(0, Math.min(1, state.drawProgress));
    const visibleEnd = new PIXI.Point(
      start.x + (end.x - start.x) * progress,
      start.y + (end.y - start.y) * progress,
    );
    const failing = now < state.failUntil;
    const disconnected = !state.active;
    const disconnectedPulse = disconnected && now < state.disconnectedUntil
      ? 0.03 + Math.sin(now / 420) * 0.02
      : 0;
    const baseAlpha = disconnected ? 0.05 : ATRIUM_CONDUIT_IDLE_ALPHA;
    const alpha = Math.min(0.9, Math.max(0, baseAlpha + state.pulsePower * 0.42 + disconnectedPulse));
    const lineColor = failing ? ATRIUM_FAIL : ATRIUM_GOLD;

    state.line.clear();
    const segments = 18;
    for (let i = 0; i < segments; i++) {
      const t0 = (i / segments) * progress;
      const t1 = ((i + 1) / segments) * progress;
      const x0 = start.x + (end.x - start.x) * t0;
      const y0 = start.y + (end.y - start.y) * t0;
      const x1 = start.x + (end.x - start.x) * t1;
      const y1 = start.y + (end.y - start.y) * t1;
      state.line.lineStyle(failing ? 2.4 : 1.6, failing ? ATRIUM_FAIL : this.atrium_mixColor(lineColor, ATRIUM_SKY, t0), alpha);
      state.line.moveTo(x0, y0);
      state.line.lineTo(x1, y1);
    }
    state.line.lineStyle(0);

    state.label.clear();
    const labelText = state.kind === 'ssh'
      ? `SSH ${this.atrium_shortId(state.host || state.peerId)}`
      : `PEER ${this.atrium_shortId(state.displayName || state.peerId)}`;
    const labelScale = Math.min(Math.max(1 / this.viewport.scale.x, 0.75), 2.4);
    const labelColor = disconnected ? ATRIUM_FAIL : ATRIUM_SKY;
    drawPixelText(state.label, labelText, 0, 0, labelColor, 2);
    state.label.scale.set(labelScale);
    state.label.alpha = disconnected && now >= state.disconnectedUntil ? 0 : 0.86;
    state.label.position.set(visibleEnd.x + 10 * labelScale, visibleEnd.y - 9 * labelScale);

    state.sparkle.clear();
    if (now < state.sparkleUntil) {
      const sparkleAlpha = Math.max(0, (state.sparkleUntil - now) / ATRIUM_CONDUIT_DRAW_MS);
      state.sparkle.lineStyle(1.5, ATRIUM_GOLD, sparkleAlpha);
      state.sparkle.moveTo(visibleEnd.x - 8, visibleEnd.y);
      state.sparkle.lineTo(visibleEnd.x + 8, visibleEnd.y);
      state.sparkle.moveTo(visibleEnd.x, visibleEnd.y - 8);
      state.sparkle.lineTo(visibleEnd.x, visibleEnd.y + 8);
      state.sparkle.lineStyle(0);
      state.sparkle.beginFill(ATRIUM_GOLD, sparkleAlpha * 0.45);
      state.sparkle.drawCircle(visibleEnd.x, visibleEnd.y, 6 + sparkleAlpha * 6);
      state.sparkle.endFill();
    }
  }

  private atrium_createGlyph(): AtriumGlyph {
    const container = new PIXI.Container();
    const echoes: PIXI.Graphics[] = [];
    for (let i = 0; i < 4; i++) {
      const echo = new PIXI.Graphics();
      echo.alpha = 0.22 - i * 0.04;
      container.addChild(echo);
      echoes.push(echo);
    }
    const text = new PIXI.Graphics();
    container.addChild(text);
    return {
      container,
      text,
      echoes,
      active: false,
      conduitKey: '',
      from: new PIXI.Point(),
      to: new PIXI.Point(),
      elapsedMs: 0,
      durationMs: 1,
    };
  }

  private atrium_spawnGlyph(state: AtriumConduitState, kind: AtriumPulseKind, text: string): void {
    this.atrium_installLayer();
    const glyph = this.atrium_glyphPool.pop() ?? this.atrium_createGlyph();
    const start = this.atrium_center();
    const end = state.anchor.clone();
    const outbound = kind === 'send' || kind === 'command';
    glyph.from.copyFrom(outbound ? start : end);
    glyph.to.copyFrom(outbound ? end : start);
    glyph.elapsedMs = 0;
    glyph.durationMs = Math.max(180, (Math.hypot(glyph.to.x - glyph.from.x, glyph.to.y - glyph.from.y) / ATRIUM_GLYPH_SPEED) * 1000);
    glyph.conduitKey = state.key;
    glyph.active = true;
    glyph.container.visible = true;
    glyph.container.alpha = 1;
    glyph.text.clear();
    const color = kind === 'ack' ? 0x86efac : kind === 'fail' ? ATRIUM_FAIL : ATRIUM_GOLD;
    drawPixelText(glyph.text, text, 0, 0, color, 2);
    for (const echo of glyph.echoes) {
      echo.clear();
      drawPixelText(echo, text, 0, 0, color, 2);
    }
    this.atrium_glyphLayer?.addChild(glyph.container);
    this.atrium_glyphs.push(glyph);
    while (this.atrium_glyphs.length > ATRIUM_MAX_GLYPHS) {
      const old = this.atrium_glyphs.shift();
      if (old) this.atrium_recycleGlyph(old);
    }
  }

  private atrium_recycleGlyph(glyph: AtriumGlyph): void {
    glyph.active = false;
    glyph.container.visible = false;
    if (glyph.container.parent) glyph.container.parent.removeChild(glyph.container);
    if (this.atrium_glyphPool.length < ATRIUM_MAX_GLYPHS) this.atrium_glyphPool.push(glyph);
    else glyph.container.destroy({ children: true });
  }

  private atrium_updateGlyphs(deltaMS: number): void {
    for (let i = this.atrium_glyphs.length - 1; i >= 0; i--) {
      const glyph = this.atrium_glyphs[i];
      glyph.elapsedMs += deltaMS;
      const t = Math.min(1, glyph.elapsedMs / glyph.durationMs);
      const dx = glyph.to.x - glyph.from.x;
      const dy = glyph.to.y - glyph.from.y;
      glyph.container.position.set(glyph.from.x + dx * t, glyph.from.y + dy * t);
      glyph.container.alpha = t > 0.82 ? Math.max(0, (1 - t) / 0.18) : 1;
      const angle = Math.atan2(dy, dx);
      glyph.container.rotation = angle;
      const inv = Math.min(Math.max(1 / this.viewport.scale.x, 0.7), 2.2);
      glyph.container.scale.set(inv);
      for (let e = 0; e < glyph.echoes.length; e++) {
        glyph.echoes[e].position.set(-(e + 1) * 8, 0);
        glyph.echoes[e].alpha = (0.24 - e * 0.045) * (1 - t * 0.4);
      }
      if (t >= 1) {
        const conduit = this.atrium_conduits.get(glyph.conduitKey);
        if (conduit) conduit.pulsePower = Math.min(1.7, conduit.pulsePower + 0.8);
        this.atrium_glyphs.splice(i, 1);
        this.atrium_recycleGlyph(glyph);
      }
    }
  }

  private atrium_update(deltaMS: number): void {
    if (!this.atrium_layer || !this.atrium_coreGlow) return;
    this.atrium_elapsedMs += deltaMS;
    this.atrium_surgePower = Math.max(0, this.atrium_surgePower - deltaMS / ATRIUM_SURGE_MS);
    this.atrium_ringSurgePower = Math.max(0, this.atrium_ringSurgePower - deltaMS / ATRIUM_SURGE_MS);

    const breath = (Math.sin((this.atrium_elapsedMs / 1000) * Math.PI * 2 * ATRIUM_CORE_BREATH_HZ) + 1) / 2;
    const baseAlpha = ATRIUM_CORE_MIN_ALPHA + (ATRIUM_CORE_MAX_ALPHA - ATRIUM_CORE_MIN_ALPHA) * breath;
    const alpha = Math.min(0.95, baseAlpha + this.atrium_surgePower * 0.36);
    const radius = ATRIUM_CORE_BASE_RADIUS * (1 + this.atrium_surgePower * 0.3);
    const center = this.atrium_center();
    // Central gold halo removed per design — the rotating ring + conduits
    // carry the atrium's visual energy without the heavy core glow.
    this.atrium_coreGlow.clear();
    // Reference the values so the breathing math isn't flagged as unused.
    void alpha; void radius; void center;

    // Surge = spin the ring FASTER, not tilt it. The wrap carries the iso
    // foreshorten (scale.y = 0.5); rotating it directly sheared the ring
    // off-axis (Pixi applies scale-then-rotation, so a y-squashed circle
    // rotates into a tilted ellipse, and the `+=` left it permanently
    // off-axis after a burst). Instead, speed up the flat GSAP spin that
    // lives on the inner rings (which sit inside the foreshorten), keeping
    // the ring coplanar with the floor.
    if (this.atrium_ringWrap) {
      this.atrium_ringWrap.rotation = 0;
      const surgeScale = 1 + this.atrium_ringSurgePower * 1.5;
      for (const child of this.atrium_ringWrap.children) {
        const tw = gsap.getTweensOf(child)[0];
        if (tw) tw.timeScale(surgeScale);
      }
    }

    const now = this.atrium_now();
    this.atrium_conduits.forEach((state) => {
      if (!state.active && now >= state.disconnectedUntil) {
        state.container.visible = false;
        return;
      }
      state.container.visible = true;
      state.pulsePower = Math.max(0, state.pulsePower - deltaMS / ATRIUM_CONDUIT_PULSE_MS);
      if (state.drawProgress < 1) state.drawProgress = Math.min(1, state.drawProgress + deltaMS / ATRIUM_CONDUIT_DRAW_MS);
      this.atrium_updateConduitAnchor(state);
      this.atrium_drawConduit(state);
    });
    this.atrium_updateGlyphs(deltaMS);
  }
  
  private handleResize(): void {
    const width = this.options.width || this.container.clientWidth || 800;
    const height = this.options.height || this.container.clientHeight || 500;
    this.resize(width, height);
  }
  
  private handleKeydown(e: KeyboardEvent): void {
    if (!this.isMapKeyboardActive() || this.isEditableKeyTarget(e.target)) return;

    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      this.zoomIn();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      this.zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      this.zoomToFit();
    }
    else if (e.key === 'Home') this.centerView();
  }

  private isMapKeyboardActive(): boolean {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    return this.pointerInsideCanvas || active === this.canvas || (active instanceof Node && this.container.contains(active));
  }

  private isEditableKeyTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  }
  
  private handleUIAction(action: string): void {
    if (action === 'zoomIn') this.zoomIn();
    else if (action === 'zoomOut') this.zoomOut();
    else if (action === 'fitAll') this.zoomToFit();
    else if (action === 'toggleLabels') this.toggleLabels();
    else if (action === 'center') this.centerView();
  }
  
  private animate(delta = 1): void {
    // Skip rendering when tab is hidden or the map is scrolled offscreen.
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.offscreen) return;
    // Throttle to ~30fps while the window is blurred — the user isn't looking.
    if (this.windowBlurred) {
      const now = typeof performance !== "undefined" && performance.now ? performance.now() : 0;
      if (now - this.lastRenderMS < 33) return;
      this.lastRenderMS = now;
    }
    const frameStart =
      typeof performance !== "undefined" && performance.now ? performance.now() : 0;
    try {
      const dt = delta / 60;
      this.animationFrame++;

      // Parallax + twinkle
      this.starfield?.update(this.viewport);

      // Phase 1 §4: volumetric ground-grid breath, scaled by system activity.
      this.updateFloorPulse(dt);

      // Mesh plan — animated island borders. Cheap re-sampling of live agent
      // occupancy/status every ~15 frames; per-frame stroke/shimmer/mote tick.
      if (this.animationFrame % 15 === 0) this.refreshIslandActivity();
      this.updateIslandAuras(dt);

      // Counter-scale labels so they stay readable at any zoom
      if (isGalactic() && this.station) {
        const deltaMS = this.app.ticker.elapsedMS;
        const inv = Math.min(Math.max(1 / this.viewport.scale.x, 0.7), 2.2);
        for (const child of this.station.labelLayer.children) {
          child.scale.set(inv);
        }
        this.station.updateLabelAlphas(deltaMS);
        if (this.district) {
          for (const child of this.district.labelLayer.children) child.scale.set(inv);
          this.district.updateLabelAlphas(deltaMS);
          this.district.setZoom(this.viewport.scale.x);
        }
        this.applyChromeOcclusion();
        this.nodes.forEach(node => {
          node.applyLabelScale(inv);
          node.updateLabelAlpha(deltaMS);
        });
        this.atrium_update(deltaMS);
        this.cinematic?.update(deltaMS);
        this.updateGalaxyLOD();
      }

      // HUD status readout + live metrics panel
      if (this.hud && this.animationFrame % 30 === 0) {
        this.hud.setStats(`NODES ${this.nodes.size}  ·  AGENTS ${this.agentToNode.size}  ·  SECTORS ${SECTORS_CORE_COUNT + (this.district?.size() ?? 0)}`);
        this.hud.setMetrics(this.computeHudMetrics());
      }

      // Live walk-trail particles for agents en route to tool sectors
      this.updateWalkTrails();

      // Animate all rooms — OR, in replay mode, freeze live motion and force
      // each sprite to its interpolated historical position from the ring buffer.
      if (this.replayActive) {
        this.applyReplayFrame(this.replayTargetT);
        // Positions are now pinned to the historical frame — re-fire any tool /
        // dialogue / completion events the scrub just crossed so the world's
        // *activity* replays, not just its ambient FX.
        this.emitReplayEvents(this.replayTargetT);
      } else {
        const viewZoom = this.viewport.scale.x;
        this.nodes.forEach(node => node.animateRooms(dt, viewZoom));
        if (isGalactic() && this.station) {
          this.spread.frame(dt, this.animationFrame, performance.now());
          this.updateDistrictFx(dt);
        }
      }

      // Tool-call chat bubbles: follow their agent, stack, drift, fade, expire
      if (this.toolBubbles.size > 0) this.updateToolBubbles();
      this.updateAgentOverlays();

      // Update minimap
      if (this.animationFrame % 20 === 0) {
        const agentRooms = new Map<string, AgentRoom>();
        this.nodes.forEach(node => {
          node.rooms.forEach((room, key) => agentRooms.set(key, room));
        });
        this.minimap.update(this.nodes, agentRooms, this.viewport);
      }

      // Reconcile the concourse rest area: resting agents that aren't on a bed
      // get routed to one; agents that woke (or moved off rest status) get freed.
      // A periodic pass covers initial bulk-load and post-placement timing that
      // a one-shot status hook can miss.
      if (!this.replayActive && this.animationFrame % 24 === 0) this.reconcileConcourse();

      // Record a 1 Hz world-space history sample (live only) and publish the
      // screen-space agent feed every frame (drives <agent-fx-layer>, emotes,
      // and the replay collector). agentWorldPos() already reflects the replayed
      // positions while scrubbing, so the FX feed stays in sync automatically.
      if (!this.replayActive) this.maybeRecordHistory();
      this.publishFxState();
      if (this.frameListeners.size) {
        const ms = this.app.ticker.elapsedMS;
        for (const fn of this.frameListeners) {
          // Isolated: an overlay bug must never break the engine's frame.
          try { fn(ms); } catch (err) {
            if (this.animationFrame % 600 === 0) console.warn('[ActivityMap] frame listener error:', err);
          }
        }
      }
    } catch (err) {
      console.error("[ActivityMap] animate error:", err);
    }
    // §5 debug telemetry — measured outside the try so a subsystem throw above
    // still records the (long) frame cost and increments the dropped counter.
    if (frameStart) {
      const drawMs = performance.now() - frameStart;
      this.updateDebugOverlay(drawMs);
      // Feed the ?perf=1 overlay (window.__hudPerf) — cheap, no-op when absent.
      try {
        const w = window as unknown as { __hudPerf?: Record<string, unknown> };
        const p = (w.__hudPerf = w.__hudPerf || {});
        p.drawMs = drawMs;
        p.agents = this.agentToNode.size;
        p.surface = `mesh ${this.nodes.size}n`;
      } catch { /* no window */ }
    }
  }

  setActive(active: boolean): void {
    if (this.panelActive === active) return;
    this.panelActive = active;
    this.updateTickerState();
  }

  private updateTickerState(): void {
    if (this.destroyed) return;
    const visible = typeof document === "undefined" || !document.hidden;
    const shouldRun = visible && this.panelActive && !this.offscreen;
    if (shouldRun) this.app.ticker.start();
    else this.app.ticker.stop();
    // Pixi's pointer hover hit-test rides the shared system ticker, not ours.
    const im = this.app.renderer.plugins.interaction as { useSystemTicker?: boolean } | undefined;
    if (im && im.useSystemTicker !== shouldRun) im.useSystemTicker = shouldRun;
  }

  // ══════════════════════════════════════════════════════════════
  // TIME-SCRUB REPLAY
  // ══════════════════════════════════════════════════════════════

  /** Publish the screen-space agent feed + zoom for FX overlays / replay collector. */
  private publishFxState(): void {
    try {
      const out: Array<{ id: string; x: number; y: number; status: string; backend?: string }> = [];
      for (const sk of this.agentToNode.keys()) {
        const p = this.agentWorldPos(sk);
        if (!p) continue;
        const s = this.viewport.toScreen(p.x, p.y);
        const room = this.roomOf(sk)?.room;
        const status = this.replayActive
          ? (this.replayStatusById.get(sk) ?? room?.data.status ?? "idle")
          : (room?.data.status ?? "idle");
        out.push({ id: sk, x: s.x, y: s.y, status, backend: room?.data.coderBackend });
      }
      (window as any).__agentFxState = out;
      (window as any).__agentFxZoom = this.viewport.scale.x;
    } catch {
      /* never let FX publication break the render loop */
    }
    // Sector drop-targets for <world-interactions> drag-to-assign. Sectors only
    // move on pan/zoom, so a 12-frame throttle keeps toScreen cost negligible.
    if (this.animationFrame % 12 === 0) this.publishWorldSectors();
  }

  /** Publish station sectors as host-relative screen rects so the Phase-3
   *  drag-to-assign layer can resolve a drop target. Each tool sector maps to a
   *  `kind` the spawn pre-fill reads ("kanban" sectors spawn a board task). */
  private publishWorldSectors(): void {
    try {
      if (!isGalactic() || !this.station) return;
      const sectors: Array<{ id: string; name: string; x: number; y: number; w: number; h: number; kind: string }> = [];
      for (const zone of this.station.zones) {
        const s = this.viewport.toScreen(zone.center.x, zone.center.y);
        // Half-extents scale with zoom so the hit-rect tracks the drawn building.
        const half = 70 * this.viewport.scale.x;
        sectors.push({
          id: zone.def.id,
          name: zone.def.name,
          x: s.x,
          y: s.y,
          w: half,
          h: half * 0.62, // iso foreshortening
          kind: SECTOR_DROP_KIND[zone.def.id] ?? "tool",
        });
      }
      for (const room of this.district?.list() ?? []) {
        const s = this.viewport.toScreen(room.center.x, room.center.y);
        const half = 70 * this.viewport.scale.x;
        sectors.push({ id: room.spec.id, name: room.spec.title, x: s.x, y: s.y, w: half, h: half * 0.62, kind: `plugin:${room.spec.pluginId}` });
      }
      (window as any).__worldSectors = sectors;
    } catch {
      /* sectors are optional — drag-to-assign degrades to no drop zones */
    }
  }

  /** Record one 1 Hz world-space snapshot of agents + active conduits. */
  private maybeRecordHistory(): void {
    const now = Date.now();
    if (now - this.replayLastSampleT < 1000) return;
    this.replayLastSampleT = now;
    const agents: ReplayAgentSample[] = [];
    for (const sk of this.agentToNode.keys()) {
      const p = this.agentWorldPos(sk);
      if (!p) continue;
      const room = this.roomOf(sk)?.room;
      agents.push({ id: sk, wx: p.x, wy: p.y, status: room?.data.status ?? "idle", backend: room?.data.coderBackend });
    }
    const conduits: ReplayConduitSample[] = [];
    this.atrium_conduits.forEach((s) => {
      if (s.active) conduits.push({ peerId: s.peerId, kind: s.kind, host: s.host, displayName: s.displayName, angle: s.angle });
    });
    this.replayHistory.push({ t: now, agents, conduits });
    const cutoff = now - this.replayCap * 1000;
    while (this.replayHistory.length && (this.replayHistory[0].t < cutoff || this.replayHistory.length > this.replayCap)) {
      this.replayHistory.shift();
    }
  }

  /**
   * Record one discrete world event (tool / dialogue / completion) for replay.
   * No-ops while replaying (those calls are re-emissions of the past, not new
   * live activity) and trims to the same retention window as the position ring.
   */
  private recordReplayEvent(ev: Omit<ReplayEventSample, "t">): void {
    if (this.replayActive) return;
    const now = Date.now();
    this.replayEvents.push({ t: now, ...ev });
    const cutoff = now - this.replayCap * 1000;
    while (
      this.replayEvents.length &&
      (this.replayEvents[0].t < cutoff || this.replayEvents.length > this.replayEventCap)
    ) {
      this.replayEvents.shift();
    }
  }

  /**
   * During replay, fire every event whose timestamp the scrub crossed since the
   * last applied frame. Smooth playback advances forward by a small step → emit
   * the half-open interval (prev, t]. A drag/seek jump (large or backward delta)
   * instead fires just the events at the landing moment once, so dragging the
   * handle past a busy span doesn't dump a burst of stale bubbles. A paused
   * frame (t unchanged) emits nothing.
   */
  private emitReplayEvents(t: number): void {
    const prev = this.replayEmitT;
    if (t === prev) return;
    const forward = t > prev;
    const gap = Math.abs(t - prev);
    if (forward && gap <= 4000) {
      for (const e of this.replayEvents) if (e.t > prev && e.t <= t) this.renderReplayEvent(e);
    } else {
      const lo = t - 1500;
      for (const e of this.replayEvents) if (e.t > lo && e.t <= t) this.renderReplayEvent(e);
    }
    this.replayEmitT = t;
  }

  /**
   * Render one recorded event through the SAME visual the live path uses. Runs
   * after applyReplayFrame() has already pinned room containers to their
   * historical positions, so bubbles/pulses/bursts land where the agent was.
   * If the agent's room no longer exists (despawned — ghost-room recreation is
   * deferred), skip it rather than crash.
   */
  private renderReplayEvent(e: ReplayEventSample): void {
    const found = this.roomOf(e.sessionKey);
    if (!found) return;
    if (e.kind === "tool" || e.kind === "dialogue") {
      this.showToolBubble(e.sessionKey, e.toolKind ?? "", e.label ?? "");
      if (e.kind === "tool" && isGalactic() && !prefersReducedMotion()) {
        const pos = found.room.getWorldAgentPosition(found.nodeArea.x, found.nodeArea.y);
        this.spawnPulseRing(pos.x, pos.y, ActivityMap.toolFamilyColor(e.toolKind ?? ""));
      }
    } else if (e.kind === "complete") {
      this.burstCompletion(e.sessionKey, e.success ?? true);
    }
  }

  /** Earliest/latest retained sample time + count (for scrubber bounds / empty-state). */
  getReplayRange(): { start: number; end: number; count: number } {
    const n = this.replayHistory.length;
    if (!n) return { start: 0, end: 0, count: 0 };
    return { start: this.replayHistory[0].t, end: this.replayHistory[n - 1].t, count: n };
  }

  isReplaying(): boolean {
    return this.replayActive;
  }

  /** Enter replay and pin the world to historical time `t` (epoch ms). No-op with empty history. */
  setReplayTime(t: number): void {
    if (!this.replayHistory.length) return;
    if (!this.replayActive) {
      this.replayActive = true;
      this.replayAppliedConduitT = -1;
      // Seed the emit cursor at the entry point so we don't dump the whole
      // event log the instant the user starts scrubbing.
      this.replayEmitT = t;
    }
    this.replayTargetT = t;
    this.applyReplayFrame(t);
  }

  /** Leave replay; rooms resume live self-animation on the next frame. */
  resumeLive(): void {
    if (!this.replayActive) return;
    this.replayActive = false;
    this.replayStatusById.clear();
    this.replayAppliedConduitT = -1;
    this.replayEmitT = 0;
    // Restore visibility of every live room hidden during replay.
    this.replayHidden.forEach((sk) => {
      const found = this.roomOf(sk);
      if (found) found.room.container.visible = true;
    });
    this.replayHidden.clear();
  }

  /** Force every agent sprite to its interpolated historical world position at `t`. */
  private applyReplayFrame(t: number): void {
    const h = this.replayHistory;
    if (!h.length) return;
    const tc = Math.max(h[0].t, Math.min(h[h.length - 1].t, t));
    let i = 0;
    while (i < h.length - 1 && h[i + 1].t <= tc) i++;
    const a = h[i];
    const b = h[Math.min(i + 1, h.length - 1)];
    const span = Math.max(1, b.t - a.t);
    const f = Math.max(0, Math.min(1, (tc - a.t) / span));
    const bById = new Map(b.agents.map((x) => [x.id, x] as const));
    const historicalIds = new Set(a.agents.map((x) => x.id));

    // Hide LIVE rooms only when the agent has NEVER appeared in the recorded
    // history (i.e. spawned after we started recording or after the scrubbed
    // window started). Without this guard, a freshly-spawned agent that isn't
    // in the bracketing sample yet would get hidden the instant the user
    // scrubs back, even by 1s — which made the world look empty.
    if (this.replayHistory.length >= 2) {
      const everSeen = new Set<string>();
      for (const frame of this.replayHistory) {
        for (const ag of frame.agents) everSeen.add(ag.id);
      }
      this.agentToNode.forEach((_node, sk) => {
        if (historicalIds.has(sk)) return;
        if (!everSeen.has(sk)) return; // never recorded → assume just spawned, keep live
        const found = this.roomOf(sk);
        if (!found) return;
        if (!this.replayHidden.has(sk)) this.replayHidden.add(sk);
        found.room.container.visible = false;
      });
    }
    // Re-show any room that WAS hidden but now appears in the historical sample
    // (the user scrubbed forward into a time where this agent existed).
    this.replayHidden.forEach((sk) => {
      if (!historicalIds.has(sk)) return;
      const found = this.roomOf(sk);
      if (found) found.room.container.visible = true;
      this.replayHidden.delete(sk);
    });

    this.replayStatusById.clear();
    for (const sa of a.agents) {
      this.replayStatusById.set(sa.id, sa.status);
      const found = this.roomOf(sa.id);
      if (!found) continue;
      // Force-visible: this agent existed at the historical time even if it
      // had been temporarily hidden by an earlier scrub.
      found.room.container.visible = true;
      const sb = bById.get(sa.id) ?? sa;
      const wx = sa.wx + (sb.wx - sa.wx) * f;
      const wy = sa.wy + (sb.wy - sa.wy) * f;
      // World → room-local. agentWorldPos() now records sprite-position = anchor
      // + localX/Y, so the historical wx already INCLUDES the agent's recorded
      // walked offset. Subtract the current localX/Y so when the sprite renders
      // at container + localX, the final on-screen point lands at wx.
      found.room.container.x = wx - found.nodeArea.x - found.room.localX;
      found.room.container.y = wy - found.nodeArea.y - found.room.localY;
    }

    // Reconcile conduits only when the bracketing sample changes (avoids churn).
    if (a.t !== this.replayAppliedConduitT) {
      this.replayAppliedConduitT = a.t;
      this.applyReplayConduits(a.conduits);
    }
  }

  /** Make the visible conduit set match the recorded set at the scrubbed time. */
  private applyReplayConduits(want: ReplayConduitSample[]): void {
    const wantKeys = new Set(want.map((c) => this.atrium_conduitKey(c.kind, c.peerId)));
    for (const c of want) {
      if (c.kind === "ssh") this.ensureSshConduit(c.peerId, c.host ?? "");
      else this.ensureFederationConduit(c.peerId, { displayName: c.displayName, angle: c.angle });
    }
    this.atrium_conduits.forEach((s) => {
      if (s.active && !wantKeys.has(this.atrium_conduitKey(s.kind, s.peerId))) {
        if (s.kind === "fed") this.releaseFederationConduit(s.peerId);
        else { s.active = false; s.container.visible = false; }
      }
    });
  }
  
  // ══════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));

    this.app.renderer.resize(nextWidth, nextHeight);
    this.viewport.resize(nextWidth, nextHeight, WORLD_WIDTH, WORLD_HEIGHT);
    this.starfield?.resize(nextWidth, nextHeight);
    this.cinematic?.resize(nextWidth, nextHeight);
    this.hud?.resize(nextWidth, nextHeight);

    this.minimap.container.position.set(nextWidth - 150, 10);
    this.themePicker?.container.position.set(nextWidth - 150, 122);
    this.uiControls?.resize(nextWidth, nextHeight, this.bottomReservedPx);
  }

  /**
   * Reserve `px` of vertical space at the bottom so the Pixi UI controls
   * stack floats above the recently-completed pin board overlay. Pass 0 to
   * restore the controls to their default bottom-right anchor.
   */
  setTopRightChromeHidden(hidden: boolean): void {
    this.topRightChromeHidden = hidden;
    if (this.minimap) this.minimap.container.visible = !hidden;
    if (this.themePicker) this.themePicker.container.visible = !hidden;
  }

  setBottomReserved(px: number): void {
    const next = Math.max(0, Math.round(px));
    if (next === this.bottomReservedPx) return;
    this.bottomReservedPx = next;
    this.uiControls?.resize(
      this.viewport.screenWidth,
      this.viewport.screenHeight,
      this.bottomReservedPx,
    );
  }

  toggleLabels(): boolean {
    this.setLabelsHidden(!this.labelsHidden);
    return this.labelsHidden;
  }

  setLabelsHidden(hidden: boolean): void {
    if (this.labelsHidden === hidden) {
      this.applyLabelVisibility();
      this.uiControls?.setLabelsHidden(hidden);
      return;
    }
    this.labelsHidden = hidden;
    writeLabelsHiddenSetting(hidden);
    this.applyLabelVisibility();
    this.uiControls?.setLabelsHidden(hidden);
  }

  private applyLabelVisibility(): void {
    const visible = !this.labelsHidden;
    // Agent badges and completion/sleep markers now share this world overlay
    // layer with plates. Keep the layer mounted; per-room label visibility and
    // station label visibility are toggled independently below.
    if (this.labelLayer) this.labelLayer.visible = true;
    this.station?.setSectorLabelsVisible(visible);
    this.district?.setLabelsVisible(visible);
    this.nodes.forEach(node => node.setLabelsVisible(visible));
  }
  
  addNode(node: MeshNode): void {
    if (this.nodes.has(node.id)) return;

    // Galactic mode but station hasn't been built yet (race: sync fires
    // before drawBackground completes). Queue the node and replay once
    // the station exists so we don't fall into the flat-grid branch and
    // leave the first satellite stranded at (400, 300) with no bridge.
    if (isGalactic() && !this.station) {
      if (!this.pendingGalacticNodes.some(n => n.id === node.id)) {
        this.pendingGalacticNodes.push(node);
      }
      return;
    }

    const nodeArea = new NodeArea(node, this.options.onNodeClick);
    if (isGalactic()) nodeArea.galacticTextures = getGalacticTextures(this.app.renderer);

    if (isGalactic() && this.station) {
      const isHub = (node.role === 'hub' || node.role === 'local') && this.zoneOwnerNodeId === null;
      if (isHub) {
        // Hub/local agents live in the Agent Quarters wing
        this.zoneOwnerNodeId = node.id;
        const center = this.station.agentQuartersCenter;
        nodeArea.x = center.x;
        nodeArea.y = center.y;
        const slots = this.station.agentQuartersSlots.map(
          s => new PIXI.Point(s.x - center.x, s.y - center.y),
        );
        // Plaque floats off the platform's left edge, beside the zone.
        // 5th arg = AQ hub flag → AgentRoom skips its office furniture so
        // agents stand directly on the zone floor (no elevated cabinet block).
        nodeArea.setGalacticLayout(slots, -430, -150, undefined, true);
      } else {
        // Satellites (and extra hubs) get an orbital pod + light bridge
        const anchorIndex = this.allocatePodSlot();
        this.podSlotOf.set(node.id, anchorIndex);
        const anchor = this.station.podAnchors[anchorIndex % this.station.podAnchors.length];
        const extraRing = Math.floor(anchorIndex / this.station.podAnchors.length);
        // Subsequent rings tuck in closer (was 120/320) so the
        // 5th+ federation islands stay inside the same frame as HQ.
        const pos = new PIXI.Point(anchor.x + extraRing * 70, anchor.y + extraRing * 200);
        nodeArea.x = pos.x;
        nodeArea.y = pos.y;
        const pod = buildPod(this.app.renderer);
        nodeArea.setGalacticLayout(pod.slots, 0, pod.labelY, pod.platform);
        // Animated island border around this federation pod (mesh plan).
        this.installPodAura(node.id, nodeArea, pod.corners);

        // Light bridge to the Command Atrium, under the platforms.
        // Anchor is recorded so updateNode/repositioning can redraw it
        // instead of leaving a dashed line dangling to the old coord.
        const bridge = new PIXI.Graphics();
        this.station.bridgeLayer.addChild(bridge);
        this.bridges.set(node.id, bridge);
        this.bridgeAnchors.set(node.id, { x: pos.x, y: pos.y });
        this.redrawBridge(node.id);
      }
      nodeArea.container.zIndex = nodeArea.y;
    } else {
      // Position nodes in a grid
      const pos = node.x !== undefined
        ? { x: node.x, y: node.y! }
        : {
            x: (this.nodes.size % 2) * 500 + 400,
            y: Math.floor(this.nodes.size / 2) * 400 + 300,
          };

      nodeArea.x = pos.x;
      nodeArea.y = pos.y;
      nodeArea.container.zIndex = pos.y;
    }

    this.nodeLayer.addChild(nodeArea.container);
    this.nodes.set(node.id, nodeArea);
    nodeArea.setLabelsVisible(!this.labelsHidden);

    // Spawn animation
    nodeArea.container.scale.set(0);
    nodeArea.container.alpha = 0;
    gsap.to(nodeArea.container.scale, { x: 1, y: 1, duration: 0.5, ease: 'back.out(1.5)' });
    gsap.to(nodeArea.container, { alpha: 1, duration: 0.35 });

    if (!this.hasAutoFit) {
      this.hasAutoFit = true;
      setTimeout(() => this.zoomToFit(), 600);
    } else if (isGalactic() && this.station && this.podSlotOf.size > 0) {
      // Federation peer joined after the initial auto-fit pinned the
      // camera on HQ. Re-fit so the new satellite island is in frame
      // instead of trailing off the side via the bridge line.
      //
      // Two-phase: snap a fast initial fit so the user never sees the
      // bridge + plaque dangling off-screen, then debounce a polished
      // final fit in case multiple peers arrive in the same burst.
      this.zoomToFit();
      if (this.refitDebounce) clearTimeout(this.refitDebounce);
      this.refitDebounce = setTimeout(() => {
        this.refitDebounce = null;
        this.zoomToFit();
      }, 600);
    }
  }

  private refitDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Pop the lowest released slot; fall back to a new monotonic index. */
  private allocatePodSlot(): number {
    if (this.freePodSlots.length > 0) {
      this.freePodSlots.sort((a, b) => a - b);
      return this.freePodSlots.shift()!;
    }
    return this.podSlotHigh++;
  }

  private releasePodSlot(idx: number): void {
    if (idx === this.podSlotHigh - 1) {
      this.podSlotHigh--;
    } else {
      this.freePodSlots.push(idx);
    }
  }

  /** Redraw a satellite's dashed bridge to the atrium using the stored
   *  anchor. Called from addNode and whenever the anchor moves. */
  private redrawBridge(nodeId: string): void {
    if (!this.station) return;
    const bridge = this.bridges.get(nodeId);
    const anchor = this.bridgeAnchors.get(nodeId);
    if (!bridge || !anchor) return;
    bridge.clear();
    // Faint shadow line on the deck plane reads as the bridge's "ground
    // projection" — sells the arc as 3D against the flat iso floor.
    bridge.lineStyle(2, 0x000000, 0.22);
    drawDashedLine(bridge, anchor.x, anchor.y, this.station.atriumCenter.x, this.station.atriumCenter.y);
    bridge.lineStyle(0);
    // Arched light bridge from satellite atrium center → command atrium.
    bridge.lineStyle(2, GALACTIC.gold, 0.6);
    drawDashedArc(bridge, anchor.x, anchor.y, this.station.atriumCenter.x, this.station.atriumCenter.y);
    bridge.lineStyle(0);
  }

  updateNode(nodeId: string, data: Partial<MeshNode>): void {
    const nodeArea = this.nodes.get(nodeId);
    if (!nodeArea) return;
    const merged = { ...nodeArea.data, ...data };
    nodeArea.update(merged);

    // If the controller pushed a new authoritative position, follow it
    // and re-anchor the bridge so the line doesn't dangle.
    if (data.x !== undefined && data.y !== undefined) {
      nodeArea.x = data.x;
      nodeArea.y = data.y;
      nodeArea.container.zIndex = data.y;
      if (this.bridges.has(nodeId)) {
        this.bridgeAnchors.set(nodeId, { x: data.x, y: data.y });
        this.redrawBridge(nodeId);
      }
    }
  }

  removeNode(nodeId: string): void {
    const nodeArea = this.nodes.get(nodeId);
    if (!nodeArea) {
      // Node might have been queued before the station existed and the
      // peer dropped before we ever rendered it — drop the queue entry.
      const qi = this.pendingGalacticNodes.findIndex(n => n.id === nodeId);
      if (qi >= 0) this.pendingGalacticNodes.splice(qi, 1);
      return;
    }

    const bridge = this.bridges.get(nodeId);
    if (bridge) {
      this.bridges.delete(nodeId);
      this.bridgeAnchors.delete(nodeId);
      gsap.to(bridge, { alpha: 0, duration: 0.35, onComplete: () => bridge.destroy() });
    }
    const slot = this.podSlotOf.get(nodeId);
    if (slot !== undefined) {
      this.podSlotOf.delete(nodeId);
      this.releasePodSlot(slot);
    }
    if (this.zoneOwnerNodeId === nodeId) this.zoneOwnerNodeId = null;

    gsap.to(nodeArea.container, {
      alpha: 0,
      duration: 0.35,
      onComplete: () => {
        nodeArea.rooms.forEach((_room, sessionKey) => {
          this.destroyToolBubbles(sessionKey);
          this.labelPlacementOffsets.delete(sessionKey);
          this.agentToNode.delete(sessionKey);
        });
        this.removePodAura(nodeId);
        this.nodeLayer.removeChild(nodeArea.container);
        this.nodes.delete(nodeId);
        nodeArea.destroy();
      },
    });
  }

  /** Returns the ids the engine currently tracks (rendered or queued). */
  getKnownNodeIds(): string[] {
    return [
      ...this.nodes.keys(),
      ...this.pendingGalacticNodes.map(n => n.id),
    ];
  }
  
  addAgent(agent: MeshAgent): void {
    this.worldLastActivityAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const nodeArea = this.nodes.get(agent.nodeId);
    if (!nodeArea) {
      console.warn(`[ActivityMap] Node ${agent.nodeId} not found for agent ${agent.sessionKey}`);
      return;
    }
    
    if (this.agentToNode.has(agent.sessionKey)) return;
    
    const room = nodeArea.addRoom(agent, this.options.onAgentClick);
    room.mountOverlay(this.labelLayer);
    this.agentToNode.set(agent.sessionKey, agent.nodeId);
    this.retargetBeds(); // addRoom re-placed the node's rooms

    // Spawn animation
    room.container.scale.set(0);
    room.container.alpha = 0;
    gsap.to(room.container.scale, { x: 1, y: 1, duration: 0.4, ease: 'back.out(1.5)' });
    gsap.to(room.container, { alpha: 1, duration: 0.3 });

    // Restored finished run (page reload / world rebuild): appear already
    // lying on a Concourse bed rather than walking there.
    if (isFinishedStatus(agent.status)) {
      this.noteFinished(agent.sessionKey);
      this.routeAgentToConcourse(agent.sessionKey, true);
    }

    this.refreshAgentQuartersActivity();
  }

  /** Record a finished agent (newest first) and depart the oldest past the cap. */
  private noteFinished(sessionKey: string): void {
    this.finishedOrder = this.finishedOrder.filter(k => k !== sessionKey);
    this.finishedOrder.unshift(sessionKey);
    while (this.finishedOrder.length > MAX_RESTING_COMPLETED) {
      const oldest = this.finishedOrder.pop()!;
      this.removeAgent(oldest);
    }
  }

  private unnoteFinished(sessionKey: string): void {
    if (this.finishedOrder.includes(sessionKey)) {
      this.finishedOrder = this.finishedOrder.filter(k => k !== sessionKey);
    }
  }

  private localPathForRoom(room: AgentRoom, nodeArea: NodeArea, worldPath: PIXI.Point[]): PIXI.Point[] {
    return worldPath.map(point => new PIXI.Point(
      point.x - nodeArea.x - room.container.x,
      point.y - nodeArea.y - room.container.y,
    ));
  }

  private buildAgentWalkPath(start: PIXI.Point, end: PIXI.Point, fromNodeId: string, toNodeId: string): PIXI.Point[] {
    const path = [start];
    if (isGalactic() && this.station && fromNodeId !== toNodeId) {
      const atrium = this.station.atriumCenter;
      path.push(
        new PIXI.Point((start.x + atrium.x) / 2, (start.y + atrium.y) / 2),
        new PIXI.Point(atrium.x, atrium.y),
        new PIXI.Point((atrium.x + end.x) / 2, (atrium.y + end.y) / 2),
      );
    }
    path.push(end);
    return path;
  }
  
  updateAgent(sessionKey: string, data: Partial<MeshAgent>): void {
    this.worldLastActivityAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const nodeId = this.agentToNode.get(sessionKey);
    if (!nodeId) return;
    
    const nodeArea = this.nodes.get(nodeId);
    const room = nodeArea?.rooms.get(sessionKey);
    if (!room || !nodeArea) return;

    if (data.nodeId && data.nodeId !== nodeId) {
      const nextNodeArea = this.nodes.get(data.nodeId);
      if (!nextNodeArea) {
        console.warn(`[ActivityMap] Node ${data.nodeId} not found for agent ${sessionKey}`);
        room.update(data);
        return;
      }

      const start = room.getWorldAgentPosition(nodeArea.x, nodeArea.y);
      const transferred = nodeArea.detachRoom(sessionKey);
      if (!transferred) return;
      nextNodeArea.attachRoom(transferred);
      transferred.update(data);
      this.agentToNode.set(sessionKey, data.nodeId);
      this.retargetBeds();

      const end = transferred.getWorldTargetPosition(nextNodeArea.x, nextNodeArea.y);
      const worldPath = this.buildAgentWalkPath(start, end, nodeId, data.nodeId);
      transferred.beginWalk(this.localPathForRoom(transferred, nextNodeArea, worldPath));
      this.refreshAgentQuartersActivity();
      return;
    }

    room.update(data);
    if (data.status) {
      gsap.to(room.container.scale, { x: 1.1, y: 1.1, duration: 0.1, yoyo: true, repeat: 1 });
      this.refreshAgentQuartersActivity();
      const st = data.status;
      if (isFinishedStatus(st)) {
        // Finished — walk to the Gateway Concourse and lie on a bed (✓ / ✕)
        // instead of vanishing. Drop any tool-sector dwell first so the rest
        // route isn't blocked by it.
        this.cancelCompletionRemoval(sessionKey);
        const pending = this.routeReturnTimers.get(sessionKey);
        if (pending) { clearTimeout(pending); this.routeReturnTimers.delete(sessionKey); }
        this.leaveSector(sessionKey, true);
        this.noteFinished(sessionKey);
        this.routeAgentToConcourse(sessionKey);
      } else {
        // Came back to life (e.g. re-run) — cancel any pending removal.
        this.cancelCompletionRemoval(sessionKey);
        this.unnoteFinished(sessionKey);
        // Rest-area routing: resting agents glide to a concourse bed; any active
        // status wakes them and walks them home. Full size throughout.
        if (isRestingStatus(st)) this.routeAgentToConcourse(sessionKey);
        else this.wakeAgentFromConcourse(sessionKey);
      }
    }
  }

  private cancelCompletionRemoval(sessionKey: string): void {
    const t = this.completionTimers.get(sessionKey);
    if (t) { clearTimeout(t); this.completionTimers.delete(sessionKey); }
  }

  removeAgent(sessionKey: string): void {
    this.cancelCompletionRemoval(sessionKey);
    this.unnoteFinished(sessionKey);
    const nodeId = this.agentToNode.get(sessionKey);
    if (!nodeId) return;

    const nodeArea = this.nodes.get(nodeId);
    const room = nodeArea?.rooms.get(sessionKey);
    if (room) {
      const c = room.container;
      gsap.killTweensOf(c);
      gsap.killTweensOf(c.scale);
      // Tasteful "depart": shrink + rise + fade so the exit reads as leaving,
      // not just blinking out. The cleanup runs when the shrink completes.
      gsap.to(c, { alpha: 0, y: c.y - 24, duration: 0.5, ease: 'power2.in' });
      gsap.to(c.scale, {
        x: c.scale.x * 0.35,
        y: c.scale.y * 0.35,
        duration: 0.5,
        ease: 'power2.in',
        onComplete: () => {
          this.destroyToolBubbles(sessionKey);
          this.labelPlacementOffsets.delete(sessionKey);
          this.cleanupAgentRoute(sessionKey);
          nodeArea?.removeRoom(sessionKey);
          this.agentToNode.delete(sessionKey);
          this.retargetBeds(); // removeRoom re-placed the node's rooms
          this.refreshAgentQuartersActivity();
        },
      });
    }
  }

  /**
   * Toggle the "sector active" highlight (breathing floor glow + label dot)
   * for a station zone. Agent Quarters is managed automatically from agent
   * statuses; other sectors are the host's to drive (Phase 4 wires them to
   * live gateway events).
   */
  setSectorActivity(sectorId: string, active: boolean): void {
    if (active) this.activeSectors.add(sectorId);
    else this.activeSectors.delete(sectorId);
    this.station?.setZoneActive(sectorId, active);
    this.district?.setActive(sectorId, active);
  }

  // ══════════════════════════════════════════════════════════════
  // ACTIVITY-DRIVEN MOVEMENT (Part 1)
  // Agents walk to the HQ sector matching the tool they're firing, dwell
  // there for the call, then walk home. Crowded sectors compact into a ring
  // and glow "hot". Public entry points: routeAgentToToolSector / routeTaskTrip
  // (driven from agency-world-viz on agent.tool / task.ingest events).
  // ══════════════════════════════════════════════════════════════

  /** Map a tool kind to the closest existing HQ sector, or null (→ go home). */
  private sectorForToolKind(kind: string): string | null {
    const k = (kind || '').toLowerCase();
    if (/read|list|cat|grep|glob|search|view|\bls\b|find/.test(k)) return 'the-vault';        // Archives / Data Vault
    if (/write|edit|multiedit|create|update|patch|apply|insert|mkdir|notebook/.test(k)) return 'canvas-atrium'; // Workshop / Forge
    if (/bash|exec|shell|run|command|terminal|\bcmd\b|spawn|script/.test(k)) return 'engineering-bay';          // Engineering / Reactor
    if (/web|fetch|http|net|url|curl|download|\bapi\b|browser|request/.test(k)) return 'comms-deck';            // Comms Array
    if (/think|reason|plan|analy|ponder|consider/.test(k)) return 'observatory';               // Observatory / Bridge
    return null;
  }

  private sectorCenter(sectorId: string): PIXI.Point | null {
    const z = this.station?.zones.find(zz => zz.def.id === sectorId);
    if (z) return z.center;
    return this.district?.center(sectorId) ?? null;
  }

  private roomOf(sessionKey: string): { room: AgentRoom; nodeArea: NodeArea } | null {
    const nodeId = this.agentToNode.get(sessionKey);
    if (!nodeId) return null;
    const nodeArea = this.nodes.get(nodeId);
    const room = nodeArea?.rooms.get(sessionKey);
    if (!nodeArea || !room) return null;
    return { room, nodeArea };
  }

  /** World point → room-local space (relative to the agent's room container). */
  private worldToRoomLocal(room: AgentRoom, nodeArea: NodeArea, world: PIXI.Point): PIXI.Point {
    return new PIXI.Point(world.x - nodeArea.x - room.container.x, world.y - nodeArea.y - room.container.y);
  }

  /**
   * Public: route an agent to the sector that matches the tool it just fired,
   * and (re)arm the 5s return timer. Each new tool event resets the timer, so
   * the agent only heads home after 5s of tool silence. Unmatched kinds send
   * the agent back to its home room.
   */
  routeAgentToToolSector(sessionKey: string, kind: string, label?: string): void {
    if (!isGalactic() || !this.station) return;
    if (this.spread.noteTool(sessionKey, kind, performance.now(), label)) return; // spread owns movement
    // A tool/RPC declared by an enabled plugin sends the agent to that
    // plugin's room; anything else uses the core sector for the tool kind.
    const roomId = this.pluginRoomForActivity({ toolKind: kind, toolLabel: label, agentKey: sessionKey });
    const sectorId = roomId ?? this.sectorForToolKind(kind);
    if (!sectorId) { this.returnAgentHome(sessionKey); return; }
    this.enterSector(sessionKey, sectorId, TOOL_HOLD_MS);
  }

  // ══════════════════════════════════════════════════════════════
  // PLUGIN DISTRICT — one room per enabled plugin. Agents whose current
  // activity belongs to a plugin (its tools / RPCs / pages / roster agents)
  // work in that plugin's room; everything else falls back to core sectors.
  // ══════════════════════════════════════════════════════════════

  private installDistrict(): void {
    if (!this.station || !isGalactic()) return;
    this.district?.destroy();
    const district = new PluginDistrict(this.app.renderer, {
      centerX: 800,
      centerY: 600,
      reducedMotion: prefersReducedMotion(),
      onRoomClick: (spec) => this.options.onPluginRoomClick?.(spec),
      onRoomHover: (spec, screen) => this.onPluginRoomHover(spec, screen),
    });
    this.backgroundLayer.addChild(district.container);
    this.labelLayer.addChild(district.labelLayer);
    this.effectsLayer.addChild(district.fxLayer);
    district.setLabelsVisible(!this.labelsHidden);
    // Hover/click come from the canvas DOM events (works on every host surface);
    // an agent under the pointer keeps its own click (Agent Focus).
    district.attachDom(
      this.canvas,
      (x, y) => { const w = this.viewport.toWorld(x, y); return { x: w.x, y: w.y }; },
      (world) => this.nearestAgentToWorld(world.x, world.y, 28) !== null,
    );
    this.district = district;
    if (this.pluginRoomSpecs.length) {
      district.sync(this.pluginRoomSpecs, false);
      this.syncDistrictSectors();
    }
  }

  /** Register the plugin rooms that should exist (from plugins.list). Rooms
   *  that vanish dissolve, new ones build in; the rest stay put. */
  setPluginRooms(specs: PluginRoomSpec[]): void {
    this.pluginRoomSpecs = specs.slice();
    if (!this.district) return;
    const { added, removed } = this.district.sync(specs, true);
    if (removed.length) {
      // Agents dwelling in a dissolved room walk home / get re-planned.
      for (const id of removed) {
        for (const key of [...(this.sectorOccupants.get(id) ?? [])]) this.returnAgentHome(key);
        this.activeSectors.delete(id);
        if (this.hoveredPluginRoom === id) { this.hoveredPluginRoom = null; this.tooltip.hide(); }
      }
    }
    if (added.length || removed.length) this.syncDistrictSectors();
    for (const id of added) if (this.activeSectors.has(id)) this.district.setActive(id, true);
  }

  /** The activity → plugin resolver built from plugins.list (agency-world-viz). */
  setPluginActivityIndex(index: PluginActivityIndex | null): void {
    this.pluginActivity = index;
  }

  /** Current plugin rooms (for harnesses / HUD). */
  pluginRooms(): PluginRoomSpec[] {
    return this.district?.list().map((r) => r.spec) ?? [];
  }

  /** Session keys currently working in a plugin room. */
  pluginRoomOccupants(roomId: string): string[] {
    const out = new Set<string>();
    this.spread.plan().forEach((a, key) => { if (a.sectorId === roomId) out.add(key); });
    for (const key of this.sectorOccupants.get(roomId) ?? []) out.add(key);
    return [...out];
  }

  private syncDistrictSectors(): void {
    const defs = this.district?.sectorDefs() ?? [];
    this.spread.setExtraSectors(defs.map((def) => ({ def, capacity: Math.max(3, Math.floor((def.w * def.h) / 12)) })));
  }

  /** Plugin room sector id for an agent's activity, or null → core sectors. */
  private pluginRoomForActivity(input: { toolKind?: string; toolLabel?: string; text?: string; agentId?: string; pluginId?: string; agentKey?: string }): string | null {
    const idx = this.pluginActivity;
    if (!idx || !this.district || this.district.size() === 0) return null;
    const data = input.agentKey ? this.roomOf(input.agentKey)?.room.data : undefined;
    const pid = idx.resolve({
      pluginId: input.pluginId ?? data?.pluginId,
      toolKind: input.toolKind,
      toolLabel: input.toolLabel,
      text: input.text ?? [data?.currentTask, data?.label].filter(Boolean).join(' · '),
      agentId: input.agentId ?? data?.agentId,
    });
    if (!pid) return null;
    const sid = roomSectorId(pid);
    return this.district.has(sid) ? sid : null;
  }

  /** Spread-driver hook: which plugin room (if any) this working agent wants. */
  private pluginRoomFor(a: SpreadAgentView, tool: { kind: string; label?: string; at: number } | undefined): string | null {
    const fresh = !!tool && performance.now() - tool.at <= TOOL_SIGNAL_TTL_MS;
    return this.pluginRoomForActivity({
      toolKind: fresh ? tool!.kind : undefined,
      toolLabel: fresh ? tool!.label : undefined,
      text: [a.currentTask, a.label].filter(Boolean).join(' · '),
      agentId: a.agentId,
      agentKey: a.key,
    });
  }

  /** Per frame: feed the district the agents working in plugin rooms so it can
   *  draw desk sparks, conversations and carried items. Also arms the "carry"
   *  state when an agent moves straight from one plugin room to another. */
  private updateDistrictFx(dt: number): void {
    const district = this.district;
    if (!district || district.size() === 0) return;
    const now = performance.now();
    const occupants: DistrictOccupant[] = [];
    const seen = new Set<string>();
    const consider = (key: string, roomId: string) => {
      if (seen.has(key) || !roomId.startsWith('plugin:') || !district.has(roomId)) return;
      seen.add(key);
      const found = this.roomOf(key);
      if (!found) return;
      const prev = this.lastPluginRoomOf.get(key);
      if (prev && prev !== roomId) this.carryingUntil.set(key, now + 12_000);
      this.lastPluginRoomOf.set(key, roomId);
      const p = this.agentWorldPos(key);
      if (!p) return;
      const moving = found.room.isWalking;
      const carryUntil = this.carryingUntil.get(key) ?? 0;
      if (!moving && carryUntil) this.carryingUntil.delete(key); // delivered
      occupants.push({ key, roomId, x: p.x, y: p.y, moving, carrying: moving && carryUntil > now });
    };
    this.spread.plan().forEach((a, key) => consider(key, a.sectorId));
    this.agentToolSector.forEach((sectorId, key) => consider(key, sectorId));
    for (const key of [...this.lastPluginRoomOf.keys()]) {
      if (!seen.has(key)) { this.lastPluginRoomOf.delete(key); this.carryingUntil.delete(key); }
    }
    // Hot tint for occupied rooms (spread path doesn't go through enterSector).
    const occupied = new Set(occupants.map((o) => o.roomId));
    for (const room of district.list()) {
      const on = occupied.has(room.spec.id) || (this.sectorOccupants.get(room.spec.id)?.size ?? 0) > 0;
      if (on !== room.active) district.setActive(room.spec.id, on);
    }
    district.frame(dt, occupants);
    // Hover tooltip tracks occupants as they come and go; rebuilding its text
    // every frame is wasted work, a few times a second is plenty.
    if (this.hoveredPluginRoom && this.animationFrame % 12 === 0) this.refreshPluginRoomTooltip();
  }

  private onPluginRoomHover(spec: PluginRoomSpec | null, screen: { x: number; y: number } | null): void {
    if (!spec || !screen) {
      this.hoveredPluginRoom = null;
      this.tooltip.hide();
      return;
    }
    this.hoveredPluginRoom = spec.id;
    this.tooltipScreen = screen;
    this.refreshPluginRoomTooltip();
  }

  private tooltipScreen: { x: number; y: number } | null = null;

  private refreshPluginRoomTooltip(): void {
    const id = this.hoveredPluginRoom;
    const room = id ? this.district?.room(id) : undefined;
    if (!id || !room || !this.tooltipScreen) return;
    const keys = this.pluginRoomOccupants(id);
    const names = keys
      .map((k) => this.roomOf(k)?.room.data)
      .filter((d): d is MeshAgent => !!d)
      .map((d) => (d.label || d.agentId || d.sessionKey).slice(0, 22));
    const lines = [room.spec.title.toUpperCase(), room.spec.subtitle.toUpperCase()];
    lines.push(keys.length ? `${keys.length} AGENT${keys.length === 1 ? '' : 'S'} HERE` : 'NO AGENTS HERE');
    for (const n of names.slice(0, 6)) lines.push(`· ${n}`);
    if (names.length > 6) lines.push(`· +${names.length - 6} MORE`);
    lines.push('CLICK TO OPEN');
    const world = this.viewport.toWorld(this.tooltipScreen.x + 14, this.tooltipScreen.y + 14);
    this.tooltip.show(world.x, world.y, lines);
    // Re-place in screen space: beside the pointer, clear of the room's own
    // sign, agent name tags and the viewport edges (it used to sit on them).
    const zoom = this.getZoom();
    const c = this.tooltip.container;
    const size = { width: c.width * zoom, height: c.height * zoom };
    const pt = this.tooltipScreen;
    const obstacles: ScreenRect[] = this.zoneLabelScreenRects();
    for (const pl of Object.values(this.lastOverlayPlaced.labels)) if (!pl.hidden) obstacles.push(pl.rect);
    const place = placeFloatingRect({
      anchor: { x: pt.x - 10, y: pt.y - 10, width: 20, height: 20 },
      size,
      bounds: { width: this.viewport.screenWidth, height: this.viewport.screenHeight },
      obstacles,
      gap: 8,
      margin: 8,
    });
    const at = this.viewport.toWorld(place.x, place.y);
    c.position.set(at.x, at.y);
  }

  /**
   * Public: when a kanban task is ingested, send an agent on a trip to the
   * task board (Mission Control) to "look at the task" for ~10s, then home.
   * Prefers a working agent on the task's node, then the hub, then anyone.
   */
  routeTaskTrip(nodeId?: string, _taskId?: string): void {
    if (!isGalactic() || !this.station) return;
    let chosen: string | undefined;
    const scan = (nid?: string) => {
      if (!nid) return;
      this.nodes.get(nid)?.rooms.forEach((room, key) => {
        if (!chosen) chosen = key;
        if (isWorkingStatus(room.data.status)) chosen = key;
      });
    };
    scan(nodeId);
    if (!chosen) scan(this.zoneOwnerNodeId ?? undefined);
    if (!chosen) {
      for (const na of this.nodes.values()) {
        const first = na.rooms.keys().next().value;
        if (first) { chosen = first; break; }
      }
    }
    if (!chosen) return;
    this.enterSector(chosen, 'mission-control', TASK_TRIP_HOLD_MS);
  }

  /** Move an agent into a sector, update crowd state, (re)arm its return timer. */
  private enterSector(sessionKey: string, sectorId: string, holdMs: number): void {
    if (!isGalactic() || !this.station || !this.roomOf(sessionKey)) return;

    // A tool/task trip takes priority over resting — vacate any bed first so the
    // concourse reconcile doesn't fight the sector detour for this agent.
    this.freeBed(sessionKey);

    const pending = this.routeReturnTimers.get(sessionKey);
    if (pending) { clearTimeout(pending); this.routeReturnTimers.delete(sessionKey); }

    const prev = this.agentToolSector.get(sessionKey);
    if (prev && prev !== sectorId) this.leaveSector(sessionKey, true);

    this.agentToolSector.set(sessionKey, sectorId);
    let occ = this.sectorOccupants.get(sectorId);
    if (!occ) { occ = new Set(); this.sectorOccupants.set(sectorId, occ); }
    occ.add(sessionKey);

    this.setSectorActivity(sectorId, true);   // hot tint via GALACTIC accent
    this.layoutSectorOccupants(sectorId);
    this.routeReturnTimers.set(sessionKey, setTimeout(() => this.returnAgentHome(sessionKey), holdMs));
  }

  /** Place every agent dwelling in a sector on a deterministic, non-overlapping
   *  golden-angle spread (no more hash-mod collisions / stacking). Occupants are
   *  sorted by stable agent-id hash so slot assignment — and therefore each
   *  agent's screen position — is reproduced exactly across a page refresh. */
  private layoutSectorOccupants(sectorId: string): void {
    const center = this.sectorCenter(sectorId);
    if (!center) return;
    const occ = Array.from(this.sectorOccupants.get(sectorId) ?? [])
      .sort((a, b) => hashString(a) - hashString(b));
    const total = occ.length;
    occ.forEach((key, i) => {
      const found = this.roomOf(key);
      if (!found) return;
      const slot = sectorSlot(i, total);
      const wx = center.x + slot.dx;
      const wy = center.y + slot.dy * SECTOR_ISO_SQUASH; // iso foreshorten
      const local = this.worldToRoomLocal(found.room, found.nodeArea, new PIXI.Point(wx, wy));
      found.room.routeToLocal(local, TOOL_WALK_SPEED_PX);
    });
  }

  /** Remove an agent from its sector's crowd; clear the hot tint when empty. */
  private leaveSector(sessionKey: string, relayout: boolean): void {
    const sectorId = this.agentToolSector.get(sessionKey);
    if (!sectorId) return;
    this.agentToolSector.delete(sessionKey);
    const occ = this.sectorOccupants.get(sectorId);
    if (!occ) return;
    occ.delete(sessionKey);
    if (occ.size === 0) {
      this.sectorOccupants.delete(sectorId);
      // Agent Quarters' glow is driven by refreshAgentQuartersActivity, not us.
      if (sectorId !== 'agent-quarters') this.setSectorActivity(sectorId, false);
    } else if (relayout) {
      this.layoutSectorOccupants(sectorId); // ring may relax back to jitter under 5
    }
  }

  /** End an agent's dwell and walk it back to its home room. */
  private returnAgentHome(sessionKey: string): void {
    const pending = this.routeReturnTimers.get(sessionKey);
    if (pending) { clearTimeout(pending); this.routeReturnTimers.delete(sessionKey); }
    this.leaveSector(sessionKey, true);
    this.roomOf(sessionKey)?.room.clearRoute();
  }

  /** Drop all route state for an agent (called when its room is removed). */
  private cleanupAgentRoute(sessionKey: string): void {
    const pending = this.routeReturnTimers.get(sessionKey);
    if (pending) { clearTimeout(pending); this.routeReturnTimers.delete(sessionKey); }
    this.leaveSector(sessionKey, true);
    this.freeBed(sessionKey);
    this.spread.forget(sessionKey);
    this.lastPluginRoomOf.delete(sessionKey);
    this.carryingUntil.delete(sessionKey);
  }

  // ══════════════════════════════════════════════════════════════
  // GATEWAY CONCOURSE — REST AREA
  // Idle / resting agents glide (at full size) to the Gateway Concourse and
  // park on a bed. Waking (any non-resting status) frees the bed and walks the
  // agent home. Reuses the same detour pathing as the tool-sector router, so
  // there's no second movement system to maintain.
  // ══════════════════════════════════════════════════════════════

  /**
   * Claim a free concourse bed for an agent, or -1 if all are taken. Idle-but-
   * alive agents fill from the front, finished runs from the back, so the two
   * rarely collide; when the beds are full a live agent takes the bed of the
   * oldest finished run (which gets up and stands at home, marker hidden).
   */
  private claimBed(sessionKey: string): number {
    const existing = this.agentBed.get(sessionKey);
    if (existing !== undefined) return existing;
    const slots = this.station?.concourseBedSlots ?? [];
    const finished = isFinishedStatus(this.roomOf(sessionKey)?.room.data.status);
    const take = (i: number): number => {
      this.bedOccupant.set(i, sessionKey);
      this.agentBed.set(sessionKey, i);
      return i;
    };
    for (let n = 0; n < slots.length; n++) {
      const i = finished ? slots.length - 1 - n : n;
      if (!this.bedOccupant.has(i)) return take(i);
    }
    if (finished) return -1;
    for (let n = this.finishedOrder.length - 1; n >= 0; n--) {
      const yielder = this.finishedOrder[n];
      const bed = this.agentBed.get(yielder);
      if (bed === undefined) continue;
      this.freeBed(yielder);
      this.roomOf(yielder)?.room.clearRoute();
      return take(bed);
    }
    return -1;
  }

  /** Release whatever bed an agent holds and clear its sleep glyph. */
  private freeBed(sessionKey: string): void {
    const idx = this.agentBed.get(sessionKey);
    if (idx === undefined) return;
    this.agentBed.delete(sessionKey);
    if (this.bedOccupant.get(idx) === sessionKey) this.bedOccupant.delete(idx);
    this.roomOf(sessionKey)?.room.setResting(false);
  }

  /**
   * Public/idle entry point: send a resting agent to a free bed in the Gateway
   * Concourse. The agent walks the whole way at full size and lies down (a Zzz
   * glyph appears). No-op outside galactic mode, if the concourse has no free
   * bed, or if the agent is already routed to a tool sector.
   */
  routeAgentToConcourse(sessionKey: string, snap = false): void {
    if (!isGalactic() || !this.station) return;
    if (this.agentToolSector.has(sessionKey)) return;   // busy at a tool sector
    const found = this.roomOf(sessionKey);
    if (!found) return;
    const bed = this.claimBed(sessionKey);
    if (bed < 0) return;                                  // concourse full — stay put
    const slot = this.station.concourseBedSlots[bed];
    const local = this.worldToRoomLocal(found.room, found.nodeArea, slot);
    if (snap) found.room.snapToLocal(local);
    else found.room.routeToLocal(local, REST_WALK_SPEED_PX);
    found.room.setResting(true);
  }

  /**
   * Keep bedded agents on their beds across NodeArea relayouts: bed slots are
   * world-space but routes are room-local, and rooms re-place whenever an agent
   * joins/leaves the node.
   */
  private retargetBeds(): void {
    const slots = this.station?.concourseBedSlots;
    if (!slots || !this.agentBed.size) return;
    this.agentBed.forEach((bed, key) => {
      const found = this.roomOf(key);
      const slot = slots[bed];
      if (!found || !slot) return;
      found.room.retargetDetour(this.worldToRoomLocal(found.room, found.nodeArea, slot));
    });
  }

  /** Wake an agent: free its bed and walk it back home (full size, normal pace). */
  wakeAgentFromConcourse(sessionKey: string): void {
    if (this.agentBed.get(sessionKey) === undefined) return;
    this.freeBed(sessionKey);
    this.roomOf(sessionKey)?.room.clearRoute();
  }

  /**
   * Periodic rest-area reconcile (called from the animate loop). Routes any
   * resting-status agent that isn't already on a bed to the concourse, and
   * wakes any bedded agent whose status is no longer resting. Idempotent —
   * routeAgentToConcourse / wakeAgentFromConcourse no-op when already settled.
   */
  private reconcileConcourse(): void {
    if (!isGalactic() || !this.station) return;
    this.retargetBeds();
    this.nodes.forEach(node => {
      node.rooms.forEach((room, key) => {
        const resting = isRestingStatus(room.data.status);
        const onBed = this.agentBed.has(key);
        if (resting && !onBed && !this.agentToolSector.has(key)) {
          this.routeAgentToConcourse(key);
        } else if (!resting && onBed) {
          this.wakeAgentFromConcourse(key);
        }
      });
    });
  }

  ensureFederationConduit(peerId: string, opts: { displayName?: string; angle?: number } = {}): void {
    if (!peerId) return;
    const key = this.atrium_conduitKey('fed', peerId);
    const existing = this.atrium_conduits.get(key);
    if (existing) {
      const wasHidden = !existing.active || !existing.container.visible;
      existing.displayName = opts.displayName ?? existing.displayName;
      existing.angle = opts.angle ?? existing.angle;
      existing.active = true;
      existing.disconnectedUntil = 0;
      existing.container.visible = true;
      if (wasHidden) {
        existing.drawProgress = 0;
        existing.sparkleUntil = this.atrium_now() + ATRIUM_CONDUIT_DRAW_MS;
      }
      this.atrium_updateConduitAnchor(existing);
      this.atrium_drawConduit(existing);
      return;
    }
    this.atrium_makeConduit('fed', peerId, opts);
  }

  releaseFederationConduit(peerId: string): void {
    const state = this.atrium_conduits.get(this.atrium_conduitKey('fed', peerId));
    if (!state) return;
    state.active = false;
    state.disconnectedUntil = this.atrium_now() + ATRIUM_CONDUIT_DISCONNECT_MS;
    state.pulsePower = Math.min(1, state.pulsePower + 0.25);
    this.atrium_drawConduit(state);
  }

  pulseConduit(peerId: string, kind: AtriumPulseKind, payload: { text?: string } = {}): void {
    if (!peerId) return;
    const state = this.atrium_findConduit(peerId) ?? this.atrium_makeConduit('fed', peerId);
    state.active = true;
    state.disconnectedUntil = 0;
    state.container.visible = true;
    state.pulsePower = Math.min(1.7, state.pulsePower + 1);
    if (kind === 'fail') {
      state.failUntil = this.atrium_now() + ATRIUM_CONDUIT_FAIL_MS;
      this.atrium_drawConduit(state);
      return;
    }
    const fallback = kind === 'ack' ? 'OK' : kind === 'command' ? 'COMMAND' : 'MESSAGE';
    this.atrium_spawnGlyph(state, kind, this.atrium_sanitizeGlyphText(payload.text ?? fallback, fallback));
    this.atrium_drawConduit(state);
  }

  surgeAtrium(intensity = 1): void {
    const amount = Math.max(0, Number.isFinite(intensity) ? intensity : 1);
    this.atrium_surgePower = Math.min(3, this.atrium_surgePower + amount);
    this.atrium_ringSurgePower = Math.min(2, this.atrium_ringSurgePower + amount);
  }

  ensureSshConduit(deviceId: string, host: string): void {
    if (!deviceId) return;
    const key = this.atrium_conduitKey('ssh', deviceId);
    const existing = this.atrium_conduits.get(key);
    if (existing) {
      const wasHidden = !existing.active || !existing.container.visible;
      existing.host = host || existing.host;
      existing.active = true;
      existing.disconnectedUntil = 0;
      existing.container.visible = true;
      if (wasHidden) {
        existing.drawProgress = 0;
        existing.sparkleUntil = this.atrium_now() + ATRIUM_CONDUIT_DRAW_MS;
      }
      this.atrium_updateConduitAnchor(existing);
      this.atrium_drawConduit(existing);
      return;
    }
    this.atrium_makeConduit('ssh', deviceId, { host });
  }

  releaseSshConduit(deviceId: string): void {
    const state = this.atrium_conduits.get(this.atrium_conduitKey('ssh', deviceId));
    if (!state) return;
    state.active = false;
    state.disconnectedUntil = this.atrium_now() + ATRIUM_CONDUIT_DISCONNECT_MS;
    state.pulsePower = Math.min(1, state.pulsePower + 0.25);
    this.atrium_drawConduit(state);
  }

  /**
   * Re-theme the whole station from a single accent color (simulates the
   * InfiniBot dynamic theme system). Rebakes every texture and rebuilds the
   * world in place; nodes, agents, camera, and active sectors survive.
   */
  setAccent(color: number): void {
    if (!isGalactic() || color === GALACTIC.gold) return;
    setGalacticAccent(color);
    this.rebuildGalacticWorld();
    // Phase 4 §persistent cosmetics — remember the chosen accent across reloads.
    try {
      localStorage?.setItem("infinibot-world-accent", String(color));
    } catch {
      /* storage blocked — cosmetic preference simply won't persist */
    }
  }

  /** Phase 4 §persistent cosmetics — apply a previously-chosen accent before the
   *  first world bake so the saved theme is baked in, not flashed in after. */
  private restorePersistedAccent(): void {
    if (!isGalactic()) return;
    try {
      const raw = localStorage?.getItem("infinibot-world-accent");
      if (!raw) return;
      const color = Number(raw);
      if (Number.isFinite(color) && color !== GALACTIC.gold) setGalacticAccent(color);
    } catch {
      /* ignore — fall back to the default gold accent */
    }
  }

  /**
   * Pull the live CSS theme tokens (--g-primary / --g-accent / --g-bg) into the
   * Pixi palette. Only rebuilds the (expensive) world when the primary accent
   * actually changed; secondary-accent / bg shifts re-tint live FX on the next
   * frame without a teardown. Safe to call on every theme-change event.
   */
  applyThemeFromCss(): void {
    if (!isGalactic()) return;
    const theme = resolveGalacticTheme();
    const accentChanged = theme.accent !== GALACTIC.gold;
    setGalacticTheme(theme.accent, theme.accent2, theme.bg);
    if (accentChanged) {
      this.rebuildGalacticWorld();
    } else {
      // Cheap path: refresh the screen-space chrome that reads the palette.
      this.hud?.refreshTint();
      this.cinematic?.refreshTint();
    }
  }

  private rebuildGalacticWorld(): void {
    if (!this.station) return;

    // Snapshot world state
    const nodeDatas: MeshNode[] = [];
    const agentDatas: MeshAgent[] = [];
    this.nodes.forEach(nodeArea => {
      nodeDatas.push({ ...nodeArea.data });
      nodeArea.rooms.forEach(room => agentDatas.push({ ...room.data }));
    });
    const activeSectors = new Set(this.activeSectors);

    // Tear down nodes + station (kills their tweens, frees display objects)
    this.nodes.forEach(nodeArea => {
      nodeArea.rooms.forEach(room => {
        gsap.killTweensOf(room.container);
        gsap.killTweensOf(room.container.scale);
      });
      gsap.killTweensOf(nodeArea.container);
      gsap.killTweensOf(nodeArea.container.scale);
      nodeArea.destroy();
    });
    this.destroyToolBubbles();
    this.routeReturnTimers.forEach(t => clearTimeout(t));
    this.routeReturnTimers.clear();
    this.completionTimers.forEach(t => clearTimeout(t));
    this.completionTimers.clear();
    this.agentToolSector.clear();
    this.sectorOccupants.clear();
    // Rooms are recreated below; drop bed assignments so reconcileConcourse
    // re-parks resting agents onto the freshly built beds.
    this.agentBed.clear();
    this.bedOccupant.clear();
    this.nodes.clear();
    this.agentToNode.clear();
    this.bridges.clear();
    this.bridgeAnchors.clear();
    this.podSlotHigh = 0;
    this.freePodSlots = [];
    this.podSlotOf.clear();
    this.zoneOwnerNodeId = null;

    // Island auras are children of the nodes (pods) + station (zones) torn down
    // above; drop the stale map + layer so installIslandAuras rebuilds cleanly.
    this.clearIslandAuras();
    if (this.atrium_layer?.parent) this.atrium_layer.parent.removeChild(this.atrium_layer);
    this.district?.destroy();
    this.district = null;
    this.hoveredPluginRoom = null;
    this.station.destroy();
    this.station = null;

    // Starfield re-bakes its accent-tinted stars
    if (this.starfield) {
      this.app.stage.removeChild(this.starfield.container);
      this.starfield.destroy();
      this.starfield = new Starfield(this.app.renderer, this.viewport.screenWidth, this.viewport.screenHeight);
      this.app.stage.addChildAt(this.starfield.container, 0);
    }

    // Rebake everything with the new palette, rebuild world + chrome
    resetGalacticTextures(this.app.renderer);
    this.drawBackground(WORLD_WIDTH, WORLD_HEIGHT);
    this.atrium_installLayer();
    this.buildChrome();

    // Restore nodes, agents, and sector activity
    for (const node of nodeDatas) this.addNode(node);
    const finishedOrder = this.finishedOrder;
    this.finishedOrder = [];
    for (const agent of agentDatas) this.addAgent(agent);
    // Re-adding reorders the finished list by room iteration — keep the real
    // newest-first completion order so eviction stays oldest-first.
    this.finishedOrder = finishedOrder.filter(k => this.agentToNode.has(k));
    activeSectors.forEach(id => this.station?.setZoneActive(id, true));
  }

  private refreshAgentQuartersActivity(): void {
    if (!this.station || !this.zoneOwnerNodeId) return;
    const hub = this.nodes.get(this.zoneOwnerNodeId);
    let working = false;
    hub?.rooms.forEach(room => {
      const s = room.data.status;
      if (isWorkingStatus(s)) working = true;
    });
    this.station.setZoneActive('agent-quarters', working);
  }
  
  showMessage(message: MeshMessage): void {
    const fromNodeId = this.agentToNode.get(message.from);
    const toNodeId = this.agentToNode.get(message.to);
    if (!fromNodeId || !toNodeId) return;
    
    const fromNode = this.nodes.get(fromNodeId);
    const toNode = this.nodes.get(toNodeId);
    const fromRoom = fromNode?.rooms.get(message.from);
    const toRoom = toNode?.rooms.get(message.to);
    
    if (!fromRoom || !toRoom) return;
    
    const fromPos = fromRoom.getWorldAgentPosition(fromNode!.x, fromNode!.y);
    const toPos = toRoom.getWorldAgentPosition(toNode!.x, toNode!.y);
    
    const trail = new MessageTrail(fromPos, toPos, message.type);
    this.effectsLayer.addChild(trail.container);
    setTimeout(() => this.effectsLayer.removeChild(trail.container), 600);
  }

  // ══════════════════════════════════════════════════════════════
  // LIVE FX — per-tool pulses, walk trails, completion bursts, metrics
  // ══════════════════════════════════════════════════════════════

  /** Glow color per tool family — file edits / shell / web / image / kanban. */
  private static toolFamilyColor(kind: string): number {
    const k = (kind || '').toLowerCase();
    if (/write|edit|multiedit|create|update|patch|apply|insert|notebook/.test(k)) return GALACTIC.gold;        // file edits → gold
    if (/bash|exec|shell|run|command|terminal|\bcmd\b|spawn|script/.test(k)) return GALACTIC.warn;             // shell → amber
    if (/web|fetch|http|url|curl|download|\bapi\b|browser|request|search/.test(k)) return 0x3ec6d8;            // web → cyan
    if (/image|img|render|paint|draw|flux|comfy|sdxl|diffus|\bgen\b|video/.test(k)) return GALACTIC.accent2;   // image gen → violet
    if (/kanban|task|board|ticket|issue|note/.test(k)) return GALACTIC.ok;                                     // kanban → green
    if (/read|list|cat|grep|glob|view|\bls\b|find|memory/.test(k)) return GALACTIC.info;                       // data read → blue
    return GALACTIC.goldLt;
  }

  /**
   * Public: react visibly to a single tool invocation. Records the event for
   * the Tools/Min HUD readout, fires a colored pulse ring at the agent's room,
   * and arms a short particle trail while the agent walks to its tool sector.
   * Pairs with routeAgentToToolSector (which handles the actual movement).
   */
  pulseToolAtRoom(sessionKey: string, kind: string): void {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.toolEventTimes.push(now);
    if (this.toolEventTimes.length > 512) this.toolEventTimes.splice(0, this.toolEventTimes.length - 512);

    if (!isGalactic() || prefersReducedMotion()) return;
    const found = this.roomOf(sessionKey);
    if (!found) return;
    const pos = found.room.getWorldAgentPosition(found.nodeArea.x, found.nodeArea.y);
    const color = ActivityMap.toolFamilyColor(kind);
    this.spawnPulseRing(pos.x, pos.y, color);
    // Ripple the island this tool call landed on (mesh plan).
    this.rippleIslandAt(pos.x, pos.y, found.nodeArea.data.id, 0.85, color);
    // Arm a fading walk-trail toward the matched sector for ~1.2s.
    if (this.sectorForToolKind(kind)) {
      this.trailingAgents.set(sessionKey, { until: now + 1200, color });
    }
  }

  /** An expanding additive ring + soft core that fades over ~620ms. */
  private spawnPulseRing(x: number, y: number, color: number): void {
    const g = new PIXI.Graphics();
    g.x = x; g.y = y;
    (g as any).blendMode = PIXI.BLEND_MODES.ADD;
    const draw = (r: number, a: number) => {
      g.clear();
      g.lineStyle(2.2, color, a);
      g.drawCircle(0, 0, r);
      g.lineStyle(0);
      g.beginFill(color, a * 0.28);
      g.drawCircle(0, 0, r * 0.5);
      g.endFill();
    };
    draw(4, 0.85);
    this.effectsLayer.addChild(g);
    const state = { r: 4, a: 0.85 };
    gsap.to(state, {
      r: 30, a: 0, duration: 0.62, ease: 'power2.out',
      onUpdate: () => { if (!this.destroyed) draw(state.r, state.a); },
      onComplete: () => {
        if (this.destroyed) return;
        this.effectsLayer.removeChild(g); g.destroy();
      },
    });
  }

  /** Per-frame: drop a fading dot at each trailing agent's current position. */
  private updateWalkTrails(): void {
    if (this.trailingAgents.size === 0 && this.trailDots.length === 0) return;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // Emit
    this.trailingAgents.forEach((info, key) => {
      if (nowMs >= info.until) { this.trailingAgents.delete(key); return; }
      if ((this.animationFrame & 1) !== 0) return; // every other frame
      const found = this.roomOf(key);
      if (!found) return;
      const pos = found.room.getWorldAgentPosition(found.nodeArea.x, found.nodeArea.y);
      const dot = new PIXI.Graphics();
      (dot as any).blendMode = PIXI.BLEND_MODES.ADD;
      dot.beginFill(info.color, 0.6);
      dot.drawCircle(0, 0, 2.6);
      dot.endFill();
      dot.x = pos.x; dot.y = pos.y - 14;
      this.effectsLayer.addChild(dot);
      this.trailDots.push({ g: dot, born: nowMs });
      if (this.trailDots.length > 160) {
        const old = this.trailDots.shift();
        if (old) { this.effectsLayer.removeChild(old.g); old.g.destroy(); }
      }
    });
    // Fade + expire
    for (let i = this.trailDots.length - 1; i >= 0; i--) {
      const d = this.trailDots[i];
      const age = nowMs - d.born;
      if (age >= 700) {
        this.effectsLayer.removeChild(d.g); d.g.destroy();
        this.trailDots.splice(i, 1);
      } else {
        d.g.alpha = 0.6 * (1 - age / 700);
      }
    }
  }

  /**
   * Public: a brief glyph burst + label when a subagent finishes, so the
   * transition is impossible to miss. Green for success, red for failure.
   */
  burstCompletion(sessionKey: string, success: boolean): void {
    // Log for time-scrub replay (no-op while replaying — that path re-fires us).
    this.recordReplayEvent({ sessionKey, kind: "complete", success });
    // Completions surge the hub heartbeat regardless of motion preference.
    this.surgeAtrium(success ? 0.8 : 1.2);
    if (!isGalactic() || prefersReducedMotion()) return;
    const found = this.roomOf(sessionKey);
    if (!found) return;
    const pos = found.room.getWorldAgentPosition(found.nodeArea.x, found.nodeArea.y);
    const color = success ? GALACTIC.ok : GALACTIC.err;
    // Stronger ripple on the island when an agent completes (mesh plan).
    this.rippleIslandAt(pos.x, pos.y, found.nodeArea.data.id, success ? 1.3 : 1.6, color);
    const burst = new PIXI.Graphics();
    (burst as any).blendMode = PIXI.BLEND_MODES.ADD;
    burst.x = pos.x; burst.y = pos.y - 20;
    this.effectsLayer.addChild(burst);
    const spokes = 8;
    const state = { t: 0 };
    gsap.to(state, {
      t: 1, duration: 0.5, ease: 'power3.out',
      onUpdate: () => {
        if (this.destroyed) return;
        burst.clear();
        const len = 6 + state.t * 16;
        const a = (1 - state.t) * 0.9;
        burst.lineStyle(2, color, a);
        for (let i = 0; i < spokes; i++) {
          const ang = (i / spokes) * Math.PI * 2;
          burst.moveTo(Math.cos(ang) * 4, Math.sin(ang) * 4);
          burst.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
        }
        burst.lineStyle(0);
        burst.beginFill(color, a * 0.5);
        burst.drawCircle(0, 0, 3 + state.t * 4);
        burst.endFill();
      },
      onComplete: () => {
        if (this.destroyed) return;
        this.effectsLayer.removeChild(burst); burst.destroy();
      },
    });
  }

  /** Feed the running token total (from the controller mesh state) for the HUD's
   *  Tokens/Hr readout. We keep two timestamped samples and derive a rate. */
  noteTokensTotal(total: number): void {
    if (!Number.isFinite(total) || total < 0) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // Reset the baseline if the total dropped (a restart / fresh session set).
    if (this.tokenBaseline === null || total < this.tokenBaseline.total) {
      this.tokenBaseline = { t: now, total };
    }
    this.tokenLatest = { t: now, total };
  }

  /** The host draws its own DOM metrics HUD — hide the in-canvas card. */
  setHudMetricsPanelVisible(visible: boolean): void {
    this.hudPanelHidden = !visible;
    this.hud?.setMetricsPanelVisible(visible);
  }

  /** Compute the live HUD metrics from internal counters + token samples. */
  private computeHudMetrics(): { agents: number; toolsPerMin: number; tokensPerHr: number } {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // Tools/min = tool events in the last 60s (trimmed here so it decays).
    const cutoff = now - 60_000;
    while (this.toolEventTimes.length && this.toolEventTimes[0] < cutoff) this.toolEventTimes.shift();
    const toolsPerMin = this.toolEventTimes.length;
    // Tokens/hr extrapolated from the baseline→latest delta.
    let tokensPerHr = 0;
    if (this.tokenBaseline && this.tokenLatest) {
      const dt = this.tokenLatest.t - this.tokenBaseline.t;
      const dTok = this.tokenLatest.total - this.tokenBaseline.total;
      if (dt > 2_000 && dTok > 0) tokensPerHr = (dTok / dt) * 3_600_000;
    }
    return { agents: this.agentToNode.size, toolsPerMin, tokensPerHr };
  }

  /**
   * Pop a tool-call chat bubble above the agent's sprite. Color-coded by tool
   * kind; follows the agent for ~3s then fades. Safe to call for off-screen
   * agents (rendering is harmless); no-ops if the agent has no room yet.
   */
  showToolBubble(sessionKey: string, kind: string, label: string): void {
    // Log for time-scrub replay (no-op while replaying — that path re-fires us).
    // `dialogue`-kind bubbles carry no toolKind, so classify by presence of one.
    this.recordReplayEvent({ sessionKey, kind: kind ? "tool" : "dialogue", toolKind: kind || undefined, label });
    const nodeId = this.agentToNode.get(sessionKey);
    if (!nodeId) return;
    const nodeArea = this.nodes.get(nodeId);
    const room = nodeArea?.rooms.get(sessionKey);
    if (!nodeArea || !room) return;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const bubble = new ToolBubble(kind, label, now);

    // Seed position immediately so it doesn't flash at the origin for one frame
    const anchor = room.getBubbleAnchor();
    bubble.container.x = nodeArea.x + room.container.x + anchor.x;
    bubble.container.y = nodeArea.y + room.container.y + anchor.y;
    bubble.container.scale.set(1 / Math.max(this.viewport.scale.x, 0.001));
    this.toolBubbleLayer.addChild(bubble.container);

    let arr = this.toolBubbles.get(sessionKey);
    if (!arr) { arr = []; this.toolBubbles.set(sessionKey, arr); }
    arr.push(bubble);

    // Cap the stack so a chatty agent can't pile up unbounded bubbles
    while (arr.length > 6) {
      const old = arr.shift();
      if (old) { this.toolBubbleLayer.removeChild(old.container); old.container.destroy({ children: true }); }
    }
  }

  /** Per-frame: expire dead bubbles and ease each per-agent vertical stack. */
  private updateToolBubbles(): void {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.toolBubbles.forEach((arr, sessionKey) => {
      // Expire (iterate backwards so splices are safe)
      for (let i = arr.length - 1; i >= 0; i--) {
        if (!arr[i].tick(now)) {
          this.toolBubbleLayer.removeChild(arr[i].container);
          arr[i].container.destroy({ children: true });
          arr.splice(i, 1);
        }
      }
      if (arr.length === 0) {
        this.toolBubbles.delete(sessionKey);
        this.bubblePlacementOffsets.delete(sessionKey);
        return;
      }

      // Newest at the base (offset 0), older ones drift up by their height + 4
      let stackY = 0;
      for (let i = arr.length - 1; i >= 0; i--) {
        const b = arr[i];
        b.stackOffset += (stackY - b.stackOffset) * 0.2;
        stackY += b.height + 4;
      }
    });
  }

  /**
   * Resolve every agent adornment in one screen-space pass. The scene graph
   * enforces the global layer order; this pass enforces spatial readability.
   */
  private updateAgentOverlays(): void {
    const zoom = Math.max(this.viewport.scale.x, 0.001);
    const sprites: SpriteObstacle[] = [];
    const bubbles: BubblePlacementInput[] = [];
    const labels: LabelPlacementInput[] = [];
    const roomByKey = new Map<string, { room: AgentRoom; node: NodeArea }>();

    this.nodes.forEach((node) => {
      node.rooms.forEach((room, sessionKey) => {
        roomByKey.set(sessionKey, { room, node });
        const hasBubble = (this.toolBubbles.get(sessionKey)?.length ?? 0) > 0;
        const roomVisible = node.container.visible && room.container.visible;
        room.syncOverlayRoot(node.x, node.y, hasBubble, node.container.alpha, roomVisible);
        if (!roomVisible) return;

        const world = room.getWorldVisualPosition(node.x, node.y);
        const screen = this.viewport.toScreen(world.x, world.y);
        // Generated galactic sprites are 64px tall in world space; the cozy
        // pixel fallback is smaller, but the conservative box prevents labels
        // from clipping either theme.
        sprites.push({
          id: sessionKey,
          rect: {
            x: screen.x - 25 * zoom,
            y: screen.y - 50 * zoom,
            width: 50 * zoom,
            height: 68 * zoom,
          },
        });

        const label = room.labelPlacementInput(
          screen.x,
          screen.y,
          zoom,
          hasBubble,
          this.labelPlacementOffsets.get(sessionKey),
        );
        if (label) labels.push(label);
      });
    });

    this.toolBubbles.forEach((arr, sessionKey) => {
      const found = roomByKey.get(sessionKey);
      if (!found || arr.length === 0) return;
      const roomVisible = found.node.container.visible && found.room.container.visible;
      for (const bubble of arr) bubble.container.visible = roomVisible;
      if (!roomVisible) return;
      const anchor = found.room.getBubbleAnchor();
      const worldX = found.node.x + found.room.container.x + anchor.x;
      const worldY = found.node.y + found.room.container.y + anchor.y;
      const screen = this.viewport.toScreen(worldX, worldY);
      let width = 0;
      let height = 0;
      for (const bubble of arr) {
        width = Math.max(width, bubble.width);
        height += bubble.height + 4;
      }
      height = Math.max(1, height - 4);
      bubbles.push({
        id: sessionKey,
        ownerId: sessionKey,
        preferred: { x: screen.x - width / 2, y: screen.y - height, width, height },
        previousOffset: this.bubblePlacementOffsets.get(sessionKey),
      });
    });

    const placed = placeAgentOverlays({
      sprites,
      bubbles,
      labels,
      bounds: {
        width: this.viewport.screenWidth,
        height: this.viewport.screenHeight,
        padding: 5,
      },
      gap: 3,
      hysteresisPx: 9,
      cellSize: 64,
    });

    this.lastOverlaySprites = sprites;
    this.lastOverlayPlaced = placed;

    roomByKey.forEach(({ room }, sessionKey) => {
      const placement = placed.labels[sessionKey];
      room.applyLabelPlacement(placement, zoom);
      if (placement && !placement.hidden) {
        this.labelPlacementOffsets.set(sessionKey, { x: placement.offsetX, y: placement.offsetY });
      } else {
        this.labelPlacementOffsets.delete(sessionKey);
      }
    });

    this.toolBubbles.forEach((arr, sessionKey) => {
      const placement = placed.bubbles[sessionKey];
      if (!placement || arr.length === 0) return;
      this.bubblePlacementOffsets.set(sessionKey, { x: placement.offsetX, y: placement.offsetY });
      const baseScreenX = placement.rect.x + placement.rect.width / 2;
      const baseScreenY = placement.rect.y + placement.rect.height;
      const baseWorld = this.viewport.toWorld(baseScreenX, baseScreenY);
      const invZoom = 1 / zoom;
      for (const bubble of arr) {
        bubble.container.scale.set(invZoom);
        bubble.container.position.set(baseWorld.x, baseWorld.y - bubble.stackOffset * invZoom);
      }
    });
  }

  /** Destroy bubbles for one agent, or all when no key is given. */
  private destroyToolBubbles(sessionKey?: string): void {
    const drop = (arr: ToolBubble[]) => arr.forEach(b => {
      this.toolBubbleLayer.removeChild(b.container);
      b.container.destroy({ children: true });
    });
    if (sessionKey) {
      const arr = this.toolBubbles.get(sessionKey);
      if (arr) { drop(arr); this.toolBubbles.delete(sessionKey); }
      this.bubblePlacementOffsets.delete(sessionKey);
    } else {
      this.toolBubbles.forEach(drop);
      this.toolBubbles.clear();
      this.bubblePlacementOffsets.clear();
    }
  }

  centerView(): void {
    if (this.nodes.size > 0) {
      this.zoomToFit();
    } else {
      this.viewport.moveCenter(800, 600);
    }
  }
  
  zoomIn(): void {
    this.animateZoom(this.viewport.scale.x * ZOOM_STEP_IN);
  }
  
  zoomOut(): void {
    this.animateZoom(this.viewport.scale.x * ZOOM_STEP_OUT);
  }

  private animateZoom(scale: number): void {
    const targetScale = Math.min(Math.max(scale, MIN_ZOOM), MAX_ZOOM);
    this.viewport.snapZoom({
      width: this.viewport.screenWidth / targetScale,
      time: ZOOM_EASE_MS,
      ease: 'easeInOutSine',
      removeOnComplete: true,
      forceStart: true,
    });
  }
  
  /**
   * Screen area zoomToFit may use, after host chrome insets. `dx/dy` is the
   * free area's centre offset from the screen centre (screen px) — the camera
   * centre shifts by that so the framed world lands in the free area. Insets
   * that would leave less than half the screen on an axis are ignored.
   */
  private fitFrame(): { width: number; height: number; dx: number; dy: number } {
    const sw = this.viewport.screenWidth;
    const sh = this.viewport.screenHeight;
    let { top, right, bottom, left } = this.fitInsets;
    if (left + right > sw * 0.5) { left = 0; right = 0; }
    if (top + bottom > sh * 0.5) { top = 0; bottom = 0; }
    const width = Math.max(1, sw - left - right);
    const height = Math.max(1, sh - top - bottom);
    return { width, height, dx: (left - right) / 2, dy: (top - bottom) / 2 };
  }

  /**
   * Host DOM chrome rects (HUD column, docked panels) in canvas px. Floor /
   * zone / plugin signs that slide under one are hidden rather than drawn
   * half-covered (they fade back in once the camera moves them clear).
   */
  setChromeRects(rects: readonly ScreenRect[]): void {
    this.chromeRects = rects.filter((r) => r.width > 0 && r.height > 0).map((r) => ({ ...r }));
    if (!this.chromeRects.length) this.chromeOccluded.clear();
  }

  /**
   * Hide floor / zone signs that would be drawn half-covered: under the host
   * HUD chrome (any overlap), or under agent sprites / name chips / tool
   * bubbles (more than a sliver). They fade back in once uncovered.
   */
  private applyChromeOcclusion(): void {
    if (this.animationFrame % 4 === 0) {
      this.chromeOccluded.clear();
      const area = (a: ScreenRect, b: ScreenRect) => {
        const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        return w > 0 && h > 0 ? w * h : 0;
      };
      const crowd: ScreenRect[] = [...this.lastOverlaySprites.map((sp) => sp.rect)];
      for (const pl of Object.values(this.lastOverlayPlaced.labels)) if (pl && !pl.hidden) crowd.push(pl.rect);
      for (const pl of Object.values(this.lastOverlayPlaced.bubbles)) if (pl && !pl.hidden) crowd.push(pl.rect);
      for (const layer of [this.station?.labelLayer, this.district?.labelLayer]) {
        if (!layer || !layer.visible) continue;
        for (const child of layer.children) {
          if (!child.visible) continue;
          const b = child.getBounds();
          if (!(b.width > 0 && b.height > 0)) continue;
          const sign = { x: b.x, y: b.y, width: b.width, height: b.height };
          const underChrome = this.chromeRects.some((r) => area(sign, r) > 0);
          const covered = crowd.reduce((sum, r) => sum + area(sign, r), 0) > sign.width * sign.height * 0.12;
          if (underChrome || covered) this.chromeOccluded.add(child);
        }
      }
    }
    for (const child of this.chromeOccluded) child.alpha = 0;
  }

  /** Host chrome rects last set by {@link setChromeRects} (canvas px). */
  getChromeRects(): readonly ScreenRect[] {
    return this.chromeRects;
  }

  /** Placed agent name chips + tool bubbles on screen (canvas px) — DOM overlays avoid them. */
  agentChipScreenRects(): ScreenRect[] {
    const out: ScreenRect[] = [];
    for (const pl of Object.values(this.lastOverlayPlaced.labels)) if (pl && !pl.hidden) out.push(pl.rect);
    for (const pl of Object.values(this.lastOverlayPlaced.bubbles)) if (pl && !pl.hidden) out.push(pl.rect);
    return out;
  }

  /** Floor / zone / plugin-room signs on screen (canvas px) — DOM overlays avoid them. */
  signScreenRects(): ScreenRect[] {
    if (this.destroyed || !this.viewport) return [];
    return this.zoneLabelScreenRects();
  }

  /**
   * Like cameraFlyTo, but lands the world point in the centre of the area the
   * host chrome leaves free (the fit insets), not under the HUD column.
   */
  cameraFlyToFree(x: number, y: number, scale: number, timeMs = 800): void {
    if (this.destroyed || !this.viewport || !this.viewport.transform) return;
    const f = this.fitFrame();
    const s = Math.min(Math.max(scale, MIN_ZOOM), MAX_ZOOM);
    this.cameraFlyTo(x - f.dx / s, y - f.dy / s, s, timeMs);
  }

  /** Reserve screen px on each edge that host DOM chrome (HUD column, docked
   *  panels) covers; zoomToFit frames the world inside what's left. */
  setFitInsets(insets: Partial<{ top: number; right: number; bottom: number; left: number }>): void {
    const clean = (v: number | undefined) => Math.max(0, Math.round(Number(v) || 0));
    this.fitInsets = {
      top: clean(insets.top),
      right: clean(insets.right),
      bottom: clean(insets.bottom),
      left: clean(insets.left),
    };
  }

  /**
   * Screen-space geometry for a DOM hover card about `sessionKey`: `anchor` is
   * the agent's sprite ∪ its placed name tag (and tool bubbles); `obstacles`
   * are the other visible name tags + floor/zone signs to keep clear.
   */
  hoverCardGeometry(sessionKey: string): { anchor: ScreenRect | null; obstacles: ScreenRect[] } {
    if (this.destroyed) return { anchor: null, obstacles: [] };
    const union = (a: ScreenRect | null, b: ScreenRect): ScreenRect => {
      if (!a) return { ...b };
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return {
        x,
        y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
      };
    };
    let anchor: ScreenRect | null = null;
    const sprite = this.lastOverlaySprites.find((sp) => sp.id === sessionKey);
    if (sprite) anchor = union(anchor, sprite.rect);
    else {
      const p = this.agentScreenPos(sessionKey);
      const z = this.getZoom();
      if (p) anchor = { x: p.x - 25 * z, y: p.y - 50 * z, width: 50 * z, height: 68 * z };
    }
    const obstacles: ScreenRect[] = [];
    for (const [id, pl] of Object.entries(this.lastOverlayPlaced.labels)) {
      if (pl.hidden) continue;
      if (id === sessionKey) anchor = union(anchor, pl.rect);
      else obstacles.push(pl.rect);
    }
    const ownBubble = this.lastOverlayPlaced.bubbles[sessionKey];
    if (ownBubble && !ownBubble.hidden) anchor = union(anchor, ownBubble.rect);
    obstacles.push(...this.zoneLabelScreenRects());
    return { anchor, obstacles };
  }

  /** Visible floor / zone / plugin-room signs, in canvas-local screen px. */
  private zoneLabelScreenRects(): ScreenRect[] {
    const out: ScreenRect[] = [];
    const sw = this.viewport.screenWidth;
    const sh = this.viewport.screenHeight;
    const layers = [this.station?.labelLayer, this.district?.labelLayer];
    for (const layer of layers) {
      if (!layer || !layer.visible || !layer.worldVisible) continue;
      for (const child of layer.children) {
        if (!child.visible || child.alpha <= 0.02) continue;
        const b = child.getBounds();
        if (!(b.width > 0 && b.height > 0)) continue;
        if (b.x > sw || b.y > sh || b.x + b.width < 0 || b.y + b.height < 0) continue;
        out.push({ x: b.x, y: b.y, width: b.width, height: b.height });
      }
    }
    return out;
  }

  zoomToFit(): void {
    if (isGalactic() && this.station) {
      // Fit the platform plus any occupied pods
      const b = this.station.bounds;
      let minX = b.minX, maxX = b.maxX, minY = b.minY, maxY = b.maxY;
      if (this.podSlotOf.size === 0) {
        // No pods yet — tighter fit on the platform itself
        minX = 800 - 900; maxX = 800 + 900; minY = b.minY; maxY = 600 + 480;
        // …plus the Plugin District ring when plugins have rooms.
        const d = this.district?.bounds();
        if (d) {
          minX = Math.min(minX, d.minX - 40); maxX = Math.max(maxX, d.maxX + 40);
          minY = Math.min(minY, d.minY - 20); maxY = Math.max(maxY, d.maxY + 20);
        }
      } else {
        const d = this.district?.bounds();
        if (d) {
          minX = Math.min(minX, d.minX - 40); maxX = Math.max(maxX, d.maxX + 40);
          minY = Math.min(minY, d.minY - 20); maxY = Math.max(maxY, d.maxY + 20);
        }
        // Expand to include every actually-placed satellite. Static
        // bounds can lag behind extra-ring spillover; reading live node
        // positions guarantees the camera frames whatever the engine
        // actually put on the field.
        this.nodes.forEach((n) => {
          if (n.x === this.station!.agentQuartersCenter.x && n.y === this.station!.agentQuartersCenter.y) return;
          minX = Math.min(minX, n.x - 220);
          maxX = Math.max(maxX, n.x + 220);
          minY = Math.min(minY, n.y - 180);
          maxY = Math.max(maxY, n.y + 220);
        });
      }
      const w = maxX - minX;
      const h = maxY - minY;
      const fit = this.fitFrame();
      const targetScale = Math.min(fit.width / (w + 100), fit.height / (h + 80), 1);
      // pixi-viewport's native animate respects its plugin loop, so it
      // can't be stomped by an in-flight wheel/drag smoothing pass the
      // way raw gsap.to(viewport.scale, ...) silently was.
      this.viewport.plugins.remove('animate');
      this.viewport.animate({
        position: {
          x: minX + w / 2 - fit.dx / targetScale,
          y: minY + h / 2 - fit.dy / targetScale,
        },
        scale: targetScale,
        time: 350,
        ease: 'easeInOutSine',
        removeOnInterrupt: true,
      });
      return;
    }

    if (this.nodes.size === 0) {
      this.viewport.moveCenter(800, 600);
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    this.nodes.forEach(n => {
      minX = Math.min(minX, n.x - 200);
      maxX = Math.max(maxX, n.x + 200);
      minY = Math.min(minY, n.y - 150);
      maxY = Math.max(maxY, n.y + 200);
    });
    
    const w = maxX - minX;
    const h = maxY - minY;
    const fit = this.fitFrame();
    const targetScale = Math.min(fit.width / (w + 100), fit.height / (h + 80), 1);
    
    this.viewport.plugins.remove('animate');
    this.viewport.animate({
      position: {
        x: minX + w / 2 - fit.dx / targetScale,
        y: minY + h / 2 - fit.dy / targetScale,
      },
      scale: targetScale,
      time: 350,
      ease: 'easeInOutSine',
      removeOnInterrupt: true,
    });
  }

  clear(): void {
    this.completionTimers.forEach(t => clearTimeout(t));
    this.completionTimers.clear();
    this.agentToNode.forEach((nodeId, sessionKey) => {
      this.removeAgent(sessionKey);
    });
    this.nodes.forEach((_, nodeId) => {
      this.removeNode(nodeId);
    });
  }
  
  destroy(): void {
    this.destroyed = true;
    this.frameListeners.clear();
    this.overlayLayers = [];
    // Plugin District first: its sign-bob / build tweens must stop before the
    // stage is torn down (a live tween on a destroyed Pixi object throws
    // every frame after navigating away from the map).
    this.district?.destroy();
    this.district = null;
    this.hoveredPluginRoom = null;
    if (this._visHandler) {
      document.removeEventListener('visibilitychange', this._visHandler);
      this._visHandler = null;
    }
    if (this.contextRestoreTimer) { clearTimeout(this.contextRestoreTimer); this.contextRestoreTimer = null; }
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('keydown', this.handleKeydown);
    window.removeEventListener('focus', this.handleWindowFocus);
    window.removeEventListener('blur', this.handleWindowBlur);
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.canvas.removeEventListener('pointerenter', this.handleCanvasPointerEnter);
    this.canvas.removeEventListener('pointerleave', this.handleCanvasPointerLeave);
    this.canvas.removeEventListener('pointerdown', this.handleCanvasPointerDown);
    this.canvas.removeEventListener('keydown', this.handleDebugKey);
    this.cinematicCam?.destroy();
    this.cinematicCam = null;
    this.routeReturnTimers.forEach(t => clearTimeout(t));
    this.routeReturnTimers.clear();
    this.completionTimers.forEach(t => clearTimeout(t));
    this.completionTimers.clear();
    // Stop live-FX tweens so their onComplete can't touch a destroyed stage.
    this.trailDots.forEach(d => gsap.killTweensOf(d.g));
    this.trailDots = [];
    this.trailingAgents.clear();
    this.clearIslandAuras();
    // Tear down the station BEFORE app.destroy() nulls the display-object
    // transforms: station.destroy() kills the infinite (repeat:-1) ring/label
    // GSAP tweens, which otherwise keep firing every frame on now-destroyed
    // Pixi objects → "Cannot set properties of null (setting 'rotation')".
    try { this.station?.destroy(); } catch { /* best-effort */ }
    this.station = null;
    // Kill any in-flight camera fly-to so the pixi-viewport `animate` plugin
    // can't tick against a destroyed viewport → "reading 'scale' of null".
    try { this.viewport?.plugins?.remove('animate'); } catch { /* best-effort */ }
    gsap.killTweensOf(this.viewport);
    // Free only THIS renderer's baked set. Do NOT pass `texture: true` to
    // app.destroy: sprites share module-level textures (agent PNG cache,
    // provider logos) with every other live/future engine, and destroying
    // them nulls their baseTexture — the next map mount then renders without
    // furniture/sprites ("reading 'valid' of null") until a page refresh.
    try { resetGalacticTextures(this.app.renderer); } catch { /* best-effort */ }
    this.app.destroy(true, { children: true, texture: false });
  }
  
  getAgentCount(): number {
    return this.agentToNode.size;
  }
  
  getNodeCount(): number {
    return this.nodes.size;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 1 holographic revamp — broadcast camera + district accents support.
  // All additive: no existing sprite size / scale / radius is touched here.
  // ──────────────────────────────────────────────────────────────────────────

  /** Faint per-district ground tint + accent border, drawn once per station
   *  build (re-run from drawBackground on theme rebuilds). Sits behind agents;
   *  agent sprites are NEVER recoloured — only the surrounding ground. */
  private districtAccentG: PIXI.Graphics | null = null;
  private ambientPhase = 0;

  private installDistrictAccents(): void {
    if (!this.station) return;
    const g = new PIXI.Graphics();
    for (const zone of this.station.zones) {
      const color = accentForSector(zone.def.id);
      // Faint ground tint inside the district.
      g.beginFill(color, 0.09);
      g.drawPolygon(zone.poly);
      g.endFill();
      // The lit perimeter stroke is now drawn by the animated IslandAura
      // (installIslandAuras) so it can pulse/shimmer with live activity; a very
      // faint static rim stays underneath so an idle/zero-activity district
      // still reads as bounded.
      g.lineStyle(1, color, 0.22);
      g.drawPolygon(zone.poly);
      g.lineStyle(0);
      // Short accent underline at the label anchor (top vertex).
      const tx = zone.poly[0];
      const ty = zone.poly[1];
      g.lineStyle(2, color, 0.7);
      g.moveTo(tx - 18, ty - 1);
      g.lineTo(tx + 18, ty - 1);
      g.lineStyle(0);
    }
    this.districtAccentG = g;
    // Above the floor/border, below the hover-glow + decor layers.
    const idx = Math.min(2, this.station.container.children.length);
    this.station.container.addChildAt(g, idx);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ISLAND AURAS — animated, activity-driven territory borders (mesh plan).
  // ──────────────────────────────────────────────────────────────────────────

  private islandAuraColors() {
    return {
      base: GALACTIC.gold,
      ok: GALACTIC.ok,
      warn: GALACTIC.warn,
      err: GALACTIC.err,
      bright: GALACTIC.goldLt,
    };
  }

  /** Build one animated aura per station district zone. Station-local space ==
   *  world space (the station container sits at the world origin), so zone.poly
   *  is used verbatim. Re-run on every station (re)build. */
  private installIslandAuras(): void {
    if (!this.station) return;
    this.clearIslandAuras();
    const layer = new PIXI.Container();
    layer.zIndex = 1; // above floor/accent tint, still behind agents (nodeLayer)
    this.station.container.addChild(layer);
    this.islandAuraLayer = layer;
    const reduced = prefersReducedMotion();
    const colors = this.islandAuraColors();
    for (const zone of this.station.zones) {
      const aura = new IslandAura({
        poly: zone.poly,
        center: { x: zone.center.x, y: zone.center.y },
        colors: { ...colors, base: accentForSector(zone.def.id) },
        reducedMotion: reduced,
      });
      layer.addChild(aura.container);
      this.islandAuras.set(`zone:${zone.def.id}`, aura);
    }
  }

  /** Attach an animated aura to a satellite pod (pod-local diamond). */
  private installPodAura(
    nodeId: string,
    nodeArea: NodeArea,
    corners: { top: PIXI.Point; right: PIXI.Point; bottom: PIXI.Point; left: PIXI.Point },
  ): void {
    const aura = new IslandAura({
      poly: [
        corners.top.x, corners.top.y,
        corners.right.x, corners.right.y,
        corners.bottom.x, corners.bottom.y,
        corners.left.x, corners.left.y,
      ],
      center: { x: 0, y: 0 },
      colors: this.islandAuraColors(),
      reducedMotion: prefersReducedMotion(),
    });
    // zIndex above the pod platform (-100000) but below agent rooms (10 + y).
    aura.container.zIndex = 5;
    nodeArea.container.addChild(aura.container);
    this.islandAuras.set(`pod:${nodeId}`, aura);
  }

  private removePodAura(nodeId: string): void {
    const aura = this.islandAuras.get(`pod:${nodeId}`);
    if (!aura) return;
    aura.destroy();
    this.islandAuras.delete(`pod:${nodeId}`);
  }

  private clearIslandAuras(): void {
    this.islandAuras.forEach(a => { try { a.destroy(); } catch { /* best effort */ } });
    this.islandAuras.clear();
    if (this.islandAuraLayer) {
      try { this.islandAuraLayer.destroy({ children: true }); } catch { /* best effort */ }
      this.islandAuraLayer = null;
    }
  }

  /** Classify an agent status into the island mood priority bucket. */
  private static moodOf(status?: string): IslandMood {
    const s = (status ?? '').toLowerCase();
    if (s === 'failed' || s === 'error' || s === 'errored') return 'failed';
    if (s === 'blocked' || s === 'waiting' || s === 'paused') return 'blocked';
    if (s === 'running' || s === 'working' || s === 'starting' || s === 'finishing' || s === 'busy') return 'working';
    return 'idle';
  }

  private static escalateMood(a: IslandMood, b: IslandMood): IslandMood {
    const rank: Record<IslandMood, number> = { idle: 0, working: 1, blocked: 2, failed: 3 };
    return rank[b] > rank[a] ? b : a;
  }

  /** Recompute per-island activity from live agents + status and feed each aura.
   *  Zone occupancy is point-in-poly over world-space agent positions; pod
   *  occupancy is the node's own room membership. Real signals only. */
  private refreshIslandActivity(): void {
    if (this.islandAuras.size === 0) return;

    // Snapshot live agent world positions + status once.
    const agents: Array<{ x: number; y: number; mood: IslandMood }> = [];
    for (const sk of this.agentToNode.keys()) {
      const p = this.agentWorldPos(sk);
      if (!p) continue;
      const status = this.roomOf(sk)?.room.data.status;
      agents.push({ x: p.x, y: p.y, mood: ActivityMap.moodOf(status) });
    }

    // Zone islands: count agents whose world position falls inside the diamond.
    if (this.station) {
      for (const zone of this.station.zones) {
        const aura = this.islandAuras.get(`zone:${zone.def.id}`);
        if (!aura) continue;
        let total = 0;
        let working = 0;
        let mood: IslandMood = 'idle';
        for (const a of agents) {
          if (!this.pointInPoly(a.x, a.y, zone.poly)) continue;
          total++;
          if (a.mood === 'working') working++;
          mood = ActivityMap.escalateMood(mood, a.mood);
        }
        aura.setActivity({ total, working, mood });
      }
    }

    // Pod islands: each satellite node's own room membership.
    this.nodes.forEach((nodeArea, nodeId) => {
      const aura = this.islandAuras.get(`pod:${nodeId}`);
      if (!aura) return;
      let total = 0;
      let working = 0;
      let mood: IslandMood = 'idle';
      nodeArea.rooms.forEach(room => {
        total++;
        const m = ActivityMap.moodOf(room.data.status);
        if (m === 'working') working++;
        mood = ActivityMap.escalateMood(mood, m);
      });
      aura.setActivity({ total, working, mood });
    });
  }

  /** Tick every aura's animation (called each frame from the render loop). */
  private updateIslandAuras(dtSeconds: number): void {
    if (this.islandAuras.size === 0) return;
    this.islandAuras.forEach(a => a.tick(dtSeconds));
  }

  /** Fire a ripple on the island(s) containing a world point — both the station
   *  zone it lands in and (if the agent lives on a satellite) that pod. */
  private rippleIslandAt(
    worldX: number,
    worldY: number,
    nodeId: string | undefined,
    strength: number,
    color?: number,
  ): void {
    const sectorId = this.sectorIdAtWorld(worldX, worldY);
    if (sectorId) this.islandAuras.get(`zone:${sectorId}`)?.ripple(strength, color);
    if (nodeId) this.islandAuras.get(`pod:${nodeId}`)?.ripple(strength, color);
  }

  /** Ray-cast point-in-polygon over a flat [x0,y0,x1,y1,...] point array. */
  private pointInPoly(x: number, y: number, poly: number[]): boolean {
    let inside = false;
    const n = poly.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i * 2], yi = poly[i * 2 + 1];
      const xj = poly[j * 2], yj = poly[j * 2 + 1];
      const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /** Live viewport handle (broadcast camera + DOM highlight projection). */
  getViewport(): Viewport {
    return this.viewport;
  }

  // ── External overlay hooks (review mesh layer) ─────────────────────────

  /** Subscribe to the engine's frame tick (ms since last frame). */
  onFrame(fn: (deltaMS: number) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /** A world-space container drawn above agents/effects and below labels. */
  createOverlayLayer(): PIXI.Container {
    const layer = new PIXI.Container();
    const idx = this.viewport.getChildIndex(this.effectsLayer) + 1 + this.overlayLayers.length;
    this.viewport.addChildAt(layer, Math.min(idx, this.viewport.children.length));
    this.overlayLayers.push(layer);
    return layer;
  }

  removeOverlayLayer(layer: PIXI.Container): void {
    this.overlayLayers = this.overlayLayers.filter((l) => l !== layer);
    if (!this.destroyed && layer.parent) layer.parent.removeChild(layer);
    try { layer.destroy({ children: true }); } catch { /* already gone */ }
  }

  /** World-space center of the Executive Suite pad (review station). */
  getExecutiveCenter(): { x: number; y: number } {
    const c = this.station?.executiveCenter;
    return c ? { x: c.x, y: c.y } : { x: 800 + 640, y: 600 - 330 };
  }

  /** Map sessionKey of the agent tracking `runId` (sub-agent runs), or null. */
  findAgentKeyByRunId(runId: string): string | null {
    if (!runId) return null;
    let hit: string | null = null;
    this.nodes.forEach((node) => {
      if (hit) return;
      node.rooms.forEach((room, key) => {
        if (!hit && room.data.runId === runId) hit = key;
      });
    });
    return hit;
  }

  /** Current viewport zoom (world → screen scale). */
  getZoom(): number {
    return this.destroyed || !this.viewport?.transform ? 1 : this.viewport.scale.x;
  }

  /** World-space position of an agent sprite, or null if not on the map. */
  /** Agent position in canvas-local screen px (for DOM overlays anchored to sprites). */
  agentScreenPos(sessionKey: string): { x: number; y: number } | null {
    const p = this.agentWorldPos(sessionKey);
    if (!p) return null;
    const s = this.viewport.toScreen(p.x, p.y);
    return { x: s.x, y: s.y };
  }

  /** Agent spread toggle (map HUD "Spread: On/Off"; persisted). */
  isSpreadEnabled(): boolean { return this.spread.isEnabled(); }
  setSpreadEnabled(on: boolean): void { this.spread.setEnabled(on); }
  onSpreadChange(fn: (on: boolean) => void): () => void { return this.spread.onChange(fn); }
  /** sessionKey → { sectorId, slot, domain } from the latest spread plan. */
  spreadPlan(): ReadonlyMap<string, { sectorId: string; slot: number; domain: string | null }> { return this.spread.plan(); }

  agentWorldPos(sessionKey: string): { x: number; y: number } | null {
    const found = this.roomOf(sessionKey);
    if (!found) return null;
    // Include the agent's CURRENT walked position within the room (localX/Y)
    // — the sprite, status indicator, backend badge, and FX particles must all
    // read the same point. Without this the FX layer renders at the room
    // anchor while the sprite has walked across the floor.
    return {
      x: found.nodeArea.x + found.room.container.x + found.room.localX,
      y: found.nodeArea.y + found.room.container.y + found.room.localY,
    };
  }

  /** True if the agent is currently placed on the map. */
  hasAgent(sessionKey: string): boolean {
    return this.agentToNode.has(sessionKey);
  }

  /** All on-map agent session keys (for nearest-agent hit tests). */
  agentSessionKeys(): string[] {
    return Array.from(this.agentToNode.keys());
  }

  /** Sector id whose diamond contains a world point, or null. */
  sectorIdAtWorld(x: number, y: number): string | null {
    if (!this.station) return null;
    for (const zone of this.station.zones) {
      if (this.pointInPoly(x, y, zone.poly)) return zone.def.id;
    }
    return null;
  }

  /** World-space center of a sector by id (broadcast camera targets), or null. */
  getSectorCenter(sectorId: string): { x: number; y: number } | null {
    const z = this.station?.zones.find((zz) => zz.def.id === sectorId);
    return z ? { x: z.center.x, y: z.center.y } : null;
  }

  /** Nearest agent sessionKey to a world point within maxDist px, or null. */
  nearestAgentToWorld(x: number, y: number, maxDist = 160): string | null {
    let best: string | null = null;
    let bestD = maxDist * maxDist;
    for (const sessionKey of this.agentToNode.keys()) {
      const p = this.agentWorldPos(sessionKey);
      if (!p) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = sessionKey;
      }
    }
    return best;
  }

  /** Eased camera fly to a world point at a target scale (broadcast + dbl-click). */
  cameraFlyTo(x: number, y: number, scale: number, timeMs = 800): void {
    // The CameraDirector drives this from a rAF loop that can outlive the
    // engine by a frame (teardown race) — and `animate()` reads the viewport's
    // transform, which app.destroy() sets to null. Bail if we're gone.
    if (this.destroyed || !this.viewport || !this.viewport.transform) return;
    const s = Math.min(Math.max(scale, MIN_ZOOM), MAX_ZOOM);
    this.viewport.plugins.remove('animate');
    this.viewport.animate({
      position: { x, y },
      scale: s,
      time: timeMs,
      ease: 'easeInOutSine',
      removeOnInterrupt: true,
    });
  }

  /**
   * Current camera transform as `{zoom, centerX, centerY}` in world coords.
   * Used by the cross-device camera mirror (web publishes this; mobile applies
   * it via {@link applyCamera}). Returns null while the engine is torn down.
   */
  getCamera(): { zoom: number; centerX: number; centerY: number } | null {
    if (this.destroyed || !this.viewport || !this.viewport.transform) return null;
    const c = this.viewport.center;
    return { zoom: this.viewport.scale.x, centerX: c.x, centerY: c.y };
  }

  /**
   * Apply a camera transform driven by an external source (the cross-device
   * mirror, or any remote director). Thin eased wrapper over {@link cameraFlyTo}
   * so callers can speak in `{zoom, centerX, centerY}` terms.
   */
  applyCamera(zoom: number, centerX: number, centerY: number, easeMs = 600): void {
    this.cameraFlyTo(centerX, centerY, zoom, easeMs);
  }

  /**
   * Subscribe to "camera settled" — fires after a manual pan/zoom (drag, wheel,
   * pinch) OR an animated {@link cameraFlyTo} completes. The consumer debounces
   * and reads {@link getCamera}. Returns an unsubscribe fn. No-op on engines
   * whose viewport has no event emitter (defensive for swapped engines).
   */
  onCameraSettle(cb: () => void): () => void {
    const vp = this.viewport as unknown as {
      on?: (ev: string, fn: () => void) => void;
      off?: (ev: string, fn: () => void) => void;
    };
    if (!vp || typeof vp.on !== "function") return () => {};
    const handler = (): void => cb();
    vp.on("moved-end", handler);
    vp.on("zoomed-end", handler);
    return () => {
      try {
        vp.off?.("moved-end", handler);
        vp.off?.("zoomed-end", handler);
      } catch {
        /* ignore */
      }
    };
  }

  /** One slow cinematic ambient drift step around the map center (idle mode). */
  ambientDriftStep(): void {
    const b = this.station?.bounds;
    const cx = b ? (b.minX + b.maxX) / 2 : 800;
    const cy = b ? (b.minY + b.maxY) / 2 : 600;
    const rx = b ? Math.max(120, (b.maxX - b.minX) * 0.18) : 300;
    const ry = b ? Math.max(90, (b.maxY - b.minY) * 0.18) : 220;
    this.ambientPhase = (this.ambientPhase + 0.6) % (Math.PI * 2);
    const tx = cx + Math.cos(this.ambientPhase) * rx;
    const ty = cy + Math.sin(this.ambientPhase * 0.7) * ry;
    this.cameraFlyTo(tx, ty, 0.85, 5200);
  }
}
