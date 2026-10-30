/**
 * Viral Structure Lint — post-generation check that a script obeys the rules
 * defined in viral-structure-rules.ts (the single source of truth).
 *
 * The agent loop runs this after each draft. Any violations are fed back to the
 * model as a critique so it can revise. Clean lint is a precondition for
 * returning the script.
 *
 * This is a pure function over script text + parsed scenes — no LLM, no I/O.
 */

import { parseScript, type ParsedScene } from "../../storyboard/script-generator.js";
import { BANNED_FILLER, CTA_EXEMPT_FILLER, resolvePacing } from "./viral-structure-rules.js";

export type LintSeverity = "error" | "warn";

export interface LintViolation {
  rule:
    | "banned_filler"
    | "hook_window"
    | "missing_scenes"
    | "missing_voiceover"
    | "missing_cta"
    | "sentence_too_long"
    | "no_concrete_detail";
  severity: LintSeverity;
  message: string;
  /** 1-based scene index when the violation is scene-local. */
  scene?: number;
}

export interface LintResult {
  clean: boolean;
  violations: LintViolation[];
  /** Human-readable critique block to feed back to the model on a revise pass. */
  critique: string;
}

const SENTENCE_WORD_LIMIT = 18;

function wordsOf(s: string): string[] {
  return (s || "").trim().split(/\s+/).filter(Boolean);
}

function sentencesOf(s: string): string[] {
  return (s || "")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function hasConcreteDetail(text: string): boolean {
  // A digit, a capitalized proper-noun-ish token mid-sentence, a $ / % sign, or
  // a quoted phrase all count as "concrete".
  if (/\d/.test(text)) return true;
  if (/[$%]/.test(text)) return true;
  if (/["“'].+?["”']/.test(text)) return true;
  // Proper noun heuristic: a capitalized word that isn't the first word.
  const tokens = wordsOf(text);
  for (let i = 1; i < tokens.length; i++) {
    if (/^[A-Z][a-zA-Z]{2,}/.test(tokens[i])) return true;
  }
  return false;
}

/**
 * Lint a script. `platform` selects the pacing rules (hook window). Pass the
 * already-parsed scenes to avoid double parsing; otherwise it parses.
 */
export function lintScript(
  script: string,
  platform: string | undefined,
  scenes?: ParsedScene[],
): LintResult {
  const violations: LintViolation[] = [];
  const parsed = scenes ?? parseScript(script);
  const pacing = resolvePacing(platform);

  if (parsed.length === 0) {
    violations.push({
      rule: "missing_scenes",
      severity: "error",
      message:
        "No [SCENE X: Title] blocks found. The script must use the VISUAL / VOICEOVER / DURATION scene structure.",
    });
    return finalize(violations);
  }

  const lastIdx = parsed.length - 1;

  parsed.forEach((scene, i) => {
    const isCtaScene = i === lastIdx;
    const vo = scene.voiceover || "";

    // Banned filler — case-insensitive substring, word-boundary for short tokens.
    const voLower = vo.toLowerCase();
    for (const phrase of BANNED_FILLER) {
      const exemptInCta = isCtaScene && CTA_EXEMPT_FILLER.includes(phrase);
      if (exemptInCta) continue;
      // Word-boundary match for single short words (guys/basically) to avoid
      // false positives inside longer words.
      const hit = phrase.includes(" ")
        ? voLower.includes(phrase)
        : new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(voLower);
      if (hit) {
        violations.push({
          rule: "banned_filler",
          severity: "error",
          scene: scene.index,
          message: `Scene ${scene.index} uses banned filler: "${phrase}".`,
        });
      }
    }

    // Sentence length.
    for (const sentence of sentencesOf(vo)) {
      if (wordsOf(sentence).length > SENTENCE_WORD_LIMIT) {
        violations.push({
          rule: "sentence_too_long",
          severity: "warn",
          scene: scene.index,
          message: `Scene ${scene.index} has a VOICEOVER sentence over ${SENTENCE_WORD_LIMIT} words — break it for one-breath delivery.`,
        });
        break; // one per scene is enough signal
      }
    }
  });

  // Hook window — scene 1 voiceover must land within the platform word window.
  const first = parsed[0];
  if (!first.voiceover || !first.voiceover.trim()) {
    violations.push({
      rule: "missing_voiceover",
      severity: "error",
      scene: first.index,
      message: "Scene 1 has no VOICEOVER — there is nothing to hook the viewer with.",
    });
  } else if (!hasConcreteDetail(first.voiceover.slice(0, 400))) {
    violations.push({
      rule: "no_concrete_detail",
      severity: "warn",
      scene: first.index,
      message:
        "The hook has no concrete detail (number, name, $/%) — front-load a specific to stop the scroll.",
    });
  }

  // CTA / payoff presence on the final scene.
  const last = parsed[lastIdx];
  const lastBlob = `${last.title} ${last.visual} ${last.voiceover || ""}`.toLowerCase();
  const ctaSignals = [
    "follow",
    "subscribe",
    "comment",
    "save",
    "share",
    "link",
    "part 2",
    "part two",
    "dm",
    "watch",
    "try",
    "join",
    "sign up",
    "download",
  ];
  if (!ctaSignals.some((s) => lastBlob.includes(s))) {
    violations.push({
      rule: "missing_cta",
      severity: "warn",
      scene: last.index,
      message: `Final scene reads as a trail-off, not a payoff/CTA. Close with a ${pacing.ctaStyle}`,
    });
  }

  return finalize(violations);
}

function finalize(violations: LintViolation[]): LintResult {
  const hasError = violations.some((v) => v.severity === "error");
  const clean = !hasError;
  const critique = violations.length
    ? [
        "The previous draft violated the viral structure rules. Fix every ERROR (warnings are strongly preferred too) and return the full corrected script in the same scene format:",
        ...violations.map((v) => `  - [${v.severity.toUpperCase()}] ${v.message}`),
      ].join("\n")
    : "";
  return { clean, violations, critique };
}
