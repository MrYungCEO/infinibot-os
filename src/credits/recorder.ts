/**
 * Recording API. Every place that talks to an LLM should flow through one of
 * these helpers. All calls are best-effort and never throw — callers wrap
 * their own try/catch.
 */

import { randomUUID } from "node:crypto";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { priceUsd } from "./pricing.js";
import { getCreditStore } from "./store.js";
import type {
  AgentBackend,
  CreditContext,
  CreditEntry,
  CreditKind,
  CreditSource,
  UsageFigures,
} from "./types.js";

const log = createSubsystemLogger("credits");

type Listener = (entry: CreditEntry) => void;
const listeners = new Set<Listener>();

export function onCredit(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(entry: CreditEntry): void {
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch (e) {
      log.warn("credit-listener-error", { err: String(e) });
    }
  }
}

export interface RecordCreditInput extends CreditContext {
  provider: string;
  model: string;
  usage?: UsageFigures;
  costUsdOverride?: number;
  source?: CreditSource;
}

/**
 * Low-level recorder. Returns the persisted entry or null if recording
 * silently failed (logged but never thrown).
 */
export function recordCredit(input: RecordCreditInput): CreditEntry | null {
  try {
    const usage: UsageFigures = {
      tokensIn: input.usage?.tokensIn ?? 0,
      tokensOut: input.usage?.tokensOut ?? 0,
      cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: input.usage?.cacheWriteTokens ?? 0,
    };

    const priced = priceUsd(input.model, usage, input.provider);
    const cost = input.costUsdOverride ?? priced.costUsd;

    const entry: CreditEntry = {
      id: `cr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      timestamp: Date.now(),
      provider: input.provider || "unknown",
      model: input.model || "unknown",
      kind: input.kind ?? "chat",
      agentBackend: input.agentBackend ?? "unknown",
      tokensIn: usage.tokensIn ?? 0,
      tokensOut: usage.tokensOut ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      costUsd: cost,
      costBreakdown: priced.breakdown,
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      taskId: input.taskId,
      projectId: input.projectId,
      businessId: input.businessId,
      contextId: input.contextId,
      workflowId: input.workflowId,
      cronId: input.cronId,
      agentId: input.agentId,
      autonomous: input.autonomous ?? false,
      latencyMs: input.latencyMs,
      success: input.success ?? true,
      errorKind: input.errorKind,
    };

    getCreditStore().insert(entry, input.source ?? "ledger.direct");
    emit(entry);
    return entry;
  } catch (e) {
    log.warn("recordCredit failed", { err: String(e) });
    return null;
  }
}

// ── Provider-specific adapters ────────────────────────────────

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicLikeResponse {
  id?: string;
  model?: string;
  usage?: AnthropicUsage;
}

export function recordFromAnthropicResponse(
  res: AnthropicLikeResponse | null | undefined,
  ctx: CreditContext & { model?: string; provider?: string },
): CreditEntry | null {
  if (!res) return null;
  const usage: UsageFigures = {
    tokensIn: res.usage?.input_tokens ?? 0,
    tokensOut: res.usage?.output_tokens ?? 0,
    cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage?.cache_creation_input_tokens ?? 0,
  };
  return recordCredit({
    ...ctx,
    provider: ctx.provider ?? "anthropic",
    model: ctx.model ?? res.model ?? "unknown",
    usage,
    requestId: res.id,
  });
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAILikeResponse {
  id?: string;
  model?: string;
  usage?: OpenAIUsage;
}

export function recordFromOpenAIResponse(
  res: OpenAILikeResponse | null | undefined,
  ctx: CreditContext & { model?: string; provider?: string },
): CreditEntry | null {
  if (!res) return null;
  const usage: UsageFigures = {
    tokensIn: res.usage?.prompt_tokens ?? 0,
    tokensOut: res.usage?.completion_tokens ?? 0,
    cacheReadTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
  return recordCredit({
    ...ctx,
    provider: ctx.provider ?? "openai",
    model: ctx.model ?? res.model ?? "unknown",
    usage,
    requestId: res.id,
  });
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiLikeResponse {
  responseId?: string;
  modelVersion?: string;
  usageMetadata?: GeminiUsageMetadata;
}

export function recordFromGeminiResponse(
  res: GeminiLikeResponse | null | undefined,
  ctx: CreditContext & { model?: string; provider?: string },
): CreditEntry | null {
  if (!res) return null;
  const usage: UsageFigures = {
    tokensIn: res.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: res.usageMetadata?.candidatesTokenCount ?? 0,
    cacheReadTokens: res.usageMetadata?.cachedContentTokenCount ?? 0,
  };
  return recordCredit({
    ...ctx,
    provider: ctx.provider ?? "google",
    model: ctx.model ?? res.modelVersion ?? "unknown",
    usage,
    requestId: res.responseId,
  });
}

interface OllamaResponse {
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export function recordFromOllamaResponse(
  res: OllamaResponse | null | undefined,
  ctx: CreditContext & { model?: string; provider?: string; isCloud?: boolean },
): CreditEntry | null {
  if (!res) return null;
  const usage: UsageFigures = {
    tokensIn: res.prompt_eval_count ?? 0,
    tokensOut: res.eval_count ?? 0,
  };
  return recordCredit({
    ...ctx,
    provider: ctx.provider ?? (ctx.isCloud ? "ollama-cloud" : "ollama-local"),
    model: ctx.model ?? res.model ?? "unknown",
    usage,
    agentBackend: ctx.agentBackend ?? (ctx.isCloud ? "ollama-cloud" : "ollama-local"),
  });
}

// ── CLI transcript adapters ────────────────────────────────────

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * opencode usage JSON. Shapes drift between CLI releases, so be tolerant:
 *   - legacy (≤ ~1.15):  `{ usage: { input, output, cacheRead, cacheWrite }, model, provider }`
 *   - current (1.17.x):  `{ type: "step_finish", part: { tokens: { input, output, reasoning,
 *                          cache: { read, write } }, cost, providerID, modelID } }`
 * Either shape (or `tokens`/`cost` hoisted to the top level) is accepted. The
 * current CLI reports a per-step `cost` in USD which we use directly rather
 * than re-pricing. Returns null when no usable token figures are present.
 */
interface OpencodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cache?: { read?: number; write?: number };
}
interface OpencodePart {
  tokens?: OpencodeTokens;
  cost?: number;
  providerID?: string;
  modelID?: string;
}
export function recordFromOpencodeJSON(
  json: {
    type?: string;
    model?: string;
    provider?: string;
    providerID?: string;
    modelID?: string;
    cost?: number;
    usage?: OpencodeTokens;
    tokens?: OpencodeTokens;
    part?: OpencodePart;
  } | null,
  ctx: CreditContext,
): CreditEntry | null {
  if (!json) return null;
  // Token figures may live at .usage (legacy), .tokens, or .part.tokens (current).
  const tok = json.usage ?? json.tokens ?? json.part?.tokens;
  if (!tok) return null;

  const cacheRead = num(tok.cacheRead) || num(tok.cache?.read);
  const cacheWrite = num(tok.cacheWrite) || num(tok.cache?.write);
  // reasoning tokens are billed as output; fold them in for display + pricing.
  const tokensOut = num(tok.output) + num(tok.reasoning);

  // The current CLI gives us an authoritative per-step cost — prefer it over
  // re-pricing (which needs a model we often can't see in the stream).
  const cliCost = typeof json.cost === "number" ? json.cost : json.part?.cost;
  const costUsdOverride =
    typeof cliCost === "number" && Number.isFinite(cliCost) ? cliCost : undefined;

  return recordCredit({
    ...ctx,
    agentBackend: ctx.agentBackend ?? "opencode",
    provider:
      json.provider ?? json.providerID ?? json.part?.providerID ?? ctx.provider ?? "opencode",
    model: json.model ?? json.modelID ?? json.part?.modelID ?? ctx.model ?? "unknown",
    usage: {
      tokensIn: num(tok.input),
      tokensOut,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
    costUsdOverride,
    source: "ledger.cli.transcript",
  });
}

/**
 * codex usage events. Shapes drift between CLI releases, so accept both:
 *   - legacy:           `{ type: "token_count", info: { input_tokens, output_tokens,
 *                          cached_input_tokens, model } }`
 *   - current (0.137):  `{ type: "turn.completed", usage: { input_tokens, cached_input_tokens,
 *                          output_tokens, reasoning_output_tokens } }`
 * Returns null for any other event type or when no usage block is present.
 */
interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  model?: string;
}
export function recordFromCodexJSON(
  json: {
    type?: string;
    info?: CodexUsage;
    usage?: CodexUsage;
    model?: string;
  } | null,
  ctx: CreditContext,
): CreditEntry | null {
  if (!json) return null;
  // legacy carried usage under `.info` on a "token_count" event; current carries
  // it under `.usage` on a "turn.completed" event. Accept either container.
  const usage =
    json.type === "token_count"
      ? json.info
      : json.type === "turn.completed"
        ? json.usage
        : (json.usage ?? json.info);
  if (!usage) return null;

  // OpenAI/codex usage accounting (Responses API semantics, verified against
  // codex-cli 0.137 `turn.completed` events):
  //   • `output_tokens` ALREADY INCLUDES `reasoning_output_tokens` — reasoning
  //     is an informational subset of output, not an additional bucket. Adding
  //     them double-counted reasoning (e.g. a "say hello" turn reported
  //     output=41/reasoning=34 → we logged 75). Use output_tokens as-is.
  //   • `input_tokens` already INCLUDES `cached_input_tokens`; we keep the full
  //     input here and pass the cached subset separately so pricing.ts can back
  //     it out (it subtracts cacheRead from tokensIn before charging).
  const outputTokens = num(usage.output_tokens);
  const reasoningTokens = num(usage.reasoning_output_tokens);
  // Defensive: only some legacy shapes reported output EXCLUSIVE of reasoning.
  // If output is plausibly missing the reasoning slice (output < reasoning),
  // fall back to the sum so we never under-count.
  const tokensOut = outputTokens >= reasoningTokens ? outputTokens : outputTokens + reasoningTokens;

  return recordCredit({
    ...ctx,
    agentBackend: ctx.agentBackend ?? "codex",
    provider: ctx.provider ?? "openai",
    model: usage.model ?? json.model ?? ctx.model ?? "unknown",
    usage: {
      tokensIn: num(usage.input_tokens),
      tokensOut,
      cacheReadTokens: num(usage.cached_input_tokens),
    },
    source: "ledger.cli.transcript",
  });
}

/**
 * Claude Code stream-json transcript: each message has
 * `{ message: { usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } } }`.
 * The CLI also writes the same shape to `~/.claude/projects/.../*.jsonl` per session.
 */
export function recordFromClaudeCodeTranscript(
  obj: { message?: { id?: string; model?: string; usage?: AnthropicUsage } } | null,
  ctx: CreditContext,
): CreditEntry | null {
  if (!obj?.message?.usage) return null;
  return recordFromAnthropicResponse(
    { id: obj.message.id, model: obj.message.model, usage: obj.message.usage },
    {
      ...ctx,
      agentBackend: ctx.agentBackend ?? "claude-code",
      provider: ctx.provider ?? "anthropic",
    },
  );
}

// ── Compatibility shim for legacy api-monitor callers ──────────

export function recordLegacyApiUsage(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  opts: {
    sessionKey?: string;
    taskId?: string;
    autonomous?: boolean;
    agentBackend?: AgentBackend;
    kind?: CreditKind;
  } = {},
): CreditEntry | null {
  return recordCredit({
    provider,
    model,
    usage: { tokensIn, tokensOut },
    costUsdOverride: costUsd,
    sessionKey: opts.sessionKey,
    taskId: opts.taskId,
    autonomous: opts.autonomous,
    agentBackend: opts.agentBackend ?? "gateway",
    kind: opts.kind,
    source: "ledger.adapter.api-monitor",
  });
}

export function recordLegacyBudgetEntry(entry: {
  provider: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  agentId: string;
  sessionKey?: string;
  timestamp?: number;
}): CreditEntry | null {
  return recordCredit({
    provider: entry.provider,
    model: entry.model ?? "unknown",
    usage: { tokensIn: entry.tokensIn, tokensOut: entry.tokensOut },
    costUsdOverride: entry.costUsd,
    agentId: entry.agentId,
    sessionKey: entry.sessionKey,
    source: "ledger.adapter.budget",
  });
}
