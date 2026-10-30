export type ExecApprovalForwardingMode = "session" | "targets" | "both";

export type ExecApprovalForwardTarget = {
  /** Channel id (e.g. "discord", "slack", or plugin channel id). */
  channel: string;
  /** Destination id (channel id, user id, etc. depending on channel). */
  to: string;
  /** Optional account id for multi-account channels. */
  accountId?: string;
  /** Optional thread id to reply inside a thread. */
  threadId?: string | number;
};

export type ExecApprovalForwardingConfig = {
  /** Enable forwarding exec approvals to chat channels. Default: false. */
  enabled?: boolean;
  /** Delivery mode (session=origin chat, targets=config targets, both=both). Default: session. */
  mode?: ExecApprovalForwardingMode;
  /** Only forward approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only forward approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Explicit delivery targets (used when mode includes targets). */
  targets?: ExecApprovalForwardTarget[];
};

/**
 * Telegram delivery for the unified approval registry
 * (src/autonomy/approval-registry.ts → src/approvals/telegram-approvals.ts).
 */
export type TelegramApprovalsConfig = {
  /** Default: on whenever an operator chat can be resolved. Set false to disable. */
  enabled?: boolean;
  /** Chat to deliver to. Default: channels.telegram.defaultChatId → allowFrom[0]. */
  chatId?: string;
  /**
   * Telegram user ids (or @usernames) whose taps/replies count. Default: the
   * owner (allowFrom[0]) + a private numeric defaultChatId. Empty → fail closed.
   */
  operatorIds?: Array<string | number>;
  /** Telegram account to send with (multi-account installs). */
  accountId?: string;
  /** Only deliver these sources (subagent-checkpoint, exec, tool-gate, orchestrator, autopilot, custom). */
  sources?: string[];
  /** Only deliver requests at or above this risk. Default: low (everything). */
  minRisk?: "low" | "medium" | "high" | "critical";
  /** Burst window: requests arriving within it are grouped into one digest. Default 1500. */
  digestWindowMs?: number;
  /** Minimum spacing between approval messages (rate limit). Default 3000. */
  minIntervalMs?: number;
};

export type ApprovalsConfig = {
  exec?: ExecApprovalForwardingConfig;
  telegram?: TelegramApprovalsConfig;
  /** Expiry for gated sub-agent check-ins (expiry = stop). Default 30. */
  checkpointTimeoutMinutes?: number;
};
