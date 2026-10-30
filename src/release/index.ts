/**
 * Release-publisher: a continuous workflow that auto-commits + pushes finished
 * coder work to the open PR once agents are idle. Local-only (no GitHub Actions).
 */

export {
  RELEASE_PUBLISHER_WORKFLOW_ID,
  initReleasePublisher,
  ensureReleasePublisherWorkflow,
  registerReleasePublisherTick,
  runReleasePublisherTick,
  blockingSubagents,
  type TickReport,
} from "./publisher.js";

export {
  loadConfig,
  isPaused,
  isDryRun,
  pausedFlagPath,
  configPath,
  DEFAULT_RELEASE_PUBLISHER_CONFIG,
  type ReleasePublisherConfig,
  type ReleasePublisherState,
} from "./config.js";
