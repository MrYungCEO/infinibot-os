/**
 * Kingly Vault Discord Integration
 * Handles all Discord API interactions for the vault system
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DiscordRole, DiscordChannel, VaultConfig } from "./types.js";

const log = createSubsystemLogger("vault-discord");

const DISCORD_API_DEFAULT = "https://discord.com/api/v10";

/**
 * API base. INFINIBOT_DISCORD_API_BASE points the helpers at a local fake
 * Discord for e2e runs; only loopback URLs are honoured so a stray env var can
 * never send a bot token to another host.
 */
export function discordApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.INFINIBOT_DISCORD_API_BASE?.trim();
  if (raw && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(raw))
    return raw.replace(/\/$/, "");
  return DISCORD_API_DEFAULT;
}

interface DiscordApiOptions {
  botToken: string;
  guildId: string;
}

async function discordFetch<T>(
  path: string,
  opts: DiscordApiOptions,
  init?: RequestInit,
): Promise<T> {
  const url = `${discordApiBase()}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bot ${opts.botToken}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log.error("Discord API error", {
      status: response.status,
      path,
      body: errorBody,
    });
    throw new Error(`Discord API error ${response.status}: ${errorBody}`);
  }

  // 204 No Content (role add/remove, kick, ban, delete) has no JSON body.
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Bot-level request (no guild in the path): current user, application, guild list. */
async function discordBotFetch<T>(path: string, botToken: string): Promise<T> {
  return discordFetch<T>(path, { botToken, guildId: "" });
}

// ============================================================
// Bot identity (setup wizards)
// ============================================================

export type DiscordBotUser = {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  bot: boolean;
};

/** GET /users/@me — the bot user behind a token. */
export async function getCurrentUser(botToken: string): Promise<DiscordBotUser> {
  const me = await discordBotFetch<any>("/users/@me", botToken);
  return {
    id: String(me.id),
    username: String(me.username ?? ""),
    globalName: me.global_name ?? null,
    avatar: me.avatar ?? null,
    bot: me.bot === true,
  };
}

export type DiscordApplicationInfo = {
  id: string;
  name: string;
  flags: number;
  botPublic: boolean;
  botRequireCodeGrant: boolean;
  approximateGuildCount: number | null;
};

/** GET /applications/@me — application id + flags (privileged intents live in the flags). */
export async function getCurrentApplication(botToken: string): Promise<DiscordApplicationInfo> {
  const app = await discordBotFetch<any>("/applications/@me", botToken);
  return {
    id: String(app.id),
    name: String(app.name ?? ""),
    flags: typeof app.flags === "number" ? app.flags : 0,
    botPublic: app.bot_public === true,
    botRequireCodeGrant: app.bot_require_code_grant === true,
    approximateGuildCount:
      typeof app.approximate_guild_count === "number" ? app.approximate_guild_count : null,
  };
}

export type DiscordBotGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  /** The bot's own permission bitfield in that guild (string, may exceed 2^53). */
  permissions: string;
  memberCount: number | null;
};

/** GET /users/@me/guilds — guilds the bot is in, with member counts. */
export async function listBotGuilds(botToken: string): Promise<DiscordBotGuild[]> {
  const guilds = await discordBotFetch<any[]>("/users/@me/guilds?with_counts=true", botToken);
  return (guilds ?? []).map((g) => ({
    id: String(g.id),
    name: String(g.name ?? ""),
    icon: g.icon ?? null,
    owner: g.owner === true,
    permissions: String(g.permissions ?? "0"),
    memberCount: typeof g.approximate_member_count === "number" ? g.approximate_member_count : null,
  }));
}

// ============================================================
// Guild Information
// ============================================================

export async function getGuild(opts: DiscordApiOptions): Promise<{
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
}> {
  const guild = await discordFetch<any>(`/guilds/${opts.guildId}?with_counts=true`, opts);
  return {
    id: guild.id,
    name: guild.name,
    icon: guild.icon,
    memberCount: guild.approximate_member_count || 0,
  };
}

// ============================================================
// Role Operations
// ============================================================

export async function listRoles(opts: DiscordApiOptions): Promise<DiscordRole[]> {
  const roles = await discordFetch<any[]>(`/guilds/${opts.guildId}/roles`, opts);
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    permissions: r.permissions,
    managed: r.managed,
    mentionable: r.mentionable ?? false,
  }));
}

export async function assignRole(
  opts: DiscordApiOptions,
  userId: string,
  roleId: string,
  reason?: string,
): Promise<void> {
  await discordFetch(`/guilds/${opts.guildId}/members/${userId}/roles/${roleId}`, opts, {
    method: "PUT",
    headers: reason ? { "X-Audit-Log-Reason": reason } : {},
  });
  log.info("Assigned role", { userId, roleId, reason });
}

export async function removeRole(
  opts: DiscordApiOptions,
  userId: string,
  roleId: string,
  reason?: string,
): Promise<void> {
  await discordFetch(`/guilds/${opts.guildId}/members/${userId}/roles/${roleId}`, opts, {
    method: "DELETE",
    headers: reason ? { "X-Audit-Log-Reason": reason } : {},
  });
  log.info("Removed role", { userId, roleId, reason });
}

// ============================================================
// Channel Operations
// ============================================================

export async function listChannels(opts: DiscordApiOptions): Promise<DiscordChannel[]> {
  const channels = await discordFetch<any[]>(`/guilds/${opts.guildId}/channels`, opts);
  return channels.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    parentId: c.parent_id || undefined,
    position: c.position,
  }));
}

export async function sendMessage(
  opts: DiscordApiOptions,
  channelId: string,
  content: string,
  options?: {
    embed?: {
      title?: string;
      description?: string;
      color?: number;
      fields?: Array<{ name: string; value: string; inline?: boolean }>;
      footer?: { text: string };
      timestamp?: string;
    };
    /** Raw Discord message components (action rows of buttons / selects). */
    components?: unknown[];
    /** Mention parsing; defaults to Discord's behaviour when omitted. */
    allowedMentions?: { parse?: Array<"users" | "roles" | "everyone">; users?: string[] };
  },
): Promise<{ id: string; channelId: string }> {
  const body: any = {};

  if (content) {
    body.content = content;
  }

  if (options?.embed) {
    body.embeds = [options.embed];
  }

  if (options?.components?.length) {
    body.components = options.components;
  }

  if (options?.allowedMentions) {
    body.allowed_mentions = options.allowedMentions;
  }

  const message = await discordFetch<any>(`/channels/${channelId}/messages`, opts, {
    method: "POST",
    body: JSON.stringify(body),
  });

  log.info("Sent message", { channelId, messageId: message.id });
  return { id: message.id, channelId };
}

export async function sendDM(
  opts: DiscordApiOptions,
  userId: string,
  content: string,
  options?: {
    embed?: {
      title?: string;
      description?: string;
      color?: number;
      fields?: Array<{ name: string; value: string; inline?: boolean }>;
    };
    components?: unknown[];
  },
): Promise<{ id: string; channelId: string }> {
  // Create DM channel
  const dmChannel = await discordFetch<any>(`/users/@me/channels`, opts, {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });

  // Send message to DM channel
  return sendMessage(opts, dmChannel.id, content, options);
}

export async function deleteMessage(
  opts: DiscordApiOptions,
  channelId: string,
  messageId: string,
  reason?: string,
): Promise<void> {
  await discordFetch(`/channels/${channelId}/messages/${messageId}`, opts, {
    method: "DELETE",
    headers: reason ? { "X-Audit-Log-Reason": reason } : {},
  });
  log.info("Deleted message", { channelId, messageId, reason });
}

/** Private thread under a text channel (only invited members + Manage Threads see it). */
export async function createPrivateThread(
  opts: DiscordApiOptions,
  channelId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const thread = await discordFetch<any>(`/channels/${channelId}/threads`, opts, {
    method: "POST",
    body: JSON.stringify({
      name: name.slice(0, 100),
      type: 12, // GUILD_PRIVATE_THREAD
      invitable: false,
      auto_archive_duration: 10080,
    }),
  });
  log.info("Created private thread", { channelId, threadId: thread.id });
  return { id: String(thread.id), name: String(thread.name ?? name) };
}

export async function addThreadMember(
  opts: DiscordApiOptions,
  threadId: string,
  userId: string,
): Promise<void> {
  await discordFetch(`/channels/${threadId}/thread-members/${userId}`, opts, { method: "PUT" });
}

// ============================================================
// Member Operations
// ============================================================

export async function getMember(
  opts: DiscordApiOptions,
  userId: string,
): Promise<{
  id: string;
  username: string;
  discriminator: string;
  nick: string | null;
  roles: string[];
  joinedAt: string;
  avatar: string | null;
} | null> {
  try {
    const member = await discordFetch<any>(`/guilds/${opts.guildId}/members/${userId}`, opts);
    return {
      id: member.user.id,
      username: member.user.username,
      discriminator: member.user.discriminator,
      nick: member.nick,
      roles: member.roles,
      joinedAt: member.joined_at,
      avatar: member.user.avatar,
    };
  } catch (err: any) {
    if (err.message?.includes("404")) {
      return null;
    }
    throw err;
  }
}

export async function listMembers(
  opts: DiscordApiOptions,
  options?: { limit?: number; after?: string },
): Promise<
  Array<{
    id: string;
    username: string;
    nick: string | null;
    roles: string[];
    joinedAt: string;
  }>
> {
  const limit = Math.min(options?.limit || 100, 1000);
  const params = new URLSearchParams({ limit: String(limit) });
  if (options?.after) {
    params.set("after", options.after);
  }

  const members = await discordFetch<any[]>(`/guilds/${opts.guildId}/members?${params}`, opts);

  return members.map((m) => ({
    id: m.user.id,
    username: m.user.username,
    nick: m.nick,
    roles: m.roles,
    joinedAt: m.joined_at,
  }));
}

// ============================================================
// Moderation Operations
// ============================================================

export async function kickMember(
  opts: DiscordApiOptions,
  userId: string,
  reason?: string,
): Promise<void> {
  await discordFetch(`/guilds/${opts.guildId}/members/${userId}`, opts, {
    method: "DELETE",
    headers: reason ? { "X-Audit-Log-Reason": reason } : {},
  });
  log.warn("Kicked member", { userId, reason });
}

export async function banMember(
  opts: DiscordApiOptions,
  userId: string,
  reason?: string,
  deleteMessageDays?: number,
): Promise<void> {
  await discordFetch(`/guilds/${opts.guildId}/bans/${userId}`, opts, {
    method: "PUT",
    body: JSON.stringify({
      delete_message_days: deleteMessageDays || 0,
    }),
    headers: reason ? { "X-Audit-Log-Reason": reason } : {},
  });
  log.warn("Banned member", { userId, reason, deleteMessageDays });
}

export async function unbanMember(
  opts: DiscordApiOptions,
  userId: string,
  reason?: string,
): Promise<void> {
  await discordFetch(`/guilds/${opts.guildId}/bans/${userId}`, opts, {
    method: "DELETE",
    headers: reason ? { "X-Audit-Log-Reason": reason } : {},
  });
  log.info("Unbanned member", { userId, reason });
}

export async function timeoutMember(
  opts: DiscordApiOptions,
  userId: string,
  durationMs: number,
  reason?: string,
): Promise<void> {
  const timeoutUntil = new Date(Date.now() + durationMs).toISOString();

  await discordFetch(`/guilds/${opts.guildId}/members/${userId}`, opts, {
    method: "PATCH",
    body: JSON.stringify({
      communication_disabled_until: timeoutUntil,
    }),
    headers: reason ? { "X-Audit-Log-Reason": reason } : {},
  });
  log.warn("Timed out member", { userId, durationMs, reason });
}

export async function removeTimeout(
  opts: DiscordApiOptions,
  userId: string,
  reason?: string,
): Promise<void> {
  await discordFetch(`/guilds/${opts.guildId}/members/${userId}`, opts, {
    method: "PATCH",
    body: JSON.stringify({
      communication_disabled_until: null,
    }),
    headers: reason ? { "X-Audit-Log-Reason": reason } : {},
  });
  log.info("Removed timeout", { userId, reason });
}

// ============================================================
// Audit Log
// ============================================================

export async function getAuditLog(
  opts: DiscordApiOptions,
  options?: {
    userId?: string;
    actionType?: number;
    limit?: number;
  },
): Promise<
  Array<{
    id: string;
    actionType: number;
    userId: string;
    targetId: string | null;
    reason: string | null;
    createdAt: number;
  }>
> {
  const params = new URLSearchParams();
  if (options?.userId) params.set("user_id", options.userId);
  if (options?.actionType) params.set("action_type", String(options.actionType));
  if (options?.limit) params.set("limit", String(Math.min(options.limit, 100)));

  const audit = await discordFetch<any>(`/guilds/${opts.guildId}/audit-logs?${params}`, opts);

  return (audit.audit_log_entries || []).map((entry: any) => ({
    id: entry.id,
    actionType: entry.action_type,
    userId: entry.user_id,
    targetId: entry.target_id,
    reason: entry.reason,
    createdAt: Number(BigInt(entry.id) >> BigInt(22)) + 1420070400000,
  }));
}

// ============================================================
// Utility Functions
// ============================================================

export function createDiscordClient(config: VaultConfig) {
  if (!config.botToken) {
    throw new Error("Discord bot token not configured");
  }
  if (!config.guildId) {
    throw new Error("Discord guild ID not configured");
  }

  const opts: DiscordApiOptions = {
    botToken: config.botToken,
    guildId: config.guildId,
  };

  return {
    // Guild
    getGuild: () => getGuild(opts),

    // Roles
    listRoles: () => listRoles(opts),
    assignRole: (userId: string, roleId: string, reason?: string) =>
      assignRole(opts, userId, roleId, reason),
    removeRole: (userId: string, roleId: string, reason?: string) =>
      removeRole(opts, userId, roleId, reason),

    // Channels
    listChannels: () => listChannels(opts),
    sendMessage: (
      channelId: string,
      content: string,
      options?: Parameters<typeof sendMessage>[3],
    ) => sendMessage(opts, channelId, content, options),
    sendDM: (userId: string, content: string, options?: Parameters<typeof sendDM>[3]) =>
      sendDM(opts, userId, content, options),

    // Members
    getMember: (userId: string) => getMember(opts, userId),
    listMembers: (options?: Parameters<typeof listMembers>[1]) => listMembers(opts, options),

    // Moderation
    kickMember: (userId: string, reason?: string) => kickMember(opts, userId, reason),
    banMember: (userId: string, reason?: string, deleteMessageDays?: number) =>
      banMember(opts, userId, reason, deleteMessageDays),
    unbanMember: (userId: string, reason?: string) => unbanMember(opts, userId, reason),
    timeoutMember: (userId: string, durationMs: number, reason?: string) =>
      timeoutMember(opts, userId, durationMs, reason),
    removeTimeout: (userId: string, reason?: string) => removeTimeout(opts, userId, reason),

    // Audit
    getAuditLog: (options?: Parameters<typeof getAuditLog>[1]) => getAuditLog(opts, options),
  };
}

export type DiscordClient = ReturnType<typeof createDiscordClient>;

// ============================================================
// Helper for mod log messages
// ============================================================

export function formatModLogEmbed(
  action: string,
  target: { id: string; username: string },
  moderator: string,
  reason?: string,
  details?: Record<string, string>,
): Parameters<typeof sendMessage>[3] {
  const colors: Record<string, number> = {
    warn: 0xffa500, // Orange
    timeout: 0xff6b6b, // Light red
    kick: 0xff4444, // Red
    ban: 0x8b0000, // Dark red
    unban: 0x00ff00, // Green
  };

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "User", value: `<@${target.id}> (${target.username})`, inline: true },
    { name: "Moderator", value: moderator, inline: true },
  ];

  if (reason) {
    fields.push({ name: "Reason", value: reason, inline: false });
  }

  if (details) {
    for (const [key, value] of Object.entries(details)) {
      fields.push({ name: key, value, inline: true });
    }
  }

  return {
    embed: {
      title: `🔨 ${action}`,
      color: colors[action.toLowerCase()] || 0x5865f2,
      fields,
      timestamp: new Date().toISOString(),
    },
  };
}
