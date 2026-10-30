/**
 * Funnel Automation Engine
 * Rule execution engine that matches triggers and executes actions
 */

import type {
  QualificationRule,
  QualificationCondition,
  QualificationOperator,
  Lead,
} from "../types.js";
import { type TriggerEvent, matchesTrigger, type TriggerType } from "./triggers.js";
import { executeAction, type ActionContext, type ActionResult } from "./actions.js";

// ═══════════════════════════════════════════════════════════════════════════════
// ENGINE STATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface RuleExecutionLog {
  id: string;
  ruleId: string;
  ruleName: string;
  triggeredAt: string;
  leadId: string;
  leadName: string;
  triggerType: TriggerType;
  conditionsMet: boolean;
  actionsExecuted: ActionResult[];
  duration: number; // ms
  error?: string;
}

export interface EngineStats {
  rulesEvaluated: number;
  rulesTriggered: number;
  actionsExecuted: number;
  errorsCount: number;
  lastRunAt: string | null;
  averageExecutionTime: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMATION ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class AutomationEngine {
  private rules: Map<string, QualificationRule> = new Map();
  private executionLogs: RuleExecutionLog[] = [];
  private stats: EngineStats = {
    rulesEvaluated: 0,
    rulesTriggered: 0,
    actionsExecuted: 0,
    errorsCount: 0,
    lastRunAt: null,
    averageExecutionTime: 0,
  };
  private maxLogs = 1000;

  // Service callbacks
  private services: {
    updateLead: ActionContext["updateLead"];
    moveLead: ActionContext["moveLead"];
    createTask: ActionContext["createTask"];
    sendNotification: ActionContext["sendNotification"];
    callWebhook: ActionContext["callWebhook"];
    logActivity: ActionContext["logActivity"];
    loadRules: (businessId: string, funnelId?: string) => Promise<QualificationRule[]>;
    updateRuleStats: (
      ruleId: string,
      updates: { triggerCount?: number; lastTriggeredAt?: string },
    ) => Promise<void>;
  };

  constructor(services: AutomationEngine["services"]) {
    this.services = services;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RULE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load rules for a business/funnel into memory
   */
  async loadRules(businessId: string, funnelId?: string): Promise<void> {
    const rules = await this.services.loadRules(businessId, funnelId);
    rules.forEach((rule) => {
      if (rule.enabled) {
        this.rules.set(rule.id, rule);
      }
    });
  }

  /**
   * Add or update a rule in memory
   */
  upsertRule(rule: QualificationRule): void {
    if (rule.enabled) {
      this.rules.set(rule.id, rule);
    } else {
      this.rules.delete(rule.id);
    }
  }

  /**
   * Remove a rule from memory
   */
  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }

  /**
   * Get all active rules (sorted by priority)
   */
  getActiveRules(funnelId?: string): QualificationRule[] {
    const rules = Array.from(this.rules.values());
    const filtered = funnelId ? rules.filter((r) => !r.funnelId || r.funnelId === funnelId) : rules;
    return filtered.sort((a, b) => a.priority - b.priority);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process a trigger event against all applicable rules
   */
  async processEvent(event: TriggerEvent): Promise<RuleExecutionLog[]> {
    const logs: RuleExecutionLog[] = [];
    const applicableRules = this.getActiveRules(event.funnelId);

    for (const rule of applicableRules) {
      const log = await this.evaluateRule(rule, event);
      if (log) {
        logs.push(log);
        this.addExecutionLog(log);
      }
    }

    this.stats.lastRunAt = new Date().toISOString();
    return logs;
  }

  /**
   * Evaluate a single rule against an event
   */
  private async evaluateRule(
    rule: QualificationRule,
    event: TriggerEvent,
  ): Promise<RuleExecutionLog | null> {
    const startTime = Date.now();
    this.stats.rulesEvaluated++;

    // Check if trigger matches
    if (!matchesTrigger(event, rule)) {
      return null;
    }

    // Need lead data to evaluate conditions
    if (!event.lead) {
      return null;
    }

    const log: RuleExecutionLog = {
      id: crypto.randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      triggeredAt: new Date().toISOString(),
      leadId: event.lead.id,
      leadName: event.lead.name,
      triggerType: event.type,
      conditionsMet: false,
      actionsExecuted: [],
      duration: 0,
    };

    try {
      // Evaluate conditions
      const conditionsMet = this.evaluateConditions(rule.conditions, event.lead);
      log.conditionsMet = conditionsMet;

      if (!conditionsMet) {
        log.duration = Date.now() - startTime;
        return log;
      }

      // Execute actions
      this.stats.rulesTriggered++;
      const context = this.createActionContext(event.lead, event.businessId, event.funnelId!, rule);

      for (const actionConfig of rule.actions) {
        const result = await executeAction(actionConfig, context);
        log.actionsExecuted.push(result);
        this.stats.actionsExecuted++;

        if (!result.success) {
          this.stats.errorsCount++;
        }
      }

      // Update rule stats
      await this.services.updateRuleStats(rule.id, {
        triggerCount: (rule.triggerCount || 0) + 1,
        lastTriggeredAt: new Date().toISOString(),
      });
    } catch (error) {
      log.error = error instanceof Error ? error.message : String(error);
      this.stats.errorsCount++;
    }

    log.duration = Date.now() - startTime;
    this.updateAverageExecutionTime(log.duration);
    return log;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONDITION EVALUATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate all conditions (AND logic)
   */
  private evaluateConditions(conditions: QualificationCondition[], lead: Lead): boolean {
    if (!conditions || conditions.length === 0) {
      return true; // No conditions = always match
    }
    return conditions.every((condition) => this.evaluateCondition(condition, lead));
  }

  /**
   * Evaluate a single condition
   */
  private evaluateCondition(condition: QualificationCondition, lead: Lead): boolean {
    const value = this.getFieldValue(condition.field, lead);
    return this.compareValues(value, condition.operator, condition.value);
  }

  /**
   * Get nested field value from lead (supports dot notation)
   */
  private getFieldValue(field: string, lead: Lead): unknown {
    const parts = field.split(".");
    let value: unknown = lead;

    for (const part of parts) {
      if (value == null || typeof value !== "object") {
        return undefined;
      }
      value = (value as Record<string, unknown>)[part];
    }

    return value;
  }

  /**
   * Compare values based on operator
   */
  private compareValues(
    actual: unknown,
    operator: QualificationOperator,
    expected: unknown,
  ): boolean {
    switch (operator) {
      case "equals":
        return actual === expected;

      case "not_equals":
        return actual !== expected;

      case "contains":
        if (typeof actual === "string" && typeof expected === "string") {
          return actual.toLowerCase().includes(expected.toLowerCase());
        }
        if (Array.isArray(actual)) {
          return actual.includes(expected);
        }
        return false;

      case "not_contains":
        if (typeof actual === "string" && typeof expected === "string") {
          return !actual.toLowerCase().includes(expected.toLowerCase());
        }
        if (Array.isArray(actual)) {
          return !actual.includes(expected);
        }
        return true;

      case "greater_than":
        return Number(actual) > Number(expected);

      case "less_than":
        return Number(actual) < Number(expected);

      case "is_set":
        return actual != null && actual !== "";

      case "is_not_set":
        return actual == null || actual === "";

      case "in_list":
        if (Array.isArray(expected)) {
          return expected.includes(actual);
        }
        if (typeof expected === "string") {
          return expected
            .split(",")
            .map((s) => s.trim())
            .includes(String(actual));
        }
        return false;

      case "not_in_list":
        if (Array.isArray(expected)) {
          return !expected.includes(actual);
        }
        if (typeof expected === "string") {
          return !expected
            .split(",")
            .map((s) => s.trim())
            .includes(String(actual));
        }
        return true;

      default:
        return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private createActionContext(
    lead: Lead,
    businessId: string,
    funnelId: string,
    rule: QualificationRule,
  ): ActionContext {
    return {
      lead,
      businessId,
      funnelId,
      ruleId: rule.id,
      ruleName: rule.name,
      updateLead: this.services.updateLead,
      moveLead: this.services.moveLead,
      createTask: this.services.createTask,
      sendNotification: this.services.sendNotification,
      callWebhook: this.services.callWebhook,
      logActivity: this.services.logActivity,
    };
  }

  private addExecutionLog(log: RuleExecutionLog): void {
    this.executionLogs.unshift(log);
    if (this.executionLogs.length > this.maxLogs) {
      this.executionLogs.pop();
    }
  }

  private updateAverageExecutionTime(duration: number): void {
    const total = this.stats.rulesEvaluated;
    const prev = this.stats.averageExecutionTime;
    this.stats.averageExecutionTime = prev + (duration - prev) / total;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  getStats(): EngineStats {
    return { ...this.stats };
  }

  getExecutionLogs(limit = 100): RuleExecutionLog[] {
    return this.executionLogs.slice(0, limit);
  }

  clearLogs(): void {
    this.executionLogs = [];
  }

  resetStats(): void {
    this.stats = {
      rulesEvaluated: 0,
      rulesTriggered: 0,
      actionsExecuted: 0,
      errorsCount: 0,
      lastRunAt: null,
      averageExecutionTime: 0,
    };
  }

  /**
   * Test a rule against a lead without executing actions
   */
  testRule(
    rule: QualificationRule,
    lead: Lead,
  ): { matches: boolean; conditionResults: { field: string; passed: boolean }[] } {
    const conditionResults = rule.conditions.map((condition) => ({
      field: condition.field,
      passed: this.evaluateCondition(condition, lead),
    }));

    return {
      matches: conditionResults.every((r) => r.passed),
      conditionResults,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export function createAutomationEngine(
  services: ConstructorParameters<typeof AutomationEngine>[0],
): AutomationEngine {
  return new AutomationEngine(services);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RE-EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { createTriggerEvent } from "./triggers.js";
export type { TriggerEvent, TriggerType } from "./triggers.js";
export type { ActionResult, ActionContext } from "./actions.js";
