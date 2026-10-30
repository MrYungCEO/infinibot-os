/**
 * Judge model chain — which model answers verification reviews, goal-judge
 * verdicts and visual assessments.
 *
 * The judge used to be hard-wired to anthropic/claude-haiku-4-5. On installs
 * without an Anthropic key every API call failed, the Claude Code CLI fallback
 * timed out under load, and runs ended UNVERIFIED with "LLM reviewer
 * unavailable" even when their evidence was fine. The chain below uses what
 * the install actually has, in this order:
 *
 *   1. env ANTHROPIC_GOAL_JUDGE_MODEL / INFINIBOT_JUDGE_MODEL (`provider/model`
 *      or a bare Anthropic id)
 *   2. config `verification.judgeModel` + `verification.judgeFallbacks`
 *   3. the agent default model (`agents.defaults.model.primary` + fallbacks)
 *   4. the first model of every custom provider in `models.providers`, then a
 *      cheap default for well-known providers (anthropic, openai, openrouter,
 *      google) — each only if a credential resolves at call time
 *   5. logged-in CLIs: Claude Code (OAuth), Codex, OpenCode
 *
 * Every failed attempt is logged with provider/model and the error, and the
 * judge that answered is returned so reviews can record it.
 */

import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";

import type { InfinibotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CliPlannerBackend } from "./cli-planner.js";

const log = createSubsystemLogger("autonomy.judge");

export type JudgeCandidate =
  | { kind: "api"; provider: string; model: string; source: string }
  | { kind: "cli"; backend: CliPlannerBackend; source: "cli" };

export interface JudgeChainInput {
  system: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Images (PNG/JPEG) to attach — vision assessment. Absolute paths. */
  imagePaths?: string[];
  /**
   * Accept a non-empty answer (e.g. it parses as the expected JSON). A
   * rejected answer is logged as a failure and the next judge is tried.
   */
  accept?: (text: string) => boolean;
}

export interface JudgeAttemptFailure {
  judge: string;
  error: string;
}

export interface JudgeChainResult {
  text: string;
  /** `provider/model` or `cli:<backend>` that answered; null when none did. */
  judge: string | null;
  failures: JudgeAttemptFailure[];
}

export interface JudgeChainDeps {
  cfg?: InfinibotConfig;
  env?: NodeJS.ProcessEnv;
  candidates?: JudgeCandidate[];
  callApi?: (c: Extract<JudgeCandidate, { kind: "api" }>, input: JudgeCallInput) => Promise<string>;
  callCli?: (c: Extract<JudgeCandidate, { kind: "cli" }>, input: JudgeCallInput) => Promise<string>;
  cliAvailable?: (backend: CliPlannerBackend) => boolean | Promise<boolean>;
}

export interface JudgeCallInput extends JudgeChainInput {
  timeoutMs: number;
}

/** Cheap default per well-known provider, used only when that provider has a key. */
const KNOWN_PROVIDER_DEFAULTS: Array<[string, string]> = [
  ["anthropic", "claude-haiku-4-5"],
  ["openai", "gpt-4.1-mini"],
  ["openrouter", "openai/gpt-4.1-mini"],
  ["google", "gemini-2.5-flash"],
];

const DEFAULT_API_TIMEOUT_MS = 90_000;
const DEFAULT_CLI_TIMEOUT_MS = 180_000;
/** Reasoning models spend the budget thinking — give them room to answer. */
const REASONING_MIN_TOKENS = 4096;
const MAX_TOKENS_CAP = 16_000;
/** Config-type failures (no key, unknown model) are not retried for this long. */
const NEGATIVE_CACHE_MS = 5 * 60_000;

// OAuth token inference requires the "Claude Code" identity prefix.
export const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

const negativeCache = new Map<string, { until: number; error: string }>();

export function resetJudgeCachesForTests(): void {
  negativeCache.clear();
}

function readJudgeConfig(cfg: InfinibotConfig | undefined): {
  judgeModel?: string;
  judgeFallbacks?: string[];
  judgeTimeoutMs?: number;
} {
  const v = (cfg as { verification?: Record<string, unknown> } | undefined)?.verification;
  if (!v || typeof v !== "object") return {};
  return {
    judgeModel: typeof v.judgeModel === "string" ? v.judgeModel : undefined,
    judgeFallbacks: Array.isArray(v.judgeFallbacks)
      ? v.judgeFallbacks.filter((x): x is string => typeof x === "string")
      : undefined,
    judgeTimeoutMs: typeof v.judgeTimeoutMs === "number" ? v.judgeTimeoutMs : undefined,
  };
}

/** `provider/model` → parts; a bare id means `defaultProvider`. Aliases resolve via agents.defaults.models. */
function parseRef(
  raw: string,
  defaultProvider: string,
  cfg: InfinibotConfig | undefined,
): { provider: string; model: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("/") && cfg) {
    const models = cfg.agents?.defaults?.models ?? {};
    for (const [key, entry] of Object.entries(models)) {
      const alias = (entry as { alias?: string } | undefined)?.alias?.trim().toLowerCase();
      if (alias && alias === trimmed.toLowerCase() && key.includes("/")) {
        return parseRef(key, defaultProvider, undefined);
      }
    }
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { provider: defaultProvider, model: trimmed };
  const provider = trimmed.slice(0, slash).trim().toLowerCase();
  const model = trimmed.slice(slash + 1).trim();
  return provider && model ? { provider, model } : null;
}

/** Ordered, de-duplicated judge candidates for this install (pure — no I/O). */
export function resolveJudgeCandidates(
  cfg: InfinibotConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): JudgeCandidate[] {
  const out: JudgeCandidate[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined, source: string, defaultProvider = "anthropic") => {
    if (!raw) return;
    const ref = parseRef(raw, defaultProvider, cfg);
    if (!ref) return;
    const key = `${ref.provider}/${ref.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind: "api", provider: ref.provider, model: ref.model, source });
  };

  add(env.ANTHROPIC_GOAL_JUDGE_MODEL?.trim(), "env:ANTHROPIC_GOAL_JUDGE_MODEL");
  add(env.INFINIBOT_JUDGE_MODEL?.trim(), "env:INFINIBOT_JUDGE_MODEL");

  const jc = readJudgeConfig(cfg);
  add(jc.judgeModel, "config:verification.judgeModel");
  for (const f of jc.judgeFallbacks ?? []) add(f, "config:verification.judgeFallbacks");

  const modelCfg = cfg?.agents?.defaults?.model as
    | string
    | { primary?: string; fallbacks?: string[] }
    | undefined;
  if (typeof modelCfg === "string") add(modelCfg, "agent-default");
  else if (modelCfg) {
    add(modelCfg.primary, "agent-default");
    for (const f of modelCfg.fallbacks ?? []) add(f, "agent-fallback");
  }

  const providers = (cfg?.models?.providers ?? {}) as Record<
    string,
    { models?: Array<{ id?: string }> }
  >;
  for (const [provider, pc] of Object.entries(providers)) {
    const first = pc?.models?.find((m) => m?.id)?.id;
    if (first) add(`${provider}/${first}`, "configured-provider");
  }
  for (const [provider, model] of KNOWN_PROVIDER_DEFAULTS)
    add(`${provider}/${model}`, "keyed-provider");

  for (const backend of ["claude-code", "codex", "opencode"] as const)
    out.push({ kind: "cli", backend, source: "cli" });
  return out;
}

export function judgeLabel(c: JudgeCandidate): string {
  return c.kind === "api" ? `${c.provider}/${c.model}` : `cli:${c.backend}`;
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** Errors that will not change until the owner changes config — cache them. */
function isConfigError(msg: string): boolean {
  return /No API key|no API key|Unknown model|does not support images|no credential/i.test(msg);
}

/**
 * One API judge call through the gateway model catalog + auth profiles.
 * Reasoning models get a larger budget and low reasoning effort; an empty
 * answer (budget spent thinking) is retried once with 4x the budget.
 */
export async function callApiJudge(
  c: Extract<JudgeCandidate, { kind: "api" }>,
  input: JudgeCallInput,
  cfg?: InfinibotConfig,
): Promise<string> {
  const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");
  const { getApiKeyForModel } = await import("../agents/model-auth.js");
  const { completeSimple } = await import("@mariozechner/pi-ai");
  const { model, error, authStorage } = resolveModel(c.provider, c.model, undefined, cfg);
  if (!model) throw new Error(error ?? `Unknown model: ${c.provider}/${c.model}`);
  const images = (input.imagePaths ?? []).slice(0, 8);
  if (images.length && !(model.input ?? []).includes("image"))
    throw new Error("model does not support images");
  const auth = await getApiKeyForModel({ model, cfg });
  if (!auth.apiKey) throw new Error(`No API key resolved for provider "${model.provider}"`);
  authStorage.setRuntimeApiKey(model.provider, auth.apiKey);
  const isOAuth = auth.mode === "oauth";

  const { readFileSync } = await import("node:fs");
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: input.prompt }];
  for (const img of images) {
    try {
      content.push({
        type: "image",
        data: readFileSync(img).toString("base64"),
        mimeType: /\.jpe?g$/i.test(img) ? "image/jpeg" : "image/png",
      });
    } catch {
      /* unreadable image — the prompt still lists the path */
    }
  }
  const context: Context = {
    systemPrompt: `${isOAuth ? `${CLAUDE_CODE_PREFIX}\n\n` : ""}${input.system}`,
    messages: [
      { role: "user", content: images.length ? content : input.prompt, timestamp: Date.now() },
    ],
  };
  const reasoning = Boolean((model as Model<Api>).reasoning);
  let maxTokens = input.maxTokens ?? 800;
  if (reasoning) maxTokens = Math.max(maxTokens, REASONING_MIN_TOKENS);
  for (let pass = 0; pass < 2; pass++) {
    const message = (await completeSimple(model, context, {
      apiKey: auth.apiKey,
      maxTokens: Math.min(maxTokens, MAX_TOKENS_CAP),
      signal: withTimeout(input.signal, input.timeoutMs),
      ...(reasoning ? { reasoning: "low" as const } : {}),
    })) as AssistantMessage;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage || `request ${message.stopReason}`);
    }
    const text = extractText(message);
    if (text.trim()) return text;
    const thinking = message.content
      .filter((b) => b.type === "thinking")
      .reduce((n, b) => n + ((b as { thinking?: string }).thinking?.length ?? 0), 0);
    if (pass === 0 && maxTokens < MAX_TOKENS_CAP) {
      log.warn(
        `judge ${judgeLabel(c)}: empty answer (stopReason=${message.stopReason}, ${thinking} thinking chars) — retrying with a larger budget`,
      );
      maxTokens = Math.min(maxTokens * 4, MAX_TOKENS_CAP);
      continue;
    }
    throw new Error(
      `empty answer (stopReason=${message.stopReason}, ${thinking} thinking chars, maxTokens=${maxTokens})`,
    );
  }
  return "";
}

async function callCliJudge(
  c: Extract<JudgeCandidate, { kind: "cli" }>,
  input: JudgeCallInput,
): Promise<string> {
  const { runCliPlanner } = await import("./cli-planner.js");
  const images = input.imagePaths ?? [];
  const userMessage = images.length
    ? `${input.prompt}\n\nUse the Read tool to view each of these screenshot files before answering:\n${images.join("\n")}`
    : input.prompt;
  return runCliPlanner({
    backend: c.backend,
    systemPrompt: input.system,
    userMessage,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
}

async function loadCfg(): Promise<InfinibotConfig | undefined> {
  try {
    const { loadConfig } = await import("../config/config.js");
    return loadConfig();
  } catch (err) {
    log.warn(`judge: could not load config (${String(err)}) — using env/CLI judges only`);
    return undefined;
  }
}

/**
 * Walk the judge chain until one answers (and `accept` agrees). Never throws;
 * returns `text: ""` with every failure when nothing answered.
 */
export async function runJudgeChain(
  input: JudgeChainInput,
  deps: JudgeChainDeps = {},
): Promise<JudgeChainResult> {
  const cfg = deps.cfg ?? (deps.candidates ? undefined : await loadCfg());
  const candidates = deps.candidates ?? resolveJudgeCandidates(cfg, deps.env ?? process.env);
  const jc = readJudgeConfig(cfg);
  const apiTimeout = jc.judgeTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const cliTimeout = Math.max(jc.judgeTimeoutMs ?? 0, DEFAULT_CLI_TIMEOUT_MS);
  const images = input.imagePaths ?? [];
  const failures: JudgeAttemptFailure[] = [];
  const cliAvailable =
    deps.cliAvailable ??
    (async (b: CliPlannerBackend) => (await import("./cli-planner.js")).checkCliAvailable(b));
  const callApi = deps.callApi ?? ((c, i) => callApiJudge(c, i, cfg));
  const callCli = deps.callCli ?? callCliJudge;

  for (const c of candidates) {
    if (input.signal?.aborted) break;
    const label = judgeLabel(c);
    if (c.kind === "cli" && images.length && c.backend !== "claude-code") continue;
    const cached = negativeCache.get(label);
    if (cached && cached.until > Date.now() && !deps.candidates) {
      failures.push({ judge: label, error: `${cached.error} (cached)` });
      continue;
    }
    if (c.kind === "cli") {
      if (!(await Promise.resolve(cliAvailable(c.backend)))) {
        failures.push({ judge: label, error: "CLI not installed" });
        continue;
      }
    }
    try {
      const text =
        c.kind === "api"
          ? await callApi(c, { ...input, timeoutMs: apiTimeout })
          : await callCli(c, { ...input, timeoutMs: cliTimeout });
      if (!text.trim()) throw new Error("empty answer");
      if (input.accept && !input.accept(text)) {
        throw new Error(`unusable answer: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
      }
      if (failures.length) {
        log.info(`judge answered by ${label} after ${failures.length} failed attempt(s)`);
      }
      return { text, judge: label, failures };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ judge: label, error: msg.slice(0, 300) });
      if (isConfigError(msg))
        negativeCache.set(label, {
          until: Date.now() + NEGATIVE_CACHE_MS,
          error: msg.slice(0, 200),
        });
      log.warn(`judge attempt failed: ${label} (${c.source}) — ${msg.slice(0, 300)}`);
    }
  }
  log.warn(
    `no judge answered (${failures.length} attempt(s)): ${failures
      .map((f) => `${f.judge}: ${f.error}`)
      .join(" | ")
      .slice(0, 800)}`,
  );
  return { text: "", judge: null, failures };
}

/** One-line summary of failed judge attempts, for review notes. */
export function summarizeJudgeFailures(failures: JudgeAttemptFailure[]): string {
  if (!failures.length) return "no judge configured";
  return failures
    .filter((f) => !/CLI not installed/.test(f.error))
    .map((f) => `${f.judge}: ${f.error}`)
    .join("; ")
    .slice(0, 500);
}
