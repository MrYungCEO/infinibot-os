/**
 * Deep Memory Architecture — Main Export
 * 
 * Persistent project sessions with crash recovery for 10+ concurrent agents.
 */

// Types
export * from "./types.js";

// Store
export { getProjectStore, ProjectStore } from "./store.js";

// TASK.md
export {
  parseTaskDocument,
  renderTaskDocument,
  readTaskFile,
  writeTaskFile,
  sessionToTaskDocument,
  taskDocumentToProgress,
  initProjectTask,
  updateProjectTask,
} from "./task-parser.js";

// Checkpoints
export {
  CheckpointManager,
  getCheckpointManager,
  maybeAutoCheckpoint,
  createMilestoneCheckpoint,
  buildContextSnapshot,
} from "./checkpoint.js";

// Recovery
export {
  RecoveryManager,
  getRecoveryManager,
  runStartupRecovery,
  type RecoveryReport,
} from "./recovery.js";

// Agent Tool
export {
  handleProjectTool,
  projectToolDefinition,
  type ProjectToolAction,
} from "./project-tool.js";

// Kanban/Notion Sync
export {
  syncProjectToKanban,
  syncSubtasksToKanban,
  syncSessionToKanban,
  completeSubtaskAndSync,
} from "./kanban-sync.js";

// Session Onboarding
export {
  startOnboarding,
  getOnboardingState,
  isOnboarding,
  advanceOnboarding,
  skipOnboarding,
  completeOnboarding,
  getOnboardingPrompt,
  parseOnboardingInput,
  shouldTriggerOnboarding,
  getExistingProjectsForOnboarding,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingMode,
} from "./session-onboarding.js";

// Project Context (for agent injection)
export {
  getProjectContext,
  getEffectiveWorkingDir,
  hasLinkedProject,
  type ProjectContext,
} from "./project-context.js";
