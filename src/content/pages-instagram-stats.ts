/**
 * Live Instagram Graph API stats for a content page.
 * In-process 5-minute cache keyed by page ID.
 * Does NOT modify instagram-client.ts (Agent #6 owns that file).
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { InstagramClient } from "../funnels/integrations/instagram-client.js";
import { readInstagramSecrets } from "./instagram-secrets.js";
import { readCachedStats, writeCachedStats } from "./instagram-stats-cache.js";
import type { ContentPage } from "./types.js";

const log = createSubsystemLogger("content-instagram");

export interface InstagramPageStats {
  followers: number;
  reach30d: number;
  /** null when Meta has dropped impressions for this account type */
  impressions30d: number | null;
  /** 30-element array, oldest → newest; padded with zeros when API returns fewer */
  reachSparkline: number[];
  topMedia: Array<{
    id: string;
    permalink: string;
    thumbnail?: string;
    reach: number;
    likes: number;
    comments: number;
    saves: number;
  }>;
  fetchedAt: number;
  fromCache: boolean;
  /** True when fresh fetch failed and we returned the on-disk last-known-good copy. */
  staleFromDisk?: boolean;
  /** Age of the returned stats in ms (now − fetchedAt for fresh-cache, now − savedAt for disk). 0 when freshly fetched. */
  ageMs: number;
  error?: { code: string; message: string };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map<string, { stats: InstagramPageStats; expiresAt: number }>();

/** Drop the in-memory cache entry for a page (used by forceRefresh callers). */
export function dropInMemoryCache(pageId: string): void {
  _cache.delete(pageId);
}

function resolveToken(page: ContentPage): string | null {
  const ig = page.integrations?.instagramGraph;
  // accessTokenRef may be the raw token or a vault key — use as-is for now
  if (ig?.accessTokenRef) return ig.accessTokenRef;
  const secrets = readInstagramSecrets();
  if (secrets?.accessToken) return secrets.accessToken;
  return null;
}

const SPARKLINE_LEN = 30;

function padSparkline(values: number[]): number[] {
  if (values.length >= SPARKLINE_LEN) return values.slice(-SPARKLINE_LEN);
  return [...new Array(SPARKLINE_LEN - values.length).fill(0), ...values];
}

export async function getInstagramPageStats(
  page: ContentPage,
  opts?: { forceRefresh?: boolean },
): Promise<InstagramPageStats | null> {
  if (page.integrations?.instagramGraph?.connected !== true) return null;

  const now = Date.now();

  if (opts?.forceRefresh) {
    _cache.delete(page.id);
  } else {
    const cached = _cache.get(page.id);
    if (cached && cached.expiresAt > now) {
      return {
        ...cached.stats,
        fromCache: true,
        ageMs: now - cached.stats.fetchedAt,
      };
    }
  }

  const token = resolveToken(page);
  if (!token) {
    // Try disk fallback even when no token — last-known-good beats zeros.
    const disk = readCachedStats(page.id);
    if (disk) {
      log.info("[content-instagram] returning disk-cached stats — no token", {
        pageId: page.id,
        savedAt: disk.savedAt,
      });
      return {
        ...disk.stats,
        fetchedAt: disk.savedAt,
        fromCache: true,
        staleFromDisk: true,
        ageMs: now - disk.savedAt,
        error: { code: "NO_TOKEN", message: "No Instagram access token configured for this page" },
      };
    }
    return {
      followers: 0,
      reach30d: 0,
      impressions30d: null,
      reachSparkline: new Array(SPARKLINE_LEN).fill(0),
      topMedia: [],
      fetchedAt: now,
      fromCache: false,
      ageMs: 0,
      error: { code: "NO_TOKEN", message: "No Instagram access token configured for this page" },
    };
  }

  // Never log raw token
  const tokenPreview = `${token.slice(0, 6)}…`;
  const igUserId = page.integrations?.instagramGraph?.igPageId;
  const client = new InstagramClient(token, igUserId);

  let followers = 0;
  let reach30d = 0;
  let impressions30d: number | null = null;
  let reachSparkline: number[] = new Array(SPARKLINE_LEN).fill(0);
  let topMedia: InstagramPageStats["topMedia"] = [];
  let firstError: { code: string; message: string } | undefined;

  // Fire all three Graph calls in parallel — they're independent.
  const [profileRes, insightsRes, mediaRes] = await Promise.allSettled([
    client.getProfile(),
    client.getProfileInsights("day"),
    client.getMediaWithInsights(10),
  ]);

  let profileOk = false;
  let insightsOk = false;
  let mediaOk = false;

  if (profileRes.status === "fulfilled") {
    profileOk = true;
    followers = profileRes.value.followers_count ?? 0;
    log.info("[content-instagram] profile fetched", { pageId: page.id, tokenPreview, followers });
  } else {
    const msg = (profileRes.reason as Error)?.message ?? String(profileRes.reason);
    log.warn("[content-instagram] getProfile failed", { pageId: page.id, error: msg });
    if (!firstError) firstError = { code: "PROFILE_ERROR", message: msg };
  }

  if (insightsRes.status === "fulfilled") {
    insightsOk = true;
    const insightsData = insightsRes.value;
    reach30d = insightsData.reach ?? 0;
    impressions30d =
      typeof insightsData.impressions === "number" && insightsData.impressions > 0
        ? insightsData.impressions
        : null;
    reachSparkline = padSparkline([reach30d]);
    log.info("[content-instagram] insights fetched", { pageId: page.id, reach30d, impressions30d });
  } else {
    const msg = (insightsRes.reason as Error)?.message ?? String(insightsRes.reason);
    log.warn("[content-instagram] getProfileInsights failed", { pageId: page.id, error: msg });
    if (!firstError) firstError = { code: "INSIGHTS_ERROR", message: msg };
  }

  if (mediaRes.status === "fulfilled") {
    mediaOk = true;
    const media = mediaRes.value;
    topMedia = media
      .map((m) => ({
        id: m.id,
        permalink: m.permalink,
        thumbnail: m.thumbnail_url ?? m.media_url,
        reach: m.insights?.reach ?? 0,
        likes: m.like_count ?? 0,
        comments: m.comments_count ?? 0,
        saves: m.insights?.saved ?? 0,
      }))
      .sort((a, b) => b.reach - a.reach)
      .slice(0, 5);
    log.info("[content-instagram] media fetched", { pageId: page.id, count: topMedia.length });
  } else {
    const msg = (mediaRes.reason as Error)?.message ?? String(mediaRes.reason);
    log.warn("[content-instagram] getMediaWithInsights failed", { pageId: page.id, error: msg });
    if (!firstError) firstError = { code: "MEDIA_ERROR", message: msg };
  }

  log.info(
    `[content-instagram] page=${page.id} followers=${followers} reach30d=${reach30d} cached=false`,
  );

  const allFailed = !profileOk && !insightsOk && !mediaOk;
  const zeroResult = followers === 0 && reach30d === 0 && topMedia.length === 0;

  // If every sub-fetch errored OR we got nothing usable, fall back to last-known-good on disk.
  if (allFailed || zeroResult) {
    const disk = readCachedStats(page.id);
    if (disk) {
      log.warn("[content-instagram] live fetch empty/failed — returning disk fallback", {
        pageId: page.id,
        savedAt: disk.savedAt,
        allFailed,
        zeroResult,
        firstError,
      });
      const fallback: InstagramPageStats = {
        ...disk.stats,
        fetchedAt: disk.savedAt,
        fromCache: true,
        staleFromDisk: true,
        ageMs: now - disk.savedAt,
        ...(firstError ? { error: firstError } : {}),
      };
      // Don't poison the in-memory cache with disk-fallback; keep memory empty so
      // the next call retries live.
      return fallback;
    }
  }

  const stats: InstagramPageStats = {
    followers,
    reach30d,
    impressions30d,
    reachSparkline,
    topMedia,
    fetchedAt: now,
    fromCache: false,
    ageMs: 0,
    ...(allFailed && firstError ? { error: firstError } : {}),
  };

  _cache.set(page.id, { stats, expiresAt: now + CACHE_TTL_MS });

  // Persist last-known-good to disk on every success-ish path (any non-empty fetch).
  if (!zeroResult) {
    try {
      writeCachedStats(page.id, stats);
    } catch (e) {
      log.warn("[content-instagram] writeCachedStats failed", {
        pageId: page.id,
        error: (e as Error).message,
      });
    }
  }

  return stats;
}
