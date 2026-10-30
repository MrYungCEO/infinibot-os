/**
 * Deep Memory Architecture — Type Definitions
 * 
 * Persistent project sessions with crash recovery, progress tracking,
 * and synchronized state for 10+ concurrent agents.
 */

// ═══════════════════════════════════════════════════════════════════
// PROJECT SESSION — The core unit of persistent work
// ═══════════════════════════════════════════════════════════════════

export interface ProjectSession {
  id: string;                          // UUID
  projectId: string;                   // Human-readable slug (e.g., "sovereignty-v1")
  name: string;                        // Display name
  description?: string;                // Brief one-liner description (plain text)

  // Rich documentation
  richDescription?: string;            // Full markdown body (overview, architecture, links, etc.)
  techStack?: string[];                // e.g., ["TypeScript", "Vite", "SQLite"]
  notes?: ProjectNote[];               // Timestamped freeform notes
  attachments?: ProjectAttachment[];   // Files / URLs related to this project

  // Assignment
  agentId: string;                     // Which agent owns this session
  sessionKey: string;                  // InfiniBot session key
  
  // State
  status: ProjectStatus;
  progress: ProjectProgress;
  
  // Persistence
  workspacePath: string;               // Project metadata directory (TASK.md, checkpoints)
  workingDir?: string;                 // Code/work directory for agent operations
  checkpointId?: string;               // Last checkpoint ID
  
  // Context injection
  contextFiles?: string[];             // Files to inject into agent context (relative to workingDir)
  contextGlobs?: string[];             // Glob patterns for context files
  
  // Timing
  createdAt: number;                   // Unix timestamp
  startedAt?: number;                  // When work began
  pausedAt?: number;                   // When paused (if paused)
  completedAt?: number;                // When finished
  lastActivityAt: number;              // Last heartbeat/update
  
  // Crash recovery
  heartbeatAt?: number;                // Last heartbeat timestamp
  staleTimeoutMs: number;              // Consider stale after this
  recoveryAttempts: number;            // How many times we've tried to recover
  maxRecoveryAttempts: number;         // Give up after this many
}

export type ProjectStatus = 
  | 'pending'       // Created but not started
  | 'running'       // Actively being worked on
  | 'paused'        // Intentionally paused
  | 'stale'         // No heartbeat, may need recovery
  | 'recovering'    // Attempting to resume
  | 'completed'     // Successfully finished
  | 'failed'        // Failed after retries
  | 'cancelled';    // Manually cancelled

// ═══════════════════════════════════════════════════════════════════
// PROGRESS — Granular progress tracking
// ═══════════════════════════════════════════════════════════════════

export interface ProjectProgress {
  percent: number;                     // 0-100
  currentStep: number;                 // 1-indexed
  totalSteps: number;
  currentStepLabel?: string;           // Human-readable current step
  subtasks: Subtask[];
  
  // Context window tracking
  contextTokens: number;               // Current context usage
  maxContextTokens: number;            // Model's max context
  contextPercent: number;              // Derived: contextTokens / maxContextTokens * 100
  
  // Timing
  estimatedRemainingMs?: number;       // ETA if calculable
  elapsedMs: number;                   // Time spent so far
}

export interface Subtask {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  percent: number;                     // 0-100 for this subtask
  startedAt?: number;
  completedAt?: number;
  notes?: string;
}

// ═══════════════════════════════════════════════════════════════════
// PROJECT CONTENT — Notes & attachments
// ═══════════════════════════════════════════════════════════════════

export interface ProjectNote {
  id: string;
  body: string;                        // Markdown
  createdAt: number;
  author?: string;                     // agentId or username
  pinned?: boolean;
  tags?: string[];
}

export type AttachmentKind = 'file' | 'url' | 'image' | 'doc' | 'repo' | 'other';

export interface ProjectAttachment {
  id: string;
  kind: AttachmentKind;
  label: string;
  // Exactly one of these will typically be set:
  url?: string;                        // External URL
  path?: string;                       // Local filesystem path (relative to workingDir if set)
  description?: string;
  addedAt: number;
  addedBy?: string;
}

// ═══════════════════════════════════════════════════════════════════
// CHECKPOINT — Point-in-time state snapshot for crash recovery
// ═══════════════════════════════════════════════════════════════════

export interface Checkpoint {
  id: string;                          // UUID
  projectSessionId: string;            // Parent session
  
  // State snapshot
  progress: ProjectProgress;
  contextSnapshot?: ContextSnapshot;   // Serialized conversation state
  workingState?: Record<string, unknown>; // Arbitrary agent state
  
  // Metadata
  createdAt: number;
  reason: CheckpointReason;
  notes?: string;
  
  // File reference
  filePath?: string;                   // Path to full checkpoint file on disk
}

export type CheckpointReason = 
  | 'auto'          // Periodic automatic checkpoint
  | 'milestone'     // Major milestone reached
  | 'subtask'       // Subtask completed
  | 'manual'        // Manually triggered
  | 'pre_pause'     // Before intentional pause
  | 'pre_delegate'  // Before delegating to another agent
  | 'error'         // After recovering from error
  | 'context_trim'; // Before context window trimming

export interface ContextSnapshot {
  sessionKey: string;
  transcriptPath: string;              // Path to conversation JSONL
  messageCount: number;
  tokenCount: number;
  lastMessageAt: number;
  truncatedAt?: number;                // If context was trimmed
}

// ═══════════════════════════════════════════════════════════════════
// TASK.md — Mission document format
// ═══════════════════════════════════════════════════════════════════

export interface TaskDocument {
  // Header
  projectName: string;
  projectId: string;
  
  // Mission
  mission: string;                     // Primary goal
  successCriteria: string[];           // Checklist items
  
  // Progress (synced with ProjectProgress)
  currentStep: number;
  totalSteps: number;
  percent: number;
  
  // Subtasks (rendered as checklist)
  subtasks: TaskSubtask[];
  
  // Context metadata
  assignedAgent: string;
  startedAt?: string;                  // ISO date
  lastCheckpoint?: string;             // ISO date
  sessionKey: string;
  
  // Notes section (free-form)
  notes: string[];
}

export interface TaskSubtask {
  label: string;
  status: 'pending' | 'in_progress' | 'completed';
  percent: number;
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT LOG — Full history of what happened
// ═══════════════════════════════════════════════════════════════════

export interface AuditEntry {
  id: string;
  projectSessionId: string;
  timestamp: number;
  event: AuditEvent;
  agentId: string;
  details?: Record<string, unknown>;
}

export type AuditEvent =
  | 'session_created'
  | 'session_started'
  | 'session_paused'
  | 'session_resumed'
  | 'session_completed'
  | 'session_failed'
  | 'session_cancelled'
  | 'checkpoint_created'
  | 'checkpoint_restored'
  | 'progress_updated'
  | 'subtask_started'
  | 'subtask_completed'
  | 'context_trimmed'
  | 'stale_detected'
  | 'recovery_started'
  | 'recovery_succeeded'
  | 'recovery_failed'
  | 'delegated_to'
  | 'delegated_from';

// ═══════════════════════════════════════════════════════════════════
// REGISTRY — Master index of all projects
// ═══════════════════════════════════════════════════════════════════

export interface ProjectRegistry {
  version: number;
  projects: ProjectSummary[];
  lastUpdatedAt: number;
}

export interface ProjectSummary {
  id: string;
  projectId: string;
  name: string;
  status: ProjectStatus;
  agentId: string;
  percent: number;
  lastActivityAt: number;
}

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD STATE — For UI rendering
// ═══════════════════════════════════════════════════════════════════

export interface ProjectDashboardState {
  sessions: ProjectSession[];
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;
  filter: ProjectStatusFilter;
  sortBy: ProjectSortField;
  sortOrder: 'asc' | 'desc';
}

export type ProjectStatusFilter = 'all' | 'active' | 'completed' | 'failed' | 'paused';
export type ProjectSortField = 'name' | 'progress' | 'lastActivity' | 'agent';

// ═══════════════════════════════════════════════════════════════════
// AGENT TOOL INPUTS/OUTPUTS
// ═══════════════════════════════════════════════════════════════════

export interface CreateProjectInput {
  projectId: string;                   // Slug like "sovereignty-v1"
  name: string;
  description?: string;
  mission: string;
  successCriteria: string[];
  subtasks: string[];                  // Labels for initial subtasks
  agentId?: string;                    // Defaults to current agent

  // Rich content
  richDescription?: string;            // Full markdown
  techStack?: string[];
  notes?: Array<string | Partial<ProjectNote>>; // Strings get wrapped into notes
  attachments?: Array<Partial<ProjectAttachment> & { label: string; kind?: AttachmentKind }>;
}

export interface UpdateProjectInput {
  projectSessionId?: string;
  projectId?: string;

  // Replaceable fields
  name?: string;
  description?: string;
  richDescription?: string;
  techStack?: string[];                // Replaces full list when provided

  // Additive content (passed alongside techStack/notes/attachments)
  addTechStack?: string[];
  removeTechStack?: string[];

  addNotes?: Array<string | Partial<ProjectNote>>;
  removeNoteIds?: string[];

  addAttachments?: Array<Partial<ProjectAttachment> & { label: string; kind?: AttachmentKind }>;
  removeAttachmentIds?: string[];
}

export interface UpdateProgressInput {
  projectSessionId: string;
  currentStep?: number;
  currentStepLabel?: string;
  subtaskUpdates?: Array<{
    id?: string;                       // ID or index
    index?: number;
    status?: 'pending' | 'in_progress' | 'completed' | 'skipped';
    percent?: number;
    notes?: string;
  }>;
  notes?: string;                      // Append to notes
  checkpoint?: boolean;                // Create checkpoint after update
  checkpointReason?: CheckpointReason;
}

export interface ProjectToolResult {
  success: boolean;
  error?: string;
  session?: ProjectSession;
  checkpoint?: Checkpoint;
  message?: string;
}
