/**
 * Gateway Methods — Project Sessions
 *
 * RPC handlers for project management, progress tracking, and recovery.
 */

import { resolve } from "path";
import {
  getProjectStore,
  handleProjectTool,
  runStartupRecovery,
  getCheckpointManager,
  startOnboarding,
  getOnboardingState,
  isOnboarding,
  advanceOnboarding,
  skipOnboarding,
  completeOnboarding,
  getOnboardingPrompt,
  parseOnboardingInput,
  shouldTriggerOnboarding,
  type ProjectToolAction,
  type ProjectSession,
  type ProjectStatus,
  type OnboardingState,
} from "../../projects/index.js";
import {
  computeStatsFromSummaries,
  getKanbanProjectAsSession,
  listKanbanProjectsAsSessions,
  listKanbanProjectsAsSummaries,
} from "../../projects/kanban-bridge.js";
import { getKanbanStore } from "../../tasks/store.js";

// ═══════════════════════════════════════════════════════════════════
// STATE DIR
// ═══════════════════════════════════════════════════════════════════

function getStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || resolve(process.cwd(), "state");
}

// ═══════════════════════════════════════════════════════════════════
// GATEWAY HANDLERS
// ═══════════════════════════════════════════════════════════════════

/**
 * projects.tool — Main project tool handler
 */
export async function projectsTool(params: ProjectToolAction): Promise<any> {
  const stateDir = getStateDir();
  return handleProjectTool(params, stateDir);
}

/**
 * Filter helper shared by projects.list and projects.summaries — applies the
 * same status/agentId filters that the legacy ProjectStore.listSessions
 * supported, so the dashboard's "active / paused / completed" buttons keep
 * working after the kanban bridge swap.
 */
function applySessionFilters<T extends { status: ProjectStatus; agentId: string }>(
  rows: T[],
  params?: { status?: ProjectStatus | ProjectStatus[]; agentId?: string; limit?: number },
): T[] {
  let out = rows;
  if (params?.status) {
    const statusList = Array.isArray(params.status) ? params.status : [params.status];
    const wanted = new Set(statusList);
    out = out.filter((r) => wanted.has(r.status));
  }
  if (params?.agentId) {
    out = out.filter((r) => r.agentId === params.agentId);
  }
  if (typeof params?.limit === "number" && params.limit >= 0) {
    out = out.slice(0, params.limit);
  }
  return out;
}

function dedupeByIdPreferringFirst<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * projects.list — List project sessions for the dashboard.
 *
 * Reads the kanban store first (the canonical store the agent's `kanban`
 * tool writes to and that mirrors to the wizard's Notion DB after the
 * recent fixes). Legacy ProjectSessions are merged in second so existing
 * autonomous-run data still renders, but they're shadowed by any kanban
 * project that shares the same id (kanban entry wins).
 */
export async function projectsList(params?: {
  status?: ProjectStatus | ProjectStatus[];
  agentId?: string;
  limit?: number;
}): Promise<{ sessions: ProjectSession[]; count: number }> {
  const kanbanSessions = await listKanbanProjectsAsSessions();
  const legacy = getProjectStore(getStateDir()).listSessions(params);
  const merged = dedupeByIdPreferringFirst([...kanbanSessions, ...legacy]);
  merged.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const filtered = applySessionFilters(merged, params);
  return { sessions: filtered, count: filtered.length };
}

/**
 * projects.get — Get a single project session.
 *
 * Tries the kanban store (live + Notion-synced) first, falls back to the
 * legacy ProjectSession store so URL-bookmarked session ids still resolve.
 */
export async function projectsGet(params: {
  id?: string;
  projectId?: string;
}): Promise<ProjectSession | null> {
  const lookupId = params.id ?? params.projectId;
  if (lookupId) {
    const kanban = await getKanbanProjectAsSession(lookupId);
    if (kanban) return kanban;
  }
  const store = getProjectStore(getStateDir());
  if (params.id) return store.getSession(params.id);
  if (params.projectId) return store.getSessionByProjectId(params.projectId);
  return null;
}

/**
 * projects.summaries — Lightweight dashboard payload.
 *
 * Same merge strategy as projects.list. Stats are recomputed from the
 * merged list so the top bar's totals match the grid below.
 */
export async function projectsSummaries(): Promise<{
  summaries: Array<{
    id: string;
    projectId: string;
    name: string;
    status: ProjectStatus;
    agentId: string;
    percent: number;
    lastActivityAt: number;
  }>;
  stats: {
    total: number;
    running: number;
    paused: number;
    completed: number;
    failed: number;
    stale: number;
  };
}> {
  const kanban = await listKanbanProjectsAsSummaries();
  const legacy = getProjectStore(getStateDir()).getSummaries();
  const merged = dedupeByIdPreferringFirst([...kanban, ...legacy]);
  merged.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  return {
    summaries: merged,
    stats: computeStatsFromSummaries(merged),
  };
}

/**
 * projects.create — Create a new project session
 */
export async function projectsCreate(params: {
  projectId: string;
  name: string;
  description?: string;
  mission: string;
  successCriteria?: string[];
  subtasks?: string[];
  agentId?: string;
  richDescription?: string;
  techStack?: string[];
  projectNotes?: Array<string | { body: string; pinned?: boolean; tags?: string[] }>;
  attachments?: Array<{
    label: string;
    kind?: "file" | "url" | "image" | "doc" | "repo" | "other";
    url?: string;
    path?: string;
    description?: string;
  }>;
}): Promise<any> {
  return handleProjectTool(
    {
      action: "create",
      ...params,
    },
    getStateDir(),
  );
}

/**
 * projects.update — Update project metadata (description, richDescription, techStack, notes, attachments)
 */
export async function projectsUpdate(params: {
  sessionId?: string;
  projectId?: string;
  name?: string;
  description?: string;
  richDescription?: string;
  techStack?: string[];
  addTechStack?: string[];
  removeTechStack?: string[];
  addNotes?: Array<string | { body: string; pinned?: boolean; tags?: string[] }>;
  removeNoteIds?: string[];
  addAttachments?: Array<{
    label: string;
    kind?: "file" | "url" | "image" | "doc" | "repo" | "other";
    url?: string;
    path?: string;
    description?: string;
  }>;
  removeAttachmentIds?: string[];
  agentId?: string;
}): Promise<any> {
  return handleProjectTool(
    {
      action: "update_project",
      ...params,
    },
    getStateDir(),
  );
}

/**
 * projects.updateProgress — Update project progress
 */
export async function projectsUpdateProgress(params: {
  sessionId?: string;
  projectId?: string;
  currentStep?: number;
  currentStepLabel?: string;
  subtaskUpdates?: Array<{
    index: number;
    status?: "pending" | "in_progress" | "completed" | "skipped";
    percent?: number;
    notes?: string;
  }>;
  notes?: string;
  contextTokens?: number;
}): Promise<any> {
  return handleProjectTool(
    {
      action: "update_progress",
      ...params,
    },
    getStateDir(),
  );
}

/**
 * projects.control — Start/pause/resume/complete/cancel
 */
export async function projectsControl(params: {
  action: "start" | "pause" | "resume" | "complete" | "cancel";
  sessionId?: string;
  projectId?: string;
}): Promise<any> {
  return handleProjectTool(
    {
      ...params,
    },
    getStateDir(),
  );
}

/**
 * projects.checkpoint — Create a checkpoint
 */
export async function projectsCheckpoint(params: {
  sessionId?: string;
  projectId?: string;
  reason?: string;
  notes?: string;
}): Promise<any> {
  return handleProjectTool(
    {
      action: "checkpoint",
      sessionId: params.sessionId,
      projectId: params.projectId,
      checkpointReason: params.reason as any,
      checkpointNotes: params.notes,
    },
    getStateDir(),
  );
}

/**
 * projects.heartbeat — Send heartbeat for a running project
 */
export function projectsHeartbeat(params: {
  sessionId?: string;
  projectId?: string;
  contextTokens?: number;
}): { success: boolean; heartbeatAt: number } {
  const store = getProjectStore(getStateDir());

  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { success: false, heartbeatAt: 0 };
  }

  let session = store.getSession(sessionId);
  if (!session) {
    session = store.getSessionByProjectId(sessionId);
  }

  if (!session) {
    return { success: false, heartbeatAt: 0 };
  }

  const updated = store.heartbeat(session.id);

  // Update context tokens if provided
  if (params.contextTokens !== undefined && updated) {
    store.updateProgress(session.id, {
      contextTokens: params.contextTokens,
      contextPercent: Math.round((params.contextTokens / updated.progress.maxContextTokens) * 100),
    });
  }

  return {
    success: Boolean(updated),
    heartbeatAt: updated?.heartbeatAt ?? 0,
  };
}

/**
 * projects.recover — Manually trigger recovery scan or recover specific session
 */
export async function projectsRecover(params?: {
  sessionId?: string;
  projectId?: string;
  scanAll?: boolean;
}): Promise<any> {
  const stateDir = getStateDir();

  if (params?.scanAll) {
    const report = await runStartupRecovery(stateDir);
    return { success: true, report };
  }

  if (params?.sessionId || params?.projectId) {
    return handleProjectTool(
      {
        action: "recover",
        sessionId: params.sessionId,
        projectId: params.projectId,
      },
      stateDir,
    );
  }

  // Default: run full scan
  const report = await runStartupRecovery(stateDir);
  return { success: true, report };
}

/**
 * projects.auditLog — Get audit log for a project
 */
export function projectsAuditLog(params: {
  sessionId?: string;
  projectId?: string;
  limit?: number;
}): { entries: any[] } {
  const store = getProjectStore(getStateDir());

  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { entries: [] };
  }

  let session = store.getSession(sessionId);
  if (!session) {
    session = store.getSessionByProjectId(sessionId);
  }

  if (!session) {
    return { entries: [] };
  }

  const entries = store.getAuditLog(session.id, params.limit);
  return { entries };
}

/**
 * projects.checkpoints — List checkpoints for a project
 */
export function projectsCheckpoints(params: {
  sessionId?: string;
  projectId?: string;
  limit?: number;
}): { checkpoints: any[] } {
  const store = getProjectStore(getStateDir());
  const checkpoints = getCheckpointManager(getStateDir());

  const sessionId = params.sessionId ?? params.projectId;
  if (!sessionId) {
    return { checkpoints: [] };
  }

  let session = store.getSession(sessionId);
  if (!session) {
    session = store.getSessionByProjectId(sessionId);
  }

  if (!session) {
    return { checkpoints: [] };
  }

  const list = store.listCheckpoints(session.id, params.limit);
  return { checkpoints: list };
}

// ═══════════════════════════════════════════════════════════════════
// SESSION ONBOARDING
// ═══════════════════════════════════════════════════════════════════

/**
 * projects.onboarding.check — Check if a session should trigger onboarding
 */
export function projectsOnboardingCheck(params: { sessionKey: string }): {
  shouldOnboard: boolean;
  isOnboarding: boolean;
  existingProjects: ProjectSession[];
  reason: "new_session" | "has_active_projects" | "skip";
} {
  const result = shouldTriggerOnboarding(params.sessionKey);
  return {
    shouldOnboard: result.trigger,
    isOnboarding: isOnboarding(params.sessionKey),
    existingProjects: result.existingProjects,
    reason: result.reason,
  };
}

/**
 * projects.onboarding.start — Start onboarding flow for a session
 */
export function projectsOnboardingStart(params: { sessionKey: string; agentId?: string }): {
  state: OnboardingState;
  prompt: string;
} {
  // Check for existing projects to pass to onboarding
  const checkResult = shouldTriggerOnboarding(params.sessionKey);
  const state = startOnboarding(
    params.sessionKey,
    params.agentId ?? "main",
    checkResult.existingProjects,
  );
  return {
    state,
    prompt: getOnboardingPrompt(state, checkResult.existingProjects),
  };
}

/**
 * projects.onboarding.get — Get current onboarding state
 */
export function projectsOnboardingGet(params: { sessionKey: string }): {
  state: OnboardingState | null;
  prompt: string | null;
} {
  const state = getOnboardingState(params.sessionKey);
  return {
    state,
    prompt: state ? getOnboardingPrompt(state) : null,
  };
}

/**
 * projects.onboarding.advance — Process user input and advance onboarding
 */
export function projectsOnboardingAdvance(params: { sessionKey: string; input: string }): {
  success: boolean;
  state: OnboardingState | null;
  prompt: string | null;
  error: string | null;
  skipped?: boolean;
} {
  const state = getOnboardingState(params.sessionKey);
  if (!state) {
    return { success: false, state: null, prompt: null, error: "No onboarding session found" };
  }

  const result = parseOnboardingInput(state, params.input);

  if (result.error === "SKIP") {
    skipOnboarding(params.sessionKey);
    return { success: true, state: null, prompt: null, error: null, skipped: true };
  }

  if (result.error) {
    return { success: false, state, prompt: getOnboardingPrompt(state), error: result.error };
  }

  if (result.advance) {
    const newState = advanceOnboarding(params.sessionKey, result.data ?? {});
    return {
      success: true,
      state: newState,
      prompt: newState ? getOnboardingPrompt(newState) : null,
      error: null,
    };
  }

  // Data update without advance (e.g., "back" command)
  if (result.data) {
    Object.assign(state, result.data);
    return {
      success: true,
      state,
      prompt: getOnboardingPrompt(state),
      error: null,
    };
  }

  return { success: false, state, prompt: getOnboardingPrompt(state), error: "Unknown error" };
}

/**
 * projects.onboarding.complete — Finalize onboarding and create project
 */
export async function projectsOnboardingComplete(params: { sessionKey: string }): Promise<{
  success: boolean;
  session: ProjectSession | null;
  error: string | null;
}> {
  const session = await completeOnboarding(params.sessionKey);

  if (!session) {
    return { success: false, session: null, error: "Failed to create project" };
  }

  return { success: true, session, error: null };
}

/**
 * projects.onboarding.skip — Skip onboarding for a session
 */
export function projectsOnboardingSkip(params: { sessionKey: string }): { success: boolean } {
  skipOnboarding(params.sessionKey);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════
// STARTUP HOOK
// ═══════════════════════════════════════════════════════════════════

/**
 * Call this on gateway startup to recover any stale sessions.
 */
export async function initProjectsRecovery(): Promise<void> {
  try {
    const report = await runStartupRecovery(getStateDir());

    if (report.staleSessions.length > 0) {
      console.log(
        `[projects] Startup recovery: ${report.recovered.length} recovered, ${report.failed.length} failed, ${report.abandoned.length} abandoned`,
      );
    }
  } catch (error) {
    console.error("[projects] Startup recovery failed:", error);
  }
}

// ═══════════════════════════════════════════════════════════════════
// RPC HANDLERS
// ═══════════════════════════════════════════════════════════════════
//
// The functions above are pure helpers — they were never wired to RPC method
// names, so calling client.request("projects.list") from the Control UI
// returned "unknown method" and the dashboard rendered as empty. This
// handlers map registers the projects.* surface for real, using the kanban
// bridge so /projects shows what's in the (Notion-mirrored) kanban store.

import type { GatewayRequestHandlers } from "./types.js";
import { applySatelliteProxy } from "../../federation/satellite-context.js";

function paramOr<T>(value: unknown, fallback: T): T {
  return (value ?? fallback) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value;
}

const _rawProjectsHandlers: GatewayRequestHandlers = {
  "projects.list": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const result = await projectsList({
        status: p.status as ProjectStatus | ProjectStatus[] | undefined,
        agentId: typeof p.agentId === "string" ? p.agentId : undefined,
        limit: typeof p.limit === "number" ? p.limit : undefined,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.summaries": async ({ respond }) => {
    try {
      const result = await projectsSummaries();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.get": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const result = await projectsGet({
        id: typeof p.id === "string" ? p.id : undefined,
        projectId: typeof p.projectId === "string" ? p.projectId : undefined,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.create": async ({ params, respond }) => {
    try {
      const result = await projectsCreate(paramOr(params, {} as never));
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.update": async ({ params, respond }) => {
    try {
      const result = await projectsUpdate(paramOr(params, {} as never));
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.updateProgress": async ({ params, respond }) => {
    try {
      const result = await projectsUpdateProgress(paramOr(params, {} as never));
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.control": async ({ params, respond }) => {
    try {
      const result = await projectsControl(paramOr(params, {} as never));
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.checkpoint": async ({ params, respond }) => {
    try {
      const result = await projectsCheckpoint(paramOr(params, {} as never));
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  // Read-only project history. Both helpers existed above but, like
  // projects.list before them, were never given an RPC name — so the audit-log
  // and checkpoint panels always errored.
  "projects.auditLog": async ({ params, respond }) => {
    try {
      respond(true, projectsAuditLog(paramOr(params, {} as never)));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.checkpoints": async ({ params, respond }) => {
    try {
      respond(true, projectsCheckpoints(paramOr(params, {} as never)));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.heartbeat": async ({ params, respond }) => {
    try {
      const result = projectsHeartbeat(paramOr(params, {} as never));
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.recover": async ({ params, respond }) => {
    try {
      const result = await projectsRecover(paramOr(params, {} as never));
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "projects.tool": async ({ params, respond }) => {
    try {
      const result = await projectsTool(paramOr(params, {} as never));
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "project.phases.list": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const store = getKanbanStore(getStateDir());
      const result = store.listPhases(requireString(p.projectId, "projectId"));
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "project.phases.create": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const store = getKanbanStore(getStateDir());
      const result = store.createPhase({
        projectId: requireString(p.projectId, "projectId"),
        name: requireString(p.name, "name"),
        dueDate: typeof p.dueDate === "string" ? p.dueDate : undefined,
        description: typeof p.description === "string" ? p.description : undefined,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "project.phases.update": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const patch = asRecord(p.patch);
      const store = getKanbanStore(getStateDir());
      const phasePatch: Parameters<typeof store.updatePhase>[1] = {};
      if (typeof patch.name === "string") phasePatch.name = patch.name;
      if (typeof patch.dueDate === "string" || patch.dueDate === null) {
        phasePatch.dueDate = patch.dueDate;
      }
      if (typeof patch.status === "string") phasePatch.status = patch.status as never;
      if (typeof patch.description === "string" || patch.description === null) {
        phasePatch.description = patch.description;
      }
      if (typeof patch.ordinal === "number") phasePatch.ordinal = patch.ordinal;
      if (typeof patch.notionId === "string" || patch.notionId === null) {
        phasePatch.notionId = patch.notionId;
      }
      const result = store.updatePhase(requireString(p.id, "id"), phasePatch);
      if (!result) throw new Error("phase not found");
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "project.phases.delete": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const store = getKanbanStore(getStateDir());
      store.deletePhase(requireString(p.id, "id"));
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "project.phases.reorder": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      const orderedIds = Array.isArray(p.orderedIds)
        ? p.orderedIds.filter((id): id is string => typeof id === "string")
        : [];
      const store = getKanbanStore(getStateDir());
      const result = store.reorderPhases(requireString(p.projectId, "projectId"), orderedIds);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "project.setDeadline": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      if (!(typeof p.dueDate === "string" || p.dueDate === null)) {
        throw new Error("dueDate is required");
      }
      const dueDate = p.dueDate;
      const store = getKanbanStore(getStateDir());
      const result = await store.updateProject(requireString(p.projectId, "projectId"), {
        dueDate: dueDate ?? undefined,
      });
      if (!result) throw new Error("project not found");
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "task.setPhase": async ({ params, respond }) => {
    try {
      const p = asRecord(params);
      if (!(typeof p.phaseId === "string" || p.phaseId === null)) {
        throw new Error("phaseId is required");
      }
      const phaseId = p.phaseId;
      const store = getKanbanStore(getStateDir());
      const result = await store.updateTask(requireString(p.taskId, "taskId"), { phaseId });
      if (!result) throw new Error("task not found");
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

// In satellite mode, proxy all projects.* calls to master (project data is master-owned).
export const projectsHandlers: GatewayRequestHandlers = applySatelliteProxy(_rawProjectsHandlers);
