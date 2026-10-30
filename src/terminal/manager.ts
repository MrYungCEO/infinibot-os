/**
 * Terminal Manager
 * Main orchestrator for terminal lifecycle and session management
 * Integrates Auto-Claude terminal features into InfiniBot
 */

import { randomUUID } from "crypto";
import type {
  TerminalProcess,
  TerminalSession,
  TerminalCreateOptions,
  TerminalOperationResult,
  WindowGetter,
  AgentCLI,
  AgentCLIOptions,
} from "./types.js";
import * as PtyManager from "./pty-manager.js";
import * as SessionHandler from "./session-handler.js";
import * as TmuxBackend from "./tmux-backend.js";
import * as TerminalLifecycle from "./terminal-lifecycle.js";
import * as TerminalEventHandler from "./terminal-event-handler.js";
import * as AgentCLIIntegration from "./agent-cli-integration-handler.js";

type BroadcastFn = (event: string, payload: any) => void;

/**
 * Maximum bytes we keep in each terminal's replay buffer. Sized to comfortably
 * hold the last screen redraw of a full-window TUI (Claude Code, vim, etc.)
 * plus a useful chunk of scrollback. Trimmed from the start so the most
 * recent state — which is what a re-attaching browser actually needs to
 * render correctly — is always preserved.
 */
const TERMINAL_BUFFER_LIMIT = 512 * 1024;

export class TerminalManager {
  private terminals: Map<string, TerminalProcess> = new Map();
  private saveTimer: NodeJS.Timeout | null = null;
  private broadcast: BroadcastFn | null = null;
  private lastNotifiedRateLimitReset = new Map<string, string>();
  private eventCallbacks: TerminalEventHandler.EventHandlerCallbacks | null = null;
  // Per-terminal PTY output listeners. Lets voice-chat's assistant-text
  // stream tap raw output for non-Claude backends (OpenCode/Codex) that
  // don't write a tailable transcript file.
  private ptyOutputListeners: Map<string, Set<(data: string) => void>> = new Map();
  // Per-terminal PTY input listeners. Used by the voice stream to suppress
  // echoed user input before it gets spoken back as if it were assistant text.
  private ptyInputListeners: Map<string, Set<(data: string) => void>> = new Map();
  // Hooks invoked synchronously *before* a terminal is destroyed. Used to
  // tear down anything bound to the terminal's lifetime — primarily the
  // assistant-text transcript stream, whose chokidar watcher / PTY tap would
  // otherwise outlive its terminal and keep emitting events for a dead id.
  private beforeDestroyHooks: Set<(terminalId: string) => void> = new Set();

  constructor(broadcastFn?: BroadcastFn) {
    if (broadcastFn) {
      this.broadcast = broadcastFn;
    }

    // Periodically save session data (every 30 seconds)
    this.saveTimer = setInterval(() => {
      SessionHandler.persistAllSessionsAsync(this.terminals).catch((error) => {
        console.error("[TerminalManager] Failed to persist sessions:", error);
      });
    }, 30000);

    // Adopt any tmux sessions that outlived a prior gateway process but
    // have no persisted row (e.g. crash before persistSessionAsync ran,
    // or state file got wiped). The actual reattach happens lazily when
    // the UI calls restore(); here we just make sure orphans show up in
    // the session list so the user can find them.
    this.reconcileTmuxSessions().catch((err) => {
      console.error("[TerminalManager] tmux reconciliation failed:", err);
    });
  }

  /**
   * Discover live tmux sessions on the infinibot socket whose ids are
   * not present in any persisted session file, and adopt them under the
   * default bucket so the user can list/restore them.
   */
  private async reconcileTmuxSessions(): Promise<void> {
    if (!TmuxBackend.isTmuxAvailable()) return;
    const live = await TmuxBackend.listLiveSessions();
    if (live.size === 0) return;
    const known = SessionHandler.getAllPersistedSessionIds();
    // Index any persisted rows so we reattach with their real title/cwd/metadata
    // rather than a synthetic "Recovered …" placeholder when one exists.
    const savedById = new Map(SessionHandler.getSavedSessions().map((s) => [s.id, s]));
    const now = new Date().toISOString();
    let adopted = 0;
    let reattached = 0;
    for (const id of live) {
      // Spawn-agent tmux sessions are owned by the subagent registry, which
      // reattaches them via `terminal.reattachSpawnAgent` during its own boot
      // recovery. Skip them here so we never double-tap the same tmux pane (two
      // node-pty clients → duplicated output stream). NOTE: `tmuxSessionName`
      // sanitizes hyphens→underscores, so a live spawn pane surfaces here as
      // `spawn_<runId>_<ts>`, not `spawn-…`; match both forms.
      if (id.startsWith("spawn-") || id.startsWith("spawn_")) continue;
      // Already live in this process (e.g. a concurrent restore beat us). Idempotent.
      if (this.terminals.has(id)) continue;

      // Ensure a persisted row exists so getSavedSessions()/metadata stay coherent.
      if (!known.has(id)) {
        const cwd = (await TmuxBackend.getSessionCwd(id)) || process.cwd();
        SessionHandler.adoptOrphanSession({
          id,
          title: `Recovered ${id.slice(0, 8)}`,
          cwd,
          createdAt: now,
          lastActiveAt: now,
        });
        adopted++;
      }

      // Reattach the still-running tmux session into `this.terminals` so it appears
      // in `terminal.list` — the source for the voice-terminal + grid "existing
      // session" dropdowns — and streams output again. `restore()` goes through
      // `tmux new-session -A`, which ATTACHES to the live session (no respawn); the
      // claude/agent process inside keeps running and its scrollback is captured via
      // capturePane. Best-effort per session: one failure must not abort the rest.
      try {
        const session =
          savedById.get(id) ??
          ({
            id,
            title: `Recovered ${id.slice(0, 8)}`,
            cwd: (await TmuxBackend.getSessionCwd(id)) || process.cwd(),
            createdAt: now,
            lastActiveAt: now,
          } as TerminalSession);
        const res = await this.restore(session);
        if (res?.success) reattached++;
      } catch (err) {
        console.error(`[TerminalManager] reattach of tmux session ${id} failed:`, err);
      }
    }
    if (adopted > 0 || reattached > 0) {
      console.log(
        `[TerminalManager] tmux reconcile: adopted ${adopted}, reattached ${reattached} live session(s)`,
      );
    }
  }

  /**
   * Set the broadcaster function
   */
  setBroadcaster(broadcastFn: BroadcastFn): void {
    this.broadcast = broadcastFn;
    // Re-create callbacks with new broadcaster
    if (this.broadcast) {
      this.eventCallbacks = TerminalEventHandler.createEventCallbacks(
        this.broadcast,
        this.lastNotifiedRateLimitReset,
      );
    }
  }

  /**
   * Get a window-like object for compatibility with handlers
   * Shim for passing broadcast capability to handlers that expect a Window
   */
  private getWindowShim(): any {
    return {
      webContents: {
        send: (event: string, ...args: any[]) => {
          // Map Electron IPC style to InfiniBot broadcast
          // InfiniBot expects specific event names and payloads
          // We might need to map or just pass through if handlers are updated
          // However, our updated handlers use 'broadcast' directly mostly.
          // This shim is for legacy imports or unmodified Auto-Claude code.
          if (this.broadcast) {
            // Assuming args[0] is payload if present
            this.broadcast(event, args[0]);
          }
        },
      },
    };
  }

  private getWindow: WindowGetter = () => this.getWindowShim();

  /**
   * Create a new terminal process
   */
  async create(options: TerminalCreateOptions): Promise<TerminalOperationResult> {
    return TerminalLifecycle.createTerminal(
      options,
      this.terminals,
      this.getWindow,
      (terminal, data) => this.handleTerminalData(terminal, data),
    );
  }

  /**
   * Restore a terminal session
   */
  async restore(session: TerminalSession, cols = 80, rows = 24): Promise<TerminalOperationResult> {
    return TerminalLifecycle.restoreTerminal(
      session,
      this.terminals,
      this.getWindow,
      (terminal, data) => this.handleTerminalData(terminal, data),
      {
        resumeClaudeSession: true,
        captureSessionId: (tid, ppath, start) => {
          // Implementation for session capture if needed
        },
        onResumeNeeded: (tid, sid) => {
          // Logic to resume Claude session
          const terminal = this.terminals.get(tid);
          if (terminal && sid && this.broadcast) {
            // Trigger resume logic or notify frontend
          }
        },
      },
      cols,
      rows,
    );
  }

  /**
   * Register a hook fired synchronously before each terminal is destroyed.
   * Hooks receive the terminal id and are expected to release any
   * lifetime-bound resources (e.g. transcript-stream watchers, PTY taps).
   * Returns an unregister function.
   *
   * Without this hook, the assistant-text transcript stream — a chokidar
   * file watcher for Claude Code or a PTY listener for OpenCode/Codex —
   * outlives the terminal it was attached to, leaks the watcher, and keeps
   * broadcasting `assistant.text.delta` events for an id that no longer
   * exists.
   */
  addBeforeDestroyHook(fn: (terminalId: string) => void): () => void {
    this.beforeDestroyHooks.add(fn);
    return () => {
      this.beforeDestroyHooks.delete(fn);
    };
  }

  private runBeforeDestroyHooks(id: string): void {
    for (const hook of this.beforeDestroyHooks) {
      try {
        hook(id);
      } catch (err) {
        console.error("[TerminalManager] before-destroy hook threw:", err);
      }
    }
  }

  /**
   * Destroy a terminal process.
   *
   * A live `spawn-*` sub-agent pane keeps its tmux session (only the pty
   * viewer is dropped) unless `killAgentPane` is passed — see
   * `agent-pane-guard.ts`.
   */
  async destroy(
    id: string,
    options: TerminalLifecycle.DestroyTerminalOptions = {},
  ): Promise<TerminalOperationResult> {
    // Tear down anything bound to this terminal's lifetime *before* the
    // PTY is killed, so observers (transcript stream, PTY taps) see a
    // clean unwind instead of a sudden EOF on a still-registered id.
    this.runBeforeDestroyHooks(id);

    const result = await TerminalLifecycle.destroyTerminal(
      id,
      this.terminals,
      (tid) => TerminalEventHandler.clearBusyState(tid),
      options,
    );

    // Also clean up rate limit tracking
    this.lastNotifiedRateLimitReset.delete(id);
    // Safety net: ensure no orphan PTY listeners remain. The transcript
    // stream's stop path (driven by the hook above) already does this,
    // but a hook failure must not leak the listener set.
    this.ptyOutputListeners.delete(id);

    return result;
  }

  /**
   * Kill all terminal processes
   */
  async killAll(): Promise<void> {
    // Snapshot ids before destroyAllTerminals mutates the map, so hooks
    // see the same set the lifecycle layer is about to tear down.
    const ids = Array.from(this.terminals.keys());
    for (const id of ids) {
      this.runBeforeDestroyHooks(id);
      this.ptyOutputListeners.delete(id);
    }
    await TerminalLifecycle.destroyAllTerminals(this.terminals, this.saveTimer);
  }

  /**
   * Send input to a terminal
   */
  write(id: string, data: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      const inputListeners = this.ptyInputListeners.get(terminal.id);
      if (inputListeners) {
        for (const cb of inputListeners) {
          try {
            cb(data);
          } catch (e) {
            console.error(`[TerminalManager] pty input listener error for ${terminal.id}:`, e);
          }
        }
      }
      PtyManager.writeToPty(terminal, data);

      // Check for deferred Claude resume
      if (terminal.pendingClaudeResume) {
        terminal.pendingClaudeResume = false;
        if (terminal.isClaudeMode && terminal.projectPath) {
          void SessionHandler.persistSessionAsync(terminal);
        }
      }
    }
  }

  /**
   * Resize a terminal
   */
  resize(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      PtyManager.resizePty(terminal, cols, rows);
    }
  }

  /**
   * Invoke Claude in a terminal
   * (Stub for full implementation, currently just errors or basic CLI)
   */
  async invokeClaude(
    id: string,
    profileId?: string,
    dangerouslySkipPermissions?: boolean,
    voiceOrchestrator?: boolean,
  ): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) return;

    // Pre-mint a Claude Code session-id so the transcript path is
    // deterministic even when several Claude Codes start together in the
    // same cwd. Honor any value the caller already stamped on the
    // terminal (e.g., resumed sessions).
    const claudeSessionId = terminal.claudeSessionId ?? randomUUID();

    // In full Auto-Claude, this uses invokeClaudeAsync with profiles
    // For InfiniBot, we might need to route this to invokeAgentCLIAsync for now
    // if we rely on global 'claude' command without profile manager.
    if (this.broadcast) {
      await AgentCLIIntegration.invokeAgentCLIAsync(
        terminal,
        "claude",
        terminal.cwd,
        { dangerouslySkipPermissions, claudeSessionId, voiceOrchestrator },
        this.broadcast,
      );
    }
  }

  /**
   * Invoke an agent CLI in a terminal
   */
  async invokeAgentCLI(id: string, cli: AgentCLI, options?: AgentCLIOptions): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) return;

    // Pre-mint Claude Code session-ids the same way invokeClaude does.
    const enriched: AgentCLIOptions | undefined =
      cli === "claude"
        ? {
            ...options,
            claudeSessionId: options?.claudeSessionId ?? terminal.claudeSessionId ?? randomUUID(),
          }
        : options;

    if (this.broadcast) {
      await AgentCLIIntegration.invokeAgentCLIAsync(
        terminal,
        cli,
        terminal.cwd,
        enriched,
        this.broadcast,
      );
    }
  }

  /**
   * Handle terminal data output
   */
  private handleTerminalData(terminal: TerminalProcess, data: string): void {
    // Append to output buffer. The buffer is replayed verbatim into a
    // fresh xterm whenever a browser tab reconnects after a refresh, so
    // it has to be large enough to carry the latest screen redraw of any
    // TUI program (Claude Code, vim, less, full-screen REPLs) without
    // chopping off the init sequences that position the cursor.
    terminal.outputBuffer = (terminal.outputBuffer || "") + data;
    if (terminal.outputBuffer.length > TERMINAL_BUFFER_LIMIT) {
      terminal.outputBuffer = terminal.outputBuffer.slice(-TERMINAL_BUFFER_LIMIT);
    }

    // Emit raw output event
    if (this.broadcast) {
      this.broadcast("terminal:output", {
        id: terminal.id,
        data,
      });
    }

    // Notify per-terminal PTY listeners (assistant-text stream for
    // OpenCode/Codex taps this — they don't write tailable transcripts).
    const listeners = this.ptyOutputListeners.get(terminal.id);
    if (listeners) {
      for (const cb of listeners) {
        try {
          cb(data);
        } catch (e) {
          console.error(`[TerminalManager] pty listener error for ${terminal.id}:`, e);
        }
      }
    }

    // Process events (Claude sessionId, etc.)
    if (this.eventCallbacks) {
      TerminalEventHandler.handleTerminalData(terminal, data, this.eventCallbacks);
    } else if (this.broadcast) {
      // Lazy intialization of event callbacks if broadcaster was set
      this.eventCallbacks = TerminalEventHandler.createEventCallbacks(
        this.broadcast,
        this.lastNotifiedRateLimitReset,
      );
      TerminalEventHandler.handleTerminalData(terminal, data, this.eventCallbacks);
    }
  }

  /**
   * Subscribe to raw PTY output for a specific terminal. The callback is
   * invoked synchronously for every chunk the PTY emits, identical to what
   * goes into the broadcast `terminal:output` event. Returns an unsubscribe
   * function. Safe to call before the terminal exists — listeners stay
   * registered for the terminal's lifetime.
   */
  subscribePtyOutput(terminalId: string, cb: (data: string) => void): () => void {
    let set = this.ptyOutputListeners.get(terminalId);
    if (!set) {
      set = new Set();
      this.ptyOutputListeners.set(terminalId, set);
    }
    set.add(cb);
    return () => {
      const s = this.ptyOutputListeners.get(terminalId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.ptyOutputListeners.delete(terminalId);
    };
  }

  /**
   * Subscribe to raw PTY input for a specific terminal. The callback is
   * invoked synchronously for every chunk written into the PTY. Returns an
   * unsubscribe function. Used by the voice stream to suppress echo.
   */
  subscribePtyInput(terminalId: string, cb: (data: string) => void): () => void {
    let set = this.ptyInputListeners.get(terminalId);
    if (!set) {
      set = new Set();
      this.ptyInputListeners.set(terminalId, set);
    }
    set.add(cb);
    return () => {
      const s = this.ptyInputListeners.get(terminalId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.ptyInputListeners.delete(terminalId);
    };
  }

  /**
   * List all terminals
   */
  list(projectPath?: string, agentId?: string): TerminalSession[] {
    const terminals = Array.from(this.terminals.values());

    const filtered = terminals.filter((t) => {
      if (projectPath && t.projectPath !== projectPath) return false;
      if (agentId && t.agentId !== agentId) return false;
      return true;
    });

    // A tmux-backed terminal can temporarily exist under both its original id
    // (`term-...`) and tmux's sanitized id (`term_...`) during reconciliation.
    // Never expose both aliases to any client. Keep the first manager entry so
    // callers retain the id used by the active PTY callbacks.
    const seenBackingSessions = new Set<string>();
    return filtered.flatMap((terminal) => {
      const session = SessionHandler.terminalToSession(terminal);
      const canonicalId = session.id.replace(/[^a-zA-Z0-9_]/g, "_");
      if (seenBackingSessions.has(canonicalId)) return [];
      seenBackingSessions.add(canonicalId);
      return [session];
    });
  }

  /**
   * Get saved sessions for a project/agent
   */
  getSavedSessions(projectPath?: string, agentId?: string): TerminalSession[] {
    return SessionHandler.getSavedSessions(projectPath, agentId);
  }

  /**
   * Clear saved sessions for a project/agent
   */
  clearSavedSessions(projectPath?: string, agentId?: string): void {
    SessionHandler.clearSavedSessions(projectPath, agentId);
  }

  /**
   * Update terminal title
   */
  setTitle(id: string, title: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.title = title;
      if (terminal.projectPath || terminal.agentId) {
        void SessionHandler.persistSessionAsync(terminal);
      }
    }
  }

  /**
   * Update display orders for terminals
   */
  updateDisplayOrders(
    projectPath: string | undefined,
    agentId: string | undefined,
    orders: Array<{ terminalId: string; displayOrder: number }>,
  ): void {
    for (const order of orders) {
      const terminal = this.terminals.get(order.terminalId);
      if (terminal) {
        terminal.displayOrder = order.displayOrder;
      }
    }
    SessionHandler.updateDisplayOrders(projectPath, agentId, orders);
  }

  /**
   * Check if a terminal is alive
   */
  isTerminalAlive(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * Get terminal by ID
   */
  getTerminal(id: string): TerminalProcess | undefined {
    return this.terminals.get(id);
  }
}
