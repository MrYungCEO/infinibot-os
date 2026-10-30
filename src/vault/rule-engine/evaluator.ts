/**
 * Vault Rule Engine — Condition Evaluator
 * Matches events against rule conditions
 */

import type { AutomationRule } from "../store/types.js";
import type { RuleEvent, RuleCondition, RuleMatch } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("vault-rule-evaluator");

// ═══════════════════════════════════════════════════════════════
// CONDITION EVALUATION
// ═══════════════════════════════════════════════════════════════

/**
 * Get a nested value from an object using dot notation
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Evaluate a single condition against an event
 */
export function evaluateCondition(condition: RuleCondition, event: RuleEvent): boolean {
  const eventValue = getNestedValue(event as unknown as Record<string, unknown>, condition.field);
  const conditionValue = condition.value;

  // Handle case sensitivity for string comparisons
  const normalize = (val: unknown): unknown => {
    if (typeof val === "string" && !condition.caseSensitive) {
      return val.toLowerCase();
    }
    return val;
  };

  const normalizedEventValue = normalize(eventValue);
  const normalizedConditionValue = normalize(conditionValue);

  switch (condition.operator) {
    case "equals":
      return normalizedEventValue === normalizedConditionValue;

    case "not_equals":
      return normalizedEventValue !== normalizedConditionValue;

    case "contains":
      if (
        typeof normalizedEventValue === "string" &&
        typeof normalizedConditionValue === "string"
      ) {
        return normalizedEventValue.includes(normalizedConditionValue);
      }
      if (Array.isArray(eventValue)) {
        return eventValue.some((v) => normalize(v) === normalizedConditionValue);
      }
      return false;

    case "not_contains":
      if (
        typeof normalizedEventValue === "string" &&
        typeof normalizedConditionValue === "string"
      ) {
        return !normalizedEventValue.includes(normalizedConditionValue);
      }
      if (Array.isArray(eventValue)) {
        return !eventValue.some((v) => normalize(v) === normalizedConditionValue);
      }
      return true;

    case "starts_with":
      if (
        typeof normalizedEventValue === "string" &&
        typeof normalizedConditionValue === "string"
      ) {
        return normalizedEventValue.startsWith(normalizedConditionValue);
      }
      return false;

    case "ends_with":
      if (
        typeof normalizedEventValue === "string" &&
        typeof normalizedConditionValue === "string"
      ) {
        return normalizedEventValue.endsWith(normalizedConditionValue);
      }
      return false;

    case "greater_than":
      if (typeof eventValue === "number" && typeof conditionValue === "number") {
        return eventValue > conditionValue;
      }
      if (eventValue instanceof Date && conditionValue instanceof Date) {
        return eventValue > conditionValue;
      }
      return false;

    case "less_than":
      if (typeof eventValue === "number" && typeof conditionValue === "number") {
        return eventValue < conditionValue;
      }
      if (eventValue instanceof Date && conditionValue instanceof Date) {
        return eventValue < conditionValue;
      }
      return false;

    case "in":
      if (Array.isArray(conditionValue)) {
        return conditionValue.some((v) => normalize(v) === normalizedEventValue);
      }
      return false;

    case "not_in":
      if (Array.isArray(conditionValue)) {
        return !conditionValue.some((v) => normalize(v) === normalizedEventValue);
      }
      return true;

    case "matches_regex":
      if (typeof eventValue === "string" && typeof conditionValue === "string") {
        try {
          const flags = condition.caseSensitive ? "" : "i";
          const regex = new RegExp(conditionValue, flags);
          return regex.test(eventValue);
        } catch {
          log.warn("Invalid regex in condition", { regex: conditionValue });
          return false;
        }
      }
      return false;

    case "is_empty":
      return (
        eventValue === null ||
        eventValue === undefined ||
        eventValue === "" ||
        (Array.isArray(eventValue) && eventValue.length === 0)
      );

    case "is_not_empty":
      return (
        eventValue !== null &&
        eventValue !== undefined &&
        eventValue !== "" &&
        (!Array.isArray(eventValue) || eventValue.length > 0)
      );

    default:
      log.warn("Unknown condition operator", { operator: condition.operator });
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// RULE MATCHING
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a rule's trigger matches the event type
 */
function matchesTrigger(rule: AutomationRule, event: RuleEvent): boolean {
  const trigger = rule.trigger as { type?: string } | string;

  if (typeof trigger === "string") {
    return trigger === event.type;
  }

  if (trigger && typeof trigger === "object" && trigger.type) {
    return trigger.type === event.type;
  }

  return false;
}

/**
 * Evaluate all conditions for a rule against an event
 * Returns matched conditions and a confidence score
 */
export function evaluateRule(rule: AutomationRule, event: RuleEvent): RuleMatch | null {
  // Check if rule is enabled
  if (!rule.enabled) {
    return null;
  }

  // Check trigger match
  if (!matchesTrigger(rule, event)) {
    return null;
  }

  // Get conditions (handle various formats)
  const conditions: RuleCondition[] = Array.isArray(rule.conditions)
    ? (rule.conditions as unknown as RuleCondition[]).filter((c) => c.field && c.operator)
    : [];

  // If no conditions, rule matches on trigger alone
  if (conditions.length === 0) {
    return {
      rule,
      event,
      matchedConditions: [],
      score: 100,
    };
  }

  // Evaluate all conditions
  const matchedConditions: RuleCondition[] = [];

  for (const condition of conditions) {
    if (evaluateCondition(condition, event)) {
      matchedConditions.push(condition);
    }
  }

  // All conditions must match (AND logic)
  if (matchedConditions.length !== conditions.length) {
    return null;
  }

  // Calculate confidence score based on condition specificity
  const score = Math.min(100, 50 + matchedConditions.length * 10);

  return {
    rule,
    event,
    matchedConditions,
    score,
  };
}

/**
 * Find all rules that match an event
 * Returns matches sorted by priority (highest first)
 */
export function findMatchingRules(rules: AutomationRule[], event: RuleEvent): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    const match = evaluateRule(rule, event);
    if (match) {
      matches.push(match);
    }
  }

  // Sort by priority (lower number = higher priority)
  // Priority is stored in rule.priority or defaults to 50
  matches.sort((a, b) => {
    const priorityA = (a.rule as unknown as { priority?: number }).priority ?? 50;
    const priorityB = (b.rule as unknown as { priority?: number }).priority ?? 50;
    return priorityA - priorityB;
  });

  return matches;
}

// ═══════════════════════════════════════════════════════════════
// SPAM DETECTION HELPERS
// ═══════════════════════════════════════════════════════════════

const messageHistory = new Map<string, { timestamps: number[]; contents: string[] }>();

/**
 * Check if a message appears to be spam
 */
export function detectSpam(
  userId: string,
  content: string,
  options: {
    maxMessagesPerMinute?: number;
    duplicateThreshold?: number;
    linkThreshold?: number;
  } = {},
): { isSpam: boolean; reason?: string } {
  const { maxMessagesPerMinute = 10, duplicateThreshold = 3, linkThreshold = 5 } = options;

  const now = Date.now();
  const history = messageHistory.get(userId) || { timestamps: [], contents: [] };

  // Clean old entries (older than 1 minute)
  const cutoff = now - 60_000;
  history.timestamps = history.timestamps.filter((t) => t > cutoff);
  history.contents = history.contents.slice(-20); // Keep last 20 messages

  // Add current message
  history.timestamps.push(now);
  history.contents.push(content.toLowerCase());
  messageHistory.set(userId, history);

  // Check rate limit
  if (history.timestamps.length > maxMessagesPerMinute) {
    return { isSpam: true, reason: "Rate limit exceeded" };
  }

  // Check duplicate messages
  const recentDuplicates = history.contents.filter((c) => c === content.toLowerCase()).length;
  if (recentDuplicates >= duplicateThreshold) {
    return { isSpam: true, reason: "Duplicate message spam" };
  }

  // Check link spam
  const linkCount = (content.match(/https?:\/\//gi) || []).length;
  if (linkCount >= linkThreshold) {
    return { isSpam: true, reason: "Link spam detected" };
  }

  return { isSpam: false };
}

/**
 * Clear spam history (for cleanup)
 */
export function clearSpamHistory(userId?: string): void {
  if (userId) {
    messageHistory.delete(userId);
  } else {
    messageHistory.clear();
  }
}
