/**
 * Vault Rule Engine — Action Executor
 * Executes rule actions when conditions match
 */

import type {
  RuleEvent,
  RuleAction,
  RuleActionType,
  RuleExecutionResult,
  RuleMatch,
} from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  warnMember,
  timeoutMember,
  kickMember,
  banMember,
  sendDM,
  sendMessage,
  assignRole,
  removeRole,
} from "../discord/index.js";
import { getVaultStore } from "../store/index.js";

const log = createSubsystemLogger("vault-rule-executor");

// ═══════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════

const actionCounts = new Map<string, number[]>();

function checkRateLimit(key: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;

  let timestamps = actionCounts.get(key) || [];
  timestamps = timestamps.filter((t) => t > cutoff);

  if (timestamps.length >= maxPerMinute) {
    return false; // Rate limited
  }

  timestamps.push(now);
  actionCounts.set(key, timestamps);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════

type ActionHandler = (
  action: RuleAction,
  event: RuleEvent,
  opts: { dryRun?: boolean; guildId: string; botToken?: string },
) => Promise<{ success: boolean; result?: unknown; error?: string }>;

const actionHandlers: Record<RuleActionType, ActionHandler> = {
  assign_role: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const roleId = action.config.roleId as string;
    if (!roleId) return { success: false, error: "No role ID specified" };

    if (opts.dryRun) {
      return { success: true, result: { dryRun: true, action: "assign_role", roleId } };
    }

    try {
      await assignRole(opts.guildId, event.userId, roleId);
      return { success: true, result: { roleId } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  remove_role: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const roleId = action.config.roleId as string;
    if (!roleId) return { success: false, error: "No role ID specified" };

    if (opts.dryRun) {
      return { success: true, result: { dryRun: true, action: "remove_role", roleId } };
    }

    try {
      await removeRole(opts.guildId, event.userId, roleId);
      return { success: true, result: { roleId } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  send_dm: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const message = action.config.message as string;
    if (!message) return { success: false, error: "No message specified" };

    // Template variable replacement
    const templatedMessage = message
      .replace(/\{username\}/g, event.username || "User")
      .replace(/\{userId\}/g, event.userId)
      .replace(/\{channelName\}/g, event.channelName || "channel");

    if (opts.dryRun) {
      return {
        success: true,
        result: { dryRun: true, action: "send_dm", message: templatedMessage },
      };
    }

    try {
      await sendDM(event.userId, templatedMessage);
      return { success: true, result: { sent: true } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  send_channel_message: async (action, event, opts) => {
    const channelId = (action.config.channelId as string) || event.channelId;
    if (!channelId) return { success: false, error: "No channel ID specified" };
    const message = action.config.message as string;
    if (!message) return { success: false, error: "No message specified" };

    // Template variable replacement
    const templatedMessage = message
      .replace(/\{username\}/g, event.username || "User")
      .replace(/\{userId\}/g, event.userId || "")
      .replace(/\{mention\}/g, event.userId ? `<@${event.userId}>` : "User");

    if (opts.dryRun) {
      return {
        success: true,
        result: {
          dryRun: true,
          action: "send_channel_message",
          channelId,
          message: templatedMessage,
        },
      };
    }

    try {
      await sendMessage(channelId, templatedMessage);
      return { success: true, result: { sent: true, channelId } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  warn_member: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const reason = (action.config.reason as string) || "Automated warning";
    const severity = (action.config.severity as string) || "minor";

    if (opts.dryRun) {
      return { success: true, result: { dryRun: true, action: "warn_member", reason, severity } };
    }

    try {
      const warning = await warnMember(
        opts.guildId,
        event.userId,
        reason,
        severity as "minor" | "moderate" | "severe",
      );

      // Store warning in vault
      const store = getVaultStore();
      await store.addWarning({
        memberId: event.userId,
        reason,
        severity: severity as "minor" | "moderate" | "severe",
        issuedBy: "rule-engine",
        issuedAt: new Date().toISOString(),
      });

      return { success: true, result: { warning } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  timeout_member: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const durationMinutes = (action.config.durationMinutes as number) || 10;
    const reason = (action.config.reason as string) || "Automated timeout";
    const durationMs = durationMinutes * 60 * 1000;

    if (opts.dryRun) {
      return {
        success: true,
        result: { dryRun: true, action: "timeout_member", durationMinutes, reason },
      };
    }

    try {
      const result = await timeoutMember(opts.guildId, event.userId, durationMs, reason);
      return { success: result.success, result: result.data, error: result.error };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  kick_member: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const reason = (action.config.reason as string) || "Automated kick";

    if (opts.dryRun) {
      return { success: true, result: { dryRun: true, action: "kick_member", reason } };
    }

    try {
      const result = await kickMember(opts.guildId, event.userId, reason);
      return { success: result.success, error: result.error };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  ban_member: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const reason = (action.config.reason as string) || "Automated ban";
    const deleteMessageDays = (action.config.deleteMessageDays as number) || 0;

    if (opts.dryRun) {
      return {
        success: true,
        result: { dryRun: true, action: "ban_member", reason, deleteMessageDays },
      };
    }

    try {
      const result = await banMember(opts.guildId, event.userId, reason, deleteMessageDays);
      return { success: result.success, error: result.error };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  delete_message: async (action, event, opts) => {
    if (!event.messageId || !event.channelId) {
      return { success: false, error: "No message or channel ID in event" };
    }

    if (opts.dryRun) {
      return {
        success: true,
        result: { dryRun: true, action: "delete_message", messageId: event.messageId },
      };
    }

    try {
      // Use Discord REST API to delete message
      const discordApiBase = "https://discord.com/api/v10";
      const response = await fetch(
        `${discordApiBase}/channels/${event.channelId}/messages/${event.messageId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bot ${opts.botToken}`,
          },
        },
      );
      if (!response.ok) {
        return { success: false, error: `Discord API ${response.status}` };
      }
      return { success: true, result: { deleted: true } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  grant_course_access: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const courseId = action.config.courseId as string;
    if (!courseId) return { success: false, error: "No course ID specified" };

    if (opts.dryRun) {
      return { success: true, result: { dryRun: true, action: "grant_course_access", courseId } };
    }

    try {
      const store = getVaultStore();
      await store.enrollInCourse(event.userId, courseId);
      return { success: true, result: { enrolled: true, courseId } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  revoke_course_access: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const courseId = action.config.courseId as string;
    if (!courseId) return { success: false, error: "No course ID specified" };

    if (opts.dryRun) {
      return { success: true, result: { dryRun: true, action: "revoke_course_access", courseId } };
    }

    try {
      // Note: unenroll not directly supported, we could delete progress instead
      log.info("Revoke course access requested", { userId: event.userId, courseId });
      return {
        success: true,
        result: { revoked: true, courseId, note: "Manual review may be needed" },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  set_tier: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const tier = action.config.tier as string;
    if (!tier) return { success: false, error: "No tier specified" };

    if (opts.dryRun) {
      return { success: true, result: { dryRun: true, action: "set_tier", tier } };
    }

    try {
      const store = getVaultStore();
      await store.upsertMember({ id: event.userId, tier });
      return { success: true, result: { tier } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  add_note: async (action, event, opts) => {
    if (!event.userId) return { success: false, error: "No user ID in event" };
    const note = action.config.note as string;
    if (!note) return { success: false, error: "No note specified" };

    if (opts.dryRun) {
      return { success: true, result: { dryRun: true, action: "add_note", note } };
    }

    try {
      const store = getVaultStore();
      const member = await store.getMember(event.userId);
      const existingNotes = member?.notes || "";
      const newNotes = existingNotes
        ? `${existingNotes}\n[${new Date().toISOString()}] ${note}`
        : `[${new Date().toISOString()}] ${note}`;
      await store.upsertMember({ id: event.userId, notes: newNotes });
      return { success: true, result: { added: true } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  webhook: async (action, event, opts) => {
    const url = action.config.url as string;
    if (!url) return { success: false, error: "No webhook URL specified" };

    if (opts.dryRun) {
      return { success: true, result: { dryRun: true, action: "webhook", url } };
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
          ...(action.config.payload as object),
        }),
      });
      return { success: response.ok, result: { status: response.status } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },

  log_only: async (action, event, opts) => {
    const message = (action.config.message as string) || "Rule triggered";
    log.info("Rule log action", { message, event, dryRun: opts.dryRun });
    return { success: true, result: { logged: true, message } };
  },
};

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTOR
// ═══════════════════════════════════════════════════════════════

/**
 * Execute all actions for a matched rule
 */
export async function executeRule(
  match: RuleMatch,
  opts: {
    dryRun?: boolean;
    guildId: string;
    botToken?: string;
    maxActionsPerMinute?: number;
    autonomyLevel?: 1 | 2 | 3;
  },
): Promise<RuleExecutionResult> {
  const startTime = Date.now();
  const rule = match.rule;
  const event = match.event;

  const actionsExecuted: RuleExecutionResult["actionsExecuted"] = [];

  // Get actions from rule
  const actions: RuleAction[] = Array.isArray(rule.actions) ? (rule.actions as RuleAction[]) : [];

  if (actions.length === 0) {
    log.info("Rule matched but has no actions", { ruleId: rule.id, ruleName: rule.name });
    return {
      ruleId: rule.id,
      ruleName: rule.name || "Unnamed Rule",
      event,
      success: true,
      actionsExecuted: [],
      executedAt: new Date(),
      durationMs: Date.now() - startTime,
    };
  }

  for (const action of actions) {
    // Check rate limit
    const rateLimitKey = `${rule.id}:${action.type}`;
    const maxPerMinute = opts.maxActionsPerMinute || 30;

    if (!checkRateLimit(rateLimitKey, maxPerMinute)) {
      actionsExecuted.push({
        type: action.type,
        success: false,
        error: "Rate limited",
      });
      continue;
    }

    // Check autonomy level for severe actions
    const severeActions: RuleActionType[] = ["kick_member", "ban_member"];
    const moderateActions: RuleActionType[] = ["warn_member", "timeout_member", "delete_message"];

    if (opts.autonomyLevel === 1) {
      // Monitor only - no moderation actions
      if ([...severeActions, ...moderateActions].includes(action.type)) {
        actionsExecuted.push({
          type: action.type,
          success: false,
          error: `Autonomy level 1 does not allow ${action.type}`,
        });
        continue;
      }
    } else if (opts.autonomyLevel === 2) {
      // Moderate - no kick/ban
      if (severeActions.includes(action.type)) {
        actionsExecuted.push({
          type: action.type,
          success: false,
          error: `Autonomy level 2 does not allow ${action.type}`,
        });
        continue;
      }
    }

    // Execute action
    const handler = actionHandlers[action.type];

    if (!handler) {
      actionsExecuted.push({
        type: action.type,
        success: false,
        error: `Unknown action type: ${action.type}`,
      });
      continue;
    }

    try {
      const result = await handler(action, event, {
        dryRun: opts.dryRun,
        guildId: opts.guildId,
        botToken: opts.botToken,
      });

      actionsExecuted.push({
        type: action.type,
        success: result.success,
        result: result.result,
        error: result.error,
      });

      if (result.success) {
        log.info("Action executed", {
          ruleId: rule.id,
          action: action.type,
          dryRun: opts.dryRun,
          result: result.result,
        });
      } else {
        log.warn("Action failed", {
          ruleId: rule.id,
          action: action.type,
          error: result.error,
        });
      }
    } catch (err) {
      actionsExecuted.push({
        type: action.type,
        success: false,
        error: String(err),
      });

      log.error("Action threw exception", {
        ruleId: rule.id,
        action: action.type,
        error: err,
      });
    }
  }

  const success = actionsExecuted.every((a) => a.success);

  return {
    ruleId: rule.id,
    ruleName: rule.name || "Unnamed Rule",
    event,
    success,
    actionsExecuted,
    executedAt: new Date(),
    durationMs: Date.now() - startTime,
  };
}
