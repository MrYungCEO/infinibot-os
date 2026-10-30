import {
  PANEL_CATALOG,
  PANEL_TYPES,
  VIEW_KINDS,
  AGENCY_SECTIONS,
  MAX_CANVASES,
  catalogEntryFor,
  filterCatalog,
  groupCatalog,
  stripEmoji,
  emptyState,
  sanitizeState,
  migrateLegacy,
  activeCanvas,
  addPanel,
  removePanel,
  patchPanel,
  focusPanel,
  movePanel,
  resizeStackPanel,
  clearCanvas,
  setMode,
  switchToCanvasSlot,
  tileCanvas,
  toggleMaximize,
  canvasTabs,
  defaultStackHeight,
  STACK_MIN_H,
  STACK_MAX_H,
} from '../screens/grid/grid-model';

const entry = (id) => PANEL_CATALOG.find((e) => e.id === id);

describe('catalogue (web getPanelCatalog parity)', () => {
  test('every web PanelType is reachable from the picker', () => {
    const types = new Set(PANEL_CATALOG.map((e) => e.type));
    for (const t of PANEL_TYPES) expect(types.has(t)).toBe(true);
  });

  test('web view adapters and agency ops tabs are all present', () => {
    for (const k of ['notes', 'research', 'clients', 'funnels', 'autonomy', 'agentActivity', 'reports', 'business']) {
      expect(entry(`view:${k}`)).toBeTruthy();
      expect(VIEW_KINDS[k].open).toBeTruthy();
    }
    for (const s of ['overview', 'allocation', 'approvals', 'activity', 'employees']) {
      expect(entry(`agencyOps:${s}`)).toMatchObject({ type: 'agencyOps', agencyOpsSection: s, plugin: 'business-agency' });
      expect(AGENCY_SECTIONS[s]).toBeTruthy();
    }
  });

  test('no emoji anywhere in the catalogue (Ionicons only)', () => {
    for (const e of PANEL_CATALOG) {
      expect(stripEmoji(e.title)).toBe(e.title);
      expect(stripEmoji(e.description)).toBe(e.description);
      expect(e.icon).toMatch(/^[a-z-]+$/);
    }
  });

  test('search + category filter, grouped in chip order', () => {
    expect(filterCatalog(PANEL_CATALOG, 'codex', '').map((e) => e.type)).toEqual(['terminal']);
    const media = filterCatalog(PANEL_CATALOG, '', 'Media');
    expect(media.every((e) => e.category === 'Media')).toBe(true);
    const groups = groupCatalog(filterCatalog(PANEL_CATALOG, '', ''));
    expect(groups.map((g) => g.cat)).toEqual(['Ops', 'Agents', 'Data', 'Media', 'Voice', 'Work']);
    expect(filterCatalog(PANEL_CATALOG, 'zzzz-nothing', '')).toEqual([]);
  });

  test('catalogEntryFor resolves adapters by viewKind / section', () => {
    expect(catalogEntryFor({ type: 'view', viewKind: 'reports' }).title).toBe('Reports');
    expect(catalogEntryFor({ type: 'agencyOps', agencyOpsSection: 'employees' }).title).toBe('Employees');
    expect(catalogEntryFor({ type: 'gpu' }).icon).toBe('hardware-chip-outline');
  });
});

describe('stripEmoji', () => {
  test('removes pictographs and leftover spacing', () => {
    expect(stripEmoji('💬 Chat')).toBe('Chat');
    expect(stripEmoji('🗂️ Kanban')).toBe('Kanban');
    expect(stripEmoji('▶ Terminal')).toBe('Terminal');
    expect(stripEmoji('Plain title')).toBe('Plain title');
    expect(stripEmoji(null)).toBe('');
  });
});

describe('layout state', () => {
  test('emptyState is a stack layout with one Main canvas', () => {
    const s = emptyState();
    expect(s.mode).toBe('stack');
    expect(s.canvases).toHaveLength(1);
    expect(activeCanvas(s).name).toBe('Main');
  });

  test('addPanel cascades, raises z, and gives chat panels a grid-session key', () => {
    let s = emptyState();
    const a = addPanel(s, entry('native:session'), { now: 1000 });
    s = a.state;
    expect(a.panel.sessionKey).toBe('grid-session-1000');
    const b = addPanel(s, entry('native:kanban'), { now: 2000 });
    s = b.state;
    expect(b.panel.x).toBeGreaterThan(a.panel.x);
    expect(b.panel.zIndex).toBeGreaterThan(a.panel.zIndex);
    expect(b.panel.kanbanProjectId).toBeNull();
    expect(activeCanvas(s).panels.map((p) => p.type)).toEqual(['session', 'kanban']);
    expect(activeCanvas(s).activePanel).toBe(b.panel.id);
  });

  test('view / agency adapters carry their kind', () => {
    const { panel } = addPanel(emptyState(), entry('agencyOps:approvals'));
    expect(panel).toMatchObject({ type: 'agencyOps', agencyOpsSection: 'approvals' });
    const v = addPanel(emptyState(), entry('view:notes')).panel;
    expect(v).toMatchObject({ type: 'view', viewKind: 'notes' });
  });

  test('patch / focus / move / remove', () => {
    let s = emptyState();
    const ids = [];
    for (const id of ['native:session', 'native:activity', 'native:credits']) {
      const r = addPanel(s, entry(id));
      s = r.state;
      ids.push(r.panel.id);
    }
    s = patchPanel(s, ids[0], { kanbanProjectId: 'p1', title: 'Renamed' });
    expect(activeCanvas(s).panels[0].title).toBe('Renamed');
    s = focusPanel(s, ids[0]);
    const c = activeCanvas(s);
    expect(c.panels[0].zIndex).toBe(c.maxZIndex);
    expect(c.activePanel).toBe(ids[0]);
    s = movePanel(s, ids[2], -1);
    expect(activeCanvas(s).panels.map((p) => p.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(movePanel(s, ids[0], -1)).toBe(s);
    s = removePanel(s, ids[0]);
    expect(activeCanvas(s).panels).toHaveLength(2);
    expect(activeCanvas(s).activePanel).toBeNull();
    s = clearCanvas(s);
    expect(activeCanvas(s).panels).toHaveLength(0);
  });

  test('stack heights clamp', () => {
    let s = emptyState();
    const r = addPanel(s, entry('native:gpu'));
    s = resizeStackPanel(r.state, r.panel.id, -5000);
    expect(activeCanvas(s).panels[0].stackHeight).toBe(STACK_MIN_H);
    s = resizeStackPanel(s, r.panel.id, 99999);
    expect(activeCanvas(s).panels[0].stackHeight).toBe(STACK_MAX_H);
    expect(defaultStackHeight('session')).toBeGreaterThan(defaultStackHeight('voice'));
  });

  test('workspace slots create canvases up to MAX_CANVASES', () => {
    let s = switchToCanvasSlot(emptyState(), 2);
    expect(s.canvases.map((c) => c.name)).toEqual(['Main', 'Work', 'Research']);
    expect(s.activeCanvasId).toBe('canvas-2');
    expect(switchToCanvasSlot(s, MAX_CANVASES)).toBe(s);
    expect(canvasTabs(s).map((t) => t.key)).toEqual(['canvas-0', 'canvas-1', 'canvas-2', '__add__']);
    s = switchToCanvasSlot(s, 4);
    expect(canvasTabs(s).some((t) => t.key === '__add__')).toBe(false);
  });

  test('tile fills the viewport in a near-square grid', () => {
    let s = emptyState();
    for (let i = 0; i < 4; i++) s = addPanel(s, entry('native:activity')).state;
    s = tileCanvas(s, 800, 600);
    const ps = activeCanvas(s).panels;
    expect(new Set(ps.map((p) => p.x)).size).toBe(2);
    expect(new Set(ps.map((p) => p.y)).size).toBe(2);
    expect(ps[1].x).toBeGreaterThan(ps[0].x);
  });

  test('maximize toggles and restores geometry', () => {
    const r = addPanel(emptyState(), entry('native:credits'));
    const before = r.panel;
    let s = toggleMaximize(r.state, before.id, { tx: 0, ty: 0, scale: 1, w: 390, h: 700 });
    const max = activeCanvas(s).panels[0];
    expect(max.width).toBe(374);
    expect(max.preMax).toMatchObject({ x: before.x, width: before.width });
    s = toggleMaximize(s, before.id, { tx: 0, ty: 0, scale: 1, w: 390, h: 700 });
    expect(activeCanvas(s).panels[0]).toMatchObject({ x: before.x, width: before.width, preMax: null });
  });

  test('setMode only accepts stack / canvas', () => {
    expect(setMode(emptyState(), 'canvas').mode).toBe('canvas');
    expect(setMode(emptyState(), 'weird').mode).toBe('stack');
  });
});

describe('sanitize + migrate', () => {
  test('junk → empty state', () => {
    expect(sanitizeState(null)).toEqual(emptyState());
    expect(sanitizeState({ canvases: 'x' }).canvases).toHaveLength(1);
  });

  test('accepts a web MasonryGridState (emoji titles stripped, unknown types dropped)', () => {
    const web = {
      activeCanvasId: 'canvas-1',
      canvases: [
        { id: 'canvas-0', name: 'Main', panels: [{ id: 'a', type: 'session', sessionKey: 'grid-session-1', title: '💬 Chat', x: 10, y: 10, width: 480, height: 500, zIndex: 3 }] },
        { id: 'canvas-1', name: 'Work', panels: [{ id: 'b', type: 'bogus' }, { id: 'c', type: 'kanban', title: '🗂️ Kanban', width: 10, height: 10 }] },
      ],
    };
    const s = sanitizeState(web);
    expect(s.activeCanvasId).toBe('canvas-1');
    expect(s.canvases[0].panels[0].title).toBe('Chat');
    expect(s.canvases[0].maxZIndex).toBe(3);
    expect(s.canvases[1].panels.map((p) => p.id)).toEqual(['c']);
    expect(s.canvases[1].panels[0].width).toBe(200);
    expect(s.canvases[1].panels[0].height).toBe(150);
  });

  test('legacy single-canvas web format (panels at the root) is wrapped', () => {
    const s = sanitizeState({ panels: [{ id: 'x', type: 'credits', title: 'Credits' }] });
    expect(s.canvases[0].panels[0].type).toBe('credits');
  });

  test('a view panel with an unknown viewKind is dropped', () => {
    const s = sanitizeState({ canvases: [{ panels: [{ id: 'v', type: 'view', viewKind: 'nope' }] }] });
    expect(s.canvases[0].panels).toHaveLength(0);
  });

  test('the first mobile WebView grid layout migrates to native panels', () => {
    const v1 = {
      panels: [
        { id: 'p1', type: 'session', title: 'Chat', path: '/webchat', x: 24, y: 24, w: 320, h: 380, z: 2 },
        { id: 'p2', type: 'notes', title: 'Notes', path: '/notes', x: 50, y: 50, w: 320, h: 380, z: 3 },
        { id: 'p3', type: 'agencyDaily', x: 0, y: 0, w: 300, h: 300, z: 4 },
        { id: 'p4', type: 'mystery' },
      ],
      tf: { tx: 5, ty: 6, scale: 0.8 },
    };
    const s = migrateLegacy(v1, 5000);
    const ps = s.canvases[0].panels;
    expect(s.mode).toBe('canvas');
    expect(s.view).toEqual({ tx: 5, ty: 6, scale: 0.8 });
    expect(ps.map((p) => p.type)).toEqual(['session', 'view', 'view']);
    expect(ps[0].sessionKey).toMatch(/^grid-session-/);
    expect(ps[1].viewKind).toBe('notes');
    expect(ps[2].viewKind).toBe('agencyDaily');
    expect(ps.every((p) => !p.path)).toBe(true);
    expect(migrateLegacy(null)).toBeNull();
  });
});
