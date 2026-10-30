/**
 * Agent Type System
 *
 * Defines the configuration shapes for native (LLM API) and CLI-based agents.
 * Both types share a common base that includes MCP access control via `enabledMCPs`.
 */

// ══════════════════════════════════════════════════════════════════════════════
// Core Types
// ══════════════════════════════════════════════════════════════════════════════

export type AgentType = "native" | "cli";

export interface BaseAgentConfig {
  /** Unique identifier for this agent configuration. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Discriminant: native (direct LLM API) or cli (spawned subprocess). */
  type: AgentType;
  /** Optional description of the agent's role or purpose. */
  description?: string;
  /** MCP server names this agent is allowed to access. */
  enabledMCPs: string[];
}

// ══════════════════════════════════════════════════════════════════════════════
// Native Agent (direct LLM API calls via Anthropic/OpenRouter/etc.)
// ══════════════════════════════════════════════════════════════════════════════

export interface NativeAgentConfig extends BaseAgentConfig {
  type: "native";
  /** Model identifier (e.g. "claude-opus-4-5", "gpt-4o"). */
  model: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Tool names (not MCP names) this agent can invoke directly. */
  tools: string[];
}

// ══════════════════════════════════════════════════════════════════════════════
// CLI Agent (spawned subprocess - Claude Code, Codex, etc.)
// ══════════════════════════════════════════════════════════════════════════════

export interface CLIAgentConfig extends BaseAgentConfig {
  type: "cli";
  /** CLI executable name or path (e.g. "claude", "codex"). */
  cliCommand: string;
  /** Extra arguments appended to the command. */
  cliArgs?: string[];
  /** Whether to run with full auto-approve (--dangerously-skip-permissions). */
  autoApprove: boolean;
  /** Hard timeout for the spawned process. */
  timeoutMinutes: number;
  /** Allowed tool categories for the CLI agent (Edit, Bash, Read, etc.). */
  allowedTools?: string[];
  /** Additional environment variables injected into the subprocess. */
  env?: Record<string, string>;
}

// ══════════════════════════════════════════════════════════════════════════════
// Union & Helpers
// ══════════════════════════════════════════════════════════════════════════════

export type AgentConfig = NativeAgentConfig | CLIAgentConfig;

export function isNativeAgent(config: AgentConfig): config is NativeAgentConfig {
  return config.type === "native";
}

export function isCLIAgent(config: AgentConfig): config is CLIAgentConfig {
  return config.type === "cli";
}
