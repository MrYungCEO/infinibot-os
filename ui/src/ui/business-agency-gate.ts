/**
 * Business & Agency — the control UI's single seam for "is the business pack
 * on?" (docs/plugins/BUSINESS-AGENCY.md § Core seam).
 *
 * Every business page is a plugin-gated tab (plugin-host.ts FIRST_PARTY_PAGES).
 * Core surfaces that merely *touch* business data — the kanban agency filter,
 * the global biz filter, product cards on HQ, the home page — ask
 * `isBusinessAgencyOn()` and behave as if there were no business data when
 * it is off. Nothing here calls a business RPC.
 */

import type { Tab } from "./navigation.js";
import { isTabAvailable } from "./plugin-host.js";

export const BUSINESS_AGENCY_PLUGIN_ID = "business-agency";

/** Every tab the business-agency plugin owns (kept in step with its manifest). */
export const BUSINESS_AGENCY_TABS: readonly Tab[] = [
  "business-hq",
  "hub",
  "command-ceo",
  "command-ops",
  "agency-daily",
  "agency-operations",
  "agency-topology",
  "clients",
  "pipeline",
  "opportunities",
  "decisions",
  "risks",
  "commitments",
  "people",
  "people-network",
  "leads",
  "qualifier",
  "funnels",
  "campaigns",
  "business",
];

const TABS: ReadonlySet<string> = new Set(BUSINESS_AGENCY_TABS);

export function isBusinessAgencyTab(tab: string): boolean {
  return TABS.has(tab);
}

/** True while the business-agency plugin is loaded and its pages are on. */
export function isBusinessAgencyOn(): boolean {
  return isTabAvailable("business-hq");
}
