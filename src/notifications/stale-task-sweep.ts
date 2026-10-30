/**
 * Stale in-progress task sweep.
 *
 * A task can get stranded in `in_progress` forever: a sub-agent died without a
 * lifecycle event, a run was interrupted by a restart with no recovery, or a
 * human started something and walked away. These tasks silently pile up and
 * make the board lie about what is actually active.
 *
 * This sweep flips any task that has been sitting in `in_progress` with no
 * activity for longer than the staleness window to `review`, and appends an
 * "auto-flagged stale" comment so it surfaces for a human to triage. It does
 * NOT touch `done` / `review` / `todo` tasks.
 *
 * Runs once shortly after gateway start, then every 6 hours. Modelled on
 * `kanban-due-sweep.ts`.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("stale-task-sweep");

/** Tasks idle longer than this (no update) are auto-flagged. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60_000; // 7 days
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000; // every 6h
const BOOT_DELAY_MS = 60_000; // give the gateway a minute to settle first

// taskId → flagged, so a repeating sweep doesn't re-comment the same task.
const flaggedCache = new Set<string>();

export async function runStaleTaskSweep(now: number = Date.now()): Promise<number> {
  let flagged = 0;
  try {
    const { listTasks } = await import("../databases/kanban-store-ops.js");
    const { mcpUpdateTask, mcpAppendTaskNote } = await import("../agents/tools/kanban-tool.js");

    const tasks = listTasks({ status: "in_progress" });
    for (const task of tasks) {
      if (flaggedCache.has(task.id)) continue;
      // Staleness measured from last activity (updatedAt), falling back to
      // createdAt for rows that never updated.
      const lastActivity = task.updatedAt || task.createdAt || now;
      const ageMs = now - lastActivity;
      if (ageMs < STALE_AFTER_MS) continue;

      const ageDays = Math.floor(ageMs / 86_400_000);
      flaggedCache.add(task.id);
      try {
        await mcpUpdateTask(task.id, { status: "review" });
        await mcpAppendTaskNote(
          task.id,
          `🕑 auto-flagged stale — sat in "in_progress" with no activity for ${ageDays} day${
            ageDays === 1 ? "" : "s"
          } (threshold ${Math.floor(STALE_AFTER_MS / 86_400_000)}d). Moved to review for triage.`,
        );
        flagged++;
        log.warn("stale task auto-flagged to review", {
          taskId: task.id,
          title: task.title,
          ageDays,
        });
      } catch (err) {
        // Allow a retry next sweep if the flip/comment failed.
        flaggedCache.delete(task.id);
        log.warn("stale task flip failed (will retry next sweep)", {
          taskId: task.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (flagged > 0) log.info("stale task sweep completed", { flagged });
  } catch (err) {
    log.warn("stale task sweep failed", { error: String(err) });
  }
  return flagged;
}

let _started = false;

export function startStaleTaskSweep(): () => void {
  if (_started) return () => {};
  _started = true;

  const boot = setTimeout(() => {
    void runStaleTaskSweep();
  }, BOOT_DELAY_MS);
  (boot as any).unref?.();

  const interval = setInterval(() => void runStaleTaskSweep(), SWEEP_INTERVAL_MS);
  interval.unref?.();

  log.info("stale task sweep scheduled", {
    staleAfterDays: Math.floor(STALE_AFTER_MS / 86_400_000),
    intervalHours: Math.floor(SWEEP_INTERVAL_MS / 3_600_000),
  });

  return () => {
    _started = false;
    clearTimeout(boot);
    clearInterval(interval);
  };
}

/** Test-only — clear the per-process flagged dedupe cache. */
export function resetStaleTaskSweepCacheForTests(): void {
  flaggedCache.clear();
}
