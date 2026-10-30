/**
 * Agency Topology — pure model + layout (src/screens/agency/topology/topology-model.js).
 */
import {
  SCOPE_LABELS,
  TOPOLOGY_TOP_CLIENTS,
  DENSE_CLIENT_THRESHOLD,
  MAX_UNLINKED_TILES,
  SIDE_BY_SIDE_MIN_WIDTH,
  buildList,
  buildTopology,
  clampZoom,
  clientRadius,
  commitGesture,
  createTopologyState,
  detailFor,
  edgePath,
  fitCamera,
  focusLabel,
  focusedIds,
  hitTest,
  initialCamera,
  isFocusable,
  layoutTopology,
  managerFromDetail,
  money,
  normalizeAgencies,
  normalizeClients,
  normalizeEmployees,
  normalizeProjects,
  normalizeRelations,
  parseNodeId,
  pickAgency,
  projectHealthLabel,
  projectTone,
  relationsSummary,
  relativeTime,
  scopeNote,
  scopedClients,
  scopedProjects,
  searchMatches,
  selectionKey,
  shapePath,
  summarize,
  toggleFocus,
  truncate,
  unwrap,
  utilizationTone,
  weightBasisFor,
  zoomAt,
} from '../screens/agency/topology/topology-model';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function client(id, extra = {}) {
  return {
    id,
    name: `Client ${id}`,
    status: 'active',
    pipelineStatus: 'in progress',
    billingEmail: null,
    projectCount: 0,
    invoiceCount: 0,
    lifetimeInvoicedCents: 0,
    outstandingCents: 0,
    mrrCents: 0,
    ...extra,
  };
}
const project = (id, clientId, extra = {}) => ({ id, clientId, name: `Project ${id}`, status: 'active', budgetCents: 0, mrrCents: 0, targetEndAt: null, ...extra });
const worker = (id, managerWorkerId = null, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  kind: 'ai',
  role: 'Role',
  department: 'Dept',
  availability: 'available',
  capacityHours: 40,
  allocatedHours: 0,
  utilizationPercent: 0,
  activeWork: 0,
  managerWorkerId,
  ...extra,
});

function fixture(overrides = {}) {
  return {
    ...createTopologyState(),
    agencyId: 'ag1',
    agencyName: 'Kingly',
    clients: [
      client('c1', { name: 'Devin', mrrCents: 50000 }),
      client('c2', { name: 'Grant', status: 'active', pipelineStatus: 'in progress', outstandingCents: 25000 }),
      client('c3', { name: 'Cold Co', status: 'prospect', pipelineStatus: 'cold' }),
      client('c4', { name: 'Done Inc', status: 'inactive', pipelineStatus: 'completed', lifetimeInvoicedCents: 1200000 }),
    ],
    projects: [
      project('p1', 'c1'),
      project('p2', 'c1', { status: 'on_hold' }),
      project('p3', null),
      project('p4', 'c3'),
      project('p5', null, { status: 'cancelled' }),
      project('p6', null, { targetEndAt: NOW - 1000 }),
    ],
    workers: [worker('ceo'), worker('vega', 'ceo'), worker('dev', 'vega', { utilizationPercent: 90 }), worker('wren', 'vega'), worker('quinn', null, { kind: 'human', utilizationPercent: 120 })],
    assignments: [{ id: 'a1', title: 'Project p1', status: 'active', members: [{ workerId: 'dev', role: 'lead' }, { workerId: 'ghost', role: 'x' }] }],
    lastLoadedAt: NOW,
    ...overrides,
  };
}

describe('normalisation', () => {
  test('unwrap handles keyed and bare responses', () => {
    expect(unwrap({ clients: [1] }, 'clients', [])).toEqual([1]);
    expect(unwrap([2], 'clients', [])).toEqual([2]);
    expect(unwrap(null, 'clients', [])).toEqual([]);
  });

  test('clients / projects / employees coerce shapes and drop junk', () => {
    const clients = normalizeClients({ clients: [{ id: 'x', name: 'X', mrrCents: '120', pipelineStatus: 'in progress' }, null, { name: 'no id' }] });
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ id: 'x', mrrCents: 120, status: 'prospect', projectCount: 0, billingEmail: null });
    const projects = normalizeProjects({ projects: [{ id: 'p', clientId: null, targetEndAt: 0 }] });
    expect(projects[0]).toMatchObject({ name: 'Untitled project', status: 'planned', targetEndAt: null, clientId: null });
    const emps = normalizeEmployees({ employees: [{ id: 'w', kind: 'robot' }] });
    expect(emps[0]).toMatchObject({ kind: 'human', managerWorkerId: null, utilizationPercent: 0 });
  });

  test('managerFromDetail reads employee.detail', () => {
    expect(managerFromDetail({ employee: { managerWorkerId: 'm1' } })).toBe('m1');
    expect(managerFromDetail({ employee: { managerWorkerId: null } })).toBeNull();
    expect(managerFromDetail(null)).toBeNull();
  });

  test('pickAgency prefers the chosen id, then the owned agency', () => {
    const agencies = normalizeAgencies({ agencies: [{ id: 'a', name: 'A', role: 'member' }, { id: 'b', name: 'B', role: 'owner' }] });
    expect(pickAgency(agencies, 'a').id).toBe('a');
    expect(pickAgency(agencies, 'zzz').id).toBe('b');
    expect(pickAgency([], null)).toBeNull();
  });

  test('relations normalise + summarise', () => {
    const r = normalizeRelations({ client: { id: 'c1', name: 'Devin' }, tasks: [{ id: 't', status: 'done' }, { id: 'u', status: 'ready' }], invoices: [{ id: 'i' }], contacts: [] }, 'project:p1');
    expect(r).toMatchObject({ key: 'project:p1', clientId: 'c1', clientName: 'Devin', loading: false });
    expect(relationsSummary(r)).toBe('0 contacts · 2 tasks (1 open) · 1 invoices');
  });
});

describe('formatting', () => {
  test('money, truncate, relativeTime', () => {
    expect(money(123456)).toBe('$1,235');
    expect(money(undefined)).toBe('$0');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
    expect(relativeTime(NOW - 5 * 60000, NOW)).toBe('5m ago');
    expect(relativeTime(null, NOW)).toBe('never');
  });
});

describe('scope', () => {
  test('active = real pipeline "in progress", falling back to rollup when absent', () => {
    const s = fixture();
    expect(scopedClients(s).map((c) => c.id)).toEqual(['c1', 'c2']);
    const legacy = fixture({ clients: [client('x', { pipelineStatus: undefined, status: 'active' }), client('y', { pipelineStatus: undefined, status: 'prospect' })] });
    expect(scopedClients(legacy).map((c) => c.id)).toEqual(['x']);
  });

  test('top ranks by revenue and keeps at most TOP clients', () => {
    const many = Array.from({ length: 20 }, (_, i) => client(`k${i}`, { mrrCents: i * 100 }));
    const s = fixture({ clients: many, clientScope: 'top' });
    const top = scopedClients(s);
    expect(top).toHaveLength(TOPOLOGY_TOP_CLIENTS);
    expect(top[0].id).toBe('k19');
  });

  test('none / all', () => {
    expect(scopedClients(fixture({ clientScope: 'none' }))).toEqual([]);
    expect(scopedClients(fixture({ clientScope: 'all' }))).toHaveLength(4);
  });

  test('projects: visible clients + unlinked, never cancelled; layer off → none', () => {
    const s = fixture();
    expect(scopedProjects(s, scopedClients(s)).map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p6']);
    expect(scopedProjects({ ...s, showProjects: false }, scopedClients(s))).toEqual([]);
  });
});

describe('semantic encoding', () => {
  test('project tone + health', () => {
    expect(projectTone(project('a', null, { status: 'completed' }), NOW)).toBe('neutral');
    expect(projectTone(project('a', null, { status: 'on_hold' }), NOW)).toBe('warning');
    expect(projectTone(project('a', null, { targetEndAt: NOW - 1 }), NOW)).toBe('danger');
    expect(projectHealthLabel(project('a', null, { targetEndAt: NOW - 1 }), NOW)).toBe('past target date');
    expect(projectHealthLabel(project('a', null, { status: 'planned' }), NOW)).toBe('planned');
  });

  test('utilisation ramp', () => {
    expect(utilizationTone(120)).toBe('danger');
    expect(utilizationTone(90)).toBe('warning');
    expect(utilizationTone(50)).toBe('success');
    expect(utilizationTone(0)).toBe('neutral');
  });

  test('weight basis falls back to project count when no revenue is recorded', () => {
    expect(weightBasisFor([client('a')])).toBe('projects');
    expect(weightBasisFor([client('a', { lifetimeInvoicedCents: 1200 })])).toBe('revenue');
    const big = clientRadius(client('a', { mrrCents: 100 }), 100, false, 'revenue');
    const small = clientRadius(client('b', { mrrCents: 1 }), 100, false, 'revenue');
    expect(big).toBeGreaterThan(small);
  });
});

describe('buildTopology', () => {
  test('nodes per layer, hidden-clients aggregate, unlinked anchor', () => {
    const m = buildTopology(fixture(), NOW);
    const ids = m.nodes.map((n) => n.id);
    expect(ids[0]).toBe('agency:ag1');
    expect(ids).toEqual(expect.arrayContaining(['worker:ceo', 'client:c1', 'client:c2', 'project:p1', 'project:p3', 'aggregate:unlinked', 'aggregate:clients']));
    expect(ids).not.toContain('client:c3');
    expect(ids).not.toContain('project:p4'); // its client is out of scope
    expect(ids).not.toContain('project:p5'); // cancelled
    expect(m.hiddenClients).toBe(2);
    expect(m.unlinkedProjects).toBe(2);
    expect(m.nodes.find((n) => n.id === 'aggregate:clients').name).toBe('+2 more clients');
  });

  test('edges: reporting lines, root bus for <=3 roots, delivery, resolvable assignments only', () => {
    const m = buildTopology(fixture(), NOW);
    const byKind = (k) => m.edges.filter((e) => e.kind === k);
    expect(byKind('reports').map((e) => `${e.source}>${e.target}`).sort()).toEqual(['worker:ceo>worker:vega', 'worker:vega>worker:dev', 'worker:vega>worker:wren']);
    expect(byKind('root').map((e) => e.target).sort()).toEqual(['worker:ceo', 'worker:quinn']);
    expect(byKind('delivers').find((e) => e.target === 'project:p3').source).toBe('aggregate:unlinked');
    expect(byKind('assigned')).toEqual([expect.objectContaining({ source: 'project:p1', target: 'worker:dev' })]);
  });

  test('workforce layer off drops workers and their edges', () => {
    const m = buildTopology(fixture({ showWorkforce: false }), NOW);
    expect(m.nodes.some((n) => n.kind === 'worker')).toBe(false);
    expect(m.edges.some((e) => e.kind === 'reports' || e.kind === 'assigned')).toBe(false);
  });

  test('worker tree: manager sits between its reports, depth = column', () => {
    const m = buildTopology(fixture(), NOW);
    const slot = (id) => m.workerSlots.get(id);
    expect(slot('ceo').depth).toBe(0);
    expect(slot('vega').depth).toBe(1);
    expect(slot('dev').depth).toBe(2);
    expect(slot('vega').slot).toBe((slot('dev').slot + slot('wren').slot) / 2);
    expect(m.maxWorkerDepth).toBe(2);
  });

  test('a reporting cycle does not hang and every worker is placed', () => {
    const s = fixture({ workers: [worker('a', 'b'), worker('b', 'a')] });
    const m = buildTopology(s, NOW);
    expect(m.workerSlots.size).toBe(2);
  });

  test('dense scope hides labels', () => {
    const many = Array.from({ length: DENSE_CLIENT_THRESHOLD + 4 }, (_, i) => client(`d${i}`));
    const m = buildTopology(fixture({ clients: many }), NOW);
    expect(m.dense).toBe(true);
    expect(m.nodes.filter((n) => n.kind === 'client').every((n) => n.labelPlacement === 'none')).toBe(true);
  });
});

describe('focus', () => {
  test('worker focus keeps the whole reporting line (up and down)', () => {
    const s = fixture({ focus: { kind: 'worker', id: 'vega' } });
    const m = buildTopology(s, NOW);
    expect(m.workers.map((w) => w.id).sort()).toEqual(['ceo', 'dev', 'vega', 'wren']);
    expect(m.clients).toEqual([]);
    expect(focusLabel(s)).toBe('VEGA');
  });

  test('client focus keeps its projects; project focus keeps its client', () => {
    const c = buildTopology(fixture({ focus: { kind: 'client', id: 'c1' } }), NOW);
    expect(c.nodes.map((n) => n.id).sort()).toEqual(['agency:ag1', 'client:c1', 'project:p1', 'project:p2']);
    const p = buildTopology(fixture({ focus: { kind: 'project', id: 'p2' } }), NOW);
    expect(p.nodes.map((n) => n.id).sort()).toEqual(['agency:ag1', 'client:c1', 'project:p2']);
    expect(p.edges.map((e) => e.id)).toEqual(['del-project:p2']);
  });

  test('unlinked focus keeps only the unassigned bucket', () => {
    const s = fixture({ focus: { kind: 'aggregate', id: 'unlinked' } });
    const m = buildTopology(s, NOW);
    expect(m.projects.map((p) => p.id).sort()).toEqual(['p3', 'p6']);
  });

  test('toggleFocus / isFocusable / focusedIds(null)', () => {
    const a = { kind: 'client', id: 'c1' };
    expect(toggleFocus(null, a)).toBe(a);
    expect(toggleFocus(a, { ...a })).toBeNull();
    expect(isFocusable({ kind: 'agency', id: 'x' })).toBe(false);
    expect(isFocusable({ kind: 'aggregate', id: 'unlinked' })).toBe(true);
    expect(focusedIds(fixture(), buildTopology(fixture(), NOW))).toBeNull();
  });
});

describe('layoutTopology', () => {
  test('portrait stacks: workforce band above delivery band, all nodes inside the width', () => {
    const m = buildTopology(fixture(), NOW);
    const l = layoutTopology(m, { width: 370, height: 500, stacked: true });
    const wf = l.regions.find((r) => r.id === 'workforce');
    const dl = l.regions.find((r) => r.id === 'delivery');
    expect(dl.y).toBeGreaterThan(wf.y + wf.height - 1);
    for (const n of l.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(370);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    expect(l.bounds.width).toBe(370);
    expect(l.bounds.height).toBeGreaterThan(dl.y + dl.height - 1);
    expect(l.regions.find((r) => r.id === 'unassigned')).toBeTruthy();
  });

  test('wide landscape puts the bands side by side; a narrow one stacks', () => {
    const m = buildTopology(fixture(), NOW);
    const wide = layoutTopology(m, { width: SIDE_BY_SIDE_MIN_WIDTH + 100, height: 360, stacked: false });
    const wf = wide.regions.find((r) => r.id === 'workforce');
    const dl = wide.regions.find((r) => r.id === 'delivery');
    expect(dl.x).toBeGreaterThan(wf.x + wf.width);
    expect(dl.y).toBe(wf.y);
    const narrow = layoutTopology(m, { width: SIDE_BY_SIDE_MIN_WIDTH - 60, height: 360, stacked: false });
    const nwf = narrow.regions.find((r) => r.id === 'workforce');
    const ndl = narrow.regions.find((r) => r.id === 'delivery');
    expect(ndl.y).toBeGreaterThan(nwf.y);
  });

  test('org tree columns follow depth, label budgets shrink with room', () => {
    const l = layoutTopology(buildTopology(fixture(), NOW), { width: 390, stacked: true });
    const at = (id) => l.nodes.find((n) => n.id === `worker:${id}`);
    expect(at('vega').x).toBeGreaterThan(at('ceo').x);
    expect(at('dev').x).toBeGreaterThan(at('vega').x);
    expect(at('ceo').labelMax).toBeGreaterThanOrEqual(4);
  });

  test('many projects for one client wrap under it instead of overflowing', () => {
    const projects = Array.from({ length: 9 }, (_, i) => project(`w${i}`, 'c1'));
    const l = layoutTopology(buildTopology(fixture({ projects }), NOW), { width: 370, stacked: true });
    const tiles = l.nodes.filter((n) => n.kind === 'project');
    expect(tiles).toHaveLength(9);
    expect(tiles.every((n) => n.wrapped)).toBe(true);
    expect(new Set(tiles.map((n) => n.y)).size).toBeGreaterThan(1);
    for (const n of tiles) expect(n.x).toBeLessThan(370);
    const anchor = l.nodes.find((n) => n.id === 'client:c1');
    expect(tiles.every((n) => n.y > anchor.y)).toBe(true);
  });

  test('a huge unassigned bucket collapses into its anchor', () => {
    const projects = Array.from({ length: MAX_UNLINKED_TILES + 5 }, (_, i) => project(`u${i}`, null));
    const l = layoutTopology(buildTopology(fixture({ projects }), NOW), { width: 370, stacked: true });
    expect(l.nodes.some((n) => n.kind === 'project')).toBe(false);
    expect(l.nodes.find((n) => n.id === 'aggregate:unlinked').sublabel).toMatch(/tap to focus/);
    expect(l.edges.some((e) => e.kind === 'delivers')).toBe(false);
  });

  test('every laid edge has a path and only joins placed nodes', () => {
    const l = layoutTopology(buildTopology(fixture(), NOW), { width: 390, stacked: true });
    const placed = new Set(l.nodes.map((n) => n.id));
    for (const e of l.edges) {
      expect(e.d).toMatch(/^M/);
      expect(placed.has(e.source) && placed.has(e.target)).toBe(true);
    }
  });
});

describe('paths + shapes', () => {
  test('edge paths', () => {
    const a = { x: 10, y: 10, size: 5 };
    const b = { x: 50, y: 40, size: 5 };
    expect(edgePath({ kind: 'reports' }, a, { x: 50, y: 10 })).toBe('M10 10H50');
    expect(edgePath({ kind: 'reports' }, a, b)).toBe('M10 15V40H50');
    expect(edgePath({ kind: 'delivers' }, a, b)).toBe('M10 10V40H50');
    expect(edgePath({ kind: 'root' }, { x: 100, y: 20, size: 20 }, b, { busX: 6 })).toBe('M80 20H6V40H50');
    expect(edgePath({ kind: 'assigned' }, a, b)).toMatch(/^M10 10Q/);
    expect(edgePath({ kind: 'reports' }, a, null)).toBe('');
  });

  test('shape paths', () => {
    expect(shapePath('circle', 0, 0, 5)).toBeNull();
    expect(shapePath('diamond', 0, 0, 5)).toBe('M0 -5L5 0L0 5L-5 0Z');
    expect(shapePath('hexagon', 0, 0, 10)).toMatch(/^M.*Z$/);
    expect(shapePath('pill', 0, 0, 10)).toMatch(/Q/);
  });
});

describe('camera', () => {
  const bounds = { minX: 0, minY: 0, width: 400, height: 1200 };

  test('fit shows everything centred', () => {
    const c = fitCamera(bounds, 400, 600, 0);
    expect(c.k).toBeCloseTo(0.5);
    expect(c.x).toBeCloseTo(100);
    expect(c.y).toBeCloseTo(0);
  });

  test('initial: fit when readable, else fit width from the top', () => {
    const tall = initialCamera(bounds, 400, 300);
    expect(tall.k).toBeCloseTo((400 - 8) / 400);
    expect(tall.y).toBe(4);
    const small = initialCamera({ minX: 0, minY: 0, width: 300, height: 300 }, 400, 400);
    expect(small.k).toBeGreaterThanOrEqual(0.8);
  });

  test('zoomAt keeps the focal point fixed and clamps', () => {
    const c = { k: 1, x: 0, y: 0 };
    const z = zoomAt(c, 100, 100, 2);
    expect(z.k).toBe(2);
    expect((100 - z.x) / z.k).toBeCloseTo(100);
    expect(zoomAt(c, 0, 0, 100).k).toBe(clampZoom(100));
    expect(zoomAt(c, 0, 0, 0.0001).k).toBe(clampZoom(0));
  });

  test('commitGesture folds a translate + scale about the centre', () => {
    const c = { k: 1, x: 10, y: 20 };
    expect(commitGesture(c, 200, 200, 5, -5, 1)).toEqual({ k: 1, x: 15, y: 15 });
    const s = commitGesture(c, 200, 200, 0, 0, 2);
    expect(s.k).toBe(2);
    expect(s.x).toBe(100 + 2 * (10 - 100));
  });
});

describe('hitTest', () => {
  const nodes = [
    { id: 'client:a', name: 'Alpha', x: 50, y: 50, size: 8, shape: 'circle', labelPlacement: 'right', labelMax: 20, showSub: true },
    { id: 'project:b', name: 'Beta', x: 200, y: 50, size: 10, shape: 'roundedRect', labelPlacement: 'below', labelMax: 10 },
  ];
  const cam = { k: 1, x: 0, y: 0 };

  test('shape, label and miss', () => {
    expect(hitTest(nodes, cam, 52, 52).id).toBe('client:a');
    expect(hitTest(nodes, cam, 90, 50).id).toBe('client:a'); // on its right-hand label
    expect(hitTest(nodes, cam, 200, 75).id).toBe('project:b'); // on its label below
    expect(hitTest(nodes, cam, 120, 200)).toBeNull();
  });

  test('touch radius grows when zoomed out (>= 22 screen px)', () => {
    const far = { k: 0.25, x: 0, y: 0 };
    // 15 screen px from Alpha (60 world px) — beyond its shape, still a hit at this zoom.
    expect(hitTest(nodes, far, 50 * 0.25 + 15, 50 * 0.25 + 3)?.id).toBe('client:a');
  });
});

describe('search', () => {
  test('matches name, sublabel and description; empty query = null', () => {
    const m = buildTopology(fixture(), NOW);
    expect(searchMatches(m.nodes, '  ')).toBeNull();
    const hits = searchMatches(m.nodes, 'devin');
    expect([...hits]).toEqual(['client:c1']);
    expect(searchMatches(m.nodes, 'dept').size).toBe(5); // worker descriptions
  });
});

describe('detailFor', () => {
  const s = fixture();
  test('agency', () => {
    const d = detailFor(s, { kind: 'agency', id: 'ag1' }, NOW);
    expect(d.rows).toEqual([['Clients', '4'], ['Active', '2'], ['Projects', '6'], ['Workforce', '5']]);
  });
  test('client', () => {
    const d = detailFor(s, { kind: 'client', id: 'c1' }, NOW);
    expect(d).toMatchObject({ title: 'Devin', kind: 'Client', tone: 'success' });
    expect(d.rows.find((r) => r[0] === 'MRR')[1]).toBe('$500');
    expect(d.rows.find((r) => r[0] === 'Billing')[1]).toBe('—');
  });
  test('project', () => {
    const d = detailFor(s, { kind: 'project', id: 'p6' }, NOW);
    expect(d).toMatchObject({ tone: 'danger', status: 'past target date' });
    expect(d.rows.find((r) => r[0] === 'Client')[1]).toBe('Not linked to a client');
  });
  test('worker: manager, reports, meter', () => {
    const d = detailFor(s, { kind: 'worker', id: 'vega' }, NOW);
    expect(d.managerId).toBe('ceo');
    expect(d.reports.map((r) => r.id)).toEqual(['dev', 'wren']);
    expect(d.rows.find((r) => r[0] === 'Manager')[1]).toBe('CEO');
    const q = detailFor(s, { kind: 'worker', id: 'quinn' }, NOW);
    expect(q).toMatchObject({ kind: 'Human worker', tone: 'danger', managerId: null });
    expect(q.rows.find((r) => r[0] === 'Manager')[1]).toBe('Reports to the agency');
  });
  test('aggregates + unknown', () => {
    const u = detailFor(s, { kind: 'aggregate', id: 'unlinked' }, NOW);
    expect(u.rows[0]).toEqual(['Count', '2']);
    expect(u.projects.map((p) => p.id)).toEqual(['p3', 'p6']);
    const h = detailFor(s, { kind: 'aggregate', id: 'clients' }, NOW);
    expect(h.title).toBe('2 clients out of scope');
    expect(h.rows[0][1]).toBe(SCOPE_LABELS.active);
    expect(detailFor(s, { kind: 'client', id: 'nope' }, NOW)).toBeNull();
    expect(detailFor(s, null, NOW)).toBeNull();
  });
});

describe('summary, list, scope note', () => {
  test('summarize', () => {
    const s = fixture();
    const sum = summarize(s, buildTopology(s, NOW), NOW);
    expect(sum.mrrCents).toBe(50000);
    expect(sum.inFlight).toBe(4);
    expect(sum.delivery.context).toContain('1 on hold');
    expect(sum.delivery.context).toContain('1 past target');
    expect(sum.delivery.context).toContain('2 with no client');
    expect(sum.workforce.context).toContain('4 AI / 1 human');
    expect(sum.workforce.context).toContain('2 at or near capacity');
    expect(sum.topClients[0].name).toBe('Done Inc'); // lifetime / 12 beats Devin's MRR
  });

  test('buildList: clients with their projects, unlinked, org tree in depth order', () => {
    const s = fixture();
    const list = buildList(s, buildTopology(s, NOW), NOW);
    expect(list.clients.map((c) => c.client.id)).toEqual(['c1', 'c2']);
    expect(list.clients[0].projects.map((p) => p.project.id)).toEqual(['p1', 'p2']);
    expect(list.unlinked.map((p) => p.project.id)).toEqual(['p3', 'p6']);
    expect(list.workers.map((w) => `${w.worker.id}:${w.depth}`)).toEqual(['ceo:0', 'vega:1', 'dev:2', 'wren:2', 'quinn:0']);
  });

  test('buildList search filters clients and dims workers', () => {
    const s = fixture({ search: 'project p2' });
    const list = buildList(s, buildTopology(s, NOW), NOW);
    expect(list.clients.map((c) => c.client.id)).toEqual(['c1']);
    expect(list.workers.every((w) => w.dim)).toBe(true);
  });

  test('scope note + ids', () => {
    const s = fixture();
    expect(scopeNote(s, buildTopology(s, NOW))).toBe('Showing 2 of 4 clients, 4 of 6 projects, 5 of 5 workers.');
    expect(parseNodeId('client:legacy-client:x')).toEqual({ kind: 'client', id: 'legacy-client:x' });
    expect(parseNodeId('bogus:1')).toBeNull();
    expect(selectionKey({ kind: 'worker', id: 'w' })).toBe('worker:w');
  });
});
