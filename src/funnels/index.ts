/**
 * Funnel System — Main Entry Point
 * Business automation and sales funnel management
 */

// ═══════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ═══════════════════════════════════════════════════════════════

export type {
  // Business
  Business,
  
  // Funnel
  Funnel,
  FunnelType,
  FunnelStatus,
  FunnelFilters,
  FunnelAnalytics,
  
  // Stage
  Stage,
  StageType,
  StageConnection,
  
  // Lead
  Lead,
  LeadSource,
  LeadStatus,
  LeadPriority,
  LeadFilters,
  LeadActivity,
  LeadStageHistory,
  
  // Offer
  Offer,
  OfferType,
  OfferStatus,
  OfferPresentation,
  
  // Task
  FunnelTask,
  FunnelTaskType,
  FunnelTaskStatus,
  FunnelTaskPriority,
  TaskFilters,
  
  // Conversation
  Conversation,
  ConversationChannel,
  ConversationStatus,
  ConversationMessage,
  
  // Qualification
  QualificationRule,
  QualificationCondition,
  QualificationActionConfig,
  QualificationOperator,
  QualificationAction,
  
  // KPI
  KPIMetric,
  KPISnapshot,
  MetricType,
  MetricPeriod,
} from './types.js';

// ═══════════════════════════════════════════════════════════════
// STORE EXPORTS
// ═══════════════════════════════════════════════════════════════

export { FunnelStore, getFunnelStore, resetFunnelStore } from './store.js';
