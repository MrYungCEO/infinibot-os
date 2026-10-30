/**
 * Credits / API-cost ledger — type definitions.
 *
 * The credit ledger is the single source of truth for token + USD spend
 * across every provider, agent backend, and CLI we spawn. Existing
 * `api-monitor` and `budget/store` write-paths funnel into the same DB so
 * UI consumers can render a unified picture.
 */

export type CreditKind =
  | "chat"
  | "completion"
  | "embedding"
  | "image"
  | "tts"
  | "stt"
  | "tool-call"
  | "other";

export type AgentBackend =
  | "claude-code"
  | "opencode"
  | "codex"
  | "gemini"
  | "grok"
  | "ollama-local"
  | "ollama-cloud"
  | "direct-api"
  | "mcp"
  | "gateway"
  | "unknown";

export interface CostBreakdown {
  inputUsd?: number;
  outputUsd?: number;
  cacheReadUsd?: number;
  cacheWriteUsd?: number;
  audioUsd?: number;
  imageUsd?: number;
  other?: Record<string, number>;
}

/** One persisted ledger row. */
export interface CreditEntry {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  kind: CreditKind;
  agentBackend: AgentBackend;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costBreakdown?: CostBreakdown;
  /** Provider-side request id when available (e.g. Anthropic `msg_...`). */
  requestId?: string;
  /** InfiniBot session key (channel:user:thread). */
  sessionKey?: string;
  taskId?: string;
  projectId?: string;
  businessId?: string;
  contextId?: string;
  workflowId?: string;
  cronId?: string;
  agentId?: string;
  autonomous: boolean;
  latencyMs?: number;
  success: boolean;
  errorKind?: string;
}

/** Context attached when recording — everything except the raw usage figures. */
export interface CreditContext {
  provider?: string;
  model?: string;
  kind?: CreditKind;
  agentBackend?: AgentBackend;
  sessionKey?: string;
  taskId?: string;
  projectId?: string;
  businessId?: string;
  contextId?: string;
  workflowId?: string;
  cronId?: string;
  agentId?: string;
  autonomous?: boolean;
  latencyMs?: number;
  success?: boolean;
  errorKind?: string;
  requestId?: string;
}

/** Raw usage figures as reported by the upstream SDK / CLI. */
export interface UsageFigures {
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ProviderCost {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requests: number;
}

export interface BackendCost {
  agentBackend: AgentBackend;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  requests: number;
}

export interface CreditAggregate {
  period: BillingPeriod;
  periodStart: number;
  periodEnd: number;
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  byProvider: ProviderCost[];
  byBackend: BackendCost[];
  byModel: Array<{
    provider: string;
    model: string;
    tokens: number;
    costUsd: number;
    requests: number;
  }>;
  byProject: Array<{ projectId: string; tokens: number; costUsd: number; requests: number }>;
  bySession: Array<{ sessionKey: string; tokens: number; costUsd: number; requests: number }>;
  autonomousPercent: number;
}

export type BillingPeriod = "hour" | "day" | "week" | "month" | "all";

export type TimeseriesBucket = "minute" | "hour" | "day" | "week";

export interface TimeseriesPoint {
  bucketStart: number;
  series: Record<string, { tokens: number; costUsd: number; requests: number }>;
}

export type CreditSource =
  | "ledger.direct"
  | "ledger.adapter.api-monitor"
  | "ledger.adapter.budget"
  | "ledger.cli.transcript"
  | "ledger.sync.provider";

export interface CreditBudget {
  id: string;
  name: string;
  /** Filter axis: provider | agent_backend | project_id | session_key | "all" */
  scopeAxis: "provider" | "agent_backend" | "project_id" | "session_key" | "all";
  scopeValue?: string;
  monthlyLimitUsd: number;
  warnThresholdPct: number;
  hardThresholdPct: number;
  /** If true and hard threshold is crossed, the spawn-guard refuses new tasks on this scope until the next month. */
  blockOnHard: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreditBudgetStatus extends CreditBudget {
  monthKey: string;
  currentSpendUsd: number;
  pctUsed: number;
  state: "ok" | "warn" | "hard" | "exceeded";
  remainingUsd: number;
}

export interface ProviderSyncCursor {
  provider: string;
  lastSyncAt?: number;
  lastReconciledTotalUsd?: number;
  status: "configured" | "missing-credentials" | "unsupported" | "error" | "ok";
  message?: string;
}
