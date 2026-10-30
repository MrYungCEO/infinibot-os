import crypto from "node:crypto";

import type { Skill } from "@mariozechner/pi-coding-agent";
import type { NormalizedChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { TtsAutoMode } from "../types.tts.js";

export type SessionScope = "per-sender" | "global";

export type SessionChannelId = ChannelId | "webchat";

export type SessionChatType = NormalizedChatType;

export type SessionOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: SessionChatType;
  from?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type ClaudeBridgeState = {
  enabled: boolean;
  terminalId: string;
  claudeSessionId: string;
  cwd: string;
  startedAt: number;
};

/**
 * Chat composer "CLI" mode for a chat thread (server-methods/chat-cli.ts):
 * which coding CLI the thread talks to, in which folder, and the CLI's own
 * session id per backend so each backend's conversation resumes where it
 * left off when the user switches back to it.
 */
export type CliChatState = {
  mode: "agent" | "cli";
  backend?: "claude-code" | "codex" | "opencode" | "gemini" | "grok";
  cwd?: string;
  /** Model per backend (absent = the CLI's own default). */
  models?: Partial<Record<"claude-code" | "codex" | "opencode" | "gemini" | "grok", string>>;
  /** CLI session id per backend, resumed on the next turn. */
  sessions?: Partial<Record<"claude-code" | "codex" | "opencode" | "gemini" | "grok", string>>;
  updatedAt: number;
};

export type SessionEntry = {
  /**
   * Last delivered heartbeat payload (used to suppress duplicate heartbeat notifications).
   * Stored on the main session entry.
   */
  lastHeartbeatText?: string;
  /** Timestamp (ms) when lastHeartbeatText was delivered. */
  lastHeartbeatSentAt?: number;
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string;
  /** Federation: node ID or name where session is running (persisted for neural map) */
  federationNode?: string;
  /** Federation: true if session was spawned on a remote node */
  federationRemote?: boolean;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  chatType?: SessionChatType;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  ttsAuto?: TtsAutoMode;
  execHost?: string;
  execSecurity?: string;
  execAsk?: string;
  execNode?: string;
  responseUsage?: "on" | "off" | "tokens" | "full";
  providerOverride?: string;
  modelOverride?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
  groupActivation?: "mention" | "always";
  groupActivationNeedsSystemIntro?: boolean;
  sendPolicy?: "allow" | "deny";
  queueMode?:
    | "steer"
    | "followup"
    | "collect"
    | "steer-backlog"
    | "steer+backlog"
    | "queue"
    | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: "old" | "new" | "summarize";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  compactionCount?: number;
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  cliSessionIds?: Record<string, string>;
  claudeCliSessionId?: string;
  /**
   * `/claude` chat bridge. When `enabled`, inbound chat messages bypass the
   * gateway agent and are typed into an interactive Claude Code session
   * running in the tmux-backed terminal `terminalId`. Kept (with
   * enabled=false) after `/claude off` so toggling back on resumes the same
   * Claude session.
   */
  claudeBridge?: ClaudeBridgeState;
  /** Chat composer Agent/CLI mode for this thread (see CliChatState). */
  cliChat?: CliChatState;
  /**
   * Coder backend that produced this session, when applicable.
   * "claude-code" | "opencode" | "codex" | "gemini" | "grok". Set by `claude-coder-tool` at
   * spawn time so the activity feed can label/recolour the row with the
   * right provider logo without re-deriving it from displayName strings.
   */
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  label?: string;
  /** Pinned to the top of chat sidebars (webchat view). */
  pinned?: boolean;
  displayName?: string;
  channel?: string;
  groupId?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  origin?: SessionOrigin;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionChannelId;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  skillsSnapshot?: SessionSkillSnapshot;
  systemPromptReport?: SessionSystemPromptReport;
};

export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, Date.now());
  if (!existing) return { ...patch, sessionId, updatedAt };
  return { ...existing, ...patch, sessionId, updatedAt };
}

export type GroupKeyResolution = {
  key: string;
  channel?: string;
  id?: string;
  chatType?: SessionChatType;
};

export type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
  resolvedSkills?: Skill[];
  version?: number;
};

export type SessionSystemPromptReport = {
  source: "run" | "estimate";
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars?: number;
  sandbox?: {
    mode?: string;
    sandboxed?: boolean;
  };
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
  };
  injectedWorkspaceFiles: Array<{
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
  }>;
  skills: {
    promptChars: number;
    entries: Array<{ name: string; blockChars: number }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      summaryChars: number;
      schemaChars: number;
      propertiesCount?: number | null;
    }>;
  };
};

export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 60;
