/**
 * Kingly Vault - Discord Message Operations
 *
 * Message operations: send, delete, edit, DM, bulk delete.
 */

import type { APIMessage, APIUser } from "discord-api-types/v10";
import { Routes } from "discord-api-types/v10";
import { createVaultDiscordClient, wrapDiscordError, type VaultDiscordClientOpts } from "./client.js";
import type {
  Message,
  MessageOptions,
  MessageEmbed,
  MessageAttachment,
  DiscordUser,
} from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type MessageOpts = VaultDiscordClientOpts;

export type SendMessageResult = {
  messageId: string;
  channelId: string;
};

// ============================================================================
// Helper Functions
// ============================================================================

function normalizeUser(raw: APIUser): DiscordUser {
  return {
    id: raw.id,
    username: raw.username,
    discriminator: raw.discriminator,
    globalName: raw.global_name,
    avatar: raw.avatar,
    bot: raw.bot,
    system: raw.system,
  };
}

function normalizeAttachment(raw: {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url: string;
  content_type?: string;
  height?: number;
  width?: number;
}): MessageAttachment {
  return {
    id: raw.id,
    filename: raw.filename,
    size: raw.size,
    url: raw.url,
    proxyUrl: raw.proxy_url,
    contentType: raw.content_type,
    height: raw.height,
    width: raw.width,
  };
}

function normalizeMessage(raw: APIMessage): Message {
  return {
    id: raw.id,
    channelId: raw.channel_id,
    guildId: (raw as { guild_id?: string }).guild_id,
    author: normalizeUser(raw.author),
    content: raw.content,
    timestamp: new Date(raw.timestamp),
    editedTimestamp: raw.edited_timestamp ? new Date(raw.edited_timestamp) : null,
    tts: raw.tts,
    mentionEveryone: raw.mention_everyone,
    mentions: raw.mentions.map(normalizeUser),
    mentionRoles: raw.mention_roles,
    attachments: raw.attachments.map((a) => normalizeAttachment(a as {
      id: string;
      filename: string;
      size: number;
      url: string;
      proxy_url: string;
      content_type?: string;
      height?: number;
      width?: number;
    })),
    embeds: raw.embeds as MessageEmbed[],
    pinned: raw.pinned,
    type: raw.type,
    referencedMessage: raw.referenced_message
      ? normalizeMessage(raw.referenced_message)
      : null,
  };
}

function buildMessagePayload(
  content: string,
  options?: MessageOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: content || undefined,
  };

  if (options?.replyTo) {
    body.message_reference = {
      message_id: options.replyTo,
      fail_if_not_exists: false,
    };
  }

  if (options?.embeds?.length) {
    body.embeds = options.embeds;
  }

  if (options?.components?.length) {
    body.components = options.components;
  }

  if (options?.allowedMentions) {
    body.allowed_mentions = options.allowedMentions;
  }

  if (options?.tts !== undefined) {
    body.tts = options.tts;
  }

  return body;
}

// ============================================================================
// Send Message
// ============================================================================

/**
 * Sends a message to a channel.
 *
 * @param channelId - The channel ID to send to
 * @param content - Message content
 * @param options - Additional message options (embeds, reply, etc.)
 * @returns The sent message
 */
export async function sendMessage(
  channelId: string,
  content: string,
  options?: MessageOptions,
  opts: MessageOpts = {},
): Promise<Message> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    const body = buildMessagePayload(content, options);

    // Handle file attachments
    if (options?.files?.length) {
      // For now, we don't support file uploads through this interface
      // The caller should use the existing sendMessageDiscord with mediaUrl
      throw new Error("File attachments not yet supported - use mediaUrl instead");
    }

    const message = (await rest.post(Routes.channelMessages(channelId), {
      body,
    })) as APIMessage;

    return normalizeMessage(message);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to send message");
  }
}

/**
 * Sends a simple text message.
 */
export async function sendText(
  channelId: string,
  content: string,
  opts: MessageOpts = {},
): Promise<Message> {
  return sendMessage(channelId, content, undefined, opts);
}

/**
 * Sends a message with embeds.
 */
export async function sendEmbed(
  channelId: string,
  embeds: MessageEmbed[],
  content?: string,
  opts: MessageOpts = {},
): Promise<Message> {
  return sendMessage(channelId, content ?? "", { embeds }, opts);
}

/**
 * Sends a reply to a message.
 */
export async function sendReply(
  channelId: string,
  messageId: string,
  content: string,
  options?: Omit<MessageOptions, "replyTo">,
  opts: MessageOpts = {},
): Promise<Message> {
  return sendMessage(channelId, content, { ...options, replyTo: messageId }, opts);
}

// ============================================================================
// Direct Messages
// ============================================================================

/**
 * Creates a DM channel with a user.
 *
 * @param userId - The user ID to DM
 * @returns The DM channel ID
 */
async function createDMChannel(
  userId: string,
  opts: MessageOpts = {},
): Promise<string> {
  const { rest } = createVaultDiscordClient(opts);

  const dmChannel = (await rest.post(Routes.userChannels(), {
    body: { recipient_id: userId },
  })) as { id: string };

  if (!dmChannel?.id) {
    throw new Error("Failed to create DM channel");
  }

  return dmChannel.id;
}

/**
 * Sends a direct message to a user.
 *
 * @param userId - The user ID to DM
 * @param content - Message content
 * @returns The sent message
 */
export async function sendDM(
  userId: string,
  content: string,
  opts: MessageOpts = {},
): Promise<Message> {
  try {
    const channelId = await createDMChannel(userId, opts);
    return await sendMessage(channelId, content, undefined, opts);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to send DM");
  }
}

/**
 * Sends a DM with embeds.
 */
export async function sendDMEmbed(
  userId: string,
  embeds: MessageEmbed[],
  content?: string,
  opts: MessageOpts = {},
): Promise<Message> {
  try {
    const channelId = await createDMChannel(userId, opts);
    return await sendMessage(channelId, content ?? "", { embeds }, opts);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to send DM with embeds");
  }
}

// ============================================================================
// Delete Messages
// ============================================================================

/**
 * Deletes a message.
 *
 * @param channelId - The channel ID
 * @param messageId - The message ID to delete
 */
export async function deleteMessage(
  channelId: string,
  messageId: string,
  opts: MessageOpts = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    await rest.delete(Routes.channelMessage(channelId, messageId));
  } catch (err) {
    throw wrapDiscordError(err, "Failed to delete message");
  }
}

/**
 * Bulk deletes messages (2-100 messages, less than 14 days old).
 *
 * @param channelId - The channel ID
 * @param messageIds - Array of message IDs to delete
 */
export async function bulkDeleteMessages(
  channelId: string,
  messageIds: string[],
  opts: MessageOpts = {},
): Promise<void> {
  if (messageIds.length === 0) return;

  try {
    const { rest } = createVaultDiscordClient(opts);

    if (messageIds.length === 1) {
      await deleteMessage(channelId, messageIds[0], opts);
      return;
    }

    // Bulk delete endpoint requires 2-100 messages
    const chunks: string[][] = [];
    for (let i = 0; i < messageIds.length; i += 100) {
      chunks.push(messageIds.slice(i, i + 100));
    }

    for (const chunk of chunks) {
      await rest.post(Routes.channelBulkDelete(channelId), {
        body: { messages: chunk },
      });
    }
  } catch (err) {
    throw wrapDiscordError(err, "Failed to bulk delete messages");
  }
}

// ============================================================================
// Edit Messages
// ============================================================================

/**
 * Edits a message.
 *
 * @param channelId - The channel ID
 * @param messageId - The message ID to edit
 * @param content - New content
 * @param embeds - New embeds (optional)
 * @returns The edited message
 */
export async function editMessage(
  channelId: string,
  messageId: string,
  content: string,
  embeds?: MessageEmbed[],
  opts: MessageOpts = {},
): Promise<Message> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    const body: Record<string, unknown> = {
      content,
    };

    if (embeds !== undefined) {
      body.embeds = embeds;
    }

    const message = (await rest.patch(Routes.channelMessage(channelId, messageId), {
      body,
    })) as APIMessage;

    return normalizeMessage(message);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to edit message");
  }
}

// ============================================================================
// Fetch Messages
// ============================================================================

/**
 * Fetches a specific message.
 *
 * @param channelId - The channel ID
 * @param messageId - The message ID
 * @returns The message or null if not found
 */
export async function getMessage(
  channelId: string,
  messageId: string,
  opts: MessageOpts = {},
): Promise<Message | null> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    const message = (await rest.get(
      Routes.channelMessage(channelId, messageId),
    )) as APIMessage;
    return normalizeMessage(message);
  } catch {
    return null;
  }
}

/**
 * Fetches messages from a channel.
 *
 * @param channelId - The channel ID
 * @param options - Query options (limit, before, after, around)
 * @returns Array of messages
 */
export async function getMessages(
  channelId: string,
  options: {
    limit?: number;
    before?: string;
    after?: string;
    around?: string;
  } = {},
  opts: MessageOpts = {},
): Promise<Message[]> {
  try {
    const { rest } = createVaultDiscordClient(opts);

    const params: Record<string, string | number> = {};
    if (options.limit) params.limit = Math.min(Math.max(options.limit, 1), 100);
    if (options.before) params.before = options.before;
    if (options.after) params.after = options.after;
    if (options.around) params.around = options.around;

    const messages = (await rest.get(
      Routes.channelMessages(channelId),
      params,
    )) as APIMessage[];

    return messages.map(normalizeMessage);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to fetch messages");
  }
}

// ============================================================================
// Pin Messages
// ============================================================================

/**
 * Pins a message in a channel.
 */
export async function pinMessage(
  channelId: string,
  messageId: string,
  opts: MessageOpts = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    await rest.put(Routes.channelPin(channelId, messageId));
  } catch (err) {
    throw wrapDiscordError(err, "Failed to pin message");
  }
}

/**
 * Unpins a message from a channel.
 */
export async function unpinMessage(
  channelId: string,
  messageId: string,
  opts: MessageOpts = {},
): Promise<void> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    await rest.delete(Routes.channelPin(channelId, messageId));
  } catch (err) {
    throw wrapDiscordError(err, "Failed to unpin message");
  }
}

/**
 * Gets all pinned messages in a channel.
 */
export async function getPinnedMessages(
  channelId: string,
  opts: MessageOpts = {},
): Promise<Message[]> {
  try {
    const { rest } = createVaultDiscordClient(opts);
    const messages = (await rest.get(Routes.channelPins(channelId))) as APIMessage[];
    return messages.map(normalizeMessage);
  } catch (err) {
    throw wrapDiscordError(err, "Failed to get pinned messages");
  }
}

// Types are exported inline above
