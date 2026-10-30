/**
 * Deep Memory Architecture — Project Tool
 *
 * Agent tool for creating projects, updating progress, and managing state.
 * Integrates with InfiniBot's tool system.
 */

import { getProjectStore, type ProjectStore } from "./store.js";
import { getCheckpointManager, type CheckpointManager } from "./checkpoint.js";
import { getRecoveryManager, type RecoveryManager } from "./recovery.js";
import { initProjectTask, writeTaskFile, sessionToTaskDocument } from "./task-parser.js";
import { syncSessionToKanban } from "./kanban-sync.js";
import type {
  ProjectSession,
  ProjectProgress,
  ProjectNote,
  ProjectAttachment,
  AttachmentKind,
  UpdateProgressInput,
  ProjectToolResult,
  Subtask,
  CheckpointReason,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────
// CONTENT NORMALIZATION HELPERS
// ─────────────────────────────────────────────────────────────────

function generateContentId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeNotes(
  raw: Array<string | Partial<ProjectNote>> | undefined,
  author: string,
): ProjectNote[] {
  if (!raw || raw.length === 0) return [];
  const now = Date.now();
  return raw.map((entry) => {
    if (typeof entry === "string") {
      return {
        id: generateContentId("note"),
        body: entry,
        createdAt: now,
        author,
      };
    }
    return {
      id: entry.id ?? generateContentId("note"),
      body: entry.body ?? "",
      createdAt: entry.createdAt ?? now,
      author: entry.author ?? author,
      pinned: entry.pinned,
      tags: entry.tags,
    };
  });
}

function normalizeAttachments(
  raw: Array<Partial<ProjectAttachment> & { label: string; kind?: AttachmentKind }> | undefined,
  author: string,
): ProjectAttachment[] {
  if (!raw || raw.length === 0) return [];
  const now = Date.now();
  return raw.map((entry) => ({
    id: entry.id ?? generateContentId("att"),
    kind: entry.kind ?? (entry.url ? "url" : entry.path ? "file" : "other"),
    label: entry.label,
    url: entry.url,
    path: entry.path,
    description: entry.description,
    addedAt: entry.addedAt ?? now,
    addedBy: entry.addedBy ?? author,
  }));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// PROJECT TOOL HANDLER
// ═══════════════════════════════════════════════════════════════════

export interface ProjectToolAction {
  action:
    | "create"
    | "list"
    | "get"
    | "start"
    | "pause"
    | "resume"
    | "complete"
    | "cancel"
    | "update_progress"
    | "update_project"
    | "checkpoint"
    | "heartbeat"
    | "recover"
    | "stats";

  // For create
  projectId?: string;
  name?: string;
  description?: string;
  mission?: string;
  successCriteria?: string[];
  subtasks?: string[];

  // Rich content (used by create + update_project)
  richDescription?: string;
  techStack?: string[];
  projectNotes?: Array<string | Partial<ProjectNote>>;
  attachments?: Array<Partial<ProjectAttachment> & { label: string; kind?: AttachmentKind }>;

  // For update_project — additive / removal
  addTechStack?: string[];
  removeTechStack?: string[];
  addNotes?: Array<string | Partial<ProjectNote>>;
  removeNoteIds?: string[];
  addAttachments?: Array<Partial<ProjectAttachment> & { label: string; kind?: AttachmentKind }>;
  removeAttachmentIds?: string[];

  // For get/update/control
  sessionId?: string;

  // For update_progress
  currentStep?: number;
  currentStepLabel?: string;
  subtaskUpdates?: Array<{
    index: number;
    status?: "pending" | "in_progress" | "completed" | "skipped";
    percent?: number;
    notes?: string;
  }>;
  notes?: string;

  // For checkpoint
  checkpointReason?: CheckpointReason;
  checkpointNotes?: string;

  // For context tracking
  contextTokens?: number;

  // Agent context (injected by gateway)
  agentId?: string;
  sessionKey?: string;
}

export async function handleProjectTool(
  params: ProjectToolAction,
  stateDir?: string,
): Promise<ProjectToolResult> {
  const store = getProjectStore(stateDir);
  const checkpoints = getCheckpointManager(stateDir);
  const recovery = getRecoveryManager(stateDir);

  const agentId = params.agentId ?? "main";

  try {
    switch (params.action) {
      case "create":
        return handleCreate(store, params, agentId, stateDir);

      case "list":
        return handleList(store);

      case "get":
        return handleGet(store, params);

      case "start":
        return handleStart(store, params, agentId);

      case "pause":
        return handlePause(recovery, params);

      case "resume":
        return handleResume(recovery, params);

      case "complete":
        return handleComplete(recovery, params);

      case "cancel":
        return handleCancel(recovery, params);

      case "update_progress":
        return handleUpdateProgress(store, params, agentId, stateDir);

      case "update_project":
        return handleUpdateProject(store, params, agentId);

      case "checkpoint":
        return handleCheckpoint(store, checkpoints, params);

      case "heartbeat":
        return handleHeartbeat(store, params);

      case "recover":
        return handleRecover(recovery, params);

      case "stats":
        return handleStats(store);

      default:
        return { success: false, error: `Unknown action: ${(params as any).action}` };
    }
  } catch (error: any) {
    console.error("[project-tool] Error:", error);
    return { success: false, error: error.message ?? String(error) };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════

function handleCreate(
  store: ProjectStore,
  params: ProjectToolAction,
  agentId: string,
  stateDir?: string,
): ProjectToolResult {
  if (!params.projectId || !params.name || !params.mission) {
    return { success: false, error: "projectId, name, and mission are required" };
  }

  // Check if project already exists
  const existing = store.getSessionByProjectId(params.projectId);
  if (existing) {
    return { success: false, error: `Project ${params.projectId} already exists` };
  }

  // Create project directory and TASK.md
  const projectDir = store.ensureProjectDir(params.projectId);

  const subtaskLabels = params.subtasks ?? [];
  const subtasks: Subtask[] = subtaskLabels.map((label, i) => ({
    id: `subtask-${i + 1}`,
    label,
    status: "pending",
    percent: 0,
  }));

  const progress: ProjectProgress = {
    percent: 0,
    currentStep: 1,
    totalSteps: subtasks.length || 1,
    currentStepLabel: subtasks[0]?.label,
    subtasks,
    contextTokens: 0,
    maxContextTokens: 200000,
    contextPercent: 0,
    elapsedMs: 0,
  };

  // Create session in DB
  const session = store.createSession({
    id: undefined as any, // Will be generated
    projectId: params.projectId!,
    name: params.name!,
    description: params.description ?? params.mission,
    richDescription: params.richDescription,
    techStack: params.techStack ? dedupeStrings(params.techStack) : undefined,
    notes: normalizeNotes(params.projectNotes, agentId),
    attachments: normalizeAttachments(params.attachments, agentId),
    agentId,
    sessionKey: params.sessionKey ?? "",
    status: "pending",
    progress,
    workspacePath: projectDir,
    staleTimeoutMs: 300000, // 5 minutes
    maxRecoveryAttempts: 3,
  });

  // Write TASK.md
  initProjectTask(projectDir, {
    projectId: params.projectId!,
    name: params.name!,
    mission: params.mission!,
    successCriteria: params.successCriteria ?? [],
    subtasks: subtaskLabels,
    agentId,
    sessionKey: params.sessionKey ?? "",
  });

  // Sync to Kanban/Notion
  syncSessionToKanban(session).catch((err) => {
    console.error(`[project-tool] Failed to sync to Kanban:`, err);
  });

  return {
    success: true,
    session,
    message: `Created project "${params.name}" (${params.projectId}) with ${subtasks.length} subtasks`,
  };
}

function handleList(store: ProjectStore): ProjectToolResult {
  const sessions = store.listSessions();
  const summaries = store.getSummaries();

  return {
    success: true,
    message: `Found ${sessions.length} projects`,
    session: undefined,
    ...({ sessions, summaries } as any),
  };
}

function handleGet(store: ProjectStore, params: ProjectToolAction): ProjectToolResult {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId or projectId required" };
  }

  let session = store.getSession(sessionId);
  if (!session) {
    session = store.getSessionByProjectId(sessionId);
  }

  if (!session) {
    return { success: false, error: `Project ${sessionId} not found` };
  }

  return { success: true, session };
}

function handleStart(
  store: ProjectStore,
  params: ProjectToolAction,
  agentId: string,
): ProjectToolResult {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId or projectId required" };
  }

  let session = store.getSession(sessionId);
  if (!session) {
    session = store.getSessionByProjectId(sessionId);
  }

  if (!session) {
    return { success: false, error: `Project ${sessionId} not found` };
  }

  if (session.status === "running") {
    return { success: true, session, message: "Project already running" };
  }

  const updated = store.updateSession(session.id, {
    status: "running",
    startedAt: session.startedAt ?? Date.now(),
    heartbeatAt: Date.now(),
  });

  if (updated) {
    store.appendAudit(session.id, "session_started", agentId);
  }

  return {
    success: true,
    session: updated ?? session,
    message: `Started project "${session.name}"`,
  };
}

function handlePause(recovery: RecoveryManager, params: ProjectToolAction): ProjectToolResult {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId required" };
  }

  const session = recovery.pauseSession(sessionId);
  if (!session) {
    return { success: false, error: `Failed to pause ${sessionId}` };
  }

  return { success: true, session, message: `Paused "${session.name}"` };
}

function handleResume(recovery: RecoveryManager, params: ProjectToolAction): ProjectToolResult {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId required" };
  }

  const session = recovery.resumeSession(sessionId);
  if (!session) {
    return { success: false, error: `Failed to resume ${sessionId}` };
  }

  return { success: true, session, message: `Resumed "${session.name}"` };
}

function handleComplete(recovery: RecoveryManager, params: ProjectToolAction): ProjectToolResult {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId required" };
  }

  const session = recovery.completeSession(sessionId);
  if (!session) {
    return { success: false, error: `Failed to complete ${sessionId}` };
  }

  return { success: true, session, message: `✅ Completed "${session.name}"` };
}

function handleCancel(recovery: RecoveryManager, params: ProjectToolAction): ProjectToolResult {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId required" };
  }

  const session = recovery.cancelSession(sessionId);
  if (!session) {
    return { success: false, error: `Failed to cancel ${sessionId}` };
  }

  return { success: true, session, message: `Cancelled "${session.name}"` };
}

function handleUpdateProgress(
  store: ProjectStore,
  params: ProjectToolAction,
  agentId: string,
  stateDir?: string,
): ProjectToolResult {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId required" };
  }

  let session = store.getSession(sessionId);
  if (!session) {
    session = store.getSessionByProjectId(sessionId);
  }

  if (!session) {
    return { success: false, error: `Project ${sessionId} not found` };
  }

  const progress = { ...session.progress };

  // Update current step
  if (params.currentStep !== undefined) {
    progress.currentStep = params.currentStep;
  }

  if (params.currentStepLabel !== undefined) {
    progress.currentStepLabel = params.currentStepLabel;
  }

  // Update context tokens
  if (params.contextTokens !== undefined) {
    progress.contextTokens = params.contextTokens;
    progress.contextPercent = Math.round((params.contextTokens / progress.maxContextTokens) * 100);
  }

  // Update subtasks
  if (params.subtaskUpdates) {
    for (const update of params.subtaskUpdates) {
      const subtask = progress.subtasks[update.index];
      if (!subtask) continue;

      if (update.status !== undefined) {
        subtask.status = update.status;
        if (update.status === "in_progress" && !subtask.startedAt) {
          subtask.startedAt = Date.now();
        }
        if (update.status === "completed") {
          subtask.completedAt = Date.now();
          subtask.percent = 100;
        }
      }

      if (update.percent !== undefined) {
        subtask.percent = update.percent;
      }

      if (update.notes !== undefined) {
        subtask.notes = update.notes;
      }
    }

    // Recalculate overall progress
    const completed = progress.subtasks.filter((s) => s.status === "completed").length;
    const total = progress.subtasks.length;
    progress.percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  }

  // Update elapsed time
  if (session.startedAt) {
    progress.elapsedMs = Date.now() - session.startedAt;
  }

  const updated = store.updateProgress(session.id, progress);

  if (updated) {
    store.appendAudit(session.id, "progress_updated", agentId, {
      percent: progress.percent,
      currentStep: progress.currentStep,
    });

    // Sync to TASK.md
    const projectDir = store.getProjectDir(session.projectId);
    const taskDoc = sessionToTaskDocument(updated);
    if (params.notes) {
      taskDoc.notes.push(params.notes);
    }
    writeTaskFile(projectDir, taskDoc);

    // Sync to Kanban/Notion
    syncSessionToKanban(updated).catch((err) => {
      console.error(`[project-tool] Failed to sync progress to Kanban:`, err);
    });
  }

  return {
    success: true,
    session: updated ?? session,
    message: `Progress: ${progress.percent}% (step ${progress.currentStep}/${progress.totalSteps})`,
  };
}

function handleUpdateProject(
  store: ProjectStore,
  params: ProjectToolAction,
  agentId: string,
): ProjectToolResult {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId or projectId required" };
  }

  let session = store.getSession(sessionId);
  if (!session) {
    session = store.getSessionByProjectId(sessionId);
  }
  if (!session) {
    return { success: false, error: `Project ${sessionId} not found` };
  }

  const patch: Partial<ProjectSession> = {};

  if (params.name !== undefined) patch.name = params.name;
  if (params.description !== undefined) patch.description = params.description;
  if (params.richDescription !== undefined) patch.richDescription = params.richDescription;

  // Tech stack: explicit replace OR additive add/remove
  let nextStack = session.techStack ? [...session.techStack] : [];
  let stackChanged = false;
  if (params.techStack !== undefined) {
    nextStack = dedupeStrings(params.techStack);
    stackChanged = true;
  }
  if (params.addTechStack && params.addTechStack.length) {
    nextStack = dedupeStrings([...nextStack, ...params.addTechStack]);
    stackChanged = true;
  }
  if (params.removeTechStack && params.removeTechStack.length) {
    const drop = new Set(params.removeTechStack.map((t) => t.toLowerCase()));
    nextStack = nextStack.filter((t) => !drop.has(t.toLowerCase()));
    stackChanged = true;
  }
  if (stackChanged) patch.techStack = nextStack;

  // Notes: keep existing, append new, drop removed by id
  let nextNotes = session.notes ? [...session.notes] : [];
  let notesChanged = false;
  if (params.addNotes && params.addNotes.length) {
    nextNotes = [...nextNotes, ...normalizeNotes(params.addNotes, agentId)];
    notesChanged = true;
  }
  if (params.removeNoteIds && params.removeNoteIds.length) {
    const drop = new Set(params.removeNoteIds);
    nextNotes = nextNotes.filter((n) => !drop.has(n.id));
    notesChanged = true;
  }
  if (notesChanged) patch.notes = nextNotes;

  // Attachments: same pattern
  let nextAttachments = session.attachments ? [...session.attachments] : [];
  let attachmentsChanged = false;
  if (params.addAttachments && params.addAttachments.length) {
    nextAttachments = [...nextAttachments, ...normalizeAttachments(params.addAttachments, agentId)];
    attachmentsChanged = true;
  }
  if (params.removeAttachmentIds && params.removeAttachmentIds.length) {
    const drop = new Set(params.removeAttachmentIds);
    nextAttachments = nextAttachments.filter((a) => !drop.has(a.id));
    attachmentsChanged = true;
  }
  if (attachmentsChanged) patch.attachments = nextAttachments;

  if (Object.keys(patch).length === 0) {
    return { success: true, session, message: "No changes" };
  }

  const updated = store.updateSession(session.id, patch);
  if (updated) {
    store.appendAudit(session.id, "progress_updated", agentId, {
      kind: "project_metadata",
      changedFields: Object.keys(patch),
    });

    syncSessionToKanban(updated).catch((err) => {
      console.error(`[project-tool] Failed to sync project metadata to Kanban:`, err);
    });
  }

  return {
    success: true,
    session: updated ?? session,
    message: `Updated project "${(updated ?? session).name}" — ${Object.keys(patch).join(", ")}`,
  };
}

async function handleCheckpoint(
  store: ProjectStore,
  checkpoints: CheckpointManager,
  params: ProjectToolAction,
): Promise<ProjectToolResult> {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId required" };
  }

  let session = store.getSession(sessionId);
  if (!session) {
    session = store.getSessionByProjectId(sessionId);
  }

  if (!session) {
    return { success: false, error: `Project ${sessionId} not found` };
  }

  const checkpoint = await checkpoints.createCheckpoint(session, {
    reason: params.checkpointReason ?? "manual",
    notes: params.checkpointNotes,
  });

  return {
    success: true,
    session,
    checkpoint,
    message: `Created checkpoint ${checkpoint.id}`,
  };
}

function handleHeartbeat(store: ProjectStore, params: ProjectToolAction): ProjectToolResult {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId required" };
  }

  let session = store.getSession(sessionId);
  if (!session) {
    session = store.getSessionByProjectId(sessionId);
  }

  if (!session) {
    return { success: false, error: `Project ${sessionId} not found` };
  }

  const updated = store.heartbeat(session.id);

  return {
    success: true,
    session: updated ?? session,
  };
}

async function handleRecover(
  recovery: RecoveryManager,
  params: ProjectToolAction,
): Promise<ProjectToolResult> {
  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, error: "sessionId required" };
  }

  const session = await recovery.manualRecover(sessionId);
  if (!session) {
    return { success: false, error: `Failed to recover ${sessionId}` };
  }

  return {
    success: true,
    session,
    message: `Recovered "${session.name}"`,
  };
}

function handleStats(store: ProjectStore): ProjectToolResult {
  const stats = store.getStats();
  const summaries = store.getSummaries();

  return {
    success: true,
    message: `Total: ${stats.total} | Running: ${stats.running} | Paused: ${stats.paused} | Completed: ${stats.completed} | Failed: ${stats.failed} | Stale: ${stats.stale}`,
    ...({ stats, summaries } as any),
  };
}

// ═══════════════════════════════════════════════════════════════════
// TOOL DEFINITION (for InfiniBot agent tools)
// ═══════════════════════════════════════════════════════════════════

export const projectToolDefinition = {
  name: "project",
  description: `Manage persistent project sessions with crash recovery and progress tracking.

Actions:
- create: Create a new project with mission, subtasks, success criteria, optional rich description (markdown), tech stack, notes, and attachments
- list: List all projects with status and progress
- get: Get details of a specific project
- start: Start working on a project (begins heartbeat tracking)
- pause: Pause a project (stops heartbeat tracking, no recovery)
- resume: Resume a paused project
- complete: Mark a project as successfully completed
- cancel: Cancel a project (no further recovery)
- update_progress: Update progress percentage, current step, or subtask status
- update_project: Update project metadata — name, description, richDescription (markdown), techStack, notes, attachments. Supports add/remove for techStack/notes/attachments
- checkpoint: Create a manual checkpoint for crash recovery
- heartbeat: Send heartbeat to prevent stale detection
- recover: Manually trigger recovery for a stale session
- stats: Get overall project statistics`,

  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "create",
          "list",
          "get",
          "start",
          "pause",
          "resume",
          "complete",
          "cancel",
          "update_progress",
          "update_project",
          "checkpoint",
          "heartbeat",
          "recover",
          "stats",
        ],
        description: "The action to perform",
      },
      projectId: {
        type: "string",
        description: 'Project slug (e.g., "sovereignty-v1") — for create or as lookup key',
      },
      sessionId: {
        type: "string",
        description: "Project session ID (alternative to projectId)",
      },
      name: {
        type: "string",
        description: "Project display name (for create)",
      },
      description: {
        type: "string",
        description: "Project description (for create)",
      },
      mission: {
        type: "string",
        description: "Project mission/goal (for create)",
      },
      successCriteria: {
        type: "array",
        items: { type: "string" },
        description: "List of success criteria (for create)",
      },
      subtasks: {
        type: "array",
        items: { type: "string" },
        description: "List of subtask labels (for create)",
      },
      richDescription: {
        type: "string",
        description:
          "Full markdown description / overview / architecture notes (for create or update_project)",
      },
      techStack: {
        type: "array",
        items: { type: "string" },
        description:
          'Tech stack tags, e.g. ["TypeScript", "Vite", "SQLite"]. For update_project this REPLACES the current list — use addTechStack/removeTechStack for additive edits',
      },
      addTechStack: {
        type: "array",
        items: { type: "string" },
        description: "Tech stack entries to append (update_project only)",
      },
      removeTechStack: {
        type: "array",
        items: { type: "string" },
        description:
          "Tech stack entries to remove (matched case-insensitive) (update_project only)",
      },
      projectNotes: {
        type: "array",
        description:
          "Initial notes for the project (create only). Each entry is either a markdown string or a {body, pinned, tags} object",
        items: {},
      },
      addNotes: {
        type: "array",
        description:
          "Notes to append to an existing project (update_project only). Strings or {body,pinned,tags} objects",
        items: {},
      },
      removeNoteIds: {
        type: "array",
        items: { type: "string" },
        description: "IDs of notes to delete (update_project only)",
      },
      attachments: {
        type: "array",
        description:
          "Initial attachments (create only). Each entry: {label, kind?, url?, path?, description?}",
        items: { type: "object" },
      },
      addAttachments: {
        type: "array",
        description: "Attachments to append (update_project only)",
        items: { type: "object" },
      },
      removeAttachmentIds: {
        type: "array",
        items: { type: "string" },
        description: "IDs of attachments to remove (update_project only)",
      },
      currentStep: {
        type: "number",
        description: "Current step number (for update_progress)",
      },
      currentStepLabel: {
        type: "string",
        description: "Label for current step (for update_progress)",
      },
      subtaskUpdates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "skipped"] },
            percent: { type: "number" },
            notes: { type: "string" },
          },
        },
        description: "Subtask updates (for update_progress)",
      },
      notes: {
        type: "string",
        description: "Notes to append (for update_progress)",
      },
      contextTokens: {
        type: "number",
        description: "Current context window token count (for update_progress)",
      },
      checkpointReason: {
        type: "string",
        enum: [
          "auto",
          "milestone",
          "subtask",
          "manual",
          "pre_pause",
          "pre_delegate",
          "error",
          "context_trim",
        ],
        description: "Reason for checkpoint (for checkpoint)",
      },
      checkpointNotes: {
        type: "string",
        description: "Notes for checkpoint (for checkpoint)",
      },
    },
    required: ["action"],
  },
};
