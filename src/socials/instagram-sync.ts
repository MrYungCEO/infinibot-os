/**
 * Instagram Sync Service
 * Syncs Instagram data to persistent analytics database
 */

import { InstagramClient } from "../funnels/integrations/instagram-client.js";
import { getSocialAnalyticsStore, type ProfileSnapshot, type PostMetric } from "./analytics-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("instagram-sync");

export interface SyncResult {
  success: boolean;
  profileSynced: boolean;
  postsSynced: number;
  insightsSynced: boolean;
  error?: string;
}

export class InstagramSyncService {
  private client: InstagramClient;
  private store: ReturnType<typeof getSocialAnalyticsStore>;
  private accountId: string = '';

  constructor(accessToken: string, stateDir: string) {
    this.client = new InstagramClient(accessToken);
    this.store = getSocialAnalyticsStore(stateDir);
  }

  async syncAll(): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      profileSynced: false,
      postsSynced: 0,
      insightsSynced: false,
    };

    try {
      // 1. Sync profile
      log.info("[instagram-sync] Starting full sync...");
      
      const profile = await this.client.getProfile();
      if (!profile) {
        result.error = "Failed to get profile";
        return result;
      }
      
      this.accountId = profile.id;
      const today = new Date().toISOString().split('T')[0];
      
      // Get profile insights
      const insights = await this.client.getProfileInsights('day');
      
      const snapshot: Omit<ProfileSnapshot, 'id'> = {
        platform: 'instagram',
        accountId: profile.id,
        username: profile.username,
        followers: profile.followers_count,
        following: profile.follows_count,
        posts: profile.media_count,
        reach: insights.reach,
        profileViews: insights.profile_views,
        websiteClicks: insights.website_clicks,
        accountsEngaged: insights.accounts_engaged,
        timestamp: Date.now(),
        date: today,
      };
      
      this.store.saveProfileSnapshot(snapshot);
      result.profileSynced = true;
      result.insightsSynced = insights.reach > 0;
      log.info("[instagram-sync] Profile synced:", { username: profile.username, followers: profile.followers_count });

      // 2. Sync posts
      const media = await this.client.getMediaWithInsights(25);
      
      for (const m of media) {
        const engagementRate = profile.followers_count > 0 
          ? ((m.like_count + m.comments_count) / profile.followers_count) * 100 
          : 0;
        
        const postMetric: Omit<PostMetric, 'id'> = {
          platform: 'instagram',
          accountId: profile.id,
          postId: m.id,
          mediaType: m.media_type as any,
          permalink: m.permalink,
          caption: m.caption?.slice(0, 500),
          thumbnailUrl: m.thumbnail_url || m.media_url,
          likes: m.like_count,
          comments: m.comments_count,
          shares: m.insights?.shares,
          saves: m.insights?.saved,
          reach: m.insights?.reach,
          impressions: m.insights?.impressions,
          plays: m.insights?.plays,
          engagementRate,
          postedAt: new Date(m.timestamp).getTime(),
          syncedAt: Date.now(),
        };
        
        this.store.savePostMetric(postMetric);
        result.postsSynced++;
      }
      
      log.info("[instagram-sync] Posts synced:", { count: result.postsSynced });

      // 3. Calculate and save daily aggregate
      const postStats = this.store.getTotalStats('instagram', profile.id);
      const previousSnapshot = this.store.getProfileHistory('instagram', profile.id, 2);
      const followerChange = previousSnapshot.length >= 2 
        ? snapshot.followers - previousSnapshot[1].followers 
        : 0;
      
      this.store.saveDailyAggregate({
        date: today,
        platform: 'instagram',
        accountId: profile.id,
        followers: snapshot.followers,
        followerChange,
        totalLikes: postStats.totalLikes,
        totalComments: postStats.totalComments,
        totalReach: insights.reach || 0,
        avgEngagementRate: postStats.avgEngagement,
        postsPublished: media.filter(m => 
          new Date(m.timestamp).toISOString().split('T')[0] === today
        ).length,
      });

      result.success = true;
      log.info("[instagram-sync] Full sync complete");
      
    } catch (e) {
      result.error = (e as Error).message;
      log.error("[instagram-sync] Sync failed:", { error: result.error });
    }

    return result;
  }

  async syncProfileOnly(): Promise<ProfileSnapshot | null> {
    try {
      const profile = await this.client.getProfile();
      if (!profile) return null;
      
      const insights = await this.client.getProfileInsights('day');
      const today = new Date().toISOString().split('T')[0];
      
      const snapshot: Omit<ProfileSnapshot, 'id'> = {
        platform: 'instagram',
        accountId: profile.id,
        username: profile.username,
        followers: profile.followers_count,
        following: profile.follows_count,
        posts: profile.media_count,
        reach: insights.reach,
        profileViews: insights.profile_views,
        websiteClicks: insights.website_clicks,
        accountsEngaged: insights.accounts_engaged,
        timestamp: Date.now(),
        date: today,
      };
      
      return this.store.saveProfileSnapshot(snapshot);
    } catch (e) {
      log.error("[instagram-sync] Profile sync failed:", { error: (e as Error).message });
      return null;
    }
  }

  getAnalytics(accountId: string, days: number = 30) {
    const history = this.store.getProfileHistory('instagram', accountId, days);
    const posts = this.store.getPostMetrics('instagram', accountId, 50);
    const topPosts = this.store.getTopPosts('instagram', accountId, 'engagement_rate', 10);
    const stats = this.store.getTotalStats('instagram', accountId);
    const growth = this.store.getFollowerGrowth('instagram', accountId, days);
    const latest = this.store.getLatestSnapshot('instagram', accountId);
    
    return {
      profile: latest,
      history,
      posts,
      topPosts,
      stats,
      growth,
    };
  }

  getFlows(accountId: string) {
    return this.store.getEngagementFlows('instagram', accountId);
  }

  createFlow(flow: {
    accountId: string;
    name: string;
    triggerType: 'keyword' | 'comment' | 'dm' | 'mention' | 'story_reply';
    triggerKeywords: string[];
    responseType: 'ai' | 'template';
    responseTemplate?: string;
    aiPrompt?: string;
  }) {
    return this.store.saveEngagementFlow({
      platform: 'instagram',
      accountId: flow.accountId,
      name: flow.name,
      triggerType: flow.triggerType,
      triggerKeywords: JSON.stringify(flow.triggerKeywords),
      responseType: flow.responseType,
      responseTemplate: flow.responseTemplate,
      aiPrompt: flow.aiPrompt,
      enabled: true,
    });
  }

  getConversations(accountId: string, limit: number = 50) {
    return this.store.getConversations('instagram', accountId, limit);
  }

  getLeads(accountId: string) {
    return this.store.getLeads('instagram', accountId);
  }
}
