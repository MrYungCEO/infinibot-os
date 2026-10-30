export type ChannelsStatusSnapshot = {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelSystemImages?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  channels: Record<string, unknown>;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
  channelDefaultAccountId: Record<string, string>;
};

export type ChannelUiMetaEntry = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export const CRON_CHANNEL_LAST = "last";

export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string | null;
  enabled?: boolean | null;
  configured?: boolean | null;
  linked?: boolean | null;
  running?: boolean | null;
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastProbeAt?: number | null;
  mode?: string | null;
  dmPolicy?: string | null;
  allowFrom?: string[] | null;
  tokenSource?: string | null;
  botTokenSource?: string | null;
  appTokenSource?: string | null;
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  baseUrl?: string | null;
  allowUnmentionedGroups?: boolean | null;
  cliPath?: string | null;
  dbPath?: string | null;
  port?: number | null;
  probe?: unknown;
  audit?: unknown;
  application?: unknown;
};

export type WhatsAppSelf = {
  e164?: string | null;
  jid?: string | null;
};

export type WhatsAppDisconnect = {
  at: number;
  status?: number | null;
  error?: string | null;
  loggedOut?: boolean | null;
};

export type WhatsAppStatus = {
  configured: boolean;
  linked: boolean;
  authAgeMs?: number | null;
  self?: WhatsAppSelf | null;
  running: boolean;
  connected: boolean;
  lastConnectedAt?: number | null;
  lastDisconnect?: WhatsAppDisconnect | null;
  reconnectAttempts: number;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
};

export type TelegramBot = {
  id?: number | null;
  username?: string | null;
};

export type TelegramWebhook = {
  url?: string | null;
  hasCustomCert?: boolean | null;
};

export type TelegramProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: TelegramBot | null;
  webhook?: TelegramWebhook | null;
};

export type TelegramStatus = {
  configured: boolean;
  tokenSource?: string | null;
  running: boolean;
  mode?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: TelegramProbe | null;
  lastProbeAt?: number | null;
};

export type DiscordBot = {
  id?: string | null;
  username?: string | null;
};

export type DiscordProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: DiscordBot | null;
};

export type DiscordStatus = {
  configured: boolean;
  tokenSource?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: DiscordProbe | null;
  lastProbeAt?: number | null;
};

export type GoogleChatProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
};

export type GoogleChatStatus = {
  configured: boolean;
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: GoogleChatProbe | null;
  lastProbeAt?: number | null;
};

export type SlackBot = {
  id?: string | null;
  name?: string | null;
};

export type SlackTeam = {
  id?: string | null;
  name?: string | null;
};

export type SlackProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: SlackBot | null;
  team?: SlackTeam | null;
};

export type SlackStatus = {
  configured: boolean;
  botTokenSource?: string | null;
  appTokenSource?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: SlackProbe | null;
  lastProbeAt?: number | null;
};

export type SignalProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  version?: string | null;
};

export type SignalStatus = {
  configured: boolean;
  baseUrl: string;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: SignalProbe | null;
  lastProbeAt?: number | null;
};

export type IMessageProbe = {
  ok: boolean;
  error?: string | null;
};

export type IMessageStatus = {
  configured: boolean;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  cliPath?: string | null;
  dbPath?: string | null;
  probe?: IMessageProbe | null;
  lastProbeAt?: number | null;
};

export type NostrProfile = {
  name?: string | null;
  displayName?: string | null;
  about?: string | null;
  picture?: string | null;
  banner?: string | null;
  website?: string | null;
  nip05?: string | null;
  lud16?: string | null;
};

export type NostrStatus = {
  configured: boolean;
  publicKey?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  profile?: NostrProfile | null;
};

export type MSTeamsProbe = {
  ok: boolean;
  error?: string | null;
  appId?: string | null;
};

export type MSTeamsStatus = {
  configured: boolean;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  port?: number | null;
  probe?: MSTeamsProbe | null;
  lastProbeAt?: number | null;
};

export type ConfigSnapshotIssue = {
  path: string;
  message: string;
};

export type ConfigSnapshot = {
  path?: string | null;
  exists?: boolean | null;
  raw?: string | null;
  hash?: string | null;
  parsed?: unknown;
  valid?: boolean | null;
  config?: Record<string, unknown> | null;
  issues?: ConfigSnapshotIssue[] | null;
};

export type ConfigUiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};

export type ConfigUiHints = Record<string, ConfigUiHint>;

export type ConfigSchemaResponse = {
  schema: unknown;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

export type PresenceEntry = {
  instanceId?: string | null;
  host?: string | null;
  ip?: string | null;
  version?: string | null;
  platform?: string | null;
  deviceFamily?: string | null;
  modelIdentifier?: string | null;
  mode?: string | null;
  lastInputSeconds?: number | null;
  reason?: string | null;
  text?: string | null;
  ts?: number | null;
};

export type GatewaySessionsDefaults = {
  model: string | null;
  contextTokens: number | null;
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
  /** Effective default model ref ("provider/model") for new sessions. */
  model?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
  };
};

export type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  scope: string;
  agents: GatewayAgentRow[];
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
  surface?: string;
  subject?: string;
  groupChannel?: string;
  room?: string;
  space?: string;
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
  responseUsage?: string;
  model?: string;
  modelProvider?: string;
  /** True when the session pins a model instead of its agent default. */
  modelOverridden?: boolean;
  contextTokens?: number;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  /** Matching rows before offset/limit (gateways with session paging). */
  total?: number;
  hasMore?: boolean;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: {
    sessionId: string;
    updatedAt?: number;
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
  };
};

export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
    kind: "agentTurn";
    message: string;
    thinking?: string;
    timeoutSeconds?: number;
    deliver?: boolean;
    provider?:
    | "last"
    | "whatsapp"
    | "telegram"
    | "discord"
    | "slack"
    | "signal"
    | "imessage"
    | "msteams";
    to?: string;
    bestEffortDeliver?: boolean;
  };

export type CronIsolation = {
  postToMainPrefix?: string;
};

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
};

export type CronJob = {
  id: string;
  agentId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  isolation?: CronIsolation;
  state?: CronJobState;
};

export type CronStatus = {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
};

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  status: "ok" | "error" | "skipped";
  durationMs?: number;
  error?: string;
  summary?: string;
};

export type SkillsStatusConfigCheck = {
  path: string;
  value: unknown;
  satisfied: boolean;
};

export type SkillInstallOption = {
  id: string;
  kind: "brew" | "node" | "go" | "uv";
  label: string;
  bins: string[];
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  configChecks: SkillsStatusConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

export type StatusSummary = Record<string, unknown>;

export type HealthSnapshot = Record<string, unknown>;

// ── Skill auto-generation queue types ─────────────────────────────────────────

export type DraftStatus = "pending" | "accepted" | "rejected";
export type HealingStatus = "pending" | "applied" | "rejected";
export type DraftScope = "user" | "workspace" | "infinibot";

export type SkillDraftUi = {
  id: string;
  slug: string;
  proposedAt: number;
  source: "reflection" | "healing";
  triggerOp?: string;
  draftPath: string;
  status: DraftStatus;
  reviewedAt?: number;
  rejectReason?: string;
  skillMd?: string;
};

export type HealingProposalUi = {
  id: string;
  skillName: string;
  reason: string;
  proposedAt: number;
  proposalPath: string;
  status: HealingStatus;
  reviewedAt?: number;
  rejectReason?: string;
  proposedMd?: string;
  currentMd?: string;
  diff?: string;
};

export type SkillActivityEntry = {
  id: string;
  ts: number;
  type:
    | "draft_created"
    | "draft_accepted"
    | "draft_rejected"
    | "healing_queued"
    | "healing_applied"
    | "healing_rejected";
  message: string;
  relatedId?: string;
  relatedSlug?: string;
};

export type SkillSystemConfig = {
  enabled: boolean;
  autoGenerate: boolean;
  autoHealing: boolean;
  minDurationMs: number;
  requireApproval: boolean;
};

export type SkillQueueStats = {
  pendingDrafts: number;
  pendingHealing: number;
  acceptedLastWeek: number;
  rejectedLastWeek: number;
};

export type LogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

export type LogEntry = {
  raw: string;
  time?: string | null;
  level?: LogLevel | null;
  subsystem?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
};

export type TaskStatus = "backlog" | "todo" | "in_progress" | "review" | "done";

export type ProjectStatus = 
  | "Not started" | "In progress" | "Completed" | "Paused" 
  | "Updating" | "Awaiting Client" | "Reviewing" | "Cancelled";

export type PriorityLevel = "Immediate" | "High" | "Medium" | "Low";

export interface KanbanProject {
  id: string;
  name: string;
  description?: string;
  color?: string;
  createdAt: number;
  updatedAt: number;

  // Notion integration fields
  notionId?: string;
  status?: ProjectStatus;
  priority?: PriorityLevel;
  type?: string[];
  progress?: number;
  taskCount?: number;
  coverUrl?: string;
  productUrl?: string;
  dueDate?: string;
  
  // Style customization
  customIcon?: string;
  iconColor?: string;
  textColor?: string;
  bgColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: "solid" | "dashed" | "dotted";

  // Instance assignment
  assignedInstances?: string[];

  // Business link (local-only, not synced to Notion)
  businessId?: string;

  // Media-provider project link (local-only) — groups generated assets.
  mediaProjectId?: string;

  // GitHub integration (local-only, not synced to Notion)
  githubRepoUrl?: string;
  githubRepo?: { owner: string; name: string };
  githubDefaultBranch?: string;
  githubLocalPath?: string;
  githubLastSyncAt?: number;
  githubSyncStatus?: "clean" | "behind" | "ahead" | "diverged" | "conflict" | "unknown";

  // Cash-flow tracking — surfaced on the projects gallery and edit dialog.
  // USD amounts; presentation/format lives in the view. Dates are ISO
  // (yyyy-mm-dd) and scope the amount to a billing cycle / month.
  paidAmount?: number;
  pendingPay?: number;
  paidAmountDate?: string;
  pendingPayDate?: string;

  // Monthly recurring revenue (USD). Manually set on the project header
  // popover; rolls up into the Agency Operations MRR statistic.
  mrr?: number;

  // Ordering
  rank?: number;

  // Sub-project hierarchy. `null` is an explicit "clear parent" signal sent to
  // the kanban gateway method (matches the store's `string | null`).
  parentProjectId?: string | null;
}

export interface ProjectNote {
  id: string;
  projectId: string;
  title: string;
  content: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectAttachment {
  id: string;
  projectId: string;
  name: string;
  path: string;
  size: number;
  mimeType?: string;
  createdAt: number;
}

export interface ProjectBadge {
  id: string;
  projectId: string;
  label: string;
  color?: string;
  icon?: string;
  createdAt: number;
}

export interface ProjectContent {
  notes: ProjectNote[];
  attachments: ProjectAttachment[];
  badges: ProjectBadge[];
}

export interface KanbanTask {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  
  // Agent Assignment Fields
  assignedAgent?: string | null;
  requiredSpecialties?: string[];
  requiredTools?: string[];
  priority?: "low" | "normal" | "high" | "critical";
  
  // Autonomous Agent Assignment
  autonomous?: boolean;
  autonomousStatus?: "pending_preflight" | "pending_approval" | "approved" | "in_progress" | "blocked" | "testing" | "complete" | "failed";

  // Notion integration fields
  notionId?: string;
  notionStatus?: string;
  dueDate?: string;
  done?: boolean;
  department?: string[];
  priorityLevel?: PriorityLevel;
  
  // Style customization
  customIcon?: string;
  iconColor?: string;
  textColor?: string;
  bgColor?: string;
  projectType?: string;
  classification?: string;
  funnelStage?: string;
  
  // Ordering
  rank?: number;
}
