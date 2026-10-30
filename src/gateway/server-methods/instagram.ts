/**
 * Instagram gateway methods.
 *
 * All credential operations flow through ~/. infinibot/secrets/instagram.json
 * (chmod 0600). Env vars (INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_APP_ID,
 * INSTAGRAM_APP_SECRET) act as a read-only fallback for pre-existing setups.
 *
 * Setup endpoints (new):
 *   instagram.setup.status      — connection state + token expiry
 *   instagram.setup.connect     — validate token, auto-fetch IG account, store
 *   instagram.setup.disconnect  — wipe secrets file
 *   instagram.setup.refresh     — refresh the long-lived token (60-day validity)
 *   instagram.setup.test        — validate token, return profile preview
 *
 * Analytics endpoints (real, no mock):
 *   instagram.profile.get       — full IG Business profile
 *   instagram.insights.get      — 30-day profile insights
 */

import {
  readInstagramSecrets,
  writeInstagramSecrets,
  deleteInstagramSecrets,
  tokenDaysRemaining,
  type InstagramSecrets,
} from "../../content/instagram-secrets.js";
import { InstagramClient } from "../../funnels/integrations/instagram-client.js";
import type { GatewayRequestHandlers } from "./types.js";

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "[error]";
}

/** Translate raw Graph API error messages into friendly English. */
function friendlyError(raw: string): string {
  if (/invalid|expired|malformed/i.test(raw)) {
    return "Your Instagram token is invalid or has expired. Please paste a fresh long-lived token.";
  }
  if (/permission|scope/i.test(raw)) {
    return "Your token is missing required permissions. Make sure you added: instagram_basic, instagram_manage_insights, pages_read_engagement, pages_show_list.";
  }
  if (/rate.?limit|too many/i.test(raw)) {
    return "Instagram is rate-limiting requests right now. Wait a few minutes and try again.";
  }
  if (/no.*business|not found/i.test(raw)) {
    return "No Instagram Business or Creator account found for this token. Make sure your Instagram is connected to a Facebook Page.";
  }
  return raw;
}

export const instagramHandlers: GatewayRequestHandlers = {
  // ── Setup: status ──────────────────────────────────────────────────────────

  "instagram.setup.status": async ({ respond }) => {
    try {
      const secrets = readInstagramSecrets();
      if (!secrets) {
        respond(true, { connected: false });
        return;
      }
      const daysLeft = tokenDaysRemaining(secrets);
      const expiringSoon = daysLeft !== null && daysLeft <= 7;
      respond(true, {
        connected: true,
        accountName: secrets.accountName,
        igBusinessAccountId: secrets.igBusinessAccountId,
        tokenExpiresAt: secrets.tokenExpiresAt,
        daysUntilExpiry: daysLeft,
        expiringSoon,
        lastSyncAt: secrets.lastSyncAt,
        connectedAt: secrets.connectedAt,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ── Setup: test (validate token, return profile preview) ──────────────────

  "instagram.setup.test": async ({ params, respond }) => {
    try {
      const accessToken = (params.accessToken as string | undefined)?.trim();
      if (!accessToken) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "accessToken is required" });
        return;
      }
      const client = new InstagramClient(accessToken);
      const result = await client.verifyConnection();
      if (!result.valid) {
        respond(false, undefined, {
          code: "VALIDATION_FAILED",
          message: friendlyError(result.error ?? "Token validation failed"),
        });
        return;
      }
      // Fetch full profile for preview
      const profile = await client.getProfile();
      respond(true, {
        valid: true,
        userId: result.userId,
        username: result.username,
        followersCount: profile.followers_count,
        mediaCount: profile.media_count,
        profilePictureUrl: profile.profile_picture_url,
        biography: profile.biography,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "VALIDATION_ERROR",
        message: friendlyError(extractErrorMessage(e)),
      });
    }
  },

  // ── Setup: connect (store credentials) ────────────────────────────────────

  "instagram.setup.connect": async ({ params, respond }) => {
    try {
      const accessToken = (params.accessToken as string | undefined)?.trim();
      const appId = (params.appId as string | undefined)?.trim();
      const appSecret = (params.appSecret as string | undefined)?.trim();
      if (!accessToken) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "accessToken is required" });
        return;
      }

      // Validate the token against the real API before storing.
      const client = new InstagramClient(accessToken);
      const result = await client.verifyConnection();
      if (!result.valid) {
        respond(false, undefined, {
          code: "VALIDATION_FAILED",
          message: friendlyError(result.error ?? "Token validation failed"),
        });
        return;
      }

      // Fetch profile for account name / ID.
      const profile = await client.getProfile();
      const igAccount = await client.getInstagramBusinessAccount();

      // Long-lived tokens are valid for 60 days.
      const tokenExpiresAt = Date.now() + 60 * 24 * 60 * 60 * 1000;

      const secrets: InstagramSecrets = {
        accessToken,
        appId: appId || process.env.INSTAGRAM_APP_ID,
        appSecret: appSecret || process.env.INSTAGRAM_APP_SECRET,
        igBusinessAccountId: igAccount?.id ?? result.userId,
        accountName: profile.username ?? result.username,
        tokenExpiresAt,
        connectedAt: Date.now(),
        lastSyncAt: Date.now(),
      };

      await writeInstagramSecrets(secrets);

      respond(true, {
        connected: true,
        accountName: secrets.accountName,
        igBusinessAccountId: secrets.igBusinessAccountId,
        tokenExpiresAt,
        followersCount: profile.followers_count,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "CONNECT_ERROR",
        message: friendlyError(extractErrorMessage(e)),
      });
    }
  },

  // ── Setup: disconnect ──────────────────────────────────────────────────────

  "instagram.setup.disconnect": async ({ respond }) => {
    try {
      const deleted = deleteInstagramSecrets();
      respond(true, { disconnected: deleted });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ── Setup: refresh token ──────────────────────────────────────────────────

  "instagram.setup.refresh": async ({ respond }) => {
    try {
      const secrets = readInstagramSecrets();
      if (!secrets) {
        respond(false, undefined, {
          code: "NOT_CONNECTED",
          message: "No Instagram credentials found. Connect Instagram first.",
        });
        return;
      }

      const newTokenData = await InstagramClient.refreshLongLivedToken(
        secrets.accessToken,
        secrets.appId,
        secrets.appSecret,
      );

      const tokenExpiresAt = Date.now() + (newTokenData.expires_in ?? 60 * 24 * 60 * 60) * 1000;
      const updated: InstagramSecrets = {
        ...secrets,
        accessToken: newTokenData.access_token,
        tokenExpiresAt,
        lastSyncAt: Date.now(),
      };

      await writeInstagramSecrets(updated);
      respond(true, {
        refreshed: true,
        tokenExpiresAt,
        daysUntilExpiry: tokenDaysRemaining(updated),
      });
    } catch (e) {
      respond(false, undefined, {
        code: "REFRESH_ERROR",
        message: friendlyError(extractErrorMessage(e)),
      });
    }
  },

  // ── Profile (real, no mock) ────────────────────────────────────────────────

  "instagram.profile.get": async ({ respond }) => {
    try {
      const secrets = readInstagramSecrets();
      if (!secrets) {
        respond(false, undefined, {
          code: "NOT_CONNECTED",
          message: "Instagram is not connected. Use the Connect Instagram button to set up access.",
        });
        return;
      }
      const client = new InstagramClient(secrets.accessToken);
      const profile = await client.getProfile();
      respond(true, {
        connected: true,
        profile: {
          id: profile.id,
          username: profile.username,
          name: profile.name,
          biography: profile.biography,
          followersCount: profile.followers_count,
          followsCount: profile.follows_count,
          mediaCount: profile.media_count,
          profilePictureUrl: profile.profile_picture_url,
          website: profile.website,
        },
      });
    } catch (e) {
      respond(false, undefined, {
        code: "API_ERROR",
        message: friendlyError(extractErrorMessage(e)),
      });
    }
  },

  // ── Insights (real, no mock) ───────────────────────────────────────────────

  "instagram.insights.get": async ({ params, respond }) => {
    try {
      const secrets = readInstagramSecrets();
      if (!secrets) {
        respond(false, undefined, {
          code: "NOT_CONNECTED",
          message: "Instagram is not connected. Use the Connect Instagram button to set up access.",
        });
        return;
      }
      const period = (params.period as "day" | "week" | "days_28" | undefined) ?? "day";
      const client = new InstagramClient(secrets.accessToken);
      const [profileInsights, profile, media] = await Promise.all([
        client.getProfileInsights(period),
        client.getProfile(),
        client.getMediaWithInsights(25),
      ]);

      // Compute engagement rate from recent posts.
      const totalEngagement = media.reduce((s, m) => s + (m.insights?.total_interactions ?? 0), 0);
      const engagementRate =
        profile.followers_count > 0
          ? totalEngagement / profile.followers_count / Math.max(media.length, 1)
          : 0;

      // Best posting time heuristic (hour with highest average engagement).
      const hourBuckets: number[] = new Array(24).fill(0);
      const hourCounts: number[] = new Array(24).fill(0);
      for (const m of media) {
        if (!m.timestamp) continue;
        const h = new Date(m.timestamp).getHours();
        hourBuckets[h] += m.insights?.total_interactions ?? 0;
        hourCounts[h]++;
      }
      let bestHour = 0;
      let bestAvg = 0;
      for (let h = 0; h < 24; h++) {
        if (!hourCounts[h]) continue;
        const avg = hourBuckets[h] / hourCounts[h];
        if (avg > bestAvg) {
          bestAvg = avg;
          bestHour = h;
        }
      }

      // Update lastSyncAt.
      await writeInstagramSecrets({ ...secrets, lastSyncAt: Date.now() });

      respond(true, {
        connected: true,
        period,
        totals: {
          reach: profileInsights.reach,
          impressions: profileInsights.impressions,
          profileViews: profileInsights.profile_views,
          accountsEngaged: profileInsights.accounts_engaged ?? 0,
        },
        profile: {
          followersCount: profile.followers_count,
          mediaCount: profile.media_count,
          username: profile.username,
        },
        media: media.slice(0, 25).map((m) => ({
          id: m.id,
          caption: m.caption,
          timestamp: m.timestamp,
          mediaType: m.media_type,
          permalink: m.permalink,
          likeCount: m.like_count,
          commentsCount: m.comments_count,
          reach: m.insights?.reach ?? 0,
          impressions: m.insights?.impressions ?? 0,
          saved: m.insights?.saved ?? 0,
          totalInteractions: m.insights?.total_interactions ?? 0,
        })),
        engagementRate,
        bestPostingHour: bestHour,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "API_ERROR",
        message: friendlyError(extractErrorMessage(e)),
      });
    }
  },
};
