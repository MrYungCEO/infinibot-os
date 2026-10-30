/**
 * Relative-scoring adapter — score a reel RELATIVE to what wins in its niche.
 *
 * This is the payoff of the whole subsystem: instead of grading content on an
 * absolute 0-10 scale, we ask "where would this land in the distribution of
 * content that actually performs in this niche, and which winning format does it
 * resemble?". The benchmark adapts over time as the watcher ingests more data,
 * so the bar rises with the niche.
 *
 * `scoreAgainstNicheBenchmark()` is PURE: it takes the reel's format features
 * and a resolved `NicheBenchmarkSnapshot` (fetch it from the store) and returns
 * a verdict. It performs no IO and has no side effects, so it is trivially
 * testable and safe to call from anywhere (RPC, agent tool, future scoring
 * pipeline). It is intentionally NOT wired into the live scoring-service here —
 * see the integration note at the bottom of this file.
 */

import type { NicheBenchmarkSnapshot } from "./benchmark-store.js";
import type { ViralFormat, ViralFormatFeatures } from "./format-framework.js";

export type ScoreTier = "S" | "A" | "B" | "C" | "D";

export interface BenchmarkComparison {
  /** Predicted engagement score for the reel from per-feature niche lifts. */
  predictedScore: number;
  /** Niche median engagement score. */
  medianScore: number;
  /** predictedScore − medianScore (positive = above the niche median). */
  scoreDelta: number;
  /** Reel length vs niche median length, in seconds (null if unknown). */
  lengthVsMedianSec: number | null;
  /** Niche sample size the benchmark is built from (confidence signal). */
  sampleSize: number;
}

export interface TopFormatMatch {
  format: ViralFormat | null;
  /** 0..1 how closely the reel matches this top format. */
  matchPct: number;
  /** Which dimensions matched. */
  matchedDimensions: string[];
}

export interface RelativeScore {
  niche: string;
  subniche: string | null;
  /** 0..100 where the reel's predicted score lands in the niche distribution. */
  percentile: number;
  tier: ScoreTier;
  vsBenchmark: BenchmarkComparison;
  topFormatMatch: TopFormatMatch;
  /** Actionable, niche-relative gaps the reel should close to perform better. */
  gaps: string[];
  /** True when the benchmark is too thin to be trustworthy. */
  lowConfidence: boolean;
}

function tierFromPercentile(p: number): ScoreTier {
  if (p >= 90) return "S";
  if (p >= 75) return "A";
  if (p >= 50) return "B";
  if (p >= 25) return "C";
  return "D";
}

function percentileFromDistribution(
  dist: NicheBenchmarkSnapshot["scoreDistribution"],
  value: number,
): number {
  // Piecewise-linear interpolation across the stored quantile anchors.
  const anchors: [number, number][] = [
    [dist.min, 0],
    [dist.p10, 10],
    [dist.p25, 25],
    [dist.p50, 50],
    [dist.p75, 75],
    [dist.p90, 90],
    [dist.p95, 95],
    [dist.max, 100],
  ];
  if (value <= anchors[0][0]) return 0;
  if (value >= anchors[anchors.length - 1][0]) return 100;
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (value <= x1) {
      if (x1 === x0) return y1;
      return Math.round((y0 + ((value - x0) / (x1 - x0)) * (y1 - y0)) * 10) / 10;
    }
  }
  return 50;
}

/** Average score for a feature value from the niche's per-feature table. */
function lift(
  perf: NicheBenchmarkSnapshot["featurePerformance"],
  dim: string,
  value: string,
  fallback: number,
): { avgScore: number; count: number } {
  const entry = perf[dim]?.[value];
  if (!entry || entry.count === 0) return { avgScore: fallback, count: 0 };
  return entry;
}

/**
 * Score a reel's format features against a niche benchmark snapshot. Pure.
 *
 * The "predicted score" is the mean of the niche's historical average scores for
 * each of the reel's feature values (hook archetype, length bucket, pacing, CTA,
 * angle, text style). A reel built entirely from the niche's winning ingredients
 * predicts high; one built from underperforming ingredients predicts low. That
 * predicted score is then placed in the niche score distribution to get a
 * percentile and tier.
 */
export function scoreAgainstNicheBenchmark(
  reelFeatures: ViralFormatFeatures,
  benchmark: NicheBenchmarkSnapshot,
): RelativeScore {
  const median = benchmark.scoreDistribution.p50;
  const perf = benchmark.featurePerformance;

  // Predict the reel's score from per-feature niche lifts.
  const dims: [string, string][] = [
    ["hookArchetype", reelFeatures.hookArchetype],
    ["lengthBucket", reelFeatures.lengthBucket],
    ["pacing", reelFeatures.pacing],
    ["ctaPattern", reelFeatures.ctaPattern],
    ["topicAngle", reelFeatures.topicAngle],
    ["onScreenTextStyle", reelFeatures.onScreenTextStyle],
  ];
  let sum = 0;
  let n = 0;
  for (const [dim, val] of dims) {
    const l = lift(perf, dim, val, median);
    sum += l.avgScore;
    n += 1;
  }
  const predictedScore = n ? Math.round((sum / n) * 100) / 100 : median;
  const percentile = percentileFromDistribution(benchmark.scoreDistribution, predictedScore);
  const tier = tierFromPercentile(percentile);

  // Match against the niche's top formats.
  const topFormatMatch = matchTopFormat(reelFeatures, benchmark.topFormats);

  // Build actionable gaps relative to what wins.
  const gaps = buildGaps(reelFeatures, benchmark, predictedScore, median);

  const lengthVsMedianSec =
    reelFeatures.lengthSec != null && benchmark.lengthDistribution.count > 0
      ? Math.round((reelFeatures.lengthSec - benchmark.lengthDistribution.p50) * 10) / 10
      : null;

  return {
    niche: benchmark.niche,
    subniche: benchmark.subniche,
    percentile,
    tier,
    vsBenchmark: {
      predictedScore,
      medianScore: Math.round(median * 100) / 100,
      scoreDelta: Math.round((predictedScore - median) * 100) / 100,
      lengthVsMedianSec,
      sampleSize: benchmark.sampleSize,
    },
    topFormatMatch,
    gaps,
    lowConfidence: benchmark.sampleSize < 8,
  };
}

function matchTopFormat(features: ViralFormatFeatures, topFormats: ViralFormat[]): TopFormatMatch {
  let best: ViralFormat | null = null;
  let bestPct = 0;
  let bestDims: string[] = [];
  for (const f of topFormats) {
    const checks: [boolean, string][] = [
      [f.hookArchetype === features.hookArchetype, "hook"],
      [f.lengthBucket === features.lengthBucket, "length"],
      [f.pacing === features.pacing, "pacing"],
      [f.ctaPattern === features.ctaPattern, "cta"],
      [f.dominantAngle === features.topicAngle, "angle"],
    ];
    const matched = checks.filter(([ok]) => ok);
    const pct = matched.length / checks.length;
    if (pct > bestPct) {
      bestPct = pct;
      best = f;
      bestDims = matched.map(([, d]) => d);
    }
  }
  return { format: best, matchPct: Math.round(bestPct * 100) / 100, matchedDimensions: bestDims };
}

function buildGaps(
  features: ViralFormatFeatures,
  benchmark: NicheBenchmarkSnapshot,
  predictedScore: number,
  median: number,
): string[] {
  const gaps: string[] = [];
  const perf = benchmark.featurePerformance;

  // Helper: best-performing value for a dimension (min sample 2).
  const bestValue = (dim: string): { value: string; avgScore: number } | null => {
    const table = perf[dim];
    if (!table) return null;
    let best: { value: string; avgScore: number } | null = null;
    for (const [value, { count, avgScore }] of Object.entries(table)) {
      if (count < 2) continue;
      if (!best || avgScore > best.avgScore) best = { value, avgScore };
    }
    return best;
  };

  const hookBest = bestValue("hookArchetype");
  if (hookBest && hookBest.value !== features.hookArchetype) {
    const cur = perf.hookArchetype?.[features.hookArchetype]?.avgScore ?? median;
    if (hookBest.avgScore > cur * 1.1) {
      gaps.push(
        `Hook archetype "${features.hookArchetype}" underperforms the niche-winning "${hookBest.value}" (avg ${hookBest.avgScore.toFixed(2)} vs ${cur.toFixed(2)}).`,
      );
    }
  }

  const ctaBest = bestValue("ctaPattern");
  if (features.ctaPattern === "none" && ctaBest && ctaBest.value !== "none") {
    gaps.push(
      `No CTA detected — top niche content uses "${ctaBest.value}" CTAs (avg ${ctaBest.avgScore.toFixed(2)}).`,
    );
  }

  // Length vs niche window.
  if (features.lengthSec != null && benchmark.lengthDistribution.count >= 4) {
    const { p25, p75 } = benchmark.lengthDistribution;
    if (features.lengthSec > p75 * 1.15) {
      gaps.push(
        `Length ${Math.round(features.lengthSec)}s exceeds the niche p75 of ${Math.round(p75)}s — tighten it.`,
      );
    } else if (features.lengthSec < p25 * 0.85) {
      gaps.push(
        `Length ${Math.round(features.lengthSec)}s is below the niche p25 of ${Math.round(p25)}s — may be too thin.`,
      );
    }
  }

  const paceBest = bestValue("pacing");
  if (paceBest && paceBest.value !== features.pacing) {
    const cur = perf.pacing?.[features.pacing]?.avgScore ?? median;
    if (paceBest.avgScore > cur * 1.15) {
      gaps.push(
        `Pacing "${features.pacing}" trails the niche-winning "${paceBest.value}" pace — consider re-cutting.`,
      );
    }
  }

  if (predictedScore < median) {
    gaps.push(
      `Predicted engagement (${predictedScore.toFixed(2)}) is below the niche median (${median.toFixed(2)}); the format mix skews to lower-performing patterns.`,
    );
  }

  return gaps;
}

/* ---------------------------------------------------------------------------
 * INTEGRATION NOTE — wiring into the live reel scorer (Agent 1 owns it).
 *
 * Do NOT edit scoring-service.ts here. After Agent 1's live scoring lands, add
 * the relative score to a reel by inserting ONE block at the point where a
 * reel's transcript + duration are known and the absolute score is produced
 * (e.g. inside scoreReel() in src/content/intelligence/, just before persisting
 * the ScoreRow):
 *
 *   import { extractFormatFeatures } from "../viral-formats/format-framework.js";
 *   import { getViralFormatsStore } from "../viral-formats/benchmark-store.js";
 *   import { detectNiche } from "../viral-formats/taxonomy.js";
 *   import { scoreAgainstNicheBenchmark } from "../viral-formats/relative-scoring.js";
 *
 *   // --- relative-to-niche score (single integration point) ---
 *   const det = detectNiche({ transcript, caption: reel.description });
 *   const feats = extractFormatFeatures({ transcript, caption: reel.description, durationSec: reel.duration_sec });
 *   const relative = scoreAgainstNicheBenchmark(
 *     feats,
 *     getViralFormatsStore().getNicheBenchmark(det.niche, det.subniche),
 *   );
 *   // attach `relative.percentile` / `relative.tier` / `relative.gaps` to the score payload.
 *
 * That is the entire wiring. Everything above is pure and already shipped.
 * ------------------------------------------------------------------------- */
