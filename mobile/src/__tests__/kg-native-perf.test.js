/**
 * Native Knowledge Graph perf controls: the frame gate that pauses the
 * render loop when the screen loses focus / the app backgrounds, the
 * bloom fallback tiers (HDR / 8-bit LDR), and the GL surface the stage renders through.
 */
import { manualPause } from '../kg/generated/kg-stage';
import { effectsFor, glSurfaceFor, HALF_FLOAT_TYPE, UNSIGNED_BYTE_TYPE } from '../kg/kg-gl-surface';
import { perfTierFor } from '../infini/perf-tier';

// The pause gate doesn't touch three's ESM example modules; stub them for jest.
jest.mock('three/examples/jsm/controls/OrbitControls.js', () => ({}));
jest.mock('three/examples/jsm/postprocessing/EffectComposer.js', () => ({}));
jest.mock('three/examples/jsm/postprocessing/RenderPass.js', () => ({}));
jest.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', () => ({}));
jest.mock('three/examples/jsm/postprocessing/OutputPass.js', () => ({}));
jest.mock('three/examples/jsm/utils/BufferGeometryUtils.js', () => ({}));

describe('pause when unfocused', () => {
  test('manualPause flips the stage loop off and on (screen focus / AppState)', () => {
    const p = manualPause(true);
    const seen = [];
    p.onChange = (a) => seen.push(a);
    expect(p.isActive()).toBe(true);
    p.set(false); // screen blurred or app backgrounded
    expect(p.isActive()).toBe(false);
    p.set(false); // no duplicate stops
    p.set(true);
    expect(seen).toEqual([false, true]);
  });
});

describe('device tiers', () => {
  test('bloom glows on every tier: HDR half-res where the GPU allows, the 8-bit quarter-res fallback otherwise', () => {
    const low = 'low';
    const high = 'high';
    expect(effectsFor(true, high)).toMatchObject({ bloom: true, bloomMode: 'hdr', bloomDivisor: 2, targetType: HALF_FLOAT_TYPE });
    // Low tier: still glows, on the cheap LDR pyramid.
    expect(effectsFor(true, low)).toMatchObject({ bloom: true, bloomMode: 'ldr', bloomDivisor: 4 });
    // No half-float render targets: 8-bit targets, still bloom.
    expect(effectsFor(false, high)).toMatchObject({ bloom: true, bloomMode: 'ldr', bloomDivisor: 4, targetType: UNSIGNED_BYTE_TYPE });
    expect(glSurfaceFor({ canvas: {}, drawingBufferWidth: 2 }, { size: () => ({ w: 2, h: 2 }), halfFloat: false, bloom: true, bloomDivisor: 4, writeLabels: () => {} })).toMatchObject({ bloom: true, bloomDivisor: 4, targetType: UNSIGNED_BYTE_TYPE });
  });
});

describe('expo-gl surface', () => {
  test('uses the drawing buffer ratio, presents with endFrameEXP and quiets unsupported pixelStorei', () => {
    const calls = [];
    const gl = {
      drawingBufferWidth: 1170,
      drawingBufferHeight: 2532,
      pixelStorei: (p, v) => calls.push(['ps', p, v]),
      getParameter: () => null,
      endFrameEXP: () => calls.push(['end']),
      VIEWPORT: 0x0ba2,
      SCISSOR_BOX: 0x0c10,
    };
    const s = glSurfaceFor(gl, { size: () => ({ w: 390, h: 844 }), halfFloat: false, bloom: false, writeLabels: () => {} });
    expect(s.pixelRatio()).toBe(3);
    expect(s.canvas.width).toBe(1170);
    s.present();
    gl.pixelStorei(0x9240, 1); // FLIP_Y: passed through
    gl.pixelStorei(0x9241, 1); // PREMULTIPLY: swallowed (expo-gl would log per upload)
    expect(calls).toEqual([['end'], ['ps', 0x9240, 1]]);
    expect(Array.from(gl.getParameter(gl.VIEWPORT))).toEqual([0, 0, 1170, 2532]);
  });
});
