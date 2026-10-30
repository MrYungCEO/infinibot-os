/**
 * Terminal-First Sub-Agent Execution
 *
 * When a sub-agent is configured with execution.mode = "terminal",
 * this module creates a PTY terminal, invokes the agent's CLI,
 * injects the task prompt, and bridges completion back to the
 * subagent lifecycle system.
 */

import { platform } from "os";
import { emitAgentEvent } from "../infra/agent-events.js";
import { isLiveAgentPane } from "./agent-pane-guard.js";
import type { TerminalManager } from "./manager.js";
import type { AgentCLI, AgentCLIOptions } from "./types.js";

const isWindows = platform() === "win32";

/** Metadata attached to a spawn-agent terminal */
export interface SpawnTerminalMeta {
  runId: string;
  sessionKey: string;
  agentId: string;
  task: string;
  label?: string;
  autoClose: boolean;
  autoCloseDelayMs: number;
  startedAt: number;
}

/** Registry of active spawn terminals (runId → terminalId) */
const activeSpawnTerminals = new Map<string, { terminalId: string; meta: SpawnTerminalMeta }>();

/** Registry of terminalId → spawn meta for exit detection */
const terminalSpawnMeta = new Map<string, SpawnTerminalMeta>();

/**
 * Spawn a CLI agent in a terminal for a sub-agent task.
 *
 * Creates terminal → invokes CLI → injects task → returns.
 * Completion is detected via PTY exit events.
 */
export async function spawnAgentInTerminal(params: {
  manager: TerminalManager;
  cli: AgentCLI;
  cwd: string;
  task: string;
  label?: string;
  runId: string;
  sessionKey: string;
  agentId: string;
  autoClose?: boolean;
  autoCloseDelayMs?: number;
  options?: AgentCLIOptions;
  broadcast?: (event: string, payload: any) => void;
}): Promise<{ success: boolean; terminalId?: string; error?: string }> {
  const {
    manager,
    cli,
    cwd,
    task,
    label,
    runId,
    sessionKey,
    agentId,
    autoClose = true,
    autoCloseDelayMs = 5000,
    options,
    broadcast,
  } = params;

  const terminalId = `spawn-${runId.slice(0, 8)}-${Date.now()}`;
  const title = label ? `🏗️ ${label}` : `🏗️ ${agentId} task`;

  // Create the terminal
  const createResult = await manager.create({
    id: terminalId,
    cwd,
    title,
    agentId,
    sessionKey,
  });

  if (!createResult.success) {
    return { success: false, error: createResult.error || "Terminal creation failed" };
  }

  const actualTerminalId = createResult.terminalId || terminalId;

  // Store spawn metadata
  const meta: SpawnTerminalMeta = {
    runId,
    sessionKey,
    agentId,
    task,
    label,
    autoClose,
    autoCloseDelayMs,
    startedAt: Date.now(),
  };
  activeSpawnTerminals.set(runId, { terminalId: actualTerminalId, meta });
  terminalSpawnMeta.set(actualTerminalId, meta);

  const trimmedTask = task.trim();
  const cliOptions: AgentCLIOptions | undefined =
    cli === "codex" && trimmedTask ? { ...options, initialPrompt: task } : options;

  // Invoke the CLI in the terminal
  await manager.invokeAgentCLI(actualTerminalId, cli, cliOptions);

  // Attach exit listener to the PTY for completion detection
  const terminal = manager.getTerminal(actualTerminalId);
  if (terminal?.pty) {
    terminal.spawnMeta = meta;
    terminal.pty.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
      handleSpawnTerminalExit(actualTerminalId, exitCode, manager, broadcast);
    });
  }

  // Wait for CLI to start up, then inject the task prompt. Codex receives
  // the initial prompt as a process argument above; typing into the TUI
  // races MCP startup and can leave the prompt queued but unsubmitted.
  if (trimmedTask && cli !== "codex") {
    const injectDelayMs = cli === "claude" ? 3000 : cli === "opencode" ? 2500 : 2000;
    setTimeout(() => {
      injectTaskPrompt(manager, actualTerminalId, cli, task);
    }, injectDelayMs);
  }

  // Broadcast spawned event for UI auto-tab creation
  if (broadcast) {
    broadcast("terminal.spawned", {
      terminalId: actualTerminalId,
      runId,
      sessionKey,
      agentId,
      label,
      title,
      cli,
      cwd,
      isSubagent: true,
    });
  }

  // Emit lifecycle start event
  emitAgentEvent({
    stream: "lifecycle",
    runId,
    data: { phase: "start", startedAt: Date.now() },
  });

  return { success: true, terminalId: actualTerminalId };
}

/**
 * Reattach to a spawn terminal whose tmux session outlived a gateway restart.
 *
 * Unlike {@link spawnAgentInTerminal}, this does NOT invoke the CLI or inject a
 * task — the coder process is already running inside the tmux session. It only:
 *   1. Re-creates the node-pty client (via `manager.create`, which uses the
 *      persistent/tmux path — `tmux new-session -A` reattaches to the live
 *      session rather than starting a new shell).
 *   2. Re-registers the spawn metadata so `handleSpawnTerminalExit` recognises
 *      the terminal.
 *   3. Re-binds the PTY exit listener so completion/announce still fires after a
 *      restart.
 *
 * Idempotent: if the terminal is already tracked (meta present) it is a no-op
 * success, so a double-reattach can't double-bind the exit listener.
 */
export async function reattachSpawnAgentTerminal(params: {
  manager: TerminalManager;
  terminalId: string;
  cwd?: string;
  runId: string;
  sessionKey: string;
  agentId: string;
  label?: string;
  autoClose?: boolean;
  autoCloseDelayMs?: number;
  broadcast?: (event: string, payload: any) => void;
}): Promise<{ success: boolean; terminalId?: string; error?: string }> {
  const {
    manager,
    terminalId,
    cwd,
    runId,
    sessionKey,
    agentId,
    label,
    autoClose = true,
    autoCloseDelayMs = 5000,
    broadcast,
  } = params;

  // Already reattached in this process — don't re-bind the exit listener.
  if (terminalSpawnMeta.has(terminalId)) {
    return { success: true, terminalId };
  }

  const title = label ? `🏗️ ${label}` : `🏗️ ${agentId} task`;

  // create() goes through the persistent (tmux) path — `tmux new-session -A`
  // attaches to the still-running session instead of spawning a fresh shell.
  const createResult = await manager.create({
    id: terminalId,
    cwd: cwd || process.cwd(),
    title,
    agentId,
    sessionKey,
  });
  if (!createResult.success) {
    return { success: false, error: createResult.error || "Terminal reattach failed" };
  }

  const actualTerminalId = createResult.terminalId || terminalId;

  const meta: SpawnTerminalMeta = {
    runId,
    sessionKey,
    agentId,
    task: "",
    label,
    autoClose,
    autoCloseDelayMs,
    startedAt: Date.now(),
  };
  activeSpawnTerminals.set(runId, { terminalId: actualTerminalId, meta });
  terminalSpawnMeta.set(actualTerminalId, meta);

  // Re-bind the exit listener so completion detection survives the restart.
  const terminal = manager.getTerminal(actualTerminalId);
  if (terminal?.pty) {
    terminal.spawnMeta = meta;
    terminal.pty.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
      handleSpawnTerminalExit(actualTerminalId, exitCode, manager, broadcast);
    });
  }

  if (broadcast) {
    broadcast("terminal.spawned", {
      terminalId: actualTerminalId,
      runId,
      sessionKey,
      agentId,
      label,
      title,
      cwd: cwd || process.cwd(),
      isSubagent: true,
      reattached: true,
    });
  }

  return { success: true, terminalId: actualTerminalId };
}

/**
 * Inject the task prompt into a CLI running in a terminal.
 * Different CLIs need slightly different injection approaches.
 */
function injectTaskPrompt(
  manager: TerminalManager,
  terminalId: string,
  cli: AgentCLI,
  task: string,
): void {
  const terminal = manager.getTerminal(terminalId);
  if (!terminal || !terminal.pty) return;

  // Escape the task for safe injection
  // All three CLIs accept typed input followed by Enter
  const sanitizedTask = task.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // For multi-line tasks, we need to handle newlines carefully
  // Most CLI tools accept paste-style input
  terminal.pty.write(sanitizedTask);

  // Send Enter to submit
  terminal.pty.write("\r");
}

/**
 * Handle terminal exit for spawn terminals.
 * Called when a PTY process exits.
 * Bridges to the subagent lifecycle system.
 */
export function handleSpawnTerminalExit(
  terminalId: string,
  exitCode: number,
  manager: TerminalManager,
  broadcast?: (event: string, payload: any) => void,
): boolean {
  const meta = terminalSpawnMeta.get(terminalId);
  if (!meta) return false; // Not a spawn terminal

  // The pty here is a CLIENT attached to a tmux pane, not the agent process.
  // If the session is still alive the client merely detached (tab closed,
  // gateway dropped the viewer) — the agent is still working. Reporting that
  // as a run exit marked healthy runs failed and, via autoClose below, ran
  // `manager.destroy` on a pane that was mid-turn. Bail out and leave the
  // spawn metadata in place so a genuine exit later still settles the run.
  if (isLiveAgentPane(terminalId)) {
    return false;
  }

  const endedAt = Date.now();

  // Get the output buffer for the result
  const terminal = manager.getTerminal(terminalId);
  const rawOutput = terminal?.outputBuffer || "";

  // Extract meaningful result from output
  const result = extractResultFromOutput(rawOutput);

  // Emit lifecycle end event — subagent-registry will pick this up
  emitAgentEvent({
    stream: "lifecycle",
    runId: meta.runId,
    data: {
      phase: exitCode === 0 ? "end" : "error",
      endedAt,
      error: exitCode !== 0 ? `CLI exited with code ${exitCode}` : undefined,
      terminalResult: result,
    },
  });

  // Broadcast completion event for UI
  if (broadcast) {
    broadcast("terminal.spawnComplete", {
      terminalId,
      runId: meta.runId,
      exitCode,
      label: meta.label,
      autoClose: meta.autoClose,
      autoCloseDelayMs: meta.autoCloseDelayMs,
    });
  }

  // Schedule auto-close if configured
  if (meta.autoClose) {
    setTimeout(() => {
      manager.destroy(terminalId).catch(() => {});
      if (broadcast) {
        broadcast("terminal.destroyed", { terminalId });
      }
    }, meta.autoCloseDelayMs);
  }

  // Cleanup
  terminalSpawnMeta.delete(terminalId);
  activeSpawnTerminals.delete(meta.runId);

  return true;
}

/**
 * Extract meaningful result text from terminal output buffer.
 * Strips ANSI codes, excessive whitespace, and returns the last
 * meaningful content (typically the CLI's final output).
 */
function extractResultFromOutput(raw: string): string {
  // Strip ANSI escape codes
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
  const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  // Split into lines and filter
  const lines = stripped.split("\n").map((l) => l.trimEnd());

  // Take last 100 meaningful lines (skip empty trailing lines)
  let endIdx = lines.length;
  while (endIdx > 0 && lines[endIdx - 1].trim() === "") endIdx--;

  const meaningful = lines.slice(Math.max(0, endIdx - 100), endIdx);

  // Join and cap at 10KB
  const result = meaningful.join("\n").trim();
  if (result.length > 10_000) {
    return `...(truncated)\n${result.slice(-10_000)}`;
  }
  return result;
}

/**
 * Check if a runId has an active spawn terminal.
 */
export function hasSpawnTerminal(runId: string): boolean {
  return activeSpawnTerminals.has(runId);
}

/**
 * Get spawn terminal info for a runId.
 */
export function getSpawnTerminalInfo(runId: string) {
  return activeSpawnTerminals.get(runId);
}

/**
 * Check if a terminal is a spawn terminal.
 */
export function isSpawnTerminal(terminalId: string): boolean {
  return terminalSpawnMeta.has(terminalId);
}

/**
 * Get all active spawn terminals.
 */
export function listSpawnTerminals(): Array<{
  terminalId: string;
  runId: string;
  agentId: string;
  label?: string;
  startedAt: number;
}> {
  return Array.from(activeSpawnTerminals.entries()).map(([runId, entry]) => ({
    terminalId: entry.terminalId,
    runId,
    agentId: entry.meta.agentId,
    label: entry.meta.label,
    startedAt: entry.meta.startedAt,
  }));
}
