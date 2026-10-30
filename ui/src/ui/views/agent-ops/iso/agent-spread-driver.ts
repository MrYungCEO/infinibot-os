/**
 * Engine glue for agent spread (see agent-spread.ts for the logic).
 *
 * The ActivityMap engine hands this driver a small host interface and calls
 * `frame()` once per animation frame. The driver then:
 *  - every ~0.4 s re-plans which sector + workstation each working agent uses,
 *    and walks agents whose slot changed (or that lost their route) to it;
 *  - every other frame applies spatial-hash separation so sprites never overlap.
 *
 * Agents on a concourse bed or on a task trip are "parked": the driver leaves
 * them to the engine's rest-area / trip code and reclaims them afterwards.
 * Toggle with setEnabled(); the choice persists in localStorage.
 */
import { SECTORS } from './sector-layout';
import { SpreadPlanner, separationOffsets, type SpreadAgentInput, type SpreadAssignment } from './agent-spread';

export interface SpreadAgentView {
  key: string;
  label?: string;
  currentTask?: string;
  agentId?: string;
  backend?: string | null;
}

export interface SpreadHost {
  /** Agents eligible to work (i.e. not in a resting / finished status). */
  workingAgents(): SpreadAgentView[];
  /** Every agent currently on the map (for separation). */
  allAgentKeys(): string[];
  /** On a bed or on a task trip — the engine owns it right now. */
  isParked(key: string): boolean;
  /** World-space workstation slots for a sector. */
  slotsFor(sectorId: string): ReadonlyArray<{ x: number; y: number }> | undefined;
  sectorCenter(sectorId: string): { x: number; y: number } | null;
  /** Walk an agent to a world point. `fresh` = new destination; otherwise just
   *  keep an existing route aligned (the agent's room may have moved). */
  routeTo(key: string, world: { x: number; y: number }, fresh: boolean): void;
  /** Hand the agent back to its default behaviour (walk home). */
  release(key: string): void;
  worldPos(key: string): { x: number; y: number } | null;
  /** Add a render-space separation nudge. */
  nudge(key: string, dx: number, dy: number): void;
  /** Plugin room (`plugin:<id>`) this agent's current activity belongs to,
   *  or null → core sectors. Optional: hosts without plugin rooms omit it. */
  roomFor?(agent: SpreadAgentView, tool: { kind: string; label?: string; at: number } | undefined): string | null;
}

export const SPREAD_STORAGE_KEY = 'infinibot.mesh.spread.v1';
/** Frames between re-plans (~0.4 s at 60 fps). */
const PLAN_EVERY_FRAMES = 24;
/** Minimum on-screen spacing between agents (world px, iso-squashed). */
export const SPREAD_MIN_SPACING_PX = 30;
/** How strongly separation corrects per second (fraction of the overlap). */
const SEPARATION_RATE = 6;

function readEnabled(): boolean {
  try {
    return localStorage.getItem(SPREAD_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export class AgentSpreadDriver {
  private enabled = readEnabled();
  private planner: SpreadPlanner | null = null;
  private readonly tools = new Map<string, { kind: string; label?: string; at: number }>();
  /** Dynamic work sectors (plugin rooms) currently registered, by id. */
  private readonly extraSectors = new Map<string, { def: import('./agent-spread').SpreadSectorDef; capacity?: number }>();
  private readonly routed = new Map<string, { x: number; y: number }>();
  private lastPlan: Map<string, SpreadAssignment> = new Map();
  private readonly listeners = new Set<(on: boolean) => void>();

  constructor(private readonly host: SpreadHost) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    try {
      localStorage.setItem(SPREAD_STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* storage blocked — session-only */
    }
    if (!on) {
      for (const key of this.routed.keys()) if (!this.host.isParked(key)) this.host.release(key);
      this.routed.clear();
      this.planner?.clear();
      this.lastPlan = new Map();
    }
    this.listeners.forEach((fn) => fn(on));
  }

  onChange(fn: (on: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Feed a tool call. Returns true when spread handles movement (so the
   *  engine should skip its legacy 5-second tool-sector trip). */
  noteTool(key: string, kind: string, now: number, label?: string): boolean {
    this.tools.set(key, { kind, label, at: now });
    return this.enabled;
  }

  /**
   * Register / replace the set of dynamic work sectors (plugin rooms). Rooms
   * not in `defs` are removed and their occupants re-planned next frame.
   */
  setExtraSectors(defs: ReadonlyArray<{ def: import('./agent-spread').SpreadSectorDef; capacity?: number }>): void {
    const next = new Set(defs.map((d) => d.def.id));
    for (const id of [...this.extraSectors.keys()]) {
      if (next.has(id)) continue;
      this.extraSectors.delete(id);
      this.planner?.removeSector(id);
    }
    for (const d of defs) {
      this.extraSectors.set(d.def.id, d);
      this.planner?.addSector(d.def, d.capacity);
    }
  }

  /** Latest tool signal for an agent (kind/label/at), if any. */
  toolOf(key: string): { kind: string; label?: string; at: number } | undefined {
    return this.tools.get(key);
  }

  forget(key: string): void {
    this.tools.delete(key);
    this.routed.delete(key);
    this.planner?.forget(key);
  }

  /** Latest plan (sessionKey → sector + slot), for debugging / harnesses. */
  plan(): ReadonlyMap<string, SpreadAssignment> {
    return this.lastPlan;
  }

  frame(dt: number, frameNo: number, now: number): void {
    if (!this.enabled) return;
    if (frameNo % PLAN_EVERY_FRAMES === 0) this.replan(now);
    if (frameNo % 2 === 0) this.separate(dt * 2);
  }

  replan(now: number): void {
    if (!this.planner) {
      this.planner = new SpreadPlanner({ sectors: SECTORS });
      for (const d of this.extraSectors.values()) this.planner.addSector(d.def, d.capacity);
    }
    const planner = this.planner;
    const inputs: SpreadAgentInput[] = [];
    for (const a of this.host.workingAgents()) {
      if (this.host.isParked(a.key)) continue;
      const t = this.tools.get(a.key);
      const wantSector = this.host.roomFor ? this.host.roomFor(a, t) : null;
      inputs.push({ ...a, toolKind: t?.kind, toolAt: t?.at, wantSector });
    }
    const plan = planner.update(inputs, now);
    this.lastPlan = plan;

    for (const key of [...this.routed.keys()]) if (!plan.has(key)) this.routed.delete(key);

    plan.forEach((a, key) => {
      const world = this.slotPoint(a);
      if (!world) return;
      const prev = this.routed.get(key);
      const fresh = !prev || Math.abs(prev.x - world.x) > 0.5 || Math.abs(prev.y - world.y) > 0.5;
      this.host.routeTo(key, world, fresh);
      this.routed.set(key, world);
    });
  }

  private slotPoint(a: SpreadAssignment): { x: number; y: number } | null {
    const slots = this.host.slotsFor(a.sectorId) ?? [];
    if (a.slot < slots.length) return slots[a.slot];
    const c = this.host.sectorCenter(a.sectorId);
    if (!c) return slots[0] ?? null;
    // Beyond the desks: a golden-angle ring around the sector centre; the
    // separation pass keeps these clear of the workstation agents.
    const i = a.slot - slots.length;
    const ang = i * 2.39996;
    const rad = 34 + 12 * Math.sqrt(i);
    return { x: c.x + Math.cos(ang) * rad, y: c.y + Math.sin(ang) * rad * 0.55 };
  }

  private separate(dt: number): void {
    const keys = this.host.allAgentKeys();
    if (keys.length < 2) return;
    const pts: Array<{ x: number; y: number }> = [];
    const live: string[] = [];
    for (const k of keys) {
      const p = this.host.worldPos(k);
      if (!p) continue;
      pts.push(p);
      live.push(k);
    }
    const off = separationOffsets(pts, SPREAD_MIN_SPACING_PX);
    const k = Math.min(1, dt * SEPARATION_RATE);
    off.forEach((o, i) => {
      if (o.x !== 0 || o.y !== 0) this.host.nudge(live[i], o.x * k, o.y * k);
    });
  }
}
