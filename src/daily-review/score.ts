/**
 * Productivity score — transparent by design. Every point is itemised in
 * `components`, and the formula is documented in docs/daily-review.md.
 *
 *   net points =
 *       10 × Σ verified runs × (1 + size bonus)          size bonus ≤ 2.5:
 *                                                          min(1, commits/4)
 *                                                        + min(0.5, files/40)
 *                                                        + 1 if it shipped a deploy
 *     +  4 × unverified completions (done, not proven)
 *     +  6 × deploys not already credited through a verified run
 *     +  3 × kanban tasks completed (not linked to a counted run)
 *     +  1 × git commits (deduplicated, capped at 40)
 *     −  4 × failed runs
 *     −  2 × rework (explicit respawns of a failed/stuck run)
 *     −  3 × incidents (gateway OOM kills / crashes)
 *
 *   absolute part = net / (net + 60)           (60 ≈ five solid verified runs)
 *   relative part = r / (r + 1),  r = net / baseline
 *                   baseline = median net of the previous 14 active days
 *   score = round(100 × (0.5 × absolute + 0.5 × relative))
 *
 * So a day exactly at your own baseline with a normal output lands near 50,
 * twice the baseline ≈ 67+, and failures/rework pull it down visibly.
 */
import type { DayRun, DayScore, ScoreComponent } from "./types.js";

export const SCORE_WEIGHTS = {
  verified: 10,
  unverified: 4,
  deploy: 6,
  kanban: 3,
  commit: 1,
  commitCap: 40,
  failed: -4,
  rework: -2,
  incident: -3,
  absoluteHalf: 60,
  minBaseline: 20,
} as const;

export interface ScoreInput {
  runs: DayRun[];
  deploysUncredited: number;
  kanbanUnlinked: number;
  commits: number;
  incidents: number;
  /** Explicit respawns started today (continuation passes are not rework). */
  rework: number;
}

export function sizeBonus(r: Pick<DayRun, "commits" | "files" | "deploys">): number {
  return Math.min(
    2.5,
    Math.min(1, r.commits / 4) + Math.min(0.5, r.files / 40) + (r.deploys > 0 ? 1 : 0),
  );
}

/** Points only — no baseline. `runs` are logical tasks (continuations collapsed). */
export function scorePoints(input: ScoreInput): { net: number; components: ScoreComponent[] } {
  const W = SCORE_WEIGHTS;
  const ended = input.runs.filter((r) => r.outcome !== "running");
  const verified = ended.filter((r) => r.outcome === "verified");
  const unverified = ended.filter((r) => r.outcome === "unverified" || r.outcome === "needs_you");
  const failed = ended.filter((r) => r.outcome === "failed");
  const verifiedPts = verified.reduce((s, r) => s + W.verified * (1 + sizeBonus(r)), 0);
  const commitsCounted = Math.min(W.commitCap, input.commits);
  const components: ScoreComponent[] = [
    {
      key: "verified",
      label: "Verified completions",
      count: verified.length,
      points: verifiedPts,
      note: `${W.verified} each × (1 + size bonus for commits, files and deploys)`,
    },
    {
      key: "unverified",
      label: "Done, not yet proven",
      count: unverified.length,
      points: unverified.length * W.unverified,
      note: `${W.unverified} each (unverified, needs you or blocked)`,
    },
    {
      key: "deploys",
      label: "Other deploys",
      count: input.deploysUncredited,
      points: input.deploysUncredited * W.deploy,
      note: `${W.deploy} each, for deploys not already counted in a verified run`,
    },
    {
      key: "kanban",
      label: "Kanban tasks completed",
      count: input.kanbanUnlinked,
      points: input.kanbanUnlinked * W.kanban,
      note: `${W.kanban} each, for tasks not linked to a counted run`,
    },
    {
      key: "commits",
      label: "Git commits",
      count: input.commits,
      points: commitsCounted * W.commit,
      note: `${W.commit} each, capped at ${W.commitCap}`,
    },
    {
      key: "failed",
      label: "Failed runs",
      count: failed.length,
      points: failed.length * W.failed,
      note: `${W.failed} each`,
    },
    {
      key: "rework",
      label: "Rework (respawns)",
      count: input.rework,
      points: input.rework * W.rework,
      note: `${W.rework} each`,
    },
    {
      key: "incidents",
      label: "Incidents (OOM, crashes)",
      count: input.incidents,
      points: input.incidents * W.incident,
      note: `${W.incident} each`,
    },
  ];
  for (const c of components) c.points = Math.round(c.points * 10) / 10;
  const net = Math.max(0, Math.round(components.reduce((s, c) => s + c.points, 0) * 10) / 10);
  return { net, components };
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Baseline = median net of the previous 14 days that had any activity. */
export function baselineFrom(previousNets: number[]): number {
  const active = previousNets.filter((n) => n > 0);
  return Math.max(SCORE_WEIGHTS.minBaseline, median(active));
}

export function gradeFor(value: number): string {
  if (value >= 80) return "Exceptional";
  if (value >= 65) return "Strong";
  if (value >= 45) return "Solid";
  if (value >= 25) return "Light";
  if (value > 0) return "Quiet";
  return "Idle";
}

export function finalizeScore(
  net: number,
  baseline: number,
  components: ScoreComponent[],
): DayScore {
  const W = SCORE_WEIGHTS;
  const absolutePart = net / (net + W.absoluteHalf);
  const ratio = baseline > 0 ? net / baseline : 0;
  const relativePart = ratio / (ratio + 1);
  const value = net <= 0 ? 0 : Math.round(100 * (0.5 * absolutePart + 0.5 * relativePart));
  return {
    version: 1,
    value,
    grade: gradeFor(value),
    net,
    baseline: Math.round(baseline * 10) / 10,
    ratio: Math.round(ratio * 100) / 100,
    absolutePart: Math.round(absolutePart * 1000) / 1000,
    relativePart: Math.round(relativePart * 1000) / 1000,
    components,
  };
}
