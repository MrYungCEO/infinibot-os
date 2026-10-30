/**
 * Projects Dashboard Controller
 * 
 * State management for the Deep Memory Architecture UI.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { KanbanTask } from "../types";

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

/**
 * A multi-phase milestone within a project. Backend contract:
 * `project.phases.*` + `task.setPhase`. Mirrors the gateway ProjectPhase.
 */
export interface ProjectPhase {
  id: string;
  projectId: string;
  name: string;
  ordinal: number;
  dueDate?: string | null;
  status: 'planned' | 'active' | 'done' | 'skipped';
  description?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A KanbanTask that may carry a phase assignment (backend adds `phaseId`). */
export type PhasedTask = KanbanTask & { phaseId?: string | null };

export interface ProjectSession {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  richDescription?: string;
  techStack?: string[];
  notes?: ProjectSessionNote[];
  attachments?: ProjectSessionAttachment[];
  agentId: string;
  sessionKey?: string;
  status: ProjectStatus;
  progress: ProjectProgress;
  workspacePath?: string;
  checkpointId?: string;
  createdAt: number;
  startedAt?: number;
  pausedAt?: number;
  completedAt?: number;
  lastActivityAt: number;
  heartbeatAt?: number;
  staleTimeoutMs: number;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
}

export interface ProjectSessionNote {
  id: string;
  body: string;
  createdAt: number;
  author?: string;
  pinned?: boolean;
  tags?: string[];
}

export type ProjectSessionAttachmentKind = 'file' | 'url' | 'image' | 'doc' | 'repo' | 'other';

export interface ProjectSessionAttachment {
  id: string;
  kind: ProjectSessionAttachmentKind;
  label: string;
  url?: string;
  path?: string;
  description?: string;
  addedAt: number;
  addedBy?: string;
}

export type ProjectStatus = 
  | 'pending' | 'running' | 'paused' | 'stale' 
  | 'recovering' | 'completed' | 'failed' | 'cancelled';

export interface ProjectProgress {
  percent: number;
  currentStep: number;
  totalSteps: number;
  currentStepLabel?: string;
  subtasks: Subtask[];
  contextTokens: number;
  maxContextTokens: number;
  contextPercent: number;
  elapsedMs: number;
  estimatedRemainingMs?: number;
}

export interface Subtask {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  percent: number;
  startedAt?: number;
  completedAt?: number;
  notes?: string;
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

export interface ProjectStats {
  total: number;
  running: number;
  paused: number;
  completed: number;
  failed: number;
  stale: number;
}

export interface ProjectsState {
  loading: boolean;
  error: string | null;
  summaries: ProjectSummary[];
  stats: ProjectStats;
  sessions: ProjectSession[];
  selectedSessionId: string | null;
  selectedSession: ProjectSession | null;
  filter: 'all' | 'active' | 'completed' | 'failed';
  pollInterval: number | null;
  // Bidirectional entity relations for the selected project. Lazy-loaded
  // when the detail panel opens; cleared on close.
  relations: {
    projectId: string | null;
    loading: boolean;
    client: { id: string; name: string }[];
    note: { id: string; name: string }[];
    workflow: { id: string; name: string }[];
  };
  catalogs: {
    clients: { id: string; name: string }[];
    notes: { id: string; name: string }[];
    workflows: { id: string; name: string }[];
    loadedAt: number | null;
  };
  relationPickerOpenFor: 'client' | 'note' | 'workflow' | null;
  relationPickerQuery: string;
  // Deadline + multi-phase management for the selected project. Keyed by
  // KanbanProject id (== ProjectSession.projectId). Lazy-loaded with the
  // detail panel; invalidated after each mutation.
  phaseData: {
    loadedProjectId: string | null;
    loadingProjectId: string | null;
    backendMissing: boolean;
    error: string | null;
    /** Phases ordered by ordinal, by projectId. */
    byProject: Record<string, ProjectPhase[]>;
    /** Project's kanban tasks (carry phaseId), by projectId. */
    tasksByProject: Record<string, PhasedTask[]>;
    /** Current project dueDate (from KanbanProject), by projectId. */
    dueDateByProject: Record<string, string | null>;
    /** Phase whose task list is expanded, or null. */
    expandedPhaseId: string | null;
    /** projectId for which the inline "add phase" form is open. */
    addOpenForProject: string | null;
    /** phaseId currently being inline-edited, or null. */
    editingPhaseId: string | null;
    /** Whether the collapsible Phases section is expanded. */
    sectionOpen: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════════
// STATE FACTORY
// ═══════════════════════════════════════════════════════════════════

export function createProjectsState(): ProjectsState {
  return {
    loading: false,
    error: null,
    summaries: [],
    stats: { total: 0, running: 0, paused: 0, completed: 0, failed: 0, stale: 0 },
    sessions: [],
    selectedSessionId: null,
    selectedSession: null,
    filter: 'all',
    pollInterval: null,
    relations: { projectId: null, loading: false, client: [], note: [], workflow: [] },
    catalogs: { clients: [], notes: [], workflows: [], loadedAt: null },
    relationPickerOpenFor: null,
    relationPickerQuery: '',
    phaseData: {
      loadedProjectId: null,
      loadingProjectId: null,
      backendMissing: false,
      error: null,
      byProject: {},
      tasksByProject: {},
      dueDateByProject: {},
      expandedPhaseId: null,
      addOpenForProject: null,
      editingPhaseId: null,
      sectionOpen: true,
    },
  };
}

// ── Project entity-relations (client / note / workflow) ──────

type ProjectRelPeerType = 'client' | 'note' | 'workflow';

async function projectFetchPeers(
  client: GatewayBrowserClient,
  id: string,
  peerType: ProjectRelPeerType,
): Promise<string[]> {
  try {
    const res = (await client.request('relations.list', { type: 'project', id, peerType })) as any;
    const rels = Array.isArray(res?.relations) ? res.relations : [];
    return rels.map((r: any) => String(r.id));
  } catch {
    return [];
  }
}

async function projectNameFor(
  client: GatewayBrowserClient,
  type: ProjectRelPeerType,
  id: string,
): Promise<string> {
  try {
    if (type === 'client') {
      const r = (await client.request('business.clients.get', { id })) as any;
      const data = r?.client?.data ?? {};
      return data.Name ?? data.name ?? data.Title ?? data.title ?? id;
    }
    if (type === 'note') {
      const r = (await client.request('notes.get', { id })) as any;
      return r?.note?.name ?? r?.name ?? id;
    }
    if (type === 'workflow') {
      const r = (await client.request('workflows.get', { id })) as any;
      return r?.workflow?.name ?? r?.name ?? id;
    }
  } catch {}
  return id;
}

export async function loadProjectRelations(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  rerender: () => void,
): Promise<void> {
  state.relations.projectId = projectId;
  state.relations.loading = true;
  rerender();
  try {
    const [cs, ns, ws] = await Promise.all([
      projectFetchPeers(client, projectId, 'client'),
      projectFetchPeers(client, projectId, 'note'),
      projectFetchPeers(client, projectId, 'workflow'),
    ]);
    const [cPeers, nPeers, wPeers] = await Promise.all([
      Promise.all(cs.map(async (id) => ({ id, name: await projectNameFor(client, 'client', id) }))),
      Promise.all(ns.map(async (id) => ({ id, name: await projectNameFor(client, 'note', id) }))),
      Promise.all(ws.map(async (id) => ({ id, name: await projectNameFor(client, 'workflow', id) }))),
    ]);
    if (state.relations.projectId === projectId) {
      state.relations = { projectId, loading: false, client: cPeers, note: nPeers, workflow: wPeers };
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.relations.loading = false;
  }
  rerender();
}

export async function loadProjectCatalogs(
  state: ProjectsState,
  client: GatewayBrowserClient,
  rerender: () => void,
  force = false,
): Promise<void> {
  if (!force && state.catalogs.loadedAt && Date.now() - state.catalogs.loadedAt < 30_000) return;
  try {
    const [cRes, nRes, wRes] = (await Promise.all([
      client.request('business.clients.list', {}).catch(() => ({})),
      client.request('notes.list', {}).catch(() => ({})),
      client.request('workflows.list', {}).catch(() => ({})),
    ])) as any[];
    const clients = ((cRes?.clients ?? []) as any[]).map((c: any) => ({
      id: String(c.id),
      name: String(c.data?.Name ?? c.data?.name ?? c.data?.Title ?? c.data?.title ?? c.id),
    }));
    const notes = ((nRes?.notes ?? []) as any[]).map((n: any) => ({
      id: String(n.id),
      name: String(n.name ?? n.title ?? n.id),
    }));
    const workflows = ((wRes?.workflows ?? wRes?.items ?? []) as any[]).map((w: any) => ({
      id: String(w.id),
      name: String(w.name ?? w.title ?? w.id),
    }));
    state.catalogs = { clients, notes, workflows, loadedAt: Date.now() };
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  rerender();
}

export async function linkProjectPeer(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  peerType: ProjectRelPeerType,
  peerId: string,
  rerender: () => void,
): Promise<void> {
  try {
    await client.request('relations.link', {
      left: { type: 'project', id: projectId },
      right: { type: peerType, id: peerId },
    });
    await loadProjectRelations(state, client, projectId, rerender);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    rerender();
  }
}

export async function unlinkProjectPeer(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  peerType: ProjectRelPeerType,
  peerId: string,
  rerender: () => void,
): Promise<void> {
  state.relations[peerType] = state.relations[peerType].filter((p) => p.id !== peerId);
  rerender();
  try {
    await client.request('relations.unlink', {
      left: { type: 'project', id: projectId },
      right: { type: peerType, id: peerId },
    });
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    await loadProjectRelations(state, client, projectId, rerender);
  }
}

export function setProjectRelationPickerOpen(state: ProjectsState, forType: ProjectRelPeerType | null, rerender: () => void) {
  state.relationPickerOpenFor = forType;
  state.relationPickerQuery = '';
  rerender();
}

export function setProjectRelationPickerQuery(state: ProjectsState, q: string, rerender: () => void) {
  state.relationPickerQuery = q;
  rerender();
}

// ═══════════════════════════════════════════════════════════════════
// API CALLS
// ═══════════════════════════════════════════════════════════════════

export async function loadProjectsSummaries(client: GatewayBrowserClient): Promise<{
  summaries: ProjectSummary[];
  stats: ProjectStats;
}> {
  const result = await client.request("projects.summaries", {});
  return result as { summaries: ProjectSummary[]; stats: ProjectStats };
}

export async function loadProjectSessions(
  client: GatewayBrowserClient,
  filter?: { status?: ProjectStatus | ProjectStatus[]; agentId?: string },
): Promise<ProjectSession[]> {
  const result = await client.request("projects.list", filter ?? {});
  return (result as { sessions: ProjectSession[] }).sessions;
}

export async function loadProjectSession(
  client: GatewayBrowserClient,
  id: string,
): Promise<ProjectSession | null> {
  const result = await client.request("projects.get", { id });
  return result as ProjectSession | null;
}

export async function createProject(
  client: GatewayBrowserClient,
  params: {
    projectId: string;
    name: string;
    description?: string;
    mission: string;
    successCriteria?: string[];
    subtasks?: string[];
    agentId?: string;
  },
): Promise<{ success: boolean; session?: ProjectSession; error?: string }> {
  return client.request("projects.create", params) as any;
}

export async function controlProject(
  client: GatewayBrowserClient,
  action: 'start' | 'pause' | 'resume' | 'complete' | 'cancel',
  sessionId: string,
): Promise<{ success: boolean; session?: ProjectSession; error?: string }> {
  return client.request("projects.control", { action, sessionId }) as any;
}

export async function updateProjectProgress(
  client: GatewayBrowserClient,
  sessionId: string,
  updates: {
    currentStep?: number;
    currentStepLabel?: string;
    subtaskUpdates?: Array<{
      index: number;
      status?: 'pending' | 'in_progress' | 'completed' | 'skipped';
      percent?: number;
      notes?: string;
    }>;
    notes?: string;
    contextTokens?: number;
  },
): Promise<{ success: boolean; session?: ProjectSession; error?: string }> {
  return client.request("projects.updateProgress", { sessionId, ...updates }) as any;
}

export async function createCheckpoint(
  client: GatewayBrowserClient,
  sessionId: string,
  reason?: string,
  notes?: string,
): Promise<{ success: boolean; checkpoint?: any; error?: string }> {
  return client.request("projects.checkpoint", { sessionId, reason, notes }) as any;
}

export async function sendHeartbeat(
  client: GatewayBrowserClient,
  sessionId: string,
  contextTokens?: number,
): Promise<{ success: boolean; heartbeatAt: number }> {
  return client.request("projects.heartbeat", { sessionId, contextTokens }) as any;
}

export async function recoverProjects(
  client: GatewayBrowserClient,
  sessionId?: string,
): Promise<{ success: boolean; report?: any; error?: string }> {
  if (sessionId) {
    return client.request("projects.recover", { sessionId }) as any;
  }
  return client.request("projects.recover", { scanAll: true }) as any;
}

export async function loadAuditLog(
  client: GatewayBrowserClient,
  sessionId: string,
  limit?: number,
): Promise<{ entries: any[] }> {
  return client.request("projects.auditLog", { sessionId, limit }) as any;
}

export async function loadCheckpoints(
  client: GatewayBrowserClient,
  sessionId: string,
  limit?: number,
): Promise<{ checkpoints: any[] }> {
  return client.request("projects.checkpoints", { sessionId, limit }) as any;
}

// ═══════════════════════════════════════════════════════════════════
// DEADLINE + PHASES (backend: project.setDeadline, project.phases.*, task.setPhase)
// ═══════════════════════════════════════════════════════════════════

/** Detect a "method not implemented yet" gateway error (backend not synced). */
function isMethodMissing(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('-32601') ||
    msg.includes('method not found') ||
    msg.includes('unknown method') ||
    msg.includes('not implemented') ||
    msg.includes('404')
  );
}

function sortPhases(phases: ProjectPhase[]): ProjectPhase[] {
  return [...phases].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
}

/**
 * Load phases, the project's kanban tasks, and the current project dueDate
 * for the detail panel. Guards against re-loading the same project. If the
 * `project.phases.*` backend is missing, flips `backendMissing` so the UI can
 * render a friendly disabled block instead of crashing.
 */
export async function loadProjectPhases(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  rerender: () => void,
): Promise<void> {
  const pd = state.phaseData;
  if (pd.loadedProjectId === projectId || pd.loadingProjectId === projectId) return;
  pd.loadingProjectId = projectId;
  pd.error = null;
  rerender();

  // Project dueDate lives on the KanbanProject; tasks come from the kanban
  // store. These are independent of the (possibly missing) phases backend.
  try {
    const projects = (await client.request('kanban.projects.list', {})) as Array<{ id: string; dueDate?: string | null }>;
    const proj = Array.isArray(projects) ? projects.find((p) => p.id === projectId) : undefined;
    pd.dueDateByProject[projectId] = proj?.dueDate ?? null;
  } catch {
    if (pd.dueDateByProject[projectId] === undefined) pd.dueDateByProject[projectId] = null;
  }

  try {
    const tasks = (await client.request('kanban.tasks.list', { projectId })) as PhasedTask[];
    pd.tasksByProject[projectId] = Array.isArray(tasks) ? tasks : [];
  } catch {
    pd.tasksByProject[projectId] = pd.tasksByProject[projectId] ?? [];
  }

  try {
    const phases = (await client.request('project.phases.list', { projectId })) as ProjectPhase[];
    pd.byProject[projectId] = sortPhases(Array.isArray(phases) ? phases : []);
    pd.backendMissing = false;
  } catch (err) {
    if (isMethodMissing(err)) {
      pd.backendMissing = true;
      pd.byProject[projectId] = pd.byProject[projectId] ?? [];
    } else {
      pd.error = err instanceof Error ? err.message : String(err);
    }
  }

  pd.loadingProjectId = null;
  pd.loadedProjectId = projectId;
  rerender();
}

/** Force a phases + tasks reload after a mutation. */
export async function reloadProjectPhases(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  rerender: () => void,
): Promise<void> {
  state.phaseData.loadedProjectId = null;
  await loadProjectPhases(state, client, projectId, rerender);
}

/** Set (or clear, with null) the project deadline. Optimistically caches it. */
export async function setProjectDeadline(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  dueDate: string | null,
  rerender: () => void,
): Promise<void> {
  const prev = state.phaseData.dueDateByProject[projectId] ?? null;
  state.phaseData.dueDateByProject[projectId] = dueDate;
  rerender();
  try {
    const proj = (await client.request('project.setDeadline', { projectId, dueDate })) as { dueDate?: string | null } | null;
    // Trust the server's echoed value when present.
    if (proj && 'dueDate' in proj) state.phaseData.dueDateByProject[projectId] = proj.dueDate ?? null;
    rerender();
  } catch (err) {
    state.phaseData.dueDateByProject[projectId] = prev;
    state.phaseData.error = isMethodMissing(err)
      ? 'Backend missing — sync the latest branch to set deadlines.'
      : (err instanceof Error ? err.message : String(err));
    rerender();
  }
}

export async function createProjectPhase(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  name: string,
  dueDate: string | null,
  rerender: () => void,
): Promise<void> {
  try {
    await client.request('project.phases.create', {
      projectId,
      name,
      dueDate: dueDate || undefined,
    });
    state.phaseData.addOpenForProject = null;
    await reloadProjectPhases(state, client, projectId, rerender);
  } catch (err) {
    state.phaseData.error = isMethodMissing(err)
      ? 'Backend missing — sync the latest branch to add phases.'
      : (err instanceof Error ? err.message : String(err));
    rerender();
  }
}

export async function updateProjectPhase(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  id: string,
  patch: Partial<ProjectPhase>,
  rerender: () => void,
): Promise<void> {
  try {
    await client.request('project.phases.update', { id, patch });
    state.phaseData.editingPhaseId = null;
    await reloadProjectPhases(state, client, projectId, rerender);
  } catch (err) {
    state.phaseData.error = err instanceof Error ? err.message : String(err);
    rerender();
  }
}

export async function deleteProjectPhase(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  id: string,
  rerender: () => void,
): Promise<void> {
  try {
    await client.request('project.phases.delete', { id });
    if (state.phaseData.expandedPhaseId === id) state.phaseData.expandedPhaseId = null;
    // Backend nulls phaseId on the affected tasks; a reload reflects that.
    await reloadProjectPhases(state, client, projectId, rerender);
  } catch (err) {
    state.phaseData.error = err instanceof Error ? err.message : String(err);
    rerender();
  }
}

export async function reorderProjectPhases(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  orderedIds: string[],
  rerender: () => void,
): Promise<void> {
  // Optimistic reorder so up/down buttons feel instant.
  const current = state.phaseData.byProject[projectId] ?? [];
  const byId = new Map(current.map((p) => [p.id, p]));
  const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as ProjectPhase[];
  if (reordered.length === current.length) {
    state.phaseData.byProject[projectId] = reordered.map((p, i) => ({ ...p, ordinal: i }));
    rerender();
  }
  try {
    await client.request('project.phases.reorder', { projectId, orderedIds });
    await reloadProjectPhases(state, client, projectId, rerender);
  } catch (err) {
    state.phaseData.error = err instanceof Error ? err.message : String(err);
    await reloadProjectPhases(state, client, projectId, rerender);
  }
}

/** Assign (or clear, with null) a task's phase. Optimistic. */
export async function setTaskPhase(
  state: ProjectsState,
  client: GatewayBrowserClient,
  projectId: string,
  taskId: string,
  phaseId: string | null,
  rerender: () => void,
): Promise<void> {
  const tasks = state.phaseData.tasksByProject[projectId] ?? [];
  const task = tasks.find((t) => t.id === taskId);
  const prev = task?.phaseId ?? null;
  if (task) task.phaseId = phaseId;
  rerender();
  try {
    await client.request('task.setPhase', { taskId, phaseId });
  } catch (err) {
    if (task) task.phaseId = prev;
    state.phaseData.error = isMethodMissing(err)
      ? 'Backend missing — sync the latest branch to assign phases.'
      : (err instanceof Error ? err.message : String(err));
    rerender();
  }
}

// ── Local UI state setters for the phases section ──
export function setPhaseExpanded(state: ProjectsState, phaseId: string | null, rerender: () => void): void {
  state.phaseData.expandedPhaseId = state.phaseData.expandedPhaseId === phaseId ? null : phaseId;
  rerender();
}

export function setPhaseAddOpen(state: ProjectsState, projectId: string | null, rerender: () => void): void {
  state.phaseData.addOpenForProject = projectId;
  rerender();
}

export function setPhaseEditing(state: ProjectsState, phaseId: string | null, rerender: () => void): void {
  state.phaseData.editingPhaseId = phaseId;
  rerender();
}

export function togglePhasesSection(state: ProjectsState, rerender: () => void): void {
  state.phaseData.sectionOpen = !state.phaseData.sectionOpen;
  rerender();
}

/** Deadline color tone relative to today. */
export function deadlineTone(dueDate: string | null | undefined): 'overdue' | 'soon' | 'ok' | null {
  if (!dueDate) return null;
  const due = Date.parse(dueDate);
  if (Number.isNaN(due)) return null;
  const now = Date.now();
  const dayMs = 86_400_000;
  // Compare against end-of-day to avoid flagging "today" as overdue.
  const endOfDue = due + dayMs;
  if (endOfDue < now) return 'overdue';
  if (due - now <= 7 * dayMs) return 'soon';
  return 'ok';
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

export function getStatusColor(status: ProjectStatus): string {
  switch (status) {
    case 'running': return '#22c55e'; // green
    case 'paused': return '#eab308'; // yellow
    case 'completed': return '#3b82f6'; // blue
    case 'failed': return '#ef4444'; // red
    case 'stale': return '#f97316'; // orange
    case 'recovering': return '#8b5cf6'; // purple
    case 'cancelled': return '#6b7280'; // gray
    case 'pending': return '#6b7280'; // gray
    default: return '#6b7280';
  }
}

export function getStatusIcon(status: ProjectStatus): string {
  switch (status) {
    case 'running': return '▶️';
    case 'paused': return '⏸️';
    case 'completed': return '✅';
    case 'failed': return '❌';
    case 'stale': return '⚠️';
    case 'recovering': return '🔄';
    case 'cancelled': return '🚫';
    case 'pending': return '⏳';
    default: return '❓';
  }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function formatContextUsage(tokens: number, max: number): string {
  const percent = max > 0 ? Math.round((tokens / max) * 100) : 0;
  const k = Math.round(tokens / 1000);
  const maxK = Math.round(max / 1000);
  return `${k}K / ${maxK}K (${percent}%)`;
}

export function getAgentDisplayName(agentId: string): string {
  const names: Record<string, string> = {
    main: 'Infini',
    coder: 'Atlas',
    'coder-claude': 'Claude Code',
    'coder-codex': 'Codex',
    'coder-opencode': 'OpenCode',
    webdev: 'Architect',
    qa: 'Sentry',
    opus: 'Oracle',
  };
  return names[agentId] ?? agentId;
}
