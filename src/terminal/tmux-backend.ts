/**
 * Tmux Backend
 *
 * Wraps node-pty around a dedicated tmux server so terminal sessions
 * (and their sub-agents) survive gateway restarts. The tmux server runs
 * as a daemon owned by PID 1 — killing the gateway only drops the client
 * pty; the shell + any running `claude` / `codex` / `opencode` keep going
 * inside the tmux pane until the host reboots or the user explicitly
 * destroys the terminal.
 *
 * Uses a state-directory-scoped socket (`-L infinibot` for the default state
 * dir, a hashed suffix for custom dirs) so separate installations cannot see
 * each other's panes. Sessions are named `infinibot_<terminalId>` (`.` and `:`
 * are not legal in tmux names; we sanitize).
 */

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { spawn as spawnPty } from "@lydell/node-pty";
import { resolveTmuxSocketName } from "./tmux-socket.js";
import type { IPty } from "./types.js";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "infinibot_";

function tmuxArgs(args: string[]): string[] {
  return ["-L", resolveTmuxSocketName(), ...args];
}

let tmuxAvailableCache: boolean | null = null;

/**
 * Detect tmux once. Result is cached for the lifetime of the process.
 * Synchronous on purpose so callers can branch without awaiting on the
 * hot create-terminal path.
 */
export function isTmuxAvailable(): boolean {
  if (tmuxAvailableCache !== null) return tmuxAvailableCache;
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    tmuxAvailableCache = true;
  } catch {
    tmuxAvailableCache = false;
  }
  return tmuxAvailableCache;
}

/**
 * Map a terminal id to a tmux session name. tmux disallows `.` and `:`
 * in session names; replace anything that isn't alnum/underscore.
 */
export function tmuxSessionName(terminalId: string): string {
  return SESSION_PREFIX + terminalId.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Inverse of tmuxSessionName, used during reconciliation to recover the
 * terminal id from a live session name. Returns null if the name isn't
 * one of ours.
 */
export function terminalIdFromSessionName(name: string): string | null {
  if (!name.startsWith(SESSION_PREFIX)) return null;
  return name.slice(SESSION_PREFIX.length);
}

/**
 * Spawn a pty that runs `tmux new-session -A` — attach if the session
 * exists, otherwise create it. The shell and its descendants live inside
 * the tmux server, not under this pty.
 */
export function spawnTmuxPty(
  terminalId: string,
  cwd: string,
  cols: number,
  rows: number,
  env: Record<string, string>,
): IPty {
  const sessionName = tmuxSessionName(terminalId);
  const args = tmuxArgs([
    "new-session",
    "-A",
    "-s",
    sessionName,
    "-x",
    String(cols),
    "-y",
    String(rows),
    "-c",
    cwd,
  ]);

  return spawnPty("tmux", args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: "utf8",
  } as Parameters<typeof spawnPty>[2]);
}

/**
 * List live infinibot tmux sessions on our socket. Returns a Set of
 * terminal ids (not full session names).
 */
export async function listLiveSessions(): Promise<Set<string>> {
  if (!isTmuxAvailable()) return new Set();
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      tmuxArgs(["list-sessions", "-F", "#{session_name}"]),
      { encoding: "utf8" },
    );
    const ids = new Set<string>();
    for (const line of stdout.split("\n")) {
      const id = terminalIdFromSessionName(line.trim());
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    // No sessions = tmux exits non-zero. Not an error.
    return new Set();
  }
}

export async function hasLiveSession(terminalId: string): Promise<boolean> {
  if (!isTmuxAvailable()) return false;
  try {
    await execFileAsync("tmux", tmuxArgs(["has-session", "-t", tmuxSessionName(terminalId)]), {
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous variant for paths where we can't await (exit handlers).
 */
export function hasLiveSessionSync(terminalId: string): boolean {
  if (!isTmuxAvailable()) return false;
  try {
    execFileSync("tmux", tmuxArgs(["has-session", "-t", tmuxSessionName(terminalId)]), {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the current pane contents (including scrollback) for the given
 * session. Used on reattach to repaint xterm.js with real history instead
 * of an empty screen.
 */
export async function capturePane(terminalId: string, lines = 2000): Promise<string> {
  if (!isTmuxAvailable()) return "";
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      tmuxArgs([
        "capture-pane",
        "-p",
        "-e", // include ANSI escapes for color
        "-J", // join wrapped lines
        "-S",
        `-${lines}`,
        "-t",
        tmuxSessionName(terminalId),
      ]),
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Kill a specific tmux session. Only call this on explicit user-initiated
 * terminal destruction — gateway shutdown must NOT kill sessions, that's
 * the whole point of using tmux.
 */
export async function killSession(terminalId: string): Promise<void> {
  if (!isTmuxAvailable()) return;
  try {
    await execFileAsync("tmux", tmuxArgs(["kill-session", "-t", tmuxSessionName(terminalId)]), {
      encoding: "utf8",
    });
  } catch {
    // Already gone — fine.
  }
}

/**
 * Get the cwd of a live session's active pane. Used during orphan
 * adoption when we have no persisted row to source cwd from.
 */
export async function getSessionCwd(terminalId: string): Promise<string | null> {
  if (!isTmuxAvailable()) return null;
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      tmuxArgs([
        "display-message",
        "-p",
        "-t",
        tmuxSessionName(terminalId),
        "#{pane_current_path}",
      ]),
      { encoding: "utf8" },
    );
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Name of the foreground process in a live session's active pane (e.g.
 * "claude", "bash"). Used to tell whether a CLI is still running inside a
 * pane or has exited back to the shell.
 */
export async function getPaneCurrentCommand(terminalId: string): Promise<string | null> {
  if (!isTmuxAvailable()) return null;
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      tmuxArgs([
        "display-message",
        "-p",
        "-t",
        tmuxSessionName(terminalId),
        "#{pane_current_command}",
      ]),
      { encoding: "utf8" },
    );
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
