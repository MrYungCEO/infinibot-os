/**
 * Deep Memory Architecture — TASK.md Parser
 *
 * Read/write mission documents that agents load on session init.
 * Format is designed to be both human and agent readable.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type {
  TaskDocument,
  TaskSubtask,
  ProjectSession,
  ProjectProgress,
  Subtask,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// PARSE TASK.md
// ═══════════════════════════════════════════════════════════════════

export function parseTaskDocument(content: string): TaskDocument | null {
  try {
    const lines = content.split("\n");

    // Parse header
    const projectMatch = content.match(/^#\s*PROJECT:\s*(.+)$/m);
    const projectName = projectMatch?.[1]?.trim() ?? "Untitled";

    // Parse mission
    const missionSection = extractSection(lines, "## Mission");
    const mission = missionSection.join("\n").trim();

    // Parse success criteria
    const criteriaSection = extractSection(lines, "## Success Criteria");
    const successCriteria = criteriaSection
      .filter((line) => line.match(/^[-*[\]]\s/))
      .map((line) => line.replace(/^[-*[\]x ]+/i, "").trim());

    // Parse progress
    const progressSection = extractSection(lines, "## Progress");
    const currentStep = extractKeyValue(progressSection, "current_step") ?? 1;
    const totalSteps = extractKeyValue(progressSection, "total_steps") ?? 1;
    const percent = extractKeyValue(progressSection, "percent") ?? 0;

    // Parse subtasks
    const subtasksSection = extractSection(lines, "## Subtasks");
    const subtasks = parseSubtasks(subtasksSection);

    // Parse context
    const contextSection = extractSection(lines, "## Context");
    const assignedAgent = extractKeyValueString(contextSection, "Assigned Agent") ?? "main";
    const startedAt = extractKeyValueString(contextSection, "Started");
    const lastCheckpoint = extractKeyValueString(contextSection, "Last Checkpoint");
    const sessionKey = extractKeyValueString(contextSection, "Session Key") ?? "";

    // Parse project ID from context or derive from name
    const projectIdLine = extractKeyValueString(contextSection, "Project ID");
    const projectId = projectIdLine ?? projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    // Parse notes
    const notesSection = extractSection(lines, "## Notes");
    const notes = notesSection
      .filter((line) => line.trim())
      .map((line) => line.replace(/^[-*]\s*/, "").trim());

    return {
      projectName,
      projectId,
      mission,
      successCriteria,
      currentStep: Number(currentStep),
      totalSteps: Number(totalSteps),
      percent: Number(percent),
      subtasks,
      assignedAgent,
      startedAt,
      lastCheckpoint,
      sessionKey,
      notes,
    };
  } catch (error) {
    console.error("[task-parser] Failed to parse TASK.md:", error);
    return null;
  }
}

function extractSection(lines: string[], header: string): string[] {
  const result: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith(header)) {
      inSection = true;
      continue;
    }

    if (inSection) {
      // Stop at next ## header
      if (line.startsWith("## ")) break;
      result.push(line);
    }
  }

  return result;
}

function extractKeyValue(lines: string[], key: string): number | undefined {
  for (const line of lines) {
    const match = line.match(new RegExp(`${key}:\\s*(\\d+)`, "i"));
    if (match) return parseInt(match[1], 10);
  }
  return undefined;
}

function extractKeyValueString(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const match = line.match(new RegExp(`[-*]?\\s*\\*?\\*?${key}\\*?\\*?:\\s*(.+)$`, "i"));
    if (match) return match[1].trim();
  }
  return undefined;
}

function parseSubtasks(lines: string[]): TaskSubtask[] {
  const subtasks: TaskSubtask[] = [];

  for (const line of lines) {
    // Match: 1. [x] Label (100%) or 1. [~] Label (60%) or 1. [ ] Label (0%)
    const match = line.match(/^\d+\.\s*\[([x~\s])\]\s*(.+?)(?:\s*\((\d+)%\))?$/i);
    if (match) {
      const checkChar = match[1].toLowerCase();
      const label = match[2].trim();
      const percent = match[3]
        ? parseInt(match[3], 10)
        : checkChar === "x"
          ? 100
          : checkChar === "~"
            ? 50
            : 0;

      const status: TaskSubtask["status"] =
        checkChar === "x" ? "completed" : checkChar === "~" ? "in_progress" : "pending";

      subtasks.push({ label, status, percent });
    }
  }

  return subtasks;
}

// ═══════════════════════════════════════════════════════════════════
// RENDER TASK.md
// ═══════════════════════════════════════════════════════════════════

export function renderTaskDocument(doc: TaskDocument): string {
  const lines: string[] = [];

  // Header
  lines.push(`# PROJECT: ${doc.projectName}`);
  lines.push("");

  // Mission
  lines.push("## Mission");
  lines.push(doc.mission);
  lines.push("");

  // Success Criteria
  lines.push("## Success Criteria");
  for (const criterion of doc.successCriteria) {
    lines.push(`- [ ] ${criterion}`);
  }
  lines.push("");

  // Progress
  lines.push("## Progress");
  lines.push(`current_step: ${doc.currentStep}`);
  lines.push(`total_steps: ${doc.totalSteps}`);
  lines.push(`percent: ${doc.percent}`);
  lines.push("");

  // Subtasks
  lines.push("## Subtasks");
  doc.subtasks.forEach((subtask, index) => {
    const checkChar =
      subtask.status === "completed" ? "x" : subtask.status === "in_progress" ? "~" : " ";
    lines.push(`${index + 1}. [${checkChar}] ${subtask.label} (${subtask.percent}%)`);
  });
  lines.push("");

  // Context
  lines.push("## Context");
  lines.push(`- **Project ID**: ${doc.projectId}`);
  lines.push(`- **Assigned Agent**: ${doc.assignedAgent}`);
  if (doc.startedAt) lines.push(`- **Started**: ${doc.startedAt}`);
  if (doc.lastCheckpoint) lines.push(`- **Last Checkpoint**: ${doc.lastCheckpoint}`);
  lines.push(`- **Session Key**: ${doc.sessionKey}`);
  lines.push("");

  // Notes
  lines.push("## Notes");
  for (const note of doc.notes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// FILE OPERATIONS
// ═══════════════════════════════════════════════════════════════════

export function readTaskFile(projectDir: string): TaskDocument | null {
  const taskPath = join(projectDir, "TASK.md");

  if (!existsSync(taskPath)) {
    return null;
  }

  try {
    const content = readFileSync(taskPath, "utf-8");
    return parseTaskDocument(content);
  } catch (error) {
    console.error(`[task-parser] Failed to read ${taskPath}:`, error);
    return null;
  }
}

export function writeTaskFile(projectDir: string, doc: TaskDocument): boolean {
  const taskPath = join(projectDir, "TASK.md");

  try {
    const content = renderTaskDocument(doc);
    writeFileSync(taskPath, content, "utf-8");
    return true;
  } catch (error) {
    console.error(`[task-parser] Failed to write ${taskPath}:`, error);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// SESSION ↔ TASK.md SYNC
// ═══════════════════════════════════════════════════════════════════

export function sessionToTaskDocument(session: ProjectSession): TaskDocument {
  const progress = session.progress;

  return {
    projectName: session.name,
    projectId: session.projectId,
    mission: session.description ?? "",
    successCriteria: [],
    currentStep: progress.currentStep ?? 1,
    totalSteps: progress.totalSteps ?? 1,
    percent: progress.percent ?? 0,
    subtasks: (progress.subtasks ?? []).map((s) => ({
      label: s.label,
      status: s.status === "skipped" ? "completed" : s.status,
      percent: s.percent,
    })),
    assignedAgent: session.agentId,
    startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : undefined,
    lastCheckpoint: session.checkpointId ? new Date().toISOString() : undefined,
    sessionKey: session.sessionKey ?? "",
    notes: [],
  };
}

export function taskDocumentToProgress(doc: TaskDocument): ProjectProgress {
  const subtasks: Subtask[] = doc.subtasks.map((s, i) => ({
    id: `subtask-${i + 1}`,
    label: s.label,
    status: s.status,
    percent: s.percent,
  }));

  return {
    percent: doc.percent,
    currentStep: doc.currentStep,
    totalSteps: doc.totalSteps,
    currentStepLabel: doc.subtasks[doc.currentStep - 1]?.label,
    subtasks,
    contextTokens: 0,
    maxContextTokens: 200000, // Default to Claude's context
    contextPercent: 0,
    elapsedMs: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════
// INIT NEW PROJECT
// ═══════════════════════════════════════════════════════════════════

export interface InitProjectOptions {
  projectId: string;
  name: string;
  mission: string;
  successCriteria: string[];
  subtasks: string[];
  agentId: string;
  sessionKey: string;
}

export function initProjectTask(projectDir: string, opts: InitProjectOptions): TaskDocument {
  const doc: TaskDocument = {
    projectName: opts.name,
    projectId: opts.projectId,
    mission: opts.mission,
    successCriteria: opts.successCriteria,
    currentStep: 1,
    totalSteps: opts.subtasks.length || 1,
    percent: 0,
    subtasks: opts.subtasks.map((label) => ({
      label,
      status: "pending",
      percent: 0,
    })),
    assignedAgent: opts.agentId,
    startedAt: new Date().toISOString(),
    lastCheckpoint: undefined,
    sessionKey: opts.sessionKey,
    notes: [],
  };

  writeTaskFile(projectDir, doc);

  return doc;
}

// ═══════════════════════════════════════════════════════════════════
// UPDATE EXISTING PROJECT
// ═══════════════════════════════════════════════════════════════════

export interface UpdateProjectOptions {
  newSubtasks?: string[];
  newGoals?: string[];
  notes?: string[];
}

/**
 * Update an existing TASK.md with new subtasks and/or goals (for extend flow).
 */
export function updateProjectTask(
  projectDir: string,
  opts: UpdateProjectOptions,
): TaskDocument | null {
  // Read existing
  const doc = readTaskFile(projectDir);
  if (!doc) {
    console.error(`[task-parser] Cannot update - no TASK.md found in ${projectDir}`);
    return null;
  }

  // Add new subtasks
  if (opts.newSubtasks && opts.newSubtasks.length > 0) {
    const newTaskItems: TaskSubtask[] = opts.newSubtasks.map((label) => ({
      label,
      status: "pending",
      percent: 0,
    }));
    doc.subtasks = [...doc.subtasks, ...newTaskItems];
    doc.totalSteps = doc.subtasks.length;

    // Recalculate percent
    const completed = doc.subtasks.filter((s) => s.status === "completed").length;
    doc.percent = Math.round((completed / doc.subtasks.length) * 100);
  }

  // Add new goals
  if (opts.newGoals && opts.newGoals.length > 0) {
    doc.successCriteria = [...doc.successCriteria, ...opts.newGoals];
  }

  // Add notes
  if (opts.notes && opts.notes.length > 0) {
    doc.notes = [...doc.notes, ...opts.notes];
  }

  // Write back
  writeTaskFile(projectDir, doc);

  console.log(
    `[task-parser] Updated TASK.md: +${opts.newSubtasks?.length ?? 0} subtasks, +${opts.newGoals?.length ?? 0} goals`,
  );

  return doc;
}
