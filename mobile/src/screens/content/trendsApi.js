// trendsApi — mobile bridge to the Trends / Research / News intelligence band.
//
// Mirrors the (in-flight) <trends-radar> component and consumes its FROZEN
// contract from src/content/trends/types.ts:
//   content.trends.last30days → TrendsBundle {
//     niche, keywords[], socialInsights[], newsTopics[], trendingFormats[],
//     generatedAt, sourcesConsulted, warnings[], origin
//   }
//
// The RPC is restart-gated (it ships on the feat/trends-radar branch). The web
// plan bakes a snapshot at ui/public/content-trends-snapshot.json for a single
// render path; that file does not exist yet, so we fetch it opportunistically
// over HTTP and fall back to a small bundled placeholder bundle (clearly marked
// origin:"snapshot") so the screen renders pre-restart instead of going blank.
//
// TODO(re-sync): once ui/public/content-trends-snapshot.json lands and the
// <trends-radar> component is finalized, confirm field names/shape against it
// and drop PLACEHOLDER_BUNDLE if a real baked snapshot is reliably served.

import { getHttpOrigin } from './contentIntelApi';

const PLACEHOLDER_BUNDLE = {
  niche: 'creator marketing',
  keywords: ['short-form', 'reels', 'hooks', 'retention'],
  socialInsights: [],
  newsTopics: [],
  trendingFormats: [],
  generatedAt: 0,
  sourcesConsulted: 0,
  warnings: ['Trends data activates after a gateway restart (content.trends.last30days).'],
  origin: 'snapshot',
};

export async function fetchTrends(gateway, opts = {}) {
  // 1) Live RPC.
  try {
    if (gateway?.sendReq) {
      const r = await gateway.sendReq('content.trends.last30days', opts);
      if (r && (Array.isArray(r.socialInsights) || Array.isArray(r.newsTopics) || Array.isArray(r.trendingFormats))) {
        return { ...PLACEHOLDER_BUNDLE, ...r, origin: r.origin || 'live' };
      }
    }
  } catch {
    /* RPC missing (un-restarted) → fall through to snapshot */
  }
  // 2) Baked snapshot served by the gateway (parity with the web fallback).
  const origin = await getHttpOrigin();
  if (origin) {
    try {
      const res = await fetch(`${origin}/content-trends-snapshot.json`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const snap = await res.json();
        return { ...PLACEHOLDER_BUNDLE, ...snap, origin: 'snapshot' };
      }
    } catch {
      /* fall through to placeholder */
    }
  }
  // 3) Bundled placeholder so the UI renders.
  return { ...PLACEHOLDER_BUNDLE };
}

export function fmtAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const h = Math.floor(diff / 3.6e6);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
