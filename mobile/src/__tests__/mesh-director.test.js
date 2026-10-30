// Native Agent Mesh — camera directors, world events and drag-to-assign, held
// to the web sources they port (agency-world-viz.ts, broadcast-director.ts,
// camera-director.ts, activity-map.ts, world-interactions/drag-assign.ts).
import fs from 'fs';
import path from 'path';

import { MeshStore, MESH_EVENTS } from '../lib/mesh/mesh-data';
import { buildStation, buildDistrict } from '../lib/mesh/world';
import {
  AmbientDrift, actionForTool, addPulse, clampFlyScale, createDirectors, dragAssignRequest, dropZoneAt, dropZones,
  pulseRings, worldEventBeats, easeInOutSine, FLY_MIN_SCALE, FLY_MAX_SCALE,
} from '../lib/mesh/director';
import { BroadcastDirector, CameraDirector } from '../lib/mesh/web-mesh.generated';

const UI = path.resolve(__dirname, '../../../ui/src/ui');
const read = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8');

function harness({ positions }) {
  let t = 1000;
  const flights = [];
  const drifts = [];
  const captions = [];
  let paused = 0;
  const d = createDirectors({
    now: () => t,
    agentExists: (k) => positions.has(k),
    agentWorldPos: (k) => positions.get(k) || null,
    flyTo: (x, y, scale, ms) => flights.push({ x, y, scale, ms }),
    ambientDrift: () => drifts.push(t),
    getPausedUntil: () => paused,
    onFocus: (f) => captions.push(f ? f.caption : null),
  });
  return {
    d, flights, drifts, captions,
    advance(ms, step = 33) { for (let i = 0; i < ms; i += step) { t += step; d.broadcast.tick(); d.camera.tick(); } },
    now: () => t,
    pause(ms) { paused = t + ms; },
  };
}

describe('web directors are compiled in, not re-implemented', () => {
  test('the generated bundle carries both directors from the web sources', () => {
    const gen = fs.readFileSync(path.resolve(__dirname, '../lib/mesh/web-mesh.generated.js'), 'utf8');
    expect(gen).toContain('ui/src/ui/views/agent-ops/broadcast-director.ts');
    expect(gen).toContain('ui/src/ui/views/agent-ops/iso/camera-director.ts');
    expect(gen).toContain('ui/src/ui/components/world-interactions/world-state.ts');
    expect(typeof BroadcastDirector).toBe('function');
    expect(typeof CameraDirector).toBe('function');
    // Tunables match the web file (HOLD_MIN_MS / FOCUS_SCALE / IDLE_AMBIENT_MS).
    const web = read('views/agent-ops/broadcast-director.ts');
    for (const [tun, re] of [['HOLD_MIN_MS = 4000', /HOLD_MIN_MS = (4000|4e3);/], ['FOCUS_SCALE = 1.45', /FOCUS_SCALE = 1\.45;/], ['IDLE_AMBIENT_MS = 15000', /IDLE_AMBIENT_MS = (15000|15e3);/], ['PAUSE_MS = 10000', /PAUSE_MS = (10000|1e4);/]]) {
      expect(web).toContain(tun);
      expect(gen).toMatch(re);
    }
  });

  test('cameraFlyTo clamp + ease mirror activity-map.ts', () => {
    const src = read('views/agent-ops/activity-map.ts');
    expect(src).toMatch(/const MIN_ZOOM = 0\.2;/);
    expect(src).toMatch(/const MAX_ZOOM = 3\.5;/);
    expect(src).toContain("ease: 'easeInOutSine'");
    expect([FLY_MIN_SCALE, FLY_MAX_SCALE]).toEqual([0.2, 3.5]);
    expect(clampFlyScale(9)).toBe(3.5);
    expect(clampFlyScale(0.01)).toBe(0.2);
    expect(easeInOutSine(0)).toBeCloseTo(0);
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5);
    expect(easeInOutSine(1)).toBeCloseTo(1);
  });
});

describe('auto-focus (CameraDirector) — full web behaviour', () => {
  test('frames the active set with a critically-damped spring and yields to the user', () => {
    const positions = new Map([['a', { x: 1000, y: 600 }], ['b', { x: 1300, y: 700 }]]);
    const h = harness({ positions });
    expect(h.d.camera.isEnabled()).toBe(true); // default ON (no storage on RN)
    h.d.camera.noteEvent({ kind: 'tool', sessionKey: 'a', ts: h.now() });
    h.d.camera.noteEvent({ kind: 'spawn', sessionKey: 'b', ts: h.now() });
    h.advance(600);
    expect(h.flights.length).toBeGreaterThan(0);
    const last = h.flights[h.flights.length - 1];
    // Weighted centroid between the two agents, spread-fit zoom inside [0.4, 2.2].
    expect(last.x).toBeGreaterThan(1000);
    expect(last.x).toBeLessThan(1300);
    expect(last.scale).toBeGreaterThanOrEqual(0.4);
    expect(last.scale).toBeLessThanOrEqual(2.2);
    // Bridge eases ~1.6 × the 110 ms commit cadence.
    expect(last.ms).toBe(176);
    // The lead (reticle subject) is the hottest agent — the fresh spawn.
    expect(h.d.camera.getCurrentSubject()).toBe('b');
    // User touches → paused (fxPausedUntil), no new flights.
    h.pause(1500);
    const n = h.flights.length;
    h.advance(1000);
    expect(h.flights.length).toBe(n);
  });

  test('idles into the cinematic ambient orbit after 12 s of quiet', () => {
    const h = harness({ positions: new Map() });
    h.advance(12_500, 100);
    expect(h.drifts.length).toBe(1);
    const drift = new AmbientDrift(buildStation());
    const a = drift.step();
    const b = drift.step();
    expect(a.scale).toBe(0.85);
    expect(a.ms).toBe(5200);
    expect(a.x).not.toBe(b.x);
  });

  test('yields entirely while Broadcast is on', () => {
    const positions = new Map([['a', { x: 1000, y: 600 }]]);
    const h = harness({ positions });
    h.d.broadcast.setEnabled(true);
    h.d.camera.noteEvent({ kind: 'tool', sessionKey: 'a', ts: h.now() });
    h.d.broadcast.noteEvent({ kind: 'tool', sessionKey: 'a', agentName: 'Ash', action: 'Bash: ls', ts: h.now() });
    h.advance(400);
    // Every flight now comes from the broadcast director (FOCUS_SCALE 1.45 / 900 ms).
    expect(h.flights.every((f) => f.scale === 1.45 && f.ms === 900)).toBe(true);
  });
});

describe('Broadcast (BroadcastDirector) — full web behaviour', () => {
  test('scores beats, flies to the top subject, captions it, holds, then bounces', () => {
    const positions = new Map([['a', { x: 900, y: 500 }], ['b', { x: 1400, y: 800 }]]);
    const h = harness({ positions });
    h.d.broadcast.setEnabled(true);
    const t0 = h.now();
    h.d.broadcast.noteEvent({ kind: 'tool', sessionKey: 'a', agentName: 'Builder', action: 'Bash: pnpm test', toolKind: 'bash', ts: t0 });
    h.d.broadcast.noteEvent({ kind: 'complete', sessionKey: 'b', agentName: 'Reviewer', success: false, target: 'InfiniBot', ts: t0 });
    h.advance(50);
    // A failed completion outranks a tool start.
    expect(h.flights[0]).toMatchObject({ x: 1400, y: 800, scale: 1.45, ms: 900 });
    expect(h.captions[h.captions.length - 1]).toBe('Reviewer  ·  task failed  ·  InfiniBot');
    expect(h.d.broadcast.getCurrentSubject()).toBe('b');
    // Hold 4–7 s, then the next beat.
    h.advance(7100);
    expect(h.flights.some((f) => f.x === 900 && f.y === 500)).toBe(true);
    expect(h.captions).toContain('Builder  ·  Bash: pnpm test');
  });

  test('a touch backs broadcast off for 10 s; switching it off clears the caption', () => {
    const positions = new Map([['a', { x: 900, y: 500 }]]);
    const h = harness({ positions });
    h.d.broadcast.setEnabled(true);
    h.d.broadcast.notePointerInteraction();
    h.d.broadcast.noteEvent({ kind: 'tool', sessionKey: 'a', ts: h.now() });
    h.advance(9000, 100);
    expect(h.flights.filter((f) => f.ms === 900)).toHaveLength(0);
    h.advance(1200, 100);
    expect(h.flights.filter((f) => f.ms === 900).length).toBeGreaterThan(0);
    h.d.broadcast.setEnabled(false);
    expect(h.captions[h.captions.length - 1]).toBeNull();
  });
});

describe('world events → beats (agency-world-viz noteWorldEvents)', () => {
  test('MeshStore emits the bridge WorldEvents the directors consume', () => {
    const s = new MeshStore();
    s.applySnapshot({ nodes: [{ id: 'local', name: 'Local' }], agents: [{ sessionKey: 'k1', label: 'One', status: 'working', nodeId: 'local' }] });
    s.applyEvent('agent', { sessionKey: 'k1', stream: 'tool', data: { name: 'Bash' } });
    s.applyEvent('session.progress', { sessionKey: 'k1', status: 'working', progress: 50 });
    s.applyEvent('subagent.complete', { sessionKey: 'k1' });
    s.applyEvent('federation.peer.connected', { peerNodeId: 'sat-1' });
    expect(MESH_EVENTS).toContain('federation.peer.connected');
    const kinds = s.drainWorldEvents().map((e) => e.kind);
    expect(kinds).toEqual(['agent.spawn', 'agent.tool', 'agent.progress', 'agent.complete', 'fed.peer.connect']);
    expect(s.drainWorldEvents()).toEqual([]);
  });

  test('beats + pulses mirror the web switch', () => {
    const agents = new Map([['k1', { sessionKey: 'k1', label: 'Builder', project: 'IB' }]]);
    const lastStatus = new Map();
    const { beats, pulses } = worldEventBeats([
      { kind: 'agent.tool', sessionKey: 'k1', tool: { kind: 'bash', label: 'Bash: a very long command line that keeps going on' } },
      { kind: 'agent.spawn', agent: { sessionKey: 'k2', label: 'New', status: 'working' } },
      { kind: 'agent.spawn', agent: { sessionKey: 'k3', status: 'completed' } },
      { kind: 'agent.progress', sessionKey: 'k1', patch: { status: 'working' } },
      { kind: 'agent.complete', sessionKey: 'k1', success: true },
      { kind: 'fed.peer.connect', peerNodeId: 'sat-1' },
    ], { agents, lastStatus, atrium: { x: 10, y: 20 }, nodes: new Map([['sat-1', { name: 'Laptop' }]]), now: 5 });
    expect(beats.map((b) => b.kind)).toEqual(['tool', 'spawn', 'complete', 'fed-hop']);
    expect(beats[0].action).toBe(actionForTool('bash', 'Bash: a very long command line that keeps going on'));
    expect(beats[0].action.endsWith('…')).toBe(true);
    expect(beats[3]).toMatchObject({ target: 'Laptop', worldX: 10, worldY: 20, focusScale: 0.95 });
    expect(pulses).toEqual(['k1', 'k2', 'k1', 'k1']);
    expect(lastStatus.get('k1')).toBe('completed');
  });

  test('pulses: one per agent, phone cap, desktop-only second ring', () => {
    let list = [];
    for (let i = 0; i < 10; i++) list = addPulse(list, `k${i}`, '#fff', 0);
    expect(list.length).toBe(7);
    list = addPulse([{ key: 'a', born: 0, ttl: 1400, color: '#fff' }], 'a', '#000', 5);
    expect(list).toHaveLength(1);
    const r = pulseRings({ key: 'a', born: 0, ttl: 1400 }, 700);
    expect(r.r1.r).toBeCloseTo(29);
    expect(r.r2).toBeNull();
    expect(pulseRings({ key: 'a', born: 0, ttl: 1400 }, 700, false).r2).not.toBeNull();
    expect(pulseRings({ key: 'a', born: 0, ttl: 1400 }, 1500)).toBeNull();
  });
});

describe('drag-to-assign (world-interactions/drag-assign.ts)', () => {
  test('drop zones = every sector + plugin room, at the web half-extents', () => {
    const station = buildStation();
    const district = buildDistrict([{ id: 'flypic', name: 'FlyPic', enabled: true }], null);
    const zones = dropZones(station, district);
    expect(zones.length).toBe(station.zones.length + district.rooms.length);
    const obs = zones.find((z) => z.id === 'observatory');
    expect(obs).toMatchObject({ name: 'OBSERVATORY', kind: 'analytics', w: 70 });
    expect(obs.h).toBeCloseTo(43.4);
    expect(dropZoneAt(zones, obs.x + 60, obs.y + 40)?.id).toBe('observatory');
    expect(dropZoneAt(zones, -99999, -99999)).toBeNull();
    const web = read('views/agent-ops/activity-map.ts');
    expect(web).toContain('const half = 70 * this.viewport.scale.x;');
    expect(web).toContain('h: half * 0.62');
  });

  test('assign fires the exact sessions.spawn the web does', () => {
    const req = dragAssignRequest({ sessionKey: 'agent:main:subagent:x', label: 'Mesh port' }, { name: 'ENGINEERING BAY' });
    expect(req).toEqual({
      method: 'sessions.spawn',
      params: {
        task: "Assigned via drag to ENGINEERING BAY. Continue Mesh port's work in this area.",
        label: 'ENGINEERING BAY · Mesh port',
      },
    });
    const web = read('components/world-interactions/drag-assign.ts');
    expect(web).toContain('callRpc("sessions.spawn"');
    expect(web).toContain('const task = `Assigned via drag to ${sector.name}. Continue ${label}\'s work in this area.`;');
    expect(web).toContain('label: `${sector.name} · ${label}`');
  });
});

describe('phone HUD fit (no sideways scroll, opaque compact landscape, no emoji)', () => {
  const hud = fs.readFileSync(path.resolve(__dirname, '../components/mesh/MeshHud.js'), 'utf8');
  const bar = fs.readFileSync(path.resolve(__dirname, '../components/mesh/MeshBottomBar.js'), 'utf8');
  const fx = fs.readFileSync(path.resolve(__dirname, '../components/mesh/MeshFx.js'), 'utf8');
  test('toolbar wraps instead of a horizontal ScrollView', () => {
    expect(hud).not.toMatch(/ScrollView/);
    expect(hud).toMatch(/toolbar: \{ flexDirection: 'row', flexWrap: 'wrap'/);
  });
  test('landscape panels are opaque', () => {
    expect(hud).toContain("const PANEL = 'rgba(9,9,12,0.97)'");
    expect(hud).toMatch(/compact && styles\.colCompact/);
  });
  test('no emoji in the mesh chrome', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}]/u;
    for (const src of [hud, bar, fx]) expect(src).not.toMatch(emoji);
  });
});
