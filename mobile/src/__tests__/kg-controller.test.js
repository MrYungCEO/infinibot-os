/**
 * Native Knowledge Graph controller — the web host's actions on a fake
 * gateway + fake stage: data load, filters, selection / peek / details,
 * long-press menu, deep links, signals, link / move / status / tag / delete,
 * consolidate, sub-project consolidation (dry run → apply → undo), spawn, undo.
 */
import { KgController, cleanPrefs, DEFAULT_PREFS } from '../kg/kg-controller';
import { makeLiveShapedSnapshot } from '../kg/generated/kg-core';

function fakeStage() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  const stage = {
    calls,
    setGraph: rec('setGraph'),
    setLayoutV3: rec('setLayoutV3'),
    setGroups: rec('setGroups'),
    setRings: rec('setRings'),
    setFocus: rec('setFocus'),
    resetView: rec('resetView'),
    fitIds: rec('fitIds'),
    flyToNode: rec('flyToNode'),
    markPositionsDirty: rec('markPositionsDirty'),
    setReducedMotion: rec('setReducedMotion'),
    setQualityMode: rec('setQualityMode'),
    setAmbience: rec('setAmbience'),
    setConnectionsMode: rec('setConnectionsMode'),
    setHullsVisible: rec('setHullsVisible'),
    setInteractionModes: rec('setInteractionModes'),
    screenOf: () => ({ x: 10, y: 10, r: 5 }),
    screenPoints: () => [],
    last(name) {
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i][0] === name) return calls[i];
      return null;
    },
  };
  return stage;
}

const SNAP = {
  generatedAt: 1,
  nodes: [
    { id: 'project:p1', kind: 'project', label: 'Launch site', meta: { health: 'active', projectId: 'p1', tasks: 4, progress: 0.5 } },
    { id: 'project:p2', kind: 'project', label: 'Mobile app', meta: { health: 'blocked', projectId: 'p2' } },
    { id: 'project:s1', kind: 'project', label: 'Launch site landing', meta: { health: 'active', projectId: 's1', parentProjectId: 'p1' } },
    { id: 'project:s2', kind: 'project', label: 'Launch site landing page', meta: { health: 'active', projectId: 's2', parentProjectId: 'p1' } },
    { id: 'project:s3', kind: 'project', label: 'Launch site landing v2', meta: { health: 'active', projectId: 's3', parentProjectId: 'p1' } },
    { id: 'note:n1', kind: 'note', label: 'Kickoff notes', meta: {} },
    { id: 'note:n2', kind: 'note', label: 'Kickoff notes copy', meta: {} },
    { id: 'client:c1', kind: 'client', label: 'Acme', meta: {} },
  ],
  edges: [
    { source: 'project:s1', target: 'project:p1', rel: 'sub-project of' },
    { source: 'project:s2', target: 'project:p1', rel: 'sub-project of' },
    { source: 'project:s3', target: 'project:p1', rel: 'sub-project of' },
    { source: 'note:n1', target: 'project:p1', rel: 'about' },
    { source: 'client:c1', target: 'project:p1', rel: 'client' },
  ],
  typeStats: { project: 5, note: 2, client: 1 },
  kinds: ['project', 'note', 'client', 'agent', 'run', 'report', 'opportunity', 'decision', 'issue', 'product', 'person', 'content'],
};

function setup(responses = {}) {
  const calls = [];
  const request = jest.fn(async (method, params) => {
    calls.push([method, params]);
    const r = responses[method];
    if (typeof r === 'function') return r(params, calls);
    if (r !== undefined) return r;
    if (method === 'graph.global.snapshot') return SNAP;
    if (method === 'objrel.list') return { relations: [] };
    if (method === 'objrel.link') return { id: `rel_${calls.length}` };
    return {};
  });
  const storage = new Map();
  const opened = [];
  const c = new KgController({
    request,
    storage: { getItem: async (k) => storage.get(k) ?? null, setItem: async (k, v) => storage.set(k, v) },
    openNode: (n) => opened.push(n.id),
    now: () => 1_760_000_000_000,
  });
  const stage = fakeStage();
  return { c, request, calls, stage, storage, opened };
}

describe('KgController', () => {
  test('prefs default to the web defaults (brain, all connections) and sanitise junk', () => {
    expect(DEFAULT_PREFS.group).toBe('brain');
    expect(cleanPrefs({ group: 'nope', kinds: ['bogus'], connections: 'x' })).toMatchObject({ group: 'brain', connections: 'all' });
    expect(cleanPrefs({ group: 'cluster', hulls: false }).hulls).toBe(false);
  });

  test('loads graph.global.snapshot with the enabled layers and pushes the scene to the stage', async () => {
    const { c, calls, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    const snap = calls.find(([m]) => m === 'graph.global.snapshot');
    expect(snap[1].types).toEqual(expect.arrayContaining(['project', 'note', 'client']));
    expect(c.nodes.length).toBe(8);
    const g = stage.last('setGraph');
    expect(g[1]).toHaveLength(8);
    expect(g[3]).toEqual({ cx: 0, cy: 0 });
    // brain mode: v3 info with the cortex scale
    expect(stage.last('setLayoutV3')[1]).toMatchObject({ mode: 'brain' });
    expect(stage.last('resetView')).toBeTruthy();
    // nodes sit on their v3 targets (world == layout around the origin)
    const n = c.nodes[0];
    expect([n.x, n.z, n.y]).toEqual(Array.from(c.v3.target.slice(0, 3)));
  });

  test('tap = peek card + fly; Details opens the detail panel; empty tap clears', async () => {
    const { c, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    c.stageCallbacks.onSelect('project:p1');
    expect(c.peekId).toBe('project:p1');
    expect(c.selectedId).toBe('project:p1');
    expect(stage.last('flyToNode')[1]).toBe('project:p1');
    expect(stage.last('setFocus')[1]).toBe('project:p1');
    c.openDetails('project:p1');
    expect(c.detailId).toBe('project:p1');
    expect(c.peekId).toBeNull();
    c.stageCallbacks.onSelect(null);
    expect(c.selection.size).toBe(0);
    expect(c.detailId).toBeNull();
  });

  test('labels and emphasis come from the shared rules (focus + neighbours)', async () => {
    const { c, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    const p1 = c.nodeById.get('project:p1');
    const p2 = c.nodeById.get('project:p2');
    expect(c.stageCallbacks.labelFor(p1, 1)).toMatchObject({ text: 'Launch site' });
    c.stageCallbacks.onSelect('project:p1');
    expect(c.stageCallbacks.emphasisFor(p1)).toBe(1);
    expect(c.stageCallbacks.emphasisFor(p2)).toBe(0.07);
    expect(c.stageCallbacks.labelFor(p2, 1)).toBeNull();
  });

  test('long-press opens the menu on that node (selecting it)', async () => {
    const { c, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    c.stageCallbacks.onContextMenu('note:n1', 40, 50);
    expect(c.menu).toEqual({ x: 40, y: 50, nodeId: 'note:n1' });
    expect([...c.selection]).toEqual(['note:n1']);
    expect(c.actionIds('note:n1')).toEqual(['note:n1']);
    // empty space with nothing selected: no menu
    c.clearSelection();
    c.menu = null;
    c.stageCallbacks.onContextMenu(null, 1, 1);
    expect(c.menu).toBeNull();
  });

  test('filters: layer + status chips rebuild client-side; a new layer refetches', async () => {
    const { c, calls, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    c.toggleHealth('blocked');
    expect(c.nodeById.has('project:p2')).toBe(false);
    c.toggleKind('note');
    expect(c.nodeById.has('note:n1')).toBe(false);
    const before = calls.filter(([m]) => m === 'graph.global.snapshot').length;
    c.toggleKind('task'); // not collected by the last snapshot → fetch
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter(([m]) => m === 'graph.global.snapshot').length).toBe(before + 1);
  });

  test('group mode switch re-lays out and re-frames', async () => {
    const { c, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    const resets = stage.calls.filter(([m]) => m === 'resetView').length;
    c.setGroupMode('cluster');
    expect(c.groupMode).toBe('cluster');
    expect(stage.last('setLayoutV3')[1]).toMatchObject({ mode: 'cluster' });
    expect(stage.calls.filter(([m]) => m === 'resetView').length).toBe(resets + 1);
    expect(c.hudTab).toBe('groups');
  });

  test('deep link before data: focus applies once the graph is laid out', async () => {
    const { c, stage } = setup();
    c.applyDeepLink({ focus: 'p2', family: true }, false);
    expect(c.pendingDeepFocus).toEqual({ id: 'p2', family: true });
    c.attachStage(stage);
    c.pendingDeepFocus = { id: 'project:p2', family: true };
    await c.refresh();
    expect(c.selectedId).toBe('project:p2');
    expect(c.peekId).toBe('project:p2');
    expect(stage.last('flyToNode')[1]).toBe('project:p2');
  });

  test('deep link layer turns the layer on and frames it', async () => {
    const { c, stage } = setup();
    c.attachStage(stage);
    c.applyDeepLink({ layer: 'client' }, false);
    await c.refresh();
    expect(stage.last('fitIds')[1]).toEqual(['client:c1']);
  });

  test('signals include the sub-project duplicate cluster; Consolidate opens the dry run', async () => {
    const { c, stage } = setup({
      'kanban.projects.list': { projects: [{ id: 's1', status: 'active' }, { id: 's2', status: 'active' }, { id: 's3', status: 'active' }] },
      'kanban.tasks.list': [],
      'kanban.projects.content.getMarkdown': { markdown: '' },
    });
    c.attachStage(stage);
    await c.refresh();
    const sub = c.hudInsights.find((i) => i.kind === 'sub-duplicates');
    expect(sub).toBeTruthy();
    await c.insightAction(sub, 'subs');
    await new Promise((r) => setTimeout(r, 10));
    expect(c.dialog.type).toBe('subs');
    expect(c.dialog.plan.steps.length).toBeGreaterThan(0);
    expect(c.dialog.plan.deletes).toBe(0);
  });

  test('link mode by taps links the two nodes (objrel.link) and offers undo', async () => {
    const { c, calls, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    c.setModes(true, false);
    c.stageCallbacks.onSelect('note:n2');
    expect(c.linkTapFrom).toBe('note:n2');
    c.stageCallbacks.onSelect('project:p2');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const link = calls.find(([m]) => m === 'objrel.link');
    expect(link).toBeTruthy();
    expect(c.canUndo).toBe(true);
    expect(c.toast.text).toMatch(/Linked/);
    await c.undoLast();
    expect(calls.some(([m]) => m === 'objrel.unlink')).toBe(true);
  });

  test('bulk status / tag / delete run the shared plans', async () => {
    const { c, calls, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    await c.bulkStatus(['project:p2'], 'done');
    expect(calls.some(([m]) => m === 'kanban.projects.update')).toBe(true);
    await c.bulkTag(['note:n1'], 'launch');
    expect(calls.some(([m]) => /notes\./.test(m))).toBe(true);
    c.openDelete(['note:n2']);
    expect(c.dialog.type).toBe('delete');
    await c.confirmDelete(c.dialog.plan);
    expect(calls.some(([m]) => /notes\.delete/.test(m))).toBe(true);
  });

  test('drag a note onto a project arms after a hold, then moves (reassign)', async () => {
    jest.useFakeTimers();
    try {
      const { c, stage } = setup();
      c.attachStage(stage);
      await c.refresh();
      const n2 = c.nodeById.get('note:n2');
      const p2 = c.nodeById.get('project:p2');
      c.stageCallbacks.onDragStart(n2.index);
      c.stageCallbacks.onDragOver(n2.index, p2.index);
      expect(c.dropTarget).toMatchObject({ id: 'project:p2', ok: true, armed: false });
      jest.advanceTimersByTime(400);
      expect(c.dropTarget.armed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('spawn agent sends sessions.spawn with the selection context', async () => {
    const { c, calls, stage } = setup({ 'sessions.spawn': { runId: 'run_123' } });
    c.attachStage(stage);
    await c.refresh();
    c.openSpawn(['project:p1']);
    expect(c.dialog.goal).toMatch(/Review the project "Launch site"/);
    await c.confirmSpawn(c.dialog);
    const spawn = calls.find(([m]) => m === 'sessions.spawn');
    expect(spawn[1].task).toMatch(/Launch site/);
    expect(c.toast.text).toMatch(/Agent started/);
  });

  test('AI drawer request carries the selection context; Open goes to the native screen', async () => {
    const { c, stage, opened } = setup();
    c.attachStage(stage);
    await c.refresh();
    c.openAi('summarize', ['project:p1', 'note:n1']);
    expect(c.ai).toMatchObject({ intent: 'summarize', count: 2, title: '2 items' });
    expect(c.ai.context).toMatch(/Launch site/);
    c.stageCallbacks.onOpen('note:n1');
    expect(opened).toEqual(['note:n1']);
  });

  test('back closes the topmost layer first', async () => {
    const { c, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    c.stageCallbacks.onSelect('project:p1');
    c.openRelated(['project:p1']);
    expect(c.closeTopmost()).toBe(true);
    expect(c.dialog).toBeNull();
    expect(c.closeTopmost()).toBe(true);
    expect(c.peekId).toBeNull();
    expect(c.closeTopmost()).toBe(false);
  });

  test('scales to the live-shaped graph (500+ nodes) in brain mode', async () => {
    const snap = makeLiveShapedSnapshot(false, 7);
    const { c, stage } = setup({ 'graph.global.snapshot': snap });
    c.attachStage(stage);
    const t0 = Date.now();
    await c.refresh();
    expect(c.nodes.length).toBeGreaterThan(400);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.hudInsights.length).toBeGreaterThan(0);
  });
});

describe('KgController polling', () => {
  test('an unchanged snapshot skips the layout pass; a changed one rebuilds', async () => {
    const { c, stage } = setup();
    c.attachStage(stage);
    await c.refresh();
    const graphs = () => stage.calls.filter(([m]) => m === 'setGraph').length;
    const n = graphs();
    await c.refresh();
    expect(graphs()).toBe(n);
    SNAP.nodes[0].meta.progress = 0.75;
    try {
      await c.refresh();
      expect(graphs()).toBe(n + 1);
      expect(c.nodeById.get('project:p1').meta.progress).toBe(0.75);
    } finally {
      SNAP.nodes[0].meta.progress = 0.5;
    }
  });
});
