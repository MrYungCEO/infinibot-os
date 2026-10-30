/**
 * Terminal System Types
 * Type definitions for the multiterminal system
 */

import type { IPty } from "@lydell/node-pty";
export type { IPty };

/**
 * Shell type for Windows terminals.
 * Used to determine correct command chaining syntax:
 * - 'powershell': Uses ';' (PowerShell 5.1 doesn't support '&&')
 * - 'cmd': Uses '&&' (cmd.exe, PowerShell 7+, bash, etc.)
 */
export type WindowsShellType = "powershell" | "cmd";

/**
 * Terminal process state (internal)
 */
export interface TerminalProcess {
  id: string;
  pty: IPty;
  cwd: string;
  title: string;
  createdAt: Date;
  projectPath?: string;
  agentId?: string;
  sessionKey?: string;
  displayOrder?: number;
  outputBuffer?: string;
  isClaudeMode?: boolean;
  claudeSessionId?: string;
  claudeProfileId?: string;
  worktreeConfig?: TerminalWorktreeConfig;
  pendingClaudeResume?: boolean;
  cliType?: AgentCLI;
  /** Spawn-agent metadata (set when terminal was created by sessions_spawn) */
  spawnMeta?: {
    runId: string;
    sessionKey: string;
    agentId: string;
    task: string;
    label?: string;
    autoClose: boolean;
    autoCloseDelayMs: number;
    startedAt: number;
  };
}

/**
 * Terminal session data (persisted)
 */
export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  projectPath?: string;
  agentId?: string;
  sessionKey?: string;
  displayOrder?: number;
  outputBuffer?: string;
  isClaudeMode?: boolean;
  claudeSessionId?: string;
  worktreeConfig?: TerminalWorktreeConfig;
  /** Last invoked agent CLI for this terminal — lets the UI re-pick the correct badge after a refresh. */
  cliType?: string;
}

/**
 * Terminal creation options
 */
export interface TerminalCreateOptions {
  id?: string;
  cwd?: string;
  title?: string;
  projectPath?: string;
  agentId?: string;
  sessionKey?: string;
  cols?: number;
  rows?: number;
  /** Skip injecting OAuth token into terminal environment (used for auth terminals) */
  skipOAuthToken?: boolean;
  /** Custom environment variables to add to the terminal (merged with defaults) */
  env?: Record<string, string>;
  worktreeConfig?: TerminalWorktreeConfig;
}

/**
 * Terminal operation result
 */
export interface TerminalOperationResult {
  success: boolean;
  error?: string;
  terminalId?: string;
  /**
   * Set by `destroyTerminal` when the terminal was a live `spawn-*` sub-agent
   * pane: the pty client was dropped but the tmux session (and the agent
   * running inside it) was deliberately left alive.
   */
  tmuxSessionPreserved?: boolean;
}

/**
 * Terminal worktree configuration
 */
export interface TerminalWorktreeConfig {
  name: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  hasGitBranch: boolean;
  taskId?: string;
  createdAt: string;
  terminalId: string;
}

/**
 * Agent CLI types
 */
export type AgentCLI = "claude" | "opencode" | "gemini" | "codex" | "grok" | "ollama";

/**
 * Options for Agent CLI invocation
 */
export interface AgentCLIOptions {
  model?: string;
  dangerouslySkipPermissions?: boolean;
  extraFlags?: string[];
  /**
   * Initial prompt to pass as a CLI argument when the CLI supports it.
   * Used for Codex so terminal spawns do not race the TUI startup by
   * typing before Codex has finished initializing MCP servers.
   */
  initialPrompt?: string;
  /**
   * Pre-assigned Claude Code session UUID. When set, infinibot passes
   * `--session-id <UUID>` to the `claude` CLI so the transcript filename
   * is known up front (it equals the session-id). This is what makes the
   * voice-chat read-aloud streamer work reliably when multiple Claude
   * Code sessions are running in the same cwd at once — without it we'd
   * fall back to a cwd+mtime heuristic that ties on simultaneous starts.
   * Ignored for non-claude CLIs.
   */
  claudeSessionId?: string;
  /**
   * When true, append the voice orchestrator system prompt via
   * `--append-system-prompt`. Set by the mobile voice call so the spawned
   * `claude` CLI behaves as a delegate-fast voice orchestrator (quick spoken
   * replies, background sub-agents for heavy work, stays open for dialogue).
   * Ignored for non-claude CLIs.
   */
  voiceOrchestrator?: boolean;
  /**
   * When true, append the MCP orchestrator system prompt via
   * `--append-system-prompt`. Set by UI-driven terminal spawns (the operator
   * is opening a Claude terminal to drive InfiniBot, not a sub-agent doing
   * one-shot work) so the spawned CLI knows it's the orchestrator and should
   * delegate medium/heavy work to InfiniBot sub-agents over MCP. Deliberately
   * NOT set by `claude_coder` / `codex_coder` / `opencode_coder` tools — those
   * are sub-agent spawns and must stay vanilla per their own preambles.
   * Ignored for non-claude CLIs (only Claude Code accepts the flag).
   */
  orchestrator?: boolean;
}

/**
 * Window getter function type
 */
export type WindowGetter = () => any | null;

/**
 * Terminal profile change info
 */
export interface TerminalProfileChangeInfo {
  id: string;
  cwd: string;
  projectPath?: string;
  claudeSessionId?: string;
  claudeProfileId?: string;
  isClaudeMode: boolean;
}

/**
 * Session date info
 */
export interface SessionDateInfo {
  date: string; // YYYY-MM-DD format
  label: string; // Human readable: "Today", "Yesterday", "Dec 10"
  sessionCount: number; // Total sessions across all projects
  projectCount: number; // Number of projects with sessions
}

/**
 * Terminal restore result
 */
export interface TerminalRestoreResult {
  restored: number;
  failed: number;
  sessions: Array<{ id: string; success: boolean; error?: string }>;
}

/**
 * Rate limit information when Claude Code hits subscription limits
 */
export interface RateLimitInfo {
  terminalId: string;
  resetTime: string; // e.g., "Dec 17 at 6am (Europe/Oslo)"
  detectedAt: Date;
  /** ID of the profile that hit the limit */
  profileId?: string;
  /** ID of a suggested alternative profile to switch to */
  suggestedProfileId?: string;
  /** Name of the suggested alternative profile */
  suggestedProfileName?: string;
  /** Whether auto-switch on rate limit is enabled */
  autoSwitchEnabled?: boolean;
}

/**
 * Rate limit information for SDK/CLI calls (non-terminal)
 */
export interface SDKRateLimitInfo {
  /** Source of the rate limit (which feature hit it) */
  source: "changelog" | "task" | "roadmap" | "ideation" | "title-generator" | "other";
  /** Project ID if applicable */
  projectId?: string;
  /** Task ID if applicable */
  taskId?: string;
  /** The reset time string */
  resetTime?: string;
  /** Type of limit: 'session' (5-hour) or 'weekly' (7-day) */
  limitType?: "session" | "weekly";
  /** Profile that hit the limit */
  profileId: string;
  /** Profile name for display */
  profileName?: string;
  /** Suggested alternative profile */
  suggestedProfile?: {
    id: string;
    name: string;
  };
  /** When detected */
  detectedAt: Date;
  /** Original error message */
  originalError?: string;
  /** Whether this rate limit was automatically handled via account swap */
  wasAutoSwapped?: boolean;
  /** Profile that was swapped to (if auto-swapped) */
  swappedToProfile?: {
    id: string;
    name: string;
  };
  /** Why the swap occurred: 'proactive' (before limit) or 'reactive' (after limit hit) */
  swapReason?: "proactive" | "reactive";
}

/**
 * Authentication failure information for SDK/CLI operations
 */
export interface AuthFailureInfo {
  /** The profile ID that failed to authenticate */
  profileId: string;
  /** The profile name for display */
  profileName?: string;
  /** Type of auth failure */
  failureType: "missing" | "invalid" | "expired" | "unknown";
  /** User-friendly message describing the failure */
  message: string;
  /** Original error message from the process output */
  originalError?: string;
  /** Task ID if applicable (for task-related auth failures) */
  taskId?: string;
  /** When detected */
  detectedAt: Date;
}

/**
 * OAuth token event payload
 */
export interface OAuthTokenEvent {
  terminalId: string;
  profileId?: string;
  email?: string | null;
  success: boolean;
  needsOnboarding?: boolean;
  message?: string;
  detectedAt: string; // ISO string across IPC
}

/**
 * Onboarding complete event payload
 */
export interface OnboardingCompleteEvent {
  terminalId: string;
  profileId?: string;
  detectedAt: string; // ISO string across IPC
}

/**
 * Rate limit event payload
 */
export interface RateLimitEvent extends Omit<RateLimitInfo, "detectedAt"> {
  detectedAt: string; // ISO string for IPC compatibility
}
