/**
 * Append-only JSON-lines store for completed run trajectories.
 *
 * Trajectories are the raw material the reflection pass distills into
 * skills, and the corpus self-improve scans periodically for refinement
 * candidates. We keep the store deliberately simple — one file per
 * agent-id, rotated after `rotateAfterLines` to keep individual reads
 * cheap. Each record is one line of compact JSON so the file is grep-able.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createSubsystemLogger } from "../../../logging/subsystem.js";

import type { CumulativeSkillsConfig, Trajectory, TrajectoryStep } from "./types.js";

const log = createSubsystemLogger("cumulative-skills/trajectory");

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function fileForAgent(config: CumulativeSkillsConfig, agentId: string): string {
  ensureDir(config.trajectoryDir);
  // Sanitize agentId so an attacker-controlled value can't escape the dir.
  const safe = agentId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "main";
  return path.join(config.trajectoryDir, `${safe}.jsonl`);
}

/** Truncate every step's content to `maxStepBytes` so the corpus stays bounded. */
function truncateSteps(steps: TrajectoryStep[], maxStepBytes: number): TrajectoryStep[] {
  return steps.map((step) => {
    if (step.content.length <= maxStepBytes) return step;
    return { ...step, content: step.content.slice(0, maxStepBytes) + " …[truncated]" };
  });
}

/** Append a completed trajectory. Returns the assigned id. */
export function appendTrajectory(
  config: CumulativeSkillsConfig,
  partial: Omit<Trajectory, "id" | "completedAt"> & { id?: string; completedAt?: string },
): Trajectory {
  const trajectory: Trajectory = {
    id: partial.id ?? `traj_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    completedAt: partial.completedAt ?? new Date().toISOString(),
    source: partial.source,
    taskPrompt: partial.taskPrompt,
    steps: truncateSteps(partial.steps, config.maxStepBytes),
    finalOutput: partial.finalOutput,
    metrics: partial.metrics,
    tags: partial.tags,
  };
  const file = fileForAgent(config, trajectory.source.agentId);
  try {
    fs.appendFileSync(file, JSON.stringify(trajectory) + "\n", { encoding: "utf8" });
  } catch (err) {
    log.warn(`failed to append trajectory: ${(err as Error)?.message ?? err}`);
    return trajectory;
  }
  rotateIfNeeded(file, config.rotateAfterLines);
  return trajectory;
}

/**
 * Rotate the trajectory file when it exceeds the cap. Older lines are
 * archived alongside the live file with a timestamp suffix; the live
 * file then becomes empty and continues taking new appends.
 */
function rotateIfNeeded(file: string, rotateAfterLines: number): void {
  if (rotateAfterLines <= 0) return;
  let lineCount = 0;
  try {
    const buf = fs.readFileSync(file);
    for (const byte of buf) if (byte === 0x0a /* \n */) lineCount += 1;
  } catch {
    return;
  }
  if (lineCount <= rotateAfterLines) return;
  const archive = `${file}.${Date.now()}.archived`;
  try {
    fs.renameSync(file, archive);
    fs.writeFileSync(file, "");
    log.info(`rotated trajectory file: ${path.basename(archive)} (${lineCount} lines)`);
  } catch (err) {
    log.warn(`trajectory rotation failed: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Read the most recent N trajectories from a given agent's store. Used by
 * the reflection pass and the self-improve pass.
 */
export function readRecentTrajectories(
  config: CumulativeSkillsConfig,
  agentId: string,
  limit: number,
): Trajectory[] {
  const file = fileForAgent(config, agentId);
  if (!fs.existsSync(file)) return [];
  const out: Trajectory[] = [];
  try {
    // Read tail by reading whole file then slicing — fine for our cap of
    // ~10k lines; if we ever raise the cap, switch to reverse-chunk read.
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n").filter(Boolean);
    for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
      try {
        out.push(JSON.parse(lines[i] as string) as Trajectory);
      } catch {
        /* skip malformed line */
      }
    }
  } catch (err) {
    log.warn(`trajectory read failed: ${(err as Error)?.message ?? err}`);
  }
  return out;
}

/** Look up a single trajectory by id (linear scan; fine for small files). */
export function readTrajectoryById(
  config: CumulativeSkillsConfig,
  agentId: string,
  id: string,
): Trajectory | null {
  const file = fileForAgent(config, agentId);
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      if (!line.includes(`"id":"${id}"`)) continue;
      try {
        const parsed = JSON.parse(line) as Trajectory;
        if (parsed.id === id) return parsed;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
