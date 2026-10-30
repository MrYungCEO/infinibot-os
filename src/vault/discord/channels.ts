/**
 * Kingly Vault - Discord Channel Management
 *
 * Channel operations: list, create, edit, delete, permissions.
 */

import type { APIChannel } from "discord-api-types/v10";
import { Routes } from "discord-api-types/v10";
import {
  createVaultDiscordClient,
  wrapDiscordError,
  type VaultDiscordClientOpts,
} from "./client.js";
import type { DiscordChannel, ChannelConfig, ChannelPermission, ChannelType } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type ChannelOptions = VaultDiscordClientOpts;

export type ChannelEditConfig = Partial<Omit<ChannelConfig, "type">> & {
  /** Lock permissions to sync with parent category */
  lockPermissions?: boolean;
};

// ============================================================================
// Helper Functions
// ============================================================================

function normalizeChannel(raw: APIChannel): DiscordChannel {
  return {
    id: raw.id,
    guildId: "guild_id" in raw ? raw.guild_id : undefined,
    name: "name" in raw && raw.name ? raw.name : "DM",
    type: raw.type as ChannelType,
    position: "position" in raw ? raw.position : undefined,
    parentId: "parent_id" in raw ? raw.parent_id : undefined,
    topic: "topic" in raw ? raw.topic : undefined,
    nsfw: "nsfw" in raw ? raw.nsfw : undefined,
    rateLimitPerUser: "rate_limit_per_user" in raw ? raw.rate_limit_per_user : undefined,
    permissionOverwrites:
      "permission_overwrites" in raw && raw.permission_overwrites
        ? raw.permission_overwrites.map((ow) => ({
            id: ow.id,
            type: ow.type as 0 | 1,
            allow: ow.allow,
            deny: ow.deny,
          }))
        : undefined,
  };
}

function buildChannelPayload(config: ChannelConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: config.name,
  };

  if (config.type !== undefined) body.type = config.type;
  if (config.parentId !== undefined) body.parent_id = config.parentId;
  if (config.topic !== undefined) body.topic = config.topic;
  if (config.position !== undefined) body.position = config.position;
  if (config.nsfw !== undefined) body.nsfw = config.nsfw;
  if (config.rateLimitPerUser !== undefined) body.rate_limit_per_user = config.rateLimitPerUser;

  if (config.permissionOverwrites?.length) {
    body.permission_overwrites = config.permissionOverwrites.map((perm) => ({
      id: perm.targetId,
      type: perm.targetType === "member" ? 1 : 0,
      allow: perm.allow?.join(",") ?? "0",
      deny: perm.deny?.join(",") ?? "0",
    }));
  }

  return body;
}

// ============================================================================
// List Channels
// ============================================================================

/**
 * Gets all channels in a guild.
 *
 * @param guildId - The guild ID
 * @returns Array of channels sorted by position
 */
export async function getChannels(
  guildId: string,
  opts: ChannelOptions = {},
): Promise<DiscordChannel[]> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    const channels = (await rest.get(Routes.guildChannels(guildId))) as APIChannel[];

    return channels.map(normalizeChannel).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  } catch (err) {
    throw wrapDiscordError(err, "Failed to get channels");
  }
}

/**
 * Gets channels filtered by type.
 *
 * @param guildId - The guild ID
 * @param type - Channel type to filter by
 * @returns Filtered array of channels
 */
export async function getChannelsByType(
  guildId: string,
  type: ChannelType,
  opts: ChannelOptions = {},
): Promise<DiscordChannel[]> {
  const channels = await getChannels(guildId, opts);
  return channels.filter((c) => c.type === type);
}

/**
 * Gets all text channels in a guild.
 */
export async function getTextChannels(
  guildId: string,
  opts: ChannelOptions = {},
): Promise<DiscordChannel[]> {
  return getChannelsByType(guildId, 0, opts);
}

/**
 * Gets all voice channels in a guild.
 */
export async function getVoiceChannels(
  guildId: string,
  opts: ChannelOptions = {},
): Promise<DiscordChannel[]> {
  return getChannelsByType(guildId, 2, opts);
}

/**
 * Gets all categories in a guild.
 */
export async function getCategories(
  guildId: string,
  opts: ChannelOptions = {},
): Promise<DiscordChannel[]> {
  return getChannelsByType(guildId, 4, opts);
}

/**
 * Gets a specific channel by ID.
 *
 * @param channelId - The channel ID
 * @returns The channel or null if not found
 */
export async function getChannel(
  channelId: string,
  opts: ChannelOptions = {},
): Promise<DiscordChannel | null> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
    return normalizeChannel(channel);
  } catch {
    return null;
  }
}

/**
 * Finds a channel by name (case-insensitive).
 *
 * @param guildId - The guild ID
 * @param name - The channel name to search for
 * @returns The first matching channel or null
 */
export async function findChannelByName(
  guildId: string,
  name: string,
  opts: ChannelOptions = {},
): Promise<DiscordChannel | null> {
  try {
    const channels = await getChannels(guildId, opts);
    const lowerName = name.toLowerCase();
    return channels.find((c) => c.name.toLowerCase() === lowerName) ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// Create Channel
// ============================================================================

/**
 * Creates a new channel in a guild.
 *
 * @param guildId - The guild ID
 * @param config - Channel configuration
 * @returns The created channel
 */
export async function createChannel(
  guildId: string,
  config: ChannelConfig,
  opts: ChannelOptions = {},
): Promise<DiscordChannel> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    const body = buildChannelPayload(config);

    const channel = (await rest.post(Routes.guildChannels(guildId), {
      body,
    })) as APIChannel;

    return normalizeChannel(channel);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to create channel");
  }
}

/**
 * Creates a text channel.
 */
export async function createTextChannel(
  guildId: string,
  name: string,
  config: Partial<Omit<ChannelConfig, "name" | "type">> = {},
  opts: ChannelOptions = {},
): Promise<DiscordChannel> {
  return createChannel(guildId, { ...config, name, type: 0 }, opts);
}

/**
 * Creates a voice channel.
 */
export async function createVoiceChannel(
  guildId: string,
  name: string,
  config: Partial<Omit<ChannelConfig, "name" | "type">> = {},
  opts: ChannelOptions = {},
): Promise<DiscordChannel> {
  return createChannel(guildId, { ...config, name, type: 2 }, opts);
}

/**
 * Creates a category.
 */
export async function createCategory(
  guildId: string,
  name: string,
  config: Partial<Omit<ChannelConfig, "name" | "type" | "parentId">> = {},
  opts: ChannelOptions = {},
): Promise<DiscordChannel> {
  return createChannel(guildId, { ...config, name, type: 4 }, opts);
}

// ============================================================================
// Edit Channel
// ============================================================================

/**
 * Edits an existing channel.
 *
 * @param channelId - The channel ID
 * @param config - Partial channel configuration
 * @returns The updated channel
 */
export async function editChannel(
  channelId: string,
  config: ChannelEditConfig,
  opts: ChannelOptions = {},
): Promise<DiscordChannel> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    const body: Record<string, unknown> = {};
    if (config.name !== undefined) body.name = config.name;
    if (config.parentId !== undefined) body.parent_id = config.parentId;
    if (config.topic !== undefined) body.topic = config.topic;
    if (config.position !== undefined) body.position = config.position;
    if (config.nsfw !== undefined) body.nsfw = config.nsfw;
    if (config.rateLimitPerUser !== undefined) body.rate_limit_per_user = config.rateLimitPerUser;
    if (config.lockPermissions !== undefined) body.lock_permissions = config.lockPermissions;

    const channel = (await rest.patch(Routes.channel(channelId), {
      body,
    })) as APIChannel;

    return normalizeChannel(channel);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to edit channel");
  }
}

/**
 * Moves a channel to a new position or category.
 *
 * @param guildId - The guild ID
 * @param channelId - The channel ID
 * @param position - New position
 * @param parentId - New parent category (null to remove from category)
 */
export async function moveChannel(
  guildId: string,
  channelId: string,
  position?: number,
  parentId?: string | null,
  opts: ChannelOptions = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    const payload: Record<string, unknown> = { id: channelId };
    if (position !== undefined) payload.position = position;
    if (parentId !== undefined) payload.parent_id = parentId;

    await rest.patch(Routes.guildChannels(guildId), {
      body: [payload],
    });
  } catch (err) {
    throw wrapDiscordError(err, "Failed to move channel");
  }
}

// ============================================================================
// Delete Channel
// ============================================================================

/**
 * Deletes a channel from a guild.
 *
 * @param guildId - The guild ID (for validation, not used in API call)
 * @param channelId - The channel ID to delete
 */
export async function deleteChannel(
  guildId: string,
  channelId: string,
  opts: ChannelOptions = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    await rest.delete(Routes.channel(channelId));
  } catch (err) {
    throw wrapDiscordError(err, "Failed to delete channel");
  }
}

// ============================================================================
// Permissions
// ============================================================================

/**
 * Sets permission overwrites for a channel.
 *
 * @param guildId - The guild ID (for validation)
 * @param channelId - The channel ID
 * @param perms - Array of permission overwrites to set
 */
export async function setPermissions(
  guildId: string,
  channelId: string,
  perms: ChannelPermission[],
  opts: ChannelOptions = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    for (const perm of perms) {
      const body: Record<string, unknown> = {
        type: perm.targetType === "member" ? 1 : 0,
      };

      // Calculate permission bitfield from array of permission names
      // For simplicity, we pass the permissions as comma-separated or as the raw bitfield
      if (perm.allow?.length) {
        body.allow = perm.allow.join(",");
      }
      if (perm.deny?.length) {
        body.deny = perm.deny.join(",");
      }

      await rest.put(`/channels/${channelId}/permissions/${perm.targetId}`, {
        body,
      });
    }
  } catch (err) {
    throw wrapDiscordError(err, "Failed to set permissions");
  }
}

/**
 * Sets a single permission overwrite for a channel.
 *
 * @param channelId - The channel ID
 * @param targetId - The role or user ID
 * @param targetType - Whether target is a role or member
 * @param allow - Permissions to allow (as bitfield string)
 * @param deny - Permissions to deny (as bitfield string)
 */
export async function setPermissionOverwrite(
  channelId: string,
  targetId: string,
  targetType: "role" | "member",
  allow?: string,
  deny?: string,
  opts: ChannelOptions = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    const body: Record<string, unknown> = {
      type: targetType === "member" ? 1 : 0,
    };
    if (allow !== undefined) body.allow = allow;
    if (deny !== undefined) body.deny = deny;

    await rest.put(`/channels/${channelId}/permissions/${targetId}`, {
      body,
    });
  } catch (err) {
    throw wrapDiscordError(err, "Failed to set permission overwrite");
  }
}

/**
 * Removes a permission overwrite from a channel.
 *
 * @param channelId - The channel ID
 * @param targetId - The role or user ID whose overwrite to remove
 */
export async function removePermissionOverwrite(
  channelId: string,
  targetId: string,
  opts: ChannelOptions = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    await rest.delete(`/channels/${channelId}/permissions/${targetId}`);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to remove permission overwrite");
  }
}

/**
 * Syncs channel permissions with its parent category.
 *
 * @param channelId - The channel ID
 */
export async function syncPermissions(
  channelId: string,
  opts: ChannelOptions = {},
): Promise<DiscordChannel> {
  return editChannel(channelId, { lockPermissions: true }, opts);
}

// Types are exported inline above
