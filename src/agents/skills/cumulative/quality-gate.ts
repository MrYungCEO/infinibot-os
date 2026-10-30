/**
 * Pre-promotion quality gate.
 *
 * A trajectory has to clear two thresholds before we even bother spending
 * tokens on the reflection pass: heuristics on the run itself, and a
 * fingerprint dedupe against existing learned skills. The dedupe runs
 * after the reflection produces a draft (we need the draft body to hash);
 * the heuristic gate runs before, on the trajectory alone.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { createSubsystemLogger } from "../../../logging/subsystem.js";

import type { CumulativeSkillsConfig, GateResult, Trajectory, ReflectionDraft } from "./types.js";
import { LEARNED_FRONTMATTER_RE, parseLearnedSkillFile } from "./storage.js";

const log = createSubsystemLogger("cumulative-skills/gate");

/**
 * Cheap pre-reflection gate. Reasons the run won't get distilled:
 *   - errored / aborted
 *   - no clear final output
 *   - too few steps to learn from
 *   - too expensive (token cap) — promoting these biases the corpus toward
 *     burning runs, not toward fast wins
 *   - too long wall-clock (same logic — we want patterns that ship fast)
 *   - too many clarification requests (the agent didn't know what it was doing;
 *     extracting that as a "skill" is harmful)
 */
export function preReflectionGate(
  config: CumulativeSkillsConfig,
  trajectory: Trajectory,
): GateResult {
  if (trajectory.metrics.errored) {
    return { accept: false, vetoBy: "errored", reason: "Run terminated with an error." };
  }
  if (!trajectory.finalOutput.trim()) {
    return { accept: false, vetoBy: "no-output", reason: "Run produced no final output." };
  }
  if (trajectory.steps.length < 2) {
    return {
      accept: false,
      vetoBy: "too-shallow",
      reason: "Trajectory has fewer than 2 steps — nothing reusable to extract.",
    };
  }
  if (
    trajectory.metrics.totalTokens != null &&
    trajectory.metrics.totalTokens > config.maxTokensForPromotion
  ) {
    return {
      accept: false,
      vetoBy: "too-expensive",
      reason: `Run consumed ${trajectory.metrics.totalTokens} tokens (cap ${config.maxTokensForPromotion}).`,
    };
  }
  if (trajectory.metrics.durationMs > config.maxDurationMsForPromotion) {
    return {
      accept: false,
      vetoBy: "too-slow",
      reason: `Run took ${Math.round(trajectory.metrics.durationMs / 1000)}s (cap ${
        Math.round(config.maxDurationMsForPromotion / 1000)
      }s).`,
    };
  }
  if (trajectory.metrics.clarifications > 1) {
    return {
      accept: false,
      vetoBy: "noisy",
      reason: `Agent asked ${trajectory.metrics.clarifications} clarification questions — pattern unclear.`,
    };
  }
  if (!trajectory.metrics.reportedSuccess) {
    return {
      accept: false,
      vetoBy: "unsuccessful",
      reason: "Agent did not report task success at the end of the run.",
    };
  }
  return { accept: true, reason: "Trajectory passed pre-reflection heuristics." };
}

/**
 * Post-reflection gate. Confidence threshold + dedupe against existing
 * learned skills (slug match OR body fingerprint similarity).
 */
export function postReflectionGate(
  config: CumulativeSkillsConfig,
  draft: ReflectionDraft,
): GateResult {
  if (draft.confidence < config.minConfidence) {
    return {
      accept: false,
      vetoBy: "low-confidence",
      reason: `Reflection self-rated ${draft.confidence.toFixed(2)} — below threshold ${config.minConfidence}.`,
    };
  }
  const dupResult = checkForDuplicate(config, draft);
  if (!dupResult.accept) return dupResult;
  return { accept: true, reason: "Draft cleared confidence + dedupe gate." };
}

/**
 * Walk the learned-skills directory looking for an existing skill that
 * either has the same kebab name or the same body fingerprint. Returns
 * an accept/reject result so the caller doesn't have to know the on-disk
 * layout.
 */
function checkForDuplicate(
  config: CumulativeSkillsConfig,
  draft: ReflectionDraft,
): GateResult {
  if (!fs.existsSync(config.skillsLearnedDir)) return { accept: true, reason: "No prior learned skills." };
  const fingerprint = computeFingerprint(draft.body);
  let entries: string[];
  try {
    entries = fs.readdirSync(config.skillsLearnedDir);
  } catch (err) {
    log.warn(`failed to scan learned skills dir: ${(err as Error)?.message ?? err}`);
    return { accept: true, reason: "Could not read learned-skills dir; allowing." };
  }
  for (const entry of entries) {
    if (entry === draft.name) {
      return {
        accept: false,
        vetoBy: "duplicate-name",
        reason: `Learned skill named "${draft.name}" already exists.`,
      };
    }
    const skillFile = path.join(config.skillsLearnedDir, entry, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const parsed = parseLearnedSkillFile(skillFile);
    if (!parsed) continue;
    if (parsed.frontmatter.fingerprint === fingerprint) {
      return {
        accept: false,
        vetoBy: "duplicate-fingerprint",
        reason: `Existing skill "${entry}" has identical body content.`,
      };
    }
  }
  return { accept: true, reason: "No duplicate." };
}

/**
 * Stable, content-only fingerprint. Whitespace-collapsed sha256 first 16
 * chars — short enough to live on a frontmatter line, long enough to make
 * accidental collisions vanishingly rare for the corpus sizes we expect.
 * Exported so the storage layer can keep the same value in frontmatter.
 */
export function computeFingerprint(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// Re-exported helpers so callers don't have to import from two modules.
export { LEARNED_FRONTMATTER_RE };
