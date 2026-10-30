/**
 * Kanban due/overdue task notification sweep.
 * Runs once at gateway startup (immediately if past 09:00, else waits),
 * then repeats daily at 09:00 local time.
 *
 * Fires:
 *   - kanban.task.due  → severity "warn"  (due today)
 *   - kanban.task.due  → severity "error" (overdue)
 *
 * Dedupes per taskId per calendar day to avoid repeated firings on gateway restart.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitNotification } from "./emit.js";

const log = createSubsystemLogger("kanban-due-sweep");

// taskId:dateIso → fired
const firedCache = new Map<string, boolean>();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function minutesSinceMidnight(now = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

function msUntilHour(hour: number): number {
  const now = new Date();
  const targetMin = hour * 60;
  const nowMin = minutesSinceMidnight(now);
  let delta = (targetMin - nowMin) * 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds();
  if (delta <= 0) delta += 24 * 60 * 60_000;
  return delta;
}

async function runSweep(stateDir?: string): Promise<void> {
  try {
    const today = todayIso();
    firedCache.clear(); // Reset for new day sweep

    const { listTasks, getProject } = await import("../databases/kanban-store-ops.js");
    const tasks = listTasks();

    for (const task of tasks) {
      if (task.status === "done") continue;
      if (!task.dueDate) continue;

      const dueIso = task.dueDate.slice(0, 10);
      const cacheKey = `${task.id}:${today}`;
      if (firedCache.has(cacheKey)) continue;

      const projectName = task.projectId ? (getProject(task.projectId)?.name ?? null) : null;

      if (dueIso === today) {
        firedCache.set(cacheKey, true);
        await emitNotification({
          category: "kanban.task.due",
          severity: "warn",
          title: "⏰ Due today",
          body: [task.title, projectName].filter(Boolean).join(" • "),
          source: "kanban",
          sourceId: `due:${task.id}:${today}`,
          deepLink: `infinibot://board/task/${task.id}`,
          data: {
            taskId: task.id,
            projectId: task.projectId,
            projectName: projectName ?? undefined,
            title: task.title,
            status: task.status,
            priority: task.priority,
            dueAt: task.dueDate,
            assignee: task.assignee,
          },
          stateDir,
        });
      } else if (dueIso < today) {
        // Overdue: calculate days late
        const dueTs = new Date(dueIso).getTime();
        const todayTs = new Date(today).getTime();
        const daysOverdue = Math.floor((todayTs - dueTs) / 86_400_000);
        const s = daysOverdue === 1 ? "" : "s";

        firedCache.set(cacheKey, true);
        await emitNotification({
          category: "kanban.task.due",
          severity: "error",
          title: "🔴 Overdue",
          body: `${task.title} • ${daysOverdue} day${s} late`,
          source: "kanban",
          sourceId: `overdue:${task.id}:${today}`,
          deepLink: `infinibot://board/task/${task.id}`,
          data: {
            taskId: task.id,
            projectId: task.projectId,
            projectName: projectName ?? undefined,
            title: task.title,
            status: task.status,
            priority: task.priority,
            dueAt: task.dueDate,
            assignee: task.assignee,
            daysOverdue,
          },
          stateDir,
        });
      }
    }

    log.info("kanban due sweep completed", { date: today });
  } catch (err) {
    log.warn("kanban due sweep failed", { error: String(err) });
  }
}

let _started = false;

export function startKanbanDueSweep(stateDir?: string): () => void {
  if (_started) return () => {};
  _started = true;

  const SWEEP_HOUR = 9;
  const delay = msUntilHour(SWEEP_HOUR);

  const boot = setTimeout(() => {
    void runSweep(stateDir);
    setInterval(() => void runSweep(stateDir), 24 * 60 * 60_000).unref?.();
  }, delay);
  (boot as any).unref?.();

  // If gateway starts after 09:00, run immediately so nothing is missed.
  if (minutesSinceMidnight() >= SWEEP_HOUR * 60) {
    void runSweep(stateDir);
  }

  log.info("kanban due sweep scheduled", { nextRunIn: `${Math.round(delay / 60_000)}m` });

  return () => {
    _started = false;
    clearTimeout(boot);
  };
}
