/**
 * Discord community seam — the single surface the first-party
 * `community-manager` plugin uses to reach core's Discord pieces. Re-exported
 * by `infinibot/plugin-sdk` as `discordCommunity`.
 *
 *   - events:   the community event bus fed by the Discord monitor
 *               (member joins/leaves, guild messages, `cm:` components)
 *   - rest:     KinglyVault's Discord REST helpers (src/vault/discord.ts) —
 *               reused, not duplicated
 *   - probe:    token normalisation + privileged-intent decoding (probe.ts)
 *   - account:  which token a configured Discord account resolves to
 *
 * Tokens are passed in by the caller and never logged here.
 */

import type { InfinibotConfig } from "../config/config.js";
import * as vaultDiscord from "../vault/discord.js";
import { resolveDiscordAccount } from "./accounts.js";
import {
  emitDiscordCommunityEvent,
  hasDiscordCommunityListeners,
  onDiscordCommunityEvent,
  snowflakeToMs,
} from "./community-events.js";
import { resolveDiscordPrivilegedIntentsFromFlags } from "./probe.js";
import { normalizeDiscordToken } from "./token.js";

export const discordCommunity = {
  onEvent: onDiscordCommunityEvent,
  emit: emitDiscordCommunityEvent,
  hasListeners: hasDiscordCommunityListeners,
  snowflakeToMs,
  normalizeToken: normalizeDiscordToken,
  intentsFromFlags: resolveDiscordPrivilegedIntentsFromFlags,
  /** Token + enabled state of one configured Discord account (never logged). */
  resolveAccount(cfg: InfinibotConfig, accountId: string) {
    const acct = resolveDiscordAccount({ cfg, accountId });
    return {
      accountId: acct.accountId,
      enabled: acct.enabled,
      token: acct.token,
      tokenSource: acct.tokenSource,
      guildMembersIntent: acct.config.intents?.guildMembers === true,
    };
  },
  rest: {
    getCurrentUser: vaultDiscord.getCurrentUser,
    getCurrentApplication: vaultDiscord.getCurrentApplication,
    listBotGuilds: vaultDiscord.listBotGuilds,
    getGuild: vaultDiscord.getGuild,
    listRoles: vaultDiscord.listRoles,
    listChannels: vaultDiscord.listChannels,
    getMember: vaultDiscord.getMember,
    assignRole: vaultDiscord.assignRole,
    removeRole: vaultDiscord.removeRole,
    sendMessage: vaultDiscord.sendMessage,
    sendDM: vaultDiscord.sendDM,
    deleteMessage: vaultDiscord.deleteMessage,
    createPrivateThread: vaultDiscord.createPrivateThread,
    addThreadMember: vaultDiscord.addThreadMember,
    timeoutMember: vaultDiscord.timeoutMember,
    kickMember: vaultDiscord.kickMember,
    banMember: vaultDiscord.banMember,
    formatModLogEmbed: vaultDiscord.formatModLogEmbed,
  },
};

export type DiscordCommunitySeam = typeof discordCommunity;
export type {
  DiscordCommunityEvent,
  DiscordCommunityComponentReply,
  DiscordCommunityUser,
} from "./community-events.js";
