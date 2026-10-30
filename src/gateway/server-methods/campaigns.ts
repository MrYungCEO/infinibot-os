/**
 * campaigns.* — Lead Outreach Campaign gateway methods.
 *
 * Each campaign joins one business + one or more products + one funnel
 * + a target-audience + a goal. Used by the qualifier to assemble the
 * CampaignContext blob that drives downstream email + doc generation.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCampaignsStore } from "../../campaigns/store.js";
import {
  buildCampaignContext,
  buildClientCampaignContext,
} from "../../campaigns/context-builder.js";
import { getFunnelStore } from "../../funnels/store.js";
import type {
  CampaignFilters,
  CampaignInput,
  CampaignPatch,
  CampaignStatus,
} from "../../campaigns/types.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("campaigns-gateway");

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asStatus(v: unknown): CampaignStatus | undefined {
  if (v === "draft" || v === "active" || v === "paused" || v === "completed") return v;
  return undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

export const campaignHandlers: GatewayRequestHandlers = {
  "campaigns.list": async ({ params, respond }) => {
    try {
      const filters: CampaignFilters = {
        businessId: asString(params.businessId),
        status: asStatus(params.status),
      };
      const campaigns = getCampaignsStore().list(filters);
      respond(true, { campaigns, count: campaigns.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "campaigns.get": async ({ params, respond }) => {
    try {
      const id = asString(params.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const campaign = getCampaignsStore().get(id);
      if (!campaign) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Campaign not found" });
        return;
      }
      respond(true, { campaign });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "campaigns.create": async ({ params, respond }) => {
    try {
      const name = asString(params.name);
      const businessId = asString(params.businessId);
      if (!name || !businessId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "name and businessId are required",
        });
        return;
      }
      const input: CampaignInput = {
        name,
        businessId,
        status: asStatus(params.status),
        productIds: asStringArray(params.productIds),
        funnelId: asString(params.funnelId) ?? null,
        targetAudience:
          (params.targetAudience as CampaignInput["targetAudience"] | undefined) ?? undefined,
        goal: (params.goal as CampaignInput["goal"] | undefined) ?? undefined,
        context: (params.context as CampaignInput["context"] | undefined) ?? undefined,
      };
      const campaign = getCampaignsStore().create(input);
      log.info("Created campaign", { campaignId: campaign.id, businessId });
      respond(true, { campaign });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "campaigns.update": async ({ params, respond }) => {
    try {
      const id = asString(params.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const rawPatch = (params.patch as Record<string, unknown> | undefined) ?? params;
      const patch: CampaignPatch = {
        name: asString(rawPatch.name),
        status: asStatus(rawPatch.status),
        productIds: asStringArray(rawPatch.productIds),
        funnelId: rawPatch.funnelId === null ? null : (asString(rawPatch.funnelId) ?? undefined),
        targetAudience: rawPatch.targetAudience as CampaignPatch["targetAudience"],
        goal: rawPatch.goal as CampaignPatch["goal"],
        context: rawPatch.context as CampaignPatch["context"],
      };
      const updated = getCampaignsStore().update(id, patch);
      if (!updated) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Campaign not found" });
        return;
      }
      respond(true, { campaign: updated });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "campaigns.delete": async ({ params, respond }) => {
    try {
      const id = asString(params.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const ok = getCampaignsStore().delete(id);
      respond(true, { deleted: ok });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "campaigns.assignLead": async ({ params, respond }) => {
    try {
      const campaignId = asString(params.campaignId);
      const leadId = asString(params.leadId);
      if (!campaignId || !leadId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "campaignId and leadId are required",
        });
        return;
      }
      const campaign = getCampaignsStore().get(campaignId);
      if (!campaign) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Campaign not found" });
        return;
      }
      const lead = getFunnelStore().setLeadCampaign(leadId, campaignId);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }
      respond(true, { lead, campaign });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "campaigns.context": async ({ params, respond }) => {
    try {
      const leadId = asString(params.leadId);
      if (!leadId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "leadId is required" });
        return;
      }
      const ctx = await buildCampaignContext(leadId);
      respond(true, { context: ctx });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "campaigns.stats": async ({ params, respond }) => {
    try {
      const id = asString(params.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const refreshed = getCampaignsStore().recomputeStats(id);
      if (!refreshed) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Campaign not found" });
        return;
      }
      respond(true, { campaign: refreshed });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  /** Validate that a campaign exists before the frontend stores _campaignId on the client. */
  "campaigns.assignClient": async ({ params, respond }) => {
    try {
      const campaignId = asString(params.campaignId);
      if (!campaignId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "campaignId is required" });
        return;
      }
      const campaign = getCampaignsStore().get(campaignId);
      if (!campaign) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Campaign not found" });
        return;
      }
      // Actual storage happens via business.clients.update(_campaignId) on the client side.
      respond(true, { campaign });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  /** Build a full campaign context blob for a CRM client record. */
  "campaigns.contextForClient": async ({ params, respond }) => {
    try {
      const clientId = asString(params.clientId);
      if (!clientId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "clientId is required" });
        return;
      }
      const ctx = await buildClientCampaignContext(clientId);
      respond(true, { context: ctx });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },
};
