import {
  sanitizeSnapshot, snapshotTypes, buildIndex, rootProjectOf, owningProjectOf, visualKind, colorFor, shapeFor,
  filterGraph, searchNodes, groupOf, groupAndCollapse, routeEdges, layoutClusters, buildGraphView,
  fitCamera, hitTest, labelTier, wantsLabel, placeLabels, familyOf, connectionsOf, aiPromptFor,
  planLink, planMove, planStatus, runPlan, webPathFor, appTargetFor, statusOf, KIND_PALETTE, HEALTH_COLOR,
} from '../lib/kg-model';

const P = (id, label, meta = {}) => ({ id: `project:${id}`, kind: 'project', label, weight: 0.5, meta: { projectId: id, ...meta } });
const T = (id, projectId, status = 'todo') => ({ id: `task:${id}`, kind: 'task', label: `Task ${id}`, meta: { projectId, status } });
const N = (id, label, meta = {}) => ({ id: `note:${id}`, kind: 'note', label, meta });

function fixture() {
  const nodes = [
    P('root', 'InfiniBot', { health: 'active', tasks: 40 }),
    P('sub', 'Mobile app', { parentProjectId: 'root', health: 'at_risk' }),
    P('other', 'KinglyVault', { health: 'done' }),
    N('n1', 'Design notes'),
    N('n2', 'Robotics landscape', { tags: ['research'] }),
    N('lonely', 'Orphan note'),
    { id: 'client:c1', kind: 'client', label: 'Acme', meta: { clientId: 'c1', status: 'prospect' } },
    { id: 'idea:i1', kind: 'idea', label: 'Voice wake word', meta: { status: 'new' } },
    { id: 'report:r1', kind: 'report', label: 'Weekly', meta: { status: 'ready' } },
  ];
  for (let i = 0; i < 30; i++) nodes.push(T(`a${i}`, 'sub', i % 3 ? 'todo' : 'done'));
  for (let i = 0; i < 5; i++) nodes.push(T(`b${i}`, 'other'));
  const edges = [
    { source: 'project:sub', target: 'project:root', rel: 'sub-project of' },
    { source: 'note:n1', target: 'project:sub', rel: 'about' },
    { source: 'note:n2', target: 'project:root', rel: 'mentions', inferred: true },
    { source: 'client:c1', target: 'project:other', rel: 'client of', inferred: true },
    { source: 'report:r1', target: 'project:root', rel: 'report documents project' },
    ...nodes.filter((n) => n.kind === 'task').map((t) => ({ source: `project:${t.meta.projectId}`, target: t.id, rel: 'contains' })),
  ];
  return sanitizeSnapshot({ nodes, edges, typeStats: { project: 3 } });
}

describe('kg-model: snapshot + index', () => {
  test('sanitizeSnapshot drops malformed nodes, duplicates and dangling edges', () => {
    const s = sanitizeSnapshot({
      nodes: [{ id: 'project:a', kind: 'project', label: 'A' }, { id: 'project:a', kind: 'project' }, { kind: 'note' }, null],
      edges: [{ source: 'project:a', target: 'note:missing', rel: 'x' }, { source: 'project:a', target: 'project:a' }],
    });
    expect(s.nodes).toHaveLength(1);
    expect(s.edges).toHaveLength(0);
    expect(s.dropped).toBe(5);
    expect(sanitizeSnapshot(null)).toBeNull();
  });

  test('snapshotTypes maps the research layer onto notes+reports and always keeps projects', () => {
    expect(snapshotTypes(['research']).sort()).toEqual(['note', 'project', 'report']);
    expect(snapshotTypes(['task', 'bogus'])).toEqual(['task', 'project']);
  });

  test('family + ownership resolution', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    expect(rootProjectOf('project:sub', idx)).toBe('project:root');
    expect(owningProjectOf(idx.byId.get('task:a1'), idx)).toBe('project:sub');
    expect(owningProjectOf(idx.byId.get('note:n1'), idx)).toBe('project:sub');
    expect(owningProjectOf(idx.byId.get('note:lonely'), idx)).toBeNull();
  });

  test('visual kinds, colours and shapes follow the web legend', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    expect(visualKind(idx.byId.get('note:n2'))).toBe('research');
    expect(shapeFor('project')).toBe('gem');
    expect(shapeFor('task')).toBe('block');
    expect(shapeFor('note')).toBe('pages');
    expect(shapeFor('report')).toBe('report');
    expect(shapeFor('research')).toBe('lens');
    expect(shapeFor('agent')).toBe('agent');
    expect(shapeFor('client')).toBe('person');
    expect(shapeFor('idea')).toBe('bulb');
    expect(colorFor(idx.byId.get('project:root'))).toBe(HEALTH_COLOR.active);
    expect(colorFor(idx.byId.get('note:n1'))).toBe(KIND_PALETTE.note);
  });
});

describe('kg-model: filters', () => {
  test('layer filter hides tasks by default and treats research as its own layer', () => {
    const s = fixture();
    const f = filterGraph(s, { kinds: ['project', 'note'] });
    expect(f.nodes.some((n) => n.kind === 'task')).toBe(false);
    expect(f.nodes.find((n) => n.id === 'note:n2')).toBeUndefined();
    const r = filterGraph(s, { kinds: ['project', 'research'] });
    expect(r.nodes.find((n) => n.id === 'note:n2')).toBeTruthy();
    expect(r.nodes.find((n) => n.id === 'note:n1')).toBeUndefined();
  });

  test('status filter uses project health and normalised statuses', () => {
    const s = fixture();
    const f = filterGraph(s, { statuses: ['done'] });
    expect(f.nodes.map((n) => n.id)).toContain('project:other');
    expect(f.nodes.map((n) => n.id)).not.toContain('project:root');
    expect(f.nodes.every((n) => statusOf(n) === 'done')).toBe(true);
    expect(f.edges.every((e) => f.index.byId.has(e.source) && f.index.byId.has(e.target))).toBe(true);
  });

  test('focus keeps exactly one project family', () => {
    const s = fixture();
    const f = filterGraph(s, { focusId: 'project:sub' });
    const ids = new Set(f.nodes.map((n) => n.id));
    expect(ids.has('project:root')).toBe(true);
    expect(ids.has('project:sub')).toBe(true);
    expect(ids.has('note:n1')).toBe(true);
    expect(ids.has('task:a3')).toBe(true);
    expect(ids.has('project:other')).toBe(false);
    expect(ids.has('task:b1')).toBe(false);
    expect(familyOf('nope', s.nodes, buildIndex(s.nodes, s.edges))).toBeNull();
  });

  test('search ranks prefix label matches first and matches tags', () => {
    const s = fixture();
    expect(searchNodes(s.nodes, 'mob')[0].id).toBe('project:sub');
    expect(searchNodes(s.nodes, 'research').map((n) => n.id)).toContain('note:n2');
    expect(searchNodes(s.nodes, '')).toEqual([]);
    const only = filterGraph(s, { search: 'orphan', searchOnly: true });
    expect(only.nodes.map((n) => n.id)).toEqual(['note:lonely']);
  });
});

describe('kg-model: grouping + super-node collapse', () => {
  test('type mode groups by kind', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    expect(groupOf(idx.byId.get('task:a1'), 'type', idx).key).toBe('type:task');
    expect(groupOf(idx.byId.get('note:n2'), 'type', idx).key).toBe('type:research');
  });

  test('project mode groups by top-level family and clusters unlinked nodes by type', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    expect(groupOf(idx.byId.get('task:a1'), 'project', idx).key).toBe('fam:project:root');
    expect(groupOf(idx.byId.get('note:lonely'), 'project', idx)).toMatchObject({ key: 'unlinked:note', title: 'Unlinked notes' });
    expect(groupOf(idx.byId.get('idea:i1'), 'project', idx).key).toBe('unlinked:idea');
  });

  test('status mode groups by status bucket', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    expect(groupOf(idx.byId.get('project:sub'), 'status', idx).key).toBe('status:at_risk');
    expect(groupOf(idx.byId.get('task:a0'), 'status', idx).key).toBe('status:done');
  });

  test('big buckets collapse into a count super-node, small ones stay expanded', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    const { groups, memberOf } = groupAndCollapse(s.nodes, idx, { mode: 'project' });
    const fam = groups.find((g) => g.key === 'fam:project:root');
    expect(fam.items[0].id).toBe('project:root'); // hub first
    const sup = fam.items.find((it) => it.superKind);
    expect(sup).toMatchObject({ kind: 'task', count: 30, label: '30 tasks' });
    expect(memberOf.get('task:a7')).toBe(sup.id);
    const other = groups.find((g) => g.key === 'fam:project:other');
    expect(other.items.filter((it) => it.kind === 'task').every((it) => !it.superKind)).toBe(true); // 5 < 24
    expect(groups[groups.length - 1].key.startsWith('unlinked:')).toBe(true);
  });

  test('expanding a super-node shows its members; collapseAt overrides apply', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    const supId = 'super:fam:project:root:task';
    const { memberOf } = groupAndCollapse(s.nodes, idx, { mode: 'project', expanded: new Set([supId]) });
    expect(memberOf.get('task:a7')).toBe('task:a7');
    const tight = groupAndCollapse(s.nodes, idx, { mode: 'project', collapseAt: { task: 3 } });
    expect(tight.memberOf.get('task:b1')).toBe('super:fam:project:other:task');
  });

  test('edges re-route onto super-nodes and dedupe', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    const { memberOf } = groupAndCollapse(s.nodes, idx, { mode: 'project' });
    const routed = routeEdges(s.edges, memberOf);
    const toSuper = routed.filter((e) => e.target === 'super:fam:project:root:task' || e.source === 'super:fam:project:root:task');
    expect(toSuper).toHaveLength(1);
    expect(toSuper[0].count).toBe(30);
  });

  test('large data: 350 projects / 2,194 tasks stays bounded with tasks collapsed', () => {
    const nodes = [];
    const edges = [];
    for (let p = 0; p < 350; p++) nodes.push(P(`p${p}`, `Project ${p}`, { health: p % 5 ? 'backlog' : 'active', tasks: 7 }));
    for (let t = 0; t < 2194; t++) {
      const pid = `p${t % 350}`;
      nodes.push(T(`t${t}`, pid));
      edges.push({ source: `project:${pid}`, target: `task:t${t}`, rel: 'contains' });
    }
    const snap = sanitizeSnapshot({ nodes, edges });
    const t0 = Date.now();
    const typeView = buildGraphView(snap, { mode: 'type', kinds: ['project', 'task'] });
    expect(Date.now() - t0).toBeLessThan(3000);
    // 350 projects + one 2,194-task super-node
    expect(typeView.items).toHaveLength(351);
    expect(typeView.items.find((i) => i.superKind).count).toBe(2194);
    // Tasks off (the default layers): only projects
    const def = buildGraphView(snap, { mode: 'project', kinds: ['project', 'note'] });
    expect(def.items.every((i) => i.node?.kind === 'project')).toBe(true);
    // Project mode with tasks on: every family's 6–7 tasks stay below the threshold
    const fam = buildGraphView(snap, { mode: 'project', kinds: ['project', 'task'] });
    expect(fam.items.length).toBeLessThanOrEqual(2544);
  });
});

describe('kg-model: layout, camera, LOD, hit-testing', () => {
  test('layout is deterministic, spaced and groups never overlap', () => {
    const s = fixture();
    const a = buildGraphView(s, { mode: 'type' });
    const b = buildGraphView(s, { mode: 'type' });
    expect(a.items.map((i) => [i.id, Math.round(i.x), Math.round(i.y)])).toEqual(b.items.map((i) => [i.id, Math.round(i.x), Math.round(i.y)]));
    for (let i = 0; i < a.groups.length; i++) {
      for (let j = i + 1; j < a.groups.length; j++) {
        const g = a.groups[i];
        const h = a.groups[j];
        expect(Math.hypot(g.x - h.x, g.y - h.y)).toBeGreaterThanOrEqual(g.R + h.R);
      }
    }
    // min spacing between items of one group
    const grp = a.items.filter((i) => i.group === 'type:project');
    for (let i = 0; i < grp.length; i++) for (let j = i + 1; j < grp.length; j++) {
      expect(Math.hypot(grp[i].x - grp[j].x, grp[i].y - grp[j].y)).toBeGreaterThan(20);
    }
  });

  test('fitCamera frames the bounds and hitTest finds the tapped node', () => {
    const s = fixture();
    const v = buildGraphView(s, { mode: 'project' });
    const cam = fitCamera(v.bounds, 390, 700);
    const hub = v.items.find((i) => i.id === 'project:root');
    const sx = cam.k * hub.x + cam.x;
    const sy = cam.k * hub.y + cam.y;
    expect(sx).toBeGreaterThan(0);
    expect(sx).toBeLessThan(390);
    expect(hitTest(v.items, cam, sx + 2, sy - 2).id).toBe('project:root');
    expect(hitTest(v.items, cam, -500, -500)).toBeNull();
  });

  test('labels by zoom level', () => {
    expect(labelTier(0.3)).toBe('hubs');
    expect(labelTier(0.8)).toBe('anchors');
    expect(labelTier(2)).toBe('all');
    const top = { node: { kind: 'project', meta: {} } };
    const sub = { node: { kind: 'project', meta: { parentProjectId: 'x' } } };
    const note = { node: { kind: 'note', meta: {} } };
    expect(wantsLabel(top, 'hubs')).toBe(true);
    expect(wantsLabel(sub, 'hubs')).toBe(false);
    expect(wantsLabel(sub, 'anchors')).toBe(true);
    expect(wantsLabel(note, 'anchors')).toBe(false);
    expect(wantsLabel({ superKind: true }, 'hubs')).toBe(true);
    expect(placeLabels([{ x: 0, y: 0, w: 50, h: 10 }, { x: 10, y: 2, w: 50, h: 10 }, { x: 0, y: 30, w: 50, h: 10 }])).toEqual([0, 2]);
  });
});

describe('kg-model: detail + ops planners (no live writes)', () => {
  test('connections + AI prompt + targets', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    const conns = connectionsOf('project:root', idx);
    expect(conns[0].inferred).toBe(false);
    expect(conns.map((c) => c.node.id)).toContain('note:n2');
    const prompt = aiPromptFor(idx.byId.get('project:root'), idx);
    expect(prompt).toMatch(/InfiniBot/);
    expect(prompt).toMatch(/Mobile app/);
    expect(webPathFor(idx.byId.get('project:root'))).toBe('/projects/infinibot--root');
    expect(appTargetFor(idx.byId.get('project:root'))).toMatchObject({ tab: 'Board', params: { projectId: 'root' } });
    expect(appTargetFor(idx.byId.get('report:r1'))).toMatchObject({ screen: 'ReportsScreen', params: { reportId: 'r1' } });
  });

  test('planLink uses objrel.link with a typed edge when the pair has one', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    const plan = planLink(idx.byId.get('task:b1'), idx.byId.get('project:root'), idx);
    expect(plan.ok).toBe(true);
    expect(plan.call).toEqual({ method: 'objrel.link', params: { fromType: 'project', fromId: 'root', toType: 'task', toId: 'b1', edge: 'project_has_task', createdBy: 'knowledge-graph' } });
    expect(planLink(idx.byId.get('note:n1'), idx.byId.get('project:sub'), idx)).toMatchObject({ ok: false, reason: 'These are already linked.' });
    expect(planLink(idx.byId.get('idea:i1'), idx.byId.get('project:sub'), idx).ok).toBe(false);
  });

  test('planMove mirrors the web re-assign calls and guards cycles', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    expect(planMove(idx.byId.get('task:b1'), idx.byId.get('project:root'), idx).call).toEqual({ method: 'kanban.tasks.update', params: { id: 'b1', projectId: 'root' } });
    expect(planMove(idx.byId.get('note:n1'), idx.byId.get('project:other'), idx).call).toEqual({ method: 'notes.update', params: { id: 'n1', projectId: 'other' } });
    expect(planMove(idx.byId.get('project:other'), idx.byId.get('project:root'), idx).call).toEqual({ method: 'kanban.projects.update', params: { id: 'other', parentProjectId: 'root' } });
    expect(planMove(idx.byId.get('project:root'), idx.byId.get('project:sub'), idx).ok).toBe(false); // loop
    expect(planMove(idx.byId.get('task:b1'), idx.byId.get('project:other'), idx).ok).toBe(false); // already there
    expect(planMove(N('doc:x', 'Doc'), idx.byId.get('project:root'), idx).ok).toBe(false);
  });

  test('planStatus maps task + project vocabularies', () => {
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    expect(planStatus(idx.byId.get('task:a1'), 'in_progress').call).toEqual({ method: 'kanban.tasks.update', params: { id: 'a1', status: 'in_progress' } });
    expect(planStatus(idx.byId.get('project:root'), 'review').call).toEqual({ method: 'kanban.projects.update', params: { id: 'root', status: 'Reviewing' } });
    expect(planStatus(idx.byId.get('note:n1'), 'done').ok).toBe(false);
    expect(planStatus(idx.byId.get('task:a1'), 'todo').ok).toBe(false); // unchanged
  });

  test('runPlan sends exactly the planned call', async () => {
    const calls = [];
    const send = async (m, p) => { calls.push([m, p]); return { ok: true }; };
    const s = fixture();
    const idx = buildIndex(s.nodes, s.edges);
    const r = await runPlan(send, planStatus(idx.byId.get('task:a1'), 'done'));
    expect(r.ok).toBe(true);
    expect(calls).toEqual([['kanban.tasks.update', { id: 'a1', status: 'done' }]]);
    const fail = await runPlan(async () => { throw new Error('boom'); }, planStatus(idx.byId.get('task:a1'), 'done'));
    expect(fail).toEqual({ ok: false, error: 'boom' });
    expect((await runPlan(send, { ok: false, reason: 'nope' })).error).toBe('nope');
  });
});
