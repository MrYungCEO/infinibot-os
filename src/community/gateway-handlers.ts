/**
 * Community Discord Gateway Handlers
 * 
 * Gateway RPC methods for community Discord integration:
 * - community.discord.connect - Connect to Discord and initialize bot
 * - community.discord.sync - Sync members and roles
 * - community.discord.roles.map - Set tier → role mapping
 * - community.discord.roles.sync - Sync a member's roles
 * - community.discord.send - Send a message to a channel
 * - community.discord.announce - Send an announcement
 * - community.discord.member.* - Member operations
 * - community.discord.ticket.* - Support ticket operations
 * - community.discord.analytics - Get community analytics
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  CommunityDiscordIntegration,
  createCommunityDiscordIntegration,
  DiscordIntegrationError,
} from "./discord-integration.js";
import type {
  TierRoleMapping,
  MemberTier,
  MessageEmbed,
  MessageComponent,
  SyncParams,
} from "./types.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";

const log = createSubsystemLogger("community-discord-gateway");

// ============================================================================
// Singleton Integration Instance
// ============================================================================

let integrationInstance: CommunityDiscordIntegration | null = null;

function getIntegration(): CommunityDiscordIntegration {
  if (!integrationInstance) {
    throw new DiscordIntegrationError(
      "Community Discord not connected. Call community.discord.connect first.",
      "NOT_CONNECTED",
    );
  }
  return integrationInstance;
}

function ensureConnected(): void {
  getIntegration(); // Throws if not connected
}

// ============================================================================
// Error Helper
// ============================================================================

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    if ("message" in e && typeof (e as Record<string, unknown>).message === "string") {
      return (e as Record<string, unknown>).message as string;
    }
  }
  return String(e);
}

// ============================================================================
// Gateway Handlers
// ============================================================================

export const communityDiscordHandlers: GatewayRequestHandlers = {
  // ==========================================================================
  // Connection & Setup
  // ==========================================================================

  /**
   * Connect to Discord and initialize the community bot
   */
  "community.discord.connect": async ({ params, respond }) => {
    try {
      const guildId = params.guildId as string;
      const botToken = params.botToken as string | undefined;
      const roleMapping = params.roleMapping as TierRoleMapping | undefined;

      if (!guildId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "guildId is required",
        });
        return;
      }

      // Use environment variables as fallback
      const token = botToken || process.env.DISCORD_BOT_TOKEN;

      if (!token) {
        respond(false, undefined, {
          code: "MISSING_TOKEN",
          message: "Bot token required. Provide botToken or set DISCORD_BOT_TOKEN env var.",
        });
        return;
      }

      // Create or reconfigure integration
      integrationInstance = createCommunityDiscordIntegration({
        guildId,
        botToken: token,
        roleMapping,
        features: {
          autoRoleSync: true,
          welcomeMessages: true,
          progressAnnouncements: true,
          slashCommands: true,
          webhooks: true,
          analytics: true,
        },
      });

      const result = await integrationInstance.connect({
        guildId,
        botToken: token,
        roleMapping,
      });

      log.info("Connected to Discord via gateway", {
        guildId: result.guildId,
        guildName: result.guildName,
        memberCount: result.memberCount,
      });

      respond(true, result);
    } catch (e) {
      log.error("Failed to connect", { error: e });
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Disconnect from Discord
   */
  "community.discord.disconnect": async ({ respond }) => {
    integrationInstance = null;
    log.info("Disconnected from Discord");
    respond(true, { disconnected: true });
  },

  /**
   * Get current connection status
   */
  "community.discord.status": async ({ respond }) => {
    const connected = integrationInstance !== null;
    const config = connected ? integrationInstance!.getConfig() : null;

    respond(true, {
      connected,
      guildId: config?.guildId,
      features: config?.features,
      roleMapping: config?.roleMapping,
    });
  },

  // ==========================================================================
  // Sync Operations
  // ==========================================================================

  /**
   * Sync members and roles with Discord
   */
  "community.discord.sync": async ({ params, respond }) => {
    try {
      ensureConnected();

      const syncParams: SyncParams = {
        fullSync: params.fullSync as boolean | undefined,
        syncRoles: params.syncRoles !== false,
        syncMembers: params.syncMembers !== false,
      };

      const result = await getIntegration().sync(syncParams);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  // ==========================================================================
  // Role Operations
  // ==========================================================================

  /**
   * Set tier → role mapping
   */
  "community.discord.roles.map": async ({ params, respond }) => {
    try {
      ensureConnected();

      const mapping = params.mapping as TierRoleMapping;

      if (!mapping || typeof mapping !== "object") {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "mapping object required with tier: roleId pairs",
        });
        return;
      }

      const result = await getIntegration().setRoleMapping(mapping);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Get current role mapping
   */
  "community.discord.roles.get": async ({ respond }) => {
    try {
      ensureConnected();
      const mapping = getIntegration().getRoleMapping();
      respond(true, { mapping });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Sync roles for a specific member
   */
  "community.discord.roles.sync": async ({ params, respond }) => {
    try {
      ensureConnected();

      const discordId = params.discordId as string;
      const tier = params.tier as MemberTier;

      if (!discordId || !tier) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "discordId and tier required",
        });
        return;
      }

      const result = await getIntegration().syncMemberRoles(discordId, tier);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Sync all member roles
   */
  "community.discord.roles.syncAll": async ({ respond }) => {
    try {
      ensureConnected();
      const result = await getIntegration().syncAllRoles();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  // ==========================================================================
  // Messaging
  // ==========================================================================

  /**
   * Send a message to a channel
   */
  "community.discord.send": async ({ params, respond }) => {
    try {
      ensureConnected();

      const channelId = params.channelId as string;
      const message = params.message as string | undefined;
      const embed = params.embed as MessageEmbed | undefined;
      const components = params.components as MessageComponent[] | undefined;

      if (!channelId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "channelId required",
        });
        return;
      }

      if (!message && !embed) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "message or embed required",
        });
        return;
      }

      const result = await getIntegration().sendMessage({
        channelId,
        message: message || "",
        embed,
        components,
      });

      respond(true, result);
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Send a welcome message
   */
  "community.discord.welcome": async ({ params, respond }) => {
    try {
      ensureConnected();

      const discordId = params.discordId as string;
      const username = params.username as string;
      const tier = (params.tier as string) || "free";

      if (!discordId || !username) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "discordId and username required",
        });
        return;
      }

      await getIntegration().sendWelcomeMessage(discordId, username, tier);
      respond(true, { sent: true });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Announce course completion
   */
  "community.discord.announce.completion": async ({ params, respond }) => {
    try {
      ensureConnected();

      const discordId = params.discordId as string;
      const username = params.username as string;
      const courseName = params.courseName as string;

      if (!discordId || !username || !courseName) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "discordId, username, and courseName required",
        });
        return;
      }

      await getIntegration().announceCourseCompletion(discordId, username, courseName);
      respond(true, { announced: true });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Announce new content
   */
  "community.discord.announce.content": async ({ params, respond }) => {
    try {
      ensureConnected();

      const contentType = params.contentType as "course" | "lesson" | "resource";
      const contentName = params.contentName as string;
      const description = params.description as string | undefined;

      if (!contentType || !contentName) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "contentType and contentName required",
        });
        return;
      }

      await getIntegration().announceNewContent(contentType, contentName, description);
      respond(true, { announced: true });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  // ==========================================================================
  // Member Operations
  // ==========================================================================

  /**
   * Handle member join
   */
  "community.discord.member.join": async ({ params, respond }) => {
    try {
      ensureConnected();

      const discordId = params.discordId as string;
      const username = params.username as string;
      const tier = (params.tier as MemberTier) || "free";

      if (!discordId || !username) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "discordId and username required",
        });
        return;
      }

      const member = await getIntegration().onMemberJoin(discordId, username, tier);
      respond(true, { member });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Handle member leave
   */
  "community.discord.member.leave": async ({ params, respond }) => {
    try {
      ensureConnected();

      const discordId = params.discordId as string;
      const reason = params.reason as string | undefined;

      if (!discordId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "discordId required",
        });
        return;
      }

      await getIntegration().onMemberLeave(discordId, reason);
      respond(true, { processed: true });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Get a member
   */
  "community.discord.member.get": async ({ params, respond }) => {
    try {
      ensureConnected();

      const discordId = params.discordId as string;

      if (!discordId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "discordId required",
        });
        return;
      }

      const member = getIntegration().getMember(discordId);

      if (!member) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: "Member not found",
        });
        return;
      }

      respond(true, { member });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * List all members
   */
  "community.discord.member.list": async ({ params, respond }) => {
    try {
      ensureConnected();

      const limit = (params.limit as number) || 100;
      const offset = (params.offset as number) || 0;

      const allMembers = getIntegration().getMembers();
      const members = allMembers.slice(offset, offset + limit);

      respond(true, {
        members,
        total: allMembers.length,
        limit,
        offset,
      });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Update member tier
   */
  "community.discord.member.setTier": async ({ params, respond }) => {
    try {
      ensureConnected();

      const discordId = params.discordId as string;
      const tier = params.tier as MemberTier;
      const source = (params.source as "manual" | "payment" | "automation") || "manual";

      if (!discordId || !tier) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "discordId and tier required",
        });
        return;
      }

      const member = await getIntegration().updateMemberTier(discordId, tier, source);

      if (!member) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: "Member not found",
        });
        return;
      }

      respond(true, { member });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * Track member activity
   */
  "community.discord.member.activity": async ({ params, respond }) => {
    try {
      ensureConnected();

      const discordId = params.discordId as string;
      const type = params.type as "message" | "reaction" | "helpful";

      if (!discordId || !type) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "discordId and type required",
        });
        return;
      }

      getIntegration().trackActivity(discordId, type);
      respond(true, { tracked: true });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  // ==========================================================================
  // Support Tickets
  // ==========================================================================

  /**
   * Get a ticket
   */
  "community.discord.ticket.get": async ({ params, respond }) => {
    try {
      ensureConnected();

      const ticketId = params.ticketId as string;

      if (!ticketId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "ticketId required",
        });
        return;
      }

      const ticket = getIntegration().getTicket(ticketId);

      if (!ticket) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: "Ticket not found",
        });
        return;
      }

      respond(true, { ticket });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  /**
   * List tickets
   */
  "community.discord.ticket.list": async ({ params, respond }) => {
    try {
      ensureConnected();

      const status = params.status as string | undefined;
      const limit = (params.limit as number) || 50;

      let tickets = getIntegration().getTickets();

      if (status) {
        tickets = tickets.filter((t) => t.status === status);
      }

      tickets = tickets.slice(0, limit);

      respond(true, { tickets, count: tickets.length });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  // ==========================================================================
  // Analytics
  // ==========================================================================

  /**
   * Get community analytics
   */
  "community.discord.analytics": async ({ params, respond }) => {
    try {
      ensureConnected();

      const startDate = params.startDate as string | undefined;
      const endDate = params.endDate as string | undefined;

      const analytics = await getIntegration().getAnalytics(startDate, endDate);
      respond(true, { analytics });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },

  // ==========================================================================
  // Webhooks
  // ==========================================================================

  /**
   * Send a webhook event manually
   */
  "community.discord.webhook.send": async ({ params, respond }) => {
    try {
      ensureConnected();

      const type = params.type as string;
      const data = params.data as Record<string, unknown>;

      if (!type || !data) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "type and data required",
        });
        return;
      }

      await getIntegration().sendWebhookEvent(type as any, data as any);
      respond(true, { sent: true });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof DiscordIntegrationError ? e.code : "INTERNAL_ERROR",
        message: extractErrorMessage(e),
      });
    }
  },
};

// ============================================================================
// Export
// ============================================================================

export default communityDiscordHandlers;
