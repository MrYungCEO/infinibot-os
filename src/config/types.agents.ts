import type { AgentDefaultsConfig } from "./types.agent-defaults.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
    };

/**
 * CLI coder backend identifier. Mirrors `CoderBackendId` in
 * src/agents/coder-backend/types.ts (kept as a literal union here to avoid the
 * config layer depending on the agents layer).
 */
export type AgentCoderBackend = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  /**
   * Secure Mode: this agent only ever runs in the secure lane (local models,
   * allowlisted tools, encrypted transcripts). Normal-lane runs are refused.
   */
  secureOnly?: boolean;
  /**
   * Subscription CLI routing for this agent: true = always run through the
   * user's logged-in CLI (claude-cli, codex-cli, …), false = never, unset =
   * follow the global `cliRoutingEnabled`.
   */
  cliRouting?: boolean;
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  /**
   * Reference (NOT the raw value) to this agent's encrypted Telegram bot token,
   * used for outbound notifications attributable to this agent. Overrides the
   * global token (channels.telegram / TELEGRAM_BOT_TOKEN) when set. The raw
   * token is stored encrypted in the agent secret store; this holds a pointer
   * of the form "vault://agents/<id>/telegram-bot-token". Never the plaintext.
   */
  telegramBotTokenRef?: string;
  /**
   * Per-agent Telegram bot configuration for the TelegramBotRouter. When set,
   * this agent gets its own Telegram bot that receives and routes messages
   * independently of the main channels.telegram account.
   */
  telegramBot?: {
    /** Raw bot token (not recommended — prefer telegramBotTokenRef). */
    botToken?: string;
    /** Bot username without the @, used to filter commands. */
    botUsername?: string;
    /** Allowlist of Telegram user IDs or usernames that can message this bot. */
    allowFrom?: Array<string | number>;
  };
  /**
   * Default CLI coder backend this agent spawns. When unset, the global
   * `coder.backend` default applies (claude-code).
   */
  defaultCoderBackend?: AgentCoderBackend;
  /**
   * Backend to retry once with when `defaultCoderBackend` fails to start
   * (binary missing, auth error, non-zero exit before first turn). When unset
   * there is no automatic fallback.
   */
  fallbackCoderBackend?: AgentCoderBackend;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    /** Agent workspace access inside the sandbox. */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    workspaceRoot?: string;
    /** Docker-specific sandbox overrides for this agent. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser overrides for this agent. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune overrides for this agent. */
    prune?: SandboxPruneSettings;
  };
  tools?: AgentToolsConfig;
  /**
   * Custom system prompt for this agent.
   * When set and not "default", replaces the built-in system prompt for this agent only.
   * Context files (SOUL.md, USER.md, etc.) are still appended.
   * Leave empty or set to "default" to use the global/default system prompt.
   */
  systemPrompt?: string;
  /**
   * Terminal-first execution mode.
   * When mode is "terminal", sessions_spawn creates a PTY terminal
   * and runs the specified CLI instead of the InfiniBot agent loop.
   * The terminal shows live in the UI with real-time output.
   */
  execution?: {
    /** Execution mode: "agent-loop" (default) or "terminal" (CLI in PTY). */
    mode?: "agent-loop" | "terminal";
    /** CLI to invoke when mode is "terminal". */
    cli?: "claude" | "opencode" | "gemini" | "codex" | "grok" | "ollama";
    /** Auto-close terminal tab on completion (default: true). */
    autoClose?: boolean;
    /** Delay in ms before auto-closing (default: 5000). */
    autoCloseDelayMs?: number;
  };
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
  /**
   * Standard-roster packs to seed in addition to "core" (main + coders):
   * "dev", "content", "business", "ops", or "all". Unset on a fresh install →
   * core only. Installs that already carry pack agents keep getting the full
   * roster. Seeding never removes agents.
   */
  rosterPacks?: string[];
};

export type AgentBinding = {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: "dm" | "group" | "channel"; id: string };
    guildId?: string;
    teamId?: string;
  };
};
