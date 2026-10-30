/**
 * New-member greeting: one public welcome post in #welcome (an embed with
 * three steps + link buttons) and the one welcome DM.
 *
 * Mention safety: the post @mentions only the new member(s). allowedMentions
 * is `{ parse: [], users: [...] }`, so @everyone, @here and role pings in any
 * text can never fire.
 */

import type { ChannelPurpose, Settings } from "./contract.js";

/** Default link-button targets (the #start-here pin). `Settings.offerLinks` overrides them. */
export const DEFAULT_GREETING_LINKS = {
  infinibot: "https://infinibotos.com",
  kinglyvault: "https://kinglyvault.com",
} as const;

/** Above this many greetings in 60 s, joins are batched into one combined post (raid-safe). */
export const GREETING_BATCH_PER_MINUTE = 5;
/** The combined post mentions at most this many members; the rest are counted. */
export const GREETING_BATCH_MAX_MENTIONS = 20;

/** The old built-in DM. It told members to press Verify, which only exists in full Live. */
export const LEGACY_DEFAULT_WELCOME_DM =
  "Welcome to Young CEO Society, {name}! Head to #start-here and press **Verify** to unlock the server. " +
  "It takes 30 seconds and tells us how we can help you build.\n\n{offers}";

type GreetSettings = Pick<Settings, "channelMap" | "offerLinks" | "guildName">;

const FALLBACK_NAMES: Partial<Record<ChannelPurpose, string>> = {
  "start-here": "#start-here",
  introductions: "#introductions",
  support: "#open-a-ticket",
  faq: "#faq",
  lives: "#lives",
};

function ch(s: GreetSettings, purpose: ChannelPurpose, fallback?: ChannelPurpose): string {
  const id = s.channelMap[purpose] ?? (fallback ? s.channelMap[fallback] : undefined);
  return id ? `<#${id}>` : (FALLBACK_NAMES[purpose] ?? `#${purpose}`);
}

/** The three steps, shared by the public post and the DM. */
export function greetingSteps(s: GreetSettings): string {
  const lives = s.channelMap.lives ? ` Lives happen in ${ch(s, "lives")}.` : "";
  return [
    `① Read ${ch(s, "start-here")}: **InfiniBot** = your AI operating system, **KinglyVault** = learn + plugins`,
    `② Say hi in ${ch(s, "introductions")}`,
    `③ Questions? ${ch(s, "support")} / ${ch(s, "faq", "help")}.${lives}`,
  ].join("\n");
}

export function greetingLinks(s: Pick<Settings, "offerLinks">): { infinibot: string; kinglyvault: string } {
  return {
    infinibot: s.offerLinks?.infinibot ?? DEFAULT_GREETING_LINKS.infinibot,
    kinglyvault: s.offerLinks?.kinglyvault ?? DEFAULT_GREETING_LINKS.kinglyvault,
  };
}

/** Link buttons (style 5) — no custom_id, nothing for the engine to handle. */
export function greetingButtons(s: Pick<Settings, "offerLinks">): unknown[] {
  const l = greetingLinks(s);
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: "InfiniBot", url: l.infinibot },
        { type: 2, style: 5, label: "KinglyVault", url: l.kinglyvault },
      ],
    },
  ];
}

export type GreetingPost = {
  content: string;
  embed: { title: string; description: string; color: number };
  components: unknown[];
  allowedMentions: { parse: []; users: string[] };
};

/**
 * The public #welcome post for one member, or one combined post for a burst.
 * Content carries the mentions (embeds never ping); the embed carries the steps.
 */
export function greetingPost(s: GreetSettings, members: Array<{ id: string }>): GreetingPost {
  const ids = [...new Set(members.map((m) => m.id))];
  const shown = ids.slice(0, GREETING_BATCH_MAX_MENTIONS);
  const more = ids.length - shown.length;
  const mentions = shown.map((id) => `<@${id}>`).join(" ");
  const content =
    ids.length === 1
      ? `Welcome ${mentions}! 👋`
      : `Welcome ${mentions}${more > 0 ? ` and ${more} more` : ""}! 👋`;
  const server = s.guildName ? `Welcome to ${s.guildName}` : "Welcome in";
  return {
    content,
    embed: { title: `${server} — start here`.slice(0, 256), description: greetingSteps(s), color: 0xd4af37 },
    components: greetingButtons(s),
    allowedMentions: { parse: [], users: shown },
  };
}

/** The welcome DM: same three steps + where to get help. Link buttons go alongside it. */
export function greetingDm(s: GreetSettings, name: string): string {
  const server = s.guildName ? `Welcome to ${s.guildName}, ${name}! 👋` : `Welcome, ${name}! 👋`;
  return `${server}\n\n${greetingSteps(s)}\n\nNeed help? Reply here or open a ticket in ${ch(s, "support")}.`;
}

/** Visible length of a greeting post (content + embed), for the ~600-char budget. */
export function greetingLength(p: GreetingPost): number {
  return p.content.length + p.embed.title.length + p.embed.description.length;
}

/** Discord "Cannot send messages to this user" (DMs closed / blocked): 403 or code 50007. */
export function isClosedDmError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return /Discord API error 403\b/.test(msg) || /"code"\s*:\s*50007\b/.test(msg);
}
