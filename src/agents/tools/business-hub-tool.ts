import type { AnyAgentTool } from "./common.js";
import { createSlotTool } from "../../plugins/core-tool-slots.js";

/**
 * `business_hub` is a Business & Agency plugin tool: core keeps the name as a
 * slot (src/plugins/core-tool-slots.ts) that the plugin fills while it is
 * enabled (src/business-hub/tool.ts). With the plugin off agents never see it.
 */
export function createBusinessHubTool(): AnyAgentTool {
  return createSlotTool("business_hub", "Business & Agency");
}
