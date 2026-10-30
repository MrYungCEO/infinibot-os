/**
 * GitHub Project Sync Tool
 *
 * Lets agents query / sync git state for projects that have a linked GitHub
 * repo. All git/gh operations shell out to the local CLI — no PATs embedded.
 *
 * Actions:
 *   status              — git fetch + parse ahead/behind/conflict state
 *   pull                — git pull --ff-only
 *   diff_against_remote — diff local HEAD vs origin/<default branch>
 *   list_open_prs       — gh pr list for the linked repo
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getKanbanStore } from "../../tasks/store.js";
import { STATE_DIR } from "../../config/paths.js";

const log = createSubsystemLogger("github-project-sync");

const ACTIONS = ["status", "pull", "diff_against_remote", "list_open_prs"] as const;

const GithubProjectSyncSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: "status | pull | diff_against_remote | list_open_prs",
  }),
  project_id: Type.String({ description: "The kanban project ID to operate on." }),
});

function getStore() {
  return getKanbanStore(resolve(STATE_DIR));
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    log.debug("spawn", { cmd, args, cwd });
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
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

function parseBranch(statusOutput: string): string {
  const m = statusOutput.match(/^# branch\.head (.+)$/m);
  return m?.[1] ?? "unknown";
}

function parseSyncStatus(
  statusOutput: string,
): "clean" | "behind" | "ahead" | "diverged" | "unknown" {
  const abMatch = statusOutput.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
  if (!abMatch) return "unknown";
  const ahead = parseInt(abMatch[1]!, 10);
  const behind = parseInt(abMatch[2]!, 10);
  if (ahead > 0 && behind > 0) return "diverged";
  if (behind > 0) return "behind";
  if (ahead > 0) return "ahead";
  return "clean";
}

export function createGithubProjectSyncTool(): AnyAgentTool {
  return {
    label: "GitHub Project Sync",
    name: "github_project_sync",
    description: `Sync and inspect the GitHub repo linked to a kanban project. Requires the project to have githubLocalPath configured. All git/gh operations use the authenticated gh CLI — no tokens needed.

Actions:
- status: Run git fetch then report ahead/behind/diverged/clean state. Updates githubSyncStatus in the project record.
- pull: Run git pull --ff-only. Updates githubSyncStatus to clean or conflict.
- diff_against_remote: Show diff between local HEAD and origin/<default branch>.
- list_open_prs: List open pull requests via gh CLI for the linked repo.`,
    parameters: GithubProjectSyncSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const projectId = readStringParam(params, "project_id", { required: true });

      const meta = getStore().getProjectMeta(projectId);
      if (!meta) {
        return jsonResult({ error: `No metadata found for project ${projectId}` });
      }

      if (action === "list_open_prs") {
        if (!meta.githubRepoOwner || !meta.githubRepoName) {
          return jsonResult({
            error: "Project has no GitHub repo configured (githubRepoOwner/githubRepoName missing)",
          });
        }
        const result = await run(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            `${meta.githubRepoOwner}/${meta.githubRepoName}`,
            "--json",
            "number,title,state,author,url,createdAt,headRefName",
            "--limit",
            "20",
          ],
          process.cwd(),
        );
        if (result.code !== 0) {
          return jsonResult({ error: `gh pr list failed: ${result.stderr}` });
        }
        let prs: unknown[] = [];
        try {
          prs = JSON.parse(result.stdout);
        } catch {
          /* leave empty */
        }
        return jsonResult({
          repo: `${meta.githubRepoOwner}/${meta.githubRepoName}`,
          prs,
          count: (prs as unknown[]).length,
        });
      }

      // All remaining actions need a valid local path
      if (!meta.githubLocalPath) {
        return jsonResult({ error: "Project has no githubLocalPath configured" });
      }
      const localPath = meta.githubLocalPath;
      if (!existsSync(localPath)) {
        return jsonResult({ error: `githubLocalPath does not exist on disk: ${localPath}` });
      }

      if (action === "status") {
        await run("git", ["fetch", "--quiet"], localPath);
        const status = await run("git", ["status", "--porcelain=v2", "--branch"], localPath);
        const syncStatus = parseSyncStatus(status.stdout);
        const branch = parseBranch(status.stdout);
        getStore().setProjectMeta(projectId, {
          githubLastSyncAt: Date.now(),
          githubSyncStatus: syncStatus,
        });
        return jsonResult({ syncStatus, branch, raw: status.stdout.trim() });
      }

      if (action === "pull") {
        await run("git", ["fetch", "--quiet"], localPath);
        const pull = await run("git", ["pull", "--ff-only"], localPath);
        const syncStatus = pull.code === 0 ? "clean" : ("conflict" as const);
        getStore().setProjectMeta(projectId, {
          githubLastSyncAt: Date.now(),
          githubSyncStatus: syncStatus,
        });
        return jsonResult({
          success: pull.code === 0,
          syncStatus,
          output: (pull.stdout + pull.stderr).trim(),
        });
      }

      if (action === "diff_against_remote") {
        const branch = meta.githubDefaultBranch || "main";
        await run("git", ["fetch", "--quiet"], localPath);
        const diff = await run("git", ["diff", `origin/${branch}...HEAD`], localPath);
        return jsonResult({ branch, diff: diff.stdout });
      }

      return jsonResult({ error: `Unknown action: ${action}` });
    },
  };
}
