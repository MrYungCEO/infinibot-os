/**
 * Vault Rule Engine — Entry Point
 * Real-time Discord automation with custom rules
 */

// Types
export * from './types.js';

// Evaluator
export {
  evaluateCondition,
  evaluateRule,
  findMatchingRules,
  detectSpam,
  clearSpamHistory,
} from './evaluator.js';

// Executor
export { executeRule } from './executor.js';

// Engine
export {
  initRuleEngine,
  reloadRules,
  getEngineStats,
  getExecutionHistory,
  isEngineRunning,
  processEvent,
  processMessage,
  processMemberJoin,
  processMemberLeave,
  processRoleChange,
  messageToRuleEvent,
  memberJoinToRuleEvent,
  memberLeaveToRuleEvent,
  roleChangeToRuleEvent,
} from './engine.js';
