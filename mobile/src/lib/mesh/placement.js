// placement.js — where each agent stands, by the web engine's rules
// (activity-map.ts + iso/agent-spread-driver.ts):
//   · working agents take distinct desks across the sectors and plugin rooms
//     via the web's own SpreadPlanner (domain classification, soft capacity,
//     sticky dwell) — or crowd Agent Quarters when Spread is off;
//   · idle / finished agents rest on the Gateway Concourse beds (remote-node
//     agents on their federation island);
//   · a separation pass keeps sprites ≥ 30px apart.

import { SpreadPlanner, separationOffsets } from './web-mesh.generated';
import { LOCAL } from './mesh-data';
import { SECTORS, cell } from './world';

const RESTING = new Set(['idle', 'completed', 'failed', undefined, null, '']);
export const isRestingStatus = (s) => RESTING.has(s);
const SPREAD_MIN_SPACING_PX = 30;

function goldenRing(center, i, base = 34) {
  const ang = i * 2.39996;
  const rad = base + 12 * Math.sqrt(i);
  return { x: center.x + Math.cos(ang) * rad, y: center.y + Math.sin(ang) * rad * 0.55 };
}

export class AgentPlacer {
  constructor() {
    this.planner = new SpreadPlanner({ sectors: SECTORS });
    this.extra = new Set();
    this.beds = new Map(); // key → bed index (sticky)
  }

  setRooms(rooms) {
    const next = new Set(rooms.map((r) => r.id));
    for (const id of [...this.extra]) {
      if (!next.has(id)) {
        this.planner.removeSector(id);
        this.extra.delete(id);
      }
    }
    for (const r of rooms) {
      this.planner.addSector(r.sectorDef, Math.max(3, Math.floor((r.sectorDef.w * r.sectorDef.h) / 12)));
      this.extra.add(r.id);
    }
  }

  /**
   * @returns Map sessionKey → { x, y, where, sectorId }
   *   opts: { station, district, islands, tools: Map key→{kind,label,at}, roomFor(agent, tool) → sectorId|null, spread, now }
   */
  place(agents, opts) {
    const { station, district, islands = [], tools = new Map(), roomFor, spread = true, now = Date.now() } = opts;
    const out = new Map();
    const rooms = new Map((district?.rooms || []).map((r) => [r.id, r]));
    const islandOf = new Map(islands.map((isl) => [isl.node.id, isl]));
    const sectorCenter = (id) => {
      const z = station.zones.find((zz) => zz.id === id);
      if (z) return z.center;
      return rooms.get(id)?.center || null;
    };
    const slotsFor = (id) => station.workSlots[id] || rooms.get(id)?.workSlots || [];

    const working = [];
    const resting = [];
    const remoteResting = new Map();
    for (const a of agents) {
      const remote = a.nodeId && a.nodeId !== LOCAL && islandOf.has(a.nodeId);
      if (isRestingStatus(a.status)) {
        if (remote) {
          if (!remoteResting.has(a.nodeId)) remoteResting.set(a.nodeId, []);
          remoteResting.get(a.nodeId).push(a);
        } else resting.push(a);
      } else working.push(a);
    }

    // Working agents.
    if (spread) {
      const inputs = working.map((a) => {
        const t = tools.get(a.sessionKey);
        return {
          key: a.sessionKey, label: a.label, currentTask: a.currentTask, agentId: a.agentId, backend: a.coderBackend || null,
          toolKind: t?.kind, toolAt: t?.at, wantSector: roomFor ? roomFor(a, t) : null,
        };
      });
      const plan = this.planner.update(inputs, now);
      plan.forEach((asg, key) => {
        const slots = slotsFor(asg.sectorId);
        let p = asg.slot < slots.length ? slots[asg.slot] : null;
        if (!p) {
          const c = sectorCenter(asg.sectorId);
          p = c ? goldenRing(c, asg.slot - slots.length) : null;
        }
        if (p) out.set(key, { x: p.x, y: p.y, where: 'sector', sectorId: asg.sectorId });
      });
    } else {
      working.forEach((a, i) => {
        const p = i < station.aqSlots.length ? station.aqSlots[i] : goldenRing(sectorCenter('agent-quarters'), i - station.aqSlots.length);
        out.set(a.sessionKey, { x: p.x, y: p.y, where: 'sector', sectorId: 'agent-quarters' });
      });
    }
    for (const a of working) {
      if (!out.has(a.sessionKey)) {
        const p = goldenRing(cell(4, 12), out.size);
        out.set(a.sessionKey, { x: p.x, y: p.y, where: 'sector', sectorId: 'agent-quarters' });
      }
    }

    // Resting agents on the concourse beds (sticky; newest finished first).
    const keys = new Set(resting.map((a) => a.sessionKey));
    for (const k of [...this.beds.keys()]) if (!keys.has(k)) this.beds.delete(k);
    const used = new Set(this.beds.values());
    resting.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    let overflow = 0;
    for (const a of resting) {
      let idx = this.beds.get(a.sessionKey);
      if (idx === undefined) {
        idx = station.bedSlots.findIndex((_, i) => !used.has(i));
        if (idx >= 0) {
          this.beds.set(a.sessionKey, idx);
          used.add(idx);
        }
      }
      const p = idx >= 0 && idx !== undefined ? station.bedSlots[idx] : goldenRing(station.concourse, overflow++, 60);
      out.set(a.sessionKey, { x: p.x, y: p.y, where: idx >= 0 ? 'bed' : 'concourse', sectorId: 'gateway-concourse' });
    }
    for (const [nodeId, list] of remoteResting) {
      const isl = islandOf.get(nodeId);
      list.forEach((a, i) => {
        const p = i < isl.slots.length ? isl.slots[i] : goldenRing(isl.center, i - isl.slots.length);
        out.set(a.sessionKey, { x: p.x, y: p.y, where: 'island', sectorId: `node:${nodeId}` });
      });
    }

    // Separation (the web relaxes continuously; a few passes settle the same picture).
    const ks = [...out.keys()].filter((k) => out.get(k).where === 'sector');
    for (let pass = 0; pass < 4 && ks.length > 1; pass++) {
      const pts = ks.map((k) => out.get(k));
      const off = separationOffsets(pts, SPREAD_MIN_SPACING_PX);
      off.forEach((o, i) => {
        if (o.x || o.y) {
          const v = out.get(ks[i]);
          out.set(ks[i], { ...v, x: v.x + o.x * 0.5, y: v.y + o.y * 0.5 });
        }
      });
    }
    return out;
  }
}
