/**
 * Social Analytics Controller — state management and API calls for social media metrics
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Types ────────────────────────────────────────────────────

export interface FollowerDataPoint {
  date: string;
  followers: number;
  change: number;
}

export interface EngagementStats {
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalReach: number;
  avgEngagementRate: number;
  likesChange: number;       // Percentage change vs previous period
  commentsChange: number;
  reachChange: number;
  engagementChange: number;
}

export interface PostPerformance {
  postId: string;
  platform: string;
  mediaType: string;
  caption: string;
  thumbnailUrl?: string;
  permalink: string;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  reach: number;
  engagementRate: number;
  postedAt: number;
}

export interface ProfileSnapshot {
  platform: string;
  accountId: string;
  username: string;
  followers: number;
  following: number;
  posts: number;
  reach?: number;
  timestamp: number;
}

export interface SocialsAnalyticsState {
  loading: boolean;
  error: string | null;
  dateRange: "7d" | "14d" | "30d";
  selectedPlatform: string | null;
  followerHistory: FollowerDataPoint[];
  engagementStats: EngagementStats | null;
  topPosts: PostPerformance[];
  latestSnapshot: ProfileSnapshot | null;
  accounts: { platform: string; accountId: string; username: string }[];
}

// ── Default State ───────────────────────────────────────────

export function createSocialsAnalyticsState(): SocialsAnalyticsState {
  return {
    loading: false,
    error: null,
    dateRange: "30d",
    selectedPlatform: null,
    followerHistory: [],
    engagementStats: null,
    topPosts: [],
    latestSnapshot: null,
    accounts: [],
  };
}

// ── API Calls ────────────────────────────────────────────────

const RANGE_DAYS: Record<string, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

export async function loadSocialsAnalytics(
  client: GatewayBrowserClient,
  state: SocialsAnalyticsState,
  requestUpdate: () => void
): Promise<void> {
  state.loading = true;
  state.error = null;
  requestUpdate();

  try {
    const days = RANGE_DAYS[state.dateRange] ?? 30;
    const platform = state.selectedPlatform ?? "instagram";
    const accountId = "default"; // Will be updated once we have account selection
    
    // Fetch all analytics data from the main endpoint
    const res = await client.request("socials.analytics.get", {
      platform,
      accountId,
      days,
    });
    
    if (res && typeof res === "object") {
      const r = res as any;
      
      // Map growth data to follower history format
      if (r.growth && Array.isArray(r.growth)) {
        state.followerHistory = r.growth.map((g: any) => ({
          date: g.date,
          followers: g.followers,
          change: g.change || 0,
        }));
      }
      
      // Map stats to engagement stats
      if (r.stats) {
        const s = r.stats;
        state.engagementStats = {
          totalLikes: s.totalLikes ?? 0,
          totalComments: s.totalComments ?? 0,
          totalShares: 0, // Not tracked separately in store
          totalReach: 0, // Will come from daily aggregates
          avgEngagementRate: s.avgEngagement ?? 0,
          likesChange: 0, // Would need previous period comparison
          commentsChange: 0,
          reachChange: 0,
          engagementChange: 0,
        };
      }
      
      // Map profile to latest snapshot
      if (r.profile) {
        const p = r.profile;
        state.latestSnapshot = {
          platform: p.platform,
          accountId: p.accountId,
          username: p.username,
          followers: p.followers,
          following: p.following,
          posts: p.posts,
          reach: p.reach,
          timestamp: p.timestamp,
        };
      }
      
      // Map top posts
      if (r.topPosts && Array.isArray(r.topPosts)) {
        state.topPosts = r.topPosts.map((post: any) => ({
          postId: post.postId,
          platform: post.platform,
          mediaType: post.mediaType,
          caption: post.caption ?? "",
          thumbnailUrl: post.thumbnailUrl,
          permalink: post.permalink,
          likes: post.likes ?? 0,
          comments: post.comments ?? 0,
          shares: post.shares ?? 0,
          saves: post.saves ?? 0,
          reach: post.reach ?? 0,
          engagementRate: post.engagementRate ?? 0,
          postedAt: post.postedAt,
        }));
      }
    }

    state.loading = false;
  } catch (err: any) {
    state.loading = false;
    state.error = err?.message ?? String(err);
  }
  
  requestUpdate();
}

export function setDateRange(
  state: SocialsAnalyticsState,
  range: "7d" | "14d" | "30d"
): SocialsAnalyticsState {
  return { ...state, dateRange: range };
}

export function setPlatform(
  state: SocialsAnalyticsState,
  platform: string | null
): SocialsAnalyticsState {
  return { ...state, selectedPlatform: platform };
}
