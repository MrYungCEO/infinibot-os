/**
 * Touch router for the native 3D Agent Mesh (the web MeshWorldScene on expo-gl).
 *
 *   one finger drag  → orbit (sideways) + tilt (up / down)
 *   tap              → scene.tapAt (agent, else the building under it)
 *   two fingers      → pinch = zoom, drag = pan across the ground
 *
 * Pure (no React): the view feeds `start / move / end` with touch lists in
 * stage px, so the rules are unit-tested with a fake scene.
 */

export const TAP_SLOP = 8;
export const TAP_MS = 450;
/** Radians of orbit / tilt per px of finger travel. */
export const ORBIT_PER_PX = 0.008;
export const TILT_PER_PX = 0.005;
/** Ground pan per px of two-finger travel (scene.panBy units). */
export const PAN_PER_PX = 0.025;

function pair(a, b) {
  return { dist: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

export function createMesh3DTouchRouter(scene, opts = {}) {
  const now = opts.now || (() => Date.now());
  let mode = 'idle'; // idle | one | two | drain
  let start = null;
  let last = null;
  let moved = false;
  let two = null;

  return {
    get mode() {
      return mode;
    },

    start(touches) {
      if (!scene) return;
      if (touches.length >= 2) {
        mode = 'two';
        two = pair(touches[0], touches[1]);
        return;
      }
      if (mode !== 'idle' || touches.length !== 1) return;
      mode = 'one';
      start = { x: touches[0].x, y: touches[0].y, t: now() };
      last = { x: start.x, y: start.y };
      moved = false;
    },

    move(touches) {
      if (!scene) return;
      if (mode === 'one' && touches.length === 1) {
        const p = touches[0];
        if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > TAP_SLOP) moved = true;
        if (moved) {
          const dx = p.x - last.x;
          const dy = p.y - last.y;
          if (dx) scene.orbitBy(-dx * ORBIT_PER_PX);
          if (dy) scene.tiltBy(-dy * TILT_PER_PX);
        }
        last = { x: p.x, y: p.y };
        return;
      }
      if (mode === 'two' && touches.length >= 2) {
        const cur = pair(touches[0], touches[1]);
        if (two && two.dist > 0 && cur.dist > 0 && cur.dist !== two.dist) scene.zoomBy(two.dist / cur.dist, 0);
        if (two) {
          const dx = cur.mx - two.mx;
          const dy = cur.my - two.my;
          if (dx || dy) scene.panBy(-dx * PAN_PER_PX, -dy * PAN_PER_PX);
        }
        two = cur;
      }
    },

    /** `remaining` = touches still down; `at` = where the lifted finger left. */
    end(remaining, at) {
      if (!scene) return;
      if (mode === 'one') {
        const p = at || last || start;
        mode = 'idle';
        if (!moved && now() - start.t <= TAP_MS) scene.tapAt(p.x, p.y, true);
        return;
      }
      if (mode === 'two') {
        two = null;
        mode = remaining.length ? 'drain' : 'idle';
        return;
      }
      if (mode === 'drain' && !remaining.length) mode = 'idle';
    },

    cancel() {
      mode = 'idle';
      two = null;
    },
  };
}
