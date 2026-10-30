/**
 * Beginner-friendly wording for provider (LLM API) and tool failures.
 *
 * Every chat surface — webchat, classic chat, channels, voice — should show
 * `formatHumanizedError(humanizeProviderError(err))` instead of the raw
 * provider payload. The raw error belongs in the gateway logs only.
 *
 * Classification is by signal (HTTP status, error code/status fields, common
 * phrases), so it works across Google/Gemini, OpenAI, OpenRouter, Anthropic,
 * Groq, xAI, Mistral, Ollama… without per-provider string tables.
 *
 * Pure module: no node imports, so the control UI can use it too.
 */

import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isContextOverflowError,
  isModelNotFoundErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
} from "./pi-embedded-helpers/error-classify.js";
import { toText } from "../utils/to-text.js";

export type HumanizedErrorKind =
  | "rate_limit"
  | "auth"
  | "billing"
  | "model_not_found"
  | "context_overflow"
  | "transient"
  | "tool_unavailable"
  | "coder_missing"
  | "local_runtime"
  | "unknown";

export type HumanizedError = {
  kind: HumanizedErrorKind;
  /** Short label, e.g. "Rate limit reached". */
  title: string;
  /** One or two plain sentences on what happened. Never contains raw JSON. */
  message: string;
  /** What the user can do about it. */
  resolution: string;
  /** Provider-suggested wait before retrying, when the error carried one. */
  retryAfterMs?: number;
  severity: "info" | "warning" | "error";
};

export type HumanizeContext = { provider?: string; model?: string };

// ── Provider naming ─────────────────────────────────────────────────────────

const PROVIDER_LABELS: Array<[RegExp, string, string]> = [
  // [provider id match, display name, what to call its key]
  [/google|gemini|vertex|antigravity/i, "Gemini", "Google AI key"],
  [/openrouter/i, "OpenRouter", "OpenRouter key"],
  [/openai|codex/i, "OpenAI", "OpenAI key"],
  [/anthropic|claude/i, "Anthropic", "Anthropic key"],
  [/groq/i, "Groq", "Groq key"],
  [/xai|grok/i, "xAI", "xAI key"],
  [/mistral/i, "Mistral", "Mistral key"],
  [/deepseek/i, "DeepSeek", "DeepSeek key"],
  [/together/i, "Together AI", "Together AI key"],
  [/fireworks/i, "Fireworks", "Fireworks key"],
  [/cerebras/i, "Cerebras", "Cerebras key"],
  [/ollama/i, "Ollama", "Ollama setup"],
  [/minimax/i, "MiniMax", "MiniMax key"],
  [/moonshot|kimi/i, "Moonshot", "Moonshot key"],
  [/zai|zhipu|glm/i, "Z.ai", "Z.ai key"],
  [/bedrock|amazon/i, "AWS Bedrock", "AWS credentials"],
  [/azure/i, "Azure OpenAI", "Azure key"],
];

/** Fingerprints in the raw error that identify the provider when ctx doesn't. */
const PROVIDER_FINGERPRINTS: Array<[RegExp, string]> = [
  [
    /generativelanguage\.googleapis|type\.googleapis\.com\/google\.rpc|RESOURCE_EXHAUSTED|aistudio\.google|ai\.google\.dev/i,
    "google",
  ],
  [/openrouter/i, "openrouter"],
  [/platform\.openai\.com|insufficient_quota/i, "openai"],
  [/anthropic|not_found_error|overloaded_error|credit balance is too low/i, "anthropic"],
  [/groq/i, "groq"],
];

function resolveProvider(ctx: HumanizeContext | undefined, raw: string) {
  const id = ctx?.provider?.trim() || PROVIDER_FINGERPRINTS.find(([re]) => re.test(raw))?.[1] || "";
  const hit = id ? PROVIDER_LABELS.find(([re]) => re.test(id)) : undefined;
  const name = hit?.[1] ?? (id ? id : "the AI provider");
  return {
    name,
    /** For "your …": "your OpenAI account" / "your AI provider account". */
    owner: id ? name : "AI provider",
    keyName: hit?.[2] ?? (id ? `${id} key` : "API key"),
    known: Boolean(id),
  };
}

// ── Raw error extraction ────────────────────────────────────────────────────

type Extracted = {
  raw: string;
  status?: number;
  /** Provider code/status/type strings, lowercased (e.g. "resource_exhausted"). */
  codes: string[];
  /** Best human sentence inside the payload, if any. */
  innerMessage?: string;
  json?: unknown;
};

function rawText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? ` (cause: ${cause.message})` : "";
    return `${err.message}${causeText}`;
  }
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    if (typeof rec.errorMessage === "string") return rec.errorMessage;
    if (typeof rec.message === "string") return rec.message;
    try {
      return JSON.stringify(err);
    } catch {
      return toText(err);
    }
  }
  return err == null ? "" : toText(err);
}

function tryParseJsonBlob(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function asStatus(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

function extract(err: unknown): Extracted {
  const raw = rawText(err).trim();
  const codes: string[] = [];
  let status: number | undefined;
  let innerMessage: string | undefined;

  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    status = asStatus(rec.status) ?? asStatus(rec.statusCode);
    if (typeof rec.code === "string") codes.push(rec.code.toLowerCase());
    else status ??= asStatus(rec.code);
  }

  const json = tryParseJsonBlob(raw);
  if (json && typeof json === "object") {
    const top = json as Record<string, unknown>;
    const inner =
      top.error && typeof top.error === "object" ? (top.error as Record<string, unknown>) : top;
    status ??= asStatus(inner.code) ?? asStatus(inner.status) ?? asStatus(top.status);
    for (const v of [inner.status, inner.type, inner.code, top.type]) {
      if (typeof v === "string") codes.push(v.toLowerCase());
    }
    if (typeof inner.message === "string") innerMessage = inner.message;
    else if (typeof top.message === "string") innerMessage = top.message;
  }

  if (status === undefined) {
    const m =
      raw.match(/^(?:http\s*)?(\d{3})\b/i) ??
      raw.match(/\b(?:status(?:\s*code)?|http)\s*[:=]?\s*(\d{3})\b/i) ??
      raw.match(/"code"\s*:\s*(\d{3})\b/);
    status = asStatus(m?.[1]);
  }
  return { raw, status, codes, innerMessage, json };
}

// ── Retry delay ─────────────────────────────────────────────────────────────

function durationToMs(text: string): number | undefined {
  // "1m30.5s", "56s", "56.68s", "120ms", "2 minutes", "30 seconds"
  const t = text.trim().toLowerCase();
  const compound = t.match(/^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/);
  if (compound && (compound[1] || compound[2] || compound[3])) {
    return (
      (Number(compound[1] ?? 0) * 3600 + Number(compound[2] ?? 0) * 60 + Number(compound[3] ?? 0)) *
      1000
    );
  }
  const ms = t.match(/^(\d+(?:\.\d+)?)\s*ms$/);
  if (ms) return Number(ms[1]);
  const words = t.match(/^(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?)$/);
  if (words) {
    const n = Number(words[1]);
    const unit = words[2];
    if (unit.startsWith("h")) return n * 3_600_000;
    if (unit.startsWith("m")) return n * 60_000;
    return n * 1000;
  }
  return undefined;
}

/** Retry hint carried by the error: Gemini RetryInfo, "try again in Ns", Retry-After. */
export function extractRetryAfterMs(err: unknown): number | undefined {
  const raw = rawText(err);
  const candidates: number[] = [];
  const push = (v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v) && v > 0 && v < 24 * 3_600_000) candidates.push(v);
  };
  // Gemini: "retryDelay": "56s"
  for (const m of raw.matchAll(/retry_?delay\\?"?\s*[:=]\s*\\?"?([\dhms.]+)/gi)) {
    push(durationToMs(m[1]));
  }
  // OpenAI/Groq/Gemini prose: "Please try again in 7.66s" / "Please retry in 56.68s" / "in 2m30s"
  for (const m of raw.matchAll(
    /(?:try again|retry) in\s+(\d+(?:\.\d+)?\s*(?:ms|s|seconds?|secs?|minutes?|mins?|hours?)|(?:\d+h)?(?:\d+m)?\d+(?:\.\d+)?s)/gi,
  )) {
    push(durationToMs(m[1].replace(/\s+/g, " ")));
  }
  // Retry-After: 30
  const header = raw.match(/retry-after\\?"?\s*[:=]\s*\\?"?(\d+(?:\.\d+)?)/i);
  if (header) push(Number(header[1]) * 1000);
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    if (typeof rec.retryAfterMs === "number") push(rec.retryAfterMs);
  }
  return candidates.length ? Math.max(...candidates) : undefined;
}

function formatWait(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `~${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `~${m} min`;
  return `~${Math.ceil(m / 60)} h`;
}

// ── Gemini quota details ────────────────────────────────────────────────────

function describeQuota(raw: string): { freeTier: boolean; limit?: string } {
  const freeTier = /free[_ -]?tier/i.test(raw);
  const value =
    raw.match(/quota_?value\\?"?\s*[:=]\s*\\?"?(\d+)/i)?.[1] ?? raw.match(/limit:\s*(\d+)/i)?.[1];
  const quotaId = raw.match(/quota_?id\\?"?\s*[:=]\s*\\?"?([A-Za-z-]+)/i)?.[1] ?? "";
  const per = /PerMinute/i.test(quotaId)
    ? "min"
    : /PerDay/i.test(quotaId)
      ? "day"
      : /PerHour/i.test(quotaId)
        ? "hour"
        : undefined;
  const unit = /token/i.test(quotaId) ? "tokens" : "requests";
  return { freeTier, limit: value ? `${value} ${unit}${per ? `/${per}` : ""}` : undefined };
}

// ── Classification ──────────────────────────────────────────────────────────

const NETWORK_RE =
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|connection (?:error|reset|closed|refused)|terminated|stream (?:ended|closed) unexpectedly|bad gateway|service unavailable|gateway timeout|internal server error|upstream/i;
const LOCAL_RUNTIME_RE = /Couldn't start [^:]{1,80}: [^|]*/;
const UNKNOWN_TOOL_RE =
  /(?:unknown tool[:\s]+["'`]?([\w.-]+))|(?:tool\s+["'`]?([\w.-]+)["'`]?\s+(?:not found|is not available|does not exist))/i;
const CODER_MISSING_RE =
  /no coding agent|coder[_ ]not[_ ]installed|\b(?:process|backend|coder|cli|claude|opencode|codex)\b[^\n]{0,40}exit(?:ed)? with code 127\b|\b(?:claude|opencode|codex)(?::\s*command)?:? not found/i;
const NO_CREDENTIALS_RE =
  /no api key|no credential|missing api key|api key (?:is )?(?:missing|required|not set)/i;
const INSUFFICIENT_CREDIT_RE =
  /\b402\b|payment required|insufficient[_ ]credits?|credit balance|out of credits|requires more credits|add credits|billing (?:is )?(?:not active|inactive|required)|account is not active|billing_not_active|insufficient_quota/i;

function pickWait(retryAfterMs: number | undefined): string {
  return retryAfterMs ? `Try again in ${formatWait(retryAfterMs)}` : "Wait a minute and try again";
}

export function humanizeProviderError(err: unknown, ctx?: HumanizeContext): HumanizedError {
  const x = extract(err);
  const { raw, status, codes } = x;
  const p = resolveProvider(ctx, raw);
  const modelRef = ctx?.model?.trim();
  const has = (...c: string[]) => c.some((v) => codes.includes(v));

  // Tool-level failures first: they're not the provider's fault.
  if (CODER_MISSING_RE.test(raw)) return humanizeCoderMissing();
  // The local runtime manager couldn't bring the GPU runtime up (vLLM unit / Ollama).
  const localStart = raw.match(LOCAL_RUNTIME_RE);
  if (has("local_runtime_unavailable") || localStart) {
    const line = localStart?.[0] ?? raw;
    return {
      kind: "local_runtime",
      title: "Local model couldn't start",
      message: line.length > 300 ? `${line.slice(0, 300)}…` : line,
      resolution:
        "Check the GPU runtime widget in the model picker (Start/Stop), or pick another local model.",
      severity: "error",
    };
  }
  const unknownTool = raw.match(UNKNOWN_TOOL_RE);
  if (unknownTool && !/model/i.test(raw.slice(0, 40))) {
    return humanizeUnknownTool(unknownTool[1] ?? unknownTool[2]);
  }

  if (isContextOverflowError(raw) || has("context_length_exceeded", "request_too_large")) {
    return {
      kind: "context_overflow",
      title: "Conversation too long",
      message: `This conversation is too long for ${modelRef ? `the ${modelRef} model` : "that model"}.`,
      resolution: "Start a new chat (/new) or switch to a model with a larger context window.",
      severity: "warning",
    };
  }

  if (
    isModelNotFoundErrorMessage(raw) ||
    has("model_not_found") ||
    /^(?:unknown model|model unavailable):/i.test(raw)
  ) {
    return {
      kind: "model_not_found",
      title: "Model unavailable",
      message: `${modelRef ? `The model "${modelRef}"` : "That model"} isn't available${p.known ? ` on ${p.name}` : ""} — it may be retired or not enabled for your key.`,
      resolution: "Pick another model in the chat's model picker (or send /model provider/model).",
      severity: "warning",
    };
  }

  const isInsufficientQuota = has("insufficient_quota");
  if (status === 402 || (INSUFFICIENT_CREDIT_RE.test(raw) && !isGeminiQuota(raw, codes))) {
    return {
      kind: "billing",
      title: "Out of credit",
      message: isInsufficientQuota
        ? `Your ${p.owner} account has used up its quota.`
        : `Your ${p.owner} account is out of credit or billing isn't set up.`,
      resolution: `Add credit/billing to your ${p.owner} account, or switch to another model.`,
      severity: "error",
    };
  }

  if (
    status === 429 ||
    has("resource_exhausted", "rate_limit_exceeded", "rate_limit_error", "too_many_requests") ||
    isRateLimitErrorMessage(raw)
  ) {
    const retryAfterMs = extractRetryAfterMs(err);
    const quota = describeQuota(raw);
    const limit = quota.limit ? ` (${quota.limit})` : "";
    const tier = quota.freeTier ? "free-tier " : "";
    const billingTip = quota.freeTier
      ? `add billing to your ${p.keyName}`
      : `check your ${p.owner} plan`;
    return {
      kind: "rate_limit",
      title: "Rate limit reached",
      message: `${p.known ? `${p.name} ` : ""}${tier}rate limit reached${limit}.`.replace(
        /^r/,
        "R",
      ),
      resolution: `${pickWait(retryAfterMs)}, switch to another model, or ${billingTip}.`,
      ...(retryAfterMs ? { retryAfterMs } : {}),
      severity: "warning",
    };
  }

  if (isBillingErrorMessage(raw)) {
    return {
      kind: "billing",
      title: "Out of credit",
      message: `Your ${p.owner} account is out of credit or billing isn't set up.`,
      resolution: `Add credit/billing to your ${p.owner} account, or switch to another model.`,
      severity: "error",
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    has("unauthenticated", "permission_denied", "authentication_error", "invalid_api_key") ||
    NO_CREDENTIALS_RE.test(raw) ||
    isAuthErrorMessage(raw)
  ) {
    return {
      kind: "auth",
      title: "API key problem",
      message: `Your ${p.owner} API key is missing or invalid.`,
      resolution:
        "Add or fix it under Connect your AI (BYOK) — on a self-hosted install, Setup › Quickstart — or switch to a model you have a key for.",
      severity: "error",
    };
  }

  if (
    (status !== undefined && status >= 500) ||
    has("unavailable", "internal", "overloaded_error", "api_error", "deadline_exceeded") ||
    isOverloadedErrorMessage(raw) ||
    isTimeoutErrorMessage(raw) ||
    NETWORK_RE.test(raw)
  ) {
    const retryAfterMs = extractRetryAfterMs(err);
    return {
      kind: "transient",
      title: "Temporary connection issue",
      message: `Temporary connection issue with ${p.name}${/overload/i.test(raw) ? " (it's overloaded right now)" : ""}.`,
      resolution: `${retryAfterMs ? `Try again in ${formatWait(retryAfterMs)}` : "Try again in a moment"}, or switch to another model if it keeps happening.`,
      ...(retryAfterMs ? { retryAfterMs } : {}),
      severity: "warning",
    };
  }

  return {
    kind: "unknown",
    title: "Request failed",
    message: `${p.known ? p.name : "The AI provider"} couldn't complete that request${cleanDetail(x)}.`,
    resolution: "Try again or switch to another model. (Full details are in the gateway logs.)",
    severity: "error",
  };
}

function isGeminiQuota(raw: string, codes: string[]): boolean {
  // Gemini 429s say "check your plan and billing details" — that's a rate
  // limit with a billing tip, not an empty-wallet error.
  return codes.includes("resource_exhausted") || /RESOURCE_EXHAUSTED/.test(raw);
}

/** A short, JSON-free detail sentence, or "" when the raw text isn't presentable. */
function cleanDetail(x: Extracted): string {
  const candidate = (x.innerMessage ?? (x.json ? "" : x.raw))
    .replace(/^(?:error|api error|failovererror)[:\s-]+/i, "")
    .split(/\n/)[0]
    .trim();
  if (!candidate || candidate.length > 160 || /[{}[\]]|https?:\/\//.test(candidate)) return "";
  return `: ${candidate.replace(/[.\s]+$/, "")}`;
}

// ── Tool failures ───────────────────────────────────────────────────────────

/** True when a coder-run failure means "no coding CLI to run" (exit 127 / not installed). */
export function isCoderMissingError(text: string | undefined): boolean {
  return Boolean(text) && CODER_MISSING_RE.test(text as string);
}

export function humanizeCoderMissing(): HumanizedError {
  return {
    kind: "coder_missing",
    title: "No coding agent set up",
    message: "No coding agent is set up in this workspace yet.",
    resolution:
      "Connect one (Claude Code / OpenCode / Codex) under Settings → Connect your AI to run code tasks.",
    severity: "warning",
  };
}

export function humanizeUnknownTool(toolName?: string, available?: string[]): HumanizedError {
  const list = (available ?? []).filter(Boolean);
  const shown = list.slice(0, 25).join(", ");
  return {
    kind: "tool_unavailable",
    title: "Action not available",
    message: `That action${toolName ? ` (${toolName})` : ""} isn't available here.`,
    resolution: list.length
      ? `Use one of the available tools instead (${shown}${list.length > 25 ? ", …" : ""}), or tell the user plainly that this can't be done here.`
      : "Use one of the tools you actually have, or say plainly that this can't be done here.",
    severity: "info",
  };
}

/** True when the text is the pi-agent-core "Tool X not found" result. */
export function parseUnknownToolError(text: string): string | undefined {
  const m = text.trim().match(/^Tool\s+(\S+)\s+not found$/);
  return m?.[1];
}

/** One-line chat text: "⚠️ <message> <resolution>". */
export function formatHumanizedError(h: HumanizedError, opts?: { icon?: boolean }): string {
  const icon = opts?.icon === false ? "" : h.severity === "info" ? "ℹ️ " : "⚠️ ";
  return `${icon}${h.message} ${h.resolution}`.trim();
}

/** Convenience: humanize + format in one call. */
export function friendlyProviderErrorText(err: unknown, ctx?: HumanizeContext): string {
  return formatHumanizedError(humanizeProviderError(err, ctx));
}

/**
 * True when text is (or embeds) a raw provider payload — JSON error body,
 * "429 …" status line, or a Google RPC status — i.e. not fit to show as-is.
 */
export function looksLikeRawProviderError(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (/^(?:model error:\s*)?(?:http\s*)?[45]\d\d\b/i.test(t)) return true;
  if (/"error"\s*:|RESOURCE_EXHAUSTED|type\.googleapis\.com|"type"\s*:\s*"\w+_error"/.test(t))
    return true;
  const json = tryParseJsonBlob(t);
  return Boolean(json && typeof json === "object");
}

/** Plain (icon-less) friendly line for a raw error, for storing in payload fields. */
export function friendlyErrorLine(err: unknown, ctx?: HumanizeContext): string {
  return formatHumanizedError(humanizeProviderError(err, ctx), { icon: false });
}
