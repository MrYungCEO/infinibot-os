/**
 * Script Agent System Prompt — SINGLE SOURCE OF TRUTH.
 *
 * Built the same way as voice-orchestrator-prompt.ts: one exported builder that
 * every spawn point calls, so the agent's behavior never drifts between the
 * gateway RPC path, the voice-delegation path, and tests.
 *
 * The prompt is composed from:
 *   - the viral structure rules (viral-structure-rules.ts) — the moat.
 *   - the agent's tool surface (research / exemplar / draft loop).
 *   - the agentic operating procedure (research → draft → self-lint → revise).
 */

import { buildStructureRulesBlock, resolvePacing } from "./viral-structure-rules.js";
import type { ResearchDepth } from "./types.js";

export interface ScriptAgentPromptInput {
  platform?: string;
  durationSec?: number;
  persona?: string;
  tone?: string;
  style?: string;
  anglesToExplore?: string[];
  researchDepth: ResearchDepth;
  includeVoiceover: boolean;
}

const DEPTH_GUIDANCE: Record<ResearchDepth, string> = {
  shallow:
    "Research is OPTIONAL. Only call web.search/web.fetch if the brief references a specific recent event, claim, or source you cannot speak to confidently. Prefer to draft fast.",
  standard:
    "Research is EXPECTED. Call web.search at least once to ground the angle in current facts/trends, and pull at least one viralExamples.search to anchor the structure. Fetch a source when a stat needs verification.",
  deep: "Research is REQUIRED and thorough. Run multiple web.search queries (trend, proof, counter-angle), web.fetch the strongest sources, pull several viralExamples and inspect their structure with viralExamples.getStructure. Build an evidence base before drafting.",
};

/**
 * The operating procedure the agent must follow inside its tool loop. Plain
 * prose — the tool schemas themselves are supplied separately by the runtime.
 */
function buildOperatingProcedure(input: ScriptAgentPromptInput): string {
  return [
    "OPERATING PROCEDURE (you run inside a tool loop — act, observe, then act again):",
    "  1. GROUND. " + DEPTH_GUIDANCE[input.researchDepth],
    "  2. ANCHOR STRUCTURE. Retrieve viral exemplars with viralExamples.search; if one is a strong structural match, call viralExamples.getStructure to study its HOOK/beats/CTA. Imitate the PATTERN, never the words.",
    "  3. PULL CONTEXT. If the user keeps notes, transcripts, or a knowledge graph, query notes.search / transcripts.search / knowledge.query for proof points, angles, and prior hooks before inventing them.",
    "  4. DRAFT. Call script.draft with your scene beats to record the first full draft.",
    "  5. SELF-CRITIQUE. The runtime lints every draft against the viral structure rules and returns violations. If there are any ERRORs, call script.revise with the fix — do not return a script that fails the lint.",
    "  6. RETURN. Once the lint is clean, output the final script as your last message, in the exact scene format below. Your final message is the script the user receives — no preamble, no commentary.",
  ].join("\n");
}

function buildFormatBlock(includeVoiceover: boolean): string {
  return [
    "OUTPUT FORMAT — every scene exactly as:",
    "",
    "[SCENE X: Title]",
    "VISUAL: what appears on screen",
    includeVoiceover
      ? "VOICEOVER: narration text"
      : "VOICEOVER: (optional — minimal narration, rely on visuals)",
    "DURATION: estimated seconds",
    "",
    "Keep each scene a self-contained visual moment that can render as a single image.",
  ].join("\n");
}

/**
 * Build the full system prompt. This is the only place the script-agent's
 * persona + rules are assembled.
 */
export function buildScriptAgentSystemPrompt(input: ScriptAgentPromptInput): string {
  const pacing = resolvePacing(input.platform);
  const durationSec = input.durationSec ?? pacing.defaultDurationSec;
  const durationDesc =
    durationSec >= 90 ? `${Math.round(durationSec / 60)} minute(s)` : `${durationSec} seconds`;

  const parts: string[] = [];

  parts.push(
    `You are a senior short-form video scriptwriter and viral-content strategist who has shipped top-performing ${pacing.name} content. You write the way the best creators write: pattern-interrupt hooks, a payoff every few seconds, zero filler. You are AGENTIC — you research, pull real exemplars, draft, lint, and revise before you hand over a script.`,
  );

  if (input.persona && input.persona.trim()) {
    parts.push("", `CREATOR PERSONA / VOICE: ${input.persona.trim()}`);
  }

  parts.push("", `TARGET: a ~${durationDesc} ${pacing.name} script.`);
  if (input.tone) parts.push(`TONE: ${input.tone}`);
  if (input.style) parts.push(`STYLE: ${input.style}`);
  if (input.anglesToExplore && input.anglesToExplore.length) {
    parts.push(`ANGLES TO EXPLORE: ${input.anglesToExplore.join("; ")}`);
  }

  parts.push("", buildStructureRulesBlock(input.platform));
  parts.push("", buildOperatingProcedure(input));
  parts.push("", buildFormatBlock(input.includeVoiceover));

  return parts.join("\n");
}

/** Compact first user turn that frames the brief for the agent. */
export function buildScriptAgentUserPrompt(brief: string, input: ScriptAgentPromptInput): string {
  const pacing = resolvePacing(input.platform);
  return [
    `Write a complete ${pacing.name} video script about:`,
    "",
    brief,
    "",
    `Remember: the first ${pacing.hookWindowWords} words of scene 1 decide whether anyone watches the rest. Ground it, anchor the structure on a real exemplar, draft, lint, revise, then deliver.`,
  ].join("\n");
}
