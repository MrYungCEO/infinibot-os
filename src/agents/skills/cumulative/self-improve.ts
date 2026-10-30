/**
 * Self-improvement pass.
 *
 * Runs periodically (or on-demand) over the corpus of learned skills.
 * For each skill that has been used `selfImproveMinUses` times since
 * its last refinement and isn't inside the cooldown window, we feed the
 * model:
 *   - the current SKILL.md body
 *   - the recent trajectories that invoked it (with success/failure tags)
 *
 * and ask it to either rewrite the body to better match what worked, or
 * decline. We only persist the rewrite when the model self-rates ≥ the
 * configured min-confidence. This is the same pattern hermes-agent uses
 * to "improve skills during use" (MIT licensed — see LICENSE-NOTICE.md).
 */
import { createSubsystemLogger } from "../../../logging/subsystem.js";

import type {
  CumulativeSkillsConfig,
  ReflectionDraft,
  Trajectory,
  UsageRecord,
} from "./types.js";
import {
  listLearnedSkills,
  parseLearnedSkillFile,
  readUsage,
  rewriteLearnedSkillBody,
  writeUsage,
} from "./storage.js";
import { readTrajectoryById } from "./trajectory-store.js";
import { parseReflectionResponse } from "./reflection.js";
import path from "node:path";

const log = createSubsystemLogger("cumulative-skills/self-improve");

const SYSTEM_PROMPT = `You are an expert agent-trainer iterating on a skill that's been used multiple times. You see:
1. The current skill body (markdown).
2. A sample of recent runs that invoked it, each tagged success / failure.

Your job is to produce a *strictly better* body — one that:
- Embeds patterns from the successes
- Adds explicit "When NOT to use" guidance from the failures
- Stays under 800 tokens
- Preserves the When-to-use → Procedure → Caveats structure

Respond with one JSON object:
{ "name": "<unchanged kebab-name>", "description": "<keep or refine>", "body": "<new markdown>", "confidence": 0.0 }

Rules:
- Confidence < 0.5 means "current body is fine; don't rewrite". The caller will discard low-confidence rewrites.
- If the failures don't show a meaningful pattern, set confidence < 0.5 and return the body unchanged.
- Never widen scope — keep the skill focused on the same trigger surface.`;

export interface SelfImproveInput {
  /** Provider-agnostic completion function (same shape as reflection.ts). */
  complete: (params: { system: string; user: string; maxOutputTokens?: number }) => Promise<string>;
  /**
   * Resolve a trajectory by id. Caller passes the same agent id so we read
   * from the right per-agent jsonl. We don't store agentId on the usage
   * sidecar (skills are agent-agnostic) so the caller has to know which
   * agents touched the skill — it's fine to pass "main" if you only have
   * one agent.
   */
  agentIdForLookup: string;
}

export interface SelfImproveResult {
  skillKey: string;
  outcome: "rewrote" | "skipped-cooldown" | "skipped-min-uses" | "skipped-low-confidence" | "skipped-no-trajectories" | "errored";
  reason: string;
}

/**
 * Iterate every learned skill and refine eligible ones. Returns one
 * result per skill so a caller (CLI, scheduled job, UI button) can show
 * a breakdown.
 */
export async function runSelfImprovePass(
  config: CumulativeSkillsConfig,
  input: SelfImproveInput,
): Promise<SelfImproveResult[]> {
  if (!config.enabled) return [];
  const out: SelfImproveResult[] = [];
  const skills = listLearnedSkills(config);
  if (skills.length === 0) return out;
  log.info(`self-improve scanning ${skills.length} learned skill(s)`);
  for (const entry of skills) {
    const usage = entry.usage;
    if (usage.invocations < config.selfImproveMinUses) {
      out.push({
        skillKey: entry.frontmatter.name,
        outcome: "skipped-min-uses",
        reason: `${usage.invocations} invocations < ${config.selfImproveMinUses}`,
      });
      continue;
    }
    if (usage.lastRefinedAt) {
      const lastMs = Date.parse(usage.lastRefinedAt);
      if (Number.isFinite(lastMs) && Date.now() - lastMs < config.selfImproveCooldownMs) {
        out.push({
          skillKey: entry.frontmatter.name,
          outcome: "skipped-cooldown",
          reason: `last refined ${new Date(lastMs).toISOString()}`,
        });
        continue;
      }
    }
    if (usage.recentTrajectoryIds.length === 0) {
      out.push({
        skillKey: entry.frontmatter.name,
        outcome: "skipped-no-trajectories",
        reason: "no recent trajectory references",
      });
      continue;
    }
    const trajectories = usage.recentTrajectoryIds
      .map((id) => readTrajectoryById(config, input.agentIdForLookup, id))
      .filter((t): t is Trajectory => t !== null);
    if (trajectories.length === 0) {
      out.push({
        skillKey: entry.frontmatter.name,
        outcome: "skipped-no-trajectories",
        reason: "all referenced trajectories rotated out",
      });
      continue;
    }
    try {
      const draft = await runOneRefinement(input, entry.frontmatter.name, entry.body, trajectories);
      if (!draft || draft.confidence < config.minConfidence) {
        out.push({
          skillKey: entry.frontmatter.name,
          outcome: "skipped-low-confidence",
          reason: `confidence ${(draft?.confidence ?? 0).toFixed(2)} < ${config.minConfidence}`,
        });
        continue;
      }
      const wrote = rewriteLearnedSkillBody(config, entry.frontmatter.name, draft.body);
      if (wrote) {
        const next: UsageRecord = { ...usage, lastRefinedAt: new Date().toISOString() };
        writeUsage(config, next);
        out.push({
          skillKey: entry.frontmatter.name,
          outcome: "rewrote",
          reason: `rewrote body (conf ${draft.confidence.toFixed(2)})`,
        });
      } else {
        out.push({
          skillKey: entry.frontmatter.name,
          outcome: "errored",
          reason: "storage rewrite failed",
        });
      }
    } catch (err) {
      log.warn(
        `self-improve crashed on "${entry.frontmatter.name}": ${(err as Error)?.message ?? err}`,
      );
      out.push({
        skillKey: entry.frontmatter.name,
        outcome: "errored",
        reason: String((err as Error)?.message ?? err),
      });
    }
  }
  return out;
}

async function runOneRefinement(
  input: SelfImproveInput,
  name: string,
  currentBody: string,
  trajectories: Trajectory[],
): Promise<ReflectionDraft | null> {
  const userMessage = buildRefineMessage(name, currentBody, trajectories);
  const raw = await input.complete({
    system: SYSTEM_PROMPT,
    user: userMessage,
    maxOutputTokens: 2000,
  });
  return parseReflectionResponse(raw);
}

function buildRefineMessage(
  name: string,
  currentBody: string,
  trajectories: Trajectory[],
): string {
  const lines: string[] = [];
  lines.push(`# Skill name\n${name}`);
  lines.push("");
  lines.push("# Current body");
  lines.push(currentBody);
  lines.push("");
  lines.push(`# Recent runs (${trajectories.length})`);
  for (const t of trajectories) {
    const verdict = verdictOf(t);
    lines.push(`---\n## ${t.id} — ${verdict}`);
    lines.push(`Task: ${t.taskPrompt.slice(0, 600)}`);
    lines.push("Steps:");
    for (const s of t.steps.slice(0, 12)) {
      lines.push(`- [${s.kind}] ${s.label}`);
    }
    lines.push(`Final: ${t.finalOutput.slice(0, 600)}`);
  }
  return lines.join("\n");
}

function verdictOf(t: Trajectory): string {
  if (t.metrics.errored) return "FAILURE (errored)";
  if (!t.metrics.reportedSuccess) return "AMBIGUOUS (no success signal)";
  return "SUCCESS";
}

/** Resolve where a learned skill lives (used by CLI / UI surfaces). */
export function pathForLearnedSkill(config: CumulativeSkillsConfig, skillKey: string): string {
  return path.join(config.skillsLearnedDir, skillKey, "SKILL.md");
}

// Re-exported for tooling
export { parseLearnedSkillFile, readUsage };
