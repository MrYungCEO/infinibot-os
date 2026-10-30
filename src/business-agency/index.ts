/**
 * Business & Agency seam — the single surface the `business-agency` plugin
 * uses to reach the business backend that still compiles into core.
 * Re-exported by `infinibot/plugin-sdk` as `businessAgency`. Handler modules
 * and stores load lazily, only after the plugin calls in.
 *
 * Docs: docs/plugins/BUSINESS-AGENCY.md.
 */

import {
  BUSINESS_AGENCY_PLUGIN_ID,
  BUSINESS_AGENCY_PLUGIN_NAME,
  businessAgencyPluginMethod,
  listBusinessAgencyMethods,
} from "./methods.js";
import { createBusinessAgencyHandlers, isBusinessAgencyActive } from "./runtime.js";
import { BUSINESS_AGENCY_TOOL_FACTORIES, BUSINESS_AGENCY_TOOL_NAMES } from "./tools.js";

/** Business hub HTTP routes + background service (lazy; src/business-hub/plugin-runtime.ts). */
const businessHub = {
  async httpRoutes() {
    return (await import("../business-hub/plugin-runtime.js")).createBusinessHubRoutes();
  },
  async start() {
    await (await import("../business-hub/plugin-runtime.js")).startBusinessHubService();
  },
  async stop() {
    await (await import("../business-hub/plugin-runtime.js")).stopBusinessHubService();
  },
};

export const businessAgency = {
  pluginId: BUSINESS_AGENCY_PLUGIN_ID,
  pluginName: BUSINESS_AGENCY_PLUGIN_NAME,
  pluginMethod: businessAgencyPluginMethod,
  listMethods: listBusinessAgencyMethods,
  createHandlers: createBusinessAgencyHandlers,
  isActive: isBusinessAgencyActive,
  toolNames: BUSINESS_AGENCY_TOOL_NAMES,
  toolFactories: BUSINESS_AGENCY_TOOL_FACTORIES,
  hub: businessHub,
};

export type BusinessAgencySeam = typeof businessAgency;
