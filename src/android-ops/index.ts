/**
 * Android Social Ops — public surface.
 *
 * Four-phone V1 for legitimate multi-account publishing: the server owns state,
 * phones execute assigned jobs, and every verification/CAPTCHA/2FA prompt is a
 * human checkpoint. See `compliance.ts` for the enforced boundary.
 */

export * from "./types.js";
export { AndroidOpsStore, getAndroidOpsStore, closeAndroidOpsStore } from "./store.js";
export {
  AndroidOpsService,
  getAndroidOpsService,
  resetAndroidOpsService,
  type TickResult,
  type ScheduleInput,
  type FleetRefreshResult,
  type SetupStatus,
  type AccountImportResult,
} from "./service.js";
export {
  SECRET_FIELD_NAMES,
  SecretMaterialError,
  assertNoSecretMaterial,
  normalizeSecretRef,
  toPublicAccount,
  normalizeDeviceRegistration,
  normalizeAccountImport,
  nextFreeSlot,
  ipFromSerial,
  isIpv4,
  looksLikeDemoData,
  detectFlyConfig,
  buildSetupSteps,
  type PublicSocialAccount,
  type DeviceRegistrationInput,
  type AccountImportEntry,
  type StoreCensus,
  type FlyConfigPresence,
  type SetupStep,
} from "./setup.js";
export {
  JOB_STATES,
  TRANSITIONS,
  canTransition,
  applyTransition,
  canRetry,
  isActive,
  isTerminal,
  nextRetryDelayMs,
  resumeStateFor,
  JobTransitionError,
} from "./job-state-machine.js";
export {
  DEFAULT_MAX_ACCOUNTS_PER_DEVICE,
  DEFAULT_DEVICE_GAP_MS,
  DEFAULT_RACK_GAP_MS,
  computeLoads,
  pickLeastLoadedDevice,
  staggerSchedule,
  dailyWorkload,
  type DeviceLoad,
  type WorkloadBucket,
} from "./assignment.js";
export {
  buildDashboard,
  collectUrgent,
  rollupAccounts,
  rollupDevices,
  rollupJobs,
  type DashboardSummary,
  type UrgentItem,
} from "./dashboard.js";
export {
  COMPLIANCE_STATEMENT,
  FORBIDDEN_CAPABILITIES,
  HUMAN_CHECKPOINTS,
  ALLOWED_COMMANDS,
  assertAllowedCommand,
  assertHumanCheckpoint,
  ComplianceViolationError,
} from "./compliance.js";
export {
  buildProvisioningSteps,
  startProvisioningRun,
  advanceProvisioning,
  nextOperatorAction,
} from "./provisioning.js";
export { SCALING_ROADMAP, BUILD_SEQUENCE, RUNBOOKS } from "./roadmap.js";
export { seedAndroidOps } from "./seed.js";
export { simulateOutcome } from "./simulator.js";
export * from "./adapters/index.js";
