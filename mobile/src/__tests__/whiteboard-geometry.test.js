/**
 * Native Whiteboard — pure geometry (bounds, hit tests, paths, camera, colour).
 */
import {
  elementBounds,
  rotatedBounds,
  sceneBounds,
  hitTest,
  hitTestScene,
  hitHandle,
  resizeBounds,
  screenToScene,
  sceneToScreen,
  zoomAround,
  fitCamera,
  centerOn,
  clampZoom,
  darkModeColor,
  renderColor,
  cornerRadius,
  rectPath,
  diamondPath,
  ellipsePath,
  polylinePath,
  arrowheadPath,
  freedrawPath,
  elementGeometry,
  dashArray,
  layoutText,
  measureText,
  seededRandom,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../screens/whiteboard/whiteboard-geometry';

const rect = (o = {}) => ({ id: 'r', type: 'rectangle', x: 10, y: 20, width: 100, height: 50, angle: 0, ...o });

describe('bounds', () => {
  test('shape bounds are x/y + size', () => {
    expect(elementBounds(rect())).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
  });
  test('negative sizes normalise', () => {
    expect(elementBounds(rect({ width: -100 }))).toEqual({ minX: -90, minY: 20, maxX: 10, maxY: 70 });
  });
  test('linear bounds come from relative points', () => {
    const a = { type: 'arrow', x: 100, y: 100, points: [[0, 0], [-50, 30], [20, 80]] };
    expect(elementBounds(a)).toEqual({ minX: 50, minY: 100, maxX: 120, maxY: 180 });
  });
  test('linear without points falls back to width/height', () => {
    expect(elementBounds({ type: 'line', x: 0, y: 0, width: -150, height: -100 })).toEqual({ minX: -150, minY: -100, maxX: 0, maxY: 0 });
  });
  test('text with no size is measured', () => {
    const b = elementBounds({ type: 'text', x: 0, y: 0, text: 'Hello', fontSize: 20 });
    expect(b.maxX).toBeGreaterThan(40);
    expect(b.maxY).toBeCloseTo(25);
  });
  test('rotation by 90deg swaps the extents around the centre', () => {
    const b = rotatedBounds(rect({ x: 0, y: 0, width: 100, height: 50, angle: Math.PI / 2 }));
    expect(b.minX).toBeCloseTo(25);
    expect(b.maxX).toBeCloseTo(75);
    expect(b.minY).toBeCloseTo(-25);
    expect(b.maxY).toBeCloseTo(75);
  });
  test('scene bounds skip deleted elements', () => {
    const b = sceneBounds([rect(), rect({ id: 'z', x: 1000, isDeleted: true })]);
    expect(b.maxX).toBe(110);
    expect(sceneBounds([])).toBeNull();
  });
});

describe('hit testing', () => {
  test('rectangle interior and tolerance', () => {
    expect(hitTest(rect(), 50, 40)).toBe(true);
    expect(hitTest(rect(), 115, 40, 8)).toBe(true);
    expect(hitTest(rect(), 130, 40, 8)).toBe(false);
  });
  test('ellipse excludes its corners', () => {
    const e = { type: 'ellipse', x: 0, y: 0, width: 100, height: 100 };
    expect(hitTest(e, 50, 50, 0)).toBe(true);
    expect(hitTest(e, 3, 3, 0)).toBe(false);
  });
  test('diamond excludes its corners', () => {
    const d = { type: 'diamond', x: 0, y: 0, width: 100, height: 100 };
    expect(hitTest(d, 50, 50, 0)).toBe(true);
    expect(hitTest(d, 5, 5, 0)).toBe(false);
  });
  test('arrow hit by distance to its path', () => {
    const a = { type: 'arrow', x: 0, y: 0, points: [[0, 0], [100, 0]], strokeWidth: 2 };
    expect(hitTest(a, 50, 5, 8)).toBe(true);
    expect(hitTest(a, 50, 30, 8)).toBe(false);
  });
  test('rotated rectangle is tested in its own frame', () => {
    const r = rect({ x: 0, y: 0, width: 200, height: 20, angle: Math.PI / 2 });
    // Centre (100,10); rotated 90deg it spans y from -90..110 at x≈90..110.
    expect(hitTest(r, 100, 100, 0)).toBe(true);
    expect(hitTest(r, 180, 10, 0)).toBe(false);
  });
  test('topmost wins; bound text resolves to its container; locked skipped', () => {
    const els = [
      rect({ id: 'a' }),
      rect({ id: 'b' }),
      { id: 't', type: 'text', x: 30, y: 30, width: 40, height: 20, text: 'x', containerId: 'a' },
    ];
    expect(hitTestScene(els, 40, 35)).toBe('a');
    expect(hitTestScene(els.slice(0, 2), 40, 35)).toBe('b');
    expect(hitTestScene([rect({ id: 'a' }), rect({ id: 'b', locked: true })], 40, 35)).toBe('a');
    expect(hitTestScene(els, 900, 900)).toBeNull();
  });
});

describe('handles + resize', () => {
  const b = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  test('finds the corner under the finger', () => {
    expect(hitHandle(b, 98, 48, 10)).toBe('se');
    expect(hitHandle(b, 2, 1, 10)).toBe('nw');
    expect(hitHandle(b, 50, 25, 10)).toBeNull();
  });
  test('dragging se grows; opposite corner anchored; never collapses', () => {
    expect(resizeBounds(b, 'se', 200, 100)).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
    expect(resizeBounds(b, 'nw', 500, 500, 4)).toEqual({ minX: 96, minY: 46, maxX: 100, maxY: 50 });
  });
  test('keepAspect scales uniformly', () => {
    const r = resizeBounds(b, 'se', 200, 60, 4, true);
    expect((r.maxX - r.minX) / (r.maxY - r.minY)).toBeCloseTo(2);
  });
});

describe('camera', () => {
  test('screen <-> scene round-trip', () => {
    const cam = { x: 30, y: -20, zoom: 2 };
    const [sx, sy] = sceneToScreen(cam, 10, 15);
    expect(screenToScene(cam, sx, sy)).toEqual([10, 15]);
  });
  test('zoomAround keeps the focal point fixed', () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    const next = zoomAround(cam, 2, 100, 100);
    expect(screenToScene(next, 100, 100)).toEqual(screenToScene(cam, 100, 100));
    expect(next.zoom).toBe(2);
  });
  test('zoom clamps', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(undefined)).toBe(1);
  });
  test('fit centres content and caps zoom at 1', () => {
    const cam = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 400, 400, 20);
    expect(cam.zoom).toBe(1);
    expect(sceneToScreen(cam, 50, 50)).toEqual([200, 200]);
    const big = fitCamera({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, 400, 400, 0);
    expect(big.zoom).toBeCloseTo(0.4);
  });
  test('fit with no content is identity-ish', () => {
    expect(fitCamera(null, 400, 300)).toEqual({ x: 200, y: 150, zoom: 1 });
  });
  test('centerOn', () => {
    const c = centerOn({ x: 0, y: 0, zoom: 2 }, 10, 10, 200, 100);
    expect(sceneToScreen(c, 10, 10)).toEqual([100, 50]);
  });
});

describe('colour', () => {
  test('dark mode maps Excalidraw ink + paper like the web filter', () => {
    expect(darkModeColor('#ffffff')).toBe('#121212');
    expect(darkModeColor('#1e1e1e')).toBe('#d3d3d3');
    expect(darkModeColor('#fff')).toBe('#121212');
  });
  test('hue survives (red stays reddish)', () => {
    const c = darkModeColor('#e03131');
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    expect(r).toBeGreaterThan(g);
  });
  test('transparent / non-hex pass through; light mode is identity', () => {
    expect(darkModeColor('transparent')).toBe('transparent');
    expect(darkModeColor('red')).toBe('red');
    expect(renderColor('#123456', false)).toBe('#123456');
  });
  test('alpha channel kept', () => {
    expect(darkModeColor('#ffffff80')).toMatch(/80$/);
  });
});

describe('paths', () => {
  test('corner radius follows Excalidraw adaptive / proportional rules', () => {
    expect(cornerRadius(null, 100)).toBe(0);
    expect(cornerRadius({ type: 2 }, 100)).toBe(25);
    expect(cornerRadius({ type: 3 }, 100)).toBe(25);
    expect(cornerRadius({ type: 3 }, 400)).toBe(32);
  });
  test('rect/diamond/ellipse paths are closed', () => {
    expect(rectPath(100, 50)).toMatch(/^M0 0 .*Z$/);
    expect(rectPath(100, 50, 10)).toContain('Q');
    expect(diamondPath(100, 50)).toMatch(/^M50 0 L100 25 L50 50 L0 25 Z$/);
    expect(diamondPath(100, 50, 10)).toContain('Q');
    expect(ellipsePath(100, 50)).toMatch(/^M100 25 C.*Z$/);
  });
  test('roughness jitter is deterministic per seed', () => {
    const a = elementGeometry(rect({ roughness: 1, seed: 42 }));
    const b = elementGeometry(rect({ roughness: 1, seed: 42 }));
    expect(a.d).toBe(b.d);
    expect(a.sketch).not.toBeNull();
    expect(elementGeometry(rect({ roughness: 0 })).sketch).toBeNull();
    const r = seededRandom(7);
    const v = r();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
  test('polyline: straight and rounded', () => {
    expect(polylinePath([[0, 0], [10, 10]])).toBe('M0 0 L10 10');
    expect(polylinePath([[0, 0], [10, 10], [20, 0]], true)).toContain('Q');
    expect(polylinePath([])).toBe('');
  });
  test('arrowheads', () => {
    const h = arrowheadPath('arrow', [0, 0], [100, 0], 2);
    expect(h.kind).toBe('arrow');
    expect(h.path).toContain('L100 0');
    expect(arrowheadPath('triangle', [0, 0], [100, 0]).filled).toBe(true);
    expect(arrowheadPath('dot', [0, 0], [100, 0]).r).toBeGreaterThan(0);
    expect(arrowheadPath('bar', [0, 0], [100, 0]).path).toMatch(/^M100 /);
    expect(arrowheadPath('arrow', [0, 0], [0, 0])).toBeNull();
    expect(arrowheadPath(null, [0, 0], [10, 0])).toBeNull();
  });
  test('arrow geometry gets an end head by default; start head when set', () => {
    const g = elementGeometry({ type: 'arrow', x: 0, y: 0, points: [[0, 0], [100, 0]], startArrowhead: 'dot' });
    expect(g.kind).toBe('line');
    expect(g.heads).toHaveLength(2);
    expect(elementGeometry({ type: 'line', x: 0, y: 0, points: [[0, 0], [100, 0]] }).heads).toHaveLength(0);
  });
  test('freedraw produces a filled outline', () => {
    const d = freedrawPath({ type: 'freedraw', points: [[0, 0], [10, 5], [20, 10], [30, 5]], strokeWidth: 2 });
    expect(d).toMatch(/^M .* Z$/);
    expect(freedrawPath({ type: 'freedraw', points: [[0, 0]] })).toMatch(/Z$/);
  });
  test('dash arrays', () => {
    expect(dashArray('solid')).toBeUndefined();
    expect(dashArray('dashed', 2)).toEqual([8, 10]);
    expect(dashArray('dotted', 2)[0]).toBe(1.5);
  });
});

describe('text layout', () => {
  test('measure grows with lines and characters', () => {
    const one = measureText('abc', 20);
    const two = measureText('abc\nabcdef', 20);
    expect(two.height).toBeCloseTo(one.height * 2);
    expect(two.width).toBeGreaterThan(one.width);
  });
  test('free text: left aligned at x, baselines step by line height', () => {
    const l = layoutText({ type: 'text', x: 10, y: 20, text: 'a\nb', fontSize: 20, width: 50 });
    expect(l.anchor).toBe('start');
    expect(l.lines[0].x).toBe(10);
    expect(l.lines[1].y - l.lines[0].y).toBeCloseTo(25);
  });
  test('bound text centres inside its container', () => {
    const c = rect({ x: 0, y: 0, width: 200, height: 100 });
    const l = layoutText({ type: 'text', x: 999, y: 999, text: 'Hi', fontSize: 20, containerId: 'r', textAlign: 'center' }, c);
    expect(l.anchor).toBe('middle');
    expect(l.lines[0].x).toBe(100);
    expect(l.lines[0].y).toBeGreaterThan(40);
    expect(l.lines[0].y).toBeLessThan(70);
  });
});

describe('render transforms + selection frame', () => {
  const { elementMatrix, matrixString, selectionFrame, angleFromHandle } = require('../screens/whiteboard/whiteboard-geometry');
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  test('unrotated matrix is a translate', () => {
    expect(elementMatrix(rect())).toEqual([1, 0, 0, 1, 10, 20]);
    expect(matrixString([1, 0, 0, 1, 10.12345, 20])).toBe('matrix(1 0 0 1 10.123 20)');
  });
  test('rotated matrix maps local centre to scene centre', () => {
    const el = rect({ x: 0, y: 0, width: 100, height: 50, angle: 1.2 });
    const [cx, cy] = apply(elementMatrix(el), 50, 25);
    expect(cx).toBeCloseTo(50);
    expect(cy).toBeCloseTo(25);
    const [px] = apply(elementMatrix(el), 0, 0);
    expect(px).not.toBeCloseTo(0);
  });
  test('single selection: rotated corners + rotate handle; multi: AABB', () => {
    const one = selectionFrame([rect({ x: 0, y: 0 })], ['r']);
    expect(one.single).toBe(true);
    expect(one.corners.se).toEqual([100, 50]);
    expect(one.rotateHandle[1]).toBeLessThan(0);
    const two = selectionFrame([rect({ id: 'a', x: 0, y: 0 }), rect({ id: 'b', x: 200, y: 100 })], ['a', 'b']);
    expect(two.single).toBe(false);
    expect(two.corners.se).toEqual([300, 150]);
    expect(two.rotateHandle).toBeNull();
    expect(selectionFrame([], ['x'])).toBeNull();
  });
  test('angle from handle: straight up is 0, right is 90deg; snaps', () => {
    expect(angleFromHandle(0, 0, 0, -10)).toBeCloseTo(0);
    expect(angleFromHandle(0, 0, 10, 0)).toBeCloseTo(Math.PI / 2);
    expect(angleFromHandle(0, 0, 10, 0.3)).toBeCloseTo(Math.PI / 2);
  });
});
