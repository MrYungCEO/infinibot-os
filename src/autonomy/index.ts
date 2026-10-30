/**
 * Autonomy Architecture — Module Exports
 * Trust infrastructure for Infini's autonomous operation
 */

// Types
export * from "./types.js";

// Subsystems
export { audit, logAudit, logCageInterference } from "./audit.js";
export { queue } from "./queue.js";
export { pause } from "./pause.js";
export { hardware } from "./hardware.js";
export { notifications } from "./notifications.js";
export { apiMonitor } from "./api-monitor.js";
export { kanbanSync, syncToKanban } from "./kanban-sync.js";

// Main manager
export { autonomy, initAutonomy, getAutonomyState, reapplyNotificationsConfig } from "./manager.js";

// Self-heal registry (broken-tool recovery + failure classification)
export { classifyFailure, attemptHeal, getHealers, DEFAULT_HEAL_BUDGET } from "./self-heal.js";
export type { Healer, HealContext, HealOutcome, FailureClassification } from "./self-heal.js";

// Closed-loop orchestrator (build → test → assess)
export {
  startOrchestratedTask,
  validatePrefire,
  getRunningOrchestrationsForTests,
} from "./orchestrator.js";
export type { PrefireValidation } from "./orchestrator.js";
export { buildTesterPrompt, parseTesterVerdict, buildBuilderPrompt } from "./tester-agent.js";
