/**
 * Bridge between the pi-ai embedded runner and the unified credit ledger.
 *
 * Each agent turn produces an `AssistantMessage` with a `usage` object of the
 * shape `{ input, output, cacheRead, cacheWrite, totalTokens, cost: {...} }`.
 * After a run completes, the runner calls `recordRunUsage(messagesSnapshot, ctx)`
 * which scans every assistant message and writes one ledger entry per turn.
 *
 * Best-effort: this never throws. A failure here cannot break an LLM call.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { recordCredit } from "../credits/recorder.js";
import type { AgentBackend, CreditContext } from "../credits/types.js";

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

interface AssistantLike {
  role?: string;
  usage?: PiUsage;
  model?: string;
  provider?: string;
  api?: string;
  timestamp?: number;
  /** Marker we attach after recording so the same message is not double-counted. */
  __creditsRecordedAt?: number;
}

export interface CreditsTraceContext extends CreditContext {
  /** Default provider when an assistant message lacks one. */
  provider?: string;
  /** Default model when an assistant message lacks one. */
  modelId?: string;
}

function looksLikeAssistantWithUsage(msg: unknown): msg is AssistantLike {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as AssistantLike;
  return m.role === "assistant" && !!m.usage && typeof m.usage === "object";
}

/** Map a pi-ai provider id to our AgentBackend taxonomy. */
function inferBackend(provider?: string): AgentBackend {
  if (!provider) return "direct-api";
  const p = provider.toLowerCase();
  if (p.startsWith("ollama")) return p.includes("cloud") ? "ollama-cloud" : "ollama-local";
  return "direct-api";
}

/**
 * Walk `messages` and record any not-yet-recorded assistant turn into the
 * credit ledger. Marks each message with `__creditsRecordedAt` so repeat
 * calls (the runner can invoke us multiple times across abort/retry) don't
 * double-count.
 */
export function recordRunUsage(
  messages: AgentMessage[] | undefined,
  ctx: CreditsTraceContext,
  error?: unknown,
): number {
  if (!messages || messages.length === 0) return 0;
  let recorded = 0;
  for (const raw of messages) {
    if (!looksLikeAssistantWithUsage(raw)) continue;
    const msg = raw as AssistantLike;
    if (msg.__creditsRecordedAt) continue;

    const usage = msg.usage ?? {};
    const provider = ctx.provider ?? msg.provider ?? "unknown";
    const model = ctx.modelId ?? msg.model ?? "unknown";
    const upstreamCost = usage.cost?.total;

    try {
      recordCredit({
        ...ctx,
        provider,
        model,
        usage: {
          tokensIn: Number(usage.input ?? 0),
          tokensOut: Number(usage.output ?? 0),
          cacheReadTokens: Number(usage.cacheRead ?? 0),
          cacheWriteTokens: Number(usage.cacheWrite ?? 0),
        },
        // Trust pi-ai's cost when it knows the model — fall back to our pricing table otherwise.
        costUsdOverride:
          typeof upstreamCost === "number" && upstreamCost > 0 ? upstreamCost : undefined,
        agentBackend: ctx.agentBackend ?? inferBackend(provider),
        success: !error,
        errorKind: error ? (error instanceof Error ? error.name : "error") : undefined,
        source: "ledger.direct",
      });
      msg.__creditsRecordedAt = Date.now();
      recorded += 1;
    } catch {
      /* swallow */
    }
  }
  return recorded;
}
