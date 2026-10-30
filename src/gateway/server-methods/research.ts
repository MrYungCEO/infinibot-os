/**
 * Research Intelligence Gateway Methods
 * Handles all research:* RPC calls
 */

import type { GatewayRequestHandlers } from "./types.js";
import * as store from "../../research/store.js";
import { resolve } from "path";
import { gatherResearch, type ResearchOptions } from "../../content/research-service.js";

// Get state directory
function getStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || "state";
}

// =============================================================================
// HANDLERS
// =============================================================================

export const researchHandlers: GatewayRequestHandlers = {
  // ---------------------------------------------------------------------------
  // STATUS
  // ---------------------------------------------------------------------------

  "research:status": async ({ respond }) => {
    try {
      const stateDir = resolve(getStateDir());

      // Seed default data on first access
      store.seedDefaultData(stateDir);

      const topics = store.getTopics(stateDir);
      const watchlist = store.getWatchlist(stateDir);
      const articles = store.getArticles(stateDir, 100);
      const settings = store.getSettings(stateDir);
      const stats = store.getStats(stateDir);

      respond(true, {
        topics,
        watchlist,
        articles,
        settings,
        stats,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ---------------------------------------------------------------------------
  // TOPICS
  // ---------------------------------------------------------------------------

  "research:topic.add": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const topic = store.addTopic(stateDir, params as any);
      respond(true, { topic });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "research:topic.remove": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const id = params?.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing id" });
        return;
      }
      const success = store.removeTopic(stateDir, id);
      respond(true, { success });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "research:topic.toggle": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const id = params?.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing id" });
        return;
      }
      const success = store.toggleTopic(stateDir, id);
      respond(true, { success });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ---------------------------------------------------------------------------
  // WATCHLIST
  // ---------------------------------------------------------------------------

  "research:watchlist.add": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const asset = store.addWatchlistAsset(stateDir, params as any);
      respond(true, { asset });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "research:watchlist.remove": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const id = params?.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing id" });
        return;
      }
      const success = store.removeWatchlistAsset(stateDir, id);
      respond(true, { success });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "research:watchlist.toggle": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const id = params?.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing id" });
        return;
      }
      const success = store.toggleWatchlistAsset(stateDir, id);
      respond(true, { success });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ---------------------------------------------------------------------------
  // ARTICLES
  // ---------------------------------------------------------------------------

  "research:article.read": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const id = params?.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing id" });
        return;
      }
      const success = store.markArticleRead(stateDir, id);
      respond(true, { success });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "research:article.bookmark": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const id = params?.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing id" });
        return;
      }
      const success = store.bookmarkArticle(stateDir, id);
      respond(true, { success });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "research:article.add": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const article = store.addArticle(stateDir, params as any);
      respond(true, { article });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ---------------------------------------------------------------------------
  // SETTINGS
  // ---------------------------------------------------------------------------

  "research:settings.update": async ({ respond, params }) => {
    try {
      const stateDir = resolve(getStateDir());
      const settings = store.updateSettings(stateDir, params as any);
      respond(true, { settings });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ---------------------------------------------------------------------------
  // FETCH
  // ---------------------------------------------------------------------------

  "research:fetch": async ({ respond }) => {
    try {
      // For now, return message - actual fetching will be done by agent tasks
      // that call web_search and process the results
      respond(true, { count: 0, message: "Use agent task to fetch research" });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ---------------------------------------------------------------------------
  // NOTION SYNC
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // GATHER — free-API + browser-relay research aggregator
  // Implements src/content/research-service.contract.md
  // ---------------------------------------------------------------------------

  "research.gather": async ({ respond, params }) => {
    try {
      const p = (params || {}) as Partial<ResearchOptions>;
      const query = typeof p.query === "string" ? p.query.trim() : "";
      if (!query) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "query is required" });
        return;
      }
      const bundle = await gatherResearch({
        query,
        sources: p.sources,
        timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
        perSource: typeof p.perSource === "number" ? p.perSource : undefined,
        useBrowserRelay: typeof p.useBrowserRelay === "boolean" ? p.useBrowserRelay : undefined,
        language: typeof p.language === "string" ? p.language : undefined,
        freshnessDays: typeof p.freshnessDays === "number" ? p.freshnessDays : undefined,
      });
      respond(true, { bundle });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "research:notion.sync": async ({ respond }) => {
    try {
      const stateDir = resolve(getStateDir());
      const settings = store.getSettings(stateDir);

      if (!settings.notionSync || !settings.notionDatabaseId) {
        respond(true, { synced: 0, error: "Notion sync not configured" });
        return;
      }

      // For now, return message - actual syncing will be done by agent tasks
      respond(true, { synced: 0, message: "Use agent task to sync to Notion" });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
