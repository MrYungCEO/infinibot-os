/**
 * Spec-vs-Result oversight analysis.
 *
 * Given an agent's original brief (the `task` field persisted on the run
 * record) plus the final transcript + files-touched list, produce a structured
 * drift report:
 *   - extracted acceptance criteria (deterministic regex/heuristic pass)
 *   - per-criterion verdict (met / unmet / partial / unknown) from a small LLM pass
 *   - deferrals the agent admitted to ("couldn't", "out of scope", …)
 *   - off-limits violations (files touched that the brief said NOT to touch)
 *
 * The off-limits cross-check is computed DETERMINISTICALLY here (not trusted to
 * the LLM) because it is the highest-priority drift signal — we never want a
 * hallucinated "no violations" to hide a real one.
 *
 * Cost is tracked: the LLM call is recorded into the credit ledger keyed by
 * `taskId = runId`, so it rolls into the run's cost rollup on the Summary tab.
 */

import { recordCredit } from "../credits/recorder.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runTieredVerdict, type TierFailure, type VerdictTier } from "./spec-verdict.js";

const log = createSubsystemLogger("spec-analysis");

/**
 * Cheapest reliable grading models, in preference order. Oversight grading is
 * high-frequency + low-stakes, so we route to a Haiku-class model on whichever
 * provider the user actually has a key for, rather than their configured
 * default (which may be a costly frontier model or an unreachable local one).
 */
const GRADING_CANDIDATES: Array<{ provider: string; model: string }> = [
  { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  { provider: "openrouter", model: "anthropic/claude-3.5-haiku" },
  { provider: "groq", model: "llama-3.1-8b-instant" },
];

/**
 * Pick the model for the verdict pass: the first candidate above whose API key
 * is configured. Returns undefined (→ `runLLM` uses the configured default)
 * only when none of the cheap providers have a key. Best-effort.
 */
async function pickGradingModel(): Promise<{ provider: string; model: string } | undefined> {
  try {
    const { loadConfig } = await import("../config/config.js");
    const { resolveApiKeyForProvider } = await import("./model-auth.js");
    const cfg = loadConfig();
    for (const cand of GRADING_CANDIDATES) {
      try {
        const auth = await resolveApiKeyForProvider({ provider: cand.provider, cfg });
        if (auth?.apiKey) return cand;
      } catch {
        /* try the next candidate */
      }
    }
  } catch {
    /* fall back to configured default */
  }
  return undefined;
}

export type CriterionStatus = "met" | "unmet" | "partial" | "unknown";

export interface SpecCriterion {
  text: string;
  status: CriterionStatus;
  /** Short justification grounded in the transcript / files-touched. */
  evidence: string;
  /**
   * True when this criterion was SYNTHESIZED (LLM or heuristic) rather than
   * parsed verbatim from the brief. The UI labels these "(inferred)" so the
   * operator knows they were derived, not stated.
   */
  inferred?: boolean;
}

export interface OffLimitsViolation {
  /** The touched file path that matched an off-limits pattern. */
  path: string;
  /** The off-limits pattern (from the brief) it matched. */
  pattern: string;
}

export interface SpecAnalysisResult {
  /** The original brief (verbatim, for the markdown header). */
  brief: string;
  criteria: SpecCriterion[];
  /** Things the agent explicitly deferred / couldn't do / put out of scope. */
  deferred: string[];
  /** Off-limits file patterns extracted from the brief. */
  offLimitsPatterns: string[];
  /** Deterministic cross-check: touched files that hit an off-limits pattern. */
  offLimitsViolations: OffLimitsViolation[];
  /** One-line overall drift verdict from the LLM. */
  summary: string;
  /** True when only the deterministic pass ran (LLM gated/unavailable). */
  heuristicOnly: boolean;
  /**
   * True when the criteria were SYNTHESIZED from the brief's intent (terse
   * briefs with no explicit "Acceptance:" block) rather than parsed verbatim.
   * The UI labels these "(inferred)" so the operator knows the source.
   */
  criteriaInferred: boolean;
  /** Operator override — drift acknowledged + accepted. */
  accepted?: boolean;
  analyzedAt: number;
  model?: string;
  provider?: string;
  /**
   * Which tier of the verdict chain produced the result:
   * "gateway" (configured cloud LLM) | "cli" (codex/claude/opencode) |
   * "ollama" (local) | "heuristic" (deterministic fallback, no LLM available).
   */
  verdictTier?: VerdictTier;
  /** Human label for the UI, e.g. "gateway primary (anthropic/claude-haiku…)". */
  verdictBy?: string;
  /**
   * Per-tier failure reasons for every tier tried before the one that produced
   * the verdict (or all of them when heuristic-only). Powers the UI "Why?"
   * expander so an operator can debug a missing LLM verdict.
   */
  tierFailures?: TierFailure[];
}

// ── Deterministic extraction ───────────────────────────────────────────────

const MAX_CRITERIA = 24;

/**
 * Pull acceptance-style criteria out of a free-form brief. Heuristics, in
 * priority order, deduped:
 *   - lines inside an "Acceptance:" / "Acceptance criteria" block
 *   - lines containing MUST / SHALL / REQUIRED (uppercase = imperative)
 *   - numbered list items (1. / 1))
 *   - bulleted list items (- / * / •)
 */
export function extractAcceptanceCriteria(brief: string): string[] {
  if (!brief) return [];
  const lines = brief.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const text = raw
      .replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 6 || text.length > 280) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  // 1) Explicit "Acceptance" block — collect following list/non-blank lines.
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#{0,6}\s*acceptance(?:\s+criteria)?\s*[:.]?/i.test(lines[i])) {
      // inline content after the colon on the same line
      const inline = lines[i].replace(/^\s*#{0,6}\s*acceptance(?:\s+criteria)?\s*[:.]?/i, "");
      if (inline.trim()) push(inline);
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) break;
        if (/^\s*#{1,6}\s/.test(l)) break; // next header
        push(l);
      }
    }
  }

  // 2) MUST / SHALL / REQUIRED imperatives.
  for (const l of lines) {
    if (/\b(MUST|SHALL|REQUIRED)\b/.test(l)) push(l);
  }

  // 3) Numbered + 4) bulleted list items.
  for (const l of lines) {
    if (/^\s*\d+[.)]\s+\S/.test(l)) push(l);
  }
  for (const l of lines) {
    if (/^\s*[-*•]\s+\S/.test(l)) push(l);
  }

  return out.slice(0, MAX_CRITERIA);
}

/** Verbs that signal a concrete, testable expectation in a terse brief. */
const IMPERATIVE_VERB_RE =
  /\b(print|echo|output|log|display|show|write|create|add|build|implement|fix|update|remove|delete|return|exit|run|install|generate|render|set|configure|ensure|make|produce|send|save|read|parse|test|verify|append|replace|rename|move|copy|format|validate|check)\b/i;

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * Deterministic fallback: SYNTHESIZE 1–3 concrete acceptance criteria from a
 * terse brief that has no explicit "Acceptance:" block or list. This guarantees
 * the oversight pass always has at least one criterion to grade — a one-line
 * brief like "Print the word OK and exit." must never produce an empty spec.
 *
 * Strategy: split the brief into clauses (sentences / "and" / "then" / commas),
 * then map each clause to a testable assertion, with a few high-signal special
 * cases ("print X" → stdout contains X; "exit" → process exits with code 0).
 * Used when the LLM synthesis pass is unavailable or returns nothing.
 */
export function synthesizeCriteriaHeuristic(brief: string): string[] {
  const text = (brief ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const clauses = text
    .split(/(?:[.;\n]+|\band\b|\bthen\b|,)/i)
    .map((c) => c.trim())
    .filter((c) => c.length >= 3);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t.length < 4 || t.length > 200) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  for (const clause of clauses) {
    // "print/echo/output the word OK" → stdout contains "OK"
    const printM = clause.match(
      /\b(?:print|echo|output|log|display|show)\b\s+(?:the\s+(?:word|text|string|line|message)\s+|a\s+|an\s+|the\s+)?["'`]?([\w][\w .,!?:'"-]{0,48}?)["'`]?$/i,
    );
    if (printM && printM[1].trim()) {
      add(`stdout contains "${printM[1].trim()}"`);
      continue;
    }
    // "and exit" / "exit cleanly" → exits with code 0
    if (/\bexits?\b/i.test(clause) && clause.length <= 30) {
      add("process exits with code 0");
      continue;
    }
    if (IMPERATIVE_VERB_RE.test(clause)) {
      add(`The result must ${lowerFirst(clause)}`);
    } else {
      add(`The result satisfies: ${clause}`);
    }
  }

  if (!out.length) add(`The result fulfills the brief: ${text.slice(0, 180)}`);
  return out.slice(0, 3);
}

const OFFLIMITS_MARKER_RE =
  /\b(?:do ?not ?touch|don'?t ?touch|off[-\s]?limits|do not (?:edit|modify|change)|don'?t (?:edit|modify|change)|hands? off|leave (?:alone|untouched))\b/i;

const FILE_TOKEN_RE =
  /([A-Za-z0-9_./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|py|go|rs|java|md|yml|yaml|sh|ps1))\b/g;

/**
 * Extract off-limits file patterns from the brief. We look for marker phrases
 * ("Do NOT touch", "off-limits", …) and harvest file-like tokens from the
 * marker line plus any immediately-following list lines. Patterns are matched
 * later by basename or path-substring.
 */
export function extractOffLimitsPatterns(brief: string): string[] {
  if (!brief) return [];
  const lines = brief.split(/\r?\n/);
  const patterns = new Set<string>();
  const harvest = (s: string) => {
    let m: RegExpExecArray | null;
    FILE_TOKEN_RE.lastIndex = 0;
    while ((m = FILE_TOKEN_RE.exec(s)) !== null) {
      patterns.add(m[1].trim());
    }
  };

  for (let i = 0; i < lines.length; i++) {
    if (!OFFLIMITS_MARKER_RE.test(lines[i])) continue;
    harvest(lines[i]);
    // Follow into the list/sentence that the marker introduces.
    for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
      const l = lines[j];
      if (!l.trim()) break;
      if (OFFLIMITS_MARKER_RE.test(l)) break;
      // stop if the line clearly starts a new unrelated heading
      if (/^\s*#{1,6}\s/.test(l)) break;
      harvest(l);
    }
  }
  return [...patterns];
}

/**
 * Deterministic cross-check of touched files against off-limits patterns.
 * Only mutating actions count (created/edited/deleted) — a "read" of an
 * off-limits file is not a violation.
 */
export function computeOffLimitsViolations(
  patterns: string[],
  filesTouched: Array<{ path: string; action?: string }>,
): OffLimitsViolation[] {
  if (!patterns.length || !filesTouched.length) return [];
  const violations: OffLimitsViolation[] = [];
  const seen = new Set<string>();
  for (const f of filesTouched) {
    const action = (f.action ?? "edited").toLowerCase();
    if (action === "read") continue;
    const path = f.path;
    if (!path) continue;
    const base = path.split(/[\\/]/).pop() ?? path;
    for (const pat of patterns) {
      const patBase = pat.split(/[\\/]/).pop() ?? pat;
      const hit =
        base.toLowerCase() === patBase.toLowerCase() ||
        path.toLowerCase().includes(pat.toLowerCase());
      if (hit) {
        const key = `${path}|${pat}`;
        if (!seen.has(key)) {
          seen.add(key);
          violations.push({ path, pattern: pat });
        }
        break;
      }
    }
  }
  return violations;
}

// ── LLM verdict pass ────────────────────────────────────────────────────────

function buildSystemPrompt(inferCriteria: boolean): string {
  const criteriaRule = inferCriteria
    ? `- The brief is terse and has NO explicit acceptance list. INFER 1–3 concrete, testable acceptance criteria from the brief's intent, then judge each. Make each criterion specific and verifiable (e.g. "stdout contains 'OK'", "process exits with code 0").`
    : `- Echo each provided criterion verbatim in "text" and judge it. Do not invent criteria.`;
  return `You are an oversight reviewer comparing an AI coding agent's ORIGINAL BRIEF against what it actually did. You are skeptical: an unverified claim is "unknown", not "met". Be terse and grounded in the evidence given.

Return ONLY a JSON object, no prose, with this exact shape:
{
  "summary": "one sentence: did the result match the brief, and the biggest drift if any",
  "criteria": [{ "text": "<criterion>", "status": "met|unmet|partial|unknown", "evidence": "<=140 chars grounded in transcript/files" }],
  "deferred": ["short phrases the agent explicitly deferred / couldn't do / put out of scope"]
}
Rules:
${criteriaRule}
- "met" only with clear supporting evidence; "partial" if started but incomplete; "unmet" if contradicted/ignored; "unknown" if the transcript doesn't say.
- "deferred" = only things the AGENT itself admitted (deferred, couldn't, blocked, out of scope, TODO). [] if none.`;
}

interface LlmVerdict {
  summary: string;
  criteria: Array<{ text: string; status: string; evidence: string }>;
  deferred: string[];
}

function coerceStatus(s: unknown): CriterionStatus {
  const v = String(s ?? "").toLowerCase();
  if (v === "met" || v === "unmet" || v === "partial" || v === "unknown") return v;
  return "unknown";
}

function clamp(s: unknown, n: number): string {
  const v = typeof s === "string" ? s : "";
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

export interface AnalyzeOptions {
  brief: string;
  /** Bounded transcript text (already truncated by the caller). */
  transcriptText: string;
  filesTouched: Array<{ path: string; action?: string }>;
  /** For credit attribution → rolls into the run's cost on the Summary tab. */
  runId: string;
  sessionKey?: string;
}

/**
 * Full spec-vs-result analysis. The deterministic passes always run; the LLM
 * verdict pass runs unless no API key is configured (then heuristicOnly=true
 * and every criterion is "unknown").
 */
export async function analyzeSpecVsResult(opts: AnalyzeOptions): Promise<SpecAnalysisResult> {
  const brief = opts.brief ?? "";
  const explicitCriteria = extractAcceptanceCriteria(brief);
  // Terse briefs ("Print OK and exit.") yield no explicit criteria — synthesize
  // testable ones deterministically so we ALWAYS have ≥1 criterion to grade.
  const inferCriteria = explicitCriteria.length === 0;
  const synthesizedCriteria = inferCriteria ? synthesizeCriteriaHeuristic(brief) : [];
  const seedCriteria = explicitCriteria.length ? explicitCriteria : synthesizedCriteria;
  const offLimitsPatterns = extractOffLimitsPatterns(brief);
  const offLimitsViolations = computeOffLimitsViolations(offLimitsPatterns, opts.filesTouched);

  const base: SpecAnalysisResult = {
    brief,
    criteria: seedCriteria.map((text) => ({
      text,
      status: "unknown",
      evidence: "",
      inferred: inferCriteria,
    })),
    deferred: [],
    offLimitsPatterns,
    offLimitsViolations,
    summary: "",
    heuristicOnly: true,
    criteriaInferred: inferCriteria,
    analyzedAt: Date.now(),
  };

  // Truly empty: no brief content to derive criteria from AND no observable
  // output to judge. Only here do we legitimately have nothing to grade.
  if (!seedCriteria.length && !opts.transcriptText.trim() && !opts.filesTouched.length) {
    base.summary = "Run produced no observable output and the brief was empty.";
    return base;
  }

  const filesList = opts.filesTouched
    .slice(0, 80)
    .map((f) => `${f.action ?? "edited"} ${f.path}`)
    .join("\n");

  const userPrompt = [
    "=== ORIGINAL BRIEF ===",
    brief.slice(0, 6000) || "(empty brief)",
    "",
    inferCriteria
      ? "=== ACCEPTANCE CRITERIA === (none stated explicitly — infer 1–3 testable ones from the brief; candidates below)"
      : "=== ACCEPTANCE CRITERIA (judge each, echo verbatim) ===",
    seedCriteria.length
      ? seedCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "(none — infer from the brief's intent)",
    "",
    "=== FILES TOUCHED ===",
    filesList || "(none recorded)",
    "",
    "=== FINAL TRANSCRIPT (truncated) ===",
    opts.transcriptText.slice(0, 12000) || "(no transcript available)",
  ].join("\n");

  const started = Date.now();
  // Tiered verdict chain — NEVER fail closed. (a) gateway primary cloud LLM →
  // (b) CLI coder (codex/claude/opencode, own auth) → (c) local Ollama →
  // (d) heuristic-only (below). pickGradingModel pins the cheapest key-having
  // model for tier (a); when no key exists runLLM falls back to the gateway
  // primary / configured default. Each tier records why it failed.
  const grader = await pickGradingModel();
  const { outcome, failures } = await runTieredVerdict({
    systemPrompt: buildSystemPrompt(inferCriteria),
    userPrompt,
    maxTokens: 1200,
    temperature: 0.1,
    grader,
    validate: validateVerdict,
  });
  base.tierFailures = failures;

  if (outcome) {
    // `outcome.parsed` already passed validateVerdict in the tier runner, so a
    // returned outcome is always a usable verdict — no re-parse / unparseable
    // branch needed (a tier that produced junk was recorded as failed and the
    // chain cascaded past it).
    const parsed = outcome.parsed as LlmVerdict;
    {
      const byText = new Map<string, { text: string; status: string; evidence: string }>(
        parsed.criteria.map((c) => [String(c.text).trim().toLowerCase(), c]),
      );
      if (explicitCriteria.length) {
        // Explicit criteria are authoritative — map LLM verdicts back onto them
        // by index, falling back to text match.
        base.criteria = explicitCriteria.map((text, i) => {
          const v = parsed.criteria[i] ?? byText.get(text.trim().toLowerCase());
          return {
            text,
            status: coerceStatus(v?.status),
            evidence: clamp(v?.evidence, 160),
            inferred: false,
          };
        });
      } else {
        // Inferred: prefer the LLM's (usually sharper) inferred + graded
        // criteria; fall back to the deterministic synthesis if it returned none.
        const llmCriteria = parsed.criteria.filter((v) => String(v.text ?? "").trim());
        base.criteria = (
          llmCriteria.length
            ? llmCriteria.slice(0, MAX_CRITERIA)
            : synthesizedCriteria.map((text) => ({ text, status: "unknown", evidence: "" }))
        ).map((v) => ({
          text: clamp(v.text, 280),
          status: coerceStatus(v.status),
          evidence: clamp(v.evidence, 160),
          inferred: true,
        }));
      }
      base.deferred = (parsed.deferred ?? [])
        .filter((d) => typeof d === "string" && d.trim())
        .map((d) => clamp(d, 200))
        .slice(0, 20);
      base.summary = clamp(parsed.summary, 280) || "Analysis complete.";
      base.heuristicOnly = false;
      base.model = outcome.model;
      base.provider = outcome.provider;
      base.verdictTier = outcome.tier;
      base.verdictBy = outcome.by;
    }

    // Track cost only for the gateway tier (real API token spend). CLI/Ollama
    // tiers are separately authenticated / local — no ledger entry. Estimated
    // tokens since runLLM does not surface usage. Keyed by taskId=runId so it
    // rolls into the Summary-tab cost. Best-effort.
    if (outcome.tier === "gateway") {
      try {
        recordCredit({
          provider: outcome.provider || "anthropic",
          model: outcome.model || "claude-haiku-4-5-20251001",
          kind: "chat",
          agentBackend: "direct-api",
          usage: {
            tokensIn: Math.ceil(userPrompt.length / 4),
            tokensOut: Math.ceil((outcome.text?.length ?? 0) / 4),
          },
          taskId: opts.runId,
          sessionKey: opts.sessionKey,
          latencyMs: Date.now() - started,
          source: "ledger.direct",
        });
      } catch {
        /* credit recording is best-effort */
      }
    }
  } else {
    // Tiers (a)–(c) all failed → deterministic heuristic only. Criteria are
    // still present (extracted or synthesized); we just couldn't grade them.
    // Surface the concrete per-tier reasons instead of a generic banner.
    log.warn("spec-analysis: all LLM verdict tiers failed", {
      runId: opts.runId,
      failures: failures.map((f) => `${f.tier}:${f.reason}`),
    });
    base.heuristicOnly = true;
    base.verdictTier = "heuristic";
    base.verdictBy = "heuristic (no LLM available)";
    base.summary =
      "LLM verdict unavailable — showing extracted criteria + off-limits check only. (heuristic only)";
  }

  return base;
}

/**
 * Tier validator: parse `text` and accept it only if it carries usable content
 * (a non-empty summary OR ≥1 criterion OR a deferral). An empty `{}` or an
 * error-shaped JSON parses but is useless — returning null makes the tier chain
 * treat it as a FAILURE and cascade to the next tier instead of stopping here.
 */
function validateVerdict(text: string): LlmVerdict | null {
  const parsed = parseVerdict(text);
  if (!parsed) return null;
  const hasContent =
    Boolean(parsed.summary && parsed.summary.trim()) ||
    parsed.criteria.length > 0 ||
    parsed.deferred.length > 0;
  return hasContent ? parsed : null;
}

function parseVerdict(text: string): LlmVerdict | null {
  if (!text) return null;
  let raw = text.trim();
  // Strip code fences if the model wrapped the JSON.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  // Grab the outermost JSON object.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Partial<LlmVerdict>;
    return {
      summary: typeof obj.summary === "string" ? obj.summary : "",
      criteria: Array.isArray(obj.criteria) ? obj.criteria : [],
      deferred: Array.isArray(obj.deferred) ? obj.deferred : [],
    };
  } catch {
    return null;
  }
}
