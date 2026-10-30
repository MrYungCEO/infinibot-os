/**
 * The native 2D map: the web's flat-map renderer + 2D stage from the bundle
 * (parity with the web golden frame digest and the ui/src source), the
 * Canvas2D → SVG recorder that draws it with react-native-svg, the floating
 * tap card's placement, the controller's renderer / legend prefs and the
 * pinch midpoint the touch router hands the 2D stage.
 */
import * as nativeCore from '../kg/generated/kg-core';
import { SvgCtx, measureInter, parseFont, scaleAlpha } from '../kg/kg-svg-ctx';
import { cardWidthFor, floatCardPos } from '../kg/kg-float';
import { createTouchRouter } from '../kg/kg-gestures';
import { KgController, cleanPrefs } from '../kg/kg-controller';

jest.mock('../../../ui/src/ui/navigation', () => require('../../../ui/scripts/kg-native/navigation-shim'));

const golden = require('../../../ui/src/ui/components/__fixtures__/kg-map2d-golden.json');
const webDigest = require('../../../ui/src/ui/components/knowledge-graph-map2d-digest');
const webSynth = require('../../../ui/src/ui/components/knowledge-graph-synth');

describe('2D map — native bundle draws what the web draws', () => {
  const snap = nativeCore.makeLiveShapedSnapshot(false, 7);
  const native = nativeCore.digestMap2dCases(snap);

  test('native bundle == web golden frame digest (every grouping mode, focus, search, phone + desktop)', () => {
    expect(Object.keys(native)).toEqual(Object.keys(golden));
    for (const k of Object.keys(golden)) expect(native[k]).toEqual(golden[k]);
  });

  test('native bundle == ui/src source compiled here', () => {
    const web = webDigest.digestMap2d(webSynth.makeLiveShapedSnapshot(false, 7), { w: 390, h: 520, mode: 'brain', focus: true });
    expect(native['phone/brain/focus']).toEqual(web);
  });

  test('the shared drawing runs through the SVG recorder: orbs, links, labels, defs deduped', () => {
    const scene = nativeCore.buildScene({
      nodes: snap.nodes,
      edges: snap.edges,
      enabledKinds: new Set(nativeCore.DEFAULT_KINDS),
      enabledHealth: new Set(nativeCore.DEFAULT_HEALTH),
      groupMode: 'brain',
      aspect: nativeCore.layoutAspectFor(390, 520),
    });
    nativeCore.placeOnTargets(scene.nodes, scene.v3, { cx: 0, cy: 0 });
    const state = { selection: new Set(), selectedId: null, hoveredId: null, adjacency: scene.adjacency, highlightSet: null, activeInsight: null, dropTarget: null, degree: scene.degree };
    const noop = () => {};
    const stage = new nativeCore.KnowledgeGraphMap2DStage(
      { onSelect: noop, onOpen: noop, onDragStart: noop, onDragOver: noop, onDragEnd: noop, onLinkStart: noop, onLinkMove: noop, onLinkEnd: noop, onLasso: noop, onContextMenu: noop, mapState: () => state },
      { size: () => ({ w: 390, h: 520 }), requestDraw: noop, dpr: 1 },
      { now: () => 900, setTimer: () => null, clearTimer: noop },
    );
    stage.setGraph(scene.nodes, nativeCore.stageLinksOf(scene.links, scene.v3), { cx: 0, cy: 0 });
    stage.setGrouping(scene.grouping, 'brain', '');
    stage.resetView(scene.nodes.filter((n) => n.anchor).map((n) => n.id));
    stage.dollyBy(3, 195, 260); // out of the dots LOD: gradients + labels
    const ctx = new SvgCtx();
    stage.frame(ctx);
    const { items, defs } = ctx.list();
    expect(items.filter((i) => i.t === 'path').length).toBeGreaterThan(300);
    expect(items.filter((i) => i.t === 'text').length).toBeGreaterThan(6);
    expect(items.some((i) => i.t === 'path' && /^url\(#g\d+\)$/.test(String(i.fill)))).toBe(true);
    // Bbox-relative gradients repeat per colour: far fewer defs than shapes.
    expect(defs.length).toBeLessThan(items.length / 6);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
  });
});

describe('SvgCtx (Canvas2D → SVG)', () => {
  test('transforms bake into stage px; full arcs become two half-arcs; strokes scale', () => {
    const c = new SvgCtx();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.translate(10, 20);
    c.scale(2, 2);
    c.beginPath();
    c.arc(5, 5, 3, 0, Math.PI * 2);
    c.lineWidth = 1.5;
    c.strokeStyle = '#fff';
    c.setLineDash([2, 1]);
    c.stroke();
    const [p] = c.list().items;
    expect(p.d).toBe('M26 30A6 6 0 1 1 14 30A6 6 0 1 1 26 30');
    expect(p).toMatchObject({ stroke: '#fff', sw: 3, dash: [4, 2] });
  });

  test('a canvas arc joins the current point; partial arcs pick the large-arc flag', () => {
    const c = new SvgCtx();
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(10, 10, 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.5);
    c.stroke();
    expect(c.list().items[0].d).toBe('M0 0L10 0A10 10 0 1 1 0 10');
  });

  test('shadowBlur draws a glow halo under the fill; save/restore scope state', () => {
    const c = new SvgCtx();
    c.save();
    c.shadowColor = 'rgba(212,175,55,0.75)';
    c.shadowBlur = 12;
    c.beginPath();
    c.arc(50, 50, 10, 0, Math.PI * 2);
    c.fillStyle = '#d4af37';
    c.fill();
    c.restore();
    expect(c.shadowBlur).toBe(0);
    const { items, defs } = c.list();
    expect(items.map((i) => i.t)).toEqual(['circle', 'path']);
    expect(items[0]).toMatchObject({ cx: 50, cy: 50, r: 22 });
    expect(defs[0]).toMatchObject({ type: 'radial', units: 'bbox' });
    expect(defs[0].stops.at(-1).color).toBe('rgba(212,175,55,0)');
  });

  test('gradients: same-colour orbs share one bbox-relative def; two-circle radials shift their stops', () => {
    const c = new SvgCtx();
    for (const [x, y, r] of [[10, 10, 5], [80, 40, 12]]) {
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      const g = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
      g.addColorStop(0, '#fff');
      g.addColorStop(1, '#000');
      c.fillStyle = g;
      c.fill();
    }
    const { items, defs } = c.list();
    expect(defs).toHaveLength(1);
    expect(items[0].fill).toBe(items[1].fill);
    expect(defs[0]).toMatchObject({ units: 'bbox', cx: 0.5, cy: 0.5, rx: 0.5, fx: 0.36, fy: 0.33 });
    expect(defs[0].stops.map((s) => s.offset)).toEqual([0, 0.1, 1]);
  });

  test('text: Inter widths, middle baseline, alignment, halo stroke', () => {
    expect(parseFont('600 11px Inter, sans-serif')).toEqual({ weight: 600, size: 11 });
    expect(measureInter('Ab', '500 10px Inter')).toBeCloseTo((709 + 618) / 100, 3);
    const c = new SvgCtx();
    c.font = '700 10px Inter';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(6,4,12,0.85)';
    c.strokeText('LOBE', 100, 50);
    c.fillStyle = '#fff';
    c.fillText('LOBE', 100, 50);
    const [s, f] = c.list().items;
    expect(s).toMatchObject({ t: 'text', fill: 'none', stroke: 'rgba(6,4,12,0.85)', sw: 3, anchor: 'middle', w: 700, fs: 10, y: 53.6 });
    expect(f).toMatchObject({ fill: '#fff', anchor: 'middle' });
    expect(c.measureText('LOBE').width).toBeGreaterThan(20);
    expect(scaleAlpha('#ffffff', 0.5)).toBe('rgba(255,255,255,0.5)');
  });
});

describe('floating tap card (the web hover-card placement)', () => {
  const host = { w: 390, h: 600 };
  const card = { w: 240, h: 220 };

  test('sits right of the node, clear of its halo, centred on it', () => {
    expect(floatCardPos({ x: 60, y: 300, r: 10 }, card, host)).toEqual({ x: 95, y: 190, side: 'right' });
  });

  test('flips left at the right edge and clamps inside the stage', () => {
    expect(floatCardPos({ x: 360, y: 300, r: 10 }, card, host)).toMatchObject({ x: 85, side: 'left' });
    expect(floatCardPos({ x: 200, y: 300, r: 10 }, card, host)).toMatchObject({ x: 8, side: 'left' });
    expect(floatCardPos({ x: 200, y: 20, r: 6 }, card, host).y).toBe(8);
    // Bottom chrome (the dock) is kept clear.
    expect(floatCardPos({ x: 60, y: 590, r: 6 }, card, host, { bottom: 90 }).y).toBe(600 - 220 - 8 - 90);
  });

  test('width follows the web breakpoints', () => {
    expect(cardWidthFor(390)).toBe(240);
    expect(cardWidthFor(1024)).toBe(280);
  });
});

describe('controller: renderer + legend prefs, 2D stage hooks', () => {
  test('renderer pref round-trips, defaults to 3D, and no-GL builds force the flat map', async () => {
    expect(cleanPrefs({}).renderer).toBe('3d');
    expect(cleanPrefs({ renderer: '2d' }).renderer).toBe('2d');
    expect(cleanPrefs({ renderer: 'x' }).renderer).toBe('3d');
    const saved = {};
    const c = new KgController({ request: async () => ({}), storage: { getItem: async () => null, setItem: async (k, v) => { saved[k] = v; } } });
    expect(c.renderer).toBe('3d');
    c.setRenderer('2d');
    expect(c.renderer).toBe('2d');
    expect(JSON.parse(Object.values(saved)[0]).renderer).toBe('2d');
    c.can3d = false;
    c.setRenderer('3d');
    expect(c.renderer).toBe('2d');
    c.setLegendOpen(false);
    expect(c.prefs.legend).toBe('closed');
    expect(cleanPrefs({ legend: 'nope' }).legend).toBe('open');
  });

  test('the 2D stage reads focus state through mapState and gets the grouping on sync', () => {
    const c = new KgController({ request: async () => ({}) });
    const st = c.stageCallbacks.mapState();
    expect(st).toMatchObject({ selectedId: null, dropTarget: null });
    expect(st.selection).toBeInstanceOf(Set);
    const calls = [];
    const rec = (n) => (...a) => calls.push([n, ...a]);
    c.stage = {
      setGraph: rec('setGraph'), setLayoutV3: rec('v3'), setGroups: rec('groups'), setGrouping: rec('grouping'),
      setRings: rec('rings'), setFocus: rec('focus'),
    };
    c.syncStage();
    expect(calls.find((x) => x[0] === 'grouping')).toEqual(['grouping', c.grouping, c.groupMode, c.search]);
  });
});

describe('touch router → 2D stage', () => {
  test('pinch hands the previous midpoint to dollyBy (zoom about the fingers), then pans', () => {
    const calls = [];
    const stage = {
      pointerDown: () => true, pointerMove: () => true, pointerUp: () => {}, pointerCancel: () => calls.push(['cancel']),
      orbitBy: () => {}, panBy: (x, y) => calls.push(['pan', x, y]), twistBy: () => {}, dollyBy: (r, x, y) => calls.push(['dolly', r, x, y]), doubleTapAt: () => {},
    };
    const r = createTouchRouter(stage);
    r.start([{ x: 100, y: 100 }, { x: 200, y: 100 }]);
    r.move([{ x: 90, y: 110 }, { x: 230, y: 110 }]);
    expect(calls[0]).toEqual(['dolly', 1.4, 150, 100]);
    expect(calls[1]).toEqual(['pan', 10, 10]);
  });
});
