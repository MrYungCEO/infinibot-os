/**
 * Single-agency Operations Center controller.
 *
 * The view is intentionally backed by one cohesive `agency.ops.*` RPC surface.
 * This keeps business operations independent from the legacy project, CRM, and
 * finance stores while the server-side agency system of record is introduced.
 */

import { applyPendingTaskWrites, beginPendingTaskWrite } from "./kanban-pending-writes";
import type { GatewayBrowserClient } from "../gateway";
import { getBizFilter, setBizFilter } from "../lib/biz-filter";
// Client profiles are consolidated onto the canonical /clients focus page;
// this surface navigates there rather than owning a second profile view.
import { openEntityInTab } from "../app-settings";
import { slugify } from "../lib/slugs";

export type AgencyOpsTone = "neutral" | "positive" | "warning" | "critical";
export type WorkerKind = "human" | "ai";
export type Availability = "available" | "focused" | "offline" | "blocked";
export type AgencyOperationsSection =
  | "overview"
  | "delivery"
  | "employees"
  | "employee-ops"
  | "allocation"
  | "approvals"
  | "finance"
  | "activity"
  | "reliability"
  | "settings";

export interface AgencyWorkspace {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
  ownerName?: string;
  memberCount?: number;
}

export interface AgencyKpi {
  id: string;
  label: string;
  value: string;
  change?: number;
  context?: string;
  tone?: AgencyOpsTone;
}

export interface PipelineStage {
  id: string;
  label: string;
  dealCount: number;
  value: number;
  weightedValue: number;
  color?: string;
}

export interface PipelineDeal {
  id: string;
  name: string;
  clientName: string;
  stageId: string;
  value: number;
  probability: number;
  ownerName?: string;
  nextAction?: string;
  nextActionAt?: number;
}

export interface AgencyDeliverable {
  id: string;
  name: string;
  status: "planned" | "in_progress" | "in_review" | "approved" | "blocked";
  dueAt?: number;
  ownerName?: string;
}

export interface AgencyEngagement {
  id: string;
  clientName: string;
  name: string;
  health: "on_track" | "at_risk" | "off_track";
  progress: number;
  budgetUsedPercent: number;
  dueAt?: number;
  deliverables: AgencyDeliverable[];
}

export interface AgencyApproval {
  id: string;
  type: "deliverable" | "spend" | "outbound" | "scope" | "deployment" | "other";
  title: string;
  description?: string;
  requestedBy: string;
  requestedAt: number;
  risk: "low" | "medium" | "high";
  amount?: number;
  currency?: string;
  engagementName?: string;
}

export interface AgencyEmployee {
  id: string;
  name: string;
  kind: WorkerKind;
  role: string;
  department: string;
  availability: Availability;
  capacityHours: number;
  allocatedHours: number;
  utilizationPercent: number;
  activeWork: number;
  performanceScore?: number;
  model?: string;
  managerName?: string;
  /**
   * Governance fields the roster RPC already returns but the card never showed.
   * All optional: an older gateway omits them and the card must degrade to
   * "not reported" rather than rendering `undefined`.
   */
  persona?: string | null;
  goals?: string[];
  kpis?: string[];
  autonomyLevel?: number;
  approvalThreshold?: number;
  /** CLI/model backend this worker executes on. Distinct from `model` (agentId). */
  modelBinding?: string | null;
  managerWorkerId?: string | null;
  employmentStatus?: string;
  currentStatus?: string;
  timezone?: string;
}

/**
 * The four autonomy levels, spelled out. A bare integer decides whether work
 * completes unattended and tells a reader nothing, so every surface that shows
 * autonomy renders this descriptor beside it.
 */
export const AUTONOMY_LEVELS: ReadonlyArray<{
  level: 0 | 1 | 2 | 3;
  label: string;
  short: string;
  detail: string;
  tone: "neutral" | "info" | "warning" | "danger";
}> = [
  {
    level: 0,
    label: "Advisory",
    short: "Never executes",
    detail: "Proposes only. Every action needs a human to carry it out.",
    tone: "neutral",
  },
  {
    level: 1,
    label: "Supervised",
    short: "Always lands in review",
    detail: "Executes, but every result stops in review before it counts as done.",
    tone: "info",
  },
  {
    level: 2,
    label: "Bounded",
    short: "Auto-completes under threshold",
    detail:
      "Completes work unattended while estimated cost stays under the approval threshold; anything above it escalates.",
    tone: "warning",
  },
  {
    level: 3,
    label: "Autonomous",
    short: "Auto-completes",
    detail: "Completes work unattended. Nothing is held for review by default.",
    tone: "danger",
  },
];

export function describeAutonomy(level: number | null | undefined) {
  if (typeof level !== "number" || !Number.isFinite(level)) return null;
  return AUTONOMY_LEVELS.find((entry) => entry.level === Math.trunc(level)) ?? null;
}

/** Chat channels an employee can be bound to. Mirrors `src/channels/registry.ts`. */
export const EMPLOYEE_CHANNEL_IDS = [
  "discord",
  "slack",
  "telegram",
  "whatsapp",
  "signal",
  "line",
  "imessage",
] as const;
export type EmployeeChannelId = (typeof EMPLOYEE_CHANNEL_IDS)[number];

/**
 * Routing-only binding between a worker and a chat channel. Never carries
 * credentials — those stay in the gateway channel configuration.
 */
export interface EmployeeChannelBinding {
  id: string;
  agencyId?: string;
  workerId: string;
  channelId: string;
  target: string | null;
  handle: string | null;
  direction: "inbound" | "outbound" | "both";
  enabled: boolean;
  config?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Structured communication profile. Typed loosely on purpose: the backend
 * surface is landing concurrently, so every field is optional and the panel
 * renders whatever arrives rather than assuming a shape.
 */
export interface EmployeeCommunicationProfile {
  version?: number;
  tone?: string;
  verbosity?: string;
  language?: string;
  emojiUse?: string;
  proactivity?: string;
  responseLatency?: {
    minSeconds?: number;
    targetSeconds?: number;
    maxSeconds?: number;
    batchWindowSeconds?: number;
    urgentBypass?: boolean;
    typingIndicator?: boolean;
  } | null;
  workingHours?: {
    respectSchedule?: boolean;
    outsideHours?: string;
    outsideHoursMessage?: string | null;
    fallbackTimezone?: string;
  } | null;
  escalation?: {
    escalateAfterMinutes?: number;
    escalationPhrase?: string;
    handoffPhrase?: string;
    notifyManager?: boolean;
  } | null;
  reportCadence?: string;
  reportTime?: string;
  greeting?: string | null;
  signOff?: string | null;
  signature?: string | null;
  humanising?: Record<string, boolean> | null;
  channelOverrides?: Array<Record<string, unknown>>;
  legacyCadence?: string | null;
  notes?: string;
  updatedAt?: number;
}

export const COMMUNICATION_TONES = [
  "formal",
  "professional",
  "friendly",
  "casual",
  "blunt",
] as const;
export const COMMUNICATION_VERBOSITY = ["terse", "concise", "balanced", "detailed"] as const;
export const PROACTIVITY_LEVELS = ["reactive", "responsive", "proactive", "driving"] as const;
export const EMOJI_USAGE = ["none", "sparing", "expressive"] as const;
export const OUTSIDE_HOURS_BEHAVIOURS = ["defer", "auto_reply", "respond"] as const;
export const REPORT_CADENCES = [
  "continuous",
  "hourly",
  "daily",
  "weekly",
  "biweekly",
  "monthly",
] as const;

/** One standard operating procedure, as returned by `agency.ops.sops.list`. */
export interface AgencySopSummary {
  id: string;
  slug: string;
  name: string;
  summary: string;
  ownerWorkerId: string | null;
  ownerRoleId?: string | null;
  category: string;
  status: string;
  version: number;
  stepCount?: number;
  steps?: unknown[];
  defaultPriority?: string;
  estimatedMinutes?: number;
  source?: string;
  tags?: string[];
}

export interface AgencySopSchedule {
  id: string;
  sopId: string;
  workerId: string;
  managerWorkerId: string | null;
  cadence: "daily" | "weekly" | "monthly";
  interval: number;
  weekday: number | null;
  monthDay: number | null;
  runAt: string;
  timezone: string;
  slaMinutes: number;
  priority: string;
  enabled: boolean;
  cronJobName: string;
  nextRunAt: number;
  lastRunAt: number | null;
}

export interface AgencySopRun {
  id: string;
  sopId: string;
  scheduleId: string | null;
  workerId: string;
  workItemId: string | null;
  trigger: string;
  sopVersion: number;
  status: "pending" | "materialised" | "failed" | "cancelled";
  note: string | null;
  scheduledFor: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgencyMember {
  agencyId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  createdAt: number;
  updatedAt: number;
}

export interface AgencyAuditEvent {
  id: string | number;
  actorId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: number;
}

export interface WorkforceAssignment {
  id: string;
  title: string;
  description: string;
  status: "planned" | "active" | "blocked" | "review" | "completed" | "cancelled";
  priority: number;
  dueAt: number | null;
  estimatedHours: number;
  requiredSkills: Array<{ skill: string; minimumLevel: number; weight?: number }>;
  requiredCapabilities: string[];
  members: Array<{ workerId: string; role: string; allocatedHours: number }>;
}

export interface EmployeeDetail {
  employee: {
    id: string;
    displayName: string;
    type: WorkerKind;
    title: string;
    timezone: string;
    employmentStatus: string;
    skills: Array<{ skill: string; level: number; yearsExperience: number }>;
    permissions: string[];
    capabilities: string[];
    goals: string[];
    kpis: string[];
    autonomyLevel: number;
    approvalThreshold: number;
    communicationCadence: string;
    sopPath: string | null;
    workspacePath: string | null;
    currentStatus: string;
    lastHeartbeatAt: number | null;
    /**
     * Fields the gateway already stores on the worker row. Optional so the
     * panel keeps rendering against a build whose payload predates them.
     */
    email?: string | null;
    departmentId?: string | null;
    employmentType?: string;
    weeklyCapacityHours?: number;
    availabilityPercent?: number;
    costRate?: number;
    currency?: string;
    agentId?: string | null;
    modelBinding?: string | null;
    persona?: string | null;
    managerWorkerId?: string | null;
    /** Structured profile; null on rows never edited since the feature landed. */
    communicationProfile?: EmployeeCommunicationProfile | null;
    /** Per-worker runtime knobs. Mirrors `src/workforce/execution-profile.ts`. */
    executionProfile?: {
      version?: number;
      fallbackModelBinding?: string | null;
      toolAllowlist?: string[];
      toolDenylist?: string[];
      timeoutMinutes?: number | null;
      maxConcurrent?: number | null;
      maxRetries?: number;
      notes?: string;
      updatedAt?: number;
    } | null;
    updatedAt?: number;
  };
  capacity: {
    effectiveCapacityHours: number;
    allocatedHours: number;
    remainingHours: number;
    utilizationPercent: number;
  } | null;
  assignments: WorkforceAssignment[];
  performance: {
    qualityScore: number | null;
    reliabilityScore: number | null;
    collaborationScore: number | null;
    outcomeAttainmentPercent: number | null;
    completedAssignments: number;
  } | null;
}

export interface HybridTeamPlanSummary {
  assignmentId: string;
  members: Array<{
    worker: { id: string; displayName: string; type: WorkerKind; costRate: number };
    allocatedHours: number;
    suitability: { score: number };
  }>;
  skillCoverage: number;
  estimatedCost: number;
  warnings: string[];
}

export type EmployeeWorkItemStatus =
  | "queued"
  | "accepted"
  | "in_progress"
  | "waiting"
  | "review"
  | "completed"
  | "cancelled"
  | "escalated";

export interface EmployeeWorkItem {
  id: string;
  workerId: string;
  managerWorkerId: string | null;
  title: string;
  instructions: string;
  status: EmployeeWorkItemStatus;
  priority: "low" | "normal" | "high" | "urgent";
  scheduledFor: number;
  dueAt: number | null;
  escalationLevel: number;
  waitingReason: string | null;
  updatedAt: number;
}

export interface EmployeeSchedule {
  id: string;
  workerId: string;
  timezone: string;
  weekdays: number[];
  shiftStart: string;
  shiftEnd: string;
  enabled: boolean;
}

export interface EmployeeResponsibility {
  id: string;
  workerId: string;
  managerWorkerId: string | null;
  title: string;
  cadence: "daily" | "weekly" | "monthly";
  runAt: string;
  slaMinutes: number;
  priority: "low" | "normal" | "high" | "urgent";
  enabled: boolean;
  nextRunAt: number;
}

export interface EmployeeReviewCycle {
  id: string;
  workerId: string;
  managerWorkerId: string;
  nextReviewAt: number;
  status: "scheduled" | "due" | "completed" | "overdue";
  agenda: string[];
}

export interface AgencyDatabaseHealth {
  ok: boolean;
  integrity: "ok" | "failed" | "unavailable";
  schema: {
    currentVersion: number;
    supportedVersion: number;
    migrationCount: number;
    upToDate: boolean;
    newerThanRuntime: boolean;
    lastMigratedAt: number | null;
  };
  backupCount: number;
  latestBackupAt: number | null;
  latestVerified: boolean;
  restorePending: boolean;
}

export interface AgencyDatabaseBackup {
  id: string;
  createdAt: number;
  sizeBytes: number;
  sha256: string;
  schemaVersion: number;
  verified: boolean;
}

export interface AgencyRestorePlan {
  restoreId: string;
  backupId: string;
  confirmation: string;
  expiresAt: number;
}

export interface AgencyFinanceSummary {
  currency: string;
  revenueMonth: number;
  cashCollectedMonth: number;
  mrr: number;
  arr: number;
  activeMrrClients: number;
  averageRevenuePerClient: number;
  revenueTarget: number;
  contractedBacklog: number;
  outstandingReceivables: number;
  overdueReceivables: number;
  grossMarginPercent: number;
  operatingExpensesMonth: number;
  aiSpendMonth: number;
  payrollMonth: number;
  cashRunwayMonths?: number;
}

export interface AgencyInvoice {
  id: string;
  clientId: string;
  clientName: string;
  number: string;
  status: "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "void";
  currency: string;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  issuedAt: number | null;
  dueAt: number | null;
  /** When the stored record last changed, so a cached PDF can be told it is stale. */
  updatedAt: number | null;
  lineItems: Array<{
    id: string;
    description: string;
    totalCents: number;
    cadence: "one_time" | "monthly" | "quarterly" | "annual";
  }>;
  projects: Array<{
    projectId: string;
    projectName: string;
    allocationCents: number;
  }>;
}

export interface AgencyProjectSummary {
  id: string;
  clientId: string | null;
  name: string;
  status: "planned" | "active" | "on_hold" | "completed" | "cancelled";
  budgetCents: number;
  /** Manually-set monthly recurring revenue for this project (integer cents). */
  mrrCents: number;
  targetEndAt: number | null;
}

export interface AgencyTaskSummary {
  id: string;
  projectId: string;
  title: string;
  status: "backlog" | "ready" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  assigneeType: "human" | "ai" | "hybrid" | null;
  assigneeId: string | null;
  dueAt: number | null;
}

export interface AgencyClient {
  id: string;
  name: string;
  /**
   * Derived three-value rollup. The owner's real pipeline has more states than
   * this, so prefer `pipelineStatusLabel` for display.
   */
  status: "prospect" | "active" | "inactive";
  /** Case-folded real pipeline state ("in progress"). Absent on older gateways. */
  pipelineStatus?: string;
  /** Display form of the real pipeline state ("In progress"). */
  pipelineStatusLabel?: string;
  /** Last write to the agency row; used to break name-match ties. */
  updatedAt?: number;
  billingEmail: string | null;
  notes: string | null;
  /** Legal / trading name of the business (nullable). Arrives from the store. */
  legalName?: string | null;
  /** Contact & social platform fields — all nullable, surfaced by the store. */
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  telegram?: string | null;
  discord?: string | null;
  instagram?: string | null;
  projectCount: number;
  invoiceCount: number;
  lifetimeInvoicedCents: number;
  outstandingCents: number;
  mrrCents: number;
}

export interface AgencyClientSyncStatus {
  connected: boolean;
  databaseName: string | null;
  lastSync: number | null;
  notionConfigured: boolean;
  schemaPropertyCount: number;
}

export interface AgencyReplicationStatus {
  agencyId: string;
  peerNodeId: string | null;
  state: "never_synced" | "in_sync" | "pending" | "offline" | "error";
  lastSyncAt: number | null;
  lastPushAt: number | null;
  lastPullAt: number | null;
  lastError: string | null;
  localDigest: string;
  remoteDigest: string | null;
  pending: boolean;
  conflicts: number;
}

export interface AgencyRevenueEntry {
  id: string;
  clientId: string;
  invoiceId: string | null;
  sourceType: "invoice_issued" | "payment_received" | "manual_adjustment";
  amountCents: number;
  currency: string;
  recurringMonthlyCents: number;
  description: string;
  recognizedAt: number;
}

export interface AgencyRevenueSummary {
  currency: string;
  periodStart: number;
  periodEnd: number;
  invoicedRevenueCents: number;
  collectedRevenueCents: number;
  mrrCents: number;
  arrCents: number;
  activeMrrClients: number;
  averageRevenuePerClientCents: number;
  revenueByClient: Array<{
    clientId: string;
    clientName: string;
    invoicedCents: number;
    collectedCents: number;
    mrrCents: number;
  }>;
  revenueByProject: Array<{
    projectId: string;
    projectName: string;
    invoicedCents: number;
    collectedCents: number;
  }>;
  trend: Array<{
    month: string;
    invoicedCents: number;
    collectedCents: number;
  }>;
}

export interface AgencyClientRevenueProfile {
  clientId: string;
  currency: string;
  mrrCents: number;
  arrCents: number;
  lastInvoiceId: string | null;
}

export interface LegacyMigrationReport {
  sourceExists: boolean;
  businessesFound: number;
  agenciesCreated: number;
  agenciesUpdated: number;
  clientsImported: number;
  projectsImported: number;
  tasksImported: number;
  projectsQuarantined: number;
  databaseRowsQuarantined: number;
  unassignedAgencyId: string | null;
  completedAt: number | null;
  warnings: string[];
}

/**
 * A namespaced memory entry belonging to one employee. This is the durable
 * "AI employees with their own memory" record: the gateway returns it verbatim
 * from `agency.ops.employee.memory.list`.
 */
export interface EmployeeMemoryEntry {
  id: string;
  agencyId: string;
  workerId: string;
  workItemId: string | null;
  namespace: string;
  key: string;
  value: unknown;
  source: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Raw conflict row from `agency.ops.replication.conflicts.list`. The gateway
 * returns the SQLite row unchanged, so the field names stay snake_case.
 */
export interface AgencyReplicationConflict {
  id: string;
  table_name: string;
  row_key: string;
  local_json: string;
  remote_json: string;
  local_version: number | null;
  remote_version: number | null;
  winner: "local" | "remote" | "deterministic";
  source_node_id: string;
  created_at: number;
  resolved_at: number | null;
}

export interface AgencyDatabaseSchemaStatus {
  currentVersion: number;
  supportedVersion: number;
  migrationCount: number;
  upToDate: boolean;
  newerThanRuntime: boolean;
  lastMigratedAt: number | null;
}

export interface AgencyBackupPruneResult {
  removedIds: string[];
  retained: number;
  policy: { maxCount: number; maxAgeDays: number };
}

export interface AgencySuitabilityResult {
  workerId: string;
  eligible: boolean;
  score: number;
  skillCoverage: number;
  availableHours: number;
  reasons: string[];
  missingSkills: string[];
  missingCapabilities: string[];
}

export type AgencyOpsDialog =
  | { kind: "deal"; name: string; clientName: string; value: string; stageId: string }
  | { kind: "engagement"; name: string; clientName: string; budget: string; dueDate: string }
  | {
      kind: "employee";
      name: string;
      workerKind: WorkerKind;
      role: string;
      department: string;
      capacityHours: string;
    }
  | { kind: "agency"; name: string }
  | { kind: "client"; name: string; billingEmail: string }
  | { kind: "project"; name: string; clientId: string; budget: string }
  | {
      kind: "task";
      title: string;
      projectId: string;
      description: string;
      assigneeType: "human" | "ai" | "hybrid";
      assigneeId: string;
    }
  | {
      kind: "assignment";
      title: string;
      description: string;
      estimatedHours: string;
      priority: string;
      memberId: string;
    }
  | { kind: "share"; email: string; role: "admin" | "member" | "viewer" }
  | {
      kind: "employee-schedule";
      workerId: string;
      timezone: string;
      weekdays: string;
      shiftStart: string;
      shiftEnd: string;
      effectiveFrom: string;
    }
  | {
      kind: "employee-responsibility";
      workerId: string;
      managerWorkerId: string;
      title: string;
      instructions: string;
      cadence: "daily" | "weekly" | "monthly";
      interval: string;
      weekday: string;
      monthDay: string;
      runAt: string;
      slaMinutes: string;
      priority: "low" | "normal" | "high" | "urgent";
    }
  | {
      kind: "employee-review";
      workerId: string;
      managerWorkerId: string;
      cadenceDays: string;
      nextReviewDate: string;
      agenda: string;
    }
  | {
      kind: "employee-work-item";
      workerId: string;
      managerWorkerId: string;
      title: string;
      instructions: string;
      priority: "low" | "normal" | "high" | "urgent";
      dueDate: string;
    }
  | {
      kind: "employee-edit";
      employeeId: string;
      name: string;
      role: string;
      department: string;
      capacityHours: string;
      availability: Availability;
    }
  | {
      kind: "client-edit";
      clientId: string;
      name: string;
      billingEmail: string;
      notes: string;
      status: AgencyClient["status"];
      email: string;
      phone: string;
      whatsapp: string;
      telegram: string;
      discord: string;
      instagram: string;
    }
  | {
      kind: "project-edit";
      projectId: string;
      name: string;
      status: AgencyProjectSummary["status"];
      /** Budget in whole currency units (dollars), string for the input. */
      budget: string;
      /** Target end date as an ISO yyyy-mm-dd string; empty clears it. */
      dueDate: string;
    }
  | {
      kind: "task-edit";
      taskId: string;
      title: string;
      status: AgencyTaskSummary["status"];
      priority: AgencyTaskSummary["priority"];
      /** Due date as an ISO yyyy-mm-dd string; empty clears it. */
      dueDate: string;
    }
  | {
      kind: "employee-memory";
      memoryId: string;
      workerId: string;
      namespace: string;
      key: string;
      value: string;
      expiresDate: string;
    }
  /**
   * The full worker editor. Every field is a string because the dialog is
   * driven by the shared `patchAgencyOpsDialog` string patcher; the submit
   * step parses and only sends the keys that actually changed, so a gateway
   * that rejects one field never silently drops the rest.
   */
  | {
      kind: "employee-profile";
      employeeId: string;
      tab: "identity" | "operating" | "communication" | "channels";
      name: string;
      role: string;
      department: string;
      managerWorkerId: string;
      capacityHours: string;
      availabilityPercent: string;
      availability: Availability;
      employmentStatus: string;
      timezone: string;
      persona: string;
      goals: string;
      kpis: string;
      skills: string;
      capabilities: string;
      autonomyLevel: string;
      approvalThreshold: string;
      modelBinding: string;
      fallbackModelBinding: string;
      maxConcurrent: string;
      timeoutMinutes: string;
      maxRetries: string;
      toolAllowlist: string;
      toolDenylist: string;
      execNotes: string;
      commTone: string;
      commVerbosity: string;
      commLanguage: string;
      commEmoji: string;
      commProactivity: string;
      commMinSeconds: string;
      commTargetSeconds: string;
      commBatchSeconds: string;
      commOutsideHours: string;
      commOutsideHoursMessage: string;
      commRespectSchedule: string;
      commReportCadence: string;
      commReportTime: string;
      commGreeting: string;
      commSignOff: string;
      commEscalateAfterMinutes: string;
      commEscalationPhrase: string;
      commHandoffPhrase: string;
      commNotifyManager: string;
      commNotes: string;
    }
  | {
      kind: "employee-channel";
      bindingId: string;
      workerId: string;
      channelId: string;
      target: string;
      handle: string;
      direction: "inbound" | "outbound" | "both";
      enabled: string;
    }
  | {
      kind: "employee-sop-attach";
      sopId: string;
      workerId: string;
      managerWorkerId: string;
      cadence: "daily" | "weekly" | "monthly";
      interval: string;
      weekday: string;
      monthDay: string;
      runAt: string;
      timezone: string;
      slaMinutes: string;
      priority: "low" | "normal" | "high" | "urgent";
    }
  | null;

/** Dialog kinds introduced for the mutation surface that had no UI affordance. */
export type ExtendedAgencyOpsDialogKind =
  | "employee-schedule"
  | "employee-responsibility"
  | "employee-review"
  | "employee-work-item"
  | "employee-edit"
  | "client-edit"
  | "project-edit"
  | "task-edit"
  | "employee-memory"
  | "employee-profile"
  | "employee-channel"
  | "employee-sop-attach";

export interface AgencyOperationsState {
  loadGeneration: number;
  loading: boolean;
  refreshing: boolean;
  saving: boolean;
  error: string | null;
  /**
   * Methods that failed during the last load. Every panel request is fault
   * isolated so one dead RPC cannot blank the page, but a failure must still
   * be visible — an empty table and a table we could not fetch look identical
   * otherwise.
   */
  failedRequests: string[];
  lastLoadedAt: number | null;
  agencies: AgencyWorkspace[];
  selectedAgencyId: string | null;
  kpis: AgencyKpi[];
  pipelineStages: PipelineStage[];
  pipelineDeals: PipelineDeal[];
  engagements: AgencyEngagement[];
  approvals: AgencyApproval[];
  employees: AgencyEmployee[];
  finance: AgencyFinanceSummary;
  invoices: AgencyInvoice[];
  clients: AgencyClient[];
  projects: AgencyProjectSummary[];
  tasks: AgencyTaskSummary[];
  // Raw kanban board projects/tasks — the SAME source the /projects (kanban)
  // page reads (kanban.projects.list / kanban.tasks.list). The Active Projects
  // panel derives its list + task cards from these using the identical
  // active-status predicate so the two views never drift. Stored raw, never
  // reconciled into `projects`.
  kanbanProjects: Array<{
    id: string;
    name: string;
    status?: string;
    archived?: boolean;
    businessId?: string;
  }>;
  kanbanTasks: Array<{
    id: string;
    projectId: string;
    title: string;
    status: string;
    done?: boolean;
    priority?: string;
  }>;
  revenue: AgencyRevenueSummary | null;
  revenueEntries: AgencyRevenueEntry[];
  clientRevenueProfiles: AgencyClientRevenueProfile[];
  invoiceDraftText: string;
  invoiceFile: { name: string; mediaType: string; base64: string } | null;
  invoiceParsedPreview: Record<string, unknown> | null;
  invoiceProjectId: string;
  invoiceClientId: string;
  invoiceImporting: boolean;
  clientSearch: string;
  /** Finance-section client directory layout: rich card grid or drag kanban. */
  financeClientView: "grid" | "kanban";
  /** Client currently being dragged across the finance kanban columns. */
  draggingClientId: string | null;
  /** Column name currently hovered during a client-kanban drag (for drop styling). */
  clientKanbanDragOverCol: string | null;
  /**
   * Full ordered pipeline-status columns for the client kanban, matching the
   * dedicated /clients page. Seeded from `agency.ops.clients.list`'s
   * `knownPipelineStatuses`, unioned with any live statuses in use.
   */
  knownPipelineStatuses: string[];
  clientPipelineStatusCounts: Array<{ status: string; label: string; count: number }>;
  /**
   * Full-screen client profile. When set, agency-operations renders the
   * dedicated profile surface for this client instead of the section grid.
   */
  clientProfileId: string | null;
  /** Notes related to the open client profile (existing notes system, tag-scoped). */
  clientProfileNotes: Array<{
    id: string;
    name: string;
    body: string;
    updatedAt: string | number;
    createdAt?: string | number;
  }>;
  clientProfileNotesLoading: boolean;
  clientProfileNoteDraft: string;
  clientProfileNoteBusy: boolean;
  /** Autonomous-agent trigger draft + busy flag for the client profile. */
  clientProfileAgentTask: string;
  clientProfileAgentBusy: boolean;
  clientProfileAgentNotice: string | null;
  /**
   * Full-screen dedicated project detail. When set, agency-operations renders
   * the in-depth {@link renderProjectDetailPage} surface for this project
   * instead of the section grid — the project analogue of `clientProfileId`.
   */
  detailProjectId: string | null;
  /** Which tab is open on the dedicated project detail page. */
  detailProjectTab: "overview" | "tasks" | "activity" | "notes";
  /** Notes related to the open project (existing notes system, tag-scoped). */
  detailProjectNotes: Array<{
    id: string;
    name: string;
    body: string;
    updatedAt: string | number;
    createdAt?: string | number;
  }>;
  detailProjectNotesLoading: boolean;
  detailProjectNoteDraft: string;
  detailProjectNoteBusy: boolean;
  /** Task ids expanded inline on the dedicated project detail page. */
  detailExpandedTaskIds: string[];
  /** Project currently dragged across the per-client profile kanban. */
  draggingProfileProjectId: string | null;
  profileKanbanDragOverCol: string | null;
  clientSyncStatus: AgencyClientSyncStatus | null;
  replicationStatus: AgencyReplicationStatus | null;
  clientSyncing: boolean;
  dialog: AgencyOpsDialog;
  approvalBusyId: string | null;
  employeeFilter: "all" | WorkerKind;
  lastShareLink: string | null;
  collaborationStatus: string | null;
  migrationReport: LegacyMigrationReport | null;
  activeSection: AgencyOperationsSection;
  selectedEmployeeId: string | null;
  employeeDetail: EmployeeDetail | null;
  members: AgencyMember[];
  auditEvents: AgencyAuditEvent[];
  assignments: WorkforceAssignment[];
  employeeWorkItems: EmployeeWorkItem[];
  employeeSchedules: EmployeeSchedule[];
  employeeResponsibilities: EmployeeResponsibility[];
  employeeReviewCycles: EmployeeReviewCycle[];
  employeeLoopLastRunAt: number | null;
  databaseHealth: AgencyDatabaseHealth | null;
  databaseBackups: AgencyDatabaseBackup[];
  pendingRestore: AgencyRestorePlan | null;
  restoreConfirmation: string;
  hybridPlan: HybridTeamPlanSummary | null;
  secondaryLoading: boolean;
  secondaryBusyId: string | null;
  deliveryView: "list" | "board";
  draggingTaskId: string | null;
  boardProjectFilter: string;
  /** Delivery-section client scope, set by clicking through from a client card. */
  deliveryClientFilter: string;
  /** Per-invoice payment amount drafts so partial payments are possible. */
  invoicePaymentAmounts: Record<string, string>;
  /** Per-review-cycle outcome drafts recorded when a manager closes a review. */
  reviewOutcomes: Record<string, string>;
  /** Namespaced memory for the employee currently open in the detail panel. */
  employeeMemory: EmployeeMemoryEntry[];
  employeeMemoryWorkerId: string | null;
  employeeMemoryLoading: boolean;
  /**
   * SOP catalogue for the agency plus the schedules and runs of whichever
   * employee is open. Kept as three lists rather than one nested blob so a
   * failure in any one of them is individually attributable in the banner.
   */
  sops: AgencySopSummary[];
  sopsLoaded: boolean;
  employeeSopSchedules: AgencySopSchedule[];
  employeeSopRuns: AgencySopRun[];
  employeeSopWorkerId: string | null;
  employeeSopLoading: boolean;
  /** Multi-platform chat bindings for the open employee. */
  employeeChannels: EmployeeChannelBinding[];
  employeeChannelsWorkerId: string | null;
  employeeChannelsLoading: boolean;
  /**
   * Set when the channel/communication RPCs are absent from this gateway, so
   * the panels can say "not available in this build" instead of "none".
   */
  employeeChannelsUnavailable: boolean;
  /** Which card is expanded in the roster, keyed by employee id. */
  expandedEmployeeIds: string[];
  /** Roster layout preference: dense list versus rich cards. */
  employeeLayout: "cards" | "list";
  /** Free-text roster search across name, role, department and model. */
  employeeSearch: string;
  /** Replication conflict drill-in, loaded on demand from the health banner. */
  replicationConflicts: AgencyReplicationConflict[];
  replicationConflictsOpen: boolean;
  replicationConflictsLoading: boolean;
  /** Result text of the last snapshot export/import, shown inline. */
  replicationSnapshotNotice: string | null;
  /** Detailed schema report, richer than the summary embedded in health. */
  schemaStatus: AgencyDatabaseSchemaStatus | null;
  /** Retention policy drafts for a manual backup prune. */
  backupRetentionCount: string;
  backupRetentionDays: string;
  backupPruneResult: AgencyBackupPruneResult | null;
  /** Dry-run legacy migration report, distinct from the last completed one. */
  migrationPreview: LegacyMigrationReport | null;
  /** Confirm-by-typing gate for the destructive full re-import. */
  migrationConfirmation: string;
  /** Per-candidate suitability for one assignment, from `.assignment.suitability`. */
  suitability: { assignmentId: string; results: AgencySuitabilityResult[] } | null;
  /**
   * Invoice authoring, backlogging and per-client revenue. Owned by
   * `controllers/agency-invoicing.ts` and lazily created by it, so the
   * composer's own churn stays out of this module.
   */
  invoicing?: import("./agency-invoicing").AgencyInvoicingState | null;
}

export interface AgencyOperationsHost {
  agencyOperationsState?: AgencyOperationsState | null;
  requestUpdate?: () => void;
}

const EMPTY_FINANCE: AgencyFinanceSummary = {
  currency: "USD",
  revenueMonth: 0,
  cashCollectedMonth: 0,
  mrr: 0,
  arr: 0,
  activeMrrClients: 0,
  averageRevenuePerClient: 0,
  revenueTarget: 0,
  contractedBacklog: 0,
  outstandingReceivables: 0,
  overdueReceivables: 0,
  grossMarginPercent: 0,
  operatingExpensesMonth: 0,
  aiSpendMonth: 0,
  payrollMonth: 0,
};

const SELECTED_AGENCY_KEY = "infinibot.agency-operations.selected-agency";

function loadSelectedAgencyId(): string | null {
  const globalAgencyId = getBizFilter();
  if (globalAgencyId) return globalAgencyId;
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(SELECTED_AGENCY_KEY);
  } catch {
    return null;
  }
}

function persistSelectedAgencyId(agencyId: string): void {
  // The existing global business filter already scopes Projects, Tasks,
  // Databases and CRM. Treat the selected agency as that same global
  // workspace boundary so every surface switches together.
  setBizFilter(agencyId);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SELECTED_AGENCY_KEY, agencyId);
  } catch {
    // Storage can be unavailable in private/embedded contexts; state still works.
  }
}

export function createAgencyOperationsState(): AgencyOperationsState {
  return {
    loadGeneration: 0,
    loading: false,
    refreshing: false,
    saving: false,
    error: null,
    failedRequests: [],
    lastLoadedAt: null,
    agencies: [],
    selectedAgencyId: loadSelectedAgencyId(),
    kpis: [],
    pipelineStages: [],
    pipelineDeals: [],
    engagements: [],
    approvals: [],
    employees: [],
    finance: { ...EMPTY_FINANCE },
    invoices: [],
    clients: [],
    projects: [],
    tasks: [],
    kanbanProjects: [],
    kanbanTasks: [],
    revenue: null,
    revenueEntries: [],
    clientRevenueProfiles: [],
    invoiceDraftText: "",
    invoiceFile: null,
    invoiceParsedPreview: null,
    invoiceProjectId: "",
    invoiceClientId: "",
    invoiceImporting: false,
    clientSearch: "",
    financeClientView: "grid",
    draggingClientId: null,
    clientKanbanDragOverCol: null,
    knownPipelineStatuses: [],
    clientPipelineStatusCounts: [],
    clientProfileId: null,
    clientProfileNotes: [],
    clientProfileNotesLoading: false,
    clientProfileNoteDraft: "",
    clientProfileNoteBusy: false,
    clientProfileAgentTask: "",
    clientProfileAgentBusy: false,
    clientProfileAgentNotice: null,
    detailProjectId: null,
    detailProjectTab: "overview",
    detailProjectNotes: [],
    detailProjectNotesLoading: false,
    detailProjectNoteDraft: "",
    detailProjectNoteBusy: false,
    detailExpandedTaskIds: [],
    draggingProfileProjectId: null,
    profileKanbanDragOverCol: null,
    clientSyncStatus: null,
    replicationStatus: null,
    clientSyncing: false,
    dialog: null,
    approvalBusyId: null,
    employeeFilter: "all",
    lastShareLink: null,
    collaborationStatus: null,
    migrationReport: null,
    activeSection: "overview",
    selectedEmployeeId: null,
    employeeDetail: null,
    members: [],
    auditEvents: [],
    assignments: [],
    employeeWorkItems: [],
    employeeSchedules: [],
    employeeResponsibilities: [],
    employeeReviewCycles: [],
    employeeLoopLastRunAt: null,
    databaseHealth: null,
    databaseBackups: [],
    pendingRestore: null,
    restoreConfirmation: "",
    hybridPlan: null,
    secondaryLoading: false,
    secondaryBusyId: null,
    deliveryView: "list",
    draggingTaskId: null,
    boardProjectFilter: "",
    deliveryClientFilter: "",
    invoicePaymentAmounts: {},
    reviewOutcomes: {},
    employeeMemory: [],
    employeeMemoryWorkerId: null,
    employeeMemoryLoading: false,
    sops: [],
    sopsLoaded: false,
    employeeSopSchedules: [],
    employeeSopRuns: [],
    employeeSopWorkerId: null,
    employeeSopLoading: false,
    employeeChannels: [],
    employeeChannelsWorkerId: null,
    employeeChannelsLoading: false,
    employeeChannelsUnavailable: false,
    expandedEmployeeIds: [],
    employeeLayout: "cards",
    employeeSearch: "",
    replicationConflicts: [],
    replicationConflictsOpen: false,
    replicationConflictsLoading: false,
    replicationSnapshotNotice: null,
    schemaStatus: null,
    backupRetentionCount: "14",
    backupRetentionDays: "30",
    backupPruneResult: null,
    migrationPreview: null,
    migrationConfirmation: "",
    suitability: null,
    invoicing: null,
  };
}

export function ensureAgencyOperationsState(host: AgencyOperationsHost): AgencyOperationsState {
  if (!host.agencyOperationsState) {
    host.agencyOperationsState = createAgencyOperationsState();
  }
  return host.agencyOperationsState;
}

function notify(host: AgencyOperationsHost): void {
  host.requestUpdate?.();
}

export function setAgencyClientKanbanDragOverCol(
  host: AgencyOperationsHost,
  colKey: string | null,
): void {
  const state = ensureAgencyOperationsState(host);
  if (state.clientKanbanDragOverCol === colKey) return;
  state.clientKanbanDragOverCol = colKey;
  notify(host);
}

export function setAgencyProfileKanbanDragOverCol(
  host: AgencyOperationsHost,
  colKey: string | null,
): void {
  const state = ensureAgencyOperationsState(host);
  if (state.profileKanbanDragOverCol === colKey) return;
  state.profileKanbanDragOverCol = colKey;
  notify(host);
}

export function setAgencyDraggingProfileProject(
  host: AgencyOperationsHost,
  projectId: string | null,
): void {
  ensureAgencyOperationsState(host).draggingProfileProjectId = projectId;
  notify(host);
}

export function setAgencyClientNoteDraft(host: AgencyOperationsHost, value: string): void {
  ensureAgencyOperationsState(host).clientProfileNoteDraft = value;
  notify(host);
}

export function setAgencyClientAgentTask(host: AgencyOperationsHost, value: string): void {
  ensureAgencyOperationsState(host).clientProfileAgentTask = value;
  notify(host);
}

export function setAgencyInvoiceText(host: AgencyOperationsHost, value: string): void {
  const state = ensureAgencyOperationsState(host);
  state.invoiceDraftText = value;
  state.invoiceParsedPreview = null;
  notify(host);
}

export function setAgencyInvoiceProject(host: AgencyOperationsHost, projectId: string): void {
  const state = ensureAgencyOperationsState(host);
  state.invoiceProjectId = projectId;
  notify(host);
}

export function setAgencyInvoiceClient(host: AgencyOperationsHost, clientId: string): void {
  ensureAgencyOperationsState(host).invoiceClientId = clientId;
  notify(host);
}

export function setAgencyFinanceClientView(
  host: AgencyOperationsHost,
  view: "grid" | "kanban",
): void {
  ensureAgencyOperationsState(host).financeClientView = view;
  notify(host);
}

export function setAgencyDraggingClient(host: AgencyOperationsHost, clientId: string | null): void {
  ensureAgencyOperationsState(host).draggingClientId = clientId;
  notify(host);
}

export function setAgencyClientSearch(host: AgencyOperationsHost, search: string): void {
  ensureAgencyOperationsState(host).clientSearch = search;
  notify(host);
}

export async function syncAgencyClients(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.clientSyncing) return;
  state.clientSyncing = true;
  state.error = null;
  notify(host);
  try {
    await client.request("agency.ops.replication.sync", { agencyId });
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    state.error = message(error);
  } finally {
    state.clientSyncing = false;
    notify(host);
  }
}

export async function updateAgencyClientStatus(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  clientId: string,
  status: AgencyClient["status"],
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (!state.selectedAgencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = clientId;
  notify(host);
  try {
    await client.request("agency.ops.clients.update", {
      agencyId: state.selectedAgencyId,
      clientId,
      status,
    });
    const existing = state.clients.find((item) => item.id === clientId);
    if (existing) existing.status = status;
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/**
 * Ordered pipeline-status columns for the client kanban. Mirrors the /clients
 * page: the known pipeline vocabulary in canonical order, unioned with any live
 * statuses currently in use (so a bespoke status the owner set still gets a
 * column). Falls back to the built-in known list before the first load.
 */
export function clientKanbanColumns(state: AgencyOperationsState): string[] {
  const known = state.knownPipelineStatuses.length
    ? [...state.knownPipelineStatuses]
    : [
        "Cold",
        "Lead",
        "In progress",
        "Updating",
        "Won",
        "Active",
        "Completed",
        "Archived",
        "Lost",
        "Cancelled",
        "Inactive",
      ];
  const seen = new Set(known.map((label) => label.toLowerCase()));
  // Union in any live status label that isn't in the known set.
  for (const client of state.clients) {
    const label = client.pipelineStatusLabel ?? client.pipelineStatus;
    if (label && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      known.push(label);
    }
  }
  return known;
}

/** Group agency clients by their real pipeline-status label (for the kanban). */
export function clientsByPipelineStatus(
  state: AgencyOperationsState,
  clients: AgencyClient[],
): Map<string, AgencyClient[]> {
  const byCol = new Map<string, AgencyClient[]>();
  for (const label of clientKanbanColumns(state)) byCol.set(label.toLowerCase(), []);
  for (const client of clients) {
    const label = (client.pipelineStatusLabel ?? client.pipelineStatus ?? "Cold").trim();
    const key = label.toLowerCase();
    if (!byCol.has(key)) byCol.set(key, []);
    byCol.get(key)!.push(client);
  }
  return byCol;
}

/**
 * Persist a client's real pipeline status (the kanban column) through the same
 * `agency.ops.clients.update` RPC used everywhere else. The legacy three-value
 * rollup is derived server-side, so we only send `pipelineStatus`.
 */
export async function updateAgencyClientPipelineStatus(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  clientId: string,
  pipelineStatus: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (!state.selectedAgencyId || state.secondaryBusyId) return;
  const existing = state.clients.find((item) => item.id === clientId);
  if (!existing) return;
  const previous = { status: existing.status, label: existing.pipelineStatusLabel, raw: existing.pipelineStatus };
  state.secondaryBusyId = clientId;
  // Optimistic: move the card immediately.
  existing.pipelineStatus = pipelineStatus.toLowerCase();
  existing.pipelineStatusLabel = pipelineStatus;
  notify(host);
  try {
    const res = (await client.request("agency.ops.clients.update", {
      agencyId: state.selectedAgencyId,
      clientId,
      pipelineStatus,
    })) as { client?: AgencyClient } | undefined;
    if (res?.client) {
      // Adopt the server's canonical form (derived rollup + normalized label).
      existing.status = res.client.status ?? existing.status;
      existing.pipelineStatus = res.client.pipelineStatus ?? existing.pipelineStatus;
      existing.pipelineStatusLabel = res.client.pipelineStatusLabel ?? existing.pipelineStatusLabel;
    }
  } catch (error) {
    // Roll back the optimistic move.
    existing.status = previous.status;
    existing.pipelineStatusLabel = previous.label;
    existing.pipelineStatus = previous.raw;
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function transitionAgencyProject(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  projectId: string,
  status: AgencyProjectSummary["status"],
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (!state.selectedAgencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = projectId;
  notify(host);
  try {
    await client.request("agency.ops.projects.transition", {
      agencyId: state.selectedAgencyId,
      projectId,
      status,
    });
    const project = state.projects.find((item) => item.id === projectId);
    if (project) project.status = status;
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function transitionAgencyTask(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  taskId: string,
  status: AgencyTaskSummary["status"],
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (!state.selectedAgencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = taskId;
  notify(host);
  try {
    await client.request("agency.ops.tasks.transition", {
      agencyId: state.selectedAgencyId,
      taskId,
      status,
    });
    const task = state.tasks.find((item) => item.id === taskId);
    if (task) task.status = status;
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

// ── Kanban-backed status controls (single source of truth) ────────────────
// The Active Projects panel renders kanban projects/tasks (state.kanbanProjects /
// state.kanbanTasks) — the SAME data the /projects page reads. That kanban store
// (Notion-backed if enabled, else local SQLite) is the single source of truth, so
// status changes here write straight through the kanban RPCs the /projects page
// uses. Those RPCs persist AND emit the `kanban:changed` broadcast, so every live
// surface reconciles instead of drifting on optimistic-only state.

/** Canonical kanban PROJECT status names (Notion vocabulary, mirrors /projects). */
export const KANBAN_PROJECT_STATUS_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["Not started", "Not started"],
  ["In progress", "In progress"],
  ["Reviewing", "Reviewing"],
  ["Awaiting Client", "Awaiting client"],
  ["Completed", "Completed"],
] as const;

/** Canonical kanban TASK status names (mirrors the /projects task board). */
export const KANBAN_TASK_STATUS_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["backlog", "Backlog"],
  ["todo", "To do"],
  ["in_progress", "In progress"],
  ["review", "In review"],
  ["done", "Done"],
] as const;

/**
 * Move a KANBAN project to a new status from the Agency Operations surface.
 * Writes through `kanban.projects.update` — the exact RPC the /projects page uses.
 * It persists to the source of truth and broadcasts `kanban:changed`. Critically it
 * updates ONLY the project row (no cascade), so child task statuses are preserved.
 */
export async function transitionKanbanProject(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  projectId: string,
  status: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (state.secondaryBusyId) return;
  state.secondaryBusyId = projectId;
  notify(host);
  try {
    await client.request("kanban.projects.update", { id: projectId, patch: { status } });
    const project = state.kanbanProjects.find((item) => item.id === projectId);
    if (project) project.status = status;
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/**
 * Move a KANBAN task to a new status (including a manual "mark complete").
 * Writes through `kanban.tasks.update` — the canonical done-flip chokepoint. When
 * status === "done" that RPC fires `broadcastTaskCompleted`, the SAME terminal write
 * `verifyAndFinalizeKanban` performs on a passing verdict, so completing a task here
 * does not bypass the completion path. Persists + broadcasts `kanban:changed`.
 */
export async function transitionKanbanTask(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  taskId: string,
  status: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (state.secondaryBusyId) return;
  state.secondaryBusyId = taskId;
  notify(host);
  try {
    const patch: { status: string; done?: boolean } = { status };
    if (status === "done") patch.done = true;
    else patch.done = false;
    const undoPending = beginPendingTaskWrite(taskId, patch);
    try {
      await client.request("kanban.tasks.update", { id: taskId, patch });
    } catch (err) {
      undoPending();
      throw err;
    }
    const task = state.kanbanTasks.find((item) => item.id === taskId);
    if (task) {
      task.status = status;
      task.done = status === "done";
    }
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export function setAgencyDeliveryView(host: AgencyOperationsHost, view: "list" | "board"): void {
  ensureAgencyOperationsState(host).deliveryView = view;
  notify(host);
}

export function setAgencyBoardProjectFilter(host: AgencyOperationsHost, projectId: string): void {
  ensureAgencyOperationsState(host).boardProjectFilter = projectId;
  notify(host);
}

export function setAgencyDraggingTask(host: AgencyOperationsHost, taskId: string | null): void {
  ensureAgencyOperationsState(host).draggingTaskId = taskId;
  notify(host);
}

export async function assignAgencyTask(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  taskId: string,
  assignee: { id: string; kind: WorkerKind } | null,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (!state.selectedAgencyId) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const previous = { assigneeId: task.assigneeId, assigneeType: task.assigneeType };
  task.assigneeId = assignee?.id ?? null;
  task.assigneeType = assignee?.kind ?? null;
  state.draggingTaskId = null;
  notify(host);
  try {
    await client.request("agency.ops.tasks.assign", {
      agencyId: state.selectedAgencyId,
      taskId,
      assigneeId: assignee?.id,
      assigneeType: assignee?.kind,
    });
  } catch (error) {
    task.assigneeId = previous.assigneeId;
    task.assigneeType = previous.assigneeType;
    state.error = message(error);
    notify(host);
  }
}

export async function stageAgencyInvoiceFile(
  host: AgencyOperationsHost,
  file: File,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  state.error = null;
  state.invoiceParsedPreview = null;
  state.invoiceProjectId = "";
  state.invoiceClientId = "";
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("Invoice file exceeds the 10 MB limit.");
    if (file.type === "application/pdf") {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("Could not read invoice file."));
        reader.readAsDataURL(file);
      });
      state.invoiceFile = {
        name: file.name,
        mediaType: file.type,
        base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      };
      state.invoiceDraftText = "";
    } else {
      state.invoiceDraftText = await file.text();
      state.invoiceFile = null;
    }
  } catch (error) {
    state.error = message(error);
  }
  notify(host);
}

export function clearAgencyInvoiceDraft(host: AgencyOperationsHost): void {
  const state = ensureAgencyOperationsState(host);
  state.invoiceDraftText = "";
  state.invoiceFile = null;
  state.invoiceParsedPreview = null;
  notify(host);
}

export async function ingestAgencyInvoice(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  confirmWarnings = false,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (!state.selectedAgencyId || state.invoiceImporting) return;
  state.invoiceImporting = true;
  state.error = null;
  notify(host);
  try {
    const payload = {
      agencyId: state.selectedAgencyId,
      sourceText: state.invoiceDraftText || undefined,
      sourceName: state.invoiceFile?.name ?? "pasted-invoice",
      sourceBase64: state.invoiceFile?.base64,
      mediaType: state.invoiceFile?.mediaType,
      confirmWarnings,
      projectId: state.invoiceProjectId || undefined,
      clientId: state.invoiceClientId || undefined,
    };
    const response = (await client.request("agency.ops.invoices.ingest", payload)) as {
      requiresConfirmation?: boolean;
      parsed?: Record<string, unknown>;
      result?: { duplicate?: boolean };
    };
    if (response.requiresConfirmation) {
      state.invoiceParsedPreview = response.parsed ?? null;
    } else {
      clearAgencyInvoiceDraft(host);
      await loadAgencyOperations(host, client, { background: true });
    }
  } catch (error) {
    state.error = message(error);
  } finally {
    state.invoiceImporting = false;
    notify(host);
  }
}

/**
 * Records a payment of an arbitrary amount on an arbitrary date.
 *
 * `amountCents` is an integer — the caller parses the operator's text once and
 * this only divides by 100 on the wire, because the gateway reads a major-unit
 * `amount` and multiplies it back. `paidAt` is freely settable in the past so
 * historical payments land in the month they actually happened rather than
 * today; omitting it means "now".
 */
export async function recordAgencyInvoicePayment(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  invoiceId: string,
  amountCents: number,
  paidAt?: number,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (!state.selectedAgencyId || state.secondaryBusyId) return;
  const method = "agency.ops.invoices.payment.record";
  state.secondaryBusyId = invoiceId;
  state.error = null;
  notify(host);
  try {
    await client.request(method, {
      agencyId: state.selectedAgencyId,
      invoiceId,
      // `amountCents` is the exact parameter; `amount` is sent alongside it
      // only so a gateway older than that parameter still records something
      // rather than nothing. Newer builds ignore the dollars value.
      amountCents,
      amount: amountCents / 100,
      paidAt: paidAt ?? Date.now(),
      method: "manual",
    });
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    recordMutationFailure(state, method, error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mutations are as fault isolated as panel loads: a rejected write must never
 * look like "nothing happened". Surface it both as the inline error and in the
 * persistent failed-request banner, which is the only place an operator can see
 * that a method (for example an RPC this build's gateway does not expose yet)
 * is unavailable rather than merely empty.
 */
function recordMutationFailure(
  state: AgencyOperationsState,
  method: string,
  error: unknown,
): void {
  const entry = `${method} — ${message(error)}`;
  state.error = message(error);
  if (!state.failedRequests.includes(entry)) state.failedRequests = [...state.failedRequests, entry];
}

/**
 * Records a failed *panel* fetch without raising the page-level red error.
 *
 * A read that a given gateway build simply does not implement is not an error
 * the operator caused, and shouting about it above the whole page trains people
 * to ignore the banner. It still has to be visible — so it lands in the
 * persistent failed-request list, which is what distinguishes "this panel is
 * broken" from "this panel is empty".
 */
function recordPanelFailure(state: AgencyOperationsState, method: string, error: unknown): void {
  const entry = `${method} — ${message(error)}`;
  if (!state.failedRequests.includes(entry)) state.failedRequests = [...state.failedRequests, entry];
}

function unwrap<T>(value: unknown, key: string, fallback: T): T {
  if (value && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key] as T;
  }
  return (value as T) ?? fallback;
}

/**
 * Issues one panel request, keeping a failure from rejecting the whole batch
 * while still recording it so the view can say the panel is broken rather than
 * silently showing nothing.
 */
function attempt(
  client: GatewayBrowserClient,
  failures: string[],
  method: string,
  params: unknown,
): Promise<unknown> {
  return client.request(method, params).catch((error) => {
    failures.push(`${method} — ${message(error)}`);
    return null;
  });
}

/**
 * Loads all operating panels concurrently. A partial endpoint failure does not
 * discard the last good snapshot: Promise.all rejects and the existing state
 * remains visible with a refresh error.
 */
export async function loadAgencyOperations(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  options: { background?: boolean } = {},
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const generation = ++state.loadGeneration;
  const background = options.background === true || state.lastLoadedAt !== null;
  state.loading = !background;
  state.refreshing = background;
  state.error = null;
  notify(host);

  try {
    // Tailscale collaboration links land on /agency/join?token=... . The
    // verified gateway identity is the principal; the browser only forwards
    // the one-time token and then removes it from history.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      const invitationToken = url.searchParams.get("token");
      if (invitationToken) {
        await client.request("agency.ops.agency.invite.accept", { token: invitationToken });
        url.searchParams.delete("token");
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      }
    }
    const agenciesResult = await client.request("agency.ops.agencies.list", {});
    if (generation !== state.loadGeneration) return;
    state.agencies = unwrap(agenciesResult, "agencies", []);
    state.migrationReport =
      agenciesResult && typeof agenciesResult === "object" && "migration" in agenciesResult
        ? ((agenciesResult as { migration?: LegacyMigrationReport }).migration ?? null)
        : null;
    const selectedStillExists = state.agencies.some(
      (agency) => agency.id === state.selectedAgencyId,
    );
    if (!selectedStillExists) {
      state.selectedAgencyId =
        state.agencies.find((agency) => agency.role === "owner")?.id ??
        state.agencies[0]?.id ??
        null;
      if (state.selectedAgencyId) persistSelectedAgencyId(state.selectedAgencyId);
    }
    const agencyId = state.selectedAgencyId;
    if (!agencyId) {
      state.kpis = [];
      state.pipelineStages = [];
      state.pipelineDeals = [];
      state.engagements = [];
      state.approvals = [];
      state.employees = [];
      state.members = [];
      state.auditEvents = [];
      state.assignments = [];
      state.employeeWorkItems = [];
      state.employeeSchedules = [];
      state.employeeResponsibilities = [];
      state.employeeReviewCycles = [];
      state.sops = [];
      state.sopsLoaded = false;
      state.employeeSopSchedules = [];
      state.employeeSopRuns = [];
      state.employeeChannels = [];
      state.databaseHealth = null;
      state.databaseBackups = [];
      state.finance = { ...EMPTY_FINANCE };
      state.invoices = [];
      state.clients = [];
      state.projects = [];
      state.tasks = [];
      state.revenue = null;
      state.revenueEntries = [];
      state.clientRevenueProfiles = [];
      state.clientSyncStatus = null;
      state.replicationStatus = null;
      state.lastLoadedAt = Date.now();
      return;
    }
    const failures: string[] = [];
    const [
      dashboardResult,
      pipelineResult,
      engagementsResult,
      approvalsResult,
      employeesResult,
      financeResult,
      invoicesResult,
      revenueResult,
      clientsResult,
      projectsResult,
      tasksResult,
      clientSyncStatusResult,
      replicationStatusResult,
      membersResult,
      auditResult,
      assignmentsResult,
      workItemsResult,
      schedulesResult,
      responsibilitiesResult,
      reviewsResult,
      sopsResult,
      databaseHealthResult,
      databaseBackupsResult,
      kanbanProjectsResult,
      kanbanTasksResult,
    ] = await Promise.all([
      attempt(client, failures, "agency.ops.dashboard", { agencyId }),
      attempt(client, failures, "agency.ops.pipeline.list", { agencyId }),
      attempt(client, failures, "agency.ops.engagements.list", { agencyId, status: "active" }),
      attempt(client, failures, "agency.ops.approvals.list", { agencyId, status: "pending" }),
      attempt(client, failures, "agency.ops.employees.list", { agencyId, status: "active" }),
      attempt(client, failures, "agency.ops.finance.summary", { agencyId, period: "month" }),
      attempt(client, failures, "agency.ops.invoices.list", { agencyId }),
      attempt(client, failures, "agency.ops.revenue.summary", { agencyId }),
      attempt(client, failures, "agency.ops.clients.list", { agencyId }),
      attempt(client, failures, "agency.ops.projects.list", { agencyId }),
      attempt(client, failures, "agency.ops.tasks.list", { agencyId }),
      attempt(client, failures, "agency.ops.clients.source.status", { agencyId }),
      Promise.resolve(null),
      attempt(client, failures, "agency.ops.members.list", { agencyId }),
      attempt(client, failures, "agency.ops.audit.list", { agencyId, limit: 100 }),
      attempt(client, failures, "agency.ops.assignments.list", { agencyId }),
      attempt(client, failures, "agency.ops.employee.inbox.list", { agencyId, limit: 250 }),
      attempt(client, failures, "agency.ops.employee.schedules.list", { agencyId }),
      attempt(client, failures, "agency.ops.employee.responsibilities.list", { agencyId }),
      attempt(client, failures, "agency.ops.employee.reviews.list", { agencyId }),
      attempt(client, failures, "agency.ops.sops.list", { agencyId }),
      ["owner", "admin"].includes(
        state.agencies.find((agency) => agency.id === agencyId)?.role ?? "",
      )
        ? Promise.resolve(null)
        : Promise.resolve(null),
      ["owner", "admin"].includes(
        state.agencies.find((agency) => agency.id === agencyId)?.role ?? "",
      )
        ? Promise.resolve(null)
        : Promise.resolve(null),
      // The kanban board is where the real in-progress work lives — a separate
      // store from the agency project register. Pulled so the Active Projects
      // panel can mirror it (see reconcile below). Never agency-scoped.
      attempt(client, failures, "kanban.projects.list", {}),
      // Kanban tasks — the SAME source the /projects page reads. The Active
      // Projects panel renders in-progress/uncompleted task cards from these so
      // project + task state never drifts from the kanban board. Never scoped.
      attempt(client, failures, "kanban.tasks.list", {}),
    ]);

    // Agency switches and reconnect refreshes can overlap. Never let a slow
    // response for the previously selected workspace overwrite the current
    // agency with empty arrays.
    if (generation !== state.loadGeneration || agencyId !== state.selectedAgencyId) return;

    const dashboard = unwrap<{ kpis?: AgencyKpi[] }>(dashboardResult, "dashboard", {});
    const pipeline = unwrap<{ stages?: PipelineStage[]; deals?: PipelineDeal[] }>(
      pipelineResult,
      "pipeline",
      {},
    );

    state.kpis = dashboardResult ? (dashboard.kpis ?? state.kpis) : state.kpis;
    state.pipelineStages = pipelineResult ? (pipeline.stages ?? state.pipelineStages) : state.pipelineStages;
    state.pipelineDeals = pipelineResult ? (pipeline.deals ?? state.pipelineDeals) : state.pipelineDeals;
    state.engagements = unwrap(engagementsResult, "engagements", state.engagements);
    state.approvals = unwrap(approvalsResult, "approvals", state.approvals);
    state.employees = unwrap(employeesResult, "employees", state.employees);
    state.finance = unwrap(financeResult, "finance", state.finance);
    state.invoices = unwrap(invoicesResult, "invoices", state.invoices);
    state.clients = unwrap(clientsResult, "clients", state.clients);
    // Capture the real pipeline-status vocabulary so the client kanban renders
    // the same columns as the dedicated /clients page (Cold, Lead, In progress,
    // …), not the three-value legacy rollup. Both `knownPipelineStatuses` and
    // the live `pipelineStatuses` distribution ship on the clients.list result.
    if (clientsResult && typeof clientsResult === "object") {
      const cr = clientsResult as {
        knownPipelineStatuses?: string[];
        pipelineStatuses?: Array<{ status: string; label: string; count: number }>;
      };
      if (Array.isArray(cr.knownPipelineStatuses)) {
        state.knownPipelineStatuses = cr.knownPipelineStatuses;
      }
      if (Array.isArray(cr.pipelineStatuses)) {
        state.clientPipelineStatusCounts = cr.pipelineStatuses;
      }
    }
    state.projects = unwrap(projectsResult, "projects", state.projects);
    state.tasks = unwrap(tasksResult, "tasks", state.tasks);

    // ── Mirror kanban in-progress projects into the agency register ──────────
    // The agency `projects` store only holds projects an operator manually
    // created and transitioned to "active". Real work is tracked on the kanban
    // board — a separate store — so the "Active Projects" panel would otherwise
    // ignore everything actually in flight. We reconcile client-side (no gateway
    // restart, mirroring the drift-radar pattern): every kanban project whose
    // status reads as in-progress is surfaced as an `active` agency project.
    if (kanbanProjectsResult) {
      const IN_PROGRESS = new Set([
        "in progress",
        "in_progress",
        "updating",
        "reviewing",
        "active",
      ]);
      const nameKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
      const kanbanProjects = unwrap<
        Array<{ id?: string; name?: string; status?: string; archived?: boolean }>
      >(kanbanProjectsResult, "projects", []);
      // Store the raw kanban projects so the Active Projects panel can derive
      // its list from the IDENTICAL source /projects reads, using the exact
      // same active-status predicate (no drift, no duplicate fetch).
      state.kanbanProjects = kanbanProjects
        .filter((kp) => kp?.id)
        .map((kp) => ({
          id: String(kp.id),
          name: kp.name ?? String(kp.id),
          status: kp.status,
          archived: kp.archived,
          businessId: (kp as { businessId?: string }).businessId,
        }));
      const byId = new Map(state.projects.map((project) => [project.id, project] as const));
      const byName = new Map(
        state.projects.map((project) => [nameKey(project.name), project] as const),
      );
      const mirrored: AgencyProjectSummary[] = [];
      for (const kp of kanbanProjects) {
        if (!kp?.id || kp.archived) continue;
        if (!IN_PROGRESS.has(nameKey(String(kp.status ?? "")))) continue;
        const existing =
          byId.get(kp.id) ?? (kp.name ? byName.get(nameKey(kp.name)) : undefined);
        if (existing) {
          // A matching agency project exists — reflect kanban reality: an
          // in-progress project reads as active in this view.
          existing.status = "active";
          continue;
        }
        // Kanban-only project (no agency counterpart). Surface it so nothing in
        // flight silently disappears; unattributed → "Internal / Unassigned".
        mirrored.push({
          id: kp.id,
          clientId: null,
          name: kp.name ?? kp.id,
          status: "active",
          budgetCents: 0,
          mrrCents: 0,
          targetEndAt: null,
        });
      }
      if (mirrored.length) state.projects = [...state.projects, ...mirrored];
    }
    // Store the raw kanban tasks (same source /projects reads) so the Active
    // Projects panel can render in-progress/uncompleted task cards keyed by the
    // kanban project id — matching the board exactly.
    if (kanbanTasksResult) {
      const kanbanTasks = unwrap<
        Array<{
          id?: string;
          projectId?: string;
          title?: string;
          status?: string;
          done?: boolean;
          priority?: string;
        }>
      >(kanbanTasksResult, "tasks", []);
      state.kanbanTasks = kanbanTasks
        .filter((kt) => kt?.id && kt?.projectId)
        .map((kt) => ({
          id: String(kt.id),
          projectId: String(kt.projectId),
          title: kt.title ?? "Untitled task",
          status: String(kt.status ?? ""),
          done: kt.done,
          priority: kt.priority,
        }));
      // A status move still in flight / not yet agreed by the server stays.
      state.kanbanTasks = applyPendingTaskWrites(state.kanbanTasks as never[]) as typeof state.kanbanTasks;
    }
    if (clientSyncStatusResult) {
      state.clientSyncStatus = clientSyncStatusResult as AgencyClientSyncStatus;
    }
    if (replicationStatusResult) {
      state.replicationStatus = unwrap(
        replicationStatusResult,
        "status",
        state.replicationStatus,
      );
    }
    state.revenue = unwrap(revenueResult, "revenue", state.revenue);
    state.revenueEntries = unwrap(revenueResult, "entries", state.revenueEntries);
    state.clientRevenueProfiles = unwrap(revenueResult, "clientProfiles", state.clientRevenueProfiles);
    state.members = unwrap(membersResult, "members", state.members);
    state.auditEvents = unwrap(auditResult, "events", state.auditEvents);
    state.assignments = unwrap(assignmentsResult, "assignments", state.assignments);
    state.employeeWorkItems = unwrap(workItemsResult, "workItems", state.employeeWorkItems);
    state.employeeSchedules = unwrap(schedulesResult, "schedules", state.employeeSchedules);
    state.employeeResponsibilities = unwrap(responsibilitiesResult, "responsibilities", state.employeeResponsibilities);
    state.employeeReviewCycles = unwrap(reviewsResult, "reviewCycles", state.employeeReviewCycles);
    state.sops = unwrap<AgencySopSummary[]>(sopsResult, "sops", state.sops);
    // `sopsLoaded` gates the per-employee lazy fetch. Only a request that
    // actually returned counts, so a failed catalogue retries rather than
    // presenting an empty attach picker as if the agency had no SOPs.
    state.sopsLoaded = sopsResult !== null;
    state.databaseHealth = databaseHealthResult as AgencyDatabaseHealth | null;
    state.databaseBackups = unwrap(databaseBackupsResult, "backups", state.databaseBackups);
    state.failedRequests = failures;
    state.lastLoadedAt = Date.now();

    // Health/backup inspection can take seconds on a large database. Load it
    // after actionable operating data is already painted instead of holding
    // clients, projects, tasks and revenue behind diagnostics.
    notify(host);
    const canManageDatabase = ["owner", "admin"].includes(
      state.agencies.find((agency) => agency.id === agencyId)?.role ?? "",
    );
    void Promise.all([
      client.request("agency.ops.replication.status", { agencyId }).catch(() => null),
      canManageDatabase
        ? client.request("agency.ops.database.health", { agencyId }).catch(() => null)
        : Promise.resolve(null),
      canManageDatabase
        ? client.request("agency.ops.database.backups.list", { agencyId }).catch(() => null)
        : Promise.resolve(null),
    ]).then(([syncResult, healthResult, backupsResult]) => {
      if (generation !== state.loadGeneration || agencyId !== state.selectedAgencyId) return;
      if (syncResult) {
        state.replicationStatus = unwrap(syncResult, "status", state.replicationStatus);
      }
      if (healthResult) state.databaseHealth = healthResult as AgencyDatabaseHealth;
      if (backupsResult) {
        state.databaseBackups = unwrap(backupsResult, "backups", state.databaseBackups);
      }
      notify(host);
    });
  } catch (error) {
    if (generation === state.loadGeneration) state.error = message(error);
  } finally {
    if (generation === state.loadGeneration) {
      state.loading = false;
      state.refreshing = false;
      notify(host);
    }
  }
}

function isoDate(value = Date.now()): string {
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * Memory values are free-form JSON. Show a plain string as-is so an operator is
 * not forced to type quotes, and pretty-print anything structured.
 */
export function stringifyMemoryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Round-trips {@link stringifyMemoryValue}: valid JSON stays typed, prose stays a string. */
function parseMemoryValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

const localTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const lines = (values: readonly string[] | undefined): string => (values ?? []).join("\n");

/**
 * Seeds the full editor from the richest source available for this employee:
 * the loaded detail payload when it is the one on screen, otherwise the roster
 * row, otherwise the documented defaults. A blank field in this form must mean
 * "not set", never "we failed to read it" — so anything we could not resolve is
 * left empty *and* the form tells the operator the profile has not loaded yet.
 */
function buildEmployeeProfileDraft(
  state: AgencyOperationsState,
  employeeId: string,
  tab: "identity" | "operating" | "communication" | "channels",
): Extract<NonNullable<AgencyOpsDialog>, { kind: "employee-profile" }> {
  const roster = state.employees.find((item) => item.id === employeeId);
  const detail =
    state.employeeDetail?.employee.id === employeeId ? state.employeeDetail.employee : null;
  const comm = detail?.communicationProfile ?? null;
  const exec = detail?.executionProfile ?? null;
  return {
    kind: "employee-profile",
    employeeId,
    tab,
    name: detail?.displayName ?? roster?.name ?? "",
    role: detail?.title ?? roster?.role ?? "",
    department: roster?.department ?? "",
    managerWorkerId: detail?.managerWorkerId ?? roster?.managerWorkerId ?? "",
    capacityHours: String(detail?.weeklyCapacityHours ?? roster?.capacityHours ?? 40),
    availabilityPercent: String(detail?.availabilityPercent ?? 100),
    availability: roster?.availability ?? "available",
    employmentStatus: detail?.employmentStatus ?? roster?.employmentStatus ?? "active",
    timezone: detail?.timezone ?? roster?.timezone ?? "UTC",
    persona: detail?.persona ?? roster?.persona ?? "",
    goals: lines(detail?.goals ?? roster?.goals),
    kpis: lines(detail?.kpis ?? roster?.kpis),
    // "skill:level" per line — proficiency is 1-5 and must survive a round trip.
    skills: (detail?.skills ?? [])
      .map((skill) => `${skill.skill}:${skill.level}`)
      .join("\n"),
    capabilities: lines(detail?.capabilities),
    autonomyLevel: String(detail?.autonomyLevel ?? roster?.autonomyLevel ?? 1),
    approvalThreshold: String(detail?.approvalThreshold ?? roster?.approvalThreshold ?? 0),
    modelBinding: detail?.modelBinding ?? roster?.modelBinding ?? "",
    fallbackModelBinding: exec?.fallbackModelBinding ?? "",
    maxConcurrent: typeof exec?.maxConcurrent === "number" ? String(exec.maxConcurrent) : "",
    timeoutMinutes: typeof exec?.timeoutMinutes === "number" ? String(exec.timeoutMinutes) : "",
    maxRetries: String(exec?.maxRetries ?? 0),
    toolAllowlist: (exec?.toolAllowlist ?? []).join(", "),
    toolDenylist: (exec?.toolDenylist ?? []).join(", "),
    execNotes: exec?.notes ?? "",
    commTone: comm?.tone ?? "professional",
    commVerbosity: comm?.verbosity ?? "concise",
    commLanguage: comm?.language ?? "en",
    commEmoji: comm?.emojiUse ?? "sparing",
    commProactivity: comm?.proactivity ?? "responsive",
    commMinSeconds: String(comm?.responseLatency?.minSeconds ?? 45),
    commTargetSeconds: String(comm?.responseLatency?.targetSeconds ?? 300),
    commBatchSeconds: String(comm?.responseLatency?.batchWindowSeconds ?? 120),
    commOutsideHours: comm?.workingHours?.outsideHours ?? "defer",
    commOutsideHoursMessage: comm?.workingHours?.outsideHoursMessage ?? "",
    commRespectSchedule: String(comm?.workingHours?.respectSchedule ?? true),
    commReportCadence: comm?.reportCadence ?? "daily",
    commReportTime: comm?.reportTime ?? "09:00",
    commGreeting: comm?.greeting ?? "",
    commSignOff: comm?.signOff ?? "",
    commEscalateAfterMinutes: String(comm?.escalation?.escalateAfterMinutes ?? 120),
    commEscalationPhrase: comm?.escalation?.escalationPhrase ?? "",
    commHandoffPhrase: comm?.escalation?.handoffPhrase ?? "",
    commNotifyManager: String(comm?.escalation?.notifyManager ?? false),
    commNotes: comm?.notes ?? detail?.communicationCadence ?? "",
  };
}

export function openAgencyOpsDialog(
  host: AgencyOperationsHost,
  kind: NonNullable<AgencyOpsDialog>["kind"],
  options: {
    entityId?: string;
    memoryEntryId?: string;
    bindingId?: string;
    sopId?: string;
    tab?: "identity" | "operating" | "communication" | "channels";
  } = {},
): void {
  const state = ensureAgencyOperationsState(host);
  const firstWorkerId = state.employees[0]?.id ?? "";
  if (kind === "employee-profile") {
    state.dialog = buildEmployeeProfileDraft(
      state,
      options.entityId ?? state.selectedEmployeeId ?? firstWorkerId,
      options.tab ?? "identity",
    );
    notify(host);
    return;
  }
  if (kind === "employee-channel") {
    const workerId = options.entityId ?? state.selectedEmployeeId ?? firstWorkerId;
    const existing = state.employeeChannels.find((item) => item.id === options.bindingId);
    state.dialog = {
      kind,
      bindingId: existing?.id ?? "",
      workerId: existing?.workerId ?? workerId,
      channelId: existing?.channelId ?? EMPLOYEE_CHANNEL_IDS[0],
      target: existing?.target ?? "",
      handle: existing?.handle ?? "",
      direction: existing?.direction ?? "both",
      enabled: existing ? String(existing.enabled) : "true",
    };
    notify(host);
    return;
  }
  if (kind === "employee-sop-attach") {
    const workerId = options.entityId ?? state.selectedEmployeeId ?? firstWorkerId;
    const worker = state.employees.find((item) => item.id === workerId);
    state.dialog = {
      kind,
      sopId: options.sopId ?? state.sops.find((sop) => sop.ownerWorkerId === workerId)?.id ??
        state.sops[0]?.id ?? "",
      workerId,
      managerWorkerId: worker?.managerWorkerId ?? "",
      cadence: "weekly",
      interval: "1",
      weekday: "1",
      monthDay: "1",
      runAt: "09:00",
      timezone: state.employeeDetail?.employee.timezone ?? "UTC",
      slaMinutes: "1440",
      priority: "normal",
    };
    notify(host);
    return;
  }
  if (kind === "employee-memory") {
    const existing = state.employeeMemory.find((entry) => entry.id === options.memoryEntryId);
    state.dialog = {
      kind,
      memoryId: existing?.id ?? "",
      workerId: existing?.workerId ?? options.entityId ?? state.selectedEmployeeId ?? firstWorkerId,
      namespace: existing?.namespace ?? "general",
      key: existing?.key ?? "",
      value: existing ? stringifyMemoryValue(existing.value) : "",
      expiresDate: existing?.expiresAt ? isoDate(existing.expiresAt) : "",
    };
    notify(host);
    return;
  }
  if (kind === "employee-schedule") {
    state.dialog = {
      kind,
      workerId: options.entityId ?? firstWorkerId,
      timezone: localTimezone(),
      weekdays: "1,2,3,4,5",
      shiftStart: "09:00",
      shiftEnd: "17:00",
      effectiveFrom: isoDate(),
    };
    notify(host);
    return;
  }
  if (kind === "employee-responsibility") {
    state.dialog = {
      kind,
      workerId: options.entityId ?? firstWorkerId,
      managerWorkerId: "",
      title: "",
      instructions: "",
      cadence: "daily",
      interval: "1",
      weekday: "1",
      monthDay: "1",
      runAt: "09:00",
      slaMinutes: "1440",
      priority: "normal",
    };
    notify(host);
    return;
  }
  if (kind === "employee-review") {
    state.dialog = {
      kind,
      workerId: options.entityId ?? firstWorkerId,
      managerWorkerId: state.employees.find((item) => item.id !== firstWorkerId)?.id ?? firstWorkerId,
      cadenceDays: "7",
      nextReviewDate: isoDate(Date.now() + 7 * 86_400_000),
      agenda: "",
    };
    notify(host);
    return;
  }
  if (kind === "employee-work-item") {
    state.dialog = {
      kind,
      workerId: options.entityId ?? firstWorkerId,
      managerWorkerId: "",
      title: "",
      instructions: "",
      priority: "normal",
      dueDate: "",
    };
    notify(host);
    return;
  }
  if (kind === "employee-edit") {
    const employee = state.employees.find((item) => item.id === options.entityId);
    state.dialog = {
      kind,
      employeeId: options.entityId ?? "",
      name: employee?.name ?? "",
      role: employee?.role ?? "",
      department: employee?.department ?? "",
      capacityHours: String(employee?.capacityHours ?? 40),
      availability: employee?.availability ?? "available",
    };
    notify(host);
    return;
  }
  if (kind === "client-edit") {
    const record = state.clients.find((item) => item.id === options.entityId);
    state.dialog = {
      kind,
      clientId: options.entityId ?? "",
      name: record?.name ?? "",
      billingEmail: record?.billingEmail ?? "",
      notes: record?.notes ?? "",
      status: record?.status ?? "prospect",
      email: record?.email ?? "",
      phone: record?.phone ?? "",
      whatsapp: record?.whatsapp ?? "",
      telegram: record?.telegram ?? "",
      discord: record?.discord ?? "",
      instagram: record?.instagram ?? "",
    };
    notify(host);
    return;
  }
  if (kind === "project-edit") {
    const project = state.projects.find((item) => item.id === options.entityId);
    state.dialog = {
      kind,
      projectId: options.entityId ?? "",
      name: project?.name ?? "",
      status: project?.status ?? "planned",
      budget: project ? String((project.budgetCents ?? 0) / 100) : "0",
      dueDate: project?.targetEndAt ? isoDate(project.targetEndAt) : "",
    };
    notify(host);
    return;
  }
  if (kind === "task-edit") {
    const task = state.tasks.find((item) => item.id === options.entityId);
    state.dialog = {
      kind,
      taskId: options.entityId ?? "",
      title: task?.title ?? "",
      status: task?.status ?? "backlog",
      priority: task?.priority ?? "normal",
      dueDate: task?.dueAt ? isoDate(task.dueAt) : "",
    };
    notify(host);
    return;
  }
  if (kind === "deal") {
    state.dialog = {
      kind,
      name: "",
      clientName: "",
      value: "",
      stageId: state.pipelineStages[0]?.id ?? "",
    };
  } else if (kind === "engagement") {
    state.dialog = { kind, name: "", clientName: "", budget: "", dueDate: "" };
  } else if (kind === "employee") {
    state.dialog = {
      kind,
      name: "",
      workerKind: "human",
      role: "",
      department: "",
      capacityHours: "40",
    };
  } else if (kind === "agency") {
    state.dialog = { kind, name: "" };
  } else if (kind === "client") {
    state.dialog = { kind, name: "", billingEmail: "" };
  } else if (kind === "project") {
    state.dialog = { kind, name: "", clientId: "", budget: "" };
  } else if (kind === "task") {
    state.dialog = {
      kind,
      title: "",
      projectId: options.entityId ?? state.detailProjectId ?? state.projects[0]?.id ?? "",
      description: "",
      assigneeType: "ai",
      assigneeId: state.employees.find((employee) => employee.kind === "ai")?.id ?? "",
    };
  } else if (kind === "assignment") {
    state.dialog = {
      kind,
      title: "",
      description: "",
      estimatedHours: "8",
      priority: "3",
      memberId: "",
    };
  } else {
    state.dialog = { kind, email: "", role: "member" };
  }
  notify(host);
}

/**
 * Opens the full editor and makes sure it is editing the *stored* profile.
 *
 * The roster row carries persona, goals, KPIs and autonomy, but not skills,
 * capabilities or the communication profile. Opening the form on partial data
 * would let an operator save defaults over real values, so the form is seeded
 * from what we have, the detail is fetched, and the seed is replaced — but only
 * while the draft is still untouched, so a fast typist is never overwritten.
 */
export async function openAgencyEmployeeEditor(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  employeeId: string,
  tab: "identity" | "operating" | "communication" | "channels" = "identity",
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const alreadyLoaded = state.employeeDetail?.employee.id === employeeId;
  openAgencyOpsDialog(host, "employee-profile", { entityId: employeeId, tab });
  if (alreadyLoaded) return;
  const seeded = JSON.stringify(state.dialog);
  await loadAgencyEmployeeDetail(host, client, employeeId);
  const dialog = state.dialog;
  if (
    dialog?.kind === "employee-profile" &&
    dialog.employeeId === employeeId &&
    JSON.stringify(dialog) === seeded
  ) {
    state.dialog = buildEmployeeProfileDraft(state, employeeId, dialog.tab);
    notify(host);
  }
}

export function patchAgencyOpsDialog(
  host: AgencyOperationsHost,
  patch: Record<string, string>,
): void {
  const state = ensureAgencyOperationsState(host);
  if (state.dialog) state.dialog = { ...state.dialog, ...patch } as AgencyOpsDialog;
  notify(host);
}

export function closeAgencyOpsDialog(host: AgencyOperationsHost): void {
  ensureAgencyOperationsState(host).dialog = null;
  notify(host);
}

const EXTENDED_DIALOG_METHODS: Record<ExtendedAgencyOpsDialogKind, string> = {
  "employee-schedule": "agency.ops.employee.schedule.create",
  "employee-responsibility": "agency.ops.employee.responsibility.create",
  "employee-review": "agency.ops.employee.review-cycle.create",
  "employee-work-item": "agency.ops.employee.work-item.create",
  "employee-edit": "agency.ops.employee.update",
  "client-edit": "agency.ops.clients.update",
  "project-edit": "agency.ops.projects.update",
  "task-edit": "agency.ops.tasks.update",
  "employee-memory": "agency.ops.employee.memory.upsert",
  "employee-profile": "agency.ops.employee.update",
  // Landing concurrently on the gateway. Kept in this map so a build without
  // them surfaces the exact missing method name in the failure banner instead
  // of leaving the panel looking merely empty.
  "employee-channel": "agency.ops.employee.channel.bind",
  "employee-sop-attach": "agency.ops.sop.schedule.attach",
};

/** Splits a textarea into trimmed, non-empty lines. */
function textLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Parses "skill:level" lines into the worker skill shape, clamping 1-5. */
function parseSkillLines(value: string): Array<{ skill: string; level: number; yearsExperience: number }> {
  return textLines(value).map((line) => {
    const separator = line.lastIndexOf(":");
    const skill = separator > 0 ? line.slice(0, separator).trim() : line;
    const level = separator > 0 ? Number(line.slice(separator + 1).trim()) : 3;
    return {
      skill,
      level: Number.isFinite(level) ? Math.min(5, Math.max(1, Math.round(level))) : 3,
      yearsExperience: 0,
    };
  });
}

const numberOrUndefined = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * The one form saves across three gateway methods, because that is how the
 * server actually models an employee: the worker row, its runtime knobs and its
 * communication profile are separately versioned and separately audited.
 *
 * They are therefore issued as three fault-isolated calls rather than one. A
 * rejected communication profile must not also discard the operator's rename.
 */
function employeeProfilePayload(
  draft: Extract<NonNullable<AgencyOpsDialog>, { kind: "employee-profile" }>,
  agencyId: string,
): Record<string, unknown> {
  return {
    agencyId,
    employeeId: draft.employeeId,
    name: draft.name.trim(),
    role: draft.role.trim(),
    department: draft.department.trim() || undefined,
    managerWorkerId: draft.managerWorkerId || null,
    capacityHours: numberOrUndefined(draft.capacityHours) ?? 40,
    availabilityPercent: numberOrUndefined(draft.availabilityPercent),
    status: draft.availability,
    employmentStatus: draft.employmentStatus || undefined,
    persona: draft.persona.trim() || undefined,
    modelBinding: draft.modelBinding.trim() || null,
    autonomyLevel: numberOrUndefined(draft.autonomyLevel) ?? 1,
    // Sent even though today's handler ignores them. They are part of the
    // operator's intent, the write is harmless, and the post-save check below
    // reports exactly which of them the gateway declined to store.
    timezone: draft.timezone.trim() || undefined,
    goals: textLines(draft.goals),
    kpis: textLines(draft.kpis),
    skills: parseSkillLines(draft.skills),
  };
}

function employeeExecutionPayload(
  draft: Extract<NonNullable<AgencyOpsDialog>, { kind: "employee-profile" }>,
  agencyId: string,
): Record<string, unknown> {
  return {
    agencyId,
    employeeId: draft.employeeId,
    modelBinding: draft.modelBinding.trim() || null,
    autonomyLevel: numberOrUndefined(draft.autonomyLevel) ?? 1,
    approvalThreshold: numberOrUndefined(draft.approvalThreshold) ?? 0,
    capabilities: textLines(draft.capabilities),
    profile: {
      fallbackModelBinding: draft.fallbackModelBinding.trim() || null,
      toolAllowlist: csv(draft.toolAllowlist),
      toolDenylist: csv(draft.toolDenylist),
      // Null is meaningful here: it is "inherit the gateway default", which is
      // exactly what an empty field should mean.
      timeoutMinutes: numberOrUndefined(draft.timeoutMinutes) ?? null,
      maxConcurrent: numberOrUndefined(draft.maxConcurrent) ?? null,
      maxRetries: numberOrUndefined(draft.maxRetries) ?? 0,
      notes: draft.execNotes.trim(),
    },
  };
}

function employeeCommunicationPayload(
  draft: Extract<NonNullable<AgencyOpsDialog>, { kind: "employee-profile" }>,
  agencyId: string,
): Record<string, unknown> {
  return {
    agencyId,
    employeeId: draft.employeeId,
    profile: {
      tone: draft.commTone,
      verbosity: draft.commVerbosity,
      language: draft.commLanguage.trim() || "en",
      emojiUse: draft.commEmoji,
      proactivity: draft.commProactivity,
      responseLatency: {
        minSeconds: numberOrUndefined(draft.commMinSeconds) ?? 45,
        targetSeconds: numberOrUndefined(draft.commTargetSeconds) ?? 300,
        batchWindowSeconds: numberOrUndefined(draft.commBatchSeconds) ?? 120,
      },
      workingHours: {
        respectSchedule: draft.commRespectSchedule === "true",
        outsideHours: draft.commOutsideHours,
        outsideHoursMessage: draft.commOutsideHoursMessage.trim() || null,
      },
      escalation: {
        escalateAfterMinutes: numberOrUndefined(draft.commEscalateAfterMinutes) ?? 120,
        escalationPhrase: draft.commEscalationPhrase.trim(),
        handoffPhrase: draft.commHandoffPhrase.trim(),
        notifyManager: draft.commNotifyManager === "true",
      },
      reportCadence: draft.commReportCadence,
      reportTime: draft.commReportTime || "09:00",
      greeting: draft.commGreeting.trim() || null,
      signOff: draft.commSignOff.trim() || null,
      notes: draft.commNotes.trim(),
    },
  };
}

/**
 * Worker-row fields the editor writes that today's `employee.update` does not
 * implement. After a save we re-read the worker and report any that did not
 * stick, so "I edited it and nothing changed" is never a silent outcome.
 */
const VERIFIED_PROFILE_FIELDS = ["persona", "goals", "kpis", "skills", "modelBinding"] as const;

export function isExtendedAgencyOpsDialog(
  draft: NonNullable<AgencyOpsDialog>,
): draft is Extract<NonNullable<AgencyOpsDialog>, { kind: ExtendedAgencyOpsDialogKind }> {
  return draft.kind in EXTENDED_DIALOG_METHODS;
}

/** Turns "1,2,3" into [1,2,3], dropping anything that is not a weekday index. */
function parseWeekdays(value: string): number[] {
  const parsed = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return parsed.length ? parsed : [1, 2, 3, 4, 5];
}

/** Next occurrence of `runAt` (HH:MM local) for the requested cadence. */
function nextRunTimestamp(runAt: string, cadence: "daily" | "weekly" | "monthly"): number {
  const [hours, minutes] = runAt.split(":").map((part) => Number(part) || 0);
  const next = new Date();
  next.setSeconds(0, 0);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= Date.now()) {
    if (cadence === "monthly") next.setMonth(next.getMonth() + 1);
    else if (cadence === "weekly") next.setDate(next.getDate() + 7);
    else next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

async function submitExtendedAgencyOpsDialog(
  client: GatewayBrowserClient,
  draft: Extract<NonNullable<AgencyOpsDialog>, { kind: ExtendedAgencyOpsDialogKind }>,
  agencyId: string,
): Promise<void> {
  const method = EXTENDED_DIALOG_METHODS[draft.kind];
  if (draft.kind === "employee-profile") {
    // Three separately-audited server surfaces, three calls, individually
    // reported. A rejected communication profile must not discard the rename.
    const attempts: Array<[string, Record<string, unknown>]> = [
      [method, employeeProfilePayload(draft, agencyId)],
      ["agency.ops.employee.execution.update", employeeExecutionPayload(draft, agencyId)],
      ["agency.ops.employee.communication.update", employeeCommunicationPayload(draft, agencyId)],
    ];
    const rejected: string[] = [];
    for (const [rpc, payload] of attempts) {
      try {
        await client.request(rpc, payload);
      } catch (error) {
        rejected.push(`${rpc} — ${message(error)}`);
      }
    }
    if (rejected.length) throw new Error(rejected.join("; "));
    return;
  }
  if (draft.kind === "employee-channel") {
    await client.request(method, {
      agencyId,
      employeeId: draft.workerId,
      channelId: draft.channelId,
      target: draft.target.trim() || null,
      handle: draft.handle.trim() || null,
      direction: draft.direction,
      enabled: draft.enabled === "true",
    });
    return;
  }
  if (draft.kind === "employee-sop-attach") {
    await client.request(method, {
      agencyId,
      sopId: draft.sopId,
      workerId: draft.workerId,
      managerWorkerId: draft.managerWorkerId || null,
      cadence: draft.cadence,
      interval: numberOrUndefined(draft.interval) ?? 1,
      weekday: draft.cadence === "weekly" ? (numberOrUndefined(draft.weekday) ?? 1) : null,
      monthDay: draft.cadence === "monthly" ? (numberOrUndefined(draft.monthDay) ?? 1) : null,
      runAt: draft.runAt || "09:00",
      timezone: draft.timezone.trim() || "UTC",
      slaMinutes: numberOrUndefined(draft.slaMinutes) ?? 1_440,
      priority: draft.priority,
      enabled: true,
    });
    return;
  }
  if (draft.kind === "employee-schedule") {
    await client.request(method, {
      agencyId,
      workerId: draft.workerId,
      timezone: draft.timezone.trim() || "UTC",
      weekdays: parseWeekdays(draft.weekdays),
      shiftStart: draft.shiftStart || "09:00",
      shiftEnd: draft.shiftEnd || "17:00",
      effectiveFrom: draft.effectiveFrom || isoDate(),
      enabled: true,
    });
    return;
  }
  if (draft.kind === "employee-responsibility") {
    await client.request(method, {
      agencyId,
      workerId: draft.workerId,
      managerWorkerId: draft.managerWorkerId || undefined,
      title: draft.title.trim(),
      instructions: draft.instructions.trim() || undefined,
      cadence: draft.cadence,
      interval: Number(draft.interval) || 1,
      weekday: draft.cadence === "weekly" ? (Number(draft.weekday) || 0) : undefined,
      monthDay: draft.cadence === "monthly" ? (Number(draft.monthDay) || 1) : undefined,
      runAt: draft.runAt || "09:00",
      slaMinutes: Number(draft.slaMinutes) || 1_440,
      priority: draft.priority,
      enabled: true,
      nextRunAt: nextRunTimestamp(draft.runAt || "09:00", draft.cadence),
    });
    return;
  }
  if (draft.kind === "employee-review") {
    await client.request(method, {
      agencyId,
      workerId: draft.workerId,
      managerWorkerId: draft.managerWorkerId,
      cadenceDays: Number(draft.cadenceDays) || 7,
      nextReviewAt: draft.nextReviewDate
        ? new Date(`${draft.nextReviewDate}T12:00:00`).getTime()
        : Date.now(),
      agenda: draft.agenda
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    });
    return;
  }
  if (draft.kind === "employee-work-item") {
    await client.request(method, {
      agencyId,
      workerId: draft.workerId,
      managerWorkerId: draft.managerWorkerId || undefined,
      title: draft.title.trim(),
      instructions: draft.instructions.trim() || undefined,
      priority: draft.priority,
      scheduledFor: Date.now(),
      dueAt: draft.dueDate ? new Date(`${draft.dueDate}T12:00:00`).getTime() : null,
    });
    return;
  }
  if (draft.kind === "employee-edit") {
    await client.request(method, {
      agencyId,
      employeeId: draft.employeeId,
      name: draft.name.trim(),
      role: draft.role.trim(),
      department: draft.department.trim() || undefined,
      capacityHours: Number(draft.capacityHours) || 40,
      status: draft.availability,
    });
    return;
  }
  if (draft.kind === "employee-memory") {
    await client.request(method, {
      agencyId,
      workerId: draft.workerId,
      namespace: draft.namespace.trim() || "general",
      key: draft.key.trim(),
      value: parseMemoryValue(draft.value),
      source: "operator",
      expiresAt: draft.expiresDate
        ? new Date(`${draft.expiresDate}T12:00:00`).getTime()
        : null,
    });
    return;
  }
  if (draft.kind === "client-edit") {
    // A blank field sends `null` so the operator can clear a value; a trimmed
    // non-empty string sets it. Every one of these persists through the real
    // agency ledger RPC — nothing is local-only state.
    await client.request(method, {
      agencyId,
      clientId: draft.clientId,
      name: draft.name.trim(),
      status: draft.status,
      billingEmail: draft.billingEmail.trim() || null,
      notes: draft.notes.trim() || null,
      email: draft.email.trim() || null,
      phone: draft.phone.trim() || null,
      whatsapp: draft.whatsapp.trim() || null,
      telegram: draft.telegram.trim() || null,
      discord: draft.discord.trim() || null,
      instagram: draft.instagram.trim() || null,
    });
    return;
  }
  if (draft.kind === "task-edit") {
    // Status stays on the always-live transition RPC so a rename/priority edit
    // never loses the state move even on a gateway that predates
    // `agency.ops.tasks.update`. Descriptive fields then persist via update.
    await client.request("agency.ops.tasks.transition", {
      agencyId,
      taskId: draft.taskId,
      status: draft.status,
    });
    await client.request(method, {
      agencyId,
      taskId: draft.taskId,
      title: draft.title.trim(),
      priority: draft.priority,
      dueAt: draft.dueDate ? new Date(`${draft.dueDate}T12:00:00`).getTime() : null,
    });
    return;
  }
  // project-edit: transition first (guaranteed live), then persist the
  // descriptive fields. Ordering means the status move survives even if the
  // update RPC is not yet served by the running daemon.
  await client.request("agency.ops.projects.transition", {
    agencyId,
    projectId: draft.projectId,
    status: draft.status,
  });
  await client.request(method, {
    agencyId,
    projectId: draft.projectId,
    name: draft.name.trim(),
    budget: Number(draft.budget) || 0,
    targetEndAt: draft.dueDate ? new Date(`${draft.dueDate}T12:00:00`).getTime() : null,
  });
}

export async function submitAgencyOpsDialog(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = state.dialog;
  if (!draft || state.saving) return;
  state.saving = true;
  state.error = null;
  notify(host);

  try {
    const agencyId = state.selectedAgencyId;
    if (draft.kind !== "agency" && !agencyId) throw new Error("Select an agency first.");
    if (isExtendedAgencyOpsDialog(draft)) {
      await submitExtendedAgencyOpsDialog(client, draft, agencyId as string);
    } else if (draft.kind === "deal") {
      await client.request("agency.ops.pipeline.deal.create", {
        agencyId,
        name: draft.name.trim(),
        clientName: draft.clientName.trim(),
        value: Number(draft.value) || 0,
        stageId: draft.stageId,
      });
    } else if (draft.kind === "engagement") {
      await client.request("agency.ops.engagement.create", {
        agencyId,
        name: draft.name.trim(),
        clientName: draft.clientName.trim(),
        budget: Number(draft.budget) || 0,
        dueAt: draft.dueDate ? new Date(`${draft.dueDate}T12:00:00`).getTime() : undefined,
      });
    } else if (draft.kind === "employee") {
      await client.request("agency.ops.employee.create", {
        agencyId,
        name: draft.name.trim(),
        kind: draft.workerKind,
        role: draft.role.trim(),
        department: draft.department.trim(),
        capacityHours: Number(draft.capacityHours) || 40,
      });
    } else if (draft.kind === "agency") {
      const created = await client.request("agency.ops.agency.create", { name: draft.name.trim() });
      const agency = unwrap<AgencyWorkspace | null>(created, "agency", null);
      if (agency?.id) {
        state.selectedAgencyId = agency.id;
        persistSelectedAgencyId(agency.id);
      }
    } else if (draft.kind === "client") {
      await client.request("agency.ops.clients.create", {
        agencyId,
        name: draft.name.trim(),
        billingEmail: draft.billingEmail.trim() || undefined,
      });
    } else if (draft.kind === "project") {
      await client.request("agency.ops.projects.create", {
        agencyId,
        name: draft.name.trim(),
        clientId: draft.clientId || undefined,
        budget: Number(draft.budget) || 0,
      });
    } else if (draft.kind === "task") {
      await client.request("agency.ops.tasks.create", {
        agencyId,
        projectId: draft.projectId,
        title: draft.title.trim(),
        description: draft.description.trim(),
        assigneeType: draft.assigneeType,
        assigneeId: draft.assigneeId || undefined,
      });
    } else if (draft.kind === "assignment") {
      const estimatedHours = Number(draft.estimatedHours) || 0;
      const member = state.employees.find((employee) => employee.id === draft.memberId);
      await client.request("agency.ops.assignment.create", {
        agencyId,
        title: draft.title.trim(),
        description: draft.description.trim() || undefined,
        estimatedHours,
        priority: Number(draft.priority) || 3,
        members: member
          ? [{ workerId: member.id, role: "owner", allocatedHours: estimatedHours || 1 }]
          : [],
      });
    } else {
      const result = await client.request("agency.ops.agency.share", {
        agencyId,
        email: draft.email.trim(),
        role: draft.role,
      });
      const payload = result as {
        joinUrl?: string | null;
        collaboration?: { state?: string; message?: string };
      };
      state.lastShareLink = payload.joinUrl ?? null;
      state.collaborationStatus =
        payload.collaboration?.message ?? payload.collaboration?.state ?? null;
    }
    state.dialog = null;
    // A memory write does not change any panel the full reload refetches, so
    // refresh the one list that actually moved before the broad reload.
    if (draft.kind === "employee-memory") {
      await loadAgencyEmployeeMemory(host, client, draft.workerId);
    }
    if (draft.kind === "employee-profile") {
      // Re-read the worker and say plainly which fields this gateway build did
      // not persist. Silently discarding half an edit is the worst outcome.
      await loadAgencyEmployeeDetail(host, client, draft.employeeId);
      reportUnpersistedProfileFields(state, draft);
    }
    if (draft.kind === "employee-channel") {
      await loadAgencyEmployeeChannels(host, client, draft.workerId);
    }
    if (draft.kind === "employee-sop-attach") {
      await loadAgencyEmployeeSops(host, client, draft.workerId);
    }
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    if (isExtendedAgencyOpsDialog(draft)) {
      // Keeps a rejected write — including a gateway that does not expose the
      // method yet — visible in the persistent failure banner.
      recordMutationFailure(state, EXTENDED_DIALOG_METHODS[draft.kind], error);
    } else {
      state.error = message(error);
    }
  } finally {
    state.saving = false;
    notify(host);
  }
}

export async function completeAgencyReviewCycle(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  reviewCycleId: string,
  outcome: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = reviewCycleId;
  state.error = null;
  notify(host);
  try {
    const result = await client.request("agency.ops.employee.review-cycle.complete", {
      agencyId,
      reviewCycleId,
      outcome,
    });
    const updated = unwrap<EmployeeReviewCycle | null>(result, "reviewCycle", null);
    if (updated) {
      // Completing a cycle re-arms it for the next cadence window rather than
      // deleting it, so replace in place instead of filtering it out.
      state.employeeReviewCycles = state.employeeReviewCycles.map((cycle) =>
        cycle.id === reviewCycleId ? updated : cycle,
      );
    } else {
      await loadAgencyOperations(host, client, { background: true });
    }
    const { [reviewCycleId]: _cleared, ...remaining } = state.reviewOutcomes;
    state.reviewOutcomes = remaining;
  } catch (error) {
    recordMutationFailure(state, "agency.ops.employee.review-cycle.complete", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export function setAgencyInvoicePaymentAmount(
  host: AgencyOperationsHost,
  invoiceId: string,
  amount: string,
): void {
  const state = ensureAgencyOperationsState(host);
  state.invoicePaymentAmounts = { ...state.invoicePaymentAmounts, [invoiceId]: amount };
  notify(host);
}

export function setAgencyReviewOutcome(
  host: AgencyOperationsHost,
  reviewCycleId: string,
  outcome: string,
): void {
  const state = ensureAgencyOperationsState(host);
  state.reviewOutcomes = { ...state.reviewOutcomes, [reviewCycleId]: outcome };
  notify(host);
}

export function setAgencyDeliveryClientFilter(
  host: AgencyOperationsHost,
  clientId: string,
): void {
  const state = ensureAgencyOperationsState(host);
  state.deliveryClientFilter = clientId;
  state.boardProjectFilter = "";
  notify(host);
}

/** Client card → the delivery board, scoped to that client's projects. */
export function focusAgencyClientProjects(host: AgencyOperationsHost, clientId: string): void {
  const state = ensureAgencyOperationsState(host);
  state.deliveryClientFilter = clientId;
  state.boardProjectFilter = "";
  state.activeSection = "delivery";
  notify(host);
}

/** Tag used to associate a note with a client through the existing notes store. */
export function clientNoteTag(clientId: string): string {
  return `client:${clientId}`;
}

/**
 * Open the full-screen client profile surface and load its related notes.
 * Everything else the profile shows (projects, tasks, deadlines, invoices,
 * revenue) is already resident in agency-operations state.
 */
/**
 * Open a client from the Agency Operations grid.
 *
 * DEDUPLICATION: this used to open a SECOND client profile overlay owned by
 * this surface, so the same client had two profile pages that knew different
 * things — the agency one had notes and the agent launcher, the /clients one
 * had the schema properties, docs, campaign, revenue and (now) the connection
 * graph and activity thread. Two profiles for one record is how a CRM starts
 * lying to you.
 *
 * The agency grid stays (picking a client to invoice is a real finance
 * workflow); only the profile is consolidated. Clicking a client now hands the
 * user to the canonical Client Focus page on /clients, which is the single
 * place a client record is viewed. Back returns here, because openEntityInTab
 * pushes a real history entry.
 *
 * The legacy overlay's state fields and renderer are left in place but are no
 * longer reachable from the grid — see `renderClientProfile`, retained so an
 * install pinned to an older bundle keeps rendering rather than blanking.
 */
export function openAgencyClientProfile(
  host: AgencyOperationsHost,
  _client: GatewayBrowserClient,
  clientId: string,
): void {
  const state = ensureAgencyOperationsState(host);
  const record = state.clients.find((c) => c.id === clientId);
  openEntityInTab(
    host as unknown as Parameters<typeof openEntityInTab>[0],
    "client",
    slugify(record?.name ?? "", clientId),
    "clients",
  );
  notify(host);
}

export function closeAgencyClientProfile(host: AgencyOperationsHost): void {
  const state = ensureAgencyOperationsState(host);
  state.clientProfileId = null;
  notify(host);
}

/** Tag used to associate a note with a project through the existing notes store. */
export function projectNoteTag(projectId: string): string {
  return `project:${projectId}`;
}

// Browser Back support for the dedicated project page. We push one history
// entry when the page opens and listen for the matching pop so the OS/browser
// Back gesture returns to Agency Operations exactly like the in-view button.
let detailPopstateBound = false;
function bindDetailPopstate(host: AgencyOperationsHost): void {
  if (detailPopstateBound || typeof window === "undefined") return;
  detailPopstateBound = true;
  window.addEventListener("popstate", () => {
    const state = host.agencyOperationsState;
    if (state?.detailProjectId) closeAgencyProjectDetail(host, { fromPopstate: true });
  });
}

/**
 * Open the full-screen dedicated project detail surface and load its related
 * notes. Everything else the page shows (tasks, status, budget, deadlines,
 * client, activity) is already resident in agency-operations state, so no
 * extra fetch is required for the core view.
 */
export function openAgencyProjectDetail(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  projectId: string,
): void {
  const state = ensureAgencyOperationsState(host);
  state.detailProjectId = projectId;
  state.detailProjectTab = "overview";
  state.detailProjectNoteDraft = "";
  bindDetailPopstate(host);
  try {
    window.history.pushState({ agencyProjectDetail: projectId }, "");
  } catch {
    /* history unavailable (non-browser host) — the in-view Back still works. */
  }
  notify(host);
  void loadAgencyProjectNotes(host, client, projectId);
}

export function setAgencyProjectDetailTab(
  host: AgencyOperationsHost,
  tab: AgencyOperationsState["detailProjectTab"],
): void {
  ensureAgencyOperationsState(host).detailProjectTab = tab;
  notify(host);
}

export function closeAgencyProjectDetail(
  host: AgencyOperationsHost,
  opts: { fromPopstate?: boolean } = {},
): void {
  const state = ensureAgencyOperationsState(host);
  if (!state.detailProjectId) return;
  state.detailProjectId = null;
  notify(host);
  // When the operator uses the in-view Back button (not the browser Back that
  // already popped our entry), unwind the history entry we pushed so the two
  // navigation paths stay consistent.
  if (!opts.fromPopstate) {
    try {
      const current = window.history.state as { agencyProjectDetail?: string } | null;
      if (current?.agencyProjectDetail) window.history.back();
    } catch {
      /* ignore */
    }
  }
}

/** Load notes related to a project from the existing notes system (tag-scoped). */
export async function loadAgencyProjectNotes(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  projectId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  state.detailProjectNotesLoading = true;
  notify(host);
  try {
    const res = (await client.request("notes.list", {
      tags: [projectNoteTag(projectId)],
      limit: 100,
    })) as { notes?: Array<Record<string, unknown>> } | undefined;
    const notes = Array.isArray(res?.notes) ? res!.notes : [];
    state.detailProjectNotes = notes
      .map((n) => ({
        id: String(n.id ?? ""),
        name: String(n.name ?? "Untitled"),
        body: String(n.body ?? ""),
        updatedAt: (n.updatedAt as string | number) ?? Date.now(),
        createdAt: (n.createdAt as string | number) ?? undefined,
      }))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch (error) {
    state.error = message(error);
  } finally {
    state.detailProjectNotesLoading = false;
    notify(host);
  }
}

/** Add a note related to the open project using the existing notes.create RPC. */
export async function addAgencyProjectNote(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  projectId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const body = state.detailProjectNoteDraft.trim();
  if (!body || state.detailProjectNoteBusy) return;
  const projectName = state.projects.find((p) => p.id === projectId)?.name ?? "Project";
  state.detailProjectNoteBusy = true;
  notify(host);
  try {
    await client.request("notes.create", {
      name: `${projectName} · ${new Date().toLocaleDateString()}`,
      body,
      category: "project",
      tags: [projectNoteTag(projectId), "project"],
    });
    state.detailProjectNoteDraft = "";
    await loadAgencyProjectNotes(host, client, projectId);
  } catch (error) {
    state.error = message(error);
  } finally {
    state.detailProjectNoteBusy = false;
    notify(host);
  }
}

export function setAgencyProjectNoteDraft(host: AgencyOperationsHost, value: string): void {
  ensureAgencyOperationsState(host).detailProjectNoteDraft = value;
  notify(host);
}

/** Load notes related to a client from the existing notes system (tag-scoped). */
export async function loadAgencyClientNotes(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  clientId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  state.clientProfileNotesLoading = true;
  notify(host);
  try {
    const res = (await client.request("notes.list", {
      tags: [clientNoteTag(clientId)],
      limit: 100,
    })) as { notes?: Array<Record<string, unknown>> } | undefined;
    const notes = Array.isArray(res?.notes) ? res!.notes : [];
    state.clientProfileNotes = notes
      .map((n) => ({
        id: String(n.id ?? ""),
        name: String(n.name ?? "Untitled"),
        body: String(n.body ?? ""),
        updatedAt: (n.updatedAt as string | number) ?? Date.now(),
        createdAt: (n.createdAt as string | number) ?? undefined,
      }))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch (error) {
    state.error = message(error);
  } finally {
    state.clientProfileNotesLoading = false;
    notify(host);
  }
}

/** Add a note related to the open client using the existing notes.create RPC. */
export async function addAgencyClientNote(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  clientId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const body = state.clientProfileNoteDraft.trim();
  if (!body || state.clientProfileNoteBusy) return;
  const clientName =
    state.clients.find((c) => c.id === clientId)?.name ?? "Client";
  state.clientProfileNoteBusy = true;
  notify(host);
  try {
    await client.request("notes.create", {
      name: `${clientName} · ${new Date().toLocaleDateString()}`,
      body,
      category: "client",
      tags: [clientNoteTag(clientId), "client"],
    });
    state.clientProfileNoteDraft = "";
    await loadAgencyClientNotes(host, client, clientId);
  } catch (error) {
    state.error = message(error);
  } finally {
    state.clientProfileNoteBusy = false;
    notify(host);
  }
}

/**
 * Launch an autonomous agent to carry out a task for the client, wired to the
 * same `sessions.spawn` path the dashboard / kanban use. When a project is
 * supplied the task is scoped to it so the coder has working context.
 */
export async function spawnAgencyClientAgent(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  clientId: string,
  options: { task?: string; projectId?: string; projectName?: string } = {},
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const clientRecord = state.clients.find((c) => c.id === clientId);
  const task = (options.task ?? state.clientProfileAgentTask).trim();
  if (!task || state.clientProfileAgentBusy) return;
  const clientName = clientRecord?.name ?? "the client";
  const scope = options.projectName
    ? ` This work is for the project "${options.projectName}".`
    : "";
  const prompt =
    `Autonomous task for agency client "${clientName}".${scope}\n\n${task}`;
  const label = `${clientName}: ${task.slice(0, 48)}`;
  state.clientProfileAgentBusy = true;
  state.clientProfileAgentNotice = null;
  notify(host);
  try {
    const res = (await client.request("sessions.spawn", {
      task: prompt,
      agentId: "coder",
      label,
      autonomous: true,
    })) as { status?: string; childSessionKey?: string; runId?: string } | undefined;
    state.clientProfileAgentNotice = `Agent launched (${res?.status ?? "accepted"}) for ${clientName}.`;
    state.clientProfileAgentTask = "";
  } catch (error) {
    state.clientProfileAgentNotice = `Failed to launch agent: ${message(error)}`;
  } finally {
    state.clientProfileAgentBusy = false;
    notify(host);
  }
}

/** "+N more open tasks" → the board, scoped to that project. */
export function focusAgencyProjectTasks(host: AgencyOperationsHost, projectId: string): void {
  const state = ensureAgencyOperationsState(host);
  state.boardProjectFilter = projectId;
  state.deliveryClientFilter = "";
  state.deliveryView = "board";
  state.activeSection = "delivery";
  notify(host);
}

/**
 * Audit row → the surface that owns the referenced entity. The audit log stores
 * only `entityType`/`entityId`, so this is a best-effort resolve: unknown types
 * fall back to leaving the operator where they are.
 */
export function focusAgencyAuditEntity(
  host: AgencyOperationsHost,
  entityType: string,
  entityId: string,
): boolean {
  const state = ensureAgencyOperationsState(host);
  const type = entityType.toLowerCase();
  if (type.includes("task")) {
    const task = state.tasks.find((item) => item.id === entityId);
    if (!task) return false;
    return (focusAgencyProjectTasks(host, task.projectId), true);
  }
  if (type.includes("project")) {
    if (!state.projects.some((item) => item.id === entityId)) return false;
    return (focusAgencyProjectTasks(host, entityId), true);
  }
  if (type.includes("client")) {
    if (!state.clients.some((item) => item.id === entityId)) return false;
    return (focusAgencyClientProjects(host, entityId), true);
  }
  if (type.includes("worker") || type.includes("employee")) {
    if (!state.employees.some((item) => item.id === entityId)) return false;
    selectAgencyEmployee(host, entityId);
    return true;
  }
  if (type.includes("invoice") || type.includes("revenue") || type.includes("payment")) {
    state.activeSection = "finance";
    notify(host);
    return true;
  }
  if (type.startsWith("agency")) {
    // Agency profile, membership and invitation events all belong to the
    // administration surface.
    state.activeSection = "settings";
    notify(host);
    return true;
  }
  return false;
}

export async function resolveAgencyApproval(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  approvalId: string,
  decision: "approved" | "rejected",
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId) return;
  if (state.approvalBusyId) return;
  state.approvalBusyId = approvalId;
  state.error = null;
  notify(host);
  try {
    await client.request("agency.ops.approval.resolve", { agencyId, approvalId, decision });
    state.approvals = state.approvals.filter((approval) => approval.id !== approvalId);
  } catch (error) {
    state.error = message(error);
  } finally {
    state.approvalBusyId = null;
    notify(host);
  }
}

export async function updateAgencyEmployeeCapacity(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  employeeId: string,
  capacityHours: number,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId) return;
  const employee = state.employees.find((item) => item.id === employeeId);
  if (!employee) return;
  const previous = employee.capacityHours;
  employee.capacityHours = capacityHours;
  notify(host);
  try {
    await client.request("agency.ops.employee.capacity.update", {
      agencyId,
      employeeId,
      capacityHours,
    });
  } catch (error) {
    employee.capacityHours = previous;
    state.error = message(error);
    notify(host);
  }
}

export function setAgencyEmployeeFilter(
  host: AgencyOperationsHost,
  filter: AgencyOperationsState["employeeFilter"],
): void {
  ensureAgencyOperationsState(host).employeeFilter = filter;
  notify(host);
}

export function setAgencyOperationsSection(
  host: AgencyOperationsHost,
  section: AgencyOperationsSection,
): void {
  ensureAgencyOperationsState(host).activeSection = section;
  notify(host);
}

export function selectAgencyEmployee(host: AgencyOperationsHost, employeeId: string | null): void {
  const state = ensureAgencyOperationsState(host);
  state.selectedEmployeeId = employeeId;
  if (!employeeId) {
    state.employeeDetail = null;
    state.employeeMemory = [];
    state.employeeMemoryWorkerId = null;
    state.employeeSopSchedules = [];
    state.employeeSopRuns = [];
    state.employeeSopWorkerId = null;
    state.employeeChannels = [];
    state.employeeChannelsWorkerId = null;
    state.employeeChannelsUnavailable = false;
  }
  state.activeSection = "employees";
  notify(host);
}

/**
 * Loads one employee's namespaced memory. This is the durable recall an AI
 * employee reads and writes between work items, so an operator needs to see and
 * correct it — an empty list here must be distinguishable from a failed fetch,
 * hence the shared failure banner.
 */
export async function loadAgencyEmployeeMemory(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  workerId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || !workerId) return;
  state.employeeMemoryLoading = true;
  state.employeeMemoryWorkerId = workerId;
  notify(host);
  try {
    const result = await client.request("agency.ops.employee.memory.list", {
      agencyId,
      workerId,
    });
    // A slower response for a previously selected employee must not overwrite
    // the memory of whoever is on screen now.
    if (state.employeeMemoryWorkerId !== workerId) return;
    state.employeeMemory = unwrap<EmployeeMemoryEntry[]>(result, "memory", []);
  } catch (error) {
    state.employeeMemory = [];
    recordMutationFailure(state, "agency.ops.employee.memory.list", error);
  } finally {
    state.employeeMemoryLoading = false;
    notify(host);
  }
}

/**
 * Compares what the full editor asked for against what the worker row actually
 * came back with, and records every field the gateway dropped. This is the
 * "never indistinguishable from no data" rule applied to writes: an operator
 * who edits autonomy on a build that cannot store it must be told, not left to
 * discover it when the employee behaves the old way.
 */
function reportUnpersistedProfileFields(
  state: AgencyOperationsState,
  draft: Extract<NonNullable<AgencyOpsDialog>, { kind: "employee-profile" }>,
): void {
  const worker = state.employeeDetail?.employee;
  if (!worker || worker.id !== draft.employeeId) return;
  const wanted = employeeProfilePayload(draft, state.selectedAgencyId ?? "");
  const dropped: string[] = [];
  for (const key of VERIFIED_PROFILE_FIELDS) {
    const expected = wanted[key];
    const actual = (worker as unknown as Record<string, unknown>)[key];
    if (key === "skills") {
      const expectedKeys = (expected as Array<{ skill: string; level: number }>)
        .map((item) => `${item.skill}:${item.level}`)
        .sort()
        .join("|");
      const actualKeys = (Array.isArray(actual) ? actual : [])
        .map((item) => {
          const row = item as { skill?: string; level?: number };
          return `${row.skill ?? ""}:${row.level ?? ""}`;
        })
        .sort()
        .join("|");
      if (expectedKeys !== actualKeys) dropped.push(key);
      continue;
    }
    if (Array.isArray(expected)) {
      const actualList = Array.isArray(actual) ? actual : [];
      if (expected.join("|") !== actualList.join("|")) dropped.push(key);
      continue;
    }
    if (typeof expected === "number") {
      if (actual !== expected) dropped.push(key);
      continue;
    }
    const expectedText = expected === null || expected === undefined ? "" : String(expected);
    const actualText = actual === null || actual === undefined ? "" : String(actual);
    if (expectedText !== actualText) dropped.push(key);
  }
  if (!dropped.length) return;
  const entry =
    `agency.ops.employee.update — saved, but this gateway did not persist: ${dropped.join(", ")}`;
  if (!state.failedRequests.includes(entry)) {
    state.failedRequests = [...state.failedRequests, entry];
  }
}

/**
 * The agency SOP catalogue. Loaded once per agency and reused by every
 * employee panel — an SOP list is agency-wide, so refetching it per card would
 * be eleven identical requests on this roster alone.
 */
export async function loadAgencySops(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId) return;
  try {
    const result = await client.request("agency.ops.sops.list", { agencyId });
    state.sops = unwrap<AgencySopSummary[]>(result, "sops", []);
    state.sopsLoaded = true;
  } catch (error) {
    state.sops = [];
    state.sopsLoaded = false;
    recordPanelFailure(state, "agency.ops.sops.list", error);
  } finally {
    notify(host);
  }
}

/**
 * Schedules and run history for one employee. Both are fetched together so the
 * panel can show "attached, last outcome" as a single coherent statement.
 */
export async function loadAgencyEmployeeSops(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  workerId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || !workerId) return;
  state.employeeSopLoading = true;
  state.employeeSopWorkerId = workerId;
  notify(host);
  const failures: string[] = [];
  try {
    if (!state.sopsLoaded) await loadAgencySops(host, client);
    const [schedulesResult, runsResult] = await Promise.all([
      attempt(client, failures, "agency.ops.sop.schedules.list", { agencyId, workerId }),
      attempt(client, failures, "agency.ops.sop.runs.list", { agencyId, workerId, limit: 20 }),
    ]);
    if (state.employeeSopWorkerId !== workerId) return;
    state.employeeSopSchedules = unwrap<AgencySopSchedule[]>(schedulesResult, "schedules", []);
    state.employeeSopRuns = unwrap<AgencySopRun[]>(runsResult, "runs", []);
    for (const failure of failures) {
      if (!state.failedRequests.includes(failure)) {
        state.failedRequests = [...state.failedRequests, failure];
      }
    }
  } finally {
    state.employeeSopLoading = false;
    notify(host);
  }
}

/**
 * Chat-channel bindings for one employee. The gateway surface is landing
 * concurrently, so a missing method is recorded as *unavailable* rather than
 * as an empty binding list — the two mean very different things to an operator
 * deciding whether an employee can be reached on Slack.
 */
export async function loadAgencyEmployeeChannels(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  workerId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || !workerId) return;
  state.employeeChannelsLoading = true;
  state.employeeChannelsWorkerId = workerId;
  notify(host);
  try {
    const result = await client.request("agency.ops.employee.channels.list", {
      agencyId,
      employeeId: workerId,
    });
    if (state.employeeChannelsWorkerId !== workerId) return;
    state.employeeChannels = unwrap<EmployeeChannelBinding[]>(result, "bindings", []);
    state.employeeChannelsUnavailable = false;
  } catch (error) {
    if (state.employeeChannelsWorkerId !== workerId) return;
    state.employeeChannels = [];
    state.employeeChannelsUnavailable = true;
    recordPanelFailure(state, "agency.ops.employee.channels.list", error);
  } finally {
    state.employeeChannelsLoading = false;
    notify(host);
  }
}

/**
 * Provision the starter SOP catalogue for the seeded roles.
 *
 * Idempotent server-side and deliberately operator-triggered: it writes rows,
 * and it must never happen as a side effect of opening a panel. It attaches no
 * schedules, so it creates no cron jobs and generates no work.
 */
export async function seedAgencySopCatalogue(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = "sop-seed";
  state.error = null;
  notify(host);
  try {
    await client.request("agency.ops.sops.seed", { agencyId });
    await loadAgencySops(host, client);
    if (state.selectedEmployeeId) {
      await loadAgencyEmployeeSops(host, client, state.selectedEmployeeId);
    }
  } catch (error) {
    recordMutationFailure(state, "agency.ops.sops.seed", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/** Fire one SOP now for this employee. Creates a Backlog work item, nothing more. */
export async function runAgencyEmployeeSop(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  sopId: string,
  workerId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = sopId;
  state.error = null;
  notify(host);
  try {
    await client.request("agency.ops.sop.run", { agencyId, sopId, workerId });
    await loadAgencyEmployeeSops(host, client, workerId);
  } catch (error) {
    recordMutationFailure(state, "agency.ops.sop.run", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/** Remove an SOP schedule, its cron job and its recurring responsibility. */
export async function detachAgencyEmployeeSop(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  scheduleId: string,
  workerId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = scheduleId;
  state.error = null;
  notify(host);
  try {
    await client.request("agency.ops.sop.schedule.detach", { agencyId, scheduleId });
    await loadAgencyEmployeeSops(host, client, workerId);
  } catch (error) {
    recordMutationFailure(state, "agency.ops.sop.schedule.detach", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/** Remove a chat-channel binding from an employee. */
export async function removeAgencyEmployeeChannel(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  bindingId: string,
  workerId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = bindingId;
  state.error = null;
  notify(host);
  try {
    await client.request("agency.ops.employee.channel.unbind", { agencyId, bindingId });
    await loadAgencyEmployeeChannels(host, client, workerId);
  } catch (error) {
    recordMutationFailure(state, "agency.ops.employee.channel.unbind", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/**
 * Take an employee off the roster. Optimistic, with rollback: the row is
 * removed immediately and restored in place if the gateway refuses.
 */
export async function deactivateAgencyEmployee(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  employeeId: string,
  employmentStatus = "inactive",
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  const index = state.employees.findIndex((item) => item.id === employeeId);
  if (index < 0) return;
  const removed = state.employees[index];
  state.secondaryBusyId = employeeId;
  state.employees = state.employees.filter((item) => item.id !== employeeId);
  if (state.selectedEmployeeId === employeeId) selectAgencyEmployee(host, null);
  notify(host);
  try {
    await client.request("agency.ops.employee.deactivate", {
      agencyId,
      employeeId,
      employmentStatus,
    });
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    const restored = [...state.employees];
    restored.splice(index, 0, removed);
    state.employees = restored;
    recordMutationFailure(state, "agency.ops.employee.deactivate", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/** Expand or collapse one roster card's governance detail. */
export function toggleAgencyEmployeeExpansion(
  host: AgencyOperationsHost,
  employeeId: string,
): void {
  const state = ensureAgencyOperationsState(host);
  state.expandedEmployeeIds = state.expandedEmployeeIds.includes(employeeId)
    ? state.expandedEmployeeIds.filter((id) => id !== employeeId)
    : [...state.expandedEmployeeIds, employeeId];
  notify(host);
}

export function setAgencyEmployeeLayout(
  host: AgencyOperationsHost,
  layout: AgencyOperationsState["employeeLayout"],
): void {
  ensureAgencyOperationsState(host).employeeLayout = layout;
  notify(host);
}

export function setAgencyEmployeeSearch(host: AgencyOperationsHost, search: string): void {
  ensureAgencyOperationsState(host).employeeSearch = search;
  notify(host);
}

export async function loadAgencyEmployeeDetail(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  employeeId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId) return;
  state.selectedEmployeeId = employeeId;
  state.employeeDetail = null;
  state.employeeMemory = [];
  state.secondaryLoading = true;
  state.activeSection = "employees";
  notify(host);
  // Memory, SOPs and channel bindings load alongside the profile: they are part
  // of who this employee is, not separate drill-ins the operator has to
  // discover. Each is independently fault isolated.
  void loadAgencyEmployeeMemory(host, client, employeeId);
  void loadAgencyEmployeeSops(host, client, employeeId);
  void loadAgencyEmployeeChannels(host, client, employeeId);
  try {
    state.employeeDetail = (await client.request("agency.ops.employee.detail", {
      agencyId,
      workerId: employeeId,
    })) as EmployeeDetail;
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryLoading = false;
    notify(host);
  }
}

export async function updateAgencyMemberRole(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  userId: string,
  role: "admin" | "member" | "viewer",
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = userId;
  notify(host);
  try {
    await client.request("agency.ops.member.role.update", { agencyId, userId, role });
    const member = state.members.find((item) => item.userId === userId);
    if (member) member.role = role;
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function removeAgencyMember(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  userId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = userId;
  notify(host);
  try {
    await client.request("agency.ops.member.remove", { agencyId, userId });
    state.members = state.members.filter((item) => item.userId !== userId);
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function planAgencyAssignmentTeam(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  assignment: WorkforceAssignment,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = assignment.id;
  state.hybridPlan = null;
  notify(host);
  try {
    const result = await client.request("agency.ops.assignment.hybrid-plan", {
      agencyId,
      requiredSkills: assignment.requiredSkills,
      requiredCapabilities: assignment.requiredCapabilities,
      estimatedHours: assignment.estimatedHours,
      maximumTeamSize: 4,
      requireHuman: true,
      requireAi: true,
    });
    const plan = unwrap<Omit<HybridTeamPlanSummary, "assignmentId"> | null>(result, "plan", null);
    state.hybridPlan = plan ? { ...plan, assignmentId: assignment.id } : null;
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function runAgencyEmployeeLoop(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = "employee-loop";
  notify(host);
  try {
    await client.request("agency.ops.employee.loop.tick", { agencyId });
    state.employeeLoopLastRunAt = Date.now();
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function transitionEmployeeWorkItem(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  workItemId: string,
  status: EmployeeWorkItemStatus,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = workItemId;
  notify(host);
  try {
    const result = await client.request("agency.ops.employee.work-item.transition", {
      agencyId,
      workItemId,
      status,
    });
    const updated = unwrap<EmployeeWorkItem | null>(result, "workItem", null);
    if (updated) {
      state.employeeWorkItems = state.employeeWorkItems.map((item) =>
        item.id === workItemId ? updated : item,
      );
    }
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export function setAgencyRestoreConfirmation(
  host: AgencyOperationsHost,
  value: string,
): void {
  ensureAgencyOperationsState(host).restoreConfirmation = value;
  notify(host);
}

export async function ensureAgencyDatabaseBackup(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = "backup-ensure";
  notify(host);
  try {
    await client.request("agency.ops.database.backup.ensure", { agencyId, maxAgeHours: 24 });
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function verifyAgencyDatabaseBackup(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  backupId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = backupId;
  notify(host);
  try {
    const result = await client.request("agency.ops.database.backup.verify", {
      agencyId,
      backupId,
    });
    const backup = unwrap<AgencyDatabaseBackup | null>(result, "backup", null);
    if (backup) {
      state.databaseBackups = state.databaseBackups.map((item) =>
        item.id === backupId ? backup : item,
      );
    }
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function prepareAgencyDatabaseRestore(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  backupId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = `restore:${backupId}`;
  notify(host);
  try {
    state.pendingRestore = (await client.request("agency.ops.database.restore.prepare", {
      agencyId,
      backupId,
    })) as AgencyRestorePlan;
    state.restoreConfirmation = "";
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function cancelAgencyDatabaseRestore(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  const plan = state.pendingRestore;
  if (!agencyId || !plan || state.secondaryBusyId) return;
  state.secondaryBusyId = plan.restoreId;
  notify(host);
  try {
    await client.request("agency.ops.database.restore.cancel", {
      agencyId,
      restoreId: plan.restoreId,
    });
    state.pendingRestore = null;
    state.restoreConfirmation = "";
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function activateAgencyDatabaseRestore(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  const plan = state.pendingRestore;
  if (
    !agencyId ||
    !plan ||
    state.restoreConfirmation !== plan.confirmation ||
    state.secondaryBusyId
  )
    return;
  state.secondaryBusyId = plan.restoreId;
  notify(host);
  try {
    await client.request("agency.ops.database.restore.activate", {
      agencyId,
      restoreId: plan.restoreId,
      confirmation: state.restoreConfirmation,
    });
    state.pendingRestore = null;
    state.restoreConfirmation = "";
    state.lastLoadedAt = null;
    await loadAgencyOperations(host, client);
  } catch (error) {
    state.error = message(error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/**
 * Opens or closes the conflict drill-in. The health banner only ever showed a
 * count, which told an operator something was wrong but not what — the list is
 * fetched lazily the first time it is opened.
 */
export async function toggleAgencyReplicationConflicts(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  state.replicationConflictsOpen = !state.replicationConflictsOpen;
  notify(host);
  if (!state.replicationConflictsOpen || !agencyId || state.replicationConflictsLoading) return;
  state.replicationConflictsLoading = true;
  notify(host);
  try {
    const result = await client.request("agency.ops.replication.conflicts.list", {
      agencyId,
      limit: 100,
    });
    state.replicationConflicts = unwrap<AgencyReplicationConflict[]>(result, "conflicts", []);
  } catch (error) {
    state.replicationConflicts = [];
    recordMutationFailure(state, "agency.ops.replication.conflicts.list", error);
  } finally {
    state.replicationConflictsLoading = false;
    notify(host);
  }
}

/**
 * Downloads this node's replication snapshot. With the federation master down,
 * this is the only way to move agency state to another node by hand.
 */
export async function exportAgencyReplicationSnapshot(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = "replication-export";
  state.replicationSnapshotNotice = null;
  notify(host);
  try {
    const result = await client.request("agency.ops.replication.export", { agencyId });
    const snapshot = unwrap<unknown>(result, "snapshot", null);
    if (typeof document !== "undefined" && typeof URL?.createObjectURL === "function") {
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `agency-${agencyId}-snapshot-${isoDate()}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    }
    state.replicationSnapshotNotice = "Snapshot exported. Keep it on encrypted storage.";
  } catch (error) {
    recordMutationFailure(state, "agency.ops.replication.export", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/**
 * Merges a snapshot exported from another node. The gateway rejects a snapshot
 * whose agency scope does not match, so a mis-picked file fails loudly.
 */
export async function importAgencyReplicationSnapshot(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  file: File,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = "replication-merge";
  state.replicationSnapshotNotice = null;
  notify(host);
  try {
    const snapshot = JSON.parse(await file.text()) as unknown;
    const result = await client.request("agency.ops.replication.merge", { agencyId, snapshot });
    const merge = unwrap<{ applied?: number; conflicts?: number } | null>(result, "merge", null);
    state.replicationSnapshotNotice = merge
      ? `Merged ${merge.applied ?? 0} row(s); ${merge.conflicts ?? 0} conflict(s) logged.`
      : "Snapshot merged.";
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    recordMutationFailure(state, "agency.ops.replication.merge", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/** Creates a recovery point immediately, rather than only when one has aged out. */
export async function createAgencyDatabaseBackup(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = "backup-create";
  notify(host);
  try {
    await client.request("agency.ops.database.backup.create", { agencyId });
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    recordMutationFailure(state, "agency.ops.database.backup.create", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export function setAgencyBackupRetention(
  host: AgencyOperationsHost,
  patch: { maxCount?: string; maxAgeDays?: string },
): void {
  const state = ensureAgencyOperationsState(host);
  if (patch.maxCount !== undefined) state.backupRetentionCount = patch.maxCount;
  if (patch.maxAgeDays !== undefined) state.backupRetentionDays = patch.maxAgeDays;
  notify(host);
}

/**
 * Applies the retention policy. The server always keeps the newest recovery
 * point regardless of policy, so this can never leave the agency unrecoverable.
 */
export async function pruneAgencyDatabaseBackups(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = "backup-prune";
  state.backupPruneResult = null;
  notify(host);
  try {
    const result = (await client.request("agency.ops.database.backups.prune", {
      agencyId,
      maxCount: Number(state.backupRetentionCount) || 14,
      maxAgeDays: Number(state.backupRetentionDays) || 30,
    })) as AgencyBackupPruneResult;
    state.backupPruneResult = result;
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    recordMutationFailure(state, "agency.ops.database.backups.prune", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/** Reads the migration ledger directly instead of the summary inside health. */
export async function loadAgencyDatabaseSchemaStatus(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = "schema-status";
  notify(host);
  try {
    state.schemaStatus = (await client.request("agency.ops.database.schema.status", {
      agencyId,
    })) as AgencyDatabaseSchemaStatus;
  } catch (error) {
    recordMutationFailure(state, "agency.ops.database.schema.status", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export function setAgencyMigrationConfirmation(
  host: AgencyOperationsHost,
  value: string,
): void {
  ensureAgencyOperationsState(host).migrationConfirmation = value;
  notify(host);
}

/** Dry run: reports what a re-import would touch without writing anything. */
export async function previewAgencyMigration(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (state.secondaryBusyId) return;
  state.secondaryBusyId = "migration-preview";
  notify(host);
  try {
    state.migrationPreview = (await client.request(
      "agency.ops.migration.preview",
      {},
    )) as LegacyMigrationReport;
  } catch (error) {
    recordMutationFailure(state, "agency.ops.migration.preview", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/** The exact phrase an operator must type before the forced re-import runs. */
export const AGENCY_MIGRATION_CONFIRMATION = "RE-IMPORT";

/**
 * Runs the legacy import. The gateway passes `force: true`, so this is a full
 * re-import of every legacy business, client, project and task — expensive on a
 * large dataset and never a no-op. The confirm-by-typing gate is deliberate.
 */
export async function runAgencyMigration(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (state.secondaryBusyId || state.migrationConfirmation !== AGENCY_MIGRATION_CONFIRMATION) return;
  state.secondaryBusyId = "migration-run";
  notify(host);
  try {
    state.migrationReport = (await client.request(
      "agency.ops.migration.run",
      {},
    )) as LegacyMigrationReport;
    state.migrationConfirmation = "";
    state.migrationPreview = null;
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    recordMutationFailure(state, "agency.ops.migration.run", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/**
 * Scores every active worker against one assignment's requirements. The hybrid
 * planner already proposes a team; this answers the different question of "why
 * was this person left out, and who else could do it".
 */
export async function checkAgencyAssignmentSuitability(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  assignment: WorkforceAssignment,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const agencyId = state.selectedAgencyId;
  if (!agencyId || state.secondaryBusyId) return;
  state.secondaryBusyId = `suitability:${assignment.id}`;
  state.suitability = null;
  notify(host);
  try {
    const result = await client.request("agency.ops.assignment.suitability", {
      agencyId,
      requiredSkills: assignment.requiredSkills,
      requiredCapabilities: assignment.requiredCapabilities,
      estimatedHours: assignment.estimatedHours,
    });
    state.suitability = {
      assignmentId: assignment.id,
      results: unwrap<AgencySuitabilityResult[]>(result, "recommendations", []),
    };
  } catch (error) {
    recordMutationFailure(state, "agency.ops.assignment.suitability", error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

export async function switchAgencyOperationsAgency(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  agencyId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  if (state.selectedAgencyId === agencyId) return;
  state.selectedAgencyId = agencyId;
  persistSelectedAgencyId(agencyId);
  state.lastLoadedAt = null;
  notify(host);
  await loadAgencyOperations(host, client);
}
