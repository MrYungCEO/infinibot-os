/**
 * layout — pure geometry for the Infini call screen (no React, no RN).
 *
 * The character is the hero in both orientations: always horizontally
 * centred on the screen, as big as the free space allows. Quick capture
 * (note / idea / task / project / log) is ONE small "+" orb that fans out a
 * labelled mini-menu on tap, so it never takes a row of its own.
 *
 * Portrait
 *   ┌──────────────────────────────┐
 *   │ ✕  ( target chip )   🔊  ⚙   │ header (light, ghost buttons)
 *   │                              │
 *   │          ( ∞ face )          │ ~90% of the width, centred in the
 *   │                              │ free area between header and info
 *   │                 [ Note    ]  │
 *   │   ● LISTENING   [ Idea    ]  │ capture menu (only while open) fans
 *   │   "Listening…"  [ Task    ]  │ up from the orb, right-aligned
 *   │                 [ Project ]  │
 *   │                 [ Log     ]  │
 *   │ (☰)      (🎙)(⌨)(⏹)     (+) │ dock: transcript · mic/type/end · capture orb
 *   └──────────────────────────────┘
 *
 * Landscape
 *   ┌───────────┬───────────────────────┬───────────┐
 *   │ ✕  ⚙  🔊  │                       │    ☰  >_  │
 *   │ (chip)    │                       │           │
 *   │ status    │       ( ∞ face )      │ [ Note  ] │ menu (while open)
 *   │           │  ~86% of the height,  │ [  …    ] │
 *   │ (⌨)(🎙)(⏹)│  horizontally centred │       (+) │ capture orb
 *   └───────────┴───────────────────────┴───────────┘
 *     left rail                            right rail
 *
 * All rectangles are in the screen's coordinates and sit inside the
 * safe-area insets (pass the insets that apply to the screen's own box —
 * see effectiveInsets — so an app banner above the screen is respected).
 */

export const CAPTURE_ORDER = ['note', 'idea', 'task', 'project', 'log'];

export const MIN_TOUCH = 44;
export const SIDE = 16; // portrait side gutter
const GAP = 12;
const HEADER_H = 48;
const INFO_H = 84;
const TALK_H = 56;
export const ORB = 52; // dock buttons and the capture orb
const MENU_ITEM_H = MIN_TOUCH;
const MENU_W = 148;
const COL_MIN = 168;
const FACE_GAP = 20; // room for the glow ring between the face and the rails
const COL_MAX = 300;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Distance from the face centre to the nearest screen edge — how far its glow/ripples may reach. */
export function edgeRoom(cx, cy, width, height) {
  return Math.max(0, Math.min(cx, width - cx, cy, height - cy));
}

/** True when the window is wider than it is tall. */
export function isLandscape(width, height) {
  return width > height;
}

/**
 * Insets for the screen's own box. When an app-level banner sits above the
 * screen (box shorter than the window), the banner already covers the top
 * inset, so only what is left of it applies.
 */
export function effectiveInsets(insets = {}, windowHeight, boxHeight) {
  const covered = windowHeight && boxHeight && boxHeight < windowHeight ? windowHeight - boxHeight : 0;
  return {
    top: Math.max(0, (insets.top || 0) - covered),
    bottom: insets.bottom || 0,
    left: insets.left || 0,
    right: insets.right || 0,
  };
}

/**
 * The capture mini-menu: `kinds.length` labelled pills stacked upward from
 * just above `bottom`, right edge at `right`. Item 0 is on top.
 */
function captureMenu(kinds, right, bottom, width, gap) {
  const h = MENU_ITEM_H * kinds.length + gap * (kinds.length - 1);
  const menu = { left: right - width, top: bottom - h, width, height: h };
  const buttons = {};
  kinds.forEach((kind, i) => {
    buttons[kind] = { left: menu.left, top: menu.top + i * (MENU_ITEM_H + gap), width, height: MENU_ITEM_H };
  });
  return { menu, buttons };
}

/** Portrait: light header on top, one slim dock at the bottom, the face centred in between. */
export function portraitLayout(width, height, insets = {}, opts = {}) {
  const kinds = opts.kinds || CAPTURE_ORDER;
  const T = Math.max(insets.top || 0, 12);
  const B = height - Math.max(insets.bottom || 0, 12);
  const innerW = width - SIDE * 2;

  const header = { left: SIDE, top: T + 4, width: innerW, height: HEADER_H };
  const talk = { left: SIDE, top: B - TALK_H, width: innerW, height: TALK_H };
  const info = { left: SIDE, top: talk.top - GAP - INFO_H, width: innerW, height: INFO_H };

  // Dock slots: transcript on the left, the capture orb on the right, the
  // mic / type / end group centred between them.
  const slotTop = talk.top + (TALK_H - ORB) / 2;
  const dock = {
    transcript: { left: talk.left, top: slotTop, width: ORB, height: ORB },
    orb: { left: talk.left + innerW - ORB, top: slotTop, width: ORB, height: ORB },
    center: { left: talk.left + ORB + GAP, top: talk.top, width: innerW - (ORB + GAP) * 2, height: TALK_H },
  };
  const { menu, buttons } = captureMenu(kinds, dock.orb.left + ORB, talk.top - 10, Math.min(MENU_W, innerW), 8);

  // Free area for the hero.
  const freeTop = header.top + header.height + 8;
  const freeBottom = info.top - 4;
  const freeH = Math.max(0, freeBottom - freeTop);
  const faceSize = Math.floor(Math.max(0, Math.min(width * 0.9, freeH - 8, 720)));
  const cx = width / 2;
  const cy = freeTop + freeH / 2;
  const face = { left: cx - faceSize / 2, top: cy - faceSize / 2, size: faceSize, cx, cy, room: edgeRoom(cx, cy, width, height) };

  return {
    orientation: 'portrait',
    safe: { left: 0, right: width, top: T, bottom: B },
    faceSize,
    face,
    free: { top: freeTop, bottom: freeBottom },
    header,
    info,
    talk,
    dock,
    orb: dock.orb,
    menu,
    buttons,
    sheetHeight: Math.round(Math.min(height * 0.62, 560)),
  };
}

/** Landscape: the face centred on the screen, slim control rails on both sides. */
export function landscapeLayout(width, height, insets = {}, opts = {}) {
  const kinds = opts.kinds || CAPTURE_ORDER;
  const L = Math.max(insets.left || 0, GAP);
  const R = width - Math.max(insets.right || 0, GAP);
  const T = Math.max(insets.top || 0, 10);
  const B = height - Math.max(insets.bottom || 0, 10);
  const availH = B - T;
  const cx = width / 2;
  const cy = T + availH / 2;

  // Face: ~86% of the height, shrunk only if the side rails would get too thin.
  const halfRoom = Math.min(cx - L, R - cx) - FACE_GAP - COL_MIN;
  const faceSize = Math.floor(Math.max(0, Math.min(height * 0.86, availH - 4, halfRoom * 2)));
  const face = { left: cx - faceSize / 2, top: cy - faceSize / 2, size: faceSize, cx, cy, room: edgeRoom(cx, cy, width, height) };

  const leftW = Math.round(clamp(face.left - FACE_GAP - L, 0, COL_MAX));
  const rightW = Math.round(clamp(R - (face.left + faceSize) - FACE_GAP, 0, COL_MAX));
  const leftRail = { left: L, top: T, width: leftW, height: availH };
  const rightRail = { left: R - rightW, top: T, width: rightW, height: availH };

  // Right rail: transcript / terminal toggles on top, the capture orb at the
  // bottom; its menu fans up between them (or beside the orb on short screens).
  const railTop = { left: rightRail.left, top: T, width: rightW, height: MIN_TOUCH };
  const orb = { left: R - ORB, top: B - ORB, width: ORB, height: ORB };
  const menuW = Math.min(MENU_W, rightW);
  const gap = 6;
  const menuH = MENU_ITEM_H * kinds.length + gap * (kinds.length - 1);
  const stacked = orb.top - 10 - menuH >= railTop.top + railTop.height + 6;
  const { menu, buttons } = stacked
    ? captureMenu(kinds, R, orb.top - 10, menuW, gap)
    : captureMenu(kinds, orb.left - 10, B, Math.min(MENU_W, rightW - ORB - 10), gap);

  // Slide-over panels.
  const drawerW = Math.round(Math.min(400, width * 0.46));
  const transcriptDrawer = { width: drawerW + (insets.left || 0), padLeft: insets.left || 0 };
  const terminalPanel = { width: Math.round(Math.min(460, width * 0.52)) + (insets.right || 0), padRight: insets.right || 0 };

  return {
    orientation: 'landscape',
    safe: { left: L, right: R, top: T, bottom: B },
    faceSize,
    face,
    leftRail,
    rightRail,
    railTop,
    orb,
    menu,
    buttons,
    transcriptDrawer,
    terminalPanel,
    sideSheetWidth: Math.round(Math.min(440, width * 0.55)),
  };
}

/** One entry point: picks the layout for the current box. */
export function infiniLayout(width, height, insets = {}, opts = {}) {
  return isLandscape(width, height) ? landscapeLayout(width, height, insets, opts) : portraitLayout(width, height, insets, opts);
}
