// label-layout.js — where the Agent Mesh's counter-scaled HUD text goes for a
// camera (pure; IsoLabels draws it). Web rules: hud.ts ZoneLabel scale
// clamp(1/k, 0.7, 2.2)·k; nameplates clamp(1/k, 0.32, 1.8)·k (active at
// k ≥ 0.5, resting at k ≥ 0.72); world-map-coder-builds.ts tags (5 full,
// then pills, max 12); review-mesh-layer.ts Auditor tag, "Screenshots · N"
// and the phone screenshot orbit (6 thumbs, k ≥ 0.32).
import { BACKEND_NAME, BUILD_COLOR, STATUS_COLOR } from '../../components/mesh/mesh-style';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const textW = (s, size, spacing = 0, k = 0.6) => s.length * (size * k + spacing);
export const ellip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const seedOdd = (key) => {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return (h & 1) === 1;
};

/** Pure: everything this layer draws + its tap targets, for a camera. */
export function layoutLabels({ cam, station, district, islands, agents, positions, auditor, screenshotCount, screenshots = [], size }) {
  const k = cam.k;
  const S = (p) => ({ x: p.x * k + cam.x, y: p.y * k + cam.y });
  const onScreen = (p, m = 120) => p.x > -m && p.y > -m && p.x < size.w + m && p.y < size.h + m;
  const out = { zones: [], plates: [], tags: [], pills: [], extra: 0, hits: [] };

  const zoneScale = clamp(1 / k, 0.7, 2.2) * k;
  const zone = (id, title, subtitle, p, alpha, accent, titleSize = 12) => {
    const s = S(p);
    if (!onScreen(s, 200)) return;
    out.zones.push({ id, title, subtitle, x: s.x, y: s.y, scale: zoneScale, alpha, accent, titleSize });
  };
  zone('hq', station.hq.title, station.hq.subtitle, station.hq, 0.9, null, 17);
  zone('exec', station.exec.label.title, station.exec.label.subtitle, station.exec.label, 0.6, null);
  const occupied = new Set([...positions.values()].map((v) => v.sectorId));
  for (const z of station.zones) zone(z.id, z.name, z.system, { x: z.top.x, y: z.top.y - 2 }, occupied.has(z.id) ? 0.55 : 0.25, z.accent);
  for (const r of district.rooms) zone(r.id, r.spec.title, r.spec.subtitle, { x: r.top.x, y: r.top.y - 2 }, occupied.has(r.id) ? 0.9 : 0.6, r.accent);
  for (const isl of islands) zone(`node:${isl.node.id}`, (isl.node.name || isl.node.id).toUpperCase(), `${isl.node.agentCount || 0} AGENTS · ${isl.node.status}`, isl.label, 0.85, null);

  // Nameplates + build tags.
  const plateScale = clamp(1 / k, 0.32, 1.8) * k;
  const builds = [];
  for (const a of agents) {
    const p = positions.get(a.sessionKey);
    if (!p) continue;
    const s = S(p);
    if (!onScreen(s)) continue;
    const resting = a.resting || ['completed', 'failed', 'idle', undefined, null].includes(a.status);
    if (a.coderBackend && !resting) {
      builds.push({ a, s });
      continue;
    }
    if (resting ? k < 0.72 : k < 0.5) continue;
    const text = ellip(String(a.label || a.agentId || a.sessionKey).toUpperCase(), resting ? 12 : 14);
    const sc = plateScale * (resting ? 0.8 : 1);
    const dy = resting ? -62 : 30 + (seedOdd(a.sessionKey) ? 19 : 0);
    out.plates.push({
      key: a.sessionKey, text, x: s.x, y: s.y + dy * k, scale: sc,
      color: STATUS_COLOR[a.status] || STATUS_COLOR.idle,
      progress: resting ? null : Math.max(0, Math.min(100, Number(a.progress) || 0)),
    });
  }
  // Coder build tags: newest activity first, 5 full tags, then compact pills (max 12).
  builds.sort((x, y) => (y.a.lastActivityAt || y.a.lastUpdateAt || 0) - (x.a.lastActivityAt || x.a.lastUpdateAt || 0));
  const tagScale = clamp(0.62 + k * 0.35, 0.62, 0.92);
  builds.forEach(({ a, s }, i) => {
    if (i >= 12) {
      out.extra += 1;
      return;
    }
    const color = a.status === 'failed' ? BUILD_COLOR.failed : a.status === 'completed' ? BUILD_COLOR.done : BUILD_COLOR[a.coderBackend] || BUILD_COLOR['claude-code'];
    const headY = s.y - (64 - 16) * k;
    const pct = a.status === 'completed' ? '100%' : a.status === 'failed' ? 'ERR' : Number(a.progress) > 0 ? `${Math.round(Math.min(100, Number(a.progress)))}%` : '';
    const sub = a.status === 'completed' ? 'Build complete' : `${BACKEND_NAME[a.coderBackend] || 'Coder'} · ${a.activityLabel || a.lastActivity?.label || 'Building'}`;
    if (i < 5) {
      const w = 212 * tagScale;
      const h = 54 * tagScale;
      const x = clamp(s.x - w / 2, 8, size.w - w - 8);
      const y = headY - 44 * tagScale - h;
      out.tags.push({ key: a.sessionKey, x, y, w, h, scale: tagScale, color, title: a.label || a.currentTask || a.agentId, pct, sub, progress: Number(a.progress) || 0, done: a.status === 'completed', leader: { x1: s.x, y1: y + h, x2: s.x, y2: headY - 2 } });
      out.hits.push({ kind: 'agent', key: a.sessionKey, x, y, w, h });
    } else {
      const w = 120 * tagScale;
      const h = 22 * tagScale;
      const x = clamp(s.x - w / 2, 8, size.w - w - 8);
      const y = headY - 14 * tagScale - h;
      out.pills.push({ key: a.sessionKey, x, y, w, h, scale: tagScale, color, title: a.label || a.agentId, pct });
      out.hits.push({ kind: 'agent', key: a.sessionKey, x, y, w, h });
    }
  });

  // Screenshot orbit (review-mesh-layer.ts, phone form): the latest 6 UI
  // screenshots in one row under the Executive Suite, hidden below zoom 0.32.
  out.thumbs = [];
  if (k >= 0.32 && screenshots.length) {
    const sc = clamp(k * 1.25, 0.55, 1.15);
    const w = 92 * sc;
    const h = 54 * sc;
    const gap = 8 * sc;
    const list = screenshots.slice(0, 6);
    const exec = station.exec;
    const base = S({ x: exec.center.x, y: exec.center.y + exec.platform.height / 2 + 52 });
    const total = list.length * w + (list.length - 1) * gap;
    list.forEach((shot, i) => {
      const x = base.x - total / 2 + i * (w + gap);
      const y = base.y;
      if (x > size.w || x + w < 0 || y > size.h || y + h < 0) return;
      out.thumbs.push({ key: shot.id || shot.path, x, y, w, h, scale: sc, shot });
      out.hits.push({ kind: 'thumb', shot, x, y, w, h: h + 16 * sc });
    });
  }

  // Auditor tag + screenshots button.
  if (auditor) {
    const s = S(auditor);
    if (onScreen(s, 200)) {
      const sc = clamp(k * 1.3, 0.8, 1.1);
      const tw = (textW('Auditor · Reviewer', 11, 0.4) + 34) * sc;
      const th = 22 * sc;
      const tag = { x: clamp(s.x - tw / 2, 6, size.w - tw - 6), y: s.y - 84 * k - th, w: tw, h: th, scale: sc };
      const label = `Screenshots · ${screenshotCount}`;
      const bw = (textW(label, 10.5, 0.2) + 30) * sc;
      // review-mesh-layer.ts: the tag floats over the shield, the button sits under the feet.
      const btn = { x: clamp(s.x - bw / 2, 6, size.w - bw - 6), y: s.y + 26 * sc * 0.5, w: bw, h: th, scale: sc, label };
      out.auditor = { tag, btn };
      out.hits.push({ kind: 'auditor', ...tag }, { kind: 'screenshots', ...btn });
    }
  }
  return out;
}

