/**
 * Content Pages gateway methods.
 *
 * Wraps the ContentPagesStore + insights/connections helpers.
 * Methods:
 *   content.pages.list / get / create / update / delete
 *   content.pages.stats / insights / connections
 *   content.pages.children.list / create / update / delete
 *   content.pages.link / intel
 *   content.pages.series.list / upsert / delete
 *   content.pages.board / stage.advance
 */

import { getContentPagesStore } from "../../content/pages-store.js";
import { getConnectionsGraph, getInsightsAsync } from "../../content/pages-insights.js";
import {
  getInstagramPageStats,
  dropInMemoryCache as dropInstagramInMemoryCache,
} from "../../content/pages-instagram-stats.js";
import { getContentIntelStore } from "../../content/intelligence/store.js";
import { getPageIntel } from "../../content/pages-intel.js";
import {
  getContentSeriesService,
  type EpisodeInput,
  type StageKind,
} from "../../content/series.js";
import { getDatabasesStore } from "../../databases/store.js";
import type {
  ContentChildKind,
  ContentPageInput,
  ContentPageIntegrations,
  ContentPageListFilter,
  ContentPagePatch,
  ContentSurface,
} from "../../content/types.js";
import { CONTENT_CHILD_KINDS, isContentStage } from "../../content/types.js";
import type { PropertyValue } from "../../databases/types.js";
import type { GatewayRequestHandlers } from "./types.js";

function stateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
}

function isChildKind(k: unknown): k is ContentChildKind {
  return typeof k === "string" && (CONTENT_CHILD_KINDS as string[]).includes(k);
}

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "[error]";
  }
}

/**
 * Compute merged stats (local recompute + live Instagram overlay if connected).
 * Returns null when the page doesn't exist. Shared by `content.pages.stats`,
 * `content.pages.stats.refresh`, and the SSE-style subscribe loop.
 */
async function computeStatsWithMeta(
  id: string,
  opts: { forceRefresh?: boolean },
): Promise<{
  stats: unknown;
  page: unknown;
  meta: {
    igLive: boolean;
    fetchedAt?: number;
    fromCache?: boolean;
    staleFromDisk?: boolean;
    ageMs?: number;
    error?: { code: string; message: string };
  };
} | null> {
  const store = getContentPagesStore(stateDir());
  const page = store.recomputeStats(id);
  if (!page) return null;

  let stats = page.stats;
  let meta: {
    igLive: boolean;
    fetchedAt?: number;
    fromCache?: boolean;
    staleFromDisk?: boolean;
    ageMs?: number;
    error?: { code: string; message: string };
  } = { igLive: false };

  if (page.surface === "instagram" && page.integrations?.instagramGraph?.connected === true) {
    try {
      const igStats = await getInstagramPageStats(page, {
        forceRefresh: opts.forceRefresh === true,
      });
      if (igStats) {
        stats = {
          ...stats,
          ...(igStats.followers > 0 ? { followers: igStats.followers } : {}),
          ...(igStats.reach30d > 0 ? { reach30d: igStats.reach30d } : {}),
          ...(igStats.impressions30d !== null ? { impressions30d: igStats.impressions30d } : {}),
          ...(igStats.reachSparkline.some((v) => v > 0)
            ? { reachSparkline: igStats.reachSparkline }
            : {}),
        };
        meta = {
          igLive: true,
          fetchedAt: igStats.fetchedAt,
          fromCache: igStats.fromCache,
          ageMs: igStats.ageMs,
          ...(igStats.staleFromDisk ? { staleFromDisk: true } : {}),
          ...(igStats.error ? { error: igStats.error } : {}),
        };
      }
    } catch {
      // best-effort — local stats still returned
    }
  }

  return { stats, page: { ...page, stats }, meta };
}

export const contentPagesHandlers: GatewayRequestHandlers = {
  "content.pages.list": async ({ params, respond }) => {
    try {
      const store = getContentPagesStore(stateDir());
      const filter: ContentPageListFilter = {
        businessId: params.businessId as string | undefined,
        surface: params.surface as ContentSurface | undefined,
        status: params.status as ContentPageListFilter["status"] | undefined,
        includeArchived: params.includeArchived === true,
      };
      const pages = store.list(filter);
      respond(true, { pages, count: pages.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.get": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const store = getContentPagesStore(stateDir());
      const page = store.get(id);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, { page });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.create": async ({ params, respond }) => {
    try {
      const businessId = params.businessId as string;
      const name = params.name as string;
      const surface = params.surface as ContentSurface;
      if (!businessId || !name || !surface) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "businessId, name, and surface are required",
        });
        return;
      }
      const input: ContentPageInput = {
        businessId,
        name,
        surface,
        handle: params.handle as string | undefined,
        url: params.url as string | undefined,
        ownerAgentId: params.ownerAgentId as string | undefined,
        status: params.status as ContentPageInput["status"] | undefined,
        theme: params.theme as ContentPageInput["theme"] | undefined,
        goals: params.goals as ContentPageInput["goals"] | undefined,
        links: params.links as ContentPageInput["links"] | undefined,
      };
      const store = getContentPagesStore(stateDir());
      const page = store.create(input);
      respond(true, { page });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.update": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const patch: ContentPagePatch = {};
      if (params.name !== undefined) patch.name = params.name as string;
      if (params.surface !== undefined) patch.surface = params.surface as ContentSurface;
      if (params.handle !== undefined) patch.handle = params.handle as string;
      if (params.url !== undefined) patch.url = params.url as string;
      if (params.ownerAgentId !== undefined) patch.ownerAgentId = params.ownerAgentId as string;
      if (params.status !== undefined) patch.status = params.status as ContentPagePatch["status"];
      if (params.theme !== undefined) patch.theme = params.theme as ContentPagePatch["theme"];
      if (params.goals !== undefined) patch.goals = params.goals as ContentPagePatch["goals"];
      if (params.links !== undefined) patch.links = params.links as ContentPagePatch["links"];
      const store = getContentPagesStore(stateDir());
      const page = store.update(id, patch);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, { page });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.delete": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const cascadeChildren = params.cascadeChildren === true;
      const store = getContentPagesStore(stateDir());
      const ok = store.delete(id, { cascadeChildren });
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.stats": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const forceRefresh = params.forceRefresh === true;
      const result = await computeStatsWithMeta(id, { forceRefresh });
      if (!result) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.stats.refresh": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      // Drop in-memory cache before fetch so refresh truly hits the wire.
      dropInstagramInMemoryCache(id);
      const result = await computeStatsWithMeta(id, { forceRefresh: true });
      if (!result) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.stats.subscribe": async ({ params, respond, client, context }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      // Generate a subscription id and start emitting periodic events through
      // the gateway broadcast bus. Lifetime is capped at 30 minutes.
      const subscriptionId = `content.pages.stats.sub.${id}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const connId = client?.connId ?? null;
      const eventName = "content.pages.stats";
      const lifetimeMs = 30 * 60 * 1000;
      const intervalMs = 60 * 1000;

      const emit = async (): Promise<void> => {
        try {
          const result = await computeStatsWithMeta(id, { forceRefresh: false });
          if (!result) return;
          context.broadcast(eventName, {
            subscriptionId,
            pageId: id,
            connId,
            ...result,
          });
        } catch (e) {
          context.logGateway.warn("content.pages.stats.subscribe emit failed", {
            pageId: id,
            error: extractErrorMessage(e),
          });
        }
      };

      const timer = setInterval(() => {
        void emit();
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();

      const stop = setTimeout(() => {
        clearInterval(timer);
        clearTimeout(stop);
      }, lifetimeMs);
      if (typeof stop.unref === "function") stop.unref();

      respond(true, {
        subscriptionId,
        intervalMs,
        ttlMs: lifetimeMs,
        eventName,
      });

      // Fire one event immediately so the UI gets fresh data on connect.
      void emit();
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.insights": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const { insights, igStats } = await getInsightsAsync(stateDir(), id);
      respond(true, { insights, igStats });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.connections": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const graph = getConnectionsGraph(stateDir(), id);
      respond(true, { graph });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ── Child-database passthroughs ─────────────────────────────

  "content.pages.children.list": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      const kind = params.kind;
      if (!pageId || !isChildKind(kind)) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and a valid kind are required",
        });
        return;
      }
      const store = getContentPagesStore(stateDir());
      const page =
        kind === "series" || kind === "ideas" ? store.ensureSeries(pageId) : store.get(pageId);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      const databaseId = store.childDatabaseId(page, kind);
      const properties = store.childProperties(page, kind);
      const rows = store.childRows(page, kind);
      respond(true, { databaseId, properties, rows });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.children.create": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      const kind = params.kind;
      if (!pageId || !isChildKind(kind)) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and a valid kind are required",
        });
        return;
      }
      const title = (params.title as string) || "Untitled";
      const values = (params.values as Record<string, PropertyValue> | undefined) ?? {};
      const store = getContentPagesStore(stateDir());
      const databases = getDatabasesStore(stateDir());
      const page =
        kind === "series" || kind === "ideas" ? store.ensureSeries(pageId) : store.get(pageId);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      const databaseId = store.childDatabaseId(page, kind);
      const row = databases.upsertRow({ databaseId, title, values });
      respond(true, { row });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.children.update": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      const kind = params.kind;
      const rowId = params.rowId as string;
      if (!pageId || !isChildKind(kind) || !rowId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId, kind, and rowId are required",
        });
        return;
      }
      const store = getContentPagesStore(stateDir());
      const databases = getDatabasesStore(stateDir());
      const page = store.get(pageId);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      const databaseId = store.childDatabaseId(page, kind);
      const row = databases.upsertRow({
        id: rowId,
        databaseId,
        title: params.title as string | undefined,
        values: params.values as Record<string, PropertyValue> | undefined,
      });
      respond(true, { row });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.children.delete": async ({ params, respond }) => {
    try {
      const rowId = params.rowId as string;
      if (!rowId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "rowId is required" });
        return;
      }
      const databases = getDatabasesStore(stateDir());
      const ok = databases.deleteRow(rowId);
      respond(true, { deleted: ok, rowId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.features.set": async ({ params, respond }) => {
    try {
      const { pageId, featureId, values } = params as {
        pageId?: string;
        featureId?: string;
        values?: Record<string, unknown>;
      };
      if (!pageId || !featureId || !values) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId, featureId, and values are required",
        });
        return;
      }
      const store = getContentPagesStore(stateDir());
      const page = store.setFeatures(pageId, featureId, values);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, { page });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.integrations.update": async ({ params, respond }) => {
    try {
      const { pageId, integrations } = params as {
        pageId?: string;
        integrations?: Record<string, unknown>;
      };
      if (!pageId || !integrations) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and integrations are required",
        });
        return;
      }
      const store = getContentPagesStore(stateDir());
      const page = store.setIntegrations(pageId, integrations as ContentPageIntegrations);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, { page });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },
  // ── Page association + Content Intelligence ─────────────────

  "content.pages.link": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      const otherPageId = params.otherPageId as string;
      if (!pageId || !otherPageId || pageId === otherPageId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and a different otherPageId are required",
        });
        return;
      }
      const store = getContentPagesStore(stateDir());
      const res =
        params.unlink === true
          ? store.unlinkPages(pageId, otherPageId)
          : store.linkPages(pageId, otherPageId);
      if (!res) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, { page: res.a, other: res.b });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.intel": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const page = getContentPagesStore(stateDir()).get(id);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      // Same store instance the content.intel.* methods use (read-only here).
      const limit = typeof params.limit === "number" ? Math.min(25, Math.max(1, params.limit)) : 5;
      respond(true, { intel: getPageIntel(getContentIntelStore(), page, limit) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ── Series + stage pipeline ─────────────────────────────────

  "content.pages.series.list": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }
      if (!getContentPagesStore(stateDir()).get(pageId)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, getContentSeriesService(stateDir()).listSeries(pageId));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.series.upsert": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      const episode = params.episode as EpisodeInput | undefined;
      if (!pageId || !episode || typeof episode !== "object") {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and episode are required",
        });
        return;
      }
      if (episode.stage !== undefined && !isContentStage(episode.stage)) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "unknown stage" });
        return;
      }
      if (!getContentPagesStore(stateDir()).get(pageId)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, {
        episode: getContentSeriesService(stateDir()).upsertEpisode(pageId, episode),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.series.delete": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      const rowId = params.rowId as string;
      if (!pageId || !rowId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and rowId are required",
        });
        return;
      }
      if (!getContentPagesStore(stateDir()).get(pageId)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      const deleted = getContentSeriesService(stateDir()).deleteEpisode(pageId, rowId);
      respond(true, { deleted, rowId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.board": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }
      if (!getContentPagesStore(stateDir()).get(pageId)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      respond(true, getContentSeriesService(stateDir()).board(pageId));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "content.pages.stage.advance": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      const rowId = params.rowId as string;
      const kind = (params.kind ?? "series") as StageKind;
      if (!pageId || !rowId || (kind !== "series" && kind !== "ideas")) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId, rowId and kind ('series' | 'ideas') are required",
        });
        return;
      }
      if (params.stage !== undefined && !isContentStage(params.stage)) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "unknown stage" });
        return;
      }
      if (!getContentPagesStore(stateDir()).get(pageId)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      const result = getContentSeriesService(stateDir()).advanceStage({
        pageId,
        kind,
        rowId,
        stage: params.stage as EpisodeInput["stage"],
        repurpose: params.repurpose !== false,
      });
      respond(true, { result });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },
};
