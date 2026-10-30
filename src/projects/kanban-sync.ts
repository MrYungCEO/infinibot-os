/**
 * Deep Memory Architecture — Kanban/Notion Sync
 *
 * Syncs project sessions with the existing Kanban system and Notion.
 * Each project session becomes a Kanban project, subtasks become tasks.
 */

import { getKanbanStore } from "../tasks/store.js";
import { notionCreateProject, notionCreateTask, notionUpdateTask } from "../tasks/notion-sync.js";
import { getProjectStore } from "./store.js";
import type { ProjectSession, ProjectProgress } from "./types.js";
import type { KanbanProject, KanbanTask, TaskStatus } from "../tasks/types.js";

// ═══════════════════════════════════════════════════════════════════
// STATUS MAPPING
// ═══════════════════════════════════════════════════════════════════

const PROJECT_STATUS_TO_KANBAN: Record<string, string> = {
  pending: "Not started",
  running: "In progress",
  paused: "Reviewing",
  stale: "Reviewing",
  recovering: "In progress",
  completed: "Completed",
  failed: "Completed",
  cancelled: "Completed",
};

const SUBTASK_TO_KANBAN_STATUS: Record<string, TaskStatus> = {
  pending: "todo",
  in_progress: "in_progress",
  completed: "done",
  skipped: "done",
};

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ═══════════════════════════════════════════════════════════════════
// SYNC FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Create or update a Kanban project from a ProjectSession.
 * Also syncs to Notion.
 */
export async function syncProjectToKanban(session: ProjectSession): Promise<KanbanProject | null> {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const kanban = getKanbanStore(stateDir);

  try {
    // Check if project already exists (by matching on projectId in description or name)
    const existingProjects = await kanban.getProjects();
    let existingProject = existingProjects.find(
      (p: KanbanProject) =>
        p.description?.includes(`[session:${session.id}]`) || p.name === session.name,
    );

    const kanbanStatus = PROJECT_STATUS_TO_KANBAN[session.status] ?? "Not started";
    const projectData: Partial<KanbanProject> = {
      name: session.name,
      description: `${session.description ?? ""}\n\n[session:${session.id}]`.trim(),
      status: kanbanStatus as any,
      type: ["AI Projects", "Deep Memory"],
      progress: session.progress.percent,
    };

    if (existingProject) {
      // Update existing
      const updated = await kanban.updateProject(existingProject.id, projectData);
      if (updated) {
        try {
          await notionCreateProject(updated);
        } catch (e) {
          console.warn(`[kanban-sync] Notion sync skipped:`, e);
        }
        console.log(`[kanban-sync] Updated Kanban project for session ${session.projectId}`);
        return updated;
      }
    } else {
      // Create new
      const newId = `proj-${generateId()}`;
      const created = await kanban.createProject({
        id: newId,
        name: projectData.name!,
        description: projectData.description,
        status: projectData.status,
        type: projectData.type,
        progress: projectData.progress,
      });

      if (created) {
        try {
          await notionCreateProject(created);
        } catch (e) {
          console.warn(`[kanban-sync] Notion sync skipped:`, e);
        }
        console.log(
          `[kanban-sync] Created Kanban project for session ${session.projectId}: ${created.id}`,
        );
        return created;
      }
    }

    return existingProject ?? null;
  } catch (error) {
    console.error(`[kanban-sync] Failed to sync project ${session.projectId}:`, error);
    return null;
  }
}

/**
 * Sync all subtasks as Kanban tasks under the project.
 */
export async function syncSubtasksToKanban(
  session: ProjectSession,
  kanbanProjectId: string,
): Promise<KanbanTask[]> {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const kanban = getKanbanStore(stateDir);
  const results: KanbanTask[] = [];

  try {
    const { subtasks } = session.progress;

    // Get existing tasks for this project
    const existingTasks = await kanban.getTasks(kanbanProjectId);

    for (let i = 0; i < subtasks.length; i++) {
      const subtask = subtasks[i];
      const taskRef = `[subtask:${session.id}:${i}]`;

      // Find existing task
      const existing = existingTasks.find((t: KanbanTask) => t.description?.includes(taskRef));

      if (existing) {
        const taskPatch: Partial<KanbanTask> = {
          title: subtask.label,
          description: `${subtask.notes ?? ""}\n\n${taskRef}`.trim(),
          status: SUBTASK_TO_KANBAN_STATUS[subtask.status] ?? "todo",
        };

        const updated = await kanban.updateTask(existing.id, taskPatch);
        if (updated) {
          try {
            await notionUpdateTask(existing.id, taskPatch);
          } catch (e) {
            console.warn(`[kanban-sync] Notion task sync skipped:`, e);
          }
          results.push(updated);
        }
      } else {
        const newTask: Omit<KanbanTask, "id" | "createdAt" | "updatedAt"> = {
          projectId: kanbanProjectId,
          title: subtask.label,
          description: `${subtask.notes ?? ""}\n\n${taskRef}`.trim(),
          status: SUBTASK_TO_KANBAN_STATUS[subtask.status] ?? "todo",
          priority: "medium",
          assignee: session.agentId,
        };

        const created = await kanban.createTask(newTask);
        if (created) {
          try {
            await notionCreateTask(created);
          } catch (e) {
            console.warn(`[kanban-sync] Notion task sync skipped:`, e);
          }
          results.push(created);
        }
      }
    }

    console.log(`[kanban-sync] Synced ${results.length} subtasks for session ${session.projectId}`);
    return results;
  } catch (error) {
    console.error(`[kanban-sync] Failed to sync subtasks for ${session.projectId}:`, error);
    return results;
  }
}

/**
 * Full sync: project + all subtasks.
 */
export async function syncSessionToKanban(session: ProjectSession): Promise<{
  project: KanbanProject | null;
  tasks: KanbanTask[];
}> {
  const project = await syncProjectToKanban(session);

  if (!project) {
    return { project: null, tasks: [] };
  }

  const tasks = await syncSubtasksToKanban(session, project.id);

  return { project, tasks };
}

/**
 * Mark a subtask as complete and sync.
 */
export async function completeSubtaskAndSync(
  sessionId: string,
  subtaskIndex: number,
): Promise<boolean> {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const projectStore = getProjectStore(stateDir);

  const session = projectStore.getSession(sessionId);
  if (!session) return false;

  // Update progress
  const progress = { ...session.progress };
  if (progress.subtasks[subtaskIndex]) {
    progress.subtasks[subtaskIndex].status = "completed";
    progress.subtasks[subtaskIndex].percent = 100;
    progress.subtasks[subtaskIndex].completedAt = Date.now();
  }

  // Recalculate overall progress
  const completed = progress.subtasks.filter((s) => s.status === "completed").length;
  progress.percent = Math.round((completed / progress.subtasks.length) * 100);

  // Update session
  projectStore.updateProgress(sessionId, progress);

  // Sync to kanban
  const updatedSession = projectStore.getSession(sessionId);
  if (updatedSession) {
    await syncSessionToKanban(updatedSession);
  }

  return true;
}
