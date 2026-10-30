/**
 * Channels a hosted plan leaves out (Free: no Telegram, no Slack). Pure: no DOM,
 * no fetch (plan-channels.ts holds the live list). docs/saas/FREE_PLAN.md.
 *
 * The server decides: GET /api/me `channelsExcluded` (lowercase ids, [] on paid
 * plans, absent on servers that predate it), GET /api/channels `excluded`, and
 * the gateway's onboarding connectors (`lockedByPlan`). The UI only presents it;
 * an empty list means everything behaves exactly as before.
 */

const LABELS: Record<string, string> = {
  telegram: "Telegram",
  slack: "Slack",
  whatsapp: "WhatsApp",
  discord: "Discord",
  googlechat: "Google Chat",
  signal: "Signal",
  imessage: "iMessage",
  nostr: "Nostr",
};

/** `channelsExcluded` from any server payload → clean lowercase ids (anything else → []). */
export function normalizeChannelsExcluded(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim().toLowerCase();
    if (id) out.add(id);
  }
  return [...out];
}

/** True when the plan leaves this channel out. */
export function isChannelLocked(id: string | null | undefined, excluded: readonly string[] | null | undefined): boolean {
  if (!id || !excluded?.length) return false;
  return excluded.includes(id.trim().toLowerCase());
}

export function channelLabel(id: string): string {
  return LABELS[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** The server's own words for the lock (POST /api/channels/:id 402, onboarding laterReason). */
export function channelLockReason(id: string, plan = "Free"): string {
  return `${channelLabel(id)} isn't included on the ${plan} plan. Upgrade to connect it.`;
}

/** "Upgrade to connect Telegram". */
export function channelUpgradeCta(id: string): string {
  return `Upgrade to connect ${channelLabel(id)}`;
}

export type ChannelLockView =
  /** Not on this plan, nothing connected: a locked card with an upgrade CTA. */
  | { kind: "locked"; id: string; label: string; title: string; body: string; cta: string }
  /** Credentials kept but not running (a downgrade): paused, never deleted. */
  | { kind: "paused"; id: string; label: string; title: string; body: string; cta: string };

/**
 * What a channel card shows when the plan leaves the channel out; null = the
 * normal card. `connected` = credentials exist (configured / accounts / the
 * server's `disabled: true`).
 */
export function channelLockView(
  id: string,
  excluded: readonly string[] | null | undefined,
  connected: boolean,
): ChannelLockView | null {
  if (!isChannelLocked(id, excluded)) return null;
  const label = channelLabel(id);
  if (connected) {
    return {
      kind: "paused",
      id,
      label,
      title: "Paused on Free",
      body: `Your ${label} connection is saved but not running: the Free plan doesn't include ${label}. Upgrade to resume it right where it was.`,
      cta: "Upgrade to resume",
    };
  }
  return {
    kind: "locked",
    id,
    label,
    title: `${label} isn't on the Free plan`,
    body: `Upgrade to connect ${label} and reach your assistant there. Everything else keeps working on Free.`,
    cta: channelUpgradeCta(id),
  };
}

/** True for the typed 402 POST /api/channels/:id answers for a channel the plan leaves out. */
export function isChannelNotInPlanError(
  body: unknown,
): body is { ok: false; code: "channel_not_in_plan"; channel?: string; error?: string; upgrade?: boolean } {
  const b = body as { code?: unknown } | null;
  return !!b && b.code === "channel_not_in_plan";
}

/** Plugin ids/channels a plan lock applies to: the plugin's own id plus the channels it provides. */
export function lockedChannelOf(
  p: { id: string; channels?: string[] | null },
  excluded: readonly string[] | null | undefined,
): string | null {
  if (!excluded?.length) return null;
  for (const ch of [...(p.channels ?? []), p.id]) {
    if (isChannelLocked(ch, excluded)) return ch.toLowerCase();
  }
  return null;
}
