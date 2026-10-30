/**
 * Per-worker chat-channel bindings — *routing only*, never credentials.
 *
 * A binding says "Mercury speaks on Slack in C123, inbound and outbound". It
 * does NOT say how to authenticate to Slack: channel credentials live in the
 * gateway config / channel plugins and must never be duplicated into agency.db,
 * which is replicated between federation nodes and included in backups.
 * `assertNoCredentials` enforces that on the free-form `config` bag.
 *
 * Channel ids are validated against `src/channels/registry.ts` rather than
 * accepted as free strings, so a binding can never point at a channel the
 * runtime does not have.
 */

import { normalizeChatChannelId, type ChatChannelId } from "../channels/registry.js";

export const CHANNEL_BINDING_DIRECTIONS = ["inbound", "outbound", "both"] as const;
export type ChannelBindingDirection = (typeof CHANNEL_BINDING_DIRECTIONS)[number];

export interface WorkerChannelBinding {
  id: string;
  agencyId: string;
  workerId: string;
  /** Validated against the chat channel registry. */
  channelId: ChatChannelId;
  /**
   * Where this worker speaks on the channel: a Slack channel id, a Telegram
   * chat id, a WhatsApp JID, a Discord channel id. Null = the channel default.
   */
  target: string | null;
  /** How the worker appears there (bot handle, display name, alias). */
  handle: string | null;
  direction: ChannelBindingDirection;
  enabled: boolean;
  /** Non-secret routing extras (threadId, locale, mention policy, …). */
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type WorkerChannelBindingInput = {
  id?: string;
  workerId: string;
  channelId: string;
  target?: string | null;
  handle?: string | null;
  direction?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
};

/**
 * Anything that looks like a secret. Deliberately broad: a false positive costs
 * an operator one renamed key, a false negative writes a bot token into a
 * replicated, backed-up database.
 */
const CREDENTIAL_KEY =
  /(token|secret|password|passwd|apikey|api_key|credential|private_?key|bearer|session|cookie|signing)/i;

export function assertNoCredentials(config: Record<string, unknown>, path = "config"): void {
  for (const [key, value] of Object.entries(config)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw new Error(
        `${path}.${key} looks like a credential; channel credentials belong in the gateway ` +
          `channel configuration, not in the agency database`,
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertNoCredentials(value as Record<string, unknown>, `${path}.${key}`);
    }
  }
}

export function parseChannelBindingDirection(raw: unknown): ChannelBindingDirection {
  if (raw === undefined || raw === null || raw === "") return "both";
  if (typeof raw === "string" && (CHANNEL_BINDING_DIRECTIONS as readonly string[]).includes(raw)) {
    return raw as ChannelBindingDirection;
  }
  throw new Error(`direction must be one of ${CHANNEL_BINDING_DIRECTIONS.join(", ")}`);
}

/** Validate a channel id against the registry. Throws with the legal set. */
export function parseChannelId(raw: unknown): ChatChannelId {
  const channelId = normalizeChatChannelId(typeof raw === "string" ? raw : null);
  if (!channelId) {
    throw new Error(`channelId must be a known chat channel (got ${JSON.stringify(raw)})`);
  }
  return channelId;
}

/** Compact, prompt-ready description of where an employee can be reached. */
export function describeChannelBindings(bindings: WorkerChannelBinding[]): string {
  const enabled = bindings.filter((binding) => binding.enabled);
  if (!enabled.length) return "";
  return enabled
    .map((binding) => {
      const where = binding.target ? ` (${binding.target})` : "";
      const who = binding.handle ? ` as ${binding.handle}` : "";
      return `- ${binding.channelId}${where}${who} — ${binding.direction}`;
    })
    .join("\n");
}
