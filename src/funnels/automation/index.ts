/**
 * Funnel Automation Module
 * Exports all automation-related types and functions
 */

// Engine
export { 
  AutomationEngine, 
  createAutomationEngine,
  createTriggerEvent,
  type RuleExecutionLog,
  type EngineStats,
  type TriggerEvent,
  type TriggerType,
  type ActionResult,
  type ActionContext,
} from './engine.js';

// Triggers
export {
  TRIGGER_CONFIGS,
  matchesTrigger,
  type TriggerConfig,
  type TriggerFieldConfig,
} from './triggers.js';

// Actions
export {
  ACTION_CONFIGS,
  executeAction,
  getActionsByCategory,
  type ActionConfig,
  type ActionFieldConfig,
} from './actions.js';
