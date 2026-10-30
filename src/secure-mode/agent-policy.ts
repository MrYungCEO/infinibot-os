/**
 * Per-agent Secure Mode policy: `agents.list[].secureOnly`.
 *
 * An agent marked secureOnly only ever runs in the secure lane. A run on a
 * normal session key for that agent is refused (fail closed) — the caller has
 * to open a secure session (`secure.session.new`) instead. Enforced at the
 * embedded-runner choke point (chat, group chat, cron, channels, `agent` RPC)
 * and early in chat.send for a clear error.
 */

import type { InfinibotConfig } from "../config/config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { isSecureSessionKey } from "./session-key.js";

/** True when the agent is configured to run only in Secure Mode. */
export function isSecureOnlyAgent(cfg: InfinibotConfig | undefined, agentId: string): boolean {
  const list = cfg?.agents?.list;
  if (!Array.isArray(list)) return false;
  const id = agentId.trim().toLowerCase();
  const entry = list.find(
    (a) =>
      a &&
      typeof a === "object" &&
      String(a.id ?? "")
        .trim()
        .toLowerCase() === id,
  );
  return Boolean(entry && (entry as { secureOnly?: unknown }).secureOnly === true);
}

/**
 * Reason a run on `sessionKey` must be refused under the per-agent policy, or
 * null when it may go ahead. Secure session keys are always fine here (the
 * lane's own checks apply to them).
 */
export function secureOnlyBlockReason(
  cfg: InfinibotConfig | undefined,
  sessionKey: string | undefined | null,
): string | null {
  if (!cfg || !sessionKey || isSecureSessionKey(sessionKey)) return null;
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  if (!isSecureOnlyAgent(cfg, agentId)) return null;
  return `agent "${agentId}" is set to always run in Secure Mode. Open a secure session for it (secure.session.new) instead of ${sessionKey}.`;
}
