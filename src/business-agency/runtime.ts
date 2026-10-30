/**
 * Business & Agency runtime seam — what the `business-agency` plugin calls
 * into, and the one place core asks "is the business pack on?".
 *
 * Everything the plugin reaches is lazy: no business handler module is
 * imported until the plugin (which only loads while enabled) asks for it.
 * Core never registers a business RPC itself, so a gateway with the plugin
 * off never serves one.
 *
 * Core code that depends on business data (reports, oversight, cron seeding,
 * agent tools) asks `isBusinessAgencyActive()` first and treats "off" as
 * "no business data" — see docs/plugins/BUSINESS-AGENCY.md § Core seam.
 */

import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "../gateway/server-methods/types.js";
import { loadConfig } from "../config/io.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  BUSINESS_AGENCY_PLUGIN_ID,
  listBusinessAgencyMethods,
  type BusinessAgencyModule,
} from "./methods.js";

const MODULE_LOADERS: Record<BusinessAgencyModule, () => Promise<GatewayRequestHandlers>> = {
  opportunity: async () =>
    (await import("../gateway/server-methods/opportunity.js")).opportunityHandlers,
  decision: async () => (await import("../gateway/server-methods/decision.js")).decisionHandlers,
  risk: async () => (await import("../gateway/server-methods/risk.js")).riskHandlers,
  commitment: async () =>
    (await import("../gateway/server-methods/commitment.js")).commitmentHandlers,
  person: async () => (await import("../gateway/server-methods/person.js")).personHandlers,
  business: async () => (await import("../gateway/server-methods/business.js")).businessHandlers,
  "business-income": async () =>
    (await import("../gateway/server-methods/business-income.js")).businessIncomeHandlers,
  "business-summary": async () =>
    (await import("../gateway/server-methods/business-summary.js")).businessSummaryHandlers,
  leads: async () => (await import("../gateway/server-methods/leads.js")).leadHandlers,
  "lead-qualifier": async () =>
    (await import("../gateway/server-methods/lead-qualifier.js")).leadQualifierHandlers,
  funnels: async () => (await import("../gateway/server-methods/funnels.js")).funnelHandlers,
  "funnels-flow": async () =>
    (await import("../gateway/server-methods/funnels-flow.js")).funnelsFlowHandlers,
  campaigns: async () => (await import("../gateway/server-methods/campaigns.js")).campaignHandlers,
  "agency-operations": async () =>
    (await import("../gateway/server-methods/agency-operations.js")).agencyOperationsHandlers,
  clients: async () => (await import("../gateway/server-methods/clients.js")).clientsHandlers,
  "business-hub": async () => (await import("../business-hub/rpc/index.js")).businessHubHandlers,
  network: async () =>
    (await import("../gateway/server-methods/people-network.js")).peopleNetworkHandlers,
  "hq-progress": async () =>
    (await import("../gateway/server-methods/hq-progress.js")).hqProgressHandlers,
};

const moduleCache = new Map<BusinessAgencyModule, Promise<GatewayRequestHandlers>>();

function loadModule(module: BusinessAgencyModule): Promise<GatewayRequestHandlers> {
  let p = moduleCache.get(module);
  if (!p) {
    p = MODULE_LOADERS[module]();
    // A failed import must not poison later calls.
    p.catch(() => moduleCache.delete(module));
    moduleCache.set(module, p);
  }
  return p;
}

/**
 * Plugin-namespaced handlers (`business-agency.*`) for every business method.
 * Each one lazy-loads its handler module on first call and then delegates to
 * the legacy handler unchanged (same params, same response shape).
 */
export function createBusinessAgencyHandlers(): Record<string, GatewayRequestHandler> {
  const out: Record<string, GatewayRequestHandler> = {};
  for (const { module, legacy, method } of listBusinessAgencyMethods()) {
    out[method] = async (opts) => {
      let handlers: GatewayRequestHandlers;
      try {
        handlers = await loadModule(module);
      } catch (err) {
        opts.respond(false, undefined, {
          code: "UNAVAILABLE",
          message: `business & agency: could not load ${module}: ${String(err)}`,
        });
        return;
      }
      const handler = handlers[legacy];
      if (!handler) {
        opts.respond(false, undefined, {
          code: "UNAVAILABLE",
          message: `business & agency: ${legacy} is not implemented`,
        });
        return;
      }
      await handler(opts);
    };
  }
  return out;
}

/** True while the business-agency plugin is loaded on this gateway. */
export function isBusinessAgencyActive(): boolean {
  const registry = getActivePluginRegistry();
  return Boolean(
    registry?.plugins.some((p) => p.id === BUSINESS_AGENCY_PLUGIN_ID && p.status === "loaded"),
  );
}

/** Write-only plugin settings holding payment-provider keys (Settings › Plugins). */
export const BUSINESS_AGENCY_SECRET_SETTINGS = {
  whop: "whopApiKey",
  stripe: "stripeSecretKey",
  square: "squareAccessToken",
} as const;

/**
 * A payment-provider key the owner saved as a write-only plugin setting
 * (`plugins.entries.business-agency.config.<key>`), or null. Income sync and
 * invoice payment links resolve keys as: per-business saved key (existing
 * installs) → this plugin setting → environment variable.
 */
export function readBusinessAgencyProviderKey(
  provider: keyof typeof BUSINESS_AGENCY_SECRET_SETTINGS,
  readConfig: () => unknown = safeLoadConfig,
): string | null {
  return readBusinessAgencySetting(BUSINESS_AGENCY_SECRET_SETTINGS[provider], readConfig);
}

/** A non-secret string plugin setting (e.g. `whopCompanyId`), or null. */
export function readBusinessAgencySetting(
  key: string,
  readConfig: () => unknown = safeLoadConfig,
): string | null {
  const cfg = readConfig() as
    | { plugins?: { entries?: Record<string, { config?: Record<string, unknown> }> } }
    | undefined;
  const value = cfg?.plugins?.entries?.[BUSINESS_AGENCY_PLUGIN_ID]?.config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeLoadConfig(): unknown {
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
}
