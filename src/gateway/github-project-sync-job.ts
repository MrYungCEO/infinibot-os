/**
 * GitHub Project Sync Background Job
 *
 * Runs every 10 minutes (scheduled from server-startup.ts). For each project
 * that has githubLocalPath configured, runs git fetch + git status and updates
 * githubSyncStatus in project_meta. Publishes a federation event when a
 * project transitions from clean → behind or conflict so the UI can react.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getKanbanStore, type GitHubSyncStatus } from "../tasks/store.js";
import { getEventBus } from "../federation/event-bus.js";

const log = createSubsystemLogger("github-project-sync-job");

function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on("error", (e) => resolve({ stdout: "", stderr: String(e), code: 1 }));
  });
}

function parseSyncStatus(statusOutput: string): GitHubSyncStatus {
  const abMatch = statusOutput.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
  if (!abMatch) return "unknown";
  const ahead = parseInt(abMatch[1]!, 10);
  const behind = parseInt(abMatch[2]!, 10);
  if (ahead > 0 && behind > 0) return "diverged";
  if (behind > 0) return "behind";
  if (ahead > 0) return "ahead";
  return "clean";
}

const ALERT_STATUSES: GitHubSyncStatus[] = ["behind", "diverged", "conflict"];

export async function startGitHubProjectSyncPass(): Promise<void> {
  const store = getKanbanStore();
  const allMeta = store.getAllProjectMeta();

  const candidates = Object.entries(allMeta).filter(
    ([, meta]) => meta.githubLocalPath && existsSync(meta.githubLocalPath),
  );

  if (candidates.length === 0) return;

  log.info(`GitHub sync pass: checking ${candidates.length} project(s)`);

  for (const [projectId, meta] of candidates) {
    const localPath = meta.githubLocalPath!;
    try {
      await runGit(["fetch", "--quiet"], localPath);
      const status = await runGit(["status", "--porcelain=v2", "--branch"], localPath);
      const newStatus = parseSyncStatus(status.stdout);
      const prevStatus = meta.githubSyncStatus;

      store.setProjectMeta(projectId, {
        githubLastSyncAt: Date.now(),
        githubSyncStatus: newStatus,
      });

      // Emit notification when project transitions into an alert state
      if (
        ALERT_STATUSES.includes(newStatus) &&
        (!prevStatus || !ALERT_STATUSES.includes(prevStatus as GitHubSyncStatus))
      ) {
        const repoLabel =
          meta.githubRepoOwner && meta.githubRepoName
            ? `${meta.githubRepoOwner}/${meta.githubRepoName}`
            : localPath;
        log.warn(`GitHub repo ${repoLabel} is now ${newStatus}`, { projectId });
        try {
          getEventBus().publish("kanban.github.status_changed" as any, {
            projectId,
            repoLabel,
            previousStatus: prevStatus ?? "unknown",
            newStatus,
            message: `GitHub repo "${repoLabel}" is ${newStatus}`,
          });
        } catch {
          /* event bus may not be ready — non-fatal */
        }
      }
    } catch (err) {
      log.debug(`GitHub sync check failed for ${projectId}`, {
        error: (err as Error).message,
      });
    }
  }
}
