/**
 * Cumulative skill system — public API surface.
 *
 * Architecture inspired by NousResearch/hermes-agent's "skills self-improve
 * during use" loop. See `LICENSE-NOTICE.md` for attribution.
 *
 *  ┌────────────┐    ┌────────────┐    ┌──────────────┐    ┌──────────┐
 *  │ Agent run  │ →  │ Trajectory │ →  │ Reflection   │ →  │ Storage  │
 *  │ completion │    │ store      │    │ + Quality    │    │ (.md)    │
 *  └────────────┘    └────────────┘    │ gate         │    └──────────┘
 *                                       └──────────────┘         │
 *                                                                ▼
 *                                                        ┌──────────────┐
 *                                                        │ Usage        │
 *                                                        │ tracker      │
 *                                                        └──────────────┘
 *                                                                │
 *                                                                ▼
 *                                                        ┌──────────────┐
 *                                                        │ Self-improve │
 *                                                        │ pass (cron)  │
 *                                                        └──────────────┘
 *
 * The system is provider-agnostic: callers pass a `complete` function that
 * routes to whichever LLM they prefer (the agent's default model, a smaller
 * cheap model for reflection, etc.). Disable globally by setting
 * INFINIBOT_CUMULATIVE_SKILLS=0.
 */
import { isSecureSessionKey } from "../../../secure-mode/session-key.js";
import type {
  CumulativeSkillsConfig,
  ReflectionDraft,
  Trajectory,
} from "./types.js";

import { resolveCumulativeSkillsConfig } from "./config.js";
import { appendTrajectory, readRecentTrajectories, readTrajectoryById } from "./trajectory-store.js";
import { reflectTrajectoryIntoSkill } from "./reflection.js";
import { postReflectionGate, preReflectionGate } from "./quality-gate.js";
import {
  incrementUsage,
  listLearnedSkills,
  parseLearnedSkillFile,
  persistLearnedSkill,
  readUsage,
  rewriteLearnedSkillBody,
  writeUsage,
} from "./storage.js";
import {
  pathForLearnedSkill,
  runSelfImprovePass,
  type SelfImproveInput,
  type SelfImproveResult,
} from "./self-improve.js";

import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("cumulative-skills");

// ── Re-exports ─────────────────────────────────────────────────────────

export type {
  CumulativeSkillsConfig,
  ReflectionDraft,
  Trajectory,
  TrajectoryStep,
  RunMetrics,
  LearnedSkillFrontmatter,
  UsageRecord,
  GateResult,
} from "./types.js";

export {
  resolveCumulativeSkillsConfig,
  appendTrajectory,
  readRecentTrajectories,
  readTrajectoryById,
  reflectTrajectoryIntoSkill,
  preReflectionGate,
  postReflectionGate,
  incrementUsage,
  listLearnedSkills,
  parseLearnedSkillFile,
  persistLearnedSkill,
  readUsage,
  rewriteLearnedSkillBody,
  writeUsage,
  runSelfImprovePass,
  pathForLearnedSkill,
};

export type { SelfImproveInput, SelfImproveResult };

// ── High-level orchestration ───────────────────────────────────────────

export interface CaptureCompletionInput {
  /** The completed trajectory (caller assembles from its agent loop). */
  trajectory: Omit<Trajectory, "id" | "completedAt">;
  /**
   * Provider-agnostic completion function. When omitted the trajectory is
   * stored but no reflection is attempted — this is useful for callers
   * that want to defer reflection to a batched cron job.
   */
  complete?: (params: { system: string; user: string; maxOutputTokens?: number }) => Promise<string>;
  /** Optional config override — defaults to env-resolved config. */
  config?: CumulativeSkillsConfig;
}

export interface CaptureCompletionResult {
  trajectory: Trajectory;
  /** When set, reflection ran. Reason describes why we did/didn't promote. */
  gate?: { stage: "pre" | "post"; accept: boolean; reason: string; vetoBy?: string };
  /** When the gate accepted, the persisted skill. */
  skill?: { name: string; file: string };
}

/**
 * Capture a completed run + (optionally) attempt to distill it into a skill.
 * This is the one-call entry point an agent loop should invoke after every
 * completion. Failures don't throw — the agent continues regardless.
 */
export async function captureCompletion(
  input: CaptureCompletionInput,
): Promise<CaptureCompletionResult> {
  // Secure Mode: secure runs are never stored as plaintext trajectories nor
  // sent to a (possibly hosted) model for reflection.
  if (isSecureSessionKey(input.trajectory.source?.sessionKey)) {
    return { trajectory: appendTrajectoryShape(input.trajectory) };
  }
  const config = input.config ?? resolveCumulativeSkillsConfig();
  if (!config.enabled) {
    log.debug("captureCompletion: cumulative skills disabled, skipping");
    return {
      trajectory: appendTrajectoryShape(input.trajectory),
    };
  }
  const trajectory = appendTrajectory(config, input.trajectory);

  if (!input.complete) {
    return { trajectory };
  }
  const pre = preReflectionGate(config, trajectory);
  if (!pre.accept) {
    log.info(`pre-gate rejected ${trajectory.id}: ${pre.reason}`);
    return { trajectory, gate: { stage: "pre", ...pre } };
  }

  let draft: ReflectionDraft | null;
  try {
    draft = await reflectTrajectoryIntoSkill({ trajectory, complete: input.complete });
  } catch (err) {
    log.warn(`reflection threw: ${(err as Error)?.message ?? err}`);
    return {
      trajectory,
      gate: { stage: "pre", accept: false, reason: "reflection-threw", vetoBy: "exception" },
    };
  }
  if (!draft) {
    return {
      trajectory,
      gate: {
        stage: "post",
        accept: false,
        reason: "Reflection returned no usable draft.",
        vetoBy: "no-draft",
      },
    };
  }

  const post = postReflectionGate(config, draft);
  if (!post.accept) {
    log.info(`post-gate rejected "${draft.name}": ${post.reason}`);
    return { trajectory, gate: { stage: "post", ...post } };
  }
  const persisted = persistLearnedSkill(config, draft, trajectory.id);
  return {
    trajectory,
    gate: { stage: "post", ...post },
    skill: { name: draft.name, file: persisted.skillFile },
  };
}

/** Shape-only fallback used when the system is disabled. Not persisted. */
function appendTrajectoryShape(t: Omit<Trajectory, "id" | "completedAt">): Trajectory {
  return {
    id: "disabled",
    completedAt: new Date().toISOString(),
    ...t,
  };
}

/**
 * Standalone reflection pass — useful for batch jobs that want to scan
 * the trajectory store and promote eligible runs that weren't reflected
 * at capture time.
 */
export async function runReflectionPass(opts: {
  agentId: string;
  limit?: number;
  complete: (params: { system: string; user: string; maxOutputTokens?: number }) => Promise<string>;
  config?: CumulativeSkillsConfig;
}): Promise<CaptureCompletionResult[]> {
  const config = opts.config ?? resolveCumulativeSkillsConfig();
  if (!config.enabled) return [];
  const trajectories = readRecentTrajectories(config, opts.agentId, opts.limit ?? 50);
  const out: CaptureCompletionResult[] = [];
  for (const trajectory of trajectories) {
    const pre = preReflectionGate(config, trajectory);
    if (!pre.accept) {
      out.push({ trajectory, gate: { stage: "pre", ...pre } });
      continue;
    }
    let draft: ReflectionDraft | null;
    try {
      draft = await reflectTrajectoryIntoSkill({ trajectory, complete: opts.complete });
    } catch {
      out.push({
        trajectory,
        gate: { stage: "pre", accept: false, reason: "reflection-threw", vetoBy: "exception" },
      });
      continue;
    }
    if (!draft) {
      out.push({
        trajectory,
        gate: {
          stage: "post",
          accept: false,
          reason: "Reflection returned no usable draft.",
          vetoBy: "no-draft",
        },
      });
      continue;
    }
    const post = postReflectionGate(config, draft);
    if (!post.accept) {
      out.push({ trajectory, gate: { stage: "post", ...post } });
      continue;
    }
    const persisted = persistLearnedSkill(config, draft, trajectory.id);
    out.push({
      trajectory,
      gate: { stage: "post", ...post },
      skill: { name: draft.name, file: persisted.skillFile },
    });
  }
  return out;
}
