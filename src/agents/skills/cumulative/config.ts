/**
 * Runtime config + path resolution for the cumulative skill system.
 *
 * The defaults follow the rest of InfiniBot — state lives under
 * `${INFINIBOT_STATE_DIR ?? ~/.infinibot}/cumulative-skills/`. Learned
 * SKILL.md files instead live inside the workspace `skills/_learned/`
 * directory so the existing `loadSkillsFromDir` watcher picks them up
 * without a separate registration path.
 */
import path from "node:path";

import { CONFIG_DIR } from "../../../utils.js";

import type { CumulativeSkillsConfig } from "./types.js";

const FALLBACK_WORKSPACE_DIR = process.cwd();

function envFlag(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve the canonical config. Caller can pass a workspace dir override
 * (e.g. when running multi-workspace agents) so learned skills land next to
 * authored ones.
 */
export function resolveCumulativeSkillsConfig(opts?: {
  workspaceDir?: string;
}): CumulativeSkillsConfig {
  const workspaceDir = opts?.workspaceDir ?? FALLBACK_WORKSPACE_DIR;
  const stateRoot = path.join(CONFIG_DIR, "cumulative-skills");
  return {
    enabled: envFlag("INFINIBOT_CUMULATIVE_SKILLS", true),
    trajectoryDir: path.join(stateRoot, "trajectories"),
    skillsLearnedDir: path.join(workspaceDir, "skills", "_learned"),
    usageDir: path.join(stateRoot, "usage"),
    maxStepBytes: envInt("INFINIBOT_CUMULATIVE_MAX_STEP_BYTES", 4 * 1024),
    rotateAfterLines: envInt("INFINIBOT_CUMULATIVE_ROTATE_LINES", 10_000),
    minConfidence: envFloat("INFINIBOT_CUMULATIVE_MIN_CONFIDENCE", 0.65),
    maxTokensForPromotion: envInt("INFINIBOT_CUMULATIVE_MAX_PROMO_TOKENS", 60_000),
    maxDurationMsForPromotion: envInt(
      "INFINIBOT_CUMULATIVE_MAX_PROMO_DURATION_MS",
      10 * 60 * 1000,
    ),
    selfImproveMinUses: envInt("INFINIBOT_CUMULATIVE_SELFIMPROVE_MIN_USES", 5),
    selfImproveCooldownMs: envInt(
      "INFINIBOT_CUMULATIVE_SELFIMPROVE_COOLDOWN_MS",
      24 * 60 * 60 * 1000,
    ),
    recentTrajectoryWindow: envInt("INFINIBOT_CUMULATIVE_RECENT_WINDOW", 20),
  };
}
