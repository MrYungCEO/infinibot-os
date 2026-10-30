/**
 * Tiered LLM verdict runner for spec-vs-result oversight grading.
 *
 * The oversight grader must NEVER fail closed just because one model path is
 * unreachable. It cascades through four tiers, in priority order, and records
 * WHICH tier produced the verdict (so the UI can show "Verdict by: …") plus the
 * concrete failure reason for every tier that was tried and failed (so an
 * operator can debug a heuristic-only result):
 *
 *   a) GATEWAY PRIMARY — the user's configured cloud LLM (via `runLLM`, which
 *      resolves `agents.defaults.model.primary` / the cheapest key-having
 *      grading model). Succeeds for ~99% of installs that finished quickstart.
 *   b) CLI CODER — a one-shot `codex` / `claude --print` / `opencode run`
 *      process. These backends carry their own auth (OAuth / CLI login) and are
 *      guaranteed installed once sub-agents have been spawned, so this rescues
 *      boxes that have a CLI login but no provider API key in config.
 *   c) LOCAL OLLAMA — `POST {host}/api/chat` with a small open-weights model
 *      auto-detected from `/api/tags` (gemma2:2b → qwen2.5:3b → first pulled).
 *      Bounded to 30s. Rescues fully-offline boxes running a local daemon.
 *   d) HEURISTIC — the caller's deterministic pass (handled by spec-analysis).
 *
 * This module owns tiers (a)–(c); the caller owns (d) and labels it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadConfig } from "../config/config.js";
import { resolveBin, enrichedPathEnv } from "./coder-backend/bin-detect.js";
import { resolveOllamaHost } from "../ollama/ensure-ollama.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("spec-verdict");
const execFileAsync = promisify(execFile);

/** Which tier produced (or failed to produce) the verdict. */
export type VerdictTier = "gateway" | "cli" | "ollama" | "heuristic";

export interface VerdictOutcome {
  /** Raw model text (the JSON the tier emitted). */
  text: string;
  /** The caller's `validate(text)` return — a ready-to-use parsed verdict. */
  parsed: unknown;
  provider: string;
  model: string;
  tier: VerdictTier;
  /** Human label for the UI, e.g. "gateway primary (anthropic/claude-haiku…)". */
  by: string;
}

export interface TierFailure {
  tier: VerdictTier;
  /** Concise reason this tier failed (shown in the UI "Why?" expander). */
  reason: string;
}

export interface TieredVerdictArgs {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Preferred cheap model for tier (a). When its key exists `runLLM` uses it;
   * otherwise `runLLM` falls back to the gateway primary / configured default.
   */
  grader?: { provider: string; model: string };
  /**
   * Validate + parse a tier's raw text into a usable verdict. Return the parsed
   * value on success, or `null` when the text is empty / unparseable / useless
   * (e.g. an error JSON with no criteria) — in which case the chain treats that
   * tier as FAILED and cascades to the next one rather than stopping with junk.
   */
  validate: (text: string) => unknown | null;
}

export interface TieredVerdictResult {
  /** Non-null when a real LLM tier (gateway/cli/ollama) produced text. */
  outcome: VerdictOutcome | null;
  /** Every tier that was attempted and failed, with its reason. */
  failures: TierFailure[];
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Combine system + user into a single prompt for CLI / Ollama tiers. */
function combinePrompt(systemPrompt: string, userPrompt: string): string {
  return `${systemPrompt}\n\n${userPrompt}\n\nReturn ONLY the JSON object described above — no prose, no markdown fences.`;
}

// ── Tier A: gateway primary (configured cloud LLM) ──────────────────────────

async function tryGateway(
  args: TieredVerdictArgs,
  failures: TierFailure[],
): Promise<VerdictOutcome | null> {
  try {
    const { runLLM } = await import("../services/email/llm-analysis.js");
    const result = await runLLM({
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      maxTokens: args.maxTokens ?? 1200,
      temperature: args.temperature ?? 0.1,
      jsonMode: true,
      ...args.grader,
    });
    const parsed = result.text?.trim() ? args.validate(result.text) : null;
    if (parsed != null) {
      return {
        text: result.text,
        parsed,
        provider: result.provider,
        model: result.model,
        tier: "gateway",
        by: `gateway primary (${result.provider}/${result.model})`,
      };
    }
    failures.push({
      tier: "gateway",
      reason: result.text?.trim()
        ? `${result.provider}/${result.model} returned an unusable/unparseable verdict`
        : "configured model returned empty text",
    });
  } catch (err) {
    failures.push({ tier: "gateway", reason: errMsg(err).slice(0, 240) });
  }
  return null;
}

// ── Tier B: CLI coder backends (own auth) ───────────────────────────────────

/**
 * One-shot CLI invocations. Each entry builds the argv for a non-interactive
 * "answer this prompt and print the result" run. The prompt is passed as the
 * final positional arg (Linux/macOS arg limits comfortably exceed our ~18 KB
 * prompt). `claude --print` is tried first — it reliably emits clean text we
 * can parse directly — then `codex exec`, then `opencode run`. Whichever yields
 * the first parseable JSON verdict wins; the others are only tried as fallbacks.
 */
const CLI_CANDIDATES: Array<{
  bin: string;
  label: string;
  buildArgs: (prompt: string) => string[];
}> = [
  {
    bin: "claude",
    label: "claude",
    buildArgs: (prompt) => [
      "--print",
      "--model",
      "claude-haiku-4-5-20251001",
      "--output-format",
      "text",
      prompt,
    ],
  },
  {
    bin: "codex",
    label: "codex",
    buildArgs: (prompt) => ["exec", "--skip-git-repo-check", prompt],
  },
  {
    bin: "opencode",
    label: "opencode",
    buildArgs: (prompt) => ["run", prompt],
  },
];

async function tryCli(
  args: TieredVerdictArgs,
  failures: TierFailure[],
): Promise<VerdictOutcome | null> {
  const prompt = combinePrompt(args.systemPrompt, args.userPrompt);
  let anyInstalled = false;
  for (const cand of CLI_CANDIDATES) {
    const binPath = resolveBin(cand.bin);
    if (!binPath) continue; // not installed — try the next, no failure noise
    anyInstalled = true;
    try {
      const { stdout } = await execFileAsync(binPath, cand.buildArgs(prompt), {
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        env: enrichedPathEnv(),
      });
      const text = (stdout ?? "").trim();
      const parsed = text ? args.validate(text) : null;
      if (parsed != null) {
        return {
          text,
          parsed,
          provider: "cli",
          model: cand.label,
          tier: "cli",
          by: `CLI (${cand.label})`,
        };
      }
      failures.push({ tier: "cli", reason: `${cand.label}: no usable JSON verdict in output` });
    } catch (err) {
      failures.push({ tier: "cli", reason: `${cand.label}: ${errMsg(err).slice(0, 160)}` });
    }
  }
  if (!anyInstalled) {
    failures.push({ tier: "cli", reason: "no CLI coder installed (codex/claude/opencode)" });
  }
  return null;
}

// ── Tier C: local Ollama ────────────────────────────────────────────────────

/** Small open-weights models preferred for grading, cheapest first. */
const OLLAMA_PREFERRED = ["gemma2:2b", "qwen2.5:3b", "llama3.2:3b", "phi3:mini"];

function pickOllamaModel(installed: string[]): string | null {
  if (!installed.length) return null;
  const byLower = new Map(installed.map((m) => [m.toLowerCase(), m] as const));
  for (const want of OLLAMA_PREFERRED) {
    const hit = byLower.get(want.toLowerCase());
    if (hit) return hit;
  }
  // Otherwise prefer any small (≤4b) tagged model, else the first one.
  const small = installed.find((m) => /[:-]([0-3](\.\d+)?b)\b/i.test(m));
  return small ?? installed[0] ?? null;
}

async function tryOllama(
  args: TieredVerdictArgs,
  failures: TierFailure[],
): Promise<VerdictOutcome | null> {
  let host: string;
  try {
    host = resolveOllamaHost(loadConfig());
  } catch {
    host = resolveOllamaHost(undefined);
  }
  try {
    const tagsRes = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!tagsRes.ok) {
      failures.push({ tier: "ollama", reason: `/api/tags HTTP ${tagsRes.status} at ${host}` });
      return null;
    }
    const tags = (await tagsRes.json()) as { models?: Array<{ name?: unknown }> };
    const installed = Array.isArray(tags?.models)
      ? tags.models
          .map((m) => (typeof m?.name === "string" ? m.name.trim() : ""))
          .filter((n): n is string => n.length > 0)
      : [];
    const model = pickOllamaModel(installed);
    if (!model) {
      failures.push({ tier: "ollama", reason: `no models pulled on ${host}` });
      return null;
    }
    const chatRes = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: { temperature: args.temperature ?? 0.1 },
        messages: [
          { role: "system", content: args.systemPrompt },
          { role: "user", content: args.userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!chatRes.ok) {
      const body = await chatRes.text().catch(() => "");
      failures.push({
        tier: "ollama",
        reason: `/api/chat HTTP ${chatRes.status}: ${body.slice(0, 160)}`,
      });
      return null;
    }
    const data = (await chatRes.json()) as { message?: { content?: string } };
    const text = (data.message?.content ?? "").trim();
    const parsed = text ? args.validate(text) : null;
    if (parsed != null) {
      return {
        text,
        parsed,
        provider: "ollama",
        model,
        tier: "ollama",
        by: `Ollama (${model})`,
      };
    }
    failures.push({
      tier: "ollama",
      reason: text
        ? `${model} returned an unusable/unparseable verdict`
        : `${model} returned empty content`,
    });
  } catch (err) {
    failures.push({ tier: "ollama", reason: `${host}: ${errMsg(err).slice(0, 160)}` });
  }
  return null;
}

/**
 * Run the verdict prompt through the tiered chain (gateway → CLI → Ollama).
 * Returns the first successful outcome plus the failure reasons of every tier
 * that was tried before it. When all three fail, `outcome` is null and the
 * caller should fall back to its deterministic heuristic pass.
 */
export async function runTieredVerdict(args: TieredVerdictArgs): Promise<TieredVerdictResult> {
  const failures: TierFailure[] = [];

  const gateway = await tryGateway(args, failures);
  if (gateway) return { outcome: gateway, failures };

  const cli = await tryCli(args, failures);
  if (cli) return { outcome: cli, failures };

  const ollama = await tryOllama(args, failures);
  if (ollama) return { outcome: ollama, failures };

  log.warn("all verdict tiers failed", {
    failures: failures.map((f) => `${f.tier}:${f.reason}`),
  });
  return { outcome: null, failures };
}
