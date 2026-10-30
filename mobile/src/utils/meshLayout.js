/**
 * meshLayout — pure geometry helpers for the agent neural map.
 *
 * Extracted from NeuralMeshScreen so the force-directed spacing pass and the
 * camera-follow math can be unit-tested in a plain Node environment (no RN /
 * Expo native deps). Everything here is deterministic — no Math.random, no
 * Date.now — so positions are stable across recomputes (a re-render must not
 * make planets jump).
 */

/** Stable 0..1 hash of a string (deterministic jitter / seeding). */
export function seedHash(s) {
  let h = 0;
  const str = String(s || 'x');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h % 1000) / 1000;
}

/**
 * Latest activity timestamp (ms) for an agent — used to rank "follow active".
 * Accepts numbers or parseable date strings across several possible fields.
 */
export function agentRecency(a) {
  const vals = [
    a && a.lastActivity && a.lastActivity.at,
    a && a.lastUpdateAt,
    a && a.lastActivity,
    a && a.startedAt,
    a && a.createdAt,
  ];
  let best = 0;
  for (const v of vals) {
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

/**
 * Camera pan offsets that center world-point `target` on screen, given the
 * current zoom. Matches the RN transform `[translate, scale]` whose origin is
 * the view centre: screen(p) = pan + centre + zoom*(p - centre); solving for
 * screen(target) === centre gives pan = -zoom*(target - centre).
 */
export function desiredPan(target, canvas, zoom) {
  return {
    x: -(target.x - canvas.width / 2) * zoom,
    y: -(target.y - canvas.height / 2) * zoom,
  };
}

/**
 * Force-directed spacing pass.
 *
 * @param groups  Array<{ node:{ id, hub:{x,y} }, agents:Array<{id?,sessionKey?}> }>
 * @param width   viewport width
 * @param height  viewport height
 * @param opts    { ticks=120, minDist, orbitBase=70, repulse=1400, spring=0.018 }
 * @returns Map<agentId,{x,y}>
 *
 * Coulomb-style repulsion (1/r²) keeps planets from overlapping; a hard
 * minimum-distance push guarantees ≥ minDist separation; a light spring pulls
 * each node toward its parent hub; positions are clamped to the viewport. The
 * caller runs this once per agent-set change and then FREEZES the result.
 */
export function computeForceLayout(groups, width, height, opts = {}) {
  const ticks = opts.ticks != null ? opts.ticks : 120;
  const minDist = opts.minDist != null ? opts.minDist : 35;
  const orbitBase = opts.orbitBase != null ? opts.orbitBase : 70;
  const REPULSE = opts.repulse != null ? opts.repulse : 1400;
  const SPRING = opts.spring != null ? opts.spring : 0.018;
  const MAXV = 16;
  const pad = 44;

  const items = [];
  (groups || []).forEach((g) => {
    const hub = g.node.hub;
    const n = g.agents.length;
    const seedRing = orbitBase + Math.min(n, 8) * 4;
    g.agents.forEach((a, i) => {
      const id = a.id || a.sessionKey || `${g.node.id}:${i}`;
      const s = seedHash(id);
      const ang = (i / Math.max(n, 1)) * Math.PI * 2 + s * 0.6;
      items.push({
        id,
        x: hub.x + Math.cos(ang) * seedRing,
        y: hub.y + Math.sin(ang) * seedRing,
        hx: hub.x,
        hy: hub.y,
        vx: 0,
        vy: 0,
      });
    });
  });

  const map = new Map();
  if (items.length === 0) return map;
  if (items.length === 1) {
    map.set(items[0].id, { x: items[0].x, y: items[0].y });
    return map;
  }

  for (let t = 0; t < ticks; t++) {
    for (let i = 0; i < items.length; i++) {
      const A = items[i];
      let fx = 0;
      let fy = 0;
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const B = items[j];
        let dx = A.x - B.x;
        let dy = A.y - B.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = seedHash(A.id + B.id) - 0.5;
          dy = seedHash(B.id + A.id) - 0.5;
          d2 = dx * dx + dy * dy + 0.01;
        }
        const d = Math.sqrt(d2);
        const f = REPULSE / d2;
        fx += (dx / d) * f;
        fy += (dy / d) * f;
        if (d < minDist) {
          const push = (minDist - d) * 0.5;
          fx += (dx / d) * push;
          fy += (dy / d) * push;
        }
      }
      fx += (A.hx - A.x) * SPRING;
      fy += (A.hy - A.y) * SPRING;
      A.vx = A.vx * 0.6 + fx * 0.5;
      A.vy = A.vy * 0.6 + fy * 0.5;
      const sp = Math.hypot(A.vx, A.vy);
      if (sp > MAXV) {
        A.vx = (A.vx / sp) * MAXV;
        A.vy = (A.vy / sp) * MAXV;
      }
    }
    for (const A of items) {
      A.x += A.vx;
      A.y += A.vy;
      A.x = Math.max(pad, Math.min(width - pad, A.x));
      A.y = Math.max(pad, Math.min(height - pad, A.y));
    }
  }

  items.forEach((A) => map.set(A.id, { x: A.x, y: A.y }));
  return map;
}
