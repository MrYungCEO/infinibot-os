/**
 * Catch-all Carbon components for community-manager buttons (`cm:…`) and
 * select menus (`cmsel:…`). A press is published on the community event bus
 * (src/discord/community-events.ts); the first subscriber reply is sent back
 * as the interaction response (ephemeral by default). With no subscriber the
 * member gets a short "not active" notice instead of Discord's failure toast.
 *
 * The response is posted with raw REST so subscribers can return plain
 * Discord component JSON (buttons / selects) without Carbon row classes.
 */

import {
  Button,
  StringSelectMenu,
  type ButtonInteraction,
  type ComponentData,
  type StringSelectMenuInteraction,
} from "@buape/carbon";
import { ButtonStyle, InteractionResponseType, MessageFlags, Routes } from "discord-api-types/v10";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  COMMUNITY_BUTTON_KEY,
  COMMUNITY_SELECT_KEY,
  emitDiscordCommunityEvent,
  type DiscordCommunityComponentReply,
  type DiscordCommunityUser,
} from "../community-events.js";

const log = createSubsystemLogger("discord/community");

type RawInteraction = {
  id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: RawUser };
  user?: RawUser;
  data?: { custom_id?: string; values?: string[] };
};
type RawUser = {
  id?: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
};

function toUser(raw: RawUser | undefined): DiscordCommunityUser | null {
  if (!raw?.id) return null;
  return {
    id: raw.id,
    username: raw.username ?? raw.id,
    globalName: raw.global_name ?? null,
    avatar: raw.avatar ?? null,
    bot: raw.bot === true,
  };
}

const INACTIVE_REPLY: DiscordCommunityComponentReply = {
  content: "This community action isn't active right now. Please try again later.",
};

async function dispatch(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  accountId: string,
  values: string[],
): Promise<void> {
  const raw = interaction.rawData as unknown as RawInteraction;
  const user = toUser(raw.member?.user ?? raw.user);
  const customId = raw.data?.custom_id ?? "";
  let reply: DiscordCommunityComponentReply | null = null;
  if (user) {
    reply = await emitDiscordCommunityEvent(
      {
        kind: "component",
        accountId,
        guildId: raw.guild_id ?? null,
        channelId: raw.channel_id ?? null,
        user,
        customId,
        values,
      },
      (err) => log.warn(`community component listener failed: ${String(err)}`),
    );
  }
  const out = reply ?? INACTIVE_REPLY;
  if (!raw.id || !raw.token) return;
  try {
    await interaction.client.rest.post(Routes.interactionCallback(raw.id, raw.token), {
      body: {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          content: out.content.slice(0, 2000),
          flags: out.ephemeral === false ? 0 : MessageFlags.Ephemeral,
          components: out.components ?? [],
          allowed_mentions: { parse: [] },
        },
      },
    });
  } catch (err) {
    log.warn(`community component reply failed: ${String(err)}`);
  }
}

export class CommunityButton extends Button {
  label = "community";
  customId = `${COMMUNITY_BUTTON_KEY}:seed=1`;
  style = ButtonStyle.Primary;

  constructor(private accountId: string) {
    super();
  }

  async run(interaction: ButtonInteraction, _data: ComponentData): Promise<void> {
    await dispatch(interaction, this.accountId, []);
  }
}

export class CommunitySelect extends StringSelectMenu {
  customId = `${COMMUNITY_SELECT_KEY}:seed=1`;
  options = [{ label: "community", value: "community" }];

  constructor(private accountId: string) {
    super();
  }

  async run(interaction: StringSelectMenuInteraction, _data: ComponentData): Promise<void> {
    await dispatch(interaction, this.accountId, [...(interaction.values ?? [])]);
  }
}

export function createCommunityComponents(accountId: string) {
  return [new CommunityButton(accountId), new CommunitySelect(accountId)];
}
