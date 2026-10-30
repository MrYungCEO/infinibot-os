export type TaskStatus = "backlog" | "todo" | "in_progress" | "review" | "done";

export type ProjectStatus =
  | "Not started"
  | "In progress"
  | "Completed"
  | "Paused"
  | "Updating"
  | "Awaiting Client"
  | "Reviewing"
  | "Cancelled";

export type PriorityLevel = "Immediate" | "High" | "Medium" | "Low";

export interface KanbanProject {
  id: string;
  name: string;
  description?: string;
  color?: string; // Hex code
  type?: string[]; // e.g. ["AI Projects"]
  status?: ProjectStatus;
  priority?: PriorityLevel;
  progress?: number;
  taskCount?: number;
  coverUrl?: string;
  productUrl?: string;
  dueDate?: string;
  notionId?: string;
  // Style customization
  customIcon?: string; // Emoji or "icon:<id>" for SVG icons
  iconColor?: string; // Hex color for icons
  textColor?: string; // Notion-style text color id
  bgColor?: string; // Notion-style background color id
  borderColor?: string; // Hex color for the card border
  borderWidth?: number; // Border width in px (0 = no border)
  borderStyle?: "solid" | "dashed" | "dotted"; // Border line style
  // Federation properties
  primaryNode?: string; // Default node for this project (e.g., "master", "desktop-pc")
  nodes?: string[]; // All nodes assigned to this project (e.g., ["master", "robo1", "robo2"])
  nodeIds?: string[]; // Federation device IDs associated with this project (multi-select)
  projectDirectory?: string; // Full path on target node (e.g., "C:\\Projects\\myapp")
  shared?: boolean; // Available to all nodes in the federation
  // Cash-flow tracking — surfaced on /projects so each project shows how much
  // has been collected vs. what is still outstanding. Stored as USD numbers;
  // formatting happens in the UI. Dates are ISO strings (yyyy-mm-dd) that
  // scope the amount to a specific month / invoice cycle.
  paidAmount?: number;
  pendingPay?: number;
  paidAmountDate?: string;
  pendingPayDate?: string;
  /** Monthly recurring revenue (USD). Manually set on the project header
   *  popover; rolls up into the Agency Operations MRR statistic. */
  mrr?: number;
  /** Invoice IDs from the agency-operations store linked to this project. When set,
   *  paidAmount/pendingPay are computed from these invoices and the raw fields are
   *  read-only display values. */
  linkedInvoiceIds?: string[];
  // Parent-child hierarchy
  parentProjectId?: string | null; // null = top-level, string = child of that project
  // Ordering
  rank?: number; // Vertical position in project list (lower = higher up)
  phases?: ProjectPhase[];
  createdAt: number;
  updatedAt: number;
}

export type ProjectPhaseStatus = "planned" | "active" | "done" | "skipped";

export interface ProjectPhase {
  id: string;
  projectId: string;
  name: string;
  ordinal: number;
  dueDate?: string;
  status: ProjectPhaseStatus;
  description?: string;
  notionId?: string;
  createdAt: number;
  updatedAt: number;
}

export type AutonomousStatus =
  | "pending_preflight"
  | "pending_approval"
  | "approved"
  | "in_progress"
  | "blocked"
  | "testing"
  | "complete"
  | "failed";

// Valid compute requirement tags for federation routing
export type ComputeRequirement = "GPU" | "Voice" | "MCP" | "Local" | "Heavy";

/**
 * Complexity bucket controlling how `content-builder` renders `KanbanTask.content`
 * and whether `auto-skill` synthesizes a workspace SKILL.md for the task.
 */
export type TaskComplexity = "trivial" | "simple" | "standard" | "robust";

/**
 * Reference to an auto-generated workspace skill captured from a robust task.
 * Stored on the task so future agents can replay the captured playbook.
 */
export interface TaskSkillRef {
  id: string;
  name: string;
  path: string;
  reason: string;
  createdAt: number;
}

export interface KanbanTask {
  id: string;
  projectId: string;
  phaseId?: string | null;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string; // "agent" or "user" or specific ID
  priority?: string;
  tags?: string[];
  assignedAgent?: string | null;
  requiredSpecialties?: string[];
  requiredTools?: string[];
  // Autonomous agent assignment
  autonomous?: boolean;
  autonomousStatus?: AutonomousStatus;
  // Notion-synced fields
  notionId?: string;
  done?: boolean;
  dueDate?: string;
  department?: string[];
  priorityLevel?: PriorityLevel;
  projectType?: string;
  classification?: string;
  funnelStage?: string;
  // Style customization
  customIcon?: string; // Emoji or "icon:<id>" for SVG icons
  iconColor?: string; // Hex color for icons
  textColor?: string; // Notion-style text color id
  bgColor?: string; // Notion-style background color id
  effectPreset?: string; // UI animation effect (glow, pulse, rainbow, fire, etc.)
  // Federation properties
  node?: string; // Which node owns this task (e.g., "master", "desktop-pc")
  nodeIds?: string[]; // Federation device IDs this task touches (multi-select, separate from assignee)
  directory?: string; // Workspace path for this task
  computeRequirements?: ComputeRequirement[]; // [GPU, Voice, MCP, Local, Heavy]
  delegatedTo?: string; // Agent/Node handling this task
  sourceNode?: string; // Where task was created
  // ── Database / page association ──
  // Tasks can be attached to any database (system role like "tasks"/"notes"
  // or any custom one) and optionally a specific row/page within it.
  // The four fields below are progressively more freeform fallbacks so the
  // UI can offer system DBs as defaults *and* accept a pasted slug or URL.
  associatedDatabaseId?: string; // Hard FK to a DatabaseRecord.id
  associatedRowId?: string; // Hard FK to a DatabaseRow.id (page)
  associatedSlug?: string; // "<dbSlug>" or "<dbSlug>/<pageSlug>" form
  associatedUrl?: string; // Fully external URL (Notion, web, etc.)
  // Ordering
  rank?: number; // Vertical position within status column (lower = higher up)
  createdAt: number;
  updatedAt: number;
  /** Unix ms when the task was moved to "done". Set on the transition; never cleared. */
  completedAt?: number;
  /**
   * Markdown body for the task scaled to `complexity`. Built by
   * `src/tasks/content-builder.ts` at every task-creation callsite.
   */
  content?: string;
  /** Complexity bucket — controls content depth and auto-skill generation. */
  complexity?: TaskComplexity;
  /** Reference to an auto-generated workspace skill (robust tasks only). */
  skillRef?: TaskSkillRef;
}

export interface KanbanState {
  projects: KanbanProject[];
  tasks: KanbanTask[];
}
