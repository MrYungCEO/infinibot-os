/**
 * CampaignContext builder.
 *
 * The integration point the user emphasized: form fill → qualifier →
 * look up the lead's campaignId → assemble business + products +
 * audience + funnel + goal into a single blob, then hand it to email
 * and document generators downstream.
 *
 * Pure reads — no writes. Returns null if the lead has no campaignId
 * stamped or the campaign/business has been deleted; callers must
 * degrade gracefully.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

import { getCampaignsStore } from "./store.js";
import { getFunnelStore } from "../funnels/store.js";
import { getDatabasesStore } from "../databases/store.js";
import { STATE_DIR } from "../config/paths.js";
import type {
  CampaignContext,
  CampaignContextBusiness,
  CampaignContextFunnel,
  CampaignContextProduct,
  ClientCampaignContext,
} from "./types.js";

interface RawProductOffering {
  id: string;
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  features?: string[];
}

interface RawBusinessProfile {
  id: string;
  name: string;
  industry?: string;
  tagline?: string | null;
  branding?: {
    colors?: { primary?: string };
    voice?: {
      tone?: string;
      audience?: string;
      do?: string[];
      dont?: string[];
    };
  } | null;
  products?: RawProductOffering[];
}

/**
 * Build a context blob for a given lead. Returns null when:
 *   - the lead has no campaignId stamped, or
 *   - the campaign no longer exists.
 *
 * Designed to be cheap to call on every email/doc generation — the
 * underlying stores are SQLite-backed and the business profile is a
 * small JSON read.
 */
export async function buildCampaignContext(leadId: string): Promise<CampaignContext | null> {
  const funnelStore = getFunnelStore();
  const lead = funnelStore.getLead(leadId);
  if (!lead) return null;
  if (!lead.campaignId) return null;

  const campaignsStore = getCampaignsStore();
  const campaign = campaignsStore.get(lead.campaignId);
  if (!campaign) return null;

  const business = loadBusinessProfile(campaign.businessId);
  const products = pickProducts(business, campaign.productIds);
  const funnel = campaign.funnelId ? loadFunnelInfo(campaign.funnelId, lead.stageId) : null;

  const ctxBusiness: CampaignContextBusiness = {
    id: business?.id ?? campaign.businessId,
    name: business?.name ?? "",
    industry: business?.industry,
    voice: business?.branding?.voice,
    branding: business
      ? { primaryColor: business.branding?.colors?.primary, tagline: business.tagline ?? null }
      : undefined,
  };

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      goal: campaign.goal,
      context: campaign.context,
      targetAudience: campaign.targetAudience,
    },
    business: ctxBusiness,
    products,
    funnel,
    lead: {
      id: lead.id,
      name: lead.name,
      email: lead.email,
      company: lead.company,
      score: lead.score,
      tags: lead.tags,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Reads the business profile from the same JSON the business gateway
 * methods use (`state/business.json`). We don't import the gateway
 * module to avoid pulling its full dependency tree into the campaigns
 * path — the file shape is stable.
 */
function loadBusinessProfile(businessId: string): RawBusinessProfile | null {
  const candidates = [
    join(STATE_DIR, "business.json"),
    join(process.cwd(), "state", "business.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as { businesses?: RawBusinessProfile[] };
      const list = parsed.businesses ?? [];
      const found = list.find((b) => b.id === businessId);
      if (found) return found;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function pickProducts(
  business: RawBusinessProfile | null,
  productIds: string[],
): CampaignContextProduct[] {
  if (!business?.products || productIds.length === 0) return [];
  const byId = new Map(business.products.map((p) => [p.id, p]));
  const out: CampaignContextProduct[] = [];
  for (const id of productIds) {
    const p = byId.get(id);
    if (!p) continue;
    out.push({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      currency: p.currency,
      features: p.features,
    });
  }
  return out;
}

function loadFunnelInfo(funnelId: string, stageId: string): CampaignContextFunnel | null {
  try {
    const store = getFunnelStore();
    const funnel = store.getFunnel(funnelId);
    if (!funnel) return null;
    const stages = store.getStages(funnelId);
    const stage = stages.find((s) => s.id === stageId);
    return {
      id: funnel.id,
      name: funnel.name,
      stageName: stage?.name,
      stagePosition: stage?.position,
    };
  } catch {
    return null;
  }
}

// ─── Client variant ───────────────────────────────────────────

/**
 * Build a campaign context blob for a CRM client record. Returns null when:
 *   - the client row doesn't exist, or
 *   - no _campaignId is stored on the row, or
 *   - the referenced campaign no longer exists.
 *
 * Client-specific placeholder vars (stored as _campaignPlaceholders on the
 * row) are exposed under `client.placeholders` so generators can reference
 * them as {{client.placeholders.KEY}}.
 */
export async function buildClientCampaignContext(
  clientId: string,
): Promise<ClientCampaignContext | null> {
  const store = getDatabasesStore();
  const row = store.getRow(clientId);
  if (!row) return null;

  const values = (row.values ?? {}) as Record<string, unknown>;
  const campaignId =
    typeof values._campaignId === "string" && values._campaignId ? values._campaignId : null;
  if (!campaignId) return null;

  const campaignsStore = getCampaignsStore();
  const campaign = campaignsStore.get(campaignId);
  if (!campaign) return null;

  const business = loadBusinessProfile(campaign.businessId);
  const products = pickProducts(business, campaign.productIds);
  const funnel = campaign.funnelId ? loadFunnelInfo(campaign.funnelId, "") : null;

  const rawPlaceholders = values._campaignPlaceholders;
  const placeholders: Record<string, string> =
    rawPlaceholders && typeof rawPlaceholders === "object" && !Array.isArray(rawPlaceholders)
      ? (rawPlaceholders as Record<string, string>)
      : {};

  const ctxBusiness: CampaignContextBusiness = {
    id: business?.id ?? campaign.businessId,
    name: business?.name ?? "",
    industry: business?.industry,
    voice: business?.branding?.voice,
    branding: business
      ? { primaryColor: business.branding?.colors?.primary, tagline: business.tagline ?? null }
      : undefined,
  };

  // Pull a displayable name from the stored values (property names vary by schema).
  const clientName =
    (typeof values.name === "string" && values.name) ||
    (typeof values.Name === "string" && values.Name) ||
    (typeof values.email === "string" && values.email) ||
    (typeof values.Email === "string" && values.Email) ||
    clientId;

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      goal: campaign.goal,
      context: campaign.context,
      targetAudience: campaign.targetAudience,
    },
    business: ctxBusiness,
    products,
    funnel,
    lead: {
      id: clientId,
      name: clientName,
      email:
        (typeof values.email === "string" ? values.email : undefined) ??
        (typeof values.Email === "string" ? values.Email : undefined),
      company:
        (typeof values.company === "string" ? values.company : undefined) ??
        (typeof values.Company === "string" ? values.Company : undefined),
    },
    client: {
      id: clientId,
      placeholders,
    },
  };
}
