/**
 * Deep Memory Architecture — Session Onboarding
 *
 * When a new session is created, prompt the user to set up a project
 * with mission, goals, and subtasks for tracking.
 *
 * Also handles extensions/updates to existing projects:
 * - Continue: Resume work on existing project
 * - Extend: Add new subtasks, update goals
 * - Switch: Associate session with different project
 */

import { getProjectStore } from "./store.js";
import { syncSessionToKanban } from "./kanban-sync.js";
import { initProjectTask, updateProjectTask } from "./task-parser.js";
import type { ProjectSession, ProjectProgress, Subtask } from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// ONBOARDING STATE
// ═══════════════════════════════════════════════════════════════════

export interface OnboardingState {
  sessionKey: string;
  step: OnboardingStep;
  mode: OnboardingMode; // NEW: Track whether creating/extending/continuing
  projectId?: string;
  name?: string;
  mission?: string;
  goals?: string[];
  subtasks?: string[];
  agentId: string;
  startedAt: number;

  // Working directory & context
  workingDir?: string; // Code/work directory for agent operations
  contextFiles?: string[]; // Files to inject into agent context

  // Extension fields
  existingSessionId?: string; // If extending/continuing an existing project
  existingProject?: ProjectSession; // Cached existing project data
  newSubtasks?: string[]; // Additional subtasks for extension
  newGoals?: string[]; // Additional goals for extension
}

export type OnboardingMode =
  | "create" // Creating a new project
  | "continue" // Resuming existing project (just re-link session)
  | "extend" // Adding to existing project (new subtasks/goals)
  | "switch"; // Choosing from multiple existing projects

export type OnboardingStep =
  | "welcome"
  | "choose_action" // Choose create/continue/extend
  | "select_project" // Pick from existing projects
  | "name_project"
  | "define_mission"
  | "set_working_dir" // Set working directory for agent operations
  | "set_goals"
  | "create_subtasks"
  | "extend_subtasks" // Add subtasks to existing
  | "extend_goals" // Add goals to existing
  | "confirm"
  | "confirm_extension" // Confirm extension changes
  | "complete";

// In-memory onboarding sessions (cleared on restart)
const activeOnboarding = new Map<string, OnboardingState>();

// ═══════════════════════════════════════════════════════════════════
// ONBOARDING FLOW
// ═══════════════════════════════════════════════════════════════════

/**
 * Start onboarding for a new session.
 * Optionally pass existing projects to enable continue/extend flows.
 */
export function startOnboarding(
  sessionKey: string,
  agentId: string,
  existingProjects?: ProjectSession[],
): OnboardingState {
  // Determine initial step based on whether existing projects exist
  const hasExisting = existingProjects && existingProjects.length > 0;
  const initialStep = hasExisting ? "choose_action" : "welcome";

  const state: OnboardingState = {
    sessionKey,
    step: initialStep,
    mode: "create",
    agentId,
    startedAt: Date.now(),
    goals: [],
    subtasks: [],
    newSubtasks: [],
    newGoals: [],
  };

  activeOnboarding.set(sessionKey, state);
  console.log(
    `[onboarding] Started onboarding for session ${sessionKey} (hasExisting: ${hasExisting})`,
  );

  return state;
}

/**
 * Get active/recent projects that could be continued or extended.
 */
export function getExistingProjectsForOnboarding(agentId?: string): ProjectSession[] {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const allSessions = store.listSessions();

  // Filter to active/paused projects (exclude completed/failed/cancelled)
  // Optionally filter by agent
  return allSessions.filter((s) => {
    const isActive = ["running", "paused", "stale", "pending"].includes(s.status);
    const matchesAgent = !agentId || s.agentId === agentId;
    return isActive && matchesAgent;
  });
}

/**
 * Get current onboarding state for a session.
 */
export function getOnboardingState(sessionKey: string): OnboardingState | null {
  return activeOnboarding.get(sessionKey) ?? null;
}

/**
 * Check if a session is in onboarding.
 */
export function isOnboarding(sessionKey: string): boolean {
  const state = activeOnboarding.get(sessionKey);
  return state !== undefined && state.step !== "complete";
}

/**
 * Advance to the next onboarding step.
 */
export function advanceOnboarding(
  sessionKey: string,
  data: Partial<OnboardingState>,
): OnboardingState | null {
  const state = activeOnboarding.get(sessionKey);
  if (!state) return null;

  // Update state with provided data
  Object.assign(state, data);

  // Advance step based on current step and mode
  switch (state.step) {
    case "welcome":
      state.mode = "create";
      state.step = "name_project";
      break;

    case "choose_action":
      // Mode was set by parseOnboardingInput
      if (state.mode === "create") {
        state.step = "name_project";
      } else if (state.mode === "continue" || state.mode === "switch") {
        state.step = "select_project";
      } else if (state.mode === "extend") {
        state.step = "select_project";
      }
      break;

    case "select_project":
      if (state.existingSessionId && state.existingProject) {
        if (state.mode === "continue") {
          // Just re-link and complete
          state.step = "complete";
        } else if (state.mode === "extend") {
          state.step = "extend_subtasks";
        }
      }
      break;

    case "name_project":
      if (state.name && state.projectId) {
        state.step = "define_mission";
      }
      break;

    case "define_mission":
      if (state.mission) {
        state.step = "set_working_dir";
      }
      break;

    case "set_working_dir":
      // workingDir is optional, can skip
      state.step = "set_goals";
      break;

    case "set_goals":
      if (state.goals && state.goals.length > 0) {
        state.step = "create_subtasks";
      }
      break;

    case "create_subtasks":
      if (state.subtasks && state.subtasks.length > 0) {
        state.step = "confirm";
      }
      break;

    case "extend_subtasks":
      // Can be empty (skip adding subtasks)
      state.step = "extend_goals";
      break;

    case "extend_goals":
      // Can be empty (skip adding goals)
      state.step = "confirm_extension";
      break;

    case "confirm":
      state.step = "complete";
      break;

    case "confirm_extension":
      state.step = "complete";
      break;
  }

  activeOnboarding.set(sessionKey, state);
  return state;
}

/**
 * Skip onboarding (user doesn't want to create a project).
 */
export function skipOnboarding(sessionKey: string): void {
  activeOnboarding.delete(sessionKey);
  console.log(`[onboarding] Skipped onboarding for session ${sessionKey}`);
}

/**
 * Complete onboarding — handles create, continue, and extend modes.
 */
export async function completeOnboarding(sessionKey: string): Promise<ProjectSession | null> {
  const state = activeOnboarding.get(sessionKey);
  if (!state) {
    console.error(`[onboarding] Cannot complete - no state found`);
    return null;
  }

  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  try {
    // Handle based on mode
    if (state.mode === "continue" && state.existingProject) {
      // CONTINUE: Just update the session key and resume
      return await completeContinueMode(state, store, sessionKey);
    }

    if (state.mode === "extend" && state.existingProject) {
      // EXTEND: Add new subtasks/goals to existing project
      return await completeExtendMode(state, store, sessionKey);
    }

    // CREATE: New project flow (original behavior)
    return await completeCreateMode(state, store, sessionKey);
  } catch (error) {
    console.error(`[onboarding] Failed to complete onboarding:`, error);
    return null;
  }
}

/**
 * Complete CREATE mode — new project.
 */
async function completeCreateMode(
  state: OnboardingState,
  store: ReturnType<typeof getProjectStore>,
  sessionKey: string,
): Promise<ProjectSession | null> {
  if (!state.name || !state.mission || !state.projectId) {
    console.error(`[onboarding] Cannot complete CREATE - missing required fields`);
    return null;
  }

  // Create subtasks
  const subtasks: Subtask[] = (state.subtasks ?? []).map((label, i) => ({
    id: `subtask-${i + 1}`,
    label,
    status: "pending" as const,
    percent: 0,
  }));

  const progress: ProjectProgress = {
    percent: 0,
    currentStep: 1,
    totalSteps: subtasks.length || 1,
    currentStepLabel: subtasks[0]?.label,
    subtasks,
    contextTokens: 0,
    maxContextTokens: 200000,
    contextPercent: 0,
    elapsedMs: 0,
  };

  // Create project directory and TASK.md
  const projectDir = store.ensureProjectDir(state.projectId);

  // Create session in DB
  const session = store.createSession({
    id: undefined as any,
    projectId: state.projectId,
    name: state.name,
    description: state.mission,
    agentId: state.agentId,
    sessionKey,
    status: "running",
    progress,
    workspacePath: projectDir,
    workingDir: state.workingDir, // User-specified working directory
    contextFiles: state.contextFiles, // Files to inject into agent context
    staleTimeoutMs: 300000,
    maxRecoveryAttempts: 3,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  });

  // Write TASK.md
  initProjectTask(projectDir, {
    projectId: state.projectId,
    name: state.name,
    mission: state.mission,
    successCriteria: state.goals ?? [],
    subtasks: state.subtasks ?? [],
    agentId: state.agentId,
    sessionKey,
  });

  // Sync to Kanban/Notion
  await syncSessionToKanban(session);

  // Clean up onboarding state
  activeOnboarding.delete(sessionKey);

  console.log(
    `[onboarding] Completed CREATE for session ${sessionKey} → project ${state.projectId}`,
  );

  return session;
}

/**
 * Complete CONTINUE mode — resume existing project with new session.
 */
async function completeContinueMode(
  state: OnboardingState,
  store: ReturnType<typeof getProjectStore>,
  sessionKey: string,
): Promise<ProjectSession | null> {
  const existing = state.existingProject;
  if (!existing) {
    console.error(`[onboarding] Cannot complete CONTINUE - no existing project`);
    return null;
  }

  // Update the existing session with the new sessionKey
  const updated = store.updateSession(existing.id, {
    sessionKey,
    status: "running",
    heartbeatAt: Date.now(),
    lastActivityAt: Date.now(),
  });

  if (!updated) {
    console.error(`[onboarding] Failed to update session for CONTINUE`);
    return null;
  }

  // Clean up onboarding state
  activeOnboarding.delete(sessionKey);

  console.log(
    `[onboarding] Completed CONTINUE for session ${sessionKey} → resumed ${existing.projectId}`,
  );

  return updated;
}

/**
 * Complete EXTEND mode — add new subtasks/goals to existing project.
 */
async function completeExtendMode(
  state: OnboardingState,
  store: ReturnType<typeof getProjectStore>,
  sessionKey: string,
): Promise<ProjectSession | null> {
  const existing = state.existingProject;
  if (!existing) {
    console.error(`[onboarding] Cannot complete EXTEND - no existing project`);
    return null;
  }

  // Merge new subtasks with existing
  const existingSubtasks = [...existing.progress.subtasks];
  const newSubtasks: Subtask[] = (state.newSubtasks ?? []).map((label, i) => ({
    id: `subtask-${existingSubtasks.length + i + 1}`,
    label,
    status: "pending" as const,
    percent: 0,
  }));

  const allSubtasks = [...existingSubtasks, ...newSubtasks];

  // Recalculate progress
  const completed = allSubtasks.filter((s) => s.status === "completed").length;
  const percent = allSubtasks.length > 0 ? Math.round((completed / allSubtasks.length) * 100) : 0;

  const updatedProgress: ProjectProgress = {
    ...existing.progress,
    subtasks: allSubtasks,
    totalSteps: allSubtasks.length,
    percent,
  };

  // Update the session
  const updated = store.updateSession(existing.id, {
    sessionKey,
    status: "running",
    progress: updatedProgress,
    heartbeatAt: Date.now(),
    lastActivityAt: Date.now(),
  });

  if (!updated) {
    console.error(`[onboarding] Failed to update session for EXTEND`);
    return null;
  }

  // Update TASK.md with new subtasks
  if (existing.workspacePath) {
    updateProjectTask(existing.workspacePath, {
      newSubtasks: state.newSubtasks ?? [],
      newGoals: state.newGoals ?? [],
    });
  }

  // Sync to Kanban/Notion
  await syncSessionToKanban(updated);

  // Clean up onboarding state
  activeOnboarding.delete(sessionKey);

  console.log(
    `[onboarding] Completed EXTEND for session ${sessionKey} → extended ${existing.projectId} with ${newSubtasks.length} subtasks`,
  );

  return updated;
}

// ═══════════════════════════════════════════════════════════════════
// ONBOARDING PROMPTS
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the prompt for the current onboarding step.
 */
export function getOnboardingPrompt(
  state: OnboardingState,
  existingProjects?: ProjectSession[],
): string {
  switch (state.step) {
    case "welcome":
      return `🚀 **New Session Started**

Would you like to set up a tracked project for this session? This enables:
- Progress tracking with visual progress bars
- Crash recovery (resume where you left off)
- Kanban board integration
- Notion sync

Reply **"yes"** to start project setup, or **"skip"** to continue without tracking.`;

    case "choose_action":
      const projects = existingProjects ?? getExistingProjectsForOnboarding(state.agentId);
      const projectList = projects
        .map((p, i) => `  ${i + 1}. **${p.name}** (${p.progress.percent}% complete, ${p.status})`)
        .join("\n");

      return `🚀 **Session Started**

You have existing active projects:
${projectList}

What would you like to do?
- **"continue [number]"** — Resume an existing project
- **"extend [number]"** — Add subtasks to an existing project  
- **"new"** — Create a new project
- **"skip"** — Continue without tracking`;

    case "select_project":
      const selectProjects = existingProjects ?? getExistingProjectsForOnboarding(state.agentId);
      const selectList = selectProjects
        .map(
          (p, i) =>
            `  ${i + 1}. **${p.name}**
     └ ${p.progress.percent}% | ${p.progress.subtasks.length} subtasks | ${p.status}
     └ ${p.description?.slice(0, 80) ?? "No description"}...`,
        )
        .join("\n\n");

      const actionWord = state.mode === "continue" ? "continue" : "extend";

      return `📂 **Select Project to ${actionWord.charAt(0).toUpperCase() + actionWord.slice(1)}**

${selectList}

Enter the project number to ${actionWord}:`;

    case "name_project":
      return `📝 **Step 1: Name Your Project**

What would you like to call this project?

Example: "Build Image Generation Pipeline"

Also provide a short ID (lowercase, hyphens): e.g., "image-gen-pipeline"`;

    case "define_mission":
      return `🎯 **Step 2: Define the Mission**

What is the main goal of this project? Describe what success looks like.

Example: "Create a working image generation system that can produce high-quality images from text prompts using ComfyUI and custom models."`;

    case "set_working_dir":
      return `📁 **Step 3: Working Directory (Optional)**

What directory should the agent work in for this project?

This sets the agent's working directory for file operations, git, and code execution.

Examples:
- \`C:\\Projects\\my-project\`
- \`~/projects/my-app\`
- \`./relative/path\`

Reply with a path, or **"skip"** to use the default workspace.

You can also specify context files (comma-separated) that should be loaded:
\`path/to/dir, README.md, src/main.ts\``;

    case "set_goals":
      return `✅ **Step 4: Success Criteria**

List the key goals that must be achieved (one per line):

Example:
- ComfyUI backend connected and working
- REST API for image generation
- At least 3 model profiles configured
- Documentation complete`;

    case "create_subtasks":
      return `📋 **Step 4: Break It Down**

List the major steps/phases for this project (one per line):

Example:
- Set up ComfyUI server
- Create FastAPI wrapper
- Implement model registry
- Add workflow templates
- Test and document`;

    case "extend_subtasks":
      const existingSubs = state.existingProject?.progress.subtasks ?? [];
      const currentList = existingSubs
        .map((s, i) => {
          const icon = s.status === "completed" ? "✅" : s.status === "in_progress" ? "🔄" : "⬜";
          return `  ${icon} ${s.label}`;
        })
        .join("\n");

      return `➕ **Add Subtasks**

Current subtasks for "${state.existingProject?.name}":
${currentList}

Add new subtasks (one per line), or reply **"skip"** to continue:`;

    case "extend_goals":
      return `➕ **Add Goals (Optional)**

Add any new success criteria (one per line), or reply **"skip"** to continue:`;

    case "confirm":
      const workingDirLine = state.workingDir
        ? `**Working Directory:** \`${state.workingDir}\``
        : "**Working Directory:** (default workspace)";
      const contextFilesLine = state.contextFiles?.length
        ? `**Context Files:** ${state.contextFiles.join(", ")}`
        : "";

      return `✨ **Ready to Create Project**

**Name:** ${state.name}
**ID:** ${state.projectId}
${workingDirLine}
${contextFilesLine}

**Mission:**
${state.mission}

**Goals:**
${state.goals?.map((g) => `- ${g}`).join("\n")}

**Subtasks:**
${state.subtasks?.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Reply **"create"** to create this project, or **"back"** to make changes.`;

    case "confirm_extension":
      const newSubCount = state.newSubtasks?.length ?? 0;
      const newGoalCount = state.newGoals?.length ?? 0;

      return `✨ **Ready to Extend Project**

**Project:** ${state.existingProject?.name}

**New Subtasks (${newSubCount}):**
${state.newSubtasks?.map((s, i) => `+ ${s}`).join("\n") || "(none)"}

**New Goals (${newGoalCount}):**
${state.newGoals?.map((g) => `+ ${g}`).join("\n") || "(none)"}

Reply **"confirm"** to extend this project, or **"back"** to make changes.`;

    case "complete":
      if (state.mode === "continue") {
        return `🔄 **Resumed Project!**

Continuing work on "${state.existingProject?.name}" (${state.existingProject?.progress.percent}% complete).

Let's continue where we left off!`;
      }

      if (state.mode === "extend") {
        const addedCount = (state.newSubtasks?.length ?? 0) + (state.newGoals?.length ?? 0);
        return `✨ **Project Extended!**

Added ${addedCount} new items to "${state.existingProject?.name}".

Let's continue the work!`;
      }

      return `🎉 **Project Created!**

Your project "${state.name}" is now being tracked. You can:
- View progress in the Projects dashboard
- See tasks on the Kanban board
- Resume from checkpoints if interrupted

Let's get started!`;

    default:
      return "";
  }
}

/**
 * Parse user input for the current onboarding step.
 */
export function parseOnboardingInput(
  state: OnboardingState,
  input: string,
  existingProjects?: ProjectSession[],
): { advance: boolean; data?: Partial<OnboardingState>; error?: string } {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  switch (state.step) {
    case "welcome":
      if (lower === "yes" || lower === "y" || lower === "start") {
        return { advance: true };
      }
      if (lower === "skip" || lower === "no" || lower === "n") {
        return { advance: false, error: "SKIP" };
      }
      return {
        advance: false,
        error: 'Please reply "yes" to start or "skip" to continue without tracking.',
      };

    case "choose_action":
      const projects = existingProjects ?? getExistingProjectsForOnboarding(state.agentId);

      // "continue 1" or "continue"
      const continueMatch = lower.match(/^continue\s*(\d+)?$/);
      if (continueMatch) {
        const idx = continueMatch[1] ? parseInt(continueMatch[1], 10) - 1 : 0;
        const project = projects[idx];
        if (!project) {
          return { advance: false, error: `Invalid project number. Choose 1-${projects.length}.` };
        }
        return {
          advance: true,
          data: {
            mode: "continue",
            existingSessionId: project.id,
            existingProject: project,
          },
        };
      }

      // "extend 1" or "extend"
      const extendMatch = lower.match(/^extend\s*(\d+)?$/);
      if (extendMatch) {
        const idx = extendMatch[1] ? parseInt(extendMatch[1], 10) - 1 : 0;
        const project = projects[idx];
        if (!project) {
          return { advance: false, error: `Invalid project number. Choose 1-${projects.length}.` };
        }
        return {
          advance: true,
          data: {
            mode: "extend",
            existingSessionId: project.id,
            existingProject: project,
          },
        };
      }

      // "new" — create new project
      if (lower === "new" || lower === "create") {
        return { advance: true, data: { mode: "create" } };
      }

      // "skip"
      if (lower === "skip" || lower === "no" || lower === "n") {
        return { advance: false, error: "SKIP" };
      }

      // Just a number — assume continue
      const numMatch = lower.match(/^(\d+)$/);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        const project = projects[idx];
        if (!project) {
          return { advance: false, error: `Invalid project number. Choose 1-${projects.length}.` };
        }
        return {
          advance: true,
          data: {
            mode: "continue",
            existingSessionId: project.id,
            existingProject: project,
          },
        };
      }

      return {
        advance: false,
        error: 'Reply "continue [n]", "extend [n]", "new", or "skip".',
      };

    case "select_project":
      const selectProjects = existingProjects ?? getExistingProjectsForOnboarding(state.agentId);
      const selectMatch = lower.match(/^(\d+)$/);
      if (selectMatch) {
        const idx = parseInt(selectMatch[1], 10) - 1;
        const project = selectProjects[idx];
        if (!project) {
          return {
            advance: false,
            error: `Invalid project number. Choose 1-${selectProjects.length}.`,
          };
        }
        return {
          advance: true,
          data: {
            existingSessionId: project.id,
            existingProject: project,
          },
        };
      }

      if (lower === "back") {
        return { advance: false, data: { step: "choose_action" } };
      }

      return { advance: false, error: 'Enter a project number or "back".' };

    case "name_project":
      // Parse "Name" and "ID" from input
      const lines = trimmed
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      let name = lines[0];
      let projectId = lines[1] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

      if (!name || name.length < 3) {
        return { advance: false, error: "Please provide a project name (at least 3 characters)." };
      }

      return { advance: true, data: { name, projectId } };

    case "define_mission":
      if (trimmed.length < 10) {
        return { advance: false, error: "Please provide a more detailed mission statement." };
      }
      return { advance: true, data: { mission: trimmed } };

    case "set_working_dir":
      if (lower === "skip" || lower === "none" || lower === "") {
        return { advance: true, data: { workingDir: undefined, contextFiles: undefined } };
      }

      // Parse "path, file1, file2" format
      const parts = trimmed
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const workingDir = parts[0];
      const contextFiles = parts.slice(1);

      return {
        advance: true,
        data: {
          workingDir,
          contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
        },
      };

    case "set_goals":
      const goals = trimmed
        .split("\n")
        .map((l) => l.replace(/^[-*•]\s*/, "").trim())
        .filter((l) => l.length > 0);

      if (goals.length === 0) {
        return { advance: false, error: "Please provide at least one success criterion." };
      }

      return { advance: true, data: { goals } };

    case "create_subtasks":
      const subtasks = trimmed
        .split("\n")
        .map((l) =>
          l
            .replace(/^\d+\.\s*/, "")
            .replace(/^[-*•]\s*/, "")
            .trim(),
        )
        .filter((l) => l.length > 0);

      if (subtasks.length === 0) {
        return { advance: false, error: "Please provide at least one subtask." };
      }

      return { advance: true, data: { subtasks } };

    case "extend_subtasks":
      if (lower === "skip" || lower === "none") {
        return { advance: true, data: { newSubtasks: [] } };
      }

      const newSubtasks = trimmed
        .split("\n")
        .map((l) =>
          l
            .replace(/^\d+\.\s*/, "")
            .replace(/^[-*•+]\s*/, "")
            .trim(),
        )
        .filter((l) => l.length > 0);

      return { advance: true, data: { newSubtasks } };

    case "extend_goals":
      if (lower === "skip" || lower === "none") {
        return { advance: true, data: { newGoals: [] } };
      }

      const newGoals = trimmed
        .split("\n")
        .map((l) => l.replace(/^[-*•+]\s*/, "").trim())
        .filter((l) => l.length > 0);

      return { advance: true, data: { newGoals } };

    case "confirm":
      if (lower === "create" || lower === "yes" || lower === "confirm") {
        return { advance: true };
      }
      if (lower === "back" || lower === "edit") {
        // Go back to name step
        return { advance: false, data: { step: "name_project" } };
      }
      return {
        advance: false,
        error: 'Please reply "create" to create the project or "back" to edit.',
      };

    case "confirm_extension":
      if (lower === "confirm" || lower === "yes") {
        return { advance: true };
      }
      if (lower === "back" || lower === "edit") {
        return { advance: false, data: { step: "extend_subtasks" } };
      }
      return {
        advance: false,
        error: 'Please reply "confirm" to extend the project or "back" to edit.',
      };

    default:
      return { advance: false };
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUTO-ONBOARDING HOOK
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a session should trigger onboarding.
 * Returns info about existing projects that could be continued.
 */
export function shouldTriggerOnboarding(sessionKey: string): {
  trigger: boolean;
  existingProjects: ProjectSession[];
  reason: "new_session" | "has_active_projects" | "skip";
} {
  // Only trigger for webchat sessions
  if (!sessionKey.includes("webchat")) {
    return { trigger: false, existingProjects: [], reason: "skip" };
  }

  // Don't trigger if already onboarding
  if (isOnboarding(sessionKey)) {
    return { trigger: false, existingProjects: [], reason: "skip" };
  }

  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  // Check if this session already has a project
  const existingSession = store.listSessions().find((s) => s.sessionKey === sessionKey);
  if (existingSession) {
    return { trigger: false, existingProjects: [], reason: "skip" };
  }

  // Check for other active projects that could be continued
  const activeProjects = store
    .listSessions()
    .filter((s) => ["running", "paused", "stale", "pending"].includes(s.status));

  if (activeProjects.length > 0) {
    // Has active projects — trigger with "choose_action" flow
    return { trigger: true, existingProjects: activeProjects, reason: "has_active_projects" };
  }

  // No active projects — trigger normal "welcome" flow
  return { trigger: true, existingProjects: [], reason: "new_session" };
}
