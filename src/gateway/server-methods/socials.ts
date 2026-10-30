/**
 * Social Analytics Gateway Handlers
 * Persistent analytics, sync, and automation management
 */

import type { GatewayRequestHandlers } from "./types.js";
import { getSocialAnalyticsStore } from "../../socials/analytics-store.js";
import { InstagramSyncService } from "../../socials/instagram-sync.js";
import { getIntegrationStore } from "../../funnels/integrations/integration-store.js";
import { getEngagementEngine } from "../../socials/engagement-engine.js";
import { 
  detectNiche, 
  generateRecommendations, 
  discoverCompetitors, 
  analyzeEngagement, 
  runFullAnalysis 
} from "../../socials/ai-insights.js";
import { resolve } from "node:path";

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

function getStateDir() {
  return resolve(process.env.INFINIBOT_STATE_DIR || "state");
}

function getStore() {
  return getSocialAnalyticsStore(getStateDir());
}

function getIntegrations() {
  return getIntegrationStore(getStateDir());
}

export const socialsHandlers: GatewayRequestHandlers = {
  // ═══════════════════════════════════════════════════════════════
  // SYNC
  // ═══════════════════════════════════════════════════════════════

  "socials.sync": async ({ params, respond }) => {
    try {
      const { platform, businessId } = params as any;
      
      // If no platform specified, sync all connected platforms
      const platformsToSync = platform ? [platform] : ['instagram'];
      const results: any[] = [];
      
      const integrations = getIntegrations();
      
      for (const p of platformsToSync) {
        if (p !== 'instagram') continue; // Only Instagram supported for now
        
        const cred = integrations.getCredentialByPlatform('instagram', businessId || 'default');
        
        if (!cred?.accessToken) {
          console.log("[socials] Instagram not connected, skipping");
          continue;
        }
        
        console.log("[socials] Starting sync for Instagram...", { accountName: cred.accountName, accountId: cred.accountId });
        const syncService = new InstagramSyncService(cred.accessToken, getStateDir());
        const result = await syncService.syncAll();
        
        console.log("[socials] Sync result:", result);
        results.push({ platform: 'instagram', ...result });
      }
      
      respond(true, { results, synced: results.length });
    } catch (e) {
      console.error("[socials] Sync error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },
  
  // ═══════════════════════════════════════════════════════════════
  // TOKEN REFRESH - Auto-refresh Instagram tokens
  // ═══════════════════════════════════════════════════════════════
  
  "socials.instagram.refreshToken": async ({ params, respond }) => {
    try {
      const { businessId } = params as any;
      const integrations = getIntegrations();
      const cred = integrations.getCredentialByPlatform('instagram', businessId || 'default');
      
      if (!cred?.accessToken) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "Instagram not connected" });
        return;
      }
      
      console.log("[socials] Refreshing Instagram token...");
      
      // Import the client dynamically
      const { InstagramClient } = await import("../../funnels/integrations/instagram-client.js");
      const newTokenData = await InstagramClient.refreshLongLivedToken(cred.accessToken);
      
      // Update stored token - use the existing credential as base
      integrations.saveCredential({
        ...cred,
        accessToken: newTokenData.access_token,
        tokenExpiry: Date.now() + (newTokenData.expires_in * 1000),
        connected: true,
        lastVerified: Date.now(),
        lastError: undefined,
      } as any);
      
      console.log("[socials] Instagram token refreshed successfully, expires in:", newTokenData.expires_in, "seconds");
      
      respond(true, { 
        refreshed: true, 
        expiresIn: newTokenData.expires_in,
        expiresAt: new Date(Date.now() + newTokenData.expires_in * 1000).toISOString()
      });
    } catch (e) {
      console.error("[socials] Token refresh error:", e);
      respond(false, undefined, { code: "REFRESH_FAILED", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  "socials.analytics.get": async ({ params, respond }) => {
    try {
      const { platform, accountId, days } = params as any;
      
      if (!platform || !accountId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "platform and accountId required" });
        return;
      }
      
      const store = getStore();
      const history = store.getProfileHistory(platform, accountId, days || 30);
      const posts = store.getPostMetrics(platform, accountId, 50);
      const topPosts = store.getTopPosts(platform, accountId, 'engagement_rate', 10);
      const stats = store.getTotalStats(platform, accountId);
      const growth = store.getFollowerGrowth(platform, accountId, days || 30);
      const latest = store.getLatestSnapshot(platform, accountId);
      
      // Map posts to UI format
      const recentPosts = posts.slice(0, 6).map(p => ({
        id: p.postId,
        platform: p.platform,
        thumbnailUrl: p.thumbnailUrl,
        caption: p.caption,
        likes: p.likes,
        comments: p.comments,
        shares: p.shares,
        views: p.plays,
        postedAt: p.postedAt,
      }));
      
      respond(true, {
        accountId,
        period: "today",
        reach: latest?.reach || 0,
        profileViews: latest?.profileViews || 0,
        newFollowers: growth.length > 0 ? growth[0].change : 0,
        impressions: stats.totalLikes + stats.totalComments,
        engagement: stats.avgEngagement,
        topPosts: recentPosts,
        // Also include raw data for charts
        profile: latest,
        history,
        posts,
        stats,
        growth,
      });
    } catch (e) {
      console.error("[socials] analytics.get error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.analytics.history": async ({ params, respond }) => {
    try {
      const { platform, accountId, days } = params as any;
      
      const store = getStore();
      const history = store.getProfileHistory(platform, accountId, days || 30);
      const growth = store.getFollowerGrowth(platform, accountId, days || 30);
      
      respond(true, { history, growth });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.analytics.posts": async ({ params, respond }) => {
    try {
      const { platform, accountId, limit, sortBy } = params as any;
      
      const store = getStore();
      const posts = sortBy 
        ? store.getTopPosts(platform, accountId, sortBy, limit || 50)
        : store.getPostMetrics(platform, accountId, limit || 50);
      
      respond(true, { posts });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.analytics.daily": async ({ params, respond }) => {
    try {
      const { platform, accountId, startDate, endDate } = params as any;
      
      const store = getStore();
      const aggregates = store.getDailyAggregates(platform, accountId, startDate, endDate);
      
      respond(true, { aggregates });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // ENGAGEMENT FLOWS
  // ═══════════════════════════════════════════════════════════════

  "socials.flows.list": async ({ params, respond }) => {
    try {
      const { platform, accountId } = params as any;
      
      const store = getStore();
      const flows = store.getEngagementFlows(platform, accountId);
      
      respond(true, { flows });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.flows.create": async ({ params, respond }) => {
    try {
      const { platform, accountId, name, triggerType, triggerKeywords, responseType, responseTemplate, aiPrompt } = params as any;
      
      if (!platform || !accountId || !name || !triggerType || !responseType) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing required fields" });
        return;
      }
      
      const store = getStore();
      const flow = store.saveEngagementFlow({
        platform,
        accountId,
        name,
        triggerType,
        triggerKeywords: JSON.stringify(triggerKeywords || []),
        responseType,
        responseTemplate,
        aiPrompt,
        enabled: true,
      });
      
      respond(true, { flow });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.flows.test": async ({ params, respond }) => {
    try {
      const { flowId, sampleContent, platform, accountId } = params as any;
      
      if (!flowId || !sampleContent || !platform || !accountId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "flowId, sampleContent, platform, and accountId required" });
        return;
      }
      
      const engine = getEngagementEngine({ stateDir: getStateDir() });
      const result = engine.testFlow(flowId, sampleContent, platform, accountId);
      
      respond(true, { 
        matched: result.matched,
        matchedKeywords: result.matchedKeywords,
        confidence: result.confidence,
        responsePreview: result.responsePreview,
        flowName: result.flow?.name,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.flows.toggle": async ({ params, respond }) => {
    try {
      const { flowId, enabled } = params as any;
      
      if (flowId === undefined || enabled === undefined) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "flowId and enabled required" });
        return;
      }
      
      const engine = getEngagementEngine({ stateDir: getStateDir() });
      const success = engine.toggleFlow(flowId, enabled);
      
      if (success) {
        respond(true, { flowId, enabled });
      } else {
        respond(false, undefined, { code: "UPDATE_FAILED", message: "Failed to toggle flow" });
      }
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.flows.stats": async ({ params, respond }) => {
    try {
      const { platform, accountId } = params as any;
      
      if (!platform || !accountId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "platform and accountId required" });
        return;
      }
      
      const engine = getEngagementEngine({ stateDir: getStateDir() });
      const stats = engine.getFlowStats(platform, accountId);
      
      respond(true, stats);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // CONVERSATIONS & LEADS
  // ═══════════════════════════════════════════════════════════════

  "socials.conversations.list": async ({ params, respond }) => {
    try {
      const { platform, accountId, limit } = params as any;
      
      const store = getStore();
      const conversations = store.getConversations(platform, accountId, limit || 50);
      
      respond(true, { conversations });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.leads.list": async ({ params, respond }) => {
    try {
      const { platform, accountId } = params as any;
      
      const store = getStore();
      const leads = store.getLeads(platform, accountId);
      
      respond(true, { leads });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.messages.list": async ({ params, respond }) => {
    try {
      const { conversationId, limit } = params as any;
      
      if (!conversationId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "conversationId required" });
        return;
      }
      
      const store = getStore();
      const messages = store.getMessages(conversationId, limit || 100);
      
      respond(true, { messages });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // ACCOUNTS
  // ═══════════════════════════════════════════════════════════════

  "socials.accounts.list": async ({ params, respond }) => {
    try {
      const integrations = getIntegrations();
      const store = getStore();
      
      // Get all connected social credentials
      const credentials = integrations.listCredentials().filter(c => 
        ['instagram', 'tiktok', 'twitter'].includes(c.platformId)
      );
      
      console.log("[socials] Found credentials:", credentials.map(c => ({ platform: c.platformId, accountId: c.accountId, accountName: c.accountName, connected: c.connected })));
      
      const accounts = credentials.map(cred => {
        const latest = cred.accountId 
          ? store.getLatestSnapshot(cred.platformId, cred.accountId)
          : null;
        
        console.log("[socials] Latest snapshot for", cred.accountId, ":", latest);
        
        // Map to UI expected format
        return {
          id: cred.accountId || cred.id,
          platform: cred.platformId,
          username: cred.accountName || '',
          displayName: cred.accountName || '',
          connected: cred.connected,
          lastSyncAt: latest?.timestamp,
          stats: {
            followers: latest?.followers || 0,
            following: latest?.following || 0,
            posts: latest?.posts || 0,
            engagement: latest?.accountsEngaged || 0,
          },
        };
      });
      
      respond(true, { accounts });
    } catch (e) {
      console.error("[socials] accounts.list error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // AI INSIGHTS
  // ═══════════════════════════════════════════════════════════════

  "socials.insights.analyze": async ({ params, respond }) => {
    try {
      const { platform, accountId } = params as any;
      
      if (!platform || !accountId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "platform and accountId required" });
        return;
      }
      
      console.log("[socials] Running full AI analysis for", platform, accountId);
      const analysis = await runFullAnalysis(platform, accountId, getStateDir());
      
      respond(true, analysis);
    } catch (e) {
      console.error("[socials] insights.analyze error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.insights.niche": async ({ params, respond }) => {
    try {
      const { platform, accountId } = params as any;
      
      if (!platform || !accountId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "platform and accountId required" });
        return;
      }
      
      console.log("[socials] Detecting niche for", platform, accountId);
      const niche = await detectNiche(platform, accountId, getStateDir());
      
      respond(true, niche);
    } catch (e) {
      console.error("[socials] insights.niche error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.insights.competitors": async ({ params, respond }) => {
    try {
      const { niche, platform } = params as any;
      
      if (!niche) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "niche required" });
        return;
      }
      
      console.log("[socials] Finding competitors for niche:", niche);
      const competitors = await discoverCompetitors(niche, platform || "instagram");
      
      respond(true, competitors);
    } catch (e) {
      console.error("[socials] insights.competitors error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.insights.recommendations": async ({ params, respond }) => {
    try {
      const { platform, accountId } = params as any;
      
      if (!platform || !accountId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "platform and accountId required" });
        return;
      }
      
      console.log("[socials] Generating recommendations for", platform, accountId);
      const recommendations = await generateRecommendations(platform, accountId, getStateDir());
      
      respond(true, recommendations);
    } catch (e) {
      console.error("[socials] insights.recommendations error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "socials.insights.engagement": async ({ params, respond }) => {
    try {
      const { platform, accountId } = params as any;
      
      if (!platform || !accountId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "platform and accountId required" });
        return;
      }
      
      console.log("[socials] Analyzing engagement for", platform, accountId);
      const engagement = await analyzeEngagement(platform, accountId, getStateDir());
      
      respond(true, engagement);
    } catch (e) {
      console.error("[socials] insights.engagement error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },
};
