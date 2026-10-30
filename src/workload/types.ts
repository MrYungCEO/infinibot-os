export type WorkEventKind =
  | "subagent_started"
  | "subagent_completed"
  | "subagent_failed"
  | "kanban_task_completed"
  | "workflow_run_completed"
  | "gateway_tool_invocation"
  | "voice_session_ended"
  | "edit_session"
  | "work_review_emitted"
  | "manual";

export type WorkEventSource =
  | "subagent_registry"
  | "kanban"
  | "workflow"
  | "voice"
  | "editor"
  | "manual"
  | "gateway";

export interface WorkEvent {
  ts: number;
  kind: WorkEventKind;
  source: WorkEventSource;
  durationMs?: number;
  label: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkloadSummary {
  date: string;
  totalMs: number;
  byKind: Partial<Record<WorkEventKind, number>>;
  bySource: Partial<Record<WorkEventSource, number>>;
  /** Top projects by duration (ms). */
  byProject: Array<{ projectId: string; label: string; totalMs: number }>;
  eventCount: number;
}

export interface WorkloadWeeklyStats {
  /** ISO date of the day. */
  date: string;
  totalMs: number;
  eventCount: number;
}

export interface ActiveBlock {
  id: string;
  label: string;
  startTs: number;
  projectId?: string;
  taskId?: string;
}
