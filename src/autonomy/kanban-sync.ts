/**
 * Autonomy Architecture — Kanban Sync
 * Syncs autonomy task status changes with the kanban board
 */

import { QueuedTask, QueuedTaskStatus } from "./types.js";
import { logAudit } from "./audit.js";

// Lazy-load kanban store to avoid circular deps
let kanbanStore: any = null;

async function getKanbanStore() {
  if (!kanbanStore) {
    const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
    const { KanbanStore } = await import("../tasks/store.js");
    kanbanStore = new KanbanStore(stateDir);
  }
  return kanbanStore;
}

// Map autonomy status to kanban status
const STATUS_MAP: Record<QueuedTaskStatus, string> = {
  pending: "backlog",
  approved: "todo",
  running: "in_progress",
  completed: "done",
  failed: "review",
  cancelled: "backlog",
  // Parked on an unhealable tool/infra blocker — surfaces in review so the
  // operator notices it needs attention, while the heartbeat keeps retrying.
  blocked: "review",
};

/**
 * Sync autonomy task status to linked kanban task
 */
export async function syncToKanban(task: QueuedTask): Promise<boolean> {
  if (!task.kanbanTaskId) {
    return false; // No linked kanban task
  }

  try {
    const store = await getKanbanStore();
    const kanbanStatus = STATUS_MAP[task.status] || "in_progress";

    // Build update patch
    const patch: Record<string, any> = {
      status: kanbanStatus,
    };

    // Mark done if completed
    if (task.status === "completed") {
      patch.done = true;
    }

    // Add description update with outcome/error
    if (task.status === "completed" && task.outcome) {
      patch.description = `✅ Completed: ${task.outcome}`;
    } else if (task.status === "failed" && task.error) {
      patch.description = `❌ Failed: ${task.error}`;
    }

    // Update kanban task
    const updated = await store.updateTask(task.kanbanTaskId, patch);

    if (updated) {
      logAudit("kanban_sync", `Synced autonomy task to kanban: ${task.title}`, {
        category: "autonomy",
        target: task.id,
        details: {
          kanbanTaskId: task.kanbanTaskId,
          newStatus: kanbanStatus,
          autonomyStatus: task.status,
        },
      });

      // Also sync to Notion if notionId exists
      if (updated.notionId) {
        try {
          await syncToNotionDb(updated.notionId, kanbanStatus, task);
        } catch (e) {
          // Log but don't fail - Notion sync is best-effort
          console.warn("Notion sync failed:", e);
        }
      }

      return true;
    }

    return false;
  } catch (e) {
    console.error("Kanban sync error:", e);
    logAudit("kanban_sync_error", `Failed to sync autonomy task to kanban: ${task.title}`, {
      category: "autonomy",
      target: task.id,
      outcome: "failure",
      details: { error: String(e) },
    });
    return false;
  }
}

/**
 * Sync to Notion (best-effort)
 */
async function syncToNotionDb(notionId: string, status: string, task: QueuedTask): Promise<void> {
  try {
    const { notionUpdateTask } = await import("../tasks/notion-sync.js");

    // Map kanban status to Notion status
    const notionStatusMap: Record<string, string> = {
      backlog: "Not started",
      todo: "Not started",
      in_progress: "In progress",
      review: "Awaiting Response",
      done: "Done",
    };

    await notionUpdateTask(notionId, {
      status: status as any,
      done: task.status === "completed",
    });
  } catch (e) {
    // Notion sync is optional
    throw e;
  }
}

/**
 * Create kanban task from autonomy task (if not linked)
 */
export async function createKanbanTask(task: QueuedTask): Promise<string | null> {
  if (task.kanbanTaskId) {
    return task.kanbanTaskId; // Already linked
  }

  try {
    const store = await getKanbanStore();

    const kanbanTask = await store.createTask({
      title: `🤖 ${task.title}`,
      description: task.description,
      status: STATUS_MAP[task.status] || "backlog",
      projectId: task.kanbanProjectId || "default",
      assignee: "autonomy",
      priority:
        task.priority === "critical"
          ? "critical"
          : task.priority === "high"
            ? "high"
            : task.priority === "low"
              ? "low"
              : "medium",
    });

    logAudit("kanban_created", `Created kanban task for autonomy task: ${task.title}`, {
      category: "autonomy",
      target: task.id,
      details: { kanbanTaskId: kanbanTask.id },
    });

    return kanbanTask.id;
  } catch (e) {
    console.error("Failed to create kanban task:", e);
    return null;
  }
}

export const kanbanSync = {
  sync: syncToKanban,
  create: createKanbanTask,
};
