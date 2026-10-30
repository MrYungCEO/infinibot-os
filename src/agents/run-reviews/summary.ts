/**
 * summaryMarkdown generation for a run review.
 *
 * Primary path: ask a cheap+fast model (haiku) to write a stylish, in-depth
 * markdown summary from the run's transcript + activity. Robust fallback:
 * a templated markdown summary assembled deterministically when the model is
 * unavailable or errors. The caller always gets usable markdown.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { AUTO_REVIEW_MODEL } from "../auto-reviewer/from-transcript.js";
import type { RunReviewDraft } from "./derive.js";

const log = createSubsystemLogger("run-reviews/summary");

const MAX_LLM_RETRIES = 1;
const RETRY_DELAY_MS = 1_200;

const SYSTEM_PROMPT = `You are a senior engineer writing a post-run review of an AI coding agent's work.
Write a STYLISH, in-depth Markdown summary a human can skim in 30 seconds and trust.

Cover, using Markdown headings (##) and bullet lists:
- **What was done** — concrete outcomes, not restated instructions.
- **Half-done / not done** — anything incomplete or skipped.
- **Key decisions** — notable choices and why.
- **Issues** — bugs, risks, or blockers surfaced.
- **Built?** — whether it compiled / built, with the evidence.
- **Recommended next actions** — crisp, actionable.

Rules: be concrete and specific, reference real file paths when given, never
invent results, keep it under ~400 words. Output ONLY the Markdown body (no
code fence around the whole thing, no preamble).`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUserPrompt(draft: RunReviewDraft, transcriptTail: string): string {
  const lines: string[] = [];
  lines.push(`TASK / BRIEF:\n${draft.title}`);
  if (draft.task && draft.task !== draft.title) lines.push(`\nFULL TASK:\n${draft.task}`);
  lines.push(`\nOUTCOME STATUS: ${draft.status}`);
  lines.push(`DURATION: ${Math.round((draft.durationMs ?? 0) / 1000)}s`);
  if (draft.backend) lines.push(`BACKEND: ${draft.backend}`);
  lines.push(`BUILT: ${draft.built ? "yes" : "no / unknown"}`);
  if (draft.buildEvidence) lines.push(`BUILD EVIDENCE: ${draft.buildEvidence}`);
  if (draft.errorMessage) lines.push(`ERROR: ${draft.errorMessage.slice(0, 400)}`);

  if (draft.filesTouched.length) {
    lines.push(
      `\nFILES TOUCHED (${draft.filesTouched.length}):\n` +
        draft.filesTouched
          .slice(0, 40)
          .map(
            (f) =>
              `- ${f.changeKind} ${f.path}` +
              (f.linesAdded || f.linesRemoved
                ? ` (+${f.linesAdded ?? 0}/-${f.linesRemoved ?? 0})`
                : ""),
          )
          .join("\n"),
    );
  }
  if (draft.actions.length) {
    lines.push(
      `\nACTIVITY TIMELINE (last ${Math.min(draft.actions.length, 20)}):\n` +
        draft.actions
          .slice(-20)
          .map((a) => `- [${a.kind}] ${a.detail}`)
          .join("\n"),
    );
  }
  if (transcriptTail) {
    lines.push(`\nTRANSCRIPT TAIL (may be truncated):\n${transcriptTail.slice(-8_000)}`);
  }
  return lines.join("\n");
}

async function callLLM(draft: RunReviewDraft, transcriptTail: string): Promise<string | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    try {
      const { runLLM } = await import("../../services/email/llm-analysis.js");
      const result = await runLLM({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(draft, transcriptTail),
        model: AUTO_REVIEW_MODEL,
        maxTokens: 900,
        temperature: 0.3,
      });
      const text = result.text.trim();
      if (text.length > 20) return text;
      throw new Error("LLM returned empty/too-short summary");
    } catch (err) {
      lastErr = err;
      log.warn("run-reviews: summary LLM call failed", {
        attempt,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.warn("run-reviews: all summary attempts failed, using template", {
    err: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  return null;
}

/** Deterministic markdown used when the model is unavailable. */
export function buildTemplatedSummary(draft: RunReviewDraft): string {
  const durationSec = Math.round((draft.durationMs ?? 0) / 1000);
  const fileCount = draft.filesTouched.length;
  const statusLine: Record<string, string> = {
    built: "completed and build evidence was captured",
    not_built: "completed, but no successful build was observed",
    partial: "ended with an error after landing some changes",
    failed: "failed before completing meaningful work",
    in_progress: "was still running when this snapshot was taken",
  };

  const out: string[] = [];
  out.push(`## Summary`);
  out.push(
    `Agent **${draft.title}** ${statusLine[draft.status] ?? "ran"} in ${durationSec}s, touching ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
  );

  if (fileCount) {
    out.push(`\n## Files touched`);
    for (const f of draft.filesTouched.slice(0, 25)) {
      const delta =
        f.linesAdded || f.linesRemoved ? ` (+${f.linesAdded ?? 0}/-${f.linesRemoved ?? 0})` : "";
      out.push(`- \`${f.path}\` — ${f.changeKind}${delta}`);
    }
    if (fileCount > 25) out.push(`- …and ${fileCount - 25} more`);
  }

  out.push(`\n## Built?`);
  out.push(
    draft.built
      ? `Yes.${draft.buildEvidence ? ` Evidence: ${draft.buildEvidence}` : ""}`
      : `No successful build was captured for this run.`,
  );

  if (draft.issues.length) {
    out.push(`\n## Issues`);
    for (const i of draft.issues.slice(0, 10)) out.push(`- **${i.severity}** — ${i.text}`);
  }

  if (draft.forwardActions.length) {
    out.push(`\n## Recommended next actions`);
    for (const a of draft.forwardActions) out.push(`- ${a.label}`);
  }

  return out.join("\n");
}

/**
 * Generate the summaryMarkdown for a draft. Always returns usable markdown:
 * LLM output when possible, otherwise the templated fallback. The second
 * return value flags whether the LLM path succeeded.
 */
export async function generateSummaryMarkdown(
  draft: RunReviewDraft,
  transcriptTail: string,
): Promise<{ markdown: string; fromLLM: boolean }> {
  let llm: string | null = null;
  try {
    llm = await callLLM(draft, transcriptTail);
  } catch (err) {
    log.warn("run-reviews: generateSummaryMarkdown threw", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  if (llm) return { markdown: llm, fromLLM: true };
  return { markdown: buildTemplatedSummary(draft), fromLLM: false };
}
