/**
 * Lead Generation Agent Tool
 *
 * Wraps the lead-generation service (google_maps / google_search / apollo /
 * hunter_io scrapers) as an AgentTool so any agent — and any MCP client —
 * can search for leads, list cached results, and push them to a Notion CRM
 * via a single tool surface.
 *
 * google_maps source needs GOOGLE_PLACES_API_KEY or SERP_API_KEY at runtime;
 * without either, the scraper falls back to a "limited simulation" path and
 * the tool will surface an empty result rather than crashing.
 */

import { Type } from "@sinclair/typebox";

import { stringEnum, optionalStringEnum } from "../schema/typebox.js";
import { getLeadService } from "../../services/lead-generation/index.js";
import type {
  Lead,
  LeadSearchParams,
  LeadSource,
  LeadType,
} from "../../services/lead-generation/types.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";
import { createSlotTool } from "../../plugins/core-tool-slots.js";

const LEAD_ACTIONS = ["search", "get", "list", "save_to_crm", "sources", "stats"] as const;

const LEAD_TYPES = [
  "business",
  "b2b",
  "agency",
  "ecommerce",
  "restaurant",
  "healthcare",
  "realestate",
  "professional",
  "tech",
] as const;

const LeadToolSchema = Type.Object({
  action: stringEnum(LEAD_ACTIONS),
  query: Type.Optional(
    Type.String({
      description: "Search query (business name, industry, or domain for hunter.io).",
    }),
  ),
  location: Type.Optional(Type.String({ description: "Where to search (city, state, country)." })),
  type: optionalStringEnum(LEAD_TYPES),
  sources: Type.Optional(
    Type.Array(Type.String(), {
      description: "Specific sources to use: google_maps, google_search, apollo, hunter_io.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max results (default 20 for search, 50 for list)." }),
  ),
  hasEmail: Type.Optional(Type.Boolean()),
  hasPhone: Type.Optional(Type.Boolean()),
  minRating: Type.Optional(Type.Number({ description: "Minimum rating filter (1-5)." })),
  id: Type.Optional(Type.String({ description: "Lead id for get / save_to_crm." })),
  databaseId: Type.Optional(
    Type.String({
      description:
        "Optional Notion CRM database id to also mirror into for save_to_crm. Leads always save to the local CRM (Clients) without it.",
    }),
  ),
  status: Type.Optional(Type.String({ description: "Filter list by lead status." })),
  quality: Type.Optional(
    Type.String({ description: "Filter list by quality (hot / warm / cold)." }),
  ),
});

export const leadToolName = "lead_generation";

export const leadToolDescription = `Search for and manage business leads via the lead-generation service.

Actions:
- search: Scrape leads by query + location + type + sources (returns structured leads).
- get: Fetch a cached lead by id.
- list: List cached leads with optional status / quality / type filters.
- save_to_crm: Push a cached lead into a Notion CRM database.
- sources: List available scraper sources and their current status.
- stats: Get scraper statistics.

Sources: google_maps, google_search, apollo, hunter_io.
Lead types: business, b2b, agency, ecommerce, restaurant, healthcare, realestate, professional, tech.

Examples:
- Search restaurants in Bangkok via Google Maps:
    { "action": "search", "query": "restaurants", "location": "Bangkok", "sources": ["google_maps"], "limit": 20 }
- Pressure washing companies in Atlanta:
    { "action": "search", "query": "pressure washing", "location": "Atlanta", "sources": ["google_maps"], "limit": 10 }
- Find emails for a domain (Hunter.io):
    { "action": "search", "query": "example.com", "sources": ["hunter_io"] }
- Push a lead to Notion CRM:
    { "action": "save_to_crm", "id": "lead-xxx", "databaseId": "<notion-db-id>" }`;

function formatLeadForAgent(lead: Lead): Record<string, unknown> {
  return {
    id: lead.id,
    companyName: lead.companyName,
    website: lead.website,
    email: lead.email || lead.contactEmail,
    phone: lead.phone || lead.contactPhone,
    address: lead.address,
    city: lead.city,
    industry: lead.industry,
    contactName: lead.contactName,
    contactTitle: lead.contactTitle,
    rating: lead.rating,
    reviewCount: lead.reviewCount,
    type: lead.type,
    source: lead.source,
    quality: lead.quality,
    inCRM: !!lead.notionPageId,
  };
}

/**
 * `lead_generation` is a Business & Agency plugin tool: core keeps the name as a slot
 * (src/plugins/core-tool-slots.ts) that the plugin fills while it is enabled.
 * With the plugin off the slot is empty and agents never see the tool.
 */
export function createLeadTool(): AnyAgentTool {
  return createSlotTool("lead_generation", "Business & Agency");
}

/** The real tool; the business-agency plugin fills the slot with it. */
export function createLeadToolImpl(): AnyAgentTool {
  return {
    label: "Lead Generation",
    name: leadToolName,
    description: leadToolDescription,
    parameters: LeadToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as
        | (typeof LEAD_ACTIONS)[number]
        | undefined;
      const service = getLeadService();

      try {
        switch (action) {
          case "search": {
            const query = readStringParam(params, "query");
            if (!query) {
              return jsonResult({ status: "error", error: "query is required for search action" });
            }
            const searchParams: LeadSearchParams = {
              query,
              location: readStringParam(params, "location"),
              type: (params.type as LeadType | undefined) ?? undefined,
              sources: Array.isArray(params.sources) ? (params.sources as LeadSource[]) : undefined,
              limit: readNumberParam(params, "limit", { integer: true }) ?? 20,
              hasEmail: typeof params.hasEmail === "boolean" ? params.hasEmail : undefined,
              hasPhone: typeof params.hasPhone === "boolean" ? params.hasPhone : undefined,
              minRating: readNumberParam(params, "minRating"),
            };
            const result = await service.search(searchParams);
            return jsonResult({
              status: "ok",
              total: result.total,
              cached: result.cached,
              leads: result.leads.map(formatLeadForAgent),
              errors: result.errors,
            });
          }

          case "get": {
            const id = readStringParam(params, "id", { required: true });
            const lead = service.getLead(id);
            if (!lead) {
              return jsonResult({ status: "error", error: "Lead not found" });
            }
            return jsonResult({ status: "ok", lead: formatLeadForAgent(lead) });
          }

          case "list": {
            let leads = service.getAllLeads();
            const statusFilter = readStringParam(params, "status");
            const qualityFilter = readStringParam(params, "quality");
            const typeFilter = params.type as LeadType | undefined;
            if (statusFilter) leads = leads.filter((l) => l.status === statusFilter);
            if (qualityFilter) leads = leads.filter((l) => l.quality === qualityFilter);
            if (typeFilter) leads = leads.filter((l) => l.type === typeFilter);
            const limit = readNumberParam(params, "limit", { integer: true }) ?? 50;
            leads = leads.slice(0, limit);
            return jsonResult({
              status: "ok",
              total: leads.length,
              leads: leads.map(formatLeadForAgent),
            });
          }

          case "save_to_crm": {
            const id = readStringParam(params, "id", { required: true });
            const databaseId = readStringParam(params, "databaseId");
            const lead = service.getLead(id);
            if (!lead) {
              return jsonResult({ status: "error", error: "Lead not found" });
            }
            const saved = await service.saveLeadToCRM({ lead, databaseId });
            return jsonResult({
              status: "ok",
              clientId: saved.clientId,
              notionPageId: saved.notionPageId,
              notionSync: saved.notionSync,
              message:
                saved.notionSync === "queued"
                  ? `Lead "${lead.companyName}" saved to the CRM (Notion mirror queued)`
                  : `Lead "${lead.companyName}" saved to the CRM`,
            });
          }

          case "sources": {
            return jsonResult({ status: "ok", sources: service.getAvailableSources() });
          }

          case "stats": {
            return jsonResult({ status: "ok", stats: service.getStats() });
          }

          default:
            return jsonResult({ status: "error", error: `Unknown action: ${action}` });
        }
      } catch (err) {
        return jsonResult({ status: "error", error: (err as Error).message });
      }
    },
  };
}
