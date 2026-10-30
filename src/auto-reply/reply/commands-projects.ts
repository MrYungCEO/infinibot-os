/**
 * Slash Commands for Project and Session Management
 *
 * /project — Project management (list, new, status, extend)
 * /session — Session management (list, switch, info)
 * /onboard — Trigger onboarding manually
 */

import { logVerbose } from "../../globals.js";
import {
  getProjectStore,
  getOnboardingState,
  startOnboarding,
  getOnboardingPrompt,
  getExistingProjectsForOnboarding,
  type ProjectSession,
} from "../../projects/index.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

// ═══════════════════════════════════════════════════════════════════
// /project COMMAND
// ═══════════════════════════════════════════════════════════════════

export const handleProjectCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

  const match = params.command.commandBodyNormalized.match(/^\/project(?:\s+(.*))?$/i);
  if (!match) return null;

  const subcommand = (match[1] ?? "status").trim().toLowerCase();
  const args = subcommand.split(/\s+/);
  const action = args[0] || "status";

  // Check authorization for write actions
  const writeActions = ["new", "create", "extend", "complete", "pause", "resume"];
  if (writeActions.includes(action) && !params.command.isAuthorizedSender) {
    logVerbose(`Ignoring /project ${action} from unauthorized sender`);
    return { shouldContinue: false };
  }

  try {
    switch (action) {
      case "list":
        return handleProjectList(params);

      case "status":
      case "info":
        return handleProjectStatus(params, args[1]);

      case "new":
      case "create":
        return handleProjectNew(params);

      case "extend":
        return handleProjectExtend(params, args[1]);

      case "complete":
        return handleProjectComplete(params, args[1]);

      case "pause":
        return handleProjectPause(params, args[1]);

      case "resume":
        return handleProjectResume(params, args[1]);

      case "help":
      default:
        return {
          shouldContinue: false,
          reply: { text: getProjectHelpText() },
        };
    }
  } catch (error) {
    console.error("[commands-projects] Error:", error);
    return {
      shouldContinue: false,
      reply: { text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error"}` },
    };
  }
};

function getProjectHelpText(): string {
  return `📋 **Project Commands**

\`/project\` or \`/project status\` — Current project status
\`/project list\` — List all projects
\`/project new\` — Start onboarding for new project
\`/project extend [id]\` — Add subtasks to a project
\`/project complete [id]\` — Mark project as complete
\`/project pause [id]\` — Pause a project
\`/project resume [id]\` — Resume a paused project
\`/project help\` — Show this help`;
}

function handleProjectList(params: any): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);
  const sessions = store.listSessions();

  if (sessions.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: "📋 No projects found. Use `/project new` to create one." },
    };
  }

  const statusEmoji: Record<string, string> = {
    running: "🟢",
    paused: "⏸️",
    completed: "✅",
    failed: "❌",
    stale: "⚠️",
    pending: "⏳",
    recovering: "🔄",
    cancelled: "🚫",
  };

  const lines = sessions.map((s, i) => {
    const emoji = statusEmoji[s.status] || "❓";
    const progress = `${s.progress.percent}%`;
    return `${i + 1}. ${emoji} **${s.name}** (${progress}) — ${s.status}`;
  });

  return {
    shouldContinue: false,
    reply: { text: `📋 **Projects (${sessions.length})**\n\n${lines.join("\n")}` },
  };
}

function handleProjectStatus(params: any, projectId?: string): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  // Find current project for this session, or by ID
  let session: ProjectSession | undefined;

  if (projectId) {
    session = store.getSessionByProjectId(projectId) ?? undefined;
  } else {
    // Find project linked to current session
    session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  }

  if (!session) {
    return {
      shouldContinue: false,
      reply: {
        text: "📋 No active project in this session. Use `/project list` or `/project new`.",
      },
    };
  }

  const progress = session.progress;
  const completedTasks = progress.subtasks.filter((s) => s.status === "completed").length;
  const totalTasks = progress.subtasks.length;

  // Progress bar
  const barLength = 20;
  const filled = Math.round((progress.percent / 100) * barLength);
  const progressBar = "█".repeat(filled) + "░".repeat(barLength - filled);

  const subtaskList = progress.subtasks
    .map((s, i) => {
      const icon = s.status === "completed" ? "✅" : s.status === "in_progress" ? "🔄" : "⬜";
      return `  ${icon} ${s.label}`;
    })
    .join("\n");

  const text = `📊 **${session.name}**
  
**Progress:** ${progressBar} ${progress.percent}%
**Status:** ${session.status}
**Tasks:** ${completedTasks}/${totalTasks} complete

**Subtasks:**
${subtaskList}

**ID:** \`${session.projectId}\``;

  return {
    shouldContinue: false,
    reply: { text },
  };
}

function handleProjectNew(params: any): CommandHandlerResult {
  // Check if already onboarding
  const existing = getOnboardingState(params.sessionKey);
  if (existing) {
    return {
      shouldContinue: false,
      reply: { text: getOnboardingPrompt(existing) },
    };
  }

  // Start fresh onboarding
  const agentId = params.agentId || "main";
  const existingProjects = getExistingProjectsForOnboarding(agentId);
  const state = startOnboarding(params.sessionKey, agentId, existingProjects);

  return {
    shouldContinue: false,
    reply: { text: getOnboardingPrompt(state, existingProjects) },
  };
}

function handleProjectExtend(params: any, projectId?: string): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  // Find project
  let session: ProjectSession | undefined;
  if (projectId) {
    session = store.getSessionByProjectId(projectId) ?? undefined;
  } else {
    session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  }

  if (!session) {
    return {
      shouldContinue: false,
      reply: {
        text: "❌ No project found. Specify project ID or link a project to this session first.",
      },
    };
  }

  // Start extend onboarding flow
  const agentId = params.agentId || "main";
  const state = startOnboarding(params.sessionKey, agentId, [session]);

  // Set mode to extend and pre-select the project
  state.mode = "extend";
  state.existingSessionId = session.id;
  state.existingProject = session;
  state.step = "extend_subtasks";

  return {
    shouldContinue: false,
    reply: { text: getOnboardingPrompt(state) },
  };
}

function handleProjectComplete(params: any, projectId?: string): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  let session: ProjectSession | undefined;
  if (projectId) {
    session = store.getSessionByProjectId(projectId) ?? undefined;
  } else {
    session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  }

  if (!session) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No project found." },
    };
  }

  store.updateSession(session.id, {
    status: "completed",
    completedAt: Date.now(),
  });

  return {
    shouldContinue: false,
    reply: { text: `✅ Project "${session.name}" marked as complete!` },
  };
}

function handleProjectPause(params: any, projectId?: string): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  let session: ProjectSession | undefined;
  if (projectId) {
    session = store.getSessionByProjectId(projectId) ?? undefined;
  } else {
    session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  }

  if (!session) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No project found." },
    };
  }

  store.updateSession(session.id, {
    status: "paused",
    pausedAt: Date.now(),
  });

  return {
    shouldContinue: false,
    reply: { text: `⏸️ Project "${session.name}" paused.` },
  };
}

function handleProjectResume(params: any, projectId?: string): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  let session: ProjectSession | undefined;
  if (projectId) {
    session = store.getSessionByProjectId(projectId) ?? undefined;
  } else {
    session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  }

  if (!session) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No project found." },
    };
  }

  store.updateSession(session.id, {
    status: "running",
    heartbeatAt: Date.now(),
  });

  return {
    shouldContinue: false,
    reply: { text: `▶️ Project "${session.name}" resumed.` },
  };
}

// ═══════════════════════════════════════════════════════════════════
// /session COMMAND
// ═══════════════════════════════════════════════════════════════════

export const handleSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

  const match = params.command.commandBodyNormalized.match(/^\/session(?:\s+(.*))?$/i);
  if (!match) return null;

  const subcommand = (match[1] ?? "info").trim().toLowerCase();
  const args = subcommand.split(/\s+/);
  const action = args[0] || "info";

  try {
    switch (action) {
      case "list":
        return handleSessionList(params);

      case "info":
      case "status":
        return handleSessionInfo(params);

      case "link":
        return handleSessionLink(params, args[1]);

      case "unlink":
        return handleSessionUnlink(params);

      case "help":
      default:
        return {
          shouldContinue: false,
          reply: { text: getSessionHelpText() },
        };
    }
  } catch (error) {
    console.error("[commands-projects] Session error:", error);
    return {
      shouldContinue: false,
      reply: { text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error"}` },
    };
  }
};

function getSessionHelpText(): string {
  return `💬 **Session Commands**

\`/session\` or \`/session info\` — Current session info
\`/session list\` — List sessions with linked projects
\`/session link <project-id>\` — Link this session to a project
\`/session unlink\` — Unlink current project
\`/session help\` — Show this help`;
}

function handleSessionList(params: any): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);
  const sessions = store.listSessions();

  const lines = sessions.map((s, i) => {
    const isCurrent = s.sessionKey === params.sessionKey;
    const marker = isCurrent ? "→ " : "  ";
    return `${marker}${i + 1}. **${s.name}** — \`${s.sessionKey?.slice(0, 30)}...\``;
  });

  if (lines.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: "💬 No project sessions found." },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `💬 **Sessions with Projects**\n\n${lines.join("\n")}` },
  };
}

function handleSessionInfo(params: any): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  // Find linked project
  const linkedProject = store.listSessions().find((s) => s.sessionKey === params.sessionKey);

  const projectInfo = linkedProject
    ? `**Linked Project:** ${linkedProject.name} (${linkedProject.progress.percent}%)`
    : "**Linked Project:** None";

  const text = `💬 **Session Info**

**Key:** \`${params.sessionKey}\`
**Agent:** ${params.agentId || "main"}
**Channel:** ${params.command.channel}
${projectInfo}`;

  return {
    shouldContinue: false,
    reply: { text },
  };
}

function handleSessionLink(params: any, projectId?: string): CommandHandlerResult {
  if (!projectId) {
    return {
      shouldContinue: false,
      reply: { text: "❌ Usage: `/session link <project-id>`" },
    };
  }

  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const session = store.getSessionByProjectId(projectId);
  if (!session) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Project "${projectId}" not found.` },
    };
  }

  // Update session key
  store.updateSession(session.id, {
    sessionKey: params.sessionKey,
    status: "running",
    heartbeatAt: Date.now(),
  });

  return {
    shouldContinue: false,
    reply: { text: `🔗 Linked this session to project "${session.name}".` },
  };
}

function handleSessionUnlink(params: any): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  if (!session) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No project linked to this session." },
    };
  }

  // Clear session key (but don't delete the project)
  store.updateSession(session.id, {
    sessionKey: "",
    status: "paused",
    pausedAt: Date.now(),
  });

  return {
    shouldContinue: false,
    reply: { text: `🔓 Unlinked project "${session.name}" from this session.` },
  };
}

// ═══════════════════════════════════════════════════════════════════
// /onboard COMMAND
// ═══════════════════════════════════════════════════════════════════

export const handleOnboardCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

  const normalized = params.command.commandBodyNormalized.trim().toLowerCase();
  const match =
    normalized === "/onboard" ||
    normalized === "/onboarding" ||
    normalized.startsWith("/onboard ") ||
    normalized.startsWith("/onboarding ");
  if (!match) return null;

  console.log(`[commands-projects] /onboard matched, sessionKey: ${params.sessionKey}`);

  // Check if already in onboarding
  const existing = getOnboardingState(params.sessionKey);
  if (existing) {
    return {
      shouldContinue: false,
      reply: { text: getOnboardingPrompt(existing) },
    };
  }

  // Start onboarding
  const agentId = params.agentId || "main";
  const existingProjects = getExistingProjectsForOnboarding(agentId);
  const state = startOnboarding(params.sessionKey, agentId, existingProjects);

  return {
    shouldContinue: false,
    reply: { text: getOnboardingPrompt(state, existingProjects) },
  };
};

// ═══════════════════════════════════════════════════════════════════
// /cmd COMMAND — Working Directory & Context Management
// ═══════════════════════════════════════════════════════════════════

export const handleCmdCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

  const match = params.command.commandBodyNormalized.match(/^\/cmd(?:\s+(.*))?$/i);
  if (!match) return null;

  const subcommand = (match[1] ?? "").trim().toLowerCase();
  const args = subcommand.split(/\s+/);
  const action = args[0] || "help";

  // Write actions require authorization
  const writeActions = ["cwd", "cd", "context", "add", "remove", "clear"];
  if (writeActions.includes(action) && !params.command.isAuthorizedSender) {
    logVerbose(`Ignoring /cmd ${action} from unauthorized sender`);
    return { shouldContinue: false };
  }

  try {
    switch (action) {
      case "cwd":
      case "cd":
        return handleCmdCwd(params, args.slice(1).join(" "));

      case "pwd":
      case "dir":
        return handleCmdPwd(params);

      case "context":
        if (args[1] === "add") {
          return handleCmdContextAdd(params, args.slice(2).join(" "));
        }
        if (args[1] === "remove" || args[1] === "rm") {
          return handleCmdContextRemove(params, args.slice(2).join(" "));
        }
        if (args[1] === "clear") {
          return handleCmdContextClear(params);
        }
        if (args[1] === "list" || args[1] === "ls" || !args[1]) {
          return handleCmdContextList(params);
        }
        return {
          shouldContinue: false,
          reply: { text: "❌ Usage: `/cmd context [add|remove|clear|list] [files...]`" },
        };

      case "info":
      case "status":
        return handleCmdInfo(params);

      case "help":
      default:
        return {
          shouldContinue: false,
          reply: { text: getCmdHelpText() },
        };
    }
  } catch (error) {
    console.error("[commands-cmd] Error:", error);
    return {
      shouldContinue: false,
      reply: { text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error"}` },
    };
  }
};

function getCmdHelpText(): string {
  return `📁 **Working Directory & Context Commands**

\`/cmd\` or \`/cmd help\` — Show this help
\`/cmd pwd\` — Show current working directory
\`/cmd cwd <path>\` — Set working directory for project
\`/cmd info\` — Show full project context info

**Context Files:**
\`/cmd context\` — List context files
\`/cmd context add <files...>\` — Add files to context
\`/cmd context remove <file>\` — Remove file from context
\`/cmd context clear\` — Clear all context files

**Examples:**
\`/cmd cwd ~/projects/my-app\`
\`/cmd context add README.md src/main.ts\`
\`/cmd context remove old-file.txt\``;
}

function handleCmdCwd(params: any, path: string): CommandHandlerResult {
  if (!path) {
    return {
      shouldContinue: false,
      reply: { text: "❌ Usage: `/cmd cwd <path>`\n\nExample: `/cmd cwd ~/projects/my-app`" },
    };
  }

  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  if (!session) {
    return {
      shouldContinue: false,
      reply: {
        text: "❌ No project linked to this session. Use `/project new` or `/session link` first.",
      },
    };
  }

  // Update working directory
  store.updateSession(session.id, {
    workingDir: path.trim(),
  });

  return {
    shouldContinue: false,
    reply: { text: `📁 Working directory set to:\n\`${path.trim()}\`` },
  };
}

function handleCmdPwd(params: any): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);

  if (!session) {
    return {
      shouldContinue: false,
      reply: {
        text: `📁 **Working Directory:** (default — no project linked)\n\nAgent workspace: \`${params.workspaceDir}\``,
      },
    };
  }

  const cwd = session.workingDir || "(default workspace)";

  return {
    shouldContinue: false,
    reply: { text: `📁 **Working Directory:** \`${cwd}\`\n**Project:** ${session.name}` },
  };
}

function handleCmdContextList(params: any): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);

  if (!session) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No project linked to this session." },
    };
  }

  const files = session.contextFiles ?? [];

  if (files.length === 0) {
    return {
      shouldContinue: false,
      reply: {
        text: `📄 **Context Files:** (none)\n\nUse \`/cmd context add <files...>\` to add files.`,
      },
    };
  }

  const fileList = files.map((f, i) => `  ${i + 1}. \`${f}\``).join("\n");

  return {
    shouldContinue: false,
    reply: { text: `📄 **Context Files (${files.length}):**\n${fileList}` },
  };
}

function handleCmdContextAdd(params: any, filesStr: string): CommandHandlerResult {
  if (!filesStr) {
    return {
      shouldContinue: false,
      reply: {
        text: "❌ Usage: `/cmd context add <files...>`\n\nExample: `/cmd context add README.md src/main.ts`",
      },
    };
  }

  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  if (!session) {
    return {
      shouldContinue: false,
      reply: {
        text: "❌ No project linked to this session. Use `/project new` or `/session link` first.",
      },
    };
  }

  // Parse files (space or comma separated)
  const newFiles = filesStr
    .split(/[,\s]+/)
    .map((f) => f.trim())
    .filter(Boolean);

  if (newFiles.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No valid files provided." },
    };
  }

  // Merge with existing, avoiding duplicates
  const existingFiles = session.contextFiles ?? [];
  const merged = [...new Set([...existingFiles, ...newFiles])];

  store.updateSession(session.id, {
    contextFiles: merged,
  });

  return {
    shouldContinue: false,
    reply: {
      text: `📄 Added ${newFiles.length} file(s) to context:\n${newFiles.map((f) => `  + \`${f}\``).join("\n")}\n\n**Total:** ${merged.length} files`,
    },
  };
}

function handleCmdContextRemove(params: any, file: string): CommandHandlerResult {
  if (!file) {
    return {
      shouldContinue: false,
      reply: { text: "❌ Usage: `/cmd context remove <file>`" },
    };
  }

  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  if (!session) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No project linked to this session." },
    };
  }

  const existingFiles = session.contextFiles ?? [];
  const filtered = existingFiles.filter((f) => f !== file.trim());

  if (filtered.length === existingFiles.length) {
    return {
      shouldContinue: false,
      reply: { text: `❌ File not found in context: \`${file}\`` },
    };
  }

  store.updateSession(session.id, {
    contextFiles: filtered,
  });

  return {
    shouldContinue: false,
    reply: {
      text: `📄 Removed \`${file}\` from context.\n**Remaining:** ${filtered.length} files`,
    },
  };
}

function handleCmdContextClear(params: any): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);
  if (!session) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No project linked to this session." },
    };
  }

  const count = session.contextFiles?.length ?? 0;

  store.updateSession(session.id, {
    contextFiles: [],
  });

  return {
    shouldContinue: false,
    reply: { text: `📄 Cleared ${count} context file(s).` },
  };
}

function handleCmdInfo(params: any): CommandHandlerResult {
  const stateDir = process.env.INFINIBOT_STATE_DIR || "state";
  const store = getProjectStore(stateDir);

  const session = store.listSessions().find((s) => s.sessionKey === params.sessionKey);

  if (!session) {
    return {
      shouldContinue: false,
      reply: {
        text: `📁 **Project Context Info**

**Linked Project:** None
**Working Directory:** (default agent workspace)
**Context Files:** (none)

Use \`/project new\` or \`/session link\` to link a project.`,
      },
    };
  }

  const cwd = session.workingDir || "(default workspace)";
  const files = session.contextFiles ?? [];
  const fileList = files.length > 0 ? files.map((f) => `  - \`${f}\``).join("\n") : "  (none)";
  const globs = session.contextGlobs ?? [];
  const globList = globs.length > 0 ? globs.map((g) => `  - \`${g}\``).join("\n") : "  (none)";

  return {
    shouldContinue: false,
    reply: {
      text: `📁 **Project Context Info**

**Project:** ${session.name} (\`${session.projectId}\`)
**Status:** ${session.status} (${session.progress.percent}% complete)

**Working Directory:**
  \`${cwd}\`

**Context Files:**
${fileList}

**Context Globs:**
${globList}

**Metadata Path:**
  \`${session.workspacePath}\``,
    },
  };
}
