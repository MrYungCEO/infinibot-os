/**
 * Project Context Injection
 *
 * Provides project-specific context to agents:
 * - Working directory override
 * - Project information (mission, progress, subtasks)
 * - Context files from project workspace
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { getProjectStore } from "./store.js";
import { readTaskFile } from "./task-parser.js";
import type { ProjectSession, TaskDocument } from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface ProjectContext {
  /** The linked project session (if any). */
  session: ProjectSession | null;

  /** The working directory for agent operations. */
  workingDir: string | null;

  /** Project-specific context to inject into system prompt. */
  systemPromptContext: string | null;

  /** Files to inject into agent context. */
  contextFiles: Array<{ path: string; content: string }>;

  /** TASK.md content (if exists). */
  taskDocument: TaskDocument | null;
}

// ═══════════════════════════════════════════════════════════════════
// CONTEXT RESOLUTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Get project context for a session.
 *
 * @param sessionKey - The InfiniBot session key
 * @param defaultWorkspaceDir - Default workspace if no project linked
 */
export function getProjectContext(sessionKey: string, defaultWorkspaceDir: string): ProjectContext {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  // Find project linked to this session
  const session = store.listSessions().find((s) => s.sessionKey === sessionKey) ?? null;

  if (!session) {
    return {
      session: null,
      workingDir: null,
      systemPromptContext: null,
      contextFiles: [],
      taskDocument: null,
    };
  }

  // Resolve working directory
  const workingDir = session.workingDir ? resolveUserPath(session.workingDir) : null;

  // Load TASK.md
  const taskDocument = session.workspacePath ? readTaskFile(session.workspacePath) : null;

  // Build system prompt context
  const systemPromptContext = buildProjectPromptContext(session, taskDocument);

  // Load context files
  const contextFiles = loadProjectContextFiles(session, workingDir ?? defaultWorkspaceDir);

  return {
    session,
    workingDir,
    systemPromptContext,
    contextFiles,
    taskDocument,
  };
}

/**
 * Resolve user paths like ~ or relative paths.
 */
function resolveUserPath(p: string): string {
  if (p.startsWith("~")) {
    return join(process.env.HOME || process.env.USERPROFILE || "", p.slice(1));
  }
  return resolve(p);
}

/**
 * Build the project context section for the system prompt.
 */
function buildProjectPromptContext(session: ProjectSession, task: TaskDocument | null): string {
  const lines: string[] = [];

  lines.push(`## Active Project: ${session.name}`);
  lines.push("");
  lines.push(`**Project ID:** \`${session.projectId}\``);
  lines.push(`**Status:** ${session.status}`);
  lines.push(`**Progress:** ${session.progress.percent}% complete`);

  if (session.workingDir) {
    lines.push(`**Working Directory:** \`${session.workingDir}\``);
    lines.push("(All file operations should be relative to this directory)");
  }

  lines.push("");

  // Mission
  if (task?.mission || session.description) {
    lines.push("### Mission");
    lines.push(task?.mission || session.description || "");
    lines.push("");
  }

  // Current progress
  const { subtasks } = session.progress;
  if (subtasks.length > 0) {
    lines.push("### Current Subtasks");
    subtasks.forEach((s, i) => {
      const icon =
        s.status === "completed"
          ? "✅"
          : s.status === "in_progress"
            ? "🔄"
            : s.status === "skipped"
              ? "⏭️"
              : "⬜";
      const pct = s.percent > 0 && s.percent < 100 ? ` (${s.percent}%)` : "";
      lines.push(`${i + 1}. ${icon} ${s.label}${pct}`);
    });
    lines.push("");

    // Find current step
    const currentIdx = subtasks.findIndex(
      (s) => s.status === "in_progress" || s.status === "pending",
    );
    if (currentIdx >= 0) {
      lines.push(`**Current Focus:** ${subtasks[currentIdx].label}`);
      lines.push("");
    }
  }

  // Success criteria
  if (task?.successCriteria && task.successCriteria.length > 0) {
    lines.push("### Success Criteria");
    task.successCriteria.forEach((c) => {
      lines.push(`- [ ] ${c}`);
    });
    lines.push("");
  }

  // Notes
  if (task?.notes && task.notes.length > 0) {
    lines.push("### Project Notes");
    task.notes.forEach((note) => {
      lines.push(`- ${note}`);
    });
    lines.push("");
  }

  lines.push("---");
  lines.push("Update progress with `/project` commands or by editing TASK.md.");

  return lines.join("\n");
}

/**
 * Load context files specified in the project.
 */
function loadProjectContextFiles(
  session: ProjectSession,
  baseDir: string,
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  // Load explicitly specified context files
  const contextFiles = session.contextFiles ?? [];
  for (const relPath of contextFiles) {
    const fullPath = join(baseDir, relPath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        files.push({ path: relPath, content });
      } catch {
        console.warn(`[project-context] Failed to load context file: ${fullPath}`);
      }
    }
  }

  // Load TASK.md if it exists and not already loaded
  if (session.workspacePath) {
    const taskPath = join(session.workspacePath, "TASK.md");
    if (existsSync(taskPath) && !contextFiles.some((f) => f.toLowerCase() === "task.md")) {
      try {
        const content = readFileSync(taskPath, "utf-8");
        files.push({ path: "TASK.md", content });
      } catch {
        console.warn(`[project-context] Failed to load TASK.md`);
      }
    }
  }

  return files;
}

/**
 * Get the effective working directory for a session.
 *
 * Priority:
 * 1. Project's workingDir (if linked)
 * 2. Agent's configured workspace
 * 3. Default workspace
 */
export function getEffectiveWorkingDir(sessionKey: string, agentWorkspaceDir: string): string {
  const context = getProjectContext(sessionKey, agentWorkspaceDir);
  return context.workingDir ?? agentWorkspaceDir;
}

/**
 * Check if a session has a linked project.
 */
export function hasLinkedProject(sessionKey: string): boolean {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);
  return store.listSessions().some((s) => s.sessionKey === sessionKey);
}
