import { getBusinessSummary, listBusinessesLight } from "../../business/summary.js";
import type { GatewayRequestHandlers } from "./types.js";

function err(e: unknown): { code: string; message: string } {
  return { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) };
}

export const businessSummaryHandlers: GatewayRequestHandlers = {
  /**
   * Aggregated per-business overview — pages, leads, KPIs, brand, assets.
   * Returns "pending" stubs for systems that don't yet scope by business id
   * so the UI can render a complete dashboard without hard errors.
   */
  "business.summary": async ({ params, respond }) => {
    try {
      const id = (params?.businessId || params?.id) as string | undefined;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId required" });
        return;
      }
      const summary = await getBusinessSummary(id);
      respond(true, summary);
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  /** Light list — id + name + logo for the business switcher. */
  "business.summary.businesses.light": async ({ respond }) => {
    try {
      respond(true, { businesses: listBusinessesLight() });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },
};
