/**
 * Public entry point for the credit / API-cost ledger.
 *
 * Usage from anywhere in the codebase:
 *   import { recordCredit, recordFromAnthropicResponse } from "../credits/index.js";
 *
 * The store auto-initializes on first use, but the gateway boot sequence
 * should call `initCreditLedger()` explicitly so the path is logged at startup.
 */

export * from "./types.js";
export {
  initCreditLedger,
  getCreditStore,
  isCreditStoreInitialized,
  closeCreditStore,
} from "./store.js";
export { priceUsd, loadPricingTable, listPricedModels, reloadPricingTable } from "./pricing.js";
export {
  recordCredit,
  recordFromAnthropicResponse,
  recordFromOpenAIResponse,
  recordFromGeminiResponse,
  recordFromOllamaResponse,
  recordFromOpencodeJSON,
  recordFromCodexJSON,
  recordFromClaudeCodeTranscript,
  recordLegacyApiUsage,
  recordLegacyBudgetEntry,
  onCredit,
} from "./recorder.js";
export {
  summary,
  timeseries,
  topConsumers,
  recentEntries,
  sessionEntries,
  projectEntries,
  budgetStatuses,
  checkSpawnGuard,
  listBudgets,
  invalidateAggregatorCache,
} from "./aggregator.js";
export { syncProvider, syncAll, listProviderCursors } from "./sync.js";

// ── Plan-aware usage tracking ──────────────────────────────────
export {
  listPlansForProvider,
  listAllPlans,
  getPlanDef,
  PLAN_PROVIDERS,
  type PlanDef,
  type PlanProvider,
} from "./plans/index.js";
export {
  listProviderPlanConfigs,
  getProviderPlanConfig,
  upsertProviderPlanConfig,
  deleteProviderPlanConfig,
  redactPlanConfig,
  type ProviderPlanConfig,
} from "./plan-config.js";
export {
  listProviderPlans,
  getProviderPlanView,
  refreshProviderPlan,
  refreshAllProviderPlans,
  testProviderConnection,
  type ProviderPlanView,
} from "./plan-service.js";
export { type ProviderPlanUsage } from "./plan-pullers/index.js";
export { startPlanRefreshLoop, stopPlanRefreshLoop } from "./plan-refresh.js";
