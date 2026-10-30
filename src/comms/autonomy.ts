/**
 * Comms Hub — agent communication autonomy model.
 *
 * An agent granted the `communication` capability has:
 *   - an autonomy level (suggest_only | draft_for_approval | full_auto)
 *   - a channel allowlist
 *   - a client scope ("all" or an explicit clientId list)
 *   - an optional daily send limit
 *
 * evaluateSend() is fail-closed: an agent with no permission row, disabled,
 * out-of-scope, or over its daily limit is denied. The operator (no agentId)
 * always sends directly.
 */

import type {
  AgentCommsPermission,
  AutonomyDecision,
  CommsChannel,
} from "./types.js";

export interface SendEvaluationInput {
  /** The permission row for the agent, or null if none exists. */
  permission: AgentCommsPermission | null;
  channel: CommsChannel;
  clientId: string | null;
  /** Outbound sends by this agent in the current rolling day (for the limit). */
  sendsToday?: number;
}

export function evaluateSend(input: SendEvaluationInput): AutonomyDecision {
  const { permission } = input;

  if (!permission) {
    return {
      outcome: "deny",
      reason: "Agent has no communication permission configured",
      autonomy: null,
    };
  }
  if (!permission.enabled) {
    return { outcome: "deny", reason: "Agent communication is disabled", autonomy: permission.autonomy };
  }
  if (!permission.channels.includes(input.channel)) {
    return {
      outcome: "deny",
      reason: `Agent is not permitted to use the ${input.channel} channel`,
      autonomy: permission.autonomy,
    };
  }
  if (permission.clientScope !== "all") {
    if (input.clientId == null || !permission.clientScope.includes(input.clientId)) {
      return {
        outcome: "deny",
        reason: "Client is outside the agent's permitted client scope",
        autonomy: permission.autonomy,
      };
    }
  }
  if (
    permission.dailySendLimit != null &&
    (input.sendsToday ?? 0) >= permission.dailySendLimit
  ) {
    return {
      outcome: "deny",
      reason: `Agent has reached its daily send limit (${permission.dailySendLimit})`,
      autonomy: permission.autonomy,
    };
  }

  switch (permission.autonomy) {
    case "full_auto":
      return { outcome: "allow", reason: "Full autonomy granted", autonomy: "full_auto" };
    case "draft_for_approval":
      return {
        outcome: "needs_approval",
        reason: "Draft saved — operator approval required before sending",
        autonomy: "draft_for_approval",
      };
    case "suggest_only":
    default:
      return {
        outcome: "deny",
        reason: "Agent may only suggest; it cannot post into a thread",
        autonomy: "suggest_only",
      };
  }
}

/** Start-of-rolling-day timestamp (24h ago) for daily-limit accounting. */
export function rollingDayStart(now = Date.now()): number {
  return now - 24 * 60 * 60 * 1000;
}
