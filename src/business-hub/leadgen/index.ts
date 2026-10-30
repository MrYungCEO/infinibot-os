/**
 * Lead generation — public entry point for the Business hub (RPC, agent
 * tools, orchestrator).
 */

export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  getLeadJob,
  listLeadJobs,
  listLeadResults,
  startLeadSearch,
  waitForLeadJob,
  type LeadJob,
  type LeadResult,
  type LeadSearchInput,
  type ResultQuery,
} from "./jobs.js";
export { enrichHubRecord, importLeadResults, type ImportOpts } from "./import.js";
export { verifyEmail, verifyLeadEmails } from "./verify.js";
export {
  listProviderStatus,
  loadLeadgenConfig,
  saveLeadgenConfig,
  type ConfigPatch,
} from "./config.js";
export { LEAD_PROVIDERS, getProvider } from "./providers.js";
export type {
  LeadData,
  LeadEmail,
  LeadProvider,
  LeadgenConfig,
  LeadgenDeps,
  EmailVerdict,
  JobProgress,
} from "./types.js";
