/**
 * Native Whiteboard — scene model (normalise, edit ops, history, templates, boards).
 */
import {
  slugifyBoardName,
  isValidBoardId,
  boardDisplayName,
  newElementId,
  normalizeElements,
  sceneFromBoardData,
  boardDataFromScene,
  sceneSignature,
  shouldAutosave,
  createElement,
  withPointExtents,
  boxFromDrag,
  setText,
  expandToGroups,
  moveElements,
  resizeElement,
  deleteElements,
  duplicateElements,
  updateStyle,
  reorder,
  containerLabel,
  setContainerLabel,
  eraseAt,
  createHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
  HISTORY_LIMIT,
  BUILTIN_TEMPLATES,
  groupTemplates,
  templateElements,
  mergeTemplates,
  normalizeBoards,
  relativeTime,
  uniqueBoardId,
  architectSpawnParams,
  architectReply,
  sceneSummary,
  TOOLS,
  STROKE_PALETTE,
} from '../screens/whiteboard/whiteboard-model';
import { hitTest, elementBounds } from '../screens/whiteboard/whiteboard-geometry';

const R = (id, o = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1, groupIds: [], ...o });

describe('ids and slugs', () => {
  test('slug matches the web controller rule', () => {
    expect(slugifyBoardName('My Drawing')).toBe('my-drawing');
    expect(slugifyBoardName('  Q3 Plan: v2!  ')).toBe('q3-plan-v2');
    expect(slugifyBoardName('---x')).toBe('x');
    expect(slugifyBoardName('')).toBe('');
  });
  test('id validity mirrors the backend ID_RE', () => {
    expect(isValidBoardId('my-drawing')).toBe(true);
    expect(isValidBoardId('-bad')).toBe(false);
    expect(isValidBoardId('Bad')).toBe(false);
    expect(isValidBoardId('a'.repeat(81))).toBe(false);
  });
  test('display name', () => {
    expect(boardDisplayName('my-drawing')).toBe('My drawing');
  });
  test('element ids are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newElementId()));
    expect(ids.size).toBe(200);
  });
});

describe('normalise / board data', () => {
  test('fills runtime defaults, drops deleted + junk, keeps unknown fields', () => {
    const out = normalizeElements([
      { type: 'line', x: 1, y: 2, width: 10, height: 20, custom: 'keep' },
      { type: 'rectangle', isDeleted: true },
      null,
      { nope: 1 },
      { type: 'arrow', id: 'a', x: 0, y: 0, width: 0, height: 60 },
      { type: 'rectangle', id: 'l', x: 0, y: 0, width: 10, height: 10, label: { text: 'Hi' } },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].points).toEqual([[0, 0], [10, 20]]);
    expect(out[0].custom).toBe('keep');
    expect(out[0].groupIds).toEqual([]);
    expect(out[0].id).toBeTruthy();
    expect(out[1].endArrowhead).toBe('arrow');
    expect(out[2].text).toBe('Hi');
  });
  test('board data shape matches the web save (light paper, files kept)', () => {
    const data = boardDataFromScene([R('a'), R('b', { isDeleted: true })], { files: { f: 1 } });
    expect(data.type).toBe('excalidraw');
    expect(data.version).toBe(2);
    expect(data.elements.map((e) => e.id)).toEqual(['a']);
    expect(data.appState.viewBackgroundColor).toBe('#ffffff');
    expect(data.files).toEqual({ f: 1 });
    expect(sceneFromBoardData(data)).toHaveLength(1);
    expect(sceneFromBoardData(null)).toEqual([]);
  });
  test('signature changes with version/position', () => {
    const a = [R('a')];
    expect(sceneSignature(a)).toBe(sceneSignature([R('a')]));
    expect(sceneSignature(a)).not.toBe(sceneSignature([R('a', { x: 5 })]));
  });
  test('autosave guard (never blank a loaded board unless cleared)', () => {
    expect(shouldAutosave({ boardId: null, elementCount: 3, loadedCount: 0 })).toBe(false);
    expect(shouldAutosave({ boardId: 'b', elementCount: 0, loadedCount: 4 })).toBe(false);
    expect(shouldAutosave({ boardId: 'b', elementCount: 0, loadedCount: 4, explicitClear: true })).toBe(true);
    expect(shouldAutosave({ boardId: 'b', elementCount: 2, loadedCount: 4 })).toBe(true);
  });
});

describe('element factory', () => {
  test('shapes carry Excalidraw runtime fields and the active style', () => {
    const el = createElement('rectangle', 5, 6, { strokeColor: STROKE_PALETTE[1] });
    expect(el).toMatchObject({ type: 'rectangle', x: 5, y: 6, strokeColor: STROKE_PALETTE[1], isDeleted: false, roundness: { type: 3 } });
    expect(typeof el.seed).toBe('number');
  });
  test('arrow / freedraw / text specifics', () => {
    expect(createElement('arrow', 0, 0).endArrowhead).toBe('arrow');
    expect(createElement('line', 0, 0).endArrowhead).toBeNull();
    expect(createElement('freedraw', 0, 0).simulatePressure).toBe(true);
    const t = setText(createElement('text', 0, 0, { fontSize: 28 }), 'Hello\nWorld');
    expect(t.fontSize).toBe(28);
    expect(t.originalText).toBe('Hello\nWorld');
    expect(t.height).toBeCloseTo(28 * 1.25 * 2);
    expect(t.version).toBe(2);
  });
  test('point extents + drag box', () => {
    const l = withPointExtents({ type: 'line', points: [[0, 0], [-30, 40]] });
    expect(l.width).toBe(30);
    expect(l.height).toBe(40);
    expect(boxFromDrag(50, 50, 10, 80)).toEqual({ x: 10, y: 50, width: 40, height: 30 });
  });
});

describe('scene operations', () => {
  test('groups expand to every member', () => {
    const els = [R('a', { groupIds: ['g'] }), R('b', { groupIds: ['g'] }), R('c')];
    expect(expandToGroups(els, ['a']).sort()).toEqual(['a', 'b']);
    expect(expandToGroups(els, ['c'])).toEqual(['c']);
  });
  test('move drags bound text and bound arrow ends', () => {
    const els = [
      R('a'),
      { id: 't', type: 'text', x: 10, y: 10, width: 20, height: 20, text: 'x', containerId: 'a' },
      { id: 'ar', type: 'arrow', x: 100, y: 25, points: [[0, 0], [100, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'z' } },
      R('z', { x: 200 }),
    ];
    const out = moveElements(els, ['a'], 10, 5);
    expect(out.find((e) => e.id === 'a')).toMatchObject({ x: 10, y: 5, version: 2 });
    expect(out.find((e) => e.id === 't')).toMatchObject({ x: 20, y: 15 });
    const ar = out.find((e) => e.id === 'ar');
    expect([ar.x, ar.y]).toEqual([110, 30]);
    // end point stays where it was in scene space
    expect(ar.x + ar.points[1][0]).toBe(200);
    expect(ar.y + ar.points[1][1]).toBe(25);
    expect(moveElements(els, ['a'], 0, 0)).toBe(els);
  });
  test('move end-bound arrow moves only the tip', () => {
    const els = [R('z'), { id: 'ar', type: 'arrow', x: 0, y: 0, points: [[0, 0], [50, 0]], endBinding: { elementId: 'z' } }];
    const ar = moveElements(els, ['z'], 10, 10).find((e) => e.id === 'ar');
    expect(ar.x).toBe(0);
    expect(ar.points[1]).toEqual([60, 10]);
  });
  test('resize: shapes, text scales font, linear scales points', () => {
    expect(resizeElement(R('a'), 'se', 200, 100)).toMatchObject({ x: 0, y: 0, width: 200, height: 100 });
    const t = setText(createElement('text', 0, 0, { fontSize: 20 }), 'abc');
    const big = resizeElement(t, 'se', t.width * 2, t.height * 2);
    expect(big.fontSize).toBeCloseTo(40, 0);
    const l = { id: 'l', type: 'line', x: 10, y: 10, points: [[0, 0], [100, 50]], width: 100, height: 50 };
    const r = resizeElement(l, 'se', 210, 110);
    expect(elementBounds(r)).toEqual({ minX: 10, minY: 10, maxX: 210, maxY: 110 });
  });
  test('delete removes bound text and unbinds arrows', () => {
    const els = [
      R('a', { boundElements: [{ id: 't', type: 'text' }] }),
      { id: 't', type: 'text', x: 0, y: 0, text: 'x', containerId: 'a' },
      { id: 'ar', type: 'arrow', x: 0, y: 0, points: [[0, 0], [1, 1]], startBinding: { elementId: 'a' } },
    ];
    const out = deleteElements(els, ['a']);
    expect(out.map((e) => e.id)).toEqual(['ar']);
    expect(out[0].startBinding).toBeNull();
  });
  test('duplicate copies container + label with remapped ids', () => {
    const els = [R('a', { boundElements: [{ id: 't', type: 'text' }] }), { id: 't', type: 'text', x: 0, y: 0, text: 'x', containerId: 'a' }];
    const { elements, ids } = duplicateElements(els, ['a'], 10);
    expect(elements).toHaveLength(4);
    const copy = elements.find((e) => e.id === ids[0]);
    expect(copy.x).toBe(10);
    const label = elements.find((e) => e.type === 'text' && e.containerId === copy.id);
    expect(label).toBeTruthy();
    expect(copy.boundElements[0].id).toBe(label.id);
  });
  test('style patch hits selection + bound text colour; fontSize only for text', () => {
    const els = [R('a'), { id: 't', type: 'text', x: 0, y: 0, text: 'x', containerId: 'a', strokeColor: '#000' }, R('b')];
    const out = updateStyle(els, ['a'], { strokeColor: '#e03131', fontSize: 36 });
    expect(out[0].strokeColor).toBe('#e03131');
    expect(out[0].fontSize).toBeUndefined();
    expect(out[1].strokeColor).toBe('#e03131');
    expect(out[1].fontSize).toBe(36);
    expect(out[2]).toBe(els[2]);
  });
  test('reorder to front / back', () => {
    const els = [R('a'), R('b'), R('c')];
    expect(reorder(els, ['a'], 'front').map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(reorder(els, ['c'], 'back').map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });
  test('container labels: create bound text, edit, inline text', () => {
    let els = [R('a')];
    els = setContainerLabel(els, 'a', 'Hello');
    const lbl = containerLabel(els, els[0]);
    expect(lbl.kind).toBe('bound');
    expect(lbl.element.text).toBe('Hello');
    expect(els[0].boundElements[0].id).toBe(lbl.element.id);
    els = setContainerLabel(els, 'a', 'Bye');
    expect(containerLabel(els, els[0]).element.text).toBe('Bye');
    els = setContainerLabel(els, 'a', '');
    expect(els).toHaveLength(1);
    const inline = [R('n', { text: 'Node' })];
    expect(containerLabel(inline, inline[0])).toEqual({ kind: 'inline', text: 'Node' });
    expect(setContainerLabel(inline, 'n', 'X')[0].text).toBe('X');
  });
  test('eraser collects hit ids', () => {
    const els = [R('a'), R('b', { x: 500 })];
    expect(eraseAt(els, 10, 10, 4, hitTest)).toEqual(['a']);
  });
});

describe('history', () => {
  test('push / undo / redo', () => {
    let h = createHistory([]);
    const s1 = [R('a')];
    const s2 = [R('a'), R('b')];
    h = pushHistory(h, s1);
    h = pushHistory(h, s2);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(s1);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toBe(s2);
    expect(redo(h)).toBe(h);
    h = undo(undo(h));
    expect(undo(h)).toBe(h);
    const h2 = pushHistory(h, s2);
    expect(h2.future).toEqual([]);
    expect(pushHistory(h2, h2.present)).toBe(h2);
  });
  test('capped', () => {
    let h = createHistory([]);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = pushHistory(h, [R(String(i))]);
    expect(h.past.length).toBe(HISTORY_LIMIT);
  });
});

describe('templates', () => {
  test('the five web built-ins', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toEqual(['blank', 'flowchart', 'mindmap', 'wireframe', 'kanban']);
    expect(groupTemplates(BUILTIN_TEMPLATES).map((g) => g.category)).toEqual(['Basic', 'Diagrams', 'Brainstorming', 'Design', 'Project Management']);
  });
  test('template elements get web defaults; fresh re-ids', () => {
    const fc = BUILTIN_TEMPLATES.find((t) => t.id === 'flowchart');
    const els = templateElements(fc);
    expect(els[0]).toMatchObject({ id: 'start', fillStyle: 'solid', roughness: 0, opacity: 100, strokeWidth: 2 });
    expect(els.find((e) => e.id === 'arrow1').points).toEqual([[0, 0], [0, 60]]);
    const fresh = templateElements(fc, true);
    expect(fresh[0].id).not.toBe('start');
    expect(fresh[0].id.startsWith('start-')).toBe(true);
  });
  test('custom templates follow built-ins', () => {
    const all = mergeTemplates([{ id: 'team-retro', data: { elements: [] } }, { id: 'nodata' }]);
    expect(all).toHaveLength(BUILTIN_TEMPLATES.length + 1);
    expect(all[all.length - 1]).toMatchObject({ id: 'custom-team-retro', name: 'Team retro', category: 'Custom' });
  });
  test('no emoji anywhere in template data', () => {
    const s = JSON.stringify(BUILTIN_TEMPLATES);
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s)).toBe(false);
  });
});

describe('boards list', () => {
  test('normalise + sort newest first', () => {
    const rows = normalizeBoards({ boards: [{ id: 'a', updatedAt: 1 }, { id: 'b', name: 'Bee', updatedAt: 5 }, { nope: 1 }] });
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows[1].name).toBe('A');
    expect(normalizeBoards(null)).toEqual([]);
  });
  test('relative time', () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(relativeTime(0, now)).toBe('');
  });
  test('unique board id', () => {
    expect(uniqueBoardId('Flowchart', [])).toBe('flowchart');
    expect(uniqueBoardId('Flowchart', ['flowchart', { id: 'flowchart-2' }])).toBe('flowchart-3');
    expect(uniqueBoardId('!!!', [])).toBe('board');
  });
});

describe('canvas architect + misc', () => {
  test('spawn params match the web panel', () => {
    expect(architectSpawnParams('  draw x ')).toEqual({ agentId: 'canvas', task: 'draw x', label: 'Canvas Request', cleanup: 'keep', runTimeoutSeconds: 120 });
  });
  test('reply extraction', () => {
    expect(architectReply({ turns: [{ role: 'user', text: 'a' }, { role: 'assistant', text: ' done ' }] })).toBe('done');
    expect(architectReply({ turns: [{ role: 'assistant', text: '  ' }] })).toBeNull();
    expect(architectReply(null)).toBeNull();
  });
  test('summary + tools', () => {
    expect(sceneSummary([R('a')]).label).toBe('1 element');
    expect(sceneSummary([]).label).toBe('0 elements');
    expect(TOOLS.map((t) => t.key)).toContain('freedraw');
  });
});

describe('rotation + binding', () => {
  const { resizeRotated, rotateElements, bindArrowEnds } = require('../screens/whiteboard/whiteboard-model');
  const { elementBounds: eb, rotatePoint } = require('../screens/whiteboard/whiteboard-geometry');
  test('resizeRotated keeps the opposite corner fixed in scene space', () => {
    const el = R('a', { x: 0, y: 0, width: 100, height: 50, angle: Math.PI / 6 });
    const b = eb(el);
    const c = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    const nwScene = rotatePoint(0, 0, c[0], c[1], el.angle);
    const out = resizeRotated(el, 'se', 150, 120);
    const nb = eb(out);
    const nc = [(nb.minX + nb.maxX) / 2, (nb.minY + nb.maxY) / 2];
    const after = rotatePoint(nb.minX, nb.minY, nc[0], nc[1], out.angle);
    expect(after[0]).toBeCloseTo(nwScene[0]);
    expect(after[1]).toBeCloseTo(nwScene[1]);
    expect(out.width).toBeGreaterThan(100);
  });
  test('unrotated resizeRotated == resizeElement', () => {
    expect(resizeRotated(R('a'), 'se', 200, 100)).toMatchObject({ width: 200, height: 100 });
  });
  test('rotate skips linear elements, carries bound text', () => {
    const els = [R('a'), { id: 't', type: 'text', x: 0, y: 0, text: 'x', containerId: 'a' }, { id: 'l', type: 'line', x: 0, y: 0, points: [[0, 0], [1, 1]] }];
    const out = rotateElements(els, ['a', 'l'], 1);
    expect(out[0].angle).toBe(1);
    expect(out[1].angle).toBe(1);
    expect(out[2].angle).toBeUndefined();
  });
  test('arrow drawn between two shapes binds both ends', () => {
    const els = [R('a'), R('b', { x: 300 }), { id: 'ar', type: 'arrow', x: 50, y: 25, points: [[0, 0], [300, 0]] }];
    const out = bindArrowEnds(els, 'ar', hitTest);
    const ar = out.find((e) => e.id === 'ar');
    expect(ar.startBinding.elementId).toBe('a');
    expect(ar.endBinding.elementId).toBe('b');
    expect(out[0].boundElements).toEqual([{ id: 'ar', type: 'arrow' }]);
    const moved = moveElements(out, ['b'], 10, 0).find((e) => e.id === 'ar');
    expect(moved.x + moved.points[1][0]).toBe(360);
  });
  test('arrow in empty space stays unbound', () => {
    const els = [{ id: 'ar', type: 'arrow', x: 500, y: 500, points: [[0, 0], [10, 0]] }];
    expect(bindArrowEnds(els, 'ar', hitTest)).toBe(els);
  });
});

describe('syncBoundText', () => {
  const { syncBoundText } = require('../screens/whiteboard/whiteboard-model');
  test('re-centres labels in moved containers; no-op when already centred', () => {
    const els = [R('a', { x: 100, y: 100, width: 200, height: 100, angle: 0.5 }), { id: 't', type: 'text', x: 0, y: 0, text: 'Hi', fontSize: 20, containerId: 'a' }];
    const out = syncBoundText(els);
    const t = out[1];
    expect(t.x + t.width / 2).toBeCloseTo(200);
    expect(t.y + t.height / 2).toBeCloseTo(150);
    expect(t.angle).toBe(0.5);
    expect(syncBoundText(out)).toBe(out);
    const plain = [R('b')];
    expect(syncBoundText(plain)).toBe(plain);
  });
});
