/**
 * Workflow Skill Reference — guaranteed skill injection for workflow steps.
 *
 * Lets workflow definitions declare `requires_skills: [...]` so the named
 * skills are guaranteed to appear in the agent's preamble even if the
 * automatic heuristic (keyword detection) would miss them.
 *
 * Usage in a workflow template frontmatter:
 *   requires_skills:
 *     - browser-selector-strategy
 *     - browser-oauth-flow
 *
 * The runner calls `injectRequiredSkillsIntoPreamble` before spawning the agent.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("workflows").child("skill-reference");

// ── Resolution ────────────────────────────────────────────────────────────────

/** Directories searched for named skills, in priority order (last wins on name conflict). */
const SKILL_SEARCH_DIRS = [
  join(homedir(), ".infinibot", "skills", "browser"),
  join(homedir(), ".infinibot", "skills"),
  join(homedir(), ".claude", "skills"),
] as const;

interface ResolvedSkill {
  name: string;
  filePath: string;
  description: string;
}

/** Find a named skill's SKILL.md across all known skill directories. */
function resolveSkill(name: string): ResolvedSkill | null {
  for (const dir of SKILL_SEARCH_DIRS) {
    const candidate = join(dir, name, "SKILL.md");
    if (existsSync(candidate)) {
      return { name, filePath: candidate, description: readSkillDescription(candidate) };
    }
  }
  log.warn(`skill-reference: skill "${name}" not found in any search dir`);
  return null;
}

function readSkillDescription(filePath: string): string {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const match = raw.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

// ── Block builders ────────────────────────────────────────────────────────────

/**
 * Build an XML block listing the explicitly-required skills.
 * Uses the same `<available_browser_skills>` format that browser-task
 * detection uses so agents apply a consistent reading pattern.
 */
export function buildRequiredSkillsBlock(skillNames: string[]): string {
  if (skillNames.length === 0) return "";

  const resolved: ResolvedSkill[] = [];
  for (const name of skillNames) {
    const skill = resolveSkill(name);
    if (skill) resolved.push(skill);
  }
  if (resolved.length === 0) return "";

  const lines = resolved
    .map(
      (s) =>
        `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.filePath}</location>\n  </skill>`,
    )
    .join("\n");

  return [
    "### Workflow Required Skills",
    "This workflow explicitly requires the following skills. Read the SKILL.md at the",
    "specified location before taking any action in that domain.",
    "",
    "<required_skills>",
    lines,
    "</required_skills>",
  ].join("\n");
}

/**
 * Inject required-skills block into an existing preamble string.
 * If the preamble already contains a Self-Healing Protocol section, the skills
 * block is inserted just before it so agents see it early.
 */
export function injectRequiredSkillsIntoPreamble(preamble: string, skillNames: string[]): string {
  if (skillNames.length === 0) return preamble;
  const block = buildRequiredSkillsBlock(skillNames);
  if (!block) return preamble;

  const insertBefore = "### Self-Healing Protocol";
  const idx = preamble.indexOf(insertBefore);
  if (idx === -1) {
    return preamble + "\n\n" + block;
  }
  return preamble.slice(0, idx) + block + "\n\n" + preamble.slice(idx);
}

// ── Frontmatter parser ────────────────────────────────────────────────────────

/**
 * Extract `requires_skills` from a workflow body or frontmatter string.
 * Accepts YAML list format:
 *   requires_skills:
 *     - browser-selector-strategy
 *     - browser-oauth-flow
 * OR inline array:
 *   requires_skills: [browser-selector-strategy, browser-oauth-flow]
 */
export function parseRequiredSkills(workflowBody: string): string[] {
  // Block list format
  const blockMatch = workflowBody.match(/^requires_skills:\s*\n((?:\s+-\s+\S+\n?)+)/m);
  if (blockMatch) {
    return blockMatch[1]
      .split("\n")
      .map((l) => l.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean);
  }

  // Inline array format
  const inlineMatch = workflowBody.match(/^requires_skills:\s*\[([^\]]+)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  return [];
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface SkillReferenceStatus {
  name: string;
  resolved: boolean;
  filePath?: string;
}

/** Check which of the named skills can actually be found on disk. */
export function checkSkillsAvailable(skillNames: string[]): SkillReferenceStatus[] {
  return skillNames.map((name) => {
    const skill = resolveSkill(name);
    return skill ? { name, resolved: true, filePath: skill.filePath } : { name, resolved: false };
  });
}

/** List all browser skills available in the browser skill dir. */
export function listBrowserSkills(): ResolvedSkill[] {
  const browserDir = join(homedir(), ".infinibot", "skills", "browser");
  if (!existsSync(browserDir)) return [];
  try {
    return readdirSync(browserDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const fp = join(browserDir, d.name, "SKILL.md");
        return existsSync(fp)
          ? { name: d.name, filePath: fp, description: readSkillDescription(fp) }
          : null;
      })
      .filter((s): s is ResolvedSkill => s !== null);
  } catch {
    return [];
  }
}
