import type { CommunicationProfile } from "./communication.js";
import type { WorkerExecutionProfile } from "./execution-profile.js";

export type WorkerType = "human" | "ai";
export type EmploymentStatus = "active" | "on_leave" | "inactive" | "terminated";
export type EmploymentType = "employee" | "contractor" | "agent";
export type AssignmentStatus =
  | "planned"
  | "active"
  | "blocked"
  | "review"
  | "completed"
  | "cancelled";
export type AssignmentRole = "owner" | "contributor" | "reviewer" | "approver";
export type ProficiencyLevel = 1 | 2 | 3 | 4 | 5;

export interface Department {
  id: string;
  agencyId: string;
  name: string;
  description: string;
  managerWorkerId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkerSkill {
  skill: string;
  level: ProficiencyLevel;
  yearsExperience: number;
  verifiedAt: number | null;
}

export interface Worker {
  id: string;
  agencyId: string;
  type: WorkerType;
  displayName: string;
  email: string | null;
  title: string;
  departmentId: string | null;
  employmentStatus: EmploymentStatus;
  employmentType: EmploymentType;
  timezone: string;
  weeklyCapacityHours: number;
  availabilityPercent: number;
  costRate: number;
  currency: string;
  agentId: string | null;
  /**
   * Model / CLI backend this worker executes on (e.g. "claude", "codex",
   * "anthropic/claude-opus-4-6"). Null means "use the gateway default".
   */
  modelBinding: string | null;
  persona: string | null;
  goals: string[];
  kpis: string[];
  autonomyLevel: 0 | 1 | 2 | 3;
  approvalThreshold: number;
  /**
   * Legacy one-line cadence. Retained for backwards compatibility and kept
   * readable: writing a `communicationProfile` refreshes this with a rendered
   * summary, and the operator's original text survives in
   * `communicationProfile.legacyCadence`.
   */
  communicationCadence: string;
  /**
   * Structured communication profile. Null on rows never edited since the
   * feature landed — use `resolveCommunicationProfile()`, which migrates the
   * legacy string on read without writing.
   */
  communicationProfile: CommunicationProfile | null;
  /**
   * Per-worker runtime knobs (backend fallback, tool allowlist, timeout, max
   * concurrency). Null means "inherit every gateway default", which is exactly
   * how rows behaved before the feature landed.
   */
  executionProfile: WorkerExecutionProfile | null;
  sopPath: string | null;
  workspacePath: string | null;
  currentStatus: string;
  lastHeartbeatAt: number | null;
  managerWorkerId: string | null;
  permissions: string[];
  capabilities: string[];
  metadata: Record<string, unknown>;
  skills: WorkerSkill[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkerInput {
  id?: string;
  agencyId: string;
  type: WorkerType;
  displayName: string;
  email?: string | null;
  title?: string;
  departmentId?: string | null;
  employmentStatus?: EmploymentStatus;
  employmentType?: EmploymentType;
  timezone?: string;
  weeklyCapacityHours?: number;
  availabilityPercent?: number;
  costRate?: number;
  currency?: string;
  agentId?: string | null;
  modelBinding?: string | null;
  persona?: string | null;
  goals?: string[];
  kpis?: string[];
  autonomyLevel?: 0 | 1 | 2 | 3;
  approvalThreshold?: number;
  communicationCadence?: string;
  communicationProfile?: CommunicationProfile | null;
  executionProfile?: WorkerExecutionProfile | null;
  sopPath?: string | null;
  workspacePath?: string | null;
  currentStatus?: string;
  lastHeartbeatAt?: number | null;
  managerWorkerId?: string | null;
  permissions?: string[];
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  skills?: WorkerSkill[];
}

export interface AssignmentMember {
  workerId: string;
  role: AssignmentRole;
  allocatedHours: number;
  worker?: Worker;
}

export interface Assignment {
  id: string;
  agencyId: string;
  title: string;
  description: string;
  projectId: string | null;
  taskId: string | null;
  status: AssignmentStatus;
  priority: number;
  startsAt: number | null;
  dueAt: number | null;
  estimatedHours: number;
  requiredSkills: SkillRequirement[];
  requiredCapabilities: string[];
  members: AssignmentMember[];
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AssignmentInput {
  id?: string;
  agencyId: string;
  title: string;
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  status?: AssignmentStatus;
  priority?: number;
  startsAt?: number | null;
  dueAt?: number | null;
  estimatedHours?: number;
  requiredSkills?: SkillRequirement[];
  requiredCapabilities?: string[];
  members?: AssignmentMember[];
  createdBy?: string | null;
}

export interface SkillRequirement {
  skill: string;
  minimumLevel: ProficiencyLevel;
  weight?: number;
}

export interface TimeEntry {
  id: string;
  agencyId: string;
  workerId: string;
  assignmentId: string;
  hours: number;
  billable: boolean;
  note: string;
  occurredOn: string;
  createdAt: number;
}

export interface PerformanceReview {
  id: string;
  agencyId: string;
  workerId: string;
  reviewerWorkerId: string | null;
  periodStart: string;
  periodEnd: string;
  qualityScore: number;
  reliabilityScore: number;
  collaborationScore: number;
  goals: string[];
  feedback: string;
  createdAt: number;
}

export interface OutcomeMetric {
  id: string;
  agencyId: string;
  workerId: string;
  assignmentId: string | null;
  metric: string;
  value: number;
  target: number | null;
  unit: string;
  recordedAt: number;
}

export interface AuditEntry {
  id: string;
  agencyId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: number;
}

export interface WorkerCapacity {
  workerId: string;
  displayName: string;
  type: WorkerType;
  weeklyCapacityHours: number;
  effectiveCapacityHours: number;
  allocatedHours: number;
  loggedHours: number;
  remainingHours: number;
  utilizationPercent: number;
  overAllocated: boolean;
}

export interface DailyRosterEntry extends WorkerCapacity {
  title: string;
  timezone: string;
  currentStatus: string;
  lastHeartbeatAt: number | null;
  activeAssignments: number;
}

export interface PerformanceScorecard {
  workerId: string;
  displayName: string;
  reviewCount: number;
  qualityScore: number | null;
  reliabilityScore: number | null;
  collaborationScore: number | null;
  outcomeAttainmentPercent: number | null;
  loggedHours: number;
  completedAssignments: number;
}

export interface DepartmentCapacity {
  departmentId: string | null;
  departmentName: string;
  headcount: number;
  humanCount: number;
  aiCount: number;
  effectiveCapacityHours: number;
  allocatedHours: number;
  remainingHours: number;
}

export interface SuitabilityRequest {
  requiredSkills?: SkillRequirement[];
  requiredCapabilities?: string[];
  estimatedHours?: number;
  preferredType?: WorkerType;
  maximumHourlyCost?: number;
}

export interface SuitabilityResult {
  workerId: string;
  eligible: boolean;
  score: number;
  skillCoverage: number;
  availableHours: number;
  reasons: string[];
  missingSkills: string[];
  missingCapabilities: string[];
}

export interface HybridTeamRequest extends SuitabilityRequest {
  requireHuman?: boolean;
  requireAi?: boolean;
  maximumTeamSize?: number;
}

export interface HybridTeamPlan {
  members: Array<{ worker: Worker; allocatedHours: number; suitability: SuitabilityResult }>;
  skillCoverage: number;
  totalHourlyCost: number;
  estimatedCost: number;
  warnings: string[];
}

export type WorkItemStatus =
  | "queued"
  | "accepted"
  | "in_progress"
  | "waiting"
  | "review"
  | "completed"
  | "cancelled"
  | "escalated";
export type WorkItemPriority = "low" | "normal" | "high" | "urgent";

export interface EmployeeWorkItem {
  id: string;
  agencyId: string;
  workerId: string;
  managerWorkerId: string | null;
  responsibilityId: string | null;
  title: string;
  instructions: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  scheduledFor: number;
  dueAt: number | null;
  acceptedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  escalationLevel: number;
  escalatedAt: number | null;
  waitingReason: string | null;
  reviewNote: string | null;
  idempotencyKey: string | null;
  context: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface EmployeeSchedule {
  id: string;
  agencyId: string;
  workerId: string;
  timezone: string;
  weekdays: number[];
  shiftStart: string;
  shiftEnd: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RecurringResponsibility {
  id: string;
  agencyId: string;
  workerId: string;
  managerWorkerId: string | null;
  title: string;
  instructions: string;
  cadence: "daily" | "weekly" | "monthly";
  interval: number;
  weekday: number | null;
  monthDay: number | null;
  runAt: string;
  slaMinutes: number;
  priority: WorkItemPriority;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  context: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ManagerReviewCycle {
  id: string;
  agencyId: string;
  workerId: string;
  managerWorkerId: string;
  cadenceDays: number;
  nextReviewAt: number;
  lastReviewAt: number | null;
  status: "scheduled" | "due" | "completed" | "overdue";
  agenda: string[];
  outcome: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobMemoryRecord {
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

export interface OperatingLoopTickResult {
  generatedWorkItemIds: string[];
  escalatedWorkItemIds: string[];
  dueReviewCycleIds: string[];
}
