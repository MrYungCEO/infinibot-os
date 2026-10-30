/**
 * Provider-agnostic LLM runner for the Emails page.
 *
 * Picks the user's configured default model + provider via
 * `resolveConfiguredModelRef` (same resolver Sessions and Agents use), then
 * dispatches to:
 *
 *   - Anthropic SDK (provider="anthropic")
 *   - OpenAI-compatible chat-completions HTTP (provider="openai" |
 *     "openrouter" | anything else with a chat-completions endpoint)
 *
 * Used by `gmail.summarize` and `gmail.analyze`. Centralising it here so
 * both stay in lockstep with the user's current API provider rather than
 * being hardcoded to Anthropic.
 */

import { loadConfig } from "../../config/config.js";
import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { resolveConfiguredModelRef } from "../../agents/model-selection.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

interface RunLlmOptions {
  systemPrompt: string;
  userPrompt: string;
  /** Hard ceiling on response tokens; sent through as max_tokens. */
  maxTokens?: number;
  /** Optional temperature override. Defaults to 0.2 (deterministic). */
  temperature?: number;
  /** When true, ask OpenAI-compatible endpoints for JSON. */
  jsonMode?: boolean;
  /**
   * Force a specific model id. Honored when the resolved provider is
   * "anthropic", or when an explicit `provider` is also passed. Callers use
   * this to pin a cheap model (e.g. Haiku) for high-frequency, low-stakes
   * passes.
   */
  model?: string;
  /**
   * Force a specific provider, bypassing the user's configured default. Used
   * by oversight grading to route to a reliable cheap model (Anthropic Haiku)
   * even when the default provider is a local/broken endpoint. The caller is
   * responsible for confirming a key exists for it.
   */
  provider?: string;
}

interface RunLlmResult {
  text: string;
  provider: string;
  model: string;
}

/**
 * Resolve the active provider+model pair from config, falling back to
 * anthropic/claude-haiku when no defaults are set.
 */
export function getActiveLLM(): { provider: string; model: string } {
  try {
    const cfg = loadConfig();
    const ref = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    return { provider: ref.provider, model: ref.model };
  } catch {
    return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
  }
}

export async function runLLM(options: RunLlmOptions): Promise<RunLlmResult> {
  const active = getActiveLLM();
  // An explicit provider override (e.g. oversight grading pinning Anthropic)
  // bypasses the user's default; otherwise use the configured default.
  const provider = options.provider || active.provider;
  // Honor a caller-pinned model when the provider is Anthropic or was itself
  // explicitly pinned (a foreign model id sent to the wrong provider would 400).
  const model =
    options.model && (provider === "anthropic" || options.provider) ? options.model : active.model;
  const cfg = loadConfig();
  const auth = await resolveApiKeyForProvider({ provider, cfg });
  const apiKey = auth.apiKey;
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${provider}". Set one under apikeys settings.`,
    );
  }

  if (provider === "anthropic") {
    return runAnthropic({ ...options, apiKey, model });
  }
  // Everything else (openai, openrouter, fireworks, deepseek, groq, …)
  // speaks the OpenAI chat-completions wire format.
  return runOpenAICompat({ ...options, apiKey, model, provider });
}

async function runAnthropic(
  opts: RunLlmOptions & { apiKey: string; model: string },
): Promise<RunLlmResult> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: opts.apiKey });
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 800,
    temperature: opts.temperature ?? 0.2,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userPrompt.slice(0, 16_000) }],
  });
  const part = response.content[0];
  const text = part && part.type === "text" ? part.text : "";
  return { text, provider: "anthropic", model: opts.model };
}

function baseUrlForProvider(provider: string, cfg: ReturnType<typeof loadConfig>): string {
  const fromCfg = (
    cfg.models?.providers as Record<string, { baseUrl?: string } | undefined> | undefined
  )?.[provider]?.baseUrl;
  if (fromCfg) return fromCfg.replace(/\/+$/, "");
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "groq":
      return "https://api.groq.com/openai/v1";
    case "fireworks":
      return "https://api.fireworks.ai/inference/v1";
    case "together":
      return "https://api.together.xyz/v1";
    case "mistral":
      return "https://api.mistral.ai/v1";
    case "xai":
      return "https://api.x.ai/v1";
    default:
      return "https://api.openai.com/v1";
  }
}

async function runOpenAICompat(
  opts: RunLlmOptions & { apiKey: string; model: string; provider: string },
): Promise<RunLlmResult> {
  const cfg = loadConfig();
  const url = `${baseUrlForProvider(opts.provider, cfg)}/chat/completions`;
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 800,
    temperature: opts.temperature ?? 0.2,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt.slice(0, 16_000) },
    ],
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
  };
  if (opts.provider === "openrouter") headers["X-Title"] = "InfiniBot Emails";

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${opts.provider} (${res.status}): ${errText.slice(0, 400)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? "";
  return { text, provider: opts.provider, model: opts.model };
}

// ============================================================
// Email summarization
// ============================================================

export async function summarizeEmail(
  text: string,
): Promise<{ summary: string; actions: string[]; provider: string; model: string }> {
  const result = await runLLM({
    systemPrompt:
      "You are an email triage assistant. For the email provided, output a concise plain-text summary (2-3 sentences) followed by a 'Actions:' line listing 0-5 action items as a bulleted list. Be brief and direct. No preamble.",
    userPrompt: text,
    maxTokens: 600,
  });
  const out = result.text;
  const actionsIdx = out.search(/^Actions?:/im);
  const summary = (actionsIdx >= 0 ? out.slice(0, actionsIdx) : out).trim();
  const actions: string[] = [];
  if (actionsIdx >= 0) {
    const section = out.slice(actionsIdx).split("\n").slice(1);
    for (const line of section) {
      const m = line.match(/^\s*[-*•]\s*(.+)$/);
      if (m) actions.push(m[1].trim());
    }
  }
  return { summary, actions, provider: result.provider, model: result.model };
}

// ============================================================
// Structured email analysis
// ============================================================

export interface EmailAnalysis {
  /** 0-100 importance score, where 100 = drop everything and read. */
  importance: number;
  /** Short tag describing why ("invoice", "client-question", "newsletter", "calendar", "promotional", ...). */
  category: string;
  /** "negative" | "neutral" | "positive" | "urgent" */
  tone: string;
  /** Whether the email needs a reply/action from the user. */
  actionRequired: boolean;
  /** Time sensitivity in hours (0 = immediate, 24 = today, 168 = this week, null = none). */
  deadlineHours: number | null;
  /** One-paragraph rationale. */
  summary: string;
  /** Suggested concrete next actions (1-4 items). */
  suggestedActions: string[];
  /** People referenced in the message (names or emails). */
  mentions: string[];
  /** What provider/model produced this analysis. */
  provider: string;
  model: string;
}

const ANALYSIS_SYSTEM = `You are an email importance analyst. Read the email and return a single JSON object describing it. Schema:

{
  "importance": number 0-100,
  "category": string (one of: invoice, client-question, lead, contract, calendar, internal, newsletter, promotional, notification, personal, security, other),
  "tone": "negative" | "neutral" | "positive" | "urgent",
  "actionRequired": boolean,
  "deadlineHours": number | null,
  "summary": string (≤ 2 sentences),
  "suggestedActions": string[] (1-4 short imperative phrases),
  "mentions": string[]
}

Rules:
- Importance reflects the user's interest, not the sender's. Promotional/newsletter = 0-20. Routine notifications = 20-40. Client questions/invoices/calendar = 50-80. Security alerts / contract deadlines / direct asks from named people = 80-100.
- "deadlineHours" should be null when no time pressure exists.
- Respond with ONLY the JSON object — no markdown fences, no preamble.`;

export async function analyzeEmail(text: string): Promise<EmailAnalysis> {
  const result = await runLLM({
    systemPrompt: ANALYSIS_SYSTEM,
    userPrompt: text,
    maxTokens: 600,
    temperature: 0.1,
    jsonMode: true,
  });
  const json = extractJsonObject(result.text);
  if (!json) {
    throw new Error("Model did not return parseable JSON.");
  }
  return {
    importance: clampNumber(json.importance, 0, 100, 0),
    category: typeof json.category === "string" ? json.category : "other",
    tone: typeof json.tone === "string" ? json.tone : "neutral",
    actionRequired: Boolean(json.actionRequired),
    deadlineHours: typeof json.deadlineHours === "number" ? json.deadlineHours : null,
    summary: typeof json.summary === "string" ? json.summary : "",
    suggestedActions: Array.isArray(json.suggestedActions)
      ? json.suggestedActions.filter((s): s is string => typeof s === "string").slice(0, 6)
      : [],
    mentions: Array.isArray(json.mentions)
      ? json.mentions.filter((s): s is string => typeof s === "string").slice(0, 10)
      : [],
    provider: result.provider,
    model: result.model,
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  // Tolerant parser — strips ```json fences, then locates the first {…}.
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      /* */
    }
  }
  return null;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}
