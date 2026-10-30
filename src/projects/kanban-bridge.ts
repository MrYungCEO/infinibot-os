/**
 * Kanban → ProjectSession adapter for the /projects dashboard.
 *
 * Why this exists: the /projects view originally read from
 * `src/projects/store.ts` (the legacy ProjectSession SQLite store), which is
 * agent-session-centric and never participated in Notion sync. The kanban
 * tool (and its underlying `src/tasks/store.ts`) is what actually mirrors to
 * the wizard-configured Notion DBs after the recent ESM/require + schema
 * fixes — so that's what the operator sees in Notion.
 *
 * Rather than fork the data model, we surface kanban projects through the
 * same RPCs the dashboard already calls (`projects.list`, `projects.get`,
 * `projects.summaries`) by adapting `KanbanProject` → `ProjectSession` /
 * `ProjectSummary`. Fields that have no kanban analogue (mission,
 * subtasks, checkpoints, agentId) get sensible defaults.
 *
 * Trade-off: the dashboard loses session-only metadata for kanban-sourced
 * rows. That matches what the operator asked for — they explicitly said
 * "this is correct db that need to show on /projects just synced with
 * notion", and they're using kanban as the canonical store going forward.
 */
import { getKanbanStore } from "../tasks/store.js";
import type { ProjectAttachment as KanbanProjectAttachment } from "../tasks/store.js";
import type { KanbanProject } from "../tasks/types.js";
import type {
  AttachmentKind,
  ProjectAttachment,
  ProjectSession,
  ProjectStatus,
  ProjectSummary,
} from "./types.js";

/** Notion / kanban status names → ProjectSession status enum. */
const KANBAN_TO_SESSION_STATUS: Record<string, ProjectStatus> = {
  "Not started": "pending",
  "In progress": "running",
  Updating: "running",
  Completed: "completed",
  Paused: "paused",
  "Awaiting Client": "paused",
  Reviewing: "paused",
  Cancelled: "cancelled",
};

/** Synthetic agent id used so the dashboard can label kanban-sourced rows. */
const KANBAN_AGENT_ID = "kanban";

function mapStatus(raw: string | undefined): ProjectStatus {
  if (!raw) return "pending";
  return KANBAN_TO_SESSION_STATUS[raw] ?? "pending";
}

/**
 * Map a kanban-store ProjectAttachment ({id, projectId, name, path, size,
 * mimeType, createdAt}) onto the ProjectSession ProjectAttachment shape
 * the dashboard renders ({id, kind, label, url|path, addedAt, …}).
 *
 * Without this mapping the dashboard's "Content & Assets" section is empty
 * even after an agent calls kanban.projects.content.addAttachment, because
 * the bridge previously dropped attachments on the floor.
 */
function kanbanAttachmentToSessionAttachment(a: KanbanProjectAttachment): ProjectAttachment {
  const isUrl = /^https?:\/\//i.test(a.path);
  const mime = (a.mimeType ?? "").toLowerCase();
  let kind: AttachmentKind = "file";
  if (isUrl) kind = "url";
  else if (mime.startsWith("image/")) kind = "image";
  else if (
    mime === "text/markdown" ||
    mime === "text/x-markdown" ||
    a.name.toLowerCase().endsWith(".md")
  )
    kind = "doc";
  else if (mime.startsWith("text/") || mime === "application/pdf") kind = "doc";
  return {
    id: a.id,
    kind,
    label: a.name,
    ...(isUrl ? { url: a.path } : { path: a.path }),
    addedAt: a.createdAt,
  };
}

function projectToSummary(p: KanbanProject): ProjectSummary {
  return {
    id: p.id,
    projectId: p.id,
    name: p.name,
    status: mapStatus(p.status),
    agentId: KANBAN_AGENT_ID,
    percent: typeof p.progress === "number" ? p.progress : 0,
    lastActivityAt: p.updatedAt ?? p.createdAt ?? Date.now(),
  };
}

function projectToSession(
  p: KanbanProject,
  kanbanAttachments: KanbanProjectAttachment[] = [],
): ProjectSession {
  const now = Date.now();
  const attachments = kanbanAttachments.map(kanbanAttachmentToSessionAttachment);
  return {
    id: p.id,
    projectId: p.id,
    name: p.name,
    description: p.description,
    techStack: p.type,
    attachments: attachments.length > 0 ? attachments : undefined,
    agentId: KANBAN_AGENT_ID,
    sessionKey: `kanban:${p.id}`,
    status: mapStatus(p.status),
    progress: {
      percent: typeof p.progress === "number" ? p.progress : 0,
      currentStep: 1,
      totalSteps: 1,
      // No subtasks plumbed yet — could fetch tasks for this project and
      // surface them, but that doubles the read cost on every dashboard
      // render. Defer until the operator asks for it.
      subtasks: [],
      contextTokens: 0,
      maxContextTokens: 0,
      contextPercent: 0,
      elapsedMs: 0,
    },
    workspacePath: "",
    createdAt: p.createdAt ?? now,
    lastActivityAt: p.updatedAt ?? p.createdAt ?? now,
    staleTimeoutMs: 0,
    recoveryAttempts: 0,
    maxRecoveryAttempts: 0,
  };
}

/**
 * List all kanban projects adapted as ProjectSummary entries.
 * The dashboard's stats bar and grid render from these.
 */
export async function listKanbanProjectsAsSummaries(): Promise<ProjectSummary[]> {
  const store = getKanbanStore();
  const projects = await store.getProjects();
  return projects.map(projectToSummary);
}

/** List all kanban projects adapted as ProjectSession entries. */
export async function listKanbanProjectsAsSessions(): Promise<ProjectSession[]> {
  const store = getKanbanStore();
  const projects = await store.getProjects();
  return projects.map((p) => projectToSession(p, store.getProjectAttachments(p.id)));
}

/** Get a single kanban project by id, adapted as a ProjectSession. */
export async function getKanbanProjectAsSession(id: string): Promise<ProjectSession | null> {
  const store = getKanbanStore();
  const projects = await store.getProjects();
  const found = projects.find((p) => p.id === id || p.notionId === id);
  return found ? projectToSession(found, store.getProjectAttachments(found.id)) : null;
}

/**
 * Aggregate stats for the dashboard's top bar. Computed from the kanban
 * project list so totals match what's actually rendered below.
 */
export function computeStatsFromSummaries(summaries: ProjectSummary[]): {
  total: number;
  running: number;
  paused: number;
  completed: number;
  failed: number;
  stale: number;
} {
  const stats = {
    total: summaries.length,
    running: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    stale: 0,
  };
  for (const s of summaries) {
    if (s.status === "running") stats.running++;
    else if (s.status === "paused") stats.paused++;
    else if (s.status === "completed") stats.completed++;
    else if (s.status === "failed") stats.failed++;
    else if (s.status === "stale") stats.stale++;
  }
  return stats;
}
