/**
 * Agent CLI Integration Handler
 * Handles invoking agent CLIs in terminals
 */

import * as path from "path";
import * as fs from "fs";
import { debugLog } from "./utils/debug-logger.js";
import { escapeShellArg, escapeForWindowsDoubleQuote } from "./utils/shell-escape.js";
import { platform, tmpdir } from "os";
import { getDefaultShell } from "./pty-manager.js";
import type { AgentCLI, AgentCLIOptions, TerminalProcess } from "./types.js";
import { buildVoiceTerminalSystemPrompt } from "../agents/voice-orchestrator-prompt.js";
import { buildMcpOrchestratorPrompt } from "../agents/mcp-orchestrator-prompt.js";

const isWindows = platform() === "win32";

/**
 * YOLO / "full-auto" flag per CLI. Setting `options.dangerouslySkipPermissions`
 * on a spawn opts the chosen CLI into its no-prompt mode — required for
 * autonomous-control loops where there's no operator to approve each tool
 * call. Each backend spells it differently:
 *   - claude:    --dangerously-skip-permissions
 *   - opencode:  --dangerously-skip-permissions   (same spelling as claude)
 *   - codex:     --dangerously-bypass-approvals-and-sandbox
 *   - gemini:    --yolo                            (Google's name for it)
 *   - grok:      --always-approve                  (xAI Grok Build)
 */
const DANGEROUSLY_SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";
const FULL_AUTO_FLAGS: Record<AgentCLI, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  opencode: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--yolo"],
  grok: ["--always-approve"],
  ollama: [],
};

/**
 * Configuration for building agent CLI shell commands
 */
export interface AgentCLICommandConfig {
  /** The CLI to invoke */
  cli: AgentCLI;
  /** Working directory for the command */
  cwd?: string;
  /** CLI options */
  options?: AgentCLIOptions;
}

/**
 * Build PATH environment variable prefix for CLI invocation.
 */
function buildPathPrefix(pathEnv: string): string {
  if (!pathEnv) {
    return "";
  }

  if (isWindows) {
    const escapedPath = escapeForWindowsDoubleQuote(pathEnv);
    return `set "PATH=${escapedPath}" && `;
  }

  return `PATH=${escapeShellArg(pathEnv)} `;
}

/**
 * Escape a command for safe use in shell commands.
 */
function escapeShellCommand(cmd: string): string {
  if (isWindows) {
    const escapedCmd = escapeForWindowsDoubleQuote(cmd);
    return `"${escapedCmd}"`;
  }
  return escapeShellArg(cmd);
}

/**
 * Get simplified tool path (assuming in PATH)
 */
function getToolPath(cli: AgentCLI): string {
  // In a real implementation, this might look up the path
  // For now, we assume the tools are in the system PATH
  switch (cli) {
    case "claude":
      return "claude";
    case "opencode":
      return "opencode";
    case "gemini":
      return "gemini";
    case "codex":
      return "codex";
    case "grok":
      return "grok";
    case "ollama":
      return "ollama";
    default:
      return cli;
  }
}

/**
 * The terminals these commands are typed into run whatever `getDefaultShell()`
 * resolves to — which on Windows is NOT always cmd.exe. When the gateway is
 * launched from a Git-Bash / WSL context, `SHELL` points at bash, and when a
 * user prefers PowerShell the PTY runs pwsh. Each needs different syntax for
 * clear / cd / command-chaining / invocation, so we detect the shell kind and
 * emit matching syntax. (The old builder always emitted cmd.exe syntax — `cls`,
 * `cd /d`, `&&`, double-quoted command — which a bash or PowerShell PTY rejects
 * as invalid, so claude/codex never actually spawned.)
 */
type ShellKind = "posix" | "cmd" | "powershell";

function detectShellKind(): ShellKind {
  const shell = getDefaultShell().toLowerCase();
  if (shell.includes("powershell") || shell.includes("pwsh")) return "powershell";
  if (shell.includes("bash") || shell.includes("zsh") || /(^|[\\/])sh(\.exe)?$/.test(shell)) {
    return "posix";
  }
  if (isWindows) return "cmd";
  return "posix";
}

/** Quote a single argument for the given shell. */
function escapeArgFor(kind: ShellKind, arg: string): string {
  if (kind === "powershell") {
    // PowerShell single-quoted literal: embedded single quotes are doubled.
    return `'${arg.replace(/'/g, "''")}'`;
  }
  if (kind === "cmd") {
    return `"${escapeForWindowsDoubleQuote(arg)}"`;
  }
  return escapeShellArg(arg);
}

function clearCmdFor(kind: ShellKind): string {
  if (kind === "cmd") return "cls";
  if (kind === "powershell") return "Clear-Host";
  return "clear";
}

function cdCmdFor(kind: ShellKind, cwd: string | undefined): string {
  if (!cwd) return "";
  if (kind === "cmd") return `cd /d ${escapeArgFor("cmd", cwd)}`;
  if (kind === "powershell") return `Set-Location -LiteralPath ${escapeArgFor("powershell", cwd)}`;
  // posix — incl. Git-Bash on Windows, where forward slashes are the safe form
  // for `cd` (backslashes inside quotes are taken literally and break the path).
  const p = isWindows ? cwd.replace(/\\/g, "/") : cwd;
  return `cd ${escapeArgFor("posix", p)}`;
}

/** Statement separator. Windows PowerShell 5.1 has no `&&`; `;` is portable. */
function chainSepFor(kind: ShellKind): string {
  return kind === "powershell" ? " ; " : " && ";
}

/** Render the CLI invocation: command name + already-escaped args. */
function invocationFor(kind: ShellKind, cliPath: string, args: string[]): string {
  const argStr = args.length > 0 ? ` ${args.join(" ")}` : "";
  if (kind === "powershell") {
    // The call operator (&) is required to RUN a command in PowerShell; a bare
    // quoted name is otherwise echoed as a string literal — the core "invalid
    // syntax for spawning" bug. cliPath is a bare alphanumeric name so quoting
    // is unnecessary, but `&` makes intent explicit and survives any future path.
    return `& ${cliPath}${argStr}`;
  }
  // cmd + posix: a bare (alphanumeric) command name resolves from PATH.
  return `${cliPath}${argStr}`;
}

/**
 * Persist a (potentially multi-line) system prompt to a temp file so it can be
 * passed via `--append-system-prompt-file` instead of inline on the typed PTY
 * command line. `tag` keys the filename so re-spawns of the same session reuse
 * one file rather than leaking a new one each time. Best-effort: on any write
 * failure we fall back to an inline flag at the call site.
 */
function writeSystemPromptFile(content: string, tag: string): string | null {
  try {
    const dir = path.join(tmpdir(), "infinibot-prompts");
    fs.mkdirSync(dir, { recursive: true });
    const safeTag = tag.replace(/[^a-zA-Z0-9_-]/g, "_");
    const file = path.join(dir, `${safeTag}.txt`);
    fs.writeFileSync(file, content, "utf8");
    return file;
  } catch {
    return null;
  }
}

/**
 * Build the shell command for invoking an agent CLI, matching the PTY's actual
 * shell (posix / cmd / powershell).
 */
export function buildAgentCLIShellCommand(cliPath: string, config: AgentCLICommandConfig): string {
  const { cli, cwd, options } = config;
  const kind = detectShellKind();
  const esc = (a: string) => escapeArgFor(kind, a);

  // Build extra flags based on options
  const flags: string[] = [];

  // Auto mode for EVERY spawned terminal (user preference): skip the CLI's
  // permission/approval prompts so it never blocks waiting for an operator
  // keypress. This is required for the hands-free voice surface and is the
  // default the user wants for all app-spawned agent terminals. Each backend
  // spells the flag differently (see FULL_AUTO_FLAGS): claude/opencode use
  // --dangerously-skip-permissions, codex --dangerously-bypass-approvals-and-
  // sandbox, gemini --yolo, ollama none. `options.dangerouslySkipPermissions`
  // is kept as an explicit signal but is no longer required.
  //
  // NOTE: Claude additionally shows a ONE-TIME "Bypass Permissions mode —
  // 1.No 2.Yes" accept prompt until the user accepts it once; after that claude
  // saves bypassPermissionsModeAccepted=true and never asks again.
  for (const f of FULL_AUTO_FLAGS[cli] ?? [DANGEROUSLY_SKIP_PERMISSIONS_FLAG]) {
    flags.push(f);
  }

  // Pre-assign the Claude Code session-id. Modern Claude Code accepts
  // `--session-id <UUID>`; the transcript file is then named after that
  // UUID, which lets the voice-chat assistant-text streamer locate the
  // right transcript even when several sessions share a cwd.
  if (cli === "claude" && options?.claudeSessionId) {
    flags.push("--session-id", esc(options.claudeSessionId));
  }

  // Voice orchestrator system prompt (mobile voice call opts in). Claude-only
  // (the flag is Claude Code's; other CLIs don't accept it).
  //
  // CRITICAL: pass the prompt via --append-system-prompt-file, NOT inline with
  // --append-system-prompt. The command is *typed into the PTY's shell*, and the
  // orchestrator prompts are multi-line. On a cmd.exe / PowerShell PTY a newline
  // inside the quoted argument terminates the command line, which truncates the
  // invocation — claude then ignores the trailing flags (notably --session-id),
  // spawns a fresh untracked session, and the voice read-aloud can never locate
  // its transcript (it looks the session up by the id we assigned). Writing the
  // prompt to a temp file keeps the typed command single-line on every shell.
  if (cli === "claude" && options?.voiceOrchestrator) {
    const prompt = buildVoiceTerminalSystemPrompt();
    const file = writeSystemPromptFile(prompt, `voice-${options.claudeSessionId ?? "default"}`);
    if (file) flags.push("--append-system-prompt-file", esc(file));
    else flags.push("--append-system-prompt", esc(prompt));
  } else if (cli === "claude" && options?.orchestrator) {
    // MCP orchestrator system prompt for UI-spawned terminals. Same delegate-
    // by-default mental model as the voice path, but framed for a text MCP
    // surface (no TTS pacing) — see src/agents/mcp-orchestrator-prompt.ts.
    // Skipped when voiceOrchestrator is already set: voice mode is a strict
    // superset (it carries the orchestrator block plus the TTS-speakable
    // rules), so we avoid stacking two near-identical preambles.
    const prompt = buildMcpOrchestratorPrompt();
    const file = writeSystemPromptFile(prompt, `mcp-${options.claudeSessionId ?? "default"}`);
    if (file) flags.push("--append-system-prompt-file", esc(file));
    else flags.push("--append-system-prompt", esc(prompt));
  }

  // Add model flag for CLIs that support it
  if (
    options?.model &&
    (cli === "gemini" || cli === "opencode" || cli === "codex" || cli === "grok")
  ) {
    flags.push("--model", esc(options.model));
  }

  // Add any extra flags
  if (options?.extraFlags) {
    flags.push(...options.extraFlags.map((f) => esc(f)));
  }

  const positionalArgs: string[] = [];
  if (cli === "codex" && options?.initialPrompt?.trim()) {
    positionalArgs.push(esc(options.initialPrompt));
  }
  if (cli === "ollama" && options?.model?.trim()) {
    positionalArgs.push("run", esc(options.model.trim()));
  }

  const args = [...flags, ...positionalArgs];

  const parts = [clearCmdFor(kind)];
  const cd = cdCmdFor(kind, cwd);
  if (cd) parts.push(cd);
  parts.push(invocationFor(kind, cliPath, args));

  return `${parts.join(chainSepFor(kind))}\r`;
}

/**
 * Get CLI display name for terminal title
 */
export function getCLIDisplayName(cli: AgentCLI): string {
  switch (cli) {
    case "claude":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "gemini":
      return "Gemini";
    case "codex":
      return "Codex";
    case "grok":
      return "Grok";
    case "ollama":
      return "Ollama";
    default:
      return "Agent";
  }
}

/**
 * Check if a terminal should be auto-renamed when an agent CLI is invoked.
 */
export function shouldAutoRenameTerminal(currentTitle: string): boolean {
  const agentPatterns = [
    /^Claude(\s|$)/,
    /^OpenCode(\s|$)/,
    /^Gemini(\s|$)/,
    /^Codex(\s|$)/,
    /^Ollama(\s|$)/,
    /^Agent(\s|$)/,
  ];

  for (const pattern of agentPatterns) {
    if (pattern.test(currentTitle)) {
      return false;
    }
  }

  const defaultNamePattern = /^Terminal \d+$/;
  return defaultNamePattern.test(currentTitle);
}

/**
 * Finalize terminal state after invoking an agent CLI.
 */
export function finalizeAgentCLIInvoke(
  terminal: TerminalProcess,
  cli: AgentCLI,
  broadcast: (event: string, payload: any) => void,
): void {
  if (shouldAutoRenameTerminal(terminal.title)) {
    const title = getCLIDisplayName(cli);
    terminal.title = title;
    broadcast("terminal.titleChange", { terminalId: terminal.id, title });
  }
}

/**
 * Invoke an agent CLI in a terminal asynchronously.
 */
export async function invokeAgentCLIAsync(
  terminal: TerminalProcess,
  cli: AgentCLI,
  cwd: string | undefined,
  options: AgentCLIOptions | undefined,
  broadcast: (event: string, payload: any) => void,
): Promise<void> {
  debugLog(`[AgentCLI] Invoking ${cli} CLI in terminal ${terminal.id}`);

  const cliPath = getToolPath(cli);

  const command = buildAgentCLIShellCommand(cliPath, {
    cli,
    cwd,
    options,
  });

  if (terminal.pty) {
    terminal.pty.write(command);
  }

  terminal.cliType = cli;
  // If the caller pre-assigned a Claude Code session-id, capture it on the
  // terminal record now (the in-output extractor would also pick it up
  // later, but the streamer needs it as early as possible — read-aloud
  // wants to attach before Claude has flushed any output).
  if (cli === "claude" && options?.claudeSessionId) {
    terminal.claudeSessionId = options.claudeSessionId;
    terminal.isClaudeMode = true;
    broadcast("terminal.claudeSessionId", {
      terminalId: terminal.id,
      sessionId: options.claudeSessionId,
    });
  }

  finalizeAgentCLIInvoke(terminal, cli, broadcast);
}
