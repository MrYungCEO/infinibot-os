/**
 * Tester subagent — system prompt + verdict parser.
 *
 * The tester is spawned by the orchestrator after each build iteration. It
 * uses the Playwright MCP (via the `mcp` agent tool) to navigate to the
 * test targets defined in the task's pre-fire questionnaire, observe the
 * page state, and emit a strict JSON verdict that the orchestrator parses
 * to decide whether to mark the task complete, feed back fix hints, or
 * stop on iteration cap.
 *
 * The prompt deliberately constrains the tester:
 *   - it MUST use Playwright via `mcp invoke { mcp: "playwright", ... }`
 *   - it MUST end its reply with a fenced JSON block containing the
 *     verdict shape parsed below
 *   - it MUST NOT edit code; verification only
 */

import type { PrefireQuestions, QueuedTask, TaskIteration, TesterVerdict } from "./types.js";

/**
 * Build the prompt the tester subagent receives. Keep it self-contained so
 * the spawn call doesn't need to pass extra context channels.
 */
export function buildTesterPrompt(
  task: QueuedTask,
  prefire: PrefireQuestions,
  iteration: TaskIteration,
): string {
  const targets =
    prefire.testTargets.length > 0
      ? prefire.testTargets
          .map((t, i) => {
            const parts: string[] = [`${i + 1}. ${t.description}`];
            if (t.url) parts.push(`   url: ${t.url}`);
            if (t.selector) parts.push(`   selector: ${t.selector}`);
            if (t.expect) parts.push(`   expect: ${t.expect}`);
            return parts.join("\n");
          })
          .join("\n")
      : "(no explicit targets — exercise the changed surface implied by the success criteria)";

  const buildContext = iteration.buildSummary
    ? `## What the builder just did\n${iteration.buildSummary}\n\n`
    : "";

  return `# Tester Agent — Iteration ${iteration.number}

You are the autonomous **tester** for the task below. The builder agent just
finished an iteration; your job is to verify whether the work meets the
success criteria. **You do not edit code.** You only observe and report.

## Task
**${task.title}**

${task.description}

## Success criteria (from pre-fire questionnaire)
${prefire.successCriteria}

## Targets to verify
${targets}

${buildContext}## How to verify

You have the \`mcp\` tool. Use the **playwright** MCP to drive a real
browser:

\`\`\`
mcp invoke { "mcp": "playwright", "tool": "browser_navigate", "args": { "url": "..." } }
mcp invoke { "mcp": "playwright", "tool": "browser_snapshot" }
mcp invoke { "mcp": "playwright", "tool": "browser_click", "args": { "element": "...", "ref": "..." } }
\`\`\`

Walk each target: navigate, observe, capture evidence, decide whether the
success criterion is met. Be specific about what you saw — selectors,
text contents, screenshots, network responses, console errors.

## Required output

End your reply with **exactly one** fenced JSON block matching this shape
(the orchestrator parses it). No prose after the closing fence.

\`\`\`json
{
  "pass": true | false,
  "summary": "1-2 sentences — what you concluded and why",
  "reasons": ["discrete observation 1", "observation 2", "..."],
  "evidence": ["url or selector or text snippet", "..."],
  "fixHints": ["specific instruction for the builder if pass=false"]
}
\`\`\`

- If \`pass\` is false, \`fixHints\` MUST be non-empty and actionable — the
  builder agent will use them as its next prompt.
- If \`pass\` is true, \`fixHints\` should be \`[]\`.
- Do not invent passes. If you can't reach a target (e.g. dev server down),
  set \`pass: false\` with a \`fixHints\` entry telling the builder to bring
  the surface back up.

Begin.`;
}

/**
 * Parse the tester's reply into a structured verdict. Tolerates extra prose
 * around the JSON block; returns a "fail with reason" verdict if no valid
 * JSON is found, so the orchestrator can still feed something useful back
 * to the builder instead of crashing.
 */
export function parseTesterVerdict(rawReply: string): TesterVerdict {
  const fallback = (reason: string): TesterVerdict => ({
    pass: false,
    summary: `Could not parse tester verdict: ${reason}`,
    reasons: [reason],
    evidence: [],
    fixHints: [
      "Re-run the verification and emit the required JSON block as the last lines of the reply.",
    ],
    rawOutput: rawReply,
  });

  if (!rawReply || !rawReply.trim()) {
    return fallback("empty reply from tester");
  }

  // Prefer a fenced ```json … ``` block; fall back to the last {...} blob.
  const fenced = rawReply.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let payload: string | null = null;
  if (fenced && fenced[1]) {
    payload = fenced[1].trim();
  } else {
    const lastOpen = rawReply.lastIndexOf("{");
    const lastClose = rawReply.lastIndexOf("}");
    if (lastOpen >= 0 && lastClose > lastOpen) {
      payload = rawReply.slice(lastOpen, lastClose + 1);
    }
  }
  if (!payload) {
    return fallback("no JSON block found");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch (e) {
    return fallback(`JSON parse error: ${String(e)}`);
  }

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const pass = parsed.pass === true;
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : pass
        ? "Tester verdict: pass"
        : "Tester verdict: fail (no summary)";
  const reasons = asStringArray(parsed.reasons);
  const evidence = asStringArray(parsed.evidence);
  let fixHints = asStringArray(parsed.fixHints);

  // Enforce the contract: a failing verdict must carry at least one hint so
  // the builder has something concrete to act on next iteration.
  if (!pass && fixHints.length === 0) {
    fixHints = [
      "Re-examine the failed reasons above and produce a fix. Tester did not provide hints.",
    ];
  }

  return {
    pass,
    summary,
    reasons,
    evidence,
    fixHints,
    rawOutput: rawReply,
  };
}

/**
 * Build the builder prompt for the *next* iteration based on the prior
 * verdict's fix hints. The first iteration uses the task's own description.
 */
export function buildBuilderPrompt(
  task: QueuedTask,
  prefire: PrefireQuestions,
  iteration: TaskIteration,
  previous?: TaskIteration,
): string {
  const head =
    `# Autonomous Build — Iteration ${iteration.number}\n\n` +
    `**Task:** ${task.title}\n\n` +
    `## Description\n${task.description}\n\n` +
    `## Success criteria\n${prefire.successCriteria}\n\n`;

  if (!previous || !previous.testerVerdict) {
    const notes = task.context?.instructions
      ? `## Instructions\n${task.context.instructions}\n\n`
      : "";
    const userNotes = prefire.notes ? `## Notes from operator\n${prefire.notes}\n\n` : "";
    return (
      head +
      notes +
      userNotes +
      "Implement the task end-to-end. When you finish your changes the tester " +
      "agent will verify the success criteria against the test targets. " +
      "Make whatever code, config, and dev-server changes are needed."
    );
  }

  const v = previous.testerVerdict;
  const hints =
    v.fixHints.length > 0
      ? v.fixHints.map((h, i) => `${i + 1}. ${h}`).join("\n")
      : "(no specific hints — re-read the failing reasons above and resolve them)";
  const reasons =
    v.reasons.length > 0
      ? v.reasons.map((r) => `- ${r}`).join("\n")
      : "(no specific reasons recorded)";

  return (
    head +
    `## Previous tester verdict (FAIL)\n${v.summary}\n\n` +
    `### Failing reasons\n${reasons}\n\n` +
    `### Fix instructions\n${hints}\n\n` +
    "Apply the fixes above and only the fixes above. Do not regress passing " +
    "criteria. The tester will rerun the full target list when you finish."
  );
}
