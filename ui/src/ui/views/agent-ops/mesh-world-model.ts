/**
 * Mesh World Model — the ONE data adapter behind both Agent Mesh views.
 *
 * The 2D iso map (<agency-world-viz> → ActivityMap) and the 3D world
 * (<mesh-world-3d>) are fed by the same WorldEvent batches from
 * AgencyDataBridge and the same plugins.list snapshot. This module folds those
 * inputs into a renderer-agnostic snapshot and lays it out in the station's
 * TILE space (the same coordinates the 2D engine projects to iso):
 *
 *   - the 10 core sectors (sector-defs.ts),
 *   - the Plugin District rooms (plugin-rooms.ts `planDistrict`, sticky),
 *   - federation nodes as islands around the station,
 *   - every on-map agent: working agents get desks via the web SpreadPlanner
 *     (domain → sector, explicit plugin → that plugin's room), resting /
 *     finished agents lie on Gateway Concourse beds, remote agents stand on
 *     their node's island.
 *
 * On-map membership mirrors ActivityMap exactly: an agent needs a known node,
 * finished runs rest until an `agent.leave` or until more than
 * MAX_RESTING_COMPLETED have finished (oldest departs). So the 2D and 3D
 * agent counts are the same by construction.
 *
 * Pure: no DOM, no Pixi, no three.js — unit-tested and also compiled into the
 * mobile app's 3D embed.
 */

import type { MeshAgent, MeshNode } from "./activity-map";
import { MAX_RESTING_COMPLETED } from "./resting-completed";
import { SECTORS, type SectorDef } from "./iso/sector-defs";
import { DISTRICT_ACCENTS } from "./iso/district-accents";
import {
  SpreadPlanner,
  TOOL_SIGNAL_TTL_MS,
  computeWorkSlots,
  domainForToolKind,
  type SpreadAgentInput,
} from "./iso/agent-spread";
import {
  planDistrict,
  roomSpecsFromPluginList,
  type PlacedRoom,
  type PluginRoomSource,
  type PluginRoomSpec,
} from "./iso/plugin-rooms";
import {
  buildPluginActivityIndex,
  type PluginActivityIndex,
  type PluginActivityListItem,
} from "./iso/plugin-activity";

// The bridge's event union, restated structurally so this module stays free of
// the bridge's gateway imports (and compiles into the mobile embed).
export type MeshWorldEvent =
  | { kind: "node.upsert"; node: MeshNode }
  | { kind: "node.remove"; nodeId: string }
  | { kind: "agent.spawn"; agent: MeshAgent }
  | { kind: "agent.progress"; sessionKey: string; patch: Partial<MeshAgent> }
  | { kind: "agent.tool"; sessionKey: string; tool: { kind: string; label: string } }
  | { kind: "agent.message"; from: string; to: string; type: string }
  | { kind: "agent.complete"; sessionKey: string; success: boolean; message?: string }
  | { kind: "agent.leave"; sessionKey: string }
  | { kind: "task.ingest"; id: string; title: string; nodeId?: string }
  | { kind: "fed.msg.send" | "fed.msg.ack" | "fed.msg.fail"; fromNodeId: string; toNodeId: string }
  | { kind: "fed.peer.connect" | "fed.peer.disconnect"; peerNodeId: string }
  | { kind: string; [key: string]: unknown };

/** What the renderer shows for an agent. */
export type AgentVisualState = "idle" | "working" | "waiting" | "error" | "done";

export function agentVisualState(status: string | undefined | null): AgentVisualState {
  switch ((status ?? "").toLowerCase()) {
    case "working":
    case "starting":
    case "finishing":
    case "running":
    case "checkpoint":
      return "working";
    case "blocked":
    case "waiting":
    case "needs_input":
    case "paused":
    case "queued":
    case "pending":
      return "waiting";
    case "failed":
    case "error":
      return "error";
    case "completed":
    case "done":
      return "done";
    default:
      return "idle";
  }
}

const isFinished = (s?: string) => s === "completed" || s === "failed";
const isResting = (s?: string) => s === undefined || s === "" || s === "idle" || isFinished(s);

export const LOCAL_NODE_ID = "local";

// ── Effects (transient beats the renderer animates) ──────────────────────

export type WorldEffect =
  | { id: number; at: number; kind: "spawn"; key: string }
  | { id: number; at: number; kind: "complete"; key: string; success: boolean }
  | { id: number; at: number; kind: "leave"; key: string }
  | { id: number; at: number; kind: "tool"; key: string; tool: string; label: string }
  | { id: number; at: number; kind: "message"; from: string; to: string; type: string }
  | { id: number; at: number; kind: "federation"; nodeId: string; type: "send" | "ack" | "fail" | "connect" | "disconnect" }
  | { id: number; at: number; kind: "task"; title: string; nodeId?: string };

type EffectInit = WorldEffect extends infer E ? (E extends WorldEffect ? Omit<E, "id" | "at"> : never) : never;

const MAX_EFFECTS = 200;

// ── Layout output ────────────────────────────────────────────────────────

export interface WorldZone {
  id: string;
  kind: "core" | "plugin" | "island";
  name: string;
  subtitle: string;
  /** Tile rect (station grid units). */
  c: number;
  r: number;
  w: number;
  h: number;
  accent: number;
  monogram?: string;
  pluginId?: string;
  nodeId?: string;
  openTab?: string;
  status?: string;
  /** Plugin rooms: the room theme (iso/plugin-rooms RoomTheme) — picks the building silhouette. */
  theme?: string;
  /** Agents currently placed in this zone. */
  occupants: number;
  /** Of those, how many are working right now (centerpieces intensify with it). */
  busy: number;
  /** Props (zone-relative tiles) — the renderer draws desks / landmark from these. */
  props: ZoneProp[];
}

export interface PlacedAgent {
  key: string;
  agent: MeshAgent;
  state: AgentVisualState;
  /** Tile position of the agent's feet. */
  c: number;
  r: number;
  zoneId: string;
  where: "desk" | "bed" | "island";
  /** Latest tool in the TTL window ("Bash: pnpm test"), if any. */
  tool?: { kind: string; label: string; at: number };
}

export interface WorldLink {
  from: { c: number; r: number };
  to: { c: number; r: number };
  kind: "conduit" | "federation";
  /** Zone the link serves (plugin room id / island id). */
  zoneId: string;
}

export interface MeshWorldLayout {
  zones: WorldZone[];
  agents: PlacedAgent[];
  links: WorldLink[];
  bounds: { minC: number; minR: number; maxC: number; maxR: number };
}

export interface MeshWorldCounts {
  agents: number;
  working: number;
  resting: number;
  nodes: number;
  plugins: number;
}

// ── Station geometry helpers ─────────────────────────────────────────────

const CONCOURSE = SECTORS.find((s) => s.id === "gateway-concourse")!;
const ATRIUM = SECTORS.find((s) => s.id === "command-atrium")!;
const centerOf = (z: { c: number; r: number; w: number; h: number }) => ({ c: z.c + z.w / 2, r: z.r + z.h / 2 });

/** Concourse beds: two rows of five, newest finished first. */
export const BED_SLOTS: ReadonlyArray<{ c: number; r: number }> = (() => {
  const out: Array<{ c: number; r: number }> = [];
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 5; i++) out.push({ c: CONCOURSE.c + 1.2 + i * 1.4, r: CONCOURSE.r + 4.4 + row * 1.9 });
  }
  return out;
})();

function goldenRing(center: { c: number; r: number }, i: number, base = 1.2): { c: number; r: number } {
  const ang = i * 2.39996;
  const rad = base + 0.45 * Math.sqrt(i);
  return { c: center.c + Math.cos(ang) * rad, r: center.r + Math.sin(ang) * rad };
}

/** A prop inside a zone, zone-relative tile coords. */
export interface ZoneProp {
  t: "desk" | "block";
  c: number;
  r: number;
  /** Desks: where the agent sits (zone-relative). Omitted = the generic "toward the viewer" rule. */
  seat?: { c: number; r: number };
  /** Desks: workstation style the renderer draws ("console", "pod", "stool", "drafting", …). */
  style?: string;
}

type DeskDef = { c: number; r: number; seat: { c: number; r: number }; style: string };
type DistrictPlan = { blocks: Array<[number, number, number, number]>; desks: DeskDef[] };

const ring = (cx: number, cr: number, rad: number, seatRad: number, angles: number[], style: string): DeskDef[] =>
  angles.map((a) => ({
    c: +(cx + Math.cos(a) * rad).toFixed(2),
    r: +(cr + Math.sin(a) * rad).toFixed(2),
    seat: { c: +(cx + Math.cos(a) * seatRad).toFixed(2), r: +(cr + Math.sin(a) * seatRad).toFixed(2) },
    style,
  }));
const facing = (c: number, r: number, dc: number, dr: number, style: string): DeskDef => ({ c, r, seat: { c: +(c + dc).toFixed(2), r: +(r + dr).toFixed(2) }, style });

/**
 * Per-district architecture footprint (zone-relative tiles, 8×8 / 8×4 rooms):
 * the centerpiece's blocked floor + the FEW workstations agents actually sit
 * at. Everyone else stands on open floor around the centerpiece. The 3D
 * renderer builds each district's signature architecture over these blocks.
 */
export const DISTRICT_PLANS: Record<string, DistrictPlan> = {
  // Holo-table in the middle; seats ring the table, facing it.
  "command-atrium": { blocks: [[2.7, 5.3, 2.7, 5.3]], desks: ring(4, 4, 1.45, 2.25, [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75], "table") },
  // Curved screen wall on the north wall, two tiers of consoles facing it.
  "mission-control": {
    blocks: [[0.6, 7.4, 0.3, 1.3]],
    desks: [facing(2.2, 3.0, 0, 0.9, "console"), facing(4.0, 2.8, 0, 0.9, "console"), facing(5.8, 3.0, 0, 0.9, "console"), facing(3.1, 5.0, 0, 0.9, "console"), facing(4.9, 5.0, 0, 0.9, "console")],
  },
  // Dish array + signal mast at the back, an arc of comms consoles.
  "comms-deck": { blocks: [[3.9, 7.2, 0.6, 3.5], [1.2, 2.8, 1.0, 2.6]], desks: [facing(2.0, 4.9, 0, 0.9, "console"), facing(4.0, 5.3, 0, 0.9, "console"), facing(6.0, 4.9, 0, 0.9, "console")] },
  // Lounge pods: agents sit IN the pods.
  "agent-quarters": {
    blocks: [[3.3, 4.7, 3.3, 4.7]],
    desks: [facing(1.6, 1.8, 0.55, 0.55, "pod"), facing(5.2, 1.4, 0.55, 0.55, "pod"), facing(1.4, 5.3, 0.55, 0.55, "pod"), facing(5.4, 5.0, 0.55, 0.55, "pod")],
  },
  // Dome + telescope; two star-chart consoles face it.
  observatory: { blocks: [[0.8, 4.8, 0.8, 4.8]], desks: [facing(5.7, 3.0, 0.85, 0.35, "console"), facing(3.0, 5.7, 0.35, 0.85, "console")] },
  // Stage + backdrop + cameras; a director's desk and a mic stand on stage.
  "broadcast-studio": { blocks: [[0.6, 3.4, 0.4, 1.5], [4.3, 5.1, 0.9, 2.9]], desks: [facing(6.7, 1.5, 0, 0.95, "console"), facing(2.0, 1.9, 0, 0.8, "mic")] },
  // Circular vault door + pedestal; two security consoles.
  "the-vault": { blocks: [[2.7, 5.3, 0.2, 1.1], [3.6, 4.4, 2.2, 3.0]], desks: [facing(1.4, 1.6, 0.1, 0.95, "console"), facing(6.6, 1.6, -0.1, 0.95, "console")] },
  // Server towers with light flow; terminals face them.
  "engineering-bay": { blocks: [[0.7, 7.3, 0.6, 3.6]], desks: [facing(2.0, 4.9, 0, 0.9, "console"), facing(4.0, 5.2, 0, 0.9, "console"), facing(6.0, 4.9, 0, 0.9, "console")] },
  // Portal arch at the back; two info kiosks. Rest pods (BED_SLOTS) fill the south half.
  "gateway-concourse": { blocks: [[2.3, 5.7, 0.4, 2.2], [0.5, 7.5, 3.9, 4.9], [0.5, 7.5, 5.8, 6.8]], desks: [facing(1.2, 2.0, 0.2, 0.9, "kiosk"), facing(6.8, 2.0, -0.2, 0.9, "kiosk")] },
  // Floating holo-sculpture on a plinth; three drafting tables face it.
  "canvas-atrium": { blocks: [[2.6, 5.4, 1.4, 4.2]], desks: [facing(1.8, 5.2, 0, 0.9, "drafting"), facing(4.0, 5.5, 0, 0.9, "drafting"), facing(6.2, 5.2, 0, 0.9, "drafting")] },
};

/**
 * Deterministic props per zone. Core sectors follow their DISTRICT_PLANS
 * entry (centerpiece blocks + a few workstations); plugin rooms: the building
 * fills the north half, a hero prop sits on the forecourt and two or three
 * workstations face the building. Islands: a pylon in the middle. Agents'
 * work seats are computed from these, so the 3D seats always agree.
 */
export function propsFor(kind: "core" | "plugin" | "island", w: number, h: number, id?: string): ZoneProp[] {
  const out: ZoneProp[] = [];
  const block = (c0: number, c1: number, r0: number, r1: number) => {
    for (let r = r0; r <= r1 + 1e-6; r += 0.7) for (let c = c0; c <= c1 + 1e-6; c += 0.7) out.push({ t: "block", c: +c.toFixed(2), r: +r.toFixed(2) });
  };
  const plan = kind === "core" && id ? DISTRICT_PLANS[id] : undefined;
  if (plan) {
    const sy = h / 8;
    for (const [c0, c1, r0, r1] of plan.blocks) block(c0, c1, r0 * (sy < 1 ? 1 : sy), r1 * (sy < 1 ? 1 : sy));
    for (const d of plan.desks) out.push({ t: "desk", c: d.c, r: d.r, seat: d.seat, style: d.style });
  } else if (kind === "core") {
    block(0.8, 2.2, 0.8, 2.2);
    const cs = [w * 0.38, w * 0.84];
    for (const c of cs) out.push({ t: "desk", c: +c.toFixed(2), r: +(h * 0.6).toFixed(2), seat: { c: +c.toFixed(2), r: +(h * 0.6 + 0.9).toFixed(2) }, style: "console" });
  } else if (kind === "plugin") {
    block(w * 0.18, w * 0.82, h * 0.12, h * 0.46);
    block(w * 0.5 - 0.5, w * 0.5 + 0.5, h * 0.58, h * 0.7);
    const cs = w >= 10 ? [0.16, 0.84, 0.32] : [0.2, 0.8];
    for (const f of cs) {
      const c = +(w * f).toFixed(2);
      const r = +(h * (f === 0.32 ? 0.76 : 0.6)).toFixed(2);
      out.push({ t: "desk", c, r, seat: { c, r: +(r + 0.9).toFixed(2) }, style: "console" });
    }
  } else {
    block(w / 2 - 0.7, w / 2 + 0.7, h / 2 - 0.7, h / 2 + 0.7);
  }
  return out;
}

const slotCache = new Map<string, Array<{ c: number; r: number }>>();
function workSlots(kind: "core" | "plugin" | "island", w: number, h: number, id?: string): Array<{ c: number; r: number }> {
  const k = `${kind}:${w}x${h}:${kind === "core" ? id ?? "" : ""}`;
  let s = slotCache.get(k);
  if (!s) {
    const props = propsFor(kind, w, h, id);
    // Workstation seats first (the few agents that sit), then open floor
    // around the centerpiece for everyone else.
    const seats = deskSeats(kind, w, h, id).flatMap((d) => (d.seat ? [d.seat] : []));
    const decor = [...props, ...seats.map((p) => ({ ...p, t: "block" as const }))].map((p) => ({ t: "block", c: p.c, r: p.r }));
    const floor = computeWorkSlots({ w, h }, decor, { max: Math.max(4, 16 - seats.length), propClearance: 0.9 });
    s = [...seats, ...floor];
    slotCache.set(k, s);
  }
  return s;
}

/**
 * Each desk prop with the seat in front of it (zone-relative tiles). Desks
 * with an explicit seat use it; others take the first free candidate toward
 * the viewer (the rule computeWorkSlots uses). Renderers put the chair here
 * and turn the desk to face it; null = no free seat (desk drawn unattended).
 */
export function deskSeats(kind: "core" | "plugin" | "island", w: number, h: number, id?: string): Array<{ desk: { c: number; r: number }; seat: { c: number; r: number } | null; style: string }> {
  const props = propsFor(kind, w, h, id);
  const inside = (c: number, r: number) => c >= 0.6 && r >= 0.6 && c <= w - 0.6 && r <= h - 0.6;
  const out: Array<{ desk: { c: number; r: number }; seat: { c: number; r: number } | null; style: string }> = [];
  for (const d of props) {
    if (d.t !== "desk") continue;
    let seat: { c: number; r: number } | null = d.seat && inside(d.seat.c, d.seat.r) ? d.seat : null;
    if (!d.seat) {
      for (const [dc, dr] of [[0.95, 0.95], [1.2, 0.2], [0.2, 1.2]] as const) {
        const c = d.c + dc;
        const r = d.r + dr;
        if (inside(c, r) && props.every((p) => p === d || Math.hypot(p.c - c, p.r - r) >= 0.95)) {
          seat = { c, r };
          break;
        }
      }
    }
    out.push({ desk: { c: d.c, r: d.r }, seat, style: d.style ?? "console" });
  }
  return out;
}

/**
 * What an agent is visibly DOING — the animation both renderers play. Derived
 * from the shared visual state plus the live tool signal (same TTL + tool
 * domains the planner uses to pick a sector):
 *
 *   working + coding/files/research/media tool → "type" (at the desk)
 *   working + planning tool, or between tools  → "think"
 *   working + messaging / delegating tool      → "talk"
 *   waiting → "wait" · error → "error" · done → "rest" · idle → "idle"
 *
 * Walking is the renderer's own business (an agent between its old and new spot).
 */
export type AgentActivity = "idle" | "wait" | "type" | "think" | "talk" | "error" | "rest";

export function agentActivity(p: Pick<PlacedAgent, "state" | "tool" | "agent">, now: number = Date.now()): AgentActivity {
  switch (p.state) {
    case "error":
      return "error";
    case "done":
      return "rest";
    case "waiting":
      return "wait";
    case "idle":
      return "idle";
    default:
      break;
  }
  const tool = p.tool;
  if (tool && now - tool.at <= TOOL_SIGNAL_TTL_MS) {
    const d = domainForToolKind(tool.kind, !!p.agent.coderBackend || !!p.agent.isBuild);
    if (d === "planning") return "think";
    if (d === "comms" || d === "orchestration") return "talk";
    if (d) return "type";
    return "type";
  }
  return "think";
}

const ISLAND_SIZE = 6;

// ── Model ────────────────────────────────────────────────────────────────

export class MeshWorldModel {
  readonly agents = new Map<string, MeshAgent>();
  readonly nodes = new Map<string, MeshNode>();
  readonly tools = new Map<string, { kind: string; label: string; at: number }>();
  private finishedOrder: string[] = [];
  private rooms: PluginRoomSpec[] = [];
  private district = new Map<string, PlacedRoom>();
  private pluginIndex: PluginActivityIndex = buildPluginActivityIndex([]);
  private readonly planner = new SpreadPlanner({ sectors: SECTORS });
  private plannerRooms = new Set<string>();
  private readonly beds = new Map<string, number>();
  private effects: WorldEffect[] = [];
  private effectSeq = 0;
  private listeners = new Set<() => void>();
  /** Bumps on every change; renderers diff against it. */
  version = 0;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  // ── Inputs ──

  apply(events: readonly MeshWorldEvent[]): void {
    if (!events.length) return;
    const now = this.clock();
    for (const e of events) this.applyOne(e as MeshWorldEvent & Record<string, any>, now);
    this.changed();
  }

  /** Forget everything (the owning view tore down). Rooms keep their plan. */
  clear(): void {
    this.agents.clear();
    this.nodes.clear();
    this.tools.clear();
    this.beds.clear();
    this.planner.clear();
    this.finishedOrder = [];
    this.changed();
  }

  /** plugins.list items → rooms (planDistrict is sticky across calls) + activity index. */
  setPluginItems(items: readonly unknown[]): void {
    const list = (items ?? []) as Array<PluginRoomSource & PluginActivityListItem>;
    this.rooms = roomSpecsFromPluginList(list);
    this.district = planDistrict(this.rooms, this.district);
    this.pluginIndex = buildPluginActivityIndex(list);
    const next = new Set([...this.district.values()].map((r) => r.spec.id));
    for (const id of [...this.plannerRooms]) {
      if (!next.has(id)) {
        this.planner.removeSector(id);
        this.plannerRooms.delete(id);
      }
    }
    for (const room of this.district.values()) {
      const def = { id: room.spec.id, c: room.c, r: room.r, w: room.w, h: room.h };
      this.planner.addSector(def, Math.max(3, Math.floor((room.w * room.h) / 12)));
      this.plannerRooms.add(room.spec.id);
    }
    this.changed();
  }

  /**
   * Replace the whole state from a snapshot (mobile host → 3D embed, or a
   * renderer that mounts late). Agents whose node is unknown are dropped, as
   * in ActivityMap.addAgent.
   */
  loadSnapshot(snap: {
    nodes?: readonly MeshNode[];
    agents?: readonly MeshAgent[];
    plugins?: readonly unknown[];
    tools?: Iterable<[string, { kind: string; label: string; at: number }]> | Record<string, { kind: string; label: string; at: number }>;
  }): void {
    const nextNodes = new Map((snap.nodes ?? []).map((n) => [n.id, n] as const));
    if (!nextNodes.size) nextNodes.set(LOCAL_NODE_ID, { id: LOCAL_NODE_ID, name: "Local", role: "hub", status: "online", agentCount: 0 });
    this.nodes.clear();
    nextNodes.forEach((n, id) => this.nodes.set(id, n));
    const prevKeys = new Set(this.agents.keys());
    this.agents.clear();
    for (const a of snap.agents ?? []) {
      if (!a?.sessionKey) continue;
      if (!this.nodes.has(a.nodeId || LOCAL_NODE_ID)) continue;
      this.agents.set(a.sessionKey, { ...a, nodeId: a.nodeId || LOCAL_NODE_ID });
      if (!prevKeys.has(a.sessionKey) && prevKeys.size) this.pushEffect({ kind: "spawn", key: a.sessionKey });
    }
    // Finished cap, newest first.
    this.finishedOrder = [...this.agents.values()]
      .filter((a) => isFinished(a.status))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .map((a) => a.sessionKey);
    while (this.finishedOrder.length > MAX_RESTING_COMPLETED) this.agents.delete(this.finishedOrder.pop()!);
    if (snap.tools) {
      this.tools.clear();
      const entries = Symbol.iterator in Object(snap.tools)
        ? [...(snap.tools as Iterable<[string, { kind: string; label: string; at: number }]>)]
        : Object.entries(snap.tools as Record<string, { kind: string; label: string; at: number }>);
      for (const [k, v] of entries) if (v) this.tools.set(k, v);
    }
    if (snap.plugins) this.setPluginItems(snap.plugins);
    else this.changed();
  }

  private applyOne(e: MeshWorldEvent & Record<string, any>, now: number): void {
    switch (e.kind) {
      case "node.upsert": {
        const node = e.node as MeshNode;
        this.nodes.set(node.id, { ...this.nodes.get(node.id), ...node });
        break;
      }
      case "node.remove": {
        this.nodes.delete(e.nodeId);
        for (const [k, a] of this.agents) if (a.nodeId === e.nodeId) this.dropAgent(k);
        break;
      }
      case "agent.spawn": {
        const a = e.agent as MeshAgent;
        if (!a?.sessionKey || !this.nodes.has(a.nodeId)) break;
        const existed = this.agents.has(a.sessionKey);
        this.agents.set(a.sessionKey, { ...this.agents.get(a.sessionKey), ...a });
        if (isFinished(a.status)) {
          if (!existed) this.noteFinished(a.sessionKey);
        } else {
          this.unnoteFinished(a.sessionKey);
          if (!existed) this.pushEffect({ kind: "spawn", key: a.sessionKey });
        }
        break;
      }
      case "agent.progress": {
        const prev = this.agents.get(e.sessionKey);
        if (!prev) break;
        const patch = e.patch as Partial<MeshAgent>;
        if (patch.nodeId && patch.nodeId !== prev.nodeId && !this.nodes.has(patch.nodeId)) {
          // ActivityMap keeps the agent on its old node when the new one is unknown.
          this.agents.set(e.sessionKey, { ...prev, ...patch, nodeId: prev.nodeId });
        } else {
          this.agents.set(e.sessionKey, { ...prev, ...patch });
        }
        if (patch.status) this.statusChanged(e.sessionKey, patch.status);
        break;
      }
      case "agent.tool": {
        const prev = this.agents.get(e.sessionKey);
        const tool = { kind: String(e.tool?.kind ?? ""), label: String(e.tool?.label ?? ""), at: now };
        this.tools.set(e.sessionKey, tool);
        if (prev) {
          this.agents.set(e.sessionKey, {
            ...prev,
            lastActivity: { kind: tool.kind, label: tool.label, at: now },
            lastActivityAt: now,
          });
          this.pushEffect({ kind: "tool", key: e.sessionKey, tool: tool.kind, label: tool.label });
        }
        break;
      }
      case "agent.complete": {
        const prev = this.agents.get(e.sessionKey);
        if (!prev) break;
        const status = e.success ? "completed" : "failed";
        this.agents.set(e.sessionKey, { ...prev, status, endedAt: prev.endedAt ?? now });
        this.statusChanged(e.sessionKey, status);
        this.pushEffect({ kind: "complete", key: e.sessionKey, success: !!e.success });
        break;
      }
      case "agent.leave": {
        if (this.agents.has(e.sessionKey)) this.pushEffect({ kind: "leave", key: e.sessionKey });
        this.dropAgent(e.sessionKey);
        break;
      }
      case "agent.message": {
        this.pushEffect({ kind: "message", from: String(e.from), to: String(e.to), type: String(e.type) });
        break;
      }
      case "task.ingest": {
        this.pushEffect({ kind: "task", title: String(e.title ?? ""), nodeId: e.nodeId });
        break;
      }
      case "fed.peer.connect":
      case "fed.peer.disconnect":
        this.pushEffect({
          kind: "federation",
          nodeId: String(e.peerNodeId),
          type: e.kind === "fed.peer.connect" ? "connect" : "disconnect",
        });
        break;
      case "fed.msg.send":
      case "fed.msg.ack":
      case "fed.msg.fail": {
        const peer = e.toNodeId && e.toNodeId !== LOCAL_NODE_ID ? e.toNodeId : e.fromNodeId;
        const type = e.kind === "fed.msg.send" ? "send" : e.kind === "fed.msg.ack" ? "ack" : "fail";
        this.pushEffect({ kind: "federation", nodeId: String(peer ?? LOCAL_NODE_ID), type });
        break;
      }
      default:
        break;
    }
  }

  private statusChanged(key: string, status: string): void {
    if (isFinished(status)) this.noteFinished(key);
    else this.unnoteFinished(key);
  }

  private noteFinished(key: string): void {
    this.finishedOrder = this.finishedOrder.filter((k) => k !== key);
    this.finishedOrder.unshift(key);
    while (this.finishedOrder.length > MAX_RESTING_COMPLETED) {
      const oldest = this.finishedOrder.pop()!;
      this.dropAgent(oldest);
    }
  }

  private unnoteFinished(key: string): void {
    if (this.finishedOrder.includes(key)) this.finishedOrder = this.finishedOrder.filter((k) => k !== key);
  }

  private dropAgent(key: string): void {
    this.agents.delete(key);
    this.tools.delete(key);
    this.beds.delete(key);
    this.planner.forget(key);
    this.unnoteFinished(key);
  }

  private pushEffect(init: EffectInit): void {
    const fx = { ...init, id: ++this.effectSeq, at: this.clock() } as WorldEffect;
    this.effects.push(fx);
    if (this.effects.length > MAX_EFFECTS) this.effects.splice(0, this.effects.length - MAX_EFFECTS);
  }

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.warn("[mesh-world-model] listener failed", err);
      }
    }
  }

  // ── Outputs ──

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Effects newer than `afterId` (renderers remember the last id they played). */
  effectsSince(afterId: number): WorldEffect[] {
    return this.effects.filter((e) => e.id > afterId);
  }

  get lastEffectId(): number {
    return this.effectSeq;
  }

  pluginRooms(): PluginRoomSpec[] {
    return this.rooms.slice();
  }

  counts(): MeshWorldCounts {
    let working = 0;
    for (const a of this.agents.values()) if (!isResting(a.status)) working++;
    return {
      agents: this.agents.size,
      working,
      resting: this.agents.size - working,
      nodes: this.nodes.size,
      plugins: this.district.size,
    };
  }

  /** Which plugin room an agent belongs in right now, or null (same rule as the mobile mesh). */
  roomFor(a: MeshAgent, now = this.clock()): string | null {
    if (!this.district.size) return null;
    const tool = this.tools.get(a.sessionKey);
    const fresh = !!tool && now - tool.at <= TOOL_SIGNAL_TTL_MS;
    const pid = this.pluginIndex.resolve({
      pluginId: a.pluginId,
      toolKind: fresh ? tool!.kind : undefined,
      toolLabel: fresh ? tool!.label : undefined,
      text: [a.currentTask, a.label].filter(Boolean).join(" · "),
      agentId: a.agentId,
    });
    const sid = pid ? `plugin:${pid}` : null;
    return sid && this.district.has(sid) ? sid : null;
  }

  /** Lay the world out in tile space. Deterministic for a given state + clock. */
  layout(now = this.clock()): MeshWorldLayout {
    const zones: WorldZone[] = [];
    const zoneById = new Map<string, WorldZone>();
    const add = (z: WorldZone) => {
      zones.push(z);
      zoneById.set(z.id, z);
    };
    for (const s of SECTORS as SectorDef[]) {
      add({
        id: s.id,
        kind: "core",
        name: s.name,
        subtitle: s.system,
        c: s.c,
        r: s.r,
        w: s.w,
        h: s.h,
        accent: DISTRICT_ACCENTS[s.id] ?? 0xd4af37,
        occupants: 0,
        busy: 0,
        props: propsFor("core", s.w, s.h, s.id),
      });
    }
    const links: WorldLink[] = [];
    const gate = { c: CONCOURSE.c + CONCOURSE.w / 2, r: CONCOURSE.r + CONCOURSE.h };
    for (const room of this.district.values()) {
      const spec = room.spec;
      add({
        id: spec.id,
        kind: "plugin",
        name: spec.title,
        subtitle: spec.subtitle,
        c: room.c,
        r: room.r,
        w: room.w,
        h: room.h,
        accent: spec.accent,
        theme: spec.theme,
        monogram: spec.monogram,
        pluginId: spec.pluginId,
        openTab: spec.openTab,
        occupants: 0,
        busy: 0,
        props: propsFor("plugin", room.w, room.h),
      });
      links.push({ from: gate, to: centerOf(room), kind: "conduit", zoneId: spec.id });
    }

    // Federation islands on a ring outside the station + district.
    let maxExtent = 24;
    for (const room of this.district.values()) {
      maxExtent = Math.max(maxExtent, room.c + room.w, room.r + room.h, 24 - room.c, 24 - room.r);
    }
    const remote = [...this.nodes.values()].filter((n) => n.id !== LOCAL_NODE_ID).sort((a, b) => a.id.localeCompare(b.id));
    const ringR = maxExtent / 2 + 8 + ISLAND_SIZE / 2;
    const atrium = centerOf(ATRIUM);
    remote.forEach((n, i) => {
      const ang = -Math.PI / 4 + (i / Math.max(1, remote.length)) * Math.PI * 2;
      const cc = 12 + Math.cos(ang) * ringR;
      const rr = 12 + Math.sin(ang) * ringR;
      const id = `node:${n.id}`;
      add({
        id,
        kind: "island",
        name: n.name || n.id,
        subtitle: `${n.role} · ${n.status}`,
        c: cc - ISLAND_SIZE / 2,
        r: rr - ISLAND_SIZE / 2,
        w: ISLAND_SIZE,
        h: ISLAND_SIZE,
        accent: n.status === "online" ? 0xd4af37 : 0x6b7280,
        nodeId: n.id,
        status: n.status,
        occupants: 0,
        busy: 0,
        props: propsFor("island", ISLAND_SIZE, ISLAND_SIZE),
      });
      links.push({ from: atrium, to: { c: cc, r: rr }, kind: "federation", zoneId: id });
    });

    // ── Agents ──
    const placed: PlacedAgent[] = [];
    const working: MeshAgent[] = [];
    const resting: MeshAgent[] = [];
    const remoteByNode = new Map<string, MeshAgent[]>();
    for (const a of this.agents.values()) {
      const isRemote = a.nodeId && a.nodeId !== LOCAL_NODE_ID && zoneById.has(`node:${a.nodeId}`);
      if (isRemote) {
        const list = remoteByNode.get(a.nodeId) ?? [];
        list.push(a);
        remoteByNode.set(a.nodeId, list);
      } else if (isResting(a.status)) resting.push(a);
      else working.push(a);
    }
    const toolOf = (k: string) => {
      const t = this.tools.get(k);
      return t && now - t.at <= TOOL_SIGNAL_TTL_MS ? t : undefined;
    };
    const push = (a: MeshAgent, p: { c: number; r: number }, zoneId: string, where: PlacedAgent["where"]) => {
      placed.push({ key: a.sessionKey, agent: a, state: agentVisualState(a.status), c: p.c, r: p.r, zoneId, where, tool: toolOf(a.sessionKey) });
      const z = zoneById.get(zoneId);
      if (z) {
        z.occupants++;
        if (agentVisualState(a.status) === "working") z.busy++;
      }
    };

    const inputs: SpreadAgentInput[] = working.map((a) => {
      const t = this.tools.get(a.sessionKey);
      return {
        key: a.sessionKey,
        label: a.label,
        currentTask: a.currentTask,
        agentId: a.agentId,
        backend: a.coderBackend ?? (a.isBuild ? "claude-code" : null),
        toolKind: t?.kind,
        toolAt: t?.at,
        wantSector: this.roomFor(a, now),
      };
    });
    const plan = this.planner.update(inputs, now);
    for (const a of working) {
      const asg = plan.get(a.sessionKey);
      const zone = (asg && zoneById.get(asg.sectorId)) || zoneById.get("agent-quarters")!;
      const slots = workSlots(zone.kind, zone.w, zone.h, zone.id);
      const slot = asg?.slot ?? 0;
      const p = slot < slots.length
        ? { c: zone.c + slots[slot].c, r: zone.r + slots[slot].r }
        : goldenRing(centerOf(zone), slot - slots.length);
      push(a, p, zone.id, "desk");
    }

    // Beds: sticky, newest finished first.
    const restKeys = new Set(resting.map((a) => a.sessionKey));
    for (const k of [...this.beds.keys()]) if (!restKeys.has(k)) this.beds.delete(k);
    const used = new Set(this.beds.values());
    resting.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || a.sessionKey.localeCompare(b.sessionKey));
    let overflow = 0;
    for (const a of resting) {
      let idx = this.beds.get(a.sessionKey);
      if (idx === undefined) {
        const free = BED_SLOTS.findIndex((_, i) => !used.has(i));
        if (free >= 0) {
          idx = free;
          this.beds.set(a.sessionKey, free);
          used.add(free);
        }
      }
      const p = idx !== undefined ? BED_SLOTS[idx] : goldenRing(centerOf(CONCOURSE), overflow++, 2.4);
      push(a, p, "gateway-concourse", "bed");
    }

    for (const [nodeId, list] of remoteByNode) {
      const zone = zoneById.get(`node:${nodeId}`)!;
      const slots = workSlots(zone.kind, zone.w, zone.h, zone.id);
      list.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
      list.forEach((a, i) => {
        const p = i < slots.length ? { c: zone.c + slots[i].c, r: zone.r + slots[i].r } : goldenRing(centerOf(zone), i - slots.length);
        push(a, p, zone.id, "island");
      });
    }

    let minC = 0;
    let minR = 0;
    let maxC = 24;
    let maxR = 24;
    for (const z of zones) {
      minC = Math.min(minC, z.c);
      minR = Math.min(minR, z.r);
      maxC = Math.max(maxC, z.c + z.w);
      maxR = Math.max(maxR, z.r + z.h);
    }
    return { zones, agents: placed, links, bounds: { minC, minR, maxC, maxR } };
  }
}
