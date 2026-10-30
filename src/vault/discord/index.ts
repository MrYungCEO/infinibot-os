/**
 * Kingly Vault - Discord Integration
 *
 * Main entry point for Discord server management.
 * Combines moderation, roles, channels, and messages into a unified API.
 */

import { loadConfig } from "../../config/config.js";

// Re-export types
export * from "./types.js";

// Re-export client utilities
export {
  createVaultDiscordClient,
  getVaultDiscordRest,
  getSharedVaultDiscordClient,
  clearSharedVaultDiscordClient,
  VaultDiscordClientError,
  DISCORD_ERROR_CODES,
  wrapDiscordError,
  getDiscordErrorCode,
  type VaultDiscordClient,
  type VaultDiscordClientOpts,
} from "./client.js";

// Re-export moderation functions
export {
  warnMember,
  timeoutMember,
  removeTimeout,
  kickMember,
  banMember,
  unbanMember,
  getTimeoutStatus,
  isBanned,
  type WarnOptions,
  type TimeoutOptions,
  type KickOptions,
  type BanOptions,
  type UnbanOptions,
  type ModerationResult,
} from "./moderation.js";

// Re-export role functions
export {
  getRoles,
  getRole,
  findRoleByName,
  createRole,
  editRole,
  deleteRole,
  assignRole,
  removeRole,
  assignRoles,
  removeRoles,
  getMemberRoles,
  hasRole,
  type RoleOptions,
  type RoleEditConfig,
} from "./roles.js";

// Re-export channel functions
export {
  getChannels,
  getChannelsByType,
  getTextChannels,
  getVoiceChannels,
  getCategories,
  getChannel,
  findChannelByName,
  createChannel,
  createTextChannel,
  createVoiceChannel,
  createCategory,
  editChannel,
  moveChannel,
  deleteChannel,
  setPermissions,
  setPermissionOverwrite,
  removePermissionOverwrite,
  syncPermissions,
  type ChannelOptions,
  type ChannelEditConfig,
} from "./channels.js";

// Re-export message functions
export {
  sendMessage,
  sendText,
  sendEmbed,
  sendReply,
  sendDM,
  sendDMEmbed,
  deleteMessage,
  bulkDeleteMessages,
  editMessage,
  getMessage,
  getMessages,
  pinMessage,
  unpinMessage,
  getPinnedMessages,
  type MessageOpts,
  type SendMessageResult,
} from "./messages.js";

// Import for class usage
import * as moderation from "./moderation.js";
import * as roles from "./roles.js";
import * as channels from "./channels.js";
import * as messages from "./messages.js";
import {
  createVaultDiscordClient,
  getSharedVaultDiscordClient,
  type VaultDiscordClient,
  type VaultDiscordClientOpts,
} from "./client.js";
import type {
  DiscordIntegrationConfig,
  Warning,
  WarningSeverity,
  DiscordRole,
  RoleConfig,
  DiscordChannel,
  ChannelConfig,
  ChannelPermission,
  Message,
  MessageOptions,
  MessageEmbed,
  DiscordMember,
} from "./types.js";

// ============================================================================
// Discord Integration Class
// ============================================================================

/**
 * DiscordIntegration provides a unified API for Discord server management.
 *
 * Features:
 * - Moderation: warn, timeout, kick, ban, unban
 * - Roles: list, create, assign, remove, edit
 * - Channels: list, create, edit, delete, permissions
 * - Messages: send, delete, DM, edit, bulk operations
 *
 * @example
 * ```typescript
 * const discord = new DiscordIntegration({ accountId: 'main' });
 *
 * // Moderation
 * await discord.warnMember(guildId, userId, 'Spamming', 'minor');
 * await discord.timeoutMember(guildId, userId, 60000); // 1 minute
 *
 * // Roles
 * const roles = await discord.getRoles(guildId);
 * await discord.assignRole(guildId, userId, roleId);
 *
 * // Channels
 * const channel = await discord.createTextChannel(guildId, 'announcements');
 * await discord.sendMessage(channel.id, 'Hello world!');
 *
 * // DMs
 * await discord.sendDM(userId, 'You have been warned!');
 * ```
 */
export class DiscordIntegration {
  private config: DiscordIntegrationConfig;
  private clientOpts: VaultDiscordClientOpts;
  private client: VaultDiscordClient | null = null;

  constructor(config: DiscordIntegrationConfig = {}) {
    this.config = config;
    this.clientOpts = {
      accountId: config.accountId,
    };
  }

  // --------------------------------------------------------------------------
  // Client Management
  // --------------------------------------------------------------------------

  /**
   * Gets the underlying Discord client.
   * Creates one if it doesn't exist.
   */
  getClient(): VaultDiscordClient {
    if (!this.client) {
      this.client = createVaultDiscordClient(this.clientOpts);
    }
    return this.client;
  }

  /**
   * Uses the shared global client instead of a dedicated one.
   */
  useSharedClient(): this {
    this.client = getSharedVaultDiscordClient(this.clientOpts);
    return this;
  }

  // --------------------------------------------------------------------------
  // Moderation
  // --------------------------------------------------------------------------

  /**
   * Issues a warning to a member.
   * The warning is returned for the caller to persist to storage.
   */
  async warnMember(
    guildId: string,
    userId: string,
    reason: string,
    severity: WarningSeverity,
    expiresAt?: Date,
  ): Promise<Warning> {
    return moderation.warnMember(guildId, userId, reason, severity, {
      ...this.clientOpts,
      moderatorId: this.config.defaultModeratorId,
      expiresAt,
    });
  }

  /**
   * Times out a member for the specified duration.
   */
  async timeoutMember(
    guildId: string,
    userId: string,
    durationMs: number,
    reason?: string,
  ): Promise<moderation.ModerationResult<DiscordMember>> {
    return moderation.timeoutMember(guildId, userId, durationMs, reason, {
      ...this.clientOpts,
      moderatorId: this.config.defaultModeratorId,
    });
  }

  /**
   * Removes a timeout from a member.
   */
  async removeTimeout(
    guildId: string,
    userId: string,
    reason?: string,
  ): Promise<moderation.ModerationResult<DiscordMember>> {
    return moderation.removeTimeout(guildId, userId, reason, {
      ...this.clientOpts,
      moderatorId: this.config.defaultModeratorId,
    });
  }

  /**
   * Kicks a member from the guild.
   */
  async kickMember(
    guildId: string,
    userId: string,
    reason?: string,
  ): Promise<moderation.ModerationResult> {
    return moderation.kickMember(guildId, userId, reason, {
      ...this.clientOpts,
      moderatorId: this.config.defaultModeratorId,
    });
  }

  /**
   * Bans a member from the guild.
   */
  async banMember(
    guildId: string,
    userId: string,
    reason?: string,
    deleteMessageDays?: number,
  ): Promise<moderation.ModerationResult> {
    return moderation.banMember(guildId, userId, reason, deleteMessageDays, {
      ...this.clientOpts,
      moderatorId: this.config.defaultModeratorId,
    });
  }

  /**
   * Unbans a user from the guild.
   */
  async unbanMember(guildId: string, userId: string): Promise<moderation.ModerationResult> {
    return moderation.unbanMember(guildId, userId, {
      ...this.clientOpts,
      moderatorId: this.config.defaultModeratorId,
    });
  }

  /**
   * Gets a member's timeout status.
   */
  async getTimeoutStatus(
    guildId: string,
    userId: string,
  ): Promise<{ timedOut: boolean; until?: Date }> {
    return moderation.getTimeoutStatus(guildId, userId, this.clientOpts);
  }

  /**
   * Checks if a user is banned.
   */
  async isBanned(guildId: string, userId: string): Promise<boolean> {
    return moderation.isBanned(guildId, userId, this.clientOpts);
  }

  // --------------------------------------------------------------------------
  // Roles
  // --------------------------------------------------------------------------

  /**
   * Gets all roles in a guild.
   */
  async getRoles(guildId: string): Promise<DiscordRole[]> {
    return roles.getRoles(guildId, this.clientOpts);
  }

  /**
   * Gets a specific role by ID.
   */
  async getRole(guildId: string, roleId: string): Promise<DiscordRole | null> {
    return roles.getRole(guildId, roleId, this.clientOpts);
  }

  /**
   * Finds a role by name.
   */
  async findRoleByName(guildId: string, name: string): Promise<DiscordRole | null> {
    return roles.findRoleByName(guildId, name, this.clientOpts);
  }

  /**
   * Creates a new role.
   */
  async createRole(guildId: string, config: RoleConfig): Promise<DiscordRole> {
    return roles.createRole(guildId, config, this.clientOpts);
  }

  /**
   * Edits an existing role.
   */
  async editRole(
    guildId: string,
    roleId: string,
    config: Partial<RoleConfig>,
  ): Promise<DiscordRole> {
    return roles.editRole(guildId, roleId, config, this.clientOpts);
  }

  /**
   * Deletes a role.
   */
  async deleteRole(guildId: string, roleId: string): Promise<void> {
    return roles.deleteRole(guildId, roleId, this.clientOpts);
  }

  /**
   * Assigns a role to a member.
   */
  async assignRole(guildId: string, userId: string, roleId: string): Promise<void> {
    return roles.assignRole(guildId, userId, roleId, this.clientOpts);
  }

  /**
   * Removes a role from a member.
   */
  async removeRole(guildId: string, userId: string, roleId: string): Promise<void> {
    return roles.removeRole(guildId, userId, roleId, this.clientOpts);
  }

  /**
   * Gets a member's current roles.
   */
  async getMemberRoles(guildId: string, userId: string): Promise<string[]> {
    return roles.getMemberRoles(guildId, userId, this.clientOpts);
  }

  /**
   * Checks if a member has a specific role.
   */
  async hasRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
    return roles.hasRole(guildId, userId, roleId, this.clientOpts);
  }

  // --------------------------------------------------------------------------
  // Channels
  // --------------------------------------------------------------------------

  /**
   * Gets all channels in a guild.
   */
  async getChannels(guildId: string): Promise<DiscordChannel[]> {
    return channels.getChannels(guildId, this.clientOpts);
  }

  /**
   * Gets a specific channel by ID.
   */
  async getChannel(channelId: string): Promise<DiscordChannel | null> {
    return channels.getChannel(channelId, this.clientOpts);
  }

  /**
   * Finds a channel by name.
   */
  async findChannelByName(guildId: string, name: string): Promise<DiscordChannel | null> {
    return channels.findChannelByName(guildId, name, this.clientOpts);
  }

  /**
   * Creates a new channel.
   */
  async createChannel(guildId: string, config: ChannelConfig): Promise<DiscordChannel> {
    return channels.createChannel(guildId, config, this.clientOpts);
  }

  /**
   * Creates a text channel.
   */
  async createTextChannel(
    guildId: string,
    name: string,
    config?: Partial<Omit<ChannelConfig, "name" | "type">>,
  ): Promise<DiscordChannel> {
    return channels.createTextChannel(guildId, name, config, this.clientOpts);
  }

  /**
   * Creates a voice channel.
   */
  async createVoiceChannel(
    guildId: string,
    name: string,
    config?: Partial<Omit<ChannelConfig, "name" | "type">>,
  ): Promise<DiscordChannel> {
    return channels.createVoiceChannel(guildId, name, config, this.clientOpts);
  }

  /**
   * Creates a category.
   */
  async createCategory(
    guildId: string,
    name: string,
    config?: Partial<Omit<ChannelConfig, "name" | "type" | "parentId">>,
  ): Promise<DiscordChannel> {
    return channels.createCategory(guildId, name, config, this.clientOpts);
  }

  /**
   * Edits a channel.
   */
  async editChannel(
    channelId: string,
    config: channels.ChannelEditConfig,
  ): Promise<DiscordChannel> {
    return channels.editChannel(channelId, config, this.clientOpts);
  }

  /**
   * Deletes a channel.
   */
  async deleteChannel(guildId: string, channelId: string): Promise<void> {
    return channels.deleteChannel(guildId, channelId, this.clientOpts);
  }

  /**
   * Sets permission overwrites for a channel.
   */
  async setPermissions(
    guildId: string,
    channelId: string,
    perms: ChannelPermission[],
  ): Promise<void> {
    return channels.setPermissions(guildId, channelId, perms, this.clientOpts);
  }

  // --------------------------------------------------------------------------
  // Messages
  // --------------------------------------------------------------------------

  /**
   * Sends a message to a channel.
   */
  async sendMessage(
    channelId: string,
    content: string,
    options?: MessageOptions,
  ): Promise<Message> {
    return messages.sendMessage(channelId, content, options, this.clientOpts);
  }

  /**
   * Sends an embed to a channel.
   */
  async sendEmbed(channelId: string, embeds: MessageEmbed[], content?: string): Promise<Message> {
    return messages.sendEmbed(channelId, embeds, content, this.clientOpts);
  }

  /**
   * Deletes a message.
   */
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    return messages.deleteMessage(channelId, messageId, this.clientOpts);
  }

  /**
   * Sends a direct message to a user.
   */
  async sendDM(userId: string, content: string): Promise<Message> {
    return messages.sendDM(userId, content, this.clientOpts);
  }

  /**
   * Gets messages from a channel.
   */
  async getMessages(
    channelId: string,
    options?: { limit?: number; before?: string; after?: string },
  ): Promise<Message[]> {
    return messages.getMessages(channelId, options, this.clientOpts);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new DiscordIntegration instance.
 *
 * @param config - Integration configuration
 * @returns Configured DiscordIntegration instance
 */
export function createDiscordIntegration(
  config: DiscordIntegrationConfig = {},
): DiscordIntegration {
  return new DiscordIntegration(config);
}

// Default export
export default DiscordIntegration;
