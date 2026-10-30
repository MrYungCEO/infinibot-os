import { MeshStore, buildMeshState, normalizeStatus, coderBackendOf, parseRestingJson, MAX_RESTING_COMPLETED } from '../lib/mesh/mesh-data';
import { buildStation, buildDistrict, buildIslands, worldBounds, cell, SECTORS } from '../lib/mesh/world';
import { AgentPlacer } from '../lib/mesh/placement';
import { buildCompletedEntries, filterCompleted, buildAgentHoverCardModel, HudStatsTracker, roomSpecsFromPluginList } from '../lib/mesh/web-mesh.generated';

const sessRes = {
  sessions: [
    { key: 'agent:main:main', kind: 'main', label: 'Ash', active: false, totalTokens: 1200 },
    { key: 'agent:main:subagent:aaa', kind: 'subagent', label: 'Mobile mesh', active: true },
    { key: 'agent:main:subagent:old', kind: 'subagent', label: 'past run', active: false },
  ],
};
const subRes = {
  subagents: [
    { sessionKey: 'agent:main:subagent:aaa', runId: 'coder-mesh-1', status: 'running', task: 'Port the mesh', progress: 40, lastActivity: { kind: 'bash', label: 'Bash: ls', at: 1_700_000_000_000 }, kanbanTaskId: 't1' },
    { childSessionKey: 'agent:main:subagent:bbb', runId: 'r-b', status: 'queued', label: 'Codex review' },
  ],
};

describe('mesh data (web agency-data-bridge parity)', () => {
  test('fetchState shape → nodes + agents', () => {
    const { nodes, agents } = buildMeshState({ role: 'master', nodes: [{ id: 'sat-1', name: 'Laptop', state: 'connected' }] }, sessRes, subRes);
    expect(nodes.map((n) => [n.id, n.role, n.status])).toEqual([['local', 'hub', 'online'], ['sat-1', 'satellite', 'online']]);
    const keys = agents.map((a) => a.sessionKey);
    expect(keys).toEqual(['agent:main:main', 'agent:main:subagent:aaa', 'agent:main:subagent:bbb']);
    const sub = agents[1];
    expect(sub).toMatchObject({ status: 'working', progress: 40, runId: 'coder-mesh-1', coderBackend: 'claude-code', isBuild: true, kanbanTaskId: 't1', activityLabel: 'Bash: ls' });
    expect(agents[0]).toMatchObject({ status: 'idle', totalTokens: 1200 });
    expect(agents[2]).toMatchObject({ status: 'starting', label: 'Codex review', coderBackend: 'codex' });
  });

  test('status + backend normalisation', () => {
    expect(normalizeStatus('RUNNING')).toBe('working');
    expect(normalizeStatus('timeout')).toBe('failed');
    expect(normalizeStatus(undefined, true)).toBe('working');
    expect(coderBackendOf({ lastActivity: { coderBackend: 'gemini' } })).toBe('gemini');
  });

  test('live events: spawn → progress → complete parks the run on the resting ring', () => {
    const saved = [];
    const s = new MeshStore({ onRestingChange: (j) => saved.push(j) });
    s.applySnapshot(buildMeshState({}, sessRes, subRes));
    expect(s.applyEvent('subagent.spawned', { sessionKey: 'k1', label: 'New run', status: 'running' })).toBe(true);
    s.applyEvent('session.progress', { sessionKey: 'k1', progress: 55, lastActivity: { kind: 'edit', label: 'Edit: a.js' } });
    expect(s.agents.get('k1')).toMatchObject({ progress: 55, activityLabel: 'Edit: a.js' });
    expect(s.toolBeats.at(-1)).toMatchObject({ sessionKey: 'k1', kind: 'edit' });
    s.applyEvent('agent', { sessionKey: 'k1', stream: 'tool', data: { name: 'Bash' } });
    expect(s.toolBeats.at(-1)).toMatchObject({ kind: 'bash' });
    s.applyEvent('subagent.error', { sessionKey: 'k1', error: 'boom' });
    expect(s.agents.has('k1')).toBe(false);
    const resting = s.listAgents().find((a) => a.sessionKey === 'k1');
    expect(resting).toMatchObject({ status: 'failed', resting: true });
    expect(JSON.parse(saved.at(-1))[0].sessionKey).toBe('k1');
    // Federation wrapper + unknown topics.
    expect(s.applyEvent('federation.event', { event: { type: 'node.connected', payload: { nodeId: 'n2', name: 'Box' } } })).toBe(true);
    expect(s.listNodes().some((n) => n.id === 'n2')).toBe(true);
    expect(s.applyEvent('nope', {})).toBe(false);
  });

  test('reconcile: an agent missing from the next snapshot finishes', () => {
    const s = new MeshStore();
    s.applySnapshot(buildMeshState({}, sessRes, subRes));
    expect(s.agents.has('agent:main:subagent:aaa')).toBe(true);
    s.applySnapshot(buildMeshState({}, { sessions: [sessRes.sessions[0]] }, { subagents: [] }));
    expect(s.agents.has('agent:main:subagent:aaa')).toBe(false);
    expect(s.listAgents().find((a) => a.sessionKey === 'agent:main:subagent:aaa')).toMatchObject({ status: 'completed' });
  });

  test('resting ring persistence is sanitised and capped', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ sessionKey: `s${i}`, endedAt: i }));
    expect(parseRestingJson(JSON.stringify(many))).toHaveLength(MAX_RESTING_COMPLETED);
    expect(parseRestingJson('{bad')).toEqual([]);
  });
});

describe('world (web sector-layout / plugin-district parity)', () => {
  const station = buildStation();
  test('station: projection, sectors, props, beds, executive suite', () => {
    expect(cell(0, 0)).toEqual({ x: 800, y: 216 });
    expect(cell(24, 24)).toEqual({ x: 800, y: 984 });
    expect(station.zones).toHaveLength(SECTORS.length);
    expect(station.zones.find((z) => z.id === 'engineering-bay').accent).toBe('#2dd4bf');
    expect(station.bedSlots).toHaveLength(16);
    expect(station.decor.filter((d) => d.bed)).toHaveLength(16);
    expect(station.exec.center).toEqual({ x: 1440, y: 270 });
    expect(station.workSlots['engineering-bay'].length).toBeGreaterThan(2);
  });

  test('plugin district: rooms from plugins.list with the web placement + conduits', () => {
    const list = [
      { id: 'flypic', name: 'FlyPic', status: 'loaded', manifestVersion: 2, contributes: { mapRoom: { title: 'FlyPic Studio', theme: 'media-studio', size: 'M', placement: 'west' } } },
      { id: 'robovoice', name: 'Robovoice', status: 'loaded', manifestVersion: 2, contributes: { mapRoom: { title: 'Robovoice Studio', theme: 'voice-studio', size: 'M', placement: 'east' } } },
      { id: 'off', name: 'Off', status: 'disabled', manifestVersion: 2, contributes: { mapRoom: { title: 'Off' } } },
    ];
    expect(roomSpecsFromPluginList(list).map((s) => s.title)).toEqual(['FlyPic Studio', 'Robovoice Studio']);
    const d = buildDistrict(list);
    expect(d.rooms.map((r) => r.spec.subtitle)).toEqual(['plugin · photo + video', 'plugin · voice studio']);
    expect(d.rooms[0].accent).toBe('#fdba74');
    expect(d.rooms.every((r) => r.decor.length > 3 && r.workSlots.length > 0)).toBe(true);
    expect(d.conduits.some((c) => c.kind === 'trunk')).toBe(true);
    expect(d.conduits.filter((c) => c.kind === 'stub')).toHaveLength(2);
    const b = worldBounds(station, d, []);
    expect(b.minX).toBeLessThan(-100);
  });

  test('federation islands for satellites only', () => {
    const isl = buildIslands([{ id: 'local', role: 'hub' }, { id: 'sat', role: 'satellite', name: 'Laptop' }]);
    expect(isl).toHaveLength(1);
    expect(isl[0].center).toEqual({ x: 1350, y: 1700 });
    expect(isl[0].slots).toHaveLength(4);
  });
});

describe('placement (web spread rules)', () => {
  test('working agents get desks by domain; idle / finished agents rest on beds', () => {
    const station = buildStation();
    const placer = new AgentPlacer();
    const agents = [
      { sessionKey: 'a', agentId: 'main', label: 'Fix the build', currentTask: 'run pnpm test in the repo', status: 'working', coderBackend: 'claude-code' },
      { sessionKey: 'b', agentId: 'main', label: 'Research competitors', currentTask: 'web search pricing', status: 'working' },
      { sessionKey: 'c', agentId: 'main', label: 'Ash', status: 'idle' },
      { sessionKey: 'd', agentId: 'main', label: 'Done run', status: 'completed', resting: true, endedAt: 5 },
    ];
    const tools = new Map([['a', { kind: 'bash', at: 1000 }]]);
    const pos = placer.place(agents, { station, district: { rooms: [] }, tools, now: 1000 });
    expect(pos.get('a')).toMatchObject({ where: 'sector', sectorId: 'engineering-bay' });
    expect(pos.get('c').where).toBe('bed');
    expect(pos.get('d').where).toBe('bed');
    expect(pos.get('c')).not.toEqual(pos.get('d'));
    // Sticky beds.
    const again = placer.place(agents, { station, district: { rooms: [] }, tools, now: 2000 });
    expect(again.get('c')).toEqual(pos.get('c'));
    // Spread off: everyone working crowds Agent Quarters.
    const off = new AgentPlacer().place(agents, { station, district: { rooms: [] }, spread: false });
    expect(off.get('b').sectorId).toBe('agent-quarters');
  });
});

describe('web card / rail / HUD logic runs unchanged in the app', () => {
  test('completed rail entries + filters', () => {
    const now = Date.now();
    const recs = [
      { runId: 'r1', label: 'Verified run', state: 'verified', terminalAt: now - 60_000, startedAt: now - 120_000, result: { summary: 'Did it', files_changed: ['a'], commits: ['abc'] } },
      { runId: 'r2', label: 'Failed run', state: 'failed', terminalAt: now - 30_000 },
    ];
    const entries = buildCompletedEntries(recs, { now });
    expect(entries.map((e) => e.runId)).toEqual(['r2', 'r1']);
    expect(filterCompleted(entries, { filter: 'failed', q: '', windowMs: 86_400_000, now }).map((e) => e.runId)).toEqual(['r2']);
  });

  test('agent card model + HUD stats', () => {
    const m = buildAgentHoverCardModel({ sessionKey: 's', agentId: 'main', label: 'Run', status: 'working', progress: 140, totalTokens: 12_345, coderBackend: 'claude-code' }, { id: 'local', name: 'Local' }, null, Date.now());
    expect(m).toMatchObject({ name: 'Run', progress: 100, node: 'Local' });
    const hud = new HudStatsTracker();
    hud.noteTool(1000);
    expect(hud.compute([{ status: 'working' }, { status: 'completed' }], 2000).online).toBe(1);
  });
});

describe('mesh deep links', () => {
  // eslint-disable-next-line global-require
  const { resolveDeepLink } = require('../navigation/deep-links');
  test('infinibot://mesh opens the native Agent Mesh, optionally focused / on a review', () => {
    expect(resolveDeepLink('infinibot://mesh')).toEqual({ screen: 'NeuralMeshScreen', params: undefined, title: 'Agent Mesh' });
    expect(resolveDeepLink('infinibot://mesh?focus=agent:main:main')).toMatchObject({ params: { focus: 'agent:main:main' } });
    expect(resolveDeepLink('infinibot://mesh/run-42')).toMatchObject({ params: { focus: 'run-42' } });
    expect(resolveDeepLink('infinibot://mesh/review/run-42')).toMatchObject({ params: { review: 'run-42' } });
    expect(resolveDeepLink('infinibot://web/mesh/review/r1')).toMatchObject({ screen: 'NeuralMeshScreen', params: { review: 'r1' } });
  });
});

describe('HUD label layout (web counter-scale rules)', () => {
  // eslint-disable-next-line global-require
  const { layoutLabels } = require('../lib/mesh/label-layout');
  const station = buildStation();
  const district = buildDistrict([]);
  const agents = [
    { sessionKey: 'w', agentId: 'main', label: 'Coder run', status: 'working', coderBackend: 'claude-code', progress: 40 },
    { sessionKey: 'i', agentId: 'main', label: 'Ash', status: 'idle' },
  ];
  const positions = new Map([['w', { x: 400, y: 600, where: 'sector', sectorId: 'engineering-bay' }], ['i', { x: 800, y: 900, where: 'bed', sectorId: 'gateway-concourse' }]]);
  const size = { w: 390, h: 844 };
  test('coder runs get a build tag + tap target; idle agents a nameplate only when zoomed in', () => {
    const far = layoutLabels({ cam: { k: 0.3, x: 0, y: 0 }, station, district, islands: [], agents, positions, auditor: station.exec.auditor, screenshotCount: 3, size });
    expect(far.tags.map((t) => t.key)).toEqual(['w']);
    expect(far.plates).toHaveLength(0);
    expect(far.hits.some((h) => h.kind === 'agent' && h.key === 'w')).toBe(true);
    const near = layoutLabels({ cam: { k: 1, x: -600, y: -700 }, station, district, islands: [], agents, positions, auditor: station.exec.auditor, screenshotCount: 3, size });
    expect(near.plates.map((p) => p.key)).toEqual(['i']);
  });
  test('screenshot orbit: up to 6 thumbs at zoom ≥ 0.32, none below', () => {
    const shots = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, path: `/p${i}.png`, verdict: 'pass', label: 'x' }));
    const cam = { k: 0.6, x: 195 - 1440 * 0.6, y: 300 - 270 * 0.6 };
    const on = layoutLabels({ cam, station, district, islands: [], agents: [], positions: new Map(), auditor: station.exec.auditor, screenshotCount: 9, screenshots: shots, size });
    expect(on.thumbs.length).toBeGreaterThan(0);
    expect(on.thumbs.length).toBeLessThanOrEqual(6);
    expect(on.hits.some((h) => h.kind === 'screenshots')).toBe(true);
    const off = layoutLabels({ cam: { ...cam, k: 0.2 }, station, district, islands: [], agents: [], positions: new Map(), auditor: station.exec.auditor, screenshotCount: 9, screenshots: shots, size });
    expect(off.thumbs).toHaveLength(0);
  });
});

describe('ambient motion + review packets (web layout-engine / review-mesh-layer)', () => {
  // eslint-disable-next-line global-require
  const { agentOffset, packetFromMessage, packetHead, PACKET_MS } = require('../lib/mesh/motion');
  test('active agents orbit r=8 (y×0.55); idle off-bed agents bob; bed / finished agents stay still', () => {
    const a = { sessionKey: 'k', status: 'working' };
    const o = agentOffset(a, 'sector', 1.3);
    expect(Math.hypot(o.x, o.y / 0.55)).toBeCloseTo(8, 5);
    expect(agentOffset(a, 'sector', 1.3)).not.toEqual(agentOffset(a, 'sector', 2.1));
    const idle = agentOffset({ sessionKey: 'i', status: 'idle' }, 'sector', 0.7);
    expect(Math.abs(idle.x)).toBeLessThanOrEqual(4);
    expect(agentOffset({ sessionKey: 'i', status: 'idle' }, 'bed', 0.7)).toEqual({ x: 0, y: 0 });
    expect(agentOffset({ sessionKey: 'd', status: 'completed', resting: true }, 'bed', 3)).toEqual({ x: 0, y: 0 });
  });
  test('a review message flies worker → Auditor along an arc and lands', () => {
    const pk = packetFromMessage({ runId: 'r1', seq: 1, kind: 'submission', to: 'reviewer' }, 1000);
    expect(pk).toMatchObject({ runId: 'r1', toReviewer: true });
    expect(packetFromMessage({ runId: 'r1', seq: 2, kind: 'action' })).toBeNull();
    const w = { x: 0, y: 500 };
    const au = { x: 1000, y: 100 };
    const start = packetHead(pk, w, au, 1000);
    const mid = packetHead(pk, w, au, 1000 + PACKET_MS / 2);
    expect(start.x).toBeCloseTo(0, 5);
    expect(mid.y).toBeLessThan((start.y + au.y - 40) / 2); // lifted arc
    expect(packetHead(pk, w, au, 1000 + PACKET_MS + 1)).toBeNull();
  });
});

describe('walking + Director lasso', () => {
  // eslint-disable-next-line global-require
  const { stepWalk, keysInRect, WALK_PX_PER_S } = require('../lib/mesh/motion');
  test('agents walk toward a new spot at 60 px/s, snap when close, teleport when far', () => {
    const targets = new Map([['a', { x: 100, y: 0 }], ['b', { x: 2000, y: 0 }], ['c', { x: 5, y: 0 }]]);
    const shown = new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 0 }], ['c', { x: 0, y: 0 }]]);
    const n = stepWalk(shown, targets, 0.5);
    expect(n.get('a')).toEqual({ x: WALK_PX_PER_S * 0.5, y: 0, walking: true });
    expect(n.get('b')).toMatchObject({ x: 2000, walking: false });
    expect(n.get('c')).toMatchObject({ x: 5, walking: false });
    const spawned = stepWalk(new Map(), new Map([['d', { x: 50, y: 0 }]]), 0.1, { spawnAt: { x: 0, y: 0 } });
    expect(spawned.get('d').walking).toBe(true);
  });
  test('lasso picks the agents inside the dragged rect (either drag direction)', () => {
    const pts = new Map([['a', { x: 10, y: 10 }], ['b', { x: 100, y: 100 }], ['c', { x: 50, y: 60 }]]);
    expect(keysInRect(pts, 0, 0, 60, 70).sort()).toEqual(['a', 'c']);
    expect(keysInRect(pts, 60, 70, 0, 0).sort()).toEqual(['a', 'c']);
  });
});
