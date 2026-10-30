/**
 * Integration Gateway Handlers
 * ManyChat and other platform integrations
 */

import type { GatewayRequestHandlers } from "./types.js";

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const maybeMessage = (e as { message?: string }).message;
    if (typeof maybeMessage === "string") return maybeMessage;
    try {
      return JSON.stringify(e);
    } catch {
      return "[complex error object]";
    }
  }
  return String(e);
}
import { getIntegrationStore } from "../../funnels/integrations/integration-store.js";
import { ManyChatClient } from "../../funnels/integrations/manychat-client.js";
import { InstagramClient } from "../../funnels/integrations/instagram-client.js";
import { resolve } from "node:path";

function getStore() {
  return getIntegrationStore(resolve(process.env.INFINIBOT_STATE_DIR || "state"));
}

export const integrationHandlers: GatewayRequestHandlers = {
  // ═══════════════════════════════════════════════════════════════
  // CREDENTIALS MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  "integrations.credentials.list": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = params.businessId as string | undefined;
      const credentials = store.listCredentials(businessId);

      // Mask sensitive data for UI
      const masked = credentials.map((c) => ({
        ...c,
        apiKey: c.apiKey ? `${c.apiKey.slice(0, 8)}...${c.apiKey.slice(-4)}` : undefined,
        apiSecret: c.apiSecret ? "••••••••" : undefined,
        accessToken: c.accessToken ? "••••••••" : undefined,
        refreshToken: c.refreshToken ? "••••••••" : undefined,
      }));

      respond(true, { credentials: masked });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.credentials.save": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { platformId, businessId, method, apiKey, apiSecret, config } = params as any;

      if (!platformId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "platformId is required" });
        return;
      }

      const id = `${platformId}-${businessId || "default"}`;

      const credential = store.saveCredential({
        id,
        platformId,
        businessId: businessId || "default",
        method: method || "api_key",
        apiKey,
        apiSecret,
        config,
        connected: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      respond(true, { credential: { ...credential, apiKey: apiKey ? "••••••••" : undefined } });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.credentials.delete": async ({ params, respond }) => {
    try {
      const store = getStore();
      const id = params.id as string;

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const deleted = store.deleteCredential(id);
      respond(true, { deleted });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.credentials.verify": async ({ params, respond }) => {
    console.log("[integrations] credentials.verify called with params:", {
      platformId: (params as any).platformId,
      businessId: (params as any).businessId,
      apiKeyLen: (params as any).apiKey?.length,
    });

    try {
      const store = getStore();
      const { platformId, businessId, apiKey } = params as any;

      if (!platformId || !apiKey) {
        console.log("[integrations] Missing params");
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "platformId and apiKey are required",
        });
        return;
      }

      let result: { valid: boolean; accountName?: string; accountId?: string; error?: string };

      if (platformId === "manychat") {
        console.log(
          "[integrations] Verifying ManyChat connection with key:",
          apiKey.slice(0, 15) + "...",
        );
        const client = new ManyChatClient(apiKey);
        const verification = await client.verifyConnection();
        console.log("[integrations] ManyChat verification result:", verification);
        result = {
          valid: verification.valid,
          accountName: verification.pageName,
          accountId: verification.pageId,
          error: verification.error,
        };
      } else {
        // Generic verification - just save
        result = { valid: true };
      }

      // Update or create credential
      const id = `${platformId}-${businessId || "default"}`;
      const existing = store.getCredential(id);

      if (result.valid) {
        // Save/update credential with connected=true
        store.saveCredential({
          id,
          platformId,
          businessId: businessId || "default",
          method: "api_key",
          apiKey,
          connected: true,
          accountName: result.accountName,
          accountId: result.accountId,
          lastVerified: Date.now(),
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        console.log("[integrations] Credential saved with connected=true");
      } else if (existing) {
        store.updateConnectionStatus(id, false, result.error);
      }

      respond(true, { verification: result });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // MANYCHAT SPECIFIC
  // ═══════════════════════════════════════════════════════════════

  "integrations.manychat.getFlows": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";

      const cred = store.getCredentialByPlatform("manychat", businessId);
      if (!cred || !cred.apiKey) {
        respond(false, undefined, {
          code: "NOT_CONNECTED",
          message: "ManyChat not connected. Add API key first.",
        });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      const flows = await client.getFlows();

      respond(true, { flows });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.getStats": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";

      const cred = store.getCredentialByPlatform("manychat", businessId);
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      const subscriberCount = await client.getSubscriberCount();

      respond(true, { stats: { subscriberCount } });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.getTags": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";

      const cred = store.getCredentialByPlatform("manychat", businessId);
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      const tags = await client.getTags();

      respond(true, { tags });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.getCustomFields": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";

      const cred = store.getCredentialByPlatform("manychat", businessId);
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      const fields = await client.getCustomFields();

      respond(true, { fields });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.getAutomations": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";

      const cred = store.getCredentialByPlatform("manychat", businessId);
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      const automations = await client.getAutomations();

      respond(true, { automations });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.sendFlow": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { businessId, subscriberId, flowNamespace } = params as any;

      if (!subscriberId || !flowNamespace) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "subscriberId and flowNamespace are required",
        });
        return;
      }

      const cred = store.getCredentialByPlatform("manychat", businessId || "default");
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      await client.sendFlow(subscriberId, flowNamespace);

      respond(true, { sent: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.getSubscriber": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { businessId, subscriberId, email, phone, igUsername } = params as any;

      const cred = store.getCredentialByPlatform("manychat", businessId || "default");
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);

      let subscriber = null;
      if (subscriberId) {
        subscriber = await client.getSubscriber(subscriberId);
      } else if (email) {
        subscriber = await client.findSubscriberByEmail(email);
      } else if (phone) {
        subscriber = await client.findSubscriberByPhone(phone);
      } else if (igUsername) {
        subscriber = await client.findSubscriberByIgUsername(igUsername);
      }

      respond(true, { subscriber });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.addTag": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { businessId, subscriberId, tagId } = params as any;

      if (!subscriberId || !tagId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "subscriberId and tagId are required",
        });
        return;
      }

      const cred = store.getCredentialByPlatform("manychat", businessId || "default");
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      await client.addTag(subscriberId, tagId);

      respond(true, { added: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.createTag": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { businessId, name } = params as any;

      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name is required" });
        return;
      }

      const cred = store.getCredentialByPlatform("manychat", businessId || "default");
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      const tag = await client.createTag(name);

      respond(true, { tag });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.getGrowthTools": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";

      const cred = store.getCredentialByPlatform("manychat", businessId);
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      const tools = await client.getGrowthTools();

      respond(true, { growthTools: tools });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.manychat.toggleAutomation": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { businessId, automationId, enabled } = params as any;

      if (!automationId || enabled === undefined) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "automationId and enabled are required",
        });
        return;
      }

      const cred = store.getCredentialByPlatform("manychat", businessId || "default");
      if (!cred || !cred.apiKey) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "ManyChat not connected" });
        return;
      }

      const client = new ManyChatClient(cred.apiKey);
      if (enabled) {
        await client.enableAutomation(automationId);
      } else {
        await client.disableAutomation(automationId);
      }

      respond(true, { toggled: true, enabled });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // INSTAGRAM GRAPH API
  // ═══════════════════════════════════════════════════════════════

  "integrations.instagram.verify": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { businessId, accessToken } = params as any;

      if (!accessToken) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "accessToken is required" });
        return;
      }

      const client = new InstagramClient(accessToken);
      const verification = await client.verifyConnection();

      if (verification.valid) {
        const id = `instagram-${businessId || "default"}`;
        store.saveCredential({
          id,
          platformId: "instagram",
          businessId: businessId || "default",
          method: "oauth",
          accessToken,
          connected: true,
          accountName: verification.username,
          accountId: verification.userId,
          lastVerified: Date.now(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      respond(true, { verification });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.instagram.getProfile": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";

      const cred = store.getCredentialByPlatform("instagram", businessId);
      if (!cred || !cred.accessToken) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "Instagram not connected" });
        return;
      }

      const client = new InstagramClient(cred.accessToken, cred.accountId);
      const profile = await client.getProfile();

      respond(true, { profile });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.instagram.getMedia": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";
      const limit = (params.limit as number) || 12;
      const withInsights = (params.withInsights as boolean) || false;

      const cred = store.getCredentialByPlatform("instagram", businessId);
      if (!cred || !cred.accessToken) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "Instagram not connected" });
        return;
      }

      const client = new InstagramClient(cred.accessToken, cred.accountId);
      const media = withInsights
        ? await client.getMediaWithInsights(limit)
        : await client.getMedia(limit);

      respond(true, { media });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.instagram.getMediaInsights": async ({ params, respond }) => {
    try {
      const store = getStore();
      const { businessId, mediaId, mediaType } = params as any;

      if (!mediaId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "mediaId is required" });
        return;
      }

      const cred = store.getCredentialByPlatform("instagram", businessId || "default");
      if (!cred || !cred.accessToken) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "Instagram not connected" });
        return;
      }

      const client = new InstagramClient(cred.accessToken, cred.accountId);
      const insights = await client.getMediaInsights(mediaId, mediaType || "IMAGE");

      respond(true, { insights });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.instagram.getProfileInsights": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";
      // New API only supports 'day' with metric_type=total_value
      const period = (params.period as "day" | "week" | "days_28") || "day";

      const cred = store.getCredentialByPlatform("instagram", businessId);
      if (!cred || !cred.accessToken) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "Instagram not connected" });
        return;
      }

      console.log("[instagram] Getting profile insights for:", { businessId, period });

      const client = new InstagramClient(cred.accessToken, cred.accountId);
      const insights = await client.getProfileInsights(period);

      console.log("[instagram] Profile insights result:", insights);

      respond(true, { insights });
    } catch (e) {
      console.error("[instagram] Profile insights error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.instagram.getAudienceInsights": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";

      const cred = store.getCredentialByPlatform("instagram", businessId);
      if (!cred || !cred.accessToken) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "Instagram not connected" });
        return;
      }

      const client = new InstagramClient(cred.accessToken, cred.accountId);
      const insights = await client.getAudienceInsights();

      respond(true, { insights });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "integrations.instagram.getStories": async ({ params, respond }) => {
    try {
      const store = getStore();
      const businessId = (params.businessId as string) || "default";

      const cred = store.getCredentialByPlatform("instagram", businessId);
      if (!cred || !cred.accessToken) {
        respond(false, undefined, { code: "NOT_CONNECTED", message: "Instagram not connected" });
        return;
      }

      const client = new InstagramClient(cred.accessToken, cred.accountId);
      const stories = await client.getStories();

      respond(true, { stories });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },
};
