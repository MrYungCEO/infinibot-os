import {
  ChannelType,
  type Client,
  GuildMemberAddListener,
  GuildMemberRemoveListener,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  PresenceUpdateListener,
} from "@buape/carbon";

import { danger } from "../../globals.js";
import { formatDurationSeconds } from "../../infra/format-duration.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { setPresence } from "./presence-cache.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import {
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  shouldEmitDiscordReactionNotification,
} from "./allow-list.js";
import { emitDiscordCommunityEvent, hasDiscordCommunityListeners } from "../community-events.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";

type LoadedConfig = ReturnType<typeof import("../../config/config.js").loadConfig>;
type RuntimeEnv = import("../../runtime.js").RuntimeEnv;
type Logger = ReturnType<typeof import("../../logging/subsystem.js").createSubsystemLogger>;

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];

export type DiscordMessageHandler = (data: DiscordMessageEvent, client: Client) => Promise<void>;

type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

function logSlowDiscordListener(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  durationMs: number;
}) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) return;
  const duration = formatDurationSeconds(params.durationMs, {
    decimals: 1,
    unit: "seconds",
  });
  const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
  const logger = params.logger ?? discordEventQueueLog;
  logger.warn("Slow listener detected", {
    listener: params.listener,
    event: params.event,
    durationMs: params.durationMs,
    duration,
    consoleMessage: message,
  });
}

export function registerDiscordListener(listeners: Array<object>, listener: object) {
  if (listeners.some((existing) => existing.constructor === listener.constructor)) {
    return false;
  }
  listeners.push(listener);
  return true;
}

export class DiscordMessageListener extends MessageCreateListener {
  constructor(
    private handler: DiscordMessageHandler,
    private logger?: Logger,
    /** When set, guild messages are also published on the community event bus. */
    private accountId?: string,
  ) {
    super();
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    const startedAt = Date.now();
    if (this.accountId) publishCommunityMessage(this.accountId, data, this.logger);
    const task = Promise.resolve(this.handler(data, client));
    void task
      .catch((err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord handler failed: ${String(err)}`));
      })
      .finally(() => {
        logSlowDiscordListener({
          logger: this.logger,
          listener: this.constructor.name,
          event: this.type,
          durationMs: Date.now() - startedAt,
        });
      });
  }
}

export class DiscordReactionListener extends MessageReactionAddListener {
  constructor(
    private params: {
      cfg: LoadedConfig;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
      guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
      logger: Logger;
    },
  ) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    const startedAt = Date.now();
    try {
      await handleDiscordReactionEvent({
        data,
        client,
        action: "added",
        cfg: this.params.cfg,
        accountId: this.params.accountId,
        botUserId: this.params.botUserId,
        guildEntries: this.params.guildEntries,
        logger: this.params.logger,
      });
    } finally {
      logSlowDiscordListener({
        logger: this.params.logger,
        listener: this.constructor.name,
        event: this.type,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

export class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
  constructor(
    private params: {
      cfg: LoadedConfig;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
      guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
      logger: Logger;
    },
  ) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    const startedAt = Date.now();
    try {
      await handleDiscordReactionEvent({
        data,
        client,
        action: "removed",
        cfg: this.params.cfg,
        accountId: this.params.accountId,
        botUserId: this.params.botUserId,
        guildEntries: this.params.guildEntries,
        logger: this.params.logger,
      });
    } finally {
      logSlowDiscordListener({
        logger: this.params.logger,
        listener: this.constructor.name,
        event: this.type,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

async function handleDiscordReactionEvent(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  cfg: LoadedConfig;
  accountId: string;
  botUserId?: string;
  guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
  logger: Logger;
}) {
  try {
    const { data, client, action, botUserId, guildEntries } = params;
    if (!("user" in data)) return;
    const user = data.user;
    if (!user || user.bot) return;
    if (!data.guild_id) return;

    const guildInfo = resolveDiscordGuildEntry({
      guild: data.guild ?? undefined,
      guildEntries,
    });
    if (guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
      return;
    }

    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) return;
    const channelName = "name" in channel ? (channel.name ?? undefined) : undefined;
    const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
    const channelType = "type" in channel ? channel.type : undefined;
    const isThreadChannel =
      channelType === ChannelType.PublicThread ||
      channelType === ChannelType.PrivateThread ||
      channelType === ChannelType.AnnouncementThread;
    let parentId = "parentId" in channel ? (channel.parentId ?? undefined) : undefined;
    let parentName: string | undefined;
    let parentSlug = "";
    if (isThreadChannel) {
      if (!parentId) {
        const channelInfo = await resolveDiscordChannelInfo(client, data.channel_id);
        parentId = channelInfo?.parentId;
      }
      if (parentId) {
        const parentInfo = await resolveDiscordChannelInfo(client, parentId);
        parentName = parentInfo?.name;
        parentSlug = parentName ? normalizeDiscordSlug(parentName) : "";
      }
    }
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      parentId,
      parentName,
      parentSlug,
      scope: isThreadChannel ? "thread" : "channel",
    });
    if (channelConfig?.allowed === false) return;

    if (botUserId && user.id === botUserId) return;

    const reactionMode = guildInfo?.reactionNotifications ?? "own";
    const message = await data.message.fetch().catch(() => null);
    const messageAuthorId = message?.author?.id ?? undefined;
    const shouldNotify = shouldEmitDiscordReactionNotification({
      mode: reactionMode,
      botId: botUserId,
      messageAuthorId,
      userId: user.id,
      userName: user.username,
      userTag: formatDiscordUserTag(user),
      allowlist: guildInfo?.users,
    });
    if (!shouldNotify) return;

    const emojiLabel = formatDiscordReactionEmoji(data.emoji);
    const actorLabel = formatDiscordUserTag(user);
    const guildSlug =
      guildInfo?.slug || (data.guild?.name ? normalizeDiscordSlug(data.guild.name) : data.guild_id);
    const channelLabel = channelSlug
      ? `#${channelSlug}`
      : channelName
        ? `#${normalizeDiscordSlug(channelName)}`
        : `#${data.channel_id}`;
    const authorLabel = message?.author ? formatDiscordUserTag(message.author) : undefined;
    const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
    const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
    const route = resolveAgentRoute({
      cfg: params.cfg,
      channel: "discord",
      accountId: params.accountId,
      guildId: data.guild_id ?? undefined,
      peer: { kind: "channel", id: data.channel_id },
    });
    enqueueSystemEvent(text, {
      sessionKey: route.sessionKey,
      contextKey: `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`,
    });
  } catch (err) {
    params.logger.error(danger(`discord reaction handler failed: ${String(err)}`));
  }
}

type PresenceUpdateEvent = Parameters<PresenceUpdateListener["handle"]>[0];

export class DiscordPresenceListener extends PresenceUpdateListener {
  private logger?: Logger;
  private accountId?: string;

  constructor(params: { logger?: Logger; accountId?: string }) {
    super();
    this.logger = params.logger;
    this.accountId = params.accountId;
  }

  async handle(data: PresenceUpdateEvent) {
    try {
      const userId =
        "user" in data && data.user && typeof data.user === "object" && "id" in data.user
          ? String(data.user.id)
          : undefined;
      if (!userId) return;
      setPresence(
        this.accountId,
        userId,
        data as import("discord-api-types/v10").GatewayPresenceUpdate,
      );
    } catch (err) {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord presence handler failed: ${String(err)}`));
    }
  }
}

type RawCommunityUser = {
  id?: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
};

function communityUser(raw: RawCommunityUser | undefined | null) {
  if (!raw?.id) return null;
  return {
    id: raw.id,
    username: raw.username ?? raw.id,
    globalName: raw.global_name ?? null,
    avatar: raw.avatar ?? null,
    bot: raw.bot === true,
  };
}

/** Guild message → community bus (fire-and-forget, never blocks the reply path). */
function publishCommunityMessage(accountId: string, data: DiscordMessageEvent, logger?: Logger) {
  if (!hasDiscordCommunityListeners()) return;
  const guildId = (data as { guild_id?: string }).guild_id;
  const message = data.message as unknown as {
    id?: string;
    channelId?: string;
    content?: string;
    rawData?: { channel_id?: string; content?: string; author?: RawCommunityUser };
  };
  const author = communityUser(
    message.rawData?.author ?? (data.author as unknown as RawCommunityUser),
  );
  const channelId = message.rawData?.channel_id ?? message.channelId;
  if (!guildId || !author || !channelId || !message.id) return;
  void emitDiscordCommunityEvent(
    {
      kind: "message",
      accountId,
      guildId,
      channelId,
      messageId: message.id,
      author,
      content: message.rawData?.content ?? message.content ?? "",
    },
    (err) =>
      (logger ?? discordEventQueueLog).warn(`community message listener failed: ${String(err)}`),
  );
}

type MemberAddEvent = Parameters<GuildMemberAddListener["handle"]>[0];
type MemberRemoveEvent = Parameters<GuildMemberRemoveListener["handle"]>[0];

/** GuildMemberAdd → community bus. Needs the GuildMembers intent. */
export class DiscordCommunityMemberAddListener extends GuildMemberAddListener {
  constructor(private params: { accountId: string; logger?: Logger }) {
    super();
  }

  async handle(data: MemberAddEvent) {
    const raw = data as unknown as {
      guild_id?: string;
      user?: RawCommunityUser;
      joined_at?: string | null;
      member?: { rawData?: { user?: RawCommunityUser; joined_at?: string | null } };
    };
    const user = communityUser(raw.user ?? raw.member?.rawData?.user);
    if (!raw.guild_id || !user) return;
    await emitDiscordCommunityEvent(
      {
        kind: "member_add",
        accountId: this.params.accountId,
        guildId: raw.guild_id,
        user,
        joinedAt: raw.joined_at ?? raw.member?.rawData?.joined_at ?? null,
      },
      (err) =>
        (this.params.logger ?? discordEventQueueLog).warn(
          `community member-add listener failed: ${String(err)}`,
        ),
    );
  }
}

/** GuildMemberRemove → community bus. Needs the GuildMembers intent. */
export class DiscordCommunityMemberRemoveListener extends GuildMemberRemoveListener {
  constructor(private params: { accountId: string; logger?: Logger }) {
    super();
  }

  async handle(data: MemberRemoveEvent) {
    const raw = data as unknown as {
      guild_id?: string;
      rawUser?: RawCommunityUser;
      user?: { id?: string };
    };
    const userId = raw.rawUser?.id ?? raw.user?.id;
    if (!raw.guild_id || !userId) return;
    await emitDiscordCommunityEvent(
      { kind: "member_remove", accountId: this.params.accountId, guildId: raw.guild_id, userId },
      (err) =>
        (this.params.logger ?? discordEventQueueLog).warn(
          `community member-remove listener failed: ${String(err)}`,
        ),
    );
  }
}
