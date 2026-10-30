/**
 * Business & Agency agent tools. Core keeps their names as tool slots
 * (src/plugins/core-tool-slots.ts); the plugin fills each slot with the
 * factory below while it is enabled, so agents only see them while it is on.
 */

import type { AnyAgentTool } from "../agents/tools/common.js";
import { createBusinessObjectsToolImpl } from "../agents/tools/business-objects-tool.js";
import { createClientContactsToolImpl } from "../agents/tools/client-contacts-tool.js";
import { createLeadScrapeToolImpl } from "../agents/tools/lead-scrape-tool.js";
import { createLeadToolImpl } from "../agents/tools/lead-tool.js";
import { createBusinessHubToolImpl } from "../business-hub/tool.js";
import { createPeopleNetworkToolImpl } from "../agents/tools/people-network-tool.js";

export const BUSINESS_AGENCY_TOOL_FACTORIES: Readonly<Record<string, () => AnyAgentTool>> = {
  lead_generation: () => createLeadToolImpl(),
  lead_scrape: () => createLeadScrapeToolImpl(),
  client_contacts: () => createClientContactsToolImpl(),
  business_objects: () => createBusinessObjectsToolImpl(),
  business_hub: () => createBusinessHubToolImpl(),
  people_network: () => createPeopleNetworkToolImpl(),
};

export const BUSINESS_AGENCY_TOOL_NAMES = Object.keys(BUSINESS_AGENCY_TOOL_FACTORIES);
