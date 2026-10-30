/**
 * Goal texts for the three standard stages. The goal runner appends the
 * completion checks and its own rules; these texts carry the contract.
 */

import { join } from "node:path";
import { EXAMPLE_REPORT, REPORT_TEMPLATE_ID } from "./report-schema.js";
import type { PipelineItem, ScheduledTask } from "./types.js";

export function reportPath(artifactDir: string): string {
  return join(artifactDir, "report.json");
}

export function validatorPath(artifactDir: string): string {
  return join(artifactDir, "validate-report.mjs");
}

export function buildSuggestionGoal(task: ScheduledTask, artifactDir: string): string {
  const repos = task.repos
    .map((r) => {
      const lines = [
        `- label: ${r.label}`,
        `  path: ${r.path}`,
        `  branch: ${r.branch ?? "(current HEAD)"}`,
      ];
      if (r.focus?.length) lines.push(`  focus: ${r.focus.join(", ")}`);
      if (r.notes) lines.push(`  notes: ${r.notes}`);
      return lines.join("\n");
    })
    .join("\n");
  return [
    `Scheduled review "${task.name}" — produce a WORK SUGGESTION REPORT (${REPORT_TEMPLATE_ID}).`,
    `## Repositories to review\n${repos || "(none configured)"}`,
    task.instructions.trim() ? `## Owner instructions\n${task.instructions.trim()}` : "",
    `## READ-ONLY — hard rules
- Do NOT edit, create or delete files inside any repository. Do NOT commit, checkout, switch branches, stash, reset, merge, rebase, push, deploy, or open/close PRs or issues.
- Read-only commands only: git log/status/diff/show/branch/rev-list/for-each-ref (use \`git -C <path> …\` and name the branch explicitly, e.g. \`git -C <path> log <branch>\`), reading files, \`gh pr list\`, \`gh issue list\`, \`gh run list\` (when a GitHub remote exists), and running existing tests ONLY if they do not write into the repo.
- The ONLY file you may write is ${reportPath(artifactDir)} (your working directory is ${artifactDir}).
- Branch refs are snapshotted before and after; any moved ref is reported to the owner as a violation.`,
    `## What to collect per repository
branch, ahead/behind vs upstream (or vs main), open PRs and issues, latest CI status, failing tests, uncommitted changes count, stale branches (>30 days, unmerged), and deploy status when you can detect it (deploy configs, recent deploy commits, a health URL).`,
    `## What to suggest
Up to ${task.limits.maxItems} concrete, high-value work items, most important first. For each: why it matters (with evidence: file:line, failing job, log line), priority P0–P3, effort S/M/L, risk low/medium/high, files/areas, a DEV plan (ordered steps), TEST/verification checks the gateway will run in the dev worktree (goal-check format — prefer deterministic shell/grep/file checks; \`llm\` {criterion} only when nothing deterministic fits), a DEPLOY plan with rollback (optionally an exact \`deploy.command\` and post-deploy \`deploy.checks\`${task.deployCommand ? `; the owner configured the deploy command \`${task.deployCommand}\`, which is what will run — do not propose another` : ""}), and the approvals it needs. \`repo\` must be one of the labels above. Checks run from the root of a fresh worktree of that repo's branch, so use repo-relative paths. Every item will be implemented by an agent in an isolated git worktree only after the owner approves it.`,
    `## Output contract
Write strict JSON to ${reportPath(artifactDir)} matching this shape (no markdown, no comments):
\`\`\`json
${JSON.stringify(EXAMPLE_REPORT, null, 2)}
\`\`\`
Check types: shell {command[,timeoutSec]} passes on exit 0 · file {path[,negate]} · grep {path,pattern[,negate]} · llm {criterion}.
Validate before you stop: \`node ${validatorPath(artifactDir)}\` must print "report.json is valid". If there is genuinely nothing worth doing, return an empty "items" array with a summary saying so.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildDevGoal(task: ScheduledTask, item: PipelineItem): string {
  const w = item.item;
  return [
    `Implement approved work item "${w.title}" (${w.priority}, effort ${w.effort}, risk ${w.risk}) from the scheduled review "${task.name}".`,
    `## Why\n${w.why}`,
    w.files.length ? `## Files / areas\n${w.files.map((f) => `- ${f}`).join("\n")}` : "",
    `## Dev plan\n${w.dev.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    item.instructions.length
      ? `## Owner instructions (take precedence over the plan)\n${item.instructions.map((s) => `- ${s}`).join("\n")}`
      : "",
    `## Rules
- Work ONLY inside this git worktree (${item.worktreePath}) on branch ${item.branch}. Commit your work on this branch with clear messages.
- Do NOT push, merge into other branches, open PRs, or deploy anything — deployment is a separate stage that needs the owner's approval.
- Do not touch files unrelated to this item.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildDeployGoal(task: ScheduledTask, item: PipelineItem): string {
  const w = item.item;
  return [
    `The owner APPROVED deploying work item "${w.title}" (scheduled review "${task.name}"). Execute the deploy plan below from the worktree ${item.worktreePath} (branch ${item.branch}).`,
    `## Deploy plan\n${w.deploy.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `## Rollback (use it if the deploy breaks something, then report what happened)\n${w.deploy.rollback}`,
    item.instructions.length
      ? `## Owner instructions\n${item.instructions.map((s) => `- ${s}`).join("\n")}`
      : "",
    item.diffSummary ? `## What was built\n${item.diffSummary}` : "",
    "## Rules\nOnly perform the steps in the deploy plan. Report exactly what you ran and the evidence that the deploy is healthy.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
