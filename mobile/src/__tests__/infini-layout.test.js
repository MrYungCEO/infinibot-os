/**
 * Infini call screen layout — the character is the centred hero in both
 * orientations; controls sit in a light header + one slim bottom dock
 * (portrait) or slim side rails (landscape) and never overlap it. Quick
 * capture is one "+" orb whose labelled menu fans out on demand.
 */
import { CAPTURE_ORDER, MIN_TOUCH, ORB, effectiveInsets, infiniLayout, isLandscape, landscapeLayout, portraitLayout } from '../infini/layout';

const IPHONE_PORTRAIT_INSETS = { top: 47, bottom: 34, left: 0, right: 0 };
const IPHONE_LAND_INSETS = { top: 0, bottom: 21, left: 59, right: 59 };
const IPAD_INSETS = { top: 24, bottom: 20, left: 0, right: 0 };

function overlaps(a, b) {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}
const faceRect = (l) => ({ left: l.face.left, top: l.face.top, width: l.faceSize, height: l.faceSize });

describe('orientation pick', () => {
  test('wider than tall is landscape', () => {
    expect(isLandscape(844, 390)).toBe(true);
    expect(isLandscape(1194, 834)).toBe(true);
    expect(isLandscape(390, 844)).toBe(false);
    expect(isLandscape(834, 1194)).toBe(false);
    expect(infiniLayout(390, 844).orientation).toBe('portrait');
    expect(infiniLayout(844, 390).orientation).toBe('landscape');
  });
});

describe('effective insets (app banner above the screen)', () => {
  test('a banner that covers the notch removes the top inset', () => {
    expect(effectiveInsets({ top: 47, bottom: 34 }, 844, 844 - 49)).toEqual({ top: 0, bottom: 34, left: 0, right: 0 });
    expect(effectiveInsets({ top: 47, bottom: 34 }, 844, 844)).toEqual({ top: 47, bottom: 34, left: 0, right: 0 });
    expect(effectiveInsets({ top: 47 }, 844, 824).top).toBe(27);
  });
});

describe('portrait', () => {
  const cases = [
    ['iPhone 390x844', 390, 844, IPHONE_PORTRAIT_INSETS],
    ['iPhone 390x795 under a push banner', 390, 795, effectiveInsets(IPHONE_PORTRAIT_INSETS, 844, 795)],
    ['iPhone SE 375x667', 375, 667, { top: 20, bottom: 0 }],
    ['iPhone Pro Max 430x932', 430, 932, { top: 59, bottom: 34, left: 0, right: 0 }],
    ['web 390x844 (no insets)', 390, 844, {}],
    ['iPad 834x1194', 834, 1194, IPAD_INSETS],
  ];

  test.each(cases)('%s: face is centred horizontally (±2pt) and in the free area vertically', (_n, w, h, insets) => {
    const l = portraitLayout(w, h, insets);
    expect(Math.abs(l.face.left + l.faceSize / 2 - w / 2)).toBeLessThanOrEqual(2);
    const freeMid = (l.free.top + l.free.bottom) / 2;
    expect(Math.abs(l.face.top + l.faceSize / 2 - freeMid)).toBeLessThanOrEqual(2);
  });

  test.each(cases.filter((c) => c[1] < 500))('%s: face is 86–90%% of the width', (_n, w, h, insets) => {
    const l = portraitLayout(w, h, insets);
    expect(l.faceSize / w).toBeGreaterThanOrEqual(0.86);
    expect(l.faceSize / w).toBeLessThanOrEqual(0.9);
  });

  test('iPad portrait: still the hero, ≥ 75% of the width', () => {
    const l = portraitLayout(834, 1194, IPAD_INSETS);
    expect(l.faceSize / 834).toBeGreaterThanOrEqual(0.75);
  });

  test.each(cases)('%s: inside the safe area, nothing overlaps the face or each other', (_n, w, h, insets) => {
    const l = portraitLayout(w, h, insets);
    const face = faceRect(l);
    const blocks = [l.header, l.info, l.talk];
    for (const r of [face, ...blocks]) {
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.left + r.width).toBeLessThanOrEqual(w);
      expect(r.top).toBeGreaterThanOrEqual(insets.top || 0);
      expect(r.top + r.height).toBeLessThanOrEqual(h - (insets.bottom || 0));
    }
    for (const b of blocks) expect(overlaps(face, b)).toBe(false);
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) expect(overlaps(blocks[i], blocks[j])).toBe(false);
    // header above the face, the dock below it
    expect(l.header.top + l.header.height).toBeLessThanOrEqual(l.face.top);
    expect(l.info.top).toBeGreaterThanOrEqual(l.face.top + l.faceSize);
  });

  test.each(cases)('%s: dock slots — transcript left, capture orb right, the centre group between, ≥44pt, clear of the face', (_n, w, h, insets) => {
    const l = portraitLayout(w, h, insets);
    const { transcript, orb, center } = l.dock;
    for (const r of [transcript, orb]) {
      expect(r.width).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(r.height).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(r.top).toBeGreaterThanOrEqual(l.talk.top);
      expect(r.top + r.height).toBeLessThanOrEqual(l.talk.top + l.talk.height);
      expect(overlaps(faceRect(l), r)).toBe(false);
      expect(overlaps(l.info, r)).toBe(false);
      expect(overlaps(l.header, r)).toBe(false);
    }
    expect(l.orb).toBe(orb);
    expect(orb.left + orb.width).toBeCloseTo(l.talk.left + l.talk.width, 6);
    expect(transcript.left).toBe(l.talk.left);
    expect(overlaps(center, orb)).toBe(false);
    expect(overlaps(center, transcript)).toBe(false);
    // mic + type + end (3 × 52 + 2 gaps) fit in the centre group
    expect(center.width).toBeGreaterThanOrEqual(ORB * 3 + 24);
  });

  test.each(cases)('%s: the capture menu fans up from the orb — 5 labelled ≥44pt pills, stacked, clear of the dock and header', (_n, w, h, insets) => {
    const l = portraitLayout(w, h, insets);
    const bs = CAPTURE_ORDER.map((k) => l.buttons[k]);
    for (const b of bs) {
      expect(b.height).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(b.width).toBeGreaterThanOrEqual(120); // icon + label
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(w);
      expect(overlaps(b, l.talk)).toBe(false);
      expect(overlaps(b, l.orb)).toBe(false);
      expect(overlaps(b, l.header)).toBe(false);
      expect(b.top).toBeGreaterThanOrEqual(l.header.top + l.header.height);
    }
    for (let i = 1; i < bs.length; i++) expect(bs[i].top).toBeGreaterThanOrEqual(bs[i - 1].top + bs[i - 1].height);
    // right-aligned with the orb, just above it
    expect(bs[0].left + bs[0].width).toBeCloseTo(l.orb.left + l.orb.width, 6);
    expect(bs[bs.length - 1].top + bs[bs.length - 1].height).toBeLessThanOrEqual(l.orb.top);
    expect(l.orb.top - (bs[bs.length - 1].top + bs[bs.length - 1].height)).toBeLessThanOrEqual(24);
  });

  test.each(cases)('%s: no capture row any more — the dock is the only control band below the info', (_n, w, h, insets) => {
    const l = portraitLayout(w, h, insets);
    expect(l.captureRow).toBeUndefined();
    expect(l.talk.top - (l.info.top + l.info.height)).toBeLessThanOrEqual(16);
  });

  test('390x844 concrete numbers: bigger than the tile-row layout (327pt)', () => {
    const l = portraitLayout(390, 844, IPHONE_PORTRAIT_INSETS);
    expect(l.faceSize).toBe(351); // floor(390 * 0.9)
    expect(l.faceSize).toBeGreaterThan(327);
    expect(l.orb).toEqual({ left: 322, top: 756, width: 52, height: 52 });
  });
});

describe('landscape', () => {
  const cases = [
    ['iPhone 844x390', 844, 390, IPHONE_LAND_INSETS],
    ['iPhone 844x390, no insets (web)', 844, 390, {}],
    ['iPhone 844x390, notch left only', 844, 390, { left: 59, right: 0, bottom: 21 }],
    ['iPhone Pro Max 932x430', 932, 430, { top: 0, bottom: 21, left: 59, right: 59 }],
    ['iPhone SE 667x375', 667, 375, {}],
    ['iPad 1194x834', 1194, 834, IPAD_INSETS],
  ];

  test.each(cases)('%s: face centred horizontally on the screen (±2pt) and vertically in the safe area', (_n, w, h, insets) => {
    const l = landscapeLayout(w, h, insets);
    expect(Math.abs(l.face.left + l.faceSize / 2 - w / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(l.face.top + l.faceSize / 2 - (l.safe.top + l.safe.bottom) / 2)).toBeLessThanOrEqual(2);
  });

  test.each(cases.filter((c) => c[1] >= 800))('%s: face is ~86%% of the screen height', (_n, w, h, insets) => {
    const l = landscapeLayout(w, h, insets);
    expect(l.faceSize / h).toBeGreaterThanOrEqual(0.82);
    expect(l.faceSize / h).toBeLessThanOrEqual(0.87);
    expect(l.faceSize).toBeGreaterThan(portraitLayout(h, w).faceSize * 0.9);
  });

  test.each(cases)('%s: rails sit inside the safe area, on both sides, never over the face', (_n, w, h, insets) => {
    const l = landscapeLayout(w, h, insets);
    const face = faceRect(l);
    const rects = [face, l.leftRail, l.rightRail, l.railTop, l.orb, ...CAPTURE_ORDER.map((k) => l.buttons[k])];
    for (const r of rects) {
      expect(r.left).toBeGreaterThanOrEqual(insets.left || 0);
      expect(r.left + r.width).toBeLessThanOrEqual(w - (insets.right || 0));
      expect(r.top).toBeGreaterThanOrEqual(insets.top || 0);
      expect(r.top + r.height).toBeLessThanOrEqual(h - (insets.bottom || 0));
    }
    expect(l.leftRail.left + l.leftRail.width).toBeLessThanOrEqual(face.left);
    expect(l.rightRail.left).toBeGreaterThanOrEqual(face.left + face.width);
    expect(l.leftRail.width).toBeGreaterThanOrEqual(160);
    expect(l.rightRail.width).toBeGreaterThanOrEqual(160);
    expect(overlaps(face, l.orb)).toBe(false);
    expect(overlaps(l.railTop, l.orb)).toBe(false);
    for (const k of CAPTURE_ORDER) {
      expect(overlaps(face, l.buttons[k])).toBe(false);
      expect(overlaps(l.leftRail, l.buttons[k])).toBe(false);
      expect(overlaps(l.railTop, l.buttons[k])).toBe(false);
      expect(overlaps(l.orb, l.buttons[k])).toBe(false);
    }
  });

  test.each(cases)('%s: the capture orb sits bottom-right; its menu stacks in the right rail as ≥44pt pills', (_n, w, h, insets) => {
    const l = landscapeLayout(w, h, insets);
    expect(l.orb.left + l.orb.width).toBe(l.safe.right);
    expect(l.orb.top + l.orb.height).toBe(l.safe.bottom);
    const bs = CAPTURE_ORDER.map((k) => l.buttons[k]);
    for (const b of bs) {
      expect(b.height).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(b.width).toBeGreaterThanOrEqual(100);
      expect(b.left).toBeGreaterThanOrEqual(l.rightRail.left);
    }
    for (let i = 1; i < bs.length; i++) expect(bs[i].top).toBeGreaterThanOrEqual(bs[i - 1].top + bs[i - 1].height);
  });

  test('667x375 (narrow phone): the rails keep their minimum width, the face takes the rest (≥ 70% of the height)', () => {
    const l = landscapeLayout(667, 375, {});
    expect(l.faceSize / 375).toBeGreaterThanOrEqual(0.7);
    expect(l.leftRail.width).toBeGreaterThanOrEqual(160);
    expect(l.rightRail.width).toBeGreaterThanOrEqual(160);
  });

  test('844x390 concrete numbers', () => {
    const l = landscapeLayout(844, 390, IPHONE_LAND_INSETS);
    expect(l.faceSize).toBe(335); // 86% of 390
    expect(l.face.cx).toBe(422);
    expect(l.leftRail.left).toBe(59);
    expect(l.rightRail.left + l.rightRail.width).toBe(844 - 59);
  });

  test('1194x834 concrete numbers', () => {
    const l = landscapeLayout(1194, 834, IPAD_INSETS);
    expect(l.faceSize).toBe(717); // 86% of 834
    expect(l.leftRail.width).toBe(207);
  });

  test('a short landscape phone (568x320) puts the menu beside the orb, still clear of the toggles', () => {
    const l = landscapeLayout(568, 320, {});
    const bs = CAPTURE_ORDER.map((k) => l.buttons[k]);
    for (const b of bs) {
      expect(b.height).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(b.top).toBeGreaterThanOrEqual(l.railTop.top + l.railTop.height);
      expect(b.top + b.height).toBeLessThanOrEqual(l.safe.bottom);
      expect(overlaps(b, l.orb)).toBe(false);
    }
  });

  test('side panels stay within the screen', () => {
    for (const [w, h] of [
      [844, 390],
      [1194, 834],
    ]) {
      const l = landscapeLayout(w, h, {});
      expect(l.transcriptDrawer.width).toBeLessThan(w * 0.5);
      expect(l.terminalPanel.width).toBeLessThanOrEqual(w * 0.52 + 1);
      expect(l.sideSheetWidth).toBeLessThanOrEqual(w * 0.55);
    }
  });
});
