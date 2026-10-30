/**
 * Instagram Graph API Client
 * Profile analytics, video metrics, and content insights
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("instagram-client");

export interface InstagramConfig {
  accessToken: string;
  userId?: string;
  username?: string;
  accountType?: "BUSINESS" | "CREATOR" | "PERSONAL";
  connected: boolean;
  lastVerified?: number;
}

export interface InstagramProfile {
  id: string;
  username: string;
  name: string;
  biography: string;
  profile_picture_url: string;
  followers_count: number;
  follows_count: number;
  media_count: number;
  website: string;
  account_type: string;
}

export interface InstagramMedia {
  id: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" | "REELS";
  media_url: string;
  thumbnail_url?: string;
  permalink: string;
  caption: string;
  timestamp: string;
  like_count: number;
  comments_count: number;
  // Video specific
  video_views?: number;
  // Insights (requires separate call)
  insights?: InstagramMediaInsights;
}

export interface InstagramMediaInsights {
  reach: number;
  engagement: number;
  saved: number;
  shares?: number;
  plays?: number;
  video_views?: number;
  total_interactions?: number;
  likes?: number;
  comments?: number;
  /** @deprecated removed from Graph API; always 0 */
  impressions?: number;
}

export interface InstagramProfileInsights {
  reach: number;
  profile_views: number;
  website_clicks: number;
  follower_count: number;
  email_contacts: number;
  phone_call_clicks: number;
  text_message_clicks: number;
  get_directions_clicks: number;
  accounts_engaged?: number;
  total_interactions?: number;
  /** @deprecated removed from Graph API; always 0 */
  impressions?: number;
}

export interface InstagramAudienceInsights {
  age_gender: Record<string, number>;
  top_cities: Record<string, number>;
  top_countries: Record<string, number>;
}

export class InstagramClient {
  private accessToken: string;
  private baseUrl = "https://graph.facebook.com/v22.0";
  private userId: string | null = null;
  private igUserId: string | null = null;

  constructor(accessToken: string, igUserId?: string) {
    this.accessToken = accessToken;
    if (igUserId) this.igUserId = igUserId;
  }

  private async request<T>(endpoint: string): Promise<T> {
    const separator = endpoint.includes("?") ? "&" : "?";
    const url = `${this.baseUrl}${endpoint}${separator}access_token=${this.accessToken}`;

    log.info("[instagram] Request:", { endpoint });

    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok || data.error) {
      const errorMsg = data.error?.message || `HTTP ${res.status}`;
      log.error("[instagram] API Error:", { error: errorMsg, code: data.error?.code });
      throw new Error(`Instagram API error: ${errorMsg}`);
    }

    return data;
  }

  // ═══════════════════════════════════════════════════════════════
  // ACCOUNT
  // ═══════════════════════════════════════════════════════════════

  async verifyConnection(): Promise<{
    valid: boolean;
    userId?: string;
    username?: string;
    error?: string;
  }> {
    try {
      // First get the Instagram Business Account ID from the Page
      const igAccount = await this.getInstagramBusinessAccount();
      if (!igAccount) {
        return {
          valid: false,
          error:
            "No Instagram Business account found. Make sure your IG is connected to a Facebook Page.",
        };
      }

      this.igUserId = igAccount.id;
      const profile = await this.getProfile();

      return {
        valid: true,
        userId: profile.id,
        username: profile.username,
      };
    } catch (e: any) {
      log.warn("[instagram] Connection verification failed:", { error: e.message });

      let errorMsg = e.message;
      if (e.message?.includes("Invalid")) {
        errorMsg = "Invalid or expired access token";
      } else if (e.message?.includes("permission")) {
        errorMsg =
          "Missing permissions. Add instagram_basic, instagram_manage_insights, pages_read_engagement";
      }

      return { valid: false, error: errorMsg };
    }
  }

  async getInstagramBusinessAccount(): Promise<{ id: string; username: string } | null> {
    log.info("[instagram] getInstagramBusinessAccount called");
    try {
      // Method 1: Try to get Instagram ID from token debug info (granular_scopes)
      try {
        log.info("[instagram] Trying token debug method...");
        const debugRes = await this.request<{
          data: { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> };
        }>(`/debug_token?input_token=${this.accessToken}`);

        log.info("[instagram] Token debug response:", {
          hasData: !!debugRes.data,
          granularScopes: debugRes.data?.granular_scopes?.map((s) => ({
            scope: s.scope,
            hasTargets: !!s.target_ids?.length,
          })),
        });

        const igScope = debugRes.data?.granular_scopes?.find(
          (s) => s.scope === "instagram_basic" && s.target_ids?.length,
        );

        log.info("[instagram] Instagram scope found:", {
          igScope: igScope ? { scope: igScope.scope, targetIds: igScope.target_ids } : null,
        });

        if (igScope?.target_ids?.[0]) {
          const igId = igScope.target_ids[0];
          log.info("[instagram] Got Instagram ID from scope:", { igId });
          const igProfile = await this.request<{ id: string; username: string }>(
            `/${igId}?fields=id,username`,
          );

          this.igUserId = igProfile.id;
          log.info("[instagram] Found Instagram from token scopes:", {
            id: igProfile.id,
            username: igProfile.username,
          });
          return igProfile;
        }
      } catch (e: any) {
        log.info("[instagram] Token debug method failed:", { error: e.message });
      }

      // Method 2: Get pages the user manages
      log.info("[instagram] Trying pages method...");
      const pagesRes = await this.request<{
        data: Array<{ id: string; name: string; access_token: string }>;
      }>("/me/accounts");

      log.info("[instagram] Pages found:", {
        count: pagesRes.data?.length || 0,
        pages: pagesRes.data?.map((p) => ({ id: p.id, name: p.name })),
      });

      if (pagesRes.data?.length) {
        // For each page, check for connected Instagram account
        for (const page of pagesRes.data) {
          try {
            log.info("[instagram] Checking page for Instagram:", {
              pageId: page.id,
              pageName: page.name,
            });
            const igRes = await this.request<{ instagram_business_account?: { id: string } }>(
              `/${page.id}?fields=instagram_business_account`,
            );

            log.info("[instagram] Page Instagram account:", {
              pageId: page.id,
              igAccount: igRes.instagram_business_account,
            });

            if (igRes.instagram_business_account?.id) {
              const igProfile = await this.request<{ id: string; username: string }>(
                `/${igRes.instagram_business_account.id}?fields=id,username`,
              );

              this.igUserId = igProfile.id;
              log.info("[instagram] Found Instagram from page:", {
                id: igProfile.id,
                username: igProfile.username,
                pageId: page.id,
              });
              return igProfile;
            }
          } catch (e: any) {
            log.info("[instagram] Page check failed:", { pageId: page.id, error: e.message });
            continue;
          }
        }
      }

      log.warn("[instagram] No Instagram Business account found after checking all methods");
      return null;
    } catch (e: any) {
      log.error("[instagram] Failed to get Instagram Business Account:", { error: e.message });
      throw e;
    }
  }

  async getProfile(): Promise<InstagramProfile> {
    if (!this.igUserId) {
      const igAccount = await this.getInstagramBusinessAccount();
      if (!igAccount) throw new Error("No Instagram Business account connected");
    }

    const fields = [
      "id",
      "username",
      "name",
      "biography",
      "profile_picture_url",
      "followers_count",
      "follows_count",
      "media_count",
      "website",
    ].join(",");

    const data = await this.request<InstagramProfile>(`/${this.igUserId}?fields=${fields}`);
    return { ...data, account_type: "BUSINESS" };
  }

  // ═══════════════════════════════════════════════════════════════
  // MEDIA
  // ═══════════════════════════════════════════════════════════════

  async getMedia(limit = 25): Promise<InstagramMedia[]> {
    if (!this.igUserId) {
      const igAccount = await this.getInstagramBusinessAccount();
      if (!igAccount) return [];
    }

    const fields = [
      "id",
      "media_type",
      "media_url",
      "thumbnail_url",
      "permalink",
      "caption",
      "timestamp",
      "like_count",
      "comments_count",
    ].join(",");

    const data = await this.request<{ data: InstagramMedia[] }>(
      `/${this.igUserId}/media?fields=${fields}&limit=${limit}`,
    );

    return data.data || [];
  }

  async getMediaInsights(mediaId: string, mediaType: string): Promise<InstagramMediaInsights> {
    // Different metrics available for different media types
    // Note: 'plays' is deprecated, use 'views' instead
    let metrics: string[];

    if (mediaType === "VIDEO" || mediaType === "REELS") {
      metrics = ["views", "reach", "saved", "shares", "total_interactions"];
    } else if (mediaType === "CAROUSEL_ALBUM") {
      metrics = ["reach", "saved", "total_interactions"];
    } else {
      // IMAGE
      metrics = ["reach", "saved", "total_interactions"];
    }

    try {
      const data = await this.request<{
        data: Array<{ name: string; values: Array<{ value: number }> }>;
      }>(`/${mediaId}/insights?metric=${metrics.join(",")}`);

      const insights: InstagramMediaInsights = {
        reach: 0,
        engagement: 0,
        saved: 0,
      };

      for (const metric of data.data || []) {
        const value = metric.values?.[0]?.value || 0;
        switch (metric.name) {
          case "reach":
            insights.reach = value;
            break;
          case "engagement":
            insights.engagement = value;
            break;
          case "saved":
            insights.saved = value;
            break;
          case "shares":
            insights.shares = value;
            break;
          case "plays":
          case "views":
            insights.plays = value;
            break;
          case "video_views":
            insights.video_views = value;
            break;
          case "total_interactions":
            insights.total_interactions = value;
            break;
        }
      }

      return insights;
    } catch (e) {
      log.warn("[instagram] Failed to get media insights:", {
        mediaId,
        error: (e as Error).message,
      });
      return { reach: 0, engagement: 0, saved: 0 };
    }
  }

  async getMediaWithInsights(limit = 10): Promise<InstagramMedia[]> {
    const media = await this.getMedia(limit);

    // Fetch insights for each media item (parallel, but limited)
    const mediaWithInsights = await Promise.all(
      media.slice(0, limit).map(async (m) => {
        const insights = await this.getMediaInsights(m.id, m.media_type);
        return { ...m, insights };
      }),
    );

    return mediaWithInsights;
  }

  // ═══════════════════════════════════════════════════════════════
  // PROFILE INSIGHTS (Last 30 days)
  // ═══════════════════════════════════════════════════════════════

  async getProfileInsights(
    period: "day" | "week" | "days_28" = "day",
  ): Promise<InstagramProfileInsights> {
    log.info("[instagram] getProfileInsights called", { period, igUserId: this.igUserId });

    if (!this.igUserId) {
      log.info("[instagram] No igUserId, fetching business account...");
      const igAccount = await this.getInstagramBusinessAccount();
      if (!igAccount) {
        log.warn("[instagram] Failed to get business account");
        return {
          reach: 0,
          profile_views: 0,
          website_clicks: 0,
          follower_count: 0,
          email_contacts: 0,
          phone_call_clicks: 0,
          text_message_clicks: 0,
          get_directions_clicks: 0,
        };
      }
      log.info("[instagram] Got business account:", igAccount);
    }

    // New Instagram API uses metric_type=total_value
    const metrics = [
      "reach",
      "profile_views",
      "website_clicks",
      "accounts_engaged",
      "total_interactions",
    ].join(",");
    const url = `/${this.igUserId}/insights?metric=${metrics}&metric_type=total_value&period=${period}`;
    log.info("[instagram] Fetching insights:", { url });

    try {
      const data = await this.request<{
        data: Array<{
          name: string;
          total_value?: { value: number };
          values?: Array<{ value: number }>;
        }>;
      }>(url);
      log.info("[instagram] Raw insights response:", {
        dataLength: data.data?.length,
        fullData: JSON.stringify(data),
      });

      const insights: InstagramProfileInsights = {
        reach: 0,
        profile_views: 0,
        website_clicks: 0,
        follower_count: 0,
        email_contacts: 0,
        phone_call_clicks: 0,
        text_message_clicks: 0,
        get_directions_clicks: 0,
      };

      for (const metric of data.data || []) {
        // New API uses total_value, old uses values array
        const value = metric.total_value?.value || metric.values?.[0]?.value || 0;
        log.info("[instagram] Parsing metric:", {
          name: metric.name,
          total_value: metric.total_value,
          values: metric.values,
          extractedValue: value,
        });
        (insights as any)[metric.name] = value;
      }

      log.info("[instagram] Final parsed insights:", { ...insights });
      return insights;
    } catch (e) {
      log.warn("[instagram] Failed to get profile insights:", { error: (e as Error).message });
      return {
        reach: 0,
        profile_views: 0,
        website_clicks: 0,
        follower_count: 0,
        email_contacts: 0,
        phone_call_clicks: 0,
        text_message_clicks: 0,
        get_directions_clicks: 0,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // AUDIENCE INSIGHTS
  // ═══════════════════════════════════════════════════════════════

  async getAudienceInsights(): Promise<InstagramAudienceInsights> {
    if (!this.igUserId) {
      const igAccount = await this.getInstagramBusinessAccount();
      if (!igAccount) return { age_gender: {}, top_cities: {}, top_countries: {} };
    }

    const metrics = ["audience_city", "audience_country", "audience_gender_age"].join(",");

    try {
      const data = await this.request<{
        data: Array<{ name: string; values: Array<{ value: Record<string, number> }> }>;
      }>(`/${this.igUserId}/insights?metric=${metrics}&period=lifetime`);

      const insights: InstagramAudienceInsights = {
        age_gender: {},
        top_cities: {},
        top_countries: {},
      };

      for (const metric of data.data || []) {
        const value = metric.values?.[0]?.value || {};
        switch (metric.name) {
          case "audience_gender_age":
            insights.age_gender = value;
            break;
          case "audience_city":
            insights.top_cities = value;
            break;
          case "audience_country":
            insights.top_countries = value;
            break;
        }
      }

      return insights;
    } catch (e) {
      log.warn("[instagram] Failed to get audience insights:", { error: (e as Error).message });
      return { age_gender: {}, top_cities: {}, top_countries: {} };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STORIES
  // ═══════════════════════════════════════════════════════════════

  async getStories(): Promise<InstagramMedia[]> {
    if (!this.igUserId) {
      const igAccount = await this.getInstagramBusinessAccount();
      if (!igAccount) return [];
    }

    try {
      const data = await this.request<{ data: InstagramMedia[] }>(
        `/${this.igUserId}/stories?fields=id,media_type,media_url,timestamp,permalink`,
      );
      return data.data || [];
    } catch {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // HASHTAG SEARCH (requires additional permissions)
  // ═══════════════════════════════════════════════════════════════

  async searchHashtag(hashtag: string): Promise<{ id: string }> {
    if (!this.igUserId) {
      await this.getInstagramBusinessAccount();
    }

    const data = await this.request<{ data: Array<{ id: string }> }>(
      `/ig_hashtag_search?user_id=${this.igUserId}&q=${encodeURIComponent(hashtag)}`,
    );

    if (!data.data?.[0]) {
      throw new Error(`Hashtag #${hashtag} not found`);
    }

    return data.data[0];
  }

  // ═══════════════════════════════════════════════════════════════
  // TOKEN REFRESH - Auto-refresh before expiry
  // ═══════════════════════════════════════════════════════════════

  /**
   * Refresh a long-lived token (valid for 60 days)
   * Should be called every 50 days or so to prevent expiration
   * Returns a new token that's valid for another 60 days
   */
  static async refreshLongLivedToken(
    currentToken: string,
    appId?: string,
    appSecret?: string,
  ): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
  }> {
    log.info("[instagram] Refreshing long-lived token...");

    const clientId = appId || process.env.INSTAGRAM_APP_ID;
    const clientSecret = appSecret || process.env.INSTAGRAM_APP_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "Instagram App ID and App Secret are required to refresh the token. Configure them in the Instagram setup modal.",
      );
    }
    const url = `https://graph.facebook.com/v22.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${currentToken}`;

    const response = await fetch(url);

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      log.error("[instagram] Token refresh failed:", { error });
      throw new Error(
        `Token refresh failed: ${(error as any)?.error?.message || response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    log.info("[instagram] Token refreshed successfully", { expiresIn: data.expires_in });

    return data;
  }

  /**
   * Check if token is close to expiry and refresh if needed
   * Call this periodically (e.g., on every sync)
   */
  async checkAndRefreshTokenIfNeeded(
    tokenExpiryMs?: number,
  ): Promise<{ refreshed: boolean; newToken?: string }> {
    // If no expiry provided, assume it might be old and try refreshing
    // Facebook tokens last 60 days, refresh at 50 days
    const REFRESH_THRESHOLD_MS = 50 * 24 * 60 * 60 * 1000; // 50 days

    if (tokenExpiryMs && tokenExpiryMs - Date.now() > REFRESH_THRESHOLD_MS) {
      return { refreshed: false };
    }

    try {
      const newTokenData = await InstagramClient.refreshLongLivedToken(this.accessToken);
      this.accessToken = newTokenData.access_token;

      return {
        refreshed: true,
        newToken: newTokenData.access_token,
      };
    } catch (e) {
      log.warn("[instagram] Token refresh failed, current token may still be valid:", {
        error: String(e),
      });
      return { refreshed: false };
    }
  }
}
