/**
 * Prompt loader tests — assert the script-agent system prompt is built from the
 * single source of truth (viral-structure-rules.ts) and carries the moat rules
 * + research expectations, with no duplicated structure definition.
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { buildScriptAgentSystemPrompt, buildScriptAgentUserPrompt } from "./script-agent-prompt.js";
import { BANNED_FILLER, STRUCTURE_BEATS, resolvePacing } from "./viral-structure-rules.js";

test("system prompt embeds the structure beats from the single source", () => {
  const p = buildScriptAgentSystemPrompt({
    platform: "tiktok",
    researchDepth: "standard",
    includeVoiceover: true,
  });
  for (const beat of STRUCTURE_BEATS) {
    assert.ok(p.includes(beat.label), `prompt missing beat label: ${beat.label}`);
  }
});

test("system prompt embeds banned filler from the single source", () => {
  const p = buildScriptAgentSystemPrompt({
    platform: "shorts",
    researchDepth: "standard",
    includeVoiceover: true,
  });
  // A representative banned phrase must appear verbatim in the rules block.
  assert.ok(p.toLowerCase().includes(BANNED_FILLER[0]));
});

test("platform pacing drives the hook window in the prompt", () => {
  const tiktok = buildScriptAgentSystemPrompt({
    platform: "tiktok",
    researchDepth: "standard",
    includeVoiceover: true,
  });
  const youtube = buildScriptAgentSystemPrompt({
    platform: "youtube",
    researchDepth: "standard",
    includeVoiceover: true,
  });
  assert.ok(tiktok.includes(`${resolvePacing("tiktok").hookWindowWords} words`));
  assert.ok(youtube.includes(`${resolvePacing("youtube").hookWindowWords} words`));
});

test("research depth changes the operating procedure guidance", () => {
  const shallow = buildScriptAgentSystemPrompt({
    researchDepth: "shallow",
    includeVoiceover: true,
  });
  const standard = buildScriptAgentSystemPrompt({
    researchDepth: "standard",
    includeVoiceover: true,
  });
  const deep = buildScriptAgentSystemPrompt({ researchDepth: "deep", includeVoiceover: true });
  assert.ok(/OPTIONAL/.test(shallow));
  assert.ok(/EXPECTED/.test(standard));
  assert.ok(/REQUIRED/.test(deep));
});

test("user prompt references the platform hook window", () => {
  const u = buildScriptAgentUserPrompt("a video about cold plunges", {
    platform: "tiktok",
    researchDepth: "standard",
    includeVoiceover: true,
  });
  assert.ok(u.includes("cold plunges"));
  assert.ok(u.includes(`${resolvePacing("tiktok").hookWindowWords} words`));
});
