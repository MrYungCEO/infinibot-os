/**
 * User-facing classification of agent turns that fail before replying, plus
 * the once-per-session "model healed" notice. Shared by the auto-reply runner
 * (chat.send / channels) and the `agent` command so every chat surface gets
 * the same terminal error shape: lifecycle `error` → chat `{state:"error",
 * errorMessage, errorCode, errorHint}`.
 */

import type { InfinibotConfig } from "../config/config.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getCliProviderInfo } from "./cli-routing.js";
import { isUnsupportedAccountMessage, isUntrustedDirMessage } from "./cli-runner/stream.js";
import { isFailoverError } from "./failover-error.js";
import { suggestReplacementModel } from "./model-heal.js";
import { humanizeProviderError, type HumanizedErrorKind } from "./provider-error-messages.js";

export type AgentTurnFailure = {
  errorMessage: string;
  /** Stable machine code the UI can branch on (e.g. show a "switch model" action). */
  errorCode?:
    | "model_unavailable"
    | "no_credentials"
    | "context_overflow"
    | "rate_limit"
    | "billing"
    | "provider_unavailable"
    | "coder_missing"
    | "tool_unavailable"
    // Subscription CLI routing (cli-routing.ts): the UI shows one fix per code.
    | "subscription_limit"
    | "subscription_signed_out"
    | "subscription_missing"
    | "subscription_timeout"
    | "subscription_unsupported"
    | "subscription_plan"
    | "subscription_untrusted"
    | "subscription_failed";
  errorHint?: string;
  /** Subscription CLI routing: the CLI provider that failed last (e.g. "claude-cli"). */
  cliProvider?: string;
  /** For "model_unavailable": the nearest valid model the user can switch to. */
  suggestedModel?: string;
};

// "Unknown model: p/m" (not in the catalog) or "Model unavailable: p/m" (the
// provider rejected it as not found — see pi-embedded-runner/run.ts).
const UNKNOWN_MODEL_RE = /(?:Unknown model|Model unavailable):\s*([^\s()]+)/i;

export function describeAgentTurnFailure(
  err: unknown,
  opts: {
    cfg?: InfinibotConfig;
    agentDir?: string;
    /** Test seam; defaults to the self-heal candidate order. */
    suggest?: (provider: string, model: string) => string | undefined;
  } = {},
): AgentTurnFailure {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const errorMessage = raw.replace(/^(?:Failover)?Error:\s*/, "").trim() || "Agent failed";
  const unknownModel = UNKNOWN_MODEL_RE.exec(errorMessage);
  if (unknownModel) {
    const ref = unknownModel[1];
    const slash = ref.indexOf("/");
    let suggestedModel: string | undefined;
    if (slash > 0) {
      const provider = ref.slice(0, slash);
      const model = ref.slice(slash + 1);
      try {
        suggestedModel = opts.suggest
          ? opts.suggest(provider, model)
          : suggestReplacementModel({
              cfg: opts.cfg,
              agentDir: opts.agentDir,
              provider,
              model,
            });
      } catch {
        suggestedModel = undefined;
      }
    }
    return {
      errorMessage: `Model unavailable — ${ref} was not found by its provider (retired upstream or not in its catalog), and no other model with credentials could answer. Choose another model.`,
      errorCode: "model_unavailable",
      errorHint: suggestedModel
        ? `Closest available model: ${suggestedModel}. Pick it in the chat's model picker, or send /model ${suggestedModel}.`
        : "Switch model: pick another one in the chat's model picker (or send /model provider/model), or add a provider key in Setup › Quickstart.",
      ...(suggestedModel ? { suggestedModel } : {}),
    };
  }
  // Everything else: beginner-friendly wording. Prefer the provider's raw
  // payload + provider/model from the (possibly wrapped) FailoverError so
  // details like Gemini's retryDelay survive; the raw text stays in the logs
  // (callers log `err` before calling this).
  const failover = findFailoverError(err);
  if (failover?.provider && getCliProviderInfo(failover.provider)) {
    return describeCliTurnFailure(errorMessage, failover);
  }
  const h = humanizeProviderError(failover?.rawMessage || failover?.message || errorMessage, {
    provider: failover?.provider,
    model: failover?.model,
  });
  if (h.kind === "unknown" && !looksLikeProviderFailure(errorMessage, failover)) {
    // Not a provider error we recognise (e.g. an internal guard message that
    // is already plain English) — keep it, it's more specific than a generic line.
    return {
      errorMessage: errorMessage.length > 300 ? `${errorMessage.slice(0, 300)}…` : errorMessage,
    };
  }
  const errorCode = TURN_FAILURE_CODES[h.kind];
  return {
    errorMessage: h.message,
    errorHint: h.resolution,
    ...(errorCode ? { errorCode } : {}),
  };
}

const TURN_FAILURE_CODES: Partial<Record<HumanizedErrorKind, AgentTurnFailure["errorCode"]>> = {
  auth: "no_credentials",
  context_overflow: "context_overflow",
  rate_limit: "rate_limit",
  billing: "billing",
  transient: "provider_unavailable",
  model_not_found: "model_unavailable",
  coder_missing: "coder_missing",
  tool_unavailable: "tool_unavailable",
};

/**
 * A turn routed through subscription CLIs failed. runCliAgent already wrote
 * plain sentences ("Claude Code has hit your plan's usage limit…"); keep them,
 * dropping the "All models failed (n): provider/model: … (reason)" framing.
 */
function describeCliTurnFailure(
  errorMessage: string,
  failover: NonNullable<ReturnType<typeof findFailoverError>>,
): AgentTurnFailure {
  const parts = errorMessage.startsWith("All models failed")
    ? errorMessage
        .replace(/^All models failed \(\d+\):\s*/, "")
        .split(" | ")
        .map((p) =>
          p
            .replace(/^[\w.-]+\/[^:]+:\s*/, "")
            .replace(
              /\s*\((?:rate_limit|auth|timeout|unknown|billing|format|model_not_found)\)$/,
              "",
            ),
        )
    : [failover.message];
  const message = [...new Set(parts.map((p) => p.trim()).filter(Boolean))].join(" ");
  const last = failover.message;
  const errorCode: AgentTurnFailure["errorCode"] = isUnsupportedAccountMessage(last)
    ? "subscription_unsupported"
    : / couldn't be started on this computer\./.test(last)
      ? "subscription_missing"
      : / your plan doesn't include this\./.test(last)
        ? "subscription_plan"
        : isUntrustedDirMessage(last)
          ? "subscription_untrusted"
          : failover.reason === "rate_limit"
            ? "subscription_limit"
            : /isn't installed/.test(last)
              ? "subscription_missing"
              : failover.reason === "auth"
                ? "subscription_signed_out"
                : failover.reason === "timeout"
                  ? "subscription_timeout"
                  : "subscription_failed";
  const label = getCliProviderInfo(failover.provider ?? "")?.label ?? "your AI account";
  const errorHint =
    errorCode === "subscription_unsupported"
      ? "Add a Gemini API key in Setup, or pick another AI account."
      : errorCode === "subscription_plan"
        ? `Sign in to ${label} with an account whose plan includes it, or pick another AI account.`
        : errorCode === "subscription_untrusted"
          ? "Try again after updating InfiniBot."
          : errorCode === "subscription_limit"
            ? `Try again when the limit resets, or switch to another AI account you have.`
            : errorCode === "subscription_signed_out"
              ? `Sign in to ${label} again.`
              : errorCode === "subscription_missing"
                ? `Set up ${label} again from Setup › Coders.`
                : `Try again.`;
  return {
    errorMessage: message.length > 600 ? `${message.slice(0, 600)}…` : message,
    errorCode,
    errorHint,
    cliProvider: failover.provider,
  };
}

function findFailoverError(err: unknown) {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur; depth++) {
    if (isFailoverError(cur)) return cur;
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

function looksLikeProviderFailure(message: string, failover: unknown): boolean {
  return Boolean(failover) || /[{}]|^\d{3}\b|All models failed/.test(message);
}

const notifiedSessions = new Map<string, Set<string>>();

/**
 * Emit the "model X unavailable — using Y" notice to the UI at most once per
 * session per (from → to). Rides the agent event bus (stream "notice"), which
 * the gateway already broadcasts to every client.
 */
export function emitModelHealedNotice(params: {
  runId: string;
  sessionKey?: string;
  from: string;
  to: string;
  message: string;
}): boolean {
  const sessionId = params.sessionKey?.trim() || params.runId;
  const key = `${params.from}→${params.to}`;
  const seen = notifiedSessions.get(sessionId) ?? new Set<string>();
  if (seen.has(key)) return false;
  seen.add(key);
  notifiedSessions.set(sessionId, seen);
  emitAgentEvent({
    runId: params.runId,
    stream: "notice",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      kind: "model_fallback",
      level: "warning",
      from: params.from,
      to: params.to,
      message: params.message,
    },
  });
  return true;
}

/**
 * Secure Mode moved this run off a remote model onto a local one. Shown once
 * per session (per from→to pair) as "Secure Mode: using <model> (local)".
 */
export function emitSecureModelNotice(params: {
  runId: string;
  sessionKey?: string;
  from: string;
  to: string;
}): boolean {
  const sessionId = params.sessionKey?.trim() || params.runId;
  const key = `secure:${params.from}→${params.to}`;
  const seen = notifiedSessions.get(sessionId) ?? new Set<string>();
  if (seen.has(key)) return false;
  seen.add(key);
  notifiedSessions.set(sessionId, seen);
  emitAgentEvent({
    runId: params.runId,
    stream: "notice",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      kind: "secure_model",
      level: "info",
      from: params.from,
      to: params.to,
      message: `Secure Mode: using ${params.to} (local)`,
    },
  });
  return true;
}

/** Test-only. */
export function resetModelHealedNoticesForTest(): void {
  notifiedSessions.clear();
}
