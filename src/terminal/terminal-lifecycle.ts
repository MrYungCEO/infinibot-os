/**
 * Terminal Lifecycle
 * Handles terminal creation, restoration, and destruction operations
 */

import * as os from "os";
import { existsSync } from "fs";
import type {
  TerminalCreateOptions,
  TerminalSession,
  TerminalProcess,
  TerminalOperationResult,
  WindowGetter,
} from "./types.js";
import * as PtyManager from "./pty-manager.js";
import * as SessionHandler from "./session-handler.js";
import * as TmuxBackend from "./tmux-backend.js";
import { isLiveAgentPane } from "./agent-pane-guard.js";
import { debugLog, debugError } from "./utils/debug-logger.js";

/**
 * Options for terminal restoration
 */
export interface RestoreOptions {
  resumeClaudeSession: boolean;
  captureSessionId: (terminalId: string, projectPath: string, startTime: number) => void;
  onResumeNeeded?: (terminalId: string, sessionId: string | undefined) => void;
}

/**
 * Data handler function type
 */
export type DataHandlerFn = (terminal: TerminalProcess, data: string) => void;

/**
 * Create a new terminal process
 */
export async function createTerminal(
  options: TerminalCreateOptions,
  terminals: Map<string, TerminalProcess>,
  getWindow: WindowGetter,
  dataHandler: DataHandlerFn,
): Promise<TerminalOperationResult> {
  const {
    id,
    cwd,
    cols = 80,
    rows = 24,
    projectPath,
    agentId,
    sessionKey,
    skipOAuthToken,
    env: customEnv,
  } = options;

  debugLog("[TerminalLifecycle] Creating terminal:", {
    id,
    cwd,
    cols,
    rows,
    projectPath,
    agentId,
    sessionKey,
  });

  if (!id) {
    return { success: false, error: "Terminal ID is required" };
  }

  if (terminals.has(id)) {
    debugLog("[TerminalLifecycle] Terminal already exists:", id);
    return { success: true, terminalId: id };
  }

  try {
    // Merge custom environment variables
    const mergedEnv = customEnv || {};

    // Validate cwd exists
    let effectiveCwd = cwd;
    if (cwd && !existsSync(cwd)) {
      debugLog(
        "[TerminalLifecycle] CWD does not exist, falling back:",
        cwd,
        "->",
        projectPath || os.homedir(),
      );
      effectiveCwd = projectPath || os.homedir();
    }

    // Persistent mode: tmux-backed pty so shell + sub-agents survive
    // gateway restarts. The lifecycle layer always asks for persistence;
    // pty-manager silently falls back to a direct $SHELL when tmux is
    // absent (Windows / fresh container).
    const ptyProcess = PtyManager.spawnPtyProcess(
      effectiveCwd || os.homedir(),
      cols,
      rows,
      mergedEnv,
      { persistent: true, termId: id },
    );

    debugLog("[TerminalLifecycle] PTY process spawned, pid:", ptyProcess.pid);

    const terminalCwd = effectiveCwd || os.homedir();
    const terminal: TerminalProcess = {
      id,
      pty: ptyProcess,
      isClaudeMode: false,
      projectPath,
      agentId,
      sessionKey,
      cwd: terminalCwd,
      outputBuffer: "",
      title: options.title || `Terminal ${terminals.size + 1}`,
      createdAt: new Date(),
    };

    terminals.set(id, terminal);

    PtyManager.setupPtyHandlers(
      terminal,
      terminals,
      getWindow,
      (term, data) => dataHandler(term, data),
      (term) => handleTerminalExit(term, terminals),
    );

    if (projectPath) {
      void SessionHandler.persistSessionAsync(terminal);
    }

    debugLog("[TerminalLifecycle] Terminal created successfully:", id);
    return { success: true, terminalId: id };
  } catch (error) {
    debugError("[TerminalLifecycle] Error creating terminal:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create terminal",
    };
  }
}

/**
 * Restore a terminal session
 */
export async function restoreTerminal(
  session: TerminalSession,
  terminals: Map<string, TerminalProcess>,
  getWindow: WindowGetter,
  dataHandler: DataHandlerFn,
  options: RestoreOptions,
  cols = 80,
  rows = 24,
): Promise<TerminalOperationResult> {
  // Look up the stored session to get the correct isClaudeMode value
  const storedSessions = SessionHandler.getSavedSessions(session.projectPath, session.agentId);
  const storedSession = storedSessions.find((s) => s.id === session.id);
  const storedIsClaudeMode = storedSession?.isClaudeMode ?? session.isClaudeMode;
  const storedClaudeSessionId = storedSession?.claudeSessionId ?? session.claudeSessionId;
  const storedWorktreeConfig = storedSession?.worktreeConfig ?? session.worktreeConfig;

  debugLog(
    "[TerminalLifecycle] Restoring terminal session:",
    session.id,
    "Claude mode:",
    storedIsClaudeMode,
    "Session ID:",
    storedClaudeSessionId,
  );

  // Validate cwd exists
  let effectiveCwd = session.cwd;
  if (!existsSync(session.cwd)) {
    debugLog(
      "[TerminalLifecycle] Session CWD does not exist, falling back:",
      session.cwd,
      "->",
      session.projectPath,
    );
    effectiveCwd = session.projectPath || os.homedir();
  }

  const result = await createTerminal(
    {
      id: session.id,
      cwd: effectiveCwd,
      cols,
      rows,
      projectPath: session.projectPath,
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      title: session.title,
    },
    terminals,
    getWindow,
    dataHandler,
  );

  if (!result.success) {
    return result;
  }

  const terminal = terminals.get(session.id);
  if (!terminal) {
    return { success: false, error: "Terminal not found after creation" };
  }

  // If a tmux session was already live (this is a real reattach after a
  // gateway restart), capture its pane so the xterm replay buffer holds
  // the actual scrollback instead of an empty screen. Without this, the
  // user sees a blank terminal even though sub-agents are still running
  // inside tmux.
  if (TmuxBackend.isTmuxAvailable() && (await TmuxBackend.hasLiveSession(session.id))) {
    const captured = await TmuxBackend.capturePane(session.id);
    if (captured) {
      terminal.outputBuffer = captured;
    }
  }

  // Restore title and worktree config from session
  terminal.title = session.title;
  if (effectiveCwd === session.cwd) {
    terminal.worktreeConfig = storedWorktreeConfig;
  } else {
    terminal.worktreeConfig = undefined;
    terminal.cwd = effectiveCwd;
    debugLog(
      "[TerminalLifecycle] Cleared worktree config for terminal with deleted worktree:",
      session.id,
    );
  }

  // Re-persist after restoring title and worktreeConfig
  if (terminal.projectPath) {
    void SessionHandler.persistSessionAsync(terminal);
  }

  // Defer Claude resume until terminal becomes active
  if (options.resumeClaudeSession && storedIsClaudeMode) {
    terminal.isClaudeMode = true;
    terminal.pendingClaudeResume = true;
    debugLog("[TerminalLifecycle] Marking terminal for deferred Claude resume:", terminal.id);

    // Persist the Claude mode and pending resume state
    if (terminal.projectPath) {
      void SessionHandler.persistSessionAsync(terminal);
    }
  }

  return {
    success: true,
    terminalId: session.id,
  };
}

/** Options for {@link destroyTerminal}. */
export interface DestroyTerminalOptions {
  /**
   * Force `tmux kill-session` even for a live `spawn-*` sub-agent pane.
   *
   * Off by default: closing a terminal VIEW must never kill the agent running
   * inside it (see `agent-pane-guard.ts`). Only set this from a path that has
   * genuinely been asked to terminate the work.
   */
  killAgentPane?: boolean;
}

/**
 * Destroy a terminal process.
 *
 * The tmux session is torn down too — EXCEPT when the terminal is a live
 * `spawn-*` sub-agent pane. Those panes are owned by the subagent registry (or
 * by another gateway instance sharing the state-scoped tmux socket), and the pty
 * here is only a viewer: killing the session would murder a running agent
 * mid-turn. Such a destroy drops the pty client and leaves the session alive,
 * reporting `tmuxSessionPreserved: true`. Pass `killAgentPane` to override.
 */
export async function destroyTerminal(
  id: string,
  terminals: Map<string, TerminalProcess>,
  onCleanup: (terminalId: string) => void,
  options: DestroyTerminalOptions = {},
): Promise<TerminalOperationResult> {
  const terminal = terminals.get(id);
  if (!terminal) {
    return { success: false, error: "Terminal not found" };
  }

  try {
    // Resolve BEFORE killing the pty: dropping the client can end the session
    // when the pane's process already exited, and we'd then read "not live".
    const preserveAgentPane = !options.killAgentPane && isLiveAgentPane(id);

    SessionHandler.removePersistedSession(terminal);
    onCleanup(id);

    // Delete from map BEFORE killing to prevent race with onExit handler
    terminals.delete(id);

    // Kill the PTY process (drops the tmux client, if any)
    PtyManager.killPty(terminal);

    // Explicit user-initiated destroy: also tear down the tmux session
    // so it doesn't leak. Distinct from gateway shutdown, where the
    // session must survive (see destroyAllTerminals) — and from a live
    // sub-agent pane, where the run outlives every viewer.
    if (preserveAgentPane) {
      debugLog(
        `[terminal-lifecycle] preserving tmux session for live agent pane ${id} (pty client dropped only)`,
      );
      return { success: true, tmuxSessionPreserved: true };
    }
    if (TmuxBackend.isTmuxAvailable()) {
      // Fire-and-forget; killSession swallows "not found".
      TmuxBackend.killSession(id).catch(() => {});
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to destroy terminal",
    };
  }
}

/**
 * Kill all terminal processes
 */
export async function destroyAllTerminals(
  terminals: Map<string, TerminalProcess>,
  saveTimer: NodeJS.Timeout | null,
): Promise<NodeJS.Timeout | null> {
  await SessionHandler.persistAllSessionsAsync(terminals);

  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }

  const promises: Promise<void>[] = [];

  terminals.forEach((terminal) => {
    promises.push(
      new Promise((resolve) => {
        try {
          // Gateway shutdown path. For tmux-backed terminals
          // this only drops the *client* pty (SIGHUP detaches
          // a tmux attach client); the session keeps running
          // inside the tmux server with its sub-agents intact.
          // Do NOT call TmuxBackend.killSession here — that is
          // reserved for explicit user-initiated destroyTerminal.
          PtyManager.killPty(terminal);
        } catch {
          // Ignore errors during cleanup
        }
        resolve();
      }),
    );
  });

  await Promise.all(promises);
  terminals.clear();

  return saveTimer;
}

/**
 * Handle terminal exit event
 */
function handleTerminalExit(
  _terminal: TerminalProcess,
  _terminals: Map<string, TerminalProcess>,
): void {
  // Don't remove session - let it persist for restoration
}

/**
 * Restore multiple sessions from a specific date
 */
export async function restoreSessionsFromDate(
  date: string,
  projectPath: string,
  agentId: string | undefined,
  terminals: Map<string, TerminalProcess>,
  getWindow: WindowGetter,
  dataHandler: DataHandlerFn,
  options: RestoreOptions,
  cols = 80,
  rows = 24,
): Promise<{
  restored: number;
  failed: number;
  sessions: Array<{ id: string; success: boolean; error?: string }>;
}> {
  const sessions = SessionHandler.getSessionsForDate(date, projectPath, agentId);
  const results: Array<{ id: string; success: boolean; error?: string }> = [];

  for (const session of sessions) {
    const result = await restoreTerminal(
      session,
      terminals,
      getWindow,
      dataHandler,
      options,
      cols,
      rows,
    );
    results.push({
      id: session.id,
      success: result.success,
      error: result.error,
    });
  }

  return {
    restored: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    sessions: results,
  };
}
