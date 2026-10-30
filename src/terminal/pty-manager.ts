/**
 * PTY Process Manager
 * Handles creation and management of pseudo-terminal processes
 */

import { spawn as spawnPty } from "@lydell/node-pty";
import { platform } from "os";
import type { TerminalProcess, TerminalCreateOptions, WindowGetter, IPty } from "./types.js";
import * as TmuxBackend from "./tmux-backend.js";

/**
 * Options that enable tmux-backed persistence for a spawned pty. When
 * `persistent` is true, a stable `termId` is provided, and tmux is
 * available on this host, the pty wraps `tmux new-session -A` so the
 * shell + sub-agents survive gateway restarts.
 */
export interface SpawnOptions {
  persistent?: boolean;
  termId?: string;
}

/**
 * Get the default shell for the current platform
 */
export function getDefaultShell(): string {
  const isWindows = platform() === "win32";

  if (isWindows) {
    // Prefer PowerShell on Windows
    return process.env.SHELL || process.env.COMSPEC || "powershell.exe";
  }

  // Unix-like systems
  return process.env.SHELL || "/bin/bash";
}

/**
 * Get shell arguments for the current platform
 */
export function getShellArgs(): string[] {
  const isWindows = platform() === "win32";

  if (isWindows) {
    // PowerShell needs -NoLogo to avoid startup banner
    const shell = getDefaultShell();
    if (shell.toLowerCase().includes("powershell")) {
      return ["-NoLogo"];
    }
  }

  return [];
}

/**
 * Spawn a new PTY process
 */
export function spawnPtyProcess(
  cwd: string,
  cols: number,
  rows: number,
  customEnv?: Record<string, string>,
  opts?: SpawnOptions,
): IPty {
  // Merge environment variables
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...customEnv,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };

  // Tmux-backed persistent path: shell lives in the tmux server, not
  // under this pty, so a gateway restart only drops the client.
  // Windows tmux is too niche to rely on — gate to non-win32.
  if (opts?.persistent && opts?.termId && platform() !== "win32" && TmuxBackend.isTmuxAvailable()) {
    return TmuxBackend.spawnTmuxPty(opts.termId, cwd, cols, rows, env);
  }

  const shell = getDefaultShell();
  const shellArgs = getShellArgs();

  const pty = spawnPty(shell, shellArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: "utf8",
  } as Parameters<typeof spawnPty>[2]);

  return pty;
}

/**
 * Setup PTY event handlers
 */
export function setupPtyHandlers(
  terminal: TerminalProcess,
  terminals: Map<string, TerminalProcess>,
  getWindow: WindowGetter,
  onData: (terminal: TerminalProcess, data: string) => void,
  onExit: (terminal: TerminalProcess) => void,
): void {
  terminal.pty.onData((data: string) => {
    onData(terminal, data);
  });

  terminal.pty.onExit(() => {
    // When the pty wraps a tmux client, an exit may just mean the
    // client detached (gateway restart, resize race, user `tmux
    // detach`) while the session is still alive. Only treat it as a
    // real terminal exit if the underlying tmux session is gone.
    if (TmuxBackend.hasLiveSessionSync(terminal.id)) {
      return;
    }
    onExit(terminal);
  });
}

/**
 * Create a new PTY process (legacy function for compatibility)
 */
export function createPty(options: TerminalCreateOptions): IPty {
  const shell = getDefaultShell();
  const shellArgs = getShellArgs();
  const cwd = options.cwd || process.cwd();
  const cols = options.cols || 80;
  const rows = options.rows || 24;

  // Merge environment variables
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };

  // Add agent identity to environment if provided
  if (options.agentId) {
    env.INFINIBOT_AGENT_ID = options.agentId;
  }

  if (options.sessionKey) {
    env.INFINIBOT_SESSION_KEY = options.sessionKey;
  }

  const pty = spawnPty(shell, shellArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: "utf8",
  } as Parameters<typeof spawnPty>[2]);

  return pty;
}

/**
 * Write data to a PTY process
 */
export function writeToPty(terminal: TerminalProcess, data: string): void {
  try {
    terminal.pty.write(data);
  } catch (error) {
    console.error(`[pty-manager] Error writing to terminal ${terminal.id}:`, error);
  }
}

/**
 * Resize a PTY process
 */
export function resizePty(terminal: TerminalProcess, cols: number, rows: number): void {
  try {
    terminal.pty.resize(cols, rows);
  } catch (error) {
    console.error(`[pty-manager] Error resizing terminal ${terminal.id}:`, error);
  }
}

/**
 * Kill a PTY process
 */
export function killPty(terminal: TerminalProcess): void {
  try {
    terminal.pty.kill();
  } catch (error) {
    console.error(`[pty-manager] Error killing terminal ${terminal.id}:`, error);
  }
}
