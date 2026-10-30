/**
 * Vault Rule Engine — Main Engine
 * Hooks into Discord events and processes automation rules
 */

import type { AutomationRule } from "../store/types.js";
import type { RuleEvent, RuleEngineConfig, RuleEngineStats, RuleExecutionResult } from "./types.js";
import { findMatchingRules, detectSpam } from "./evaluator.js";
import { executeRule } from "./executor.js";
import { getVaultStore } from "../store/index.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("vault-rule-engine");

// ═══════════════════════════════════════════════════════════════
// ENGINE STATE
// ═══════════════════════════════════════════════════════════════

let engineConfig: RuleEngineConfig | null = null;
let cachedRules: AutomationRule[] = [];
let lastRuleReload = 0;
let engineStartTime = 0;
let stats: RuleEngineStats = {
  rulesLoaded: 0,
  rulesEnabled: 0,
  eventsProcessed: 0,
  rulesTriggered: 0,
  actionsExecuted: 0,
  errors: 0,
  uptimeMs: 0,
};

// Execution history for UI display
const executionHistory: RuleExecutionResult[] = [];
const MAX_HISTORY = 100;

// ═══════════════════════════════════════════════════════════════
// ENGINE LIFECYCLE
// ═══════════════════════════════════════════════════════════════

/**
 * Initialize the rule engine
 */
export async function initRuleEngine(config: RuleEngineConfig): Promise<void> {
  log.info("Initializing Vault Rule Engine", {
    guildId: config.guildId,
    dryRun: config.dryRun,
    autonomyLevel: config.autonomyLevel,
  });

  engineConfig = config;
  engineStartTime = Date.now();

  // Load initial rules
  await reloadRules();

  // Set up periodic rule reload
  const reloadInterval = config.ruleReloadInterval || 60_000; // Default 1 minute
  setInterval(reloadRules, reloadInterval);

  log.info("Vault Rule Engine initialized", {
    rulesLoaded: cachedRules.length,
    rulesEnabled: cachedRules.filter((r) => r.enabled).length,
  });
}

/**
 * Reload rules from the database
 */
export async function reloadRules(): Promise<void> {
  try {
    const store = getVaultStore();
    cachedRules = await store.getRules();
    lastRuleReload = Date.now();

    stats.rulesLoaded = cachedRules.length;
    stats.rulesEnabled = cachedRules.filter((r) => r.enabled).length;

    log.debug("Rules reloaded", {
      total: cachedRules.length,
      enabled: stats.rulesEnabled,
    });
  } catch (err) {
    log.error("Failed to reload rules", { error: err });
    stats.errors++;
  }
}

/**
 * Get current engine stats
 */
export function getEngineStats(): RuleEngineStats {
  return {
    ...stats,
    uptimeMs: engineStartTime ? Date.now() - engineStartTime : 0,
  };
}

/**
 * Get recent execution history
 */
export function getExecutionHistory(): RuleExecutionResult[] {
  return [...executionHistory];
}

/**
 * Check if engine is running
 */
export function isEngineRunning(): boolean {
  return engineConfig !== null;
}

// ═══════════════════════════════════════════════════════════════
// EVENT PROCESSING
// ═══════════════════════════════════════════════════════════════

/**
 * Process an event through the rule engine
 */
export async function processEvent(event: RuleEvent): Promise<RuleExecutionResult[]> {
  if (!engineConfig) {
    log.warn("Rule engine not initialized");
    return [];
  }

  stats.eventsProcessed++;
  stats.lastEventAt = new Date();

  const results: RuleExecutionResult[] = [];

  // Find matching rules
  const matches = findMatchingRules(cachedRules, event);

  if (matches.length === 0) {
    return results;
  }

  log.info("Event matched rules", {
    eventType: event.type,
    matchCount: matches.length,
    ruleNames: matches.map((m) => m.rule.name),
  });

  stats.rulesTriggered += matches.length;

  // Execute each matching rule
  for (const match of matches) {
    try {
      const result = await executeRule(match, {
        dryRun: engineConfig.dryRun,
        guildId: engineConfig.guildId,
        botToken: engineConfig.botToken,
        maxActionsPerMinute: engineConfig.maxActionsPerMinute,
        autonomyLevel: engineConfig.autonomyLevel,
      });

      results.push(result);

      // Update stats
      stats.actionsExecuted += result.actionsExecuted.length;
      if (!result.success) {
        stats.errors++;
      }

      // Store in history
      executionHistory.unshift(result);
      if (executionHistory.length > MAX_HISTORY) {
        executionHistory.pop();
      }

      // Update rule trigger count in DB
      try {
        const store = getVaultStore();
        await store.upsertRule({
          id: match.rule.id,
          lastTriggeredAt: new Date().toISOString(),
          triggerCount: (match.rule.triggerCount || 0) + 1,
        });
      } catch (err) {
        log.warn("Failed to update rule trigger count", { ruleId: match.rule.id, error: err });
      }
    } catch (err) {
      log.error("Failed to execute rule", {
        ruleId: match.rule.id,
        error: err,
      });
      stats.errors++;
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// DISCORD EVENT CONVERTERS
// ═══════════════════════════════════════════════════════════════

/**
 * Convert a Discord message event to RuleEvent
 */
export function messageToRuleEvent(
  message: {
    id: string;
    content: string;
    channelId: string;
    channelName?: string;
    author: { id: string; username: string };
    attachments?: unknown[];
    mentions?: { id: string }[];
  },
  guildId: string,
): RuleEvent {
  return {
    type: "message_sent",
    timestamp: new Date(),
    guildId,
    userId: message.author.id,
    username: message.author.username,
    messageId: message.id,
    channelId: message.channelId,
    channelName: message.channelName,
    content: message.content,
    attachments: message.attachments?.length || 0,
    mentions: message.mentions?.map((m) => m.id),
    raw: { message },
  };
}

/**
 * Convert a Discord member join event to RuleEvent
 */
export function memberJoinToRuleEvent(
  member: {
    id: string;
    username: string;
    joinedAt?: Date;
    createdAt?: Date;
    roles?: string[];
  },
  guildId: string,
): RuleEvent {
  return {
    type: "member_join",
    timestamp: new Date(),
    guildId,
    userId: member.id,
    username: member.username,
    userRoles: member.roles,
    userJoinedAt: member.joinedAt,
    accountCreatedAt: member.createdAt,
    raw: { member },
  };
}

/**
 * Convert a Discord member leave event to RuleEvent
 */
export function memberLeaveToRuleEvent(
  member: {
    id: string;
    username: string;
    roles?: string[];
  },
  guildId: string,
): RuleEvent {
  return {
    type: "member_leave",
    timestamp: new Date(),
    guildId,
    userId: member.id,
    username: member.username,
    userRoles: member.roles,
    raw: { member },
  };
}

/**
 * Convert a Discord role change event to RuleEvent
 */
export function roleChangeToRuleEvent(
  data: {
    userId: string;
    username: string;
    roleId: string;
    roleName: string;
    action: "add" | "remove";
  },
  guildId: string,
): RuleEvent {
  return {
    type: "role_change",
    timestamp: new Date(),
    guildId,
    userId: data.userId,
    username: data.username,
    roleId: data.roleId,
    roleName: data.roleName,
    roleAction: data.action,
    raw: { data },
  };
}

// ═══════════════════════════════════════════════════════════════
// HIGH-LEVEL PROCESSORS
// ═══════════════════════════════════════════════════════════════

/**
 * Process a Discord message through the rule engine
 * Includes spam detection
 */
export async function processMessage(
  message: Parameters<typeof messageToRuleEvent>[0],
  guildId: string,
): Promise<RuleExecutionResult[]> {
  // Check for spam first
  const spamCheck = detectSpam(message.author.id, message.content);

  if (spamCheck.isSpam) {
    log.info("Spam detected", {
      userId: message.author.id,
      reason: spamCheck.reason,
    });

    // Create a spam event and process it
    const spamEvent: RuleEvent = {
      type: "message_sent",
      timestamp: new Date(),
      guildId,
      userId: message.author.id,
      username: message.author.username,
      messageId: message.id,
      channelId: message.channelId,
      content: message.content,
      raw: { spam: true, reason: spamCheck.reason },
    };

    // Check if there's a spam rule
    const spamMatches = findMatchingRules(cachedRules, spamEvent);
    if (spamMatches.length > 0) {
      return processEvent(spamEvent);
    }
  }

  const event = messageToRuleEvent(message, guildId);
  return processEvent(event);
}

/**
 * Process a member join event
 */
export async function processMemberJoin(
  member: Parameters<typeof memberJoinToRuleEvent>[0],
  guildId: string,
): Promise<RuleExecutionResult[]> {
  const event = memberJoinToRuleEvent(member, guildId);
  return processEvent(event);
}

/**
 * Process a member leave event
 */
export async function processMemberLeave(
  member: Parameters<typeof memberLeaveToRuleEvent>[0],
  guildId: string,
): Promise<RuleExecutionResult[]> {
  const event = memberLeaveToRuleEvent(member, guildId);
  return processEvent(event);
}

/**
 * Process a role change event
 */
export async function processRoleChange(
  data: Parameters<typeof roleChangeToRuleEvent>[0],
  guildId: string,
): Promise<RuleExecutionResult[]> {
  const event = roleChangeToRuleEvent(data, guildId);
  return processEvent(event);
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

export { cachedRules as rules, engineConfig as config };
