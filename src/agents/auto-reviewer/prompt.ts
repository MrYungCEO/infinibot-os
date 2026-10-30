/**
 * Prompt template for LLM-generated agent reviews.
 *
 * Constraints enforced via prompt:
 *   - Summary: 1–3 sentences, plain language, 6th-grade reading level
 *   - Next steps: plain-language bullets, max 5
 *   - No corporate fluff; concrete and actionable
 */

export type ReviewPromptContext = {
  task: string;
  label?: string;
  status: string;
  durationSec: number;
  filesTouched: Array<{ path: string; action: string }>;
  lastProgressUpdates: string[];
  workdir?: string;
  errorMessage?: string;
};

export const REVIEW_SYSTEM_PROMPT = `You write short post-task reviews for AI coding agents. Plain English. Sixth-grade reading level. No corporate jargon, no fluff.

Format your response as JSON with exactly these fields:
{
  "summary": "<1-3 sentences describing what the agent did and whether it worked>",
  "nextSteps": ["<step 1>", "<step 2>", ...],  // max 5, concrete actions
  "blockers": ["<blocker>", ...],  // what stopped the agent or remains broken, if anything
  "confidence": "high" | "medium" | "low"  // how confident are you the work is complete and correct?
}

Rules:
- summary: 1–3 sentences MAX. State what was done and the outcome. No padding.
- nextSteps: concrete things a human or another agent should do next. Empty array [] if nothing needed.
- blockers: things that are actively broken or incomplete. Empty array [] if clean finish.
- confidence: "high" = looks done; "medium" = probably done but hard to verify; "low" = unclear, errors, or left incomplete.`;

export function buildReviewPrompt(ctx: ReviewPromptContext): string {
  const lines: string[] = [];
  lines.push(`Task: ${ctx.task.slice(0, 800)}`);
  if (ctx.label) lines.push(`Label: ${ctx.label}`);
  lines.push(`Status: ${ctx.status}`);
  lines.push(`Duration: ${ctx.durationSec}s`);
  if (ctx.workdir) lines.push(`Working directory: ${ctx.workdir}`);
  if (ctx.errorMessage) lines.push(`Error: ${ctx.errorMessage.slice(0, 400)}`);

  if (ctx.filesTouched.length > 0) {
    lines.push("");
    lines.push(`Files touched (${ctx.filesTouched.length}):`);
    for (const f of ctx.filesTouched.slice(0, 30)) {
      lines.push(`  ${f.action.toUpperCase()} ${f.path}`);
    }
    if (ctx.filesTouched.length > 30) {
      lines.push(`  … and ${ctx.filesTouched.length - 30} more`);
    }
  }

  if (ctx.lastProgressUpdates.length > 0) {
    lines.push("");
    lines.push("Recent progress updates:");
    for (const u of ctx.lastProgressUpdates.slice(-10)) {
      lines.push(`  - ${u.slice(0, 200)}`);
    }
  }

  lines.push("");
  lines.push("Write a review JSON for this agent run.");
  return lines.join("\n");
}
