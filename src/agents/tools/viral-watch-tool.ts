/**
 * viral_watch — agent tool for the viral-format intelligence subsystem.
 *
 * Lets an agent (e.g. the CMO) build and query the historical benchmark base:
 * ingest top/competitor content for a niche, discover the winning formats, and
 * score a draft reel RELATIVE to what wins in the niche rather than on an
 * absolute scale.
 *
 * Self-contained: it only calls the pure `src/content/viral-formats/` subsystem.
 * To expose it to agents, register it in the tool array (one line) — see the
 * registration note at the bottom. Until then the same capability is reachable
 * over the `viral.formats.*` gateway RPCs.
 */

import { Type } from "@sinclair/typebox";

import {
  detectNiche,
  discoverTopFormats,
  extractFormatFeatures,
  getViralFormatsStore,
  scoreAgainstNicheBenchmark,
  watch,
  type ScoredCorpusItem,
  type ViralFormatFeatures,
  type WatchSourceType,
} from "../../content/viral-formats/index.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const WATCH_ACTIONS = [
  "watch",
  "top_formats",
  "benchmark",
  "score",
  "detect_niche",
  "stats",
] as const;
const SOURCE_TYPES = ["account", "hashtag", "url", "list", "manual"] as const;

const ViralWatchSchema = Type.Object({
  action: stringEnum(WATCH_ACTIONS, {
    description:
      "watch (ingest a target into the base), top_formats, benchmark, score (a draft reel vs the niche), detect_niche, stats.",
  }),
  target: Type.Optional(
    Type.String({ description: "Account handle, hashtag, URL, or list id (watch)." }),
  ),
  sourceType: Type.Optional(
    stringEnum(SOURCE_TYPES, { description: "How to interpret target (watch)." }),
  ),
  niche: Type.Optional(
    Type.String({ description: "Niche id, e.g. 'ai' (required for top_formats/benchmark/score)." }),
  ),
  subniche: Type.Optional(
    Type.String({ description: "Subniche id, e.g. 'ai-agents-automation'." }),
  ),
  max: Type.Optional(
    Type.Number({ description: "Max items to ingest per target (watch; default 25)." }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max formats to return (top_formats; default 8)." }),
  ),
  transcript: Type.Optional(Type.String({ description: "Reel transcript (score/detect_niche)." })),
  caption: Type.Optional(Type.String({ description: "Reel caption (score/detect_niche)." })),
  durationSec: Type.Optional(Type.Number({ description: "Reel length in seconds (score)." })),
});

export function createViralWatchTool(_options?: { agentId?: string }): AnyAgentTool {
  return {
    label: "Viral Watch",
    name: "viral_watch",
    description:
      "Build and query the historical viral-format benchmark base. Detect the niche of content, ingest " +
      "top/competitor content via free public sources (YouTube RSS, Reddit JSON, oEmbed) into the base, " +
      "discover the winning formats per (sub)niche, and score a draft reel RELATIVE to what actually wins " +
      "in the niche (percentile + tier + gaps), not on an absolute scale. Use before scripting to ground " +
      "ideas in proven formats, and after drafting to check fit. Actions: watch, top_formats, benchmark, " +
      "score, detect_niche, stats.",
    parameters: ViralWatchSchema,
    execute: async (_toolCallId, args, signal) => {
      if (signal?.aborted) {
        const err = new Error("viral_watch aborted");
        err.name = "AbortError";
        throw err;
      }
      const p = args as Record<string, unknown>;
      const action = readStringParam(p, "action", { required: true });
      const store = getViralFormatsStore();

      if (action === "detect_niche") {
        return jsonResult(
          detectNiche({
            transcript: readStringParam(p, "transcript", { required: false }) ?? null,
            caption: readStringParam(p, "caption", { required: false }) ?? null,
          }),
        );
      }

      if (action === "watch") {
        const result = await watch({
          targets: readStringParam(p, "target", { required: true }),
          sourceType: (readStringParam(p, "sourceType", { required: false }) ??
            "account") as WatchSourceType,
          niche: readStringParam(p, "niche", { required: false }) ?? null,
          subniche: readStringParam(p, "subniche", { required: false }) ?? null,
          max: readNumberParam(p, "max", { required: false }) ?? undefined,
        });
        return jsonResult(result);
      }

      const niche = readStringParam(p, "niche", { required: action !== "stats" });
      const subniche = readStringParam(p, "subniche", { required: false }) ?? null;

      if (action === "stats") {
        return jsonResult({ ...store.stats(), jobs: store.listJobs() });
      }

      if (action === "top_formats") {
        const rows = store.listItems({ niche: niche!, subniche });
        const scored: ScoredCorpusItem[] = rows.map((r) => ({
          features: JSON.parse(r.features_json) as ViralFormatFeatures,
          score: r.engagement_score,
          percentile: r.percentile ?? undefined,
        }));
        return jsonResult(
          discoverTopFormats(scored, {
            niche: niche!,
            subniche,
            limit: readNumberParam(p, "limit", { required: false }) ?? 8,
          }),
        );
      }

      if (action === "benchmark") {
        return jsonResult({ benchmark: store.getNicheBenchmark(niche!, subniche) });
      }

      if (action === "score") {
        const features = extractFormatFeatures({
          transcript: readStringParam(p, "transcript", { required: false }) ?? null,
          caption: readStringParam(p, "caption", { required: false }) ?? null,
          durationSec: readNumberParam(p, "durationSec", { required: false }) ?? null,
        });
        const benchmark = store.getNicheBenchmark(niche!, subniche);
        return jsonResult({ score: scoreAgainstNicheBenchmark(features, benchmark), features });
      }

      return jsonResult({ error: `unknown action: ${action}` });
    },
  };
}

// Registered by the content-studio plugin (src/content-studio/tools.ts).
