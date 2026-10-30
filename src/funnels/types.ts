/**
 * Funnel System — Core Type Definitions
 * Business automation and sales funnel management
 */

// ═══════════════════════════════════════════════════════════════
// BUSINESS TYPES
// ═══════════════════════════════════════════════════════════════

export interface Business {
  id: string;
  name: string;
  description?: string;
  industry?: string;
  website?: string;
  logo?: string;

  // Contact info
  email?: string;
  phone?: string;
  address?: string;

  // Settings
  timezone?: string;
  currency?: string;

  // Meta
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// ═══════════════════════════════════════════════════════════════
// FUNNEL TYPES
// ═══════════════════════════════════════════════════════════════

export type FunnelType =
  | "sales"
  | "marketing"
  | "onboarding"
  | "support"
  | "recruitment"
  | "custom";

export type FunnelStatus = "draft" | "active" | "paused" | "archived";

export interface Funnel {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  type: FunnelType;
  status: FunnelStatus;

  // Visual layout
  color?: string;
  icon?: string;

  // Automation
  automationEnabled: boolean;
  webhookUrl?: string;

  // Stats (computed/cached)
  totalLeads?: number;
  conversionRate?: number;
  averageDaysInFunnel?: number;

  // Meta
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// ═══════════════════════════════════════════════════════════════
// STAGE TYPES
// ═══════════════════════════════════════════════════════════════

export type StageType =
  | "entry" // First stage, leads enter here
  | "standard" // Normal funnel stage
  | "decision" // Branch point with multiple exits
  | "exit" // Final stage (won/lost/completed)
  | "parking"; // Hold/nurture stage

export interface Stage {
  id: string;
  funnelId: string;
  name: string;
  description?: string;
  type: StageType;

  // Visual positioning
  position: number;
  color?: string;
  icon?: string;

  // Rules
  autoMoveAfterDays?: number; // Auto-advance after N days
  maxDaysAllowed?: number; // Alert if lead stays too long

  // Qualification
  qualificationRules?: string[]; // QualificationRule IDs

  // Stats (computed/cached)
  leadCount?: number;
  avgTimeInStage?: number;

  // ── Slice C: canvas visual fields ─────────────────────────────
  //
  // A funnel + its stages is now THE canvas — there's no separate
  // flow_maps table for the production model. These fields hold the
  // visual + integration state the canvas needs to render a node.
  // All optional so old funnels that pre-date the unified schema keep
  // rendering with sensible defaults.

  /** Production node library id (e.g. "instagram", "email_seq"). */
  libraryId?: string;
  /** Emoji visual identifier shown on the canvas node. */
  emoji?: string;
  /** Canvas grid coordinates. */
  row?: number;
  column?: number;
  /** Per-node checklist items (what features/integrations are enabled). */
  items?: Array<{ id: string; label: string; enabled: boolean }>;
  /** Integration connection state — wired by the setup wizard. */
  integration?: {
    type: "api" | "scraping" | "manual" | "webhook";
    connected: boolean;
    lastSync?: number;
  };
  /** Link to a landing page / external URL for this stage. */
  pageLink?: {
    type: "directory" | "external" | "none";
    directoryPath?: string;
    externalUrl?: string;
    lastEdited?: number;
  };
  /** KPI tracking config for this stage. */
  kpiTracking?: {
    enabled: boolean;
    siteId?: string;
    trackClicks?: boolean;
    trackScroll?: boolean;
    trackForms?: boolean;
    conversionGoal?: "form_submit" | "button_click" | "page_visit" | "custom";
    customEventName?: string;
  };

  // Meta
  createdAt: string;
  updatedAt: string;
}

export interface StageConnection {
  id: string;
  funnelId: string;
  sourceStageId: string;
  targetStageId: string;

  // Conditions for auto-movement
  label?: string;
  conditionType?: "manual" | "auto" | "rule";
  conditionConfig?: Record<string, unknown>;

  // Stats
  transitionCount?: number;
  avgTransitionTime?: number; // hours

  // Meta
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════
// LEAD TYPES
// ═══════════════════════════════════════════════════════════════

export type LeadSource =
  | "website"
  | "referral"
  | "social"
  | "email"
  | "phone"
  | "advertisement"
  | "event"
  | "import"
  | "manual"
  | "other";

export type LeadStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost"
  | "nurturing"
  | "disqualified";

export type LeadPriority = "low" | "medium" | "high" | "urgent";

export interface Lead {
  id: string;
  businessId: string;
  funnelId: string;
  stageId: string;

  // Contact info
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;

  // Lead data
  source: LeadSource;
  status: LeadStatus;
  priority: LeadPriority;
  score?: number; // 0-100 qualification score

  /**
   * Outreach campaign that produced this lead. Stamped at insert time
   * when the lead comes from a campaign-driven flow (scrape, form
   * submission via a campaign-bound funnel, etc.). Drives campaign
   * context lookup during qualification/email/doc generation.
   */
  campaignId?: string;

  // Value
  estimatedValue?: number;
  currency?: string;

  // Assignment
  assignedTo?: string; // User/agent ID

  // Tracking
  tags?: string[];
  customFields?: Record<string, unknown>;

  // Timeline
  firstContactAt?: string;
  lastContactAt?: string;
  lastActivityAt?: string;
  expectedCloseDate?: string;

  // Outcome (if won/lost)
  actualValue?: number;
  lostReason?: string;
  wonAt?: string;
  lostAt?: string;

  // Meta
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface LeadActivity {
  id: string;
  leadId: string;
  type: "note" | "email" | "call" | "meeting" | "task" | "stage_change" | "score_change" | "system";
  description: string;
  metadata?: Record<string, unknown>;
  performedBy?: string;
  createdAt: string;
}

export interface LeadStageHistory {
  id: string;
  leadId: string;
  fromStageId?: string;
  toStageId: string;
  reason?: string;
  performedBy?: string;
  createdAt: string;
  timeInPreviousStage?: number; // seconds
}

// ═══════════════════════════════════════════════════════════════
// OFFER TYPES
// ═══════════════════════════════════════════════════════════════

export type OfferType = "product" | "service" | "subscription" | "bundle" | "custom";
export type OfferStatus = "draft" | "active" | "expired" | "archived";

export interface Offer {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  type: OfferType;
  status: OfferStatus;

  // Pricing
  price: number;
  currency: string;
  discountPercent?: number;
  discountAmount?: number;

  // Validity
  validFrom?: string;
  validUntil?: string;

  // Limits
  maxRedemptions?: number;
  currentRedemptions?: number;

  // Targeting
  targetStages?: string[]; // Stage IDs where this offer is presented
  targetTags?: string[];
  minScore?: number;

  // Content
  heroImage?: string;
  features?: string[];
  terms?: string;

  // Meta
  createdAt: string;
  updatedAt: string;
}

export interface OfferPresentation {
  id: string;
  offerId: string;
  leadId: string;
  presentedAt: string;
  presentedBy?: string;
  response?: "accepted" | "rejected" | "pending" | "expired";
  respondedAt?: string;
  notes?: string;
}

// ═══════════════════════════════════════════════════════════════
// TASK TYPES (Funnel-specific)
// ═══════════════════════════════════════════════════════════════

export type FunnelTaskType =
  | "follow_up"
  | "call"
  | "email"
  | "meeting"
  | "proposal"
  | "demo"
  | "review"
  | "custom";

export type FunnelTaskStatus = "pending" | "in_progress" | "completed" | "cancelled" | "overdue";
export type FunnelTaskPriority = "low" | "normal" | "high" | "urgent";

export interface FunnelTask {
  id: string;
  businessId: string;
  funnelId?: string;
  leadId?: string;
  stageId?: string;

  title: string;
  description?: string;
  type: FunnelTaskType;
  status: FunnelTaskStatus;
  priority: FunnelTaskPriority;

  // Assignment
  assignedTo?: string;
  createdBy?: string;

  // Scheduling
  dueAt?: string;
  reminderAt?: string;
  completedAt?: string;

  // Automation
  autoGenerated?: boolean;
  ruleId?: string; // If generated by automation

  // Meta
  createdAt: string;
  updatedAt: string;
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION TYPES
// ═══════════════════════════════════════════════════════════════

export type ConversationChannel =
  | "email"
  | "phone"
  | "sms"
  | "whatsapp"
  | "telegram"
  | "discord"
  | "website_chat"
  | "in_person"
  | "other";

export type ConversationStatus = "active" | "closed" | "pending" | "archived";

export interface Conversation {
  id: string;
  businessId: string;
  leadId: string;

  channel: ConversationChannel;
  status: ConversationStatus;
  subject?: string;

  // External references
  externalId?: string; // Email thread ID, chat ID, etc.
  externalUrl?: string;

  // Participants
  participantIds?: string[];
  assignedTo?: string;

  // Stats
  messageCount?: number;
  lastMessageAt?: string;
  lastMessageBy?: string;

  // Sentiment (AI-analyzed)
  sentiment?: "positive" | "neutral" | "negative";
  sentimentScore?: number; // -1 to 1

  // Meta
  startedAt: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;

  direction: "inbound" | "outbound";
  senderType: "lead" | "user" | "agent" | "system";
  senderId?: string;
  senderName?: string;

  content: string;
  contentType?: "text" | "html" | "markdown";

  // Attachments
  attachments?: {
    name: string;
    url: string;
    type: string;
    size?: number;
  }[];

  // Tracking
  readAt?: string;
  deliveredAt?: string;

  // AI analysis
  summary?: string;
  extractedData?: Record<string, unknown>;

  // Meta
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════
// QUALIFICATION RULE TYPES
// ═══════════════════════════════════════════════════════════════

export type QualificationOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "greater_than"
  | "less_than"
  | "is_set"
  | "is_not_set"
  | "in_list"
  | "not_in_list";

export type QualificationAction =
  | "add_score"
  | "subtract_score"
  | "set_score"
  | "move_stage"
  | "add_tag"
  | "remove_tag"
  | "assign_to"
  | "create_task"
  | "send_notification"
  | "webhook";

export interface QualificationCondition {
  field: string; // e.g., 'lead.company', 'lead.email', 'custom.budget'
  operator: QualificationOperator;
  value: unknown;
}

export interface QualificationActionConfig {
  type: QualificationAction;
  config: Record<string, unknown>;
}

export interface QualificationRule {
  id: string;
  businessId: string;
  funnelId?: string;
  stageId?: string;

  name: string;
  description?: string;
  enabled: boolean;
  priority: number; // Lower = higher priority, evaluated first

  // Trigger
  triggerOn:
    | "lead_created"
    | "lead_updated"
    | "stage_changed"
    | "field_changed"
    | "field_updated"
    | "score_changed"
    | "tag_added"
    | "tag_removed"
    | "activity_logged"
    | "time_in_stage"
    | "scheduled"
    | "webhook_received"
    | "manual";
  triggerField?: string; // For field_changed trigger

  // Conditions (AND logic)
  conditions: QualificationCondition[];

  // Actions (executed in order)
  actions: QualificationActionConfig[];

  // Stats
  triggerCount?: number;
  lastTriggeredAt?: string;

  // Meta
  createdAt: string;
  updatedAt: string;
}

// ═══════════════════════════════════════════════════════════════
// KPI METRIC TYPES
// ═══════════════════════════════════════════════════════════════

export type MetricType =
  | "count"
  | "sum"
  | "average"
  | "percentage"
  | "ratio"
  | "duration"
  | "currency";

export type MetricPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "yearly" | "all_time";

export interface KPIMetric {
  id: string;
  businessId: string;
  funnelId?: string;
  stageId?: string;

  name: string;
  description?: string;
  type: MetricType;

  // Calculation
  formula?: string; // For computed metrics
  sourceField?: string;
  aggregation?: "sum" | "avg" | "min" | "max" | "count";

  // Current value
  currentValue: number;
  previousValue?: number;
  changePercent?: number;

  // Targets
  targetValue?: number;
  warningThreshold?: number;
  criticalThreshold?: number;

  // Display
  unit?: string;
  precision?: number;
  displayFormat?: string;

  // Period
  period: MetricPeriod;
  periodStart?: string;
  periodEnd?: string;

  // Meta
  calculatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface KPISnapshot {
  id: string;
  metricId: string;
  value: number;
  period: MetricPeriod;
  periodStart: string;
  periodEnd: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════
// FILTER & QUERY TYPES
// ═══════════════════════════════════════════════════════════════

export interface LeadFilters {
  businessId?: string;
  funnelId?: string;
  stageId?: string;
  campaignId?: string;
  status?: LeadStatus | LeadStatus[];
  priority?: LeadPriority | LeadPriority[];
  source?: LeadSource | LeadSource[];
  assignedTo?: string;
  tags?: string[];
  minScore?: number;
  maxScore?: number;
  search?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: "asc" | "desc";
}

export interface FunnelFilters {
  businessId?: string;
  type?: FunnelType | FunnelType[];
  status?: FunnelStatus | FunnelStatus[];
  search?: string;
  limit?: number;
  offset?: number;
}

export interface TaskFilters {
  businessId?: string;
  funnelId?: string;
  leadId?: string;
  stageId?: string;
  assignedTo?: string;
  status?: FunnelTaskStatus | FunnelTaskStatus[];
  type?: FunnelTaskType | FunnelTaskType[];
  dueBefore?: string;
  dueAfter?: string;
  overdue?: boolean;
  limit?: number;
  offset?: number;
}

// ═══════════════════════════════════════════════════════════════
// FLOW MAP TYPES (Visual Funnel Builder)
// ═══════════════════════════════════════════════════════════════

export type FlowNodeType =
  | "entry"
  | "social"
  | "messaging"
  | "hub"
  | "offer"
  | "landing"
  | "qualification"
  | "custom";

export type PlatformType =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "twitter"
  | "linkedin"
  | "telegram"
  | "discord"
  | "whatsapp"
  | "website"
  | "app"
  | "email";

export type IntegrationType = "api" | "webhook" | "manual" | "scraping";

export interface FlowNodeItem {
  id: string;
  label: string;
  icon?: string;
  enabled: boolean;
}

export interface FlowNodeIntegration {
  type: IntegrationType;
  connected: boolean;
  lastSync?: number;
  apiKey?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  tokenExpiry?: number;
  config?: Record<string, any>;
}

export interface FlowNodeKPI {
  followers?: number;
  subscribers?: number;
  members?: number;
  revenue?: number;
  conversions?: number;
  clicks?: number;
  views?: number;
  leads?: number;
  lastUpdated?: number;
}

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  platform?: PlatformType;
  name: string;
  description?: string;
  color?: string;
  row: number;
  column: number;
  width?: number;
  items?: FlowNodeItem[];
  integration?: FlowNodeIntegration;
  kpi?: FlowNodeKPI;
  config?: Record<string, any>;
}

export interface FlowConnection {
  id: string;
  from: string;
  to: string;
  label?: string;
  conversionRate?: number;
}

export interface FunnelFlowMap {
  id: string;
  name: string;
  businessId: string;
  nodes: FlowNode[];
  connections: FlowConnection[];
  createdAt: string;
  updatedAt: string;
  /** Set when the flow map has been promoted to a live funnel via funnels.flowmap.promote. */
  funnelId?: string;
}

// ═══════════════════════════════════════════════════════════════
// ANALYTICS TYPES
// ═══════════════════════════════════════════════════════════════

export interface FunnelAnalytics {
  funnelId: string;
  period: { start: string; end: string };

  // Lead metrics
  totalLeads: number;
  newLeads: number;
  convertedLeads: number;
  lostLeads: number;

  // Conversion
  overallConversionRate: number;
  stageConversionRates: Record<string, number>;

  // Value
  totalValue: number;
  wonValue: number;
  lostValue: number;
  averageDealSize: number;

  // Time
  averageDaysToClose: number;
  averageTimePerStage: Record<string, number>;

  // Activity
  totalActivities: number;
  activitiesByType: Record<string, number>;

  // Stage breakdown
  leadsPerStage: Record<string, number>;
  valuePerStage: Record<string, number>;
}
