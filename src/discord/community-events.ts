/**
 * Discord community event fan-out.
 *
 * The Discord monitor (src/discord/monitor/*) publishes a small, typed set of
 * guild events here — member joins/leaves, guild messages and presses of
 * `cm:` buttons / `cmsel:` select menus — so a plugin (community-manager)
 * can run deterministic onboarding and moderation without opening a second
 * Discord connection.
 *
 * Plugins run in their own jiti module instances, so the listener set lives on
 * `globalThis` under a registered symbol: core's instance and every plugin
 * instance see the same subscribers.
 *
 * Nothing here ever carries a bot token.
 */

export type DiscordCommunityUser = {
  id: string;
  username: string;
  globalName?: string | null;
  avatar?: string | null;
  bot?: boolean;
};

export type DiscordCommunityEvent =
  | {
      kind: "member_add";
      accountId: string;
      guildId: string;
      user: DiscordCommunityUser;
      joinedAt: string | null;
    }
  | { kind: "member_remove"; accountId: string; guildId: string; userId: string }
  | {
      kind: "message";
      accountId: string;
      guildId: string;
      channelId: string;
      messageId: string;
      author: DiscordCommunityUser;
      content: string;
    }
  | {
      kind: "component";
      accountId: string;
      guildId: string | null;
      channelId: string | null;
      user: DiscordCommunityUser;
      /** Full custom id, e.g. `cm:a=verify` or `cmsel:q=intent`. */
      customId: string;
      /** Selected option values (select menus only). */
      values: string[];
    };

/** What a component subscriber wants sent back to the member (ephemeral by default). */
export type DiscordCommunityComponentReply = {
  content: string;
  ephemeral?: boolean;
  /** Raw Discord message components (action rows). */
  components?: unknown[];
};

export type DiscordCommunityListener = (
  event: DiscordCommunityEvent,
) =>
  | void
  | DiscordCommunityComponentReply
  | null
  | Promise<void | DiscordCommunityComponentReply | null>;

/** Custom-id keys reserved for community components (Carbon key before ":"). */
export const COMMUNITY_BUTTON_KEY = "cm";
export const COMMUNITY_SELECT_KEY = "cmsel";

const LISTENERS = Symbol.for("infinibot.discord.community.listeners");

function listeners(): Set<DiscordCommunityListener> {
  const g = globalThis as unknown as Record<symbol, Set<DiscordCommunityListener> | undefined>;
  let set = g[LISTENERS];
  if (!set) {
    set = new Set();
    g[LISTENERS] = set;
  }
  return set;
}

export function onDiscordCommunityEvent(listener: DiscordCommunityListener): () => void {
  const set = listeners();
  set.add(listener);
  return () => set.delete(listener);
}

export function hasDiscordCommunityListeners(): boolean {
  return listeners().size > 0;
}

/**
 * Publish an event. Resolves to the first component reply a subscriber
 * returned (component events only); listener errors are reported through
 * `onError` and never thrown into the Discord monitor.
 */
export async function emitDiscordCommunityEvent(
  event: DiscordCommunityEvent,
  onError?: (err: unknown) => void,
): Promise<DiscordCommunityComponentReply | null> {
  let reply: DiscordCommunityComponentReply | null = null;
  for (const listener of [...listeners()]) {
    try {
      const out = await listener(event);
      if (!reply && out && typeof out === "object" && typeof out.content === "string") {
        reply = out;
      }
    } catch (err) {
      onError?.(err);
    }
  }
  return reply;
}

/** Discord snowflake → creation time (ms). */
export function snowflakeToMs(id: string): number | null {
  try {
    return Number(BigInt(id) >> 22n) + 1420070400000;
  } catch {
    return null;
  }
}
