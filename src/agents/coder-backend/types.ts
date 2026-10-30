/**
 * CoderBackend — unified interface for CLI coding-agent backends.
 *
 * Concrete implementations: ClaudeCodeBackend, OpenCodeBackend.
 * Factory: getCoderBackend() in registry.ts.
 *
 * COORDINATION: opencode-swap — new file; no existing code modified here.
 */

export type CoderBackendId = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

/** Every coder backend, in picker order. Single source for enums and validators. */
export const CODER_BACKEND_IDS = ["claude-code", "codex", "opencode", "gemini", "grok"] as const;

/** CLI binary each backend runs. */
export function coderCliCommand(id: CoderBackendId): string {
  return id === "claude-code" ? "claude" : id;
}

export function isCoderBackendId(value: unknown): value is CoderBackendId {
  return typeof value === "string" && (CODER_BACKEND_IDS as readonly string[]).includes(value);
}

// ── Re-exports from launcher so call sites don't need two imports ──────────
export type { SessionInfo, LaunchOptions, BackgroundSession } from "../claude-code/launcher.js";
export type { CLIAgentConfig } from "../types/agent-types.js";

// ── MCP entry shape shared between backends ────────────────────────────────

export interface McpServerEntry {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  enabled?: boolean;
}

// ── Capabilities advertised by each backend ────────────────────────────────

export interface CoderBackendCapabilities {
  /** Backend identifier for logging / UI display. */
  id: CoderBackendId;
  /** Human-readable name for UI. */
  displayName: string;
  /** Supports `--output-format stream-json` (or equivalent). */
  supportsStreamJson: boolean;
  /** Supports passing a scoped MCP config file / injecting MCP config. */
  supportsMcpConfig: boolean;
  /** Supports resuming a previous session. */
  supportsSessionResume: boolean;
  /** Can run multiple sessions in parallel. */
  supportsParallelSessions: boolean;
  /**
   * Model string format expected by the CLI.
   * "name"          → bare model name, e.g. "claude-sonnet-4-6"  (Claude Code)
   * "provider/name" → provider-prefixed,  e.g. "anthropic/claude-sonnet-4-6" (OpenCode)
   */
  modelFormat: "name" | "provider/name";
}

// ── Check-installed result ─────────────────────────────────────────────────

export interface BackendInstallStatus {
  installed: boolean;
  version?: string;
  /** Absolute resolved path to the CLI binary, when found. */
  binPath?: string;
  /** Human-readable one-click install hint shown in the UI when not installed. */
  installHint?: string;
}

// ── The interface every backend must implement ─────────────────────────────

import type { CLIAgentConfig } from "../types/agent-types.js";
import type { SessionInfo, LaunchOptions, BackgroundSession } from "../claude-code/launcher.js";

export interface CoderBackend {
  readonly id: CoderBackendId;

  /**
   * Spawn the agent, wait for it to finish, and return the session result.
   * Equivalent to `spawnClaudeCodeAgent` for CC.
   */
  spawn(
    config: CLIAgentConfig,
    task: string,
    workdir: string,
    options?: LaunchOptions,
  ): Promise<SessionInfo>;

  /**
   * Spawn the agent in the background and return a handle immediately.
   * Equivalent to `spawnClaudeCodeAgentBackground` for CC.
   */
  spawnBackground(
    config: CLIAgentConfig,
    task: string,
    workdir: string,
    options?: LaunchOptions,
  ): BackgroundSession;

  /**
   * Write an MCP server entry into the backend's global config file.
   * For CC → `~/.claude.json` mcpServers.
   * For OC → `~/.config/opencode/opencode.json` mcp.
   */
  installMcp(serverName: string, entry: McpServerEntry): Promise<void>;

  /**
   * Remove an MCP server entry from the backend's global config file.
   */
  uninstallMcp(serverName: string): Promise<void>;

  /**
   * List MCP server names currently in the backend's global config file.
   */
  listInstalledMcps(): Promise<string[]>;

  /** Return static capability flags for this backend. */
  getCapabilities(): CoderBackendCapabilities;

  /**
   * Check whether the CLI binary is installed and return its version.
   * Used by the UI to offer a one-click install when the backend is missing.
   */
  checkInstalled(): Promise<BackendInstallStatus>;
}
