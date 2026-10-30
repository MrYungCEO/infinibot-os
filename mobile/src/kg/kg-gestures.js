/**
 * Touch router for the native Knowledge Graph stage.
 *
 * Maps raw React Native touches onto the shared 3D stage (the same
 * KnowledgeGraph3DStage the web graph runs):
 *
 *   one finger on a node      → node drag (drop on a project = move), or a
 *                               link drag in link mode — the stage owns it
 *   one finger on empty space → orbit (select mode: lasso)
 *   tap                       → select / peek (empty: clear, super-node: open)
 *   double tap on a node      → open it
 *   long press                → context menu (the stage's own 520 ms timer)
 *   two fingers               → pinch = dolly (2D: zoom about the fingers),
 *                               drag = pan, twist = spin (3D)
 *
 * Pure (no React): the screen feeds it `start / move / end` with touch lists
 * in stage px, so the gesture rules are unit-tested with a fake stage.
 */

export const ORBIT_SLOP = 6;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

function pointer(p, type, down) {
  return {
    x: p.x,
    y: p.y,
    pointerType: 'touch',
    button: 0,
    buttons: down ? 1 : 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    type,
  };
}

function twoFinger(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { dist: Math.hypot(dx, dy), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, angle: Math.atan2(dy, dx) };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function createTouchRouter(stage, opts = {}) {
  const now = opts.now || (() => Date.now());
  let mode = 'idle'; // idle | one | two | drain (fingers still down after a pinch)
  let start = null;
  let last = null;
  let orbiting = false;
  let moved = false;
  let pair = null;
  let lastTap = null;

  const api = {
    get mode() {
      return mode;
    },

    /** Touches currently down (after the change). */
    start(touches) {
      if (!stage) return;
      if (touches.length >= 2) {
        if (mode === 'one') stage.pointerCancel();
        mode = 'two';
        pair = twoFinger(touches[0], touches[1]);
        return;
      }
      if (mode !== 'idle' || touches.length !== 1) return;
      mode = 'one';
      start = { x: touches[0].x, y: touches[0].y };
      last = { ...start };
      orbiting = false;
      moved = false;
      stage.pointerDown(pointer(start, 'pointerdown', true));
    },

    move(touches) {
      if (!stage) return;
      if (mode === 'one' && touches.length === 1) {
        const p = touches[0];
        if (Math.hypot(p.x - start.x, p.y - start.y) > 4) moved = true;
        const owned = stage.pointerMove(pointer(p, 'pointermove', true));
        if (!owned) {
          if (!orbiting && Math.hypot(p.x - start.x, p.y - start.y) > ORBIT_SLOP) orbiting = true;
          if (orbiting) stage.orbitBy(p.x - last.x, p.y - last.y);
        }
        last = { x: p.x, y: p.y };
        return;
      }
      if (mode === 'two' && touches.length >= 2) {
        const cur = twoFinger(touches[0], touches[1]);
        // Zoom about the previous midpoint, then pan it onto the new one (the 2D
        // map keeps the world point under the fingers; the 3D stage ignores x, y).
        if (pair && pair.dist > 0 && cur.dist > 0) stage.dollyBy(cur.dist / pair.dist, pair.mx, pair.my);
        if (pair) stage.panBy(cur.mx - pair.mx, cur.my - pair.my);
        if (pair) stage.twistBy(wrapAngle(cur.angle - pair.angle));
        pair = cur;
      }
    },

    /** `remaining` = touches still down; `at` = where the lifted finger left. */
    end(remaining, at) {
      if (!stage) return;
      if (mode === 'one') {
        const p = at || last || start;
        mode = 'idle';
        stage.pointerUp(pointer(p, 'pointerup', false));
        if (!moved) {
          const t = now();
          if (lastTap && t - lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < DOUBLE_TAP_PX) {
            lastTap = null;
            stage.doubleTapAt(p.x, p.y);
          } else lastTap = { t, x: p.x, y: p.y };
        } else lastTap = null;
        return;
      }
      if (mode === 'two') {
        pair = null;
        lastTap = null;
        mode = remaining.length ? 'drain' : 'idle';
        return;
      }
      if (mode === 'drain' && !remaining.length) mode = 'idle';
    },

    /** The responder was taken away (scroll view, system gesture). */
    cancel() {
      if (mode === 'one') stage?.pointerCancel();
      mode = 'idle';
      pair = null;
    },
  };
  return api;
}

/** Mouse wheel (web export) → the same dolly OrbitControls applies. */
export function wheelRatio(deltaY) {
  const d = Math.max(-200, Math.min(200, deltaY));
  return Math.pow(0.95, d * 0.05);
}
