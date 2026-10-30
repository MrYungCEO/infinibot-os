/**
 * Content Trends — gateway RPC handlers.
 *
 * The operator surface behind the dashboard <trends-radar> band: free /
 * open-source trends + news + social-format aggregation for the user's content
 * niche over the last 30 days.
 *
 * Data source: `src/content/trends/aggregator.ts` (no paid API keys). Results
 * are cached in `<stateDir>/content-trends.db` with a TTL so we don't re-fetch
 * upstream RSS/JSON on every dashboard load. The payload shape mirrors the
 * baked fallback snapshot at `ui/public/content-trends-snapshot.json` so the UI
 * has a single render path whether the data is live or from the snapshot.
 *
 * On a fresh aggregation we opportunistically run the proactive spike-watcher
 * ({@link checkTrendsAndAlert}) which may emit ONE NOTABLE pop-up via the
 * existing proactive system (cooldown + dedupe enforced in the watcher).
 *
 * RPCs:
 *   content.trends.last30days   — cached-or-fresh bundle (default surface)
 *   content.trends.refresh      — force a re-fetch, bypassing the TTL
 *   content.trends.checkAlerts  — re-run the proactive spike-watch on cache
 *   content.trends.capabilities — availability probe (gates UI "live" badge)
 */

import { GatewayRequestHandlers } from "./types.js";
import { resolveStateDir } from "../../config/paths.js";
import { aggregateTrends } from "../../content/trends/aggregator.js";
import { readCache, writeCache } from "../../content/trends/store.js";
import { checkTrendsAndAlert } from "../../content/trends/proactive-watch.js";
import type { TrendsBundle, TrendsOptions } from "../../content/trends/types.js";

// 6-hour TTL: trends move on a daily cadence, so a 6h cache keeps the dashboard
// snappy while staying fresh enough for "last 30 days".
const TTL_MS = 6 * 60 * 60 * 1000;

function cacheKey(niche: string | undefined): string {
  return `last30:${(niche || "default").toLowerCase().trim()}`;
}

function readOpts(params: unknown): TrendsOptions {
  const p = (params ?? {}) as Record<string, unknown>;
  return {
    niche: typeof p.niche === "string" ? p.niche : undefined,
    keywords: Array.isArray(p.keywords)
      ? (p.keywords as string[]).filter((k) => typeof k === "string")
      : undefined,
    force: p.force === true,
    timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
  };
}

/** Aggregate fresh, persist, and run the proactive spike-watch. */
async function aggregateAndCache(opts: TrendsOptions, stateDir: string): Promise<TrendsBundle> {
  const bundle = await aggregateTrends(opts);
  writeCache(stateDir, cacheKey(opts.niche), bundle);
  // Opportunistic, non-blocking alerting — never let it break the response.
  try {
    checkTrendsAndAlert(bundle, stateDir);
  } catch {
    /* alerting is best-effort */
  }
  return bundle;
}

export const contentTrendsHandlers: GatewayRequestHandlers = {
  "content.trends.last30days": async ({ params, respond }) => {
    try {
      const opts = readOpts(params);
      const stateDir = resolveStateDir();
      if (!opts.force) {
        const cached = readCache(stateDir, cacheKey(opts.niche), TTL_MS);
        if (cached) {
          respond(true, { bundle: cached });
          return;
        }
      }
      const bundle = await aggregateAndCache(opts, stateDir);
      respond(true, { bundle });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "content.trends.refresh": async ({ params, respond }) => {
    try {
      const opts = { ...readOpts(params), force: true };
      const stateDir = resolveStateDir();
      const bundle = await aggregateAndCache(opts, stateDir);
      respond(true, { bundle });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "content.trends.checkAlerts": async ({ params, respond }) => {
    try {
      const opts = readOpts(params);
      const stateDir = resolveStateDir();
      let bundle = readCache(stateDir, cacheKey(opts.niche), TTL_MS);
      if (!bundle) bundle = await aggregateAndCache(opts, stateDir);
      const result = checkTrendsAndAlert(bundle, stateDir);
      respond(true, { result });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // The mere presence of this method tells the UI the trends RPCs are
  // registered (gateway restarted). The UI shows a "live" vs "snapshot" badge
  // off a successful call here.
  "content.trends.capabilities": ({ respond }) => {
    try {
      const stateDir = resolveStateDir();
      const cached = readCache(stateDir, cacheKey(undefined), TTL_MS);
      respond(true, {
        available: true,
        cached: Boolean(cached),
        ttlMs: TTL_MS,
        generatedAt: cached?.generatedAt ?? null,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
