/**
 * Project-scoped native graph: the KanbanScreen "Knowledge Graph" button opens
 * the graph with { project } → graph.global.snapshot({ projectId, hops }),
 * scope bar model, depth change, "Show all" restores the user's layers.
 */
import { KgController, scopeInfoOf } from '../kg/kg-controller';
import { projectScopeOf, deepLinkSig } from '../kg/kg-deep-link';

const SCOPED = {
  generatedAt: 1,
  nodes: [
    { id: 'project:p1', kind: 'project', label: 'FlyPic', meta: { projectId: 'p1', health: 'done', scopeRoot: true } },
    { id: 'task:t1', kind: 'task', label: 'Ship it', meta: { projectId: 'p1' } },
    { id: 'note:n1', kind: 'note', label: 'Spec', meta: {} },
  ],
  edges: [
    { source: 'project:p1', target: 'task:t1', rel: 'contains' },
    { source: 'note:n1', target: 'project:p1', rel: 'mentions' },
  ],
  typeStats: { project: 1, task: 1, note: 1 },
  kinds: ['project', 'task', 'note'],
  scope: { projectId: 'p1', projectNodeId: 'project:p1', label: 'FlyPic', found: true, hops: 2, totalNodes: 840, totalEdges: 900, hubs: [], capped: 0, secureExcluded: 0 },
};
const FULL = { ...SCOPED, scope: undefined, nodes: [...SCOPED.nodes, { id: 'project:p2', kind: 'project', label: 'Other', meta: { projectId: 'p2' } }] };

function setup() {
  const calls = [];
  const request = jest.fn(async (method, params) => {
    calls.push([method, params]);
    if (method === 'graph.global.snapshot') return params.projectId ? SCOPED : FULL;
    if (method === 'objrel.list') return { relations: [] };
    return {};
  });
  const c = new KgController({ request, storage: { getItem: async () => null, setItem: async () => {} }, now: () => 1 });
  return { c, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('project-scoped knowledge graph (native)', () => {
  test('route params → scope', () => {
    expect(projectScopeOf({ project: 'project:p1', projectName: 'FlyPic' })).toEqual({ id: 'p1', name: 'FlyPic', hops: 2 });
    expect(projectScopeOf({ focus: 'x' })).toBeNull();
    expect(deepLinkSig({ project: 'a' })).not.toBe(deepLinkSig({ project: 'b' }));
  });

  test('scoped request, scope bar model, depth, show all', async () => {
    const { c, calls } = setup();
    const userKinds = [...c.enabledKinds];
    c.setProjectScope({ id: 'p1', name: 'FlyPic' });
    await flush();
    const req = calls.filter(([m]) => m === 'graph.global.snapshot').pop()[1];
    expect(req).toMatchObject({ projectId: 'p1', hops: 2 });
    expect(req.types).toEqual(expect.arrayContaining(['task', 'run', 'file']));
    // every status shows (the root project is "done" but still visible)
    expect(c.nodes.map((n) => n.id)).toContain('project:p1');
    const m = c.scopeModel();
    expect(m).toMatchObject({ id: 'p1', name: 'FlyPic', hops: 2, countText: '3 of 840 nodes', sparse: false });
    expect(c.pendingDeepFocus).toEqual({ id: 'project:p1', family: false });
    expect(c.groupMode).not.toBe('brain');
    // consolidation lookups are skipped while scoped
    expect(calls.some(([meth]) => meth === 'objrel.list')).toBe(false);

    c.setScopeHops(3);
    await flush();
    expect(calls.filter(([meth]) => meth === 'graph.global.snapshot').pop()[1]).toMatchObject({ projectId: 'p1', hops: 3 });

    c.clearProjectScope();
    await flush();
    const last = calls.filter(([meth]) => meth === 'graph.global.snapshot').pop()[1];
    expect(last.projectId).toBeUndefined();
    expect(c.scopeModel()).toBeNull();
    expect([...c.enabledKinds].sort()).toEqual(userKinds.sort());
  });

  test('scopeInfoOf ignores unscoped payloads', () => {
    expect(scopeInfoOf({ nodes: [] })).toBeNull();
    expect(scopeInfoOf(SCOPED).projectNodeId).toBe('project:p1');
  });
});
