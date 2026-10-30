/**
 * Checkpoint System
 * Save and restore project states using git tags + metadata
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { GatewayRequestHandlers } from "./types.js";

// ── Types ────────────────────────────────────────────────────

interface CheckpointMetadata {
    id: string;
    projectPath: string;
    description: string;
    createdAt: string;
    gitHash: string;
    gitTag: string;
    taskIds?: string[];
    kanbanSnapshot?: {
        projects?: any[];
        tasks?: any[];
    };
}

// ── Helpers ──────────────────────────────────────────────────

const CHECKPOINT_DIR = join(process.cwd(), "state", "checkpoints");

function ensureCheckpointDir(): void {
    if (!existsSync(CHECKPOINT_DIR)) {
        mkdirSync(CHECKPOINT_DIR, { recursive: true });
    }
}

function getProjectCheckpointDir(projectPath: string): string {
    ensureCheckpointDir();
    // Create safe directory name from project path
    const safeName = projectPath.replace(/[^a-zA-Z0-9]/g, "_");
    const dir = join(CHECKPOINT_DIR, safeName);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getCheckpointMetadataPath(projectPath: string, checkpointId: string): string {
    return join(getProjectCheckpointDir(projectPath), `${checkpointId}.json`);
}

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

function generateCheckpointId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const shortId = randomUUID().slice(0, 8);
    return `${timestamp}-${shortId}`;
}

function generateCheckpointTag(checkpointId: string): string {
    return `checkpoint/${checkpointId}`;
}

// ── Handlers ─────────────────────────────────────────────────

export const checkpointHandlers: GatewayRequestHandlers = {

    /** Create a checkpoint (git tag + metadata) */
    "checkpoint.create": async ({ params, respond }) => {
        try {
            const projectPath = typeof params?.projectPath === "string" ? params.projectPath : "";
            const description = typeof params?.description === "string" ? params.description : "Checkpoint";

            if (!projectPath) {
                respond(false, undefined, { code: "INVALID_REQUEST", message: "projectPath is required" });
                return;
            }

            const resolvedPath = resolve(projectPath);
            if (!existsSync(resolvedPath)) {
                respond(false, undefined, { code: "INVALID_REQUEST", message: "Project path does not exist" });
                return;
            }

            if (!isGitRepo(resolvedPath)) {
                respond(false, undefined, { code: "GIT_ERROR", message: "Not a git repository" });
                return;
            }

            // Check for uncommitted changes
            const status = safeGit("status --porcelain", resolvedPath);
            if (status && status.trim()) {
                respond(false, undefined, {
                    code: "GIT_ERROR",
                    message: "Repository has uncommitted changes. Commit or stash them first."
                });
                return;
            }

            // Generate checkpoint ID and tag
            const checkpointId = generateCheckpointId();
            const gitTag = generateCheckpointTag(checkpointId);
            const gitHash = git("rev-parse HEAD", resolvedPath);

            // Create annotated git tag
            const escapedDesc = description.replace(/"/g, '\\"');
            git(`tag -a "${gitTag}" -m "${escapedDesc}"`, resolvedPath);

            // Save checkpoint metadata
            const metadata: CheckpointMetadata = {
                id: checkpointId,
                projectPath: resolvedPath,
                description,
                createdAt: new Date().toISOString(),
                gitHash,
                gitTag,
                taskIds: (Array.isArray(params?.taskIds) ? params.taskIds : []) as string[],
                kanbanSnapshot: (params?.kanbanSnapshot as CheckpointMetadata["kanbanSnapshot"]) || {},
            };

            const metadataPath = getCheckpointMetadataPath(resolvedPath, checkpointId);
            writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

            respond(true, {
                checkpointId,
                gitTag,
                gitHash,
                createdAt: metadata.createdAt,
            });
        } catch (e: any) {
            respond(false, undefined, { code: "CHECKPOINT_ERROR", message: e?.message || "Failed to create checkpoint" });
        }
    },

    /** List all checkpoints for a project */
    "checkpoint.list": async ({ params, respond }) => {
        try {
            const projectPath = typeof params?.projectPath === "string" ? params.projectPath : "";

            if (!projectPath) {
                respond(false, undefined, { code: "INVALID_REQUEST", message: "projectPath is required" });
                return;
            }

            const resolvedPath = resolve(projectPath);
            const checkpointDir = getProjectCheckpointDir(resolvedPath);

            if (!existsSync(checkpointDir)) {
                respond(true, { checkpoints: [] });
                return;
            }

            // Read all checkpoint metadata files
            const files = readdirSync(checkpointDir).filter(f => f.endsWith(".json"));
            const checkpoints: CheckpointMetadata[] = [];

            for (const file of files) {
                try {
                    const content = readFileSync(join(checkpointDir, file), "utf8");
                    const metadata: CheckpointMetadata = JSON.parse(content);
                    checkpoints.push(metadata);
                } catch {
                    // Skip invalid metadata files
                }
            }

            // Sort by creation date (newest first)
            checkpoints.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

            respond(true, { checkpoints });
        } catch (e: any) {
            respond(false, undefined, { code: "CHECKPOINT_ERROR", message: e?.message || "Failed to list checkpoints" });
        }
    },

    /** Restore project to a checkpoint */
    "checkpoint.restore": async ({ params, respond }) => {
        try {
            const projectPath = typeof params?.projectPath === "string" ? params.projectPath : "";
            const checkpointId = typeof params?.checkpointId === "string" ? params.checkpointId : "";
            const createBranch = params?.createBranch === true;
            const branchName = typeof params?.branchName === "string" ? params.branchName : "";

            if (!projectPath || !checkpointId) {
                respond(false, undefined, { code: "INVALID_REQUEST", message: "projectPath and checkpointId are required" });
                return;
            }

            const resolvedPath = resolve(projectPath);
            if (!isGitRepo(resolvedPath)) {
                respond(false, undefined, { code: "GIT_ERROR", message: "Not a git repository" });
                return;
            }

            // Load checkpoint metadata
            const metadataPath = getCheckpointMetadataPath(resolvedPath, checkpointId);
            if (!existsSync(metadataPath)) {
                respond(false, undefined, { code: "CHECKPOINT_ERROR", message: "Checkpoint not found" });
                return;
            }

            const metadata: CheckpointMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));

            // Check for uncommitted changes
            const status = safeGit("status --porcelain", resolvedPath);
            if (status && status.trim()) {
                respond(false, undefined, {
                    code: "GIT_ERROR",
                    message: "Repository has uncommitted changes. Commit or stash them first."
                });
                return;
            }

            // Checkout the checkpoint tag
            if (createBranch && branchName) {
                git(`checkout -b "${branchName}" "${metadata.gitTag}"`, resolvedPath);
            } else {
                git(`checkout "${metadata.gitTag}"`, resolvedPath);
            }

            respond(true, {
                checkpointId,
                gitTag: metadata.gitTag,
                gitHash: metadata.gitHash,
                restored: true,
                branch: createBranch ? branchName : null,
            });
        } catch (e: any) {
            respond(false, undefined, { code: "CHECKPOINT_ERROR", message: e?.message || "Failed to restore checkpoint" });
        }
    },

    /** Delete a checkpoint */
    "checkpoint.delete": async ({ params, respond }) => {
        try {
            const projectPath = typeof params?.projectPath === "string" ? params.projectPath : "";
            const checkpointId = typeof params?.checkpointId === "string" ? params.checkpointId : "";

            if (!projectPath || !checkpointId) {
                respond(false, undefined, { code: "INVALID_REQUEST", message: "projectPath and checkpointId are required" });
                return;
            }

            const resolvedPath = resolve(projectPath);
            if (!isGitRepo(resolvedPath)) {
                respond(false, undefined, { code: "GIT_ERROR", message: "Not a git repository" });
                return;
            }

            // Load checkpoint metadata
            const metadataPath = getCheckpointMetadataPath(resolvedPath, checkpointId);
            if (!existsSync(metadataPath)) {
                respond(false, undefined, { code: "CHECKPOINT_ERROR", message: "Checkpoint not found" });
                return;
            }

            const metadata: CheckpointMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));

            // Delete git tag
            try {
                git(`tag -d "${metadata.gitTag}"`, resolvedPath);
            } catch {
                // Tag might not exist, continue
            }

            // Delete metadata file
            unlinkSync(metadataPath);

            respond(true, {
                checkpointId,
                deleted: true,
            });
        } catch (e: any) {
            respond(false, undefined, { code: "CHECKPOINT_ERROR", message: e?.message || "Failed to delete checkpoint" });
        }
    },
};
