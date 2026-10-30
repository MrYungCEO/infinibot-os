/**
 * Turn-origin trust classification.
 *
 * Every agent turn is classified by WHERE it came from, so tool defaults can
 * be generous for the operator and conservative for everyone else:
 *
 * - "operator"          — control UI / authenticated WS operator, MCP operator,
 *                         voice on the operator session, cron/autonomy/goal runs
 *                         the operator created, sub-agents of those. Anything
 *                         with no external sender identity lands here.
 * - "owner"             — a chat-channel turn whose sender matches the owner
 *                         identities: the channel's configured `allowFrom`
 *                         (same list `commands` uses as the owner list) or
 *                         `tools.trust.owners`.
 * - "untrusted-content" — the turn carries external content the operator did not
 *                         write (hook sessions: gmail/webhook). Tools stay
 *                         available but lose permission bypasses.
 * - "untrusted-sender"  — a chat-channel sender that is not the owner (paired
 *                         DM contacts, group members, open-DM strangers).
 *
 * Note: the pairing store is deliberately NOT an owner source. Pairing lets a
 * contact talk to the bot; it does not make them the operator.
 */

import { getChannelDock } from "../channels/dock.js";
import { normalizeAnyChannelId, normalizeChatChannelId } from "../channels/registry.js";
import type { InfinibotConfig } from "../config/config.js";
import { isExternalHookSession } from "../security/external-content.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

export type TurnTrustLevel = "operator" | "owner" | "untrusted-content" | "untrusted-sender";

export type TurnTrust = {
  level: TurnTrustLevel;
  /** True for operator + owner turns. */
  trusted: boolean;
  /** Short human-readable reason (logs / refusal messages). */
  reason: string;
  /** Normalized channel id, when the turn came from a chat channel. */
  channel?: string;
};

export type ResolveTurnTrustParams = {
  config?: InfinibotConfig;
  sessionKey?: string | null;
  messageProvider?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  senderE164?: string | null;
  senderUsername?: string | null;
};

/** Core chat channels resolve without the plugin registry; plugins need it. */
function normalizeChannel(raw?: string | null): string | null {
  const core = normalizeChatChannelId(raw);
  if (core) return core;
  try {
    return normalizeAnyChannelId(raw);
  } catch {
    return null;
  }
}

const OPERATOR: TurnTrust = { level: "operator", trusted: true, reason: "operator session" };

function hookSessionRest(sessionKey?: string | null): string | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) return null;
  const rest = parseAgentSessionKey(raw)?.rest ?? raw;
  return isExternalHookSession(rest) ? rest : null;
}

function normalizeEntries(params: {
  config?: InfinibotConfig;
  channel: string;
  accountId?: string | null;
  values: Array<string | number>;
}): string[] {
  const dock = getChannelDock(params.channel as never);
  const raw = params.values.map((v) => String(v).trim()).filter(Boolean);
  if (raw.length === 0) return [];
  if (dock?.config?.formatAllowFrom && params.config) {
    try {
      return dock.config.formatAllowFrom({
        cfg: params.config,
        accountId: params.accountId,
        allowFrom: raw,
      });
    } catch {
      // fall through to raw normalization
    }
  }
  return raw.map((entry) => entry.toLowerCase());
}

/**
 * Owner identities for a channel: the channel's configured `allowFrom`
 * (wildcards excluded — "*" means "anyone may talk", not "everyone is owner")
 * plus `tools.trust.owners` entries scoped to this channel or unscoped.
 */
export function resolveChannelOwnerIds(params: {
  config?: InfinibotConfig;
  channel: string;
  accountId?: string | null;
}): string[] {
  const { config, channel, accountId } = params;
  const dock = getChannelDock(channel as never);
  let allowFrom: Array<string | number> = [];
  if (config && dock?.config?.resolveAllowFrom) {
    try {
      allowFrom = dock.config.resolveAllowFrom({ cfg: config, accountId }) ?? [];
    } catch {
      allowFrom = [];
    }
  }
  const extra: string[] = [];
  for (const entry of config?.tools?.trust?.owners ?? []) {
    const trimmed = String(entry).trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep > 0) {
      const scope = normalizeChannel(trimmed.slice(0, sep));
      if (scope) {
        if (scope === channel) extra.push(trimmed.slice(sep + 1));
        continue;
      }
    }
    extra.push(trimmed);
  }
  const combined = [...allowFrom.map(String), ...extra].filter((e) => e.trim() && e.trim() !== "*");
  return Array.from(new Set(normalizeEntries({ config, channel, accountId, values: combined })));
}

/**
 * External voice-call sessions (a caller on a voice provider such as a
 * Robovoice location, calling back into the gateway for the LLM step):
 * `agent:<id>:voicecall:<provider>:…` is a caller who is NOT the operator;
 * `agent:<id>:voicecall-owner:<provider>:…` is one the provider authenticated
 * as the owner. See src/gateway/voice/voice-llm-turn.ts.
 */
export const VOICE_CALLER_SESSION_PREFIX = "voicecall:";
export const VOICE_OWNER_SESSION_PREFIX = "voicecall-owner:";

function voiceCallTrust(sessionKey?: string | null): TurnTrust | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) return null;
  const rest = parseAgentSessionKey(raw)?.rest ?? raw;
  if (rest.startsWith(VOICE_OWNER_SESSION_PREFIX)) {
    return {
      level: "owner",
      trusted: true,
      reason: "voice caller authenticated as owner",
      channel: "voice",
    };
  }
  if (rest.startsWith(VOICE_CALLER_SESSION_PREFIX)) {
    return {
      level: "untrusted-sender",
      trusted: false,
      reason: "external voice caller (not authenticated as owner)",
      channel: "voice",
    };
  }
  return null;
}

export function resolveTurnTrust(params: ResolveTurnTrustParams): TurnTrust {
  const voice = voiceCallTrust(params.sessionKey);
  if (voice) return voice;
  const hookRest = hookSessionRest(params.sessionKey);
  if (hookRest) {
    return {
      level: "untrusted-content",
      trusted: false,
      reason: `external hook session (${hookRest.split(":").slice(0, 2).join(":")})`,
    };
  }

  const channel = normalizeChannel(params.messageProvider);
  // Not a chat channel (webchat/control UI, voice, MCP, cron, CLI, …) → operator.
  if (!channel) return OPERATOR;

  const senderCandidates = [params.senderId, params.senderE164, params.senderUsername]
    .map((v) => (v ?? "").trim())
    .filter(Boolean);
  // A channel-bound run with no sender identity is gateway-initiated (cron
  // delivery, heartbeat, announce) rather than an inbound message.
  if (senderCandidates.length === 0) {
    return { ...OPERATOR, reason: `gateway-initiated ${channel} run`, channel };
  }

  const owners = resolveChannelOwnerIds({
    config: params.config,
    channel,
    accountId: params.accountId,
  });
  if (owners.length > 0) {
    const normalizedSenders = normalizeEntries({
      config: params.config,
      channel,
      accountId: params.accountId,
      values: senderCandidates,
    });
    const usernameVariants = senderCandidates.flatMap((v) =>
      v.startsWith("@") ? [v.slice(1).toLowerCase()] : [v.toLowerCase(), `@${v.toLowerCase()}`],
    );
    const matched = [...normalizedSenders, ...usernameVariants].some((s) => owners.includes(s));
    if (matched) {
      return { level: "owner", trusted: true, reason: `${channel} owner`, channel };
    }
  }

  if (params.config?.tools?.trust?.nonOwnerSenders === "trusted") {
    return {
      level: "owner",
      trusted: true,
      reason: `${channel} sender (tools.trust.nonOwnerSenders=trusted)`,
      channel,
    };
  }
  return {
    level: "untrusted-sender",
    trusted: false,
    reason: `${channel} sender is not a configured owner`,
    channel,
  };
}
