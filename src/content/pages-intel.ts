/**
 * Content page ↔ Content Intelligence bridge (read-only).
 *
 * Connects a content page to the reel / YouTube library in content-intel.db
 * by handle: an Instagram page reads the reels whose `account` matches
 * `links.intelAccount` (default: the page handle without "@"); a YouTube
 * page reads the `youtube_channels` row whose id is `links.youtubeChannelId`
 * or whose handle matches the page handle. Nothing here writes to the intel
 * store.
 */

import type { ContentIntelStore } from "./intelligence/store.js";
import type { ContentPage } from "./types.js";

export interface PageIntelReel {
  shortcode: string;
  url: string | null;
  description: string | null;
  publishTime: string | null;
  views: number | null;
  saves: number | null;
  likes: number | null;
  tier: string | null;
  viral: number | null;
  overall: number | null;
}

export interface PageIntelYoutubeVideo {
  videoId: string;
  title: string | null;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  thumbnailUrl: string | null;
}

export type PageIntel =
  | {
      source: "instagram";
      account: string;
      linked: boolean;
      totals: { reels: number; scored: number; transcribed: number; views: number; saves: number };
      tiers: Record<string, number>;
      avgScores: {
        hook: number | null;
        value: number | null;
        viral: number | null;
        overall: number | null;
      };
      topReels: PageIntelReel[];
    }
  | {
      source: "youtube";
      handle: string | null;
      linked: boolean;
      channel: {
        channelId: string;
        name: string | null;
        handle: string | null;
        subscriberCount: number | null;
        videoCount: number | null;
      } | null;
      topVideos: PageIntelYoutubeVideo[];
    }
  | { source: "none"; linked: false };

export function normalizeHandle(h: string | undefined | null): string {
  return (h ?? "").trim().replace(/^@/, "").toLowerCase();
}

/** The reels.account a page maps to, or "" when it has none. */
export function intelAccountForPage(page: ContentPage): string {
  return normalizeHandle(page.links.intelAccount || page.handle);
}

export function getPageIntel(store: ContentIntelStore, page: ContentPage, limit = 5): PageIntel {
  const db = store.db;
  if (page.surface === "instagram") {
    const account = intelAccountForPage(page);
    const where = "lower(r.account) = ?";
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS reels,
                COALESCE(SUM(r.has_score),0) AS scored,
                COALESCE(SUM(r.has_transcript),0) AS transcribed,
                COALESCE(SUM(m.views),0) AS views,
                COALESCE(SUM(m.saves),0) AS saves
           FROM reels r
           LEFT JOIN reel_metrics m ON m.shortcode = r.shortcode
             AND m.rowid = (SELECT rowid FROM reel_metrics WHERE shortcode = r.shortcode
                             ORDER BY captured_at DESC, rowid DESC LIMIT 1)
          WHERE ${where}`,
      )
      .get(account) as {
      reels: number;
      scored: number;
      transcribed: number;
      views: number;
      saves: number;
    };
    const tierRows = db
      .prepare(
        `SELECT s.tier AS tier, COUNT(*) AS n FROM scores s JOIN reels r ON r.shortcode = s.shortcode
          WHERE ${where} GROUP BY s.tier ORDER BY s.tier`,
      )
      .all(account) as Array<{ tier: string; n: number }>;
    const avg = db
      .prepare(
        `SELECT AVG(s.hook) AS hook, AVG(s.value) AS value, AVG(s.viral) AS viral, AVG(s.overall) AS overall
           FROM scores s JOIN reels r ON r.shortcode = s.shortcode WHERE ${where}`,
      )
      .get(account) as Record<string, number | null>;
    const top = db
      .prepare(
        `SELECT r.shortcode, r.url, r.description, r.publish_time, m.views, m.saves, m.likes,
                s.tier, s.viral, s.overall
           FROM reels r
           LEFT JOIN reel_metrics m ON m.shortcode = r.shortcode
             AND m.rowid = (SELECT rowid FROM reel_metrics WHERE shortcode = r.shortcode
                             ORDER BY captured_at DESC, rowid DESC LIMIT 1)
           LEFT JOIN scores s ON s.shortcode = r.shortcode
          WHERE ${where}
          ORDER BY COALESCE(m.views, 0) DESC
          LIMIT ?`,
      )
      .all(account, limit) as Array<Record<string, unknown>>;
    const round = (v: unknown) => (typeof v === "number" ? Math.round(v * 10) / 10 : null);
    return {
      source: "instagram",
      account,
      linked: totals.reels > 0,
      totals,
      tiers: Object.fromEntries(tierRows.map((t) => [t.tier, t.n])),
      avgScores: {
        hook: round(avg.hook),
        value: round(avg.value),
        viral: round(avg.viral),
        overall: round(avg.overall),
      },
      topReels: top.map((r) => ({
        shortcode: r.shortcode as string,
        url: (r.url as string | null) ?? null,
        description: (r.description as string | null) ?? null,
        publishTime: (r.publish_time as string | null) ?? null,
        views: (r.views as number | null) ?? null,
        saves: (r.saves as number | null) ?? null,
        likes: (r.likes as number | null) ?? null,
        tier: (r.tier as string | null) ?? null,
        viral: (r.viral as number | null) ?? null,
        overall: (r.overall as number | null) ?? null,
      })),
    };
  }

  if (page.surface === "youtube") {
    const handle = normalizeHandle(page.handle) || null;
    const channel = store
      .listYoutubeChannels()
      .find((c) =>
        page.links.youtubeChannelId
          ? c.channel_id === page.links.youtubeChannelId
          : handle !== null && normalizeHandle(c.handle) === handle,
      );
    const videos = channel
      ? store
          .listYoutubeVideos(channel.channel_id, 500)
          .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
          .slice(0, limit)
      : [];
    return {
      source: "youtube",
      handle,
      linked: Boolean(channel),
      channel: channel
        ? {
            channelId: channel.channel_id,
            name: channel.name,
            handle: channel.handle,
            subscriberCount: channel.subscriber_count,
            videoCount: channel.video_count,
          }
        : null,
      topVideos: videos.map((v) => ({
        videoId: v.video_id,
        title: v.title,
        publishedAt: v.published_at,
        views: v.views,
        likes: v.likes,
        thumbnailUrl: v.thumbnail_url,
      })),
    };
  }
  return { source: "none", linked: false };
}
