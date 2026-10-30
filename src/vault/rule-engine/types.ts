/**
 * Vault Rule Engine — Type Definitions
 * Real-time automation for Discord community management
 */

import type { AutomationRule } from '../store/types.js';

// ═══════════════════════════════════════════════════════════════
// EVENT TYPES
// ═══════════════════════════════════════════════════════════════

export type RuleEventType =
  | 'member_join'
  | 'member_leave'
  | 'message_sent'
  | 'message_delete'
  | 'role_change'
  | 'course_complete'
  | 'warning_issued'
  | 'payment_received'
  | 'reaction_add'
  | 'reaction_remove'
  | 'scheduled';

export interface RuleEvent {
  type: RuleEventType;
  timestamp: Date;
  guildId: string;
  
  // Member context
  userId?: string;
  username?: string;
  userRoles?: string[];
  userJoinedAt?: Date;
  accountCreatedAt?: Date;
  
  // Message context
  messageId?: string;
  channelId?: string;
  channelName?: string;
  content?: string;
  attachments?: number;
  mentions?: string[];
  
  // Role context
  roleId?: string;
  roleName?: string;
  roleAction?: 'add' | 'remove';
  
  // Course context
  courseId?: string;
  courseName?: string;
  
  // Payment context
  amount?: number;
  currency?: string;
  tier?: string;
  
  // Raw data for custom conditions
  raw?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// CONDITION TYPES
// ═══════════════════════════════════════════════════════════════

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'less_than'
  | 'in'
  | 'not_in'
  | 'matches_regex'
  | 'is_empty'
  | 'is_not_empty';

export interface RuleCondition {
  field: string;
  operator: ConditionOperator;
  value: unknown;
  caseSensitive?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// ACTION TYPES
// ═══════════════════════════════════════════════════════════════

export type RuleActionType =
  | 'assign_role'
  | 'remove_role'
  | 'send_dm'
  | 'send_channel_message'
  | 'warn_member'
  | 'timeout_member'
  | 'kick_member'
  | 'ban_member'
  | 'delete_message'
  | 'grant_course_access'
  | 'revoke_course_access'
  | 'set_tier'
  | 'add_note'
  | 'webhook'
  | 'log_only';

export interface RuleAction {
  type: RuleActionType;
  config: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// EXECUTION TYPES
// ═══════════════════════════════════════════════════════════════

export interface RuleMatch {
  rule: AutomationRule;
  event: RuleEvent;
  matchedConditions: RuleCondition[];
  score: number; // 0-100 confidence
}

export interface RuleExecutionResult {
  ruleId: string;
  ruleName: string;
  event: RuleEvent;
  success: boolean;
  actionsExecuted: {
    type: RuleActionType;
    success: boolean;
    result?: unknown;
    error?: string;
  }[];
  executedAt: Date;
  durationMs: number;
}

export interface RuleEngineStats {
  rulesLoaded: number;
  rulesEnabled: number;
  eventsProcessed: number;
  rulesTriggered: number;
  actionsExecuted: number;
  errors: number;
  lastEventAt?: Date;
  uptimeMs: number;
}

// ═══════════════════════════════════════════════════════════════
// ENGINE CONFIG
// ═══════════════════════════════════════════════════════════════

export interface RuleEngineConfig {
  /** Guild ID to monitor */
  guildId: string;
  
  /** Bot token for Discord API */
  botToken: string;
  
  /** How often to reload rules from DB (ms) */
  ruleReloadInterval?: number;
  
  /** Max actions per minute (rate limiting) */
  maxActionsPerMinute?: number;
  
  /** Enable detailed logging */
  verbose?: boolean;
  
  /** Dry run mode (log but don't execute) */
  dryRun?: boolean;
  
  /** Autonomy level (1=monitor, 2=moderate, 3=full) */
  autonomyLevel?: 1 | 2 | 3;
}
