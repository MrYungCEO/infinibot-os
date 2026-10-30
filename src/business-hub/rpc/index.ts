/**
 * Business hub RPC surface — every `hub.*` handler in one map, plus the
 * method → scope table the plugin manifest and the gateway scope checks use.
 * The agent tool (`business_hub`) calls the same handlers, so the UI, agents
 * and RPC clients always share one code path.
 */

import type { GatewayRequestHandlers } from "../../gateway/server-methods/types.js";
import { CORE_METHOD_SCOPES, coreHubHandlers } from "./core.js";
import { EMAIL_METHOD_SCOPES, emailHubHandlers } from "./email.js";
import { LEADGEN_METHOD_SCOPES, leadgenHubHandlers, setLeadgenDealHook } from "./leadgen.js";
import { getHubDb } from "../db.js";
import { openLeadDeal } from "../automation.js";
import { wireBusinessHub } from "../plugin-runtime.js";
import { overviewHubHandlers, OVERVIEW_METHOD_SCOPES } from "./overview.js";
import { REVENUE_METHOD_SCOPES, revenueHubHandlers } from "./revenue.js";
import { TRACKING_METHOD_SCOPES, trackingHubHandlers } from "./tracking.js";
import { AUTOPILOT_METHOD_SCOPES, autopilotHubHandlers } from "./autopilot.js";

// Email / revenue RPCs fire the same pipeline hooks as the schedulers.
void wireBusinessHub();

// Lead-gen imports open deals through the shared automation path.
setLeadgenDealHook(({ contactId, companyId, pipelineStage }) => {
  openLeadDeal(getHubDb(), { contactId, companyId, stageName: pipelineStage });
});

export const businessHubHandlers: GatewayRequestHandlers = {
  ...autopilotHubHandlers,
  ...coreHubHandlers,
  ...leadgenHubHandlers,
  ...emailHubHandlers,
  ...trackingHubHandlers,
  ...revenueHubHandlers,
  ...overviewHubHandlers,
};

export const BUSINESS_HUB_METHOD_SCOPES: Record<string, "read" | "write" | "admin"> = {
  ...AUTOPILOT_METHOD_SCOPES,
  ...CORE_METHOD_SCOPES,
  ...LEADGEN_METHOD_SCOPES,
  ...EMAIL_METHOD_SCOPES,
  ...TRACKING_METHOD_SCOPES,
  ...REVENUE_METHOD_SCOPES,
  ...OVERVIEW_METHOD_SCOPES,
};

/**
 * Call a hub handler in-process (agent tool, cron, other core code).
 * Resolves with the payload or rejects with the handler's error message.
 */
export async function invokeHub(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = businessHubHandlers[method];
  if (!handler) throw new Error(`unknown business hub method: ${method}`);
  return new Promise((resolve, reject) => {
    void Promise.resolve(
      handler({
        params,
        respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => {
          if (ok) resolve(payload);
          else reject(new Error(error?.message ?? "request failed"));
        },
      } as unknown as Parameters<typeof handler>[0]),
    ).catch(reject);
  });
}
