/**
 * Kingly Vault - Discord Integration Types
 *
 * Discord-specific types for guild management, moderation, roles, channels, and members.
 * Imports shared types from store/types.ts where applicable.
 */

// Import shared types from canonical store
import type { Warning, ModAction, ModerationLog } from '../store/types.js';

// Re-export for convenience
export type { Warning, ModAction, ModerationLog };

// ============================================================================
// Core Discord Types
// ============================================================================

export type DiscordGuild = {
  id: string;
  name: string;
  icon?: string | null;
  ownerId: string;
  memberCount?: number;
  description?: string | null;
  features: string[];
  premiumTier: number;
  preferredLocale: string;
  createdAt: Date;
};

export type DiscordChannel = {
  id: string;
  guildId?: string;
  name: string;
  type: ChannelType;
  position?: number;
  parentId?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  permissionOverwrites?: ChannelPermissionOverwrite[];
};

export type ChannelType =
  | 0 // GUILD_TEXT
  | 2 // GUILD_VOICE
  | 4 // GUILD_CATEGORY
  | 5 // GUILD_ANNOUNCEMENT
  | 10 // ANNOUNCEMENT_THREAD
  | 11 // PUBLIC_THREAD
  | 12 // PRIVATE_THREAD
  | 13 // GUILD_STAGE_VOICE
  | 14 // GUILD_DIRECTORY
  | 15; // GUILD_FORUM

export type DiscordRole = {
  id: string;
  guildId: string;
  name: string;
  color: number;
  hoist: boolean;
  icon?: string | null;
  position: number;
  permissions: string;
  managed: boolean;
  mentionable: boolean;
};

export type DiscordMember = {
  id: string;
  guildId: string;
  userId: string;
  nickname?: string | null;
  displayName: string;
  username: string;
  discriminator?: string;
  avatar?: string | null;
  roles: string[];
  joinedAt: Date;
  premiumSince?: Date | null;
  deaf?: boolean;
  mute?: boolean;
  pending?: boolean;
  communicationDisabledUntil?: Date | null;
};

export type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string;
  globalName?: string | null;
  avatar?: string | null;
  bot?: boolean;
  system?: boolean;
};

// ============================================================================
// Permission Types
// ============================================================================

export type ChannelPermissionOverwrite = {
  id: string;
  type: 0 | 1; // 0 = role, 1 = member
  allow: string;
  deny: string;
};

export type ChannelPermission = {
  targetId: string;
  targetType: "role" | "member";
  allow?: string[];
  deny?: string[];
};

// Discord permission flags (as strings for BigInt handling)
export const DiscordPermissions = {
  CREATE_INSTANT_INVITE: "1",
  KICK_MEMBERS: "2",
  BAN_MEMBERS: "4",
  ADMINISTRATOR: "8",
  MANAGE_CHANNELS: "16",
  MANAGE_GUILD: "32",
  ADD_REACTIONS: "64",
  VIEW_AUDIT_LOG: "128",
  PRIORITY_SPEAKER: "256",
  STREAM: "512",
  VIEW_CHANNEL: "1024",
  SEND_MESSAGES: "2048",
  SEND_TTS_MESSAGES: "4096",
  MANAGE_MESSAGES: "8192",
  EMBED_LINKS: "16384",
  ATTACH_FILES: "32768",
  READ_MESSAGE_HISTORY: "65536",
  MENTION_EVERYONE: "131072",
  USE_EXTERNAL_EMOJIS: "262144",
  VIEW_GUILD_INSIGHTS: "524288",
  CONNECT: "1048576",
  SPEAK: "2097152",
  MUTE_MEMBERS: "4194304",
  DEAFEN_MEMBERS: "8388608",
  MOVE_MEMBERS: "16777216",
  USE_VAD: "33554432",
  CHANGE_NICKNAME: "67108864",
  MANAGE_NICKNAMES: "134217728",
  MANAGE_ROLES: "268435456",
  MANAGE_WEBHOOKS: "536870912",
  MANAGE_EXPRESSIONS: "1073741824",
  USE_APPLICATION_COMMANDS: "2147483648",
  REQUEST_TO_SPEAK: "4294967296",
  MANAGE_EVENTS: "8589934592",
  MANAGE_THREADS: "17179869184",
  CREATE_PUBLIC_THREADS: "34359738368",
  CREATE_PRIVATE_THREADS: "68719476736",
  USE_EXTERNAL_STICKERS: "137438953472",
  SEND_MESSAGES_IN_THREADS: "274877906944",
  USE_EMBEDDED_ACTIVITIES: "549755813888",
  MODERATE_MEMBERS: "1099511627776",
} as const;

// ============================================================================
// Moderation Types (Discord-specific)
// ============================================================================

export type WarningSeverity = "minor" | "moderate" | "severe";

export type ModerationAction = {
  id: string;
  guildId: string;
  moderatorId: string;
  targetUserId: string;
  actionType: "warn" | "timeout" | "kick" | "ban" | "unban";
  reason?: string;
  duration?: number; // in milliseconds, for timeouts
  createdAt: Date;
  metadata?: Record<string, unknown>;
};

export type TimeoutTarget = {
  guildId: string;
  userId: string;
  durationMs: number;
  reason?: string;
};

export type BanTarget = {
  guildId: string;
  userId: string;
  reason?: string;
  deleteMessageDays?: number;
};

export type KickTarget = {
  guildId: string;
  userId: string;
  reason?: string;
};

// ============================================================================
// Configuration Types
// ============================================================================

export type RoleConfig = {
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string;
  position?: number;
  icon?: string;
  unicodeEmoji?: string;
};

export type ChannelConfig = {
  name: string;
  type?: ChannelType;
  parentId?: string;
  topic?: string;
  position?: number;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  permissionOverwrites?: ChannelPermission[];
};

export type MessageOptions = {
  replyTo?: string;
  embeds?: MessageEmbed[];
  components?: MessageComponent[];
  files?: MessageFile[];
  allowedMentions?: AllowedMentions;
  tts?: boolean;
};

export type MessageEmbed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
};

export type MessageComponent = {
  type: number;
  components?: MessageComponent[];
  style?: number;
  label?: string;
  emoji?: { name?: string; id?: string; animated?: boolean };
  custom_id?: string;
  url?: string;
  disabled?: boolean;
  options?: Array<{
    label: string;
    value: string;
    description?: string;
    emoji?: { name?: string; id?: string };
    default?: boolean;
  }>;
  placeholder?: string;
  min_values?: number;
  max_values?: number;
};

export type MessageFile = {
  name: string;
  data: Buffer | Uint8Array;
  contentType?: string;
};

export type AllowedMentions = {
  parse?: Array<"roles" | "users" | "everyone">;
  roles?: string[];
  users?: string[];
  replied_user?: boolean;
};

// ============================================================================
// Message Types
// ============================================================================

export type Message = {
  id: string;
  channelId: string;
  guildId?: string;
  author: DiscordUser;
  content: string;
  timestamp: Date;
  editedTimestamp?: Date | null;
  tts: boolean;
  mentionEveryone: boolean;
  mentions: DiscordUser[];
  mentionRoles: string[];
  attachments: MessageAttachment[];
  embeds: MessageEmbed[];
  pinned: boolean;
  type: number;
  referencedMessage?: Message | null;
};

export type MessageAttachment = {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxyUrl: string;
  contentType?: string;
  height?: number;
  width?: number;
};

// ============================================================================
// API Response Types (from Discord API)
// ============================================================================

export type DiscordApiOpts = {
  token?: string;
  accountId?: string;
};

export type VaultDiscordError = {
  code: string;
  message: string;
  details?: unknown;
  discordCode?: number;
};

// ============================================================================
// Integration Types (for store coordination)
// ============================================================================

export type LoggableModerationAction = {
  type: ModerationAction["actionType"];
  guildId: string;
  targetUserId: string;
  moderatorId?: string;
  reason?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
};

export type DiscordIntegrationConfig = {
  accountId?: string;
  defaultModeratorId?: string;
  logModerationActions?: boolean;
};

/** Discord configuration for vault integration */
export type DiscordConfig = DiscordIntegrationConfig;
