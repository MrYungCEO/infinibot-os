/**
 * Design page — prompt composer.
 *
 * Builds the open-design-style layered system prompt:
 *   DISCOVERY directives   (turn-1 question form, then 5-dim critique loop)
 *   + identity charter     (OFFICIAL_DESIGNER_PROMPT — anti-AI-slop)
 *   + active DESIGN.md     (full body inlined)
 *   + active SKILL.md      (full body inlined)
 *   + project metadata     (kind, fidelity, speakerNotes, animations)
 *   + workspace cwd        (the absolute path the agent is operating in)
 */

import { existsSync, readFileSync } from "fs";

import type { DesignProject, DesignSkill, DesignSystem } from "./types.js";

const OFFICIAL_DESIGNER_PROMPT = `You are a senior designer. Your bar is editorial — every piece looks like it
shipped to a real audience, not a portfolio shot. You're allergic to AI slop:
template marketing layouts, "abstract people shaking hands", three-feature-grid
fatigue, exclamation-point microcopy, "AI-powered" anywhere in headlines.

Default to **specific over generic**: pick a domain in the brief and write copy
for THAT domain, not a placeholder. Make typographic and color choices that
would survive a critique — restraint > maximalism unless the brief explicitly
asks for energy.

Use the active DESIGN.md as scripture: color, type, spacing, motion, voice. If
the system says "no gradients on buttons", don't put gradients on buttons.
Quote the section names in code comments above the relevant CSS so a reader
can audit.

Use real tools against a real filesystem. The cwd is your project workspace.
Write files; don't paste code into chat unless asked.`;

const DISCOVERY_RULES = `**RULE 1 — Discovery first.**

If the user's brief is missing surface, audience, tone, brand context, scale, or
constraints, your FIRST move on a fresh project is to ask a short structured
question form covering those gaps. Render it as a clean numbered list (1-6)
with one question per line. Don't write any code on turn 1 of a fresh brief.

Once you have the answers, proceed.

**RULE 2 — Show something visible early.**

After 1-2 reading/setup tool calls, get a first draft to disk so the user sees
something in the iframe preview. Wireframe-level is fine for the first pass;
you can refine after the user redirects.

**RULE 3 — Five-dimensional self-critique before declaring done.**

Before saying you're finished, score your own output on:
  · Philosophy   — does the brief's intent come through?
  · Hierarchy    — does the eye know where to go?
  · Detail       — is there at least one specific that wouldn't survive a "this looks AI" sniff test?
  · Function     — does every interactive element actually work?
  · Innovation   — did you do anything the user couldn't have specced themselves?

If any score is < 7/10, take one more revision pass.`;

interface BuildSystemPromptInput {
  project: DesignProject;
  skill: DesignSkill | null;
  system: DesignSystem | null;
}

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const parts: string[] = [DISCOVERY_RULES, OFFICIAL_DESIGNER_PROMPT];

  if (input.system) {
    parts.push(
      "",
      `## Active design system — ${input.system.name}`,
      "",
      readFileSafe(input.system.rootPath),
    );
  }

  if (input.skill) {
    const skillBody = readFileSafe(input.skill.rootDir + "/SKILL.md");
    parts.push(
      "",
      `## Active skill — ${input.skill.name}`,
      `Skill folder on disk: \`${input.skill.rootDir}\` — read \`assets/\` and \`references/\` from there with your file tools.`,
      "",
      skillBody,
    );
  }

  parts.push(
    "",
    "## Project metadata",
    `- Workspace cwd: \`${input.project.workspaceDir}\` — your file/exec/claude_coder tools operate here.`,
    `- Project kind: \`${input.project.kind}\``,
    input.project.brief
      ? [
          `- Surface: ${input.project.brief.surface}`,
          `- Audience: ${input.project.brief.audience}`,
          `- Tone: ${input.project.brief.tone}`,
          input.project.brief.brandContext
            ? `- Brand context: ${input.project.brief.brandContext}`
            : "",
          input.project.brief.scale ? `- Scale: ${input.project.brief.scale}` : "",
          input.project.brief.constraints
            ? `- Constraints: ${input.project.brief.constraints}`
            : "",
          input.project.brief.fidelity ? `- Fidelity target: ${input.project.brief.fidelity}` : "",
          input.project.brief.speakerNotes ? `- Speaker notes: yes` : "",
          input.project.brief.animations ? `- Motion / animations: yes` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "- No brief provided yet — open with the discovery question form (RULE 1).",
    "",
    "## Output discipline",
    "- Write files to the workspace cwd. Use relative paths — `index.html`, `styles.css`, `assets/hero.svg`.",
    "- The user is watching the iframe preview update live; promote your current best draft to `index.html`.",
    "- When you're done, end with a one-line summary + the 5-dimension scoresheet from RULE 3.",
  );

  return parts.filter(Boolean).join("\n");
}

function readFileSafe(path: string): string {
  try {
    if (!existsSync(path)) return `[file not found: ${path}]`;
    return readFileSync(path, "utf-8");
  } catch (err) {
    return `[failed to read ${path}: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/** Compose the initial user message for a brand-new project — kicks off RULE 1. */
export function buildInitialUserMessage(project: DesignProject): string {
  if (!project.brief) {
    return `Starting a new design project: "${project.name}" (${project.kind}). Open with the discovery question form per RULE 1 — I'll fill it in and we'll go from there.`;
  }
  const b = project.brief;
  const lines = [
    `Brief for "${project.name}":`,
    `- Surface: ${b.surface}`,
    `- Audience: ${b.audience}`,
    `- Tone: ${b.tone}`,
  ];
  if (b.brandContext) lines.push(`- Brand context: ${b.brandContext}`);
  if (b.scale) lines.push(`- Scale: ${b.scale}`);
  if (b.constraints) lines.push(`- Constraints: ${b.constraints}`);
  lines.push(
    "",
    "Build the first draft. Get a visible artifact to `index.html` quickly so we can iterate.",
  );
  return lines.join("\n");
}
