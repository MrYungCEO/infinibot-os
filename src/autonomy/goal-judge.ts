/**
 * Goal Judge — evaluates whether an autonomous agent has completed a stated goal.
 *
 * Asks the install's judge chain (see judge-models.ts: env / config
 * verification.judgeModel / agent default model / any keyed provider / logged-in
 * CLI) to assess the conversation tail and emit a done/continue verdict.
 * Conservative by design: defaults to continue on parse errors or when no
 * judge answers.
 *
 * # Cadence
 *
 * - In the build/test orchestrator (src/autonomy/orchestrator.ts runLoop) the
 *   tester verdict acts as the per-iteration judge — it runs every iteration
 *   when `prefire.testerEnabled` is true. When tester is disabled the builder
 *   output is accepted as outcome.
 * - In goal-orchestrator turns the judge is consulted at the end of each
 *   synthesis pass (every turn). Both call paths go through evaluateGoal()
 *   below.
 *
 * # Model resolution
 *
 * resolveJudgeCandidates() in judge-models.ts. ANTHROPIC_GOAL_JUDGE_MODEL is
 * still honored first; it no longer defaults to Anthropic when the owner has
 * no Anthropic key.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { runJudgeChain, type JudgeChainDeps, type JudgeChainResult } from "./judge-models.js";

const log = createSubsystemLogger("autonomy.goal");

export interface JudgeInput {
  goalText: string;
  conversationTail: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  subgoals?: string[];
}

export interface JudgeVerdict {
  done: boolean;
  rationale: string;
  nextPrompt?: string;
  blocked?: boolean;
}

const JUDGE_PROMPT_TEMPLATE = `You are evaluating whether an autonomous agent has completed a stated goal.

GOAL: {goal}
{subgoalsBlock}
CONVERSATION TAIL (most recent {n} turns):
{tail}

Respond with STRICT JSON (no markdown, no commentary):
{
  "done": boolean,
  "rationale": "1-2 sentences explaining your decision",
  "nextPrompt": "if !done, what should the agent do next (1-2 sentences); omit if done",
  "blocked": boolean
}

Be conservative. Mark done=true only when:
- The agent explicitly confirms completion AND deliverables are produced, OR
- The goal is blocked (required file/service unavailable, goal is impossible, etc.)

Default to done=false with a specific nextPrompt if there is any ambiguity.`;

function parseVerdict(text: string): JudgeVerdict | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const blob = fenced ? fenced[1] : text;
  const start = blob.indexOf("{");
  const end = blob.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(blob.slice(start, end + 1)) as Record<string, unknown>;
    const blocked = parsed.blocked === true;
    const done = parsed.done === true || blocked;
    const rationale =
      typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim()
        : done
          ? "Goal marked complete."
          : "Continuing toward goal.";
    const nextPrompt = typeof parsed.nextPrompt === "string" ? parsed.nextPrompt : undefined;
    return { done, rationale, nextPrompt, blocked };
  } catch {
    return null;
  }
}

/**
 * Evaluate whether the agent has completed its goal.
 * Returns a conservative "continue" verdict on any failure.
 */
export async function evaluateGoal(
  input: JudgeInput,
  deps?: JudgeChainDeps,
): Promise<JudgeVerdict> {
  const fallback: JudgeVerdict = {
    done: false,
    rationale: "judge parse error, continuing",
    nextPrompt: "continue toward the goal",
  };

  try {
    const subgoalsBlock =
      input.subgoals && input.subgoals.length > 0
        ? `\nSUBGOALS:\n${input.subgoals.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`
        : "";

    // Format conversation tail; cap at 30k chars (truncate from the front).
    const tailLines = input.conversationTail
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join("\n\n");
    const cappedTail =
      tailLines.length > 30_000
        ? `...(truncated)\n\n${tailLines.slice(tailLines.length - 30_000)}`
        : tailLines;

    const prompt = JUDGE_PROMPT_TEMPLATE.replace("{goal}", input.goalText)
      .replace("{subgoalsBlock}", subgoalsBlock)
      .replace("{n}", String(input.conversationTail.length))
      .replace("{tail}", cappedTail);

    const { text } = await runJudgeChain(
      {
        system:
          "You are a conservative goal-completion judge. Output strict JSON only — no markdown, no commentary.",
        prompt,
        maxTokens: 512,
        accept: (t) => parseVerdict(t) !== null,
      },
      deps,
    );
    if (!text.trim()) {
      log.warn("goal judge: no judge answered — continuing");
      return fallback;
    }

    const verdict = parseVerdict(text);
    if (!verdict) {
      log.warn("goal judge response could not be parsed", { text: text.slice(0, 200) });
      return fallback;
    }

    log.info("goal judge verdict", {
      done: verdict.done,
      blocked: verdict.blocked,
      rationale: verdict.rationale,
    });
    return verdict;
  } catch (err) {
    log.warn("goal judge threw", { error: String(err) });
    return fallback;
  }
}

/**
 * Execute one turn of a goal using the Anthropic model directly.
 * Returns the model's response text; returns an error string on failure.
 */
export async function executeGoalTurn(prompt: string): Promise<string> {
  const { text, failures } = await runJudgeChain({
    system:
      "You are an autonomous agent executing tasks step by step. Complete the requested task directly and thoroughly.",
    prompt,
    maxTokens: 4096,
  });
  if (!text) {
    log.warn("goal executor: no model answered", { failures: failures.length });
    return "(credentials unavailable — cannot execute goal turn)";
  }
  log.info("goal executor response", { length: text.length });
  return text;
}

// ─── Per-criterion judge (goal runs + queue gateCriteria) ─────────────────

export interface CriterionJudgeInput {
  goalText: string;
  criterion: string;
  /** Tail of the agent's output / final reply. */
  agentOutput: string;
  /** `git diff --stat` + truncated diff of the workdir, when available. */
  diff?: string;
  signal?: AbortSignal;
}

export interface CriterionVerdict {
  pass: boolean;
  rationale: string;
  /** True when no judge could be reached — callers treat as a failed check. */
  unavailable?: boolean;
}

const CRITERION_PROMPT = `You are a strict verifier deciding whether ONE completion criterion of an autonomous coding task is met.

GOAL: {goal}

CRITERION: {criterion}

AGENT OUTPUT (tail):
{output}

WORKDIR DIFF:
{diff}

Respond with STRICT JSON only: {"pass": boolean, "rationale": "1-2 sentences citing the evidence"}
Mark pass=true ONLY when the evidence above shows the criterion is met. The agent claiming success is not evidence by itself.`;

export function parseCriterionVerdict(text: string): CriterionVerdict | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const blob = fenced ? fenced[1] : text;
  const start = blob.indexOf("{");
  const end = blob.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(blob.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.pass !== "boolean") return null;
    const rationale =
      typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim()
        : parsed.pass
          ? "Criterion met."
          : "Criterion not met.";
    return { pass: parsed.pass, rationale };
  } catch {
    return null;
  }
}

/**
 * Judge one natural-language criterion. Uses the gateway model catalog (same
 * auth path as {@link evaluateGoal}); falls back to a locally installed CLI
 * (claude / codex / opencode) when no API credential resolves. Conservative:
 * any failure → pass=false.
 */
export async function evaluateCriterion(
  input: CriterionJudgeInput,
  deps?: JudgeChainDeps,
): Promise<CriterionVerdict> {
  const cap = (s: string, n: number) => (s.length > n ? `...(truncated)\n${s.slice(-n)}` : s);
  const prompt = CRITERION_PROMPT.replace("{goal}", input.goalText)
    .replace("{criterion}", input.criterion)
    .replace("{output}", cap(input.agentOutput || "(no output captured)", 20_000))
    .replace("{diff}", cap(input.diff || "(no diff available)", 20_000));
  const system = "You are a strict completion verifier. Output strict JSON only.";
  const { text, failures } = await runJudgeChain(
    {
      system,
      prompt,
      maxTokens: 400,
      signal: input.signal,
      accept: (t) => parseCriterionVerdict(t) !== null,
    },
    deps,
  );
  if (!text.trim()) {
    const { summarizeJudgeFailures } = await import("./judge-models.js");
    return {
      pass: false,
      rationale: `LLM judge unavailable: ${summarizeJudgeFailures(failures)}`,
      unavailable: true,
    };
  }
  return (
    parseCriterionVerdict(text) ?? {
      pass: false,
      rationale: `judge response unparseable: ${text.slice(0, 160)}`,
    }
  );
}

// ─── Generic judge call (verified-completion reviewer + visual assessment) ──

export interface JudgeTextInput {
  system: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Images (PNG/JPEG) to attach — vision assessment. Absolute paths. */
  imagePaths?: string[];
}

/**
 * One judge call through the install's judge chain (judge-models.ts). Returns
 * "" when no judge is reachable — callers must treat that as "unavailable",
 * never as a pass.
 *
 * With `imagePaths`, API judges attach the images inline (vision models only);
 * the Claude Code CLI fallback is told to Read the files.
 */
export async function judgeText(input: JudgeTextInput): Promise<string> {
  return (await judgeTextDetailed(input)).text;
}

/** {@link judgeText} plus which judge answered and why the others failed. */
export async function judgeTextDetailed(
  input: JudgeTextInput & { accept?: (text: string) => boolean },
  deps?: JudgeChainDeps,
): Promise<JudgeChainResult> {
  return runJudgeChain(input, deps);
}
