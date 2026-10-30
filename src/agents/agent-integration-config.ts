/**
 * Per-agent integration overrides layered on top of global config.
 *
 * Mirrors the pattern used by sandbox-agent-config / pi-tools-agent-config:
 * resolve an agent-specific value, falling back to the global default so that
 * agents without these fields behave exactly as before.
 *
 * Two concerns live here:
 *   1. Coder backend selection — which CLI backend an agent spawns by default,
 *      and which to retry once with on launch failure.
 *   2. Telegram bot token — the outbound token attributable to an agent,
 *      decrypted from the agent secret store, falling back to the global token.
 */

import type { CoderBackendId } from "./coder-backend/types.js";
import { getAgentSecret } from "./agent-secret-store.js";
import type { InfinibotConfig } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveTelegramToken } from "../telegram/token.js";

/** Look up the configured entry for an agent id (normalized), if any. */
export function findAgentConfigEntry(
  cfg: InfinibotConfig | undefined,
  agentId: string | undefined,
): AgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const list = cfg?.agents?.list;
  if (!Array.isArray(list)) return undefined;
  return list.find((entry) => entry && normalizeAgentId(entry.id) === id);
}

/** The global coder backend default (claude-code when unset). */
export function globalCoderBackendId(cfg: InfinibotConfig | undefined): CoderBackendId {
  const raw = (cfg as { coder?: { backend?: CoderBackendId } } | undefined)?.coder?.backend;
  return raw ?? "claude-code";
}

export type ResolvedCoderBackends = {
  /** Backend to launch first. */
  primary: CoderBackendId;
  /** Backend to retry once with if `primary` fails to start. Undefined = no fallback. */
  fallback?: CoderBackendId;
  /** True when `primary` came from an explicit per-call `backend` argument. */
  primaryExplicit: boolean;
};

/**
 * Resolve the primary + fallback coder backends for an agent.
 *
 * Primary precedence: explicit call arg → agent.defaultCoderBackend → global.
 * Fallback: agent.fallbackCoderBackend, but only when it differs from the
 * resolved primary (retrying with the same backend would be pointless).
 */
export function resolveAgentCoderBackends(
  cfg: InfinibotConfig | undefined,
  agentId: string | undefined,
  explicit?: CoderBackendId | null,
): ResolvedCoderBackends {
  const entry = findAgentConfigEntry(cfg, agentId);
  const primary: CoderBackendId =
    explicit ?? entry?.defaultCoderBackend ?? globalCoderBackendId(cfg);
  const fallbackRaw = entry?.fallbackCoderBackend;
  const fallback = fallbackRaw && fallbackRaw !== primary ? fallbackRaw : undefined;
  return { primary, fallback, primaryExplicit: Boolean(explicit) };
}

export type ResolvedTelegramToken = {
  token: string;
  /** Where the token came from: the agent's own secret, or the global config. */
  source: "agent" | "global" | "none";
};

/**
 * Resolve the Telegram bot token to use on behalf of an agent.
 *
 * Order: the agent's encrypted token (when `telegramBotTokenRef` is set and
 * decrypts to a non-empty value) → the global token (channels.telegram /
 * TELEGRAM_BOT_TOKEN). Returns `{ token: "", source: "none" }` when neither
 * is available.
 */
export function resolveAgentTelegramToken(
  cfg: InfinibotConfig | undefined,
  agentId: string | undefined,
  opts?: { stateDir?: string },
): ResolvedTelegramToken {
  const entry = findAgentConfigEntry(cfg, agentId);
  const ref = entry?.telegramBotTokenRef;
  if (ref) {
    const token = getAgentSecret(ref, opts)?.trim();
    if (token) return { token, source: "agent" };
  }
  const global = resolveTelegramToken(cfg).token.trim();
  if (global) return { token: global, source: "global" };
  return { token: "", source: "none" };
}
