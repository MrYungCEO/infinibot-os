/**
 * Verification review — turns (classification + RESULT + evidence + diff) into
 * one verdict:
 *
 *   VERIFIED    RESULT "done", every deterministic check passed, visual
 *               changes carry valid screenshots, and the LLM reviewer found
 *               no unsupported claims.
 *   UNVERIFIED  something is missing or unsupported (reasons listed). The
 *               pipeline may continue the run to close the gap.
 *   FAILED      hard evidence the work is broken: the process failed, or a
 *               claimed-passing command fails when re-run.
 *
 * Never VERIFIED when any part of the review says otherwise.
 */

import type { RunResult } from "./contract.js";
import type { ExitClassification } from "./classifier.js";
import type { EvidenceReport } from "./evidence.js";

export type Verdict = "VERIFIED" | "UNVERIFIED" | "FAILED";

export interface LlmReview {
  available: boolean;
  verdict: "supported" | "unsupported" | "contradicted" | "unavailable";
  unsupportedClaims: Array<{ claim: string; why: string; critical?: boolean }>;
  /** Claims that are not needed to show the task's acceptance criteria are met. */
  incidentalClaims?: string[];
  notes: string;
  /** Judge that produced this review (`provider/model` or `cli:<backend>`). */
  judge?: string | null;
  /** Why earlier judges in the chain did not answer. */
  judgeFailures?: Array<{ judge: string; error: string }>;
}

export interface ReviewOutcome {
  verdict: Verdict;
  reasons: string[];
  /** Gaps the agent itself can close — drives auto-continuation. */
  fixable: string[];
  /**
   * Non-blocking notes: checks the gateway could not re-run for environmental
   * reasons (missing tool, wrong Node, missing worktree). Never FAIL a run and
   * never drive a continuation on their own.
   */
  warnings: string[];
  visualFiles: string[];
  visualSatisfied: boolean;
  llm: LlmReview | null;
}

const REVIEW_PROMPT = `You are an adversarial reviewer checking a coding agent's completion report against hard evidence.

TASK GIVEN TO THE AGENT:
{task}
{later}
AGENT'S RESULT BLOCK (its claims):
{result}

DETERMINISTIC EVIDENCE CHECKS (run by the gateway, trustworthy):
{evidence}

GIT DIFF SINCE THE RUN STARTED:
{diff}

AGENT'S FINAL MESSAGE (tail):
{final}

File content shown under an evidence line was read from disk by the gateway (result JSON, logs, test reports the agent referenced) — it IS evidence; judge the claim against it.
Evidence marked "could not re-run (environment)" means the gateway's own environment could not execute the command (tool not installed, wrong Node version, worktree gone). It is NOT evidence against the claim — treat such a claim like an agent-reported check that was not re-run, and do not list it as unsupported for that reason alone.
Headless-browser GPU/GL driver messages ("GL Driver Message", "GPU stall due to ReadPixels", software-WebGL fallback) are benign noise, not console errors. Evidence marked "pre-existing failure … baseline" fails on the base commit too — it was not introduced by this run.
First work out the task's ACCEPTANCE CRITERIA (what must be true for the task to be done). For every claim, decide whether the evidence above supports it. A claim with no matching evidence is unsupported. The agent saying something is not evidence. Also flag acceptance criteria the diff shows were not done.
Mark each unsupported claim "critical": true only when it is needed to show an acceptance criterion is met. Side observations, background explanations, deploy notes the task did not ask for, and extra checks beyond the criteria are "critical": false — list them in incidental_claims too. Never demand evidence for incidental claims.
Respond with STRICT JSON only:
{"verdict":"supported|unsupported|contradicted","unsupported_claims":[{"claim":"...","why":"...","critical":true}],"incidental_claims":["claim text"],"notes":"1-2 sentences"}
"supported" only when every critical claim is backed; "contradicted" when evidence shows a critical claim is false.`;

export function parseLlmReview(text: string): LlmReview | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const blob = fenced ? fenced[1] : text;
  const s = blob.indexOf("{");
  const e = blob.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const o = JSON.parse(blob.slice(s, e + 1)) as Record<string, unknown>;
    const v = o.verdict;
    if (v !== "supported" && v !== "unsupported" && v !== "contradicted") return null;
    const unsupportedClaims = Array.isArray(o.unsupported_claims)
      ? o.unsupported_claims
          .map((x) =>
            x && typeof x === "object"
              ? {
                  claim: String((x as { claim?: unknown }).claim ?? ""),
                  why: String((x as { why?: unknown }).why ?? ""),
                  ...(typeof (x as { critical?: unknown }).critical === "boolean"
                    ? { critical: (x as { critical: boolean }).critical }
                    : {}),
                }
              : null,
          )
          .filter((x): x is { claim: string; why: string; critical?: boolean } => Boolean(x?.claim))
      : [];
    const incidentalClaims = Array.isArray(o.incidental_claims)
      ? o.incidental_claims.filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : [];
    return {
      available: true,
      verdict: v,
      unsupportedClaims,
      ...(incidentalClaims.length ? { incidentalClaims: incidentalClaims.slice(0, 20) } : {}),
      notes: typeof o.notes === "string" ? o.notes.slice(0, 600) : "",
    };
  } catch {
    return null;
  }
}

/** Evidence lines for the reviewer, with bounded excerpts of referenced result files. */
export function renderEvidence(evidence: EvidenceReport, excerptBudget = 8000): string {
  let budget = excerptBudget;
  const lines = evidence.items.map((i) => {
    let line = `- [${i.status}] ${i.kind}: ${i.ref} — ${i.detail}`;
    if (i.excerpt && budget > 0) {
      const ex = i.excerpt.slice(0, Math.min(1200, budget));
      budget -= ex.length;
      line += `\n  file content (read by the gateway):\n${ex
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")}`;
    }
    return line;
  });
  return lines.join("\n") || "(none)";
}

export type JudgeFn = (input: {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Reject an answer so the next judge in the chain is tried. */
  accept?: (text: string) => boolean;
}) => Promise<
  | string
  | { text: string; judge?: string | null; failures?: Array<{ judge: string; error: string }> }
>;

export async function runLlmReview(params: {
  task: string;
  result: RunResult | null;
  evidence: EvidenceReport;
  finalText: string;
  judge: JudgeFn;
  /** Follow-up instructions (gateway continuations / operator) — they supersede the task. */
  laterInstructions?: string[];
}): Promise<LlmReview> {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);
  const later = (params.laterInstructions ?? []).filter(Boolean);
  const prompt = REVIEW_PROMPT.replace("{task}", cap(params.task || "(unknown)", 6000))
    .replace(
      "{later}",
      later.length
        ? `\nLATER INSTRUCTIONS TO THE AGENT (these supersede the task where they conflict):\n${later
            .map((l, i) => `${i + 1}. ${cap(l, 1500)}`)
            .join("\n")}\n`
        : "",
    )
    .replace(
      "{result}",
      params.result ? JSON.stringify(params.result, null, 1).slice(0, 8000) : "(no RESULT block)",
    )
    .replace("{evidence}", renderEvidence(params.evidence))
    .replace("{diff}", cap(params.evidence.diffText || "(no diff)", 16_000))
    .replace("{final}", cap(params.finalText.slice(-3000), 3000));
  let text = "";
  let judge: string | null = null;
  let failures: Array<{ judge: string; error: string }> = [];
  try {
    const out = await params.judge({
      system: "You are a strict completion reviewer. Output strict JSON only.",
      prompt,
      maxTokens: 900,
      accept: (t) => parseLlmReview(t) !== null,
    });
    if (typeof out === "string") text = out;
    else {
      text = out.text;
      judge = out.judge ?? null;
      failures = out.failures ?? [];
    }
  } catch (err) {
    failures.push({ judge: "judge", error: err instanceof Error ? err.message : String(err) });
    text = "";
  }
  const why = failures
    .filter((f) => !/CLI not installed/.test(f.error))
    .map((f) => `${f.judge}: ${f.error}`)
    .join("; ")
    .slice(0, 400);
  if (!text.trim()) {
    return {
      available: false,
      verdict: "unavailable",
      unsupportedClaims: [],
      notes: why ? `LLM reviewer unavailable — ${why}` : "LLM reviewer unavailable",
      judge: null,
      judgeFailures: failures.slice(0, 12),
    };
  }
  const parsed = parseLlmReview(text);
  if (!parsed) {
    return {
      available: false,
      verdict: "unavailable",
      unsupportedClaims: [],
      notes: `LLM reviewer response unparseable: ${text.slice(0, 120)}`,
      judge,
      judgeFailures: failures.slice(0, 12),
    };
  }
  return { ...parsed, judge, ...(failures.length ? { judgeFailures: failures.slice(0, 12) } : {}) };
}

export function composeVerdict(params: {
  classification: ExitClassification;
  evidence: EvidenceReport;
  visualFiles: string[];
  llm: LlmReview | null;
}): ReviewOutcome {
  const { classification, evidence, visualFiles, llm } = params;
  const result = classification.result;
  const reasons: string[] = [];
  const fixable: string[] = [];
  const warnings = environmentWarnings(evidence);

  // Hard failure: the process failed with nothing to show.
  if (classification.kind === "failed") {
    return {
      verdict: "FAILED",
      reasons: classification.reasons,
      fixable: [],
      warnings: [],
      visualFiles,
      visualSatisfied: false,
      llm,
    };
  }

  // Re-run contradicts a claimed pass → FAILED.
  const contradicted = evidence.items.filter(
    (i) => i.kind === "command" && i.status === "fail" && /claimed exit 0/.test(i.detail),
  );
  if (contradicted.length > 0) {
    for (const c of contradicted)
      reasons.push(`claimed-passing check fails on re-run: ${c.ref} (${c.detail})`);
    return {
      verdict: "FAILED",
      reasons,
      fixable: contradicted.map((c) => `\`${c.ref}\` fails when re-run — fix it and re-run it`),
      warnings: environmentWarnings(evidence),
      visualFiles,
      visualSatisfied: false,
      llm,
    };
  }

  if (!result) {
    reasons.push(...classification.reasons);
    fixable.push("end your final message with the RESULT block");
  } else if (result.status === "blocked" || result.status === "needs_input") {
    reasons.push(
      `agent reported ${result.status}: ${result.open_issues.join("; ") || result.summary}`,
    );
  } else if (classification.kind === "premature") {
    reasons.push(...classification.reasons);
    fixable.push("wait for the background work you started, read its output, then report");
  }

  const incidental = llm?.available ? incidentalClaimSet(llm) : [];
  for (const item of evidence.items) {
    if (item.status !== "fail") continue;
    // A failed vision assessment is a finding about the screenshots, handled below.
    if (item.kind === "visual") continue;
    // Scope: a claim the reviewer judged incidental to the acceptance criteria
    // never blocks (and is never demanded back from the worker).
    if (item.kind === "claim" && isIncidental(item.ref.split(" ← ")[0], incidental)) {
      warnings.push(`incidental claim not proven (not required by the task): ${item.ref} — ${item.detail}`);
      continue;
    }
    reasons.push(`${item.kind}: ${item.ref} — ${item.detail}`);
    fixable.push(`${item.kind} evidence failed: ${item.ref} — ${item.detail}`);
  }

  // Visual rule.
  const validShots = evidence.items.filter((i) => i.kind === "screenshot" && i.status === "pass");
  const visionFail = evidence.items.find((i) => i.kind === "visual" && i.status === "fail");
  const visualSatisfied = visualFiles.length === 0 || (validShots.length > 0 && !visionFail);
  if (visualFiles.length > 0 && validShots.length > 0 && visionFail) {
    reasons.push(`visual check failed: ${visionFail.detail}`);
    fixable.push(
      `the visual_verify vision review failed — fix the UI and re-run visual_verify: ${visionFail.detail}`,
    );
  }
  if (!visualSatisfied && !visionFail) {
    reasons.push(
      `visual files changed (${visualFiles.slice(0, 5).join(", ")}${visualFiles.length > 5 ? ", …" : ""}) but no valid screenshots were provided`,
    );
    fixable.push(
      "this run changed visual files — build the UI and call the `visual_verify` tool on the affected routes (desktop + mobile), check the screenshots match the intent, and list their paths in RESULT.screenshots",
    );
  }

  if (llm?.available) {
    if (llm.verdict !== "supported") {
      const envClaims = evidence.items
        .filter((i) => i.kind === "claim" && i.environment)
        .map((i) => i.ref.split(" ← ")[0]);
      for (const u of llm.unsupportedClaims.slice(0, 8)) {
        if (u.critical === false || isIncidental(u.claim, incidental)) {
          warnings.push(`incidental claim not proven (not required by the task): "${u.claim}" — ${u.why}`);
          continue;
        }
        if (isEnvironmentOnlyObjection(u, envClaims)) {
          warnings.push(
            `reviewer could not confirm "${u.claim}" — gateway re-run blocked by its environment`,
          );
          continue;
        }
        reasons.push(`reviewer: unsupported claim "${u.claim}" — ${u.why}`);
        fixable.push(`back this claim with evidence or drop it: "${u.claim}" (${u.why})`);
      }
      if (llm.unsupportedClaims.length === 0)
        reasons.push(`reviewer: ${llm.verdict} — ${llm.notes}`);
    }
  } else if (result?.status === "done") {
    // No model reachable: only trust the report when every claim was proven
    // deterministically (no "warn" = unchecked claims).
    const unproven = evidence.items.filter((i) => i.kind === "claim" && i.status !== "pass");
    if (unproven.length > 0) {
      reasons.push(
        `LLM reviewer unavailable and ${unproven.length} claim(s) could not be proven deterministically${llm?.notes && llm.notes !== "LLM reviewer unavailable" ? ` (${llm.notes.replace(/^LLM reviewer unavailable — /, "").slice(0, 240)})` : ""}`,
      );
    }
  }

  const verdict: Verdict =
    reasons.length === 0 && result?.status === "done" ? "VERIFIED" : "UNVERIFIED";
  return { verdict, reasons, fixable, warnings, visualFiles, visualSatisfied, llm };
}

function incidentalClaimSet(llm: LlmReview): string[] {
  return [
    ...(llm.incidentalClaims ?? []),
    ...llm.unsupportedClaims.filter((u) => u.critical === false).map((u) => u.claim),
  ];
}

/** Claim text matches one the reviewer marked incidental (loose, prefix-tolerant). */
export function isIncidental(claim: string, incidental: string[]): boolean {
  const c = norm(claim);
  if (!c) return false;
  return incidental.some((i) => {
    const n = norm(i);
    return Boolean(n) && (c === n || (n.length > 24 && (c.includes(n) || n.includes(c))));
  });
}

function environmentWarnings(evidence: EvidenceReport): string[] {
  const env = evidence.items.filter(
    (i) => (i.environment || i.baseline) && i.kind === "command",
  );
  const claimOnly = evidence.items.filter(
    (i) => i.environment && i.kind === "claim" && !env.some((c) => i.detail === c.detail),
  );
  return [...env, ...claimOnly].map((i) => `${i.kind}: ${i.ref} — ${i.detail}`);
}

const ENV_WHY_RE =
  /exit(?:ed)?(?: with)?(?: code)? 127|command not found|not found on the gateway|engines?\b|Node (?:v?20|version)|could not re-run \(environment\)|gateway'?s? environment/i;

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The reviewer objected to a claim only because the gateway could not re-run
 * it: the claim is one whose re-run was environment-blocked, or the reviewer's
 * reason cites the environment failure itself.
 */
export function isEnvironmentOnlyObjection(
  u: { claim: string; why: string },
  envClaims: string[],
): boolean {
  if (envClaims.length === 0) return false;
  const c = norm(u.claim);
  const matchesEnvClaim = envClaims.some((e) => {
    const n = norm(e);
    return Boolean(n) && (c.includes(n) || n.includes(c));
  });
  return matchesEnvClaim || ENV_WHY_RE.test(u.why);
}
