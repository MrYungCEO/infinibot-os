/**
 * content/trends/proactive-watch — lightweight agentic alerting for the trends
 * band. When a notable trend / news spike is detected in a freshly-aggregated
 * bundle, emit ONE proactive pop-up through the EXISTING proactive system
 * ({@link emitProactiveServerSide}) — we never restructure the proactive core.
 *
 * Opt-in + non-spammy:
 *   • Disabled unless INFINIBOT_TRENDS_ALERTS !== "0" (default on, but gated by
 *     cooldown so it can't spam).
 *   • A per-niche cooldown (default 6h) is persisted in content-trends.db.
 *   • A content signature dedupes against the last alert so the same spike
 *     never re-fires even after the cooldown lapses.
 *
 * "Spike" heuristic (free-data, no model call): a news topic clustering ≥3
 * related articles, OR a social insight with an outsized engagement score
 * relative to the batch median. The first qualifying signal becomes the alert.
 */

import type { TrendsBundle } from "./types.js";
import { readAlertState, writeAlertState } from "./store.js";
import { emitProactiveServerSide } from "../../proactive/emit.js";

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
const CLUSTER_SPIKE = 3; // ≥3 clustered articles on one topic = newsworthy

export interface TrendsSpike {
  kind: "news" | "social";
  title: string;
  url: string;
  detail: string;
}

/** Find the most notable spike in a bundle, or null when nothing qualifies. */
export function detectSpike(bundle: TrendsBundle): TrendsSpike | null {
  // 1) News cluster spike — strongest signal.
  const topNews = bundle.newsTopics.find((t) => t.cluster >= CLUSTER_SPIKE);
  if (topNews) {
    return {
      kind: "news",
      title: topNews.title,
      url: topNews.url,
      detail: `${topNews.cluster} outlets covered this in the last 30 days (${topNews.source}).`,
    };
  }
  // 2) Social engagement outlier — score ≥ 2.5× the batch median.
  const scores = bundle.socialInsights.map((s) => s.score).sort((a, b) => a - b);
  if (scores.length >= 4) {
    const median = scores[Math.floor(scores.length / 2)] || 0;
    const outlier = bundle.socialInsights.find((s) => median > 0 && s.score >= median * 2.5);
    if (outlier) {
      return {
        kind: "social",
        title: outlier.title,
        url: outlier.url,
        detail: `Outsized engagement (${outlier.score.toLocaleString()}) in ${outlier.community ?? outlier.platform}.`,
      };
    }
  }
  return null;
}

/** Stable signature for a spike so the same one never re-alerts. */
function signatureOf(spike: TrendsSpike): string {
  return `${spike.kind}:${spike.url || spike.title}`;
}

export interface AlertResult {
  emitted: boolean;
  reason: string;
  spike?: TrendsSpike;
}

/**
 * Inspect a fresh bundle and, if a notable spike clears the cooldown + dedupe
 * gates, emit a single proactive NOTABLE pop-up suggesting a script angle.
 * Never throws. Returns what it decided so callers/tests can assert.
 */
export function checkTrendsAndAlert(bundle: TrendsBundle, stateDir: string): AlertResult {
  if (process.env.INFINIBOT_TRENDS_ALERTS === "0") {
    return { emitted: false, reason: "disabled" };
  }
  const spike = detectSpike(bundle);
  if (!spike) return { emitted: false, reason: "no-spike" };

  const key = `niche:${bundle.niche}`;
  const sig = signatureOf(spike);
  const prior = readAlertState(stateDir, key);
  if (prior) {
    if (prior.signature === sig) return { emitted: false, reason: "duplicate", spike };
    if (Date.now() - prior.lastAlertAt < COOLDOWN_MS) {
      return { emitted: false, reason: "cooldown", spike };
    }
  }

  const built = emitProactiveServerSide(
    {
      tier: "NOTABLE",
      title:
        spike.kind === "news"
          ? "📈 Trending news spike in your niche"
          : "🔥 A post is overperforming",
      body:
        `**${spike.title}**\n\n${spike.detail}\n\n` +
        `Turn this into a script angle while it's hot — open the Trends Radar on your dashboard.`,
      attribution: { agentId: "trends-radar", agentName: "Trends Radar" },
      actions: [
        {
          id: "open-trends",
          kind: "open",
          label: "Open Trends Radar",
          primary: true,
          payload: { tab: "dashboard" },
        },
        {
          id: "open-source",
          kind: "open",
          label: "View source",
          payload: { url: spike.url },
        },
        { id: "snooze", kind: "snooze", label: "Snooze" },
      ],
      dedupKey: `trends:${bundle.niche}`,
      voice: `Heads up — ${spike.title}. Worth a script while it's trending.`,
    },
    stateDir,
  );

  if (!built) return { emitted: false, reason: "emit-failed", spike };
  writeAlertState(stateDir, key, sig);
  return { emitted: true, reason: "emitted", spike };
}
