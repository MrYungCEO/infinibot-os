// motion.js — the web mesh's ambient agent motion + review packets, pure:
//   · iso/layout-engine.ts runLayoutTick: active agents orbit their slot
//     (r = 8, y × 0.55, 4 s period); idle (not parked on a bed) bob
//     4·sin(t·0.35·2π + φ) in x and 2.4·sin in y.
//   · review-mesh-layer.ts packets: a review message flies between the worker
//     and the Auditor along the web's arc (arcPoint / arcLift), 1.5–2.4 s.
import { arcLift, arcPoint, isPacketMessage, packetTone, travelsToReviewer, TONE_CSS } from './web-mesh.generated';

const WORKING = new Set(['working', 'starting', 'finishing', 'running']);

export function phaseOf(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return ((h >>> 0) % 6283) / 1000;
}

/** World-px offset for an agent at time `tSec` ({x:0,y:0} for parked / finished agents). */
export function agentOffset(a, where, tSec) {
  const ph = phaseOf(a.sessionKey || '');
  if (WORKING.has(a.status) && !a.resting) {
    const ang = (tSec / 4) * Math.PI * 2 + ph;
    return { x: 8 * Math.cos(ang), y: 8 * 0.55 * Math.sin(ang) };
  }
  if ((a.status === 'idle' || !a.status) && !a.resting && where !== 'bed') {
    const s = Math.sin(tSec * 0.35 * Math.PI * 2 + ph);
    return { x: 4 * s, y: 2.4 * s };
  }
  return { x: 0, y: 0 };
}

export const PACKET_MS = 2000;

/** A review.message → a packet spec (null for actions, which don't travel). */
export function packetFromMessage(msg, now = Date.now()) {
  if (!msg || !isPacketMessage(msg)) return null;
  return { id: `${msg.runId}:${msg.seq ?? msg.id}`, runId: msg.runId, toReviewer: travelsToReviewer(msg), color: TONE_CSS[packetTone(msg)] || '#f5c542', born: now };
}

/** Where a packet's head is now, or null once it has landed. `worker`/`auditor` are world points. */
export function packetHead(pk, worker, auditor, now = Date.now()) {
  const t = (now - pk.born) / PACKET_MS;
  if (t < 0 || t > 1 || !worker || !auditor) return null;
  const [a, b] = pk.toReviewer ? [worker, auditor] : [auditor, worker];
  const lift = arcLift(a.x, a.y - 40, b.x, b.y - 40);
  const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
  return arcPoint(a.x, a.y - 40, b.x, b.y - 40, lift, e, { x: 0, y: 0 });
}

/** Walk speed (activity-map.ts): 60 world px/s; teleport past 900 px (a new island / fresh mount). */
export const WALK_PX_PER_S = 60;

/** Advance every displayed position toward its target; returns a new Map. */
export function stepWalk(shown, targets, dtSec, { spawnAt = null } = {}) {
  const out = new Map();
  const maxStep = WALK_PX_PER_S * Math.max(0, Math.min(dtSec, 0.5));
  for (const [key, t] of targets) {
    const cur = shown.get(key) || spawnAt || t;
    const dx = t.x - cur.x;
    const dy = t.y - cur.y;
    const d = Math.hypot(dx, dy);
    if (d <= maxStep || d > 900) out.set(key, { x: t.x, y: t.y, walking: false });
    else out.set(key, { x: cur.x + (dx / d) * maxStep, y: cur.y + (dy / d) * maxStep, walking: true });
  }
  return out;
}

/** Keys of agents whose (screen) point falls inside a lasso rect. */
export function keysInRect(points, x0, y0, x1, y1) {
  const [l, r] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [t, b] = y0 < y1 ? [y0, y1] : [y1, y0];
  const out = [];
  for (const [key, p] of points) if (p.x >= l && p.x <= r && p.y >= t && p.y <= b) out.push(key);
  return out;
}
