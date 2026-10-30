/**
 * Business hub RPC — `hub.tracking.*`: sites (public key, allowed origins,
 * consent mode), the install snippet, stats and the recent event log.
 */

import { resolveBaseUrl } from "../email/config.js";
import { installDoc, snippetHtml } from "../tracking-snippet.js";
import {
  deleteSite,
  getSite,
  listEvents,
  listSites,
  saveSite,
  trackingStats,
} from "../tracking.js";
import { defineHubHandlers, HubError, optBool, optNum, optStr, reqStr, strArr } from "./helpers.js";

export const trackingHubHandlers = defineHubHandlers({
  "hub.tracking.sites.list": (_p, { db }) => ({ sites: listSites(db) }),
  "hub.tracking.sites.save": (p, ctx) => {
    const site = saveSite(ctx.db, {
      id: optStr(p, "id"),
      name: optStr(p, "name"),
      origins: strArr(p, "origins"),
      consentMode: optStr(p, "consentMode"),
      funnelId: p.funnelId === null ? null : optStr(p, "funnelId"),
      rotateKey: optBool(p, "rotateKey"),
    });
    ctx.broadcast("hub.tracking.changed", { kind: "site", id: site.id });
    return { site };
  },
  "hub.tracking.sites.delete": (p, ctx) => {
    deleteSite(ctx.db, reqStr(p, "id"), { keepData: optBool(p, "keepData") });
    ctx.broadcast("hub.tracking.changed", { kind: "site" });
    return { ok: true };
  },
  "hub.tracking.snippet": (p, { db }) => {
    const site = getSite(db, reqStr(p, "siteId"));
    if (!site) throw new HubError("site not found", "NOT_FOUND");
    // The UI may pass its own origin when no public base URL is configured yet.
    const base = resolveBaseUrl(db, optStr(p, "baseUrl"));
    if (!base) throw new HubError("set the public base URL in Email settings, or pass baseUrl");
    return {
      html: snippetHtml(site, base),
      doc: installDoc(site, base),
      publicKey: site.publicKey,
      consentMode: site.consentMode,
      originsConfigured: site.origins.length > 0,
    };
  },
  "hub.tracking.stats": (p, { db }) =>
    trackingStats(db, optStr(p, "siteId"), { from: optNum(p, "from"), to: optNum(p, "to") }),
  "hub.tracking.events": (p, { db }) => ({
    events: listEvents(db, {
      siteId: optStr(p, "siteId"),
      contactId: optStr(p, "contactId"),
      type: optStr(p, "type"),
      before: optNum(p, "before"),
      limit: optNum(p, "limit"),
    }),
  }),
});

/** Gateway scopes for `hub.tracking.*` (plugin manifest `contributes.rpc[].scope`). */
export const TRACKING_METHOD_SCOPES: Record<string, "read" | "write" | "admin"> = {
  "hub.tracking.sites.list": "read",
  "hub.tracking.sites.save": "write",
  "hub.tracking.sites.delete": "write",
  "hub.tracking.snippet": "read",
  "hub.tracking.stats": "read",
  "hub.tracking.events": "read",
};
