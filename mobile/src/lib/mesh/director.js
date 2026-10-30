// director.js — the web mesh's camera directors + drag-to-assign, natively.
//
// The camera logic itself is the web's: BroadcastDirector
// (views/agent-ops/broadcast-director.ts) and CameraDirector
// (views/agent-ops/iso/camera-director.ts) are compiled into
// web-mesh.generated.js. This file is the glue <agency-world-viz> wraps
// around them, ported line for line:
//   · worldEventBeats    noteWorldEvents()        (agency-world-viz.ts:2453)
//   · actionForTool      actionForTool()          (agency-world-viz.ts:2424)
//   · AmbientDrift       ambientDriftStep()       (activity-map.ts:7003)
//   · clampFlyScale      cameraFlyTo() clamp      (activity-map.ts:6941)
//   · dropZones          publishWorldSectors()    (activity-map.ts:4651), in world px
//   · dragAssignRequest  DragAssignController     (world-interactions/drag-assign.ts)
//   · pulse / reticle    renderFx()               (agency-world-viz.ts:2580-2740)
import { BroadcastDirector, CameraDirector, agentLabel, hitTestSector } from './web-mesh.generated';
import { FALLBACK_ACCENT, worldBounds } from './world';

/** activity-map.ts MIN_ZOOM / MAX_ZOOM — cameraFlyTo clamps to these. */
export const FLY_MIN_SCALE = 0.2;
export const FLY_MAX_SCALE = 3.5;
export function clampFlyScale(s) {
  return Math.min(Math.max(s, FLY_MIN_SCALE), FLY_MAX_SCALE);
}

/** pixi-viewport 'easeInOutSine' (penner). */
export function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** Pointer pauses the host feeds the directors (agency-world-viz.ts). */
export const POINTER_PAUSE_MS = 1500; // handleFxPointerDown
export const WHEEL_PAUSE_MS = 3000; // handleFxWheel (pinch on a phone)
export const FOLLOW_REFLY_MS = 600; // renderFx follow lock cadence
export const FOLLOW_SCALE = 1.5;
export const FOLLOW_FLY_MS = 650;
export const DBLTAP_SCALE = 1.6; // handleFxDblClick
export const DBLTAP_FLY_MS = 700;
export const PULSE_TTL_MS = 1400;
export const MOBILE_PULSE_CAP = 6;
export const TOAST_MS = 2600; // world-interactions toast()
export const REJECT_MS = 520; // drag-assign reject flash

export function actionForTool(kind, label) {
  if (label) return label.length > 40 ? label.slice(0, 38) + '…' : label;
  return kind ? `running ${kind}` : 'working';
}

function pointInPoly(x, y, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].y > y) !== (poly[j].y > y) && x < ((poly[j].x - poly[i].x) * (y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) ins = !ins;
  }
  return ins;
}

/** engine.sectorIdAtWorld */
export function sectorAt(station, x, y) {
  for (const z of station?.zones || []) if (pointInPoly(x, y, z.poly)) return z;
  return null;
}

/** accentCss(engine.sectorIdAtWorld(pos)) */
export function accentAt(station, x, y) {
  return sectorAt(station, x, y)?.accent || FALLBACK_ACCENT;
}

/**
 * Map a batch of store world events into director beats + highlight pulses —
 * agency-world-viz.ts noteWorldEvents(). `lastStatus` is the host's
 * lastStatusByKey map (mutated, as on the web).
 */
export function worldEventBeats(events, { agents, lastStatus, atrium, nodes, now }) {
  const beats = [];
  const pulses = [];
  for (const e of events) {
    switch (e.kind) {
      case 'agent.tool': {
        const a = agents.get(e.sessionKey);
        beats.push({
          kind: 'tool',
          sessionKey: e.sessionKey,
          agentName: a?.name ?? a?.label,
          action: actionForTool(e.tool?.kind, e.tool?.label),
          target: a?.repo || a?.project || a?.cwd,
          toolKind: e.tool?.kind,
          ts: now,
        });
        pulses.push(e.sessionKey);
        break;
      }
      case 'agent.spawn': {
        const a = e.agent;
        // Restored resting (finished) agents aren't a spawn beat.
        if (a?.status === 'completed' || a?.status === 'failed' || a?.resting) break;
        const known = agents.get(a.sessionKey);
        beats.push({ kind: 'spawn', sessionKey: a.sessionKey, agentName: a?.name ?? a?.label ?? known?.label, action: 'spawned', target: a?.repo || a?.project || known?.project, ts: now });
        pulses.push(a.sessionKey);
        break;
      }
      case 'agent.progress': {
        const prev = lastStatus.get(e.sessionKey);
        const next = e.patch?.status;
        if (next) {
          const wasIdle = !prev || prev === 'idle' || prev === 'queued';
          const isActive = next === 'running' || next === 'active' || next === 'working';
          if (wasIdle && isActive) pulses.push(e.sessionKey);
          lastStatus.set(e.sessionKey, next);
        }
        break;
      }
      case 'agent.complete': {
        const a = agents.get(e.sessionKey);
        beats.push({ kind: 'complete', sessionKey: e.sessionKey, agentName: a?.name ?? a?.label, success: e.success, target: a?.repo || a?.project, ts: now });
        pulses.push(e.sessionKey);
        lastStatus.set(e.sessionKey, e.success ? 'completed' : 'failed');
        break;
      }
      case 'fed.peer.connect':
      case 'fed.msg.send': {
        const peer = e.peerNodeId || e.toNodeId || e.fromNodeId;
        // No agent subject — point the camera at the federation atrium.
        beats.push({
          kind: 'fed-hop',
          action: 'federation hop',
          target: nodes.get(peer)?.name || peer,
          worldX: atrium?.x,
          worldY: atrium?.y,
          focusScale: 0.95,
          ts: now,
        });
        break;
      }
      default:
        break;
    }
  }
  return { beats, pulses };
}

/** addPulse() — replaces any pulse on the same agent; phone cap of 6 (mobileLike). */
export function addPulse(list, key, color, now, mobileLike = true) {
  if (mobileLike && list.length > MOBILE_PULSE_CAP) return list;
  const next = list.filter((p) => p.key !== key);
  next.push({ key, born: now, ttl: PULSE_TTL_MS, color });
  if (next.length > 24) next.splice(0, next.length - 24);
  return next;
}

/** One pulse's rings at age k∈[0,1) — renderFx() (r2 is desktop-only). */
export function pulseRings(p, now, mobileLike = true) {
  const k = (now - p.born) / p.ttl;
  if (k < 0 || k >= 1) return null;
  const out = {
    halo: { r: 16 + 6 * k, opacity: 0.18 * (1 - k) },
    r1: { r: 14 + 30 * k, opacity: 0.55 * (1 - k) },
    r2: null,
  };
  const k2 = (k - 0.25) / 0.75;
  if (k2 > 0 && !mobileLike) out.r2 = { r: 14 + 30 * k2, opacity: 0.4 * (1 - k2) };
  return out;
}

/** Reticle rotation in degrees at time t (renderFx: (t0 / 14) % 360). */
export function reticleRotation(t) {
  return (t / 14) % 360;
}

/** engine.ambientDriftStep(): a slow orbit around the station centre at 0.85×. */
export class AmbientDrift {
  constructor(station) {
    const b = worldBounds(station, null, null);
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
    this.rx = Math.max(120, (b.maxX - b.minX) * 0.18);
    this.ry = Math.max(90, (b.maxY - b.minY) * 0.18);
    this.phase = 0;
  }

  step() {
    this.phase = (this.phase + 0.6) % (Math.PI * 2);
    return { x: this.cx + Math.cos(this.phase) * this.rx, y: this.cy + Math.sin(this.phase * 0.7) * this.ry, scale: 0.85, ms: 5200 };
  }
}

/**
 * Build both web directors over native deps. `deps.flyTo(x, y, scale, ms)` is
 * the engine's cameraFlyTo (eased, clamped); `deps.onFocus` receives the
 * BroadcastDirector caption.
 */
export function createDirectors(deps) {
  const broadcast = new BroadcastDirector({
    now: deps.now,
    agentExists: deps.agentExists,
    agentWorldPos: deps.agentWorldPos,
    flyTo: deps.flyTo,
    ambientDrift: deps.ambientDrift,
    onFocus: deps.onFocus,
  });
  const camera = new CameraDirector({
    now: deps.now,
    agentExists: deps.agentExists,
    agentWorldPos: deps.agentWorldPos,
    flyTo: deps.flyTo,
    ambientDrift: deps.ambientDrift,
    getPausedUntil: deps.getPausedUntil,
    isBroadcastEnabled: () => broadcast.isEnabled(),
  });
  return { broadcast, camera };
}

/** activity-map.ts SECTOR_DROP_KIND */
export const SECTOR_DROP_KIND = {
  'mission-control': 'autonomy',
  'agent-quarters': 'agents',
  'engineering-bay': 'terminals',
  'command-atrium': 'federation',
  'comms-deck': 'channels',
  observatory: 'analytics',
  'broadcast-studio': 'media',
  'canvas-atrium': 'canvas',
  'the-vault': 'security',
};

/**
 * publishWorldSectors() in WORLD px: every station sector + every plugin room,
 * half-extent 70 (× 0.62 iso foreshortening). The web publishes the same rects
 * in screen px (half = 70 × zoom), so hit-testing a world point here is the
 * same test.
 */
export function dropZones(station, district) {
  const out = [];
  for (const z of station?.zones || []) {
    out.push({ id: z.id, name: z.name, x: z.center.x, y: z.center.y, w: 70, h: 70 * 0.62, kind: SECTOR_DROP_KIND[z.id] ?? 'tool' });
  }
  for (const r of district?.rooms || []) {
    out.push({ id: r.spec.id, name: r.spec.title, x: r.center.x, y: r.center.y, w: 70, h: 70 * 0.62, kind: `plugin:${r.spec.pluginId}` });
  }
  return out;
}

export function dropZoneAt(zones, wx, wy) {
  return hitTestSector(zones, wx, wy);
}

/** DragAssignController.assign(): the exact sessions.spawn the web fires. */
export function dragAssignRequest(agent, sector) {
  const label = agentLabel({ label: agent.label, id: agent.sessionKey });
  return {
    method: 'sessions.spawn',
    params: {
      task: `Assigned via drag to ${sector.name}. Continue ${label}'s work in this area.`,
      label: `${sector.name} · ${label}`,
    },
  };
}

/** world-interactions TAP_SLOP_PX / AGENT_HIT_RADIUS (screen px). */
export const TAP_SLOP_PX = 6;
export const DRAG_HIT_RADIUS = 24;
