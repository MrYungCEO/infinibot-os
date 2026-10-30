import type { NormalizedChatType } from "../channels/chat-type.js";
import type { SessionEntry } from "../config/sessions.js";
import type { DeliveryContext } from "../utils/delivery-context.js";

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
};

export type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  pinned?: boolean;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  chatType?: NormalizedChatType;
  origin?: SessionEntry["origin"];
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  responseUsage?: "on" | "off" | "tokens" | "full";
  modelProvider?: string;
  /** True when the session pins a model (sessions.patch model) instead of its agent default. */
  modelOverridden?: boolean;
  model?: string;
  contextTokens?: number;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionEntry["lastChannel"];
  lastTo?: string;
  lastAccountId?: string;
  /** Federation: human-facing node name/id where session is running */
  node?: string;
  /** Federation: canonical node id (the world-map island key). Distinct from
   *  `node`, which may carry a display name. */
  nodeId?: string;
  /** Federation: true if session is running on a remote node */
  remote?: boolean;
  /** Transcript file path */
  transcriptPath?: string;
  /**
   * Coder backend that produced this row, when applicable. Mirrors
   * SessionEntry.coderBackend so the activity feed can pick the right
   * provider logo/accent without re-deriving from displayName strings.
   */
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
  /** Effective default model ref ("provider/model") for new sessions of this agent. */
  model?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
  };
};

export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionsPreviewEntry = {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: SessionPreviewItem[];
};

export type SessionsPreviewResult = {
  ts: number;
  previews: SessionsPreviewEntry[];
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  /** Matching rows before `offset`/`limit` were applied. */
  total?: number;
  /** More rows exist past this page. */
  hasMore?: boolean;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: SessionEntry;
};
