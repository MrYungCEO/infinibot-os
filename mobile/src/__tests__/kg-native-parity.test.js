/**
 * Web ↔ native parity for the knowledge graph.
 *
 * The native screen draws from mobile/src/kg/generated/kg-core.js — a bundle
 * of the SAME ui/src knowledge-graph modules the web graph runs. These tests
 * replay the web suite's golden cases (ui/src/ui/components/
 * knowledge-graph-scene.test.ts) three ways and require identical output:
 *   1. the native bundle,
 *   2. the ui/src TypeScript source compiled by this suite's toolchain,
 *   3. the golden digest the web (vitest) suite pins.
 * Same snapshot + same filters + same aspect → same nodes, sizes, colours,
 * brain/lobe targets, links, halos, rings, labels, emphasis and signals.
 */
import * as nativeCore from '../kg/generated/kg-core';

// The web navigation module pulls in the whole web shell; the bundle swaps in
// a stub (ui/scripts/kg-native/navigation-shim.ts) — so does this test.
jest.mock('../../../ui/src/ui/navigation', () => require('../../../ui/scripts/kg-native/navigation-shim'));

const webDigest = require('../../../ui/src/ui/components/knowledge-graph-scene-digest');
const webScene = require('../../../ui/src/ui/components/knowledge-graph-scene');
const webSynth = require('../../../ui/src/ui/components/knowledge-graph-synth');
const golden = require('../../../ui/src/ui/components/__fixtures__/kg-scene-golden.json');

function cases(core, synth) {
  const plain = synth.makeLiveShapedSnapshot(false, 7);
  const tasks = synth.makeLiveShapedSnapshot(true, 11);
  const a = core.layoutAspectFor;
  return {
    'live-shaped/phone': core.digestAllModes(plain, { aspect: a(390, 700) }),
    'live-shaped/desktop': core.digestAllModes(plain, { aspect: a(1600, 900) }),
    'live-tasks/landscape': core.digestAllModes(tasks, { aspect: a(844, 330) }),
    'live-shaped/search': core.digestAllModes(plain, { aspect: a(390, 700), search: 'kingly' }),
  };
}

describe('knowledge graph — native bundle matches the web pipeline', () => {
  const native = cases(nativeCore, nativeCore);

  test('native bundle == web golden (every case × every grouping mode)', () => {
    expect(Object.keys(native)).toEqual(Object.keys(golden));
    for (const k of Object.keys(golden)) {
      expect(Object.keys(native[k])).toEqual(['brain', 'orbit', 'project', 'status', 'type', 'cluster']);
      expect(native[k]).toEqual(golden[k]);
    }
  });

  test('native bundle == ui/src source compiled here', () => {
    // One case is enough here (the golden pins the rest); layout is the slow part.
    const plain = webSynth.makeLiveShapedSnapshot(false, 7);
    const web = { ...webScene, ...webDigest }.digestAllModes(plain, { aspect: webScene.layoutAspectFor(390, 700) });
    expect(native['live-shaped/phone']).toEqual(web);
  });

  test('brain mode puts nodes in lobes on both hemispheres', () => {
    const regions = golden['live-shaped/phone'].brain.regions;
    expect(regions.some((r) => r.startsWith('frontal:L:'))).toBe(true);
    expect(regions.some((r) => r.startsWith('frontal:R:'))).toBe(true);
    expect(native['live-shaped/phone'].brain.count).toBeGreaterThan(400);
  });
});
