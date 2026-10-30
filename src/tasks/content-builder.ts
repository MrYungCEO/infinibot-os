/**
 * Task content builder.
 *
 * Every task-creation callsite — CLI, gateway RPC, MCP tool, autonomy
 * orchestrator, subagent registry — feeds its known signal through
 * `buildTaskContent` so the resulting `KanbanTask.content` field carries a
 * markdown body scaled to the task's complexity. This is what powers the
 * "robust tasks generate a workspace skill" pipeline alongside
 * `auto-skill.ts`.
 *
 * Goals:
 *   - Always produce a non-empty string (never throw on missing fields).
 *   - Depth scales with `complexity`: trivial → one line; robust → full
 *     headings + artifacts + auto-skill footer.
 *   - Heuristic in `inferComplexity` is intentionally simple and readable —
 *     no ML, no scoring weights to tune. Easy to grep, easy to predict.
 */
import type { KanbanTask, TaskComplexity, TaskSkillRef } from "./types.js";

export interface BuildTaskContentInput {
  title: string;
  complexity?: TaskComplexity;
  /** What was done, in plain prose. */
  what?: string;
  /** Where it lives — file paths, repo URL, target surface. */
  where?: string;
  /** Free-form additional details, decisions, follow-ups. */
  details?: string;
  /** External-facing artifacts (PR URLs, files, dashboards). */
  artifacts?: Array<{ label: string; url?: string; path?: string }>;
  /** If a workspace skill was auto-generated, render a footer linking it. */
  skillRef?: TaskSkillRef;
}

/**
 * Heuristic for picking a complexity bucket when the caller doesn't pass
 * one. Reads only fields that are commonly populated on agent-created
 * tasks; falls back to `simple` for an empty stub. The thresholds are
 * deliberately chunky so the bucket is predictable from the inputs:
 *
 *   - title  ≥ 12 words      → robust
 *   - tags/tools ≥ 3, or multiline description, or title ≥ 6 words → standard
 *   - title ≥ 3 words or any description                            → simple
 *   - otherwise                                                     → trivial
 */
export function inferComplexity(task: Partial<KanbanTask>): TaskComplexity {
  const title = (task.title ?? "").trim();
  const titleWords = title ? title.split(/\s+/).filter(Boolean).length : 0;
  const description = (task.description ?? "").trim();
  const descLines = description ? description.split(/\r?\n/).filter(Boolean).length : 0;
  const tagCount = Array.isArray(task.tags) ? task.tags.length : 0;
  const toolCount = Array.isArray(task.requiredTools) ? task.requiredTools.length : 0;
  const specialtyCount = Array.isArray(task.requiredSpecialties)
    ? task.requiredSpecialties.length
    : 0;

  if (titleWords >= 12) return "robust";
  if (descLines >= 4) return "robust";
  if (tagCount + toolCount + specialtyCount >= 5) return "robust";
  if (descLines >= 2 || titleWords >= 6 || tagCount + toolCount + specialtyCount >= 3) {
    return "standard";
  }
  if (titleWords >= 3 || description.length > 0) return "simple";
  return "trivial";
}

function renderArtifactsBlock(artifacts: BuildTaskContentInput["artifacts"]): string {
  if (!artifacts || artifacts.length === 0) return "";
  const lines = ["### Artifacts"];
  for (const art of artifacts) {
    const where = art.url ?? art.path ?? "";
    lines.push(where ? `- [${art.label}](${where})` : `- ${art.label}`);
  }
  return lines.join("\n");
}

function renderSkillFooter(skillRef: TaskSkillRef | undefined): string {
  if (!skillRef) return "";
  return [
    "---",
    `> Skill generated: **${skillRef.name}**`,
    `> Path: \`${skillRef.path}\``,
    `> Reason: ${skillRef.reason}`,
  ].join("\n");
}

function joinSections(parts: Array<string | undefined | null>): string {
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0)
    .join("\n\n");
}

/**
 * Convenience helper for the common pattern: take whatever fields a
 * callsite has (title/description/tags), infer complexity, and produce
 * `{ content, complexity }` ready to merge into the task payload before
 * persisting. Robust tasks are handled by callsites that follow up with
 * `maybeGenerateSkillForTask` and re-call this helper with `skillRef`.
 */
export function enrichTaskWithContent(input: {
  title: string;
  description?: string;
  tags?: string[];
  requiredTools?: string[];
  requiredSpecialties?: string[];
  what?: string;
  where?: string;
  details?: string;
  complexity?: TaskComplexity;
  artifacts?: BuildTaskContentInput["artifacts"];
  skillRef?: TaskSkillRef;
}): { content: string; complexity: TaskComplexity } {
  const complexity =
    input.complexity ??
    inferComplexity({
      title: input.title,
      description: input.description,
      tags: input.tags,
      requiredTools: input.requiredTools,
      requiredSpecialties: input.requiredSpecialties,
    });
  // Default the body fields off the inputs when callers don't supply them
  // — so trivial CLI calls still produce useful content.
  const what = input.what ?? (input.description ? input.description.split(/\r?\n/)[0] : undefined);
  const details =
    input.details ??
    (input.description && input.description.includes("\n") ? input.description : undefined);
  const content = buildTaskContent({
    title: input.title,
    complexity,
    what,
    where: input.where,
    details,
    artifacts: input.artifacts,
    skillRef: input.skillRef,
  });
  return { content, complexity };
}

/**
 * Build the markdown body for a task. Always returns a non-empty string —
 * callers can safely persist the result onto `KanbanTask.content`.
 */
export function buildTaskContent(input: BuildTaskContentInput): string {
  const title = (input.title || "Untitled task").trim();
  const complexity: TaskComplexity =
    input.complexity ?? inferComplexity({ title, description: input.details ?? input.what });

  const what = (input.what ?? "").trim();
  const where = (input.where ?? "").trim();
  const details = (input.details ?? "").trim();
  const skillFooter = renderSkillFooter(input.skillRef);

  if (complexity === "trivial") {
    // Single-line summary; ignore extras to keep cards readable.
    const summary = what || details || `Task: ${title}`;
    return summary.split(/\r?\n/)[0]!.trim();
  }

  if (complexity === "simple") {
    // 2–4 lines tops. Drop artifact links here; users open the full task
    // detail for those.
    const lines: string[] = [];
    if (what) lines.push(what.split(/\r?\n/).slice(0, 2).join(" "));
    if (where) lines.push(`Where: ${where}`);
    if (details && !what) lines.push(details.split(/\r?\n/).slice(0, 2).join(" "));
    if (lines.length === 0) lines.push(`Task: ${title}`);
    const body = lines.slice(0, 4).join("\n");
    return skillFooter ? `${body}\n\n${skillFooter}` : body;
  }

  if (complexity === "standard") {
    // Bulleted What / Where / Details — no headings (keeps card-detail compact).
    const lines: string[] = [];
    if (what) lines.push(`- **What:** ${what.replace(/\n+/g, " ")}`);
    if (where) lines.push(`- **Where:** ${where.replace(/\n+/g, " ")}`);
    if (details) lines.push(`- **Details:** ${details.replace(/\n+/g, " ")}`);
    if (lines.length === 0) lines.push(`- **What:** ${title}`);
    const artifactsBlock = renderArtifactsBlock(input.artifacts);
    return joinSections([lines.join("\n"), artifactsBlock, skillFooter]);
  }

  // robust: full headings + artifacts + skill footer
  const sections: string[] = [];
  sections.push(`# ${title}`);
  if (what) sections.push(`## What\n${what}`);
  if (where) sections.push(`## Where\n${where}`);
  if (details) sections.push(`## Details\n${details}`);
  const artifactsBlock = renderArtifactsBlock(input.artifacts);
  if (artifactsBlock) sections.push(artifactsBlock);
  if (skillFooter) sections.push(skillFooter);
  // Guarantee a body when robust was forced on a near-empty input.
  if (sections.length === 1) sections.push(`Task: **${title}**`);
  return sections.join("\n\n");
}
