/**
 * Content Intelligence tool — read-only access to the operator's reel library
 * for marketing analysis.
 *
 * This is the grounding surface for the CMO agent: it reads the same SQLite
 * store the content.intel.* RPCs serve, but never mutates it. It lets an agent
 * pull top performers, inspect a single reel (with transcript + AI score), and
 * summarise the library so its advice is grounded in real performance data.
 */

import { Type } from "@sinclair/typebox";

import { getContentIntelStore } from "../../content/intelligence/store.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const INTEL_ACTIONS = ["top_reels", "get_reel", "library_stats"] as const;
const SORT_METRICS = ["viral", "overall", "hook", "value", "views", "saves"] as const;
const SORT_ORDER = ["desc", "asc"] as const;

const ContentIntelToolSchema = Type.Object({
  action: stringEnum(INTEL_ACTIONS),
  /** Which metric to rank by (top_reels). */
  metric: Type.Optional(
    stringEnum(SORT_METRICS, { description: "Ranking metric for top_reels; default 'viral'." }),
  ),
  /** Sort direction — 'asc' surfaces the worst performers for failure analysis. */
  order: Type.Optional(
    stringEnum(SORT_ORDER, { description: "Sort direction for top_reels; default 'desc'." }),
  ),
  /** Max reels to return (top_reels). */
  limit: Type.Optional(Type.Number({ description: "Max reels to return (default 10, max 50)." })),
  /** Only include reels that already have an AI score (top_reels). */
  scoredOnly: Type.Optional(
    Type.Boolean({ description: "Restrict top_reels to scored reels (default true)." }),
  ),
  /** Reel shortcode (get_reel). */
  shortcode: Type.Optional(
    Type.String({ description: "Instagram shortcode of a single reel (get_reel)." }),
  ),
});

type ReelSummary = {
  shortcode: string;
  url: string;
  account: string;
  description: string;
  publish_time: string;
  duration_sec: number | null;
  views: number | null;
  saves: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  tier: string | null;
  hook: number | null;
  value: number | null;
  viral: number | null;
  overall: number | null;
  reason: string | null;
};

function metricValue(s: ReelSummary, metric: (typeof SORT_METRICS)[number]): number {
  const v = s[metric];
  return typeof v === "number" ? v : -1;
}

export function createContentIntelTool(_options?: { agentId?: string }): AnyAgentTool {
  return {
    label: "Content Intelligence",
    name: "content_intel",
    description:
      "Read the operator's Instagram reel library for marketing analysis (read-only). Actions: " +
      "'top_reels' (rank reels by viral/overall/hook/value/views/saves; use order:'asc' to study flops), " +
      "'get_reel' (full reel detail incl. transcript + AI score for a shortcode), " +
      "'library_stats' (totals, tier distribution, pipeline coverage). " +
      "Use this to ground every recommendation in real performance data before advising or scripting.",
    parameters: ContentIntelToolSchema,
    execute: async (_toolCallId, args, signal) => {
      if (signal?.aborted) {
        const err = new Error("content_intel aborted");
        err.name = "AbortError";
        throw err;
      }
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const store = getContentIntelStore();

      if (action === "library_stats") {
        const reels = store.listReelsWithMetrics(5000);
        const byState = store.countByState();
        const tiers: Record<string, number> = {};
        let totalViews = 0;
        let totalSaves = 0;
        for (const r of reels) {
          totalViews += r.views ?? 0;
          totalSaves += r.saves ?? 0;
          if (r.has_score) {
            const score = store.getScore(r.shortcode);
            const tier = score?.tier ?? "—";
            tiers[tier] = (tiers[tier] ?? 0) + 1;
          }
        }
        return jsonResult({
          totals: {
            reels: byState.total,
            transcribed: byState.hasTranscript,
            scored: byState.hasScore,
            total_views: totalViews,
            total_saves: totalSaves,
          },
          tier_distribution: tiers,
        });
      }

      if (action === "get_reel") {
        const shortcode = readStringParam(params, "shortcode", { required: true });
        const reel = store.getReel(shortcode);
        if (!reel) return jsonResult({ found: false, shortcode });
        const metrics = store.getLatestMetrics(shortcode);
        const score = store.getScore(shortcode);
        const transcript = store.getTranscript(shortcode);
        return jsonResult({
          found: true,
          reel: {
            shortcode: reel.shortcode,
            url: reel.url,
            account: reel.account,
            description: reel.description,
            publish_time: reel.publish_time,
            duration_sec: reel.duration_sec,
            views: metrics?.views ?? null,
            reach: metrics?.reach ?? null,
            likes: metrics?.likes ?? null,
            comments: metrics?.comments ?? null,
            shares: metrics?.shares ?? null,
            saves: metrics?.saves ?? null,
            follows: metrics?.follows ?? null,
            tier: score?.tier ?? null,
            hook: score?.hook ?? null,
            value: score?.value ?? null,
            viral: score?.viral ?? null,
            overall: score?.overall ?? null,
            reason: score?.reason ?? null,
            idea_vs_execution: score?.idea_vs_execution ?? null,
            transcript: transcript?.text ?? null,
            transcript_engine: transcript?.engine ?? null,
          },
        });
      }

      if (action === "top_reels") {
        const metric = (
          typeof params.metric === "string" ? params.metric : "viral"
        ) as (typeof SORT_METRICS)[number];
        const order = (typeof params.order === "string" ? params.order : "desc") as "asc" | "desc";
        const scoredOnly = typeof params.scoredOnly === "boolean" ? params.scoredOnly : true;
        const limit = Math.max(1, Math.min(50, readNumberParam(params, "limit") ?? 10));

        const reels = store.listReelsWithMetrics(5000);
        const summaries: ReelSummary[] = [];
        for (const r of reels) {
          const score = r.has_score ? store.getScore(r.shortcode) : undefined;
          if (scoredOnly && !score) continue;
          summaries.push({
            shortcode: r.shortcode,
            url: r.url,
            account: r.account,
            description: r.description,
            publish_time: r.publish_time,
            duration_sec: r.duration_sec,
            views: r.views ?? null,
            saves: r.saves ?? null,
            likes: r.likes ?? null,
            comments: r.comments ?? null,
            shares: r.shares ?? null,
            tier: score?.tier ?? null,
            hook: score?.hook ?? null,
            value: score?.value ?? null,
            viral: score?.viral ?? null,
            overall: score?.overall ?? null,
            reason: score?.reason ?? null,
          });
        }
        summaries.sort((a, b) => {
          const av = metricValue(a, metric);
          const bv = metricValue(b, metric);
          return order === "asc" ? av - bv : bv - av;
        });
        return jsonResult({
          metric,
          order,
          count: Math.min(limit, summaries.length),
          reels: summaries.slice(0, limit),
        });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
