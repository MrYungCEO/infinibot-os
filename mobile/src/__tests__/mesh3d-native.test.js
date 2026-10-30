/**
 * Native 3D Agent Mesh: the committed bundle matches ui/src
 * (node ui/scripts/build-mesh3d-native.mjs --check), and the touch router maps
 * gestures onto the scene's camera / tap API.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { TAP_MS, createMesh3DTouchRouter } from '../lib/mesh/mesh3d-gestures';

describe('mesh3d native bundle', () => {
  test('mobile/src/lib/mesh/generated/mesh3d.js is up to date with ui/src', () => {
    const script = path.resolve(__dirname, '../../../ui/scripts/build-mesh3d-native.mjs');
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      code = e.status ?? 1;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    expect({ code, out }).toEqual({ code: 0, out: '' });
  });

  test('three stays external and the only DOM use is the guarded label atlas', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../lib/mesh/generated/mesh3d.js'), 'utf8');
    expect(src).toMatch(/from "three"/);
    expect(src).not.toMatch(/three\.module|REVISION = "/);
    expect((src.match(/\bdocument\./g) || []).length).toBe(1);
    expect(src).toMatch(/opts\.labels\) != null \? _c : typeof document !== "undefined"/);
  });
});

function fakeScene() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return { calls, orbitBy: rec('orbitBy'), tiltBy: rec('tiltBy'), zoomBy: rec('zoomBy'), panBy: rec('panBy'), tapAt: rec('tapAt') };
}

describe('mesh3d touch router', () => {
  test('a quick still touch is a tap at the lift point', () => {
    let t = 0;
    const s = fakeScene();
    const r = createMesh3DTouchRouter(s, { now: () => t });
    r.start([{ x: 100, y: 200 }]);
    t = 120;
    r.end([], { x: 102, y: 201 });
    expect(s.calls).toEqual([['tapAt', 102, 201, true]]);
  });

  test('a long press is not a tap', () => {
    let t = 0;
    const s = fakeScene();
    const r = createMesh3DTouchRouter(s, { now: () => t });
    r.start([{ x: 10, y: 10 }]);
    t = TAP_MS + 1;
    r.end([], { x: 10, y: 10 });
    expect(s.calls).toEqual([]);
  });

  test('one-finger drag orbits and tilts, and never taps', () => {
    const s = fakeScene();
    const r = createMesh3DTouchRouter(s, { now: () => 0 });
    r.start([{ x: 100, y: 100 }]);
    r.move([{ x: 130, y: 90 }]);
    r.move([{ x: 160, y: 80 }]);
    r.end([], { x: 160, y: 80 });
    const names = s.calls.map((c) => c[0]);
    expect(names).toContain('orbitBy');
    expect(names).toContain('tiltBy');
    expect(names).not.toContain('tapAt');
    // Dragging right orbits the camera the other way (world follows the finger).
    expect(s.calls.find((c) => c[0] === 'orbitBy')[1]).toBeLessThan(0);
  });

  test('pinch out zooms in immediately; two-finger drag pans', () => {
    const s = fakeScene();
    const r = createMesh3DTouchRouter(s, { now: () => 0 });
    r.start([{ x: 100, y: 100 }]);
    r.start([{ x: 100, y: 100 }, { x: 200, y: 100 }]);
    r.move([{ x: 50, y: 100 }, { x: 250, y: 100 }]);
    const zoom = s.calls.find((c) => c[0] === 'zoomBy');
    expect(zoom[1]).toBeCloseTo(0.5);
    expect(zoom[2]).toBe(0);
    r.move([{ x: 60, y: 120 }, { x: 260, y: 120 }]);
    const pan = s.calls.filter((c) => c[0] === 'panBy').pop();
    expect(pan[1]).toBeLessThan(0);
    expect(pan[2]).toBeLessThan(0);
    r.end([{ x: 60, y: 120 }], null);
    expect(r.mode).toBe('drain');
    r.end([], null);
    expect(r.mode).toBe('idle');
    expect(s.calls.map((c) => c[0])).not.toContain('tapAt');
  });
});
