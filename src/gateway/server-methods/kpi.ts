/**
 * KPI Analytics Gateway Handlers
 * Gateway methods for the universal KPI tracking system
 */

import { GatewayRequestHandlers } from "./types.js";
import { getKPITracker } from "../../analytics/kpi-tracker.js";
import type { TrackingPayload, TimeRange, GoalConfig, FunnelStep } from "../../analytics/types.js";

const tracker = () => getKPITracker();

export const kpiHandlers: GatewayRequestHandlers = {
  // ═══════════════════════════════════════════════════════════════
  // EVENT TRACKING (called by embed scripts)
  // ═══════════════════════════════════════════════════════════════

  "kpi.track": async ({ params, respond }) => {
    const payload = params as unknown as TrackingPayload;

    if (!payload.siteKey) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing siteKey" });
      return;
    }
    if (!payload.fingerprint) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing fingerprint" });
      return;
    }
    if (!payload.event?.type) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "Missing event.type" });
      return;
    }

    const result = await tracker().track(payload);
    respond(true, result);
  },

  // ═══════════════════════════════════════════════════════════════
  // SITE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  "kpi.sites.create": async ({ params, respond }) => {
    const { domain, name, communityId, settings } = params as {
      domain: string;
      name: string;
      communityId?: string;
      settings?: Record<string, unknown>;
    };

    if (!domain || !name) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "domain and name are required" });
      return;
    }

    const site = tracker().createSite({ domain, name, communityId, settings });
    respond(true, { site });
  },

  "kpi.sites.get": async ({ params, respond }) => {
    const { siteId } = params as { siteId: string };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const site = tracker().getSite(siteId);
    if (!site) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Site not found" });
      return;
    }

    respond(true, { site });
  },

  "kpi.sites.list": async ({ params, respond }) => {
    const { communityId } = params as { communityId?: string };
    const sites = tracker().listSites(communityId);
    respond(true, { sites });
  },

  "kpi.sites.update": async ({ params, respond }) => {
    const { siteId, ...updates } = params as { siteId: string } & Record<string, unknown>;

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const site = tracker().updateSite(siteId, updates);
    if (!site) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Site not found" });
      return;
    }

    respond(true, { site });
  },

  "kpi.sites.delete": async ({ params, respond }) => {
    const { siteId } = params as { siteId: string };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const deleted = tracker().deleteSite(siteId);
    respond(true, { deleted });
  },

  "kpi.sites.regenerateKey": async ({ params, respond }) => {
    const { siteId } = params as { siteId: string };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const scriptKey = tracker().regenerateScriptKey(siteId);
    if (!scriptKey) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Site not found" });
      return;
    }

    respond(true, { scriptKey });
  },

  "kpi.sites.getScript": async ({ params, respond }) => {
    const { siteId, gatewayUrl } = params as { siteId: string; gatewayUrl?: string };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const site = tracker().getSite(siteId);
    if (!site) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Site not found" });
      return;
    }

    // Generate embed script
    const baseUrl = gatewayUrl || "https://your-gateway.com";
    const script = generateEmbedScript(site.scriptKey, baseUrl);

    respond(true, { script, scriptKey: site.scriptKey });
  },

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  "kpi.analytics.get": async ({ params, respond }) => {
    const { siteId, timeRange = "30d" } = params as { siteId: string; timeRange?: TimeRange };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const analytics = tracker().getAnalytics(siteId, timeRange);
    respond(true, { analytics });
  },

  "kpi.analytics.overview": async ({ params, respond }) => {
    const { siteId, timeRange = "30d" } = params as { siteId: string; timeRange?: TimeRange };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const analytics = tracker().getAnalytics(siteId, timeRange);
    respond(true, { overview: analytics.overview });
  },

  "kpi.analytics.realtime": async ({ params, respond }) => {
    const { siteId } = params as { siteId: string };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const analytics = tracker().getAnalytics(siteId, "1h");
    respond(true, { realtime: analytics.realtime });
  },

  "kpi.analytics.timeseries": async ({ params, respond }) => {
    const { siteId, metric = "page_views", timeRange = "30d" } = params as {
      siteId: string;
      metric?: "page_views" | "sessions" | "visitors";
      timeRange?: TimeRange;
    };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const data = tracker().getTimeSeries(siteId, metric, timeRange);
    respond(true, { metric, timeRange, data });
  },

  // ═══════════════════════════════════════════════════════════════
  // GOALS
  // ═══════════════════════════════════════════════════════════════

  "kpi.goals.create": async ({ params, respond }) => {
    const { siteId, name, description, type, config, value, active = true } = params as {
      siteId: string;
      name: string;
      description?: string;
      type: "destination" | "duration" | "pages_per_session" | "event";
      config: GoalConfig;
      value?: number;
      active?: boolean;
    };

    if (!siteId || !name || !type || !config) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId, name, type, and config are required" });
      return;
    }

    const goal = tracker().createGoal({ siteId, name, description, type, config, value, active });
    respond(true, { goal });
  },

  "kpi.goals.get": async ({ params, respond }) => {
    const { goalId } = params as { goalId: string };

    if (!goalId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "goalId is required" });
      return;
    }

    const goal = tracker().getGoal(goalId);
    if (!goal) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Goal not found" });
      return;
    }

    respond(true, { goal });
  },

  "kpi.goals.list": async ({ params, respond }) => {
    const { siteId } = params as { siteId: string };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const goals = tracker().listGoals(siteId);
    respond(true, { goals });
  },

  "kpi.goals.update": async ({ params, respond }) => {
    const { goalId, ...updates } = params as { goalId: string } & Record<string, unknown>;

    if (!goalId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "goalId is required" });
      return;
    }

    const goal = tracker().updateGoal(goalId, updates);
    if (!goal) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Goal not found" });
      return;
    }

    respond(true, { goal });
  },

  "kpi.goals.delete": async ({ params, respond }) => {
    const { goalId } = params as { goalId: string };

    if (!goalId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "goalId is required" });
      return;
    }

    const deleted = tracker().deleteGoal(goalId);
    respond(true, { deleted });
  },

  // ═══════════════════════════════════════════════════════════════
  // FUNNELS
  // ═══════════════════════════════════════════════════════════════

  "kpi.funnels.create": async ({ params, respond }) => {
    const { siteId, name, description, steps } = params as {
      siteId: string;
      name: string;
      description?: string;
      steps: FunnelStep[];
    };

    if (!siteId || !name || !steps?.length) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId, name, and steps are required" });
      return;
    }

    const funnel = tracker().createFunnel({ siteId, name, description, steps });
    respond(true, { funnel });
  },

  "kpi.funnels.get": async ({ params, respond }) => {
    const { funnelId } = params as { funnelId: string };

    if (!funnelId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
      return;
    }

    const funnel = tracker().getFunnel(funnelId);
    if (!funnel) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Funnel not found" });
      return;
    }

    respond(true, { funnel });
  },

  "kpi.funnels.list": async ({ params, respond }) => {
    const { siteId } = params as { siteId: string };

    if (!siteId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "siteId is required" });
      return;
    }

    const funnels = tracker().listFunnels(siteId);
    respond(true, { funnels });
  },

  "kpi.funnels.update": async ({ params, respond }) => {
    const { funnelId, ...updates } = params as { funnelId: string } & Record<string, unknown>;

    if (!funnelId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
      return;
    }

    const funnel = tracker().updateFunnel(funnelId, updates);
    if (!funnel) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Funnel not found" });
      return;
    }

    respond(true, { funnel });
  },

  "kpi.funnels.delete": async ({ params, respond }) => {
    const { funnelId } = params as { funnelId: string };

    if (!funnelId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
      return;
    }

    const deleted = tracker().deleteFunnel(funnelId);
    respond(true, { deleted });
  },

  "kpi.funnels.analytics": async ({ params, respond }) => {
    const { funnelId, timeRange = "30d" } = params as { funnelId: string; timeRange?: TimeRange };

    if (!funnelId) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "funnelId is required" });
      return;
    }

    const analytics = tracker().getFunnelAnalytics(funnelId, timeRange);
    respond(true, { analytics });
  },
};

// ═══════════════════════════════════════════════════════════════
// EMBED SCRIPT GENERATOR
// ═══════════════════════════════════════════════════════════════

function generateEmbedScript(scriptKey: string, gatewayUrl: string): string {
  return `<!-- KPI Analytics -->
<script>
(function(w,d,s,k,g){
  w._kpi=w._kpi||{q:[],track:function(){this.q.push(arguments)}};
  w._kpi.key=k;w._kpi.gateway=g;
  var f=d.getElementsByTagName(s)[0],j=d.createElement(s);
  j.async=1;j.src=g+'/kpi.js';f.parentNode.insertBefore(j,f);
})(window,document,'script','${scriptKey}','${gatewayUrl}');
</script>
<!-- End KPI Analytics -->`;
}
