/**
 * Viral-Format Intelligence — gateway RPC handlers.
 *
 * Operator + agent surface over the self-contained `src/content/viral-formats/`
 * subsystem: the niche taxonomy, the /watch ingestion engine, the historical
 * benchmark base, the top-format discovery, and the relative-scoring adapter.
 *
 * This file owns a fresh `viral.formats.*` namespace and touches no other
 * domain's store or handlers. New methods require a gateway restart to go live.
 *
 * RPCs:
 *   viral.formats.taxonomy    — the niche/subniche taxonomy
 *   viral.formats.detectNiche — classify transcript/caption/topic → (niche,subniche)
 *   viral.formats.watch       — ingest top/competitor content into the base
 *   viral.formats.topFormats  — discovered top formats for a (sub)niche
 *   viral.formats.benchmark   — the rolling benchmark snapshot for a (sub)niche
 *   viral.formats.score       — score reel features RELATIVE to the niche
 *   viral.formats.list        — watched items (optionally filtered)
 *   viral.formats.stats       — corpus totals + per-niche sample sizes + jobs
 */

import { GatewayRequestHandlers } from "./types.js";
import {
  detectNiche,
  listNiches,
  getViralFormatsStore,
  discoverTopFormats,
  extractFormatFeatures,
  scoreAgainstNicheBenchmark,
  watch,
  type ScoredCorpusItem,
  type ViralFormatFeatures,
  type WatchedItemInput,
  type WatchSourceType,
} from "../../content/viral-formats/index.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export const viralFormatsHandlers: GatewayRequestHandlers = {
  "viral.formats.taxonomy": ({ respond }) => {
    try {
      respond(true, { niches: listNiches() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "viral.formats.detectNiche": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const detection = detectNiche({
        transcript: str(p.transcript) ?? null,
        caption: str(p.caption) ?? null,
        topic: str(p.topic) ?? null,
        account: str(p.account) ?? null,
        hashtags: Array.isArray(p.hashtags) ? (p.hashtags as string[]) : null,
      });
      respond(true, { detection });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "viral.formats.watch": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const sourceType = (str(p.sourceType) ?? "account") as WatchSourceType;
      const targets = Array.isArray(p.targets)
        ? (p.targets as string[])
        : (str(p.targets) ?? str(p.target) ?? []);
      const items = Array.isArray(p.items) ? (p.items as WatchedItemInput[]) : undefined;
      const result = await watch({
        targets,
        sourceType,
        niche: str(p.niche) ?? null,
        subniche: str(p.subniche) ?? null,
        max: num(p.max),
        items,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "viral.formats.topFormats": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const niche = str(p.niche);
      if (!niche)
        return respond(false, undefined, { code: "BAD_REQUEST", message: "niche required" });
      const subniche = str(p.subniche) ?? null;
      const store = getViralFormatsStore();
      const rows = store.listItems({ niche, subniche });
      const scored: ScoredCorpusItem[] = rows.map((r) => ({
        features: JSON.parse(r.features_json) as ViralFormatFeatures,
        score: r.engagement_score,
        percentile: r.percentile ?? undefined,
      }));
      respond(true, discoverTopFormats(scored, { niche, subniche, limit: num(p.limit) ?? 8 }));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "viral.formats.benchmark": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const niche = str(p.niche);
      if (!niche)
        return respond(false, undefined, { code: "BAD_REQUEST", message: "niche required" });
      const snapshot = getViralFormatsStore().getNicheBenchmark(niche, str(p.subniche) ?? null, {
        fresh: p.fresh === true,
      });
      respond(true, { benchmark: snapshot });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "viral.formats.score": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const niche = str(p.niche);
      if (!niche)
        return respond(false, undefined, { code: "BAD_REQUEST", message: "niche required" });
      // Accept either pre-extracted features or raw transcript/caption/duration.
      const features: ViralFormatFeatures =
        p.features && typeof p.features === "object"
          ? (p.features as ViralFormatFeatures)
          : extractFormatFeatures({
              transcript: str(p.transcript) ?? null,
              caption: str(p.caption) ?? null,
              durationSec: num(p.durationSec) ?? null,
            });
      const benchmark = getViralFormatsStore().getNicheBenchmark(niche, str(p.subniche) ?? null);
      respond(true, { score: scoreAgainstNicheBenchmark(features, benchmark), features });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "viral.formats.list": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const rows = getViralFormatsStore().listItems({
        niche: str(p.niche),
        subniche: str(p.subniche) ?? null,
        limit: num(p.limit),
      });
      respond(true, { items: rows, count: rows.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "viral.formats.stats": ({ respond }) => {
    try {
      const store = getViralFormatsStore();
      respond(true, { ...store.stats(), jobs: store.listJobs() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
