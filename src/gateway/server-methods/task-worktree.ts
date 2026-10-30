/**
 * Task Worktree Integration
 * Isolated git worktrees for task development
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GatewayRequestHandlers } from "./types.js";

// ── Types ────────────────────────────────────────────────────

interface TaskWorktreeMetadata {
    taskId: string;
    projectPath: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
    createdAt: string;
    lastSync?: string;
}

// ── Helpers ──────────────────────────────────────────────────

const WORKTREE_BASE_DIR = ".infinibot/worktrees/tasks";
const METADATA_DIR = ".infinibot/metadata/worktrees";

function git(args: string, cwd: string): string {
    const opts: any = {
        encoding: "utf-8" as const,
        timeout: 30000,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"] as any,
        cwd,
    };

    // Isolate git env
    const env = { ...process.env };
    for (const k of [
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ]) delete env[k];
    env.HUSKY = "0";
    opts.env = env;

    return execSync(`git ${args}`, opts).toString().trim();
}

function safeGit(args: string, cwd: string): string | null {
    try {
        return git(args, cwd);
    } catch {
        return null;
    }
}

function isGitRepo(cwd: string): boolean {
    try {
        git("rev-parse --git-dir", cwd);
        return true;
    } catch {
        return false;
    }
}

function getWorktreePath(projectPath: string, taskId: string): string {
    return join(projectPath, WORKTREE_BASE_DIR, taskId);
}

function getMetadataPath(projectPath: string, taskId: string): string {
    const metadataDir = join(projectPath, METADATA_DIR);
    if (!existsSync(metadataDir)) {
        mkdirSync(metadataDir, { recursive: true });
    }
    return join(metadataDir, `${taskId}.json`);
}

function sanitizeBranchName(name: string): string {
    // Replace invalid characters with hyphens
    return name.replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/^-+|-+$/g, "");
}

// ── Handlers ─────────────────────────────────────────────────

export const taskWorktreeHandlers: GatewayRequestHandlers = {

    /** Create worktree for a task */
    "task.worktree.create": async ({ params, respond }) => {
        try {
            const taskId = typeof params?.taskId === "string" ? params.taskId : "";
            const projectPath = typeof params?.projectPath === "string" ? params.projectPath : "";
            const baseBranch = typeof params?.baseBranch === "string" ? params.baseBranch : "main";
            const branchName = typeof params?.branchName === "string" ? params.branchName : `task/${taskId}`;

            if (!taskId || !projectPath) {
                respond(false, undefined, { code: "INVALID_REQUEST", message: "taskId and projectPath are required" });
                return;
            }

            const resolvedPath = resolve(projectPath);
            if (!isGitRepo(resolvedPath)) {
                respond(false, undefined, { code: "GIT_ERROR", message: "Not a git repository" });
                return;
            }

            const worktreePath = getWorktreePath(resolvedPath, taskId);

            // Check if worktree already exists
            if (existsSync(worktreePath)) {
                respond(false, undefined, { code: "WORKTREE_ERROR", message: "Worktree already exists for this task" });
                return;
            }

            // Ensure base directory exists
            const baseDir = join(resolvedPath, WORKTREE_BASE_DIR);
            if (!existsSync(baseDir)) {
                mkdirSync(baseDir, { recursive: true });
            }

            // Sanitize branch name
            const safeBranchName = sanitizeBranchName(branchName);

            // Check if branch already exists
            const branchExists = safeGit(`rev-parse --verify ${safeBranchName}`, resolvedPath);

            if (branchExists) {
                // Branch exists, create worktree from it
                git(`worktree add "${worktreePath}" "${safeBranchName}"`, resolvedPath);
            } else {
                // Create new branch from base branch
                git(`worktree add -b "${safeBranchName}" "${worktreePath}" "${baseBranch}"`, resolvedPath);
            }

            // Save metadata
            const metadata: TaskWorktreeMetadata = {
                taskId,
                projectPath: resolvedPath,
                worktreePath,
                branch: safeBranchName,
                baseBranch,
                createdAt: new Date().toISOString(),
            };

            const metadataPath = getMetadataPath(resolvedPath, taskId);
            writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

            respond(true, {
                taskId,
                worktreePath,
                branch: safeBranchName,
                created: true,
            });
        } catch (e: any) {
            respond(false, undefined, { code: "WORKTREE_ERROR", message: e?.message || "Failed to create worktree" });
        }
    },

    /** Get worktree info for a task */
    "task.worktree.get": async ({ params, respond }) => {
        try {
            const taskId = typeof params?.taskId === "string" ? params.taskId : "";
            const projectPath = typeof params?.projectPath === "string" ? params.projectPath : "";

            if (!taskId || !projectPath) {
                respond(false, undefined, { code: "INVALID_REQUEST", message: "taskId and projectPath are required" });
                return;
            }

            const resolvedPath = resolve(projectPath);
            const metadataPath = getMetadataPath(resolvedPath, taskId);

            if (!existsSync(metadataPath)) {
                respond(false, undefined, { code: "WORKTREE_ERROR", message: "Worktree not found for this task" });
                return;
            }

            const metadata: TaskWorktreeMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));

            // Get git status if worktree still exists
            let status: any = null;
            if (existsSync(metadata.worktreePath)) {
                const statusRaw = safeGit("status --porcelain=v1", metadata.worktreePath);
                const lines = statusRaw ? statusRaw.split("\n").filter(Boolean) : [];

                let staged = 0, unstaged = 0, untracked = 0;
                for (const l of lines) {
                    const x = l[0], y = l[1];
                    if (x === "?") { untracked++; continue; }
                    if (x !== " " && x !== "?") staged++;
                    if (y !== " " && y !== "?") unstaged++;
                }

                const ahead = safeGit(`rev-list --count ${metadata.baseBranch}..${metadata.branch}`, metadata.worktreePath);
                const behind = safeGit(`rev-list --count ${metadata.branch}..${metadata.baseBranch}`, metadata.worktreePath);

                status = {
                    clean: lines.length === 0,
                    staged,
                    unstaged,
                    untracked,
                    ahead: ahead ? parseInt(ahead, 10) : 0,
                    behind: behind ? parseInt(behind, 10) : 0,
                };
            }

            respond(true, {
                ...metadata,
                status,
                exists: existsSync(metadata.worktreePath),
            });
        } catch (e: any) {
            respond(false, undefined, { code: "WORKTREE_ERROR", message: e?.message || "Failed to get worktree info" });
        }
    },

    /** Remove task worktree */
    "task.worktree.remove": async ({ params, respond }) => {
        try {
            const taskId = typeof params?.taskId === "string" ? params.taskId : "";
            const projectPath = typeof params?.projectPath === "string" ? params.projectPath : "";
            const deleteBranch = params?.deleteBranch === true;

            if (!taskId || !projectPath) {
                respond(false, undefined, { code: "INVALID_REQUEST", message: "taskId and projectPath are required" });
                return;
            }

            const resolvedPath = resolve(projectPath);
            const metadataPath = getMetadataPath(resolvedPath, taskId);

            if (!existsSync(metadataPath)) {
                respond(false, undefined, { code: "WORKTREE_ERROR", message: "Worktree not found for this task" });
                return;
            }

            const metadata: TaskWorktreeMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));

            // Remove worktree
            if (existsSync(metadata.worktreePath)) {
                try {
                    git(`worktree remove --force "${metadata.worktreePath}"`, resolvedPath);
                } catch (e: any) {
                    // If worktree remove fails, try to clean up manually
                    console.warn(`Failed to remove worktree: ${e.message}`);
                }
            }

            // Delete branch if requested
            if (deleteBranch) {
                try {
                    git(`branch -D "${metadata.branch}"`, resolvedPath);
                } catch {
                    // Branch might not exist or be checked out elsewhere
                }
            }

            // Delete metadata
            unlinkSync(metadataPath);

            respond(true, {
                taskId,
                removed: true,
                branchDeleted: deleteBranch,
            });
        } catch (e: any) {
            respond(false, undefined, { code: "WORKTREE_ERROR", message: e?.message || "Failed to remove worktree" });
        }
    },

    /** Merge task worktree to main */
    "task.worktree.merge": async ({ params, respond }) => {
        try {
            const taskId = typeof params?.taskId === "string" ? params.taskId : "";
            const projectPath = typeof params?.projectPath === "string" ? params.projectPath : "";
            const noFf = params?.noFf !== false; // Default to true
            const deleteBranch = params?.deleteBranch === true;

            if (!taskId || !projectPath) {
                respond(false, undefined, { code: "INVALID_REQUEST", message: "taskId and projectPath are required" });
                return;
            }

            const resolvedPath = resolve(projectPath);
            const metadataPath = getMetadataPath(resolvedPath, taskId);

            if (!existsSync(metadataPath)) {
                respond(false, undefined, { code: "WORKTREE_ERROR", message: "Worktree not found for this task" });
                return;
            }

            const metadata: TaskWorktreeMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));

            // Check for uncommitted changes in worktree
            if (existsSync(metadata.worktreePath)) {
                const status = safeGit("status --porcelain", metadata.worktreePath);
                if (status && status.trim()) {
                    respond(false, undefined, {
                        code: "GIT_ERROR",
                        message: "Worktree has uncommitted changes. Commit them first."
                    });
                    return;
                }
            }

            // Switch to base branch in main repo
            git(`checkout "${metadata.baseBranch}"`, resolvedPath);

            // Merge task branch
            const mergeCmd = noFf ? `merge --no-ff "${metadata.branch}"` : `merge "${metadata.branch}"`;
            const mergeResult = git(mergeCmd, resolvedPath);

            // Delete branch if requested
            if (deleteBranch) {
                try {
                    git(`branch -d "${metadata.branch}"`, resolvedPath);
                } catch {
                    // Branch might be needed elsewhere
                }
            }

            // Update metadata
            metadata.lastSync = new Date().toISOString();
            writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

            respond(true, {
                taskId,
                merged: true,
                result: mergeResult,
                branchDeleted: deleteBranch,
            });
        } catch (e: any) {
            respond(false, undefined, { code: "WORKTREE_ERROR", message: e?.message || "Failed to merge worktree" });
        }
    },
};
