/**
 * Auto-skill generator for robust kanban tasks.
 *
 * When a task is created with `complexity: "robust"` and carries enough
 * signal (a non-empty `content` body that mentions at least two of
 * what/where/details), we synthesize a workspace skill — a frontmatter-
 * prefixed `SKILL.md` under the InfiniBot skill workspace — so the next
 * time an agent grinds through a similar task, the skill is loaded
 * automatically by the existing skill subsystem (see
 * `src/agents/skills/workspace.ts`).
 *
 * Storage rules:
 *   - Files land under `<workspaceSkillsDir>/skill-<slug>/SKILL.md`.
 *   - `workspaceSkillsDir` defaults to `${CONFIG_DIR}/skills` — i.e.
 *     `~/.infinibot/skills/` — which is the "managed skills" dir picked up
 *     by `loadWorkspaceSkillEntries`. Override via `INFINIBOT_STATE_DIR`
 *     (the standard InfiniBot env var) or via the optional `targetDir`
 *     param for tests.
 *   - Frontmatter includes `name`, `description`, `source: auto-task`,
 *     `taskId` and `taskTitle` so dedupe/inspection is possible.
 *
 * Safety: the writer NEVER throws upward. Failures are logged and result
 * in a null return, so the task itself can still be saved.
 *
 * Secret hygiene: before writing, content is scrubbed for common secret
 * patterns (`accessToken=...`, `Authorization: Bearer ...`) to avoid
 * accidentally caching credentials into a re-loaded skill.
 */
import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../utils.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { KanbanTask, TaskSkillRef } from "./types.js";

const log = createSubsystemLogger("auto-skill");

const fsp = fs.promises;

const SKILL_NAME_MAX = 60;

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SKILL_NAME_MAX) || "task"
  );
}

/**
 * Strip patterns that commonly indicate secrets so we never persist them
 * into a skill that lives on disk for the rest of the workspace's life.
 */
export function sanitizeSkillBody(input: string): string {
  if (!input) return "";
  return input
    .replace(/(access[_-]?token\s*[:=]\s*)([^\s"',}]+)/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s"',}]+)/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)([^\s"',]+)/gi, "$1[REDACTED]")
    .replace(/(password\s*[:=]\s*)([^\s"',}]+)/gi, "$1[REDACTED]")
    .replace(/(secret\s*[:=]\s*)([^\s"',}]+)/gi, "$1[REDACTED]")
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/ghp_[a-zA-Z0-9]{20,}/g, "[REDACTED]")
    .replace(/xox[bps]-[a-zA-Z0-9-]+/g, "[REDACTED]");
}

function countSignalSections(content: string | undefined): number {
  if (!content) return 0;
  const lower = content.toLowerCase();
  let n = 0;
  // Match the markers buildTaskContent emits at the standard/robust levels.
  if (/\bwhat[:\s]/i.test(content) || /\*\*what\*\*/i.test(content)) n++;
  if (/\bwhere[:\s]/i.test(content) || /\*\*where\*\*/i.test(content)) n++;
  if (/\bdetails[:\s]/i.test(content) || /\*\*details\*\*/i.test(content)) n++;
  // Robust mode emits `## What`, `## Where`, `## Details` headings — also count.
  if (/^##\s+what\b/m.test(lower)) n = Math.max(n, 1);
  if (/^##\s+where\b/m.test(lower)) n = Math.max(n, 2);
  if (/^##\s+details\b/m.test(lower)) n = Math.max(n, 3);
  return n;
}

function defaultWorkspaceSkillsDir(): string {
  // Use the same dir the skill loader treats as `managedSkillsDir` so
  // auto-generated skills are picked up by the next agent run.
  return path.join(CONFIG_DIR, "skills");
}

function escapeFrontmatterValue(value: string): string {
  // Use a single-quoted YAML scalar; escape any embedded single quotes per YAML rules.
  return `'${value.replace(/'/g, "''")}'`;
}

function buildSkillFile(params: {
  skillName: string;
  description: string;
  task: Pick<KanbanTask, "id" | "title" | "content">;
  reason: string;
  createdAt: number;
}): string {
  const safeBody = sanitizeSkillBody(params.task.content ?? "");
  const fm = [
    "---",
    `name: ${params.skillName}`,
    `description: ${escapeFrontmatterValue(params.description)}`,
    `source: auto-task`,
    `taskId: ${escapeFrontmatterValue(params.task.id)}`,
    `taskTitle: ${escapeFrontmatterValue(params.task.title)}`,
    `createdAt: ${params.createdAt}`,
    "---",
  ].join("\n");

  const body = [
    `# ${params.task.title}`,
    "",
    "## Why this skill exists",
    params.reason,
    "",
    "## Captured task content",
    safeBody || "_No task content captured._",
  ].join("\n");

  return `${fm}\n\n${body}\n`;
}

export interface MaybeGenerateSkillOptions {
  /** Override the workspace dir — primarily for tests. */
  targetDir?: string;
}

/**
 * Generate a workspace skill for a robust task when the signal warrants
 * it. Returns the skill reference for the caller to persist on the task,
 * or `null` when no skill was produced. Never throws.
 */
export async function maybeGenerateSkillForTask(
  task: KanbanTask,
  opts: MaybeGenerateSkillOptions = {},
): Promise<TaskSkillRef | null> {
  try {
    if (task.complexity !== "robust") return null;
    if (!task.content || !task.content.trim()) return null;
    if (countSignalSections(task.content) < 2) return null;

    const dir = opts.targetDir ?? defaultWorkspaceSkillsDir();
    const baseName = `skill-${slugify(task.title || task.id)}`;
    const skillDir = path.join(dir, baseName);
    const skillFile = path.join(skillDir, "SKILL.md");

    // Idempotency: if a file already exists for this task id, reuse it.
    if (fs.existsSync(skillFile)) {
      try {
        const raw = fs.readFileSync(skillFile, "utf-8");
        if (raw.includes(`taskId: '${task.id.replace(/'/g, "''")}'`)) {
          return {
            id: baseName,
            name: baseName,
            path: skillFile,
            reason: `Reused existing auto-skill for task "${task.title}"`,
            createdAt: Date.now(),
          };
        }
      } catch {
        /* fall through and overwrite */
      }
    }

    await fsp.mkdir(skillDir, { recursive: true });

    const createdAt = Date.now();
    const description = `Auto-generated playbook captured from kanban task: ${task.title.slice(
      0,
      160,
    )}`;
    const reason = `Captured from a robust kanban task so future agents can replay the same steps.`;

    const fileContents = buildSkillFile({
      skillName: baseName,
      description,
      task: { id: task.id, title: task.title, content: task.content },
      reason,
      createdAt,
    });

    await fsp.writeFile(skillFile, fileContents, "utf-8");

    log.info("auto-skill generated", {
      taskId: task.id,
      skillName: baseName,
      path: skillFile,
    });

    return {
      id: baseName,
      name: baseName,
      path: skillFile,
      reason,
      createdAt,
    };
  } catch (err) {
    log.warn("auto-skill generation failed", {
      taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
