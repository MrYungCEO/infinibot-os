// contentIntelApi — mobile bridge to the Content Intelligence backend.
//
// Mirrors the control-UI Content Intelligence view (ui/src/ui/views/content-intel.ts)
// and consumes the SAME gateway RPCs so mobile and web render identical data:
//   content.intel.list   — all reels + totals + tier distribution
//   content.intel.get    — one reel (with transcript text)
//   content.intel.totals — cheap header poll
//   content.intel.capabilities / .score / .scoreBatch — live scoring (restart-gated)
//
// Payload shape is the FROZEN snake_case contract shared with the baked snapshot
// at ui/public/content-intel-snapshot.json, so there is ONE render path whether
// data comes from the live RPC or the static fallback. When the RPCs aren't yet
// registered (gateway not restarted), we fetch that snapshot over HTTP from the
// gateway origin — exactly what the web view does — so the screen renders pre-restart.
//
// Thumbnails + reel videos are served as static/Range-capable assets by the
// gateway (relative paths in the payload); assetUrl() resolves them to absolute
// URLs against the gateway HTTP origin derived from the WS gateway URL.

import { getGatewayUrl } from '../../utils/storage';

function req(gateway, method, params) {
  if (!gateway?.sendReq) return Promise.reject(new Error('Gateway not ready'));
  return gateway.sendReq(method, params || {});
}

// ── Gateway HTTP origin ───────────────────────────────────────────
// The gateway serves the control-UI WS and its static assets on the SAME
// origin. The mobile WS URL is e.g. ws://<gateway-host>:18789[/path]; the
// static/HTTP origin is the http(s):// equivalent with no path.
let _originCache = null;
export async function getHttpOrigin() {
  if (_originCache) return _originCache;
  try {
    const wsUrl = await getGatewayUrl();
    if (!wsUrl) return '';
    const m = /^(wss?|https?):\/\/([^/]+)/i.exec(wsUrl);
    if (!m) return '';
    const proto = /^(wss|https)/i.test(m[1]) ? 'https' : 'http';
    _originCache = `${proto}://${m[2]}`;
    return _originCache;
  } catch {
    return '';
  }
}
// Reset when the gateway URL changes (Settings save).
export function resetHttpOrigin() {
  _originCache = null;
}

// Resolve a relative asset path (thumbnail / video) to an absolute URL.
// Absolute URLs (remote og:image) are returned unchanged.
export function assetUrl(origin, path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!origin) return null;
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

// The reel video is deterministically served at this Range-capable route, so we
// build the URL from the shortcode rather than depending on the (in-flux) RPC
// `video_url` field. Mirrors src/gateway/content-intel-video-http.ts.
// TODO(re-sync): if the gateway exposes a different video route, prefer the
// reel's `video_url` field when present.
export function videoUrl(origin, reel) {
  if (!reel?.shortcode) return null;
  if (reel.video_url) return assetUrl(origin, reel.video_url);
  if (!origin) return null;
  return `${origin}/plugins/content-studio/video?shortcode=${encodeURIComponent(reel.shortcode)}`;
}

// ── List / get ────────────────────────────────────────────────────
// Returns the full payload { account, totals, tier_distribution, reels, source }.
// source is 'live' (RPC) or 'snapshot' (HTTP fallback), matching the web badge.
export async function fetchIntel(gateway) {
  try {
    const r = await req(gateway, 'content.intel.list', { limit: 2000 });
    if (r && Array.isArray(r.reels)) {
      return { ...r, source: 'live' };
    }
    throw new Error('empty list');
  } catch {
    // Fallback to the baked snapshot served by the gateway (pre-restart path).
    const origin = await getHttpOrigin();
    if (origin) {
      try {
        const res = await fetch(`${origin}/content-intel-snapshot.json`, {
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const snap = await res.json();
          return { ...snap, source: 'snapshot' };
        }
      } catch {
        /* fall through to empty */
      }
    }
    return { account: '', totals: null, tier_distribution: {}, reels: [], source: 'error' };
  }
}

// Fetch one reel WITH transcript text (lazy; only the live RPC returns text).
export async function fetchReel(gateway, shortcode) {
  try {
    const r = await req(gateway, 'content.intel.get', { shortcode });
    return r?.reel || null;
  } catch {
    return null;
  }
}

// ── Live scoring (restart-gated) ──────────────────────────────────
// Presence of content.intel.capabilities tells us the scoring RPCs are live.
export async function fetchCapabilities(gateway) {
  try {
    return await req(gateway, 'content.intel.capabilities', {});
  } catch {
    return null; // un-restarted gateway → scoring disabled
  }
}

export const scoreReel = (gateway, shortcode) =>
  req(gateway, 'content.intel.score', { shortcode });

export const scoreBatch = (gateway, limit) =>
  req(gateway, 'content.intel.scoreBatch', limit ? { limit } : {});

export const cancelBatch = (gateway) =>
  req(gateway, 'content.intel.scoreBatchCancel', {});

export const PROGRESS_EVENT = 'content.intel.progress';

// ── Derived display helpers (parity with the web view) ────────────
export function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Engagement rate = (likes + comments + shares + saves) / reach.
export function engagementRate(r) {
  const reach = r?.reach || 0;
  if (!reach) return null;
  const eng = (r.likes || 0) + (r.comments || 0) + (r.shares || 0) + (r.saves || 0);
  return (eng / reach) * 100;
}

// Tier → class bucket, mirroring the web tierClass() (S/A bright, B/C/D dimmer).
export function tierClass(tier) {
  const t = (tier || '').trim().toUpperCase();
  if (t === 'S' || t === 'A') return 'a';
  if (t === 'B') return 'b';
  if (t === 'C') return 'c';
  if (t === 'D') return 'd';
  return 'none';
}
